/**
 * The reader's zoom ladder.
 *
 * A step is the whole of what pressing the key or the button means, and the two
 * things worth holding it to are both invisible in ordinary use. It must be
 * *reversible* — one press up and one press down has to land where it started,
 * or a zoom level stops being somewhere you can get back to — and it must not
 * run off either end, since the buttons are drawn from `canZoom` and a step that
 * silently did nothing would be a control that looks live and is not.
 *
 * The third case is the one that will actually happen: a number that is not on
 * the ladder. `localStorage` is a file somebody can edit and a stop retired in a
 * later version is a value written by an older one, and either way the answer
 * has to be a move in the direction asked for rather than a jump to an end.
 */
import { describe, expect, it } from "bun:test";
import { adoptZoom, canZoom, DEFAULT_ZOOM, stepZoom, ZOOM_STOPS, zoomLabel } from "../src/zoom";

const MIN = ZOOM_STOPS[0]!;
const MAX = ZOOM_STOPS[ZOOM_STOPS.length - 1]!;

describe("the zoom ladder", () => {
  it("steps to the next stop in each direction", () => {
    expect(stepZoom(1, 1)).toBe(ZOOM_STOPS[ZOOM_STOPS.indexOf(1) + 1]!);
    expect(stepZoom(1, -1)).toBe(ZOOM_STOPS[ZOOM_STOPS.indexOf(1) - 1]!);
    expect(stepZoom(1, 0)).toBe(1);
  });

  it("comes back to where it started", () => {
    for (const stop of ZOOM_STOPS.slice(1, -1)) {
      expect(stepZoom(stepZoom(stop, 1), -1)).toBe(stop);
      expect(stepZoom(stepZoom(stop, -1), 1)).toBe(stop);
    }
  });

  it("stops at both ends rather than wrapping or running off", () => {
    expect(stepZoom(MIN, -1)).toBe(MIN);
    expect(stepZoom(MAX, 1)).toBe(MAX);
    expect(stepZoom(MIN, -99)).toBe(MIN);
    expect(stepZoom(MAX, 99)).toBe(MAX);
  });

  it("says when a button has nowhere to go", () => {
    expect(canZoom(MIN, -1)).toBe(false);
    expect(canZoom(MIN, 1)).toBe(true);
    expect(canZoom(MAX, 1)).toBe(false);
    expect(canZoom(MAX, -1)).toBe(true);
  });

  /**
   * The value between two stops moves rather than snapping in place: snapping
   * would spend the press on arriving at the ladder, so the first press after a
   * hand-edited file would appear to do nothing.
   */
  it("moves a value that is between stops", () => {
    const between = (ZOOM_STOPS[3]! + ZOOM_STOPS[4]!) / 2;
    expect(stepZoom(between, 1)).toBeGreaterThan(between);
    expect(stepZoom(between, -1)).toBeLessThan(between);
  });

  it("takes anything storage hands back and returns a stop", () => {
    expect(adoptZoom("1.3")).toBe(1.3);
    expect(adoptZoom(null)).toBe(DEFAULT_ZOOM);
    expect(adoptZoom("wide")).toBe(DEFAULT_ZOOM);
    expect(adoptZoom(0)).toBe(MIN);
    expect(adoptZoom(1000)).toBe(MAX);
    expect(ZOOM_STOPS).toContain(adoptZoom(1.22));
  });

  it("prints a level as a whole percentage", () => {
    expect(zoomLabel(1)).toBe("100%");
    expect(zoomLabel(1.15)).toBe("115%");
    expect(ZOOM_STOPS.map(zoomLabel).every((label) => /^\d+%$/.test(label))).toBe(true);
  });
});
