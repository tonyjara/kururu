/**
 * The store's pure half: what a board change *is*, written down, and the
 * shapes the database, the export and the search share with the window.
 *
 * Cards lived inside `session.json` with the layout, and the layout's rules
 * are the wrong rules for them. The file is state — rebuildable, ignored
 * whole on a version mismatch, written last-writer-wins by whichever server
 * was up — and cards are the one thing in kururu nobody can rebuild. So they
 * go to a database of their own (`server/src/store.ts`), and this file holds
 * the part of that which is arithmetic rather than disk: how a profile or a
 * workspace is known across cold starts, what a change to a board amounts to
 * as events, how a typed query becomes one FTS5 will take, and the rows an
 * export is made of.
 *
 * **Keys, not ids.** Profile and workspace ids are counters `persist.ts`
 * mints afresh on every cold start, and a login key may be shared by two
 * profiles, so neither can name a board on disk. A key is minted once when a
 * profile or workspace is made, written to the layout file and the host's
 * blob exactly as `loginKey` is, and never changes. The wire keeps its ids.
 *
 * **Events from a diff.** Every road onto a board — a client's verb, a
 * harness tool, the run automation, a card sent between boards — ends in one
 * pure function replacing one `Board` with another. Comparing the two is
 * therefore the one place the history can be written without instrumenting
 * each verb, and the one that cannot miss a road added later. Pure, tested.
 */
import type { Board, BoardLane, Card, CardDates, CardRun, CardWorktree } from "./board";
import { channelOfPrompt, readPeerMark, type ChannelKind } from "./channels";
import { sameMade } from "./made";
import type { VoiceLang } from "./voice";

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** What a profile's or a workspace's key looks like: a letter for which, `k`, and twelve hex digits. */
export const STORE_KEY = /^[pw]k[0-9a-f]{12}$/;

export function isStoreKey(value: unknown): value is string {
  return typeof value === "string" && STORE_KEY.test(value);
}

