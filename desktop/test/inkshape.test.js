/**
 * The screen pen's geometry in the main process, held to the server's.
 * `ink.js` cannot import `shared/ink.ts`, so `inkshape.js` keeps copies, and
 * a copy that drifted would end bursts by one rule in main and describe them
 * by another in `marks.md`.
 */
import { describe, expect, it } from "bun:test";
import * as shared from "../../shared/ink";
import { MARKS_MAX as SHARED_MARKS_MAX } from "../../shared/marks";
import { BURST_GAP_MS, CROP_MARGIN_MIN, FRAME_LONG_EDGE, MARKS_MAX, cropRect, pointOf, strokesBox, windowNumberOf } from "../inkshape.js";

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
});
