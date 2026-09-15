/**
 * Box-drawing and block-element characters, drawn to the cell instead of taken
 * from the font.
 *
 * These two Unicode ranges are the only ones whose whole job is to *touch the
 * edge of the cell*: a row of `─` has to read as one unbroken rule, and a run of
 * `█` has to read as a solid shape rather than a row of bricks. Every other
 * character is deliberately smaller than its cell — side bearings are what stop
 * letters from colliding — so a terminal that draws text by asking the font for
 * a glyph and painting it at the cell origin is right about everything except
 * these two ranges, where it is wrong by exactly the amount the font reserves
 * for breathing room.
 *
 * ghostty-web is such a terminal: its renderer is one `fillText` per cell with
 * no synthesis of any kind, and its cell is measured off `M` —
 * `ceil(measureText("M").width)` wide, `ceil(ascent + descent) + 2` tall. In SF
 * Mono at 12px that cell is 8 × 11, while `─` is 7.34 wide and `█` runs from
 * 0.77 below the cell's top to 2 past its bottom. So consecutive `─` leave a
 * 0.66px hole between them and stacked blocks leave a 0.77px seam, which is the
 * hairline dashes in Claude Code's input rule and the grid of bricks in its
 * masthead. No font fixes this and it is not a font problem: the cell is a crop
 * of the em box taken from one capital letter, so no face's block glyphs can be
 * expected to fill it. Ghostty proper draws with fillText too and does not have
 * the bug, because it never asks the font — it rasterises U+2500–U+259F itself,
 * to the cell, which is what this module is.
 *
 * The geometry is pure and kept apart from the painting because the geometry is
 * the whole decision, the same argument `sizing.ts` makes. `web/test` can then
 * assert the property that matters and that no screenshot shows: that shapes
 * reach the cell edge exactly, so two neighbours abut with nothing between them.
 *
 * Coordinates are relative to the cell, which is what makes snapping to the
 * device pixel safe to do locally: cell origins are integer multiples of a cell
 * width and height that are themselves integers (the renderer ceils both), so a
 * position rounded within one cell rounds identically in every other.
 *
 * Not covered, on purpose: Powerline's private-use separators (U+E0B0–), which
 * have the same seam and are somebody else's codepoints. A patched font either
 * has them or the cell is tofu, and guessing at a private-use assignment is a
 * different kind of mistake from correcting a glyph whose shape Unicode names.
 */

/** A piece of a synthesized glyph, in cell-relative coordinates. */
export type BoxShape =
  | { kind: "rect"; x: number; y: number; w: number; h: number; alpha?: number }
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number; width: number }
  | { kind: "curve"; x1: number; y1: number; cx: number; cy: number; x2: number; y2: number; width: number };

export const FIRST_BOX = 0x2500;
export const LAST_BOX = 0x259f;

/**
 * Every box-drawing character that is four arms and nothing else, as the weight
 * of its up, right, down and left arm: 0 none, 1 light, 2 heavy, 3 double.
 *
 * A table rather than an algorithm because the range is not one — the light and
 * heavy forms interleave in an order only a table can state, and the
 * mixed-weight tees (`┞`, `╆`) exist precisely so that no rule covers them. The
 * entries left empty are the ones that are not arms at all: the dashes, the
 * arcs and the diagonals, each handled below on its own terms.
 */
