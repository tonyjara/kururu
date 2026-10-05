/**
 * A workspace's board: cards of work, and the agent each one was handed to.
 *
 * It exists because the sidebar lists *processes* and nothing in kururu listed
 * the work. Six agents is six rows, and which of them was the migration and
 * which was the flaky test is a thing you keep in your head — or in a file the
 * agents can read and kururu cannot draw. A card is that sentence written down
 * once, and the robot on it is the one gesture that turns it into an agent,
 * with the card itself as the prompt.
 *
 * It lives on the `Workspace` rather than in a file of its own, and that is the
 * decision worth defending. A workspace is already one piece of work, and its
 * arrangement already survives both kinds of restart by two roads — the host's
 * blob across a server restart and `persist.ts` across a cold one — so a board
 * that rides along gets both for nothing. A separate file would need a key to
 * find its workspace by, and workspace ids are counters `persist.ts` mints
 * afresh on every cold start; a board keyed on one would come back as somebody
 * else's. And the blob is opaque to the pty host, so none of this costs an edit
 * to the half of kururu that holds the agents.
 *
 * `Workspace.board` is null until somebody opens it. An empty board on every
 * workspace would be a board on every workspace — this is a thing you ask for.
 *
 * Pure, like `layout.ts`: the server applies these and the client never holds a
 * board of its own. The client sends verbs; the snapshot is the answer.
 */
import { dayAt, dayNumber, type Day } from "./days";
import { isWorkspaceColor, WORKSPACE_COLORS, type WorkspaceColor } from "./model";

/**
 * Four columns, fixed. `review` is the one that is not the usual three, and it
 * is what makes the automation honest: an agent that stopped talking has
 * finished a *turn*, which is not the same as finishing the work — it may be
 * asking a question — and nothing in a byte stream tells the two apart. So a
 * finished run lands in front of a person, and only a person says done.
 */
export const BOARD_COLUMNS = ["todo", "doing", "review", "done"] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

export const COLUMN_LABELS: Record<BoardColumn, string> = {
  todo: "To do",
  doing: "In progress",
  review: "Review",
  done: "Done",
};

export function isBoardColumn(value: unknown): value is BoardColumn {
  return typeof value === "string" && (BOARD_COLUMNS as readonly string[]).includes(value);
}

/**
 * A column a person made, on a board that takes them — which is the profile's
 * alone. A workspace's four are fixed because the run automation reads them:
 * a finished run goes to Review, a card sent to Done ends its dev server. The
 * profile's board runs nothing, so nothing reads its columns but a person, and
 * a person's inbox is shaped however they think: Someday, Bugs, Waiting on
 * design.
 *
 * `id` is what a card's `column` names, so that a rename is one field and not
 * a walk over every card. The profile's first three keep the fixed ids they
 * had before columns could be made, which is what lets a board written then
 * come back with its cards where they were.
 *
 * `color` is what the column's cards wear wherever they are drawn away from
 * it — on the timeline a card is a bar among other columns' bars, and the
 * colour is the only thing left of which column it is in. One of a
 * workspace's tag colours by name, for the reasons `WORKSPACE_COLORS` gives,
 * and every column is made with one for the reason `Workspace.color` gives:
 * nobody chooses, and a colour that waits to be chosen arrives the day after
 * it would have helped. Null is "no colour", which a person can still pick.
 */
export interface BoardLane {
  id: string;
  name: string;
  color: WorkspaceColor | null;
}

/**
 * What the three columns a profile's board starts with are coloured. Amber
 * and green are what kururu already means by working and by finished, in
 * every theme; blue is the one that is neither.
 */
const LANE_COLORS: Record<string, WorkspaceColor> = { todo: "blue", doing: "amber", done: "green" };

/**
 * The colour a new column gets: the first nobody else on the board is
 * wearing. The order is not the picker's spectrum, whose neighbours are
 * alike, but one that steps across it — and it leaves the starting three's
 * colours until last, so a fourth column is never taken for In progress.
 * Chosen by rule rather than at random, unlike a workspace's, because this
 * file is pure and a board adopted twice has to come out the same.
 */
const LANE_SPREAD: readonly WorkspaceColor[] = [
  "violet",
  "coral",
  "cyan",
  "rose",
  "lime",
  "sand",
  "lavender",
  "red",
  "azure",
  "blush",
  "brick",
  "blue",
  "amber",
  "green",
];

