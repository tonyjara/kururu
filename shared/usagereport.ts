/**
 * What the Usage page draws, worked out from the ledger's rows.
 *
 * Pure and in `shared/` because every interesting mistake on that page is
 * arithmetic: a session counted because a launch wrote its row before it had
 * said a word, a limit week cut at the wrong instant, a workspace that changes
 * colour when the range does, a Kuru that disappears into Other. A chart that
 * is wrong in those ways looks exactly as convincing as one that is right, so
 * the numbers are settled here where a test can reach them and the page only
 * draws what it is given.
 *
 * **Everything is counted off cells, never off `sessions`.** A cell is one
 * session on one model over one slice of time, read from the rollup or, at the
 * edges of a range that does not fall on midnight, from the messages. A
 * `sessions` row can exist before its first message, since a launch writes it,
 * and such a row must not count as a session anybody spent anything in. So
 * `sessions` is only ever looked up by an id a cell has already named.
 *
 * Words come from kururu and never from a log. A workspace is named by the
 * database, a card by its title, a session with neither by the folder it ran in
 * and the day. The transcript's own `ai-title` can quote the conversation and is
 * not read at all.
 */
import { priceOf } from "./prices";
import { dayBounds, dayOf, tokensOf, type AttributedBy, type SessionKind, type UsageProgram } from "./usage";
import { SERIES_SLOTS } from "./chartcolor";

export const USAGE_RANGES = ["week", "today", "7d", "30d", "all"] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];
export const USAGE_DIMENSIONS = ["workspace", "kuru", "card", "agent", "model", "program"] as const;
export type UsageDimension = (typeof USAGE_DIMENSIONS)[number];

export function isUsageRange(value: unknown): value is UsageRange {
  return typeof value === "string" && (USAGE_RANGES as readonly string[]).includes(value);
}

export function isUsageDimension(value: unknown): value is UsageDimension {
  return typeof value === "string" && (USAGE_DIMENSIONS as readonly string[]).includes(value);
}

/** One session on one model over one slice of time. `at` is where the slice starts: all a bucket needs. */
export interface UsageCell {
  at: number;
  sessionId: string;
  model: string;
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

/** What the ledger knows about a session, looked up by an id a cell named. */
export interface SessionFact {
  id: string;
  program: UsageProgram;
  kind: SessionKind;
  workspaceKey: string | null;
  cardId: string | null;
  cwd: string | null;
  attributedBy: AttributedBy;
  agentId: string | null;
  startedAt: number;
  lastAt: number;
}

/** What kururu calls things, and what is alive enough to be gone to. Only ever from kururu. */
export interface UsageNames {
  workspace(key: string): string | null;
  card(id: string): string | null;
  /** The terminal this session is running in now, if it is. */
  liveAgent(fact: SessionFact): { id: string; label: string } | null;
  /** The card's board, when this window could open it. */
  openableCard(id: string): { workspaceId: string } | null;
  /** A folder as it is drawn: `~` for the home folder. */
  folder(path: string): string;
}

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

export const WEEK_MS = 7 * 86_400_000;

export interface RangeBounds {
  id: UsageRange;
  from: number;
  to: number;
  /** The same length of time before it, or null for All, which has nothing before it. */
  previous: { from: number; to: number } | null;
  /** What the delta under a tile is against. */
  previousLabel: string | null;
  /** True when "week" fell back to seven days, because no reading has said when the week resets. */
  guessed: boolean;
}

/** Local midnight `days` days before `now`'s day, through the calendar. */
function dayStart(now: number, daysBack: number): number {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - daysBack).getTime();
}

/**
 * Where a range starts and what it is compared with. The comparison is the same
 * length of time ending the same distance back, not the whole of the previous
 * period, because at nine in the morning a full yesterday beside a third of
 * today says only that the day is not over.
 */
