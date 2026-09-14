/**
 * The client half of kururu's wire protocol: one WebSocket, held open, that
 * both pushes state down and carries RPC up.
 *
 * A module-level store rather than context, because the desktop window and the
 * phone run the same components and neither has a second session to show. React
 * subscribes through useSyncExternalStore, so a push re-renders only what read
 * the field that changed.
 *
 * Reconnection is expected, not exceptional: the kururu server restarts when
 * you edit it, the daemon restarts on prefix+R, and a phone drops the socket
 * every time it sleeps. So the socket reopens on a backoff forever, and the UI
 * renders `connected` rather than erroring.
 */
import { useSyncExternalStore } from "react";
import type { SessionSnapshot } from "../../shared/ghosttown";
import type { ClientMessage, DevServer, ServerMessage } from "../../shared/wire";

export interface KururuState {
  /** The websocket to the kururu server is open. */
  connected: boolean;
  /** The kururu server's socket to the ghosttown daemon is open. */
  daemon: boolean;
  daemonError?: string;
  snapshot: SessionSnapshot | null;
  devServers: DevServer[];
  sessions: string[];
  activeSession: string;
  /** Screen text per surface, as last pushed. */
  screens: Record<string, string>;
}

const RETRY_MS = [200, 500, 1000, 2000, 4000];

let state: KururuState = {
  connected: false,
  daemon: false,
  snapshot: null,
  devServers: [],
  sessions: [],
  activeSession: "",
  screens: {},
};

const listeners = new Set<() => void>();
let socket: WebSocket | null = null;
let attempt = 0;
let nextCallId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

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
    // A reconnect has lost the server's idea of what we were watching.
    if (watched) send({ type: "watch-screen", surfaceId: watched });
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
      case "sessions":
        set({ sessions: msg.sessions, activeSession: msg.active });
        break;
      case "screen":
        set({ screens: { ...state.screens, [msg.surfaceId]: msg.text } });
        break;
      case "daemon":
        set({ daemon: msg.connected, daemonError: msg.error });
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
    set({ connected: false, daemon: false });
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

/** Passthrough RPC to the ghosttown daemon. */
export function call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const id = nextCallId++;
  return new Promise((resolve, reject) => {
    if (socket?.readyState !== WebSocket.OPEN) return reject(new Error("not connected"));
    pending.set(id, { resolve, reject });
    send({ type: "call", id, method, params });
  });
}

let watched: string | null = null;

/** Tell the server which surface's screen to keep us posted on. */
export function watchScreen(surfaceId: string | null): void {
  if (watched === surfaceId) return;
  watched = surfaceId;
  send({ type: "watch-screen", surfaceId });
}

export function selectSession(session: string): void {
  send({ type: "select-session", session });
}

/** Ask for a proxy port so this dev server is reachable from the phone. */
export function openPreview(port: number): void {
  send({ type: "open-preview", port });
}

export function sendText(surfaceId: string, text: string): Promise<unknown> {
  return call("send-text", { surface: surfaceId, text });
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
