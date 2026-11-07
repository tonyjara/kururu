/**
 * Where the agents kururu starts on its own go: one pane, along one edge.
 *
 * A card's robot and Kuru's `start_agent` used to put an agent beside the
 * board — in the pane focus came from, else in any other — and, in a
 * workspace with no board open, in the focused pane itself. Each of those
 * is a fair answer to "where is nobody reading", and together they
 * scattered: an agent went wherever was nearest, tabbed in with the nvim or
 * the shell somebody was using, and five cards later a workspace was one
 * big pane of everything. The person this was built for keeps the top half
 * for what they read — the board, a file, nvim — and the bottom half for
 * agents, so that is the default, and the agents kururu starts all go to
 * one pane on that edge, as tabs. An agent opened from a pane's + menu is
 * not one of these: it was put somewhere by hand, and goes there.
 *
 * Which pane is "the bottom pane" in a layout of several splits is the
 * decision made here, and it is made on geometry rather than on the tree,
 * since one picture has many trees and the person sees the picture. A pane
 * is on the bottom when it touches the bottom edge *and* has something
 * above it: a pane that runs the full height is the bottom of nothing, and
 * a layout with no pane under another has no bottom pane yet. Among those:
 *
 * 1. the one kururu marked when it last put an agent there
 *    (`PaneState.forAgents`), so that agents keep joining one pane however
 *    the rest is split around it;
 * 2. else the widest, because a strip along the bottom is what "the bottom
 *    pane" means and a corner is not;
 * 3. else the tallest, then the first in reading order — ties, settled the
 *    same way every time.
 *
 * A pane showing the board or a document is never taken, for
 * `paneBesideBoard`'s old reason: a new tab is shown, and the thing being
 * read would go. When nothing qualifies the whole layout is split — what
 * was there keeps its arrangement on top and the agents get the full width
 * below. An empty workspace is split too: an empty top half is a fine thing
 * to have, and an agent in the only pane would be the pile this replaces.
 *
 * `top` is the same rule upside down. `off` is the rule from before, which
 * stays in `workspaces.ts` because it reads the workspace's memory of where
 * focus came from — nothing a tree can answer.
 *
 * Pure, on `layout.ts`'s terms: the server asks it, the test pins it, and a
 * client could draw the mark without asking anything new.
 */
import { BOARD_TAB, activeAgent, panes, rects, showsDoc, type LayoutNode, type PaneState, type Rect } from "./layout";

/** Where the agents kururu starts go: the bottom pane, the top pane, or beside the board as before. */
export type AgentPlacement = "bottom" | "top" | "off";

export const AGENT_PLACEMENTS: readonly AgentPlacement[] = ["bottom", "top", "off"];

/** On, at the bottom: what the person who asked for this keeps. */
export const DEFAULT_AGENT_PLACEMENT: AgentPlacement = "bottom";

export function isAgentPlacement(value: unknown): value is AgentPlacement {
  return typeof value === "string" && (AGENT_PLACEMENTS as readonly string[]).includes(value);
}

/** The workspace's own choice when it has made one, else its profile's. */
export function placementOf(profile: AgentPlacement, workspace: AgentPlacement | null): AgentPlacement {
  return workspace ?? profile;
}

/** A pane to put the agent in, or the layout to divide because there is none. */
export type AgentPaneChoice = { pane: string } | { wrap: "below" | "above" };

/** Ratios are products of floats; an edge is an edge to within this. */
const EPS = 1e-6;

/** Whether a pane sits along that edge with something on the other side of it. */
export function onEdge(rect: Rect, side: "bottom" | "top"): boolean {
  return side === "bottom" ? rect.y > EPS && rect.y + rect.h > 1 - EPS : rect.y < EPS && rect.y + rect.h < 1 - EPS;
}

/** Whether a new tab may be put in front of what a pane is showing: never the board, never a document. */
export function takesAgent(pane: PaneState): boolean {
  return !showsDoc(pane) && activeAgent(pane) !== BOARD_TAB;
}

/** The agents' pane on that edge, by the rule above, or the word to make one. */
export function agentsPane(layout: LayoutNode, side: "bottom" | "top"): AgentPaneChoice {
  const at = rects(layout);
  const usable = panes(layout).flatMap((pane) => {
    const rect = at.get(pane.id);
    return rect && onEdge(rect, side) && takesAgent(pane) ? [{ pane, rect }] : [];
  });
  const marked = usable.find(({ pane }) => pane.forAgents);
  if (marked) return { pane: marked.pane.id };
  let best: { pane: PaneState; rect: Rect } | undefined;
  for (const one of usable) {
    if (!best || one.rect.w > best.rect.w + EPS || (Math.abs(one.rect.w - best.rect.w) <= EPS && one.rect.h > best.rect.h + EPS)) best = one;
  }
  return best ? { pane: best.pane.id } : { wrap: side === "bottom" ? "below" : "above" };
}
