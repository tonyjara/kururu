/**
 * That the Anthropic credit estimate takes off what was spent since the
 * balance was read — no more, no less — and that an answer it cannot read
 * becomes no figure rather than a wrong one.
 *
 * Held to `openrouter.test.ts`'s rule, refuse and never repair, with more
 * reason: the figure is drawn as what is left, and every way a parser could
 * be wrong here — a bucket read as zero, a day counted twice, the morning
 * before the balance counted after it — draws more left than there is.
 */
import { describe, expect, it } from "bun:test";

import {
  adminKeyHint,
  anchorFrom,
  chooseSource,
  costPageFrom,
  costStart,
  costWindows,
  creditLedger,
  creditLeft,
  spentByByok,
  spentByCost,
  utcDay,
  validAdminKey,
  validBalance,
  windowStarts,
  type CreditAnchor,
} from "../../shared/anthropiccredit";
import { byokPageFrom, sumByok } from "../../shared/openrouter";

const KEY = `sk-ant-admin01-${"0123456789abcdef".repeat(4)}`;
/** Saturday 25 October 2026, mid-afternoon UTC. */
const SATURDAY = Date.UTC(2026, 9, 25, 15);

const bucket = (day: string, ...amounts: string[]) => ({
  starting_at: `${day}T00:00:00Z`,
  ending_at: "ignored",
  results: amounts.map((amount) => ({ amount, currency: "USD" })),
});

describe("validAdminKey and adminKeyHint", () => {
  it("takes a real-shaped key and hints it by prefix and last four", () => {
    expect(validAdminKey(KEY)).toBe(true);
    expect(adminKeyHint(KEY)).toBe("sk-ant-admin01-…cdef");
  });

  it("refuses anything that would be a second header", () => {
    expect(validAdminKey(`${KEY}\r\nx-evil: 1`)).toBe(false);
    expect(validAdminKey(42)).toBe(false);
  });
});

describe("validBalance", () => {
  it("takes dollars and refuses what is not", () => {
    expect(validBalance(187.42)).toBe(true);
    expect(validBalance(0)).toBe(true);
    expect(validBalance(-1)).toBe(false);
    expect(validBalance(Number.NaN)).toBe(false);
    expect(validBalance(Infinity)).toBe(false);
    expect(validBalance("200")).toBe(false);
    expect(validBalance(5_000_000)).toBe(false);
  });
});

describe("costPageFrom", () => {
  it("reads cents as dollars, summed per bucket, and an empty bucket as zero", () => {
    const page = costPageFrom({ data: [bucket("2026-10-24", "123.45", "100"), bucket("2026-10-25")], has_more: false, next_page: null })!;
    expect(page.days.map((d) => d.day)).toEqual(["2026-10-24", "2026-10-25"]);
    expect(page.days[0]!.dollars).toBeCloseTo(2.2345, 10);
    expect(page.days[1]!.dollars).toBe(0);
    expect(page.next).toBeNull();
  });

  it("follows the cursor only when there is more", () => {
    expect(costPageFrom({ data: [], has_more: true, next_page: "page_x" })?.next).toBe("page_x");
    expect(costPageFrom({ data: [], has_more: false, next_page: "page_x" })?.next).toBeNull();
  });

  it("refuses a page with an amount it cannot read, rather than counting that day as nothing", () => {
    expect(costPageFrom({ data: [bucket("2026-10-24", "12.5", "lots")] })).toBeNull();
    expect(costPageFrom({ data: [bucket("2026-10-24", "")] })).toBeNull();
    expect(costPageFrom({ data: [{ starting_at: "2026-10-24T00:00:00Z", results: [{ amount: 12 }] }] })).toBeNull();
  });

  it("refuses another currency, a bucket without a day, and not a page at all", () => {
    expect(costPageFrom({ data: [{ starting_at: "2026-10-24T00:00:00Z", results: [{ amount: "1", currency: "EUR" }] }] })).toBeNull();
    expect(costPageFrom({ data: [{ results: [] }] })).toBeNull();
    expect(costPageFrom({ data: [{ starting_at: "2026-10-24T00:00:00Z" }] })).toBeNull();
    expect(costPageFrom(null)).toBeNull();
    expect(costPageFrom({ error: { type: "authentication_error" } })).toBeNull();
  });
});

