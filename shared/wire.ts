/**
 * Kururu's own wire protocol: what the browser and the kururu server say to
 * each other over the WebSocket.
 *
 * Deliberately *not* ghosttown's protocol. That one is request/response over a
 * unix socket with no way to push, so the server polls it and pushes the result
 * here. A client that had to poll over the tailnet from a phone would spend the
 * radio and still be behind; this way the phone holds one socket open and is
 * told when something changes.
 *
 * Two message families: `call`/`reply` is a plain RPC passthrough to ghosttown,
 * and everything else is state the server volunteers.
 */
import type { SessionSnapshot } from "./ghosttown";

/** A dev server kururu found listening on this machine. */
export interface DevServer {
  /** Listening port on localhost — the thing the preview points at. */
  port: number;
  pid: number;
  /** argv as `ps` prints it, tidied: "vite --port 3001". */
  command: string;
  /** Program name alone, for a label: "vite", "next", "bun". */
  program: string;
  /** Working directory of the process, when it could be read. */
  cwd?: string;
  /**
   * Port the kururu proxy is exposing this on, once one has been opened. The
   * desktop window does not need it (localhost is the same machine); the phone
   * cannot reach the dev server any other way.
   */
  proxyPort?: number;
}

export type ServerMessage =
  /** Sent on connect and whenever the daemon's snapshot changes. */
  | { type: "snapshot"; snapshot: SessionSnapshot }
  /** Sent on connect and whenever the set of listening dev servers changes. */
  | { type: "dev-servers"; servers: DevServer[] }
  /** Profiles with a daemon running right now. */
  | { type: "sessions"; sessions: string[]; active: string }
  /** The agent pane's view of a surface: its screen, as text. */
  | { type: "screen"; surfaceId: string; text: string }
  /** Answer to a `call`. */
  | { type: "reply"; id: number; ok: true; result: unknown }
  | { type: "reply"; id: number; ok: false; error: string }
  /** The daemon went away, or came back. */
  | { type: "daemon"; connected: boolean; error?: string };

export type ClientMessage =
  /** Passthrough to ghosttown's control socket. */
  | { type: "call"; id: number; method: string; params?: Record<string, unknown> }
  /** Which surface the agent pane is showing — the server polls just this one. */
  | { type: "watch-screen"; surfaceId: string | null }
  /** Switch profiles (ghosttown calls them sessions). */
  | { type: "select-session"; session: string }
  /** Open a proxy for this dev server so a phone can reach it. */
  | { type: "open-preview"; port: number };

/** How often the server re-asks the daemon for a snapshot. */
export const SNAPSHOT_POLL_MS = 600;
/** How often it re-reads the watched surface's screen. Slower: it is a lot more bytes. */
export const SCREEN_POLL_MS = 900;
/** How often it re-scans for listening dev servers. Slowest: it shells out twice. */
export const DEV_SCAN_MS = 3000;
