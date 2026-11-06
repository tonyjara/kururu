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

/** A window's number as the window server knows it, out of `getMediaSourceId()`'s `window:<id>:<n>`; null for anything else. */
function windowNumberOf(sourceId) {
  const match = /^window:(\d+):/.exec(String(sourceId));
  return match ? Number(match[1]) : null;
}

module.exports = { BURST_GAP_MS, FRAME_LONG_EDGE, CROP_MARGIN_MIN, MARKS_MAX, strokesBox, cropRect, pointOf, windowNumberOf };
