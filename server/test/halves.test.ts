/**
 * Where a new tab goes when nobody named a pane — `shared/halves.ts`. Pure,
 * and the part of the rule a person could disagree with, so it is pinned
 * layout by layout: the ones the owner described (an empty workspace, a
 * board on top and agents below, a document from Kuru's drawer while an
 * agent is focused) and the ones geometry is easy to get wrong on — a
 * full-height pane, a bottom row of two, a mark dragged off its half.
 */
import { describe, expect, it } from "bun:test";
import { halfOf, inHalf, paneInHalf, showsKind } from "../../shared/halves";
import { BOARD_TAB, docTab, findPane, makePane, markAgentsPane, panes, paneWithAgent, rects, wrapLayout, type LayoutNode, type PaneState } from "../../shared/layout";
import { Workspaces } from "../src/workspaces";

function pane(id: string, tabs: string[] = [], extra: Partial<PaneState> = {}): LayoutNode {
  return { type: "pane", pane: { id, agentIds: tabs, activeIdx: 0, ...extra } };
}
let splits = 0;
function col(a: LayoutNode, b: LayoutNode, ratio = 0.5): LayoutNode {
  return { type: "split", id: `s${++splits}`, dir: "col", ratio, a, b };
}
function row(a: LayoutNode, b: LayoutNode, ratio = 0.5): LayoutNode {
  return { type: "split", id: `s${++splits}`, dir: "row", ratio, a, b };
}
const DOC = docTab("/repo", "README.md");
const OTHER = docTab("/repo", "PLAN.md");

describe("which half a tab belongs in", () => {
  it("is the lower for a terminal and the upper for the board or a document", () => {
    expect(halfOf("a1")).toBe("lower");
    expect(halfOf(BOARD_TAB)).toBe("upper");
    expect(halfOf(DOC)).toBe("upper");
  });
});

describe("the layouts the owner described", () => {
  it("fills an empty workspace with the first thing opened, whichever half", () => {
    expect(paneInHalf(pane("n1"), "lower")).toEqual({ pane: "n1" });
    expect(paneInHalf(pane("n1"), "upper")).toEqual({ pane: "n1" });
  });

  it("puts an agent under a workspace that is only the board, and a document over one that is only an agent", () => {
    expect(paneInHalf(pane("n1", [BOARD_TAB]), "lower")).toEqual({ wrap: "below" });
    expect(paneInHalf(pane("n1", ["a1"]), "upper")).toEqual({ wrap: "above" });
  });

  it("lets a lone pane keep what is its own: another agent joins the lone agent, another document the lone document", () => {
    expect(paneInHalf(pane("n1", ["a1"]), "lower")).toEqual({ pane: "n1" });
    expect(paneInHalf(pane("n1", [DOC]), "upper")).toEqual({ pane: "n1" });
    // What the pane is showing decides, not what is behind it.
    expect(paneInHalf(pane("n1", [BOARD_TAB, "a1"], { activeIdx: 1 }), "lower")).toEqual({ pane: "n1" });
    // A reader waiting on its picker is a document's pane.
    expect(paneInHalf(pane("n1", [], { reader: { root: "/repo", follow: null, editor: null, rev: 0 } }), "lower")).toEqual({ wrap: "below" });
  });

  it("sends a document up and an agent down in a workspace split top and bottom, whatever is focused", () => {
    const layout = col(pane("top", [BOARD_TAB]), pane("low", ["a1"]));
    expect(paneInHalf(layout, "upper", "low")).toEqual({ pane: "top" });
    expect(paneInHalf(layout, "lower", "top")).toEqual({ pane: "low" });
  });

  it("splits a workspace of two panes side by side, since neither is above or below anything", () => {
    expect(paneInHalf(row(pane("l", [BOARD_TAB]), pane("r", ["a1"])), "lower")).toEqual({ wrap: "below" });
    expect(paneInHalf(row(pane("l", [BOARD_TAB]), pane("r", ["a1"])), "upper")).toEqual({ wrap: "above" });
  });
});

