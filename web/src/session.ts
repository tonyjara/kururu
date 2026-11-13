/**
 * The client half of kururu's wire protocol: one WebSocket, held open, that
 * both pushes state down and carries keystrokes up.
 *
 * A module-level store rather than context, because the window has one session
 * to show and there will never be a second. React subscribes to the *snapshot*
 * through useSyncExternalStore, so a status change re-renders the sidebar and
 * nothing else.
 *
 * Terminal output deliberately does not go through React at all. It arrives
 * sixty times a second, it is megabytes over an afternoon, and its destination
 * is an emulator that owns its own canvas — putting it in state would re-render
 * the tree for bytes React cannot draw. So output is delivered straight to
 * whoever registered a sink for that terminal, and the only thing React learns
 * is that a terminal exists.
 *
 * Reconnection is expected, not exceptional: the kururu server restarts when you
 * edit it, and a phone drops the socket every time it sleeps. So the socket
 * reopens on a backoff forever, and the UI renders `connected` rather than
 * erroring. Note what a reconnect does *not* cost — the agents are processes on
 * the other end, so they are still there when the socket comes back, and every
 * terminal somebody can see asks for its history again and catches up.
 */
import type { RunView } from "../../shared/automation";
import type { ProjectEdit } from "../../shared/subprojects";
import { useSyncExternalStore } from "react";
import type { Direction } from "../../shared/layout";
import type { Action } from "../../shared/keys";
import type { MascotConfig, PtyKind, SessionSnapshot } from "../../shared/model";
import type {
  AccountUsage,
  CodexUsage,
  ClientMessage,
  DevServer,
  EditorChoice,
  GitAction,
  Notification,
  ServerMessage,
  WorkspaceBranch,
  WorkspaceProject,
} from "../../shared/wire";
import type { BoardColumn, CardDates } from "../../shared/board";
import type { DbCatalog, DbResult, DbRows, WorkspaceDatabase } from "../../shared/databases";
import type { NvimCloseReport } from "../../shared/footprint";
import type { LaunchSettings } from "../../shared/launchers";
import type { MergeReply, MergeResolution, ProjectSettings, WorktreeOutcome, WorktreeStatus } from "../../shared/projects";
import type { NotifySettings } from "../../shared/notify";
import type { OpenRouterStatus } from "../../shared/openrouter";
import type { SlotsView } from "../../shared/slots";
import type { WebStatus } from "../../shared/web";
import type { ChannelKind, ChannelsStatus, TelegramStatus } from "../../shared/channels";
import type { BackupStatus } from "../../shared/backup";
import type { SearchHit, SearchScope } from "../../shared/store";
import type { KuruConversation, KuruPage, PeerKuru } from "../../shared/kuru";
import type { KuruAround, KuruSearchAnswer } from "../../shared/kurusearch";
import type { MadeFile } from "../../shared/made";
import type { OutboxEntry, SpeechChunk, VoiceChoice, VoiceLang, VoiceSettings, VoiceStatus } from "../../shared/voice";
import type { MachineEntry, MachinePin, MachineStatus } from "../../shared/machines";
import type { MachineSpecs, TypedKey } from "../../shared/specs";
import type { NodesView } from "../../shared/nodes";
import type { MoveCheck, MoveDone, MovePlan, NewWorkspaceMade } from "../../shared/move";
import { EMPTY_SECRETS, type Lendable, type LendAsk, type SecretsView } from "../../shared/secrets";
import type { VaultView } from "../../shared/vaultview";
import type { FieldOutcome, UseAnswer, UseRule, VaultAsk, VaultPage } from "../../shared/vaultitems";
import type { InterfaceAppearance, TerminalAppearance } from "../../shared/theme";
import type { BarSettings } from "../../shared/statusbar";
import type { ReloadAsk, ReloadHold, ReloadPage } from "../../shared/reload";
import { applyDelta } from "../../shared/snapdelta";
import type { Grid } from "./grid";
import { claimAccess } from "./access";

export interface KururuState {
  /** The websocket to the kururu server is open. */
  connected: boolean;
  snapshot: SessionSnapshot | null;
  /**
   * Dev servers kururu found on this machine, which the sidebar lists as links
   * — and which the preview pane, PLAN.md item 5, will want as well.
   */
  devServers: DevServer[];
  /**
   * The branch each workspace is on, for the workspaces that are in a repo.
   *
   * Beside `devServers` rather than in the snapshot, for the same reason that
   * one is: it is discovered by polling the machine rather than decided by
   * anything kururu owns, it changes on its own clock, and a client that
   * reconnects gets the whole list rather than having to catch up.
   */
  branches: WorkspaceBranch[];
  /** Where each workspace's file tree starts. Polled beside `branches`, from the same walk. */
  projects: WorkspaceProject[];
  /**
   * What this machine's Claude account has spent. Null until a reading has
   * landed, which is not the same as a reading that says signed out — the
   * bottom bar draws neither, and only one of them is an answer.
   */
  usage: AccountUsage | null;
  /** What the Codex account has spent, as Codex last wrote it down, or null while Codex is not signed in. */
  codexUsage: CodexUsage | null;
  /** Antigravity's quota, in Codex's shape. See `server/src/agy.ts`. */
  agyUsage: CodexUsage | null;
  /** Every machine the sidebar watches, with its last reading. See `shared/machines.ts`. */
  machines: MachineStatus[];
  /** Each machine's kept hardware reading, what was typed beside it and its history, by machine id. See `shared/specs.ts`. */
  specs: Record<string, MachineSpecs>;
  /**
   * This kururu among the others — its role, every other member with its
   * last summary, who leads — or null until the server has said. See
   * `shared/nodes.ts`.
   */
  nodes: NodesView | null;
  /**
   * The secrets lent between nodes: on the parent what it could lend and how
   * each grant stands, on a child what it holds and from whom. Hints only.
   * See `shared/secrets.ts`.
   */
  secrets: SecretsView;
  /** The OpenRouter account, or null when no key has been given. See `shared/openrouter.ts`. */
  openrouter: OpenRouterStatus | null;
  /** The slot queue and the Mac's load, or null until the server has said. See `shared/slots.ts`. */
  slots: SlotsView | null;
  /** The vault's open asks, drawn over everything by `VaultAsk.tsx`. Never a value. See `shared/vaultitems.ts`. */
  vaultAsks: VaultAsk[];
  /** The web for the agents — its providers in order — or null until the server has said. Never a key. See `shared/web.ts`. */
  web: WebStatus | null;
  /** Where the backups stand, or null until the server has said. See `shared/backup.ts`. */
  backup: BackupStatus | null;
  /**
   * Every database every workspace's env files name, for the button on the
   * row and the viewer behind it. Found by the walk that finds `branches`, and
   * sent the same way. See `shared/databases.ts`.
   */
  databases: WorkspaceDatabase[];
  /** The voice: its settings, its programs, its model, its voices. Null until the server has said. See `shared/voice.ts`. */
  voice: VoiceStatus | null;
  /**
   * The conversation with Kuru, every profile's: the newest items of each,
   * with the two counts the status bar's chip wears. The drawer draws it;
   * `fetchKuru` pages back through what is older. See `shared/kuru.ts`.
   */
  kuru: KuruConversation[];
  /** Every other node's Kuru, which the drawer draws beside this one's (`mergeNodes`). Empty on a node in no roster. */
  kuruPeers: PeerKuru[];
  /** Your messages to Kuru, every profile's, in the order the server took them: the pill's line under Kuru's words. The drawer reads them merged into `kuru`. */
  outbox: OutboxEntry[];
  /** The channels — Telegram — or null until the server has said. Never a token. See `shared/channels.ts`. */
  channels: ChannelsStatus | null;
  /**
   * The last thing the server said about a verb for another node's workspace
   * that could not go — "omarchy is away", "that stays where it is" — and
   * when, for the remote band to show for a moment. Null until one has.
   */
  remoteSaid: { node: string; text: string; at: number } | null;
}

const RETRY_MS = [200, 500, 1000, 2000, 4000];

let state: KururuState = {
  connected: false,
  snapshot: null,
  devServers: [],
  branches: [],
  projects: [],
  usage: null,
  codexUsage: null,
  agyUsage: null,
  machines: [],
  specs: {},
  nodes: null,
  secrets: EMPTY_SECRETS,
  openrouter: null,
  slots: null,
  vaultAsks: [],
  web: null,
  backup: null,
  databases: [],
  voice: null,
  kuru: [],
  kuruPeers: [],
  outbox: [],
  channels: null,
  remoteSaid: null,
};

const listeners = new Set<() => void>();
let socket: WebSocket | null = null;
let attempt = 0;
/** A `resync` has been asked for and the whole snapshot is not here yet. */
let resyncing = false;
let nextRequestId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

/**
 * Where output goes.
 *
 * A set per agent rather than one, although `terminals.ts` pools exactly one
 * emulator per terminal and the layout puts a terminal in exactly one tab. The
 * set costs nothing and it is what stops a subscription arriving a frame before
 * its predecessor has gone from silently replacing it — which is the kind of
 * thing that shows up as one pane that has quietly stopped updating.
 */
export interface OutputSink {
  /** Live bytes. Append. */
  write(data: string): void;
  /**
   * The history of this terminal, and the grid the server laid it out at. Clear
   * everything, become that shape, and start from this — in that order, because
   * a screen serialized for 229 columns written into a grid of any other width
   * wraps and stays wrapped.
   */
  reset(data: string, cols: number, rows: number): void;
  /**
   * The shape the server has decided this terminal is. Become it.
   *
   * The sink used to be *asked* its size instead, on the way to telling the
   * server what the pty should be — the pane fitted itself to its box and the
   * pty followed. That made the size whichever client resized last, and let a
   * client and the pty hold two ideas of the shape at once, which is the
   * disagreement underneath every screen kururu has drawn wrong. The traffic
   * goes the other way now: a pane proposes, the server decides, and the
   * emulator resizes here and nowhere else.
   */
  size(cols: number, rows: number): void;
  /**
   * The socket came back, so this sink has missed whatever arrived in the gap.
   *
   * It is told rather than rebuilt, because a rebuild is a screen at a size and
   * only a sink in a pane can say what shape it is being drawn at. One that is
   * on screen acts immediately; a pooled emulator that no pane is holding
   * measures nothing, and waits until one borrows it. Which of those it is, is
   * the sink's own question to answer — it is holding the element.
   */
  stale(): void;
}
const sinks = new Map<string, Set<OutputSink>>();

