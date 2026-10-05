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
 * is a *pane*, and a pane holds a stack of tabs with one showing. Tabs are what
 * let a pane be a place you work rather than a slot one process occupies: four
 * agents in one project belong in one pane, not four. A tab is a terminal, the
 * board, or a document, in any mix — see `BOARD_TAB` and `docTab`.
 *
 * Everything here is pure and immutable. An operation returns a new tree, which
 * is what lets the server diff nothing and broadcast whole, and what lets React
 * see a change.
 */

/**
 * What a pane's documents are doing, beyond being tabs.
 *
 * A document is a tab like a terminal or the board is (`docTab`), so which
 * file a pane is showing is simply its active tab and which files it has open
 * is its strip. What is left over is the part that belongs to the pane rather
 * than to any one document: whether it is tracking an editor, and the project
 * its picker opens on while it has nothing to show yet.
 *
 * Deliberately nothing about what a document *said*, because this goes to disk
 * with the layout. A rendered document is derived from a file somebody else
 * owns, so the pane remembers where to look and nothing about what it found:
 * reopening kururu shows the file as it is now, not as it was.
 *
 * Optional on a pane, and a pane without one can still hold documents — one
 * dragged in from a reader needs nothing here. It exists for a pane that was
 * opened *as* a reader: one following an editor, or waiting on its picker.
 */
export interface ReaderState {
  /** The project the picker opens on, or "" for "ask". Not the document's root. */
  root: string;
  /** The terminal whose nvim drives this, or null for a pinned pane. */
  follow: string | null;
  /**
   * The terminal this reader was opened to follow, kept while it is pinned.
   *
   * Pinning used to throw the answer away — `follow` went to null and nothing
   * remembered what it had been — so the button that says "follow the editor
   * again" had no editor to go back to and did nothing at all. Null for a
   * reader that was only ever opened from the tree: there is nothing to follow,
   * and the strip shows no button for it.
   */
  editor: string | null;
  /**
   * Bumped every time the editor writes the file, which is the whole mechanism
   * for "it updates when I save".
   *
   * The snapshot carries this rather than the rendered markup: a snapshot goes
   * out on every change to anything, and putting a document's HTML in one would
   * send a README to every client because somebody switched tabs. So the client
   * fetches the render, and this is what tells it the answer it has is stale.
   * It is a cache key and only ever goes up; which document it is for is the
   * active tab's business.
   */
  rev: number;
}

/** A document, by the only address `files.ts` answers to. */
export interface ReaderDoc {
  root: string;
  /** Relative to `root`, forward slashes, the shape `files.ts` takes. */
  path: string;
}

