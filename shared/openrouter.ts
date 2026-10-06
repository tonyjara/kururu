/**
 * What an OpenRouter account is to kururu, and how its answers are read.
 *
 * Somebody who points most of their projects at one OpenRouter account has one
 * balance draining from a dozen places at once, and no single project's logs
 * say how fast. The sidebar already shows what Claude is spending and what the
 * VPS is doing; this is the third gauge of the same kind, and the question it
 * answers is "how long before something of mine starts getting 402s".
 *
 * **It needs a management key, and that is the decision everything else
 * follows from.** OpenRouter tells the balance — `/credits` — only to a
 * management key, and the spend per day, week and month only through
 * `/keys`, which lists every key on the account with its own running totals.
 * An inference key, the kind every project's `.env` already holds, can be
 * asked about itself and nothing else, which is a figure for one project when
 * the point is all of them. Reading those `.env` files to find one was not
 * considered for long: kururu does not go through somebody's projects looking
 * for credentials.
 *
 * A management key cannot run a model but can make and delete API keys, so
 * it is the most powerful thing kururu stores. `server/src/openrouter.ts` says
 * how it is kept; the rule that matters here is that **the key crosses the
 * wire once, inbound, and never back out.** What a client gets is `hint` —
 * enough of the key to recognise it — and dollars.
 *
 * Pure, and in `shared/` beside `vps.ts` for that module's reason: the parse
 * and the arithmetic are the part worth testing, and the types are the part
 * both halves import.
 */

/** One reading of the account. Dollars throughout, as OpenRouter states them. */
export interface OpenRouterReading {
  /** When it was taken. */
  at: number;
  /** Every credit ever bought. */
  credits: number;
  /** Every credit ever spent. `credits - used` is the balance. */
  used: number;
  /**
   * Spend in the current UTC day, week (from Monday) and month, summed over
   * every key on the account. Null when the key list could not be read — an
   * inference key whose `/credits` was answered anyway, say. A key deleted
   * mid-month takes its spend with it; OpenRouter does not keep it per key.
   */
  spend: OpenRouterSpend | null;
}

export interface OpenRouterSpend {
  day: number;
  week: number;
  month: number;
}

/**
 * The account and what is known about it — what crosses the wire, and null on
 * it when no key has been given. `stale` and `error` together for the VPS row's
 * reason: the last balance is still the best one known, and must not look
 * current when it is not.
 */
export interface OpenRouterStatus {
  /** `sk-or-v1-…a3f9`: enough to tell two keys apart, not enough to be one. */
  hint: string;
  reading: OpenRouterReading | null;
  stale: boolean;
  /** Why the last attempt failed, in a sentence, or null if it did not. */
  error: string | null;
}

/**
 * A key worth sending in a header. OpenRouter's are `sk-or-v1-` and hex, but
 * the check is the header's rather than theirs — a prefix they change next
 * year should not lock anybody out, while a newline in a header is a second
 * header, and a key that long is a paste of something else.
 */
export function validOpenRouterKey(key: unknown): key is string {
  return typeof key === "string" && key.length >= 16 && key.length <= 256 && /^[A-Za-z0-9_.-]+$/.test(key);
}

/** The prefix and the last four, the way OpenRouter's own key list shows one. */
export function keyHint(key: string): string {
  const prefix = /^sk-or-v\d+-/.exec(key)?.[0] ?? "";
  return `${prefix}…${key.slice(-4)}`;
}

