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
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { adoptMascot, countsAsAgent, defaultMascot } from "../../shared/model";
import { bindKey } from "../../shared/keys";
import type { AgentSnapshot, AgentStatus, MascotSet, Profile, PtyKind, SessionSnapshot, Workspace } from "../../shared/model";
import type { ClientMessage, DevServer, ServerMessage, SupabaseDb, WorkspaceBranch } from "../../shared/wire";
import { DEV_SCAN_MS, GIT_SCAN_MS, SAVE_DEBOUNCE_MS, SUPABASE_SCAN_MS, USAGE_POLL_MS } from "../../shared/wire";
import {
  bindAddress,
  cookieHeader,
  hasToken,
  isShared,
  rotateToken,
  setShare,
  sharing,
  token,
  verdict,
} from "./access";
import { parseReport } from "./agents/report";
import { dump as dumpRecording, forget as forgetRecording, recordBacklog, recordInput, recordNote, recordOutput } from "./record";
import { processCwd } from "./cwd";
import { scanDevServers, stopDev, type DevProc } from "./devservers";
import { findSupabase, probe, supabaseCommand, type SupabaseFound } from "./supabase";
import { readHead, repoAt } from "./git";
import { pollUsage, usageSnapshot } from "./usage";
import { allowedRoots, allowRoot, findDocs, listDir, readBytes, readFile, resolveInRoot } from "./files";
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
import { agentLabel, agentSummary, basename } from "../../shared/labels";
import {
  adoptNotify,
  isNotifyEvent,
  notifyGate,
  notifyText,
  NOTIFY_THROTTLE_MS,
  type NotifyEvent,
  type NotifySettings,
} from "../../shared/notify";
import { readNotify, writeNotify } from "./notify";
import { soundBytes, sounds } from "./sounds";
import { readAppearance, writeAppearance } from "./appearance";
import {
  annotate as annotateCatalog,
  assetFile,
  catalog,
  install as installStyle,
  installedPack,
  readLibrary,
  rememberMascotId,
  preview as previewStyle,
  remove as removeStyle,
  stylesHome,
} from "./styles";
import { isStyleKind, PACK_PARTS, type InstalledStyle, type PackManifest, type StyleKind } from "../../shared/styles";
import {
  createLocalSkin,
  localDir,
  putLocalAsset,
  readLocalManifest,
  removeLocalAsset,
  writeLocalManifest,
} from "./studio";
import { adoptAppearance, themeFor, type Appearance } from "../../shared/theme";
import { isStyleId, skinFor } from "../../shared/skin";
import { HostLink, type Port } from "./hostlink";
import { connectToHost, hostSocketPath, type SocketPort } from "./hostsock";
import { MouseEncoding } from "./mouseencoding";
import { readSnapshot, writeSnapshot } from "./persist";
import { closeAllPreviews, closePreview, openPreview, openPreviews } from "./proxy";
import { reach } from "./reach";
import { smallestGrid, type Grid } from "./sizing";
import { checkForUpdate } from "./update";
import { VERSION } from "./version";
import { orderAgents, Workspaces } from "./workspaces";

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
  supabase: [] as SupabaseDb[],
  branches: [] as WorkspaceBranch[],
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
let notify = readNotify();
let appearance = readAppearance();
/**
 * What has been installed from `../kururu-styles`.
 *
 * Held rather than re-read per snapshot, for the reason above: a snapshot goes
 * out on every status change and this is a directory of files. It is re-read
 * when it changes, which is when an install or a remove comes back — and on a
 * server restart, which is also how a style dropped in by hand takes effect.
 */
let styles = readLibrary();

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

