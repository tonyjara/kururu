/**
 * The one property a screenshot cannot show and the whole module exists for:
 * that a box or block character reaches the edge of its cell exactly, so the
 * next cell's begins where this one ends.
 *
 * The bug being pinned here was invisible in review and obvious on screen — a
 * font's `─` is 7.34px wide in an 8px cell and its `█` starts 0.77px below the
 * cell's top, so a rule came out dashed and a masthead came out as bricks. Every
 * assertion below is therefore about coverage rather than about shapes: what
 * matters is not that `─` is one rectangle but that no column of the cell is
 * left unpainted, because a single unpainted column is the whole defect.
 *
 * The cell is 8 × 11 at half-pixel units, which is SF Mono at 12px on a retina
 * display — the case in the screenshot that started this.
 */
import { describe, expect, it } from "bun:test";
import { type BoxShape, boxShapes } from "../src/boxdraw";

const W = 8;
const H = 11;
const U = 0.5;

const shapesOf = (ch: string, w = W, h = H, u = U) => boxShapes(ch.codePointAt(0) ?? 0, w, h, u);

/**
 * The shapes painted onto a grid one device pixel across, so that a question
 * about coverage can be asked as one. Shaded rectangles are left out: they are
 * the cell at an alpha and would answer every coverage question trivially.
 */
function raster(shapes: BoxShape[] | null, w = W, h = H, u = U): boolean[][] {
  const cols = Math.round(w / u);
  const rows = Math.round(h / u);
  const grid = Array.from({ length: rows }, () => new Array<boolean>(cols).fill(false));
  for (const s of shapes ?? []) {
    if (s.kind !== "rect" || s.alpha !== undefined) continue;
    for (let ry = 0; ry < rows; ry++) {
      for (let rx = 0; rx < cols; rx++) {
        const px = (rx + 0.5) * u;
        const py = (ry + 0.5) * u;
        if (px > s.x && px < s.x + s.w && py > s.y && py < s.y + s.h) {
          (grid[ry] as boolean[])[rx] = true;
        }
      }
    }
  }
  return grid;
}

const inked = (grid: boolean[][]) => grid.flat().filter(Boolean).length;
const rowOf = (grid: boolean[][], y: number) => grid[y] ?? [];
const colOf = (grid: boolean[][], x: number) => grid.map((row) => row[x] ?? false);

describe("lines reach the edge", () => {
  it("draws ─ from one side of the cell to the other", () => {
    const grid = raster(shapesOf("─"));
    const band = grid.findIndex((row) => row.some(Boolean));
    expect(band).toBeGreaterThan(0);
    // The defect this replaces: the font's glyph stops 0.66px short, so the row
    // has a hole in it at the far end and the rule looks dashed.
    expect(rowOf(grid, band).every(Boolean)).toBe(true);
  });

  it("draws │ from the top of the cell to the bottom", () => {
    const grid = raster(shapesOf("│"));
    const band = grid[0]?.findIndex(Boolean) ?? -1;
    expect(band).toBeGreaterThan(0);
    expect(colOf(grid, band).every(Boolean)).toBe(true);
  });

  it("reaches the edge at one device pixel per cell pixel too", () => {
    const grid = raster(shapesOf("─", W, H, 1), W, H, 1);
    const band = grid.findIndex((row) => row.some(Boolean));
    expect(rowOf(grid, band).every(Boolean)).toBe(true);
  });

  it("stops at the centre when only one arm is asked for", () => {
    const grid = raster(shapesOf("╴"));
    const band = grid.findIndex((row) => row.some(Boolean));
    expect(rowOf(grid, band).slice(0, W / U / 2).every(Boolean)).toBe(true);
    expect(rowOf(grid, band).slice(W / U / 2).some(Boolean)).toBe(false);
  });

  it("gives heavy more weight than light, and both at least a pixel", () => {
    const light = inked(raster(shapesOf("─")));
    const heavy = inked(raster(shapesOf("━")));
    expect(light).toBeGreaterThan(0);
    expect(heavy).toBeGreaterThan(light);
  });
});

