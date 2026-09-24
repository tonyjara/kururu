/**
 * What kururu knows about the agents it is running, and where they live.
 *
 * This replaces `ghosttown.ts`, which mirrored somebody else's protocol. Kururu
 * owns its ptys now, so these types are not a copy of anything and cannot drift
 * from a second source — they are the source.
 *
 * It was flat for a while, and the note here said a layout tree was geometry no
 * client had to learn. That was true of a window with one tab strip in it. It
 * stopped being true the moment panes tiled: a client that draws a layout has to
 * be told the layout, and the only question left was who owns it. The server
 * does — same as ghosttown's daemon — which is what makes an arrangement survive
 * a window reload, reach a second client, and be worth writing to disk.
 *
 * So the hierarchy is ghosttown's, on purpose and with the same words:
 *
 *   profile   a named session; a list of workspaces. Switching one swaps the
 *             whole window, and what you left keeps running.
 *   workspace one split tree, named. The thing prefix+1..9 jump between.
 *   pane      a leaf of that tree, holding tabs.
 *   tab       one terminal. An agent lives in exactly one.
 *
 * The one place kururu differs is what a profile *is* underneath. Ghosttown
 * gives each its own daemon; kururu has one server that owns every pty, so a
 * profile here is a namespace, not a process. The visible behaviour is the same
 * — and the agents in the profile you are not looking at are still running.
 */
import type { KeyOverrides } from "./keys";
import type { LayoutNode } from "./layout";
import type { LaunchSettings } from "./launchers";
import type { NotifySettings } from "./notify";
import type { StyleLibrary } from "./styles";
import type { Appearance } from "./theme";

/**
 * `idle`, `working` and `done` are inferred from output timing (agents/status.ts).
 * `blocked` is not inferable — nothing about the byte stream says "waiting for a
 * human" — so it only ever arrives from an agent that reports it (agents/report.ts).
 */
export type AgentStatus = "idle" | "working" | "blocked" | "done";

/**
 * What kururu was *asked* to start, which is not the same as what ended up
 * running in there. `agent` is "start me an agent"; `shell` is "give me a
 * terminal". They are the same machinery — a pty kururu owns — and the
 * distinction is only about what the user meant, which is why a shell someone
 * has since typed `claude` into reports `kind: "shell"` and `agent: "claude"`
 * at the same time. Both are true, and the sidebar shows the second one.
 */
export type PtyKind = "agent" | "shell";

/** How full an agent's context window is, in the two numbers it takes to say it. */
export interface ContextUsage {
  used: number;
  window: number;
}

