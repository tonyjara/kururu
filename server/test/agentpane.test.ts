/**
 * Which pane is the agents' — `shared/agentpane.ts`. Pure, and the one part
 * of sending agents to the bottom that a person could disagree with, so it
 * is pinned layout by layout: the three asked for by name (an empty
 * workspace, one with the board open, one already split) and the ones a
 * rule about edges is easy to get wrong on — a full-height pane, a bottom
 * row of two, a mark that has been dragged off the edge.
 */
import { describe, expect, it } from "bun:test";
import { AGENT_PLACEMENTS, agentsPane, isAgentPlacement, onEdge, placementOf, takesAgent } from "../../shared/agentpane";
import { BOARD_TAB, docTab, findPane, makePane, markAgentsPane, panes, paneWithAgent, rects, wrapLayout, type LayoutNode, type PaneState } from "../../shared/layout";
import type { Profile } from "../../shared/model";
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

describe("the three layouts asked about", () => {
  it("splits an empty workspace, leaving the empty pane on top", () => {
    expect(agentsPane(pane("n1"), "bottom")).toEqual({ wrap: "below" });
  });

  it("splits a workspace that is only the board, rather than hiding it", () => {
    expect(agentsPane(pane("n1", [BOARD_TAB]), "bottom")).toEqual({ wrap: "below" });
    // The board behind a terminal is not being read; the pane is still the whole height.
    expect(agentsPane(pane("n1", [BOARD_TAB, "a1"], { activeIdx: 1 }), "bottom")).toEqual({ wrap: "below" });
  });

  it("joins the bottom pane of a workspace already split top and bottom", () => {
    expect(agentsPane(col(pane("top", [BOARD_TAB]), pane("low", ["a1"])), "bottom")).toEqual({ pane: "low" });
    expect(agentsPane(col(pane("top", [BOARD_TAB]), pane("low")), "bottom")).toEqual({ pane: "low" });
  });

  it("splits a workspace split side by side, since neither half is below anything", () => {
    expect(agentsPane(row(pane("l", [BOARD_TAB]), pane("r", ["a1"])), "bottom")).toEqual({ wrap: "below" });
  });
});

describe("what counts as the bottom pane", () => {
  it("is a pane along the bottom edge with something above it, however thin", () => {
    expect(agentsPane(col(pane("top"), pane("low"), 0.9), "bottom")).toEqual({ pane: "low" });
    expect(agentsPane(col(pane("top"), pane("low"), 0.1), "bottom")).toEqual({ pane: "low" });
  });

  it("is the lower right when the left runs the full height", () => {
    const layout = row(pane("board", [BOARD_TAB]), col(pane("nvim", ["a1"]), pane("shell", ["a2"])));
    expect(agentsPane(layout, "bottom")).toEqual({ pane: "shell" });
  });

  it("prefers the widest of a bottom row, then the leftmost", () => {
    expect(agentsPane(col(pane("top"), row(pane("a"), pane("b"))), "bottom")).toEqual({ pane: "a" });
    expect(agentsPane(col(pane("top"), row(pane("a"), pane("b"), 0.3)), "bottom")).toEqual({ pane: "b" });
  });

  it("is never the bottom of an upper half, only of the whole", () => {
    const layout = col(row(pane("a"), col(pane("b"), pane("corner"))), pane("strip"));
    expect(agentsPane(layout, "bottom")).toEqual({ pane: "strip" });
  });

  it("prefers the taller of two as wide", () => {
    const layout = row(col(pane("a"), pane("short"), 0.8), col(pane("b"), pane("tall"), 0.3));
    expect(agentsPane(layout, "bottom")).toEqual({ pane: "tall" });
  });

  it("passes over a pane showing the board or a document, and splits when that leaves none", () => {
    const doc = docTab("/repo", "README.md");
    expect(agentsPane(col(pane("top"), pane("low", [BOARD_TAB])), "bottom")).toEqual({ wrap: "below" });
    expect(agentsPane(col(pane("top"), pane("low", [doc])), "bottom")).toEqual({ wrap: "below" });
    // A reader waiting on its picker has no tabs and is still being read.
    expect(agentsPane(col(pane("top"), pane("low", [], { reader: { root: "/repo", follow: null, editor: null, rev: 0 } })), "bottom")).toEqual({ wrap: "below" });
    expect(agentsPane(col(pane("top"), row(pane("a", [BOARD_TAB]), pane("b", ["a1"]))), "bottom")).toEqual({ pane: "b" });
  });
});

