/**
 * What one node tells its parent about what it has spent, and how the parent
 * takes it.
 *
 * Each node reads its own logs into its own ledger, so a parent never sees a
 * log and never needs an agent's folder on its own disk. What crosses the link
 * is a rollup, because that is what stops ten nodes making ten ledgers of the
 * parent's: one row per session, per model, per **quarter hour**. Not per day,
 * though the plan first said so and the rollups on disk are, for two reasons a
 * day cannot meet. A day is the local day of the node that cut it, and a box on
 * UTC would draw Thursday night's work on the Mac's Friday; a quarter hour is an
 * instant, and every zone there is falls on one, so the parent cuts its own days.
 * And the page has to answer "today so far" and a limit week that starts at ten
 * past four, which it does off the messages here and could not do for a node
 * holding only whole days.
 *
 * **A day is the unit of asking.** The parent says what it holds for each of the
 * node's days, as that day's signature off `daily`, and the node sends the days
 * that differ, each whole, each replacing what was there. No cursor to lose: a
 * backfill that finds last month, or a session a card comes to name after the
 * fact, moves a signature, and that day crosses again. Nothing is ever deleted
 * from here because a node stopped mentioning it, since a node's ledger can be
 * younger than what it told us.
 *
 * Numbers, ids, model names and folders, and the names of its workspaces and
 * cards, which the page has no other way to say and which the link already
 * carries in a summary and a mirror. Never a qualified id: `adoptUsagePart`
 * refuses one, because this goes to disk. Everything is checked here, because it
 * is off the wire, and a row that fails is dropped rather than repaired.
 */
import { containsQualified } from "./remote";
import { countOf, type AttributedBy, type SessionKind, type UsageProgram } from "./usage";

/** One session, on one model, over one quarter hour. `at` is where the quarter starts. */
export interface PulledCell {
  sessionId: string;
  model: string;
  at: number;
  messages: number;
  input: number;
  write5m: number;
  write1h: number;
  read: number;
  output: number;
  thinking: number;
  cost: number;
  unpriced: number;
}

/** A session as the node has it. No terminal id, which means nothing here and could be somebody's here. */
export interface PulledSession {
  id: string;
  program: UsageProgram;
  kind: SessionKind;
  profileKey: string | null;
  workspaceKey: string | null;
  cardId: string | null;
  /** A machine that node reached it on, by the name it calls it. */
  machine: string | null;
  cwd: string | null;
  attributedBy: AttributedBy;
  startedAt: number;
  lastAt: number;
  /** What the program says the whole session spent, in dollars, where it says. */
  says: number | null;
}

export interface PulledDay {
  /** The node's own local day, known only as the name of what is being replaced. */
  day: string;
  sig: string;
  cells: PulledCell[];
}

export interface UsagePart {
  days: PulledDay[];
  /** Every session a cell here names. */
  sessions: PulledSession[];
  names: { workspaces: Record<string, string>; cards: Record<string, string> };
  /** More days differ than one answer holds: ask again. */
  more: boolean;
}

/**
 * How much one answer carries before the rest wait for the next, in rows of the
 * node's `session_days`, which it can count without making any of them. A busy
 * session's day is a dozen or two quarter hours, so this is a frame of a few
 * megabytes, and the link's pings wait behind it.
 */
export const USAGE_PART_WEIGHT = 1_000;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SIG = /^[0-9a-f]{8,64}$/;
const ID = /^[\w.:-]{1,128}$/;
const MODEL = /^[\w.:<>\[\]-]{0,96}$/;
const MAX_CWD = 1024;
const MAX_NAME = 200;
const MAX_DAYS = 20_000;
const PROGRAMS: readonly string[] = ["claude", "codex", "opencode"] satisfies UsageProgram[];
const KINDS: readonly string[] = ["harness", "agent", "card"] satisfies SessionKind[];
const NAMED_BY: readonly string[] = ["spawn", "report", "card_runs", "conversations", "folder"] satisfies AttributedBy[];

function idOf(value: unknown): string | null {
  return typeof value === "string" && ID.test(value) && !containsQualified(value) ? value : null;
}

function optionalId(value: unknown): { ok: boolean; value: string | null } {
  if (value === null || value === undefined) return { ok: true, value: null };
  const id = idOf(value);
  return { ok: id !== null, value: id };
}

function momentOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function adoptCell(raw: unknown): PulledCell | null {
  if (!raw || typeof raw !== "object") return null;
  const cell = raw as Record<string, unknown>;
  const sessionId = idOf(cell.sessionId);
  const at = momentOf(cell.at);
  const model = typeof cell.model === "string" && MODEL.test(cell.model) ? cell.model : null;
  if (sessionId === null || at === null || model === null) return null;
  const numbers = [cell.messages, cell.input, cell.write5m, cell.write1h, cell.read, cell.output, cell.thinking, cell.cost, cell.unpriced].map((value) =>
    value === undefined || value === null ? null : countOf(value),
  );
  if (numbers.some((value) => value === null)) return null;
  const [messages, input, write5m, write1h, read, output, thinking, cost, unpriced] = numbers as number[];
  return { sessionId, model, at, messages: messages!, input: input!, write5m: write5m!, write1h: write1h!, read: read!, output: output!, thinking: thinking!, cost: cost!, unpriced: unpriced! };
}