export interface AgentSnapshot {
  /** Stable for the life of the pty. Every message about an agent is keyed on it. */
  id: string;
  /** What it was started as. See PtyKind: it says nothing about what is running. */
  kind: PtyKind;
  /**
   * What the program in here calls itself — the title it set with OSC 0 or 2,
   * put through `cleanTitle` on the way in. Null until something sets one,
   * which for a bare shell is usually never.
   *
   * This is a sentence about the *work*, not a name for the terminal, and it is
   * drawn where `activity` is drawn rather than where `agent` is: claude writes
   * a summary of the turn into its window title once it has had a prompt, and
   * it rewrites it every turn after that. A tab that renamed itself that often
   * would be a tab you navigate by position. So it is the second line of a
   * sidebar row, and the one line a tab has — see `agentSummary` in
   * `web/src/labels.ts`, which is what decides between this and `activity`.
   *
   * The two are siblings and arrive by different roads, which is the only
   * reason they are separate fields. `activity` needs a hook installed and is
   * the server's; this needs nothing at all and is the host's, because the byte
   * stream is the only place it exists and the emulator is already parsing it.
   *
   * It held the basename of `cwd` for a while and nothing ever drew it: the
   * project is on the line underneath and in the tooltip already, so a field
   * repeating it said nothing. The pty had been carrying the real answer the
   * whole time and there was nothing listening for it.
   */
  title: string | null;
  status: AgentStatus;
  /**
   * The agent program actually running in there right now — "claude", "codex" —
   * found by walking the process tree, not by trusting what we launched. A shell
   * that has not started one yet, or has exited back to a prompt, reports null.
   */
  agent: string | null;
  /** Output has arrived that nobody watching this agent has seen. */
  unread: boolean;
  cwd: string;
  /**
   * The pid on the end of the pty — the login shell, since a command runs under
   * one. It is here so the server can ask the kernel where that terminal *is*
   * now rather than where it was opened: a new tab should land in the directory
   * you cd'd to. Signalling stays the host's business; this is for reading.
   */
  pid: number;
  /** argv as launched, for a tooltip and for relaunching. */
  command: string;
  /** Wall clock at spawn. Sorting the tab strip by this keeps tabs from reordering. */
  createdAt: number;
  /** Only ever non-null if the agent reports it; see agents/report.ts. */
  contextUsage: ContextUsage | null;
  /**
   * What this agent last said it was doing, in whatever words it used — the
   * prompt it was handed, or the thing it is asking permission for. Reported,
   * never inferred: a terminal carries a picture of a turn, not a description
   * of one.
   *
   * Optional because, unlike everything above it, this does not come from the
   * pty host. The host knows nothing about it; the server holds it beside the
   * snapshot and merges it on the way out. That is deliberate — it is the only
   * field here that is *about* the work rather than about the process, it goes
   * stale the moment the work moves on, and keeping it on the restartable side
   * means improving it never costs anybody their agents. A server restart
   * forgets it, and the next report fills it in again.
   */
  activity?: string | null;
  /**
   * The agent program last seen in this pty, even if it is not there now — the
   * pty's memory of having been an agent, as opposed to `agent` above, which is
   * whether one is running in it this second.
   *
   * It exists because "is this an agent?" and "is an agent running in it right
   * now?" are different questions and the sidebar asks the first. Detection is a
   * poll of the process table, so `agent` blinks off whenever claude is between
   * things; a list filtered on it alone would drop rows and put them back, which
   * is worse than showing a shell. And an agent that has *exited* reports null
   * forever after, so filtering on `agent` would hide exactly the terminals whose
   * screen is the only record of what they said.
   *
   * Server-side, like `activity`, and for the same reason: it is accumulated from
   * snapshots the host already sends, so learning it costs no edit to the half
   * that owns the ptys. A restart forgets it and the next poll relearns it for
   * everything still running.
   */
  lastAgent?: string | null;
  /**
   * How much memory this terminal is holding, in bytes: the resident set of the
   * pty's own process and everything under it, added up. Null for a terminal
   * whose process could not be read, which is what an exited one looks like.
   *
   * Server-side like the three fields above it and for the same reason — it is
   * learnt from the process table rather than from a pty, so the half of kururu
   * that cannot be restarted never has to hear about it. What the number does
   * and does not cover (shared pages counted twice; compressed pages not counted
   * at all) is `server/src/memory.ts`'s business, and it is worth reading before
   * treating this as the truth about a machine.
   */
  rss?: number | null;
  /**
   * A name the user typed (rename-tab). Wins over everything else a tab could
   * be called, and unlike the detected program it is never overwritten.
   */
  titleOverride: string | null;
  /**
   * The pty has closed but the agent is still listed, because its screen is the
   * only record of what it said — including whatever it printed on the way out.
   * Killing it is what removes it from the list.
   */
  exited: boolean;
  exitCode: number | null;
}

/**
 * A title as the program meant it, with the part kururu already says better
 * taken off the front.
 *
 * Agents lead their own title with a status glyph and animate it: claude sits
 * at `✳ Merge pane-drag changes` and spins a braille frame in place of
 * the ✳ while it works. Two reasons that prefix comes off, and the second is
 * why this is a function and not a CSS rule. The dot beside the label is
 * already saying working, in a vocabulary the rest of the window shares. And a
 * title that changes ten times a second is a snapshot broadcast ten times a
 * second — stripping the frame first leaves a string that holds still, so the
 * host can compare it against the last one and stay quiet. The whole spinner
 * lives in the prefix; the words behind it change once a turn.
 *
 * Shared because the host cleans and the browser draws, and a title spelled two
 * ways is a tab and a sidebar row disagreeing about the same terminal. Capped
 * because this arrives from a program that can put anything it likes in there,
 * and a label is a label.
 */
