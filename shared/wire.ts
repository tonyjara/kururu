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
 * and the *size* of the grid is the server's to decide. Three consequences
 * worth naming:
 *
 *  - `watch` takes two *sets*. Panes are tiled, so several terminals are visible
 *    at once and all of them want their bytes — and the client keeps emulators
 *    for terminals it is not showing, which want theirs too or they go stale.
 *  - A pane does not resize a terminal, it *proposes* a size. A pty has one
 *    shape and there can be several clients, so the server collects the
 *    proposals, picks one, resizes the pty, and tells every client what the
 *    shape now is. The client's emulator changes size when it is told and at no
 *    other time, which is what makes the two grids unable to disagree — and
 *    every borked screen kururu has had was that disagreement.
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
import type { Action } from "./keys";
import type { MascotConfig, ProfileIdentity, PtyKind, SessionSnapshot } from "./model";
import type { TerminalAppearance } from "./theme";

/**
 * Who a profile's terminals open as: what `claude` and `gh` and `git` say when
 * they are asked with that profile's environment. The reply to `/api/identity`.
 *
 * A fetch rather than part of the snapshot, because unlike everything else a
 * profile holds this is not kururu's state — it is the world's. It changes when
 * somebody logs in inside a terminal the server is only watching, and answering
 * it means running three CLIs. Null for a tool that could not be asked at all,
 * which covers not-installed and timed-out alike: both mean the page cannot say.
 */
export interface IdentityWho {
  claude: { loggedIn: boolean; email: string | null; org: string | null; plan: string | null } | null;
  gh: GhAccount | null;
  git: { name: string | null; email: string | null } | null;
}

/** One github account as gh describes it. `active` is true of one per directory. */
export interface GhAccount {
  host: string;
  login: string;
  /** gh's own word for whether the token still works; "success" when it does. */
  state: string | null;
  gitProtocol: string | null;
  active: boolean;
}

/**
 * What there is to pick between — the reply to `/api/identity/known`.
 *
 * Accounts, not directories, because an account is the thing somebody has in
 * mind and a directory is only how kururu stores the choice. The asymmetry
 * between the two lists is the tools': gh knows a login before any directory
 * exists, so an account can be named and its directory written when it is
 * picked; a Claude account has no name until somebody has logged into a
 * directory, so there the directory comes first and the email is what is found
 * in it. `dir: null` is the machine's own `~/.claude`.
 */
export interface KnownAccounts {
  claude: { dir: string | null; email: string | null; org: string | null }[];
  gh: KnownGhAccount[];
}

/**
 * A github account, plus where a profile gets pointed to use it.
 *
 * The directory is named after the account and written on first use, which is
 * what lets the client tell which option is selected by comparing strings rather
 * than waiting to be told — and what makes two profiles picking one account
 * share one directory instead of accumulating copies.
 */
export interface KnownGhAccount extends GhAccount {
  dir: string;
}

/**
 * How to reach this server from a device that is not this machine — the answer
 * to `GET /api/reach`, and the only part of the protocol that is not about
 * agents.
 *
 * It is a fetch rather than a field of the snapshot, and that is the one
 * decision in it. The snapshot is pushed because everything in it changes while
 * you are looking at it; this changes when somebody joins a different Wi-Fi or
 * brings tailscale up, which is not something the server has any way to be told
 * about — it would be a poll, running forever, to keep a value nothing displays
 * except a dialog that is almost never open. So the dialog asks, and goes on
 * asking while it is open. See `server/src/reach.ts`.
 */
export interface Reach {
  /** The port the kururu server itself is listening on. */
  port: number;
  /** Private addresses on this machine's own networks, likeliest first. */
  lan: string[];
  /** The tailnet address, or null when tailscale is not up. */
  tailscale: string | null;
}

