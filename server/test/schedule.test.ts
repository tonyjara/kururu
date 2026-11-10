/**
 * The schedule line: that it reads as the plan's grammar and refuses in
 * words, that every slot is in its own zone whatever this machine's clock
 * says, that "every 2 weeks" keeps its weeks across edits and restarts, and
 * that the hours a change of clocks skips or repeats fire once.
 */
import { describe, expect, it } from "bun:test";
import { canonicalZone, dailyOrSlower, inWords, instantOf, nextFive, nextRun, parseSchedule, slotLabel, todayIn, wallOf, type Schedule } from "../../shared/schedule";
import { dayNumber } from "../../shared/days";

function parse(text: string): Schedule {
  const parsed = parseSchedule(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.schedule;
}

const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString());

describe("parseSchedule", () => {
  it("reads the plan's own line", () => {
    expect(parse("every 2 weeks on mon at 09:00 America/Asuncion from 2026-11-23")).toEqual({
      kind: "every",
      n: 2,
      unit: "weeks",
      on: [1],
      at: 540,
      zone: "America/Asuncion",
      from: "2026-11-23",
    });
  });

  it("reads the other three forms", () => {
    expect(parse("manual")).toEqual({ kind: "manual" });
    expect(parse("once 2026-11-23 09:00 UTC")).toEqual({ kind: "once", day: "2026-11-23", at: 540, zone: "UTC" });
    const cron = parse("cron 0 9 * * mon-fri Europe/Madrid");
    expect(cron.kind).toBe("cron");
    if (cron.kind === "cron") {
      expect(cron.dows).toEqual([1, 2, 3, 4, 5]);
      expect(cron.doms).toBeNull();
    }
  });

  it("takes days as lists, ranges and full names, and the last of a month", () => {
    expect(parse("every week on mon, wed,fri at 07:30 UTC")).toMatchObject({ on: [1, 3, 5], n: 1 });
    expect(parse("every 1 days on monday-friday at 07:30 UTC")).toMatchObject({ on: [1, 2, 3, 4, 5] });
    expect(parse("every month on 1,last at 08:00 UTC")).toMatchObject({ on: [1, -1] });
    expect(parse("every 15 minutes UTC")).toMatchObject({ n: 15, unit: "minutes", at: null });
  });

  it("refuses in words, never by guessing", () => {
    const why = (text: string) => {
      const parsed = parseSchedule(text);
      return parsed.ok ? null : parsed.error;
    };
    expect(why("every 2 minutes UTC")).toContain("5 minutes");
    expect(why("every day at 09:00")).toContain("time zone");
    expect(why("every day UTC")).toContain("at 09:00");
    expect(why("every day at 25:00 UTC")).toContain("not a time");
    expect(why("every week on someday at 09:00 UTC")).toContain("day of the week");
    expect(why("every 2 weeks at 09:00 Mars/Olympus")).toContain("not a time zone");
    expect(why("every 2 weeks at 09:00 UTC from 2026-02-30")).toContain("not a day");
    expect(why("weekly")).toContain("every, cron, once or manual");
    expect(why("cron * * * * * UTC")).toContain("5 minutes");
    expect(why("cron 0 9 * * UTC")).toContain("five fields");
    expect(why("every 2 hours on mon UTC")).toContain("days, weeks and months");
    expect(why("once 2026-11-23 09:00 UTC; rm -rf")).not.toBeNull();
  });

  it("knows a zone by its own spelling, and nothing that would need escaping", () => {
    expect(canonicalZone("America/Asuncion")).toBe("America/Asuncion");
    expect(canonicalZone("UTC")).toBe("UTC");
    expect(canonicalZone("america/asuncion")).toBe("America/Asuncion");
    expect(canonicalZone("Nowhere/Atall")).toBeNull();
    expect(canonicalZone("$(touch x)")).toBeNull();
  });
});

