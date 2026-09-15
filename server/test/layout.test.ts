/**
 * The split tree. Pure, so it is testable without a browser — and worth testing,
 * because every one of these is a rearrangement that must not lose a pane, leave
 * a split holding one child, or point a focus at something that is gone.
 *
 * `paneInDirection` gets the most attention here. It is the one operation that
 * cannot be read off the tree — "the pane to the left" is a question about
 * geometry — and it is the one a wrong answer makes look like a broken key.
 */
import { describe, expect, it } from "bun:test";
import {
  addTab,
  closePane,
  cycleTab,
  dividers,
  makePane,
  mergePanes,
  movePaneTo,
  moveTabTo,
  nudge,
  paneInDirection,
  paneWithAgent,
  panes,
  rects,
  removeTab,
  selectTab,
  setRatio,
  soloPane,
  split,
  splitWith,
  stepPane,
  swapPanes,
  visibleAgents,
  type LayoutNode,
} from "../../shared/layout";

/**
 * A | (B / C) — one pane on the left, two stacked on the right. The shape a
 * window ends up in about four seconds after you learn the keys.
 */
function tree(): LayoutNode {
  return {
    type: "split",
    id: "s1",
    dir: "row",
    ratio: 0.5,
    a: makePane("A"),
    b: { type: "split", id: "s2", dir: "col", ratio: 0.5, a: makePane("B"), b: makePane("C") },
  };
}

describe("panes", () => {
  it("reads left to right, top to bottom", () => {
    expect(panes(tree()).map((p) => p.id)).toEqual(["A", "B", "C"]);
  });
});

describe("tabs", () => {
  it("adds at the end of the strip and shows what it added", () => {
    let root: LayoutNode = makePane("A");
    root = addTab(root, "A", "a1", "/one");
    root = addTab(root, "A", "a2", "/two");
    const pane = panes(root)[0]!;
    expect(pane.agentIds).toEqual(["a1", "a2"]);
    expect(pane.activeIdx).toBe(1);
    // The pane remembers where its newest tab was started; that is what a
    // restored layout offers you and what a split inherits.
    expect(pane.cwd).toBe("/two");
  });

  it("falls back to the tab on the left when one closes", () => {
    let root: LayoutNode = addTab(addTab(addTab(makePane("A"), "A", "a1"), "A", "a2"), "A", "a3");
    root = selectTab(root, "A", 2);
    root = removeTab(root, "a3");
    expect(panes(root)[0]!.agentIds).toEqual(["a1", "a2"]);
    expect(panes(root)[0]!.activeIdx).toBe(1);
  });

  it("clamps rather than trusting an index into a strip that shrank", () => {
    // Closing the only tab must not leave activeIdx pointing past the end: the
    // next add would land beside a phantom.
    const root = removeTab(addTab(makePane("A"), "A", "a1"), "a1");
    expect(panes(root)[0]!.agentIds).toEqual([]);
    expect(panes(root)[0]!.activeIdx).toBe(0);
  });

  it("cycles with wrap, and does nothing with fewer than two", () => {
    const two = addTab(addTab(makePane("A"), "A", "a1"), "A", "a2");
    expect(panes(cycleTab(two, "A", 1))[0]!.activeIdx).toBe(0);
    expect(panes(cycleTab(two, "A", -1))[0]!.activeIdx).toBe(0);
    const one = addTab(makePane("A"), "A", "a1");
    expect(panes(cycleTab(one, "A", 1))[0]!.activeIdx).toBe(0);
  });

  it("drags a tab along its own strip and follows it", () => {
    const root = addTab(addTab(addTab(makePane("A"), "A", "a1"), "A", "a2"), "A", "a3");
    const moved = moveTabTo(root, "a1", "A", 2);
    expect(panes(moved)[0]!.agentIds).toEqual(["a2", "a3", "a1"]);
    expect(panes(moved)[0]!.activeIdx).toBe(2);
  });

  it("finds the pane holding a terminal whether or not its tab is showing", () => {
    const root = addTab(addTab(makePane("A"), "A", "a1"), "A", "a2");
    expect(paneWithAgent(root, "a1")?.id).toBe("A");
    expect(paneWithAgent(root, "nope")).toBeNull();
  });

  it("reports only the tab that is showing as visible", () => {
    let root = tree();
    root = addTab(addTab(root, "A", "a1"), "A", "a2");
    root = addTab(root, "B", "a3");
    // a1 is behind a2 in the same pane; nobody can see it, so nobody watches it.
    expect(visibleAgents(root)).toEqual(["a2", "a3"]);
  });
});

