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
}

export interface Card {
  /** Random rather than from `nextId`, whose counter only knows about panes. */
  id: string;
  title: string;
  body: string;
  column: BoardColumn;
  createdAt: number;
  run: CardRun | null;
}

export interface Board {
  /** In column order is not guaranteed; within a column, this order is the order drawn. */
  cards: Card[];
}

/** Long enough for a real ticket, short enough that a bad paste is not a megabyte in every snapshot. */
export const TITLE_MAX = 200;
export const BODY_MAX = 20_000;

export function emptyBoard(): Board {
  return { cards: [] };
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

/** A new card at the foot of its column. A card with no title is not a card. */
export function addCard(board: Board, fields: { title: unknown; body?: unknown; column?: unknown }, id: string, now: number): Board {
  const title = text(fields.title, TITLE_MAX);
  if (!title) return board;
  const card: Card = {
    id,
    title,
    body: text(fields.body, BODY_MAX) ?? "",
    column: isBoardColumn(fields.column) ? fields.column : "todo",
    createdAt: now,
    run: null,
  };
  return { cards: [...board.cards, card] };
}

export function editCard(board: Board, cardId: string, fields: { title?: unknown; body?: unknown }): Board {
  const title = fields.title === undefined ? undefined : text(fields.title, TITLE_MAX);
  const body = fields.body === undefined ? undefined : text(fields.body, BODY_MAX);
  // An emptied title is refused rather than applied, for `addCard`'s reason.
  if (title === "" || title === null || body === null) return board;
  return {
    cards: board.cards.map((card) =>
      card.id === cardId ? { ...card, ...(title !== undefined ? { title } : {}), ...(body !== undefined ? { body } : {}) } : card,
    ),
  };
}

export function removeCard(board: Board, cardId: string): Board {
  return { cards: board.cards.filter((card) => card.id !== cardId) };
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
  if (!card || !isBoardColumn(column)) return board;
  if (index !== undefined && (!Number.isInteger(index) || (index as number) < 0)) return board;
  const rest = board.cards.filter((c) => c.id !== cardId);
  const moved = { ...card, column };
  const inColumn = rest.filter((c) => c.column === column);
  const before = index === undefined ? undefined : inColumn[index as number];
  if (!before) {
    // The foot of the column: after its last card, or at the end of everything.
    const last = inColumn.at(-1);
    const at = last ? rest.indexOf(last) + 1 : rest.length;
    return { cards: [...rest.slice(0, at), moved, ...rest.slice(at)] };
  }
  const at = rest.indexOf(before);
  return { cards: [...rest.slice(0, at), moved, ...rest.slice(at)] };
}

/** A board's cards, a column at a time, in the order they are drawn. */
export function columnCards(board: Board, column: BoardColumn): Card[] {
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
export function startRun(board: Board, cardId: string, run: Omit<CardRun, "state" | "endedAt">): Board {
  return {
    cards: board.cards.map((card) =>
      card.id === cardId ? { ...card, column: "doing", run: { ...run, state: "starting", endedAt: null } } : card,
    ),
  };
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
  return changed ? { cards } : board;
}

/**
 * The prompt a card becomes. The title leads because it is the sentence the
 * card was written as; the body is the detail under it.
 */
export function cardPrompt(card: Pick<Card, "title" | "body">): string {
  return card.body ? `${card.title}\n\n${card.body}` : card.title;
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
  const raw = (value as { cards?: unknown }).cards;
  if (!Array.isArray(raw)) return emptyBoard();
  const cards: Card[] = [];
  for (const item of raw as Record<string, unknown>[]) {
    if (!item || typeof item !== "object") continue;
    const title = text(item.title, TITLE_MAX);
    if (!title || typeof item.id !== "string") continue;
    cards.push({
      id: item.id,
      title,
      body: text(item.body, BODY_MAX) ?? "",
      column: isBoardColumn(item.column) ? item.column : "todo",
      createdAt: Number.isFinite(item.createdAt) ? (item.createdAt as number) : 0,
      run: adoptRun(item.run),
    });
  }
  return { cards };
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
  };
}

/** The board as `persist.ts` writes it: every card, and no process ids. */
export function storedBoard(board: Board): Board {
  return {
    cards: board.cards.map((card) => ({ ...card, run: card.run ? { ...card.run, agentId: null } : null })),
  };
}