/**
 * Who to hand a notification to, or null when nothing is listening yet.
 *
 * One rather than a set, because there is one window and it has one answer —
 * and deliberately *not* wired straight to `web/src/notify.ts` from here. That
 * would be a cycle: the click handler on a card sends `reveal-agent`, which is
 * this module. A registration turns the cycle into a line, and it puts the
 * wiring in `App.tsx` beside every other window-level behaviour rather than
 * hiding it in an import that exists for its side effect.
 *
 * A notification that arrives before anybody has registered is dropped, which
 * is the correct handling of an event: there is nothing to catch up on, and a
 * card queued from before the app mounted would be news about a status two
 * seconds stale.
 */
let notifyListener: ((card: Notification) => void) | null = null;

export function onNotify(listener: (card: Notification) => void): () => void {
  notifyListener = listener;
  return () => {
    if (notifyListener === listener) notifyListener = null;
  };
}

function set(patch: Partial<KururuState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function send(msg: ClientMessage): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

/**
 * Hand something to one pane's emulator without letting it take the socket down.
 *
 * The same argument `ptyhost.ts` makes about its port, one process further out.
 * A sink is an emulator in a pane, and an emulator can be gone — a pane closed
 * between a message being sent and being dispatched is ordinary, and Ghostty's
 * terminal answers every call after `dispose()` by throwing rather than by doing
 * nothing, which is what xterm did. Uncaught, that throw leaves the rest of the
 * loop undelivered: the other panes watching the same agent miss the bytes, and
 * those bytes do not come again, because an agent redraws differentially and
 * will never resend what it believes is already on screen.
 *
 * Logged rather than swallowed. A pane that silently stops updating is the kind
 * of bug that gets debugged by staring at a terminal wondering why it is stale,
 * and the whole point of catching here is that the failure stays the size of one
 * pane instead of becoming the size of the window.
 */
function deliver(to: () => void): void {
  try {
    to();
  } catch (err) {
    console.error("kururu: a terminal refused output and was skipped", err);
  }
}

function connect(): void {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  // `delta=1`: the snapshot once, then only what changed — see `shared/snapdelta.ts`.
  const ws = new WebSocket(`${proto}//${location.host}/ws?delta=1`);
  socket = ws;
  resyncing = false;

  ws.onopen = () => {
    attempt = 0;
    set({ connected: true });
    /**
     * The server keeps no memory of a socket that went away, so every pane that
     * is open has to say so again — what it has visible, and then, emulator by
     * emulator, what shape it is and what it is missing.
     *
     * Separately, because those are different questions and `watch` can only
     * answer the first: it is a set of ids and a set of ids cannot say how wide
     * anything is. Every sink is simply told the socket is back, and each
     * decides what that means for it — a pane's emulator proposes its size and
     * asks for the screen it missed; a pooled one that is off screen notes it
     * and waits to be borrowed, because a terminal nobody can see must not
     * reach through a reconnect and reshape itself.
     */
    if (!atScreen) send({ type: "looking", looking: false });
    if (amTalking) send({ type: "talking", talking: true });
    sayReloadable();
    if (connectListener) deliver(() => connectListener?.());
    if (watched.size > 0 || warmed.size > 0) sendWatch();
    for (const open of sinks.values()) {
      for (const sink of open) deliver(() => sink.stale());
    }
  };

  ws.onmessage = (event) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(event.data as string) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "snapshot":
        resyncing = false;
        set({ snapshot: msg.snapshot });
        sayUnsaid();
        break;
      case "delta": {
        // Until the whole snapshot asked for arrives, every delta is from a
        // state this page does not hold.
        if (resyncing) break;
        const before = state.snapshot;
        let after: SessionSnapshot | null = null;
        try {
          if (before) after = applyDelta(before, msg.delta);
        } catch (err) {
          console.error("kururu: a snapshot delta did not fit; asking for the whole", err);
        }
        if (after) set({ snapshot: after });
        else {
          resyncing = true;
          send({ type: "resync" });
        }
        break;
      }
      case "dev-servers":
        set({ devServers: msg.servers });
        break;
      case "branches":
        set({ branches: msg.branches });
        break;
      case "projects":
        set({ projects: msg.projects });
        break;
      case "usage":
        set({ usage: msg.usage });
        break;
      case "codex-usage":
        set({ codexUsage: msg.codex });
        break;
      case "agy-usage":
        set({ agyUsage: msg.agy });
        break;
      case "machines":
        set({ machines: msg.machines });
        break;
      case "specs":
        set({ specs: msg.specs });
        break;
      case "nodes":
        set({ nodes: msg.nodes });
        break;
      case "secrets":
        set({ secrets: msg.secrets });
        break;
      case "openrouter":
        set({ openrouter: msg.openrouter });
        break;
      case "slots":
        set({ slots: msg.slots });
        break;
      case "vault-asks":
        set({ vaultAsks: Array.isArray(msg.asks) ? msg.asks : [] });
        break;
      case "web":
        set({ web: msg.web });
        break;
      case "backup":
        set({ backup: msg.backup });
        break;
      case "voice":
        set({ voice: msg.voice });
        break;
      case "speech":
        // An event, like `notify`, and wrapped the same way: the player must
        // not take the socket's dispatch down with it.
        if (speechListener) deliver(() => speechListener?.(msg.speech));
        break;
      case "hush":
        if (hushListener) deliver(() => hushListener?.(msg.hushed === true));
        break;
      case "reload":
        if (reloadListener) deliver(() => reloadListener?.({ type: "ask", ask: msg.ask, until: msg.until }));
        break;
      case "reload-cancel":
        if (reloadListener) deliver(() => reloadListener?.({ type: "cancel", id: msg.id }));
        break;
      case "kuru":
        set({ kuru: Array.isArray(msg.kuru) ? msg.kuru : [], kuruPeers: Array.isArray(msg.peers) ? msg.peers : [] });
        break;
      case "outbox":
        set({ outbox: Array.isArray(msg.outbox) ? msg.outbox : [] });
        if (outboxListener) deliver(() => outboxListener?.(state.outbox));
        break;
      case "channels":
        set({ channels: msg.channels });
        break;
      case "databases":
        set({ databases: msg.databases });
        break;
      case "output":
        for (const sink of sinks.get(msg.agentId) ?? []) deliver(() => sink.write(msg.data));
        break;
      case "grid":
        for (const sink of sinks.get(msg.agentId) ?? [])
          deliver(() => sink.size(msg.cols, msg.rows));
        break;
      case "backlog": {
        /**
         * Every emulator of that terminal, which is one of them.
         *
         * It used to be *the one that asked*, matched by an epoch the request
         * carried, and the epoch existed because two panes on one terminal were
         * two shapes: an emulator rebuilt while its predecessor's answer was
         * still in flight must not be reset by a screen laid out for a box that
         * no longer exists. There is one shape now — the server's — and an
         * answer that states the grid it used is correct for whoever receives
         * it, so there is nothing left to match.
         */
        for (const sink of sinks.get(msg.agentId) ?? []) {
          deliver(() => sink.reset(msg.data, msg.cols, msg.rows));
        }
        break;
      }
      case "stale":
        // Another node's terminals whose watch came back, or stopped: what
        // `onopen` says to every sink, said to these.
        for (const id of msg.agentIds) for (const sink of sinks.get(id) ?? []) deliver(() => sink.stale());
        break;
      case "remote-said":
        set({ remoteSaid: { node: msg.node, text: msg.text, at: Date.now() } });
        break;
      case "notify":
        // Everything has already been decided; see `shared/notify.ts`. Wrapped
        // the way output is, for the reason output is: a listener that throws
        // must not take the rest of the socket's dispatch down with it.
        if (notifyListener) deliver(() => notifyListener?.(msg.notification));
        break;
      case "reply": {
        const waiting = pending.get(msg.id);
        if (!waiting) break;
        pending.delete(msg.id);
        if (msg.ok) waiting.resolve(msg.result);
        else waiting.reject(new Error(msg.error));
        break;
      }
    }
  };

  const reopen = () => {
    if (socket !== ws) return; // already replaced
    socket = null;
    set({ connected: false });
    for (const [, waiting] of pending) waiting.reject(new Error("disconnected"));
    pending.clear();
    // The server that said somebody was talking is gone, and the next one
    // says again on connect. A hush nobody is left to lift would keep Kuru
    // quiet on this page for good.
    if (hushListener) deliver(() => hushListener?.(false));
    // The asks belong to the server that made them, and nobody is waiting on
    // them any more: the command that asked asks the next server again.
    if (reloadListener) deliver(() => reloadListener?.({ type: "lost" }));
    const delay = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]!;
    attempt++;
    setTimeout(connect, delay);
  };
  ws.onclose = reopen;
  ws.onerror = () => ws.close();
}

/**
 * A token in the address is exchanged for a cookie before the socket is opened,
 * because the handshake is one of the things that cookie authorises — see
 * `access.ts`. It costs a microtask when there is no token, which is every load
 * except the first on a phone that has just scanned the code.
 */
void claimAccess().then(connect);

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Send something that can fail and wait for the server's answer. Anything that
 * changes which agents exist goes through here, so a refusal reaches the caller
 * instead of being inferred from the next snapshot.
 */
function request(msg: (id: number) => ClientMessage): Promise<unknown> {
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    if (socket?.readyState !== WebSocket.OPEN) return reject(new Error("not connected"));
    pending.set(id, { resolve, reject });
    send(msg(id));
  });
}

let watched = new Set<string>();
let warmed = new Set<string>();