function freeColor(lanes: readonly BoardLane[]): WorkspaceColor {
  return LANE_SPREAD.find((color) => !lanes.some((lane) => lane.color === color)) ?? WORKSPACE_COLORS[0];
}

/** A column's name, and how many a board may have — past that it is a scroll, not a board. */
export const LANE_NAME_MAX = 40;
export const LANES_MAX = 12;

/**
 * The profile's board starts with three of the four. It is a list of work that
 * has not found its workspace yet, and nothing on it is ever handed to an
 * agent — so there is no run to finish and nothing for Review to be in front of.
 */
export function profileLanes(): BoardLane[] {
  return (["todo", "doing", "done"] as const).map((id) => ({ id, name: COLUMN_LABELS[id], color: LANE_COLORS[id] ?? null }));
}

/** The columns a board draws, in order: its own if it has any, else the fixed four. */
export function boardLanes(board: Board): BoardLane[] {
  return board.columns ?? BOARD_COLUMNS.map((id) => ({ id, name: COLUMN_LABELS[id], color: null }));
}

function hasLane(board: Board, column: unknown): column is string {
  return typeof column === "string" && boardLanes(board).some((lane) => lane.id === column);
}

export function mintLaneId(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return `k${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Where an agent handed a card has got to, as far as its status says.
 *
 * `starting` is the gap before the first sign of work; `finished` is a turn
 * that ended, which is the event the whole feature is for; `ended` is a pty
 * that closed, or a run that a cold start found with no process behind it —
 * `persist.ts` restores structure and never processes, so a run it brings back
 * is one that is not running.
 */
export type RunState = "starting" | "working" | "blocked" | "finished" | "ended";

export interface CardRun {
  /**
   * The terminal it runs in. A process id, so it is dropped on the way to disk
   * and a restored run has none — the card remembers *that* it ran, not where.
   */
  agentId: string | null;
  /** The launcher it was started with, by id — see `shared/launchers.ts`. */
  launcher: string;
  /** What the menu called it, kept so the card can say it after the list moves on. */
  label: string;
  state: RunState;
  startedAt: number;
  /** When it last finished or ended, for the card to say how long ago. */
  endedAt: number | null;
  /**
   * The conversation, for a CLI that lets kururu name it up front — Claude
   * Code's `--session-id` — so that a card whose agent has gone can be handed
   * the same conversation back with `--resume`. Unlike `agentId` it goes to
   * disk: it names a transcript file, not a process, and the transcript is
   * still there after a cold start. Null for Codex, which picks its own ids
   * and says them to nobody, and for runs from before this was kept.
   */
  sessionId: string | null;
  /**
   * Where the agent started. Kept because a Claude transcript is filed under
   * the directory it ran in and `--resume` only looks in the one it is run
   * from — so resuming means starting there again, which is the card's
   * worktree while it stands and a guess once it has gone.
   */
  cwd: string | null;
}

/** What a session id must look like to be put on a command line. Claude Code insists on a UUID. */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The checkout a card's work happens in, when it has one of its own.
 *
 * On the card rather than on the run, because it outlives the run: an agent
 * that ended is handed a second one on the same card, and the second should
 * find the first one's files, not a fresh checkout beside them. Every field is
 * a path or a ref, so all of it goes to disk and comes back — the worktree is
 * still there after a cold start, and the card has to know where.
 */
export interface CardWorktree {
  /** The main working tree it was added from — the directory the robot was pressed in. */
  root: string;
  /** The linked worktree's directory. See `worktreeDir` in `shared/projects.ts`. */
  path: string;
  /** The branch made for it. */
  branch: string;
  /** What it was cut from — the branch the main tree had checked out, or a short sha. */
  base: string;
}

/**
 * The dev server a card's worktree is being served by — a terminal kururu
 * opened for it, running the project's dev line with a `PORT` the kernel
 * handed out.
 *
 * Its own field rather than a second run, because it is not work anybody is
 * waiting on: it has no status worth a dot, it never finishes a turn, and a
 * card with its agent ended still wants its preview. Tracked at all so that
 * the card can restart the one terminal that is its server and end it when
 * the card goes to Done — without it the server is one more tab nobody can
 * tell from the others. `port` is what it was *offered*; the address the card
 * links to is whichever the dev-server scan finds listening in the worktree,
 * since a server that ignores `PORT` (vite does) picks its own.
 */
export interface CardDev {
  /** A process id, dropped on the way to disk like `CardRun.agentId`. */
  agentId: string | null;
  port: number;
}

/**
 * When a card is for: a day, or a run of them. One day is a range whose ends
 * are the same, so that nothing downstream has two cases to draw.
 *
 * Days rather than times, for the reason `shared/days.ts` gives, and *when it
 * is for* rather than when it is due: a deadline is one end of a range and a
 * timeline needs both, since what is being planned is the week and a week is
 * made of how long things take.
 */
export interface CardDates {
  start: Day;
  end: Day;
}

export interface Card {
  /** Random rather than from `nextId`, whose counter only knows about panes. */
  id: string;
  /**
   * The card's place in the order its board was written in, from 1 — what the
   * card's code is made of, the way a Jira key is. Separate from `id` because
   * that one is random so that it never collides, and this one exists to be
   * read: it says which card came first at a glance, which neither the column
   * a card sits in nor the order within it does once cards have been dragged.
   */
  number: number;
  title: string;
  body: string;
  /**
   * One of its board's columns by id — a `BoardColumn` on a workspace's board,
   * and on the profile's whatever `Board.columns` names.
   */
  column: string;
  createdAt: number;
  run: CardRun | null;
  /**
   * Whether the card's agent gets a worktree of its own, ticked when the card
   * is written. A choice per card rather than a project setting, because most
   * cards are a quick fix that belongs in the checkout you are already in, and
   * the few that want isolation are the ones you know about as you write them.
   * A card whose worktree already stands keeps going back into it either way.
   */
  isolate: boolean;
  worktree: CardWorktree | null;
  dev: CardDev | null;
  /**
   * When it is for, or null for a card nobody has put on the calendar — which
   * is most of them, and the ordinary state. Given on the profile's board,
   * whose timeline is what draws it; a card sent to a workspace keeps it,
   * since being handed to an agent does not move the day it was promised for.
   */
  dates: CardDates | null;
}

export interface Board {
  /** In column order is not guaranteed; within a column, this order is the order drawn. */
  cards: Card[];
  /**
   * The number the next card gets. A counter rather than one more than the
   * highest card, so that a number is never handed out twice: delete the
   * newest card and the one after it still gets a number of its own, and a
   * code somebody wrote in a commit message never comes to mean another card.
   */
  next: number;
  /**
   * The board's own columns, on the one board that has them — the profile's.
   * Absent on a workspace's, which draws the fixed four; see `BoardLane`.
   */
  columns?: BoardLane[];
}

/** Long enough for a real ticket, short enough that a bad paste is not a megabyte in every snapshot. */
export const TITLE_MAX = 200;
export const BODY_MAX = 20_000;

export function emptyBoard(): Board {
  return { cards: [], next: 1 };
}

export function emptyProfileBoard(): Board {
  return { cards: [], next: 1, columns: profileLanes() };
}

export function mintCardId(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return `c${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** A card's text as a string off the wire: trimmed, capped, and refused if it is not text. */
function text(value: unknown, max: number): string | null {
  return typeof value === "string" ? value.trim().slice(0, max) : null;
}

/**
 * A card's dates off the wire or the disk: two real days in order, or null.
 *
 * An `end` that is absent is the same day as the start — a client naming one
 * day should not have to say it twice. An end *before* its start is refused
 * rather than swapped: swapping is a guess at which of the two was the typo,
 * and a range somebody did not mean is worse on a calendar than none.
 */
export function adoptDates(value: unknown): CardDates | null {
  if (!value || typeof value !== "object") return null;
  const { start, end } = value as Record<string, unknown>;
  const from = dayNumber(start);
  const to = end === undefined || end === null ? from : dayNumber(end);
  if (from === null || to === null || to < from) return null;
  return { start: dayAt(from), end: dayAt(to) };
}

/**
 * A new card at the foot of its column. A card with no title is not a card;
 * one whose dates are not dates is a card with none, as one whose column is
 * not a column is a card in the first.
 */
export function addCard(
  board: Board,
  fields: { title: unknown; body?: unknown; column?: unknown; isolate?: unknown; dates?: unknown },
  id: string,
  now: number,
): Board {
  const title = text(fields.title, TITLE_MAX);
  if (!title) return board;
  const card: Card = {
    id,
    number: board.next,
    title,
    body: text(fields.body, BODY_MAX) ?? "",
    column: hasLane(board, fields.column) ? fields.column : boardLanes(board)[0]!.id,
    createdAt: now,
    run: null,
    isolate: fields.isolate === true,
    worktree: null,
    dev: null,
    dates: adoptDates(fields.dates),
  };
  return { ...board, cards: [...board.cards, card], next: board.next + 1 };
}

/**
 * `dates` has three answers where the others have two: absent leaves the
 * card's alone, null takes them off, and anything else is a range to be held
 * to `adoptDates` — and refused with the rest of the edit if it fails, since
 * here a bad range would otherwise read as "take them off".
 */
export function editCard(
  board: Board,
  cardId: string,
  fields: { title?: unknown; body?: unknown; isolate?: unknown; dates?: unknown },
): Board {
  const title = fields.title === undefined ? undefined : text(fields.title, TITLE_MAX);
  const body = fields.body === undefined ? undefined : text(fields.body, BODY_MAX);
  // An emptied title is refused rather than applied, for `addCard`'s reason.
  if (title === "" || title === null || body === null) return board;
  const isolate = typeof fields.isolate === "boolean" ? fields.isolate : undefined;
  const dates = fields.dates === undefined || fields.dates === null ? fields.dates : adoptDates(fields.dates);
  if (fields.dates !== undefined && fields.dates !== null && dates === null) return board;
  return {
    ...board,
    cards: board.cards.map((card) =>
      card.id === cardId
        ? {
            ...card,
            ...(title !== undefined ? { title } : {}),
            ...(body !== undefined ? { body } : {}),
            ...(isolate !== undefined ? { isolate } : {}),
            ...(dates !== undefined ? { dates } : {}),
          }
        : card,
    ),
  };
}

export function removeCard(board: Board, cardId: string): Board {
  return { ...board, cards: board.cards.filter((card) => card.id !== cardId) };
}

/**
 * Put a card in a column, at a place among the cards already there — or at the
 * foot when `index` is absent.
 *
 * The index counts the *destination column's* cards with the moved one taken
 * out, which is what the client can see: it is pointing between two cards in a
 * column, and the flat list they are stored in is not its business. Checked with
 * `Number.isInteger` at the entry, for `layout.ts`'s reason — a clamp is not a
 * check, and NaN loses every comparison it is in.
 */
export function moveCard(board: Board, cardId: string, column: unknown, index?: unknown): Board {
  const card = board.cards.find((c) => c.id === cardId);
  if (!card || !hasLane(board, column)) return board;
  if (index !== undefined && (!Number.isInteger(index) || (index as number) < 0)) return board;
  const rest = board.cards.filter((c) => c.id !== cardId);
  const moved = { ...card, column };
  const inColumn = rest.filter((c) => c.column === column);
  const before = index === undefined ? undefined : inColumn[index as number];
  if (!before) {
    // The foot of the column: after its last card, or at the end of everything.
    const last = inColumn.at(-1);
    const at = last ? rest.indexOf(last) + 1 : rest.length;
    return { ...board, cards: [...rest.slice(0, at), moved, ...rest.slice(at)] };
  }
  const at = rest.indexOf(before);
  return { ...board, cards: [...rest.slice(0, at), moved, ...rest.slice(at)] };
}

/** A board's cards, a column at a time, in the order they are drawn. */
export function columnCards(board: Board, column: string): Card[] {
  return board.cards.filter((card) => card.column === column);
}

/** Whether a run still has a process behind it that could be doing something. */
export function runLive(run: CardRun | null): boolean {
  return run !== null && run.agentId !== null && (run.state === "starting" || run.state === "working" || run.state === "blocked");
}

/**
 * Hand a card to an agent: it moves to In progress and remembers which one.
 * A card whose agent is still going is left alone — two agents on one ticket is
 * a thing somebody should do on purpose, with a second card.
 */
export function startRun(
  board: Board,
  cardId: string,
  run: Omit<CardRun, "state" | "endedAt" | "sessionId" | "cwd"> & Partial<Pick<CardRun, "sessionId" | "cwd">>,
): Board {
  const started: CardRun = { ...run, sessionId: run.sessionId ?? null, cwd: run.cwd ?? null, state: "starting", endedAt: null };
  return {
    ...board,
    cards: board.cards.map((card) => (card.id === cardId ? { ...card, column: "doing", run: started } : card)),
  };
}

/**
 * Remember the checkout a card's work is in, or forget it once it has gone.
 * Separate from `startRun` because the two happen at different times — the
 * worktree is made before the agent, and it stays after the run ends.
 */
export function setWorktree(board: Board, cardId: string, worktree: CardWorktree | null): Board {
  return { ...board, cards: board.cards.map((card) => (card.id === cardId ? { ...card, worktree } : card)) };
}

/** Remember the terminal serving a card's worktree, or forget it once it has been ended. */
export function setDev(board: Board, cardId: string, dev: CardDev | null): Board {
  return { ...board, cards: board.cards.map((card) => (card.id === cardId ? { ...card, dev } : card)) };
}

/**
 * What an agent's status means for the card it was handed, or null for "no
 * change". `idle` is never news: it is both the moment before a turn starts and
 * a short burst settling, and neither says anything the run did not already.
 */
export function runStateFor(status: string, exited: boolean): RunState | null {
  if (exited) return "ended";
  if (status === "working") return "working";
  if (status === "blocked") return "blocked";
  if (status === "done") return "finished";
  return null;
}

/**
 * Carry an agent's status onto the card it runs, and move the card when the
 * run's state *changes*.
 *
 * The moves are edges, never levels, and that is what lets a person argue with
 * them. `done` is a status an agent sits in until it is typed at again; if the
 * rule were "a finished run's card is in Review", dragging it back to In
 * progress would last until the next status tick. Instead the card moves once,
 * when the run's state becomes `finished` — and only out of the column the
 * automation put it in, so a card somebody has already dragged to Done is not
 * pulled back to Review because the agent answered a follow-up.
 *
 * Returns the same board when nothing changed, which is what keeps a status
 * tick from being a snapshot and a disk write.
 */
export function noteRun(board: Board, agentId: string, status: string, exited: boolean, now: number): Board {
  let changed = false;
  const cards = board.cards.map((card) => {
    const run = card.run;
    if (!run || run.agentId !== agentId) return card;
    const next = runStateFor(status, exited);
    if (next === null || next === run.state) return card;
    // An exited agent's card keeps `finished` if it got there first: the turn
    // ended well and then somebody closed the terminal, which is not news.
    if (next === "ended" && run.state === "finished") return card;
    changed = true;
    const ending = next === "finished" || next === "ended";
    let column = card.column;
    if (next === "finished" && column === "doing") column = "review";
    if ((next === "working" || next === "blocked") && column === "review") column = "doing";
    return { ...card, column, run: { ...run, state: next, endedAt: ending ? now : run.endedAt } };
  });
  return changed ? { ...board, cards } : board;
}

/**
 * The prompt a card becomes. The title leads because it is the sentence the
 * card was written as; the body is the detail under it.
 */
export function cardPrompt(card: Pick<Card, "title" | "body">): string {
  return card.body ? `${card.title}\n\n${card.body}` : card.title;
}

/**
 * Take a card off one board and put it at the foot of its column on another —
 * the profile's board sending a card to the workspace it belongs to.
 *
 * The card keeps its id, which is random and so means the same card on either
 * board, and is given the next number of the board it lands on, since a number
 * is a place in *that* board's order and the code it makes carries the new
 * workspace's name. It arrives as text and its dates: a profile card has never
 * run, and whether it wants a worktree is a question for the board that can
 * make one, but the day it was planned for is about the work and goes where
 * the work goes. A column the destination does not draw is its To do. Both
 * boards come back unchanged when the card is not on the first.
 */
export function transferCard(from: Board, to: Board, cardId: string): { from: Board; to: Board } {
  const card = from.cards.find((c) => c.id === cardId);
  if (!card) return { from, to };
  const column = hasLane(to, card.column) ? card.column : boardLanes(to)[0]!.id;
  const moved: Card = { ...card, number: to.next, column, run: null, isolate: false, worktree: null, dev: null };
  return {
    from: removeCard(from, cardId),
    to: moveCard({ ...to, cards: [...to.cards, moved], next: to.next + 1 }, cardId, column),
  };
}

/**
 * A board off the blob or the disk, made to match the types — or null for one
 * that is not there, which is the ordinary case.
 *
 * Read the way `adopt()` in `workspaces.ts` reads everything out of a blob: a
 * hand-edited file or an older server can put anything in here, and a card that
 * is not a card is dropped rather than carried as something the window cannot
 * draw. A run that claims to be going but names no process is one a cold start
 * brought back, and it is `ended` — nothing is running it.
 */
export function adoptBoard(value: unknown): Board | null {
  if (!value || typeof value !== "object") return null;
  const columns = adoptLanes((value as { columns?: unknown }).columns);
  const shape: Board = columns ? { cards: [], next: 1, columns } : emptyBoard();
  const raw = (value as { cards?: unknown }).cards;
  if (!Array.isArray(raw)) return shape;
  const cards: Card[] = [];
  const taken = new Set<number>();
  for (const item of raw as Record<string, unknown>[]) {
    if (!item || typeof item !== "object") continue;
    const title = text(item.title, TITLE_MAX);
    if (!title || typeof item.id !== "string") continue;
    const number = Number.isInteger(item.number) && (item.number as number) > 0 && !taken.has(item.number as number) ? (item.number as number) : 0;
    if (number) taken.add(number);
    cards.push({
      id: item.id,
      number,
      title,
      body: text(item.body, BODY_MAX) ?? "",
      column: hasLane(shape, item.column) ? item.column : boardLanes(shape)[0]!.id,
      createdAt: Number.isFinite(item.createdAt) ? (item.createdAt as number) : 0,
      run: adoptRun(item.run),
      // A card from before the choice was per card ran in a worktree if it has one.
      isolate: item.isolate === true || adoptWorktree(item.worktree) !== null,
      worktree: adoptWorktree(item.worktree),
      dev: adoptDev(item.dev),
      dates: adoptDates(item.dates),
    });
  }
  // A card from before cards were numbered, or one whose number is a second
  // card's, is numbered after the rest in the order it was written — which is
  // the order the numbers are for.
  let next = Math.max(1, ...[...taken].map((n) => n + 1));
  const stored = (value as { next?: unknown }).next;
  if (Number.isInteger(stored) && (stored as number) > next) next = stored as number;
  for (const card of [...cards].filter((c) => c.number === 0).sort((a, b) => a.createdAt - b.createdAt)) card.number = next++;
  return { ...shape, cards, next };
}

/**
 * The profile's board off the blob or the disk. A board from before its
 * columns could be made has none written down, and gets the three it drew —
 * whose ids its cards already name.
 */
export function adoptProfileBoard(value: unknown): Board {
  const board = adoptBoard(value);
  if (!board) return emptyProfileBoard();
  if (board.columns) return board;
  return adoptBoard({ ...board, columns: profileLanes() })!;
}

/**
 * A board's own columns, or null for one that has none. Named and unique, or
 * dropped; none left at all is the same as none written, since a board with
 * no column has nowhere to draw a card.
 *
 * A colour that is *absent* is a column from before columns had one, and it
 * is given one here — the starting three theirs, the rest the first going
 * spare — so that a board written last week comes back coloured rather than
 * waiting to be. A colour that is null was chosen, and stays none; one that
 * is not a colour at all is a hand-edited file, and is none too.
 */
function adoptLanes(value: unknown): BoardLane[] | null {
  if (!Array.isArray(value)) return null;
  const lanes: BoardLane[] = [];
  const uncoloured: BoardLane[] = [];
  for (const item of value as Record<string, unknown>[]) {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id) continue;
    const name = text(item.name, LANE_NAME_MAX);
    if (!name || lanes.some((lane) => lane.id === item.id)) continue;
    const lane: BoardLane = { id: item.id, name, color: isWorkspaceColor(item.color) ? item.color : null };
    if (item.color === undefined) {
      lane.color = LANE_COLORS[lane.id] ?? null;
      if (lane.color === null) uncoloured.push(lane);
    }
    lanes.push(lane);
    if (lanes.length === LANES_MAX) break;
  }
  // After the rest have said theirs, so that a spare colour is one that is spare.
  for (const lane of uncoloured) lane.color = freeColor(lanes);
  return lanes.length ? lanes : null;
}

/**
 * A new column at the right of the rest. Only on a board that has columns of
 * its own — a workspace's four are not the kind that are added to.
 */
export function addLane(board: Board, name: unknown, id: string): Board {
  const clean = text(name, LANE_NAME_MAX);
  if (!board.columns || !clean || board.columns.length >= LANES_MAX || hasLane(board, id)) return board;
  return { ...board, columns: [...board.columns, { id, name: clean, color: freeColor(board.columns) }] };
}

/**
 * Give a column a colour, or none. One of `WORKSPACE_COLORS` or the edit is
 * refused — `set-workspace-color`'s line, for its reason: the name ends up in
 * a style, and kururu is reachable from the tailnet.
 */
export function colorLane(board: Board, laneId: string, color: unknown): Board {
  if (!board.columns || !hasLane(board, laneId)) return board;
  if (color !== null && !isWorkspaceColor(color)) return board;
  return { ...board, columns: board.columns.map((lane) => (lane.id === laneId ? { ...lane, color } : lane)) };
}

export function renameLane(board: Board, laneId: string, name: unknown): Board {
  const clean = text(name, LANE_NAME_MAX);
  if (!board.columns || !clean || !hasLane(board, laneId)) return board;
  return { ...board, columns: board.columns.map((lane) => (lane.id === laneId ? { ...lane, name: clean } : lane)) };
}

/** Put a column at a place among the rest, counted with it taken out — `moveCard`'s index. */
export function moveLane(board: Board, laneId: string, index: unknown): Board {
  if (!board.columns || !Number.isInteger(index) || (index as number) < 0) return board;
  const lane = board.columns.find((l) => l.id === laneId);
  if (!lane) return board;
  const rest = board.columns.filter((l) => l !== lane);
  const at = Math.min(index as number, rest.length);
  return { ...board, columns: [...rest.slice(0, at), lane, ...rest.slice(at)] };
}

/**
 * Take a column away. Its cards are not taken with it: they go to the foot of
 * the column to its left — or its right, for the first — in the order they
 * were in, because deleting a heading is not deleting the work under it. The
 * last column stays, for `adoptLanes`'s reason.
 */
export function removeLane(board: Board, laneId: string): Board {
  if (!board.columns || board.columns.length < 2) return board;
  const at = board.columns.findIndex((l) => l.id === laneId);
  if (at < 0) return board;
  const into = board.columns[at === 0 ? 1 : at - 1]!.id;
  const columns = board.columns.filter((l) => l.id !== laneId);
  const kept = board.cards.filter((c) => c.column !== laneId);
  const moved = board.cards.filter((c) => c.column === laneId).map((c) => ({ ...c, column: into }));
  const last = kept.filter((c) => c.column === into).at(-1);
  const pos = last ? kept.indexOf(last) + 1 : kept.length;
  return { ...board, columns, cards: [...kept.slice(0, pos), ...moved, ...kept.slice(pos)] };
}

/**
 * The code a card is known by: the first three letters of its workspace's
 * name and its number, `KUR-12`. Worked out where it is drawn rather than
 * stored, so that it follows the workspace when that is renamed.
 */
export function cardCode(workspaceName: string, number: number): string {
  const prefix = workspaceName.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 3).toUpperCase();
  return prefix ? `${prefix}-${number}` : `#${number}`;
}

