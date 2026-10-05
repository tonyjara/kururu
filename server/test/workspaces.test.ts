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
import { BOARD_TAB, docTab, docsOf, findPane, panes, showingDoc } from "../../shared/layout";
import { Workspaces, nextColor, nextId, orderAgents } from "../src/workspaces";
import { LOGIN_KEY, WORKSPACE_COLORS, gatherGroups, groupName, type Profile } from "../../shared/model";

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
 * Groups of workspaces. The property that matters is the one the sidebar's
 * numbers rest on: every verb leaves each group's members side by side, so the
 * index a row prints is still the index prefix+1..9 jumps to.
 */
describe("workspace groups", () => {
  /** Four workspaces, a..d, and the names the list is in. */
  const four = () => {
    const workspaces = new Workspaces();
    workspaces.renameWorkspace(workspaces.activeWorkspace.id, "a");
    for (const name of ["b", "c", "d"]) workspaces.newWorkspace(name);
    const id = (name: string) => workspaces.active.workspaces.find((w) => w.name === name)!.id;
    const order = () => workspaces.active.workspaces.map((w) => `${w.name}${w.group ? `:${w.group}` : ""}`);
    return { workspaces, id, order };
  };

  it("gathers each group where its first member stands, and leaves loose ones be", () => {
    const list = [
      { n: 1, group: "x" },
      { n: 2, group: null },
      { n: 3, group: "y" },
      { n: 4, group: "x" },
      { n: 5, group: null },
    ];
    expect(gatherGroups(list).map((w) => w.n)).toEqual([1, 4, 2, 3, 5]);
  });

  it("starts a group in place, files into its end, and leaves just after it", () => {
    const { workspaces, id, order } = four();
    workspaces.setWorkspaceGroup(id("b"), "work");
    expect(order()).toEqual(["a", "b:work", "c", "d"]);
    workspaces.setWorkspaceGroup(id("d"), "work");
    expect(order()).toEqual(["a", "b:work", "d:work", "c"]);
    workspaces.setWorkspaceGroup(id("b"), null);
    expect(order()).toEqual(["a", "d:work", "b", "c"]);
  });

  it("cleans the name, and reads one with nothing in it as no group", () => {
    expect(groupName("  two\n words ")).toBe("two words");
    expect(groupName("   ")).toBeNull();
    expect(groupName(7)).toBeNull();
    expect(groupName("x".repeat(100))!.length).toBe(40);
  });

  it("renames a group on every member, merges onto a name in use, and disbands onto null", () => {
    const { workspaces, id, order } = four();
    workspaces.setWorkspaceGroup(id("a"), "one");
    workspaces.setWorkspaceGroup(id("b"), "two");
    workspaces.setWorkspaceGroup(id("c"), "two");
    workspaces.renameWorkspaceGroup("two", "three");
    expect(order()).toEqual(["a:one", "b:three", "c:three", "d"]);
    // The merged group stands where the first of the two did.
    workspaces.renameWorkspaceGroup("one", "three");
    expect(order()).toEqual(["a:three", "b:three", "c:three", "d"]);
    workspaces.renameWorkspaceGroup("three", null);
    expect(order()).toEqual(["a", "b", "c", "d"]);
  });

  it("moves a dragged workspace into the group of the row it was dropped on", () => {
    const { workspaces, id, order } = four();
    workspaces.setWorkspaceGroup(id("c"), "g");
    workspaces.setWorkspaceGroup(id("d"), "g");
    expect(order()).toEqual(["a", "b", "c:g", "d:g"]);
    workspaces.moveWorkspace(id("a"), 3);
    expect(order()).toEqual(["b", "c:g", "d:g", "a:g"]);
    workspaces.moveWorkspace(id("c"), 0);
    expect(order()).toEqual(["c", "b", "d:g", "a:g"]);
  });

  it("moves a whole group to a loose row's place or another group's, from either side", () => {
    const { workspaces, id, order } = four();
    workspaces.setWorkspaceGroup(id("b"), "x");
    workspaces.setWorkspaceGroup(id("c"), "x");
    expect(order()).toEqual(["a", "b:x", "c:x", "d"]);
    // Down past a loose one, then back up between two.
    workspaces.moveWorkspaceGroup("x", id("d"));
    expect(order()).toEqual(["a", "d", "b:x", "c:x"]);
    workspaces.moveWorkspaceGroup("x", id("a"));
    expect(order()).toEqual(["b:x", "c:x", "a", "d"]);
    // Onto another group, by any of its members.
    workspaces.setWorkspaceGroup(id("d"), "y");
    workspaces.moveWorkspaceGroup("x", id("d"));
    expect(order()).toEqual(["a", "d:y", "b:x", "c:x"]);
    // Onto itself, onto nothing, and as no group at all: nothing moves.
    for (const onto of [id("b"), "w-nope", 7]) workspaces.moveWorkspaceGroup("x", onto);
    workspaces.moveWorkspaceGroup(null, id("a"));
    expect(order()).toEqual(["a", "d:y", "b:x", "c:x"]);
  });

  it("refuses a position that is not a number", () => {
    const { workspaces, id, order } = four();
    workspaces.moveWorkspace(id("a"), Number.NaN);
    expect(order()).toEqual(["a", "b", "c", "d"]);
  });

  it("survives a restore that never heard of groups", () => {
    const { workspaces, id } = four();
    workspaces.setWorkspaceGroup(id("b"), "g");
    const blob = JSON.parse(JSON.stringify(workspaces.active)) as Profile;
    for (const w of blob.workspaces) delete (w as { group?: unknown }).group;
    const restored = new Workspaces([blob]);
    expect(restored.active.workspaces.every((w) => w.group === null)).toBe(true);
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
  const paneOf = (workspaces: Workspaces, id: string) => findPane(workspaces.activeWorkspace.layout, id)!;

  it("carries the project in at birth, so the picker has somewhere to open", () => {
    const workspaces = new Workspaces();
    const made = workspaces.openReader(workspaces.focusedPaneId, null, "/home/you/project")!;
    expect(paneOf(workspaces, made).reader).toMatchObject({ root: "/home/you/project", follow: null });
    expect(paneOf(workspaces, made).agentIds).toEqual([]);
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
    expect(showingDoc(paneOf(workspaces, made))).toEqual({ root: "/home/you/project", path: "docs/PLAN.md" });
    expect(paneOf(workspaces, made).reader).toMatchObject({ follow: null });
    expect(workspaces.readersFollowing("agent-1")).toHaveLength(0);
  });

  it("opens a document in any pane, as a tab after the one showing", () => {
    const workspaces = new Workspaces();
    const pane = workspaces.focusedPaneId;
    workspaces.addTab("a1", "/home/you/project", pane);
    expect(workspaces.openDoc(pane, "/home/you/project", "README.md")).toBe(true);
    expect(paneOf(workspaces, pane).agentIds).toEqual(["a1", docTab("/home/you/project", "README.md")]);
    expect(showingDoc(paneOf(workspaces, pane))?.path).toBe("README.md");
    expect(workspaces.agentsHere()).toEqual(["a1"]);
  });

  it("takes the screen for an editor's report only where a document is already showing", () => {
    const workspaces = new Workspaces();
    const made = workspaces.openReader(workspaces.focusedPaneId, "agent-1", "/p")!;
    const w = workspaces.activeWorkspace.id;
    workspaces.setReaderTarget(w, made, "/p", "a.md");
    expect(showingDoc(paneOf(workspaces, made))?.path).toBe("a.md");
    // A terminal dragged in and showing: the next report lands behind it.
    workspaces.moveTab("a2", made);
    workspaces.setReaderTarget(w, made, "/p", "b.md");
    expect(paneOf(workspaces, made).agentIds).toEqual([docTab("/p", "a.md"), "a2", docTab("/p", "b.md")]);
    expect(paneOf(workspaces, made).activeIdx).toBe(1);
    expect(paneOf(workspaces, made).reader).toMatchObject({ follow: "agent-1" });
  });
});

/**
 * Documents as tabs: one per document per pane, in any pane beside terminals
 * and the board, and the pane goes with its last tab — plus the follow button,
 * which used to forget the editor the moment it was pinned and so could never
 * unpin.
 */
describe("document tabs", () => {
  const ROOT = "/home/you/project";
  const paneOf = (workspaces: Workspaces, id: string) => findPane(workspaces.activeWorkspace.layout, id) ?? undefined;
  const paths = (workspaces: Workspaces, id: string) => {
    const pane = paneOf(workspaces, id);
    return pane ? docsOf(pane).map((doc) => doc.path) : undefined;
  };
  const shown = (workspaces: Workspaces, id: string) => {
    const pane = paneOf(workspaces, id);
    return pane ? showingDoc(pane)?.path : undefined;
  };

  it("opens each document as a tab after the one showing, and never twice", () => {
    const workspaces = new Workspaces();
    const made = workspaces.showDoc(ROOT, "a.md")!;
    workspaces.showDoc(ROOT, "b.md");
    workspaces.selectDoc(made, 0);
    workspaces.showDoc(ROOT, "c.md");
    workspaces.showDoc(ROOT, "b.md");
    expect(paths(workspaces, made)).toEqual(["a.md", "c.md", "b.md"]);
    expect(shown(workspaces, made)).toBe("b.md");
    // Every click landed in the one pane rather than tiling the window.
    expect(panes(workspaces.activeWorkspace.layout).filter((p) => docsOf(p).length > 0)).toHaveLength(1);
  });

  it("shows the neighbour when the showing tab closes, and closes the pane with the last", () => {
    const workspaces = new Workspaces();
    const made = workspaces.showDoc(ROOT, "a.md")!;
    workspaces.showDoc(ROOT, "b.md");
    workspaces.showDoc(ROOT, "c.md");
    workspaces.selectDoc(made, 1);
    workspaces.closeDoc(made, 1);
    expect(shown(workspaces, made)).toBe("a.md");
    workspaces.closeDoc(made, 1);
    expect(shown(workspaces, made)).toBe("a.md");
    workspaces.closeDoc(made, 0);
    expect(paneOf(workspaces, made)).toBeUndefined();
  });

  it("ignores an index that is not a document", () => {
    const workspaces = new Workspaces();
    const made = workspaces.showDoc(ROOT, "a.md")!;
    workspaces.moveTab("a1", made);
    workspaces.closeDoc(made, 5);
    workspaces.selectDoc(made, 5);
    workspaces.closeDoc(made, 1);
    expect(paneOf(workspaces, made)?.agentIds).toEqual([docTab(ROOT, "a.md"), "a1"]);
  });

  it("remembers the editor through a pin, so following again has somebody to follow", () => {
    const workspaces = new Workspaces();
    const made = workspaces.openReader(workspaces.focusedPaneId, "agent-1", ROOT)!;
    workspaces.pinReader(made, false);
    expect(paneOf(workspaces, made)?.reader).toMatchObject({ follow: null, editor: "agent-1" });
    workspaces.pinReader(made, true);
    expect(paneOf(workspaces, made)?.reader).toMatchObject({ follow: "agent-1" });
  });

  it("has nobody to follow when it was opened from the tree", () => {
    const workspaces = new Workspaces();
    const made = workspaces.showDoc(ROOT, "a.md")!;
    workspaces.pinReader(made, true);
    expect(paneOf(workspaces, made)?.reader?.follow ?? null).toBeNull();
  });

  it("reorders along its own strip, the index read as where the tab was dropped", () => {
    const workspaces = new Workspaces();
    const made = workspaces.showDoc(ROOT, "a.md")!;
    workspaces.showDoc(ROOT, "b.md");
    workspaces.showDoc(ROOT, "c.md");
    // a dropped on the insertion line after c.
    workspaces.moveDoc(made, 0, made, 3);
    expect(paths(workspaces, made)).toEqual(["b.md", "c.md", "a.md"]);
    expect(shown(workspaces, made)).toBe("a.md");
    workspaces.moveDoc(made, 2, made, 0);
    expect(paths(workspaces, made)).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("moves a tab into another pane, and closes the one it emptied", () => {
    const workspaces = new Workspaces();
    const one = workspaces.showDoc(ROOT, "a.md")!;
    workspaces.showDoc(ROOT, "b.md");
    workspaces.splitWithDoc(one, 1, one, "row", false);
    const two = workspaces.focusedPaneId;
    expect(two).not.toBe(one);
    expect(paths(workspaces, one)).toEqual(["a.md"]);
    expect(paths(workspaces, two)).toEqual(["b.md"]);
    workspaces.moveDoc(one, 0, two, 0);
    expect(paths(workspaces, two)).toEqual(["a.md", "b.md"]);
    expect(shown(workspaces, two)).toBe("a.md");
    expect(paneOf(workspaces, one)).toBeUndefined();
  });

  it("goes into the strip of a pane with the board and terminals in it, and back out", () => {
    const workspaces = new Workspaces();
    const home = workspaces.focusedPaneId;
    workspaces.addTab("a1", ROOT, home);
    workspaces.openBoard(home, true);
    const reader = workspaces.showDoc(ROOT, "spec.md")!;
    expect(reader).not.toBe(home);

    workspaces.moveDoc(reader, 0, home, 1);
    expect(paneOf(workspaces, home)?.agentIds).toEqual(["a1", docTab(ROOT, "spec.md"), BOARD_TAB]);
    expect(shown(workspaces, home)).toBe("spec.md");
    expect(paneOf(workspaces, reader)).toBeUndefined();
    // Nothing that treats a tab as a process sees it.
    expect(workspaces.agentsHere()).toEqual(["a1"]);
    expect(workspaces.closePane(home)).toEqual(["a1"]);
  });

  it("takes a terminal into a pane of documents", () => {
    const workspaces = new Workspaces();
    const home = workspaces.focusedPaneId;
    workspaces.addTab("a1", ROOT, home);
    const reader = workspaces.showDoc(ROOT, "a.md")!;
    workspaces.moveTab("a1", reader);
    expect(paneOf(workspaces, reader)?.agentIds).toEqual([docTab(ROOT, "a.md"), "a1"]);
    expect(paneOf(workspaces, home)).toBeUndefined();
  });

  it("splits beside any pane, and refuses to split a pane off its only tab", () => {
    const workspaces = new Workspaces();
    const terminal = workspaces.focusedPaneId;
    const made = workspaces.showDoc(ROOT, "a.md")!;
    const before = workspaces.activeWorkspace.layout;
    workspaces.splitWithDoc(made, 0, made, "col", false);
    expect(workspaces.activeWorkspace.layout).toBe(before);
    workspaces.splitWithDoc(made, 0, terminal, "col", true);
    const all = panes(workspaces.activeWorkspace.layout);
    expect(all.flatMap((p) => docsOf(p).map((d) => d.path))).toEqual(["a.md"]);
    expect(all.find((p) => p.id === made)).toBeUndefined();
  });

  it("pours any pane into any other, a document already there not brought twice", () => {
    const workspaces = new Workspaces();
    const terminal = workspaces.focusedPaneId;
    workspaces.addTab("a1", ROOT, terminal);
    const one = workspaces.showDoc(ROOT, "a.md")!;
    workspaces.showDoc(ROOT, "b.md");
    workspaces.splitWithDoc(one, 1, one, "row", false);
    const two = workspaces.focusedPaneId;
    workspaces.showDoc(ROOT, "a.md");
    workspaces.mergePanes(one, two);
    expect(paneOf(workspaces, one)).toBeUndefined();
    expect(paths(workspaces, two)).toEqual(["b.md", "a.md"]);
    workspaces.mergePanes(two, terminal);
    expect(paneOf(workspaces, terminal)?.agentIds).toEqual(["a1", docTab(ROOT, "b.md"), docTab(ROOT, "a.md")]);
  });

  it("refuses a document through the verbs that address a tab by id", () => {
    const workspaces = new Workspaces();
    const made = workspaces.showDoc(ROOT, "a.md")!;
    const other = workspaces.split("row")!;
    const before = workspaces.activeWorkspace.layout;
    workspaces.moveTab(docTab(ROOT, "a.md"), other);
    workspaces.splitWith(docTab(ROOT, "a.md"), other, "row", false);
    expect(workspaces.activeWorkspace.layout).toBe(before);
    expect(paths(workspaces, made)).toEqual(["a.md"]);
  });

  it("lands a file dropped from the tree where it was dropped, or in a pane of its own", () => {
    const workspaces = new Workspaces();
    const home = workspaces.focusedPaneId;
    workspaces.addTab("a1", ROOT, home);
    workspaces.openBoard(home, true);
    workspaces.openDoc(home, ROOT, "a.md", 1);
    expect(paneOf(workspaces, home)?.agentIds).toEqual(["a1", docTab(ROOT, "a.md"), BOARD_TAB]);
    // Dropped again further along: it moves rather than doubling.
    workspaces.openDoc(home, ROOT, "a.md", 3);
    expect(paneOf(workspaces, home)?.agentIds).toEqual(["a1", BOARD_TAB, docTab(ROOT, "a.md")]);
    workspaces.splitWithFile(ROOT, "b.md", home, "row", true);
    const [left, right] = panes(workspaces.activeWorkspace.layout);
    expect(left!.agentIds).toEqual([docTab(ROOT, "b.md")]);
    expect(right!.id).toBe(home);
    expect(workspaces.focusedPaneId).toBe(left!.id);
  });

  it("pins a following reader when a different document is picked from its strip", () => {
    const workspaces = new Workspaces();
    const made = workspaces.openReader(workspaces.focusedPaneId, "agent-1", ROOT)!;
    const w = workspaces.activeWorkspace.id;
    workspaces.setReaderTarget(w, made, ROOT, "a.md");
    workspaces.setReaderTarget(w, made, ROOT, "b.md");
    workspaces.selectDoc(made, 1);
    expect(paneOf(workspaces, made)?.reader?.follow).toBe("agent-1");
    workspaces.selectDoc(made, 0);
    expect(paneOf(workspaces, made)?.reader?.follow).toBeNull();
  });
});

/**
 * What a terminal ending does to the arrangement it was in. `removeTab` is the
 * gesture — close this tab, keep the pane, it is a place you are keeping —
 * and `reapTab` is the pty being gone, which takes the pane with it unless
 * something else is left in there. The refusals are the interesting half: a
 * workspace must keep a pane to focus, and a pane with a document or the board
 * still in it is not a hole.
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


describe("loginKey", () => {
  it("is minted for a new profile, and for one that arrived without", () => {
    const workspaces = new Workspaces();
    expect(workspaces.active.loginKey).toMatch(LOGIN_KEY);
    const bare = { ...workspaces.active, loginKey: undefined } as unknown as Profile;
    const restored = new Workspaces([bare]);
    expect(restored.active.loginKey).toMatch(LOGIN_KEY);
    expect(restored.active.loginKey).not.toBe(workspaces.active.loginKey);
  });

  it("keeps the one a blob carries and replaces one that is not a key", () => {
    const base = new Workspaces().active;
    expect(new Workspaces([{ ...base, loginKey: "0123456789ab" }]).active.loginKey).toBe("0123456789ab");
    const swapped = new Workspaces([{ ...base, loginKey: "../../etc" }]).active.loginKey;
    expect(swapped).toMatch(LOGIN_KEY);
  });

  it("is what summaries hand to the directory lookup, and carry themselves", () => {
    const workspaces = new Workspaces();
    const [summary] = workspaces.summaries(() => 0, (key) => `/profiles/${key}`);
    expect(summary!.loginDir).toBe(`/profiles/${workspaces.active.loginKey}`);
    expect(summary!.loginKey).toBe(workspaces.active.loginKey);
  });
});

describe("setProfileLogin", () => {
  it("points a profile at another's key, so the two share a directory", () => {
    const workspaces = new Workspaces();
    const a = workspaces.active.id;
    const b = workspaces.newProfile("b");
    const shared = workspaces.all().find((p) => p.id === a)!.loginKey;
    workspaces.setProfileLogin(b, shared);
    expect(workspaces.all().map((p) => p.loginKey)).toEqual([shared, shared]);
  });

  it("mints a fresh key for null, and leaves the old directory's key behind", () => {
    const workspaces = new Workspaces();
    const before = workspaces.active.loginKey;
    workspaces.setProfileLogin(workspaces.active.id, null);
    expect(workspaces.active.loginKey).toMatch(LOGIN_KEY);
    expect(workspaces.active.loginKey).not.toBe(before);
  });

  it("refuses a key that is not one, and an unknown profile", () => {
    const workspaces = new Workspaces();
    const before = workspaces.active.loginKey;
    workspaces.setProfileLogin(workspaces.active.id, "../../etc");
    workspaces.setProfileLogin("p999", "0123456789ab");
    expect(workspaces.active.loginKey).toBe(before);
  });

  it("is not a change when the key is the one already held", () => {
    const workspaces = new Workspaces();
    let changes = 0;
    workspaces.onChange = () => changes++;
    workspaces.setProfileLogin(workspaces.active.id, workspaces.active.loginKey);
    expect(changes).toBe(0);
  });
});
