/**
 * The room a first click acts in, as the page sends it and as AppKit is told
 * it (`firstClickRoom` in `stays.js`). The page measures its buttons in its
 * own pixels and the window's points are those times the page's zoom; and it
 * is a number off the wire, so anything but four finite numbers is no room
 * at all, never a room clamped into shape.
 */
import { describe, expect, it } from "bun:test";
import { firstClickRoom } from "../stays.js";

describe("firstClickRoom", () => {
  it("is the page's room at 100%", () => {
    expect(firstClickRoom({ x: 13, y: 18, width: 52, height: 12 }, 1)).toEqual({ x: 13, y: 18, width: 52, height: 12 });
  });

  it("is multiplied into the window's points by the zoom", () => {
    // At 110% the page measures its 52-point group as 47.27 of its pixels.
    const room = firstClickRoom({ x: 13 / 1.1, y: 20, width: 52 / 1.1, height: 12 / 1.1 }, 1.1);
    expect(room?.x).toBeCloseTo(13);
    expect(room?.y).toBeCloseTo(22);
    expect(room?.width).toBeCloseTo(52);
    expect(room?.height).toBeCloseTo(12);
  });

  it("is none for nothing, or for no size", () => {
    expect(firstClickRoom(null, 1)).toBeNull();
    expect(firstClickRoom(undefined, 1)).toBeNull();
    expect(firstClickRoom("13,18,52,12", 1)).toBeNull();
    expect(firstClickRoom({ x: 13, y: 18, width: 0, height: 12 }, 1)).toBeNull();
    expect(firstClickRoom({ x: 13, y: 18, width: 52, height: -1 }, 1)).toBeNull();
  });

  it("is none for a number that is not one", () => {
    expect(firstClickRoom({ x: NaN, y: 18, width: 52, height: 12 }, 1)).toBeNull();
    expect(firstClickRoom({ x: 13, y: Infinity, width: 52, height: 12 }, 1)).toBeNull();
    expect(firstClickRoom({ x: 13, y: 18, width: "52", height: 12 }, 1)).toBeNull();
    expect(firstClickRoom({ x: 13, y: 18, width: 52 }, 1)).toBeNull();
    expect(firstClickRoom({ x: 13, y: 18, width: 52, height: 12 }, NaN)).toBeNull();
    expect(firstClickRoom({ x: 13, y: 18, width: 52, height: 12 }, 0)).toBeNull();
  });

  it("is none for a room no three buttons need, which would give a whole window the first click", () => {
    expect(firstClickRoom({ x: 0, y: 0, width: 1280, height: 860 }, 1)).toBeNull();
  });
});
