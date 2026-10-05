/**
 * Calendar days: that a string is a day only if a calendar has it, and that
 * the arithmetic does not care what the clocks did that weekend.
 */
import { describe, expect, it } from "bun:test";
import { dayAt, dayNumber, today, weekday, weekStart } from "../../shared/days";

describe("days", () => {
  it("counts from 1970 and back again", () => {
    expect(dayNumber("1970-01-01")).toBe(0);
    expect(dayNumber("1969-12-31")).toBe(-1);
    expect(dayNumber("2026-09-28")).toBe(20724);
    expect(dayAt(20724)).toBe("2026-09-28");
    for (const day of ["2024-02-29", "1999-12-31", "2000-01-01", "2038-01-19"]) expect(dayAt(dayNumber(day)!)).toBe(day);
  });

  it("refuses a day no calendar has, rather than rolling it into the next month", () => {
    expect(dayNumber("2026-02-29")).toBeNull();
    expect(dayNumber("2024-02-29")).toBe(19782);
    expect(dayNumber("2026-04-31")).toBeNull();
    expect(dayNumber("2026-00-10")).toBeNull();
    expect(dayNumber("2026-13-01")).toBeNull();
    expect(dayNumber("2026-01-00")).toBeNull();
  });

  it("refuses anything that is not the one spelling", () => {
    for (const not of ["2026-9-28", "28-09-2026", "2026/09/28", "2026-09-28T00:00:00Z", " 2026-09-28", "", "today"]) {
      expect(dayNumber(not)).toBeNull();
    }
    for (const not of [20724, null, undefined, {}, new Date(0), Number.NaN]) expect(dayNumber(not)).toBeNull();
    // Two digits are a year `Date` would put in the 1900s. Four is the rule,
    // and the first century is not a year anything here is planned for.
    expect(dayNumber("0026-09-28")).toBeNull();
  });

  it("is a day later across a change of clocks", () => {
    // Europe and the Americas both move theirs inside these two ranges.
    expect(dayNumber("2026-03-30")! - dayNumber("2026-03-28")!).toBe(2);
    expect(dayNumber("2026-11-02")! - dayNumber("2026-10-24")!).toBe(9);
  });

  it("reads today off the clock where the person is, not in UTC", () => {
    expect(today(new Date(2026, 8, 28, 23, 59))).toBe("2026-09-28");
    expect(today(new Date(2026, 0, 1, 0, 0))).toBe("2026-01-01");
  });

  it("knows the day of the week, either side of 1970", () => {
    expect(weekday(0)).toBe(4);
    expect(weekday(-1)).toBe(3);
    expect(weekday(-5)).toBe(6);
    expect(weekday(20724)).toBe(1);
  });

  it("finds the start of a week for whichever day a week starts on", () => {
    const thursday = dayNumber("2026-10-01")!;
    expect(dayAt(weekStart(thursday, 1))).toBe("2026-09-28");
    expect(dayAt(weekStart(thursday, 0))).toBe("2026-09-27");
    expect(dayAt(weekStart(thursday, 6))).toBe("2026-09-26");
    expect(weekStart(20724, 1)).toBe(20724);
    expect(dayAt(weekStart(-1, 1))).toBe("1969-12-29");
  });
});
