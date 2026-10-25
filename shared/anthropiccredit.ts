/**
 * What is left of the Anthropic API credit, which nobody will say.
 *
 * Somebody who bought a few hundred dollars of Claude API credit and lent the
 * key to OpenRouter as BYOK has the OpenRouter chip read nearly nothing — its
 * own cost on those calls is zero — while the real balance drains on the
 * Console. That balance is the figure worth a chip, and **Anthropic has no
 * endpoint for it.** As of 2026-10 the Admin API has the cost report (spend
 * per day, in cents), the usage report (tokens) and spend *limits* (caps an
 * admin sets, not credit bought); the balance is on the Console's Billing page
 * and nowhere a program can read. So the chip is an estimate, drawn as one
 * with an "≈", and this module is the arithmetic of it:
 *
 *   **left ≈ the balance somebody read off the Console − what has been spent since.**
 *
 * The balance and the moment it was read are the anchor, set in Settings.
 * What has been spent since comes from one of two places:
 *
 * - **The cost report** (`/v1/organizations/cost_report`), with an Admin API
 *   key. Every dollar the organisation spends, OpenRouter's BYOK calls
 *   included, since those are made with the organisation's key. Its buckets
 *   are whole UTC days, so the anchor keeps what its own day had cost when it
 *   was set and that much is taken off the day; the report lags about five
 *   minutes, and leaves out Priority Tier, which bills another way.
 * - **OpenRouter's BYOK totals**, off the management key the OpenRouter chip
 *   already holds — no new key. Only what goes through OpenRouter, and every
 *   BYOK provider on that account together; right for somebody whose Claude
 *   calls all go that way and whose one BYOK key is Anthropic's. Real time,
 *   because `/keys` states each key's lifetime BYOK spend and the anchor keeps
 *   the sum.
 *
 * The cost report wins when both are there, because it is the one that
 * cannot miss a call. Each source is counted only from a baseline taken *at*
 * the anchor, never one worked out after it: an Admin key added a week later
 * cannot know what that first day had cost by the hour the balance was read,
 * so it waits for the balance to be set again, and the page says so.
 *
 * Reading the user's projects for a regular key was not considered, for
 * `shared/openrouter.ts`'s reason. Pure, and in `shared/` for that module's.
 */
import type { OpenRouterSpend } from "./openrouter";

export type CreditSource = "cost-report" | "openrouter-byok";

/** The balance read off the Console, and where each source stood at that moment. */
export interface CreditAnchor {
  /** Dollars. */
  balance: number;
  at: number;
  /**
   * The cost report's baseline: the UTC day `at` fell in, and what that day
   * had cost by then, in dollars. Null when there was no Admin key to ask.
   */
  cost: { day: string; before: number } | null;
  /** Every OpenRouter key's lifetime BYOK spend, summed, at `at`; null when OpenRouter could not say. */
  byok: number | null;
}

/** One estimate. Dollars throughout. */
export interface CreditReading {
  /** When the spend behind it was read. */
  at: number;
  source: CreditSource;
  /** Gone since the anchor, never below zero. */
  spent: number;
  /** Today, this week and this month, in the source's windows: what the pace is measured over. */
  spend: OpenRouterSpend | null;
}

/** What crosses the wire. Never the key, and never the baselines, which mean nothing to a window. */
export interface AnthropicCreditStatus {
  /** `sk-ant-admin01-…a3f9`, or null when no Admin key was given. */
  adminHint: string | null;
  anchor: { balance: number; at: number; sources: CreditSource[] } | null;
  reading: CreditReading | null;
  stale: boolean;
  /** Why the last read failed, in a sentence, or null. */
  error: string | null;
  /** Something to do that would make the estimate better, in a sentence, or null. */
  note: string | null;
  /**
   * Whether OpenRouter has seen BYOK spend on this account. The chip is drawn
   * unconfigured — a mark and "set up" — when it has, because then there is
   * API credit somewhere to count and one step would count it; and not drawn
   * at all for somebody with no API credit, for whom it would be clutter.
   */
  byokSeen: boolean;
}

/** A balance worth keeping: dollars, finite, and not a typo of a million. */
export function validBalance(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1_000_000;
}

/**
 * A key worth sending in a header — `shared/openrouter.ts`'s check, for its
 * reason. Not a prefix check: the cost report also takes a personal key that
 * is not scoped to a workspace, and the server's trial call is the judge.
 */
export function validAdminKey(key: unknown): key is string {
  return typeof key === "string" && key.length >= 16 && key.length <= 256 && /^[A-Za-z0-9_.-]+$/.test(key);
}

/** `sk-ant-admin01-…a3f9`: the prefix and the last four, as the Console's key list shows one. */
export function adminKeyHint(key: string): string {
  const prefix = /^sk-ant-[a-z]+\d*-/.exec(key)?.[0] ?? "";
  return `${prefix}…${key.slice(-4)}`;
}

/** `2026-10-25` for the UTC day `ms` falls in: the cost report's buckets are UTC days. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** One day of the cost report. */
export interface CostDay {
  day: string;
  dollars: number;
}

/**
 * One page of the cost report as days, and the cursor to the next, or null if
 * the page is not the shape documented. An amount is a decimal string in
 * cents — `"123.45"` is $1.23 — and a day with no costs is a bucket with no
 * results, which is zero. A bucket that cannot be read makes the page null
 * rather than that day zero, `usage.test.ts`'s rule: refuse, never repair.
 */
