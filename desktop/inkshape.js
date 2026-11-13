/**
 * The screen pen's numbers and geometry, for `ink.js`, without Electron.
 *
 * The main process is plain JavaScript run as it is, so it cannot import
 * `shared/ink.ts`, where these are defined for the server; they are copied
 * here and `desktop/test/inkshape.test.js` holds the two to each other —
 * a burst ended by one rule here and another there would split a mark in
 * two, or a crop would be cut where the server says it was not.
 */

/** Strokes on one display closer than this, pen-up to pen-down, are one mark. */
const BURST_GAP_MS = 1200;
/** The long edge a whole display is shrunk to. */
const FRAME_LONG_EDGE = 1568;
/** A crop's margin round the ink: a quarter of it, at least this many points. */
const CROP_MARGIN_MIN = 120;
/** The most marks one set takes (`MARKS_MAX` in `shared/marks.ts`). */
const MARKS_MAX = 20;

/** The bounds of some strokes, in their points. */
function strokesBox(strokes) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const stroke of strokes) {
    for (const [x, y] of stroke) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** The part of a display a crop keeps: the ink, a margin round it, held inside the display. */
function cropRect(box, display) {
  const mx = Math.max(CROP_MARGIN_MIN, box.width / 4);
  const my = Math.max(CROP_MARGIN_MIN, box.height / 4);
  const x = Math.max(0, Math.floor(box.x - mx));
  const y = Math.max(0, Math.floor(box.y - my));
  const right = Math.min(display.width, Math.ceil(box.x + box.width + mx));
  const bottom = Math.min(display.height, Math.ceil(box.y + box.height + my));
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

/** A point off the wire: two finite numbers, or nothing. */
function pointOf(value) {
  if (!Array.isArray(value)) return null;
  const x = Number(value[0]);
  const y = Number(value[1]);
  return Number.isFinite(x) && Number.isFinite(y) ? /** @type {[number, number]} */ ([x, y]) : null;
}

/** How far round the box's pencil a pen-down still counts as a press on it, in points: a hand's slop on a 28-point button. */
const PENCIL_SLOP = 4;

/** A pencil's place off the wire, in its page's CSS pixels: four finite numbers and a size, or nothing. */
function rectOf(value) {
  if (!value || typeof value !== "object") return null;
  const x = Number(value.x);
  const y = Number(value.y);
  const width = Number(value.width);
  const height = Number(value.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0 || width > 1000 || height > 1000) return null;
  return { x, y, width, height };
}

/**
 * Whether a pen-down at `global` (the whole desktop's points) is on a Kuru
 * box's pencil. `windows` are the pages that have one up, each as its
 * window's content bounds, its zoom and the pencil in the page's own pixels,
 * in order from the front: the first window that holds the point decides,
 * so a press on the floating chat where it sits over the window is the
 * chat's, and a stroke anywhere else on it is a stroke.
 */
function pencilHit(global, windows) {
  for (const { bounds, zoom, pencil } of windows) {
    if (global.x < bounds.x || global.y < bounds.y || global.x >= bounds.x + bounds.width || global.y >= bounds.y + bounds.height) continue;
    const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
    const left = bounds.x + pencil.x * z - PENCIL_SLOP;
    const top = bounds.y + pencil.y * z - PENCIL_SLOP;
    const right = bounds.x + (pencil.x + pencil.width) * z + PENCIL_SLOP;
    const bottom = bounds.y + (pencil.y + pencil.height) * z + PENCIL_SLOP;
    return global.x >= left && global.x < right && global.y >= top && global.y < bottom;
  }
  return false;
}

/** A window's number as the window server knows it, out of `getMediaSourceId()`'s `window:<id>:<n>`; null for anything else. */
function windowNumberOf(sourceId) {
  const match = /^window:(\d+):/.exec(String(sourceId));
  return match ? Number(match[1]) : null;
}

module.exports = { BURST_GAP_MS, FRAME_LONG_EDGE, CROP_MARGIN_MIN, MARKS_MAX, PENCIL_SLOP, strokesBox, cropRect, pointOf, rectOf, pencilHit, windowNumberOf };