const ARMS: readonly string[] = [
  // ─ ━ │ ┃ ┄ ┅ ┆ ┇
  "0101", "0202", "1010", "2020", "", "", "", "",
  // ┈ ┉ ┊ ┋ ┌ ┍ ┎ ┏
  "", "", "", "", "0110", "0210", "0120", "0220",
  // ┐ ┑ ┒ ┓ └ ┕ ┖ ┗
  "0011", "0012", "0021", "0022", "1100", "1200", "2100", "2200",
  // ┘ ┙ ┚ ┛ ├ ┝ ┞ ┟
  "1001", "1002", "2001", "2002", "1110", "1210", "2110", "1120",
  // ┠ ┡ ┢ ┣ ┤ ┥ ┦ ┧
  "2120", "2210", "1220", "2220", "1011", "1012", "2011", "1021",
  // ┨ ┩ ┪ ┫ ┬ ┭ ┮ ┯
  "2021", "2012", "1022", "2022", "0111", "0112", "0211", "0212",
  // ┰ ┱ ┲ ┳ ┴ ┵ ┶ ┷
  "0121", "0122", "0221", "0222", "1101", "1102", "1201", "1202",
  // ┸ ┹ ┺ ┻ ┼ ┽ ┾ ┿
  "2101", "2102", "2201", "2202", "1111", "1112", "1211", "1212",
  // ╀ ╁ ╂ ╃ ╄ ╅ ╆ ╇
  "2111", "1121", "2121", "2112", "2211", "1122", "1221", "2212",
  // ╈ ╉ ╊ ╋ ╌ ╍ ╎ ╏
  "1222", "2122", "2221", "2222", "", "", "", "",
  // ═ ║ ╒ ╓ ╔ ╕ ╖ ╗
  "0303", "3030", "0310", "0130", "0330", "0013", "0031", "0033",
  // ╘ ╙ ╚ ╛ ╜ ╝ ╞ ╟
  "1300", "3100", "3300", "1003", "3001", "3003", "1310", "3130",
  // ╠ ╡ ╢ ╣ ╤ ╥ ╦ ╧
  "3330", "1013", "3031", "3033", "0313", "0131", "0333", "1303",
  // ╨ ╩ ╪ ╫ ╬ ╭ ╮ ╯
  "3101", "3303", "1313", "3131", "3333", "", "", "",
  // ╰ ╱ ╲ ╳ ╴ ╵ ╶ ╷
  "", "", "", "", "0001", "1000", "0100", "0010",
  // ╸ ╹ ╺ ╻ ╼ ╽ ╾ ╿
  "0002", "2000", "0200", "0020", "0201", "1020", "0102", "2010",
];

/**
 * The dashed forms, as how many dashes cross the cell and which way they run.
 * Unicode spells the count into the name — "triple dash", "quadruple dash" —
 * and the count is the entire difference between them.
 */
const DASHES: Readonly<Record<number, { count: number; weight: number; vertical: boolean }>> = {
  0x2504: { count: 3, weight: 1, vertical: false },
  0x2505: { count: 3, weight: 2, vertical: false },
  0x2506: { count: 3, weight: 1, vertical: true },
  0x2507: { count: 3, weight: 2, vertical: true },
  0x2508: { count: 4, weight: 1, vertical: false },
  0x2509: { count: 4, weight: 2, vertical: false },
  0x250a: { count: 4, weight: 1, vertical: true },
  0x250b: { count: 4, weight: 2, vertical: true },
  0x254c: { count: 2, weight: 1, vertical: false },
  0x254d: { count: 2, weight: 2, vertical: false },
  0x254e: { count: 2, weight: 1, vertical: true },
  0x254f: { count: 2, weight: 2, vertical: true },
};

/**
 * The shapes that draw `cp` in a `w` × `h` cell, or null if it is not ours.
 *
 * `unit` is one device pixel in the units everything else is in, so that an edge
 * lands on a pixel boundary rather than being smeared across two. That matters
 * more here than anywhere else in the window: a 1px rule drawn across a device
 * pixel boundary is a 2px grey one, and a grey rule looks exactly like the seam
 * this module exists to remove.
 */
