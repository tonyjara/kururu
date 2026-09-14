/**
 * The split tree, and every pure operation on it.
 *
 * This lives in `shared/` because both halves need it and neither should have
 * its own copy: the server owns the layout and mutates it, the browser draws it
 * and computes what is on screen from it. Two implementations of "which pane is
 * to the left of this one" would disagree eventually, and the disagreement would
 * look like a focus bug.
 *
 * The shape is ghosttown's, deliberately — a workspace is one split tree, a leaf
 * is a *pane*, and a pane holds a stack of terminals as tabs with one showing.
 * That last part is the difference from the tree kururu had a week ago, where a
 * pane held exactly one terminal. Tabs are what let a pane be a place you work
 * rather than a slot one process occupies: four agents in one project belong in
 * one pane, not four.
 *
 * Everything here is pure and immutable. An operation returns a new tree, which
 * is what lets the server diff nothing and broadcast whole, and what lets React
 * see a change.
 */

/** A leaf: terminals stacked as tabs, in strip order, one of them showing. */
export interface PaneState {
  id: string;
  /** Agent ids, in tab order. Empty is a real state — a pane with nothing in it. */
  agentIds: string[];
  /** Index into `agentIds`. Meaningless when the pane is empty. */
  activeIdx: number;
  /**
   * Where a new tab here should start, remembered from the last tab that lived
   * in this pane. It is what survives a restart: a restored pane has no
   * processes, and this is what makes its "new agent" button land in the project
   * that pane was for rather than in `~`.
   */
  cwd?: string;
}

export type LayoutNode = PaneNode | SplitNode;

export interface PaneNode {
  type: "pane";
  pane: PaneState;
}

export interface SplitNode {
  type: "split";
  id: string;
  /** `row` puts its children side by side; `col` stacks them. */
  dir: "row" | "col";
  /** Share of the space taken by `a`, between 0 and 1. */
  ratio: number;
  a: LayoutNode;
  b: LayoutNode;
}

/** Normalized geometry, 0..1 in both axes. Only ever derived, never stored. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function makePane(id: string, cwd?: string): PaneNode {
  return { type: "pane", pane: { id, agentIds: [], activeIdx: 0, cwd } };
}

/** Every pane, left to right and top to bottom — which is also cycle order. */
export function panes(node: LayoutNode): PaneState[] {
  if (node.type === "pane") return [node.pane];
  return [...panes(node.a), ...panes(node.b)];
}

export function findPane(node: LayoutNode, paneId: string): PaneState | null {
  return panes(node).find((p) => p.id === paneId) ?? null;
}

/** The pane holding this terminal, whether or not its tab is the active one. */
export function paneWithAgent(node: LayoutNode, agentId: string): PaneState | null {
  return panes(node).find((p) => p.agentIds.includes(agentId)) ?? null;
}

/** The terminal showing in a pane, or null when the pane is empty. */
export function activeAgent(pane: PaneState): string | null {
  return pane.agentIds[pane.activeIdx] ?? null;
}

/** Every terminal whose tab is the one showing — what a client needs to watch. */
export function visibleAgents(node: LayoutNode): string[] {
  const ids: string[] = [];
  for (const pane of panes(node)) {
    const id = activeAgent(pane);
    if (id) ids.push(id);
  }
  return ids;
}