describe("moveTabTo", () => {
  /** A | (B / C), with two tabs in A and one in B. */
  function loaded() {
    let root = tree();
    root = addTab(addTab(root, "A", "a1"), "A", "a2");
    root = addTab(root, "B", "a3");
    return root;
  }

  it("carries a tab into another pane and shows it there", () => {
    const after = moveTabTo(loaded(), "a1", "B", 0);
    expect(panes(after).find((p) => p.id === "A")!.agentIds).toEqual(["a2"]);
    const b = panes(after).find((p) => p.id === "B")!;
    expect(b.agentIds).toEqual(["a1", "a3"]);
    // Dropped means showing: having to go and find it would make the gesture
    // pointless.
    expect(b.activeIdx).toBe(0);
  });

  it("appends when no position is named", () => {
    const after = moveTabTo(loaded(), "a1", "B");
    expect(panes(after).find((p) => p.id === "B")!.agentIds).toEqual(["a3", "a1"]);
  });

  it("leaves the pane it came from showing something sensible", () => {
    // a2 was showing in A; taking it out must not leave activeIdx past the end.
    const after = moveTabTo(loaded(), "a2", "C");
    const a = panes(after).find((p) => p.id === "A")!;
    expect(a.agentIds).toEqual(["a1"]);
    expect(a.activeIdx).toBe(0);
  });

  it("ignores a terminal that is not in the tree", () => {
    const start = loaded();
    expect(moveTabTo(start, "nope", "B", 0)).toBe(start);
  });

  it("clamps an index past the end rather than leaving a hole", () => {
    const after = moveTabTo(loaded(), "a1", "B", 99);
    expect(panes(after).find((p) => p.id === "B")!.agentIds).toEqual(["a3", "a1"]);
  });
});

describe("splitWith", () => {
  it("divides the pane and puts the dragged tab in the new half", () => {
    let root: LayoutNode = addTab(addTab(makePane("A"), "A", "a1"), "A", "a2");
    root = splitWith(root, "a1", "A", "row", false, "s9", makePane("NEW"));
    expect(panes(root).map((p) => p.id)).toEqual(["A", "NEW"]);
    expect(panes(root)[0]!.agentIds).toEqual(["a2"]);
    expect(panes(root)[1]!.agentIds).toEqual(["a1"]);
  });

  it("puts it on the side it was dropped on", () => {
    // Dropped on the left edge, so the new pane is the left one. A split that
    // ignored the side would be a drag that lies about where the tab is going.
    let root: LayoutNode = addTab(addTab(makePane("A"), "A", "a1"), "A", "a2");
    root = splitWith(root, "a1", "A", "row", true, "s9", makePane("NEW"));
    expect(panes(root).map((p) => p.id)).toEqual(["NEW", "A"]);
    expect(panes(root)[0]!.agentIds).toEqual(["a1"]);
  });

  it("can pull a tab out of one pane into a split of another", () => {
    let root = tree();
    root = addTab(root, "A", "a1");
    root = splitWith(root, "a1", "C", "col", false, "s9", makePane("NEW"));
    expect(panes(root).find((p) => p.id === "A")!.agentIds).toEqual([]);
    expect(panes(root).find((p) => p.id === "NEW")!.agentIds).toEqual(["a1"]);
  });
});

describe("split", () => {
  it("divides the named pane and gives the new one its project", () => {
    const start = addTab(makePane("A"), "A", "a1", "/work");
    const root = split(start, "A", "row", "s9", makePane("B"));
    expect(panes(root).map((p) => p.id)).toEqual(["A", "B"]);
    expect(panes(root)[1]!.cwd).toBe("/work");
  });

  it("leaves a tree alone when the pane is not in it", () => {
    const start = tree();
    expect(split(start, "nope", "row", "s9", makePane("Z"))).toBe(start);
  });
});

