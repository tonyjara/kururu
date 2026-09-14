/**
 * The kururu server: one process between the agents and every UI.
 *
 * It owns the ptys, holds an emulator per agent, and pushes what changed down a
 * WebSocket to whoever is watching — the desktop window and the phone are the
 * same client code talking to this same server, which is what keeps the two from
 * drifting. It also serves the built web app, so the window loads a URL rather
 * than a file and there is exactly one asset pipeline.
 *
 * It used to poll a ghosttown daemon and forward what it saw. Now it is the
 * source, which removes the polling: a pty raises an event when it has something
 * to say, so snapshots are pushed when something actually changes rather than
 * on a timer. The timers that survive are the ones that could not be events —
 * end-of-work is *silence*, which raises no event, and the process table has to
 * be asked — plus one that coalesces, because output is an event thousands of
 * times a second and a socket should not be.
 *
 * It no longer owns the ptys. They live one process over, in `ptyhost.ts`, and
 * the reason is the dev loop: everything in this file changes weekly, and until
 * the split, restarting it to pick up a change took every agent with it. Now
 * this process can be killed and re-forked in under a second and the terminals
 * do not notice — it asks the host what is running, asks for the arrangement it
 * left behind, and carries on. See `hostlink.ts` for where the line is drawn.
 *
 * Runs on Node, not Bun, because it is loaded inside the Electron app rather
 * than spawned beside it. Nothing here may import electron: it must stay
 * runnable as a plain `node` process, which is how it is tested.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { adoptMascot, countsAsAgent, defaultMascot } from "../../shared/model";
import { bindKey } from "../../shared/keys";
import type { AgentSnapshot, MascotSet, Profile, PtyKind, SessionSnapshot } from "../../shared/model";
import type { ClientMessage, DevServer, ServerMessage } from "../../shared/wire";
import { DEV_SCAN_MS, SAVE_DEBOUNCE_MS } from "../../shared/wire";
import { parseReport } from "./agents/report";
import { dump as dumpRecording, forget as forgetRecording, recordBacklog, recordInput, recordNote, recordOutput } from "./record";
import { processCwd } from "./cwd";
import { scanDevServers } from "./devservers";
import { allowedRoots, allowRoot, listDir, readFile } from "./files";
import {
  adoptLegacySheet,
  builtinSheets,
  freshMascotId,
  importSheet,
  importedSheets,
  readMascots,
  removeSheet,
  sheetImage,
  sheetsDir,
  writeMascots,
} from "./mascot";
import { readKeys, writeKeys } from "./keys";
import { HostLink, type Port } from "./hostlink";
import { MouseEncoding } from "./mouseencoding";
import { readSnapshot, writeSnapshot } from "./persist";
import { closeAllPreviews, closePreview, openPreview, openPreviews } from "./proxy";
import { Workspaces } from "./workspaces";

const PORT = Number(process.env.KURURU_PORT ?? 7717);
const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * Where the built web app is. The Electron app passes this explicitly, because
 * once this file is bundled it no longer sits where the source did; running it
 * straight from the repo falls back to the source layout.
 */
const WEB_DIST = process.env.KURURU_WEB_DIST || join(HERE, "../../web/dist");

/**
 * Extra directories the file browser may read, colon-separated. Agent cwds and
 * dev server cwds are added automatically; this is for a project with nothing
 * running in it yet. Set at launch by the person running the server, never by a
 * client.
 */
for (const dir of (process.env.KURURU_ROOTS ?? "").split(":")) allowRoot(dir.trim() || undefined);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface ClientState {
  /** Terminals this client has on screen. Panes are tiled, so this is a set. */
  watching: Set<string>;
  /**
   * Terminals whose backlog is still being prepared, holding the live output
   * that arrived in the meantime.
   *
   * Opening a pane is two messages — the history, then everything after it — and
   * they must arrive in that order, because the client clears its emulator
   * before writing the history. Serializing the backlog takes a moment (the
   * emulator's write queue has to drain first, and the screen is resized to the
   * asking pane before that), and a flush can happen inside that moment. So
   * output for a terminal in here queues rather than races.
   *
   * `inflight` is a count rather than a flag because two rebuilds can overlap —
   * flick between two tabs fast enough and the second emulator asks before the
   * first one's answer has been serialized. Releasing the queue when the *first*
   * finishes would let live output reach the client ahead of the second screen,
   * which then wipes it on arrival: bytes the server has and the client never
   * sees again. The hold therefore lifts when the last rebuild is done, not the
   * first.
   */
  awaiting: Map<string, { inflight: number; queued: string[] }>;
}

/**
 * The link to the pty host, and the arrangement.
 *
 * Both are filled in by `attach()` once the main process has handed us a port:
 * the host is asked what is running and what the previous server left behind,
 * and only then is there anything to serve. Before that this process is a socket
 * nobody has said anything on yet.
 */
// Assigned by `attach()` before anything is served; see the bottom of the file.
let host!: HostLink;
let workspaces!: Workspaces;
const clients = new Map<WebSocket, ClientState>();

const state = {
  devServers: [] as DevServer[],
};

function send(ws: WebSocket, msg: ServerMessage): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // client went away mid-send; the close handler will clean up
  }
}

function broadcast(msg: ServerMessage): void {
  const payload = JSON.stringify(msg);
  for (const ws of clients.keys()) {
    try {
      ws.send(payload);
    } catch {
      // ditto
    }
  }
}

/**
 * Snapshots are pushed on change rather than diffed on a timer, so the server
 * has to avoid sending the same thing twice itself: several things can change in
 * one turn of the event loop (a pty exits, its status settles, its program
 * disappears) and each of them calls onChange.
 */
