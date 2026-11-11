/**
 * Whether a pointer crossing a menu is on its way to the list a row opened.
 *
 * It exists because a list beside a menu is reached on a diagonal, and a
 * diagonal crosses the rows under the one that opened it. Taking each of those
 * rows at its word, as a menu does when nothing is open beside it, closed the
 * list the pointer was travelling to (the owner, 2026-11-11, on a profile
 * card: "Send to" took the menu over on the way down to Edit). A delay alone
 * would also do it, but only by making every change of mind wait; this is the
 * usual triangle, from where the pointer was a moment ago to the near edge of
 * the list, and a pointer inside it is aiming. Anything else is somebody who
 * has moved on, and is answered at once.
 *
 * Pure, with the menu's timings beside it, so `web/test/menuaim.test.ts` can
 * hold both still.
 */

/**
 * How long the pointer rests on a row before its list opens. A pass on the
 * way to another row takes well under this; a click, Enter or → opens it at
 * once, so nobody who means it waits.
 */
export const OPEN_MS = 250;

/**
 * How long a pointer aiming at an open list may stop on a row it was crossing
 * before that row is taken to be where it meant to go.
 */
export const AIM_MS = 250;

/**
 * How far the pointer may drift while it is resting on a row, in CSS pixels.
 * A trackpad never holds perfectly still, and a hand that has stopped should
 * not have to.
 */
export const REST_PX = 5;

/**
 * How much taller than the list the triangle's far edge is taken to be, above
 * and below: a short list beside a long menu is otherwise a target a hand
 * misses by a row.
 */
const SLACK_PX = 12;

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Twice the signed area of a, b, c: which side of a→b the point c is on. */
function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/**
 * Whether the pointer, having moved from `from` to `to`, is heading into
 * `list`, which is drawn to the right of the menu when `toRight` and to its
 * left otherwise. A pointer that has not moved is not aiming at anything:
 * a hand at rest has arrived.
 */
export function aiming(from: Point, to: Point, list: Rect, toRight: boolean): boolean {
  if (from.x === to.x && from.y === to.y) return false;
  const edge = toRight ? list.left : list.right;
  // Already past the near edge, or going the other way, is not on the way there.
  if (toRight ? to.x >= edge || to.x < from.x : to.x <= edge || to.x > from.x) return false;
  const top = { x: edge, y: list.top - SLACK_PX };
  const bottom = { x: edge, y: list.bottom + SLACK_PX };
  const d1 = cross(from, top, to);
  const d2 = cross(top, bottom, to);
  const d3 = cross(bottom, from, to);
  const negative = d1 < 0 || d2 < 0 || d3 < 0;
  const positive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(negative && positive);
}
