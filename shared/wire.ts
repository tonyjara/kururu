/**
 * Kururu's wire protocol: what the browser and the kururu server say to each
 * other over the WebSocket.
 *
 * The shape follows from one decision: the browser runs a real terminal
 * emulator now, so this protocol carries *pty bytes*, not a picture of them.
 * It used to push the current screen rendered down to plain text, because the
 * client was a `<pre>` and a `<pre>` cannot parse an escape sequence. That cost
 * everything a terminal is — colour, cursor, alt-screen, selection, scrollback —
 * to save a dependency, and a terminal that cannot do those things is not one.
 *
 * So output is a byte stream, input is keystrokes rather than submitted turns,
 * and the client tells the server what size grid it is drawing into. Three
 * consequences worth naming:
 *
 *  - `watch` takes a *set*. Panes are tiled, so several terminals are visible at
 *    once and all of them want their bytes.
 *  - A terminal that has just been opened needs the history it missed, which is
 *    `backlog` — reconstructed by the emulator the server keeps beside each pty,
 *    not a replay of raw bytes that may have been cut mid-sequence. A
 *    reconstruction is laid out at a width, so asking for one and saying how
 *    wide you are is a single message and the answer names the grid it used.
 *  - `input` carries no id and gets no reply. It is a keystroke; a round trip
 *    per keypress to learn what the snapshot already says is not worth having.
 *
 * The second half of the protocol is the arrangement, and it reads as verbs
 * rather than state because the server owns it: the client says *split the
 * focused pane*, not *here is my new tree*. That is what makes two clients agree
 * and what lets a window reload cost a repaint. Almost all of them are
 * fire-and-forget for the same reason `input` is — the snapshot that follows is
 * the answer, and it is complete. Only `new-tab` can fail in a way nothing else
 * would explain, so it alone carries an `id` and is answered with `reply`.
 */
import type { Direction } from "./layout";
import type { MascotConfig, PtyKind, SessionSnapshot } from "./model";

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
  /** Sent on connect and whenever anything about any agent changes. Complete, never a delta. */
  | { type: "snapshot"; snapshot: SessionSnapshot }
  /** Sent on connect and whenever the set of listening dev servers changes. */
  | { type: "dev-servers"; servers: DevServer[] }
  /** Raw pty output, exactly as it arrived, for a terminal this client is watching. */
  | { type: "output"; agentId: string; data: string }
  /**
   * Everything that terminal has said so far, as the escape sequences that
   * rebuild it — and the grid it was serialized at, which is the point of
   * sending it rather than leaving the client to assume.
   *
   * A serialized screen is laid out at a particular width. Written into a grid
   * of a different one, every row longer than the target wraps, everything below
   * shifts down, and the top of the screen scrolls away. What is left is a
   * client whose buffer disagrees with the server's — and an agent redraws
   * differentially, so it will never resend a row it believes is already right
   * and the disagreement is permanent. `cols`/`rows` are therefore not advice:
   * the client sizes its emulator to them before writing `data`, which is what
   * makes the two grids identical by construction rather than by luck.
   *
   * `epoch` is the `request-backlog` this answers, so an emulator thrown away
   * between the asking and the answering cannot have its replacement reset by a
   * screen meant for its predecessor.
   */
  | { type: "backlog"; agentId: string; data: string; cols: number; rows: number; epoch: number }
  /** Answer to any client message carrying an `id`. */
  | { type: "reply"; id: number; ok: true; result: unknown }
  | { type: "reply"; id: number; ok: false; error: string };

