/**
 * Bring a card on a board into sight, and move nothing else.
 *
 * `scrollIntoView` was the first answer and the wrong one twice over. It
 * scrolls every ancestor that can, so a card asked for from the sidebar could
 * shift the pane, the panes' row or the whole page under somebody's hands; and
 * with `nearest` a card at the foot of a long column arrives pressed against
 * the bottom edge, where the eye that went looking for it does not land. So the
 * scrollers between the card and the board are found and moved here, and only
 * those: the column's list, which centres the card, and the board sideways,
 * which brings the card's column into view — a column is a place the eye
 * already knows how to read, and centring one would leave the board between
 * two. Sideways it is the column that is measured, not the card, and on a
 * board that snaps it arrives at its start: the snap points are the columns'
 * starts, and a board scrolled only as far as a column's near edge — the
 * first version — was taken back to the column it came from by the snap,
 * which on a phone, where a column is most of the screen, is always nearer.
 *
 * A card that is already wholly in view does not move at all. The reveal runs
 * whenever the focused pane's agent changes, which is every click in the
 * sidebar, and a board that shuffled a card already in front of you on each of
 * them would be a board you could not read while you worked.
 *
 * The arithmetic is `revealTo`, pure, so that `web/test` can hold it to those
 * promises without a layout engine.
 */

/** Room left between a revealed card and the scroller's edge, so it does not arrive flush against it. */
const PAD = 8;

/**
 * How an item out of view is brought in: to the middle, only as far as the
 * near edge, or with its start at the scroller's — where a snap point is.
 */
export type Reveal = "centre" | "nearest" | "start";

/**
 * Where a scroller should go to show an item, on one axis, or null to stay.
 * Positions are in the scroller's content: `item` from the start of what it
 * scrolls, `scroll` and `view` what is on screen now, `content` how much
 * there is in all. An item bigger than the view is shown from its start,
 * which is where its title is.
 */
export function revealTo(
  scroll: number,
  view: number,
  content: number,
  item: { start: number; size: number },
  how: Reveal,
): number | null {
  const end = item.start + item.size;
  if (item.start >= scroll && end <= scroll + view) return null;
  let target: number;
  if (how === "start") target = item.start;
  else if (item.size > view - 2 * PAD) target = item.start - PAD;
  else if (how === "centre") target = item.start + item.size / 2 - view / 2;
  else target = item.start < scroll ? item.start - PAD : end - view + PAD;
  target = Math.round(Math.min(Math.max(target, 0), Math.max(content - view, 0)));
  return target === Math.round(scroll) ? null : target;
}

const scrolls = (overflow: string) => overflow === "auto" || overflow === "scroll";

/**
 * Show the card with this id, inside `scope` — a board, or the sheet the
 * profile's board is drawn on — scrolling only scrollers within it. Smooth,
 * unless the machine asks for less motion. False when no such card is drawn
 * there, as for one open in its editor.
 */
export function revealCard(scope: HTMLElement, cardId: string): boolean {
  const card = scope.querySelector<HTMLElement>(`[data-card="${CSS.escape(cardId)}"]`);
  if (!card) return false;
  const behavior: ScrollBehavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  const box = card.getBoundingClientRect();
  // Every target is read before any scroller moves: a smooth scroll in the
  // column would otherwise be half-way through when the board measured it.
  const moves: { node: HTMLElement; top?: number; left?: number }[] = [];
  // The scroller's child the card is in, as the walk climbs: at the board,
  // that is the column.
  let within: HTMLElement = card;
  for (let node = card.parentElement; node; within = node, node = node.parentElement) {
    const style = getComputedStyle(node);
    const frame = node.getBoundingClientRect();
    const move: (typeof moves)[number] = { node };
    if (scrolls(style.overflowY) && node.scrollHeight > node.clientHeight) {
      const start = box.top - frame.top - node.clientTop + node.scrollTop;
      const top = revealTo(node.scrollTop, node.clientHeight, node.scrollHeight, { start, size: box.height }, "centre");
      if (top !== null) move.top = top;
    }
    if (scrolls(style.overflowX) && node.scrollWidth > node.clientWidth) {
      const column = within.getBoundingClientRect();
      const start = column.left - frame.left - node.clientLeft + node.scrollLeft;
      const how = style.scrollSnapType === "none" ? "nearest" : "start";
      const left = revealTo(node.scrollLeft, node.clientWidth, node.scrollWidth, { start, size: column.width }, how);
      if (left !== null) move.left = left;
    }
    if (move.top !== undefined || move.left !== undefined) moves.push(move);
    if (node === scope) break;
  }
  for (const { node, top, left } of moves) node.scrollTo({ top, left, behavior });
  return true;
}
