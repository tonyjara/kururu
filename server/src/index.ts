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
 * Runs on Node rather than Bun, which was once because Electron loaded it and is
 * now simply what it is: the bundle is built for node and the desktop no longer
 * starts it at all. Nothing here may import electron — this process is something
 * you run, possibly on a machine with no window on it, and the window is one
 * client of it exactly as the phone is.
 */
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { adoptIdentity, adoptMascot, countsAsAgent, defaultMascot } from "../../shared/model";
import { bindKey } from "../../shared/keys";
import type { AgentSnapshot, MascotSet, Profile, PtyKind, SessionSnapshot } from "../../shared/model";
import type { ClientMessage, DevServer, ServerMessage } from "../../shared/wire";
import { DEV_SCAN_MS, SAVE_DEBOUNCE_MS } from "../../shared/wire";
import { parseReport } from "./agents/report";
import { dump as dumpRecording, forget as forgetRecording, recordBacklog, recordInput, recordNote, recordOutput } from "./record";
import { processCwd } from "./cwd";
import { scanDevServers, stopDev, type DevProc } from "./devservers";
import { allowedRoots, allowRoot, findDocs, listDir, readBytes, readFile, resolveInRoot } from "./files";
import {
  describeIdentity,
  ensureClaudeDir,
  ensureGhConfig,
  expandHome,
  ghIn,
  identityEnv,
  knownAccounts,
  shellQuote,
  tildify,
} from "./identity";
import { renderMarkdown } from "./markdown";
import { scanMemory } from "./memory";
import { attach as attachEditor, findNvim } from "./nvim";
import { panes } from "../../shared/layout";
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
import { readAppearance, writeAppearance } from "./appearance";
import { adoptAppearance, themeFor, type Appearance } from "../../shared/theme";
import { skinFor } from "../../shared/skin";
import { HostLink, type Port } from "./hostlink";
import { connectToHost, hostSocketPath, type SocketPort } from "./hostsock";
import { MouseEncoding } from "./mouseencoding";
import { readSnapshot, writeSnapshot } from "./persist";
import { closeAllPreviews, closePreview, openPreview, openPreviews } from "./proxy";
import { reach } from "./reach";
import { smallestGrid, type Grid } from "./sizing";
import { Workspaces } from "./workspaces";

const PORT = Number(process.env.KURURU_PORT ?? 7717);

/**
 * The exit code that means "start me again", as opposed to the ones that mean
 * anything else. A restart has to be distinguishable from a crash or a clean
 * stop, or a supervisor either resurrects a server that was asked to go away or
 * declines to bring back one that asked to come back. 75 is sysexits' TEMPFAIL,
 * which is as close as a standard list gets to the sentiment.
 */
const RESTART_EXIT_CODE = 75;
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
   * Terminals this client keeps an emulator for without showing them.
   *
   * The browser pools emulators by agent id and moves them between panes rather
   * than rebuilding them, which only works if a pooled one goes on being fed —
   * an emulator that stops receiving output is an emulator that has to be
   * reconstructed, and reconstruction is the whole cost pooling removes. So
   * output goes to the *union* of this and `watching`.
   *
   * It is a second set rather than more ids in the first because `watching`
   * answers a question this cannot: what a human can actually see. The unread
   * mark is exactly that question, and folding the two together would mean no
   * terminal a client had pooled could ever be marked unread again.
   */
  warm: Set<string>;
  /**
   * The grid each of this client's panes says it could draw that terminal at.
   *
   * A proposal, never an instruction — see `applySize` for what is done with
   * them. Kept per client rather than reduced on arrival because the policy is
   * a minimum over the clients that can *see* the terminal, and a client going
   * away or looking elsewhere changes the answer without anybody proposing
   * anything.
   *
   * Withdrawn by `watch`: a terminal a client no longer lists as visible loses
   * its entry here. That is deliberately the same message that already says
   * what a human can see, rather than a second one that could disagree with it
   * — and it is what stops a warm client, whose detached emulator cannot
   * measure a box and so never proposes anyway, from having a vote.
   */
  proposals: Map<string, Grid>;
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
let appearance = readAppearance();

/**
 * Every appearance change is the same two steps the mascot's are — write it
 * down, then tell every client — and the snapshot is the answer, exactly as it
 * is to a split. Nothing here restarts, reloads or repaints anything: the
 * window redraws because the snapshot it is rendering changed, which is what
 * makes a theme picked on the desktop land on the phone without either of them
 * knowing about the other.
 */
function saveAppearance(next: Appearance): void {
  appearance = next;
  writeAppearance(next);
  pushSnapshot();
}

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
    appearance,
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

/**
 * Terminals that have said something while nobody had them on screen.
 *
 * This used to be the host's, and it was right there for as long as "watched"
 * and "visible" were the same set. They are not any more: a client pools
 * emulators and the host is told to stream the union, so the host now clears its
 * own mark for every terminal a client is merely keeping warm — which is every
 * terminal you might want the mark for.
 *
 * So the *answer* moves here, for the same reason `activity` lives here: it is
 * learnt from something only this side knows, and losing it on a restart costs
 * a dot that the next byte of output puts back. What stays on the host is the
 * case this side cannot see at all — a terminal in neither set is never streamed
 * to this process, so its output never reaches `onOutput` and only the host can
 * notice it. `overlay` therefore *ors* the two rather than replacing one with
 * the other: the host answers for what it is not streaming, this answers for
 * what it is.
 */
const unread = new Set<string>();

/**
 * Whether this client's emulators want that terminal's bytes — on screen or
 * merely kept. Everything that fans output out, or holds it back for a backlog,
 * asks this rather than `watching`, because a warm emulator that stops being fed
 * is a warm emulator that has to be rebuilt.
 */
function sees(st: ClientState, agentId: string): boolean {
  return st.watching.has(agentId) || st.warm.has(agentId);
}

/** Agent id → the agent program last seen in it. See AgentSnapshot.lastAgent. */
const lastAgent = new Map<string, string>();

/**
 * How much memory each terminal is holding, in bytes, by agent id.
 *
 * Here rather than on the host for the reason `activity` and `lastAgent` are:
 * it is read out of the process table, the pty host has nothing to do with it,
 * and losing it on a restart costs one poll. See `memory.ts` for what the figure
 * covers — and for why it is rounded before it lands in here rather than on the
 * way out, which is what stops a number that never holds still from being a
 * broadcast that never stops.
 */