describe("the mark", () => {
  it("wins over a wider pane, so agents keep joining the one they were in", () => {
    const layout = col(pane("top"), row(pane("a"), pane("b", ["a1"], { forAgents: true }), 0.7));
    expect(agentsPane(layout, "bottom")).toEqual({ pane: "b" });
  });

  it("is ignored once its pane is no longer on that edge", () => {
    // The agents' pane swapped to the top: the setting says bottom, and the bottom is what is asked for.
    const layout = col(pane("agents", ["a1"], { forAgents: true }), pane("shell", ["a2"]));
    expect(agentsPane(layout, "bottom")).toEqual({ pane: "shell" });
    expect(agentsPane(layout, "top")).toEqual({ pane: "agents" });
  });

  it("is ignored while its pane is showing the board", () => {
    const layout = col(pane("top"), row(pane("a"), pane("b", ["a1", BOARD_TAB], { forAgents: true, activeIdx: 1 })));
    expect(agentsPane(layout, "bottom")).toEqual({ pane: "a" });
  });

  it("moves rather than multiplies, and leaves the tree alone when it is already there", () => {
    const layout = col(pane("a", [], { forAgents: true }), pane("b"));
    const moved = markAgentsPane(layout, "b");
    expect(panes(moved).map((p) => [p.id, p.forAgents === true])).toEqual([["a", false], ["b", true]]);
    expect("forAgents" in panes(moved)[0]!).toBe(false);
    expect(markAgentsPane(moved, "b")).toBe(moved);
  });
});

describe("top", () => {
  it("is the same rule upside down", () => {
    expect(agentsPane(pane("n1"), "top")).toEqual({ wrap: "above" });
    expect(agentsPane(col(pane("up"), pane("low", [BOARD_TAB])), "top")).toEqual({ pane: "up" });
    expect(agentsPane(col(pane("up", [BOARD_TAB]), pane("low")), "top")).toEqual({ wrap: "above" });
    expect(agentsPane(row(pane("l"), pane("r")), "top")).toEqual({ wrap: "above" });
  });
});

describe("wrapLayout", () => {
  it("puts everything that was there on one side and the fresh pane across the other", () => {
    const before = row(pane("l"), pane("r"));
    const below = wrapLayout(before, "s", makePane("agents"));
    expect(below).toMatchObject({ type: "split", dir: "col", ratio: 0.5, a: before });
    const at = rects(below);
    expect(at.get("agents")).toEqual({ x: 0, y: 0.5, w: 1, h: 0.5 });
    expect(at.get("l")).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 });
    const above = wrapLayout(before, "s", makePane("agents"), true);
    expect(rects(above).get("agents")).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
    // And what it made is what the rule then finds.
    expect(agentsPane(below, "bottom")).toEqual({ pane: "agents" });
    expect(agentsPane(above, "top")).toEqual({ pane: "agents" });
  });
});

describe("the small pieces", () => {
  it("reads an edge to within rounding", () => {
    expect(onEdge({ x: 0, y: 0.7, w: 1, h: 0.30000000000000004 }, "bottom")).toBe(true);
    expect(onEdge({ x: 0, y: 0, w: 1, h: 1 }, "bottom")).toBe(false);
    expect(onEdge({ x: 0, y: 0, w: 1, h: 1 }, "top")).toBe(false);
  });

  it("takes a pane that is empty or showing a terminal, nothing else", () => {
    expect(takesAgent({ id: "n", agentIds: [], activeIdx: 0 })).toBe(true);
    expect(takesAgent({ id: "n", agentIds: ["a1", BOARD_TAB], activeIdx: 0 })).toBe(true);
    expect(takesAgent({ id: "n", agentIds: ["a1", BOARD_TAB], activeIdx: 1 })).toBe(false);
  });

  it("knows the three words and nothing else, and a workspace's beats its profile's", () => {
    for (const word of AGENT_PLACEMENTS) expect(isAgentPlacement(word)).toBe(true);
    for (const junk of ["left", "", null, undefined, 1, {}]) expect(isAgentPlacement(junk)).toBe(false);
    expect(placementOf("bottom", null)).toBe("bottom");
    expect(placementOf("bottom", "off")).toBe("off");
  });
});

