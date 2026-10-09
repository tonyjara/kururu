/**
 * Where the voice pill has been dragged to, as a number that survives the
 * window changing shape under it.
 *
 * A position in pixels is the obvious thing to keep and the wrong one, for two
 * reasons that are really one. The window is resized — a desktop window made
 * narrower, a phone turned on its side — and so is the pill, from the one word
 * of "Hearing…" to three lines of what Kuru is saying, every time its phase
 * changes. A left edge kept in pixels is a pill that walks off the right of a
 * narrower window, or grows past the edge the moment it has more to say.
 *
 * So what is kept is a fraction of the *room the pill has to move in*: the
 * window less the pill, on each axis. Zero is flush with the left or the top,
 * one is flush with the right or the bottom, and everything between is inside
 * by construction, however big either of them is at the moment. That is also
 * exactly what CSS can draw without measuring anything — `left` as a share of
 * the window and a `translate` back by the same share of the pill — so the
 * stylesheet holds it in place through every resize and every new sentence
 * with no listener and no render. And it is right at the edges, which is where
 * a pill gets put out of the way: one left in a corner grows away from the
 * corner rather than past it.
 *
 * Pure, and its own module, so that `web/test` can hold it to that without
 * importing the microphone.
 */

/** Shares of the free room, 0–1 on each axis. */
export interface Place {
  x: number;
  y: number;
}

/**
 * The place of a pill whose top-left corner is at `left, top`, kept inside the
 * room. A pointer dragged past an edge holds the pill against it rather than
 * taking it out of the window.
 */
export function placeAt(
  left: number,
  top: number,
  width: number,
  height: number,
  roomWidth: number,
  roomHeight: number,
): Place {
  return { x: share(left, roomWidth - width), y: share(top, roomHeight - height) };
}

/**
 * How far along `free` pixels `at` is. A pill as wide as the window has no room
 * to move in on that axis, and the middle is the honest answer for it — and the
 * one that is still right when the window is widened again.
 */
function share(at: number, free: number): number {
  if (!(free > 0) || !Number.isFinite(at)) return 0.5;
  return Math.min(1, Math.max(0, at / free));
}

/**
 * A stored place, or none — which is the pill's own spot above the status bar.
 *
 * What comes back out of `localStorage` is a string anybody could have edited,
 * so anything that is not two finite numbers is no place. Numbers outside 0–1
 * are clamped rather than refused: they still say which edge it was left at,
 * and a pill restored half off the screen is one with less of itself to take
 * hold of.
 */
export function adoptPlace(raw: string | null): Place | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { x, y } = parsed as Record<string, unknown>;
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}