let snapshotQueued = false;
function pushSnapshot(): void {
  if (snapshotQueued) return;
  snapshotQueued = true;
  queueMicrotask(() => {
    snapshotQueued = false;
    broadcast({ type: "snapshot", snapshot: snapshot() });
  });
}

/**
 * The two halves, joined. The host knows what is running and the arrangement
 * knows where it is; neither one has an opinion about the other, which is what
 * keeps a pty out of the layout code and a split out of the pty code.
 *
 * Agents are scoped to the active profile because that is the window you are
 * looking at. The ones in the profile you left are still running — their count
 * is on the profile's row in the switcher, which is the whole point of saying
 * that switching is not closing.
 */
/**
 * The two things a person chose: their mascots, and their keyboard.
 *
 * Held rather than re-read per snapshot because a snapshot goes out on every
 * status change and these are files: the read happens when they change, which is
 * when the verb arrives. A server restart re-reads both, which is also how a
 * config edited by hand takes effect — and restarting the server costs a
 * reconnect and nothing else, which is what makes that a reasonable thing to
 * tell somebody to do.
 */
adoptLegacySheet();
let mascots = readMascots();
let keys = readKeys();

/**
 * Every mascot change goes through here, because all five of them are the same
 * two steps — write it down, then tell every client — and a verb that forgot the
 * second would leave the window that sent it drawing the badge it had before.
 * The snapshot is the answer to these messages, the way it is to a split.
 */
function saveMascots(next: MascotSet): void {
  mascots = next;
  writeMascots(next);
  pushSnapshot();
}

function snapshot(): SessionSnapshot {
  // Every snapshot is also the moment we learn what is running where, because it
  // is the one function that is called whenever anything about an agent changes.
  rememberAgents();
  const profile = workspaces.active;
  const mine = new Set(workspaces.agentsIn(profile.id));
  return {
    session: "kururu",
    profile,
    profiles: workspaces.summaries((id) => workspaces.agentsIn(id).filter((a) => host.isLive(a)).length),
    // Two fields are merged here rather than carried by the host — see `overlay`
    // below, and the fields themselves in `shared/model.ts`, for why they live
    // on this side of the link at all.
    agents: host.agents.filter((agent) => mine.has(agent.id)).map(overlay),
    mascots,
    keys,
  };
}

/**
 * Remember which ptys have had an agent in them.
 *
 * Every profile's, not just the one on screen: an agent in a profile you are not
 * looking at can exit while you are elsewhere, and if we only ever looked at the
 * active one we would have no record of what it had been by the time you came
 * back. Cheap enough to do on every snapshot — it is a map write per terminal,
 * against a function that already walks them all.
 */
function rememberAgents(): void {
  for (const agent of host.agents) if (agent.agent) lastAgent.set(agent.id, agent.agent);
}

/**
 * What each agent last said it was doing, by agent id.
 *
 * This is the server's, not the host's, and that is the whole point of it being
 * here. Everything else in a snapshot is a fact about a process — its pid, its
 * cwd, whether it is still alive — and the host is the only thing that can
 * answer those. A sentence about the work is not a fact about the process: it
 * arrives from the agent by a different road entirely (`POST /api/report`),
 * it is stale the moment the turn moves on, and nothing depends on it surviving.
 * Keeping it out of the host means the line can be improved, reworded or thrown
 * away without the edit costing anybody a running agent, which is the
 * difference between a thing that gets tuned and a thing that does not.
 *
 * A restart empties it. That is correct rather than merely tolerable: what an
 * agent was doing a server ago is exactly the claim we are least entitled to
 * keep making, and the next report is one turn away.
 */
const activity = new Map<string, string>();

/** One sidebar line's worth. The tooltip is where a long one goes in full. */
const MAX_ACTIVITY = 200;

/** Agent id → the agent program last seen in it. See AgentSnapshot.lastAgent. */
const lastAgent = new Map<string, string>();

/**
 * How each terminal writes its mouse reports, so the backlog can say it too.
 * See `mouseencoding.ts` — the serializer restores the mouse being *on* and
 * loses how it speaks, and the two halves disagreeing types into the program.
 */
const mouseEncodings = new Map<string, MouseEncoding>();

function mouseEncodingOf(agentId: string): MouseEncoding {
  let encoding = mouseEncodings.get(agentId);
  if (!encoding) mouseEncodings.set(agentId, (encoding = new MouseEncoding()));
  return encoding;
}

/**
 * What the pty host cannot say about an agent, added on the way out.
 *
 * Both of these are things the server knows and the host does not, and both are
 * cheap to lose: one arrives from the agent by a different road, the other is
 * relearnt by the next poll. Which is the point — neither is worth a field in
 * the half of kururu you cannot restart.
 */
function overlay(agent: AgentSnapshot): AgentSnapshot {
  const said = activity.get(agent.id);
  const was = lastAgent.get(agent.id);
  if (!said && !was) return agent;
  return { ...agent, ...(said ? { activity: said } : {}), ...(was ? { lastAgent: was } : {}) };
}

/**
 * The layout goes two places, and they are not the same thing.
 *
 * The host gets it *immediately*, whole, agent ids and all — that is what makes
 * restarting this process invisible, and it never touches a disk. The file gets
 * it on a delay and with the processes stripped out, because that copy is for
 * surviving a quit, and dragging a divider changes the layout sixty times a
 * second while none of those are worth a write.
 */
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function queueSave(): void {
  host.keep(JSON.stringify({ profiles: workspaces.all(), activeProfileId: workspaces.active.id }));
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeSnapshot(workspaces.all(), workspaces.active.id);
  }, SAVE_DEBOUNCE_MS);
  saveTimer.unref?.();
}