describe("the windows", () => {
  it("counts the week from Monday and the month from the first, in UTC", () => {
    expect(windowStarts(SATURDAY)).toEqual({ week: "2026-10-19", month: "2026-10-01" });
    // A Sunday is the end of its week, not the start of the next.
    expect(windowStarts(Date.UTC(2026, 10, 1, 12))).toEqual({ week: "2026-10-26", month: "2026-11-01" });
  });

  it("asks from whichever is earliest of the anchor and the two windows", () => {
    expect(costStart("2026-10-24", SATURDAY)).toBe("2026-10-01");
    expect(costStart("2026-09-12", SATURDAY)).toBe("2026-09-12");
    expect(costStart(null, SATURDAY)).toBe("2026-10-01");
    // Early in a month the week reaches back into the last one.
    expect(costStart(null, Date.UTC(2026, 10, 3))).toBe("2026-11-01");
    expect(costStart(null, Date.UTC(2026, 9, 2))).toBe("2026-09-28");
  });

  it("sums today, the week and the month off the days", () => {
    const days = [
      { day: "2026-09-30", dollars: 100 },
      { day: "2026-10-01", dollars: 1 },
      { day: "2026-10-20", dollars: 2 },
      { day: "2026-10-25", dollars: 4 },
    ];
    expect(costWindows(days, SATURDAY)).toEqual({ day: 4, week: 6, month: 7 });
  });
});

describe("what has gone since the balance was read", () => {
  const anchor = (over: Partial<CreditAnchor> = {}): CreditAnchor => ({
    balance: 200,
    at: SATURDAY,
    cost: { day: "2026-10-25", before: 3 },
    byok: 40,
    ...over,
  });

  it("takes the anchor's own day less what it had cost by then, and every day after", () => {
    const days = [
      { day: "2026-10-24", dollars: 50 },
      { day: "2026-10-25", dollars: 5 },
      { day: "2026-10-26", dollars: 7 },
    ];
    expect(spentByCost({ ...anchor(), cost: { day: "2026-10-25", before: 3 } }, days)).toBe(9);
  });

  it("never goes below zero, when the report has not caught up with the baseline", () => {
    expect(spentByCost({ ...anchor(), cost: { day: "2026-10-25", before: 3 } }, [{ day: "2026-10-25", dollars: 2 }])).toBe(0);
  });

  it("takes the BYOK total's growth, and a deleted key cannot give spend back", () => {
    expect(spentByByok({ ...anchor(), byok: 40 }, 52.5)).toBe(12.5);
    expect(spentByByok({ ...anchor(), byok: 40 }, 31)).toBe(0);
  });

  it("is the balance less the spend, in the ledger the runway is worked from", () => {
    const status = {
      anchor: { balance: 200, at: SATURDAY, sources: [] },
      reading: { at: SATURDAY, source: "cost-report" as const, spent: 12.5, spend: null },
    };
    expect(creditLeft(status)).toBe(187.5);
    expect(creditLedger(status)).toEqual({ credits: 200, used: 12.5, spend: null });
    expect(creditLeft({ anchor: null, reading: null })).toBeNull();
  });

  it("prefers the cost report, and counts only from a baseline taken at the anchor", () => {
    expect(chooseSource(anchor(), { admin: true, byok: true })).toBe("cost-report");
    expect(chooseSource(anchor(), { admin: false, byok: true })).toBe("openrouter-byok");
    // An Admin key added later has no baseline of its own to count from.
    expect(chooseSource(anchor({ cost: null }), { admin: true, byok: true })).toBe("openrouter-byok");
    expect(chooseSource(anchor({ cost: null }), { admin: true, byok: false })).toBeNull();
    expect(chooseSource(anchor({ byok: null }), { admin: false, byok: true })).toBeNull();
  });
});

describe("anchorFrom", () => {
  it("reads back what was written", () => {
    const a: CreditAnchor = { balance: 200, at: SATURDAY, cost: { day: utcDay(SATURDAY), before: 1.5 }, byok: 12 };
    expect(anchorFrom(JSON.parse(JSON.stringify(a)))).toEqual(a);
  });

  it("drops a baseline it cannot read, and refuses an anchor without a balance", () => {
    expect(anchorFrom({ balance: 200, at: SATURDAY, cost: { day: "yesterday", before: 1 }, byok: "12" })).toEqual({
      balance: 200,
      at: SATURDAY,
      cost: null,
      byok: null,
    });
    expect(anchorFrom({ at: SATURDAY })).toBeNull();
    expect(anchorFrom(null)).toBeNull();
  });
});

describe("OpenRouter's BYOK totals", () => {
  const key = (total: unknown, day = 1, week = 2, month = 3) => ({
    byok_usage: total,
    byok_usage_daily: day,
    byok_usage_weekly: week,
    byok_usage_monthly: month,
  });

  it("sums every key's four figures", () => {
    const rows = byokPageFrom({ data: [key(10), key(5.5, 0.5, 1, 2)] })!;
    expect(sumByok(rows)).toEqual({ total: 15.5, day: 1.5, week: 3, month: 5 });
  });

  it("is nothing when any key does not say, since a sum with one missing is subtracted from a balance", () => {
    expect(byokPageFrom({ data: [key(10), { usage_daily: 1 }] })).toBeNull();
    expect(byokPageFrom({ data: [key(Number.NaN)] })).toBeNull();
    expect(byokPageFrom({ nope: [] })).toBeNull();
    expect(byokPageFrom({ data: [] })).toEqual([]);
  });
});
