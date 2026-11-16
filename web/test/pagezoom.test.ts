/**
 * The measured zoom's one guard (`agrees` in `web/src/float.ts`): a zoom
 * read off a window's width and off its height is taken only when the two
 * say the same, since the outside and inside sizes caught halfway through
 * a resize say different things — which put the docked waveform at a third
 * of its size and the pen's tools at three times theirs (2026-11-15).
 */
import { describe, expect, it } from "bun:test";
import { agrees } from "../src/float";

describe("a measured zoom", () => {
  it("is taken when the width and the height say the same, rounding and all", () => {
    // 110%: a 497 × 64 panel is 451.8 × 58.2 inside.
    expect(agrees(497 / 451.8, 64 / 58.2)).toBe(true);
    expect(agrees(1, 1)).toBe(true);
  });

  it("is not taken halfway through a resize", () => {
    // Made at 480 × 72, told 148 × 64: the outside still the old, the inside the new.
    expect(agrees(480 / 135.2, 72 / 58.4)).toBe(false);
    // 148 wide to 497, the height unchanged.
    expect(agrees(148 / 453.9, 64 / 58.4)).toBe(false);
  });

  it("is not taken from a window with no size", () => {
    expect(agrees(Number.NaN, 1)).toBe(false);
    expect(agrees(1, Infinity)).toBe(false);
    expect(agrees(0, 0)).toBe(false);
  });
});
