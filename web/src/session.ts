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
import type { PtyKind, SessionSnapshot, WorkspaceColor } from "../../shared/model";
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
  /** The history of this terminal. Clear everything and start from this. */
  reset(data: string): void;
}
const sinks = new Map<string, Set<OutputSink>>();

/**
 * Backlogs that arrived before any emulator had subscribed for them. One per
 * agent, because only the newest is worth keeping: each is a whole screen, and
 * an older whole screen tells you nothing a newer one does not.
 */
const held = new Map<string, string>();

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
    // The server keeps no memory of a socket that went away, so every pane that
    // is open has to say so again — and gets its history back in reply, which is
    // how it catches up on whatever was said while we were gone.
    if (watched.size > 0) send({ type: "watch", agentIds: [...watched] });
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
         * A backlog is never thrown away for want of an emulator to write it
         * into. The server sends one because a terminal came on screen, and the
         * component that will draw it subscribes a frame or two later — once its
         * box has a size, because a screen serialized for 144 columns written
         * into the 80 xterm starts life with is a screen that comes out wrapped.
         * Those are two different clocks, and the gap is real: dropping what
         * lands in it leaves the emulator with nothing but the agent's next
         * partial redraw, which is a screen with holes in it.
         */
        const set = sinks.get(msg.agentId);
        if (!set || set.size === 0) {
          held.set(msg.agentId, msg.data);
          break;
        }
        held.delete(msg.agentId);
        for (const sink of set) sink.reset(msg.data);
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
 * Say which terminals are on screen. Derived from the layout the server sent
 * back, and sent whole: the server answers with history for the ones it had not
 * been sending, which is what makes a pane you just opened arrive full rather
 * than empty.
 */
export function watch(agentIds: Iterable<string>): void {
  const next = new Set(agentIds);
  if (next.size === watched.size && [...next].every((id) => watched.has(id))) return;
  watched = next;
  send({ type: "watch", agentIds: [...next] });
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
  // Anything that arrived before there was anywhere to put it. Written first,
  // so the request below — whose answer is newer — still lands on top of it.
  const waiting = held.get(agentId);
  if (waiting !== undefined) {
    held.delete(agentId);
    sink.reset(waiting);
  }
  send({ type: "request-backlog", agentId });
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
