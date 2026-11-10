/**
 * What every part of the server shares: the subsystems `attach()` builds, the
 * connected clients and the one way anything reaches them, the settings and
 * per-agent state a snapshot is made of, and the snapshot itself.
 *
 * It exists because `index.ts` was the composition root and twenty features
 * at once, and none of them could leave while the state they all read lived
 * in its module scope. With it here, a feature is a module that imports what
 * it needs from this one, and `index.ts` is what is left over.
 *
 * The subsystems are `let`s that `attach()` fills in once, through `provide`,
 * because ESM lets only the module that declares a binding assign it; every
 * importer reads the live binding, so code that ran before attach still sees
 * them filled in afterwards, exactly as when they were the entry module's
 * own. The settings that change at runtime are assigned the same way, by the
 * verbs that change them. A context object (`ctx.workspaces`) was the
 * alternative and would have touched every line that reads one.
 */
import type { WebSocket } from "ws";
import type { WorkspaceDatabase } from "../../shared/databases";
import type { AgentSnapshot, HostInfo, LoginSummary, SessionSnapshot } from "../../shared/model";
import { BY_MAX, oneLine, reloaderName } from "../../shared/reload";
import { diffFrames, type Frame, Framer, type SnapshotDelta } from "../../shared/snapdelta";
import type { DevServer, ServerMessage, WorkspaceBranch, WorkspaceProject } from "../../shared/wire";
import { readAppearance } from "./appearance";
import { delivery, type Delivery, liveness, SNAPSHOT_HOLD } from "./backpressure";
import { Backup } from "./backup";
import { Channels } from "./channels";
import { Gap } from "./gap";
import { Harness } from "./harness";
import { HostLink } from "./hostlink";
import { readKeys } from "./keys";
import { Kuru } from "./kuru";
import { readLaunch } from "./launch";
import { TelegramLead } from "./lead";
import { loginDir } from "./logins";
import { MadeFiles } from "./made";
import { adoptLegacySheet, readMascots } from "./mascot";
import { MouseEncoding } from "./mouseencoding";
import { Mover } from "./move";
import { NodeNotices } from "./nodenotice";
import { NodeHost } from "./nodes";
import { NodeWatches } from "./nodewatch";
import { readNotify } from "./notify";
import { OnScreen } from "./onscreen";
import { Outbox } from "./outbox";
import { PeerKurus } from "./peerkuru";
import { snapshotPath } from "./persist";
import { readProjects } from "./projects";
import { WindowReloads } from "./reload";
import { Secrets } from "./secrets";
import type { Grid } from "./sizing";
import { Sleeper } from "./sleep";
import type { Slots } from "./slots";
import type { Vault } from "./vaultstore";
import { Store } from "./store";
import { Launches } from "./usage/attribute";
import { NodeUsage } from "./usage/remote";
import type { UsageReader } from "./usage/sweep";
import { Voice } from "./voice";
import { orderAgents, Workspaces } from "./workspaces";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface ClientState {
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
   * Somebody is in front of this client — the page is not in a pocket.
   *
   * It gates the proposals above and reaches nothing else. A socket says
   * nothing about a screen: a phone that locks keeps every pane it had, goes on
   * claiming to see them for as long as the connection lives, and the
   * connection is deliberately never hung up on. The minimum is over the
   * clients that can *see* a terminal, so that claim was the desktop being held
   * at phone width by a phone on a table in another room.
   *
   * False does not withdraw the proposals, it stops counting them. A page that
   * comes back has the same panes at the same sizes and can vote again in the
   * message that says so, rather than in whatever frame its emulators get round
   * to measuring in.
   *
   * True until a client says otherwise, which is also what an older client that
   * never sends `looking` means.
   */
  looking: boolean;
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
  /**
   * The node this client is, when it is the parent's server watching this
   * one through `/link/watch` rather than a window — the id the node
   * handshake proved. Null for a window, a pill or a phone.
   *
   * A watcher is a client in every way the terminals count one: it watches,
   * proposes sizes, looks, asks for backlogs and types, through the same
   * code a phone does. It is not a window in any other way, and everything
   * that asks "is anybody here" asks without it: it is sent the snapshot and
   * the terminals' bytes and nothing else a page is sent, it starts none of
   * the polls a first window starts — the parent draws its own bar — it
   * takes no part in the voice, and it is never "the phone arriving" that
   * the setup wizard waits for. See `docs/plans/remote-workspaces.md`.
   */
  watcher: string | null;
  /**
   * Whether anything has come back on this socket since the last ping: a
   * pong, or any message. See `checkLiveness`.
   */
  heard: boolean;
  /**
   * A snapshot this client was owed while it was too far behind to be sent
   * one, which it gets — the latest, not every one it missed — once its
   * buffer drains. See `deliver`.
   */
  owedSnapshot: boolean;
  /**
   * Whether this client opened its socket with `?delta=1`, and so is sent
   * what changed rather than the whole snapshot each time. See
   * `shared/snapdelta.ts`.
   */
  deltas: boolean;
  /**
   * The state this client was last sent, which the next is diffed against —
   * for a client of deltas, and for one of snapshots so that an unchanged
   * one is not sent again. Null until the first, and whenever one was not
   * delivered, so the next is whole. See `sendState`.
   */
  sent: Frame | null;
}

