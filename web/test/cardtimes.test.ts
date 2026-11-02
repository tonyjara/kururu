import { describe, expect, test } from "bun:test";
import { cardTimes, stamp } from "../src/cardtimes";

const now = Date.UTC(2026, 10, 2, 18, 0);
const at = Date.UTC(2026, 10, 2, 14, 32);

describe("stamp", () => {
  test("day, short month and time in the given locale and zone", () => {
    expect(stamp(at, now, "en-GB", "UTC")).toBe("2 Nov, 14:32");
    expect(stamp(at, now, "en-US", "UTC")).toBe("Nov 2, 2:32 PM");
  });

  test("the zone moves the time, and the day with it", () => {
    expect(stamp(Date.UTC(2026, 10, 2, 1, 5), now, "en-GB", "America/Asuncion")).toBe("1 Nov, 22:05");
  });

  test("the year only when it is not this one", () => {
    expect(stamp(Date.UTC(2025, 11, 30, 9, 0), now, "en-GB", "UTC")).toBe("30 Dec 2025, 09:00");
  });
});

describe("cardTimes", () => {
  test("a card written in Needs you has one time", () => {
    expect(cardTimes(at, at + 1, now, "en-GB", "UTC")).toEqual({ added: "2 Nov, 14:32" });
  });

  test("a card moved there later says both", () => {
    expect(cardTimes(Date.UTC(2026, 9, 30, 8, 0), at, now, "en-GB", "UTC")).toEqual({ added: "30 Oct, 08:00", since: "2 Nov, 14:32" });
  });

  test("no arrival time, or a broken one, is the written time alone", () => {
    expect(cardTimes(at, undefined, now, "en-GB", "UTC")).toEqual({ added: "2 Nov, 14:32" });
    expect(cardTimes(at, Number.NaN, now, "en-GB", "UTC")).toEqual({ added: "2 Nov, 14:32" });
  });
});