/** A dollar figure off the wire: finite or nothing. NaN loses every comparison it is in. */
function dollars(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * `/credits`' `{ data: { total_credits, total_usage } }`, or null. Both or
 * neither: a balance worked out from one real figure and one default is a
 * balance somebody would top up, or not, on the strength of a parser's guess.
 */
export function creditsFrom(body: unknown): { credits: number; used: number } | null {
  const data = (body as { data?: Record<string, unknown> } | null)?.data;
  if (!data || typeof data !== "object") return null;
  const credits = dollars(data.total_credits);
  const used = dollars(data.total_usage);
  if (credits === null || used === null) return null;
  return { credits, used };
}

/**
 * One page of `/keys`, as a list of the three running totals per key, or null
 * if the page is not a list at all. A key whose totals do not parse is
 * skipped rather than counted as zero — a missing figure undercounts, and an
 * invented one is invented — and a page that is entirely unreadable is null
 * so the caller can tell "no keys" from "not the shape we know".
 */
export function keyPageFrom(body: unknown): OpenRouterSpend[] | null {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  const out: OpenRouterSpend[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const day = dollars(row.usage_daily);
    const week = dollars(row.usage_weekly);
    const month = dollars(row.usage_monthly);
    if (day === null || week === null || month === null) continue;
    out.push({ day, week, month });
  }
  return out;
}

export function sumSpend(rows: OpenRouterSpend[]): OpenRouterSpend {
  return rows.reduce((a, b) => ({ day: a.day + b.day, week: a.week + b.week, month: a.month + b.month }), {
    day: 0,
    week: 0,
    month: 0,
  });
}

export function balanceOf(reading: OpenRouterReading): number {
  return reading.credits - reading.used;
}

const DAY_MS = 86_400_000;

/**
 * How long the balance lasts at the pace it is being spent, or null when
 * nothing is being spent or nothing says how fast.
 *
 * The pace is a window's spend over the time the window has been open, and the
 * window is whichever of OpenRouter's two — the UTC week from Monday, the UTC
 * month from the first — has been open longer. Both reset on a calendar, so
 * either alone is a pace measured over a few hours at the turn of it: on the
 * second of the month the month says almost nothing, and on a Monday the week
 * says less. Taking the longer one means the figure is never measured over
 * less than the days since whichever reset came first. A floor of one day
 * under it, so the first hours of a Monday the first are not "$0.40 in two
 * hours, therefore $5 a day".
 *
 * Not a forecast, and drawn as "about": it assumes the next days look like the
 * last ones, which for somebody who batch-runs evals on a Friday they will not.
 */
export function runway(
  reading: OpenRouterReading,
  now = Date.now(),
): { days: number; perDay: number; basis: "week" | "month" } | null {
  if (!reading.spend) return null;
  const date = new Date(now);
  const monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  // getUTCDay is 0 for Sunday; the week OpenRouter counts starts on Monday.
  const sinceMonday = (date.getUTCDay() + 6) % 7;
  const weekStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - sinceMonday);
  const basis = weekStart < monthStart ? "week" : "month";
  const start = basis === "week" ? weekStart : monthStart;
  const spent = basis === "week" ? reading.spend.week : reading.spend.month;
  const elapsed = Math.max(1, (now - start) / DAY_MS);
  const perDay = spent / elapsed;
  if (!(perDay > 0)) return null;
  return { days: Math.max(0, balanceOf(reading)) / perDay, perDay, basis };
}

/**
 * Green, amber, red for a balance. OpenRouter states no thresholds, so these
 * are kururu's, and they are in days rather than dollars because dollars mean
 * nothing without a pace — twenty is a month to one person and an afternoon to
 * another. Under a week is worth a top-up when convenient; under three days is
 * worth one now. A balance at or under zero is red whatever the pace, because
 * that is the 402 itself rather than a warning of one.
 */
export function balanceSeverity(reading: OpenRouterReading, now = Date.now()): "normal" | "warning" | "critical" {
  if (balanceOf(reading) <= 0) return "critical";
  const left = runway(reading, now);
  if (!left) return "normal";
  return left.days < 3 ? "critical" : left.days < 7 ? "warning" : "normal";
}

/**
 * `$12.34`, `$1,204`, `<$0.01`, `-$0.52`. Cents until a thousand, where they
 * stop being information; and a figure that rounds to nothing but is not
 * nothing says so, because "$0.00 today" over a day of free-model calls is
 * true and over a day of a cent's worth of real ones is not.
 */
export function formatDollars(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs > 0 && abs < 0.005) return `${sign}<$0.01`;
  const digits = abs >= 1000 ? 0 : 2;
  return `${sign}$${abs.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** "about 9 days", "under a day", "over a year" — coarse, like `resetIn`, and for its reason. */
export function formatRunway(days: number): string {
  if (days < 1) return "under a day";
  if (days > 365) return "over a year";
  const n = Math.floor(days);
  return `about ${n} ${n === 1 ? "day" : "days"}`;
}
