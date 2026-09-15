/**
 * Whether a pane has actually been measured, which is not the same question as
 * whether its emulator answered.
 *
 * `Terminal.tsx` may not subscribe, fit, or tell the server a size until the
 * grid it is about to name is the pane's own. The reason is in CLAUDE.md at
 * length: a backlog is a screen serialized at a width, so a grid named before
 * the box is real produces a screen the agent believes it has already drawn
 * correctly and will never repaint — and worse, the size travels on to the pty,
 * where it is a SIGWINCH that makes an agent redraw itself into it.
 *
 * Under xterm the test was simply whether `proposeDimensions()` returned
 * anything: a box it could not measure produced `undefined`, and there was
 * nothing further to decide. Ghostty's addon does the same arithmetic and then
 * ends it with `Math.max(2, …)` and `Math.max(1, …)`, so an unlaid-out pane does
 * not decline to answer — **it answers `2x1`**, which is finite, positive, and
 * completely wrong. A pane mid-drag is exactly such a box, and the cost of
 * believing it is a real terminal resized to two columns with an agent in it.
 *
 * So the clamp floor has to be read back as what it actually means, which is "I
 * could not work this out". The floor here sits just above it: no pane a person
 * can make is four columns wide, and nothing legitimate is being refused.
 */
export interface Grid {
  cols: number;
  rows: number;
}

/**
 * Comfortably above the addon's own `Math.max(2, …)` / `Math.max(1, …)` floor,
 * and far below the narrowest pane a window 420px wide can be split into.
 */
export const MIN_COLS = 4;
export const MIN_ROWS = 2;

/** The proposal if it can be believed, or null — which means "ask again later". */
export function usableGrid(proposed: Partial<Grid> | undefined | null): Grid | null {
  if (!proposed) return null;
  const { cols, rows } = proposed;
  if (typeof cols !== "number" || typeof rows !== "number") return null;
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null;
  if (cols < MIN_COLS || rows < MIN_ROWS) return null;
  return { cols, rows };
}