describe("corners and junctions", () => {
  it("fills the corner of ┌ rather than leaving a notch in it", () => {
    const grid = raster(shapesOf("┌"));
    // Both arms reach their own edge...
    expect(colOf(grid, W / U - 1).some(Boolean)).toBe(true);
    expect(rowOf(grid, H / U - 1).some(Boolean)).toBe(true);
    // ...and the quarter square between them is painted, which an arm that
    // stopped dead at the centre would leave empty.
    const midX = Math.floor(W / U / 2) - 1;
    const midY = Math.floor(H / U / 2) - 1;
    expect(rowOf(grid, midY)[midX]).toBe(true);
  });

  it("leaves the junction of ╬ open, which is what a double line is for", () => {
    const grid = raster(shapesOf("╬"));
    const midX = Math.floor(W / U / 2);
    const midY = Math.floor(H / U / 2);
    expect(rowOf(grid, midY)[midX]).toBe(false);
    // Each arm still arrives at its edge.
    expect(rowOf(grid, midY - 2).some(Boolean)).toBe(true);
    expect(colOf(grid, 0).some(Boolean)).toBe(true);
    expect(colOf(grid, W / U - 1).some(Boolean)).toBe(true);
  });

  it("keeps the far wall of ╠ continuous and breaks the near one", () => {
    const grid = raster(shapesOf("╠"));
    const midX = Math.floor(W / U / 2);
    // The left rail runs the full height of the cell; the right one is cut where
    // the branch comes through, and the branch reaches the right edge.
    expect(colOf(grid, midX - 2).every(Boolean)).toBe(true);
    expect(colOf(grid, W / U - 1).some(Boolean)).toBe(true);
    const near = colOf(grid, midX + 1);
    expect(near.some(Boolean)).toBe(true);
    expect(near.every(Boolean)).toBe(false);
  });

  it("runs ═ the full width as two rails", () => {
    const grid = raster(shapesOf("═"));
    const bands = grid.map((row, i) => (row.some(Boolean) ? i : -1)).filter((i) => i >= 0);
    expect(bands.length).toBeGreaterThanOrEqual(2);
    for (const band of bands) expect(rowOf(grid, band).every(Boolean)).toBe(true);
    // The channel between the rails is what makes it a double line.
    expect(bands.some((b, i) => i > 0 && b - (bands[i - 1] ?? 0) > 1)).toBe(true);
  });

  it("draws an arc as a curve that starts and ends on the cell's edges", () => {
    const [curve] = shapesOf("╭") ?? [];
    expect(curve?.kind).toBe("curve");
    if (curve?.kind !== "curve") return;
    expect(curve.y1).toBe(H);
    expect(curve.x2).toBe(W);
  });

  it("dashes a dashed line rather than drawing it solid", () => {
    const grid = raster(shapesOf("┄"));
    const band = grid.findIndex((row) => row.some(Boolean));
    expect(rowOf(grid, band).some(Boolean)).toBe(true);
    expect(rowOf(grid, band).every(Boolean)).toBe(false);
  });
});

describe("blocks tile the cell", () => {
  it("fills the whole cell for █", () => {
    expect(raster(shapesOf("█")).every((row) => row.every(Boolean))).toBe(true);
  });

  it("splits the cell exactly between ▀ and ▄", () => {
    const upper = raster(shapesOf("▀"));
    const lower = raster(shapesOf("▄"));
    expect(inked(upper) + inked(lower)).toBe((W / U) * (H / U));
    expect(upper.some((row, y) => row.some((on, x) => on && (lower[y]?.[x] ?? false)))).toBe(false);
  });

  it("splits the cell exactly between ▌ and ▐", () => {
    const left = raster(shapesOf("▌"));
    const right = raster(shapesOf("▐"));
    expect(inked(left) + inked(right)).toBe((W / U) * (H / U));
    expect(left.some((row, y) => row.some((on, x) => on && (right[y]?.[x] ?? false)))).toBe(false);
  });

  it("tiles the four quadrants with no seam and no overlap", () => {
    // The masthead in the report is these four: ▐ ▛ ▝ ▜ over a black ground, so
    // a seam between quadrants is what made it read as separate bricks.
    const quads = ["▘", "▝", "▖", "▗"].map((ch) => raster(shapesOf(ch)));
    const total = quads.reduce((n, q) => n + inked(q), 0);
    expect(total).toBe((W / U) * (H / U));
    for (let y = 0; y < H / U; y++) {
      for (let x = 0; x < W / U; x++) {
        expect(quads.filter((q) => q[y]?.[x]).length).toBe(1);
      }
    }
  });

  it("puts the eighths against the edge they are named for", () => {
    for (const ch of ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]) {
      const grid = raster(shapesOf(ch));
      expect(rowOf(grid, H / U - 1).every(Boolean)).toBe(true);
    }
    for (const ch of ["▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"]) {
      const grid = raster(shapesOf(ch));
      expect(colOf(grid, 0).every(Boolean)).toBe(true);
    }
  });

  it("makes a shade an alpha over the whole cell, not a shape", () => {
    const [shade] = shapesOf("▒") ?? [];
    expect(shade).toEqual({ kind: "rect", x: 0, y: 0, w: W, h: H, alpha: 0.5 });
  });
});

describe("what it declines", () => {
  it("leaves everything outside the two ranges to the font", () => {
    // Including the geometric shapes next door, which are glyphs with their own
    // proportions rather than characters that have to fill a cell.
    for (const ch of ["M", " ", "▲", "◆", "⠿"]) expect(shapesOf(ch)).toBeNull();
  });

  it("refuses a cell that has not been measured", () => {
    expect(shapesOf("─", 0, 11, 0.5)).toBeNull();
    expect(shapesOf("─", 8, 0, 0.5)).toBeNull();
    expect(shapesOf("─", 8, 11, 0)).toBeNull();
  });
});
