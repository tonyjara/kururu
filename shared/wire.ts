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
import type { MascotConfig, PtyKind, SessionSnapshot } from "./model";
import type { LaunchSettings } from "./launchers";
import type { NotifyEvent, NotifySettings } from "./notify";
import type { TerminalAppearance } from "./theme";

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

/**
 * Whether this server can be reached from anywhere but the machine it is on, and
 * the secret that makes that safe — the rest of the answer to `GET /api/reach`.
 *
 * Kururu has no accounts and never will; what it has is one token, minted once
 * and carried in the QR code, so the phone that scanned it is in and the laptop
 * on the same café Wi-Fi is not. It rides in the `Reach` answer because it is
 * the same question asked twice — "how do I get to this from my phone" and "is
 * anybody allowed to" are one sentence to the person in front of the dialog, and
 * splitting them across two fetches would let the dialog draw a QR code for a
 * server that is not listening on that address at all.
 *
 * The token is deliberately *not* in the snapshot. A snapshot goes to every
 * client on every change and is written to disk by nothing, but it is also the
 * thing most likely to end up in a screenshot of a bug report; a secret should
 * be somewhere it is fetched on purpose, by the one dialog that draws it.
 */
export interface Sharing {
  /** What the socket is doing. False when bound to loopback, which is the default. */
  shared: boolean;
  /**
   * What was *chosen*, which is the same thing except in the window between
   * pressing the button and the server coming back — the bind address is fixed
   * when the socket opens. The two differing is the whole of "a restart is
   * owed", and is why this is a second field rather than a nullable first one.
   */
  wanted: boolean;
  /** The token a client that is not on this machine has to present. */
  token: string;
  /**
   * Whether flipping `shared` will actually take effect by itself. The bind
   * address is fixed when the socket is opened, so changing it needs the server
   * started again — which is free, and something a supervisor does, and
   * therefore something that may not be available. The dialog says which.
   */
  restartable: boolean;
}

/**
 * What `GET /api/update` answers: whether there is a newer kururu than the one
 * you are looking at.
 *
 * Fetched rather than pushed, because this is the world's state and not
 * kururu's: it changes when somebody publishes a release rather than when
 * anything here happens, and answering costs a request to GitHub that should be
 * made when somebody asks and not on a timer.
 *
 * `error` and `newer: false` are different answers and the dialog must not
 * collapse them. "You are up to date" and "I could not find out" are the same
 * picture and opposite facts, and only one of them means you can stop thinking
 * about it.
 */
export interface UpdateCheck {
  /** The running server's version, or `0.0.0-dev` for a checkout. */
  current: string;
  /** The newest published release, without its leading `v`. Null if unknown. */
  latest: string | null;
  newer: boolean;
  /** The release body — the changelog section for that version, as markdown. */
  notes: string | null;
  /**
   * The same notes as markup. Rendered by the server for the reason everything
   * else is — `markdown.ts` is server-side so that a phone is handed markup
   * rather than a parser, and release notes are not the place to make a second
   * arrangement. Null when there are no notes or when rendering them failed,
   * which the dialog draws as the raw text rather than as nothing.
   */
  notesHtml: string | null;
  url: string | null;
  checkedAt: number;
  /** Why there is no answer, in a sentence a person can read. */
  error: string | null;
}

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

/**
 * The branch a workspace is on.
 *
 * Live and per-workspace: it is learnt by looking at the disk rather than
 * decided by anything kururu owns, it changes without kururu being told, and
 * nothing about it is worth remembering across a restart. Two workspaces open on one checkout get one entry each
 * saying the same thing, which is correct — they are both on that branch.
 *
 * Absent rather than empty when a workspace is not in a repository, so the row
 * draws nothing instead of drawing a blank where a branch goes.
 */
export interface WorkspaceBranch {
  workspaceId: string;
  /** The working tree's root — the directory holding `.git`. */
  root: string;
  /** The branch, or a short sha when `detached`. */
  branch: string;
  /** HEAD names a commit rather than a branch: a tag, a sha, or a rebase. */
  detached: boolean;
}

/**
 * The directory a workspace's file tree is rooted at.
 *
 * The repository the workspace is in when it is in one, and otherwise the
 * directory its focused terminal is standing in. A repository rather than a cwd
 * because a terminal that has `cd`'d into `server/src` is still working on the
 * whole project, and a tree that shrank to wherever you last stood would be a
 * tree you kept climbing out of.
 *
 * Found by the server, from terminals it holds, and allowed as a root there —
 * so it is also the answer to "may the tree read this": a client never names a
 * root it was not first handed.
 */
