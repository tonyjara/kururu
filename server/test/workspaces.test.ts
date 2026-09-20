/**
 * The arrangement, at the one point where it answers a question rather than just
 * holding a tree: `split` says which pane it made, and the caller opens a
 * terminal in that pane. A pane id for a split that did not happen would put a
 * terminal somewhere nothing is pointing at, so it is worth pinning down.
 *
 * Nothing here touches a pty. `Workspaces` imports the tree and the model and
 * nothing else, which is what makes it testable at all.
 */
import { describe, expect, it } from "bun:test";
import { panes } from "../../shared/layout";
import { Workspaces, nextColor, nextId, orderAgents } from "../src/workspaces";
import { WORKSPACE_COLORS } from "../../shared/model";

describe("split", () => {
  it("returns the pane it made, and it is in the tree", () => {
    const workspaces = new Workspaces();
    const fresh = workspaces.split("row");
    expect(fresh).not.toBeNull();
    expect(panes(workspaces.activeWorkspace.layout).map((p) => p.id)).toContain(fresh!);
    expect(workspaces.focusedPaneId).toBe(fresh!);
  });

  it("says nothing was made when there is no such pane to divide", () => {
    const workspaces = new Workspaces();
    const before = panes(workspaces.activeWorkspace.layout).length;
    expect(workspaces.split("row", "no-such-pane")).toBeNull();
    expect(panes(workspaces.activeWorkspace.layout)).toHaveLength(before);
  });
});

describe("hasPane", () => {
  it("follows a pane in and out of the workspace on screen", () => {
    const workspaces = new Workspaces();
    const fresh = workspaces.split("col")!;
    expect(workspaces.hasPane(fresh)).toBe(true);
    workspaces.closePane(fresh);
    expect(workspaces.hasPane(fresh)).toBe(false);
  });

  it("is false for a pane in a workspace you are not in", () => {
    const workspaces = new Workspaces();
    const here = workspaces.focusedPaneId;
    workspaces.newWorkspace("elsewhere");
    expect(workspaces.hasPane(here)).toBe(false);
  });
});

/**
 * The colour tag is the one field a client sets to a value that ends up inside a
 * style attribute, and kururu is reachable from the tailnet. So what it refuses
 * matters more than what it accepts, and refusing has to mean *leaving it alone*
 * rather than clearing it — a rejected write that silently untagged a workspace
 * would look like the feature not working rather than like a rejected write.
 */
describe("setWorkspaceColor", () => {
  it("tags a workspace, and unsets it with null", () => {
    const workspaces = new Workspaces();
    const id = workspaces.activeWorkspace.id;

    workspaces.setWorkspaceColor(id, "violet");
    expect(workspaces.activeWorkspace.color).toBe("violet");

    workspaces.setWorkspaceColor(id, null);
    expect(workspaces.activeWorkspace.color).toBeNull();
  });

  it("refuses anything that is not in the palette, and keeps what was there", () => {
    const workspaces = new Workspaces();
    const id = workspaces.activeWorkspace.id;
    workspaces.setWorkspaceColor(id, "violet");

    // `crimson` rather than `red`, which this list used to carry and which is a
    // real tag now. The point of the case is a CSS colour word the palette does
    // not name, and the palette grew into the old example.
    for (const junk of ["crimson", "#ff0000", "url(javascript:0)", "", 7, {}, undefined]) {
      workspaces.setWorkspaceColor(id, junk);
      expect(workspaces.activeWorkspace.color).toBe("violet");
    }
  });

  it("does nothing at all for a workspace that is not there", () => {
    const workspaces = new Workspaces();
    const had = workspaces.activeWorkspace.color;
    workspaces.setWorkspaceColor("w-nope", "cyan");
    expect(workspaces.activeWorkspace.color).toBe(had);
  });
});

/**
 * The colour a new workspace is born with.
 *
 * The interesting property is not which colour comes out — it is random on
 * purpose — but that it does not repeat while there is anything left to repeat
 * with. That is the whole reason this is a function rather than one line inside
 * `blankWorkspace`, and it is the one part of it a test can hold.
 */
