/**
 * Where a board's scroller goes to show a card. The promise that matters
 * most is the one nobody sees when it is kept: a card already in view does
 * not move, because every click in the sidebar asks.
 */
import { describe, expect, it } from "bun:test";
import { revealTo } from "../src/reveal";

describe("revealTo", () => {
  it("stays put for an item wholly in view", () => {
    expect(revealTo(0, 400, 2000, { start: 0, size: 80 }, "centre")).toBeNull();
    expect(revealTo(300, 400, 2000, { start: 620, size: 80 }, "centre")).toBeNull();
    expect(revealTo(300, 400, 2000, { start: 300, size: 400 }, "nearest")).toBeNull();
  });

  it("centres an item below the fold, or above it", () => {
    // Middle of the item at 1040, of a 400 view at 840.
    expect(revealTo(0, 400, 2000, { start: 1000, size: 80 }, "centre")).toBe(840);
    expect(revealTo(1200, 400, 2000, { start: 100, size: 80 }, "centre")).toBe(0);
    // Half in view counts as out of it.
    expect(revealTo(0, 400, 2000, { start: 360, size: 80 }, "centre")).toBe(200);
  });

  it("brings an item only to the near edge when not centring", () => {
    expect(revealTo(0, 400, 2000, { start: 500, size: 200 }, "nearest")).toBe(308);
    expect(revealTo(900, 400, 2000, { start: 500, size: 200 }, "nearest")).toBe(492);
  });

  it("puts an item's start at the scroller's for a snap point, whichever side it is on", () => {
    expect(revealTo(8, 390, 1000, { start: 236, size: 220 }, "start")).toBe(236);
    expect(revealTo(700, 390, 1300, { start: 236, size: 220 }, "start")).toBe(236);
    expect(revealTo(0, 390, 1000, { start: 900, size: 220 }, "start")).toBe(610);
    expect(revealTo(236, 390, 1000, { start: 236, size: 220 }, "start")).toBeNull();
  });

  it("never goes past either end of what scrolls", () => {
    expect(revealTo(0, 400, 1000, { start: 960, size: 40 }, "centre")).toBe(600);
    expect(revealTo(500, 400, 1000, { start: 4, size: 40 }, "nearest")).toBe(0);
  });

  it("shows an item bigger than the view from its start", () => {
    expect(revealTo(0, 400, 2000, { start: 1000, size: 600 }, "centre")).toBe(992);
    expect(revealTo(0, 400, 2000, { start: 1000, size: 600 }, "nearest")).toBe(992);
  });
});
