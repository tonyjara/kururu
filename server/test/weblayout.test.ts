/**
 * Browser tabs in the split tree.
 *
 * A `web:` id sits in `agentIds` beside the terminals, so every gesture a tab
 * has applies to it for free — and the two ways that goes wrong are the ones
 * these pin. The first is the old trap: anything that is not the board or a
 * document used to be read as a *terminal*, so a page would be killed, watched
 * and typed into. The second is the page's address, which lives on the pane
 * (`PaneState.web`) and has to travel with its tab through every operation
 * that moves one, and go with it through every one that takes one out.
 */
import { describe, expect, it } from "bun:test";
import {
  activeTerminal,
  addTab,
  addWebTab,
  BOARD_TAB,
  closePane,
  cycleTab,
  docTab,
  findPane,
  isWebTab,
  makePane,
  mergePanes,
  movePaneTo,
  moveTabTo,
  mintWebTab,
  paneWithAgent,
  removeAt,
  removeTab,
  selectTab,
  setWebTab,
  showingWeb,
  splitWith,
  swapPanes,
  terminalsOf,
  visibleAgents,
  webTabOf,
  type LayoutNode,
  type PaneState,
  type WebTabState,
} from "../../shared/layout";
import { takesAgent } from "../../shared/agentpane";

const W = "web:abcdefgh1234";
const W2 = "web:zyxwvuts9876";
const page = (url = "http://localhost:3000/"): WebTabState => ({ url, title: "", nav: 0 });

/** A | B, with a terminal in each and a page in A after its terminal. */
function tree(): LayoutNode {
  let root: LayoutNode = { type: "split", id: "s1", dir: "row", ratio: 0.5, a: makePane("A"), b: makePane("B") };
  root = addTab(root, "A", "a1");
  root = addTab(root, "B", "a2");
  return addWebTab(root, "A", W, page());
}

const pane = (root: LayoutNode, id: string): PaneState => findPane(root, id)!;

/** Every pane's `web` holds exactly its own web tabs — the invariant every operation keeps. */
function consistent(root: LayoutNode): boolean {
  const walk = (node: LayoutNode): PaneState[] => (node.type === "pane" ? [node.pane] : [...walk(node.a), ...walk(node.b)]);
  return walk(root).every((p) => {
    const tabs = p.agentIds.filter(isWebTab).sort();
    const keys = Object.keys(p.web ?? {}).sort();
    return JSON.stringify(tabs) === JSON.stringify(keys) && (p.web === undefined || keys.length > 0);
  });
}

describe("the id", () => {
  it("is minted random, and recognised", () => {
    const id = mintWebTab();
    expect(isWebTab(id)).toBe(true);
    expect(id).toMatch(/^web:[a-z0-9]{12}$/);
    expect(mintWebTab()).not.toBe(id);
  });

  it("is not a document, the board, a terminal or a qualified id", () => {
    expect(isWebTab(docTab("/r", "a.md"))).toBe(false);
    expect(isWebTab(BOARD_TAB)).toBe(false);
    expect(isWebTab("a12")).toBe(false);
    expect(isWebTab("n:box:web:abcdefgh1234")).toBe(false);
    expect(isWebTab("web:../../etc")).toBe(false);
    expect(isWebTab(42)).toBe(false);
  });
});

describe("a page is not a terminal", () => {
  it("is left out of terminalsOf, which is what gets killed", () => {
    expect(terminalsOf(["a1", W, BOARD_TAB, docTab("/r", "a.md"), "a2"])).toEqual(["a1", "a2"]);
  });

  it("is not the active terminal, and not watched", () => {
    const root = tree();
    expect(activeTerminal(pane(root, "A"))).toBeNull();
    expect(visibleAgents(root)).toEqual(["a2"]);
  });

  it("does not take an agent in front of it", () => {
    expect(takesAgent(pane(tree(), "A"))).toBe(false);
    expect(takesAgent(pane(tree(), "B"))).toBe(true);
  });
});

describe("addWebTab", () => {
  it("goes after the tab showing, shows, and carries its page", () => {
    const root = tree();
    expect(pane(root, "A").agentIds).toEqual(["a1", W]);
    expect(pane(root, "A").activeIdx).toBe(1);
    expect(showingWeb(pane(root, "A"))).toEqual({ id: W, page: page() });
    expect(consistent(root)).toBe(true);
  });

  it("lands first in an empty pane", () => {
    const root = addWebTab(makePane("E"), "E", W, page());
    expect(pane(root, "E").agentIds).toEqual([W]);
    expect(pane(root, "E").activeIdx).toBe(0);
  });

  it("refuses an id already in the tree, and one that is not a page's", () => {
    const root = tree();
    expect(addWebTab(root, "B", W, page("https://example.com/"))).toBe(root);
    expect(addWebTab(root, "B", "a9", page())).toBe(root);
  });
});