describe("nextColor", () => {
  it("gives a new workspace a colour rather than leaving it blank", () => {
    const workspaces = new Workspaces();
    const id = workspaces.newWorkspace("second");
    const color = workspaces.active.workspaces.find((w) => w.id === id)?.color;
    expect(WORKSPACE_COLORS).toContain(color!);
  });

  it("never repeats while the palette has anything left", () => {
    const workspaces = new Workspaces();
    for (let i = 0; i < WORKSPACE_COLORS.length - 1; i++) workspaces.newWorkspace(`ws${i}`);
    const worn = workspaces.active.workspaces.map((w) => w.color);
    expect(worn.length).toBe(WORKSPACE_COLORS.length);
    expect(new Set(worn).size).toBe(WORKSPACE_COLORS.length);
  });

  it("takes the one colour left when every other is taken", () => {
    const taken = WORKSPACE_COLORS.filter((c) => c !== "blush");
    expect(nextColor(taken)).toBe("blush");
  });

  /**
   * Past the end of the palette it starts again rather than giving up, and it
   * starts with the colours used once rather than with the ones used twice.
   */
  it("spreads the second time round too", () => {
    const twice = [...WORKSPACE_COLORS, ...WORKSPACE_COLORS.filter((c) => c !== "cyan")];
    expect(nextColor(twice)).toBe("cyan");
  });

  /** An untagged workspace is not a colour and does not push the next one. */
  it("ignores the ones nobody tagged", () => {
    const taken = [...WORKSPACE_COLORS.filter((c) => c !== "sand"), null, null, null];
    expect(nextColor(taken)).toBe("sand");
  });
});

/**
 * Where the counter is right now, which a test cannot assume: `seq` is
 * module-level and every `Workspaces` built above has already moved it.
 */
function counterAt(): number {
  return Number(/(\d+)$/.exec(nextId("probe"))![1]);
}

/**
 * Rewrite every id in an arrangement to run upward from `from`, references and
 * all, by renaming the tokens in its JSON.
 *
 * This is how a *fresh process* is simulated in a test that shares one counter
 * with everything before it. The bug is that a new server starts at zero while
 * the host's blob already holds `n1`, `w2`, `p3` — so what has to be reproduced
 * is not a particular number but the overlap: a blob holding precisely the ids
 * this process is about to hand out next.
 *
 * Rewriting the serialized form rather than walking the tree is deliberate.
 * `focusedPaneId` and `activeWorkspaceId` are the same token as the id they
 * point at, so replacing tokens keeps them pointing at the right thing — and a
 * test that had to know which fields are references would be a test that goes
 * stale the day one is added.
 */
function renumber(profiles: unknown, from: number): never[] {
  const seen = new Map<string, string>();
  let n = from;
  const json = JSON.stringify(profiles).replace(/"([a-z])(\d+)"/g, (_whole, prefix: string, num: string) => {
    const key = `${prefix}${num}`;
    if (!seen.has(key)) seen.set(key, `${prefix}${n++}`);
    return `"${seen.get(key)}"`;
  });
  return JSON.parse(json);
}

/** Every id in an arrangement, so a test can look for one used twice. */
function allIds(workspaces: Workspaces): string[] {
  const out: string[] = [];
  const walk = (node: any): void => {
    if (node.type === "pane") out.push(node.pane.id);
    else {
      out.push(node.id);
      walk(node.a);
      walk(node.b);
    }
  };
  for (const profile of workspaces.all()) {
    out.push(profile.id);
    for (const workspace of profile.workspaces) {
      out.push(workspace.id);
      walk(workspace.layout);
    }
  }
  return out;
}

/**
 * The id counter across a restart, which is the one thing about `adopt` that is
 * not about a missing field.
 *
 * `persist.ts` mints every id as it rebuilds a stored tree, so the disk path
 * walks the counter past its own work for free. The host's blob does not: it is
 * the arrangement exactly as the last server left it, handed over whole, and a
 * new process starting at zero will mint `n1` for a layout that already has one.
 * Nothing throws — a duplicate is a perfectly good string — and the symptom is
 * two panes in one workspace answering to one id, where `findPane` takes
 * whichever comes first and focusing or closing acts on the wrong pane.
 */