export function cleanTitle(raw: string): string {
  return raw
    .replace(/^(?:[\p{So}\p{Sk}\p{Cf}\p{Mn}]+\s*)+/u, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/**
 * Which part of which sprite sheet the mascot is, and how fast it goes.
 *
 * The mascot started as a pre-cut strip, on the theory that "a horizontal strip
 * of square frames" is a contract that needs no manifest because a strip states
 * its own frame count. That was true and still is — a strip is just a sheet with
 * one row in it — but it put the interesting decision outside the app: picking
 * an animation meant running a script over a sheet and dropping the result in a
 * directory. The sheets themselves already hold six animations across eight
 * facings, so the thing worth choosing was never the file, it was the *part*.
 *
 * So the config is a rectangle of cells: a sheet, a grid size, and where in it
 * to start and how far to run. Settings is the authoring tool, which is also why
 * the cutting script it replaced is gone.
 */
export interface MascotConfig {
  /**
   * A sheet by name — the frog in `assets/spritesheets`, or anything in
   * `~/.config/kururu/sheets`. Never a path: this arrives from a client, and
   * kururu is reachable from the tailnet.
   */
  sheet: string;
  /** The sheet's grid. One cell is this many pixels, square. */
  frame: number;
  /**
   * The square inside a cell actually worth drawing, in sheet pixels.
   *
   * It has to be one box for every frame of every clip rather than each frame's
   * own bounding box, and the reason is the same one twice over. Within a clip:
   * where the sprite sits *in* its cell is how a sheet draws a jump, so trimming
   * each frame to its own content would land them all on the floor and throw the
   * animation away. Across clips: a sitting frog is smaller than a jumping one,
   * so a box each would scale them differently and the frog would change size
   * the moment its agent stopped. One box, and it stays the same frog.
   *
   * Square, so the badge is square and the frame count stays the only thing that
   * varies.
   */
  trim: { x: number; y: number; size: number };
  /**
   * Whether it moves. `system` follows `prefers-reduced-motion`, which is the
   * polite default everywhere else and the wrong one here: this is a 16px
   * functional indicator in the class of a spinner, not the kind of sliding
   * parallax that preference exists to stop, and frozen on one frame it says
   * exactly as much as the dot it replaced. So `always` is the default and the
   * preference is offered rather than obeyed.
   */
  motion: MascotMotion;
  /** What it does while the agent is going. The one this started as. */
  working: MascotClip;
  /**
   * What it does while the agent is stopped and nothing is wrong — or `null` for
   * the dot it used to be.
   *
   * Only `idle` gets one. `blocked` and `done` are stopped too, but they are
   * stopped *at you*: they are the two states that want a human, and leaving
   * them as coloured dots is what makes them stand out from a sidebar where
   * everything else is moving. `exited` keeps its dot for the same reason from
   * the other direction — there is nothing left in there to animate.
   *
   * Nullable because a sheet may hold only one animation worth having, and
   * because the dot was a perfectly good answer for two years. Adding one is a
   * drag in Settings.
   */
  idle: MascotClip | null;
}

/**
 * One animation: a run of cells along a row, and how long a loop takes.
 *
 * The sheet, the cell size and the trim are not in here on purpose. Those are
 * facts about the *picture* and must be the same for every clip of one mascot —
 * two clips at two cell sizes is not a mascot, it is two mascots.
 */
export interface MascotClip {
  /** The row, and the run of cells along it, that make up the animation. */
  row: number;
  col: number;
  count: number;
  /** One full loop, in milliseconds — not a frame rate. */
  cycle: number;
}

export type MascotMotion = "always" | "system" | "never";

export const MASCOT_MOTIONS: readonly MascotMotion[] = ["always", "system", "never"];

/**
 * The frog: mid-jump while it works, breathing while it waits.
 *
 * Row 1 of the sheets is a three-quarter facing; `guide.png` says which columns
 * are which animation — JUMP is 7-10, IDLE is 0-2. The trim is the union of the
 * two, which on this sheet is the jump's own box, the idle frog being smaller
 * and standing in the same place.
 */
const DEFAULT_IDLE: MascotClip = { row: 1, col: 0, count: 3, cycle: 1800 };

export const DEFAULT_MASCOT: MascotConfig = {
  sheet: "green",
  frame: 32,
  trim: { x: 5, y: 11, size: 21 },
  motion: "always",
  working: { row: 1, col: 7, count: 4, cycle: 720 },
  idle: DEFAULT_IDLE,
};

/** A sheet name is a name, never a path — same rule as a workspace colour. */
export function isSheetName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}

/**
 * The name a file somebody imported gets called.
 *
 * Here rather than in the importer because both halves need the same answer: the
 * browser derives a name from the file it is about to send so it can avoid one
 * already in the list, and the server derives it again from what arrived rather
 * than trusting the first answer. A name that reaches a filesystem is exactly
 * the kind of thing two spellings of would disagree about.
 *
 * Everything that is not a lowercase letter, a digit or a dash becomes a dash,
 * which makes "Frog Jump (2).png" into "frog-jump-2". A name that survives that
 * with nothing left is called `sheet`, since refusing a file over its own
 * filename would be a strange place to stop somebody.
 */
export function slugSheetName(filename: string): string {
  const base = filename.replace(/\.[^.]*$/, "");
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return isSheetName(slug) ? slug : "sheet";
}

/**
 * Read a mascot config out of whatever arrived — a client message, or a JSON
 * file written by a version of kururu that did not have half these fields.
 *
 * Every number is clamped rather than refused, because a selection that runs one
 * cell off the edge of a sheet is a slider gone too far, not an attack, and the
 * sensible answer is the nearest legal selection. `sheet` is the exception and is
 * refused outright, falling back to the default: it names a file, and a name
 * that is not a name has no nearest legal value. Whether the sheet actually
 * *exists* is not decided here — that is the server's, since only it can look.
 */
export function adoptMascot(value: unknown): MascotConfig {
  const raw = (value ?? {}) as Record<string, unknown>;
  const frame = clamp(raw.frame, 1, 512, DEFAULT_MASCOT.frame);
  const trim = (raw.trim ?? {}) as Record<string, unknown>;
  const size = clamp(trim.size, 1, frame, Math.min(frame, DEFAULT_MASCOT.trim.size));

  /**
   * The version before this one had a single animation, with its row, columns
   * and speed at the top level rather than under `working`. That file is
   * somebody's selection, so it becomes the working clip rather than being
   * dropped — and it gets no idle animation, because it never chose one and
   * inventing cells on a sheet we know nothing about would draw whatever
   * happened to be at the top-left of it.
   */
  const flat = raw.working === undefined && typeof raw.row === "number";

  return {
    sheet: isSheetName(raw.sheet) ? raw.sheet : DEFAULT_MASCOT.sheet,
    frame,
    trim: {
      // The default's own box is the fallback, not zero: a config written before
      // the trim existed is the frog, and the top-left corner of its cell is
      // empty sky. `clamp` bounds the fallback too, so a smaller cell than the
      // default's still lands somewhere inside itself.
      x: clamp(trim.x, 0, frame - size, DEFAULT_MASCOT.trim.x),
      y: clamp(trim.y, 0, frame - size, DEFAULT_MASCOT.trim.y),
      size,
    },
    motion: isMascotMotion(raw.motion) ? raw.motion : DEFAULT_MASCOT.motion,
    working: adoptClip(flat ? raw : raw.working, DEFAULT_MASCOT.working),
    idle:
      raw.idle === null
        ? null
        : raw.idle !== undefined
          ? adoptClip(raw.idle, DEFAULT_IDLE)
          : flat
            ? null
            : DEFAULT_MASCOT.idle,
  };
}

/** Same rule as the rest: every number is clamped towards the nearest legal one. */
function adoptClip(value: unknown, fallback: MascotClip): MascotClip {
  const raw = (value ?? {}) as Record<string, unknown>;
  return {
    row: clamp(raw.row, 0, 4096, fallback.row),
    col: clamp(raw.col, 0, 4096, fallback.col),
    count: clamp(raw.count, 1, 64, fallback.count),
    cycle: clamp(raw.cycle, 80, 10000, fallback.cycle),
  };
}

/**
 * A mascot somebody saved: a sheet, its clips, and a name and an id on it.
 *
 * The name exists because a selection is a handful of numbers and nobody
 * recognises their own by reading them. The id exists because the name does not
 * have to be unique — two of these are often the same frog at two speeds, and
 * renaming one must not silently become the other.
 */
export interface Mascot extends MascotConfig {
  id: string;
  name: string;
}

/**
 * Every mascot, and which one a workspace gets when it has not picked.
 *
 * It was one config, which was right while picking one was the whole feature. It
 * is not: a sheet holds six animations across eight facings, so what people do
 * with the picker is find three they like — and a picker with no way to keep
 * anything makes you re-find a selection you already made. So the config is a
 * list, choosing is switching rather than re-picking, and a workspace can point
 * at one the way it points at a colour.
 *
 * Never empty. An empty list would mean a working agent with no badge, and the
 * one thing this whole feature exists to guarantee is that a row which is doing
 * something has something in it.
 */
export interface MascotSet {
  /**
   * The one a workspace gets when it has not picked, by id. Editable, which is
   * the point of it being a field rather than "the first in the list": the frog
   * is what kururu ships with, not what you are stuck with.
   *
   * The head of the list stands in if it names nothing.
   */
  default: string;
  list: Mascot[];
}

/** The mascot to draw for a workspace, given what it picked. Never null. */
export function mascotFor(set: MascotSet, mascotId: string | null): Mascot {
  return set.list.find((m) => m.id === mascotId) ?? defaultMascot(set);
}

/**
 * The fallback: for a workspace that has not chosen, and for anything drawing a
 * badge outside one. Falls to the head of the list rather than to nothing, since
 * the list is never empty and there is therefore always an answer.
 */
export function defaultMascot(set: MascotSet): Mascot {
  return set.list.find((m) => m.id === set.default) ?? set.list[0]!;
}

export const DEFAULT_MASCOT_SET: MascotSet = {
  default: "m1",
  list: [{ id: "m1", name: "Frog", ...DEFAULT_MASCOT }],
};

/**
 * Read a whole set out of whatever arrived — a client message, or the file
 * `~/.config/kururu/mascot.json`, which for one version of kururu held a single
 * config with no list, no id and no name in it.
 *
 * That version is the interesting case and it is handled rather than discarded:
 * a file with a `sheet` and no `list` is one mascot, so it becomes one, keeping
 * the selection somebody made. Everything else about this is `adoptMascot`'s
 * rules applied per entry — clamp the numbers, refuse a sheet name that is not a
 * name — plus the two the list adds: ids are made unique, and an empty result is
 * the default frog rather than nothing to draw.
 */
export function adoptMascots(value: unknown): MascotSet {
  const raw = (value ?? {}) as {
    default?: unknown;
    active?: unknown;
    list?: unknown;
    sheet?: unknown;
  };
  const entries = Array.isArray(raw.list)
    ? raw.list
    : // One mascot, written before there could be two.
      isSheetName(raw.sheet)
      ? [value]
      : [];

  const seen = new Set<string>();
  const list: Mascot[] = [];
  for (const entry of entries) {
    const one = (entry ?? {}) as { id?: unknown; name?: unknown };
    const id =
      typeof one.id === "string" && one.id && !seen.has(one.id) ? one.id : `m${list.length + 1}`;
    if (seen.has(id)) continue;
    seen.add(id);
    list.push({
      id,
      name:
        typeof one.name === "string" && one.name.trim()
          ? one.name.trim().slice(0, 40)
          : `Mascot ${list.length + 1}`,
      ...adoptMascot(entry),
    });
  }
  if (list.length === 0) return DEFAULT_MASCOT_SET;

  // `active` is what this field was called when one mascot served the whole
  // window, before a workspace could override it.
  const chosen = raw.default ?? raw.active;
  return {
    default: typeof chosen === "string" && seen.has(chosen) ? chosen : list[0]!.id,
    list,
  };
}

function isMascotMotion(value: unknown): value is MascotMotion {
  return typeof value === "string" && (MASCOT_MOTIONS as readonly string[]).includes(value);
}

function clamp(value: unknown, low: number, high: number, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.max(low, Math.min(high, n));
}

/**
 * The colours a workspace can be tagged with.
 *
 * Names rather than CSS values, and the server only ever accepts one of these.
 * Two reasons, and the second is the one that matters: a name can be restyled
 * later without rewriting everybody's saved session, and kururu is reachable
 * from the tailnet — a colour field that took arbitrary text would be a client
 * writing directly into a style attribute. What each name looks like is the
 * web's business; see `colors.ts`.
 */
export const WORKSPACE_COLORS = [
  "green",
  "amber",
  "sand",
  "coral",
  "red",
  "brick",
  "blush",
  "rose",
  "violet",
  "lavender",
  "azure",
  "blue",
  "cyan",
  "lime",
] as const;

export type WorkspaceColor = (typeof WORKSPACE_COLORS)[number];

export function isWorkspaceColor(value: unknown): value is WorkspaceColor {
  return typeof value === "string" && (WORKSPACE_COLORS as readonly string[]).includes(value);
}

/** One split tree with a name. What prefix+1..9 switch between. */
export interface Workspace {
  id: string;
  name: string;
  layout: LayoutNode;
  focusedPaneId: string;
  /**
   * The pane focus was on before this one, so that going back is one gesture.
   *
   * `lastWorkspaceId` one level down, and for the same job: on a phone the panes
   * are drawn one at a time, and somebody watching two agents crosses between
   * them every few seconds. A list to pick from is the wrong shape for a move
   * you make that often — it is the argument the profile switcher lost, and a
   * toggle is what wins it.
   *
   * Null is "nowhere to go back to yet", which a fresh workspace and a restored
   * one both are. Nothing keeps it honest as panes close: an id naming a pane
   * that has gone reads as null at the point it is used, on `mascotId`'s
   * reasoning — a check on the way in would buy a repair where the fallback is
   * already the same answer.
   */
  lastPaneId: string | null;
  /**
   * A tag, not a theme: it rules a line down the left of the workspace's row and
   * down the left of every agent living in it, so "which of these is the one I
   * have the browser open for" is answered by glancing rather than by reading.
   *
   * It used to be null by default, on the argument that a palette where
   * everything is coloured says nothing and the point of the mark is that you
   * chose it. That argument was wrong about which thing is scarce. Nobody
   * chooses: a workspace is made in the middle of doing something else, and the
   * colour picker is two gestures away from a list that is already legible at
   * three rows — so the tags got set on the day somebody had six workspaces and
   * needed them, which is the day *after* the one where they would have helped.
   * `blankWorkspace` assigns one now, spreading across the palette rather than
   * picking blind, and choosing stays exactly as available as it was.
   *
   * Null survives, and is still what the picker's "No colour" writes. It also
   * remains what every workspace restored from a session written before this
   * reads as — retagging those on load would be a version change rearranging a
   * palette somebody had already arranged by hand.
   */
  color: WorkspaceColor | null;
  /**
   * Which mascot this workspace's agents animate, or null for the default.
   *
   * Null rather than a copy of the default, for the same reason `color` is
   * nullable: "I have not chosen" and "I chose the thing that is currently the
   * default" are different, and only the first follows when the default changes.
   * An id naming a mascot that has since been deleted reads as null, which is
   * why nothing has to be cleaned up when one goes.
   */
  mascotId: string | null;
}

/** A named session: a list of workspaces, and which of them you are in. */
export interface Profile {
  id: string;
  name: string;
  /**
   * The name of the directory this profile's logins live in, when profiles
   * keep their own — `~/.config/kururu/profiles/<loginKey>/`, with a Claude
   * config directory and a Codex home inside it. See `server/src/logins.ts`.
   *
   * Minted at random when the profile is made and never changed, and that is
   * the whole reason it is neither the id nor the name. `persist.ts`
   * regenerates ids on a cold start, and they are counters that a profile made
   * after another was deleted would reuse — so a login keyed by id would come
   * back as the wrong person's after a restart, which is the exact accident
   * this exists to rule out. A name follows a rename, and moving a directory
   * somebody's login lives in because they retitled a tab strip is the other
   * accident. A random key does neither: it is written to disk with the
   * profile, restored with it, and a blob or file from before it existed is
   * given a fresh one on the way in — which reads as "not signed in yet", and
   * never as somebody else.
   */
  loginKey: string;
  workspaces: Workspace[];
  activeWorkspaceId: string;
  /**
   * The workspace you were in before this one — tmux's last-window, which is
   * what makes prefix+z a toggle between the two you are actually working in
   * rather than a walk through the list.
   */
  lastWorkspaceId: string | null;
  /**
   * The order somebody dragged the sidebar's agent list into, by id.
   *
   * Spawn order is the default and it is a good one: it never moves under you,
   * which is what you want from a list you are scanning. It is a poor
   * *arrangement*, though — the two agents you are alternating between this
   * afternoon arrived an hour apart, and nothing else in kururu puts them next
   * to each other, since the layout answers where a terminal is drawn and not
   * where it is listed.
   *
   * Ids of processes rather than structure, which is what decides where this
   * lives. It rides in the host's blob, so it survives a server restart
   * alongside the terminals it names, and `persist.ts` deliberately does not
   * write it: a cold start has no agents to put in an order. Ids that have since
   * gone are ignored on the way out rather than pruned on the way in — the two
   * give the same list, and only one of them costs a write per snapshot.
   */
  agentOrder: string[];
  /**
   * The terminals the sidebar's list has been told to put away, by id.
   *
   * Hiding one is a statement about the *list* and about nothing else: the pty
   * runs on, its tab is where it was, `prefix+a` still finds it by name, and a
   * notification it earns is still delivered. The list is the one place in
   * kururu that spans a whole profile, which is exactly what makes it the place
   * that gets long — six agents you are working with and the four from this
   * morning you have not got round to killing are the same list, and the second
   * four are the ones you scroll past.
   *
   * Not a kill and not a close, which is the point: the row that offered only
   * those two made "I am done looking at this" cost either a scroll or a turn.
   *
   * Ids of processes rather than structure, so it lives exactly where
   * `agentOrder` lives and for the same reasons — in the host's blob, which
   * survives a server restart alongside the terminals it names, and out of
   * `persist.ts`, because a cold start has no agents to have put away. Ids that
   * name nothing are ignored where they are read rather than pruned on the way
   * in, which is the other half of that file's bargain: pruning would be a write
   * per snapshot to reach the answer a filter already gives.
   */
  hiddenAgents: string[];
}

/** What a login key may be: the hex `mintLoginKey` makes, and nothing that could be a path. */
export const LOGIN_KEY = /^[0-9a-f]{12}$/;

export function isLoginKey(value: unknown): value is string {
  return typeof value === "string" && LOGIN_KEY.test(value);
}

/**
 * A fresh key: twelve hex digits from the platform's random source, which both
 * halves have as `globalThis.crypto`. Only the server ever mints one, but the
 * check above is what a key is held to wherever it is read, and the two are
 * one rule kept in one place.
 */
export function mintLoginKey(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A profile you are not in, as much of it as a switcher needs to draw. */
export interface ProfileSummary {
  id: string;
  name: string;
  workspaces: number;
  /** Live ptys inside it. The reason switching away is not the same as closing. */
  agents: number;
  /**
   * Where this profile's logins live when profiles keep their own — the
   * directory in full, because it is the one thing on the Profiles page
   * somebody will want to `cd` into or copy a settings file across to. Sent
   * whether or not the setting is on: it is a fact about the profile either
   * way, and the page decides what to draw.
   */
  loginDir: string;
  /**
   * Which login that is, so the page can tell two profiles pointed at the same
   * one apart from two that merely look alike, and mark the picker. The key
   * and not just the directory because the picker sends the key back.
   */
  loginKey: string;
}

/**
 * One login kururu holds: a directory under `profiles/` and who is signed into
 * it, as far as Claude Code has written down.
 *
 * This is what a profile *chooses from*, and it is the whole of what may be
 * chosen: directories kururu made, listed by looking at the disk, labelled by
 * an account record the tool wrote. Nothing is typed. A login that some profile
 * uses is in the list whether or not anybody has signed into it yet — that is
 * the "not signed in yet" row — and a directory nobody uses and nobody signed
 * into is not, because it is an empty folder and there is nothing to say about
 * it. The Codex login rides along in the same directory and is not described:
 * its account record carries no email to read, and the list is labelled by the
 * one that does.
 */
export interface LoginSummary {
  key: string;
  /** The Claude account signed into it, or null for a directory nobody has signed into. */
  email: string | null;
}

/**
 * The pty host, as it introduced itself when this server connected.
 *
 * The host outlives every server and does not pick up a new bundle until it is
 * restarted, so it is routinely older than the server talking to it — and a
 * field the server puts on a spawn that an old host does not know about is
 * dropped on the floor with correct code on both sides. `HOST_PROTOCOL` in
 * `server/src/hostlink.ts` is the number that changes when that would matter,
 * and `current` is whether the running host has it.
 */
export interface HostInfo {
  /** Its build, or null for a host from before the handshake carried one. */
  version: string | null;
  /** It applies everything this server sends. False means a restart is owed, and every agent with it. */
  current: boolean;
}

/**
 * Everything a client needs to draw the window, in one message.
 *
 * Only the active profile is sent in full. The others are a name and two counts,
 * because a switcher is all you can do with a profile you are not in, and
 * sending every workspace of every profile would put a layout nobody is looking
 * at on the wire on every status change.
 */
export interface SessionSnapshot {
  session: string;
  /** The active profile, whole. */
  profile: Profile;
  /** Every profile including the active one, in creation order. */
  profiles: ProfileSummary[];
  /**
   * Every login on this machine that a profile could be pointed at, whether or
   * not the switch is on — see `LoginSummary`. Read off the disk, so a `/login`
   * typed into a terminal shows up here within a poll and never has to be
   * declared.
   */
  logins: LoginSummary[];
  /**
   * Every agent in the active profile, in the order the sidebar lists them:
   * creation order, rearranged by whatever has been dragged. Ordered here rather
   * than in the client for the reason the layout is — the arrangement is the
   * server's, so two clients cannot end up holding it differently.
   */
  agents: AgentSnapshot[];
  /**
   * Every mascot the user has kept, and which one the working badge is. In the
   * snapshot rather than behind its own fetch because it is a thing the client
   * cannot draw a row without, it changes while the window is open (Settings is
   * a second client writing it), and it is a few hundred bytes beside a list of
   * agents.
   */
  mascots: MascotSet;
  /**
   * Which keys the user has rebound, and only those — `shared/keys.ts` holds the
   * defaults, and both halves import them. Server-owned like everything else
   * here, so the phone and the desktop cannot end up with different keyboards
   * and a rebinding survives a reload.
   */
  keys: KeyOverrides;
  /**
   * Which theme is on and what the terminals are set in. Server-owned like the
   * keyboard and for the same reasons — a phone and a desktop cannot end up
   * looking like two applications, and a reload does not cost you the choice.
   *
   * A theme *id* travels, never a palette: `shared/theme.ts` holds what each one
   * means and both halves import it, so a flavour restyled in a later version
   * restyles everywhere rather than being frozen in somebody's config file.
   */
  appearance: Appearance;
  /**
   * When kururu may interrupt you, and what it sounds like.
   *
   * In the snapshot for the keyboard's reasons, and with one of its own. A
   * notification is the one thing kururu does that reaches you when you are not
   * looking at it, so a phone and a desktop disagreeing about whether it may
   * would be the setting failing in the only case it exists for — and unlike the
   * theme, nothing on screen would show you which of them was wrong.
   *
   * What is *here* is only the choice. The policy is applied on the server, per
   * client, before a notification is sent at all (see `shared/notify.ts`); this
   * travels because the client needs two of the five fields to make the noise,
   * and because the page that edits it draws what comes back rather than holding
   * anything.
   */
  notify: NotifySettings;
  /**
   * Which agents and models the new-tab button offers. The catalogue itself is
   * in `shared/launchers.ts` and both halves import it; what travels is only
   * which rows somebody switched off.
   */
  launch: LaunchSettings;
  /**
   * Whether the pty host is one that every request of this server's reaches.
   * In the snapshot because the one setting whose effect depends on it —
   * profiles keeping their own logins — is drawn by a page that has to say so
   * when it is switched on and not yet in force.
   */
  host: HostInfo;
  /**
   * The themes and skins installed from `../kururu-styles`, resolved.
   *
   * This is the one place a palette genuinely does travel, and it is the
   * exception that proves the rule above: an installed theme is not in
   * `shared/theme.ts` and never will be, so there is no id both halves could
   * look up. The server reads the manifests, checks them — see
   * `shared/styles.ts`, where every value in here is somebody else's string —
   * and sends the same `Theme` and `Skin` shapes the built-ins already are, so
   * every list in the window is one concatenation rather than two code paths.
   *
   * In the snapshot rather than behind its own fetch, for the mascots' reason:
   * the client cannot draw the window without it, it changes while the window is
   * open because Settings is a second client writing it, and it is nothing next
   * to a list of agents. The *catalogue* — what there is to install — is the
   * opposite on all three counts and is a fetch.
   */
  styles: StyleLibrary;
}

/** What an agent (or a Claude Code hook) may tell kururu about itself. */
export interface AgentReport {
  status?: AgentStatus;
  /** Free text for a notification; not rendered in the tab strip. */
  message?: string;
  context?: ContextUsage;
}

/**
 * Whether this one is somebody's work — what a quit confirmation counts.
 *
 * A terminal you opened to run `ls` in is not worth a dialog, so shells are not
 * counted; a shell you then typed `claude` into is, which is why this asks what
 * is *running* as well as what was asked for. Erring towards counting is the
 * right way round: a needless dialog costs a keystroke, a missed one costs a turn.
 *
 * It lives here because two processes ask it — the pty host, for the dialog, and
 * the server, for `/api/health` — and two spellings of this rule would disagree
 * on exactly the case that matters.
 */
export function countsAsAgent(agent: AgentSnapshot): boolean {
  return !agent.exited && (agent.kind === "agent" || agent.agent !== null);
}

export const AGENT_STATUSES: readonly AgentStatus[] = ["idle", "working", "blocked", "done"];

export function isAgentStatus(value: unknown): value is AgentStatus {
  return typeof value === "string" && (AGENT_STATUSES as readonly string[]).includes(value);
}