/**
 * Where a new terminal should start.
 *
 * A multiplexer's answer is "where the terminal you were just in is", and it
 * means *is*, not was: a minute after a shell opens it has been cd'd into a
 * project, and a tab that landed in the directory the pty was spawned in would
 * open in a home directory nobody is working in. So the pid is asked of the
 * kernel (`cwd.ts`) and what was recorded at spawn is only the fallback.
 *
 * Which terminal to follow is the rest of the question. The one this pane is
 * showing is the obvious answer; a pane with nothing in it remembers the project
 * it was for, which is what a restored layout and a fresh split have instead;
 * and failing both, the newest terminal anywhere in this workspace, because a
 * workspace is one piece of work and its directory is a better guess than `~`.
 */
async function cwdForNewTab(paneId: string): Promise<string | undefined> {
  const showing = workspaces.activeAgentIn(paneId);
  if (showing) {
    const followed = await followCwd(showing);
    if (followed) return followed;
  }
  const remembered = workspaces.cwdFor(paneId);
  if (remembered) return remembered;
  const newest = newestAgentHere();
  return newest ? await followCwd(newest) : undefined;
}

/** Where that terminal is now, or failing that where it was opened. */
async function followCwd(agentId: string): Promise<string | undefined> {
  const agent = host.find(agentId);
  if (!agent) return undefined;
  // An exited pty has no cwd to read, and asking about a recycled pid would be
  // worse than not asking: its spawn directory is the only honest answer left.
  const live = agent.exited || !agent.pid ? undefined : await processCwd(agent.pid);
  return live ?? agent.cwd;
}

/**
 * Open a terminal in a pane.
 *
 * Everything that *makes* a pane comes through here — a split, a new workspace,
 * a new profile, the first launch — as well as `new-tab` itself, which is the
 * point: a pane with nothing in it used to offer one button that opened a
 * terminal, and a choice with one option is not a choice, it is a step. Sharing
 * the call is also what keeps the automatic case and the asked-for one from
 * drifting apart.
 *
 * `from` is the pane whose cwd to follow, which is not always the pane the
 * terminal lands in. A split's new half is empty and remembers only the
 * directory its parent was *recorded* in, while the terminal still running next
 * door can be asked where it actually is.
 */
async function openTerminal(
  paneId: string,
  options: { cwd?: string; command?: string; kind?: PtyKind; from?: string } = {},
): Promise<AgentSnapshot> {
  const agent = await host.create({
    cwd: options.cwd ?? (await cwdForNewTab(options.from ?? paneId)),
    command: options.command,
    /**
     * A terminal unless the client insists otherwise. The window stopped
     * offering "start me an agent" as a separate thing to click: it is one
     * gesture fewer to open a terminal and type `claude` in it, and the tab ends
     * up saying the same thing either way, because `procs.ts` reports what is
     * actually running in there.
     */
    kind: options.kind ?? "shell",
  });
  /**
   * Crossing the link takes long enough for the pane to have been closed in the
   * meantime — a split followed straight away by `C-a x` is all it takes. An
   * agent in no pane at all is one running with nothing pointing at it, so it
   * goes wherever the focus ended up instead.
   */
  const target = workspaces.hasPane(paneId) ? paneId : workspaces.focusedPaneId;
  workspaces.addTab(agent.id, agent.cwd, target);
  workspaces.focusPane(target);
  // The project an agent is working in is one you can browse; that is the
  // whole basis on which the file tree decides what it may read.
  allowRoot(agent.cwd);
  return agent;
}

/**
 * The same, for the gestures that make a pane rather than ask for a terminal.
 * There is no reply for them to fail: a spawn that cannot happen leaves the pane
 * empty, which is a state the window can still draw and click its way out of.
 */
function fillPane(paneId: string, from?: string): void {
  void openTerminal(paneId, from === undefined ? {} : { from }).catch((err) => {
    console.error("kururu: could not open a terminal:", err instanceof Error ? err.message : err);
  });
}

/** The newest terminal in this workspace, preferring one that is still running. */
function newestAgentHere(): string | undefined {
  const here = new Set(workspaces.agentsHere());
  // host.agents is oldest first, so the last of them is the most recent.
  const mine = host.agents.filter((agent) => here.has(agent.id));
  const live = mine.filter((agent) => !agent.exited);
  return (live.length ? live : mine).at(-1)?.id;
}

/**
 * Reap a terminal the arrangement no longer has room for. Pane and workspace
 * deletion hand back what was inside them; this is what ends it.
 */
function killAll(agentIds: string[]): void {
  for (const agentId of agentIds) {
    host.kill(agentId);
    // It must not be left as a tab pointing at a terminal that no longer exists.
    workspaces.removeTab(agentId);
    // Nor as a sentence about what a dead terminal is doing. Ids are not reused,
    // so this is housekeeping rather than correctness — but the map would
    // otherwise grow for the life of the process.
    activity.delete(agentId);
    lastAgent.delete(agentId);
    forgetRecording(agentId);
    mouseEncodings.delete(agentId);
  }
}

// ---------------------------------------------------------------------------
// The loops that remain
// ---------------------------------------------------------------------------

/** Who is watching what, recomputed whenever it might have changed. */
function syncWatched(): void {
  const watched = new Set<string>();
  for (const st of clients.values()) {
    for (const id of st.watching) watched.add(id);
  }
  host.watch(watched);
}