describe("the id counter across a restart", () => {
  it("starts above every id the blob already holds", () => {
    const fresh = new Workspaces();
    const blob = renumber(fresh.all(), 9000);

    new Workspaces(blob);
    expect(counterAt()).toBeGreaterThan(9000);
  });

  it("does not hand out an id the restored arrangement is using", () => {
    // A blob holding exactly what this process would mint next, which is what a
    // server that has just restarted is looking at.
    const blob = renumber(new Workspaces().all(), counterAt() + 1);
    const restored = new Workspaces(blob);
    const before = allIds(restored);

    // Now do what the previous server would have gone on doing.
    restored.split("row");
    restored.split("col");
    restored.newWorkspace("second");
    restored.split("row");
    restored.newProfile("second");

    const after = allIds(restored);
    expect(new Set(after).size).toBe(after.length);
    // And the restored ids are all still there, rather than having been
    // repaired by renaming somebody's live arrangement out from under them.
    for (const id of before) expect(after).toContain(id);
  });

  it("leaves the disk path alone, where the counter is already past its work", () => {
    // `persist.ts` mints as it revives, so a restore from disk arrives with ids
    // below the counter and this must not push it anywhere.
    const fresh = new Workspaces();
    const at = counterAt();
    new Workspaces(renumber(fresh.all(), 1));
    // Only the probe above moved it: `adoptSeq` found nothing higher than it
    // already was, which is what a disk restore always looks like.
    expect(counterAt()).toBe(at + 1);
  });
});

describe("adopting a restored profile", () => {
  it("fills in a colour a previous version of the server never wrote", () => {
    // The host's blob, as an older server left it: no `color` anywhere.
    const before = new Workspaces();
    const stale = JSON.parse(JSON.stringify(before.all()), (key, value) =>
      key === "color" ? undefined : value,
    );
    expect(stale[0].workspaces[0]).not.toHaveProperty("color");

    const after = new Workspaces(stale);
    expect(after.activeWorkspace.color).toBeNull();
  });
});

/**
 * The way back to the other pane — the phone's whole navigation between two
 * agents, since a narrow window draws one pane at a time.
 */
describe("lastPane", () => {
  it("is the other one when there are two, with nothing remembered yet", () => {
    const workspaces = new Workspaces();
    const first = workspaces.focusedPaneId;
    const second = workspaces.split("row", first)!;
    expect(workspaces.focusedPaneId).toBe(second);
    workspaces.lastPane();
    expect(workspaces.focusedPaneId).toBe(first);
    // And back, which is what makes it a toggle rather than a walk.
    workspaces.lastPane();
    expect(workspaces.focusedPaneId).toBe(second);
  });

  it("goes between the two you are in and leaves the third where it is", () => {
    const workspaces = new Workspaces();
    const a = workspaces.focusedPaneId;
    const b = workspaces.split("row", a)!;
    const c = workspaces.split("col", b)!;
    workspaces.focusPane(a);
    workspaces.focusPane(c);
    workspaces.lastPane();
    expect(workspaces.focusedPaneId).toBe(a);
    workspaces.lastPane();
    expect(workspaces.focusedPaneId).toBe(c);
    // b was never in the pair, and a toggle must not wander into it.
    expect(workspaces.focusedPaneId).not.toBe(b);
  });

  it("steps on rather than doing nothing when the pane it remembers has gone", () => {
    const workspaces = new Workspaces();
    const a = workspaces.focusedPaneId;
    const b = workspaces.split("row", a)!;
    const c = workspaces.split("col", b)!;
    // Focus is on c, having come from b. Close b and the memory names nothing.
    workspaces.closePane(b);
    expect(workspaces.activeWorkspace.lastPaneId).toBe(b);
    workspaces.lastPane();
    expect(workspaces.focusedPaneId).toBe(a);
  });

  it("does nothing at all with one pane", () => {
    const workspaces = new Workspaces();
    const only = workspaces.focusedPaneId;
    workspaces.lastPane();
    expect(workspaces.focusedPaneId).toBe(only);
  });
});

/**
 * The reader, at the two points where picking a file by hand differs from
 * following an editor: the project it opens on, and what happens to the follow.
 */