/** How often the dialog re-asks, so tailscale coming up shows without a reload. */
export const REACH_POLL_MS = 3000;

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
   * The grid this terminal is being drawn at. The server decided it, the pty has
   * already been told, and the client's emulator becomes this shape.
   *
   * It is an instruction rather than a notification, and that inversion is the
   * whole of the sizing rework. A pane used to fit its emulator to its box and
   * inform the pty afterwards, which made the size whichever client resized
   * last — so a second client of another width made the first one ragged, the
   * server's single screen had to be reshaped to each client's guess before it
   * could be serialized, and the client and the pty could believe different
   * things about where a row ends. They cannot now: there is one size, the
   * server owns it, and this message is how anybody learns what it is.
   *
   * Sent to every client that is being streamed this terminal, warm ones
   * included — a pooled emulator off screen is still being fed bytes an agent
   * laid out for the pty's grid, so it has to be that grid.
   */
  | { type: "grid"; agentId: string; cols: number; rows: number }
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
   * They survive the server owning the size, and deliberately. The size is no
   * longer in *question* — a `grid` saying the same thing has almost always
   * already gone out — but a backlog is the one message whose correctness
   * depends on the shape it is written into, and a screen that states its own
   * shape cannot be desynchronised by anything. It also covers the one ordering
   * a single authoritative size does not: a resize landing while this one was
   * being serialized, where the answer names the shape the *host* used and a
   * second `grid` follows it.
   */
  | { type: "backlog"; agentId: string; data: string; cols: number; rows: number }
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
   * The grid this client's pane *could* draw that terminal at. A proposal, not
   * a resize: the server collects them and decides.
   *
   * It was a resize, and the pane applied it to its own emulator on the way
   * past. That made the size last-writer-wins, which is fine with one window and
   * is why a phone made the desktop ragged — and, worse, meant the client and
   * the pty could hold different ideas of the shape at once, which is the
   * disagreement underneath every screen kururu has ever drawn wrong. tmux
   * settled this in the 1990s with `window-size`; the policy here is its
   * `smallest`, over the clients that have the terminal *visible*, so a phone
   * and a desktop watching one agent both see a correct screen rather than take
   * turns making each other wrong.
   *
   * A proposal is withdrawn by a `watch` that no longer lists the terminal as
   * visible — the same message that already says what a human can see, rather
   * than a second one that could disagree with it. So a warm client, which is
   * keeping an emulator current and showing nobody anything, never has a say in
   * the size; and a terminal no client can see keeps the shape it had rather
   * than being resized to nothing.
   */
  | { type: "propose-size"; agentId: string; cols: number; rows: number }
  /**
   * What this client has on screen, and what it is keeping an emulator for
   * without showing it. Both are sets: panes are tiled, and emulators are
   * pooled. Re-sent after a reconnect — the server keeps no memory of a socket
   * that went away.
   *
   * Two fields rather than one because the server answers two questions with
   * them and only one of the answers is their union. What to *stream* is the
   * union: a pooled emulator that stops being fed goes stale, and a stale one
   * has to be reconstructed, which is the thing pooling exists to stop happening
   * during ordinary navigation. What counts as *unread* is `agentIds` alone —
   * the mark means "output arrived where nobody was looking", and an emulator
   * kept warm in a workspace you are not in is nobody looking.
   *
   * `warm` is optional so a client that has not been updated still watches
   * exactly as it did; an absent warm set is an empty one.
   */
  | { type: "watch"; agentIds: string[]; warm?: string[] }
  /**
   * Rebuild this terminal. The only thing that produces a `backlog`.
   *
   * It used to name a size, and to carry an `epoch` so that an answer could be
   * matched to the emulator that asked. Both were consequences of the client
   * owning the shape: two panes of two widths asked two different questions
   * about one terminal, and each had to be answered without wrecking the other.
   * There is one shape now and the server knows it, so there is one answer, and
   * an answer that states the grid it used is correct for whoever receives it.
   *
   * What it still is not is `watch`. Watching says which terminals are on
   * screen and starts their bytes flowing; this says *I have nothing in my
   * emulator*, which only an emulator that has just been built can know. A
   * first borrow, one that was evicted and came back, and a reconnect are the
   * three ways that happens — a tab switch and a workspace change are not among
   * them, which is the point of pooling emulators at all.
   *
   * It is sent immediately after a `propose-size` for the same terminal, and
   * `web/src/session.ts` sends the two together so it cannot be otherwise: the
   * shape has to be established before a screen is laid out in it.
   */
  | { type: "request-backlog"; agentId: string }

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
  /**
   * Give a workspace its own mascot, or `null` to hand it back to the default.
   * An id rather than a config, so changing a mascot changes it everywhere it is
   * used rather than in one copy of it — and an id naming nothing reads as the
   * default, which is what makes deleting a mascot need no cleanup.
   */
  | { type: "set-workspace-mascot"; workspaceId: string; mascotId: string | null }
  /**
   * The ▸ / ↻ on a workspace row: get this workspace's dev server serving fresh.
   *
   * One verb rather than a start and a restart, because it is one intention and
   * the client is the wrong side to decide between them — the button's face
   * comes from a scan that is up to three seconds old, and a server that came up
   * in the meantime should be restarted rather than started twice. So the client
   * says what it wants and the server looks: something serving is interrupted
   * and re-run, nothing serving is started from what the workspace remembers,
   * and a workspace that has never had one does nothing (and draws no button).
   *
   * It deliberately does not switch workspace. Starting your app somewhere else
   * is not a reason to be taken there.
   */
  | { type: "run-dev"; workspaceId: string }
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
   * Which accounts this profile's terminals are opened as — see
   * `ProfileIdentity`, which is three paths and deliberately not three secrets.
   *
   * The whole identity rather than one field at a time, for the reason
   * `set-terminal-appearance` gives: they are edited together on one page and a
   * per-field verb would make that page send three messages to describe one
   * decision. Adopted rather than trusted on arrival — a path that is not
   * absolute is dropped rather than resolved, because a relative one would mean
   * a different directory in every pane.
   *
   * It reaches the pty at spawn and at no other time, so this changes the next
   * terminal in the profile and none of the ones already in it.
   */
  | { type: "set-profile-identity"; profileId: string; identity: ProfileIdentity }
  /**
   * Use a github account that already exists, named rather than located.
   *
   * The server writes the five lines of config that make a directory mean that
   * account and points the profile at it, which is the half a client cannot do
   * — and should not: a client that sent a path would be a client that could
   * send any path, and this one is reachable from the tailnet. Null hands the
   * profile back to whatever gh itself is set to.
   */
  | { type: "use-gh-account"; profileId: string; account: { host: string; login: string } | null }
  /**
   * Sign in to a new account for this profile, which is not something a dialog
   * can do: both flows are a browser, a code to paste and a few questions. So it
   * is done the way the dev-server button does its job — by opening a terminal
   * and typing the line a person would type — in the profile it is about, so
   * that what happens next is on screen rather than in a pane somewhere else.
   */
  | { type: "sign-in"; profileId: string; tool: "claude" | "gh" }

  /**
   * Put the server back on current source. It owns no ptys, so this costs a
   * reconnect and a repaint — the agents are in the pty host next door and the
   * arrangement is handed back by it. Ghosttown's prefix+B, minus the casualties.
   */
  | { type: "restart-server" }

  /** Open a proxy for this dev server so a phone can reach it. */
  | { type: "open-preview"; port: number }

  // --- the reader ----------------------------------------------------------
  /**
   * Split a reader off the pane a terminal is in, and point it at that
   * terminal's editor.
   *
   * It splits rather than replacing, because the pane you asked from is the one
   * with the editor in it and taking that away to show the file would be a
   * strange reading of "show me this". `paneId` is the pane to split; `agentId`
   * is whose nvim to follow, and with neither the focused pane and its showing
   * terminal are used, which is what the keybinding sends.
   *
   * A pane that is already a reader is re-pointed rather than split again: the
   * second press of a key that made a pane should not make another one.
   */
  | { type: "open-reader"; paneId?: string; agentId?: string }

  /**
   * Stop following an editor and sit on the file it is showing now.
   *
   * The reader is mostly worth having *because* it follows, so this is not the
   * common case — it is for the moment you want to read one file while the
   * editor goes somewhere else, and it is reversible by asking again.
   */
  | { type: "pin-reader"; paneId: string; follow: boolean }

  // --- the mascot ----------------------------------------------------------
  /**
   * Change one saved mascot. A verb like everything else here: Settings does not
   * hold a config and post it back, it says *this is the selection now* and reads
   * the snapshot that follows. Which is what lets a second window — or a phone —
   * see the change without being told separately, and what makes the file on
   * disk worth writing.
   *
   * It names the one it is editing rather than meaning "the current one",
   * because two windows can be open and the other one may have switched between
   * you picking a cell and the message arriving.
   */
  | { type: "set-mascot"; id: string; mascot: MascotConfig }
  /** Keep another. A copy of `from` when there is one, so a variation starts from the thing it varies. */
  | { type: "add-mascot"; from?: string }
  /** Forget one. The last one cannot go: a working row must always have something in it. */
  | { type: "remove-mascot"; id: string }
  | { type: "rename-mascot"; id: string; name: string }
  /**
   * Which one a workspace gets when it has not picked. The frog is what kururu
   * ships with, not what you are stuck with.
   */
  | { type: "set-default-mascot"; id: string }

  // --- the keyboard --------------------------------------------------------
  /**
   * Rebind one key, or unbind it with `null`. One key rather than a whole map,
   * for the same reason a split is a verb: the gesture is "this key does that
   * now", and a client that posted an entire keymap would be holding one.
   *
   * What gets stored is the difference from the defaults, which is what stops a
   * saved keyboard from freezing kururu's keys at the version you first opened
   * Settings in. See `shared/keys.ts`.
   */
  | { type: "bind-key"; key: string; action: Action | null }
  /** Back to ghosttown's table, exactly. Deletes the overrides rather than writing them out. */
  | { type: "reset-keys" }

  // --- how it looks --------------------------------------------------------
  /**
   * Wear a different theme. An id from `shared/theme.ts` and nothing else — the
   * server refuses anything it does not recognise, which is `set-workspace-color`'s
   * rule and is here for a stronger version of the same reason: a palette is not
   * eight values in a style attribute, it is forty, and kururu is reachable from
   * the tailnet.
   *
   * An id rather than the tokens, so that a theme improved in a later version
   * improves for everybody who picked it instead of leaving them on a copy taken
   * the day they chose.
   */
  | { type: "set-theme"; themeId: string }
  /**
   * The type a terminal is set in, and the shape of its cursor. A whole
   * `TerminalAppearance` rather than one field at a time, which is the one place
   * this protocol departs from "a message is a verb" — and deliberately: these
   * four are edited together on one page, they have no meaning apart, and a
   * per-field verb would make a Settings panel send four messages to describe
   * one decision.
   *
   * It is adopted rather than trusted on arrival. `fontSize` especially: it
   * decides the cell, the cell decides the grid a pane proposes, and the grid is
   * what every pty watching gets resized to — so a number typed too large is a
   * SIGWINCH into a shape no box has, and `adoptAppearance` clamps it.
   */
  | { type: "set-terminal-appearance"; terminal: TerminalAppearance };

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