/**
 * The link to the pty host, and the arrangement.
 *
 * Both are filled in by `attach()` once the main process has handed us a port:
 * the host is asked what is running and what the previous server left behind,
 * and only then is there anything to serve. Before that this process is a socket
 * nobody has said anything on yet.
 */
// Assigned by `attach()`, through `provide`, before anything is served.
export let host!: HostLink;
export let workspaces!: Workspaces;
/** The harness's hands — built once the two above exist, at the foot of startup. See `harness.ts`. */
export let harness!: Harness;
/** Its ears and mouth, built beside it. See `voice.ts`. */
export let voice!: Voice;
/** What you said, kept on the disk until Kuru has it. See `outbox.ts`. */
export let outbox!: Outbox;
/** The conversation with Kuru as the drawer draws it, assembled from the store, the outbox and the voice. See `kuru.ts`. */
export let kuru!: Kuru;
/** Other doors into that conversation — Telegram — fed what Kuru took in and said. See `channels.ts`. */
export let channels!: Channels;
/** What an agent on a machine is doing, read off its screen since nothing there reports. See `onscreen.ts`. */
export let screens!: OnScreen;
/** Ends a card's agent that has sat idle, once its conversation is made sure of. See `sleep.ts`. */
export let sleeper!: Sleeper;
/** The build and simulator queue agents share. See `slots.ts`. */
export let slots!: Slots;
/** The database: boards, conversations and the voice's lists. Opened in `attach()`, before anything is served. See `store.ts`. */
export let store!: Store;
/** The usage ledger's reader, or null when its file would not open. See `usage/sweep.ts`. */
export let usageReader: UsageReader | null = null;
/** Whose each session was, written at launch, into the same file. See `usage/attribute.ts`. */
export let usageLaunches: Launches | null = null;
/** What the other nodes spent, asked of them by the parent. See `usage/remote.ts`. */
export let usageNodes: NodeUsage | null = null;
export let backup!: Backup;
/** This kururu among the others: pairing, the roster and the links. See `nodes.ts`. */
export let nodes!: NodeHost;
/** Other nodes' workspaces on this window: the watches of them, and which is on screen. See `nodewatch.ts`. */
export let watches!: NodeWatches;
/** Another node's agents wanting a human, raised on this node's clients. See `nodenotice.ts`. */
export let nodeNotices!: NodeNotices;
/** A workspace moved to or from another node. See `move.ts`. */
export let mover!: Mover;
/** The other nodes' Kurus: asking them, reading them, and their conversations in the drawer. Null until the links exist. See `peerkuru.ts`. */
export let peerKurus: PeerKurus | null = null;

/**
 * The profile whose Kuru is this node's Kuru to the other nodes — the one
 * `@mac` names, that their messages go to and whose conversation they draw:
 * the one Telegram is pointed at, else the active one. A child has one.
 */
export function kuruKey(): string | null {
  return channels.telegram.profileKey() ?? workspaces.active.key;
}