/** One card's bar on a timeline: where it starts among the days drawn, and how many it covers. */
export interface TimelineRow {
  card: Card;
  /** The first day of the bar that is drawn, counted from the window's first day. */
  at: number;
  span: number;
  /** The card's dates run past this edge of the window, so the bar's end there is a cut and not an end. */
  cutStart: boolean;
  cutEnd: boolean;
}

export interface Timeline {
  rows: TimelineRow[];
  /** Dated cards that are wholly outside the window, by side — what the arrows say is waiting there. */
  earlier: number;
  later: number;
  /** The cards with no dates, in the order the board holds them. */
  loose: Card[];
}

/**
 * A board as a timeline sees it: the cards that touch a window of `days` days
 * beginning at `first`, each as a bar clipped to it.
 *
 * A window rather than the whole span of the board's dates, because a span is
 * as wide as its worst card: one ticket dated to next year by a slip of the
 * finger would be three hundred empty columns between the work and the typo.
 * What is outside is counted instead of drawn, so that an empty window with
 * cards either side of it does not read as an empty calendar.
 *
 * Ordered by when each starts, then by which ends first, then by number — so
 * the rows read down the page in the order the days read across it, and two
 * cards on the same days keep the order they were written in.
 */
export function timeline(board: Board, first: number, days: number): Timeline {
  const out: Timeline = { rows: [], earlier: 0, later: 0, loose: [] };
  if (!Number.isInteger(first) || !Number.isInteger(days) || days < 1) return out;
  const last = first + days - 1;
  const spans: { card: Card; from: number; to: number }[] = [];
  for (const card of board.cards) {
    const from = card.dates ? dayNumber(card.dates.start) : null;
    const to = card.dates ? dayNumber(card.dates.end) : null;
    if (from === null || to === null) out.loose.push(card);
    else if (to < first) out.earlier++;
    else if (from > last) out.later++;
    else spans.push({ card, from, to });
  }
  spans.sort((a, b) => a.from - b.from || a.to - b.to || a.card.number - b.card.number);
  out.rows = spans.map(({ card, from, to }) => {
    const start = Math.max(from, first);
    return { card, at: start - first, span: Math.min(to, last) - start + 1, cutStart: from < first, cutEnd: to > last };
  });
  return out;
}

