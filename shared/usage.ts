/**
 * The ledger's pure half: what a billed message is once it has been read off
 * a log, whose it was, and which day it falls on.
 *
 * Claude Code deletes a transcript thirty days after it was written, and with
 * it the only record of what that session spent. The ledger is the durable
 * copy, and it keeps numbers and never words: a raw log is two thirds tool
 * output and holds everything the user's projects hold. So the rows here have
 * no field a sentence could arrive in, and titles come from kururu when a page
 * draws them, never from a transcript.
 *
 * Two questions live here because they are arithmetic rather than disk, and
 * because the page will want them too. **Whose was it:** a transcript knows its
 * folder and nothing else, and what kururu knows is in the database, so
 * `attributionFor` takes the two and says which won and why. **Which day:**
 * days are the Mac's, the way the user speaks of them, and so a rollup that is
 * bucketed in the wrong zone is a chart that disagrees with their memory; the
 * limit week is the account's own instant and is not a thing this file knows.
 */

export type UsageProgram = "claude" | "codex" | "opencode";
/** Which log a row came from. A subagent's turns are in a file of their own and nowhere else. */
export type UsageSource = "transcript" | "subagent" | "rollout" | "opencode";
export type SessionKind = "harness" | "agent" | "card";
/** What named a session: a launch record, the database's two tables, or only the folder it ran in. */
export type AttributedBy = "spawn" | "card_runs" | "conversations" | "folder";

/** One billed API message. A streamed reply is several records of one message, and this is the message. */
export interface MessageRow {
  sessionId: string;
  messageId: string;
  at: number;
  model: string;
  requestedModel: string | null;
  effort: string | null;
  input: number;
  write5m: number;
  write1h: number;
  read: number;
  output: number;
  thinking: number;
  costEst: number | null;
  sidechain: boolean;
  source: UsageSource;
}