describe("what counts as each half", () => {
  it("is a pane along that edge with something on the other side, however thin", () => {
    expect(paneInHalf(col(pane("top"), pane("low"), 0.9), "lower")).toEqual({ pane: "low" });
    expect(paneInHalf(col(pane("top"), pane("low"), 0.1), "upper")).toEqual({ pane: "top" });
  });

  it("is the lower right when the left runs the full height, and never the full-height pane", () => {
    const layout = row(pane("board", [BOARD_TAB]), col(pane("nvim", ["a1"]), pane("shell", ["a2"])));
    expect(paneInHalf(layout, "lower")).toEqual({ pane: "shell" });
    expect(paneInHalf(layout, "upper")).toEqual({ pane: "nvim" });
  });

  it("is never the bottom of an upper half, only of the whole", () => {
    const layout = col(row(pane("a"), col(pane("b"), pane("corner"))), pane("strip"));
    expect(paneInHalf(layout, "lower")).toEqual({ pane: "strip" });
  });

  it("is read off a hand-made arrangement the same way: the top row is the upper half, the bottom row the lower", () => {
    // Agents dragged to the top and the board to the bottom: the halves are where the panes are.
    const layout = col(pane("up", ["a1"]), pane("down", [BOARD_TAB]));
    expect(paneInHalf(layout, "lower")).toEqual({ pane: "down" });
    expect(paneInHalf(layout, "upper")).toEqual({ pane: "up" });
  });
});

describe("among several panes of a half", () => {
  it("takes the one you are in first", () => {
    const layout = col(row(pane("a", [BOARD_TAB]), pane("b", [DOC])), row(pane("c", ["a1"]), pane("d", ["a2"], { forAgents: true })));
    expect(paneInHalf(layout, "upper", "a")).toEqual({ pane: "a" });
    expect(paneInHalf(layout, "lower", "c")).toEqual({ pane: "c" });
  });

  it("then, for a terminal, the marked pane, even over a wider one", () => {
    const layout = col(pane("top"), row(pane("a", ["a1"]), pane("b", ["a2"], { forAgents: true }), 0.7));
    expect(paneInHalf(layout, "lower")).toEqual({ pane: "b" });
    expect(paneInHalf(layout, "lower", "top")).toEqual({ pane: "b" });
  });

  it("ignores a mark whose pane is no longer in the lower half", () => {
    const layout = col(pane("agents", ["a1"], { forAgents: true }), pane("shell", ["a2"]));
    expect(paneInHalf(layout, "lower")).toEqual({ pane: "shell" });
  });

  it("then one already showing that half's kind, so a document joins the reader and not the board", () => {
    expect(paneInHalf(col(row(pane("board", [BOARD_TAB]), pane("reader", [OTHER])), pane("low", ["a1"])), "upper")).toEqual({ pane: "reader" });
    expect(paneInHalf(col(pane("top"), row(pane("doc", [DOC]), pane("shell", ["a1"]))), "lower")).toEqual({ pane: "shell" });
    // An empty pane is asking to be filled, and counts as either kind.
    expect(paneInHalf(col(row(pane("shell", ["a1"]), pane("empty")), pane("low")), "upper")).toEqual({ pane: "empty" });
  });

  it("then the widest, then the tallest, then reading order", () => {
    expect(paneInHalf(col(pane("top"), row(pane("a"), pane("b"))), "lower")).toEqual({ pane: "a" });
    expect(paneInHalf(col(pane("top"), row(pane("a"), pane("b"), 0.3)), "lower")).toEqual({ pane: "b" });
    const layout = row(col(pane("a"), pane("short"), 0.8), col(pane("b"), pane("tall"), 0.3));
    expect(paneInHalf(layout, "lower")).toEqual({ pane: "tall" });
  });

  it("covers what a pane of the wrong kind is showing rather than splitting again", () => {
    // A document somebody dragged into the lower half: an agent goes in front of it, a tab away.
    expect(paneInHalf(col(pane("top", [BOARD_TAB]), pane("low", [DOC])), "lower")).toEqual({ pane: "low" });
    expect(paneInHalf(col(pane("top", ["a1"]), pane("low", ["a2"])), "upper")).toEqual({ pane: "top" });
  });
});