/** A leaf: tabs in strip order, one of them showing. */
export interface PaneState {
  id: string;
  /**
   * The tabs, in strip order: terminals by agent id, the board (`BOARD_TAB`)
   * and documents (`docTab`). Named for what it held first, and kept that way
   * because the wire, the host's blob and `session.json` all spell it so.
   * Empty is a real state — a pane with nothing in it.
   */
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
  /**
   * The pane's reader, when it was opened as one. See `ReaderState`.
   *
   * It used to be the other kind of pane — mutually exclusive with terminals,
   * on the argument that one strip mixing them would have one ✕ meaning two
   * verbs. That argument lost to the one about arranging: a window whose
   * documents could only ever sit in panes of their own could not put a spec
   * beside the board that is working through it, in the strip you are already
   * looking at. The ✕ says which verb it is in its tooltip, the way the
   * board's already did.
   */
  reader?: ReaderState;
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

/**
 * The numbers that arrive from outside, and why they are checked here rather
 * than at the socket.
 *
 * Every one of these comes off a `ClientMessage` — a ratio from a dragged
 * divider, an index from a clicked tab — and a message is JSON from a client on
 * the tailnet, so "a number" is a thing to establish rather than assume. The
 * clamps were already here and already meant to be that check. They were not,
 * because **NaN loses every comparison it is in**: `Math.max(0.1, Math.min(0.9,
 * NaN))` is NaN, and `index < 0 || index >= length` is *false* for NaN and false
 * again for the string `"x"`, so the guard that looks like a range check waves
 * both of them straight through to the assignment below it.
 *
 * What made that worth fixing rather than noting is where the value goes. A
 * tree is not scratch state: it is handed to the pty host as the arrangement and
 * debounced onto disk by `persist.ts`, and `JSON.stringify(NaN)` is `null`. So a
 * single malformed message put a `"ratio": null` in `session.json` that came
 * back every start afterwards, with the geometry it produces wrong in a way no
 * gesture in the window could undo — the divider you would drag to fix it is
 * computed from the ratio that is broken.
 *
 * Refused rather than repaired, and that is the same line `set-workspace-color`
 * draws. A ratio of `"x"` is not a drag that went too far, with a nearest legal
 * value to snap to; it is not a drag at all, and the tree it was aimed at is
 * already a perfectly good one. `propose-size` in `index.ts` has always taken
 * this shape — it is the same argument, arriving at the same answer, for the one
 * number that was already known to reach a pty.
 */
function clampRatio(ratio: number): number {
  return Math.max(0.1, Math.min(0.9, ratio));
}

/** A tab position: a whole number, and not a negative one. */
function isIndex(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

/** Every pane, left to right and top to bottom — which is also cycle order. */
export function panes(node: LayoutNode): PaneState[] {
  if (node.type === "pane") return [node.pane];
  return [...panes(node.a), ...panes(node.b)];
}

export function findPane(node: LayoutNode, paneId: string): PaneState | null {
  return panes(node).find((p) => p.id === paneId) ?? null;
}

/**
 * The one pane a window too narrow to tile shows.
 *
 * The focused pane, because on a phone "the pane I am looking at" and "the pane
 * the next keystroke belongs to" stop being two questions — there is nowhere
 * else for a keystroke to go. Which is also what makes the choice outlast a
 * reload and reach the window next door without anything new being stored: focus
 * is part of the arrangement, and the arrangement is the server's.
 *
 * It falls back to the first pane rather than answering null, because a focus
 * left pointing at a pane that has since closed would be a phone with nothing on
 * screen at all — and unlike a colour name or a mascot id, "which pane" has a
 * nearest legal answer. The tree always holds at least one.
 */
export function soloPane(node: LayoutNode, focusedPaneId: string): PaneState {
  const all = panes(node);
  return all.find((p) => p.id === focusedPaneId) ?? all[0]!;
}

/** The pane holding this terminal, whether or not its tab is the active one. */
export function paneWithAgent(node: LayoutNode, agentId: string): PaneState | null {
  return panes(node).find((p) => p.agentIds.includes(agentId)) ?? null;
}

/**
 * The workspace's board, as a tab.
 *
 * It sits in `agentIds` beside the terminals under an id no pty can have (the
 * host mints `a1`, `a2`…), and that is the whole trick: every gesture a tab
 * already has — reordering along a strip, dragging into another pane, dropping
 * on an edge to split, pouring one pane into another — is written against
 * that list, and a board that is one more entry in it gets all of them without
 * a line of its own. The price is that the few things that treat a tab as a
 * *process* have to be told this one is not: `activeTerminal`,
 * `visibleAgents`, and the lists `workspaces.ts` hands to whatever kills.
 *
 * One per workspace, because the board is the workspace's and not the tab's
 * (`Workspace.board`); closing the tab puts the cards away, and the next
 * `open-board` finds them where they were.
 */
export const BOARD_TAB = "board";

export function isBoardTab(id: unknown): boolean {
  return id === BOARD_TAB;
}

/**
 * A document, as a tab.
 *
 * The board's trick again: an id no pty can have, in the same list as the
 * terminals, so every gesture a tab has — reordering, dragging between panes,
 * splitting off onto an edge, pouring one pane into another — works on a
 * document without a line of its own. The address is the id, JSON so that no
 * character a path can contain is ambiguous, which also makes the same file
 * the same tab: a pane holds a document once.
 *
 * Unlike the board and the terminals, the same document may be open in two
 * panes. That is why nothing addresses a document tab by id alone across the
 * tree — `moveDocTo` and `splitWithDoc` take the pane it is leaving and where
 * in that pane's strip it is.
 */
const DOC_PREFIX = "doc:";

export function docTab(root: string, path: string): string {
  return DOC_PREFIX + JSON.stringify([root, path]);
}

export function isDocTab(id: unknown): id is string {
  return typeof id === "string" && id.startsWith(DOC_PREFIX);
}

/** The document a tab is, or null for a terminal, the board, or anything malformed. */
export function parseDocTab(id: unknown): ReaderDoc | null {
  if (!isDocTab(id)) return null;
  try {
    const parsed: unknown = JSON.parse(id.slice(DOC_PREFIX.length));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [root, path] = parsed as unknown[];
    return typeof root === "string" && typeof path === "string" && path !== "" ? { root, path } : null;
  } catch {
    return null;
  }
}

/** Only the terminals of a list of tabs — what may be killed, watched or typed into. */
export function terminalsOf(ids: readonly string[]): string[] {
  return ids.filter((id) => id !== BOARD_TAB && !isDocTab(id));
}

/** A pane's documents, in strip order. */
export function docsOf(pane: PaneState): ReaderDoc[] {
  return pane.agentIds.flatMap((id) => parseDocTab(id) ?? []);
}

/** The tab showing in a pane — a terminal, the board or a document — or null when it is empty. */
export function activeAgent(pane: PaneState): string | null {
  return pane.agentIds[pane.activeIdx] ?? null;
}

/** The terminal showing in a pane, or null when it is empty or showing the board or a document. */
export function activeTerminal(pane: PaneState): string | null {
  const id = activeAgent(pane);
  return id === BOARD_TAB || isDocTab(id) ? null : id;
}

/** The document showing in a pane, or null when the active tab is not one. */
export function showingDoc(pane: PaneState): ReaderDoc | null {
  return parseDocTab(activeAgent(pane));
}

/**
 * Whether a pane is being read rather than worked in: its active tab is a
 * document, or it has no tabs and is a reader waiting on its picker or its
 * editor. The question everything asks before it takes a pane's screen away —
 * a new terminal lands elsewhere, an editor's `:w` may change which document
 * shows but never swaps a terminal out for one.
 */
export function showsDoc(pane: PaneState): boolean {
  return pane.agentIds.length === 0 ? Boolean(pane.reader) : showingDoc(pane) !== null;
}

/** Every terminal whose tab is the one showing — what a client needs to watch. */
export function visibleAgents(node: LayoutNode): string[] {
  const ids: string[] = [];
  for (const pane of panes(node)) {
    const id = activeTerminal(pane);
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
 * A pane with the tab at `at` gone.
 *
 * The showing tab going hands the screen to its neighbour — the tab to the
 * left, which is where your eye already is. A tab going from elsewhere in the
 * strip leaves the one you were looking at showing, which means shifting the
 * index when it went from the left of it.
 */
export function removeAt(pane: PaneState, at: number): PaneState {
  if (!isIndex(at) || at >= pane.agentIds.length) return pane;
  const agentIds = pane.agentIds.filter((_, i) => i !== at);
  const active =
    at < pane.activeIdx ? pane.activeIdx - 1 : at === pane.activeIdx ? (at > 0 ? at - 1 : 0) : pane.activeIdx;
  return { ...pane, agentIds, activeIdx: Math.max(0, Math.min(active, agentIds.length - 1)) };
}

/**
 * Take a terminal out of whatever pane holds it. Terminals and the board only:
 * a document can be open in two panes, and taking it out "wherever it is"
 * would close both.
 */
export function removeTab(node: LayoutNode, agentId: string): LayoutNode {
  return mapPanes(node, (pane) => {
    const at = pane.agentIds.indexOf(agentId);
    return at === -1 ? pane : removeAt(pane, at);
  });
}

export function selectTab(node: LayoutNode, paneId: string, index: number): LayoutNode {
  if (!isIndex(index)) return node;
  return updatePane(node, paneId, (pane) =>
    index >= pane.agentIds.length ? pane : { ...pane, activeIdx: index },
  );
}

/** Next or previous tab in a pane, wrapping. */
export function cycleTab(node: LayoutNode, paneId: string, delta: number): LayoutNode {
  if (!Number.isInteger(delta)) return node;
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
  // An index that is not one is read as "no index given" rather than refused:
  // unlike a ratio this argument is already optional, and the end of the strip
  // is what a drop with nothing to say about position has always meant. See
  // `clampRatio` for what a number arriving here may turn out to be — without
  // this, `Math.min` passes NaN through and it lands in `activeIdx` below.
  const wanted = index !== undefined && !isIndex(index) ? undefined : index;
  // Remove first, so an index within the same strip means what it looks like:
  // the position the tab will occupy once it is gone from where it was.
  const without = removeTab(node, agentId);
  return updatePane(without, toPaneId, (pane) => {
    const at = Math.max(0, Math.min(wanted ?? pane.agentIds.length, pane.agentIds.length));
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
 *
 * Any pane into any other, since a pane is no longer one kind of thing. A
 * document the target already has is not brought twice, and a reader's state
 * comes along when the target has none — which is what keeps a pane following
 * an editor still following it after being poured somewhere.
 */
export function mergePanes(node: LayoutNode, fromId: string, intoId: string): LayoutNode {
  if (fromId === intoId) return node;
  const from = findPane(node, fromId);
  const into = findPane(node, intoId);
  if (!from || !into) return node;
  const arriving = from.agentIds.filter((id) => !(isDocTab(id) && into.agentIds.includes(id)));
  const merged = updatePane(node, intoId, (pane) => ({
    ...pane,
    agentIds: [...pane.agentIds, ...arriving],
    // Show the first of what arrived, the way a single dropped tab shows.
    activeIdx: arriving.length > 0 ? pane.agentIds.length : pane.activeIdx,
    reader: pane.reader ?? from.reader,
  }));
  return closePane(merged, fromId) ?? merged;
}

/**
 * Put a tab into a pane's strip at `at` (the end when it has nothing to say),
 * showing. A document the pane already has moves rather than doubling, with
 * `at` read as where it lands once its old place has gone.
 *
 * Pins a reader that was following an editor when what shows changes to a
 * different document: a document somebody put there by hand is one an editor
 * next door should not take back on its next `:w`.
 */
export function placeTab(pane: PaneState, id: string, at: number | undefined): PaneState {
  const before = showingDoc(pane);
  let target = at;
  const agentIds = pane.agentIds.filter((existing, i) => {
    if (existing !== id) return true;
    if (target !== undefined && i < target) target--;
    return false;
  });
  const place = Math.max(0, Math.min(target ?? agentIds.length, agentIds.length));
  agentIds.splice(place, 0, id);
  const doc = parseDocTab(id);
  const pinned = doc && pane.reader?.follow && !(before && sameDoc(before, doc));
  return {
    ...pane,
    agentIds,
    activeIdx: place,
    ...(pinned ? { reader: { ...pane.reader!, follow: null } } : {}),
  };
}

function sameDoc(a: ReaderDoc, b: ReaderDoc): boolean {
  return a.root === b.root && a.path === b.path;
}

/**
 * Open a document in a pane as a tab, after the one showing — or select it,
 * when the pane has it already. `show` says whether it takes the screen: a
 * file somebody picked always does; an editor's report does only in a pane
 * already showing a document, because an nvim wandering through a project
 * should not swap the terminal you are watching for a README.
 */
export function withDoc(pane: PaneState, doc: ReaderDoc, show: boolean): PaneState {
  const id = docTab(doc.root, doc.path);
  const at = pane.agentIds.indexOf(id);
  if (at !== -1) return show ? { ...pane, activeIdx: at } : pane;
  const place = pane.agentIds.length === 0 ? 0 : pane.activeIdx + 1;
  const agentIds = [...pane.agentIds];
  agentIds.splice(place, 0, id);
  return { ...pane, agentIds, activeIdx: show || pane.agentIds.length === 0 ? place : pane.activeIdx };
}

/**
 * Move a document's tab: along its own strip, or into any other pane's.
 *
 * `moveTabTo` for documents, with the same rule about the index — it is where
 * the tab will sit once it is gone from where it was — and the same landing:
 * the moved document is the one showing. Addressed by pane and position rather
 * than by id because the same document can be open in two panes.
 */
export function moveDocTo(
  node: LayoutNode,
  fromPaneId: string,
  index: number,
  toPaneId: string,
  at?: number,
): LayoutNode {
  const id = isIndex(index) ? findPane(node, fromPaneId)?.agentIds[index] : undefined;
  if (!isDocTab(id) || !findPane(node, toPaneId)) return node;
  const wanted = at !== undefined && !isIndex(at) ? undefined : at;
  if (fromPaneId === toPaneId) return updatePane(node, toPaneId, (pane) => placeTab(pane, id, wanted));
  const without = updatePane(node, fromPaneId, (pane) => removeAt(pane, index));
  return updatePane(without, toPaneId, (pane) => placeTab(pane, id, wanted));
}

/**
 * Drop a document's tab on a pane's edge: a new pane there, holding just it.
 *
 * `splitWith` for documents. A pane's only tab dropped on its own edge is
 * refused: it would split the pane and close the half it came from, which is
 * the pane it already was.
 */
export function splitWithDoc(
  node: LayoutNode,
  fromPaneId: string,
  index: number,
  paneId: string,
  dir: SplitNode["dir"],
  before: boolean,
  splitId: string,
  freshId: string,
): LayoutNode {
  const from = findPane(node, fromPaneId);
  const id = isIndex(index) ? from?.agentIds[index] : undefined;
  if (!from || !isDocTab(id) || !findPane(node, paneId)) return node;
  if (fromPaneId === paneId && from.agentIds.length === 1) return node;
  const without = updatePane(node, fromPaneId, (pane) => removeAt(pane, index));
  const fresh: PaneNode = { type: "pane", pane: { id: freshId, agentIds: [id], activeIdx: 0 } };
  return split(without, paneId, dir, splitId, fresh, before);
}

/** Drag a divider. Clamped so a pane can always be grabbed again. */
export function setRatio(node: LayoutNode, splitId: string, ratio: number): LayoutNode {
  if (!Number.isFinite(ratio)) return node;
  if (node.type === "pane") return node;
  if (node.id === splitId) return { ...node, ratio: clampRatio(ratio) };
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
  // Checked here rather than in `adjust`, and the difference is not filing: the
  // sign is applied by multiplying, and multiplication *coerces*, so `"0.5"`
  // would arrive below as a perfectly good -0.5 and `null` as -0. This is the
  // last point at which the argument is still what the client sent. See
  // `clampRatio` for why that matters.
  if (!Number.isFinite(delta)) return node;
  const axis = dir === "left" || dir === "right" ? "row" : "col";
  const sign = dir === "right" || dir === "down" ? 1 : -1;
  const target = nearestSplit(node, paneId, axis);
  return target ? adjust(node, target, sign * delta) : node;
}

/** setRatio, relative — the ratio it is moving from is the tree's, not the caller's. */
function adjust(node: LayoutNode, splitId: string, by: number): LayoutNode {
  if (node.type === "pane") return node;
  if (node.id === splitId) return { ...node, ratio: clampRatio(node.ratio + by) };
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