export interface WorkspaceProject {
  workspaceId: string;
  root: string;
}

/**
 * An nvim the file tree could open a file in: which terminal it is running in,
 * and the pane that terminal is a tab of.
 */
export interface EditorChoice {
  agentId: string;
  paneId: string;
}

/**
 * One allowance, as the account itself reports it.
 *
 * Deliberately the shape the API states rather than three named fields, because
 * the set of limits is the account's business and changes without asking us: a
 * plan with a per-model weekly cap sends a third entry, one without sends two,
 * and a version of this that read `session` and `weekly` out of named keys would
 * silently stop drawing the cap that was actually about to bite. So the client
 * draws the list it is handed, whatever is in it.
 *
 * `severity` is the account's judgement and not a threshold kururu picked. That
 * matters more than it looks: "80% is amber" is a rule we would have invented,
 * and it would disagree with the warning Claude Code itself prints at exactly
 * the moment the two are on screen together.
 */
export interface UsageLimit {
  /** `session`, `weekly_all`, `weekly_scoped` — and whatever is added next. */
  kind: string;
  /** Which clock it is on, so the client can group without parsing `kind`. */
  group: string;
  /** How much is spent, 0–100. The bar draws it as it stands. */
  percent: number;
  /** `normal` | `warning` | `critical`, straight from the account. */
  severity: string;
  /** ISO 8601, or null for a limit with no clock of its own. */
  resetsAt: string | null;
  /** The model a scoped limit is scoped to — "Opus", "Fable". Null when it is not. */
  scope: string | null;
}

/**
 * What the machine's Claude account has spent.
 *
 * One account and not one per profile. A profile is a drawer of workspaces and
 * nothing else — it has no login of its own to be measured against — so there is
 * exactly one allowance here. A machine can still hold several Claude logins, one
 * per `CLAUDE_CONFIG_DIR`, and the one measured is whichever was signed into
 * last; `email` is there so the bar can say whose it is, because two accounts'
 * percentages look exactly alike.
 *
 * `stale` rather than dropping the reading on a failed poll. A bar that empties
 * because the wifi dropped is worse than a bar that admits it is a minute old:
 * the number it was showing is still the best thing known, and the one thing it
 * must not do is look current when it is not.
 */
export interface AccountUsage {
  limits: UsageLimit[];
  /** When this reading was actually taken, not when it was sent. */
  at: number;
  /** The last fetch failed; these are the numbers from before it. */
  stale: boolean;
  /** No usable login on this machine — nothing to show and nothing wrong. */
  signedOut: boolean;
  /** Whose allowance this is, as Claude Code recorded it, or null if it did not. */
  email: string | null;
}

/**
 * One notification, composed by the server and ready to draw.
 *
 * The text is composed *there* and not here, and it is worth saying why, since
 * the client has a snapshot and could do it itself. It could not: the snapshot
 * holds the active profile's agents only, and the notifications worth having are
 * mostly from the profile you are not looking at. `notifyText` in
 * `shared/notify.ts` is what writes these two strings.
 */
export interface Notification {
  /** Where clicking it goes. See `reveal-agent`. */
  agentId: string;
  /** Which transition raised it, so the client can tell two cards apart. */
  event: NotifyEvent;
  /** The headline: which terminal, and what changed. */
  title: string;
  /** What it wants, then where it is. Empty when there is nothing to add. */
  body: string;
}