describe("the small pieces", () => {
  it("reads an edge to within rounding", () => {
    expect(inHalf({ x: 0, y: 0.7, w: 1, h: 0.30000000000000004 }, "lower")).toBe(true);
    expect(inHalf({ x: 0, y: 0, w: 1, h: 1 }, "lower")).toBe(false);
    expect(inHalf({ x: 0, y: 0, w: 1, h: 1 }, "upper")).toBe(false);
  });

  it("knows which kind a pane is showing", () => {
    expect(showsKind({ id: "n", agentIds: [], activeIdx: 0 }, "lower")).toBe(true);
    expect(showsKind({ id: "n", agentIds: [], activeIdx: 0 }, "upper")).toBe(true);
    expect(showsKind({ id: "n", agentIds: ["a1", BOARD_TAB], activeIdx: 0 }, "lower")).toBe(true);
    expect(showsKind({ id: "n", agentIds: ["a1", BOARD_TAB], activeIdx: 1 }, "upper")).toBe(true);
    expect(showsKind({ id: "n", agentIds: [DOC], activeIdx: 0 }, "lower")).toBe(false);
  });

  it("wraps the whole layout, and what it made is what the rule then finds", () => {
    const before = row(pane("l", [BOARD_TAB]), pane("r", [DOC]));
    const below = wrapLayout(before, "s", makePane("agents"));
    expect(rects(below).get("agents")).toEqual({ x: 0, y: 0.5, w: 1, h: 0.5 });
    expect(rects(below).get("l")).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 });
    expect(paneInHalf(below, "lower")).toEqual({ pane: "agents" });
    const above = wrapLayout(pane("a", ["a1"]), "s", makePane("docs"), true);
    expect(rects(above).get("docs")).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
    expect(paneInHalf(above, "upper")).toEqual({ pane: "docs" });
  });

  it("moves the mark rather than multiplying it", () => {
    const layout = col(pane("a", [], { forAgents: true }), pane("b"));
    const moved = markAgentsPane(layout, "b");
    expect(panes(moved).map((p) => [p.id, p.forAgents === true])).toEqual([["a", false], ["b", true]]);
    expect(markAgentsPane(moved, "b")).toBe(moved);
  });
});

/**
 * The same rule against a real arrangement: what the server's verbs do to
 * the layout it holds. A terminal itself is `addTab`, as `openTerminal`
 * does it.
 */