/** The secrets this node lends its children, or holds from its parent. See `secrets.ts`. */
export let secrets!: Secrets;
/** The vault's own items and the dialogs that fill them. See `vaultstore.ts`. */
export let vault!: Vault;
/** Which node polls Telegram for the others, and the chat's words crossing the links. Null until the links exist. See `lead.ts`. */
export let lead: TelegramLead | null = null;

/** The parent's Telegram settings into the roster, whenever they may have moved. A no-op anywhere else, and when nothing changed. */
export function syncRosterChannels(): void {
  if (nodes?.role() === "parent") nodes.setChannels(channels.telegram.ownShared());
}
export const clients = new Map<WebSocket, ClientState>();

/**
 * How many of the clients are windows — pages, pills, phones — and not a
 * parent watching this node. What every "is anybody connected" asks, since
 * a watcher is nobody to draw a bar for.
 */
export function windows(): number {
  let n = 0;
  for (const st of clients.values()) if (!st.watcher) n++;
  return n;
}

/**
 * What a watcher is sent of what everybody is sent: the snapshot, which is
 * the tree it relays, and where each workspace is on this disk, which its
 * file tree opens on. The rest of a page's messages — the usage, the voice,
 * the nodes, the backup — are about this node's own window, and the parent
 * draws its own.
 */
function forWatcher(msg: ServerMessage): boolean {
  return msg.type === "snapshot" || msg.type === "projects";
}

export const state = {
  devServers: [] as DevServer[],
  branches: [] as WorkspaceBranch[],
  projects: [] as WorkspaceProject[],
  databases: [] as WorkspaceDatabase[],
};

/**
 * One frame out — or held, or the client cut off, by `delivery`
 * (`backpressure.ts`). Everything to a client goes through here; `send` and
 * `broadcast` are only the stringifying.
 */
export function deliver(ws: WebSocket, payload: string, snapshot = false): Delivery {
  const verdict = delivery(ws.bufferedAmount, snapshot);
  if (verdict === "cut") {
    // `terminate`, not `close`: a close handshake would queue behind the
    // same megabytes. The close event drops the client as any other does.
    ws.terminate();
    return verdict;
  }
  const st = verdict === "hold" ? clients.get(ws) : undefined;
  if (st) {
    st.owedSnapshot = true;
    holdSnapshots();
    return verdict;
  }
  try {
    ws.send(payload);
  } catch {
    // client went away mid-send; the close handler will clean up
  }
  return verdict;
}

/**
 * A snapshot still waiting to go is sent ahead of anything else but output.
 * The throttle in `pushSnapshot` delays it, and a message that follows a
 * verb — a notice about an agent, a spawned terminal's answer — must not
 * reach a window before the snapshot that has the thing it is about.
 */
function snapshotFirst(msg: ServerMessage): void {
  if (snapshots.pending && msg.type !== "output" && msg.type !== "snapshot" && msg.type !== "delta") snapshots.flush();
}

export function send(ws: WebSocket, msg: ServerMessage): void {
  snapshotFirst(msg);
  deliver(ws, JSON.stringify(msg), msg.type === "snapshot");
}

export function broadcast(msg: ServerMessage): void {
  snapshotFirst(msg);
  const payload = JSON.stringify(msg);
  const watchers = forWatcher(msg);
  const snapshot = msg.type === "snapshot";
  for (const [ws, st] of clients) {
    if (st.watcher && !watchers) continue;
    deliver(ws, payload, snapshot);
  }
}

/**
 * The clients owed a snapshot, looked at until each has drained enough to be
 * sent the current one. A timer only while somebody is owed, since nearly
 * always nobody is.
 */
let snapshotHold: ReturnType<typeof setInterval> | null = null;
function holdSnapshots(): void {
  if (snapshotHold) return;
  snapshotHold = setInterval(releaseSnapshots, 250);
  snapshotHold.unref?.();
}