function adoptSession(raw: unknown): PulledSession | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = idOf(row.id);
  const startedAt = momentOf(row.startedAt);
  const lastAt = momentOf(row.lastAt);
  if (id === null || startedAt === null || lastAt === null) return null;
  if (!PROGRAMS.includes(row.program as string) || !KINDS.includes(row.kind as string) || !NAMED_BY.includes(row.attributedBy as string)) return null;
  const profile = optionalId(row.profileKey);
  const workspace = optionalId(row.workspaceKey);
  const card = optionalId(row.cardId);
  if (!profile.ok || !workspace.ok || !card.ok) return null;
  const machine = typeof row.machine === "string" && row.machine.length <= MAX_NAME && !containsQualified(row.machine) ? row.machine : null;
  const cwd = typeof row.cwd === "string" && row.cwd.length <= MAX_CWD && !containsQualified(row.cwd) ? row.cwd : null;
  const says = typeof row.says === "number" && Number.isFinite(row.says) && row.says >= 0 ? row.says : null;
  return {
    id,
    program: row.program as UsageProgram,
    kind: row.kind as SessionKind,
    profileKey: profile.value,
    workspaceKey: workspace.value,
    cardId: card.value,
    machine,
    cwd,
    attributedBy: row.attributedBy as AttributedBy,
    startedAt,
    lastAt,
    says,
  };
}

function adoptNames(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (idOf(key) === null || typeof value !== "string" || !value || containsQualified(value)) continue;
    out[key] = value.slice(0, MAX_NAME);
  }
  return out;
}

/**
 * An answer off the link, as only what is sound in it, or null when it is not
 * an answer. A cell whose session did not come with it is dropped too: it could
 * only be drawn as a session nobody knows.
 */
export function adoptUsagePart(raw: unknown): UsagePart | null {
  if (!raw || typeof raw !== "object") return null;
  const part = raw as Record<string, unknown>;
  if (!Array.isArray(part.days) || !Array.isArray(part.sessions)) return null;
  const sessions = part.sessions.map(adoptSession).filter((row): row is PulledSession => row !== null);
  const known = new Set(sessions.map((row) => row.id));
  const days: PulledDay[] = [];
  for (const each of part.days as unknown[]) {
    if (!each || typeof each !== "object") continue;
    const { day, sig, cells } = each as Record<string, unknown>;
    if (typeof day !== "string" || !DAY.test(day) || typeof sig !== "string" || !SIG.test(sig) || !Array.isArray(cells)) continue;
    days.push({ day, sig, cells: cells.map(adoptCell).filter((cell): cell is PulledCell => cell !== null && known.has(cell.sessionId)) });
  }
  const names = (part.names ?? {}) as Record<string, unknown>;
  return { days, sessions, names: { workspaces: adoptNames(names.workspaces), cards: adoptNames(names.cards) }, more: part.more === true };
}

/** What the parent says it holds, off the link at the node's end: day to signature, and nothing else. */
export function adoptKnownDays(raw: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw || typeof raw !== "object") return out;
  for (const [day, sig] of Object.entries(raw as Record<string, unknown>)) {
    if (out.size >= MAX_DAYS) break;
    if (DAY.test(day) && typeof sig === "string" && SIG.test(sig)) out.set(day, sig);
  }
  return out;
}

/**
 * Which days to send, newest first, since it is this week somebody is looking
 * at, as many as fit. A day crosses whole or not at all, and the first always
 * crosses however large, or an enormous day would stop everything behind it.
 */
export function daysToSend(current: readonly { day: string; sig: string }[], known: ReadonlyMap<string, string>, weightOf: (day: string) => number, budget = USAGE_PART_WEIGHT): { days: { day: string; sig: string }[]; more: boolean } {
  const differing = current.filter((each) => known.get(each.day) !== each.sig).sort((a, b) => b.day.localeCompare(a.day));
  const days: { day: string; sig: string }[] = [];
  let used = 0;
  for (const each of differing) {
    const weight = weightOf(each.day);
    if (days.length && used + weight > budget) return { days, more: true };
    days.push(each);
    used += weight;
  }
  return { days, more: false };
}

/** A computer that is not this one, as the Usage page's foot says it. */
export interface RemoteSource {
  name: string;
  kind: "machine" | "node";
  /** When its numbers were last read; null when they have not been since this server started, for a machine. */
  at: number | null;
  /** Why they could not be, in ssh's or the link's words. */
  error: string | null;
}