export function rangeBounds(id: UsageRange, now: number, weekResetsAt: number | null): RangeBounds {
  const span = (from: number, previousLabel: string, back = now - from, guessed = false): RangeBounds => ({
    id,
    from,
    to: now,
    previous: { from: from - back, to: now - back },
    previousLabel,
    guessed,
  });
  switch (id) {
    case "today":
      return span(dayStart(now, 0), "yesterday by now", 86_400_000);
    case "30d":
      return span(dayStart(now, 29), "the 30 days before");
    case "all":
      return { id, from: 0, to: now, previous: null, previousLabel: null, guessed: false };
    case "week":
      if (weekResetsAt !== null && Number.isFinite(weekResetsAt) && weekResetsAt > now && weekResetsAt - now <= WEEK_MS) return span(weekResetsAt - WEEK_MS, "last limit week by now", WEEK_MS);
      return span(dayStart(now, 6), "the 7 days before", WEEK_MS, true);
    case "7d":
      return span(dayStart(now, 6), "the 7 days before", WEEK_MS);
  }
}

/**
 * A span as whole local days, which the rollup can answer, and the slices at
 * either end that it cannot, which the messages must. A limit week starts at an
 * instant of the account's choosing, and "today" ends at this minute.
 */
export function splitDays(from: number, to: number): { firstDay: string | null; lastDay: string | null; edges: { from: number; to: number }[] } {
  if (to <= from) return { firstDay: null, lastDay: null, edges: [] };
  const fromDay = dayBounds(dayOf(from));
  const toDay = dayBounds(dayOf(to));
  if (fromDay.start === toDay.start) return { firstDay: null, lastDay: null, edges: [{ from, to }] };
  const wholeFrom = from === fromDay.start ? fromDay.start : fromDay.end;
  // The moment `to` is exclusive, so a span ending at midnight has no slice after it.
  const wholeTo = toDay.start;
  const edges: { from: number; to: number }[] = [];
  if (from !== fromDay.start) edges.push({ from, to: fromDay.end });
  if (to !== toDay.start) edges.push({ from: toDay.start, to });
  if (wholeFrom >= wholeTo) return { firstDay: null, lastDay: null, edges };
  return { firstDay: dayOf(wholeFrom), lastDay: dayOf(wholeTo - 1), edges };
}

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------

export interface UsageBucket {
  from: number;
  to: number;
  /** On the axis. */
  label: string;
  /** In a tooltip and a table. */
  long: string;
}

/**
 * Held rather than made per call: a report says a date thousands of times, and
 * `toLocaleDateString` builds a formatter every time, which took a whole report
 * by agent from about 30 ms to about 150 on the event loop terminals share.
 */
const FORMAT = {
  monthDay: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }),
  weekday: new Intl.DateTimeFormat("en-US", { weekday: "short" }),
  fullDay: new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }),
  hour: new Intl.DateTimeFormat("en-US", { hour: "numeric" }),
  month: new Intl.DateTimeFormat("en-US", { month: "short" }),
  monthYear: new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }),
};

function monthDay(at: number): string {
  return FORMAT.monthDay.format(at);
}

/**
 * The columns a range is drawn in: hours for today, since one column is a tile
 * pretending to be a chart; days up to five weeks; then weeks and months, so
 * that a year on a phone is still columns and not a smear. All through the
 * calendar: a day the clocks change on is not 24 hours long.
 */
export function bucketsFor(from: number, to: number, oldest: number | null): UsageBucket[] {
  // An empty ledger asked for everything has no first day: one day of nothing, not months since 1970.
  const start = Math.max(from, oldest ?? (from || to - 86_400_000));
  const days = (to - start) / 86_400_000;
  const out: UsageBucket[] = [];
  if (dayOf(start) === dayOf(to - 1) && days <= 1) {
    const base = new Date(start);
    for (let hour = 0; hour < 24; hour++) {
      const at = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour).getTime();
      if (at >= to) break;
      const label = FORMAT.hour.format(at).replace(/\s/g, "").toLowerCase();
      out.push({ from: at, to: new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour + 1).getTime(), label, long: `${monthDay(at)}, ${label}` });
    }
    return out;
  }
  const first = new Date(start);
  if (days <= 35) {
    for (let at = dayBounds(dayOf(start)).start; at < to; at = dayBounds(dayOf(at)).end) {
      out.push({ from: at, to: dayBounds(dayOf(at)).end, label: days <= 8 ? FORMAT.weekday.format(at) : monthDay(at), long: FORMAT.fullDay.format(at) });
    }
    return out;
  }
  if (days <= 200) {
    // Weeks start on Monday, the way a calendar on this Mac's side of the world prints them.
    const monday = new Date(first.getFullYear(), first.getMonth(), first.getDate() - ((first.getDay() + 6) % 7));
    for (let week = 0; ; week++) {
      const at = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7 * week).getTime();
      if (at >= to) break;
      const next = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7 * (week + 1)).getTime();
      out.push({ from: at, to: next, label: monthDay(at), long: `Week of ${monthDay(at)}` });
    }
    return out;
  }
  for (let month = 0; ; month++) {
    const at = new Date(first.getFullYear(), first.getMonth() + month, 1).getTime();
    if (at >= to) break;
    const next = new Date(first.getFullYear(), first.getMonth() + month + 1, 1).getTime();
    out.push({ from: at, to: next, label: FORMAT.month.format(at), long: FORMAT.monthYear.format(at) });
  }
  return out;
}

