/**
 * How big a terminal is, when more than one pane has an opinion.
 *
 * A pty has exactly one size and kururu can have several clients — two windows,
 * or a desktop and a phone — each drawing the same agent into a box of its own.
 * Something has to choose, and for most of kururu's life nothing did: a pane
 * fitted its emulator to its box and told the pty what it had become, so the
 * answer was whichever client resized last. That is fine with one window, which
 * is why it survived, and it is why a phone made the desktop ragged the moment
 * one existed. It also let a client and the pty hold two ideas of where a row
 * ends at once, which is the disagreement underneath every screen kururu has
 * drawn wrong.
 *
 * tmux settled this in the 1990s and its `window-size` names the four answers:
 * `largest`, `smallest`, `manual`, `latest`. This is `smallest`, over the
 * clients that can actually see the terminal. Not `latest`, because a phone and
 * a desktop watching one agent should both see a correct screen rather than
 * take turns making each other wrong; not `largest`, because the smaller of
 * them would then be clipping what it cannot draw.
 *
 * It is a module of its own, and a pure one, because the policy is the decision
 * — everything around it in `index.ts` is bookkeeping about whose proposals are
 * still in play. A minimum is also the kind of thing that reads as obviously
 * right and has an edge at each end: nobody proposing at all, and two clients
 * whose boxes are smaller in different dimensions.
 */

/** A terminal's shape, in cells. */
export interface Grid {
  cols: number;
  rows: number;
}

/**
 * The largest grid every proposal can draw, or null when there are none.
 *
 * Each dimension is taken on its own rather than picking whichever client is
 * smaller overall: a short wide pane and a tall narrow one want the
 * intersection of the two, which is the only shape both of them can show
 * without clipping.
 *
 * Null means *keep what it had*, and it is the answer whenever the last pane
 * showing a terminal goes away. A terminal nobody can see is not resized to
 * nothing, and it is not resized by a client that is merely keeping a pooled
 * emulator current off screen — that client is showing nobody anything, so it
 * has no box to speak for.
 */
export function smallestGrid(proposals: Iterable<Grid>): Grid | null {
  let cols = Infinity;
  let rows = Infinity;
  for (const proposed of proposals) {
    if (proposed.cols < cols) cols = proposed.cols;
    if (proposed.rows < rows) rows = proposed.rows;
  }
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null;
  return { cols, rows };
}