/**
 * Output arrives already coalesced — the host batches it at one frame, because
 * the flood is on its side of the link and a message per pty write would cross
 * the process boundary as well as the socket. What is left here is fan-out: the
 * same chunk to every client watching that terminal.
 */
function onOutput(agentId: string, data: string): void {
  recordOutput(agentId, data);
  mouseEncodingOf(agentId).read(data);
  for (const [ws, st] of clients) {
    if (!st.watching.has(agentId)) continue;
    const pending = st.awaiting.get(agentId);
    if (pending) pending.queued.push(data);
    else send(ws, { type: "output", agentId, data });
  }
}

/**
 * Start holding a terminal's live output, ready for its backlog to go out first.
 *
 * One rebuild, one hold; the count is what makes overlapping rebuilds safe. See
 * `ClientState.awaiting` for why releasing on the first of them loses bytes.
 */
function openQueue(st: ClientState, agentId: string): void {
  const pending = st.awaiting.get(agentId);
  if (pending) pending.inflight++;
  else st.awaiting.set(agentId, { inflight: 1, queued: [] });
}

/**
 * Size the terminal to the pane that asked, then hand that pane the history.
 *
 * The resize comes first and that ordering is the whole fix. A backlog is the
 * server's emulator *serialized*, and a serialized screen is laid out at a
 * particular width: reconstructed into a grid of a different one it wraps, the
 * rows below shift, and the top scrolls away. The client's buffer then disagrees
 * with the server's about where everything is — permanently, because an agent
 * redraws differentially and never resends a row it believes is already right.
 * That was the borked text on a workspace switch and the cwd sitting inside an
 * agent's input box, and both are the same disagreement.
 *
 * So the pane's grid arrives on the same message as the request, the screen is
 * put into that shape before it is serialized, and the answer names the shape it
 * used. The resize is not debounced here the way a live one is: this is not the
 * box moving, it is a pane arriving, and it happens once.
 *
 * Everything after the `await` re-checks. A pane can close, or the whole socket
 * go away, in the time it takes to drain the write queue and serialize.
 */
async function sendBacklog(
  ws: WebSocket,
  agentId: string,
  cols: number,
  rows: number,
  epoch: number,
): Promise<void> {
  host.resize(agentId, cols, rows);
  /**
   * The serialized screen, plus the one thing it cannot carry. Appended here
   * rather than in `screen.ts` so this fix costs a reconnect and not every agent
   * the user is running; see `mouseencoding.ts` for what is being restored.
   */
  const serialized = await host.backlog(agentId).catch(() => "");
  const data = serialized + mouseEncodingOf(agentId).suffix();
  const st = clients.get(ws);
  const pending = st?.awaiting.get(agentId);
  if (!st || !pending) return;
  const watching = st.watching.has(agentId);
  if (watching) {
    // The bytes, not just the size: a screen rebuilt wrongly can only be
    // explained by replaying exactly what rebuilt it.
    recordNote(agentId, "backlog", `${data.length} bytes rebuilt at ${cols}x${rows}`);
    recordBacklog(agentId, data);
    send(ws, { type: "backlog", agentId, data, cols, rows, epoch });
  }
  // A later rebuild is still being prepared, so the hold stays on for it.
  if (--pending.inflight > 0) return;
  st.awaiting.delete(agentId);
  if (!watching) return;
  for (const queued of pending.queued) send(ws, { type: "output", agentId, data: queued });
}

let lastDevJson = "";

async function pollDevServers(): Promise<void> {
  const servers = await scanDevServers();
  for (const server of servers) allowRoot(server.cwd);
  const proxied = openPreviews();
  for (const server of servers) {
    const proxyPort = proxied.get(server.port);
    if (proxyPort) server.proxyPort = proxyPort;
  }
  // A proxy whose dev server has stopped is holding a port for nothing.
  const live = new Set(servers.map((s) => s.port));
  for (const devPort of proxied.keys()) {
    if (!live.has(devPort)) closePreview(devPort);
  }
  const json = JSON.stringify(servers);
  if (json === lastDevJson) return;
  lastDevJson = json;
  state.devServers = servers;
  broadcast({ type: "dev-servers", servers });
}

/**
 * One timer left in this process. The status heuristic and the process scan went
 * with the ptys — they are questions about processes, and the host is where
 * those live now.
 */
const timers = [setInterval(() => void pollDevServers(), DEV_SCAN_MS)];

void pollDevServers();

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