export type ClientMessage =
  // --- terminals -----------------------------------------------------------
  /**
   * Start a terminal and put it in a pane as a new tab. Every field defaults:
   * the focused pane, that pane's project, an agent rather than a shell.
   */
  | { type: "new-tab"; id: number; kind?: PtyKind; cwd?: string; command?: string; paneId?: string }
  /**
   * End a terminal and take its tab with it. Defaults to the focused tab.
   *
   * This is the one destructive verb in the layout half, and it is destructive
   * on purpose: a tab is where a terminal lives, so closing it is not putting it
   * away. The key bound to it is shifted for exactly that reason.
   */
  | { type: "close-tab"; agentId?: string }
  | { type: "select-tab"; paneId: string; index: number }
  | { type: "cycle-tab"; delta: number; paneId?: string }
  /**
   * Put a terminal in a pane, at a position in its strip. One message for every
   * rearrangement a drag can be — along a strip, into the pane next door, out of
   * the sidebar, in from another workspace — because they are one gesture.
   */
  | { type: "move-tab"; agentId: string; paneId: string; index?: number }
  /** Dropped on a pane's edge: divide it and put the terminal in the new half. */
  | { type: "split-with"; agentId: string; paneId: string; dir: "row" | "col"; before: boolean }
  /** Dropped on a workspace in the sidebar: send it there, to whatever has focus. */
  | { type: "move-tab-to-workspace"; agentId: string; workspaceId: string }
  /** Name a tab. An empty name hands it back to what it would be called anyway. */
  | { type: "rename-tab"; agentId: string; name: string }
  /**
   * Keystrokes, straight through to the pty. No id: this is what the user typed,
   * and it is either delivered or the terminal is visibly dead already.
   */
  | { type: "input"; agentId: string; data: string }
  /**
   * The grid this client is drawing that terminal into. A pty has one size and
   * panes are tiled, so the last pane to report wins — which is the right answer
   * when the same terminal is on screen twice at different sizes, because the
   * one you just resized is the one you are looking at.
   */
  | { type: "resize"; agentId: string; cols: number; rows: number }
  /**
   * Which terminals this client has on screen. A set, not one: panes are tiled.
   * Re-sent after a reconnect — the server keeps no memory of a socket that went
   * away.
   */
  | { type: "watch"; agentIds: string[] }
  /**
   * Rebuild this terminal at this size. The only thing that produces a `backlog`.
   *
   * It carries the grid because a history and the shape it is laid out in are
   * one question rather than two. They were two: the emulator asked for its
   * history the instant it mounted and mentioned its size sixty milliseconds
   * later on the resize debounce, so the server answered at whatever size the
   * pane that last drew this terminal happened to be. Switching workspace is
   * where that was reliably wrong, a different workspace being a different pane
   * geometry, and the reconstruction arrived wrapped for a width nobody was
   * drawing at.
   *
   * `watch` deliberately no longer does this. It says which terminals are on
   * screen, and a set of ids cannot carry a size — asking there is how a
   * wrong-sized screen got painted before the emulator that would receive it
   * even existed. Watching is about streaming; this is about rebuilding, and
   * only an emulator that has just been built knows it needs it. A fresh pane, a
   * tab switch and a reconnect are the three ways that happens.
   */
  | { type: "request-backlog"; agentId: string; cols: number; rows: number; epoch: number }

  // --- panes ---------------------------------------------------------------
  | { type: "split"; dir: "row" | "col"; paneId?: string }
  /** Close a pane and everything in it. The last pane of a workspace empties instead. */
  | { type: "close-pane"; paneId?: string }
  | { type: "focus-pane"; paneId: string }
  /** prefix+hjkl. Nothing that way is not an error; the client focuses the sidebar. */
  | { type: "focus-dir"; dir: Direction }
  | { type: "step-pane"; delta: number }
  | { type: "set-ratio"; splitId: string; ratio: number }
  /**
   * A whole pane, dragged by its tab strip. Dropped on another pane's middle it
   * swaps places with it; on an edge it moves to that side of it; on its tab
   * strip it pours its tabs in and disappears.
   */
  | { type: "swap-panes"; paneId: string; withPaneId: string }
  | { type: "move-pane"; paneId: string; toPaneId: string; dir: "row" | "col"; before: boolean }
  | { type: "merge-panes"; paneId: string; intoPaneId: string }
  /** Resize mode: push the divider the focused pane's edge sits against. */
  | { type: "nudge"; dir: Direction; delta: number }

  // --- workspaces ----------------------------------------------------------
  | { type: "new-workspace"; name?: string }
  | { type: "switch-workspace"; workspaceId: string }
  /** The number the sidebar prints beside each one, zero-based on the wire. */
  | { type: "workspace-index"; index: number }
  | { type: "step-workspace"; delta: number }
  /** Back to the one you came from — a toggle, not a walk through the list. */
  | { type: "last-workspace" }
  | { type: "rename-workspace"; workspaceId: string; name: string }
  /**
   * Tag a workspace with a colour, or `null` to clear it. A name from
   * WORKSPACE_COLORS and nothing else — the server refuses anything it does not
   * recognise rather than storing it, because this value ends up in a style
   * attribute and the client it came from may be a phone on the tailnet.
   */
  | { type: "set-workspace-color"; workspaceId: string; color: string | null }
  /** Deletes it and ends everything in it. The last workspace cannot go. */
  | { type: "delete-workspace"; workspaceId: string }
  /** Dragged up or down the sidebar list. An absolute position, not a step. */
  | { type: "move-workspace"; workspaceId: string; index: number }

  // --- profiles ------------------------------------------------------------
  | { type: "new-profile"; name: string }
  /** What you switch away from keeps running; one server owns every profile's ptys. */
  | { type: "switch-profile"; profileId: string }
  | { type: "rename-profile"; profileId: string; name: string }
  | { type: "delete-profile"; profileId: string }

  /**
   * Put the server back on current source. It owns no ptys, so this costs a
   * reconnect and a repaint — the agents are in the pty host next door and the
   * arrangement is handed back by it. Ghosttown's prefix+B, minus the casualties.
   */
  | { type: "restart-server" }

  /** Open a proxy for this dev server so a phone can reach it. */
  | { type: "open-preview"; port: number }

  /**
   * Change what the working badge animates. A verb like everything else here:
   * Settings does not hold a config and post it back, it says *this is the
   * selection now* and reads the snapshot that follows. Which is what lets a
   * second window — or a phone — see the change without being told separately,
   * and what makes the file on disk worth writing.
   */
  | { type: "set-mascot"; mascot: MascotConfig };

/**
 * How often the status heuristic is asked to notice that work has stopped.
 * Output arrives as events, but *silence* does not, so end-of-work needs a tick.
 */
export const STATUS_TICK_MS = 500;
/**
 * Output is coalesced and flushed at most this often — one frame at 60Hz. A pty
 * mid-build emits thousands of writes a second, and a WebSocket message each
 * would spend more time framing than the terminal spends drawing. Low enough
 * that typing still feels direct.
 */
export const OUTPUT_FLUSH_MS = 16;
/**
 * How long the arrangement sits still before it is written to disk. Dragging a
 * divider changes it sixty times a second; only the last one is worth a write.
 */
export const SAVE_DEBOUNCE_MS = 1000;
/** How often the process table is re-read to see which agent is running where. */
export const AGENT_SCAN_MS = 2000;
/** How often it re-scans for listening dev servers. Slowest: it shells out twice. */
export const DEV_SCAN_MS = 3000;