const memory = new Map<string, number>();

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
  const serving = devRunning.get(agent.id);
  const fresh = unread.has(agent.id);
  const held = memory.get(agent.id);
  if (!said && !was && !serving && !fresh && !held) return agent;
  return {
    ...agent,
    ...(said ? { activity: said } : {}),
    ...(was ? { lastAgent: was } : {}),
    ...(serving ? { dev: serving.program } : {}),
    ...(held ? { rss: held } : {}),
    // Only ever set, never cleared: see `unread`. The host still answers for the
    // terminals it is not streaming to this process.
    ...(fresh ? { unread: true } : {}),
  };
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
 * Sign a profile in to an account, by opening a terminal and typing the line a
 * person would type.
 *
 * Neither flow can happen in a dialog: both are a browser, a code to paste and a
 * few questions, and the only thing kururu could add by wrapping them is a place
 * for them to go wrong silently. So this is the dev-server button's approach for
 * the same reason it was right there — the useful part is the setup around the
 * command, not the command — and it happens in the profile it is about, switched
 * to first, so that what comes next is on screen rather than in a pane somewhere
 * else. A new tab rather than a live one, because the one thing worse than a
 * login prompt you cannot find is a login prompt typed into a waiting agent.
 *
 * The two tools want opposite things and that is the whole of the difference
 * here. A Claude account *is* a config directory, so this makes sure the profile
 * has one of its own before anything is typed — signing in with nothing set
 * would put the new account in `~/.claude` and replace the one the machine had.
 * A github account is a name gh holds in its keyring, so the login belongs in
 * gh's own config where it is registered once and pickable from every profile;
 * hence `env -u`, undoing this profile's override for the length of one command
 * rather than adding a second account to a directory named after the first.
 *
 * **Both lines name their own environment rather than relying on the pty's, and
 * that is not belt and braces.** The overlay is applied by the pty host, which is
 * the one process in kururu that does not restart when you edit it — so there is
 * a window, every time this feature changes, where the server sends an `env` the
 * running host is too old to understand and drops. A terminal that quietly opens
 * as the wrong account is a bad afternoon; a *login* that quietly goes to the
 * wrong directory replaces an account somebody had. It cost exactly that once,
 * with the profile's directory left empty and the default written instead. A
 * command that states its target works on any host and, being on screen, says
 * where it is going while it goes there.
 */
async function signIn(profileId: string, tool: "claude" | "gh"): Promise<void> {
  workspaces.switchProfile(profileId);
  const profile = workspaces.active;
  if (profile.id !== profileId) return;

  let command = "env -u GH_CONFIG_DIR gh auth login";
  if (tool === "claude") {
    let dir = profile.identity.claudeConfigDir;
    if (!dir) {
      dir = tildify(ensureClaudeDir(profile.name));
      workspaces.setProfileIdentity(profileId, { ...profile.identity, claudeConfigDir: dir });
    }
    command = `CLAUDE_CONFIG_DIR=${shellQuote(expandHome(dir))} claude auth login`;
  }

  const agent = await openTerminal(workspaces.focusedPaneId);
  await settle(DEV_SPAWN_SETTLE_MS);
  if (!host.isLive(agent.id)) return;
  typeCommand(agent.id, command, "sign-in");
}

/**
 * Which accounts the pty about to be spawned belongs to.
 *
 * The active profile's, unless the workspace it is landing in has borrowed
 * somebody else's — which is the one thing a profile could not express, because
 * a profile is one set of accounts and a workspace is one piece of work, and the
 * afternoon those disagree is the afternoon a repository of your own turns up in
 * your work profile.
 *
 * It is still read here rather than carried on the message, for the same reason
 * the layout is the server's: what a client sends is a *pointer* at a profile it
 * can already see, never three paths of its own. A client that named its own
 * environment would be a client that could name any environment, and this one is
 * reachable from the tailnet.
 *
 * The workspace defaults to the active one because that is where every gesture
 * that reaches a spawn happens — a split, a new tab, a new workspace — with one
 * exception that is the whole reason this takes an argument at all: ▸ on a
 * workspace row deliberately starts a dev server somewhere you are not looking,
 * and it must start it as that workspace's accounts rather than as the ones
 * belonging to the workspace you happen to be standing in.
 *
 * Undefined when nobody has been claimed, which is the common case and means the
 * host spawns exactly as it always did.
 */
function spawnEnv(workspaceId = workspaces.activeWorkspace.id): Record<string, string> | undefined {
  return identityEnv(workspaces.identityForWorkspace(workspaceId));
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
    env: spawnEnv(),
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
    memory.delete(agentId);
    unread.delete(agentId);
    sizes.delete(agentId);
    for (const st of clients.values()) st.proposals.delete(agentId);
    forgetRecording(agentId);
    mouseEncodings.delete(agentId);
  }
}

// ---------------------------------------------------------------------------
// The loops that remain
// ---------------------------------------------------------------------------

/**
 * What the host should stream, recomputed whenever it might have changed: every
 * terminal any client has on screen, plus every one any client is keeping an
 * emulator for. The union, because a pooled emulator that stops being fed is one
 * that has to be reconstructed — see `ClientState.warm`.
 *
 * The host reads its watched set as "somebody is looking at this" and clears
 * `unread` for all of it, which is why that mark is answered on this side now.
 */
function syncWatched(): void {
  const watched = new Set<string>();
  for (const st of clients.values()) {
    for (const id of st.watching) watched.add(id);
    for (const id of st.warm) watched.add(id);
  }
  host.watch(watched);
}

/**
 * The shape each terminal is, as decided here rather than claimed by a pane.
 *
 * Empty at startup and filled by the first proposal, which is the honest state
 * of affairs: a pty the host spawned has whatever grid the host gave it, this
 * process has no way to ask, and the first client to put a pane on it is the
 * first thing that makes the size a decision anybody made. See `ownedGrid` for
 * the one path that has to answer before that has happened.
 */
const sizes = new Map<string, Grid>();

/**
 * The shape to fall back on for a terminal nothing has ever proposed a size for
 * — and it is applied, not merely reported, which is what makes it safe.
 *
 * It mirrors the spawn grid in `agents/screen.ts` rather than importing it:
 * that module is the pty host's and pulling it in here would drag a headless
 * xterm into this bundle, and the alternative — a constant they share — means
 * editing a file in `agents/`, which costs the user every agent they are
 * running. A mirror that has drifted therefore has to be harmless, and it is:
 * the screen is put into this shape before it is serialized, so the answer
 * names a grid that is true whether or not the guess matched.
 *
 * Nothing should reach it. `web/src/session.ts` sends `propose-size` and
 * `request-backlog` from one function for exactly this reason, so by the time
 * a history is being built the server owns a size for that terminal.
 */
const FALLBACK_GRID: Grid = {
  cols: Number(process.env.KURURU_COLS) || 120,
  rows: Number(process.env.KURURU_ROWS) || 40,
};

/**
 * The grid a terminal is at, establishing one if nobody has ever said.
 *
 * A read in every case that matters. The write is the cold path above, and it
 * resizes rather than guessing quietly, because a caller asking this is about
 * to lay a screen out in the answer.
 */
function ownedGrid(agentId: string): Grid {
  const had = sizes.get(agentId);
  if (had) return had;
  host.resize(agentId, FALLBACK_GRID.cols, FALLBACK_GRID.rows);
  const grid = { ...FALLBACK_GRID };
  sizes.set(agentId, grid);
  return grid;
}