export function boxShapes(cp: number, w: number, h: number, unit: number): BoxShape[] | null {
  if (!(w > 0) || !(h > 0) || !(unit > 0)) return null;
  const snap = (v: number) => Math.round(v / unit) * unit;

  if (cp >= 0x2580 && cp <= LAST_BOX) return blocks(cp, w, h, snap);
  if (cp < FIRST_BOX || cp > 0x257f) return null;

  // A light line is a tenth of the cell, which lands on the 1px the font's own
  // `─` draws at 12px and then scales with the grid rather than with nothing.
  // Heavy is twice that, forced at least one device pixel clear of light so the
  // two never come out the same width in a small cell.
  const light = Math.max(unit, snap(h / 10));
  const heavy = Math.max(light + unit, snap(h / 5));
  // A double line is two light rails one light width apart, so the pair is three
  // times a light line and still legible in a cell eleven pixels tall. `rail` is
  // how far each sits from the centre.
  const rail = light;
  const thick = (weight: number) => (weight === 2 ? heavy : light);

  const dash = DASHES[cp];
  if (dash) return dashed(dash, w, h, thick(dash.weight), snap);

  switch (cp) {
    case 0x256d: return [arc(w, h, light, snap, 1, 1)]; // ╭ down and right
    case 0x256e: return [arc(w, h, light, snap, 1, -1)]; // ╮ down and left
    case 0x256f: return [arc(w, h, light, snap, -1, -1)]; // ╯ up and left
    case 0x2570: return [arc(w, h, light, snap, -1, 1)]; // ╰ up and right
    case 0x2571: return [{ kind: "line", x1: 0, y1: h, x2: w, y2: 0, width: light }];
    case 0x2572: return [{ kind: "line", x1: 0, y1: 0, x2: w, y2: h, width: light }];
    case 0x2573:
      return [
        { kind: "line", x1: 0, y1: h, x2: w, y2: 0, width: light },
        { kind: "line", x1: 0, y1: 0, x2: w, y2: h, width: light },
      ];
  }

  const arms = ARMS[cp - FIRST_BOX];
  if (!arms) return null;
  const u = Number(arms[0]);
  const r = Number(arms[1]);
  const d = Number(arms[2]);
  const l = Number(arms[3]);

  const out: BoxShape[] = [];
  const xc = w / 2;
  const yc = h / 2;
  const hDouble = l === 3 || r === 3;
  const vDouble = u === 3 || d === 3;

  /**
   * How far past the centre an arm runs, positive being *through* it.
   *
   * Three cases, and the middle one is the whole reason corners have no notch in
   * them: an arm that stopped dead at the centre would leave the quarter square
   * between it and its perpendicular unfilled, so it crosses by half the
   * perpendicular's width and the two overlap there instead. Against a double
   * perpendicular it stops short, at the near rail's outer edge — a stem running
   * into the channel between the rails would fill the junction the double form
   * exists to leave open — unless the same axis continues out the other side, in
   * which case it is a line passing through and does.
   */
  const reach = (perpDouble: boolean, perpAny: boolean, perpThick: number, through: boolean) => {
    if (!perpAny) return 0;
    if (!perpDouble) return perpThick / 2;
    return through ? 0 : -(rail + light / 2);
  };

  /**
   * The same question for one rail of a double arm, asked per rail: the wall a
   * branch comes through is broken and the far one stays continuous, which is
   * what makes `╠` two rails and a gap rather than a solid tee. Only another
   * double ever cuts that break — a single line crossing a double one covers its
   * own junction, so nothing has to move aside for it.
   */
  const railReach = (perpDouble: boolean, perpAny: boolean, branchHere: boolean) => {
    if (!perpAny || !perpDouble) return 0;
    return branchHere ? -(rail - light / 2) : rail + light / 2;
  };

  const bar = (dir: number, stop: number, cross: number, t: number, vertical: boolean) => {
    const a = dir < 0 ? 0 : snap(stop);
    const b = dir < 0 ? snap(stop) : vertical ? h : w;
    if (b <= a) return;
    const near = snap(cross - t / 2);
    out.push(
      vertical
        ? { kind: "rect", x: near, y: a, w: t, h: b - a }
        : { kind: "rect", x: a, y: near, w: b - a, h: t },
    );
  };

  for (const vertical of [false, true]) {
    // The arm toward the origin and the one away from it: up and down, or left
    // and right.
    const back = vertical ? u : l;
    const forth = vertical ? d : r;
    if (!back && !forth) continue;
    const centre = vertical ? yc : xc;
    const cross = vertical ? xc : yc;
    const isDouble = vertical ? vDouble : hDouble;
    const perpDouble = vertical ? hDouble : vDouble;
    const perpBack = vertical ? l : u;
    const perpForth = vertical ? r : d;
    const perpAny = Boolean(perpBack || perpForth);
    const perpThick = Math.max(perpBack ? thick(perpBack) : 0, perpForth ? thick(perpForth) : 0);

    for (const dir of [-1, 1]) {
      const weight = dir < 0 ? back : forth;
      if (!weight) continue;
      if (isDouble) {
        for (const side of [-1, 1]) {
          // Which perpendicular arm this rail runs alongside: for a horizontal
          // pair the upper rail answers to `up`, for a vertical pair the left
          // rail answers to `left`.
          const branch = side < 0 ? perpBack : perpForth;
          const over = railReach(perpDouble, perpAny, Boolean(branch));
          bar(dir, centre - dir * over, cross + side * rail, light, vertical);
        }
      } else {
        const over = reach(perpDouble, perpAny, perpThick, Boolean(back && forth));
        bar(dir, centre - dir * over, cross, thick(weight), vertical);
      }
    }
  }
  return out;
}

/**
 * An arc, as the curve between its two arm ends with the cell centre pulling it
 * round. A quadratic through the corner rather than a true quarter circle,
 * because the control point *is* the corner the two straight arms would have met
 * at — which is what makes `╭` sit flush against the `─` beside it.
 *
 * `down` and `right` are ±1 and say which two arms the arc joins: (1, 1) is
 * down-and-right, (-1, -1) up-and-left.
 */
