/**
 * That an OpenRouter answer cannot become a wrong balance, and that the pace
 * behind the balance's colour is measured over the window it claims.
 *
 * The parse is held to `usage.test.ts`'s rule — refuse, never repair — because
 * the client draws `credits - used` as "what you have left", and a default of
 * zero on either side is a balance off by everything ever bought or spent.
 */
import { describe, expect, it } from "bun:test";

import {
  balanceSeverity,
  creditsFrom,
  formatDollars,
  formatRunway,
  keyHint,
  keyPageFrom,
  runway,
  sumSpend,
  validOpenRouterKey,
  type OpenRouterReading,
} from "../../shared/openrouter";

const KEY = `sk-or-v1-${"0123456789abcdef".repeat(4)}`;

describe("validOpenRouterKey", () => {
  it("takes a real-shaped key", () => {
    expect(validOpenRouterKey(KEY)).toBe(true);
  });

  it("refuses anything that would be a second header", () => {
    expect(validOpenRouterKey(`${KEY}\r\nx-evil: 1`)).toBe(false);
    expect(validOpenRouterKey(`${KEY} `)).toBe(false);
  });

  it("refuses the short, the long and the not-a-string", () => {
    expect(validOpenRouterKey("sk-or")).toBe(false);
    expect(validOpenRouterKey("a".repeat(300))).toBe(false);
    expect(validOpenRouterKey(42)).toBe(false);
  });
});

describe("keyHint", () => {
  it("keeps the prefix and the last four, and nothing between", () => {
    expect(keyHint(KEY)).toBe("sk-or-v1-…cdef");
  });

  it("does without a prefix it does not know", () => {
    expect(keyHint("abcdefghijklmnop1234")).toBe("…1234");
  });
});

describe("creditsFrom", () => {
  it("reads both totals", () => {
    expect(creditsFrom({ data: { total_credits: 50, total_usage: 37.66 } })).toEqual({ credits: 50, used: 37.66 });
  });

  it("refuses a half: one real figure and a default is a made-up balance", () => {
    expect(creditsFrom({ data: { total_credits: 50 } })).toBeNull();
    expect(creditsFrom({ data: { total_credits: 50, total_usage: "37" } })).toBeNull();
    expect(creditsFrom({ data: { total_credits: Number.NaN, total_usage: 1 } })).toBeNull();
  });

  it("refuses a shape it does not know", () => {
    expect(creditsFrom(null)).toBeNull();
    expect(creditsFrom({ total_credits: 50, total_usage: 1 })).toBeNull();
  });
});

describe("keyPageFrom", () => {
  const key = (over: Record<string, unknown> = {}) => ({
    hash: "x",
    usage: 10,
    usage_daily: 1,
    usage_weekly: 3,
    usage_monthly: 7,
    ...over,
  });

  it("reads each key's three running totals", () => {
    expect(keyPageFrom({ data: [key(), key({ usage_daily: 0.5 })] })).toEqual([
      { day: 1, week: 3, month: 7 },
      { day: 0.5, week: 3, month: 7 },
    ]);
  });

  it("skips a key it cannot read rather than counting it as nothing", () => {
    expect(keyPageFrom({ data: [key({ usage_weekly: null }), key()] })).toEqual([{ day: 1, week: 3, month: 7 }]);
  });

  it("tells an empty page from one that is not a page", () => {
    expect(keyPageFrom({ data: [] })).toEqual([]);
    expect(keyPageFrom({ data: {} })).toBeNull();
  });

  it("sums across keys", () => {
    expect(sumSpend([{ day: 1, week: 2, month: 3 }, { day: 1, week: 2, month: 3 }])).toEqual({ day: 2, week: 4, month: 6 });
  });
});

/** Wednesday 15 October 2025, noon UTC: two and a half days into the week, fourteen and a half into the month. */
const MID_OCTOBER = Date.UTC(2025, 9, 15, 12);
/** Friday 3 October 2025, noon UTC: four and a half days into the week, two and a half into the month. */
const EARLY_OCTOBER = Date.UTC(2025, 9, 3, 12);

function reading(over: Partial<OpenRouterReading> = {}): OpenRouterReading {
  return { at: 0, credits: 50, used: 30, spend: { day: 1, week: 5, month: 29 }, ...over };
}

describe("runway", () => {
  it("paces by the month once the month has been open longer than the week", () => {
    const pace = runway(reading(), MID_OCTOBER)!;
    expect(pace.basis).toBe("month");
    expect(pace.perDay).toBeCloseTo(29 / 14.5, 6);
    expect(pace.days).toBeCloseTo(20 / (29 / 14.5), 6);
  });

  it("paces by the week when the week started in the last month", () => {
    const pace = runway(reading({ spend: { day: 1, week: 9, month: 5 } }), EARLY_OCTOBER)!;
    expect(pace.basis).toBe("week");
    expect(pace.perDay).toBeCloseTo(9 / 4.5, 6);
  });

  it("never measures over less than a day", () => {
    // Monday 1 September 2025, two hours in: both windows opened at midnight.
    const pace = runway(reading({ spend: { day: 2, week: 2, month: 2 } }), Date.UTC(2025, 8, 1, 2))!;
    expect(pace.perDay).toBe(2);
  });

  it("has nothing to say about an account nothing is spending", () => {
    expect(runway(reading({ spend: { day: 0, week: 0, month: 0 } }), MID_OCTOBER)).toBeNull();
    expect(runway(reading({ spend: null }), MID_OCTOBER)).toBeNull();
  });

  it("does not run backwards on a negative balance", () => {
    expect(runway(reading({ used: 60 }), MID_OCTOBER)!.days).toBe(0);
  });
});

describe("balanceSeverity", () => {
  // Two dollars a day, mid-month.
  const at = (balance: number) => reading({ credits: 30 + balance, used: 30, spend: { day: 2, week: 5, month: 29 } });

  it("goes by days left, not by dollars", () => {
    expect(balanceSeverity(at(20), MID_OCTOBER)).toBe("normal");
    expect(balanceSeverity(at(10), MID_OCTOBER)).toBe("warning");
    expect(balanceSeverity(at(4), MID_OCTOBER)).toBe("critical");
  });

  it("is red at nothing left whatever the pace", () => {
    expect(balanceSeverity(reading({ used: 50, spend: null }), MID_OCTOBER)).toBe("critical");
  });

  it("is calm when nothing is being spent", () => {
    expect(balanceSeverity(reading({ spend: null }), MID_OCTOBER)).toBe("normal");
  });
});

describe("formatDollars", () => {
  it("prints cents under a thousand and drops them above", () => {
    expect(formatDollars(12.345)).toBe("$12.35");
    expect(formatDollars(0)).toBe("$0.00");
    expect(formatDollars(1204.4)).toBe("$1,204");
  });

  it("says a fraction of a cent is not nothing", () => {
    expect(formatDollars(0.0004)).toBe("<$0.01");
  });

  it("puts the sign outside", () => {
    expect(formatDollars(-0.52)).toBe("-$0.52");
  });
});

describe("formatRunway", () => {
  it("is coarse at both ends", () => {
    expect(formatRunway(0.4)).toBe("under a day");
    expect(formatRunway(1.9)).toBe("about 1 day");
    expect(formatRunway(9.7)).toBe("about 9 days");
    expect(formatRunway(500)).toBe("over a year");
  });
});