describe("the reader", () => {
  it("carries the project in at birth, so the picker has somewhere to open", () => {
    const workspaces = new Workspaces();
    const made = workspaces.openReader(workspaces.focusedPaneId, null, "/home/you/project")!;
    const reader = panes(workspaces.activeWorkspace.layout).find((p) => p.id === made)?.reader;
    expect(reader).toMatchObject({ root: "/home/you/project", path: "", follow: null });
  });

  it("leaves the focus where it was — the caller decides whether to move it", () => {
    const workspaces = new Workspaces();
    const from = workspaces.focusedPaneId;
    const made = workspaces.openReader(from, null)!;
    expect(workspaces.focusedPaneId).toBe(from);
    workspaces.focusPane(made);
    expect(workspaces.focusedPaneId).toBe(made);
  });

  it("stops following when a file is picked, so a save elsewhere cannot take it away", () => {
    const workspaces = new Workspaces();
    const made = workspaces.openReader(workspaces.focusedPaneId, "agent-1")!;
    expect(workspaces.readersFollowing("agent-1")).toHaveLength(1);

    expect(workspaces.openDoc(made, "/home/you/project", "docs/PLAN.md")).toBe(true);
    const reader = panes(workspaces.activeWorkspace.layout).find((p) => p.id === made)?.reader;
    expect(reader).toMatchObject({ root: "/home/you/project", path: "docs/PLAN.md", follow: null });
    expect(workspaces.readersFollowing("agent-1")).toHaveLength(0);
  });

  it("does nothing to a pane that is not a reader", () => {
    const workspaces = new Workspaces();
    expect(workspaces.openDoc(workspaces.focusedPaneId, "/home/you/project", "README.md")).toBe(false);
  });
});

/**
 * What a terminal ending does to the arrangement it was in. `removeTab` is the
 * gesture — close this tab, keep the pane, it is a place you are keeping —
 * and `reapTab` is the pty being gone, which takes the pane with it unless
 * something else is left in there. The two refusals are the interesting half:
 * a workspace must keep a pane to focus, and a reader is not a hole.
 */
describe("reapTab", () => {
  it("takes the pane with the tab when there is nothing else in it", () => {
    const workspaces = new Workspaces();
    const first = workspaces.focusedPaneId;
    const second = workspaces.split("row")!;
    workspaces.addTab("a1", "/home/you/project", first);
    workspaces.addTab("a2", "/home/you/project", second);

    workspaces.reapTab("a2");
    expect(panes(workspaces.activeWorkspace.layout).map((p) => p.id)).toEqual([first]);
    expect(workspaces.focusedPaneId).toBe(first);
  });

  it("leaves a pane that still has a tab in it", () => {
    const workspaces = new Workspaces();
    const pane = workspaces.focusedPaneId;
    workspaces.split("row");
    workspaces.addTab("a1", "/home/you/project", pane);
    workspaces.addTab("a2", "/home/you/project", pane);

    workspaces.reapTab("a1");
    expect(panes(workspaces.activeWorkspace.layout)).toHaveLength(2);
    expect(workspaces.agentsHere()).toEqual(["a2"]);
  });

  /**
   * The last pane is emptied rather than removed, which is `closePane`'s own
   * rule: a workspace with no panes has nothing to focus and nothing to aim an
   * action at. What is left is the empty pane, which is the button that opens
   * the next terminal.
   */
  it("keeps the last pane of a workspace, emptied", () => {
    const workspaces = new Workspaces();
    const only = workspaces.focusedPaneId;
    workspaces.addTab("a1", "/home/you/project", only);

    workspaces.reapTab("a1");
    expect(panes(workspaces.activeWorkspace.layout).map((p) => p.id)).toEqual([only]);
    expect(workspaces.agentsHere()).toEqual([]);
  });

  it("reaches a terminal in a workspace you are not looking at", () => {
    const workspaces = new Workspaces();
    const there = workspaces.focusedPaneId;
    const gone = workspaces.split("row")!;
    workspaces.addTab("a1", "/home/you/project", there);
    workspaces.addTab("a2", "/home/you/project", gone);
    const away = workspaces.newWorkspace("elsewhere");

    workspaces.reapTab("a2");
    expect(workspaces.activeWorkspace.id).toBe(away);
    expect(workspaces.allAgents()).toEqual(["a1"]);
  });

  it("is nothing at all for a terminal no pane is showing", () => {
    const workspaces = new Workspaces();
    workspaces.split("row");
    const before = JSON.stringify(workspaces.activeWorkspace.layout);
    workspaces.reapTab("a9");
    expect(JSON.stringify(workspaces.activeWorkspace.layout)).toBe(before);
  });
});

/**
 * The sidebar's list, which is the one thing here that is an order rather than a
 * tree. Spawn order is the default and a drag is a memory laid over it, so the
 * interesting cases are all about what happens when the two disagree: a terminal
 * that started after the drag, and one in the memory that has since been killed.
 */