function mintKey(prefix: "pk" | "wk"): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return `${prefix}${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function mintProfileKey(): string {
  return mintKey("pk");
}

export function mintWorkspaceKey(): string {
  return mintKey("wk");
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Who changed a board: a person at a window, the harness through a tool, the
 * run automation, an import, or another node's Kuru through the link —
 * `peer:omarchy`, by the name it had then.
 */
export type Actor = "user" | "harness" | "automation" | "import" | `peer:${string}`;

export type EventKind = "created" | "edited" | "moved" | "sent" | "run" | "deleted" | "restored" | "imported";

/** One line of a card's history. `detail` is whatever the kind needs to say more than its columns do. */
export interface CardEvent {
  id: number;
  at: number;
  cardId: string;
  boardId: string;
  actor: Actor;
  kind: EventKind;
  fromColumn: string | null;
  toColumn: string | null;
  detail: Record<string, unknown> | null;
}

/** An event before the database has numbered it or placed it on a board. */
export type NewEvent = Omit<CardEvent, "id" | "boardId">;

/** What one board becoming another amounts to. */
export interface BoardDiff {
  added: Card[];
  changed: { before: Card; after: Card }[];
  removed: Card[];
  events: NewEvent[];
}

function sameDates(a: CardDates | null, b: CardDates | null): boolean {
  return a === b || (a !== null && b !== null && a.start === b.start && a.end === b.end);
}

function sameWorktree(a: CardWorktree | null, b: CardWorktree | null): boolean {
  return a === b || (a !== null && b !== null && a.root === b.root && a.path === b.path && a.branch === b.branch && a.base === b.base);
}

/** Whether two runs are the same run, which is the same start: a card's run is replaced whole when the robot is pressed again. */
export function sameRun(a: CardRun | null, b: CardRun | null): boolean {
  return a === b || (a !== null && b !== null && a.startedAt === b.startedAt && a.launcher === b.launcher);
}

/**
 * The events between two cards that are the same card. Order within a column,
 * the dev server and the links to what its agent made are not events: a drag
 * nobody wants a line for, a process, and a pointer at a file that every turn
 * may move.
 */
function cardEvents(before: Card, after: Card, at: number, actor: Actor): NewEvent[] {
  const out: NewEvent[] = [];
  if (before.column !== after.column) {
    out.push({ at, cardId: after.id, actor, kind: "moved", fromColumn: before.column, toColumn: after.column, detail: null });
  }
  const fields: string[] = [];
  const detail: Record<string, unknown> = {};
  if (before.title !== after.title) {
    fields.push("title");
    detail.title = { from: before.title, to: after.title };
  }
  if (before.body !== after.body) fields.push("body");
  if (before.isolate !== after.isolate) fields.push("isolate");
  if (!sameDates(before.dates, after.dates)) {
    fields.push("dates");
    detail.dates = { from: before.dates, to: after.dates };
  }
  if (!sameWorktree(before.worktree, after.worktree)) {
    fields.push("worktree");
    detail.worktree = after.worktree ? { branch: after.worktree.branch, base: after.worktree.base } : null;
  }
  if (fields.length) {
    out.push({ at, cardId: after.id, actor, kind: "edited", fromColumn: null, toColumn: null, detail: { fields, ...detail } });
  }
  if (!sameRun(before.run, after.run)) {
    if (after.run) {
      out.push({
        at,
        cardId: after.id,
        actor,
        kind: "run",
        fromColumn: null,
        toColumn: null,
        detail: { state: "started", launcher: after.run.launcher, label: after.run.label, sessionId: after.run.sessionId },
      });
    }
  } else if (before.run && after.run && before.run.state !== after.run.state) {
    out.push({ at, cardId: after.id, actor, kind: "run", fromColumn: null, toColumn: null, detail: { state: after.run.state, launcher: after.run.launcher } });
  }
  return out;
}

/** Whether anything an event or a row would notice differs. Position is included: it is written, if not announced. */
export function cardDiffers(before: Card, after: Card): boolean {
  return (
    before.title !== after.title ||
    before.body !== after.body ||
    before.column !== after.column ||
    before.number !== after.number ||
    before.isolate !== after.isolate ||
    !sameDates(before.dates, after.dates) ||
    !sameWorktree(before.worktree, after.worktree) ||
    !sameRun(before.run, after.run) ||
    before.run?.state !== after.run?.state ||
    before.run?.endedAt !== after.run?.endedAt ||
    before.run?.agentId !== after.run?.agentId ||
    // A Codex run's id arrives after it started, read off its rollout.
    before.run?.sessionId !== after.run?.sessionId ||
    before.dev?.agentId !== after.dev?.agentId ||
    before.dev?.port !== after.dev?.port ||
    !sameMade(before.made, after.made)
  );
}

/**
 * One board becoming another, as rows and as history. A card in `after` and
 * not in `before` was made; one the other way round was deleted; one in
 * both is changed when a row or an event would notice, and only then, so a
 * status tick that returned the same cards writes nothing.
 */
export function diffBoards(before: Board | null, after: Board, at: number, actor: Actor): BoardDiff {
  const was = new Map((before?.cards ?? []).map((card) => [card.id, card] as const));
  const diff: BoardDiff = { added: [], changed: [], removed: [], events: [] };
  const seen = new Set<string>();
  for (const card of after.cards) {
    seen.add(card.id);
    const old = was.get(card.id);
    if (!old) {
      diff.added.push(card);
      diff.events.push({ at, cardId: card.id, actor, kind: "created", fromColumn: null, toColumn: card.column, detail: { title: card.title } });
      continue;
    }
    if (old === card) continue;
    const events = cardEvents(old, card, at, actor);
    if (events.length || cardDiffers(old, card) || positionOf(before!, old.id) !== positionOf(after, card.id)) {
      diff.changed.push({ before: old, after: card });
      diff.events.push(...events);
    }
  }
  for (const card of before?.cards ?? []) {
    if (seen.has(card.id)) continue;
    diff.removed.push(card);
    diff.events.push({ at, cardId: card.id, actor, kind: "deleted", fromColumn: card.column, toColumn: null, detail: { title: card.title } });
  }
  return diff;
}

function positionOf(board: Board, cardId: string): number {
  return board.cards.findIndex((card) => card.id === cardId);
}

/**
 * The same card leaving one board and arriving on another in one change is a
 * transfer, not a death and a birth. Given every board's diff from one
 * profile change, the pairs are matched by id and both halves are rewritten
 * as one `sent` event, so the card's row keeps its history and moves.
 */
export function pairTransfers(diffs: { boardId: string; diff: BoardDiff }[]): { cardId: string; from: string; to: string }[] {
  const left = new Map<string, string>();
  for (const { boardId, diff } of diffs) for (const card of diff.removed) left.set(card.id, boardId);
  const sent: { cardId: string; from: string; to: string }[] = [];
  for (const { boardId, diff } of diffs) {
    for (const card of diff.added) {
      const from = left.get(card.id);
      if (from && from !== boardId) sent.push({ cardId: card.id, from, to: boardId });
    }
  }
  return sent;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * What somebody typed, as a query FTS5 will take. Its own grammar has
 * operators, column filters and a strict idea of a quote, and a stray `"` or
 * a lone `NOT` is an error rather than a miss. So every word is quoted as a
 * phrase and the last one is a prefix, which is what a search box means:
 * "migr ord" finds "Migración de órdenes" once the tokenizer has folded the
 * accents. Null for a query with no word in it.
 */