function releaseSnapshots(): void {
  const due: [WebSocket, ClientState][] = [];
  let owed = 0;
  for (const [ws, st] of clients) {
    if (!st.owedSnapshot) continue;
    if (ws.bufferedAmount > SNAPSHOT_HOLD) {
      owed++;
      continue;
    }
    st.owedSnapshot = false;
    // What it was owed was never sent, so what it holds is older than any
    // delta would be from: the whole snapshot.
    st.sent = null;
    due.push([ws, st]);
  }
  if (due.length) sendState(due, snapshot());
  if (!owed && snapshotHold) {
    clearInterval(snapshotHold);
    snapshotHold = null;
  }
}

/**
 * Builds each client's frame. One for the server's life, so that a board's
 * frame outlives the snapshot it was first seen in — see `Framer`.
 */
const framer = new Framer();

/**
 * The state, to some clients: to each what changed since what it was last
 * sent (`ClientState.sent`), as a `delta` to a client that asked for them and
 * as the whole `snapshot` to one that did not, or to one that holds nothing
 * yet. Nothing at all to a client for which nothing changed.
 *
 * Most clients were sent the same frame last, so each distinct delta is
 * worked out and stringified once, and the whole snapshot — still a megabyte
 * and a half, still ~25 ms — only when somebody is to be sent it.
 *
 * `now` is taken rather than read here because `snapshot()` is also when
 * the server notes what is running where (`rememberAgents`), and the
 * broadcast must read it whether or not anybody is connected.
 */
export function sendState(targets: Iterable<readonly [WebSocket, ClientState]>, now: SessionSnapshot): void {
  let frame: Frame | null = null;
  let whole: string | null = null;
  const diffs = new Map<Frame, SnapshotDelta | null>();
  const payloads = new Map<Frame, string>();
  for (const [ws, st] of targets) {
    if (st.owedSnapshot) continue;
    frame ??= framer.frame(now);
    let payload: string;
    const sent = st.sent;
    if (sent) {
      if (!diffs.has(sent)) diffs.set(sent, diffFrames(sent, frame));
      const delta = diffs.get(sent)!;
      if (!delta) {
        st.sent = frame;
        continue;
      }
      if (st.deltas) {
        let cached = payloads.get(sent);
        if (!cached) {
          cached = JSON.stringify({ type: "delta", delta } satisfies ServerMessage);
          payloads.set(sent, cached);
        }
        payload = cached;
      } else payload = whole ??= JSON.stringify({ type: "snapshot", snapshot: now } satisfies ServerMessage);
    } else payload = whole ??= JSON.stringify({ type: "snapshot", snapshot: now } satisfies ServerMessage);
    // A held delta is a hole in what the client holds, as a held snapshot
    // was a stale one: either way the next it is sent is whole.
    st.sent = deliver(ws, payload, true) === "send" ? frame : null;
  }
}

/**
 * Whether each client is still there (`liveness`, every `PING_MS`). `/ws`
 * had no liveness at all: a phone that left the tailnet without a FIN stayed
 * in `clients` until the kernel gave up on it, holding a size vote, a voice
 * seat and everything sent to it in the meantime. Now it goes thirty to sixty
 * seconds after it went. A phone that only locked its screen loses its socket
 * the same way, which iOS takes from a suspended page anyway, and reconnects
 * when it wakes as it did then.
 */
export function checkLiveness(): void {
  for (const [ws, st] of clients) {
    if (liveness(st.heard) === "drop") {
      ws.terminate();
      continue;
    }
    st.heard = false;
    try {
      ws.ping();
    } catch {
      // Closing already.
    }
  }
}

/**
 * Agents asking for the window to be reloaded — `bun run reload-window` and
 * the harness's `reload_window`. It talks to the clients and nothing else;
 * see `reload.ts`.
 */
export const reloads = new WindowReloads<WebSocket>({ send, connected: () => windows() });

/**
 * Who asked for a reload, as the window's notice names them: the agent the
 * command ran in, found by the id its pty was started with — the way the
 * report hook knows which agent it is — or what a caller from outside kururu
 * called itself.
 */