describe("orderAgents", () => {
  it("is spawn order until something has been dragged", () => {
    expect(orderAgents(["a", "b", "c"], [])).toEqual(["a", "b", "c"]);
  });

  it("puts what was dragged first and everything spawned since behind it", () => {
    expect(orderAgents(["a", "b", "c", "d"], ["c", "a"])).toEqual(["c", "a", "b", "d"]);
  });

  it("skips a remembered id nothing answers to, rather than drawing a dead row", () => {
    expect(orderAgents(["a", "c"], ["c", "b", "a"])).toEqual(["c", "a"]);
  });
});

describe("reorderAgent", () => {
  /** A profile with three terminals in it, in the order they were spawned. */
  const three = (): { workspaces: Workspaces; ids: string[] } => {
    const workspaces = new Workspaces();
    const ids = ["a1", "a2", "a3"];
    for (const id of ids) workspaces.addTab(id, "/home/you/project");
    return { workspaces, ids };
  };

  it("puts a terminal above the row it was dropped on", () => {
    const { workspaces, ids } = three();
    workspaces.reorderAgent("a3", "a1", ids);
    expect(orderAgents(ids, workspaces.active.agentOrder)).toEqual(["a3", "a1", "a2"]);
  });

  it("puts it last when there is nothing below the row it was dropped on", () => {
    const { workspaces, ids } = three();
    workspaces.reorderAgent("a1", null, ids);
    expect(orderAgents(ids, workspaces.active.agentOrder)).toEqual(["a2", "a3", "a1"]);
  });

  it("moves nothing: the terminal stays in the pane it was in", () => {
    const { workspaces, ids } = three();
    const pane = workspaces.focusedPaneId;
    workspaces.reorderAgent("a3", "a1", ids);
    expect(panes(workspaces.activeWorkspace.layout).find((p) => p.id === pane)?.agentIds).toEqual(ids);
  });

  it("leaves the order alone when a row is dropped on itself", () => {
    const { workspaces, ids } = three();
    workspaces.reorderAgent("a2", "a2", ids);
    expect(workspaces.active.agentOrder).toEqual([]);
  });

  it("ignores a terminal this profile does not hold", () => {
    const { workspaces, ids } = three();
    workspaces.reorderAgent("nobody", "a1", ids);
    expect(orderAgents(ids, workspaces.active.agentOrder)).toEqual(ids);
  });
});

/**
 * Putting a row away, which is the one verb in here that is about the sidebar's
 * list and about nothing else. So the tests that matter are the ones that check
 * it is about nothing else: the tab is where it was, and the second client's
 * message arriving after the first one won is not an error.
 */
describe("setAgentHidden", () => {
  const three = (): { workspaces: Workspaces; ids: string[] } => {
    const workspaces = new Workspaces();
    const ids = ["a1", "a2", "a3"];
    for (const id of ids) workspaces.addTab(id, "/home/you/project");
    return { workspaces, ids };
  };

  it("puts a terminal away and brings it back", () => {
    const { workspaces } = three();
    workspaces.setAgentHidden("a2", true);
    expect(workspaces.active.hiddenAgents).toEqual(["a2"]);
    workspaces.setAgentHidden("a2", false);
    expect(workspaces.active.hiddenAgents).toEqual([]);
  });

  it("holds a terminal in the list once, however many clients ask", () => {
    const { workspaces } = three();
    workspaces.setAgentHidden("a2", true);
    workspaces.setAgentHidden("a2", true);
    expect(workspaces.active.hiddenAgents).toEqual(["a2"]);
  });

  it("is not an error to show one that was never put away", () => {
    const { workspaces } = three();
    workspaces.setAgentHidden("a1", false);
    expect(workspaces.active.hiddenAgents).toEqual([]);
  });

  it("moves nothing: the tab is in the pane it was in", () => {
    const { workspaces, ids } = three();
    const pane = workspaces.focusedPaneId;
    workspaces.setAgentHidden("a2", true);
    expect(panes(workspaces.activeWorkspace.layout).find((p) => p.id === pane)?.agentIds).toEqual(ids);
  });

  it("ignores a terminal this profile does not hold", () => {
    const { workspaces } = three();
    workspaces.setAgentHidden("nobody", true);
    expect(workspaces.active.hiddenAgents).toEqual([]);
  });
});
