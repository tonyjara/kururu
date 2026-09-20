/**
 * That the sentence under the bar says the right thing.
 *
 * The bar itself cannot really be wrong — it is one number as one width — but
 * the words beside it can, and they are the half people act on. "Resets in 4h"
 * is what decides whether somebody starts another agent this afternoon, so the
 * boundaries get checked: the minute either side of an hour, of a day, and of
 * the reset itself, which is the one that can go negative.
 */
import { describe, expect, it } from "bun:test";
import { limitLabel, limitTitle, resetIn, staleTitle } from "../src/usage";
import type { UsageLimit } from "../../shared/wire";

function limit(over: Partial<UsageLimit> = {}): UsageLimit {
  return {
    kind: "session",
    group: "session",
    percent: 41,
    severity: "normal",
    resetsAt: null,
    scope: null,
    ...over,
  };
}

const NOW = Date.parse("2026-09-18T12:00:00.000Z");
const inMs = (ms: number) => new Date(NOW + ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("limitLabel", () => {
  it("names the kinds it knows", () => {
    expect(limitLabel(limit({ kind: "session" }))).toBe("Session");
    expect(limitLabel(limit({ kind: "weekly_all" }))).toBe("Week");
  });

  it("hangs the model off a scoped limit", () => {
    expect(limitLabel(limit({ kind: "weekly_scoped", scope: "Opus" }))).toBe("Week · Opus");
  });

  /** A kind nobody has seen gets a readable label rather than no row. */
  it("tidies a kind it does not know", () => {
    expect(limitLabel(limit({ kind: "monthly_all" }))).toBe("Monthly all");
  });
});

describe("resetIn", () => {
  it("counts minutes under the hour", () => {
    expect(resetIn(inMs(14 * MIN), NOW)).toBe("resets in 14m");
  });

  it("counts hours and minutes under the day", () => {
    expect(resetIn(inMs(2 * HOUR + 14 * MIN), NOW)).toBe("resets in 2h 14m");
  });

  /** A round figure drops the empty half rather than printing "2h 0m". */
  it("drops the minutes when there are none", () => {
    expect(resetIn(inMs(2 * HOUR), NOW)).toBe("resets in 2h");
    expect(resetIn(inMs(3 * DAY), NOW)).toBe("resets in 3d");
  });

  it("counts days and hours past the day", () => {
    expect(resetIn(inMs(3 * DAY + 4 * HOUR), NOW)).toBe("resets in 3d 4h");
  });

  /** The seam at each unit, where an off-by-one prints "60m" or "24h". */
  it("crosses each boundary without printing a full unit of the smaller one", () => {
    expect(resetIn(inMs(59 * MIN), NOW)).toBe("resets in 59m");
    expect(resetIn(inMs(HOUR), NOW)).toBe("resets in 1h");
    expect(resetIn(inMs(23 * HOUR + 59 * MIN), NOW)).toBe("resets in 23h 59m");
    expect(resetIn(inMs(DAY), NOW)).toBe("resets in 1d");
  });

  /**
   * The window has turned over and the next poll has not landed. "now" rather
   * than a negative, which is the version a reader would notice and distrust.
   */
  it("reads a reset in the past as now", () => {
    expect(resetIn(inMs(-3 * MIN), NOW)).toBe("resets now");
    expect(resetIn(inMs(0), NOW)).toBe("resets now");
  });

  /** No honest guess at a reset time, so no line at all. */
  it("says nothing about a timestamp it cannot parse", () => {
    expect(resetIn("soon", NOW)).toBe("");
    expect(resetIn("", NOW)).toBe("");
  });
});

describe("limitTitle", () => {
  it("states both numbers, since a bar only shows one", () => {
    expect(limitTitle(limit({ percent: 41 }))).toBe("41% used, 59% left");
  });

  it("adds the exact reset when there is one", () => {
    expect(limitTitle(limit({ percent: 41, resetsAt: inMs(HOUR) }))).toContain("41% used, 59% left");
    expect(limitTitle(limit({ percent: 41, resetsAt: inMs(HOUR) }))).toContain("Resets ");
  });

  it("leaves the reset out rather than printing an unparseable one", () => {
    expect(limitTitle(limit({ percent: 41, resetsAt: "soon" }))).toBe("41% used, 59% left");
  });
});

describe("staleTitle", () => {
  it("says how old the numbers are", () => {
    expect(staleTitle(NOW - 5 * MIN, NOW)).toContain("5m old");
  });

  /** Never "0m old", which reads as current — the whole point is that it is not. */
  it("never claims the numbers are from this instant", () => {
    expect(staleTitle(NOW, NOW)).toContain("1m old");
  });
});