export function reloaderOf(agentId: string | null, given: string | null): string {
  const agent = agentId ? host.find(agentId) : undefined;
  if (agent) {
    const profileId = workspaces.profileOf(agent.id);
    const workspace = profileId
      ? (workspaces.profile(profileId)?.workspaces.find((w) => workspaces.agentsInWorkspace(profileId, w.id).includes(agent.id))?.name ?? null)
      : null;
    return reloaderName({
      name: agent.titleOverride || null,
      doing: agent.title || activity.get(agent.id) || null,
      program: agent.agent ?? agent.lastAgent ?? (agent.kind === "shell" ? "a shell" : "an agent"),
      workspace,
    });
  }
  return given ? oneLine(given, BY_MAX) || "a terminal outside kururu" : "a terminal outside kururu";
}

/**
 * Snapshots are pushed on change rather than diffed on a timer, so the server
 * has to avoid sending the same thing twice itself: several things can change in
 * one turn of the event loop (a pty exits, its status settles, its program
 * disappears) and each of them calls onChange.
 *
 * And, for what nobody at a window did, at most one per `SNAPSHOT_GAP_MS`
 * (`gap.ts`). Coalescing within one turn of the loop was not enough, because
 * the things that change most often arrive as separate requests: every hook
 * report of every agent — each PreToolUse — is its own `/api/report` and was
 * its own 1.2 MB snapshot to every client, with ~25 ms of stringify here and a
 * ~21 ms parse in each window. So a change inside the gap waits for its end
 * and goes out as the state then is; the first after a quiet spell still goes
 * at the end of its turn.
 *
 * A client's own verb is not held: a split, a tab switch, a divider being
 * dragged are drawn off the snapshot they cause, and the drag at four frames
 * a second was the cost of holding them. The message handler flushes at the
 * end of its turn whatever it pushed (`admitClient`), which is what every
 * change did before. What a broadcast sends each client is what changed
 * since the last it was sent (`sendState`, `shared/snapdelta.ts`); this
 * only stops the reports multiplying even that.
 */
const SNAPSHOT_GAP_MS = 250;
export const snapshots = new Gap(SNAPSHOT_GAP_MS, () => {
  sendState(clients, snapshot());
  // Every change a snapshot carries is a change the other nodes' summary
  // of this one may carry too; `queueSummary` coalesces and compares.
  nodes?.queueSummary();
});
export function pushSnapshot(): void {
  snapshots.push();
}

/** The nodes view to every client, once per turn of the loop however many things moved. */
let nodesQueued = false;
export function pushNodes(): void {
  if (nodesQueued) return;
  nodesQueued = true;
  queueMicrotask(() => {
    nodesQueued = false;
    broadcast({ type: "nodes", nodes: nodes.view() });
    // A summary is what a node's notices are read off while no watch of it is up.
    for (const node of nodes.statuses()) nodeNotices?.summary(node.id, node.summary, node.state === "up", watches?.watched(node.id) ?? false);
    // A link, a roster or a summary moved, and any of them can move the
    // poll — or whether this node could take it, which its summary says.
    lead?.evaluate();
    syncRosterChannels();
    nodes.queueSummary();
  });
}