describe("paneForIn and paneFor", () => {
  const where = (w: Workspaces, paneId: string) => rects(w.activeWorkspace.layout).get(paneId);

  it("fills an empty workspace with the first agent, marks it, and moves nobody's keyboard", () => {
    const w = new Workspaces();
    const home = w.focusedPaneId;
    const agents = w.paneForIn(w.active.id, w.activeWorkspace.id, "lower")!;
    expect(agents).toBe(home);
    expect(panes(w.activeWorkspace.layout)).toHaveLength(1);
    expect(findPane(w.activeWorkspace.layout, agents)!.forAgents).toBe(true);
  });

  it("keeps a workspace's board on top and its agents under it, every later one as a tab", () => {
    const w = new Workspaces();
    const home = w.focusedPaneId;
    w.openBoard(home);
    const first = w.paneForIn(w.active.id, w.activeWorkspace.id, "lower")!;
    w.addTab("a1", "/repo", first);
    const second = w.paneForIn(w.active.id, w.activeWorkspace.id, "lower")!;
    expect(second).toBe(first);
    expect(paneWithAgent(w.activeWorkspace.layout, BOARD_TAB)!.id).toBe(home);
    expect(where(w, home)!.y).toBe(0);
    expect(where(w, first)!.y).toBe(0.5);
    expect(w.focusedPaneId).toBe(home);
  });

  it("opens the board over a workspace of agents, not in front of them", () => {
    const w = new Workspaces();
    const home = w.focusedPaneId;
    w.addTab("a1", "/repo", home);
    const board = w.openBoard(home)!;
    expect(board).not.toBe(home);
    expect(where(w, board)).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
    expect(where(w, home)).toEqual({ x: 0, y: 0.5, w: 1, h: 0.5 });
    // The menu's Board still goes where it was asked for.
    const w2 = new Workspaces();
    w2.addTab("a1", "/repo", w2.focusedPaneId);
    expect(w2.openBoard(w2.focusedPaneId, true)).toBe(w2.focusedPaneId);
  });

  it("shows a document from the drawer in the upper half while an agent below has the keyboard", () => {
    const w = new Workspaces();
    const home = w.focusedPaneId;
    w.openBoard(home);
    const low = w.paneForIn(w.active.id, w.activeWorkspace.id, "lower")!;
    w.addTab("a1", "/repo", low);
    w.focusPane(low);
    const shown = w.showDoc("/repo", "README.md")!;
    expect(shown).toBe(home);
    expect(findPane(w.activeWorkspace.layout, low)!.agentIds).toEqual(["a1"]);
    expect(w.focusedPaneId).toBe(low);
  });

  it("keeps a link's document in the reader it was clicked in, when that is in the upper half", () => {
    const w = new Workspaces();
    const home = w.focusedPaneId;
    w.openBoard(home);
    const reader = w.split("row", home)!;
    w.openDoc(reader, "/repo", "README.md");
    w.paneForIn(w.active.id, w.activeWorkspace.id, "lower");
    w.focusPane(home);
    expect(w.showDoc("/repo", "PLAN.md", reader)).toBe(reader);
  });

  it("makes the upper half over a workspace of terminals for a document", () => {
    const w = new Workspaces();
    const home = w.focusedPaneId;
    w.addTab("a1", "/repo", home);
    const shown = w.showDoc("/repo", "README.md")!;
    expect(where(w, shown)).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
    expect(where(w, home)).toEqual({ x: 0, y: 0.5, w: 1, h: 0.5 });
  });

  it("starts a fresh lower pane in the directory of the pane you are in", () => {
    const w = new Workspaces();
    w.addTab(BOARD_TAB, undefined, w.focusedPaneId);
    w.addTab("shell", "/repo/sub", w.split("row", w.focusedPaneId)!);
    const agents = w.paneForIn(w.active.id, w.activeWorkspace.id, "lower")!;
    expect(findPane(w.activeWorkspace.layout, agents)!.cwd).toBe("/repo/sub");
  });

  it("sends a terminal dropped on another workspace's row to that workspace's lower half", () => {
    const w = new Workspaces();
    const away = w.activeWorkspace.id;
    w.openBoard(w.focusedPaneId);
    w.newWorkspace("here");
    w.addTab("a1", "/repo", w.focusedPaneId);
    w.moveTabToWorkspace("a1", away);
    const there = w.workspaceIn(w.active.id, away)!;
    const at = rects(there.layout).get(paneWithAgent(there.layout, "a1")!.id)!;
    expect(at.y).toBe(0.5);
    expect(paneWithAgent(there.layout, BOARD_TAB)!.agentIds).toEqual([BOARD_TAB]);
  });

  it("works on a workspace that is not on screen, and moves nobody to it", () => {
    const w = new Workspaces();
    const away = w.activeWorkspace.id;
    w.openBoard(w.focusedPaneId);
    w.newWorkspace("here");
    const here = w.activeWorkspace.id;
    const focus = w.focusedPaneId;
    const agents = w.paneForIn(w.active.id, away, "lower")!;
    expect(w.activeWorkspace.id).toBe(here);
    expect(w.focusedPaneId).toBe(focus);
    expect(panes(w.workspaceIn(w.active.id, away)!.layout).map((p) => p.id)).toContain(agents);
    expect(panes(w.activeWorkspace.layout)).toHaveLength(1);
  });
});

describe("cwdPaneIn", () => {
  it("is the pane focus came from beside the board, never the lower pane the agent lands in", () => {
    const w = new Workspaces();
    const home = w.focusedPaneId;
    w.addTab("shell", "/repo", home);
    const board = w.split("row", home)!;
    w.openBoard(board, true);
    expect(w.cwdPaneIn(w.active.id, w.activeWorkspace.id)).toBe(home);
    const lone = new Workspaces();
    lone.openBoard(lone.focusedPaneId, true);
    expect(lone.cwdPaneIn(lone.active.id, lone.activeWorkspace.id)).toBe(lone.focusedPaneId);
    expect(panes(lone.activeWorkspace.layout)).toHaveLength(1);
  });
});