describe("setWebTab", () => {
  it("changes the page where it is and nothing else", () => {
    const root = tree();
    const next = setWebTab(root, W, (p) => ({ ...p, url: "http://localhost:3000/about", title: "About" }));
    expect(webTabOf(next, W)).toEqual({ url: "http://localhost:3000/about", title: "About", nav: 0 });
    expect(pane(next, "B")).toBe(pane(root, "B"));
  });

  it("is the same tree for no change, and for no such tab", () => {
    const root = tree();
    expect(setWebTab(root, W, (p) => ({ ...p }))).toBe(root);
    expect(setWebTab(root, W2, (p) => ({ ...p, title: "x" }))).toBe(root);
  });
});

describe("moving a page", () => {
  it("moveTabTo carries its page to the other pane", () => {
    const root = moveTabTo(tree(), W, "B", 0);
    expect(pane(root, "A").agentIds).toEqual(["a1"]);
    expect(pane(root, "A").web).toBeUndefined();
    expect(pane(root, "B").agentIds).toEqual([W, "a2"]);
    expect(pane(root, "B").web?.[W]).toEqual(page());
    expect(consistent(root)).toBe(true);
  });

  it("moveTabTo along its own strip keeps its page", () => {
    const root = moveTabTo(tree(), W, "A", 0);
    expect(pane(root, "A").agentIds).toEqual([W, "a1"]);
    expect(webTabOf(root, W)).toEqual(page());
    expect(consistent(root)).toBe(true);
  });

  it("splitWith puts it, with its page, in the new pane", () => {
    const root = splitWith(tree(), W, "B", "col", false, "s2", makePane("F"));
    expect(pane(root, "F").agentIds).toEqual([W]);
    expect(pane(root, "F").web?.[W]).toEqual(page());
    expect(consistent(root)).toBe(true);
  });

  it("mergePanes brings its page into the pane it was poured into", () => {
    const root = mergePanes(tree(), "A", "B");
    expect(pane(root, "B").agentIds).toEqual(["a2", "a1", W]);
    expect(pane(root, "B").web?.[W]).toEqual(page());
    expect(consistent(root)).toBe(true);
  });

  it("mergePanes keeps the pages of both panes", () => {
    const root = mergePanes(addWebTab(tree(), "B", W2, page("https://example.com/")), "A", "B");
    expect(Object.keys(pane(root, "B").web ?? {}).sort()).toEqual([W, W2].sort());
    expect(consistent(root)).toBe(true);
  });

  it("swapPanes and movePaneTo move the pane, page and all", () => {
    const swapped = swapPanes(tree(), "A", "B");
    expect(paneWithAgent(swapped, W)?.id).toBe("A");
    expect(webTabOf(swapped, W)).toEqual(page());
    const moved = movePaneTo(tree(), "A", "B", "col", false, "s3");
    expect(webTabOf(moved, W)).toEqual(page());
    expect(consistent(moved)).toBe(true);
  });
});

describe("taking a page out", () => {
  it("removeTab takes its page with it", () => {
    const root = removeTab(tree(), W);
    expect(paneWithAgent(root, W)).toBeNull();
    expect(pane(root, "A").web).toBeUndefined();
    expect(consistent(root)).toBe(true);
  });

  it("removeAt takes only that page", () => {
    const two = addWebTab(tree(), "A", W2, page("https://example.com/"));
    const left = removeAt(pane(two, "A"), pane(two, "A").agentIds.indexOf(W));
    expect(left.agentIds).toEqual(["a1", W2]);
    expect(Object.keys(left.web ?? {})).toEqual([W2]);
  });

  it("removing a terminal beside it leaves the page alone", () => {
    const root = removeTab(tree(), "a1");
    expect(pane(root, "A").agentIds).toEqual([W]);
    expect(webTabOf(root, W)).toEqual(page());
  });

  it("closePane takes the page with the pane", () => {
    const root = closePane(tree(), "A")!;
    expect(webTabOf(root, W)).toBeNull();
    expect(consistent(root)).toBe(true);
  });
});

describe("selecting", () => {
  it("selectTab and cycleTab show a page as any tab", () => {
    const root = selectTab(tree(), "A", 0);
    expect(showingWeb(pane(root, "A"))).toBeNull();
    const back = cycleTab(root, "A", 1);
    expect(showingWeb(pane(back, "A"))?.id).toBe(W);
  });
});