/**
 * The same rule against a real arrangement: what `agentPaneIn` does to the
 * layout it holds, which is what a card's robot and Kuru's `start_agent`
 * ask. The terminal itself is `addTab`, as `openTerminal` does it.
 */
describe("agentPaneIn", () => {
  const where = (w: Workspaces, paneId: string) => rects(w.activeWorkspace.layout).get(paneId);

  it("splits an empty workspace, puts the agent below, and leaves the focus on top", () => {
    const w = new Workspaces();
    const top = w.focusedPaneId;
    const agents = w.agentPaneIn(w.active.id, w.activeWorkspace.id)!;
    expect(agents).not.toBe(top);
    expect(where(w, top)).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
    expect(where(w, agents)).toEqual({ x: 0, y: 0.5, w: 1, h: 0.5 });
    expect(findPane(w.activeWorkspace.layout, agents)!.forAgents).toBe(true);
    expect(w.focusedPaneId).toBe(top);
  });

  it("puts every later agent in the same pane as a tab", () => {
    const w = new Workspaces();
    const first = w.agentPaneIn(w.active.id, w.activeWorkspace.id)!;
    w.addTab("a1", "/repo", first);
    const second = w.agentPaneIn(w.active.id, w.activeWorkspace.id)!;
    w.addTab("a2", "/repo", second);
    expect(second).toBe(first);
    expect(panes(w.activeWorkspace.layout)).toHaveLength(2);
    expect(findPane(w.activeWorkspace.layout, first)!.agentIds).toEqual(["a1", "a2"]);
  });

  it("keeps a workspace's board on top and its agents under it", () => {
    const w = new Workspaces();
    const home = w.focusedPaneId;
    w.openBoard(home, true);
    const agents = w.agentPaneIn(w.active.id, w.activeWorkspace.id)!;
    expect(paneWithAgent(w.activeWorkspace.layout, BOARD_TAB)!.id).toBe(home);
    expect(where(w, home)!.y).toBe(0);
    expect(where(w, agents)!.y).toBe(0.5);
    expect(w.focusedPaneId).toBe(home);
  });

  it("joins the bottom of a workspace already split, without splitting again", () => {
    const w = new Workspaces();
    const home = w.focusedPaneId;
    w.openBoard(home, true);
    const low = w.split("col", home)!;
    w.addTab("shell", "/repo", low);
    w.focusPane(home);
    expect(w.agentPaneIn(w.active.id, w.activeWorkspace.id)).toBe(low);
    expect(panes(w.activeWorkspace.layout)).toHaveLength(2);
  });

  it("splits the whole of a side-by-side workspace, not one half of it", () => {
    const w = new Workspaces();
    const left = w.focusedPaneId;
    w.openBoard(left, true);
    const right = w.split("row", left)!;
    w.addTab("nvim", "/repo", right);
    const agents = w.agentPaneIn(w.active.id, w.activeWorkspace.id)!;
    expect(where(w, left)).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 });
    expect(where(w, right)).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
    expect(where(w, agents)).toEqual({ x: 0, y: 0.5, w: 1, h: 0.5 });
  });

  it("starts a fresh agents' pane in the directory of the pane you are in", () => {
    const w = new Workspaces();
    w.addTab("shell", "/repo/sub", w.focusedPaneId);
    const agents = w.agentPaneIn(w.active.id, w.activeWorkspace.id)!;
    expect(findPane(w.activeWorkspace.layout, agents)!.cwd).toBe("/repo/sub");
  });

  it("goes to the top, upside down, when that is the choice", () => {
    const w = new Workspaces();
    const home = w.focusedPaneId;
    w.setAgentPlacement(w.active.id, "top");
    const agents = w.agentPaneIn(w.active.id, w.activeWorkspace.id)!;
    expect(where(w, agents)!.y).toBe(0);
    expect(where(w, home)!.y).toBe(0.5);
  });

  it("is the old rule when off: beside the board, in the pane you came from", () => {
    const w = new Workspaces();
    const home = w.focusedPaneId;
    w.openBoard(home, true);
    w.setAgentPlacement(w.active.id, "off");
    const beside = w.agentPaneIn(w.active.id, w.activeWorkspace.id)!;
    expect(where(w, beside)).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
    expect(findPane(w.activeWorkspace.layout, beside)!.forAgents).toBeUndefined();
  });

  it("lets a workspace say otherwise than its profile, and null hand it back", () => {
    const w = new Workspaces();
    const ws = w.activeWorkspace.id;
    w.setWorkspaceAgentPlacement(w.active.id, ws, "off");
    // Off with no board is the focused pane itself, as it always was.
    expect(w.agentPaneIn(w.active.id, ws)).toBe(w.focusedPaneId);
    expect(panes(w.activeWorkspace.layout)).toHaveLength(1);
    w.setWorkspaceAgentPlacement(w.active.id, ws, null);
    expect(w.activeWorkspace.agentPlacement).toBeNull();
    expect(panes(w.activeWorkspace.layout)).toHaveLength(1);
    w.agentPaneIn(w.active.id, ws);
    expect(panes(w.activeWorkspace.layout)).toHaveLength(2);
  });

  it("works on a workspace that is not on screen, and moves nobody to it", () => {
    const w = new Workspaces();
    const away = w.activeWorkspace.id;
    w.newWorkspace("here");
    const here = w.activeWorkspace.id;
    const focus = w.focusedPaneId;
    const agents = w.agentPaneIn(w.active.id, away)!;
    expect(w.activeWorkspace.id).toBe(here);
    expect(w.focusedPaneId).toBe(focus);
    expect(panes(w.workspaceIn(w.active.id, away)!.layout).map((p) => p.id)).toContain(agents);
    expect(panes(w.activeWorkspace.layout)).toHaveLength(1);
  });
});

