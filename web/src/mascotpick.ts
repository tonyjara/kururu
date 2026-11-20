/**
 * The arithmetic of the workspace's mascot picker, kept out of the component so
 * it can be tested without a DOM.
 *
 * The picker was a column of rows, which was right for four mascots and wrong
 * for thirty: it ran off the bottom of the window, and a wheel over it closed
 * it. It is now a grid of badges with a box to type a name into, and the two
 * questions that brings — which of them a few letters mean, and where an arrow
 * key goes in a grid whose last row is short and whose first entry is a row of
 * its own — are answered here.
 */

export interface Named {
  name: string;
  /** A second name it also answers to: the default's own, for "Default". */
  also?: string;
}

/**
 * The options a query keeps, best first: a name that starts with it, then one
 * with a word that does, then one that holds it anywhere — each group in the
 * order it was given, since that order is the owner's own (Settings → Mascot).
 * Case and accents are ignored, because nobody types "Ñandú" to find it.
 */
export function matchOptions<T extends Named>(options: readonly T[], query: string): T[] {
  const q = fold(query.trim());
  if (!q) return [...options];
  const rank = (option: T): number => {
    let best = 3;
    for (const name of [option.name, option.also]) {
      if (!name) continue;
      const n = fold(name);
      if (n.startsWith(q)) best = Math.min(best, 0);
      else if (n.split(/[^a-z0-9]+/).some((word) => word.startsWith(q))) best = Math.min(best, 1);
      else if (n.includes(q)) best = Math.min(best, 2);
    }
    return best;
  };
  return options
    .map((option, index) => ({ option, index, rank: rank(option) }))
    .filter((one) => one.rank < 3)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((one) => one.option);
}

function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * Where an arrow key takes the cursor among `count` entries, the first `lead`
 * of which are rows of their own above a grid `columns` wide.
 *
 * Never wraps: a cursor that leaves the right end of one row and appears at
 * the left of the next has moved somewhere the eye was not following. Down
 * from a column the short last row does not reach lands on the last entry
 * rather than nowhere, the way a file grid in Finder does; up from the grid's
 * first row goes to the row above it. -1 for an empty list.
 */
export function stepGrid(index: number, key: string, count: number, columns: number, lead = 0): number {
  if (count <= 0) return -1;
  const last = count - 1;
  const at = Math.max(0, Math.min(index, last));
  const cols = Math.max(1, Math.floor(columns));
  if (key === "Home") return 0;
  if (key === "End") return last;

  if (at < lead) {
    if (key === "ArrowDown" || key === "ArrowRight") return Math.min(at + 1, last);
    if (key === "ArrowUp" || key === "ArrowLeft") return Math.max(at - 1, 0);
    return at;
  }

  const cell = at - lead;
  switch (key) {
    case "ArrowRight":
      return Math.min(at + 1, last);
    case "ArrowLeft":
      return at === 0 ? 0 : at - 1;
    case "ArrowDown": {
      if (at + cols <= last) return at + cols;
      // Already on the last row: stay. Otherwise the short last row's end.
      return Math.floor(cell / cols) === Math.floor((last - lead) / cols) ? at : last;
    }
    case "ArrowUp":
      if (cell >= cols) return at - cols;
      return lead > 0 ? lead - 1 : at;
    default:
      return at;
  }
}