/**
 * A card's dates after a bar has been dragged by `by` days: the whole bar, or
 * one end of it.
 *
 * An end dragged past the other stops at it, leaving one day, rather than
 * turning the range inside out — the hand is still holding the same end, and
 * a bar that flipped under it would have the drag suddenly moving the other
 * one. This is the one place a range is clamped, and it may be because
 * nothing here came off a wire: the result goes to the server as an ordinary
 * edit and is held to `adoptDates` there like any other.
 */
export function shiftDates(dates: CardDates, by: number, edge: "both" | "start" | "end"): CardDates {
  const from = dayNumber(dates.start);
  const to = dayNumber(dates.end);
  if (from === null || to === null || !Number.isInteger(by)) return dates;
  if (edge === "start") return { start: dayAt(Math.min(from + by, to)), end: dates.end };
  if (edge === "end") return { start: dates.start, end: dayAt(Math.max(to + by, from)) };
  return { start: dayAt(from + by), end: dayAt(to + by) };
}

/**
 * Four strings or nothing. A worktree with a field missing is not one kururu
 * can merge or remove, so it is dropped rather than half-carried — the
 * directory, if it exists, is still there for a person to find.
 */
function adoptWorktree(value: unknown): CardWorktree | null {
  if (!value || typeof value !== "object") return null;
  const { root, path, branch, base } = value as Record<string, unknown>;
  if (typeof root !== "string" || typeof path !== "string" || typeof branch !== "string" || typeof base !== "string") return null;
  if (!root.startsWith("/") || !path.startsWith("/") || !branch || !base) return null;
  return { root, path, branch, base };
}

