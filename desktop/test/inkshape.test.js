/**
 * The screen pen's geometry in the main process, held to the server's.
 * `ink.js` cannot import `shared/ink.ts`, so `inkshape.js` keeps copies, and
 * a copy that drifted would end bursts by one rule in main and describe them
 * by another in `marks.md`.
 */
import { describe, expect, it } from "bun:test";
import * as shared from "../../shared/ink";
import { MARKS_MAX as SHARED_MARKS_MAX } from "../../shared/marks";
import { BURST_GAP_MS, CROP_MARGIN_MIN, FRAME_LONG_EDGE, MARKS_MAX, PENCIL_SLOP, cropRect, pencilHit, pointOf, rectOf, strokesBox, windowNumberOf } from "../inkshape.js";

describe("inkshape", () => {
  it("has the server's numbers", () => {
    expect(BURST_GAP_MS).toBe(shared.BURST_GAP_MS);
    expect(FRAME_LONG_EDGE).toBe(shared.FRAME_LONG_EDGE);
    expect(CROP_MARGIN_MIN).toBe(shared.CROP_MARGIN_MIN);
    expect(MARKS_MAX).toBe(SHARED_MARKS_MAX);
  });

  it("boxes and crops as the server does", () => {
    const strokes = [
      [
        [10, 20],
        [300, 25],
      ],
      [[15, 400]],
    ];
    expect(strokesBox(strokes)).toEqual(shared.strokesBox(strokes));
    for (const box of [strokesBox(strokes), { x: 1400, y: 880, width: 30, height: 15 }, { x: 0, y: 0, width: 800, height: 100 }]) {
      expect(cropRect(box, { width: 1440, height: 900 })).toEqual(shared.cropRect(box, { width: 1440, height: 900 }));
    }
  });

  it("takes only finite points, and window numbers out of a media source id", () => {
    expect(pointOf([1, 2])).toEqual([1, 2]);
    expect(pointOf([NaN, 2])).toBeNull();
    expect(pointOf("1,2")).toBeNull();
    expect(windowNumberOf("window:12345:0")).toBe(12345);
    expect(windowNumberOf("screen:1:0")).toBeNull();
  });

  it("takes a pencil's place only as four finite numbers and a size", () => {
    expect(rectOf({ x: 10, y: 20, width: 28, height: 28 })).toEqual({ x: 10, y: 20, width: 28, height: 28 });
    expect(rectOf({ x: "10", y: 20, width: 28, height: 28 })).toEqual({ x: 10, y: 20, width: 28, height: 28 });
    expect(rectOf({ x: NaN, y: 20, width: 28, height: 28 })).toBeNull();
    expect(rectOf({ x: 10, y: 20, width: 0, height: 28 })).toBeNull();
    expect(rectOf({ x: 10, y: 20, width: 28, height: 5000 })).toBeNull();
    expect(rectOf(null)).toBeNull();
    expect(rectOf("10,20,28,28")).toBeNull();
  });

  it("finds a pen-down on a box's pencil, at the page's zoom, the frontmost window deciding", () => {
    const chat = { bounds: { x: 1000, y: 500, width: 320, height: 300 }, zoom: 1.1, pencil: { x: 40, y: 250, width: 28, height: 28 } };
    const window = { bounds: { x: 0, y: 0, width: 1600, height: 1000 }, zoom: 1, pencil: { x: 1030, y: 770, width: 28, height: 28 } };
    // The chat's pencil, at 110%: from 1044 to 1074.8 across, 775 to 805.8 down.
    expect(pencilHit({ x: 1050, y: 780 }, [chat, window])).toBe(true);
    expect(pencilHit({ x: 1044 - PENCIL_SLOP, y: 775 }, [chat])).toBe(true);
    expect(pencilHit({ x: 1044 - PENCIL_SLOP - 1, y: 775 }, [chat])).toBe(false);
    // The window's pencil is under the chat: a press there is the chat's, and misses its pencil.
    expect(pencilHit({ x: 1035, y: 775 }, [chat, window])).toBe(false);
    expect(pencilHit({ x: 1035, y: 775 }, [window])).toBe(true);
    // Off every window that has one: a stroke.
    expect(pencilHit({ x: 200, y: 200 }, [chat])).toBe(false);
    expect(pencilHit({ x: 200, y: 200 }, [])).toBe(false);
  });
});
