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
 * open pane asks for its history again and catches up.
 */
import { useSyncExternalStore } from "react";
import type { Direction } from "../../shared/layout";
import type { Action } from "../../shared/keys";
import type { MascotConfig, PtyKind, SessionSnapshot, WorkspaceColor } from "../../shared/model";
import type { ClientMessage, DevServer, ServerMessage } from "../../shared/wire";

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
 * Where output goes. One terminal can be open in more than one pane, so this is
 * a set of sinks per agent rather than one — each pane has its own emulator and
 * both want the same bytes.
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
   * What shape this emulator is right now, for the request that asks for a
   * history. The sink is asked rather than told because the answer changes —
   * the pane is resizable — and because a reconnect has to ask again on behalf
   * of a sink that has been sitting there for an hour.
   */
  grid(): { cols: number; rows: number };
}
const sinks = new Map<string, Set<OutputSink>>();

/**
 * Which `request-backlog` each sink is waiting for.
 *
 * A backlog is a whole screen at a particular size, and the wrong one is worse
 * than none: two panes showing the same terminal are two different shapes, and
 * an emulator thrown away and rebuilt has asked twice. So a sink takes only the
 * answer to its own question, and the ones meant for a predecessor — or for the
 * pane next door — go past it.
 */
const epochs = new WeakMap<OutputSink, number>();
let nextEpoch = 1;

function set(patch: Partial<KururuState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function send(msg: ClientMessage): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
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
     * is open has to say so again — and then ask, separately, for the history it
     * missed while we were gone.
     *
     * Separately because those are two different questions and only one of them
     * has a size in it. `watch` is a set of ids; it cannot say how wide anything
     * is, and a history laid out at a width nobody is drawing at is a screen
     * that stays wrong. Every emulator that is still mounted asks for itself, at
     * whatever shape it is now.
     */
    if (watched.size > 0) send({ type: "watch", agentIds: [...watched] });
    for (const [agentId, open] of sinks) for (const sink of open) askBacklog(agentId, sink);
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
        for (const sink of sinks.get(msg.agentId) ?? []) sink.write(msg.data);
        break;
      case "backlog": {
        /**
         * Delivered to the emulator that asked, and to no other.
         *
         * A backlog used to arrive unbidden — the server sent one whenever a
         * terminal came on screen — and could land before any emulator had
         * subscribed to receive it, which is why one was held for the next sink
         * to appear. It cannot now: the only thing that produces a backlog is a
         * request an emulator made for itself, so the asker is already here, and
         * an answer to a question nobody is waiting for any more is an answer to
         * a pane that has closed.
         *
         * The epoch is what makes "the one that asked" a fact rather than a
         * hope. Two panes on one terminal are two shapes and each asked for its
         * own; an emulator rebuilt while its predecessor's answer was still in
         * flight must not be reset by that answer, which is a screen laid out
         * for a box that no longer exists.
         */
        for (const sink of sinks.get(msg.agentId) ?? []) {
          if (epochs.get(sink) !== msg.epoch) continue;
          sink.reset(msg.data, msg.cols, msg.rows);
        }
        break;
      }
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

connect();

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

/**
 * Say which terminals are on screen, so the server knows whose bytes are worth
 * sending. Derived from the layout the server sent back, and sent whole.
 *
 * It no longer brings history with it. A set of ids cannot say how wide anything
 * is, and history is a screen laid out at a width — so the two were separated
 * and the asking moved to the only thing that knows the answer, which is the
 * emulator that is about to draw it.
 */
export function watch(agentIds: Iterable<string>): void {
  const next = new Set(agentIds);
  if (next.size === watched.size && [...next].every((id) => watched.has(id))) return;
  watched = next;
  send({ type: "watch", agentIds: [...next] });
}

/**
 * Ask for this terminal's history, at the shape this emulator is drawing at.
 *
 * The size travels with the question because the answer is laid out for it, and
 * a round trip that has to be told the size afterwards has already produced a
 * wrong screen. The epoch travels with it so the answer can be matched back to
 * this asking and not to another.
 */
function askBacklog(agentId: string, sink: OutputSink): void {
  const { cols, rows } = sink.grid();
  const epoch = nextEpoch++;
  epochs.set(sink, epoch);
  send({ type: "request-backlog", agentId, cols, rows, epoch });
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
export function subscribeOutput(agentId: string, sink: OutputSink): () => void {
  let set = sinks.get(agentId);
  if (!set) sinks.set(agentId, (set = new Set()));
  set.add(sink);
  askBacklog(agentId, sink);
  return () => {
    set.delete(sink);
    if (set.size === 0) sinks.delete(agentId);
  };
}

/** What the user typed. Straight through, no interpretation, no reply. */
export function input(agentId: string, data: string): void {
  send({ type: "input", agentId, data });
}

/** This pane is this many columns by this many rows now. */
export function resize(agentId: string, cols: number, rows: number): void {
  send({ type: "resize", agentId, cols, rows });
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
 * Put the server back on current source. The agents are not in it — they are in
 * the pty host beside it — so this costs a reconnect, which this module does
 * anyway and forever.
 */
export function restartServer(): void {
  send({ type: "restart-server" });
}

/** Ask for a proxy port so this dev server is reachable from the phone. */
export function openPreview(port: number): void {
  send({ type: "open-preview", port });
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