/**
 * Decide how big a terminal is, resize it, and tell everybody drawing it.
 *
 * This is the inversion Part 2 of the lifecycle rework exists for. A pane used
 * to fit its emulator to its own box and inform the pty afterwards, so the size
 * was whichever client resized last — which is fine with one window, is why a
 * phone made the desktop ragged, and, worse, let the client and the pty hold
 * two ideas of the shape at once. Every screen kururu has drawn wrong has been
 * that disagreement. Now the pty is resized first and each client's emulator
 * conforms to what it is told, in that order, so the two cannot diverge.
 *
 * The policy itself is `sizing.ts`, which argues for it. What is here is whose
 * proposals are still in play, and the answer is *everyone who has one* — with
 * no test against `watching`, deliberately. A pane measures its box in a layout
 * effect and the watch listing it arrives a passive effect later, so a proposal
 * is reliably the first this server hears of a terminal being on screen;
 * requiring `watching` to already contain it would mean answering the first
 * backlog at a size nobody asked for and correcting it a moment afterwards. So
 * a proposal counts from the moment it arrives, and `watch` is what takes it
 * away again — which is also what keeps a warm client, whose detached emulator
 * cannot measure a box and so never proposes anyway, out of the minimum.
 */
function applySize(agentId: string): void {
  const proposals: Grid[] = [];
  for (const st of clients.values()) {
    const proposed = st.proposals.get(agentId);
    if (proposed) proposals.push(proposed);
  }
  const next = smallestGrid(proposals);
  if (!next) return;
  const { cols, rows } = next;
  const had = sizes.get(agentId);
  if (had && had.cols === cols && had.rows === rows) return;
  sizes.set(agentId, next);
  // Recorded for the same reason an input is: a repaint arriving on the wrong
  // side of a resize is the shape of most terminal bugs, and the bytes alone
  // cannot show which side it was on.
  recordNote(agentId, "resize", `${cols}x${rows}`);
  host.resize(agentId, cols, rows);
  /**
   * Warm clients are told too. A pooled emulator that is off screen is still
   * being fed bytes the agent laid out for the pty's grid, so an emulator left
   * at the old shape would wrap every one of them — and it would carry that
   * damage into the pane that borrows it next, having asked for nothing,
   * because there is nothing about a tab switch that says a rebuild is needed.
   */
  for (const [ws, st] of clients) {
    if (sees(st, agentId)) send(ws, { type: "grid", agentId, cols, rows });
  }
}

/**
 * A client went away, which is a window closing, a phone going to sleep, or
 * this server being about to be replaced. Everything it was holding open goes
 * with it: the terminals it had streaming, and its say in how big they are.
 *
 * The sizes are decided again *after* it is out of the map, so its proposals
 * are gone from the minimum. Closing the narrow window is how the wide one gets
 * its columns back, and without this the last shape a departed client asked for
 * would outlive it for as long as the terminal did.
 */