export type ServerMessage =
  /** Sent on connect and whenever anything about any agent changes. Complete, never a delta. */
  | { type: "snapshot"; snapshot: SessionSnapshot }
  /** Sent on connect and whenever the set of listening dev servers changes. */
  | { type: "dev-servers"; servers: DevServer[] }
  /**
   * Sent on connect and whenever any workspace's branch changes. A whole list
   * rather than a delta for the snapshot's reason: there are never more than a
   * handful, and a client that has just reconnected must not have to work out
   * what it missed.
   */
  | { type: "branches"; branches: WorkspaceBranch[] }
  /** Where each workspace's file tree starts. Sent whole, like `branches`. */
  | { type: "projects"; projects: WorkspaceProject[] }
  /**
   * Sent on connect and whenever the allowance moves. Null while nothing has
   * ever been read successfully — which is not the same as `signedOut`, and the
   * sidebar draws neither.
   */
  | { type: "usage"; usage: AccountUsage | null }
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
  /**
   * Something wants a human, and this client is one of the ones that should be
   * told.
   *
   * The only message here that is not about state. Everything else says what
   * *is* — and a notification is an event: it happens once, it is stale a
   * heartbeat later, and a client that reconnects and finds it has missed one
   * has missed nothing worth resending. Which is exactly why it cannot be a
   * field on the snapshot: the snapshot goes out several times a second and is
   * complete, so an agent that finished would keep on having finished, and the
   * card would be raised again on every tick for as long as the status held.
   *
   * Addressed rather than broadcast, and that is the other half. The gate in
   * `shared/notify.ts` asks whether *this* client has the terminal on screen,
   * which is a different answer for the desktop showing it and the phone in
   * your pocket — the same reason `watch` carries what a client can see rather
   * than the server assuming one answer for everybody. Everything has already
   * been decided by the time this is sent: the client plays the sound and draws
   * the card, and applies no policy of its own.
   */
  | { type: "notify"; notification: Notification }
  /** Answer to any client message carrying an `id`. */
  | { type: "reply"; id: number; ok: true; result: unknown }
  | { type: "reply"; id: number; ok: false; error: string };