describe("nextRun", () => {
  const pasapy = parse("every 2 weeks on mon at 09:00 America/Asuncion from 2026-11-23");

  it("gives the Pasapy review's first five: 23 Nov, then every second Monday, at 09:00 Asunción", () => {
    const five = nextFive(pasapy, Date.parse("2026-11-10T12:00:00Z"), "2026-11-10").map(iso);
    // Asunción is UTC-3 all year since 2024.
    expect(five).toEqual([
      "2026-11-23T12:00:00.000Z",
      "2026-12-07T12:00:00.000Z",
      "2026-12-21T12:00:00.000Z",
      "2027-01-04T12:00:00.000Z",
      "2027-01-18T12:00:00.000Z",
    ]);
  });

  it("is strictly after: the slot itself gives the next one, never itself", () => {
    const slot = Date.parse("2026-11-23T12:00:00Z");
    expect(iso(nextRun(pasapy, slot - 1, "2026-11-10"))).toBe("2026-11-23T12:00:00.000Z");
    expect(iso(nextRun(pasapy, slot, "2026-11-10"))).toBe("2026-12-07T12:00:00.000Z");
  });

  it("keeps the on-weeks by the stored anchor when the line has no from", () => {
    const line = parse("every 2 weeks on mon at 09:00 UTC");
    // Made on Tuesday 2026-11-10: that week is week 0, so its Monday has gone and the next on-week is 23 Nov.
    expect(iso(nextRun(line, Date.parse("2026-11-10T12:00:00Z"), "2026-11-10"))).toBe("2026-11-23T09:00:00.000Z");
    // The same line, asked weeks later with the same anchor, still lands on the same alternation.
    expect(iso(nextRun(line, Date.parse("2026-12-01T00:00:00Z"), "2026-11-10"))).toBe("2026-12-07T09:00:00.000Z");
  });

  it("counts minutes and hours from the anchor, as elapsed time", () => {
    const line = parse("every 5 minutes UTC");
    expect(iso(nextRun(line, Date.parse("2026-11-10T12:03:10Z"), "2026-11-10"))).toBe("2026-11-10T12:05:00.000Z");
    expect(iso(nextRun(line, Date.parse("2026-11-10T12:05:00Z"), "2026-11-10"))).toBe("2026-11-10T12:10:00.000Z");
    const hourly = parse("every 3 hours at 01:00 UTC");
    expect(iso(nextRun(hourly, Date.parse("2026-11-10T05:00:00Z"), "2026-11-10"))).toBe("2026-11-10T07:00:00.000Z");
  });

  it("fires on weekdays only when asked, and on the last of a month", () => {
    const weekdays = parse("every day on mon-fri at 08:00 UTC");
    // Friday 2026-11-13 at noon: the next weekday is Monday the 16th.
    expect(iso(nextRun(weekdays, Date.parse("2026-11-13T12:00:00Z"), "2026-11-01"))).toBe("2026-11-16T08:00:00.000Z");
    const last = parse("every month on last at 23:00 UTC");
    expect(iso(nextRun(last, Date.parse("2027-02-01T00:00:00Z"), "2026-11-01"))).toBe("2027-02-28T23:00:00.000Z");
    const thirtyFirst = parse("every month on 31 at 10:00 UTC");
    // November has no 31st: skipped, as cron skips it.
    expect(iso(nextRun(thirtyFirst, Date.parse("2026-11-01T00:00:00Z"), "2026-10-01"))).toBe("2026-12-31T10:00:00.000Z");
  });

  it("puts a wall time in its zone, whatever this machine's zone is", () => {
    const line = parse("every day at 09:00 Asia/Tokyo");
    expect(iso(nextRun(line, Date.parse("2026-11-10T00:00:00Z"), "2026-11-01"))).toBe("2026-11-11T00:00:00.000Z");
  });

  it("fires a skipped hour at the next minute that exists, and a repeated hour once", () => {
    // New York springs forward at 02:00 on 2027-03-14: 02:30 does not exist.
    const spring = parse("every day at 02:30 America/New_York");
    expect(iso(nextRun(spring, Date.parse("2027-03-13T12:00:00Z"), "2027-03-01"))).toBe("2027-03-14T07:00:00.000Z");
    // And falls back at 02:00 on 2026-11-01: 01:30 happens twice, and fires the first time.
    const fall = parse("every day at 01:30 America/New_York");
    const first = nextRun(fall, Date.parse("2026-10-31T12:00:00Z"), "2026-10-01");
    expect(iso(first)).toBe("2026-11-01T05:30:00.000Z");
    expect(iso(nextRun(fall, first!, "2026-10-01"))).toBe("2026-11-02T06:30:00.000Z");
  });

  it("reads cron's two day fields the way cron does", () => {
    // Both restricted: the 1st or any Monday.
    const both = parse("cron 0 9 1 * mon UTC");
    expect(iso(nextRun(both, Date.parse("2026-11-24T00:00:00Z"), "x"))).toBe("2026-11-30T09:00:00.000Z");
    expect(iso(nextRun(both, Date.parse("2026-11-30T10:00:00Z"), "x"))).toBe("2026-12-01T09:00:00.000Z");
    const steps = parse("cron */30 9-10 * * * UTC");
    expect(nextFive(steps, Date.parse("2026-11-10T00:00:00Z"), "x").map(iso)).toEqual([
      "2026-11-10T09:00:00.000Z",
      "2026-11-10T09:30:00.000Z",
      "2026-11-10T10:00:00.000Z",
      "2026-11-10T10:30:00.000Z",
      "2026-11-11T09:00:00.000Z",
    ]);
  });

  it("has no next for manual, or for once when it has been", () => {
    expect(nextRun(parse("manual"), 0, "2026-11-10")).toBeNull();
    const once = parse("once 2026-11-23 09:00 UTC");
    expect(iso(nextRun(once, Date.parse("2026-11-10T00:00:00Z"), "x"))).toBe("2026-11-23T09:00:00.000Z");
    expect(nextRun(once, Date.parse("2026-11-23T09:00:00Z"), "x")).toBeNull();
    expect(nextRun(once, Number.NaN, "x")).toBeNull();
  });
});

