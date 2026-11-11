/**
 * Where a new tab goes when nobody said which pane: one rule, in two halves.
 *
 * Anything that runs in a terminal — an agent, a shell, a dev server, nvim,
 * a machine's shell, Kuru itself — opens in the lower half. Everything else
 * — the board, a document in the reader — opens in the upper half. The
 * owner asked for it in those words on 2026-11-11, and it replaced three
 * rules that each answered "where is nobody reading" on its own terms: the
 * agents' pane along an edge chosen in Settings (bottom, top, or off), the
 * old `paneBesideBoard` (the pane focus came from, else any other beside the
 * board, else a split off it) for shells, open_shell and the worktree's
 * terminal, and "the focused pane, whatever it shows" for a file from the
 * tree, a link out of Kuru's drawer and the board's key. Each was fair, and
 * together a document landed in front of the agent being watched and an
 * agent in front of the document being read.
 *
 * A gesture made *on* a pane is not asked here: its + menu, its new-tab
 * button, Enter in it while it is empty, its menu's Board, a tab dropped on
 * it, a split. The person picked the pane, and it goes there.
 *
 * Which panes are a half is geometry rather than the tree, since one
 * picture has many trees and the person sees the picture. A pane is in the
 * lower half when it touches the bottom edge *and* has something above it,
 * and in the upper half when it touches the top edge and has something
 * below it; a pane that runs the full height is in neither, so a workspace
 * of two panes side by side has no halves yet, and the whole of it becomes
 * the upper half when one is made (`wrapLayout`), the lower half getting
 * the full width. A layout rearranged by hand is read the same way: the
 * top row is the upper half, the bottom row the lower, whatever is in them.
 *
 * Among the panes of a half, in order:
 *
 * 1. the one the caller prefers — the focused pane, for a gesture somebody
 *    made with the keyboard or a click — when it is in that half;
 * 2. in the lower half, the pane marked `forAgents`, where the last
 *    terminal went, so terminals keep joining one pane however the rest is
 *    split around it;
 * 3. one already showing that half's kind of thing — a terminal or nothing
 *    in the lower; in the upper a document first, then nothing or the
 *    board, a terminal last — so a document joins the reader rather than
 *    covering the board beside it;
 * 4. the widest, since a strip along an edge is what a half means and a
 *    corner is not; then the tallest; then reading order.
 *
 * What a pane is showing never rules it out. The old rule passed over a
 * pane showing the board or a document, because a new tab is shown; now
 * the board and the documents have a half of their own, and a pane in the
 * wrong half is one somebody put there, whose covered tab is a click away.
 *
 * A workspace of one pane has no halves by geometry, and counts as the half
 * of what it is showing: a lone shell is the lower half, so the next agent
 * joins it as a tab rather than pushing it to the top, and a lone document
 * or board is the upper. Empty, it is either, and the first thing opened
 * fills it: an empty half beside it would be a pane waiting for nothing.
 *
 * Pure, on `layout.ts`'s terms: the server asks it, the test pins it.
 */
import { activeAgent, activeTerminal, panes, rects, showsDoc, terminalsOf, type LayoutNode, type PaneState, type Rect } from "./layout";

export type Half = "upper" | "lower";

/** The half a tab belongs in: a terminal's is the lower, anything else's — the board, a document — the upper. */
export function halfOf(tab: string): Half {
  return terminalsOf([tab]).length > 0 ? "lower" : "upper";
}

/** A pane of that half to put the tab in, or the side to make the half on because there is none. */
export type HalfChoice = { pane: string } | { wrap: "below" | "above" };

/** Ratios are products of floats; an edge is an edge to within this. */
const EPS = 1e-6;

/** Whether a pane is in that half: along its edge, with something on the other side of it. */
export function inHalf(rect: Rect, half: Half): boolean {
  return half === "lower" ? rect.y > EPS && rect.y + rect.h > 1 - EPS : rect.y < EPS && rect.y + rect.h < 1 - EPS;
}

/** Whether a pane is showing the kind of thing that half holds, or nothing yet. */
export function showsKind(pane: PaneState, half: Half): boolean {
  return kindRank(pane, half) < 2;
}

/**
 * How well what a pane is showing fits a half, lower is better: in the
 * lower a terminal or nothing (0), anything else (2); in the upper a
 * document (0), nothing or the board (1), a terminal (2).
 */
function kindRank(pane: PaneState, half: Half): number {
  const empty = activeAgent(pane) === null && !pane.reader;
  const terminal = activeTerminal(pane) !== null;
  if (half === "lower") return empty || terminal ? 0 : 2;
  if (showsDoc(pane)) return 0;
  return terminal ? 2 : 1;
}

/** The pane of that half a new tab goes to, by the rule above, or the word to make the half. */
export function paneInHalf(layout: LayoutNode, half: Half, prefer?: string | null): HalfChoice {
  const all = panes(layout);
  const only = all.length === 1 ? all[0] : undefined;
  if (only) return showsKind(only, half) ? { pane: only.id } : { wrap: half === "lower" ? "below" : "above" };
  const at = rects(layout);
  const candidates = all.flatMap((pane) => {
    const rect = at.get(pane.id);
    return rect && inHalf(rect, half) ? [{ pane, rect }] : [];
  });
  const preferred = prefer ? candidates.find(({ pane }) => pane.id === prefer) : undefined;
  if (preferred) return { pane: preferred.pane.id };
  const marked = half === "lower" ? candidates.find(({ pane }) => pane.forAgents) : undefined;
  if (marked) return { pane: marked.pane.id };
  let best: { pane: PaneState; rect: Rect; rank: number } | undefined;
  for (const one of candidates.map((c) => ({ ...c, rank: kindRank(c.pane, half) }))) {
    const wider = one.rect.w > (best?.rect.w ?? 0) + EPS;
    const asWide = best !== undefined && Math.abs(one.rect.w - best.rect.w) <= EPS;
    if (!best || one.rank < best.rank || (one.rank === best.rank && (wider || (asWide && one.rect.h > best.rect.h + EPS)))) best = one;
  }
  return best ? { pane: best.pane.id } : { wrap: half === "lower" ? "below" : "above" };
}