export function ftsQuery(text: string): string | null {
  const words = text
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((word) => word.length > 0)
    .slice(0, 16);
  if (words.length === 0) return null;
  return words.map((word, i) => `"${word.replaceAll('"', '""')}"${i === words.length - 1 ? "*" : ""}`).join(" ");
}

export type SearchScope = "all" | "cards" | "turns";

export interface CardHit {
  kind: "card";
  id: string;
  boardId: string;
  profileKey: string;
  /** Null on the profile's own board. */
  workspaceKey: string | null;
  workspaceName: string | null;
  profileName: string;
  number: number;
  title: string;
  column: string;
  /** The matching text, with the match marked by `[` and `]`. */
  snippet: string;
  deleted: boolean;
  /** When it last changed column, if it ever has. */
  movedAt: number | null;
  updatedAt: number;
  /** Filled in by the server for the window, which navigates by id: this session's ids, or null when not on screen. */
  profileId?: string | null;
  workspaceId?: string | null;
}

export type TurnRole = "you" | "kuru" | "agent";
/** Where a turn came from: typed here, spoken, a line Kuru said mid-turn, or a channel such as Telegram (`shared/channels.ts`). */
export type TurnVia = "typed" | "voice" | "kururu" | ChannelKind;

export interface TurnHit {
  kind: "turn";
  id: number;
  conversationId: string;
  conversationKind: ConversationKind;
  profileKey: string;
  role: TurnRole;
  via: TurnVia;
  at: number;
  snippet: string;
  /** The whole turn, capped, for the window to open. */
  text: string;
  profileId?: string | null;
}

export type SearchHit = CardHit | TurnHit;