/**
 * A port the kernel could have handed out, or nothing. The terminal id is kept
 * when there is one, since this is also how the board crosses a server restart
 * with its terminals still running; `storedBoard` is what drops it.
 */
function adoptDev(value: unknown): CardDev | null {
  if (!value || typeof value !== "object") return null;
  const { agentId, port } = value as Record<string, unknown>;
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) return null;
  return { agentId: typeof agentId === "string" ? agentId : null, port: port as number };
}

const RUN_STATES: readonly RunState[] = ["starting", "working", "blocked", "finished", "ended"];

function adoptRun(value: unknown): CardRun | null {
  if (!value || typeof value !== "object") return null;
  const run = value as Record<string, unknown>;
  if (typeof run.launcher !== "string") return null;
  const agentId = typeof run.agentId === "string" ? run.agentId : null;
  let state: RunState = RUN_STATES.includes(run.state as RunState) ? (run.state as RunState) : "ended";
  if (agentId === null && state !== "finished") state = "ended";
  return {
    agentId,
    launcher: run.launcher,
    label: typeof run.label === "string" ? run.label : run.launcher,
    state,
    startedAt: Number.isFinite(run.startedAt) ? (run.startedAt as number) : 0,
    endedAt: Number.isFinite(run.endedAt) ? (run.endedAt as number) : null,
    // Both end up on a command line or as a pty's cwd, and this file can be
    // hand-edited: an id that is not a UUID is dropped, a cwd that is not
    // absolute likewise.
    sessionId: typeof run.sessionId === "string" && SESSION_ID.test(run.sessionId) ? run.sessionId : null,
    cwd: typeof run.cwd === "string" && run.cwd.startsWith("/") ? run.cwd : null,
  };
}

/**
 * Whether a card's last run can be picked up where it left off: its agent has
 * gone, and it was one whose conversation kururu can find again. A run whose
 * terminal is still open is not resumable — it is *running*, and a second
 * `--resume` of one conversation is two agents writing one transcript.
 */
export function canResume(run: CardRun | null, open: boolean): boolean {
  return run !== null && !open && (run.sessionId !== null || run.launcher.startsWith("codex"));
}

/**
 * The board as `persist.ts` writes it: every card, and no process ids. A dev
 * server is nothing *but* a process, so it goes entirely — a cold start has
 * no terminal to point at, and the next robot press starts a fresh one.
 */
export function storedBoard(board: Board): Board {
  return {
    ...board,
    cards: board.cards.map((card) => ({ ...card, run: card.run ? { ...card.run, agentId: null } : null, dev: null })),
  };
}