function dropClient(ws: WebSocket): void {
  const st = clients.get(ws);
  if (!st) return;
  clients.delete(ws);
  syncWatched();
  for (const agentId of st.proposals.keys()) applySize(agentId);
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
  let onScreen = false;
  for (const [ws, st] of clients) {
    if (st.watching.has(agentId)) onScreen = true;
    if (!sees(st, agentId)) continue;
    const pending = st.awaiting.get(agentId);
    if (pending) pending.queued.push(data);
    else send(ws, { type: "output", agentId, data });
  }
  // Output nobody is looking at is the definition of unread — and "looking at"
  // is the visible set, never the warm one. A pooled emulator in a workspace you
  // are not in is being kept current, not being read.
  if (!onScreen && !unread.has(agentId)) {
    unread.add(agentId);
    pushSnapshot();
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
 * Hand a pane the history of a terminal, at the size the server owns.
 *
 * It used to resize first, to whatever grid the asking pane claimed on the
 * request, because a backlog is the server's emulator *serialized* and a
 * serialized screen is laid out at a particular width: reconstructed into a
 * grid of a different one it wraps, the rows below shift, and the top scrolls
 * away. The client's buffer then disagrees with the server's about where
 * everything is — permanently, because an agent redraws differentially and
 * never resends a row it believes is already right. That was the borked text on
 * a workspace switch and the cwd sitting inside an agent's input box.
 *
 * The shape still has to be right; what changed is who says so. It is settled
 * before this is ever called, by the `propose-size` the client sends in the
 * same breath as its request, so there is nothing to resize here and nothing to
 * take a pane's word for. The answer names the grid all the same — a screen
 * that states its own shape is correct for whoever receives it, and that is
 * worth keeping for the one ordering a single size does not cover.
 *
 * Everything after the `await` re-checks. A pane can close, the whole socket go
 * away, or the size be decided again by another client, in the time it takes to
 * drain the write queue and serialize.
 */
async function sendBacklog(ws: WebSocket, agentId: string): Promise<void> {
  const { cols, rows } = ownedGrid(agentId);
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
  const watching = sees(st, agentId);
  if (watching) {
    // The bytes, not just the size: a screen rebuilt wrongly can only be
    // explained by replaying exactly what rebuilt it.
    recordNote(agentId, "backlog", `${data.length} bytes rebuilt at ${cols}x${rows}`);
    recordBacklog(agentId, data);
    send(ws, { type: "backlog", agentId, data, cols, rows });
    /**
     * And the shape again, if it moved while this was being built.
     *
     * The host serialized at `cols`x`rows` — it had the request before any
     * later resize — so the answer is correct and the client is right to
     * become that shape to read it. But the `grid` announcing the newer size
     * went out *before* this did, so without this the client would end up back
     * at the older one while the pty sat at the newer, which is exactly the
     * permanent disagreement everything else here is arranged to prevent. It
     * takes two clients and a resize inside a few milliseconds to reach, and it
     * costs one message to close.
     */
    const now = sizes.get(agentId);
    if (now && (now.cols !== cols || now.rows !== rows)) {
      send(ws, { type: "grid", agentId, cols: now.cols, rows: now.rows });
    }
  }
  // A later rebuild is still being prepared, so the hold stays on for it.
  if (--pending.inflight > 0) return;
  st.awaiting.delete(agentId);
  if (!watching) return;
  for (const queued of pending.queued) send(ws, { type: "output", agentId, data: queued });
}

let lastDevJson = "";

/**
 * Which terminal is serving what, right now — the live half of the pair whose
 * other half is `Workspace.dev`.
 *
 * Server-side for the same reason `activity` is: it is learnt from a process
 * scan this side already runs, so the pty host never has to hear about dev
 * servers at all and this whole feature costs nobody a running agent to change.
 * A restart empties it and the next poll, three seconds later, fills it in.
 */
const devRunning = new Map<string, DevProc>();

/**
 * The pid each terminal's dev server was last seen as, so the directory it is
 * running in is read once rather than every three seconds. `processCwd` is an
 * `lsof` per call on macOS, and the answer cannot change without the process
 * changing with it.
 */
const devPids = new Map<string, number>();

/**
 * Terminals with a run or a restart in flight.
 *
 * The scan must leave these alone. A restart interrupts the server and then
 * waits before typing the command again, and a poll landing in that window
 * would see an empty tab, drop the row's ↻ for a ▸, and — worse — forget
 * nothing but confuse everyone looking at it. Held by agent id rather than by
 * workspace because that is what the poll is keyed on.
 */
const devBusy = new Set<string>();

/**
 * Which pid to walk down from for each terminal: the pty's own process.
 *
 * Exited terminals are left out (there is nothing under a dead pty), and so are
 * the ones with an agent running in them. That second one is ghosttown's rule
 * and it is worth keeping: a tab in two roles is a tab you act on twice by
 * accident, and the accident here is the expensive kind — the ↻ types a line
 * into the terminal it found the server in, and typing `npm run dev` at a
 * waiting Claude Code sends it as a prompt.
 */
function devRoots(): Array<[string, number]> {
  const roots: Array<[string, number]> = [];
  // The first scan is kicked off at module load, which is before the main
  // process has handed us a port and `attach` has filled these in. There is
  // nothing to attribute yet; the machine-wide half of the scan still runs.
  if (!host) return roots;
  for (const agent of host.agents) {
    if (agent.exited || !agent.pid || agent.agent) continue;
    if (devBusy.has(agent.id)) continue;
    roots.push([agent.id, agent.pid]);
  }
  return roots;
}

async function pollDevServers(): Promise<void> {
  const { servers, running } = await scanDevServers(devRoots());
  for (const server of servers) allowRoot(server.cwd);
  /**
   * Every dev server gets a proxy, whether or not anything has asked for one.
   *
   * This used to wait for `open-preview`, which is the right shape for a preview
   * *pane* — it is opened deliberately, and the pane can wait a round trip for
   * the port to come back. It is the wrong shape for a link. A phone opening a
   * dev server wants a real anchor with a real href, because that is what buys
   * long-press to copy, the share sheet, a background tab, and Add to Home
   * Screen; a button that sends a message, waits for the next `dev-servers`
   * push and then calls `window.open` gets none of those, and is additionally
   * blocked by mobile Safari for opening a window outside the gesture that
   * asked for it. An href cannot be built after the fact, so the port has to
   * exist before anybody taps.
   *
   * The cost is a listener per dev server for sessions that never look at one —
   * an idle accept loop, which is nothing, and which `closePreview` reclaims as
   * soon as the dev server stops. Opening these only while a non-loopback client
   * is connected was the obvious economy and is a worse feature: previews are
   * global while that test is per-client, so a link would appear and disappear
   * according to who *else* had the window open.
   */
  const proxyPorts = new Set(openPreviews().values());
  for (const server of servers) {
    /**
     * Never a preview of a preview. `scanDevServers` already refuses this
     * process's own sockets, which is where the loop actually came from and the
     * fix that matters; this is the second lock on the same door, because the
     * failure mode is not a wrong row in a list but a process that opens
     * listeners until it runs out of ports, and the two guards fail for
     * different reasons — that one needs the pid to be ours, this one only needs
     * the port to be one we handed out.
     */
    if (proxyPorts.has(server.port)) continue;
    try {
      openPreview(server.port);
    } catch {
      // Out of preview ports. The snapshot simply carries no proxyPort for this
      // one, and the sidebar row draws without a link rather than with a broken.
    }
  }
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
  noteDevRunning(running);
  const json = JSON.stringify(servers);
  if (json === lastDevJson) return;
  lastDevJson = json;
  state.devServers = servers;
  broadcast({ type: "dev-servers", servers });
}

/**
 * Take in what the scan found: update the live map, and note on each workspace
 * what it is serving so the button survives the server stopping.
 *
 * A terminal with a run in flight keeps whatever it had. Its root was withheld
 * from the scan, so the scan has nothing to say about it — and dropping it here
 * would be reading "I did not ask" as "there is nothing there", which is exactly
 * the flicker the busy set exists to prevent.
 */
function noteDevRunning(found: Map<string, DevProc>): void {
  let changed = false;
  for (const [agentId, dev] of found) {
    const had = devRunning.get(agentId);
    if (!had || had.pid !== dev.pid || had.command !== dev.command) changed = true;
    devRunning.set(agentId, dev);
  }
  for (const agentId of [...devRunning.keys()]) {
    if (found.has(agentId) || devBusy.has(agentId)) continue;
    devRunning.delete(agentId);
    devPids.delete(agentId);
    changed = true;
  }
  if (changed) pushSnapshot();

  // The directory is asked for only when the process is new to us; see devPids.
  for (const [agentId, dev] of found) {
    if (devPids.get(agentId) === dev.pid) continue;
    devPids.set(agentId, dev.pid);
    void rememberDev(agentId, dev);
  }
}

/** Where this server is actually running, and then: note it on its workspace. */
async function rememberDev(agentId: string, dev: DevProc): Promise<void> {
  const cwd = (await processCwd(dev.pid)) ?? host.find(agentId)?.cwd ?? "";
  workspaces.rememberDev(agentId, { command: dev.command, cwd, agentId });
}

/**
 * How long to wait after a dev server is gone before typing its command again.
 *
 * The shell has to get the foreground back and print a prompt; a line typed into
 * the gap lands inside whatever the old server wrote on its way out, which is
 * not wrong so much as unreadable.
 */
const DEV_RESTART_SETTLE_MS = 400;

/**
 * The same, for a tab that has just been opened for it — longer, because a login
 * shell has a whole rc file to get through first.
 *
 * It is a wait rather than a handshake, and it is worth saying why: output from
 * an unwatched terminal never reaches this process (that is the invariant that
 * keeps a pty nobody is looking at off the socket), so there is no prompt to see
 * arrive. The bytes themselves are safe either way — the tty buffers what is
 * written before the shell reads it — so this is only about the command landing
 * somewhere a person can read it.
 */
const DEV_SPAWN_SETTLE_MS = 900;

function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether a line may be typed into this terminal.
 *
 * Live, and with no agent running in it. The second check is the one that
 * matters: kururu's agents are real and typing at a waiting Claude Code submits
 * a prompt, so a remembered tab that has since had `claude` started in it is
 * passed over and a new one is opened instead.
 */
function canTypeInto(agentId: string | null | undefined): agentId is string {
  if (!agentId) return false;
  const agent = host.find(agentId);
  return Boolean(agent && !agent.exited && !agent.agent);
}

/**
 * Type a command and press return, the way a person would. The tag is what the
 * tape calls it (`record.ts`), and it is a parameter because two features now
 * do this: the dev-server button, and signing a profile in to an account.
 */
function typeCommand(agentId: string, command: string, tag: "dev" | "sign-in" = "dev"): void {
  const line = `${command}\r`;
  recordInput(agentId, line);
  recordNote(agentId, tag, `running ${command}`);
  host.write(agentId, line);
}

/**
 * ▸ / ↻ on a workspace row: get that workspace serving fresh.
 *
 * One entry point for both faces of the button, because the client is the wrong
 * side to tell them apart — see `run-dev` in `shared/wire.ts`. What is actually
 * up is whatever the last scan found in this workspace's terminals, and a
 * workspace holding two servers restarts both: "restart my app" means all of it.
 *
 * Nothing about this switches workspace, opens a pane, or focuses anything. The
 * app comes back up where it was.
 */
async function runDev(workspaceId: string): Promise<void> {
  const workspace = workspaces.workspaceById(workspaceId);
  if (!workspace) return;

  const serving = workspaces
    .agentsInWorkspace(workspaceId)
    .filter((agentId) => devRunning.has(agentId) && !devBusy.has(agentId));

  if (serving.length > 0) {
    await Promise.all(serving.map((agentId) => restartDevIn(agentId)));
    return;
  }

  const memory = workspace.dev;
  if (!memory) return;

  // The tab it last ran in, if it is still there and still a shell. Otherwise a
  // new one, in the directory the server was running in — which is the case a
  // restored layout is always in, its panes having come back empty on purpose.
  if (canTypeInto(memory.agentId)) {
    typeCommand(memory.agentId, memory.command);
    void pollSoon();
    return;
  }

  const agent = await host.create({
    cwd: memory.cwd || undefined,
    kind: "shell",
    env: spawnEnv(workspaceId),
  });
  workspaces.addTabTo(workspaceId, agent.id, agent.cwd);
  allowRoot(agent.cwd);
  devBusy.add(agent.id);
  try {
    await settle(DEV_SPAWN_SETTLE_MS);
    if (!host.isLive(agent.id)) return;
    typeCommand(agent.id, memory.command);
    workspaces.rememberDev(agent.id, { ...memory, agentId: agent.id });
  } finally {
    devBusy.delete(agent.id);
  }
  void pollSoon();
}

/**
 * Exactly the ^C and the re-typed line you would do by hand, which is why it
 * needs no memory of how the tab was set up and works for a server kururu never
 * started.
 *
 * The terminal is held out of the scan for the duration. Without that the poll
 * would land between the interrupt and the retype, find nothing, and report the
 * workspace stopped — and the row would blink through ▸ on its way back to ↻ for
 * no reason a person could act on.
 */
async function restartDevIn(agentId: string): Promise<void> {
  const dev = devRunning.get(agentId);
  if (!dev) return;
  devBusy.add(agentId);
  try {
    await stopDev(dev.pid);
    // Say so now rather than at the next poll: a button that takes three seconds
    // to show it did anything reads as a button that missed.
    devRunning.delete(agentId);
    devPids.delete(agentId);
    pushSnapshot();
    await settle(DEV_RESTART_SETTLE_MS);
    if (!canTypeInto(agentId)) return;
    typeCommand(agentId, dev.command);
  } finally {
    devBusy.delete(agentId);
  }
  void pollSoon();
}

/**
 * Put the row back without waiting for the next tick. Three seconds of ▸ after
 * pressing ▸ is the button appearing not to have worked.
 */
function pollSoon(): Promise<void> {
  return settle(DEV_RESTART_SETTLE_MS * 2).then(() => pollDevServers());
}

// ---------------------------------------------------------------------------
// The reader, and the editor that drives it
// ---------------------------------------------------------------------------

/**
 * How often kururu looks for an editor to attach to.
 *
 * An nvim starting inside a pty raises no event anything out here can hear — the
 * same reason the dev-server scan is a timer — so this is a poll, and it is a
 * cheap one because it only asks about terminals a reader is actually following.
 * A pane with no reader beside it costs nothing at all.
 */
const NVIM_SCAN_MS = 2000;

/**
 * Sockets already hooked. Keyed by the socket path rather than the pid, because
 * a pid is reused and a socket path carries the pid *and* the directory nvim
 * made for that run — so a new editor in a recycled pid is a new key, which is
 * what stops kururu from deciding it has already attached to a process that has
 * never heard of it.
 */
const attached = new Set<string>();

/** A path and a filetype. Anything larger is not an editor reporting a buffer. */
const NVIM_BODY_LIMIT = 8 * 1024;

/**
 * Attach to whatever editor is in this terminal, if there is one.
 *
 * Failure is silent and normal: most terminals have no nvim in them, an nvim
 * that has just started may not have its socket yet, and `--remote-expr` against
 * an editor sitting in a modal prompt will time out. All three are answered by
 * the next sweep.
 */
async function hookEditor(agentId: string): Promise<void> {
  const agent = host.find(agentId);
  if (!agent || agent.exited || !agent.pid) return;
  const nvim = await findNvim(agent.pid);
  if (!nvim || attached.has(nvim.socket)) return;
  if (await attachEditor(nvim, agentId, PORT)) attached.add(nvim.socket);
}

/**
 * Sweep the terminals that have a reader pointed at them.
 *
 * Deliberately not every terminal: attaching is a process spawn, and installing
 * a hook in an editor nobody asked to watch would be reaching into somebody's
 * session for no reason at all. A reader is the asking.
 */
async function pollEditors(): Promise<void> {
  const following = new Set<string>();
  for (const profile of workspaces.all()) {
    for (const workspace of profile.workspaces) {
      for (const pane of panes(workspace.layout)) {
        if (pane.reader?.follow) following.add(pane.reader.follow);
      }
    }
  }
  for (const agentId of following) await hookEditor(agentId);
  // A socket for an editor that has gone is a key that will never be asked
  // about again; drop it so a long session does not accumulate them.
  if (attached.size > 64) attached.clear();
}

/**
 * The root a file belongs to, or null.
 *
 * The longest allowed root that contains it, which is `files.ts`'s question
 * asked from the other end. Roots still come only from the places the server
 * already knows — an agent's cwd, a dev server's, `KURURU_ROOTS` — so an editor
 * that wanders outside every project kururu is holding gets no answer rather
 * than teaching the server a new place to read from. That asymmetry is the whole
 * point of the rule: a path arriving from outside may *select* a root, never
 * create one.
 */
function rootFor(absolute: string): { root: string; rel: string } | null {
  let best: { root: string; rel: string } | null = null;
  for (const root of allowedRoots()) {
    const prefix = root.endsWith("/") ? root : `${root}/`;
    if (!absolute.startsWith(prefix)) continue;
    if (best && best.root.length >= root.length) continue;
    best = { root, rel: absolute.slice(prefix.length) };
  }
  return best;
}

/**
 * The root a *directory* is in, or "" — `rootFor` asked about a path that may
 * be a root itself rather than something underneath one.
 *
 * Which is the common case here and not an edge: `allowRoot` is told about a
 * terminal's cwd, so a pane's cwd is usually a root exactly, and `rootFor`
 * matches on a prefix and therefore answers nothing for it. The empty string is
 * a real answer and the picker draws it — a reader that cannot guess its project
 * asks which one, rather than guessing wrong and looking broken.
 */
function rootForDir(dir: string | undefined): string {
  if (!dir) return "";
  if (allowedRoots().includes(dir)) return dir;
  return rootFor(dir.endsWith("/") ? dir : `${dir}/`)?.root ?? "";
}

/**
 * An editor saying where it is. The one endpoint whose caller is a program
 * kururu installed rather than a person or a client — `report-cli.ts`'s shape,
 * for the same reason: the thing that knows is the thing that should say so.
 */
function nvimBuffer(body: unknown): void {
  if (!body || typeof body !== "object") return;
  const { agent, path, filetype } = body as { agent?: unknown; path?: unknown; filetype?: unknown };
  if (typeof agent !== "string" || typeof path !== "string" || !path.startsWith("/")) return;
  // A reader that draws markdown should not blank itself because you looked at
  // a source file for a moment. Anything it cannot render leaves it as it was.
  const markdown = filetype === "markdown" || /\.(md|markdown|mdx)$/i.test(path);
  if (!markdown) return;
  const located = rootFor(path);
  if (!located) return;
  for (const { workspaceId, paneId } of workspaces.readersFollowing(agent)) {
    workspaces.setReaderTarget(workspaceId, paneId, located.root, located.rel);
  }
}

// ---------------------------------------------------------------------------
// What each terminal is costing the machine
// ---------------------------------------------------------------------------

/**
 * How often memory is measured.
 *
 * Slower than everything else out here on purpose. A process growing raises no
 * event, so this has to be a poll like the other two — but it is the only one
 * whose answer nobody acts on within a second: you look at it when a fan comes
 * on, not while you type. Five seconds is inside the attention span of "which of
 * these is the heavy one" and well outside the rate at which a `ps` is worth
 * running.
 */
const MEM_SCAN_MS = 5000;

/**
 * Which pids to add up from: every live pty, and deliberately not the filtered
 * set the dev scan walks.
 *
 * `devRoots` withholds terminals with an agent running in them, because what it
 * feeds is a button that types into one. Nothing here types anywhere — it reads
 * a number out of a table — and an agent's terminal is the one whose memory is
 * worth knowing, so withholding it would leave the feature answering only for
 * the rows nobody asked about.
 */
function memRoots(): Array<[string, number]> {
  const roots: Array<[string, number]> = [];
  if (!host) return roots;
  for (const agent of host.agents) {
    if (agent.exited || !agent.pid) continue;
    roots.push([agent.id, agent.pid]);
  }
  return roots;
}

/**
 * Measure, and say so only when the figure moved.
 *
 * The comparison is against what was already rounded (see `memory.ts`), which is
 * the whole reason this can push at all: on the raw byte count every working
 * agent changes every poll, and a snapshot every five seconds for the life of a
 * session is a lot of bytes to spend redrawing `390 MB` as `390 MB`.
 */
async function pollMemory(): Promise<void> {
  const found = await scanMemory(memRoots());
  let changed = false;
  for (const [agentId, bytes] of found) {
    if (memory.get(agentId) !== bytes) changed = true;
    memory.set(agentId, bytes);
  }
  // A terminal the scan could not find is one whose process has gone; the row
  // stays (an exited agent is still listed) and simply stops saying a number,
  // rather than keeping the last one it had, which would be a claim about a
  // process that does not exist.
  for (const agentId of [...memory.keys()]) {
    if (found.has(agentId)) continue;
    memory.delete(agentId);
    changed = true;
  }
  if (changed) pushSnapshot();
}

/**
 * The timers left in this process, and what they have in common: each one asks
 * the *machine* a question no pty can raise an event about. The status heuristic
 * and the agent scan went with the ptys, because those are questions about a
 * process kururu owns and the host is where those live now.
 */
const timers = [
  setInterval(() => void pollDevServers(), DEV_SCAN_MS),
  setInterval(() => void pollEditors(), NVIM_SCAN_MS),
  setInterval(() => void pollMemory(), MEM_SCAN_MS),
];

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

    case "propose-size": {
      /**
       * A pane's opinion, not its decision. Checked to the same floor the host
       * checks to, so a box that has not been laid out cannot enter the
       * minimum: the smallest proposal wins, which makes a bad small one the
       * worst possible input this could take.
       */
      const { agentId, cols, rows } = msg;
      if (!Number.isInteger(cols) || !Number.isInteger(rows)) return;
      if (cols < 2 || rows < 2) return;
      st.proposals.set(agentId, { cols, rows });
      applySize(agentId);
      return;
    }

    case "watch": {
      const next = new Set(msg.agentIds);
      const kept = new Set(msg.warm ?? []);
      const opened = [...next].filter((id) => !st.watching.has(id));
      st.watching = next;
      st.warm = kept;
      /**
       * Withdraw the proposals for whatever this client can no longer see, and
       * decide those terminals again without them. This is how a pane closing
       * gives the size back — the other client watching the same agent stops
       * being held to a width nobody is drawing at, and a terminal with no
       * visible watcher left keeps the shape it had rather than being resized
       * by whoever merely has it pooled.
       */
      for (const id of [...st.proposals.keys()]) {
        if (next.has(id)) continue;
        st.proposals.delete(id);
        applySize(id);
      }
      // A pane that closed while its backlog was in flight should not receive it
      // — unless the emulator behind it is still pooled, in which case it is the
      // same emulator and the same question, merely off screen.
      for (const id of [...st.awaiting.keys()]) {
        if (!next.has(id) && !kept.has(id)) st.awaiting.delete(id);
      }
      syncWatched();
      /**
       * Streaming starts here and history does not. Watching says which
       * terminals are on screen; it is a set of ids and it cannot say how wide
       * any of them is, so answering it with a reconstruction meant serializing
       * a screen at whatever width the pane that last drew this terminal
       * happened to be. The emulator that is about to draw it asks for itself,
       * and says what shape it is while asking.
       */
      let seen = false;
      for (const id of opened) {
        recordNote(id, "watch", "a client opened this terminal");
        // Somebody is looking at it now, which is the only thing that clears the
        // mark. The host clears its own for the whole union, warm included,
        // which is exactly why this side keeps an answer of its own.
        if (unread.delete(id)) seen = true;
      }
      if (seen) pushSnapshot();
      return;
    }

    case "request-backlog":
      // Queue this terminal's live output behind the history: the client is
      // about to clear its emulator, and anything that overtakes the answer
      // would be wiped by it. `openQueue` counts rather than sets, so two
      // rebuilds in flight at once do not release each other's hold — rare now
      // that ordinary navigation rebuilds nothing, and kept because counting is
      // free and the bug it prevents is bytes the client never sees again.
      openQueue(st, msg.agentId);
      void sendBacklog(ws, msg.agentId);
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

    case "last-pane":
      workspaces.lastPane();
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

    case "set-workspace-identity":
      workspaces.setWorkspaceIdentity(msg.workspaceId, msg.profileId);
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

    // --- how it looks ------------------------------------------------------
    /**
     * `themeFor` is the check and the fallback in one, which is the shape
     * `mascotFor` has and is right for the same reason: an id naming nothing is
     * what a downgrade looks like, and the default drawn is a better answer than
     * a refusal nobody is listening for. What gets written is therefore always
     * an id this version can draw.
     */
    case "set-theme":
      saveAppearance({ ...appearance, themeId: themeFor(msg.themeId).id });
      return;

    /**
     * The same shape `set-theme` has, and nothing more, because the difference
     * between the two is entirely on the client: a skin moves the line weight
     * and the type ramp, so applying one re-measures every terminal, whereas a
     * theme never does. That belongs where the measuring happens — nothing here
     * resizes anything, for the reason `set-terminal-appearance` gives below.
     */
    case "set-skin":
      saveAppearance({ ...appearance, skinId: skinFor(msg.skinId).id });
      return;

    /**
     * Adopted rather than trusted — a font size arrives as a number somebody
     * typed, and it is the one setting in kururu that reaches a pty: the cell
     * follows the size, the proposed grid follows the cell, and every client
     * watching that terminal is resized to whatever policy picks. `adoptAppearance`
     * clamps it, so the worst a bad message can do is a legal grid.
     *
     * Nothing is resized here. The size still comes the only way it ever comes —
     * a pane measures its box and proposes, `applySize` decides — so a font
     * change is a client re-measuring, not a server deciding a shape.
     */
    case "set-terminal-appearance":
      saveAppearance(adoptAppearance({ ...appearance, terminal: msg.terminal }));
      return;

    case "delete-workspace":
      killAll(workspaces.deleteWorkspace(msg.workspaceId));
      return;

    case "move-workspace":
      workspaces.moveWorkspace(msg.workspaceId, msg.index);
      return;

    case "run-dev":
      // Nothing to reply to and nothing to wait for: a spawn or a restart takes
      // a second or two, and what says it happened is the snapshot the scan
      // pushes when the row changes.
      void runDev(msg.workspaceId).catch((err) => {
        console.error("kururu: could not run the dev server:", err instanceof Error ? err.message : err);
      });
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

    /**
     * Adopted rather than trusted, like the mascot and the workspace colour, and
     * refused rather than repaired: a path that is not absolute is dropped,
     * because there is no nearest legal value for a path and a relative one
     * would resolve against whatever directory each terminal happened to open
     * in. Nothing running is touched — the overlay is read at spawn.
     */
    case "set-profile-identity":
      workspaces.setProfileIdentity(msg.profileId, adoptIdentity(msg.identity));
      return;

    /**
     * A github account picked by name. The directory that means it is written
     * here rather than named by the client, which is the point of the verb: a
     * client that sent a path would be a client that could send any path, and
     * a config directory is a thing kururu creates in the user's home.
     *
     * `git_protocol` is carried over from wherever gh already knows the account,
     * so a profile that picks it does not quietly go back to https on an account
     * set up for ssh. Nothing else is copied: gh owns that file afterwards.
     */
    case "use-gh-account": {
      const account = msg.account;
      const before = workspaces.identityOf(msg.profileId);
      if (!account) {
        workspaces.setProfileIdentity(msg.profileId, { ...before, ghConfigDir: null });
        return;
      }
      void (async () => {
        const known = (await ghIn(null)) ?? [];
        const match = known.find((a) => a.host === account.host && a.login === account.login);
        const dir = ensureGhConfig(account.host, account.login, match?.gitProtocol ?? undefined);
        workspaces.setProfileIdentity(msg.profileId, {
          ...workspaces.identityOf(msg.profileId),
          ghConfigDir: tildify(dir),
        });
      })().catch((err) => {
        console.error("kururu: could not use that github account:", err instanceof Error ? err.message : err);
      });
      return;
    }

    case "sign-in":
      // Nothing to reply to: what says it worked is a terminal appearing with a
      // login prompt in it, which is also the thing the user has to go and do.
      void signIn(msg.profileId, msg.tool).catch((err) => {
        console.error("kururu: could not start a sign-in:", err instanceof Error ? err.message : err);
      });
      return;

    case "restart-server":
      /**
       * Put this server back on current code, which costs a reconnect and
       * nothing else — the agents are in the pty host, a process over.
       *
       * Exiting *is* the restart: only something supervising this process can
       * bring a new one up, and `server/run.mjs` is what does, on this exit code
       * specifically so that an ordinary crash is not mistaken for a request.
       * Unsupervised there is nobody to ask, and exiting would take the server
       * away rather than replace it — so it says so instead of doing half of it.
       */
      if (process.env.KURURU_SUPERVISED !== "1") {
        console.error("kururu: nothing is supervising this server, so there is nobody to restart it");
        return;
      }
      void shutdown().then(() => process.exit(RESTART_EXIT_CODE));
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

    // --- the reader --------------------------------------------------------

    case "open-reader": {
      const paneId = msg.paneId ?? workspaces.focusedPaneId;
      const agentId = msg.agentId ?? workspaces.activeAgentIn(paneId);
      /**
       * The project comes from where the pane already is, and from what the
       * pane *remembers* rather than from the kernel: `cwdForNewTab` asks lsof
       * because a new terminal landing in `~` all afternoon is a real cost, and
       * here the worst case of being a directory behind is a picker that opens
       * on the project list. That is not worth an async spawn on a keypress.
       */
      const made = workspaces.openReader(paneId, agentId, rootForDir(workspaces.cwdFor(paneId)));
      if (!made) return;
      if (msg.focus) workspaces.focusPane(made);
      // Ahead of the sweep, because the pane is on screen now and a reader that
      // is blank for two seconds reads as one that does not work.
      if (agentId) void hookEditor(agentId);
      return;
    }

    case "pin-reader":
      workspaces.pinReader(msg.paneId, msg.follow);
      return;

    case "open-doc":
      /**
       * Checked where every path from a client is checked, and a pick that does
       * not resolve is simply not made: the pane keeps the document it had. A
       * refusal that blanked the reader would read as the feature being broken
       * rather than as a refusal, which is the argument `set-workspace-color`
       * makes about a colour it will not take.
       */
      if (!resolveInRoot(msg.root, msg.path)) return;
      workspaces.openDoc(msg.paneId, msg.root, msg.path);
      return;
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
   * The addresses this machine can be reached at, for the QR the phone scans.
   * Asked for rather than pushed: it changes when somebody joins a different
   * network or brings tailscale up, neither of which raises an event here, and
   * a poll running forever to keep a value only one dialog ever draws would be
   * a timer earning nothing. See `reach.ts`.
   */
  /**
   * What the pty host is holding, for something that is not a browser.
   *
   * The snapshot already goes to every client over the websocket, so this adds
   * no knowledge — what it adds is a way to ask without becoming a client. The
   * caller is `server/status.mjs`, a terminal command, and the alternative it
   * exists to avoid is much worse than an endpoint: the host's socket accepts
   * one server at a time and treats a second connection as a restarted first,
   * so a status tool that asked the *host* directly would knock the live server
   * off its own link to find out how things were going.
   *
   * So the rule stands that the host is opaque and the server is the thing that
   * describes it — and when there is no server, there is genuinely nobody who
   * can answer, which is a true thing for a status command to have to say.
   */
  if (url.pathname === "/api/agents") {
    json(res, {
      agents: host.agents.map((agent) => ({
        id: agent.id,
        name: agent.agent ?? agent.title ?? null,
        program: agent.agent,
        status: agent.status,
        cwd: agent.cwd,
        pid: agent.pid,
        exited: agent.exited,
        counts: countsAsAgent(agent),
      })),
    });
    return;
  }

  if (url.pathname === "/api/reach") {
    json(res, reach(PORT));
    return;
  }

  /**
   * Who a profile's terminals would open as — the answer `claude` and `gh` give
   * when asked with that profile's environment.
   *
   * A fetch rather than a field in the snapshot, and that is the interesting
   * decision here. Everything else Settings edits is server state that changes
   * when somebody changes it; this is the *world's* state, it changes when a
   * person logs in inside a terminal kururu is only watching, and answering it
   * means running two CLIs. Putting it in the snapshot would mean either running
   * them on every status tick or pushing an answer that is quietly hours old. So
   * it is asked for by the one page that draws it, at the moment it is drawn.
   */
  /**
   * What there is to pick between. Separate from `/api/identity` because it is a
   * different question with a different shape — that one is "who is this
   * profile", this one is "who could it be" — and because it spans every profile
   * at once, where that one is about a single identity.
   */
  if (url.pathname === "/api/identity/known") {
    knownAccounts(workspaces.all().map((profile) => profile.identity)).then(
      (known) => json(res, known),
      () => json(res, { claude: [], gh: [] }),
    );
    return;
  }

  if (url.pathname === "/api/identity") {
    const profileId = url.searchParams.get("profile") ?? "";
    describeIdentity(workspaces.identityOf(profileId)).then(
      (who) => json(res, who),
      () => json(res, { claude: null, gh: null, git: null }),
    );
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
  if (url.pathname === "/api/nvim-buffer" && req.method === "POST") {
    void readBody(req, NVIM_BODY_LIMIT)
      .then((body) => nvimBuffer(JSON.parse(body.toString("utf8"))))
      .catch(() => {
        // an editor that sent something unparseable is not worth a log line
      });
    json(res, { ok: true });
    return;
  }
  /**
   * The documents a picker offers, and the projects it could offer them from.
   *
   * The roots travel with every answer rather than being a second request: the
   * list and the thing that changes which list it is belong on screen together,
   * and this is answering a tap on a phone. With exactly one project there is no
   * choice to make and the client is not asked to make one — it gets the
   * documents straight away. With several and no root named, `root` comes back
   * empty and the client draws the projects instead, which is a question kururu
   * genuinely cannot answer for it.
   */
  if (url.pathname === "/api/docs") {
    const roots = allowedRoots();
    const asked = url.searchParams.get("root") ?? "";
    const root = asked || (roots.length === 1 ? (roots[0] ?? "") : "");
    if (!root) {
      json(res, { roots, root: "", docs: [] });
      return;
    }
    try {
      json(res, { roots, root, docs: findDocs(root) });
    } catch (err) {
      json(res, { roots, root: "", docs: [], error: err instanceof Error ? err.message : String(err) }, 400);
    }
    return;
  }
  if (url.pathname === "/api/markdown") {
    const root = url.searchParams.get("root") ?? "";
    const path = url.searchParams.get("path") ?? "";
    void (async () => {
      try {
        const file = readFile(root, path);
        json(res, await renderMarkdown(file.text, root, path, appearance.themeId));
      } catch (err) {
        json(res, { error: err instanceof Error ? err.message : String(err) }, 400);
      }
    })();
    return;
  }
  if (url.pathname === "/api/file-raw") {
    const root = url.searchParams.get("root") ?? "";
    const path = url.searchParams.get("path") ?? "";
    try {
      const file = readBytes(root, path);
      res.writeHead(200, {
        "content-type": file.type,
        "content-length": file.bytes.length,
        // An SVG is a document, and a browser pointed straight at this URL would
        // treat it as one. In an `<img>` — the only way the reader asks for it —
        // none of that runs; these say so for the case somebody opens the link.
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
        "x-content-type-options": "nosniff",
        "content-disposition": "inline",
        "cache-control": "no-cache",
      });
      res.end(file.bytes);
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 400);
    }
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
    clients.set(ws, {
      watching: new Set(),
      warm: new Set(),
      proposals: new Map(),
      awaiting: new Map(),
    });
    send(ws, { type: "snapshot", snapshot: snapshot() });
    send(ws, { type: "dev-servers", servers: state.devServers });

    ws.on("message", (data) => handleMessage(ws, data.toString()));
    ws.on("close", () => dropClient(ws));
    ws.on("error", () => dropClient(ws));
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
 * How this process finds the pty host.
 *
 * There used to be two arrangements and only one of them worked the way the
 * split promises. Under Electron the main process forked a host beside us and
 * handed over a `MessagePort`; standalone, with nobody to do that, we built a
 * host *inside this process* — which meant that during development, when the
 * server is restarted on every save, every restart quietly killed every agent.
 * The seam was there and the process boundary was not.
 *
 * So there is one arrangement now: the host listens on a socket and we connect
 * to it. A server that has just been restarted connects again and `hello` hands
 * it back the agents and the arrangement, which is exactly what a re-forked
 * utilityProcess got. Starting the host if it is not there is a convenience for
 * the common case of one machine and one person; it is spawned **detached**, so
 * it is not our child and does not go down with us. That is the whole point.
 */
const SOCKET = hostSocketPath();

/**
 * Start a host and wait for it to answer.
 *
 * Its output goes to a file rather than to ours: it outlives this process by
 * design, so inheriting our stdio would leave it writing into a terminal that
 * has moved on, and a daemon nobody can see the logs of is one nobody can debug.
 */
async function startPtyHost(): Promise<void> {
  const entry = process.env.KURURU_PTYHOSTD || fileURLToPath(new URL("./ptyhostd.mjs", import.meta.url));
  if (!existsSync(entry)) throw new Error(`no pty host to start at ${entry} — bun run build:server`);

  mkdirSync(dirname(SOCKET), { recursive: true });
  const log = openSync(join(dirname(SOCKET), "ptyhost.log"), "a");
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: ["ignore", log, log],
    // Harmless under node, and the one thing that makes this work if the binary
    // running us ever turns out to be Electron's.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  child.unref();
  closeSync(log);
}

/**
 * The link, however we have to get it.
 *
 * Retried rather than awaited once because a host that has just been spawned is
 * not listening yet, and because two servers started together both find nothing
 * and both spawn one — the loser exits on `EADDRINUSE` and the winner is there a
 * moment later, so patience is also what resolves the race.
 */
async function linkToHost(): Promise<SocketPort> {
  try {
    return await connectToHost(SOCKET);
  } catch {
    // Nothing listening. Ours to start.
  }
  await startPtyHost();
  for (let attempt = 0; attempt < 50; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      return await connectToHost(SOCKET);
    } catch {
      // Still coming up.
    }
  }
  throw new Error(`the pty host did not come up at ${SOCKET} — see ${join(dirname(SOCKET), "ptyhost.log")}`);
}

const link = await linkToHost();

/**
 * The host going away is not survivable, and pretending otherwise is worse than
 * exiting. Every agent was in that process; what is left here is a layout full
 * of tabs pointing at terminals that no longer exist and a UI that would draw
 * them as though they did.
 */
link.onClose(() => {
  if (stopping) return;
  console.error("kururu: the pty host went away — every agent went with it");
  process.exit(1);
});

await attach(link);

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