export type ClientMessage =
  // --- terminals -----------------------------------------------------------
  /**
   * Start a terminal and put it in a pane as a new tab. Every field defaults:
   * the focused pane, that pane's project, an agent rather than a shell.
   *
   * `launcher` is an id from `shared/launchers.ts` — an agent on a model, picked
   * from the new-tab menu — and the server turns it into the command. It wins
   * over `command` and `kind` when both are sent.
   */
  | {
      type: "new-tab";
      id: number;
      kind?: PtyKind;
      cwd?: string;
      command?: string;
      launcher?: string;
      paneId?: string;
    }
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
  /**
   * Dropped on another row of the sidebar's agent list: put this terminal above
   * that one, or at the end when `beforeAgentId` is null.
   *
   * It rearranges the *list* and nothing else — the terminal stays in the pane
   * and the workspace it was in, which the row it is drawn in goes on saying.
   * The two verbs above are the ones that move it.
   */
  | { type: "reorder-agent"; agentId: string; beforeAgentId: string | null }
  /**
   * Put a terminal away in the sidebar's list, or bring it back.
   *
   * The state and not a toggle, because two clients are the normal case here:
   * a phone and a desktop drawing the same list, and a toggle arriving from one
   * while the other was mid-tap is a row that ends up in whichever state the
   * race decided. The button knows which state it is asking for; asking for it
   * is free and cannot disagree with itself.
   *
   * It hides a *row*. The pty is untouched, the tab is untouched, and
   * `close-tab` above remains the only verb in here that ends anything.
   */
  | { type: "hide-agent"; agentId: string; hidden: boolean }
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
   * Whether anybody is in front of this client at all.
   *
   * `watch` says which terminals are on screen; this says whether the screen
   * is. They are not the same question and the second has no answer in the
   * first: a phone locked in a pocket has exactly the panes it had a moment
   * ago and a human reading none of them, and it goes on saying so for as long
   * as its socket lives — which is a long time, because a sleeping phone is
   * deliberately never hung up on and nothing here pings.
   *
   * What that cost was the desktop. The size policy is a minimum over the
   * clients that can see a terminal, so a phone that had been looking at one
   * held every other client down to phone width until its socket eventually
   * died — and walking back to the window did not undo it, because nothing
   * there had moved and a pane only proposes when its box does.
   *
   * So it gates the vote and nothing else. The proposals are *kept* rather
   * than withdrawn: a page that goes away and comes back has the same panes at
   * the same sizes, and a client that had to be re-measured before it could
   * speak again would spend the first frame of every return at somebody else's
   * shape. Deliberately not folded into `watch`, which would be the
   * one-message answer and is the wrong one — `watching` also decides the
   * unread mark and suppresses a notification card, and a frozen page cannot
   * draw a card, it queues them and raises the lot on unlock. Reaching a phone
   * with its screen off is push's job, not this one's.
   */
  | { type: "looking"; looking: boolean }
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
  /**
   * The other pane: back where focus came from, and the next one along when
   * there is no back yet. A toggle rather than a walk, the way `last-workspace`
   * is one level up — it is what a phone flips between two agents with, since a
   * narrow window draws one pane at a time.
   */
  | { type: "last-pane" }
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
   * Point a profile at one of the logins kururu holds — a key out of
   * `SessionSnapshot.logins`, which is the only place one may come from — or,
   * with null, at a fresh directory of its own that nobody is signed into. Two
   * profiles on one key share the directory and everything in it, and that is
   * the feature: the same account, the same settings, the same memory.
   *
   * Only terminals opened afterwards are affected. A running pty was spawned
   * with its directories in its environment and keeps them; nothing here can
   * or should reach into it.
   */
  | { type: "set-profile-login"; profileId: string; loginKey: string | null }

  /**
   * Put the server back on current source. It owns no ptys, so this costs a
   * reconnect and a repaint — the agents are in the pty host next door and the
   * arrangement is handed back by it. Ghosttown's prefix+B, minus the casualties.
   */
  | { type: "restart-server" }

  /**
   * Go to that terminal, wherever it is: switch profile, switch workspace, focus
   * the pane, select the tab.
   *
   * Sent by a click on a notification, and it is one verb rather than the four
   * the client could have sent instead. Four would have to be sent in order,
   * against a layout the sender is by definition not looking at — the whole
   * point of the card is that the agent is somewhere else — and any of them
   * arriving after the tree has moved would land somewhere nobody asked for. The
   * server is holding the arrangement and can do all four against one state,
   * which is the same argument every other verb in here makes.
   *
   * It is deliberately not restricted to the profile this client is in. That is
   * the feature: an agent blocked in the profile you left is exactly the one you
   * cannot see and most need taking to.
   */
  | { type: "reveal-agent"; agentId: string }

  /*
   * There was an `open-preview` here, carrying a port, and it is worth saying
   * why there is not one now rather than leaving the gap to be refilled.
   *
   * It was how a client asked for a proxy, back when one was opened on demand.
   * `pollDevServers` opens one for every dev server it finds instead — a link
   * needs a real `href` before anybody taps it, which is the whole argument
   * written out beside that loop — so by the time any client could have asked,
   * the answer was already in the snapshot as `proxyPort`. The verb went on
   * existing with nothing calling it.
   *
   * That is not free. A port on a `ClientMessage` is a port kururu was told,
   * not one it found, and `openPreview` binds `0.0.0.0` — so the dead verb was
   * a way for one unauthenticated message to put a listener on every interface
   * this machine has, forwarding to any loopback port it named. Loopback-only
   * services are loopback-only precisely because they are unauthenticated, and
   * this reached past the tailnet onto whatever network the laptop was on.
   *
   * `devservers.ts` states the rule it broke: ports come from the kernel, never
   * from a command line — or, here, from a client. If the preview *pane* ever
   * needs a verb, it should name a dev server kururu has already discovered,
   * never a number.
   */

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
   *
   * `focus` moves the focus onto the reader instead of leaving it where it was,
   * and it is the client's to decide because it is a fact about the window
   * rather than about the layout. On a desktop the reader lands *beside* the
   * editor and taking the keyboard away from what you were typing into would be
   * wrong; on a phone only the focused pane is drawn at all, so a reader you
   * asked for and cannot see is a reader that did not open.
   */
  | { type: "open-reader"; paneId?: string; agentId?: string; focus?: boolean }

  /**
   * Point a reader at a file somebody chose, and stop following an editor.
   *
   * The unfollowing is not a separate decision the caller gets to make: a file
   * you picked by hand that the next `:w` on another machine could replace is a
   * document that walks away mid-sentence. Picking *is* pinning, which is what
   * `pin-reader` already means — this is the other half of it, the half that
   * says which file to pin to.
   *
   * `root` is one of the roots the server already holds. A client naming a root
   * of its own is the one thing `files.ts` exists to refuse, so this is checked
   * there like every other path that arrives from outside.
   */
  | { type: "open-doc"; paneId: string; root: string; path: string }

  /**
   * Stop following an editor and sit on the file it is showing now.
   *
   * The reader is mostly worth having *because* it follows, so this is not the
   * common case — it is for the moment you want to read one file while the
   * editor goes somewhere else, and it is reversible by asking again.
   */
  | { type: "pin-reader"; paneId: string; follow: boolean }

  /**
   * Show, or close, one of a reader's tabs, by its place in the strip.
   *
   * An index rather than a path, for the reason tabs of terminals go by id: the
   * client is naming a thing it can see, and the server already holds the list
   * it is an index into — a path would be a second way to name a file that has
   * to be checked all over again for a click that opens nothing new. Closing
   * the last one closes the pane.
   */
  | { type: "select-doc"; paneId: string; index: number }
  | { type: "close-doc"; paneId: string; index: number }

  /**
   * A reader's tab, dragged: onto a reader's strip, at a place in it — its own
   * strip is a reorder — or onto a pane's edge, where it becomes a reader of
   * its own. `move-tab` and `split-with` for documents, kept apart from them
   * because a terminal is named by an id the whole server knows and a document
   * is named by its place in one pane's list.
   */
  | { type: "move-doc"; fromPaneId: string; index: number; toPaneId: string; at?: number }
  | { type: "split-with-doc"; fromPaneId: string; index: number; paneId: string; dir: "row" | "col"; before: boolean }

  /**
   * Show a markdown file, from the file tree.
   *
   * The server picks the pane rather than the client, because "the reader" is a
   * question about the arrangement: the focused pane if it is a reader, else any
   * reader in the workspace, else a new one split off the focused pane. A client
   * that chose would have to send a split and then an `open-doc` to a pane id it
   * had not seen yet. `focus` is `open-reader`'s — a phone wants to be taken to
   * the document, a desktop wants its keyboard left where it was.
   */
  | { type: "show-doc"; root: string; path: string; focus?: boolean }

  /**
   * Every nvim in the workspace on screen, nearest first — the focused pane's,
   * then the pane focus came from, then the rest. Replied to with
   * `EditorChoice[]`, which may be empty.
   */
  | { type: "find-editors"; id: number }

  /**
   * Open a file from the tree in nvim.
   *
   * `agentId` names the terminal whose nvim to use, from a `find-editors`
   * answer; null asks for a new one, in a split off the focused pane. Either way
   * the pane it lands in is focused, because a file opened somewhere you are not
   * looking has not been opened as far as you can tell. Replied to with the
   * agent id it went to.
   */
  | { type: "open-in-editor"; id: number; root: string; path: string; agentId: string | null }

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
   * Which shape the window is, which is a separate decision from which colours
   * — see `shared/skin.ts`. An id for `set-theme`'s reason, and doubly so here:
   * a skin's tokens include a `font-family` and a `box-shadow`, so a message
   * carrying them would be a client on the tailnet writing CSS values into the
   * root element of every other client looking at this server.
   *
   * Changing it **does** re-measure every terminal, which is the one way this
   * differs from `set-theme`: a skin moves the line weight and the type, and
   * both move the box a pty is sized to. That resize goes through the same
   * settle a dragged divider does, for the same reason.
   */
  | { type: "set-skin"; skinId: string }
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
  | { type: "set-terminal-appearance"; terminal: TerminalAppearance }

  /**
   * When kururu may interrupt you, and what it sounds like — all five fields at
   * once, on `set-terminal-appearance`'s reasoning: they are one decision and
   * they are edited on one page.
   *
   * A verb like the rest, so the choice reaches the phone as well as the window
   * that made it. The *sound* is the interesting one to think about here: what
   * travels is an id, and the id is resolved against `/System/Library/Sounds` on
   * the machine running the server. A phone has never heard of that directory
   * and gets the sound anyway, because it fetches the bytes from `/api/sound`
   * like it fetches everything else.
   */
  | { type: "set-notify"; notify: NotifySettings }
  /**
   * Which agents and models the new-tab menu offers. Server-owned like the rest
   * of Settings, so the phone's menu is the desktop's menu.
   */
  | { type: "set-launch"; launch: LaunchSettings };

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
/**
 * How often each workspace's `.git/HEAD` is re-read.
 *
 * Faster than the other two because it is by far the cheapest — one small file
 * read per workspace, no subprocess and no socket — and because it is the one
 * of the three that a person changes *deliberately* and then immediately looks
 * at. A branch that took five seconds to catch up would be caught out every
 * time somebody checked out and glanced at the sidebar to confirm it.
 */
export const GIT_SCAN_MS = 4000;
/**
 * How often each profile's allowance is asked for. Slowest of the lot by two
 * orders of magnitude, and the only poll in kururu that leaves the machine.
 *
 * A minute is not a compromise between freshness and politeness — it is the
 * resolution of the thing being measured. The session window is five hours and
 * the weekly one is seven days, so a percentage that is sixty seconds old is
 * indistinguishable from a current one at every width this bar is ever drawn.
 * Polling faster would buy a number nobody could see change, against somebody
 * else's API.
 */
export const USAGE_POLL_MS = 60_000;
