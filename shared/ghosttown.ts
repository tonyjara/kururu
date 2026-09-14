/**
 * The shape of ghosttown's control protocol, mirrored.
 *
 * Kururu is a *client* of the ghosttown daemon, not a fork of it: it opens the
 * same unix socket `gt` does and speaks the same newline-delimited JSON. That
 * keeps one daemon owning every pty on this machine, so the agents you see in
 * the TUI, in the desktop window and on your phone are the same agents — which
 * is the whole point, and the thing a second daemon would quietly break.
 *
 * These types are copied rather than imported because the two projects are
 * separate repos. The protocol is documented as additive, so a copy drifts by
 * *missing* new fields, never by disagreeing about old ones. When they do drift,
 * this file is the one place to reconcile.
 */

export type AgentStatus = "idle" | "working" | "blocked" | "done";

export interface Request {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export type Response =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

/** How full an agent's context window is, in the two numbers it takes to say it. */
export interface ContextUsage {
  used: number;
  window: number;
}

export interface SurfaceSnapshot {
  id: string;
  title: string;
  command: string;
  status: AgentStatus;
  unread: boolean;
  agent?: string;
  active: boolean;
}

export interface PaneSnapshot {
  id: string;
  rect: { x: number; y: number; width: number; height: number };
  focused: boolean;
  surfaces: SurfaceSnapshot[];
}

/**
 * One agent in the profile, wherever it lives. Flat and workspace-tagged: the
 * phone's tab strip is a list of agents, not a layout, so this is the record it
 * renders directly.
 */
export interface AgentSnapshot {
  surfaceId: string;
  title: string;
  status: AgentStatus;
  agent: string | null;
  live: boolean;
  unread: boolean;
  workspaceId: string;
  workspace: string;
  paneId: string;
  lastActiveAt: number | null;
  contextUsage: ContextUsage | null;
}

export interface WorkspaceSnapshot {
  id: string;
  name: string;
  active: boolean;
  panes: PaneSnapshot[];
}

export interface SessionSnapshot {
  session: string;
  workspaces: WorkspaceSnapshot[];
  agents: AgentSnapshot[];
}

/**
 * The subset of ghosttown's methods kururu uses. `read-screen` and `send-text`
 * are what make an agent pane possible today with no change to ghosttown: the
 * screen is what the agent is saying, and send-text is how you answer it.
 */
export interface Methods {
  ping: { params: Record<string, never>; result: "pong" };
  list: { params: Record<string, never>; result: SessionSnapshot };
  "send-text": { params: { surface?: string; text: string }; result: true };
  "read-screen": { params: { surface?: string }; result: { text: string } };
  focus: { params: { surface?: string; pane?: string; workspace?: string }; result: true };
  "select-tab": { params: { pane?: string; index: number }; result: true };
  notify: { params: { title?: string; body: string; surface?: string }; result: true };
}

export type MethodName = keyof Methods;

/** Where every socket of every profile lives — so it is also the profile list. */
export function defaultSocketDir(): string {
  if (process.env.GHOSTTOWN_SOCKET_DIR) return process.env.GHOSTTOWN_SOCKET_DIR;
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return `/tmp/ghosttown-${uid}`;
}

export function socketPathFor(session: string): string {
  return `${defaultSocketDir()}/${session}.sock`;
}
