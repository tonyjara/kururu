/**
 * The workspace's mascot picker: which mascots a few typed letters keep, and
 * where an arrow key goes in a grid with a row of its own above it and a short
 * last row under it — the two places a cursor most easily lands nowhere.
 */
import { describe, expect, it } from "bun:test";
import { matchOptions, stepGrid } from "../src/mascotpick";

const names = (list: { name: string }[]) => list.map((one) => one.name);

describe("matchOptions", () => {
  const options = [
    { name: "Default", also: "Frog" },
    { name: "Frog" },
    { name: "Michi" },
    { name: "Plumber" },
    { name: "Gameboy Green" },
    { name: "Platypus" },
    { name: "Ñandú" },
  ];

  it("keeps everything, in order, for an empty or blank query", () => {
    expect(names(matchOptions(options, ""))).toEqual(names(options));
    expect(names(matchOptions(options, "   "))).toEqual(names(options));
  });

  it("puts a name that starts with it first, then a word that does, then anywhere", () => {
    expect(names(matchOptions(options, "gr"))).toEqual(["Gameboy Green"]);
    expect(names(matchOptions(options, "g"))).toEqual(["Gameboy Green", "Default", "Frog"]);
  });

  it("keeps the given order inside a rank", () => {
    expect(names(matchOptions(options, "pl"))).toEqual(["Plumber", "Platypus"]);
  });

  it("finds the default by the name of the mascot it is", () => {
    expect(names(matchOptions(options, "frog"))).toEqual(["Default", "Frog"]);
  });

  it("ignores case and accents", () => {
    expect(names(matchOptions(options, "MICHI"))).toEqual(["Michi"]);
    expect(names(matchOptions(options, "nandu"))).toEqual(["Ñandú"]);
  });

  it("keeps nothing when nothing matches", () => {
    expect(matchOptions(options, "zq")).toEqual([]);
  });
});

describe("stepGrid", () => {
  // Default on a row of its own, then 29 tiles five across: rows of 5, the
  // last one four long (indices 26..29).
  const count = 30;
  const cols = 5;
  const lead = 1;

  it("moves along a row without wrapping past its ends", () => {
    expect(stepGrid(2, "ArrowRight", count, cols, lead)).toBe(3);
    expect(stepGrid(2, "ArrowLeft", count, cols, lead)).toBe(1);
    expect(stepGrid(29, "ArrowRight", count, cols, lead)).toBe(29);
    expect(stepGrid(0, "ArrowLeft", count, cols, lead)).toBe(0);
  });

  it("moves a whole row down and up", () => {
    expect(stepGrid(2, "ArrowDown", count, cols, lead)).toBe(7);
    expect(stepGrid(7, "ArrowUp", count, cols, lead)).toBe(2);
  });

  it("goes from the leading row into the grid and back", () => {
    expect(stepGrid(0, "ArrowDown", count, cols, lead)).toBe(1);
    expect(stepGrid(0, "ArrowRight", count, cols, lead)).toBe(1);
    for (const top of [1, 3, 5]) expect(stepGrid(top, "ArrowUp", count, cols, lead)).toBe(0);
  });

  it("lands on the last entry from a column the short last row does not reach", () => {
    // Index 25 is the fifth column of the row above the last.
    expect(stepGrid(25, "ArrowDown", count, cols, lead)).toBe(29);
  });

  it("stays put going down from the last row", () => {
    expect(stepGrid(27, "ArrowDown", count, cols, lead)).toBe(27);
  });

  it("stays put going up from the first row with nothing above it", () => {
    expect(stepGrid(2, "ArrowUp", 29, cols, 0)).toBe(2);
  });

  it("goes to either end on Home and End", () => {
    expect(stepGrid(12, "Home", count, cols, lead)).toBe(0);
    expect(stepGrid(12, "End", count, cols, lead)).toBe(29);
  });

  it("follows the number of columns it is told, as on a phone", () => {
    expect(stepGrid(22, "ArrowDown", count, 4, lead)).toBe(26);
  });

  it("brings an index past the end back into range, and says -1 for nothing", () => {
    expect(stepGrid(40, "ArrowLeft", 3, cols)).toBe(1);
    expect(stepGrid(0, "ArrowDown", 0, cols)).toBe(-1);
  });
});