/** The same two steps, for the same reason. See `saveAppearance`. */
function saveNotify(next: NotifySettings): void {
  notify = next;
  writeNotify(next);
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

/**
 * Fetch a style, put it on disk, and make it the one in use if that is what was
 * meant.
 *
 * The four kinds end in four different places and that asymmetry is real rather
 * than an inconsistency. A theme and a skin are one id in `appearance.json`. A
 * **mascot** is not: it becomes a row in the user's mascot list — the same list
 * Settings edits by dragging cells out of a sheet — because once it is installed
 * there is no useful difference between a mascot from the registry and one
 * somebody cut out by hand, and keeping two kinds would mean every reader
 * downstream learning which it had. A **sound** lands in a fourth place again,
 * `notify.json`, and that is the one worth defending: a noise is not a look, so
 * it does not belong in `appearance.json` — the same sentence `server/src/notify.ts`
 * already makes about why that file exists at all. A **pack** is a handful of
 * ids and nothing else, so installing one is installing what it names; it is
 * stored as a record so that it can be listed and removed, and removing it
 * deliberately leaves its parts alone, because a pack is a *reference* and
 * taking away the recommendation is not taking away the theme.
 */
async function installOne(kind: string, id: string, activate: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await installStyle(kind, id);
  if (!result.ok) return result;

  if (result.mascot) {
    const { name, config, replaces } = result.mascot;
    const already = replaces ? mascots.list.find((m) => m.id === replaces) : undefined;
    const mascotId = already?.id ?? freshMascotId(mascots.list);
    const one = { id: mascotId, name: name.slice(0, 40), ...config };
    // The default is left alone even when this is being worn: `wear` below is
    // the one place that decides, and it needs the id `rememberMascotId` is
    // about to write down.
    saveMascots({
      default: mascots.default,
      list: already ? mascots.list.map((m) => (m.id === mascotId ? one : m)) : [...mascots.list, one],
    });
    rememberMascotId(result.record.kind, result.record.id, mascotId);
  }

  styles = readLibrary();

  if (result.record.kind === "pack") {
    const pack = (result.manifest ?? {}) as Record<string, unknown>;
    for (const part of PACK_PARTS) {
      const partId = pack[part];
      if (typeof partId !== "string") continue;
      // A part that fails is reported nowhere and that is deliberate: a pack
      // whose skin is temporarily unreachable should still leave you with its
      // theme, its mascot and its sound, which is most of the look. Refusing the
      // lot would make one bad file take three good ones down with it.
      //
      // Never activated on the way past, even when the pack is being worn. What
      // a pack *means* is one answer and `wear` below is where it is given; a
      // part that put itself on here would be a second, arrived at by a
      // different route, and the two would drift the first time a pack learned
      // to name something new. It also saves three writes of `appearance.json`
      // for one click.
      await installOne(part, partId, false);
    }
    styles = readLibrary();
  }

  if (activate) wear(result.record.kind, result.record.id);
  else pushSnapshot();
  return { ok: true };
}

/**
 * The three files a style can land in, gathered up so that wearing a pack writes
 * each of them at most once.
 *
 * A pack is the reason this exists. Every other style is one decision in one
 * file and `saveAppearance` is the whole story; a pack is up to five — a theme,
 * a skin, a mascot, a sound and a face — spread across `appearance.json`,
 * `mascots.json` and `notify.json`, and doing them one saver at a time would
 * push three snapshots for one click and repaint the window three times on the
 * way to the look somebody asked for. So the parts are folded into a `Look`
 * first and written afterwards.
 */
interface Look {
  appearance: Appearance;
  mascots: MascotSet;
  notify: NotifySettings;
}

/**
 * One installed style, folded into a look.
 *
 * The four kinds land in the four places `installOne`'s comment argues for, and
 * the ids are resolved through `themeFor` and `skinFor` for the reason those
 * exist: what is being worn has to be something this version can draw, and the
 * fallback belongs at the moment of wearing rather than in the file.
 *
 * A mascot is the one that can silently decline. It is worn by *its row in the
 * user's list*, not by its registry id — see `installOne` — so a record from
 * before `mascotId` was written down, or one whose row somebody has since
 * deleted in Settings, has nothing to point at. Leaving the current mascot up is
 * the right answer there: the alternative is a badge that goes blank because a
 * pack mentioned a sprite that is not on the machine any more.
 */
function put(look: Look, record: InstalledStyle): Look {
  switch (record.kind) {
    case "theme":
      return { ...look, appearance: { ...look.appearance, themeId: themeFor(record.id, styles.themes).id } };
    case "skin":
      return { ...look, appearance: { ...look.appearance, skinId: skinFor(record.id, styles.skins).id } };
    case "mascot":
      if (!record.mascotId || !look.mascots.list.some((m) => m.id === record.mascotId)) return look;
      return { ...look, mascots: { ...look.mascots, default: record.mascotId } };
    /**
     * Picking the sound, and not also turning notifications on.
     *
     * `enabled` and `events` are a decision about being interrupted and this is
     * a decision about what the interruption sounds like — so a pack worn by
     * somebody who has notifications switched off is a pack whose sound is
     * waiting for them when they switch them back on, rather than a style
     * choice that quietly started interrupting them.
     */
    case "sound":
      return { ...look, notify: { ...look.notify, sound: record.id } };
    default:
      return look;
  }
}

/** Write whichever of the three actually moved, then tell every client once. */
function saveLook(next: Look): void {
  if (next.appearance !== appearance) {
    appearance = next.appearance;
    writeAppearance(next.appearance);
  }
  if (next.mascots !== mascots) {
    mascots = next.mascots;
    writeMascots(next.mascots);
  }
  if (next.notify !== notify) {
    notify = next.notify;
    writeNotify(next.notify);
  }
  pushSnapshot();
}

/**
 * Put on something that is already on the machine.
 *
 * Split out of `installOne` because wearing and installing stopped being the
 * same gesture. They were, for as long as the only way to arrive at a style was
 * to press its row in the registry — and then a pack is five decisions somebody
 * made once, in an order they cannot get back to afterwards: change the skin,
 * try a different mascot, and there is no longer any way to say *put the pack
 * back on* short of removing it and installing it again over the network. So
 * this takes an id and nothing else, touches no network, and is what both the
 * Appearance tab's pack picker and an installed row in the Styles tab call.
 *
 * A pack fans out here rather than in the caller, which is the whole point: what
 * it means to wear one is written down once.
 */
function wear(kind: StyleKind, id: string): { ok: true } | { ok: false; error: string } {
  const record = styles.installed.find((r) => r.kind === kind && r.id === id);
  if (!record) return { ok: false, error: "that style is not installed" };
  let look: Look = { appearance, mascots, notify };
  if (kind === "pack") {
    const pack = installedPack(id);
    if (!pack) return { ok: false, error: `${record.name} is installed but its manifest is unreadable` };
    for (const part of PACK_PARTS) {
      const partId = pack[part];
      // A part the pack names but the machine does not have is skipped rather
      // than refused, which is `installOne`'s rule for a part that would not
      // download, arriving at the same conclusion from the other end: most of a
      // pack is most of the look, and nothing here is worth losing the rest of
      // it over.
      const partRecord = partId ? styles.installed.find((r) => r.kind === part && r.id === partId) : undefined;
      if (partRecord) look = put(look, partRecord);
    }
    look = wearFont(look, pack);
  } else {
    look = put(look, record);
  }
  saveLook(look);
  return { ok: true };
}

/**
 * The face a pack asks for, if it asks for one.
 *
 * Kururu installs no fonts and never should — see `adoptPackManifest` — so this
 * writes a *name* into the same field the box in Settings writes, and a machine
 * without that face keeps the one it had. Which is the honest behaviour and not
 * a silent failure: naming a font nobody has is what typing one character wrong
 * into that box already does, and `web/src/fonts.ts` exists because of it.
 *
 * A pack with no `font` leaves the setting alone rather than clearing it. The
 * empty string means "kururu's own stack" and writing it would make wearing a
 * pack quietly undo a font somebody chose for themselves, which is a decision
 * about type that the pack declined to have an opinion about.
 */
function wearFont(look: Look, pack: PackManifest): Look {
  if (!pack.font || pack.font === look.appearance.terminal.fontFamily) return look;
  return {
    ...look,
    appearance: { ...look.appearance, terminal: { ...look.appearance.terminal, fontFamily: pack.font } },
  };
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
function snapshot(): SessionSnapshot {
  // Every snapshot is also the moment we learn what is running where, because it
  // is the one function that is called whenever anything about an agent changes.
  rememberAgents();
  const profile = workspaces.active;
  const mine = new Set(workspaces.agentsIn(profile.id));
  // The host holds its terminals in spawn order, which is the default and is
  // only the default: the sidebar's list can be dragged into an order of its
  // own, and that order is the profile's. Applied here rather than in the
  // client, on the same reasoning as the layout — see `Profile.agentOrder`.
  const here = host.agents.filter((agent) => mine.has(agent.id));
  const at = new Map(
    orderAgents(
      here.map((agent) => agent.id),
      profile.agentOrder,
    ).map((id, index) => [id, index] as const),
  );
  return {
    session: "kururu",
    profile,
    profiles: workspaces.summaries((id) => workspaces.agentsIn(id).filter((a) => host.isLive(a)).length),
    // Two fields are merged here rather than carried by the host — see `overlay`
    // below, and the fields themselves in `shared/model.ts`, for why they live
    // on this side of the link at all.
    agents: here.sort((a, b) => (at.get(a.id) ?? 0) - (at.get(b.id) ?? 0)).map(overlay),
    mascots,
    keys,
    notify,
    appearance,
    styles,
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
 * Terminals that finished a turn, or asked a question, while nobody was looking.
 *
 * It used to mean "bytes arrived off screen", and that is what made it useless:
 * a spinner, a dev server's request log and an agent thinking out loud all emit
 * continuously, so every row that was not the one visible tab lit within a
 * second and stayed lit until you opened that exact tab. A mark that is on for
 * nine rows out of ten is not a mark, and the thing it was standing in for —
 * *this one wants you and you were not there* — was never what it measured.
 *
 * So it is the same event a notification is, seen by somebody who was not at the
 * screen when it happened: a transition into `blocked` or `done` (`NOTIFY_EVENTS`
 * — the two states `status.ts` calls "wants a human") for a terminal no client
 * has visible. `noticeStatuses` is where both are decided, together, because a
 * card and a dot that disagreed about what deserves attention would be two
 * policies to tune instead of one.
 *
 * Two consequences worth stating, because neither is a bug:
 *
 * A transition *off* those states clears it. The dot says a terminal is waiting
 * for you now, not that it once was, and an agent poked from the phone must not
 * leave a dot on the desktop for work that has since resumed.
 *
 * A restart forgets the set, and that is correct for the reason `lastStatus`
 * argues at length: statuses are relearnt on the first tick and raise no
 * transitions, so nothing is marked and nothing is announced. The alternative is
 * sixteen terminals sitting at `done` all claiming to be news at once.
 *
 * The host keeps a flag of this name too and it is now genuinely vestigial —
 * byte-derived, and unreachable from here because `agents/host.ts` costs the
 * user every running agent to edit. `overlay` *replaces* it rather than oring
 * it in, which is the whole of what that costs us.
 */
const unread = new Set<string>();

/**
 * Whether anybody can actually see that terminal right now.
 *
 * Visible, never merely warm: a pooled emulator in a workspace you are not in is
 * being kept current, not being read. Asked across every client because the
 * question the mark answers is "was anyone there", and the desktop showing the
 * pane answers it for the phone in your pocket.
 */
function onScreenAnywhere(agentId: string): boolean {
  for (const st of clients.values()) if (st.watching.has(agentId)) return true;
  return false;
}

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
 * What the pty host cannot say about an agent, added on the way out — and the
 * one thing it says that this side has to overrule.
 *
 * Everything merged in here is something the server knows and the host does not,
 * and all of it is cheap to lose: one line arrives from the agent by a different
 * road, the rest are relearnt by the next poll. Which is the point — none of it
 * is worth a field in the half of kururu you cannot restart.
 *
 * `unread` is the odd one and is *overwritten*, not merged. The host derives it
 * from bytes, this side derives it from a turn ending where nobody could see it,
 * and the host's file is the one that costs the user every running agent to
 * edit — so the correction is made here, on the way past. See `unread`.
 */
function overlay(agent: AgentSnapshot): AgentSnapshot {
  const said = activity.get(agent.id);
  const was = lastAgent.get(agent.id);
  const serving = devRunning.get(agent.id);
  const fresh = unread.has(agent.id);
  const held = memory.get(agent.id);
  if (!said && !was && !serving && !held && fresh === agent.unread) return agent;
  return {
    ...agent,
    ...(said ? { activity: said } : {}),
    ...(was ? { lastAgent: was } : {}),
    ...(serving ? { dev: serving.program } : {}),
    ...(held ? { rss: held } : {}),
    // Replaced rather than ored, which is the one line that stops the host's
    // byte-derived flag from lighting every row again behind this one's back.
    // See `unread`: the two are not two halves of an answer any more, they are
    // two different questions and only this one is asked here.
    unread: fresh,
  };
}

// ---------------------------------------------------------------------------
// Notifications
//
// The only thing kururu does that reaches somebody who is not looking at it,
// which is what makes every decision in here about *restraint*. The policy is
// `shared/notify.ts`, ported from ghosttown so that "needs input" means the same
// thing in both; what is here is the two things the policy cannot be pure about
// — noticing that a status moved, and knowing which clients can already see it.
//
// It lives in `index.ts` and not in `agents/`, and that is not filing. The host
// is where a status is *computed*, and it is also the half of kururu that costs
// the user every running agent to edit — so a feature that will be tuned (and
// this one will: every threshold in a notification is a matter of taste) belongs
// on the side that restarts for free. It is the same line `activity` and
// `unread` are drawn on, and the reason both of those sit here too.
// ---------------------------------------------------------------------------

/**
 * What each terminal's status was the last time we looked.
 *
 * Notifications are about *transitions* and a snapshot only carries states, so
 * somebody has to remember. The host cannot: it raises `onAgents` when anything
 * changes and says nothing about what changed, which is right — a delta is a
 * thing every reader of this protocol would then have to understand, and the
 * one reader that wants it can keep four bytes per terminal instead.
 *
 * An id that is not in here yet notifies for nothing, which is the whole reason
 * the absent case is separated from the equal case below. A server restart
 * relearns every status on the first tick, and without that guard sixteen
 * terminals sitting at `done` would all announce themselves at once — the same
 * "a restart forgets it and that is correct" the `activity` map argues for,
 * except that here forgetting it wrongly is audible.
 */
const lastStatus = new Map<string, AgentStatus>();

/** When each terminal was last allowed to interrupt. See `NOTIFY_THROTTLE_MS`. */
const notifiedAt = new Map<string, number>();

/**
 * Look for terminals that have just started wanting a human, and answer it twice
 * — with a card for whoever is reachable now, and with a mark for whoever is
 * not.
 *
 * Hung off the same `onAgents` that pushes a snapshot, because it is the same
 * event — anything about any agent changed — and a second subscription would
 * only be a second thing to keep in step. That is also why nothing in here
 * pushes: `onAgents` calls this and then pushes, so a mark set on this pass is
 * already in the snapshot that pass sends.
 *
 * It walks every profile's terminals and not just the active one's: an agent
 * blocked in the profile you left is the notification most worth having, since
 * it is the one there is no dot on screen for.
 *
 * The card and the mark share this loop deliberately. They are the same
 * judgement — *this wants a human* — asked of two different audiences, and
 * deciding them apart is how a dot ends up lit for reasons no notification
 * would ever have fired on. What differs is only the audience: `announce` runs
 * the gate per client and is throttled, because interrupting somebody twice is
 * worse than not at all; the mark is for the client that was not there to be
 * interrupted, so it is neither throttled nor per client.
 */
function noticeStatuses(): void {
  const live = new Set<string>();
  for (const agent of host.agents) {
    live.add(agent.id);
    const before = lastStatus.get(agent.id);
    lastStatus.set(agent.id, agent.status);
    // Never seen before, or has not moved. See `lastStatus` for why those are
    // two cases and not one.
    if (before === undefined || before === agent.status) continue;
    if (agent.exited) continue;
    if (!isNotifyEvent(agent.status)) {
      // It has stopped wanting anybody — it was typed into, or it went back to
      // work — so the dot has nothing left to be about. `forget` covers the
      // terminal going away; this covers the terminal carrying on.
      unread.delete(agent.id);
      continue;
    }
    // Nobody saw it happen, so leave something that says it did. Checked at the
    // moment of the transition and never again: walking in on a terminal that
    // was already `done` before you left is not news, which is the same reason
    // `announce` fires on the edge rather than on the state.
    if (!onScreenAnywhere(agent.id)) unread.add(agent.id);
    announce(agent, agent.status);
  }
  for (const id of [...lastStatus.keys()]) {
    if (live.has(id)) continue;
    lastStatus.delete(id);
    notifiedAt.delete(id);
  }
}

/**
 * Tell whoever should be told, and nobody else.
 *
 * The gate is run *per client* rather than once, because the one question it
 * asks that is not a setting — is this terminal on screen — has a different
 * answer for the desktop showing the pane and the phone in your pocket. Which is
 * exactly the shape `unread` already has, and for the same reason: `watching` is
 * what a human can see, and a warm pooled emulator is nobody looking.
 *
 * The throttle is recorded only if something actually went out. A burst of
 * transitions while you are staring at the pane is not a notification and must
 * not spend the quiet period a real one four seconds later would need.
 */
function announce(agent: AgentSnapshot, event: NotifyEvent): void {
  const now = Date.now();
  if (now - (notifiedAt.get(agent.id) ?? 0) < NOTIFY_THROTTLE_MS) return;

  /**
   * The overlaid snapshot, not the host's. `activity` is what the agent said it
   * was doing — the permission prompt's own words, when a Claude Code hook is
   * installed — and it is the single most useful line a card can carry. It is
   * merged on this side, so the un-overlaid agent would notify with the title
   * and lose it.
   */
  const full = overlay(agent);
  const place = workspaces.placeOf(agent.id);
  /**
   * `agentLabel` answers `starting…` for a terminal opened as an agent whose
   * program the process scan has not named yet, and that is right where it is
   * used: a sidebar row corrects itself two seconds later, when the scan lands.
   * A card does not. It is drawn once and keeps what it was handed, so
   * `starting… needs input` would sit in Notification Center saying nothing for
   * the rest of the afternoon — and it is reachable, because a report can arrive
   * before the first scan and because `procs.ts` does not recognise every agent
   * anybody runs. The command is the better answer here for the reason the
   * placeholder is the better answer there: it is the one name a terminal has
   * that never stops being true.
   */
  const label = full.agent || full.titleOverride ? agentLabel(full) : basename(full.command);
  const text = notifyText({
    label,
    summary: agentSummary(full),
    workspace: place?.workspace,
    // Only when there is more than one profile to be in. With one, naming it on
    // every card is a word that never varies and therefore never informs —
    // ghosttown's rule about its session name, and the same one `labels.ts`
    // applies to a summary that is merely the label again.
    profile: workspaces.all().length > 1 ? place?.profile : undefined,
    event,
  });
  const notification = { agentId: agent.id, event, ...text };

  let sent = false;
  for (const [ws, st] of clients) {
    const verdict = notifyGate(
      { event, visible: st.watching.has(agent.id), isAgent: countsAsAgent(full) },
      notify,
    );
    if (!verdict.pass) continue;
    send(ws, { type: "notify", notification });
    sent = true;
  }
  if (sent) notifiedAt.set(agent.id, now);
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
    forget(agentId);
  }
}

/**
 * Everything on this side that was about one terminal.
 *
 * Ids are not reused, so none of this is correctness — but every one of these
 * maps would otherwise grow for the life of the process. `lastStatus` and
 * `notifiedAt` are deliberately not in here: `noticeStatuses` drops an id the
 * moment the host stops listing it, which is the same event by a shorter road.
 */
function forget(agentId: string): void {
  activity.delete(agentId);
  lastAgent.delete(agentId);
  memory.delete(agentId);
  unread.delete(agentId);
  sizes.delete(agentId);
  for (const st of clients.values()) st.proposals.delete(agentId);
  forgetRecording(agentId);
  mouseEncodings.delete(agentId);
}

/**
 * Clear away terminals whose pty has ended on its own — `exit` at a shell, a
 * command that ran out, an agent that quit.
 *
 * The host keeps an exited pty listed with its screen intact, and that is right
 * for the host: it cannot know whether anybody still wants to read it, and a
 * screen is the only record a dead terminal leaves. Deciding is this side's
 * job, and the answer is that a tab is where a terminal *lives* — so when the
 * terminal has gone the tab has nothing left to be, and a pane holding nothing
 * else goes with it (`reapTab`). That is tmux's default and what typing `exit`
 * means everywhere else; the cost is the screen, and the alternative was a dead
 * tab per terminal you ever closed, waiting to be dismissed by hand.
 *
 * It is noticed here rather than in `agents/host.ts` for the reason `lastStatus`
 * is: that file costs the user every running agent to edit, and this is a matter
 * of taste that will be tuned. Nothing has to be remembered between calls,
 * because the reap is what makes the host stop listing it — the kill is a
 * message, so the same agent may still be in the list on the next push, and a
 * second kill is swallowed by `ptyhost.ts` and a second `reapTab` finds no pane.
 */
function reapExited(): void {
  for (const agent of host.agents) {
    if (!agent.exited) continue;
    host.kill(agent.id);
    workspaces.reapTab(agent.id);
    forget(agent.id);
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
 * The host reads its watched set as "somebody is looking at this" and keeps a
 * mark of its own off the back of it. That mark is not used — see `unread` and
 * `overlay` — and it is left alone because `agents/host.ts` costs the user every
 * running agent to edit.
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
 *
 * It used to decide `unread` here as well, on the theory that bytes off screen
 * are news. They are not — see `unread` — and a function on the hot path that
 * also carried a policy was the shape that made that easy to miss.
 */
function onOutput(agentId: string, data: string): void {
  recordOutput(agentId, data);
  mouseEncodingOf(agentId).read(data);
  for (const [ws, st] of clients) {
    if (!sees(st, agentId)) continue;
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
 * Type a command and press return, the way a person would. `dev` is what the
 * tape calls it (`record.ts`) — kururu typing on its own account rather than a
 * person typing, which is the distinction the tape is there to preserve.
 */
function typeCommand(agentId: string, command: string): void {
  const line = `${command}\r`;
  recordInput(agentId, line);
  recordNote(agentId, "dev", `running ${command}`);
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

  const agent = await host.create({ cwd: memory.cwd || undefined, kind: "shell" });
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
// Supabase
// ---------------------------------------------------------------------------

/**
 * Workspaces with a start or a stop in flight.
 *
 * `devBusy`'s job for the same reason, and with a longer fuse: `supabase start`
 * pulls and boots a dozen containers, so the port stays shut for the better part
 * of a minute after the button has been pressed. Without this the row would sit
 * at "off" for that whole minute and read as a button that did nothing, which is
 * the state in which somebody presses it again.
 *
 * Cleared by the probe rather than by a timer: the answer arriving *is* the end
 * of the wait, and a timeout that fired first would hand the row back to the
 * probe mid-boot and undo the thing this exists for. The timer below is only the
 * floor under a command that fails outright — a `supabase` that is not installed
 * prints its error in the terminal and never changes the port, and a row stuck
 * on "working" forever would be worse than one that goes back to off and lets
 * you read what it said.
 */
const supabaseBusy = new Map<string, NodeJS.Timeout>();

/**
 * How long a start or a stop may be in flight before the row stops waiting for
 * it. Long, because `supabase start` on a cold machine pulls images.
 */
const SUPABASE_BUSY_MS = 180_000;

/**
 * What was found at a directory, so the walk up the tree is not redone every
 * three seconds for every workspace.
 *
 * Expiring rather than permanent, and both halves of that matter. A project
 * appears when somebody runs `supabase init` and disappears when a directory is
 * renamed, so a cache with no expiry would need invalidating from places that
 * have no business knowing this exists; a minute is short enough that nobody
 * notices and long enough that the common case — the same four directories,
 * twenty times a minute — costs nothing.
 */
const supabaseSeen = new Map<string, { at: number; found: SupabaseFound | null }>();
const SUPABASE_CACHE_MS = 60_000;

async function lookFor(dir: string): Promise<SupabaseFound | null> {
  const had = supabaseSeen.get(dir);
  if (had && Date.now() - had.at < SUPABASE_CACHE_MS) return had.found;
  const found = await findSupabase(dir);
  supabaseSeen.set(dir, { at: Date.now(), found });
  return found;
}

/**
 * Every directory this workspace could be said to be *in*, best first.
 *
 * A workspace has no directory of its own — it is an arrangement, not a project
 * — so this asks the three things that do have one, in the order of how much
 * they know. A live terminal's cwd is where somebody actually is. A pane's
 * remembered cwd is where its terminals were, and is the only one of the three
 * that survives a restart with the panes empty — which is exactly the state in
 * which you want the button, because there is nothing running and the database
 * is probably down. The dev server's directory is last and is usually one of the
 * other two.
 */
function workspaceDirs(workspace: Workspace): string[] {
  const dirs: string[] = [];
  const add = (dir: string | undefined | null) => {
    if (dir && !dirs.includes(dir)) dirs.push(dir);
  };
  for (const pane of panes(workspace.layout)) {
    for (const agentId of pane.agentIds) add(host.find(agentId)?.cwd);
    add(pane.cwd);
  }
  add(workspace.dev?.cwd);
  return dirs;
}

let lastSupabaseJson = "";

/**
 * Which of the active profile's workspaces have a local Supabase, and whether it
 * is answering.
 *
 * The active profile only. Every other profile's workspaces are not on anybody's
 * screen — the snapshot itself carries one profile for the same reason — and a
 * probe is a connection attempt rather than a read of a table somebody else is
 * making anyway, so there is nothing to be gained by asking about rows nobody
 * can see.
 */
async function pollSupabase(): Promise<void> {
  if (!host || !workspaces) return;
  const dbs: SupabaseDb[] = [];
  for (const workspace of workspaces.active.workspaces) {
    let found: SupabaseFound | null = null;
    for (const dir of workspaceDirs(workspace)) {
      found = await lookFor(dir);
      if (found) break;
    }
    if (!found) continue;
    const busy = supabaseBusy.has(workspace.id);
    const up = await probe(found.port);
    /**
     * The probe agreeing with what was asked for is what ends the wait. Which
     * way round it has to agree is not knowable from here — a stop makes the
     * port shut and a start makes it open — so the rule is simply "it changed":
     * whatever the button asked for, the port was in the other state when it was
     * pressed, because that is what the button was offering.
     */
    const before = state.supabase.find((db) => db.workspaceId === workspace.id);
    if (busy && before && before.up !== up) clearBusy(workspace.id);
    dbs.push({
      workspaceId: workspace.id,
      root: found.root,
      project: found.project,
      port: found.port,
      up,
      busy: supabaseBusy.has(workspace.id),
    });
  }
  const json = JSON.stringify(dbs);
  if (json === lastSupabaseJson) return;
  lastSupabaseJson = json;
  state.supabase = dbs;
  broadcast({ type: "supabase", dbs });
}

function markBusy(workspaceId: string): void {
  clearBusy(workspaceId);
  supabaseBusy.set(
    workspaceId,
    setTimeout(() => supabaseBusy.delete(workspaceId), SUPABASE_BUSY_MS),
  );
}

function clearBusy(workspaceId: string): void {
  const timer = supabaseBusy.get(workspaceId);
  if (timer) clearTimeout(timer);
  supabaseBusy.delete(workspaceId);
}

/**
 * The database button: type `supabase start` or `supabase stop` into a terminal
 * in this workspace.
 *
 * Typed rather than spawned, and this is the decision the whole feature rests
 * on. `supabase start` is a minute of Docker output, prompts when an image has
 * to be pulled, and an error report worth reading when it fails — and it ends by
 * printing the anon key and the studio URL, which is the thing people go looking
 * for afterwards. Run behind the scenes, all of that is lost and the button is a
 * light that goes on or does not. Run in a terminal, it is exactly what the
 * person would have typed, in a tab they can scroll, interrupt with ^C, and read
 * the keys out of. It is the same bargain ▸ makes, for the same reason.
 *
 * The terminal is chosen the way `runDev` chooses one: an idle shell in this
 * workspace with no agent in it, or a new tab in the project's directory. It
 * must not be an agent's — typing `supabase stop` at a waiting Claude Code sends
 * it as a prompt.
 */
async function runSupabase(workspaceId: string, on: boolean): Promise<void> {
  const workspace = workspaces.workspaceById(workspaceId);
  if (!workspace) return;
  const db = state.supabase.find((entry) => entry.workspaceId === workspaceId);
  if (!db) return;

  const command = await supabaseCommand(db.root, on ? "start" : "stop");
  markBusy(workspaceId);
  pushSnapshotSupabase();

  /**
   * An idle shell *standing in the project*, which is a stricter test than the
   * one `runDev` makes and has to be. `runDev` re-types a command into the
   * terminal it watched that command run in, so the directory is right by
   * construction. This has no such history: the first thing it finds might be a
   * shell somebody opened in `~` to read their mail in, and `npm run db:start`
   * typed there is a script-not-found in the wrong directory — which the row
   * would then sit and wait a full three minutes for.
   *
   * `startsWith` on the root plus a separator, not on the root: `/tmp/k2/fake`
   * must not match `/tmp/k2/faketown`, and prefix tests that forget the
   * separator are how a directory check quietly becomes a substring check.
   */
  const reuse = workspaces.agentsInWorkspace(workspaceId).find((agentId) => {
    if (!canTypeInto(agentId) || devRunning.has(agentId)) return false;
    const cwd = host.find(agentId)?.cwd ?? "";
    return cwd === db.root || cwd.startsWith(`${db.root}/`);
  });
  if (reuse) {
    typeCommand(reuse, command);
    return;
  }

  const agent = await host.create({ cwd: db.root, kind: "shell" });
  workspaces.addTabTo(workspaceId, agent.id, agent.cwd);
  allowRoot(agent.cwd);
  await settle(DEV_SPAWN_SETTLE_MS);
  if (!host.isLive(agent.id)) return;
  typeCommand(agent.id, command);
}

/**
 * Say the row is working *now*, rather than at the next tick.
 *
 * `supabase start` changes nothing observable for the better part of a minute,
 * so without this the button would be pressed and the row would sit exactly as
 * it was until the containers came up. Pressing it again in that gap is the
 * obvious thing to do and the expensive one.
 */
function pushSnapshotSupabase(): void {
  state.supabase = state.supabase.map((db) =>
    db.busy === supabaseBusy.has(db.workspaceId) ? db : { ...db, busy: supabaseBusy.has(db.workspaceId) },
  );
  lastSupabaseJson = JSON.stringify(state.supabase);
  broadcast({ type: "supabase", dbs: state.supabase });
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

/**
 * Where the repository is for a given directory, so the walk up the tree is not
 * redone every four seconds.
 *
 * Only the *walk* is remembered, never the branch. That split is the whole
 * design: where `.git` lives changes about as often as somebody moves a project,
 * and what is in `HEAD` changes every time they check something out — which is
 * the fact the row exists to show. Caching the second would make the row a
 * picture of a branch from a minute ago, which is worse than no row.
 */
const repoSeen = new Map<string, { at: number; found: { root: string; git: string } | null }>();
const REPO_CACHE_MS = 60_000;

async function repoFor(dir: string): Promise<{ root: string; git: string } | null> {
  const had = repoSeen.get(dir);
  if (had && Date.now() - had.at < REPO_CACHE_MS) return had.found;
  const found = await repoAt(dir);
  repoSeen.set(dir, { at: Date.now(), found });
  return found;
}

let lastBranchJson = "";

/**
 * What every workspace of the active profile has checked out.
 *
 * The active profile only, on `pollSupabase`'s reasoning: the snapshot carries
 * one profile, so the rows this could describe are the rows nobody can see.
 */
async function pollBranches(): Promise<void> {
  if (!host || !workspaces) return;
  const branches: WorkspaceBranch[] = [];
  for (const workspace of workspaces.active.workspaces) {
    for (const dir of workspaceDirs(workspace)) {
      const repo = await repoFor(dir);
      if (!repo) continue;
      const head = await readHead(repo);
      // A repository whose HEAD could not be read is still the answer to "which
      // repository is this workspace in", so the walk stops here either way —
      // trying the next directory up would find the *parent* repo and report a
      // branch from a project this workspace is not in.
      if (head) branches.push({ workspaceId: workspace.id, ...head });
      break;
    }
  }
  const json = JSON.stringify(branches);
  if (json === lastBranchJson) return;
  lastBranchJson = json;
  state.branches = branches;
  broadcast({ type: "branches", branches });
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
 * Ask the account where it stands against its limits.
 *
 * Skipped entirely when nobody is connected, which none of the other polls
 * bother with and this one must. The others read this machine — a `ps`, an
 * `lsof` — and running them for nobody wastes a few milliseconds of our own CPU.
 * This one is a request to somebody else's API carrying somebody's credential,
 * and making it on a schedule for a window that is not open is the kind of thing
 * that should never have been written. A client connecting gets the last reading
 * immediately and a fresh one within the minute.
 */
async function pollAccountUsage(): Promise<void> {
  if (clients.size === 0) return;
  if (await pollUsage()) broadcast({ type: "usage", usage: usageSnapshot() });
}

/**
 * The timers left in this process, and what they have in common: each one asks
 * the *machine* a question no pty can raise an event about. The status heuristic
 * and the agent scan went with the ptys, because those are questions about a
 * process kururu owns and the host is where those live now.
 *
 * The usage poll is the exception to the sentence above and the only one of
 * these that leaves the machine at all. It is out here with the rest because it
 * is the same shape — a question with no event behind it — and a minute apart
 * rather than seconds because it is measuring a five-hour window.
 */
const timers = [
  setInterval(() => void pollDevServers(), DEV_SCAN_MS),
  setInterval(() => void pollSupabase(), SUPABASE_SCAN_MS),
  setInterval(() => void pollBranches(), GIT_SCAN_MS),
  setInterval(() => void pollEditors(), NVIM_SCAN_MS),
  setInterval(() => void pollMemory(), MEM_SCAN_MS),
  setInterval(() => void pollAccountUsage(), USAGE_POLL_MS),
];

void pollDevServers();
void pollSupabase();
void pollBranches();

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

    case "reorder-agent": {
      // The base is the host's order, exactly as `snapshot` takes it, because
      // the list the drop was aimed at was drawn from that and a splice against
      // any other would land the row above a different neighbour.
      const profileId = workspaces.profileOf(msg.agentId);
      if (!profileId) return;
      const mine = new Set(workspaces.agentsIn(profileId));
      const ids = host.agents.filter((agent) => mine.has(agent.id)).map((agent) => agent.id);
      workspaces.reorderAgent(msg.agentId, msg.beforeAgentId, ids);
      return;
    }

    case "hide-agent":
      // No id check of its own: `setAgentHidden` finds the profile the terminal
      // is in and does nothing when there isn't one, which is the same answer a
      // guard here would give one line earlier.
      workspaces.setAgentHidden(msg.agentId, msg.hidden === true);
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
        // Somebody is looking at it now, so whatever it wanted has been seen.
        // Opened, not merely warm: an emulator kept current in a workspace you
        // are not in is nobody reading it. The other way the mark comes off is
        // the terminal going back to work — see `noticeStatuses`.
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
      saveAppearance({ ...appearance, themeId: themeFor(msg.themeId, styles.themes).id });
      return;

    /**
     * The same shape `set-theme` has, and nothing more, because the difference
     * between the two is entirely on the client: a skin moves the line weight
     * and the type ramp, so applying one re-measures every terminal, whereas a
     * theme never does. That belongs where the measuring happens — nothing here
     * resizes anything, for the reason `set-terminal-appearance` gives below.
     */
    case "set-skin":
      saveAppearance({ ...appearance, skinId: skinFor(msg.skinId, styles.skins).id });
      return;

    /**
     * A notification was clicked. Take them to it — see `Workspaces.reveal` for
     * why the four moves are one method, and note the one thing this does *not*
     * do: nothing here raises the window. That is the desktop bridge's, because
     * only the process that owns a window can raise it, and the phone has no
     * window to raise.
     */
    case "reveal-agent":
      workspaces.reveal(msg.agentId);
      return;

    case "set-notify":
      saveNotify(adoptNotify(msg.notify));
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

    case "supabase-power":
      // As above, and more so: this one takes a minute, and what reports it is
      // the terminal the command was typed into.
      void runSupabase(msg.workspaceId, msg.on === true).catch((err) => {
        console.error("kururu: could not reach the database:", err instanceof Error ? err.message : err);
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
  // A manifest served as anything else is a manifest Chrome refuses to parse,
  // and the symptom is the home-screen icon quietly going back to a screenshot.
  ".webmanifest": "application/manifest+json",
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
  // What a `sound` style may ship — `SOUND_FORMATS`, and nothing wider. These
  // reach a browser through `/api/styles/asset` and `/api/styles/preview`,
  // which serve whatever an entry recorded; a type guessed as
  // `application/octet-stream` is one Safari will not decode.
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
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

/** Read a JSON request body, with a cap — this endpoint is tailnet-reachable. */
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

  /**
   * Everything below this line is behind the gate, and that is deliberate rather
   * than tidy: a list of protected paths is a list somebody adds a route to
   * without noticing, and the route they forget will be the one that reads a
   * file. See `access.ts` for what is actually being decided. The two answers
   * are told apart on purpose — a page from somewhere else is a bug or an attack
   * and is worth saying so about, while a missing token is a phone that has not
   * scanned the QR code yet and is an instruction, not an error.
   */
  const allowed = verdict(req, url);
  if (allowed !== "ok") {
    text(
      res,
      allowed === "cross-origin"
        ? "kururu: refused — this page is not one kururu serves."
        : "kururu: this server is shared, so it wants the token from its Share dialog. Scan the QR code again.",
      403,
    );
    return;
  }

  /**
   * One scanned QR code, turned into a device that keeps working.
   *
   * The token arrives as `?k=` on the address the phone opened, and the page
   * hands it straight back here so it can be exchanged for a cookie — which the
   * browser then attaches to every fetch *and to the WebSocket handshake*, which
   * is the whole reason this is a cookie and not something the client would have
   * to remember to add in eleven places. It also works identically in
   * development, where the page comes from vite and only the proxied requests
   * ever reach this process, so there is no second arrangement to keep in step.
   *
   * Reachable without a token by construction — the gate above has already
   * accepted this request, and on a shared server accepting it is what having
   * presented a valid one *means*.
   */
  if (url.pathname === "/api/access") {
    if (!isShared()) {
      json(res, { ok: true, shared: false });
      return;
    }
    if (!hasToken(req, url)) {
      text(res, "kururu: that token is not this server's.", 403);
      return;
    }
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "set-cookie": cookieHeader(token()),
    });
    res.end(JSON.stringify({ ok: true, shared: true }));
    return;
  }

  if (url.pathname === "/api/health") {
    json(res, {
      ok: true,
      // The one field something outside kururu reads to tell two builds apart —
      // a window against a server in a cupboard, or the updater against either.
      version: VERSION,
      agents: host.agents.length,
      liveAgents: host.agents.filter(countsAsAgent).length,
      devServers: state.devServers.length,
    });
    return;
  }

  /**
   * Whether there is a newer kururu. A `force` is somebody pressing the button a
   * second time, which is the one case that should skip the cache — see
   * `update.ts` for why there is one.
   */
  if (url.pathname === "/api/update") {
    const check = await checkForUpdate(url.searchParams.has("force"));
    /**
     * The notes are rendered here rather than in `update.ts` because this is
     * where the theme is — release notes are code blocks as often as not, and
     * highlighting them against a palette the window is not wearing is worse
     * than not highlighting them. A failure falls back to the markdown source,
     * which is perfectly readable and is what a changelog is written as anyway.
     */
    let notesHtml: string | null = null;
    if (check.notes) {
      try {
        notesHtml = (await renderMarkdown(check.notes, "", "release-notes.md", appearance.themeId)).html;
      } catch {
        notesHtml = null;
      }
    }
    json(res, { ...check, notesHtml });
    return;
  }

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

  /**
   * The addresses this machine can be reached at, for the QR the phone scans.
   * Asked for rather than pushed: it changes when somebody joins a different
   * network or brings tailscale up, neither of which raises an event here, and
   * a poll running forever to keep a value only one dialog ever draws would be
   * a timer earning nothing. See `reach.ts`.
   */
  if (url.pathname === "/api/reach") {
    json(res, { ...reach(PORT), ...sharing() });
    return;
  }

  /**
   * Turning sharing on or off, and minting a new token.
   *
   * A POST rather than a message on the socket, because it is answered with the
   * new state and the dialog needs that answer — a snapshot cannot carry it, for
   * the reason `wire.ts` gives beside `Sharing`: the token has no business going
   * to every client on every change. Restarting is the caller's, and only when
   * the bind address actually has to move: turning sharing off while already
   * loopback-bound changes nothing about the socket.
   */
  if (url.pathname === "/api/share" && req.method === "POST") {
    const body = await readJsonBody(req);
    const wanted = (body as { share?: unknown } | null)?.share;
    const rotate = (body as { rotate?: unknown } | null)?.rotate === true;

    let next = rotate ? rotateToken() : sharing();
    if (typeof wanted === "boolean") {
      next = setShare(wanted);
      json(res, next);
      /**
       * Restarted only when the *socket* disagrees with what was just chosen,
       * which is not the same test as "the decision changed": somebody who
       * turns sharing on and immediately off again has changed the file twice
       * and the socket never needed to move at all. Sent after the answer has
       * gone out, or the dialog is told nothing and is left looking at a
       * connection that dropped for no reason it could explain.
       */
      if (wanted !== isShared() && next.restartable) {
        setTimeout(() => process.exit(RESTART_EXIT_CODE), 250);
      }
      return;
    }
    json(res, next);
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
   * What there is to be notified *by*: kururu's own sounds and the machine's.
   *
   * A fetch rather than a snapshot field, on `/api/styles`' split — the snapshot
   * carries what somebody *chose*, and this is what there is to choose from. It
   * is a directory listing of somebody else's files, it changes when they drop a
   * file into `~/Library/Sounds` rather than when kururu does anything, and the
   * only thing in the window that cannot be drawn without it is the one tab
   * asking.
   */
  if (url.pathname === "/api/sounds") {
    json(res, { sounds: sounds() });
    return;
  }

  /**
   * One sound, in something the browser can actually play.
   *
   * The transcode is `sounds.ts`' business and the reason it exists; what
   * belongs here is the caching, and it is a year because a *sound* is
   * immutable in the way a style asset is: the id names a file on this machine
   * and the phone should fetch each one once, ever. The case that breaks that —
   * somebody replacing `~/Library/Sounds/Frog.wav` — is rare enough and
   * self-inflicted enough that a reload is the right cost, where re-fetching
   * every notification sound on every page load is not.
   */
  if (url.pathname === "/api/sound") {
    const sound = await soundBytes(url.searchParams.get("id") ?? "");
    if (!sound) {
      text(res, "no such sound\n", 404);
      return;
    }
    res.writeHead(200, {
      "content-type": sound.type,
      "content-length": sound.bytes.length,
      "cache-control": "public, max-age=31536000, immutable",
    });
    res.end(sound.bytes);
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
   * from the tailnet. `no-cache` so a user who overwrites their own sheet sees
   * it after a reload rather than after a restart; the sheets that ship never
   * change, and they are fifteen kilobytes.
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

  // --- the styles registry -------------------------------------------------
  /**
   * What `../kururu-styles` is offering, and what this machine already has of it.
   *
   * A fetch rather than a snapshot field, and the split is the one the update
   * check draws: the snapshot carries what *kururu* owns, and this is the
   * world's. It changes when somebody merges a pull request in another
   * repository, answering it means a request over the network, and nothing in
   * the window can be drawn without it except the one tab that is asking. The
   * installed half *is* in the snapshot, because a theme you are wearing is not
   * a catalogue.
   *
   * `?refresh=1` is the *Check for updates* button, and it is the only thing
   * that bypasses the ten-minute cache — which is what makes that button a
   * button rather than decoration.
   */
  if (url.pathname === "/api/styles/catalog") {
    const { index, stale, error } = await catalog(url.searchParams.get("refresh") === "1");
    json(res, {
      entries: index ? annotateCatalog(index, styles.installed) : [],
      stale,
      ...(error ? { error } : {}),
      home: stylesHome(),
    });
    return;
  }

  /**
   * One file out of an installed style — a font, a stylesheet, a texture.
   *
   * An endpoint rather than static serving for `sheetFile`'s reason and one
   * more. The reason: the name is checked against what the entry actually
   * recorded rather than pasted into a path, and this is reachable from the
   * tailnet. The one more: everything a style brings is served from *kururu's
   * own origin*, which is the entire point of installing rather than linking —
   * a window that fetched a font from somebody else's host would tell that host
   * when its owner was working.
   *
   * Cached hard, because the URL names an entry whose contents cannot change
   * without a version bump and a reinstall.
   */
  if (url.pathname === "/api/styles/asset") {
    const path = assetFile(
      url.searchParams.get("kind") ?? "",
      url.searchParams.get("id") ?? "",
      url.searchParams.get("file") ?? "",
    );
    if (!path) {
      text(res, "no such asset\n", 404);
      return;
    }
    let body: Buffer;
    try {
      body = readFileSync(path);
    } catch {
      text(res, "no such asset\n", 404);
      return;
    }
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
      "content-length": body.length,
      "cache-control": "public, max-age=31536000, immutable",
    });
    res.end(body);
    return;
  }

  /**
   * The picture for a mascot, or the noise for a sound, that nobody has
   * installed yet — proxied from the registry. See `preview` in
   * `server/src/styles.ts` for why this exists at all and why the browser is not
   * the thing fetching it.
   */
  if (url.pathname === "/api/styles/preview") {
    const shot = await previewStyle(url.searchParams.get("kind") ?? "", url.searchParams.get("id") ?? "", url.searchParams.get("file"));
    if (!shot) {
      text(res, "no preview\n", 404);
      return;
    }
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(shot.file).toLowerCase()] ?? "application/octet-stream",
      "content-length": shot.bytes.length,
      // Not `immutable`: the URL names an entry rather than a version, so it is
      // the one asset URL in kururu whose contents can change under it — a
      // registry entry updated upstream is exactly that. An hour is long enough
      // that scrolling the list twice is one request.
      "cache-control": "public, max-age=3600",
    });
    res.end(shot.bytes);
    return;
  }

  /**
   * Install one, and — if that is what the gesture was — wear it.
   *
   * `activate` is a parameter rather than something this decides, because the
   * two callers mean different things by the same download. Picking a theme in
   * the Styles tab is "I want this one", and an install that did not put it on
   * would make choosing a two-step gesture for no reason. Pressing *Update* on a
   * style you are not currently wearing is not a request to start wearing it,
   * and one that switched the window out from under you would be the kind of
   * surprise nobody forgives.
   */
  if (url.pathname === "/api/styles/install" && req.method === "POST") {
    const kind = url.searchParams.get("kind") ?? "";
    const id = url.searchParams.get("id") ?? "";
    const activate = url.searchParams.get("activate") === "1";
    const result = await installOne(kind, id, activate);
    if (!result.ok) {
      json(res, { error: result.error }, 400);
      return;
    }
    json(res, { ok: true, installed: styles.installed });
    return;
  }

  /**
   * Wear one that is already here. No network, no download, no version.
   *
   * A separate verb from `install` rather than `install?activate=1` on a style
   * that is already on disk, and the difference is the network: this has to work
   * on a plane. Installing checks the registry for the entry, which is right for
   * a download and absurd for "put the pack I have back on" — and it is the
   * gesture somebody makes most, because a pack is five decisions and changing
   * one of them by hand is how you end up wanting the other four back.
   */
  if (url.pathname === "/api/styles/wear" && req.method === "POST") {
    const kind = url.searchParams.get("kind") ?? "";
    const id = url.searchParams.get("id") ?? "";
    if (!isStyleKind(kind) || !isStyleId(id)) {
      json(res, { error: "that is not a style" }, 400);
      return;
    }
    const result = wear(kind, id);
    if (!result.ok) {
      json(res, { error: result.error }, 400);
      return;
    }
    json(res, { ok: true, installed: styles.installed });
    return;
  }

  if (url.pathname === "/api/styles/remove" && req.method === "POST") {
    const result = removeStyle(url.searchParams.get("kind") ?? "", url.searchParams.get("id") ?? "");
    if (!result.ok) {
      json(res, { error: result.error }, 400);
      return;
    }
    /**
     * Nothing here un-picks anything, and that is the point of the design rather
     * than an omission. `appearance.json` keeps the id of a theme you removed,
     * `themeFor` falls back to the default while it is gone, and reinstalling it
     * puts you back where you were — which is only possible because
     * `adoptAppearance` stopped rewriting ids it could not resolve.
     */
    styles = readLibrary();
    pushSnapshot();
    json(res, { ok: true, installed: styles.installed });
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

  // --- the skin studio ------------------------------------------------------
  /**
   * A skin of yours, being made. See `server/src/studio.ts` for what one is —
   * an ordinary installed skin with `local` on its record — and why that is the
   * whole design. What is here is the four verbs and one rule they share: every
   * one of them ends in `styles = readLibrary()` and a snapshot, because the
   * point of the studio is that the window you are looking at *is* the preview,
   * and so is the phone's.
   *
   * Wearing follows editing. Creating a skin puts it on, and so does the first
   * edit to one you are not wearing, on the reasoning the Styles tab gives for
   * picking being installing: nobody opens a skin to edit it and then wonders
   * whether to look at it. It is the studio's one act of switching, and it is
   * the reason the response is the manifest rather than a bare `ok` — the
   * page needs the file names back to draw its thumbnails from.
   */
  if (url.pathname === "/api/studio/skin") {
    const id = url.searchParams.get("id") ?? "";
    if (req.method === "GET") {
      const manifest = readLocalManifest(id);
      if (!manifest) {
        json(res, { error: "that is not a skin of yours" }, 404);
        return;
      }
      const record = styles.installed.find((r) => r.kind === "skin" && r.id === id && r.local);
      json(res, { manifest, files: record?.files ?? [], dir: localDir(id) });
      return;
    }
    if (req.method === "POST") {
      const result = createLocalSkin(id, url.searchParams.get("name") ?? "", url.searchParams.get("from"), styles);
      if (!result.ok) {
        json(res, { error: result.error }, 400);
        return;
      }
      styles = readLibrary();
      saveAppearance({ ...appearance, skinId: id });
      json(res, { ok: true, manifest: result.manifest, files: styles.installed.find((r) => r.kind === "skin" && r.id === id)?.files ?? [], dir: localDir(id) });
      return;
    }
    if (req.method === "PUT") {
      let body: unknown;
      try {
        body = await readJsonBody(req, 256 * 1024);
      } catch {
        json(res, { error: "that manifest could not be read" }, 400);
        return;
      }
      const result = writeLocalManifest(id, body);
      if (!result.ok) {
        json(res, { error: result.error }, 400);
        return;
      }
      styles = readLibrary();
      if (appearance.skinId !== id) saveAppearance({ ...appearance, skinId: id });
      else pushSnapshot();
      json(res, { ok: true, manifest: result.manifest });
      return;
    }
    text(res, "GET, POST or PUT", 405);
    return;
  }

  /**
   * A picture or a font, into a skin of yours. The body is the file, on the
   * mascot import's reasoning — one file to one place, and the name in the
   * query so the bytes can stay the bytes. Every check is in `putLocalAsset`,
   * beside the write.
   */
  if (url.pathname === "/api/studio/asset") {
    const id = url.searchParams.get("id") ?? "";
    const file = url.searchParams.get("file") ?? "";
    if (req.method === "DELETE") {
      const result = removeLocalAsset(id, file);
      if (!result.ok) {
        json(res, { error: result.error }, 400);
        return;
      }
      styles = readLibrary();
      pushSnapshot();
      json(res, { ok: true, files: result.files });
      return;
    }
    if (req.method !== "POST") {
      text(res, "POST or DELETE", 405);
      return;
    }
    let bytes: Buffer;
    try {
      bytes = await readBody(req, IMPORT_LIMIT);
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : "could not read that file" }, 413);
      return;
    }
    const result = putLocalAsset(id, file, bytes);
    if (!result.ok) {
      json(res, { error: result.error }, 400);
      return;
    }
    styles = readLibrary();
    pushSnapshot();
    json(res, { ok: true, file: result.file, files: result.files, width: result.width, height: result.height, stamp: Date.now() });
    return;
  }

  /**
   * Show the skin's directory in the file manager — of the machine the server
   * is on, which is the only machine that has it. From the phone this opens a
   * Finder window on the desktop, which is odd and correct: the files are
   * there, and "where did my skin go" has one answer. The path is the server's
   * own, built from an id it checked; nothing from the client reaches the
   * command line.
   */
  if (url.pathname === "/api/studio/reveal" && req.method === "POST") {
    const id = url.searchParams.get("id") ?? "";
    if (!readLocalManifest(id)) {
      json(res, { error: "that is not a skin of yours" }, 404);
      return;
    }
    const dir = localDir(id);
    const [cmd, args] = process.platform === "darwin" ? ["open", [dir]] : ["xdg-open", [dir]];
    execFile(cmd, args, () => {
      // A machine with no file manager is a machine where the path in the
      // dialog is the answer, and it is already on screen.
    });
    json(res, { ok: true, dir });
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
  /**
   * The same gate the HTTP side is behind, and the case it exists for most.
   *
   * A WebSocket is not subject to the same-origin policy and sends no preflight,
   * so without this any page in any tab could open one to a *loopback-bound*
   * kururu and drive it — read the snapshot, spawn a pty, type into it. The
   * refusal is a closed socket rather than a status, because there is no
   * handshake to put one in yet and a client that is not ours has nothing to be
   * told.
   */
  if (verdict(req, url) !== "ok") {
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
    send(ws, { type: "supabase", dbs: state.supabase });
    send(ws, { type: "branches", branches: state.branches });
    send(ws, { type: "usage", usage: usageSnapshot() });
    // The first client through the door is also what starts the usage poll: it
    // is skipped while nothing is connected, so without this a freshly started
    // server would draw no bar for a minute.
    void pollAccountUsage();

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
  host.onAgents = () => {
    // One event, three readers. Notifications want the *transition* and the
    // snapshot carries the state, so this has to run wherever the state is
    // learnt — a second subscription would be a second thing to keep in step
    // with a status that already only changes in one place. The reap is the
    // same argument again, and runs after the notice so that a terminal which
    // said something on its way out has still been heard.
    noticeStatuses();
    reapExited();
    pushSnapshot();
  };
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
    if (placed.has(agent.id)) continue;
    // One that ended while nothing was attached is reaped rather than placed:
    // `live` has already dropped its tab, and putting a dead terminal in
    // whatever pane happens to be focused is worse than not showing it at all.
    // Straight to the host, because the layout no longer mentions it and the
    // rest of `reapExited` would be looking for a tab that is not there.
    if (agent.exited) {
      host.kill(agent.id);
      continue;
    }
    workspaces.addTab(agent.id, agent.cwd);
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

  server.listen(PORT, bindAddress(), () => {
    const built = existsSync(join(WEB_DIST, "index.html"));
    console.log(`kururu server  http://localhost:${PORT}  (v${VERSION})`);
    console.log(`  agents       ${state.agents.length} held by the pty host`);
    console.log(`  web app      ${built ? WEB_DIST : "not built — bun run build"}`);
    // Said every time, because which of the two a server is in is the one thing
    // about it somebody could be wrong about in a way that matters.
    console.log(
      `  reachable    ${isShared() ? "from other machines, with the token from the Share dialog" : "from this machine only"}`,
    );
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
