/**
 * The aim a menu reads off a pointer crossing it on the way to an open list:
 * the diagonal down from "Send to" to its list is aiming, a pointer going
 * straight down the menu or back the way it came is not.
 */
import { describe, expect, it } from "bun:test";

import { AIM_MS, aiming, OPEN_MS, REST_PX } from "../src/menuaim";

// A list beside the menu's right edge, its first row level with the row that opened it.
const right = { left: 200, top: 100, right: 360, bottom: 300 };
// The same list on the menu's left.
const left = { left: 0, top: 100, right: 160, bottom: 300 };

describe("aiming", () => {
  it("takes a diagonal toward the list across the row below as aiming", () => {
    expect(aiming({ x: 120, y: 110 }, { x: 130, y: 122 }, right, true)).toBe(true);
    expect(aiming({ x: 240, y: 110 }, { x: 230, y: 122 }, left, false)).toBe(true);
  });

  it("does not take straight down the menu as aiming", () => {
    expect(aiming({ x: 120, y: 110 }, { x: 120, y: 130 }, right, true)).toBe(false);
    expect(aiming({ x: 120, y: 110 }, { x: 121, y: 160 }, right, true)).toBe(false);
  });

  it("does not take going the other way as aiming", () => {
    expect(aiming({ x: 120, y: 110 }, { x: 110, y: 122 }, right, true)).toBe(false);
    expect(aiming({ x: 240, y: 110 }, { x: 250, y: 122 }, left, false)).toBe(false);
  });

  it("does not take a pointer that has stopped as aiming", () => {
    expect(aiming({ x: 120, y: 110 }, { x: 120, y: 110 }, right, true)).toBe(false);
  });

  it("does not take a pointer already past the list's near edge as aiming", () => {
    expect(aiming({ x: 190, y: 110 }, { x: 205, y: 120 }, right, true)).toBe(false);
  });

  it("takes a short list beside a long menu with a little slack", () => {
    const short = { left: 200, top: 100, right: 360, bottom: 130 };
    // Headed just under the list's bottom edge.
    expect(aiming({ x: 120, y: 110 }, { x: 140, y: 116 }, short, true)).toBe(true);
    // Headed well below it.
    expect(aiming({ x: 120, y: 110 }, { x: 125, y: 160 }, short, true)).toBe(false);
  });
});

describe("the menu's timings", () => {
  it("are a short rest, the same either way, with a hand's drift allowed", () => {
    expect(OPEN_MS).toBe(250);
    expect(AIM_MS).toBe(250);
    expect(REST_PX).toBeGreaterThan(0);
  });
});