/** What a program says a session spent on one model, as it says it. A cross-check, never the source of a row. */
export interface TotalsRow {
  sessionId: string;
  model: string;
  input: number;
  output: number;
  thinking: number;
  read: number;
  write5m: number;
  write1h: number;
  costProgram: number | null;
  at: number;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/**
 * A count off a log, or null when it is not one. Absent is zero, since older
 * records simply do not have the newer fields; anything else that is not a
 * non-negative finite number makes the record unreadable, and the caller
 * counts it as skipped rather than letting it reach a sum, where one NaN would
 * lose a whole day. Numbers off a file are numbers off the wire.
 */
export function countOf(value: unknown): number | null {
  if (value === undefined || value === null) return 0;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * How a message's cache writes split between the two lifetimes, which are
 * priced differently. Older records state only a total, and a total with no
 * split is read as the five-minute kind, which was the only one then. When the
 * two disagree the total is what the tokens column must add up to, so the
 * difference goes to the five-minute side, and a split larger than its total
 * (two records in this Mac's logs) is believed as stated.
 */
export function splitCacheWrite(total: number, stated5m: number, stated1h: number): { write5m: number; write1h: number } {
  const remainder = total - stated5m - stated1h;
  return { write5m: remainder > 0 ? stated5m + remainder : stated5m, write1h: stated1h };
}

/** Everything a message sent and received: the column the page calls tokens. */
export function tokensOf(row: Pick<MessageRow, "input" | "write5m" | "write1h" | "read" | "output">): number {
  return row.input + row.write5m + row.write1h + row.read + row.output;
}

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

function two(n: number): string {
  return String(n).padStart(2, "0");
}

/** The local day a moment fell on, as `YYYY-MM-DD`. */
export function dayOf(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/**
 * Where a local day starts and stops, in epoch ms. Through the calendar rather
 * than by adding 86,400,000, because a change of clocks makes a day of
 * twenty-three or twenty-five hours and the arithmetic would lose an hour of
 * somebody's messages to the day beside it.
 */
export function dayBounds(day: string): { start: number; end: number } {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return { start: new Date(year, month - 1, date).getTime(), end: new Date(year, month - 1, date + 1).getTime() };
}

// ---------------------------------------------------------------------------
// Whose it was
// ---------------------------------------------------------------------------

/** The folder `harnessHome` makes for a profile, as Claude Code spells a project directory. */
const HARNESS_PROJECT = /-harness-(pk[0-9a-f]{12})$/;

/**
 * The profile whose harness ran in this project directory, or null. By the
 * folder's spelling and not the whole path, so a data directory that moved
 * still reads its old transcripts as Kuru's.
 */
export function harnessProfileOf(projectDir: string): string | null {
  return HARNESS_PROJECT.exec(projectDir)?.[1] ?? null;
}

/** How a harness that ran in a project's folder, before it had its own, is known: `--name harness`, in its first records. */
export const HARNESS_TITLE = '"customTitle":"harness"';
/** The title is written early, and this is `harnesshome.ts`'s reading of early. */
export const HARNESS_TITLE_HEAD = 64 * 1024;

export interface RunFact {
  sessionId: string;
  runId: number;
  cardId: string;
  agentId: string | null;
  profileKey: string;
  workspaceKey: string | null;
}

export interface ConversationFact {
  sessionId: string;
  kind: string;
  profileKey: string;
}

/** What kururu's database knows about sessions, indexed. */
export interface AttributionFacts {
  runs: ReadonlyMap<string, RunFact>;
  conversations: ReadonlyMap<string, ConversationFact>;
  /** The profile a login directory belongs to, when exactly one does. */
  profileOfLogin: ReadonlyMap<string, string>;
}

export function noFacts(): AttributionFacts {
  return { runs: new Map(), conversations: new Map(), profileOfLogin: new Map() };
}

/** What a log itself can say about whose it was. */
export interface SeenInLog {
  projectDir: string;
  /** Whether its head carried the harness's title. */
  titled: boolean;
  loginKey: string | null;
}

export interface Attribution {
  profileKey: string | null;
  workspaceKey: string | null;
  cardId: string | null;
  runId: number | null;
  agentId: string | null;
  kind: SessionKind;
  attributedBy: AttributedBy;
}

/**
 * Whose a session was, from the strongest thing that names it: a card's run,
 * then anything that says harness, then the conversations table, then the
 * folder. A session nothing names is still somebody's profile when its login
 * has one owner, and the page says it is folder-only.
 */
export function attributionFor(sessionId: string, seen: SeenInLog, facts: AttributionFacts): Attribution {
  const run = facts.runs.get(sessionId);
  if (run) {
    return {
      profileKey: run.profileKey,
      workspaceKey: run.workspaceKey,
      cardId: run.cardId,
      runId: run.runId,
      agentId: run.agentId,
      kind: "card",
      attributedBy: "card_runs",
    };
  }
  const none = { workspaceKey: null, cardId: null, runId: null, agentId: null };
  const conversation = facts.conversations.get(sessionId);
  const ofLogin = seen.loginKey ? (facts.profileOfLogin.get(seen.loginKey) ?? null) : null;
  const home = harnessProfileOf(seen.projectDir);
  if (conversation?.kind === "harness") return { ...none, profileKey: conversation.profileKey, kind: "harness", attributedBy: "conversations" };
  if (home) return { ...none, profileKey: home, kind: "harness", attributedBy: "folder" };
  if (seen.titled) return { ...none, profileKey: conversation?.profileKey ?? ofLogin, kind: "harness", attributedBy: "folder" };
  if (conversation) return { ...none, profileKey: conversation.profileKey, kind: "agent", attributedBy: "conversations" };
  return { ...none, profileKey: ofLogin, kind: "agent", attributedBy: "folder" };
}

const STRENGTH: Record<AttributedBy, number> = { folder: 0, conversations: 1, card_runs: 2, spawn: 3 };

/**
 * Two attributions of one session, as what the ledger should keep. A weaker
 * reading never replaces a stronger one, since the facts only ever grow and a
 * session read again from a later file knows less than the first read did: a
 * subagent's file has no title, and a harness read from it must stay one.
 */
export function strongerAttribution(held: Attribution, read: Attribution): Attribution {
  if (STRENGTH[read.attributedBy] < STRENGTH[held.attributedBy]) return held;
  if (read.attributedBy === held.attributedBy) {
    if (held.kind === "harness" && read.kind !== "harness") return held;
    if (held.profileKey !== null && read.profileKey === null) return held;
  }
  return read;
}

/** The fields that decide which row of `daily` a session's messages land on. */
export function sameRollupKeys(a: Attribution, b: Attribution): boolean {
  return a.profileKey === b.profileKey && a.workspaceKey === b.workspaceKey && a.cardId === b.cardId && a.kind === b.kind;
}

// ---------------------------------------------------------------------------
// What `/api/health` says
// ---------------------------------------------------------------------------

export interface LedgerStatus {
  messages: number;
  sessions: number;
  files: number;
  bytes: number;
  /** The first and last local day with a row, or null while there are none. */
  oldestDay: string | null;
  newestDay: string | null;
  /** Lines the parser would not read: a format that moved shows up here rather than as a quiet shortfall. */
  skipped: number;
  /** Messages whose model the price table does not have. */
  unpriced: number;
  /** A pass through the logs, while one has work: the bytes still to read shrink as it goes. */
  reading: { doneBytes: number; totalBytes: number; files: number } | null;
  /** When the last complete pass finished. */
  sweptAt: number | null;
  /** How the first pass of this process went. */
  firstPass: { ms: number; bytes: number; files: number } | null;
  /** Why it is not working, when it is not. The rest of the server carries on. */
  error: string | null;
}