export function isSearchScope(value: unknown): value is SearchScope {
  return value === "all" || value === "cards" || value === "turns";
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export type ConversationKind = "harness" | "agent";

export interface Turn {
  id: number;
  conversationId: string;
  at: number;
  role: TurnRole;
  via: TurnVia;
  text: string;
  lang: VoiceLang | null;
  /** The outbox message this turn delivered, when it was spoken. */
  voiceId: string | null;
}

export interface Conversation {
  id: string;
  profileKey: string;
  kind: ConversationKind;
  launcher: string | null;
  cwd: string | null;
  startedAt: number;
}

/** The prefix the voice puts on words it heard, which is how a typed turn is told from a spoken one. */
export const VOICE_PREFIX = "[voice]";

/**
 * Where a prompt came from, by its mark. Words from another node carry that
 * node's mark ahead of the voice's (`peerWords`), and the voice's is still
 * the truth about them: `[user@mac] [voice] …` was spoken, on the Mac.
 */
export function viaOf(text: string): TurnVia {
  const words = readPeerMark(text)?.rest ?? text;
  if (words.startsWith(VOICE_PREFIX)) return "voice";
  return channelOfPrompt(words) ?? "typed";
}

/**
 * A long turn with lines in it goes into the harness as a paste — a single
 * line is typed, see `typingPieces` — and so does one the user pasted into
 * its terminal themselves, and Claude Code's own `UserPromptSubmit` hook
 * reports either back wrapped in `<pasted_content id="…">` tags rather than
 * the words alone. Anchored to the whole string, not found anywhere in it,
 * because the wrapper is the entire prompt when it fires — stripping a
 * substring match would also eat a turn that is legitimately talking about
 * the tag itself.
 */
const PASTED_CONTENT = /^\s*<pasted_content id="([^"]*)">\s*([\s\S]*?)\s*<\/pasted_content id="\1">\s*$/;

export function stripPastedContent(text: string): string {
  return text.match(PASTED_CONTENT)?.[2] ?? text;
}

/** The session id a Claude transcript's path names: the file is `<id>.jsonl`. Null for anything else. */
export function sessionOfTranscript(path: string | null | undefined): string | null {
  if (!path) return null;
  const file = path.slice(path.lastIndexOf("/") + 1);
  if (!file.endsWith(".jsonl")) return null;
  const id = file.slice(0, -".jsonl".length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) ? id : null;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** The export's format, stamped into every file so a later reader knows what it has. */
export const EXPORT_VERSION = 1;

export interface RunExport {
  launcher: string;
  label: string;
  state: CardRun["state"];
  startedAt: number;
  endedAt: number | null;
  sessionId: string | null;
  cwd: string | null;
}

export interface EventExport {
  at: number;
  actor: Actor;
  kind: EventKind;
  fromColumn: string | null;
  toColumn: string | null;
  detail: Record<string, unknown> | null;
}

/** A card as the export writes it: every column of its row, every run and every event, nothing about processes. */
export interface CardExport {
  id: string;
  number: number;
  title: string;
  body: string;
  column: string;
  position: number;
  isolate: boolean;
  dates: CardDates | null;
  worktree: CardWorktree | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  runs: RunExport[];
  events: EventExport[];
}

/** One board, one file. */
export interface BoardExport {
  version: typeof EXPORT_VERSION;
  profile: { key: string; name: string; loginKey: string | null };
  /** Null for the profile's own board. */
  workspace: { key: string; name: string } | null;
  board: { id: string; next: number; columns: BoardLane[] | null; createdAt: number };
  cards: CardExport[];
}

/** One conversation, one file: this header on the first line and a turn on each line after it. */
export interface ConversationExport extends Conversation {
  version: typeof EXPORT_VERSION;
  profileName: string;
}

export type TurnExport = Omit<Turn, "id" | "conversationId">;

/** Every record a mirror tree holds that the database can be rebuilt from. */
export interface DataExport {
  boards: BoardExport[];
  conversations: { header: ConversationExport; turns: TurnExport[] }[];
}

/**
 * A file name a board or a conversation is written under: the name as a
 * person would recognise it, folded to what every filesystem takes, with
 * the key on the end so two workspaces called "main" are two files. A
 * rename is then a rename in git, which it tracks.
 */
export function exportName(name: string, key: string): string {
  const folded = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 40);
  return folded ? `${folded}-${key}` : key;
}