/** The secrets view to every client, once per turn of the loop. */
let secretsQueued = false;
export function pushSecrets(): void {
  if (secretsQueued) return;
  secretsQueued = true;
  queueMicrotask(() => {
    secretsQueued = false;
    if (secrets) broadcast({ type: "secrets", secrets: secrets.view() });
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
export let mascots = readMascots();
export let keys = readKeys();
export let notify = readNotify();
export let launch = readLaunch();
/** By repository root — see `shared/projects.ts`. Written by `saveProject` only. */
export let projects = readProjects();

/**
 * What the pty host said about itself when this server arrived — see
 * `HOST_PROTOCOL` — or, until it has, what a host from before the handshake
 * says: nothing, which is read as the oldest protocol there is.
 */
export let hostInfo: HostInfo = { version: null, current: false, env: false };
export let hostProtocol = 1;

/**
 * The logins on this machine as the Profiles page last saw them, and the only
 * keys `set-profile-login` will accept.
 *
 * A copy rather than a read, because it goes into every snapshot and a snapshot
 * is sent whenever anything about an agent changes — a directory listing and a
 * file read per profile on each of those is not a price to pay for a list that
 * changes when somebody types `/login`. `refreshLogins` brings it up to date on
 * the usage poll's schedule and on every verb that touches a profile, and
 * pushes a snapshot when it finds a difference, so a login made in a terminal
 * appears on the page within the minute without the page asking.
 *
 * Every key a profile holds is in the list whether or not the disk has heard
 * of it yet: a key is minted before its directory is made, and the page has to
 * be able to draw "not signed in yet" for a profile nobody has opened a
 * terminal in.
 */
export let logins: LoginSummary[] = [];

export let appearance = readAppearance();

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
export function snapshot(): SessionSnapshot {
  // Every snapshot is also the moment we learn what is running where, because it
  // is the one function that is called whenever anything about an agent changes.
  rememberAgents();
  const profile = workspaces.active;
  // A local switch, by whatever road, puts the local workspace back on screen.
  watches?.noteLocal(`${profile.id}/${profile.onDashboard ? profile.dashboard.id : profile.activeWorkspaceId}`);
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
    profiles: workspaces.summaries(
      (id) => workspaces.agentsIn(id).filter((a) => host.isLive(a)).length,
      loginDir,
    ),
    logins,
    host: hostInfo,
    // Two fields are merged here rather than carried by the host — see `overlay`
    // below, and the fields themselves in `shared/model.ts`, for why they live
    // on this side of the link at all.
    agents: here.sort((a, b) => (at.get(a.id) ?? 0) - (at.get(b.id) ?? 0)).map(overlay),
    mascots,
    keys,
    notify,
    launch,
    projectSettings: projects,
    appearance,
    remote: watches?.view() ?? null,
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
export const activity = new Map<string, string>();

/** One sidebar line's worth. The tooltip is where a long one goes in full. */
export const MAX_ACTIVITY = 200;

/**
 * What each agent's last turn ended in, as the links under its row. Beside
 * `activity` because it is the same kind of thing — about the work, from the
 * agent's own report, nothing the host needs — and unlike it kept on disk,
 * for the reason `server/src/made.ts` gives: the next report that would fill
 * it in again is the next turn, and a finished agent has none coming.
 */
export const madeFiles = new MadeFiles(MadeFiles.defaultPath(snapshotPath()));
madeFiles.load();

/**
 * When each agent's current turn began — its prompt hook's report — which is
 * what "changed this turn" is measured from (`shared/made.ts`). A restart
 * forgets it, and a turn whose start was not seen is measured from the end of
 * the one before, which `madeFiles` does keep.
 */
export const turnStart = new Map<string, number>();

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
export const unread = new Set<string>();

/**
 * Whether anybody can actually see that terminal right now.
 *
 * Visible, never merely warm: a pooled emulator in a workspace you are not in is
 * being kept current, not being read. Asked across every client because the
 * question the mark answers is "was anyone there", and the desktop showing the
 * pane answers it for the phone in your pocket.
 */
export function onScreenAnywhere(agentId: string): boolean {
  for (const st of clients.values()) if (st.watching.has(agentId)) return true;
  return false;
}

/**
 * Whether this client's emulators want that terminal's bytes — on screen or
 * merely kept. Everything that fans output out, or holds it back for a backlog,
 * asks this rather than `watching`, because a warm emulator that stops being fed
 * is a warm emulator that has to be rebuilt.
 */
export function sees(st: ClientState, agentId: string): boolean {
  return st.watching.has(agentId) || st.warm.has(agentId);
}

/** Agent id → the agent program last seen in it. See AgentSnapshot.lastAgent. */
export const lastAgent = new Map<string, string>();

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
export const memory = new Map<string, number>();

/**
 * How each terminal writes its mouse reports, so the backlog can say it too.
 * See `mouseencoding.ts` — the serializer restores the mouse being *on* and
 * loses how it speaks, and the two halves disagreeing types into the program.
 */
export const mouseEncodings = new Map<string, MouseEncoding>();

export function mouseEncodingOf(agentId: string): MouseEncoding {
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
export function overlay(agent: AgentSnapshot): AgentSnapshot {
  const said = activity.get(agent.id);
  const was = lastAgent.get(agent.id);
  const fresh = unread.has(agent.id);
  const held = memory.get(agent.id);
  const made = madeFiles.of(agent.id);
  if (!said && !was && !held && made.length === 0 && fresh === agent.unread) return agent;
  return {
    ...agent,
    ...(said ? { activity: said } : {}),
    ...(was ? { lastAgent: was } : {}),
    ...(held ? { rss: held } : {}),
    ...(made.length ? { made } : {}),
    // Replaced rather than ored, which is the one line that stops the host's
    // byte-derived flag from lighting every row again behind this one's back.
    // See `unread`: the two are not two halves of an answer any more, they are
    // two different questions and only this one is asked here.
    unread: fresh,
  };
}

/**
 * The bindings above that another module assigns, by name — `attach()` the
 * subsystems, once, and the verbs the settings they change. See the module
 * comment for why this and not a context object. The ones that start out null
 * are spelled out, since `typeof` here would be narrowed to that null.
 */
interface Provided {
  host: typeof host;
  workspaces: typeof workspaces;
  harness: typeof harness;
  voice: typeof voice;
  outbox: typeof outbox;
  kuru: typeof kuru;
  channels: typeof channels;
  screens: typeof screens;
  sleeper: typeof sleeper;
  slots: typeof slots;
  store: typeof store;
  usageReader: UsageReader | null;
  usageLaunches: Launches | null;
  usageNodes: NodeUsage | null;
  backup: typeof backup;
  nodes: typeof nodes;
  watches: typeof watches;
  nodeNotices: typeof nodeNotices;
  mover: typeof mover;
  peerKurus: PeerKurus | null;
  secrets: typeof secrets;
  vault: typeof vault;
  lead: TelegramLead | null;
  hostInfo: typeof hostInfo;
  hostProtocol: typeof hostProtocol;
  logins: typeof logins;
  appearance: typeof appearance;
  mascots: typeof mascots;
  keys: typeof keys;
  notify: typeof notify;
  launch: typeof launch;
  projects: typeof projects;
}

const assigners: { [K in keyof Provided]: (value: Provided[K]) => void } = {
  host: (value) => {
    host = value;
  },
  workspaces: (value) => {
    workspaces = value;
  },
  harness: (value) => {
    harness = value;
  },
  voice: (value) => {
    voice = value;
  },
  outbox: (value) => {
    outbox = value;
  },
  kuru: (value) => {
    kuru = value;
  },
  channels: (value) => {
    channels = value;
  },
  screens: (value) => {
    screens = value;
  },
  sleeper: (value) => {
    sleeper = value;
  },
  slots: (value) => {
    slots = value;
  },
  store: (value) => {
    store = value;
  },
  usageReader: (value) => {
    usageReader = value;
  },
  usageLaunches: (value) => {
    usageLaunches = value;
  },
  usageNodes: (value) => {
    usageNodes = value;
  },
  backup: (value) => {
    backup = value;
  },
  nodes: (value) => {
    nodes = value;
  },
  watches: (value) => {
    watches = value;
  },
  nodeNotices: (value) => {
    nodeNotices = value;
  },
  mover: (value) => {
    mover = value;
  },
  peerKurus: (value) => {
    peerKurus = value;
  },
  secrets: (value) => {
    secrets = value;
  },
  vault: (value) => {
    vault = value;
  },
  lead: (value) => {
    lead = value;
  },
  hostInfo: (value) => {
    hostInfo = value;
  },
  hostProtocol: (value) => {
    hostProtocol = value;
  },
  logins: (value) => {
    logins = value;
  },
  appearance: (value) => {
    appearance = value;
  },
  mascots: (value) => {
    mascots = value;
  },
  keys: (value) => {
    keys = value;
  },
  notify: (value) => {
    notify = value;
  },
  launch: (value) => {
    launch = value;
  },
  projects: (value) => {
    projects = value;
  },
};

/** Assigns one of this module's bindings, and returns what it was given, as the assignment it replaces did. */
export function provide<K extends keyof Provided, V extends Provided[K]>(key: K, value: V): V {
  assigners[key](value);
  return value;
}