describe("swapPanes", () => {
  it("exchanges two panes, contents and all", () => {
    // The gesture this exists for: two agents on the left, a terminal on the
    // right, and you want them the other way round.
    let root = tree();
    root = addTab(addTab(root, "A", "a1"), "A", "a2");
    root = addTab(root, "B", "a3");
    const after = swapPanes(root, "A", "B");
    const order = panes(after).map((p) => p.id);
    expect(order).toEqual(["B", "A", "C"]);
    // The tabs travelled with them; only the places changed.
    expect(panes(after).find((p) => p.id === "A")!.agentIds).toEqual(["a1", "a2"]);
    expect(panes(after).find((p) => p.id === "B")!.agentIds).toEqual(["a3"]);
  });

  it("leaves the tree alone when a pane is not in it", () => {
    const start = tree();
    expect(swapPanes(start, "A", "nope")).toBe(start);
    expect(swapPanes(start, "A", "A")).toBe(start);
  });

  it("does not disturb the ratios of the splits around them", () => {
    const start = setRatio(tree(), "s1", 0.3);
    const after = swapPanes(start, "A", "C");
    expect(after.type === "split" && after.ratio).toBe(0.3);
  });
});

describe("movePaneTo", () => {
  it("puts a pane back on the side it was dropped, without nesting deeper", () => {
    // A | B. Drag A onto B's right edge: the answer is B | A — one split, the
    // other way round, not a split inside the split they were already in.
    let root: LayoutNode = split(makePane("A"), "A", "row", "s1", makePane("B"));
    root = addTab(root, "A", "a1");
    root = addTab(root, "B", "a2");
    const after = movePaneTo(root, "A", "B", "row", false, "s9");
    expect(panes(after).map((p) => p.id)).toEqual(["B", "A"]);
    expect(after.type === "split" && after.a.type).toBe("pane");
    expect(panes(after).find((p) => p.id === "A")!.agentIds).toEqual(["a1"]);
  });

  it("can drop a pane above another one", () => {
    const root = tree();
    const after = movePaneTo(root, "A", "C", "col", true, "s9");
    // A left the row split entirely and is now stacked over C.
    expect(panes(after).map((p) => p.id)).toEqual(["B", "A", "C"]);
  });

  it("refuses to move the only pane there is", () => {
    const only = makePane("A");
    expect(movePaneTo(only, "A", "A", "row", false, "s9")).toBe(only);
  });
});

describe("mergePanes", () => {
  it("pours one pane's tabs into another and closes the empty one", () => {
    let root = tree();
    root = addTab(addTab(root, "A", "a1"), "A", "a2");
    root = addTab(root, "B", "a3");
    const after = mergePanes(root, "A", "B");
    expect(panes(after).map((p) => p.id)).toEqual(["B", "C"]);
    expect(panes(after)[0]!.agentIds).toEqual(["a3", "a1", "a2"]);
    // The first of what arrived is what shows, the way a single dropped tab does.
    expect(panes(after)[0]!.activeIdx).toBe(1);
  });

  it("is the way back from a split, so an empty pane merges to nothing", () => {
    const root = addTab(tree(), "B", "a1");
    const after = mergePanes(root, "A", "B");
    expect(panes(after).map((p) => p.id)).toEqual(["B", "C"]);
    expect(panes(after)[0]!.agentIds).toEqual(["a1"]);
  });
});

describe("closePane", () => {
  it("gives the space to the sibling and drops the split", () => {
    const after = closePane(tree(), "B");
    expect(after).not.toBeNull();
    expect(panes(after!).map((p) => p.id)).toEqual(["A", "C"]);
    // s2 held B and C; with B gone it is just C, never a split with one side.
    expect(after!.type === "split" && after!.b.type).toBe("pane");
  });

  it("returns nothing when the last pane goes", () => {
    expect(closePane(makePane("A"), "A")).toBeNull();
  });
});

describe("setRatio", () => {
  it("clamps so a pane is never dragged out of existence", () => {
    expect((setRatio(tree(), "s1", 0) as { ratio: number }).ratio).toBe(0.1);
    expect((setRatio(tree(), "s1", 2) as { ratio: number }).ratio).toBe(0.9);
  });
});

describe("soloPane", () => {
  it("is the focused pane", () => {
    const node = tree();
    expect(soloPane(node, "C").id).toBe("C");
  });

  it("falls back to the first rather than leaving a phone with nothing on screen", () => {
    const node = tree();
    // What a focus left pointing at a pane that has since been closed looks
    // like from here. A narrow window has no second pane to fall back on.
    expect(soloPane(node, "gone").id).toBe("A");
  });
});