/** The bucket a moment falls in, or -1. Buckets are few and ordered, so a walk would do; this is called per cell. */
export function bucketIndex(buckets: readonly UsageBucket[], at: number): number {
  let low = 0;
  let high = buckets.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const bucket = buckets[mid]!;
    if (at < bucket.from) high = mid - 1;
    else if (at >= bucket.to) low = mid + 1;
    else return mid;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// What a cell belongs to
// ---------------------------------------------------------------------------

export interface UsageEntity {
  key: string;
  label: string;
  /** Named only by the folder it ran in, which the page says. */
  folderOnly?: boolean;
  kuru?: boolean;
}

const KURU: UsageEntity = { key: "kuru", label: "Kuru", kuru: true };

const PROGRAM_NAMES: Record<UsageProgram, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };

export function programName(program: UsageProgram): string {
  return PROGRAM_NAMES[program];
}

/**
 * A model as a person says it: `claude-opus-5-5` is Opus 5.5 and
 * `claude-sonnet-4-20250514` is Sonnet 4. Anything else, which is every other
 * company's model, is left as its own id: guessing at how to spell somebody
 * else's product is how a label goes wrong quietly.
 */
export function modelName(model: string): string {
  const match = /^claude-([a-z]+)-(\d+(?:-\d{1,2})?)(?:-\d{8})?(?:\[[^\]]*\])?$/.exec(model);
  if (!match) return model;
  const [, family, version] = match as unknown as [string, string, string];
  return `${family[0]!.toUpperCase()}${family.slice(1)} ${version.replace("-", ".")}`;
}