function mapPanes(node: LayoutNode, fn: (pane: PaneState) => PaneState): LayoutNode {
  if (node.type === "pane") {
    const pane = fn(node.pane);
    return pane === node.pane ? node : { type: "pane", pane };
  }
  const a = mapPanes(node.a, fn);
  const b = mapPanes(node.b, fn);
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

/** Replace one pane's state, leaving every other node identical. */
export function updatePane(
  node: LayoutNode,
  paneId: string,
  fn: (pane: PaneState) => PaneState,
): LayoutNode {
  return mapPanes(node, (pane) => (pane.id === paneId ? fn(pane) : pane));
}

/** Add a tab, at the end of the strip, and show it. */
export function addTab(node: LayoutNode, paneId: string, agentId: string, cwd?: string): LayoutNode {
  return updatePane(node, paneId, (pane) => ({
    ...pane,
    agentIds: [...pane.agentIds, agentId],
    activeIdx: pane.agentIds.length,
    cwd: cwd ?? pane.cwd,
  }));
}

/**
 * Take a terminal out of whatever pane holds it.
 *
 * The pane it leaves shows its neighbour — the tab to the left, which is where
 * your eye already is — and clamps rather than trusting the index it had.
 */
export function removeTab(node: LayoutNode, agentId: string): LayoutNode {
  return mapPanes(node, (pane) => {
    const at = pane.agentIds.indexOf(agentId);
    if (at === -1) return pane;
    const agentIds = pane.agentIds.filter((id) => id !== agentId);
    return {
      ...pane,
      agentIds,
      activeIdx: Math.max(0, Math.min(at > 0 ? at - 1 : 0, agentIds.length - 1)),
    };
  });
}

export function selectTab(node: LayoutNode, paneId: string, index: number): LayoutNode {
  return updatePane(node, paneId, (pane) =>
    index < 0 || index >= pane.agentIds.length ? pane : { ...pane, activeIdx: index },
  );
}

/** Next or previous tab in a pane, wrapping. */
export function cycleTab(node: LayoutNode, paneId: string, delta: number): LayoutNode {
  return updatePane(node, paneId, (pane) => {
    const n = pane.agentIds.length;
    if (n < 2) return pane;
    return { ...pane, activeIdx: (pane.activeIdx + delta + n) % n };
  });
}

/**
 * Move a tab anywhere: along its own strip, or into another pane's.
 *
 * One operation for both, because they are the same gesture — you pick a
 * terminal up and put it down somewhere — and splitting them into "reorder" and
 * "transfer" would mean a drag that crossed a pane boundary took a different
 * code path than one that did not, which is exactly where the off-by-one lives.
 *
 * The tab lands *showing*, in the pane it was dropped into. Dropping something
 * and then having to go find it would make the gesture pointless.
 */
export function moveTabTo(
  node: LayoutNode,
  agentId: string,
  toPaneId: string,
  index?: number,
): LayoutNode {
  if (!paneWithAgent(node, agentId)) return node;
  // Remove first, so an index within the same strip means what it looks like:
  // the position the tab will occupy once it is gone from where it was.
  const without = removeTab(node, agentId);
  return updatePane(without, toPaneId, (pane) => {
    const at = Math.max(0, Math.min(index ?? pane.agentIds.length, pane.agentIds.length));
    const agentIds = [...pane.agentIds];
    agentIds.splice(at, 0, agentId);
    return { ...pane, agentIds, activeIdx: at };
  });
}

/**
 * Divide a pane in two. The new pane takes the right or bottom half by default —
 * the half your eye goes to next — and it starts empty, with the cwd of the pane
 * it came from, so whatever you start in it lands in the same project.
 *
 * `before` puts it on the other side instead. Nothing types that by hand; it is
 * what makes dropping a tab on a pane's *left* edge put it on the left, which is
 * the only behaviour a drag can have without being a lie.
 */
export function split(
  node: LayoutNode,
  paneId: string,
  dir: SplitNode["dir"],
  splitId: string,
  fresh: PaneNode,
  before = false,
): LayoutNode {
  if (node.type === "pane") {
    if (node.pane.id !== paneId) return node;
    const existing: PaneNode = node;
    const added: PaneNode = {
      type: "pane",
      pane: { ...fresh.pane, cwd: fresh.pane.cwd ?? node.pane.cwd },
    };
    return {
      type: "split",
      id: splitId,
      dir,
      ratio: 0.5,
      a: before ? added : existing,
      b: before ? existing : added,
    };
  }
  const a = split(node.a, paneId, dir, splitId, fresh, before);
  const b = split(node.b, paneId, dir, splitId, fresh, before);
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

/**
 * Drop a tab on a pane's edge: divide that pane and put the tab in the new half.
 *
 * The pane it came from can end up empty, and this does not tidy that up —
 * `workspaces.ts` does, because whether an emptied pane should disappear depends
 * on whether it was the last one, which is a question about the workspace rather
 * than about the tree.
 */
export function splitWith(
  node: LayoutNode,
  agentId: string,
  paneId: string,
  dir: SplitNode["dir"],
  before: boolean,
  splitId: string,
  fresh: PaneNode,
): LayoutNode {
  if (!paneWithAgent(node, agentId)) return node;
  const divided = split(node, paneId, dir, splitId, fresh, before);
  if (divided === node) return node;
  return moveTabTo(divided, agentId, fresh.pane.id, 0);
}

/**
 * Remove a pane. Its sibling takes the whole of the space they shared — the
 * split is gone, not left holding one child, because a split with one side is
 * just that side.
 *
 * Returns null when the pane was the last one. The caller decides what an empty
 * workspace looks like rather than having a blank pane forced on it here.
 */
export function closePane(node: LayoutNode, paneId: string): LayoutNode | null {
  if (node.type === "pane") return node.pane.id === paneId ? null : node;
  const a = closePane(node.a, paneId);
  const b = closePane(node.b, paneId);
  if (a === null) return b;
  if (b === null) return a;
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

/**
 * Exchange two panes' places in the tree, contents and all.
 *
 * The cheap half of rearranging, and the one people reach for first: two panes
 * side by side, and you want them the other way round. Doing that by moving one
 * out and splitting the other with it would work and would also rebuild the tree
 * around them, changing ratios that had nothing to do with the request. A swap
 * touches two leaves and nothing else.
 */
export function swapPanes(node: LayoutNode, aId: string, bId: string): LayoutNode {
  if (aId === bId) return node;
  const a = findPane(node, aId);
  const b = findPane(node, bId);
  if (!a || !b) return node;
  return mapPanes(node, (pane) => (pane.id === aId ? b : pane.id === bId ? a : pane));
}

/**
 * Take a whole pane out of the tree and put it back beside another one.
 *
 * Remove first, then split: doing it in that order is what keeps the tree from
 * growing a level it does not need. Two panes side by side, drag the left one
 * onto the right one's right edge — removing the left leaves the right alone as
 * the whole tree, and splitting it puts them back as one split the other way
 * round, rather than a split nested inside the split they were already in.
 */
export function movePaneTo(
  node: LayoutNode,
  paneId: string,
  toPaneId: string,
  dir: SplitNode["dir"],
  before: boolean,
  splitId: string,
): LayoutNode {
  if (paneId === toPaneId) return node;
  const moving = findPane(node, paneId);
  if (!moving) return node;
  const without = closePane(node, paneId);
  // It was the only pane there was; there is nowhere for it to go.
  if (!without || !findPane(without, toPaneId)) return node;
  return split(without, toPaneId, dir, splitId, { type: "pane", pane: moving }, before);
}

/**
 * Pour one pane's tabs into another and close the pane they came from.
 *
 * The inverse of dropping a tab on an edge, and the only way back: without it a
 * window can be divided by mouse but never put back together, which is a
 * rearrangement gesture that only works in one direction.
 */
export function mergePanes(node: LayoutNode, fromId: string, intoId: string): LayoutNode {
  if (fromId === intoId) return node;
  const from = findPane(node, fromId);
  if (!from || !findPane(node, intoId)) return node;
  const merged = updatePane(node, intoId, (pane) => ({
    ...pane,
    agentIds: [...pane.agentIds, ...from.agentIds],
    // Show the first of what arrived, the way a single dropped tab shows.
    activeIdx: from.agentIds.length > 0 ? pane.agentIds.length : pane.activeIdx,
  }));
  return closePane(merged, fromId) ?? merged;
}

/** Drag a divider. Clamped so a pane can always be grabbed again. */
export function setRatio(node: LayoutNode, splitId: string, ratio: number): LayoutNode {
  if (node.type === "pane") return node;
  if (node.id === splitId) return { ...node, ratio: Math.max(0.1, Math.min(0.9, ratio)) };
  const a = setRatio(node.a, splitId, ratio);
  const b = setRatio(node.b, splitId, ratio);
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

/** The next pane along, wrapping. */
export function stepPane(node: LayoutNode, paneId: string, delta: number): string | null {
  const all = panes(node);
  if (all.length === 0) return null;
  const at = all.findIndex((p) => p.id === paneId);
  if (at === -1) return all[0]!.id;
  return all[(at + delta + all.length) % all.length]!.id;
}

/**
 * Where every pane is, as fractions of the workspace.
 *
 * Derived on demand and never stored: the browser lays panes out with nested
 * flex boxes and knows nothing about coordinates, and the *only* thing that
 * needs them is directional focus — "the pane to the left" is a question about
 * geometry that a tree cannot answer on its own.
 */
export function rects(node: LayoutNode, within: Rect = { x: 0, y: 0, w: 1, h: 1 }): Map<string, Rect> {
  if (node.type === "pane") return new Map([[node.pane.id, within]]);
  const first =
    node.dir === "row"
      ? { ...within, w: within.w * node.ratio }
      : { ...within, h: within.h * node.ratio };
  const second =
    node.dir === "row"
      ? { ...within, x: within.x + first.w, w: within.w - first.w }
      : { ...within, y: within.y + first.h, h: within.h - first.h };
  const out = rects(node.a, first);
  for (const [id, rect] of rects(node.b, second)) out.set(id, rect);
  return out;
}

/** Where a split's boundary sits, and what a drag on it should measure against. */
export interface Divider {
  /** The split's id — what `setRatio` is addressed to. */
  id: string;
  dir: SplitNode["dir"];
  /** The split's own rectangle. A nested divider is a fraction of *this*, not of the window. */
  within: Rect;
  /** The boundary itself: an x for a row, a y for a col. */
  at: number;
}

/**
 * Every divider, with the geometry a drag needs.
 *
 * Panes are positioned rather than nested now (see `Panes.tsx` for why), so the
 * boundaries are no longer implied by a flex box and have to be worked out. The
 * `within` rect is the part that is easy to get wrong: dragging the divider of a
 * split that is itself one half of another split must be read against its own
 * rectangle, or the pointer and the ratio disagree by whatever the outer split's
 * ratio happens to be.
 */
export function dividers(node: LayoutNode, within: Rect = { x: 0, y: 0, w: 1, h: 1 }): Divider[] {
  if (node.type === "pane") return [];
  const first =
    node.dir === "row"
      ? { ...within, w: within.w * node.ratio }
      : { ...within, h: within.h * node.ratio };
  const second =
    node.dir === "row"
      ? { ...within, x: within.x + first.w, w: within.w - first.w }
      : { ...within, y: within.y + first.h, h: within.h - first.h };
  const at = node.dir === "row" ? within.x + first.w : within.y + first.h;
  return [
    { id: node.id, dir: node.dir, within, at },
    ...dividers(node.a, first),
    ...dividers(node.b, second),
  ];
}

export type Direction = "left" | "right" | "up" | "down";

/**
 * Move the divider that this pane's edge sits against, by a fraction.
 *
 * Which divider that is, is the whole question: a pane four splits deep has four
 * ancestors and only some of them run the right way. The answer is the nearest
 * ancestor whose direction matches the axis you are pushing along — the same one
 * you would grab with the mouse if you aimed at that edge.
 *
 * The sign does not depend on which side of the split the pane is on. `right`
 * always moves the divider right, which grows the pane on its left and shrinks
 * the one on its right; that is what the key means, not "make me bigger".
 */
export function nudge(
  node: LayoutNode,
  paneId: string,
  dir: Direction,
  delta: number,
): LayoutNode {
  const axis = dir === "left" || dir === "right" ? "row" : "col";
  const sign = dir === "right" || dir === "down" ? 1 : -1;
  const target = nearestSplit(node, paneId, axis);
  return target ? adjust(node, target, sign * delta) : node;
}

/** setRatio, relative — the ratio it is moving from is the tree's, not the caller's. */
function adjust(node: LayoutNode, splitId: string, by: number): LayoutNode {
  if (node.type === "pane") return node;
  if (node.id === splitId) return { ...node, ratio: Math.max(0.1, Math.min(0.9, node.ratio + by)) };
  const a = adjust(node.a, splitId, by);
  const b = adjust(node.b, splitId, by);
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

function nearestSplit(node: LayoutNode, paneId: string, axis: SplitNode["dir"]): string | null {
  // Depth-first, remembering the closest matching split seen on the way down —
  // which, when the pane turns up, is its nearest matching ancestor.
  const walk = (current: LayoutNode, closest: string | null): string | null => {
    if (current.type === "pane") return current.pane.id === paneId ? closest : null;
    const next = current.dir === axis ? current.id : closest;
    return walk(current.a, next) ?? walk(current.b, next);
  };
  return walk(node, null);
}

/**
 * The pane in that direction, or null when there is none.
 *
 * The rule is the one every tiling window manager uses: of the panes that start
 * beyond this one's edge and overlap it on the other axis, take the nearest.
 * Null is a useful answer and not a failure — the client turns "nothing to the
 * left of the leftmost pane" into focusing the sidebar, the way ghosttown does.
 */
export function paneInDirection(
  node: LayoutNode,
  paneId: string,
  dir: Direction,
): string | null {
  const all = rects(node);
  const from = all.get(paneId);
  if (!from) return null;
  const EPS = 1e-6;

  let best: { id: string; gap: number; overlap: number } | null = null;
  for (const [id, rect] of all) {
    if (id === paneId) continue;

    // Distance from our edge to theirs, and how much they share the other axis.
    let gap: number;
    let overlap: number;
    if (dir === "left" || dir === "right") {
      gap = dir === "right" ? rect.x - (from.x + from.w) : from.x - (rect.x + rect.w);
      overlap = Math.min(from.y + from.h, rect.y + rect.h) - Math.max(from.y, rect.y);
    } else {
      gap = dir === "down" ? rect.y - (from.y + from.h) : from.y - (rect.y + rect.h);
      overlap = Math.min(from.x + from.w, rect.x + rect.w) - Math.max(from.x, rect.x);
    }
    if (gap < -EPS || overlap <= EPS) continue;

    // Nearest wins; where two are equally near, the one sharing more edge does.
    if (!best || gap < best.gap - EPS || (Math.abs(gap - best.gap) <= EPS && overlap > best.overlap)) {
      best = { id, gap, overlap };
    }
  }
  return best?.id ?? null;
}