describe("the rest", () => {
  it("says the schedule in words with its zone", () => {
    expect(inWords(parse("every 2 weeks on mon at 09:00 America/Asuncion from 2026-11-23"))).toBe(
      "every 2 weeks on Monday at 09:00 America/Asuncion, from 23 Nov 2026",
    );
    expect(inWords(parse("every day on mon-fri at 07:30 UTC"))).toBe("every day on Monday, Tuesday, Wednesday, Thursday and Friday at 07:30 UTC");
    expect(inWords(parse("every month on 1,last at 08:00 UTC"))).toBe("every month on the 1st and last day at 08:00 UTC");
    expect(inWords(parse("manual"))).toBe("only when run by hand");
  });

  it("labels a slot in its zone", () => {
    expect(slotLabel(Date.parse("2026-11-23T12:00:00Z"), "America/Asuncion")).toBe("Mon 23 Nov, 09:00");
  });

  it("knows which schedules are daily or slower, for the default catch-up", () => {
    expect(dailyOrSlower(parse("every 2 weeks on mon at 09:00 UTC"))).toBe(true);
    expect(dailyOrSlower(parse("every 6 hours UTC"))).toBe(false);
    expect(dailyOrSlower(parse("cron 0 9 * * * UTC"))).toBe(true);
    expect(dailyOrSlower(parse("cron 0 9,17 * * * UTC"))).toBe(false);
  });

  it("finds today and wall times in a zone", () => {
    expect(todayIn("Pacific/Kiritimati", Date.parse("2026-11-10T12:00:00Z"))).toBe("2026-11-11");
    expect(wallOf(Date.parse("2026-11-23T12:00:00Z"), "America/Asuncion")).toEqual({ day: dayNumber("2026-11-23")!, minute: 540 });
    expect(iso(instantOf(dayNumber("2026-11-23")!, 540, "America/Asuncion"))).toBe("2026-11-23T12:00:00.000Z");
  });
});