function lastPart(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** A session nothing better names: the folder's last word and the day, which is how anybody would find it again. */
export function sessionLabel(fact: SessionFact, names: UsageNames): string {
  if (fact.kind === "harness") return "Kuru";
  const card = fact.cardId ? names.card(fact.cardId) : null;
  if (card) return card;
  const live = names.liveAgent(fact);
  if (live) return live.label;
  const folder = fact.cwd ? names.folder(fact.cwd) : null;
  const where = folder ? (folder === "~" ? folder : lastPart(folder)) : "Unknown folder";
  return `${where}, ${monthDay(fact.startedAt)}`;
}

/**
 * Whose a cell is, by the dimension the page was asked for. By model and by
 * program Kuru is not a row of its own: Opus is Opus whoever asked, and carving
 * it out would make the bar for the model most of its tokens went to read
 * shorter than the bill says it was.
 */
export function entityOf(by: UsageDimension, cell: Pick<UsageCell, "model">, fact: SessionFact, names: UsageNames): UsageEntity {
  if (by === "model") return { key: cell.model, label: modelName(cell.model) };
  if (by === "program") return { key: fact.program, label: programName(fact.program) };
  if (fact.kind === "harness") return KURU;
  switch (by) {
    case "kuru":
      return { key: "agents", label: "Agents" };
    case "card": {
      if (!fact.cardId) return { key: "no-card", label: "Not on a card" };
      return { key: fact.cardId, label: names.card(fact.cardId) ?? "A card since removed" };
    }
    case "agent":
      return { key: fact.id, label: sessionLabel(fact, names), folderOnly: fact.attributedBy === "folder" };
    case "workspace": {
      if (fact.workspaceKey) return { key: fact.workspaceKey, label: names.workspace(fact.workspaceKey) ?? "A workspace since removed" };
      if (!fact.cwd) return { key: "folder:?", label: "Unknown folder", folderOnly: true };
      return { key: `folder:${fact.cwd}`, label: names.folder(fact.cwd), folderOnly: true };
    }
  }
}

// ---------------------------------------------------------------------------
// Sums
// ---------------------------------------------------------------------------

export interface UsageTotals {
  tokens: number;
  cost: number;
  messages: number;
  /** Messages whose model the price table does not have. Their tokens are exact and their dollars are not in `cost`. */
  unpriced: number;
  /** Sessions with at least one message in the range. */
  sessions: number;
  kuruTokens: number;
  kuruCost: number;
}

export function totalsOf(cells: readonly UsageCell[], kind: (sessionId: string) => SessionKind | null): UsageTotals {
  const out: UsageTotals = { tokens: 0, cost: 0, messages: 0, unpriced: 0, sessions: 0, kuruTokens: 0, kuruCost: 0 };
  const seen = new Set<string>();
  for (const cell of cells) {
    const tokens = tokensOf(cell);
    out.tokens += tokens;
    out.cost += cell.cost;
    out.messages += cell.messages;
    out.unpriced += cell.unpriced;
    seen.add(cell.sessionId);
    if (kind(cell.sessionId) === "harness") {
      out.kuruTokens += tokens;
      out.kuruCost += cell.cost;
    }
  }
  out.sessions = seen.size;
  return out;
}

export interface RankedRow {
  key: string;
  label: string;
  tokens: number;
  cost: number;
  messages: number;
  /** Of the range's tokens, 0–1. */
  share: number;
  kuru?: boolean;
  folderOnly?: boolean;
  /** How many this row stands for, when it is Other. */
  others?: number;
}

/** Past this the rest of a ranked list are one row called Other, and the table has them by name. */
export const RANKED_TOP = 8;

interface EntitySum {
  entity: UsageEntity;
  tokens: number;
  cost: number;
  messages: number;
}

function sumByEntity(cells: readonly UsageCell[], facts: ReadonlyMap<string, SessionFact>, by: UsageDimension, names: UsageNames): EntitySum[] {
  const sums = new Map<string, EntitySum>();
  for (const cell of cells) {
    const fact = facts.get(cell.sessionId);
    if (!fact) continue;
    const entity = entityOf(by, cell, fact, names);
    const sum = sums.get(entity.key) ?? { entity, tokens: 0, cost: 0, messages: 0 };
    sum.tokens += tokensOf(cell);
    sum.cost += cell.cost;
    sum.messages += cell.messages;
    sums.set(entity.key, sum);
  }
  // A row of nothing is Claude Code's `<synthetic>`: no model served it, and it has no bar to draw.
  return [...sums.values()].filter((sum) => sum.tokens > 0).sort((a, b) => b.tokens - a.tokens || a.entity.key.localeCompare(b.entity.key));
}

/** Largest first, the top eight and Other, with Kuru always a row of its own wherever its tokens put it. */
export function rankRows(sums: readonly EntitySum[]): RankedRow[] {
  const total = sums.reduce((n, sum) => n + sum.tokens, 0);
  const row = (sum: EntitySum): RankedRow => ({
    key: sum.entity.key,
    label: sum.entity.label,
    tokens: sum.tokens,
    cost: sum.cost,
    messages: sum.messages,
    share: total ? sum.tokens / total : 0,
    ...(sum.entity.kuru ? { kuru: true } : {}),
    ...(sum.entity.folderOnly ? { folderOnly: true } : {}),
  });
  const kept = sums.filter((sum) => sum.entity.kuru);
  const others = sums.filter((sum) => !sum.entity.kuru);
  const top = others.slice(0, RANKED_TOP);
  const rest = others.slice(RANKED_TOP);
  const rows = [...kept, ...top].sort((a, b) => b.tokens - a.tokens).map(row);
  if (rest.length) {
    const tokens = rest.reduce((n, sum) => n + sum.tokens, 0);
    rows.push({
      key: "other",
      label: `Other (${rest.length})`,
      tokens,
      cost: rest.reduce((n, sum) => n + sum.cost, 0),
      messages: rest.reduce((n, sum) => n + sum.messages, 0),
      share: total ? tokens / total : 0,
      others: rest.length,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The stack, and whose colour is whose
// ---------------------------------------------------------------------------

/** Which colour a series wears: Kuru's, the quiet one, or a slot of the table in `chartcolor.ts`. */
export type SeriesInk = "kuru" | "rest" | number;

export interface StackSeries {
  key: string;
  label: string;
  ink: SeriesInk;
  /** Tokens in each bucket. */
  values: number[];
  total: number;
}

/**
 * Which slot each series on screen wears. Colour follows the entity and never
 * its rank in what is showing, so a reader who has learned that a workspace is
 * orange is not misled by the next range. So the slots go by all-time rank: the
 * six largest ever hold theirs for good, and one that is only large this week
 * borrows the first slot nobody on screen is using, which is the same one
 * whenever that same set is drawn.
 */
export function seriesSlots(shown: readonly string[], allTimeRanked: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  const taken = new Set<number>();
  const rankOf = new Map(allTimeRanked.map((key, rank) => [key, rank] as const));
  for (const key of shown) {
    const rank = rankOf.get(key);
    if (rank !== undefined && rank < SERIES_SLOTS) {
      out.set(key, rank);
      taken.add(rank);
    }
  }
  const late = shown.filter((key) => !out.has(key)).sort((a, b) => (rankOf.get(a) ?? Infinity) - (rankOf.get(b) ?? Infinity) || a.localeCompare(b));
  for (const key of late) {
    for (let slot = 0; slot < SERIES_SLOTS; slot++) {
      if (taken.has(slot)) continue;
      out.set(key, slot);
      taken.add(slot);
      break;
    }
  }
  return out;
}

/** Kuru at the foot, the slots in their fixed order so the validated neighbours stay neighbours, Other on top. */
export function buildStack(cells: readonly UsageCell[], facts: ReadonlyMap<string, SessionFact>, by: UsageDimension, names: UsageNames, buckets: readonly UsageBucket[], allTimeRanked: readonly string[]): StackSeries[] {
  const sums = sumByEntity(cells, facts, by, names);
  const others = sums.filter((sum) => !sum.entity.kuru);
  const shown = others.slice(0, SERIES_SLOTS).map((sum) => sum.entity.key);
  const slots = seriesSlots(shown, allTimeRanked);
  const series = new Map<string, StackSeries>();
  const make = (key: string, label: string, ink: SeriesInk): StackSeries => {
    const made = { key, label, ink, values: buckets.map(() => 0), total: 0 };
    series.set(key, made);
    return made;
  };
  for (const sum of sums) {
    if (sum.entity.kuru) make(sum.entity.key, sum.entity.label, "kuru");
    else if (by === "kuru") make(sum.entity.key, sum.entity.label, "rest");
    else if (slots.has(sum.entity.key)) make(sum.entity.key, sum.entity.label, slots.get(sum.entity.key)!);
  }
  const rest = others.length - shown.length;
  const other = rest > 0 ? make("other", `Other (${rest})`, "rest") : null;
  for (const cell of cells) {
    const fact = facts.get(cell.sessionId);
    if (!fact) continue;
    const at = bucketIndex(buckets, cell.at);
    if (at < 0) continue;
    const target = series.get(entityOf(by, cell, fact, names).key) ?? other;
    if (!target) continue;
    const tokens = tokensOf(cell);
    target.values[at]! += tokens;
    target.total += tokens;
  }
  const order = (ink: SeriesInk) => (ink === "kuru" ? -1 : ink === "rest" ? SERIES_SLOTS : ink);
  return [...series.values()].sort((a, b) => order(a.ink) - order(b.ink));
}

// ---------------------------------------------------------------------------
// What kind of token
// ---------------------------------------------------------------------------

export interface KindRow {
  kind: "read" | "write" | "output" | "input";
  label: string;
  tokens: number;
  /** Of the tokens, 0–1. */
  share: number;
  cost: number;
  /** Of the estimate, 0–1. */
  costShare: number;
}

/**
 * Tokens and dollars by kind, side by side, because that difference is the whole
 * explanation: nearly every token is a cheap re-read of the conversation and
 * half the dollars are not. A row of the ledger has one estimate for all its
 * kinds, so each cell's is split by the kinds' list prices. Splitting its own
 * estimate rather than pricing the kinds again is what keeps these summing to
 * the tile above them through fast mode and Haiku's long-context tier, which the
 * rollup has no column for.
 */
export function kindsOf(cells: readonly UsageCell[]): { rows: KindRow[]; thinking: number } {
  const sums = { read: [0, 0], write: [0, 0], output: [0, 0], input: [0, 0] } as Record<KindRow["kind"], [number, number]>;
  let thinking = 0;
  for (const cell of cells) {
    const write = cell.write5m + cell.write1h;
    sums.read[0] += cell.read;
    sums.write[0] += write;
    sums.output[0] += cell.output;
    sums.input[0] += cell.input;
    thinking += cell.thinking;
    const price = priceOf(cell.model, cell.at)?.price;
    if (!price || cell.cost <= 0) continue;
    const parts = {
      read: cell.read * price.read,
      write: cell.write5m * price.write5m + cell.write1h * price.write1h,
      output: cell.output * price.output,
      input: cell.input * price.input,
    };
    const whole = parts.read + parts.write + parts.output + parts.input;
    if (whole <= 0) continue;
    for (const kind of ["read", "write", "output", "input"] as const) sums[kind][1] += (parts[kind] / whole) * cell.cost;
  }
  const tokens = sums.read[0] + sums.write[0] + sums.output[0] + sums.input[0];
  const cost = sums.read[1] + sums.write[1] + sums.output[1] + sums.input[1];
  const row = (kind: KindRow["kind"], label: string): KindRow => ({
    kind,
    label,
    tokens: sums[kind][0],
    share: tokens ? sums[kind][0] / tokens : 0,
    cost: sums[kind][1],
    costShare: cost ? sums[kind][1] / cost : 0,
  });
  return { rows: [row("read", "Cache read"), row("write", "Cache write"), row("output", "Output"), row("input", "Input")], thinking };
}

// ---------------------------------------------------------------------------
// Context carried
// ---------------------------------------------------------------------------

export interface ContextStrip {
  sessionId: string;
  label: string;
  workspace: string;
  messages: number;
  peak: number;
  median: number;
  last: number;
  /** Which message first carried over 200 k, 1-based, or null. */
  over200At: number | null;
  /** Down-sampled, each point the largest of what it stands for, so a peak is never smoothed away. */
  points: { message: number; context: number }[];
}

export const CONTEXT_MARK = 200_000;
export const CONTEXT_POINTS = 60;

/** One session's context per message as the strip draws it. */
export function contextStrip(values: readonly number[]): Pick<ContextStrip, "messages" | "peak" | "median" | "last" | "over200At" | "points"> {
  const messages = values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const over = values.findIndex((value) => value > CONTEXT_MARK);
  const points: { message: number; context: number }[] = [];
  if (messages <= CONTEXT_POINTS) {
    values.forEach((context, i) => points.push({ message: i + 1, context }));
  } else {
    for (let i = 0; i < CONTEXT_POINTS; i++) {
      const start = Math.floor((i * messages) / CONTEXT_POINTS);
      const end = Math.floor(((i + 1) * messages) / CONTEXT_POINTS);
      let at = start;
      for (let j = start; j < end; j++) if (values[j]! > values[at]!) at = j;
      points.push({ message: at + 1, context: values[at]! });
    }
  }
  return {
    messages,
    peak: sorted[messages - 1] ?? 0,
    median: sorted[Math.floor(messages / 2)] ?? 0,
    last: values[messages - 1] ?? 0,
    over200At: over === -1 ? null : over + 1,
    points,
  };
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export interface LimitReading {
  at: number;
  kind: string;
  scope: string | null;
  percent: number;
  source: string;
}

export interface LimitSeries {
  key: string;
  label: string;
  /** The highest reading in each bucket, or null where nothing was read: a gap, not a zero. */
  values: (number | null)[];
  /** The last reading, which is what the legend quotes. */
  last: number | null;
}

/**
 * The week limits, bucket by bucket. Only the weeks, because a five-hour window
 * resets several times a column and would draw a comb. The highest of a bucket
 * rather than its last, since "the week limit reached 80 % on Thursday" is what
 * this panel is for and a reset that evening would hide it.
 */
export function limitSeries(readings: readonly LimitReading[], buckets: readonly UsageBucket[]): LimitSeries[] {
  const series = new Map<string, LimitSeries & { lastAt: number }>();
  for (const reading of readings) {
    if (!reading.kind.startsWith("weekly") || !Number.isFinite(reading.percent)) continue;
    const at = bucketIndex(buckets, reading.at);
    if (at < 0) continue;
    const key = `${reading.source}|${reading.kind}|${reading.scope ?? ""}`;
    const who = reading.source === "codex" ? "Codex" : "Claude";
    const label = `${who} week${reading.scope ? ` · ${reading.scope}` : ""}`;
    const held = series.get(key) ?? { key, label, values: buckets.map(() => null), last: null, lastAt: -Infinity };
    held.values[at] = Math.max(held.values[at] ?? 0, reading.percent);
    if (reading.at >= held.lastAt) {
      held.last = reading.percent;
      held.lastAt = reading.at;
    }
    series.set(key, held);
  }
  return [...series.values()].sort((a, b) => a.label.localeCompare(b.label)).map(({ lastAt: _, ...rest }) => rest);
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

export interface SessionRow {
  id: string;
  label: string;
  workspace: string;
  lastAt: number;
  program: UsageProgram;
  /** The model most of its tokens went to, and how many others it also used. */
  model: string;
  moreModels: number;
  messages: number;
  input: number;
  write: number;
  read: number;
  output: number;
  tokens: number;
  cost: number;
  unpriced: number;
  /** What the program says the whole session spent, which may reach outside the range; null when it says nothing. */
  says: number | null;
  /** Who named it, as the page says it. */
  attribution: "Kuru" | "card" | "launch" | "hook" | "database" | "folder only";
  /** A terminal to go to, if this session is running. */
  agentId: string | null;
  /** A card to open, if this window can. */
  card: { id: string; workspaceId: string } | null;
}

/** The table's length. The long tail below it is a line of small numbers, and the count says how many. */
export const TABLE_ROWS = 100;

function attributionWord(fact: SessionFact): SessionRow["attribution"] {
  if (fact.kind === "harness") return "Kuru";
  if (fact.cardId) return "card";
  if (fact.attributedBy === "spawn") return "launch";
  if (fact.attributedBy === "report") return "hook";
  return fact.attributedBy === "conversations" ? "database" : "folder only";
}

export function workspaceOf(fact: SessionFact, names: UsageNames): string {
  if (fact.kind === "harness") return "Kuru";
  if (fact.workspaceKey) return names.workspace(fact.workspaceKey) ?? "A workspace since removed";
  return fact.cwd ? names.folder(fact.cwd) : "Unknown folder";
}

export function sessionRows(cells: readonly UsageCell[], facts: ReadonlyMap<string, SessionFact>, says: ReadonlyMap<string, number>, names: UsageNames): { rows: SessionRow[]; more: number } {
  const byModel = new Map<string, Map<string, number>>();
  const rows = new Map<string, SessionRow>();
  for (const cell of cells) {
    const fact = facts.get(cell.sessionId);
    if (!fact) continue;
    let row = rows.get(fact.id);
    if (!row) {
      row = {
        id: fact.id,
        label: sessionLabel(fact, names),
        workspace: workspaceOf(fact, names),
        lastAt: fact.lastAt,
        program: fact.program,
        model: "",
        moreModels: 0,
        messages: 0,
        input: 0,
        write: 0,
        read: 0,
        output: 0,
        tokens: 0,
        cost: 0,
        unpriced: 0,
        says: says.get(fact.id) ?? null,
        attribution: attributionWord(fact),
        agentId: null,
        card: null,
      };
      rows.set(fact.id, row);
    }
    const tokens = tokensOf(cell);
    row.messages += cell.messages;
    row.input += cell.input;
    row.write += cell.write5m + cell.write1h;
    row.read += cell.read;
    row.output += cell.output;
    row.tokens += tokens;
    row.cost += cell.cost;
    row.unpriced += cell.unpriced;
    const models = byModel.get(fact.id) ?? new Map<string, number>();
    models.set(cell.model, (models.get(cell.model) ?? 0) + tokens);
    byModel.set(fact.id, models);
  }
  const sorted = [...rows.values()].sort((a, b) => b.tokens - a.tokens || a.id.localeCompare(b.id));
  const kept = sorted.slice(0, TABLE_ROWS);
  for (const row of kept) {
    const models = [...byModel.get(row.id)!.entries()].sort((a, b) => b[1] - a[1]);
    row.model = modelName(models[0]![0]);
    row.moreModels = models.length - 1;
    // Only for the rows that are drawn: each is a look at the live tree.
    const fact = facts.get(row.id)!;
    row.agentId = names.liveAgent(fact)?.id ?? null;
    const openable = fact.cardId ? names.openableCard(fact.cardId) : null;
    row.card = openable && fact.cardId ? { id: fact.cardId, workspaceId: openable.workspaceId } : null;
  }
  return { rows: kept, more: sorted.length - kept.length };
}

/**
 * The estimate beside Claude Code's own figure, over the sessions that lie
 * wholly inside the range. Only those, because `cost-state` is a whole session's
 * running total: setting it beside the part of a session a range happens to cover
 * would manufacture a gap out of nothing.
 */
export function programSays(rows: Iterable<{ id: string; cost: number; says: number | null }>, facts: ReadonlyMap<string, SessionFact>, from: number, to: number): { sessions: number; estimate: number; says: number } | null {
  const out = { sessions: 0, estimate: 0, says: 0 };
  for (const row of rows) {
    const fact = facts.get(row.id);
    if (!fact || fact.program !== "claude" || row.says === null || fact.startedAt < from || fact.lastAt > to) continue;
    out.sessions++;
    out.estimate += row.cost;
    out.says += row.says;
  }
  return out.sessions ? out : null;
}

// ---------------------------------------------------------------------------
// The whole report
// ---------------------------------------------------------------------------

export interface RetentionRow {
  /** Whose login it is, as the page says it. */
  who: string;
  days: number;
  /** Whether the file says so, or this is Claude Code's default. */
  stated: boolean;
}

export interface UsageReport {
  at: number;
  by: UsageDimension;
  range: RangeBounds;
  /** Whose account said when the limit week resets: Claude's when it has been read, else Codex's. */
  weekOwner: "claude" | "codex" | null;
  totals: UsageTotals;
  previous: UsageTotals | null;
  ranked: RankedRow[];
  buckets: UsageBucket[];
  stack: StackSeries[];
  limits: LimitSeries[];
  kinds: KindRow[];
  thinking: number;
  context: ContextStrip[];
  sessions: SessionRow[];
  sessionsMore: number;
  says: { sessions: number; estimate: number; says: number } | null;
  retention: RetentionRow[];
  foot: {
    oldestDay: string | null;
    skipped: number;
    unpriced: number;
    reading: { doneBytes: number; totalBytes: number; files: number } | null;
    sweptAt: number | null;
    error: string | null;
  };
}

export interface ReportInput {
  by: UsageDimension;
  range: RangeBounds;
  at: number;
  cells: readonly UsageCell[];
  /** Quarter-hour cells when the range is a single day, the one thing drawn finer than days; the same tokens as `cells`. */
  fineCells?: readonly UsageCell[];
  previousCells: readonly UsageCell[] | null;
  /** Every session the ledger has: looked up by id, never counted. */
  facts: ReadonlyMap<string, SessionFact>;
  says: ReadonlyMap<string, number>;
  /** Every cell ever, summed by session and model, for who holds which colour. */
  allTime: readonly UsageCell[];
  names: UsageNames;
  limits: readonly LimitReading[];
  oldestDay: string | null;
  retention: RetentionRow[];
  foot: UsageReport["foot"];
}

/** Everything but the context strips, which take a query per session, and the week's owner, which is the caller's to know. */
export function buildReport(input: ReportInput): Omit<UsageReport, "context" | "weekOwner"> {
  const { by, range, at, cells, facts, names } = input;
  const kind = (id: string) => facts.get(id)?.kind ?? null;
  const oldest = input.oldestDay ? dayBounds(input.oldestDay).start : null;
  const buckets = bucketsFor(range.from, range.to, oldest);
  const ranked = rankRows(sumByEntity(cells, facts, by, names));
  const allTimeRanked = sumByEntity(input.allTime, facts, by, names)
    .filter((sum) => !sum.entity.kuru)
    .map((sum) => sum.entity.key);
  const table = sessionRows(cells, facts, input.says, names);
  return {
    at,
    by,
    range,
    totals: totalsOf(cells, kind),
    previous: input.previousCells ? totalsOf(input.previousCells, kind) : null,
    ranked,
    buckets,
    stack: buildStack(input.fineCells ?? cells, facts, by, names, buckets, allTimeRanked),
    limits: limitSeries(input.limits, buckets),
    ...(() => {
      const { rows, thinking } = kindsOf(cells);
      return { kinds: rows, thinking };
    })(),
    sessions: table.rows,
    sessionsMore: table.more,
    says: programSays(table.rows, facts, range.from, range.to),
    retention: input.retention,
    foot: input.foot,
  };
}