function arc(
  w: number,
  h: number,
  width: number,
  snap: (v: number) => number,
  down: number,
  right: number,
): BoxShape {
  const xc = snap(w / 2 - width / 2) + width / 2;
  const yc = snap(h / 2 - width / 2) + width / 2;
  return {
    kind: "curve",
    x1: xc,
    y1: down < 0 ? 0 : h,
    cx: xc,
    cy: yc,
    x2: right < 0 ? 0 : w,
    y2: yc,
    width,
  };
}

function dashed(
  spec: { count: number; vertical: boolean },
  w: number,
  h: number,
  t: number,
  snap: (v: number) => number,
): BoxShape[] {
  const span = spec.vertical ? h : w;
  const cross = (spec.vertical ? w : h) / 2;
  const near = snap(cross - t / 2);
  const step = span / spec.count;
  const gap = step / 3;
  const out: BoxShape[] = [];
  for (let i = 0; i < spec.count; i++) {
    const a = snap(i * step + gap / 2);
    const b = snap((i + 1) * step - gap / 2);
    if (b <= a) continue;
    out.push(
      spec.vertical
        ? { kind: "rect", x: near, y: a, w: t, h: b - a }
        : { kind: "rect", x: a, y: near, w: b - a, h: t },
    );
  }
  return out;
}

/**
 * The block elements, as fractions of the cell.
 *
 * Every edge is snapped in its own right rather than a snapped size being added
 * to an origin, so `▀` and `▄` in one column meet on a single pixel row instead
 * of overlapping or leaving a line of background between them. The shades are
 * the exception and are not geometry at all: they are the cell at a quarter, a
 * half and three quarters, which is what a shade means at eleven pixels — a real
 * dither pattern this small is a grey rectangle with moiré in it.
 */
function blocks(cp: number, w: number, h: number, snap: (v: number) => number): BoxShape[] {
  const part = (x0: number, y0: number, x1: number, y1: number, alpha?: number): BoxShape => {
    const ax = snap(x0 * w);
    const ay = snap(y0 * h);
    return { kind: "rect", x: ax, y: ay, w: snap(x1 * w) - ax, h: snap(y1 * h) - ay, alpha };
  };
  const quads = (ul: boolean, ur: boolean, ll: boolean, lr: boolean): BoxShape[] => {
    const out: BoxShape[] = [];
    if (ul) out.push(part(0, 0, 0.5, 0.5));
    if (ur) out.push(part(0.5, 0, 1, 0.5));
    if (ll) out.push(part(0, 0.5, 0.5, 1));
    if (lr) out.push(part(0.5, 0.5, 1, 1));
    return out;
  };

  switch (cp) {
    case 0x2580: return [part(0, 0, 1, 1 / 2)];
    case 0x2581: return [part(0, 7 / 8, 1, 1)];
    case 0x2582: return [part(0, 6 / 8, 1, 1)];
    case 0x2583: return [part(0, 5 / 8, 1, 1)];
    case 0x2584: return [part(0, 4 / 8, 1, 1)];
    case 0x2585: return [part(0, 3 / 8, 1, 1)];
    case 0x2586: return [part(0, 2 / 8, 1, 1)];
    case 0x2587: return [part(0, 1 / 8, 1, 1)];
    case 0x2588: return [part(0, 0, 1, 1)];
    case 0x2589: return [part(0, 0, 7 / 8, 1)];
    case 0x258a: return [part(0, 0, 6 / 8, 1)];
    case 0x258b: return [part(0, 0, 5 / 8, 1)];
    case 0x258c: return [part(0, 0, 4 / 8, 1)];
    case 0x258d: return [part(0, 0, 3 / 8, 1)];
    case 0x258e: return [part(0, 0, 2 / 8, 1)];
    case 0x258f: return [part(0, 0, 1 / 8, 1)];
    case 0x2590: return [part(1 / 2, 0, 1, 1)];
    case 0x2591: return [part(0, 0, 1, 1, 0.25)];
    case 0x2592: return [part(0, 0, 1, 1, 0.5)];
    case 0x2593: return [part(0, 0, 1, 1, 0.75)];
    case 0x2594: return [part(0, 0, 1, 1 / 8)];
    case 0x2595: return [part(7 / 8, 0, 1, 1)];
    case 0x2596: return quads(false, false, true, false);
    case 0x2597: return quads(false, false, false, true);
    case 0x2598: return quads(true, false, false, false);
    case 0x2599: return quads(true, false, true, true);
    case 0x259a: return quads(true, false, false, true);
    case 0x259b: return quads(true, true, true, false);
    case 0x259c: return quads(true, true, false, true);
    case 0x259d: return quads(false, true, false, false);
    case 0x259e: return quads(false, true, true, false);
    case 0x259f: return quads(false, true, true, true);
  }
  return [];
}