describe("stepPane", () => {
  it("wraps in both directions", () => {
    expect(stepPane(tree(), "C", 1)).toBe("A");
    expect(stepPane(tree(), "A", -1)).toBe("C");
  });
});

describe("rects", () => {
  it("divides the space the way the splits say", () => {
    const all = rects(tree());
    expect(all.get("A")).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(all.get("B")).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
    expect(all.get("C")).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  });
});

describe("nudge", () => {
  const ratios = (node: LayoutNode): Record<string, number> => {
    const out: Record<string, number> = {};
    const walk = (n: LayoutNode) => {
      if (n.type === "pane") return;
      out[n.id] = n.ratio;
      walk(n.a);
      walk(n.b);
    };
    walk(node);
    return out;
  };

  it("moves the nearest divider running the right way", () => {
    // B is inside the vertical split s2, but pushing it right has to move s1 —
    // the horizontal one — because s2 has no left or right edge to give.
    const after = nudge(tree(), "B", "right", 0.1);
    expect(ratios(after).s1).toBeCloseTo(0.6);
    expect(ratios(after).s2).toBeCloseTo(0.5);
  });

  it("moves the divider, not the pane, whichever side the pane is on", () => {
    // Right is right for both of them: A grows, C shrinks, same key.
    expect(ratios(nudge(tree(), "A", "right", 0.1)).s1).toBeCloseTo(0.6);
    expect(ratios(nudge(tree(), "C", "right", 0.1)).s1).toBeCloseTo(0.6);
    expect(ratios(nudge(tree(), "A", "left", 0.1)).s1).toBeCloseTo(0.4);
  });

  it("pushes the stacked divider when the axis is vertical", () => {
    expect(ratios(nudge(tree(), "B", "down", 0.1)).s2).toBeCloseTo(0.6);
  });

  it("does nothing when there is no divider that way", () => {
    const only = makePane("A");
    expect(nudge(only, "A", "right", 0.1)).toBe(only);
  });
});

describe("dividers", () => {
  it("gives each split its boundary and its own rectangle", () => {
    const all = dividers(tree());
    expect(all.map((d) => d.id)).toEqual(["s1", "s2"]);
    // The outer split divides the window down the middle.
    expect(all[0]).toMatchObject({ dir: "row", at: 0.5, within: { x: 0, y: 0, w: 1, h: 1 } });
    // The inner one divides only the right half — and its `within` says so,
    // which is what stops a drag on it from being read against the whole window.
    expect(all[1]).toMatchObject({ dir: "col", at: 0.5, within: { x: 0.5, y: 0, w: 0.5, h: 1 } });
  });

  it("follows a ratio into the nested rectangle", () => {
    const all = dividers(setRatio(tree(), "s1", 0.25));
    expect(all[0]!.at).toBeCloseTo(0.25);
    expect(all[1]!.within).toMatchObject({ x: 0.25, w: 0.75 });
  });

  it("has none for a single pane", () => {
    expect(dividers(makePane("A"))).toEqual([]);
  });
});

describe("paneInDirection", () => {
  it("crosses a split to the nearest pane that shares an edge", () => {
    expect(paneInDirection(tree(), "B", "left")).toBe("A");
    expect(paneInDirection(tree(), "C", "left")).toBe("A");
    expect(paneInDirection(tree(), "B", "down")).toBe("C");
    expect(paneInDirection(tree(), "C", "up")).toBe("B");
  });

  it("says nothing rather than wrapping", () => {
    // The client turns a null here into focusing the sidebar. Wrapping would
    // send the focus across the window and look like a bug.
    expect(paneInDirection(tree(), "A", "left")).toBeNull();
    expect(paneInDirection(tree(), "B", "up")).toBeNull();
    expect(paneInDirection(tree(), "C", "right")).toBeNull();
  });

  it("picks the neighbour sharing the most edge when two are equally near", () => {
    // A | (B / C), but B is short: moving right from A should land on B, the
    // one whose top edge lines up with where the focus already is.
    const root: LayoutNode = {
      type: "split",
      id: "s1",
      dir: "row",
      ratio: 0.5,
      a: makePane("A"),
      b: { type: "split", id: "s2", dir: "col", ratio: 0.7, a: makePane("B"), b: makePane("C") },
    };
    expect(paneInDirection(root, "A", "right")).toBe("B");
  });
});
