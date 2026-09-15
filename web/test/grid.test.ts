/**
 * The guard that stops a pane which has not been laid out from resizing
 * somebody's agent.
 *
 * Worth a test because the value it refuses is not obviously wrong — `2x1` is a
 * perfectly well-formed grid, and the only thing that makes it a bug is knowing
 * it is what Ghostty's fit addon returns when it cannot measure the box. That
 * knowledge lives in one `if`, and an `if` with a number in it is exactly the
 * sort of thing somebody simplifies away.
 */
import { describe, expect, it } from "bun:test";
import { MIN_COLS, MIN_ROWS, usableGrid } from "../src/grid";

describe("usableGrid", () => {
  it("takes a real pane's measurement", () => {
    expect(usableGrid({ cols: 120, rows: 40 })).toEqual({ cols: 120, rows: 40 });
    expect(usableGrid({ cols: MIN_COLS, rows: MIN_ROWS })).toEqual({ cols: MIN_COLS, rows: MIN_ROWS });
  });

  it("refuses the clamp floor, which is how the addon says it could not measure", () => {
    // What a zero-size pane actually produces: Math.max(2, 0) by Math.max(1, 0).
    expect(usableGrid({ cols: 2, rows: 1 })).toBeNull();
    expect(usableGrid({ cols: 3, rows: 20 })).toBeNull();
    expect(usableGrid({ cols: 100, rows: 1 })).toBeNull();
  });

  it("refuses an absent or unfinished answer", () => {
    expect(usableGrid(undefined)).toBeNull();
    expect(usableGrid(null)).toBeNull();
    expect(usableGrid({})).toBeNull();
    expect(usableGrid({ cols: Number.NaN, rows: 20 })).toBeNull();
    expect(usableGrid({ cols: 80, rows: Number.POSITIVE_INFINITY })).toBeNull();
  });
});
