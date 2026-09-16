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
import { useSyncExternalStore } from "react";
import type { Direction } from "../../shared/layout";
import type { Action } from "../../shared/keys";
import type {
  MascotConfig,
  ProfileIdentity,
  PtyKind,
  SessionSnapshot,
  WorkspaceColor,
} from "../../shared/model";
import type { ClientMessage, DevServer, Notification, ServerMessage } from "../../shared/wire";
import type { NotifySettings } from "../../shared/notify";
import type { TerminalAppearance } from "../../shared/theme";
import type { Grid } from "./grid";
import { claimAccess } from "./access";

export interface KururuState {
  /** The websocket to the kururu server is open. */
  connected: boolean;
  snapshot: SessionSnapshot | null;
  /**
   * Dev servers kururu found on this machine. Nothing draws them since the UI
   * became terminals-only; the server still finds them, and the preview that
   * will want them is PLAN.md item 5.
   */
  devServers: DevServer[];
}

const RETRY_MS = [200, 500, 1000, 2000, 4000];

let state: KururuState = { connected: false, snapshot: null, devServers: [] };

const listeners = new Set<() => void>();
let socket: WebSocket | null = null;
let attempt = 0;
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
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  socket = ws;

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
        set({ snapshot: msg.snapshot });
        break;
      case "dev-servers":
        set({ devServers: msg.servers });
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
  options: { kind?: PtyKind; cwd?: string; command?: string; paneId?: string } = {},
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

export function workspaceByIndex(index: number): void {
  send({ type: "workspace-index", index });
}

export function stepWorkspace(delta: number): void {
  send({ type: "step-workspace", delta });
}

export function lastWorkspace(): void {
  send({ type: "last-workspace" });
}

export function renameWorkspace(workspaceId: string, name: string): void {
  send({ type: "rename-workspace", workspaceId, name });
}

/** Tag a workspace, or clear it with null. See WORKSPACE_COLORS. */
export function setWorkspaceColor(workspaceId: string, color: WorkspaceColor | null): void {
  send({ type: "set-workspace-color", workspaceId, color });
}

/**
 * Open this workspace's next terminals as another profile's accounts, or `null`
 * to hand it back to the profile it lives in. A profile id and not an identity:
 * the paths stay the server's, and this only points at one of them.
 */
export function setWorkspaceIdentity(workspaceId: string, profileId: string | null): void {
  send({ type: "set-workspace-identity", workspaceId, profileId });
}

/**
 * The ▸ / ↻ on a workspace row. One verb for both faces of it: the server knows
 * better than this window whether anything is actually serving, since what the
 * button is drawn from is a scan up to three seconds old.
 */
export function runDev(workspaceId: string): void {
  send({ type: "run-dev", workspaceId });
}

export function deleteWorkspace(workspaceId: string): void {
  send({ type: "delete-workspace", workspaceId });
}

export function moveWorkspace(workspaceId: string, index: number): void {
  send({ type: "move-workspace", workspaceId, index });
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

/**
 * Which accounts this profile opens terminals as. Sent whole rather than a field
 * at a time — the three are one decision and are edited on one page — and it
 * reaches the next pty rather than the ones already running.
 */
export function setProfileIdentity(profileId: string, identity: ProfileIdentity): void {
  send({ type: "set-profile-identity", profileId, identity });
}

/**
 * Use a github account by name. The server writes the config directory that
 * means it — a path is not the client's to invent — and points the profile at
 * it. Null hands the profile back to whatever gh itself is set to.
 */
export function useGhAccount(profileId: string, account: { host: string; login: string } | null): void {
  send({ type: "use-gh-account", profileId, account });
}

/**
 * Start a login for a profile. There is no reply and there is no dialog: what
 * happens is a terminal opening in that profile with the login prompt in it.
 */
export function signIn(profileId: string, tool: "claude" | "gh"): void {
  send({ type: "sign-in", profileId, tool });
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

/** Stop following the editor, or start again. */
export function pinReader(paneId: string, follow: boolean): void {
  send({ type: "pin-reader", paneId, follow });
}

/**
 * Read this file in this pane. The other half of `pinReader`: it says which
 * document, and the server stops following an editor because of it.
 */
export function openDoc(paneId: string, root: string, path: string): void {
  send({ type: "open-doc", paneId, root, path });
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

/**
 * How it looks. A verb like the rest, which is what makes a theme picked on the
 * phone arrive on the desktop — nothing applies anything locally and waits for
 * the server to agree, because there would then be a moment where the two
 * disagreed and a dropped socket would make it permanent.
 */
export function setTheme(themeId: string): void {
  send({ type: "set-theme", themeId });
}

/**
 * What shape the window is, which travels the same road as the theme for the
 * same reason and has one extra consequence at the far end: a skin moves the
 * line weight and the type ramp, so the snapshot that comes back resizes every
 * pane box, and a resized box is a new grid proposed to the pty. That happens
 * through the `ResizeObserver` `terminals.ts` already has — see the header of
 * `web/src/skin.ts` — so there is nothing to do here but send the verb.
 */
export function setSkin(skinId: string): void {
  send({ type: "set-skin", skinId });
}

/** The terminal's type and cursor, all four at once — they are edited together. */
export function setTerminalAppearance(terminal: TerminalAppearance): void {
  send({ type: "set-terminal-appearance", terminal });
}

/** When kururu may interrupt you, and what it sounds like. All five at once. */
export function setNotify(notify: NotifySettings): void {
  send({ type: "set-notify", notify });
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

// ---------------------------------------------------------------------------
// React binding
// ---------------------------------------------------------------------------

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useKururu(): KururuState {
  return useSyncExternalStore(subscribe, () => state);
}