function same(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

/**
 * The two sets, on one message, because the server needs both to answer two
 * different questions with them: what to stream is their union, and what counts
 * as unread is only ever the first.
 */
function sendWatch(): void {
  send({ type: "watch", agentIds: [...watched], warm: [...warmed] });
}

/**
 * Say which terminals are on screen, so the server knows whose bytes somebody is
 * actually looking at. Derived from the layout the server sent back, and sent
 * whole.
 *
 * It no longer brings history with it. A set of ids cannot say how wide anything
 * is, and history is a screen laid out at a width — so the two were separated
 * and the asking moved to the only thing that knows the answer, which is the
 * emulator that is about to draw it.
 */
export function watch(agentIds: Iterable<string>): void {
  const next = new Set(agentIds);
  if (same(next, watched)) return;
  watched = next;
  sendWatch();
}

/**
 * Say which terminals this client is keeping an emulator for without showing
 * them. `terminals.ts` owns the answer; see its module comment for why there is
 * one at all.
 *
 * A pooled emulator has to be fed or it goes stale, and a stale one has to be
 * reconstructed, which is the entire thing the pool exists to stop happening
 * during ordinary navigation. So the server streams the union of this and
 * `watch`. It is deliberately not folded into `watch`: the unread mark means
 * "output arrived where nobody was looking", and an emulator kept warm in a
 * workspace you are not in is nobody looking.
 */
export function warm(agentIds: Iterable<string>): void {
  const next = new Set(agentIds);
  if (same(next, warmed)) return;
  warmed = next;
  sendWatch();
}

/**
 * Say whether anybody is in front of this screen.
 *
 * The size policy is a minimum over the clients that can see a terminal, and a
 * socket is a poor witness to that: a phone that locks keeps its panes, keeps
 * its connection — the server deliberately never hangs up on a sleeping one —
 * and goes on voting for a grid nobody is reading. The desktop was then held at
 * phone width by a phone in another room, and walking back to the window did
 * not fix it, because nothing in the window had moved and a pane proposes when
 * its box changes.
 *
 * It says nothing about *which* terminals are on screen; `watch` is still the
 * only thing that answers that, and still the only thing the unread mark and
 * the notification gate consult. `terminals.ts` owns the one listener, because
 * the vote this gates is the pool's.
 *
 * Deduped, and re-sent on a reconnect from `onopen`: the server keeps no memory
 * of a socket that went away, and a phone that reconnects while still in a
 * pocket must not come back with a vote.
 */
let atScreen = true;

export function looking(present: boolean): void {
  if (present === atScreen) return;
  atScreen = present;
  send({ type: "looking", looking: present });
}

/**
 * Say what shape this pane could draw the terminal at, then ask for its history
 * — in that order, and from one function so it cannot be in any other.
 *
 * A history is a screen laid out at a width, and the width is the server's to
 * choose. Which makes the ordering the whole of it: a pane that asked before
 * saying how big it is would be answered at whatever shape the last client
 * happened to leave behind, and a pane that said afterwards would already have
 * the wrong screen. The two are separate messages because they are separate
 * questions — one is an opinion the server weighs against every other client's,
 * the other is a request only this emulator can have a reason to make — and
 * they travel on one socket, so the server reads them in the order they were
 * written.
 */
function askBacklog(agentId: string, grid: Grid): void {
  proposeSize(agentId, grid.cols, grid.rows);
  send({ type: "request-backlog", agentId });
}

/**
 * Ask for this terminal's history again, for a sink that is already subscribed.
 *
 * The one caller is a pooled emulator that was told it was `stale` and has a
 * pane to measure, which is the only way a subscription that already exists can
 * need a screen it does not have.
 */
export function rebuild(agentId: string, grid: Grid): void {
  askBacklog(agentId, grid);
}

/**
 * Register a terminal's emulator to receive that agent's bytes, and ask for the
 * history it has missed.
 *
 * The request is not redundant with `watch`. Watching is about which terminals
 * are on screen, and a fresh emulator is a different event: a terminal can be on
 * screen the whole time and still be drawn by an emulator that has just been
 * built and has nothing in it. Asking here means every mount is correct without
 * anything having to reason about why it happened.
 */
export function subscribeOutput(agentId: string, sink: OutputSink, grid: Grid): () => void {
  let set = sinks.get(agentId);
  if (!set) sinks.set(agentId, (set = new Set()));
  set.add(sink);
  askBacklog(agentId, grid);
  return () => {
    set.delete(sink);
    if (set.size === 0) sinks.delete(agentId);
  };
}

/** What the user typed. Straight through, no interpretation, no reply. */
export function input(agentId: string, data: string): void {
  send({ type: "input", agentId, data });
}

/**
 * This pane could draw that terminal at this many columns by this many rows.
 *
 * An opinion, and nothing happens to the emulator here. The server holds one
 * proposal per client, takes the smallest over the clients that have the
 * terminal visible, resizes the pty, and sends back the grid everybody is to
 * draw at — which arrives as `size` on the sink. A window that is the only one
 * looking gets exactly what it asked for; a phone and a desktop on one agent
 * get an answer they can both draw, rather than taking turns making each other
 * ragged.
 */
export function proposeSize(agentId: string, cols: number, rows: number): void {
  send({ type: "propose-size", agentId, cols, rows });
}

/**
 * Everything below changes the arrangement, which the server owns.
 *
 * They are verbs rather than state, and they are fire-and-forget: the snapshot
 * that follows is the answer and it is complete. Only `newTab` waits, because
 * spawning is the one thing here that can fail in a way the next snapshot would
 * not explain.
 */
export function newTab(
  options: {
    kind?: PtyKind;
    cwd?: string;
    command?: string;
    launcher?: string;
    nvim?: boolean;
    lazygit?: boolean;
    local?: boolean;
    paneId?: string;
    workspaceId?: string;
  } = {},
): Promise<string> {
  return request((id) => ({ type: "new-tab", id, ...options })).then(
    (result) => (result as { id: string }).id,
  );
}

/** End a terminal and take its tab with it. Defaults to the focused one. */
export function closeTab(agentId?: string): void {
  send({ type: "close-tab", agentId });
}

export function selectTab(paneId: string, index: number): void {
  send({ type: "select-tab", paneId, index });
}

export function cycleTab(delta: number, paneId?: string): void {
  send({ type: "cycle-tab", delta, paneId });
}

/** Put a terminal in a pane, at a place in its strip. Every drag ends here. */
export function moveTab(agentId: string, paneId: string, index?: number): void {
  send({ type: "move-tab", agentId, paneId, index });
}

/** Dropped on a pane's edge: divide it and put the terminal in the new half. */
export function splitWith(
  agentId: string,
  paneId: string,
  dir: "row" | "col",
  before: boolean,
): void {
  send({ type: "split-with", agentId, paneId, dir, before });
}

/** Dropped on a workspace row: send it there, into whatever pane has focus. */
export function moveTabToWorkspace(agentId: string, workspaceId: string): void {
  send({ type: "move-tab-to-workspace", agentId, workspaceId });
}

/**
 * Dropped on another row of the sidebar's agent list: put it above that one, or
 * at the end when there is nothing below it. Rearranges the list and moves
 * nothing — the two above are what move a terminal.
 */
export function reorderAgent(agentId: string, beforeAgentId: string | null): void {
  send({ type: "reorder-agent", agentId, beforeAgentId });
}

/**
 * Put a terminal away in the sidebar's list, or bring it back. The state rather
 * than a toggle — see `hide-agent` in `shared/wire.ts`.
 */
export function hideAgent(agentId: string, hidden: boolean): void {
  send({ type: "hide-agent", agentId, hidden });
}

export function renameTab(agentId: string, name: string): void {
  send({ type: "rename-tab", agentId, name });
}

export function splitPane(dir: "row" | "col", paneId?: string): void {
  send({ type: "split", dir, paneId });
}

export function closePane(paneId?: string): void {
  send({ type: "close-pane", paneId });
}

export function focusPane(paneId: string): void {
  send({ type: "focus-pane", paneId });
}

export function focusDirection(dir: Direction): void {
  send({ type: "focus-dir", dir });
}

export function stepPane(delta: number): void {
  send({ type: "step-pane", delta });
}

/** The other pane — where focus came from, or the next one along. See the wire. */
export function lastPane(): void {
  send({ type: "last-pane" });
}

export function setRatio(splitId: string, ratio: number): void {
  send({ type: "set-ratio", splitId, ratio });
}

export function nudge(dir: Direction, delta: number): void {
  send({ type: "nudge", dir, delta });
}

/** A pane dropped on another pane's middle: the two change places. */
export function swapPanes(paneId: string, withPaneId: string): void {
  send({ type: "swap-panes", paneId, withPaneId });
}

/** A pane dropped on another pane's edge: it moves to that side of it. */
export function movePane(
  paneId: string,
  toPaneId: string,
  dir: "row" | "col",
  before: boolean,
): void {
  send({ type: "move-pane", paneId, toPaneId, dir, before });
}

/** A pane dropped on another pane's tab strip: its tabs go in there. */
export function mergePanes(paneId: string, intoPaneId: string): void {
  send({ type: "merge-panes", paneId, intoPaneId });
}

export function newWorkspace(name?: string): void {
  send({ type: "new-workspace", name });
}

export function switchWorkspace(workspaceId: string): void {
  send({ type: "switch-workspace", workspaceId });
}

/**
 * A node's name, or this one's for null, as the store has it now. Read at
 * the moment rather than subscribed to, for the drag's refusals: a pane
 * that subscribed to the store for a name it needs only mid-drag would
 * render again on every message the store takes.
 */
export function nodeName(node: string | null): string {
  if (node === null) return state.nodes?.self.name || "this computer";
  return state.nodes?.nodes.find((n) => n.id === node)?.name ?? "the other computer";
}

/** A node's name as the store has it now, or null for one it does not know — for a card reference's place. */
export function nodeNameOf(node: string): string | null {
  return state.nodes?.nodes.find((n) => n.id === node)?.name ?? null;
}

/**
 * A refusal this page makes itself about a node, drawn in the band where
 * the server's `remote-said` is: a file from the Finder held over one of
 * its terminals. `say` is handed the node's name. Said again at most once a
 * second, since a drag repeats its `dragover` many times a second.
 */
export function sayAboutNode(node: string, say: (name: string) => string): void {
  const text = say(nodeName(node));
  const said = state.remoteSaid;
  if (said && said.node === node && said.text === text && Date.now() - said.at < 1_000) return;
  set({ remoteSaid: { node, text, at: Date.now() } });
}

/** Put another node's workspace on this screen, by the key its summary gives. See `server/src/nodewatch.ts`. */
export function showNodeWorkspace(nodeId: string, workspaceKey: string): void {
  send({ type: "show-node-workspace", nodeId, workspaceKey });
}

/** A new workspace on another node: its word on the folder, its guess when null. */
export function nodeNewCheck(nodeId: string, name: string, folder: string | null): Promise<MoveCheck> {
  return request((id) => ({ type: "node-new-check", id, nodeId, name, folder })) as Promise<MoveCheck>;
}

/** Make it there. Rejects with the node's sentence, and then nothing was made. */
export function nodeNewWorkspace(nodeId: string, name: string, folder: string): Promise<NewWorkspaceMade> {
  return request((id) => ({ type: "node-new-workspace", id, nodeId, name, folder })) as Promise<NewWorkspaceMade>;
}

/** A node's card to Done, when it is still a plain move there. Rejects with the node's sentence why not. */
export function nodeCardDone(nodeId: string, workspaceKey: string, cardId: string): Promise<unknown> {
  return request((id) => ({ type: "node-card-done", id, nodeId, workspaceKey, cardId }));
}

export function workspaceByIndex(index: number): void {
  send({ type: "workspace-index", index });
}

export function stepWorkspace(delta: number): void {
  send({ type: "step-workspace", delta });
}

export function lastWorkspace(): void {
  send({ type: "last-workspace" });
}

/**
 * The profile's Dashboard on screen, with one of its fixed tabs in front
 * (`shared/dashboard.ts`). Leaving it is any workspace switch.
 */
export function openDashboard(tab?: string): void {
  send({ type: "open-dashboard", ...(tab ? { tab } : {}) });
}

export function renameWorkspace(workspaceId: string, name: string): void {
  send({ type: "rename-workspace", workspaceId, name });
}

export function deleteWorkspace(workspaceId: string): void {
  send({ type: "delete-workspace", workspaceId });
}

export function moveWorkspace(workspaceId: string, index: number): void {
  send({ type: "move-workspace", workspaceId, index });
}

/** File it under a group, made by naming it, or take it out with null. See `Workspace.group`. */
export function setWorkspaceGroup(workspaceId: string, group: string | null): void {
  send({ type: "set-workspace-group", workspaceId, group });
}

/** A whole group dragged onto a row, taking its place. `onto` is a workspace id. */
export function moveWorkspaceGroup(group: string, onto: string): void {
  send({ type: "move-workspace-group", group, onto });
}

/** Rename a group on every member; null disbands it. */
export function renameWorkspaceGroup(from: string, to: string | null): void {
  send({ type: "rename-workspace-group", from, to });
}

export function newProfile(name: string): void {
  send({ type: "new-profile", name });
}

export function switchProfile(profileId: string): void {
  send({ type: "switch-profile", profileId });
}

export function renameProfile(profileId: string, name: string): void {
  send({ type: "rename-profile", profileId, name });
}

export function deleteProfile(profileId: string): void {
  send({ type: "delete-profile", profileId });
}

/** A key out of the snapshot's `logins`, or null for a fresh directory of the profile's own. */
export function setProfileLogin(profileId: string, loginKey: string | null): void {
  send({ type: "set-profile-login", profileId, loginKey });
}

/**
 * Put the server back on current source. The agents are not in it — they are in
 * the pty host beside it — so this costs a reconnect, which this module does
 * anyway and forever.
 */
export function restartServer(): void {
  send({ type: "restart-server" });
}

/**
 * Put a reader beside this pane, following the editor in it.
 *
 * A verb, like everything else: the client does not decide where the pane goes
 * or what it shows. It says *read what this terminal is reading* and draws the
 * snapshot that comes back — which is what lets the same press from a phone put
 * the same reader in front of the same file.
 */
export function openReader(paneId?: string, agentId?: string, focus?: boolean): void {
  send({ type: "open-reader", paneId, agentId, focus });
}

/**
 * Show this workspace's board — the first time, make it. See `shared/board.ts`.
 * The server focuses it, since a board is a thing you type into.
 */
export function openBoard(paneId?: string, here?: boolean, workspaceId?: string): void {
  send({ type: "open-board", paneId, here, workspaceId });
}

export function addCard(workspaceId: string, title: string, body: string, column?: BoardColumn, isolate?: boolean): void {
  send({ type: "add-card", workspaceId, title, body, column, isolate });
}

export function addRunCard(
  workspaceId: string,
  title: string,
  body: string,
  column: BoardColumn | undefined,
  isolate: boolean,
  launcher: string,
): Promise<string> {
  return request((id) => ({ type: "add-run-card", id, workspaceId, title, body, column, isolate, launcher })).then(
    (result) => (result as { agentId: string }).agentId,
  );
}

export function editCard(
  workspaceId: string,
  cardId: string,
  fields: { title?: string; body?: string; isolate?: boolean; dates?: CardDates | null },
): void {
  send({ type: "edit-card", workspaceId, cardId, ...fields });
}

/** `index` is a place among the destination column's cards, the moved one left out. */
export function moveCard(workspaceId: string, cardId: string, column: BoardColumn, index?: number): void {
  send({ type: "move-card", workspaceId, cardId, column, index });
}

/** The card only. Its agent, if it has one, runs on — see `delete-card`. */
export function deleteCard(workspaceId: string, cardId: string): void {
  send({ type: "delete-card", workspaceId, cardId });
}

/** `width` in pixels, clamped on arrival; `null` takes the column back to the default. */
export function resizeColumn(workspaceId: string, column: BoardColumn, width: number | null): void {
  send({ type: "resize-column", workspaceId, column, width });
}

// The profile's board: the same verbs, by profile — see `send-profile-card`.

export function addProfileCard(profileId: string, title: string, body: string, column?: string, dates?: CardDates | null): void {
  send({ type: "add-profile-card", profileId, title, body, column, dates });
}

/** `dates` absent leaves the card's alone; null takes them off. */
export function editProfileCard(
  profileId: string,
  cardId: string,
  fields: { title?: string; body?: string; dates?: CardDates | null },
): void {
  send({ type: "edit-profile-card", profileId, cardId, ...fields });
}

export function moveProfileCard(profileId: string, cardId: string, column: string, index?: number): void {
  send({ type: "move-profile-card", profileId, cardId, column, index });
}

export function deleteProfileCard(profileId: string, cardId: string): void {
  send({ type: "delete-profile-card", profileId, cardId });
}

export function addProfileColumn(profileId: string, name: string): void {
  send({ type: "add-profile-column", profileId, name });
}

export function renameProfileColumn(profileId: string, columnId: string, name: string): void {
  send({ type: "rename-profile-column", profileId, columnId, name });
}

/** One of WORKSPACE_COLORS, or null for none. */
export function colorProfileColumn(profileId: string, columnId: string, color: string | null): void {
  send({ type: "set-profile-column-color", profileId, columnId, color });
}

export function collapseProfileColumn(profileId: string, columnId: string, collapsed: boolean): void {
  send({ type: "set-profile-column-collapsed", profileId, columnId, collapsed });
}

export function moveProfileColumn(profileId: string, columnId: string, index: number): void {
  send({ type: "move-profile-column", profileId, columnId, index });
}

/** Its cards go to the column beside it — see `removeLane`. */
export function deleteProfileColumn(profileId: string, columnId: string): void {
  send({ type: "delete-profile-column", profileId, columnId });
}

/** The same drag, on this board's own columns — see `resizeColumn`. */
export function resizeProfileColumn(profileId: string, columnId: string, width: number | null): void {
  send({ type: "resize-profile-column", profileId, columnId, width });
}

/** Off the profile's board and onto a workspace's, which is made if it has none. */
export function sendProfileCard(profileId: string, cardId: string, workspaceId: string): void {
  send({ type: "send-profile-card", profileId, cardId, workspaceId });
}

/**
 * Hand a card to an agent on this launcher. Waits, for `newTab`'s reason: a
 * spawn that fails is not explained by the next snapshot.
 */
export function runCard(workspaceId: string, cardId: string, launcher: string, fresh = false): Promise<string> {
  return request((id) => ({ type: "run-card", id, workspaceId, cardId, launcher, ...(fresh ? { fresh } : {}) })).then(
    (result) => (result as { agentId: string }).agentId,
  );
}
export function resumeCard(workspaceId: string, cardId: string): Promise<string> {
  return request((id) => ({ type: "resume-card", id, workspaceId, cardId })).then(
    (result) => (result as { agentId: string }).agentId,
  );
}

/**
 * The git on a card's worktree, from its menu. All of them wait, because each
 * is a subprocess on the server that can say no in a way the next snapshot
 * would not explain — and the status is nothing *but* the answer.
 */
export function worktreeStatus(workspaceId: string, cardId: string): Promise<WorktreeStatus> {
  return request((id) => ({ type: "worktree-status", id, workspaceId, cardId })) as Promise<WorktreeStatus>;
}
export function commitCard(workspaceId: string, cardId: string): Promise<{ files: number }> {
  return request((id) => ({ type: "commit-card", id, workspaceId, cardId })) as Promise<{ files: number }>;
}
export function stashCard(workspaceId: string, cardId: string): Promise<{ files: number }> {
  return request((id) => ({ type: "stash-card", id, workspaceId, cardId })) as Promise<{ files: number }>;
}
export function mergeCard(workspaceId: string, cardId: string, resolve?: MergeResolution): Promise<MergeReply> {
  return request((id) => ({ type: "merge-card", id, workspaceId, cardId, ...(resolve ? { resolve } : {}) })) as Promise<MergeReply>;
}
/**
 * A verb on a workspace's git, from its row's menu, on its main checkout.
 * Waits, for the card verbs' reason, and resolves to the line to show — what
 * was committed, pushed or merged — or rejects with git's reason for not.
 */
export function workspaceGit(workspaceId: string, root: string, action: GitAction, message?: string): Promise<string> {
  return request((id) => ({ type: "workspace-git", id, workspaceId, root, action, message })).then(
    (result) => (result as { said: string }).said,
  );
}
export function openWorktree(workspaceId: string, cardId: string): Promise<string> {
  return request((id) => ({ type: "open-worktree", id, workspaceId, cardId })).then(
    (result) => (result as { agentId: string }).agentId,
  );
}

/** The card's dev server: started afresh in the pane it was in, or started for the first time. */
export function restartCardDev(workspaceId: string, cardId: string): Promise<unknown> {
  return request((id) => ({ type: "restart-card-dev", id, workspaceId, cardId }));
}
/** The card's dev server ended and its tab closed. */
export function stopCardDev(workspaceId: string, cardId: string): Promise<unknown> {
  return request((id) => ({ type: "stop-card-dev", id, workspaceId, cardId }));
}

/**
 * Stop a dev server from the sidebar's list, by the port and pid its row was
 * drawn from. Resolves once it has gone; rejects with why it was not stopped.
 */
export function stopDevServer(port: number, pid: number): Promise<unknown> {
  return request((id) => ({ type: "stop-dev-server", id, port, pid }));
}

// --- automations --------------------------------------------------------------
// The things kururu does on a schedule (`server/src/automations.ts`). Each is a
// request: a definition the parser refuses, or a run that is already going,
// comes back as the error the sheet shows.

export function saveAutomation(key: string | null, workspaceId: string, text: string): Promise<{ key: string }> {
  return request((id) => ({ type: "automation-save", id, key, workspaceId, text })) as Promise<{ key: string }>;
}

export function pauseAutomation(key: string, on: boolean): Promise<unknown> {
  return request((id) => ({ type: "automation-pause", id, key, on }));
}

export function pauseAllAutomations(): Promise<unknown> {
  return request((id) => ({ type: "automation-pause-all", id }));
}

export function runAutomation(key: string): Promise<{ runId: number; agentId: string | null }> {
  return request((id) => ({ type: "automation-run", id, key })) as Promise<{ runId: number; agentId: string | null }>;
}

export function deleteAutomation(key: string): Promise<unknown> {
  return request((id) => ({ type: "automation-delete", id, key }));
}

export function automationRuns(key: string): Promise<(RunView & { kept: string | null })[]> {
  return request((id) => ({ type: "automation-runs", id, key })) as Promise<(RunView & { kept: string | null })[]>;
}

export function openAutomationRun(key: string, runId: number): Promise<unknown> {
  return request((id) => ({ type: "automation-open", id, key, runId }));
}

/** Stop following the editor, or start again. */
export function pinReader(paneId: string, follow: boolean): void {
  send({ type: "pin-reader", paneId, follow });
}

/** Show one of a reader's tabs. */
export function selectDoc(paneId: string, index: number): void {
  send({ type: "select-doc", paneId, index });
}

/** Close one of a reader's tabs; the last one takes the pane with it. */
export function closeDoc(paneId: string, index: number): void {
  send({ type: "close-doc", paneId, index });
}

/** A reader's tab, dropped on a reader's strip — its own, to reorder. */
export function moveDoc(fromPaneId: string, index: number, toPaneId: string, at?: number): void {
  send({ type: "move-doc", fromPaneId, index, toPaneId, at });
}

/** A reader's tab, dropped on a pane's edge: a reader of its own, on that side. */
export function splitWithDoc(fromPaneId: string, index: number, paneId: string, dir: "row" | "col", before: boolean): void {
  send({ type: "split-with-doc", fromPaneId, index, paneId, dir, before });
}

/**
 * Read this file in this pane. The other half of `pinReader`: it says which
 * document, and the server stops following an editor because of it.
 */
export function openDoc(paneId: string, root: string, path: string, at?: number): void {
  send({ type: "open-doc", paneId, root, path, ...(at !== undefined ? { at, focus: true } : {}) });
}

/** A file from the tree, dropped on a pane's edge: a pane of its own, on that side. */
export function splitWithFile(root: string, path: string, paneId: string, dir: "row" | "col", before: boolean): void {
  send({ type: "split-with-file", root, path, paneId, dir, before });
}

/**
 * Read a markdown file in the upper half — see `show-doc` — and `focus` is
 * for the window that can only see one pane. `from` is the reader a link was
 * clicked in, which keeps the document when it is in the upper half.
 */
export function showDoc(root: string, path: string, focus?: boolean, from?: string): void {
  send({ type: "show-doc", root, path, focus, ...(from ? { paneId: from } : {}) });
}

/** Every nvim in the workspace on screen, nearest first. May be empty. */
export function findEditors(): Promise<EditorChoice[]> {
  return request((id) => ({ type: "find-editors", id })) as Promise<EditorChoice[]>;
}

/**
 * Open a file in nvim: the one in that terminal, or a new one in a tab of the
 * focused pane when `agentId` is null. Waits, because "nvim did not answer" is a real outcome and
 * the next snapshot would not explain it.
 */
export function openInEditor(
  root: string,
  path: string,
  agentId: string | null,
  at: { paneId?: string; line?: number | null } = {},
): Promise<string> {
  return request((id) => ({ type: "open-in-editor", id, root, path, agentId, ...at })).then(
    (result) => (result as { agentId: string }).agentId,
  );
}

/**
 * Open what an agent made: Markdown in the reader, anything else in a new
 * nvim tab, in `workspaceId` (switched to first) or wherever the server finds
 * the file belongs. Waits, because "that file is not there any more" is a
 * real answer and the link that was clicked is where it should be said.
 */
export function openMade(file: MadeFile, workspaceId: string | null, focus: boolean): Promise<void> {
  return request((id) => ({ type: "open-made", id, root: file.root, path: file.path, line: file.line, workspaceId, focus })).then(() => undefined);
}

/**
 * Ask these nvims to `:qa` — any on the machine, by `FootprintNvim.id`. Waits,
 * because the answer is which of them refused and why.
 */
export function closeNvims(ids: string[]): Promise<NvimCloseReport> {
  return request((id) => ({ type: "close-nvims", id, ids })) as Promise<NvimCloseReport>;
}

/** End nvims that refused `closeNvims` — the second yes. SIGTERM, then SIGKILL. */
export function killNvims(ids: string[]): Promise<NvimCloseReport> {
  return request((id) => ({ type: "kill-nvims", id, ids })) as Promise<NvimCloseReport>;
}

/**
 * The mascots, and the keyboard. Fire-and-forget like every other verb: the
 * snapshot that comes back is the answer, so Settings never holds a config of
 * its own and a second window sees the change without being told.
 */
export function setMascot(id: string, mascot: MascotConfig): void {
  send({ type: "set-mascot", id, mascot });
}

export function addMascot(from?: string): void {
  send({ type: "add-mascot", from });
}

export function removeMascot(id: string): void {
  send({ type: "remove-mascot", id });
}

export function renameMascot(id: string, name: string): void {
  send({ type: "rename-mascot", id, name });
}

/** Which mascot a workspace gets when it has not picked one of its own. */
export function setDefaultMascot(id: string): void {
  send({ type: "set-default-mascot", id });
}

/** Give a workspace its own, or `null` to hand it back to the default. */
export function setWorkspaceMascot(workspaceId: string, mascotId: string | null): void {
  send({ type: "set-workspace-mascot", workspaceId, mascotId });
}

/** Rebind one key, or unbind it with `null`. */
export function bindKey(key: string, action: Action | null): void {
  send({ type: "bind-key", key, action });
}

export function resetKeys(): void {
  send({ type: "reset-keys" });
}

/** The terminal's type and cursor, all four at once — they are edited together. */
export function setTerminalAppearance(terminal: TerminalAppearance): void {
  send({ type: "set-terminal-appearance", terminal });
}

/** The face and the size the interface is set in. See `set-interface-appearance`. */
export function setInterfaceAppearance(ui: InterfaceAppearance): void {
  send({ type: "set-interface-appearance", ui });
}

/** Which of the bottom bar's chips are drawn: the whole list of the hidden ones. */
export function setBar(bar: BarSettings): void {
  send({ type: "set-bar", bar });
}

/** When kururu may interrupt you, and what it sounds like. All five at once. */
export function setNotify(notify: NotifySettings): void {
  send({ type: "set-notify", notify });
}

/** Watch a machine. Rejects with the server's sentence when the host is not one it will run. */
export function addMachine(name: string, host: string, panel: string): Promise<MachineEntry> {
  return request((id) => ({ type: "add-machine", id, name, host, panel })) as Promise<MachineEntry>;
}

/**
 * Settings → Nodes → Add a computer: show the join command for ten minutes,
 * or stop showing it. Resolves with the command, or null once stopped.
 */
export function inviteNode(on: boolean): Promise<NodesView["invite"]> {
  return request((id) => ({ type: "node-invite", id, on })) as Promise<NodesView["invite"]>;
}

/** On the new PC's own page: the Mac's join command, pasted. The server posts it to the Mac. */
export function joinNode(text: string): Promise<NodesView> {
  return request((id) => ({ type: "node-join", id, text })) as Promise<NodesView>;
}

/** A new name for a member, this node included. The parent's alone. */
export function renameNode(nodeId: string, name: string): Promise<unknown> {
  return request((id) => ({ type: "node-rename", id, nodeId, name }));
}

/** The rank list as the drag left it: every member's id, first first. */
export function rankNodes(order: string[]): Promise<unknown> {
  return request((id) => ({ type: "node-rank", id, order }));
}

/** Out of the roster. Its links drop as the new roster reaches each node. */
export function removeNode(nodeId: string): Promise<unknown> {
  return request((id) => ({ type: "node-remove", id, nodeId }));
}

/** The row menu's Move to <node>…: what would go and stay, and the node's word on the folder — its guess when null. */
export function moveWorkspacePlan(workspaceId: string, nodeId: string, folder: string | null): Promise<MovePlan> {
  return request((id) => ({ type: "node-move-plan", id, workspaceId, nodeId, folder })) as Promise<MovePlan>;
}

/** What a move answered, and what was lent with it or why not. */
export interface MoveResult {
  done: MoveDone;
  node: string;
  url: string;
  lent: string[];
  lendError: string | null;
}

/**
 * Move it, and lend the node what `lend` names once it is there. Resolves
 * once the node has it and it has left this list; rejects with why, and
 * then nothing here changed and nothing was lent.
 */
export function moveWorkspaceTo(workspaceId: string, nodeId: string, folder: string, lend?: LendAsk): Promise<MoveResult> {
  return request((id) => ({ type: "node-move", id, workspaceId, nodeId, folder, ...(lend ? { lend } : {}) })) as Promise<MoveResult>;
}

/**
 * The owner's answer to a vault dialog: the values by field id, straight from
 * the fields to the socket, or null for Cancel. Nothing here keeps them —
 * not the draft store, not a log — and the reply is a word per field.
 */
export function answerVault(ask: string, values: Record<string, string> | null, uses: Record<string, UseRule>): Promise<FieldOutcome[]> {
  return request((id) => ({ type: "vault-answer", id, ask, values, uses })) as Promise<FieldOutcome[]>;
}

/** The owner's answer to a command waiting to use a vault item. */
export function allowVault(ask: string, answer: UseAnswer): Promise<unknown> {
  return request((id) => ({ type: "vault-allow", id, ask, answer }));
}

/** Settings → Vault's own sections: the items kept, their rules, recent uses. */
export function vaultPage(): Promise<VaultPage> {
  return request((id) => ({ type: "vault-page", id })) as Promise<VaultPage>;
}

export function setVaultUse(name: string, use: UseRule): Promise<VaultPage> {
  return request((id) => ({ type: "vault-set-use", id, name, use })) as Promise<VaultPage>;
}

export function removeVaultItem(name: string): Promise<VaultPage> {
  return request((id) => ({ type: "vault-remove", id, name })) as Promise<VaultPage>;
}

export function clearVaultUses(): Promise<VaultPage> {
  return request((id) => ({ type: "vault-clear-uses", id })) as Promise<VaultPage>;
}

/** Settings → Vault: everything this kururu can see and lend, by name and hint. Never a value. */
export function vault(): Promise<VaultView> {
  return request((id) => ({ type: "vault", id })) as Promise<VaultView>;
}

/** What a workspace could lend a node, by hint, and the node's word on the folder — its guess when null. The parent's alone. */
export function lendOffer(workspaceId: string, nodeId: string, folder: string | null): Promise<Lendable> {
  return request((id) => ({ type: "secrets-offer", id, workspaceId, nodeId, folder })) as Promise<Lendable>;
}

/** Lend a node what `ask` names of a workspace's; env files into the folder the node is asked about again. */
export function lendSecrets(workspaceId: string, nodeId: string, folder: string | null, ask: LendAsk): Promise<{ view: SecretsView; lent: string[]; to: string | null }> {
  return request((id) => ({ type: "secrets-lend", id, workspaceId, nodeId, folder, ask })) as Promise<{ view: SecretsView; lent: string[]; to: string | null }>;
}

/** Lend a kind to a node, or take it back. The parent's alone. */
export function grantSecret(nodeId: string, kind: string, on: boolean): Promise<SecretsView> {
  return request((id) => ({ type: "secret-grant", id, nodeId, kind, on })) as Promise<SecretsView>;
}

/** Send a lent kind again, though the node holds a version of it. */
export function pushSecret(nodeId: string, kind: string): Promise<SecretsView> {
  return request((id) => ({ type: "secret-push", id, nodeId, kind })) as Promise<SecretsView>;
}

/** The token `claude setup-token` printed, kept on this Mac for lending as the profile's login. */
export function lendClaude(profileId: string, token: string): Promise<SecretsView> {
  return request((id) => ({ type: "claude-lend", id, profileId, token })) as Promise<SecretsView>;
}

export function unlendClaude(login: string): Promise<SecretsView> {
  return request((id) => ({ type: "claude-unlend", id, login })) as Promise<SecretsView>;
}

/** A tab running `claude setup-token` as the profile's login. */
export function openClaudeLend(profileId: string): Promise<unknown> {
  return request((id) => ({ type: "claude-lend-open", id, profileId }));
}

/** Stop watching it, which also brings home every workspace pinned to it. */
export function removeMachine(machineId: string): void {
  send({ type: "remove-machine", machineId });
}

/** Settings → Specs: one typed field of a machine. Blank removes it. */
export function setSpecs(machineId: string, key: TypedKey, value: string): void {
  send({ type: "set-specs", machineId, key, value });
}

/** A line of a machine's history. Rejects with the server's sentence, about a date it will not keep. */
export function specsHistory(
  machineId: string,
  change: { op: "add"; date: string; text: string } | { op: "edit"; entryId: string; date?: string; text?: string } | { op: "remove"; entryId: string },
): Promise<unknown> {
  return request((id) => ({ type: "specs-history", id, machineId, ...change }));
}

/** Read a machine's hardware now. Rejects with ssh's words when it could not. */
export function readSpecsNow(machineId: string): Promise<unknown> {
  return request((id) => ({ type: "read-specs", id, machineId }));
}

/** The machine row's shell button: `ssh -t <host>` in a tab of the focused pane. */
export function openMachineShell(machineId: string): Promise<string> {
  return request((id) => ({ type: "open-machine-shell", id, machineId })).then((result) => (result as { id: string }).id);
}

/**
 * Pin a workspace's shells to a machine and a folder there, or bring them home
 * with `null`. Rejects with the server's sentence about a folder it will not
 * put in a command line.
 */
export function pinWorkspace(workspaceId: string, machineId: string | null, dir: string): Promise<MachinePin | null> {
  return request((id) => ({ type: "pin-workspace", id, workspaceId, machineId, dir })) as Promise<MachinePin | null>;
}

/** Hand the server an OpenRouter key. Rejects with OpenRouter's reason, in a sentence, when it is refused. */
export function setOpenRouterKey(key: string): Promise<OpenRouterStatus> {
  return request((id) => ({ type: "set-openrouter-key", id, key })) as Promise<OpenRouterStatus>;
}

export function clearOpenRouterKey(): void {
  send({ type: "clear-openrouter-key" });
}


/** The chain's order, first first, or its page limit. */
export function setWeb(change: { order?: string[]; pageLimit?: number }): Promise<WebStatus> {
  return request((id) => ({ type: "set-web", id, ...change })) as Promise<WebStatus>;
}

/** A provider's switch, or one of its fields. Rejects with the reason, in a sentence, when the provider will not take it — a key it does not know. */
export function setWebProvider(provider: string, change: { enabled?: boolean; field?: string; value?: unknown }): Promise<WebStatus> {
  return request((id) => ({ type: "set-web-provider", id, provider, ...change })) as Promise<WebStatus>;
}

export function clearWebProviderField(provider: string, field: string): Promise<WebStatus> {
  return request((id) => ({ type: "clear-web-provider-field", id, provider, field })) as Promise<WebStatus>;
}

/** A provider's own test. Resolves with what came back, rejects with why not. */
export function testWebProvider(provider: string): Promise<string> {
  return request((id) => ({ type: "test-web-provider", id, provider })) as Promise<string>;
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/** Hand the server a channel's bot token. Rejects with the reason, in a sentence, when the channel refuses it. */
export function setChannelToken(kind: ChannelKind, token: string): Promise<TelegramStatus> {
  return request((id) => ({ type: "channel-token", id, kind, token })) as Promise<TelegramStatus>;
}

export function forgetChannel(kind: ChannelKind): void {
  send({ type: "channel-forget", kind });
}

/** The switch, the profile (null for whichever is active) and whether replies are spoken here too. Rejects with why, when switching on is refused. */
export function setChannel(kind: ChannelKind, change: { enabled?: boolean; profileId?: string | null; speakReplies?: boolean }): Promise<TelegramStatus> {
  return request((id) => ({ type: "channel-set", id, kind, ...change })) as Promise<TelegramStatus>;
}

export function pairChannel(kind: ChannelKind, on: boolean): Promise<TelegramStatus> {
  return request((id) => ({ type: "channel-pair", id, kind, on })) as Promise<TelegramStatus>;
}

export function allowChannelUser(kind: ChannelKind, userId: string): Promise<TelegramStatus> {
  return request((id) => ({ type: "channel-allow", id, kind, userId })) as Promise<TelegramStatus>;
}

export function refuseChannelUser(kind: ChannelKind): void {
  send({ type: "channel-refuse", kind });
}

export function disallowChannelUser(kind: ChannelKind, userId: string): void {
  send({ type: "channel-disallow", kind, userId });
}

/** Send a test message to every allowed account. Resolves with what happened, rejects with why not. */
export function testChannel(kind: ChannelKind): Promise<string> {
  return request((id) => ({ type: "channel-test", id, kind })) as Promise<string>;
}

export function clearChannelIgnored(kind: ChannelKind): void {
  send({ type: "channel-clear-ignored", kind });
}

// ---------------------------------------------------------------------------
// The database and the backups
// ---------------------------------------------------------------------------

/** The backup settings, all at once. Rejects with git's reason when the repository does not answer. */
export function setBackup(settings: { url: string | null; enabled: boolean; intervalMin: number }): Promise<BackupStatus> {
  return request((id) => ({ type: "set-backup", id, ...settings })) as Promise<BackupStatus>;
}

export function backupNow(): Promise<BackupStatus> {
  return request((id) => ({ type: "backup-now", id })) as Promise<BackupStatus>;
}

/** A deleted card of the profile on screen, back onto its board. */
export function restoreCard(cardId: string): Promise<unknown> {
  return request((id) => ({ type: "restore-card", id, cardId }));
}

export interface DeletedCardRow {
  id: string;
  number: number;
  title: string;
  column: string;
  deletedAt: number;
  workspaceKey: string | null;
  workspaceName: string | null;
  workspaceId: string | null;
}

export function deletedCards(profileId: string): Promise<DeletedCardRow[]> {
  return request((id) => ({ type: "deleted-cards", id, profileId })) as Promise<DeletedCardRow[]>;
}

/**
 * Full text over the profile's cards and conversations, off `/api/search`.
 * A fetch rather than a message: the answer is for the page that asked and
 * nobody else, and a GET is what a search is.
 */
export async function search(profileId: string, query: string, scope: SearchScope = "all"): Promise<SearchHit[]> {
  const params = new URLSearchParams({ q: query, scope, profile: profileId });
  const response = await fetch(`/api/search?${params}`);
  if (!response.ok) throw new Error(`search answered ${response.status}`);
  const body = (await response.json()) as { hits?: SearchHit[] };
  return Array.isArray(body.hits) ? body.hits : [];
}

// ---------------------------------------------------------------------------
// The voice
// ---------------------------------------------------------------------------

let speechListener: ((chunk: SpeechChunk) => void) | null = null;

/** Who plays what the harness says. One listener, like `onNotify`: the player in `voice.ts`. */
export function onSpeech(listener: (chunk: SpeechChunk) => void): () => void {
  speechListener = listener;
  return () => {
    if (speechListener === listener) speechListener = null;
  };
}

let hushListener: ((hushed: boolean) => void) | null = null;

/** Who holds speech while somebody talks. The player in `voice.ts`, like `onSpeech`. */
export function onHush(listener: (hushed: boolean) => void): () => void {
  hushListener = listener;
  return () => {
    if (hushListener === listener) hushListener = null;
  };
}

let connectListener: (() => void) | null = null;

/** Who wants to know the socket is up again: the clips in `voice.ts` the server has not taken yet. */
export function onConnect(listener: () => void): () => void {
  connectListener = listener;
  return () => {
    if (connectListener === listener) connectListener = null;
  };
}

let outboxListener: ((outbox: OutboxEntry[]) => void) | null = null;

/** Who follows the messages on their way to Kuru, beyond the list that draws them: the pill, through `voice.ts`. */
export function onOutbox(listener: (outbox: OutboxEntry[]) => void): () => void {
  outboxListener = listener;
  return () => {
    if (outboxListener === listener) outboxListener = null;
  };
}

/**
 * This page is talking to Kuru, so nothing anywhere should speak over it.
 * Deduped, and re-sent from `onopen` like `looking`: the server keeps no
 * memory of a socket that went away, and a reconnect mid-sentence must not
 * let the other windows start talking.
 */
let amTalking = false;

export function talking(on: boolean): void {
  if (on === amTalking) return;
  amTalking = on;
  send({ type: "talking", talking: on });
}

/**
 * What became of a reply here: held, to be played, or let go before its end.
 * Not re-sent on a reconnect, since the server that comes back is usually a
 * new one that never made the reply — see `Voice.leave`.
 */
export function speechHeld(utterance: string, held: boolean): void {
  send({ type: "speech-held", utterance, held });
}

/** One sentence of a reply played to its end here. */
export function speechPlayed(utterance: string, seq: number): void {
  send({ type: "speech-played", utterance, seq });
}

// ---------------------------------------------------------------------------
// An agent reloading the window
// ---------------------------------------------------------------------------

export type ReloadEvent =
  | { type: "ask"; ask: ReloadAsk; until: number }
  | { type: "cancel"; id: string }
  /** The socket dropped, and every ask with it. */
  | { type: "lost" };

let reloadListener: ((event: ReloadEvent) => void) | null = null;

/** Who decides when this page reloads: `reload.ts`. One listener, like `onHush`. */
export function onReload(listener: (event: ReloadEvent) => void): () => void {
  reloadListener = listener;
  return () => {
    if (reloadListener === listener) reloadListener = null;
  };
}

/**
 * This page can be asked to reload — see `shared/reload.ts`. Said on every
 * connect, on `looking`'s reasoning: the server keeps no memory of a socket
 * that went away. `reloaded`, the asks the page before this one reloaded
 * for, rides along until a connect has carried it once.
 */
let reloadPage: ReloadPage | null = null;
const reloadedFor = new Set<string>();

export function reloadable(page: ReloadPage, reloaded: readonly string[]): void {
  reloadPage = page;
  for (const id of reloaded) reloadedFor.add(id);
  if (socket?.readyState === WebSocket.OPEN) sayReloadable();
}

function sayReloadable(): void {
  if (!reloadPage) return;
  send({ type: "reloadable", page: reloadPage, ...(reloadedFor.size ? { reloaded: [...reloadedFor] } : {}) });
  reloadedFor.clear();
}

/** What is holding those asks here now. */
export function reloadHeld(ids: string[], holds: ReloadHold[]): void {
  send({ type: "reload-held", ids, holds });
}

/**
 * This page is reloading for those asks. Resolves once the word has left
 * the page — the socket's buffer is empty — or after a moment if it will not
 * empty, so the reload that follows does not take the word down with it.
 */
export function reloading(ids: string[]): Promise<void> {
  send({ type: "reloading", ids });
  const started = performance.now();
  return new Promise((resolve) => {
    const drained = () => {
      if (!socket || socket.bufferedAmount === 0 || performance.now() - started > 300) setTimeout(resolve, 20);
      else setTimeout(drained, 10);
    };
    drained();
  });
}

/** These replies have been in view in the open drawer long enough to count as read. */
export function kuruSeen(profileId: string, utterances: string[]): void {
  send({ type: "kuru-seen", profileId, utterances });
}

/** Pin a line of the drawer's, or take the pin off. The next `kuru` message says it is done, here and on every other client. */
export function kuruPin(profileId: string, id: string, pinned: boolean): void {
  send({ type: "kuru-pin", profileId, id, pinned });
}

/** Add a workspace to a line of the drawer's, or take it off. The next `kuru` message says it is done, everywhere. */
export function kuruTag(profileId: string, id: string, workspaceKey: string, kept: boolean): void {
  send({ type: "kuru-tag", profileId, id, workspaceKey, kept });
}

/**
 * Say one reply again, from the drawer's speaker. `text` is the reply as the
 * drawer already shows it, for when the one being replayed is already heard
 * and so the server has no copy of its words left to say again.
 */
export function kuruReplay(profileId: string, utterance: string, text?: string): void {
  send({ type: "kuru-replay", profileId, utterance, text });
}

/**
 * A line for Kuru from the drawer's composer. Minted an id here, as a clip
 * is, so that the server can tell a retry from a second message; what comes
 * back is the outbox's record of it, on the socket, merged into the
 * conversation like a spoken one.
 *
 * Said with the socket down, it waits here for the next server's snapshot
 * (`sayUnsaid`) rather than going the way of every other message `send`
 * cannot deliver. The box empties on Send either way, and a line that went
 * nowhere left nothing behind it: the owner pressed Send in the floating
 * chat and nothing reached Kuru (2026-11-12). That day's cause was another
 * (`shared/bidi.ts`), but a server restarting under `bun run dev` is a
 * socket down for a second or two many times a day, and a hidden page's
 * reconnect can take longer. Kept by the profile's key, since the id it was
 * said to is minted afresh by a server that started cold.
 */
export function kuruSay(profileId: string, text: string): string {
  const id = mintId();
  const at = Date.now();
  if (socket?.readyState === WebSocket.OPEN) send({ type: "kuru-say", profileId, id, text, at });
  else {
    const profile = state.snapshot?.profile;
    if (profile?.id === profileId) unsaid.push({ key: profile.key, id, text, at });
  }
  return id;
}

/** Lines for Kuru said while the socket was down, by the key of the profile they were said in. In memory: a page reloaded meanwhile has lost them. */
const unsaid: { key: string; id: string; text: string; at: number }[] = [];

/** A snapshot came: what was said while there was none goes now, to the profile's id on this server. Sent twice, the id makes the second nothing. */
function sayUnsaid(): void {
  const profile = state.snapshot?.profile;
  if (!profile || !unsaid.length || socket?.readyState !== WebSocket.OPEN) return;
  const waiting = unsaid.splice(0);
  for (const line of waiting) {
    if (line.key === profile.key) send({ type: "kuru-say", profileId: profile.id, id: line.id, text: line.text, at: line.at });
    else unsaid.push(line);
  }
}

/** Stop Kuru's turn, as Escape in its terminal would. The status the drawer reads says when it has. */
export function kuruStop(profileId: string): void {
  send({ type: "kuru-stop", profileId });
}

/** The conversation before a moment, oldest first, and whether there is more before that. */
export async function fetchKuru(profileId: string, before: number | null): Promise<KuruPage> {
  const params = new URLSearchParams({ profile: profileId });
  if (before !== null) params.set("before", String(before));
  const response = await fetch(`/api/kuru?${params}`);
  if (!response.ok) throw new Error(`the conversation answered ${response.status}`);
  const body = (await response.json()) as Partial<KuruPage>;
  return { items: Array.isArray(body.items) ? body.items : [], more: body.more === true };
}

/** Every line of the conversation with these words, or a rejection when the server would not say; `signal` lets a keystroke drop the one before it. */
export async function searchKuru(profileId: string, words: string, signal: AbortSignal): Promise<KuruSearchAnswer> {
  const response = await fetch(`/api/kuru/search?${new URLSearchParams({ profile: profileId, q: words })}`, { signal });
  if (!response.ok) throw new Error(`the search answered ${response.status}`);
  const body = (await response.json()) as Partial<KuruSearchAnswer>;
  return { raw: typeof body.raw === "string" ? body.raw : words, items: Array.isArray(body.items) ? body.items : [], total: Number.isFinite(body.total) ? body.total! : 0, exact: Number.isFinite(body.exact) ? body.exact! : 0 };
}

/** The lines around a moment — `before: 0` for only what comes after it — and whether there is more each way. */
export async function fetchKuruAround(profileId: string, at: number, before?: number): Promise<KuruAround> {
  const params = new URLSearchParams({ profile: profileId, at: String(at) });
  if (before !== undefined) params.set("before", String(before));
  const response = await fetch(`/api/kuru/around?${params}`);
  if (!response.ok) throw new Error(`the conversation answered ${response.status}`);
  const body = (await response.json()) as Partial<KuruAround>;
  return { items: Array.isArray(body.items) ? body.items : [], older: body.older === true, newer: body.newer === true };
}

/**
 * An id for a message — a clip or a typed line — minted on this side so a
 * retry is the same message and not a second one. `randomUUID` wants a
 * secure context, which a phone over the tailnet's http is not.
 */
export function mintId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Send a failed message of yours again. */
export function resendVoice(id: string): void {
  send({ type: "voice-resend", id });
}

/** Take a failed message of yours off the list, audio and all. */
export function discardVoice(id: string): void {
  send({ type: "voice-discard", id });
}

/** The voice's settings, all at once, on `setNotify`'s pattern. */
export function setVoice(voice: VoiceSettings): void {
  send({ type: "set-voice", voice });
}

/** Audition a voice. Resolves with the utterance to fetch; rejects with why it could not be made. */
export function previewVoice(voice: VoiceChoice, lang: VoiceLang): Promise<{ utterance: string }> {
  return request((id) => ({ type: "voice-preview", id, voice, lang })) as Promise<{ utterance: string }>;
}

export function downloadVoiceModel(): void {
  send({ type: "download-voice-model" });
}

/**
 * A clip to the server, as a WAV, under the id this page minted for it. A
 * fetch and not the socket because it is a binary body of up to ten
 * megabytes, which the socket carries as JSON strings and should not.
 * Resolves the moment the server has it on its disk, with the outbox's
 * record of it — null for a clip too short to hold a word — and rejects with
 * why it was not taken: the server down or restarting, or refusing it.
 * Sending the same id twice is the same message, so a retry is always safe.
 */
export async function sendClip(clip: { id: string; profileId: string; at: number; wav: ArrayBuffer; marks?: string }): Promise<OutboxEntry | null> {
  const query = new URLSearchParams({ profile: clip.profileId, id: clip.id, at: String(clip.at), ...(clip.marks ? { marks: clip.marks } : {}) });
  const res = await fetch(`/api/voice/hear?${query}`, {
    method: "POST",
    headers: { "content-type": "audio/wav" },
    body: clip.wav,
  });
  const body = (await res.json().catch(() => ({ error: `the server said ${res.status}` }))) as { entry?: OutboxEntry | null; error?: string };
  if (!res.ok || body.error !== undefined || body.entry === undefined) throw new Error(body.error ?? `the server said ${res.status}`);
  return body.entry;
}

/**
 * A dictated comment, as a WAV, into words — `/api/voice/dictate`, the
 * recogniser a clip to Kuru is heard by, with the words handed back and
 * nothing kept or sent on. Resolves with them, empty for a clip that held
 * none; rejects with why it could not be heard.
 */
export async function dictateClip(wav: ArrayBuffer): Promise<string> {
  const res = await fetch("/api/voice/dictate", { method: "POST", headers: { "content-type": "audio/wav" }, body: wav });
  const body = (await res.json().catch(() => ({ error: `the server said ${res.status}` }))) as { text?: unknown; error?: string };
  if (!res.ok || typeof body.text !== "string") throw new Error(body.error ?? `the server said ${res.status}`);
  return body.text;
}

/**
 * A file for Kuru's box that this page cannot name by its path, kept by the
 * server in its `drops/` folder. Resolves with the path of the copy, on the
 * server's computer, which is Kuru's; rejects with why it was not kept. A
 * fetch rather than the socket for `sendClip`'s reason: a picture is a binary
 * body of megabytes.
 */
export async function sendDrop(file: File): Promise<string> {
  const res = await fetch(`/api/drop?${new URLSearchParams({ name: file.name })}`, {
    method: "POST",
    headers: { "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  const body = (await res.json().catch(() => ({ error: `the server said ${res.status}` }))) as { path?: unknown; error?: string };
  if (!res.ok || typeof body.path !== "string") throw new Error(body.error ?? `the server said ${res.status}`);
  return body.path;
}

/**
 * A set of marks made with the screen pen, posted whole — the crops and the
 * displays in it as base64 — to the server this window is connected to, which writes
 * the folder and answers with the lines for Kuru's box (`server/src/marks.ts`).
 * A fetch for `sendDrop`'s reason: it is megabytes.
 */
export async function sendMarks(set: unknown): Promise<{ id: string; path: string; lines: string[] }> {
  const res = await fetch("/api/marks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(set) });
  const body = (await res.json().catch(() => ({ error: `the server said ${res.status}` }))) as { id?: unknown; path?: unknown; lines?: unknown; error?: string };
  if (!res.ok || typeof body.id !== "string" || typeof body.path !== "string" || !Array.isArray(body.lines)) throw new Error(body.error ?? `the server said ${res.status}`);
  return { id: body.id, path: body.path, lines: body.lines.filter((l): l is string => typeof l === "string") };
}

/** Where one sentence of an utterance is fetched from. */
export function speechUrl(utterance: string, seq: number): string {
  return `/api/speech?u=${encodeURIComponent(utterance)}&seq=${seq}`;
}

/**
 * The database viewer's three questions. Each rejects with what Postgres
 * said, in its own words, which the viewer shows where the answer would go.
 * `database` is another database on the same server, or undefined for the
 * URL's own.
 */
export function dbCatalog(dbId: string, database?: string): Promise<DbCatalog> {
  return request((id) => ({ type: "db-catalog", id, dbId, ...(database ? { database } : {}) })) as Promise<DbCatalog>;
}

export function dbRows(
  dbId: string,
  database: string | undefined,
  schema: string,
  table: string,
  offset: number,
  limit: number,
): Promise<DbRows> {
  return request((id) => ({
    type: "db-rows",
    id,
    dbId,
    ...(database ? { database } : {}),
    schema,
    table,
    offset,
    limit,
  })) as Promise<DbRows>;
}

export function dbQuery(dbId: string, database: string | undefined, sql: string, writes: boolean): Promise<DbResult> {
  return request((id) => ({ type: "db-query", id, dbId, ...(database ? { database } : {}), sql, writes })) as Promise<DbResult>;
}

/** Which agents and models the new-tab menu offers. */
export function setLaunch(launch: LaunchSettings): void {
  send({ type: "set-launch", launch });
}

/** What one repository has been told about itself — worktrees, setup, dev. */
export function setProject(root: string, settings: ProjectSettings): void {
  send({ type: "set-project", root, settings });
}

/**
 * Merge every card's worktree in this repository back and take it down. Waits,
 * because the answer is a list of what happened to each, and the snapshot only
 * shows which worktrees are gone.
 */
export function retireWorktrees(root: string): Promise<WorktreeOutcome[]> {
  return request((id) => ({ type: "retire-worktrees", id, root })) as Promise<WorktreeOutcome[]>;
}

/**
 * Go to that terminal, wherever it is — the click on a notification.
 *
 * A verb like every other navigation, which is what makes it work at all from a
 * card about an agent in a profile this window is not showing: the client does
 * not know where that agent is and has no business finding out. It says *take
 * me to this one* and draws the snapshot that comes back.
 */
export function revealAgent(agentId: string): void {
  send({ type: "reveal-agent", agentId });
}

/**
 * Take me to the harness: started, resumed or revealed, whichever it needs —
 * the server knows which and the button does not. `fresh` throws the old
 * conversation away, which is a thing to ask for by name.
 */
export function openHarness(options: { fresh?: boolean } = {}): void {
  send({ type: "open-harness", ...options });
}

/**
 * The same, waiting for the answer: for the drawer's Start, which has a
 * line to say why a Kuru would not start. A Kuru just started is answered
 * for once it is up or has died, which can take a few seconds.
 */
export function startHarness(): Promise<unknown> {
  return request((id) => ({ type: "open-harness", id }));
}

/** End a profile's Kuru and start it on the program Settings names now. Waits, because it can fail, and the page says so. */
export function restartHarness(profileId: string): Promise<unknown> {
  return request((id) => ({ type: "restart-harness", id, profileId }));
}

/** Auto Swap for a profile — the screen following what its harness acts on. The server does the following; this is only the switch. */
export function setAutoSwap(profileId: string, on: boolean): void {
  send({ type: "set-auto-swap", profileId, on });
}

/** Whether a profile's Claude agents load only kururu's MCP servers. Read at each launch, so it changes the next agent started, not the ones running. */
export function setAgentsKururuMcpOnly(profileId: string, on: boolean): void {
  send({ type: "set-agents-kururu-mcp-only", profileId, on });
}

/** A workspace's root folder, or "" for none. Resolves with the path the server stored; rejects with why it was refused. See `Workspace.root`. */
export function setWorkspaceRoot(profileId: string, workspaceId: string, root: string): Promise<string | null> {
  return request((id) => ({ type: "set-workspace-root", id, profileId, workspaceId, root })) as Promise<string | null>;
}

/** The owner's edits to a workspace's projects, whole. See `shared/subprojects.ts`. */
export function setWorkspaceProjects(profileId: string, workspaceId: string, edits: ProjectEdit[]): void {
  send({ type: "set-workspace-projects", profileId, workspaceId, edits });
}

/** Look under a workspace's root for its projects again; resolves once the server has looked. */
export function lookForProjects(profileId: string, workspaceId: string): Promise<unknown> {
  return request((id) => ({ type: "look-for-projects", id, profileId, workspaceId }));
}

export function setWorkspaceMobile(profileId: string, workspaceId: string, on: boolean): void {
  send({ type: "set-workspace-mobile", profileId, workspaceId, on });
}

// ---------------------------------------------------------------------------
// React binding
// ---------------------------------------------------------------------------

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Every root this node's workspaces have, as a file reference looks a file's
 * project up among them (`filequote.ts`). Its own hook, held to the one
 * array the store replaces only when the server says the projects moved, so
 * a reader does not draw again on every message the store takes.
 */
function projectRootsOf(projects: readonly WorkspaceProject[]): string[] {
  return [...new Set(projects.flatMap((p) => [p.root, ...p.choices]))];
}
let rootsFor: { projects: readonly WorkspaceProject[]; roots: string[] } | null = null;
export function projectRootsNow(): string[] {
  if (rootsFor?.projects !== state.projects) rootsFor = { projects: state.projects, roots: projectRootsOf(state.projects) };
  return rootsFor.roots;
}
export function useProjectRoots(): string[] {
  return useSyncExternalStore(subscribe, projectRootsNow);
}

export function useKururu(): KururuState {
  return useSyncExternalStore(subscribe, () => state);
}