/**
 * Point a renderer's canvas at the geometry above.
 *
 * The hook is the context's own `fillText`, wrapped, rather than a replacement
 * for the renderer's cell-drawing method — and that is a deliberately smaller
 * bet on somebody else's internals. `renderCellText` decides the foreground
 * colour, the selection colour, the faint alpha, the bold and italic face, the
 * underline and the link underline; reimplementing it to change one call would
 * mean keeping all of that in step forever. Wrapping the one call leaves every
 * one of those decisions where it is, and the assumption it does rest on is
 * narrow enough to check: that a cell's glyph is a single `fillText` at the
 * cell's left edge and its baseline, which is the only `fillText` in the
 * library. The symptom if a future version breaks it is box characters going
 * back to being drawn by the font, which is to say the gaps come back.
 */
const patched = new WeakSet<CanvasRenderingContext2D>();

/**
 * Shapes are the same for every cell of a given character, so they are worked
 * out once per character per grid rather than per cell. A screen of `─` is two
 * hundred identical calls a frame and the arithmetic is not free.
 */
let cacheW = 0;
let cacheH = 0;
let cacheUnit = 0;
let cache: (BoxShape[] | null | undefined)[] = [];

function shapesFor(cp: number, w: number, h: number, unit: number): BoxShape[] | null {
  if (w !== cacheW || h !== cacheH || unit !== cacheUnit) {
    cacheW = w;
    cacheH = h;
    cacheUnit = unit;
    cache = new Array(LAST_BOX - FIRST_BOX + 1);
  }
  const i = cp - FIRST_BOX;
  const hit = cache[i];
  if (hit !== undefined) return hit;
  const made = boxShapes(cp, w, h, unit);
  cache[i] = made;
  return made;
}

function paint(ctx: CanvasRenderingContext2D, shapes: readonly BoxShape[], ox: number, oy: number): void {
  for (const s of shapes) {
    if (s.kind === "rect") {
      if (s.alpha === undefined) {
        ctx.fillRect(ox + s.x, oy + s.y, s.w, s.h);
        continue;
      }
      // Multiplied into whatever is already there rather than assigned, so a
      // shade inside faint text stays faint.
      const was = ctx.globalAlpha;
      ctx.globalAlpha = was * s.alpha;
      ctx.fillRect(ox + s.x, oy + s.y, s.w, s.h);
      ctx.globalAlpha = was;
      continue;
    }
    // The renderer sets `strokeStyle` and `lineWidth` immediately before each of
    // its own strokes, so changing them here costs nothing and restores nothing.
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineWidth = s.width;
    ctx.beginPath();
    ctx.moveTo(ox + s.x1, oy + s.y1);
    if (s.kind === "line") ctx.lineTo(ox + s.x2, oy + s.y2);
    else ctx.quadraticCurveTo(ox + s.cx, oy + s.cy, ox + s.x2, oy + s.y2);
    ctx.stroke();
  }
}

/** Draw this renderer's box and block characters here instead of from the font. */
export function installBoxDrawing(renderer: { getCanvas(): HTMLCanvasElement; getMetrics(): { width: number; height: number; baseline: number } }): void {
  const ctx = renderer.getCanvas().getContext("2d");
  if (!ctx || patched.has(ctx)) return;
  patched.add(ctx);
  const original = ctx.fillText.bind(ctx);
  ctx.fillText = (text: string, x: number, y: number, maxWidth?: number): void => {
    if (text.length === 1) {
      const cp = text.charCodeAt(0);
      if (cp >= FIRST_BOX && cp <= LAST_BOX) {
        const m = renderer.getMetrics();
        // The renderer scales its context by the device pixel ratio and takes it
        // from `window` unless it was handed one, which kururu does not do.
        const shapes = shapesFor(cp, m.width, m.height, 1 / (window.devicePixelRatio || 1));
        if (shapes) {
          paint(ctx, shapes, x, y - m.baseline);
          return;
        }
      }
    }
    original(text, x, y, maxWidth);
  };
}