export function costPageFrom(body: unknown): { days: CostDay[]; next: string | null } | null {
  const page = body as { data?: unknown; has_more?: unknown; next_page?: unknown } | null;
  if (!page || !Array.isArray(page.data)) return null;
  const days: CostDay[] = [];
  for (const bucket of page.data) {
    const b = (bucket && typeof bucket === "object" ? bucket : {}) as { starting_at?: unknown; results?: unknown };
    if (typeof b.starting_at !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(b.starting_at)) return null;
    if (!Array.isArray(b.results)) return null;
    let cents = 0;
    for (const result of b.results) {
      const r = (result && typeof result === "object" ? result : {}) as { amount?: unknown; currency?: unknown };
      // Currently always USD; a balance bought in dollars cannot take anything else off it.
      if (r.currency !== undefined && r.currency !== "USD") return null;
      const amount = typeof r.amount === "string" && r.amount.trim() !== "" ? Number(r.amount) : NaN;
      if (!Number.isFinite(amount)) return null;
      cents += amount;
    }
    days.push({ day: b.starting_at.slice(0, 10), dollars: cents / 100 });
  }
  const next = page.has_more === true && typeof page.next_page === "string" ? page.next_page : null;
  return { days, next };
}

/** The total of the days on or after `from` — ISO dates compare as strings. */
export function costSince(days: readonly CostDay[], from: string): number {
  return days.reduce((sum, d) => (d.day >= from ? sum + d.dollars : sum), 0);
}

/** Monday of the UTC week `now` is in, and the first of its month: the windows OpenRouter counts in, kept here for the same pace. */
export function windowStarts(now: number): { week: string; month: string } {
  const date = new Date(now);
  const sinceMonday = (date.getUTCDay() + 6) % 7;
  return {
    week: utcDay(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - sinceMonday)),
    month: utcDay(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)),
  };
}

/** The first day the cost report must be asked from: the anchor's, or whichever window opened earlier. */
export function costStart(anchorDay: string | null, now: number): string {
  const { week, month } = windowStarts(now);
  return [anchorDay ?? month, week, month].sort()[0]!;
}

/** Today, this week and this month, off the cost report's days. */
export function costWindows(days: readonly CostDay[], now: number): OpenRouterSpend {
  const { week, month } = windowStarts(now);
  return { day: costSince(days, utcDay(now)), week: costSince(days, week), month: costSince(days, month) };
}

/**
 * Which source the estimate is counted from, or null when none can be: the
 * cost report when the anchor has its baseline and there is a key to ask,
 * OpenRouter when the anchor has its baseline and OpenRouter is saying.
 */
export function chooseSource(
  anchor: CreditAnchor,
  have: { admin: boolean; byok: boolean },
): CreditSource | null {
  if (anchor.cost && have.admin) return "cost-report";
  if (anchor.byok !== null && have.byok) return "openrouter-byok";
  return null;
}

/** What the cost report says has gone since the anchor: its day after the baseline, and every day after that. */
export function spentByCost(anchor: CreditAnchor & { cost: NonNullable<CreditAnchor["cost"]> }, days: readonly CostDay[]): number {
  return Math.max(0, costSince(days, anchor.cost.day) - anchor.cost.before);
}

/**
 * What OpenRouter says has gone since the anchor. Never below zero: a key
 * deleted since takes its lifetime total with it, and spend cannot come back.
 */
export function spentByByok(anchor: CreditAnchor & { byok: number }, total: number): number {
  return Math.max(0, total - anchor.byok);
}

/** The estimate itself: the anchor's balance less what has gone. */
export function creditLeft(status: Pick<AnthropicCreditStatus, "anchor" | "reading">): number | null {
  if (!status.anchor || !status.reading) return null;
  return status.anchor.balance - status.reading.spent;
}

/** The anchor's balance and the spend, in the shape `shared/openrouter.ts` works a runway and a colour out of. */
export function creditLedger(status: Pick<AnthropicCreditStatus, "anchor" | "reading">) {
  if (!status.anchor || !status.reading) return null;
  return { credits: status.anchor.balance, used: status.reading.spent, spend: status.reading.spend };
}

/** The anchor as a reader would hold it, from what is on the disk; null for anything that is not one. */
export function anchorFrom(raw: unknown): CreditAnchor | null {
  const a = raw as Partial<Record<keyof CreditAnchor, unknown>> | null;
  if (!a || typeof a !== "object") return null;
  if (!validBalance(a.balance) || typeof a.at !== "number" || !Number.isFinite(a.at)) return null;
  const c = a.cost as { day?: unknown; before?: unknown } | null | undefined;
  const cost =
    c && typeof c.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(c.day) && typeof c.before === "number" && Number.isFinite(c.before)
      ? { day: c.day, before: c.before }
      : null;
  const byok = typeof a.byok === "number" && Number.isFinite(a.byok) ? a.byok : null;
  return { balance: a.balance, at: a.at, cost, byok };
}

/** The sources an anchor can be counted from, for the page. */
export function anchorSources(anchor: CreditAnchor): CreditSource[] {
  return [...(anchor.cost ? (["cost-report"] as const) : []), ...(anchor.byok !== null ? (["openrouter-byok"] as const) : [])];
}

export const SOURCE_NAMES: Record<CreditSource, string> = {
  "cost-report": "Anthropic's cost report",
  "openrouter-byok": "OpenRouter's BYOK totals",
};