describe("cwdPaneIn", () => {
  it("is the pane focus came from beside the board, never the agents' pane it lands in", () => {
    const w = new Workspaces();
    const home = w.focusedPaneId;
    w.addTab("shell", "/repo", home);
    const board = w.split("row", home)!;
    w.openBoard(board, true);
    expect(w.cwdPaneIn(w.active.id, w.activeWorkspace.id)).toBe(home);
    // With no other pane than the board's, the board's own directory — what a split off it would have had.
    const lone = new Workspaces();
    lone.openBoard(lone.focusedPaneId, true);
    expect(lone.cwdPaneIn(lone.active.id, lone.activeWorkspace.id)).toBe(lone.focusedPaneId);
    expect(panes(lone.activeWorkspace.layout)).toHaveLength(1);
  });

  it("is the focused pane when there is no board", () => {
    const w = new Workspaces();
    const home = w.focusedPaneId;
    w.split("row", home);
    expect(w.cwdPaneIn(w.active.id, w.activeWorkspace.id)).toBe(w.focusedPaneId);
  });
});

describe("reading the choice out of a blob", () => {
  it("defaults what an older server never wrote, and refuses words it does not know", () => {
    const fresh = new Workspaces().all();
    const old = fresh.map(({ agentPlacement: _p, ...profile }) => ({
      ...profile,
      workspaces: profile.workspaces.map(({ agentPlacement: _w, ...workspace }) => workspace),
    })) as unknown as Profile[];
    const adopted = new Workspaces(old).all()[0]!;
    expect(adopted.agentPlacement).toBe("bottom");
    expect(adopted.workspaces[0]!.agentPlacement).toBeNull();
    const junk = [{ ...fresh[0]!, agentPlacement: "sideways", workspaces: fresh[0]!.workspaces.map((w) => ({ ...w, agentPlacement: 7 })) }] as unknown as Profile[];
    const read = new Workspaces(junk).all()[0]!;
    expect(read.agentPlacement).toBe("bottom");
    expect(read.workspaces[0]!.agentPlacement).toBeNull();
  });
});