function reply(ws: WebSocket, id: number, run: () => unknown): void {
  try {
    send(ws, { type: "reply", id, ok: true, result: run() ?? true });
  } catch (err) {
    send(ws, { type: "reply", id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/** The same, for anything that has to cross the link and come back. */
async function replyAsync(ws: WebSocket, id: number, run: () => Promise<unknown>): Promise<void> {
  try {
    send(ws, { type: "reply", id, ok: true, result: (await run()) ?? true });
  } catch (err) {
    send(ws, { type: "reply", id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

function handleMessage(ws: WebSocket, raw: string): void {
  const st = clients.get(ws);
  if (!st) return;

  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw) as ClientMessage;
  } catch {
    return;
  }

  switch (msg.type) {
    // --- terminals ---------------------------------------------------------

    case "new-tab": {
      const paneId = msg.paneId ?? workspaces.focusedPaneId;
      void replyAsync(ws, msg.id, () =>
        openTerminal(paneId, { cwd: msg.cwd, command: msg.command, kind: msg.kind }),
      );
      return;
    }

    case "close-tab": {
      const agentId = msg.agentId ?? workspaces.focusedAgent();
      if (agentId) killAll([agentId]);
      return;
    }

    case "select-tab":
      workspaces.selectTab(msg.paneId, msg.index);
      return;

    case "cycle-tab":
      workspaces.cycleTab(msg.delta, msg.paneId);
      return;

    case "move-tab":
      workspaces.moveTab(msg.agentId, msg.paneId, msg.index);
      return;

    case "split-with":
      workspaces.splitWith(msg.agentId, msg.paneId, msg.dir, msg.before);
      return;

    case "move-tab-to-workspace":
      workspaces.moveTabToWorkspace(msg.agentId, msg.workspaceId);
      return;

    case "rename-tab":
      host.rename(msg.agentId, msg.name);
      return;

    case "input":
      // No reply: this is what the user typed, and it is either delivered or the
      // terminal is visibly dead already.
      recordInput(msg.agentId, msg.data);
      host.write(msg.agentId, msg.data);
      return;

    case "resize":
      // Recorded because a repaint arriving on the wrong side of a resize is the
      // shape of most terminal bugs, and the bytes alone cannot show which.
      recordNote(msg.agentId, "resize", `${msg.cols}x${msg.rows}`);
      host.resize(msg.agentId, msg.cols, msg.rows);
      return;

    case "watch": {
      const next = new Set(msg.agentIds);
      const opened = [...next].filter((id) => !st.watching.has(id));
      st.watching = next;
      // A pane that closed while its backlog was in flight should not receive it.
      for (const id of [...st.awaiting.keys()]) if (!next.has(id)) st.awaiting.delete(id);
      syncWatched();
      /**
       * Streaming starts here and history does not. Watching says which
       * terminals are on screen; it is a set of ids and it cannot say how wide
       * any of them is, so answering it with a reconstruction meant serializing
       * a screen at whatever width the pane that last drew this terminal
       * happened to be. The emulator that is about to draw it asks for itself,
       * and says what shape it is while asking.
       */
      for (const id of opened) recordNote(id, "watch", "a client opened this terminal");
      return;
    }

    case "request-backlog":
      // Queue this terminal's live output behind the history: the client is
      // about to clear its emulator, and anything that overtakes the answer
      // would be wiped by it. `openQueue` counts rather than sets, so two
      // rebuilds in flight at once do not release each other's hold.
      openQueue(st, msg.agentId);
      void sendBacklog(ws, msg.agentId, msg.cols, msg.rows, msg.epoch);
      return;

    // --- panes -------------------------------------------------------------

    case "split": {
      // The half you were in is where the new one's directory comes from: it has
      // a terminal in it that can be asked where it is now, which is better than
      // the directory the pane was recorded as being for.
      const from = msg.paneId ?? workspaces.focusedPaneId;
      const fresh = workspaces.split(msg.dir, from);
      if (fresh) fillPane(fresh, from);
      return;
    }

    case "close-pane":
      killAll(workspaces.closePane(msg.paneId));
      return;

    case "focus-pane":
      workspaces.focusPane(msg.paneId);
      return;

    case "focus-dir":
      workspaces.focusDirection(msg.dir);
      return;

    case "step-pane":
      workspaces.stepFocus(msg.delta);
      return;

    case "set-ratio":
      workspaces.setRatio(msg.splitId, msg.ratio);
      return;

    case "nudge":
      workspaces.nudge(msg.dir, msg.delta);
      return;

    case "swap-panes":
      workspaces.swapPanes(msg.paneId, msg.withPaneId);
      return;

    case "move-pane":
      workspaces.movePane(msg.paneId, msg.toPaneId, msg.dir, msg.before);
      return;

    case "merge-panes":
      workspaces.mergePanes(msg.paneId, msg.intoPaneId);
      return;

    // --- workspaces --------------------------------------------------------

    case "new-workspace":
      // A workspace is one piece of work, so its first terminal starts in the
      // directory a terminal opened in it would: `cwdForNewTab` finds nothing
      // here to follow, which is the honest answer for work not started yet.
      workspaces.newWorkspace(msg.name);
      fillPane(workspaces.focusedPaneId);
      return;

    case "switch-workspace":
      workspaces.switchWorkspace(msg.workspaceId);
      return;

    case "workspace-index":
      workspaces.switchWorkspaceByIndex(msg.index);
      return;

    case "step-workspace":
      workspaces.stepWorkspace(msg.delta);
      return;

    case "last-workspace":
      workspaces.lastWorkspace();
      return;

    case "rename-workspace":
      workspaces.renameWorkspace(msg.workspaceId, msg.name);
      return;

    case "set-workspace-color":
      workspaces.setWorkspaceColor(msg.workspaceId, msg.color);
      return;

    case "set-workspace-mascot":
      workspaces.setWorkspaceMascot(msg.workspaceId, msg.mascotId);
      return;

    // --- the mascot --------------------------------------------------------
    /**
     * The selection is adopted rather than trusted: it arrives from a client,
     * and `adoptMascot` is what turns "a number somebody dragged too far" into
     * the nearest legal one. A sheet that does not exist is refused there and
     * falls back, so what gets written is always something that can be drawn.
     *
     * A message naming a mascot that is not there is dropped rather than
     * creating one. Settings only ever edits something it is looking at, so this
     * is a message from a window whose list is a moment out of date, and
     * resurrecting a deleted mascot is a worse answer than losing one drag.
     */
    case "set-mascot": {
      const one = mascots.list.find((m) => m.id === msg.id);
      if (!one) return;
      saveMascots({
        ...mascots,
        // Id and name first, so the file stays readable to the person it says
        // can edit it by hand.
        list: mascots.list.map((m) =>
          m.id === msg.id ? { id: m.id, name: m.name, ...adoptMascot(msg.mascot) } : m,
        ),
      });
      return;
    }

    /**
     * A copy of the one you are looking at, not a fresh default: you press this
     * when the thing in front of you is nearly right, and starting from the
     * default frog would throw away the sheet and the cell size you had just
     * found. It becomes the active one, because adding something you then have
     * to go and click is a step that decided nothing.
     */
    case "add-mascot": {
      const from = mascots.list.find((m) => m.id === (msg.from ?? mascots.default)) ?? mascots.list[0]!;
      const id = freshMascotId(mascots.list);
      saveMascots({
        ...mascots,
        // Capped here rather than left for the adopter, or a name copied enough
        // times would come back forty characters shorter than it went in.
        list: [...mascots.list, { ...from, id, name: `${from.name} copy`.slice(0, 40) }],
      });
      return;
    }

    /**
     * The last one cannot go. An empty list would mean a working agent with
     * nothing in its row, which is the one thing the mascot exists to prevent —
     * so the button is hidden rather than the message refused, and this is the
     * backstop for the window that had two of them a second ago.
     */
    case "remove-mascot": {
      if (mascots.list.length < 2) return;
      const list = mascots.list.filter((m) => m.id !== msg.id);
      if (list.length === mascots.list.length) return;
      saveMascots({
        default: list.some((m) => m.id === mascots.default) ? mascots.default : list[0]!.id,
        list,
      });
      return;
    }

    case "rename-mascot": {
      const name = msg.name.trim().slice(0, 40);
      if (!name) return;
      saveMascots({ ...mascots, list: mascots.list.map((m) => (m.id === msg.id ? { ...m, name } : m)) });
      return;
    }

    case "set-default-mascot": {
      if (!mascots.list.some((m) => m.id === msg.id)) return;
      saveMascots({ ...mascots, default: msg.id });
      return;
    }

    // --- the keyboard ------------------------------------------------------
    /**
     * `bindKey` is where the checking is, and it is shared with the client for
     * the usual reason: the action has to be one of the ones that exist and the
     * key has to be one a person can press, and two spellings of that would
     * disagree about exactly the case that matters. It returns the overrides
     * unchanged when it refuses, so a bad message is a no-op rather than an
     * error nobody is listening for.
     */
    case "bind-key": {
      keys = bindKey(keys, msg.key, msg.action);
      writeKeys(keys);
      pushSnapshot();
      return;
    }

    case "reset-keys": {
      keys = {};
      writeKeys(keys);
      pushSnapshot();
      return;
    }

    case "delete-workspace":
      killAll(workspaces.deleteWorkspace(msg.workspaceId));
      return;

    case "move-workspace":
      workspaces.moveWorkspace(msg.workspaceId, msg.index);
      return;

    // --- profiles ----------------------------------------------------------

    case "new-profile":
      workspaces.newProfile(msg.name);
      fillPane(workspaces.focusedPaneId);
      return;

    case "switch-profile":
      workspaces.switchProfile(msg.profileId);
      return;

    case "rename-profile":
      workspaces.renameProfile(msg.profileId, msg.name);
      return;

    case "delete-profile":
      killAll(workspaces.deleteProfile(msg.profileId));
      return;

    case "restart-server":
      // Only the main process can re-fork us; running standalone there is
      // nobody to ask, and nothing that a restart would preserve anyway.
      parentPort?.postMessage({ type: "restart" });
      return;

    case "open-preview": {
      try {
        openPreview(msg.port);
      } catch {
        // out of preview ports; the next dev-servers push just omits proxyPort
      }
      lastDevJson = "";
      void pollDevServers();
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function json(res: ServerResponse, body: unknown, status = 200): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

function text(res: ServerResponse, body: string, status = 200): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

/** Read a JSON request body, with a cap — this endpoint is tailnet-reachable. */
/**
 * A little over the sheet cap, so a file that is too big is refused by the thing
 * that can say *why* rather than by the socket closing mid-upload.
 */
const IMPORT_LIMIT = 2 * 1024 * 1024;

/** The body, as bytes. What `readJsonBody` is built on, minus the parse. */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("that file is far too big"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function readJsonBody(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("body is not JSON"));
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(res: ServerResponse, rel: string): void {
  const file = join(WEB_DIST, rel);
  let isFile = false;
  try {
    isFile = statSync(file).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    // Unknown paths fall through to index.html so the client router owns them.
    const index = join(WEB_DIST, "index.html");
    if (!existsSync(index)) {
      text(res, "kururu: web app not built. Run `bun run build`.", 404);
      return;
    }
    res.writeHead(200, { "content-type": CONTENT_TYPES[".html"]! });
    createReadStream(index).pipe(res);
    return;
  }
  res.writeHead(200, { "content-type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

  if (url.pathname === "/api/health") {
    json(res, {
      ok: true,
      agents: host.agents.length,
      liveAgents: host.agents.filter(countsAsAgent).length,
      devServers: state.devServers.length,
    });
    return;
  }

  /**
   * How an agent tells kururu what it is doing. The only source of `blocked`
   * and of context usage; see agents/report.ts for why neither is inferable.
   */
  if (url.pathname === "/api/report") {
    if (req.method !== "POST") {
      text(res, "POST only", 405);
      return;
    }
    try {
      const parsed = parseReport(await readJsonBody(req));
      if (!parsed) {
        json(res, { error: "need a valid status or context" }, 400);
        return;
      }
      // An agent that does not name itself is the common case: the hook runs
      // inside the pty, so its own environment already says which one it is.
      const agentId = parsed.agentId ?? process.env.KURURU_AGENT_ID ?? null;
      if (!agentId || !host.find(agentId)) {
        json(res, { error: "no such agent" }, 404);
        return;
      }
      host.report(agentId, parsed.report);
      /**
       * The host is told the status and the context; the message stops here.
       * It is the one part of a report that says something about the work rather
       * than about the process, so it is the one part the host has no use for —
       * see `activity` beside `snapshot()`. Trimmed and capped on the way in
       * because it is drawn in a sidebar one line high, and an agent that
       * reported a paragraph would otherwise be storing one per turn.
       */
      const said = parsed.report.message?.replace(/\s+/g, " ").trim();
      if (said) activity.set(agentId, said.slice(0, MAX_ACTIVITY));
      json(res, { ok: true });
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 400);
    }
    return;
  }

  /**
   * The last little while of one terminal's raw stream, for diagnosing something
   * that has already happened. Plain text, deliberately: it is read by a person,
   * usually by piping it into a file. See `record.ts`.
   */
  if (url.pathname === "/api/record") {
    const agentId = url.searchParams.get("agent") ?? "";
    if (!agentId || !host.find(agentId)) {
      text(res, "no such agent\n", 404);
      return;
    }
    text(res, dumpRecording(agentId, Number(url.searchParams.get("tail")) || undefined));
    return;
  }

  /**
   * One sprite sheet. `?sheet=` names it — Settings asks for each in turn to
   * draw its picker — and without one you get whichever is currently selected,
   * which is all a row drawing a badge ever needs to know.
   *
   * An endpoint rather than a static file because most sheets live outside the
   * app entirely, in the user's config directory, and because the name has to be
   * checked against the list rather than pasted into a path: this is reachable
   * from the tailnet. `no-cache` so a
   * user who overwrites their own sheet sees it after a reload rather than after
   * a restart; the sheets that ship never change, and they are fifteen kilobytes.
   */
  if (url.pathname === "/api/mascot.png") {
    const body = sheetImage(url.searchParams.get("sheet") ?? defaultMascot(mascots).sheet);
    if (!body) {
      text(res, "no such sheet\n", 404);
      return;
    }
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[".png"]!,
      "content-length": body.length,
      "cache-control": "no-cache",
    });
    res.end(body);
    return;
  }

  /**
   * What Settings may offer. Not in the snapshot: it is a catalogue, wanted once
   * by one dialog, and putting it on every status change would be paying for it
   * continuously to save one request nobody makes twice.
   *
   * The two lists are kept apart because they are not the same kind of thing to
   * the UI: one of them has a remove button. `dir` is there so the dialog can
   * tell you where they went without spelling the path a second time.
   *
   * DELETE removes one of yours. It is the same shape as the import below — a
   * name, checked against the list of imported sheets and nothing else.
   */
  if (url.pathname === "/api/mascot/sheets") {
    if (req.method === "DELETE") {
      const name = url.searchParams.get("name") ?? "";
      if (!removeSheet(name)) {
        json(res, { error: "no such imported sheet" }, 404);
        return;
      }
      json(res, { ok: true, builtin: builtinSheets(), imported: importedSheets(), dir: sheetsDir() });
      return;
    }
    json(res, { builtin: builtinSheets(), imported: importedSheets(), dir: sheetsDir() });
    return;
  }

  /**
   * A sheet somebody picked in a file dialog, on its way to `~/.config/kururu/sheets`.
   *
   * The body is the file, not JSON and not a form: it is one PNG going to one
   * place, and multipart would be a parser to maintain for a boundary nobody
   * needs. The name travels in the query so the bytes can stay the bytes.
   *
   * Every check is in `importSheet` rather than here, because this is the one
   * endpoint that writes a file to the user's config directory on behalf of a
   * client, and the checks belong beside the write rather than beside the route.
   */
  if (url.pathname === "/api/mascot/import") {
    if (req.method !== "POST") {
      text(res, "POST only", 405);
      return;
    }
    let bytes: Buffer;
    try {
      bytes = await readBody(req, IMPORT_LIMIT);
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : "could not read that file" }, 413);
      return;
    }
    const result = importSheet(url.searchParams.get("name") ?? "", bytes);
    if (!result.ok) {
      json(res, { error: result.error }, 400);
      return;
    }
    json(res, { name: result.name, builtin: builtinSheets(), imported: importedSheets(), dir: sheetsDir() });
    return;
  }

  // --- file browsing -------------------------------------------------------
  if (url.pathname === "/api/roots") {
    json(res, { roots: allowedRoots() });
    return;
  }
  if (url.pathname === "/api/ls" || url.pathname === "/api/file") {
    const root = url.searchParams.get("root") ?? "";
    const path = url.searchParams.get("path") ?? "";
    try {
      json(res, url.pathname === "/api/ls" ? { entries: listDir(root, path) } : readFile(root, path));
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 400);
    }
    return;
  }

  if (process.env.KURURU_DEV === "1" && !existsSync(join(WEB_DIST, "index.html"))) {
    text(
      res,
      `kururu server is up on :${PORT}.\nThe UI is not built — run \`bun run build\`, or let the desktop app start vite.\n`,
    );
    return;
  }

  serveStatic(res, url.pathname === "/" ? "index.html" : url.pathname.slice(1));
}

// ---------------------------------------------------------------------------
// Listen
// ---------------------------------------------------------------------------

const server = createServer((req, res) => {
  void handleRequest(req, res).catch(() => {
    if (!res.headersSent) text(res, "kururu: internal error", 500);
    else res.destroy();
  });
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.set(ws, { watching: new Set(), awaiting: new Map() });
    send(ws, { type: "snapshot", snapshot: snapshot() });
    send(ws, { type: "dev-servers", servers: state.devServers });

    ws.on("message", (data) => handleMessage(ws, data.toString()));
    ws.on("close", () => {
      clients.delete(ws);
      syncWatched();
    });
    ws.on("error", () => {
      clients.delete(ws);
      syncWatched();
    });
  });
});

/** A websocket held open by a sleeping phone must not be hung up on. */
server.keepAliveTimeout = 0;
server.headersTimeout = 0;
server.requestTimeout = 0;

// ---------------------------------------------------------------------------
// Coming up
// ---------------------------------------------------------------------------

/**
 * Attach to the pty host, work out what the window is supposed to look like,
 * and only then start serving.
 *
 * The order of preference for the arrangement is the whole point of the split.
 * The host's blob is what a server *we* replaced left behind a moment ago —
 * complete, with every tab still pointing at a live pty — so a restart is
 * invisible. The file on disk is the cold-start fallback, and it has the
 * processes stripped out because they are not coming back. Neither is trusted
 * blindly: a tab pointing at a terminal the host does not have is dropped,
 * which is what stops a stale blob from showing tabs that are not there.
 */
async function attach(port: Port): Promise<void> {
  host = new HostLink(port);
  host.onAgents = pushSnapshot;
  host.onOutput = onOutput;

  const state = await host.hello();
  const live = new Set(state.agents.filter((agent) => !agent.exited).map((agent) => agent.id));

  let profiles: Profile[] | undefined;
  let activeProfileId: string | undefined;
  if (state.blob) {
    try {
      const kept = JSON.parse(state.blob) as { profiles: Profile[]; activeProfileId: string };
      profiles = kept.profiles;
      activeProfileId = kept.activeProfileId;
    } catch {
      // A blob we cannot read is no worse than not having one.
    }
  }
  if (!profiles) {
    const fromDisk = readSnapshot();
    profiles = fromDisk?.profiles;
    activeProfileId = fromDisk?.activeProfileId;
  }

  workspaces = new Workspaces(profiles);
  if (activeProfileId) workspaces.switchProfile(activeProfileId);
  for (const agentId of workspaces.allAgents()) {
    if (!live.has(agentId)) workspaces.removeTab(agentId);
  }
  // An agent the host has but no layout mentions would be running with nothing
  // pointing at it — put it somewhere rather than leave it unreachable.
  const placed = new Set(workspaces.allAgents());
  for (const agent of state.agents) {
    if (!placed.has(agent.id)) workspaces.addTab(agent.id, agent.cwd);
  }

  workspaces.onChange = () => {
    pushSnapshot();
    queueSave();
  };
  for (const agent of state.agents) allowRoot(agent.cwd);

  /**
   * A first run — no blob, no file on disk, nothing running — is the one
   * restore-shaped case that opens a terminal. `persist.ts` deliberately brings
   * panes back empty and this does not change that: there is nothing to bring
   * back here. The blank pane in a blank profile is a pane being *made*, and a
   * pane being made gets a terminal like every other one.
   */
  if (!profiles && state.agents.length === 0) fillPane(workspaces.focusedPaneId);

  server.listen(PORT, "0.0.0.0", () => {
    const built = existsSync(join(WEB_DIST, "index.html"));
    console.log(`kururu server  http://localhost:${PORT}`);
    console.log(`  agents       ${state.agents.length} held by the pty host`);
    console.log(`  web app      ${built ? WEB_DIST : "not built — bun run build"}`);
  });
}

/**
 * How this process is started, in the two arrangements that exist.
 *
 * Under Electron the main process forks a pty host beside us and hands us a port
 * to it. Standalone — `bun run dev`, or a test — there is nobody to do that, so
 * we build a host in this process and link to it locally. The second one has no
 * restart guarantee, but there was never a second process to restart.
 */
const parentPort = (process as NodeJS.Process & {
  parentPort?: {
    on(ev: string, fn: (e: { data: unknown; ports?: Port[] }) => void): void;
    postMessage(msg: unknown): void;
  };
}).parentPort;

if (parentPort) {
  parentPort.on("message", (event) => {
    const data = event.data as { type?: string } | null;
    const linked = event.ports?.[0];
    if (data?.type === "link" && linked && !host) void attach(linked);
  });
} else {
  const { createPtyHost } = await import("./ptyhost");
  const { localPortPair } = await import("./hostlink");
  const [mine, theirs] = localPortPair();
  createPtyHost().attach(theirs);
  await attach(mine);
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

/**
 * What this process owns, which is deliberately not much any more. The ptys are
 * the host's, and it is told to let go of them by the main process rather than
 * by us — a server being torn down is usually just a server being replaced.
 */
let stopping: Promise<void> | null = null;
export function shutdown(): Promise<void> {
  if (stopping) return stopping;
  stopping = (async () => {
    for (const timer of timers) clearInterval(timer);
    // The arrangement outlives this process either way; flush it while it is whole.
    if (saveTimer) clearTimeout(saveTimer);
    if (workspaces) writeSnapshot(workspaces.all(), workspaces.active.id);
    closeAllPreviews();
    for (const ws of clients.keys()) {
      try { ws.terminate(); } catch { /* already gone */ }
    }
    clients.clear();
    wss.close();
    server.close();
    server.closeAllConnections();
  })();
  return stopping;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown().then(() => process.exit(0));
  });
}
