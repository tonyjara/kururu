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
import { Workspaces, nextId, orderAgents } from "../src/workspaces";

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
    expect(workspaces.activeWorkspace.color).toBeNull();

    workspaces.setWorkspaceColor(id, "violet");
    expect(workspaces.activeWorkspace.color).toBe("violet");

    workspaces.setWorkspaceColor(id, null);
    expect(workspaces.activeWorkspace.color).toBeNull();
  });

  it("refuses anything that is not in the palette, and keeps what was there", () => {
    const workspaces = new Workspaces();
    const id = workspaces.activeWorkspace.id;
    workspaces.setWorkspaceColor(id, "violet");

    for (const junk of ["red", "#ff0000", "url(javascript:0)", "", 7, {}, undefined]) {
      workspaces.setWorkspaceColor(id, junk);
      expect(workspaces.activeWorkspace.color).toBe("violet");
    }
  });

  it("does nothing at all for a workspace that is not there", () => {
    const workspaces = new Workspaces();
    workspaces.setWorkspaceColor("w-nope", "cyan");
    expect(workspaces.activeWorkspace.color).toBeNull();
  });

  it("gives a new workspace no colour rather than one off the shelf", () => {
    const workspaces = new Workspaces();
    const id = workspaces.newWorkspace("second");
    expect(workspaces.active.workspaces.find((w) => w.id === id)?.color).toBeNull();
  });
});

describe("setProfileIdentity", () => {
  it("lands on the profile named, not on the one you are standing in", () => {
    const workspaces = new Workspaces();
    const here = workspaces.active.id;
    const there = workspaces.newProfile("work");
    workspaces.switchProfile(here);

    workspaces.setProfileIdentity(there, {
      claudeConfigDir: "/w/claude",
      ghConfigDir: null,
      gitConfigGlobal: null,
    });

    expect(workspaces.active.id).toBe(here);
    expect(workspaces.identityOf(there).claudeConfigDir).toBe("/w/claude");
    expect(workspaces.identityOf(here).claudeConfigDir).toBeNull();
  });

  it("is carried on the summaries, which is how Settings can edit all of them", () => {
    const workspaces = new Workspaces();
    const id = workspaces.active.id;
    workspaces.setProfileIdentity(id, {
      claudeConfigDir: null,
      ghConfigDir: "/w/gh",
      gitConfigGlobal: null,
    });
    expect(workspaces.summaries(() => 0)[0]?.identity.ghConfigDir).toBe("/w/gh");
  });

  it("ignores a profile that is not there rather than inventing one", () => {
    const workspaces = new Workspaces();
    workspaces.setProfileIdentity("nope", {
      claudeConfigDir: "/w/claude",
      ghConfigDir: null,
      gitConfigGlobal: null,
    });
    expect(workspaces.all()).toHaveLength(1);
    expect(workspaces.identityOf("nope").claudeConfigDir).toBeNull();
  });
});

describe("setWorkspaceIdentity", () => {
  /** A profile with somebody claimed, so borrowing it has something to show. */
  function withAccounts(workspaces: Workspaces, name: string, claude: string): string {
    const here = workspaces.active.id;
    const id = workspaces.newProfile(name);
    workspaces.setProfileIdentity(id, {
      claudeConfigDir: claude,
      ghConfigDir: null,
      gitConfigGlobal: null,
    });
    workspaces.switchProfile(here);
    return id;
  }

  it("opens a borrowing workspace's terminals as the profile it points at", () => {
    const workspaces = new Workspaces();
    const work = withAccounts(workspaces, "work", "/w/claude");
    const mixed = workspaces.newWorkspace("theirs");

    workspaces.setWorkspaceIdentity(mixed, work);

    expect(workspaces.identityForWorkspace(mixed).claudeConfigDir).toBe("/w/claude");
  });

  it("leaves every other workspace on the profile it lives in", () => {
    const workspaces = new Workspaces();
    const work = withAccounts(workspaces, "work", "/w/claude");
    const own = workspaces.activeWorkspace.id;
    const mixed = workspaces.newWorkspace("theirs");
    workspaces.setWorkspaceIdentity(mixed, work);

    expect(workspaces.identityForWorkspace(own).claudeConfigDir).toBeNull();
  });

  it("hands a workspace back with null rather than by naming its own profile", () => {
    const workspaces = new Workspaces();
    const work = withAccounts(workspaces, "work", "/w/claude");
    const mixed = workspaces.activeWorkspace.id;
    workspaces.setWorkspaceIdentity(mixed, work);

    workspaces.setWorkspaceIdentity(mixed, null);

    expect(workspaces.workspaceById(mixed)?.identityProfileId).toBeNull();
    expect(workspaces.identityForWorkspace(mixed).claudeConfigDir).toBeNull();
  });

  it("refuses a profile that is not there rather than storing a dead pointer", () => {
    const workspaces = new Workspaces();
    const mixed = workspaces.activeWorkspace.id;
    workspaces.setWorkspaceIdentity(mixed, "nope");
    expect(workspaces.workspaceById(mixed)?.identityProfileId).toBeNull();
  });

  it("falls back to the profile you are in once the borrowed one is deleted", () => {
    // The pointer is deliberately not cleaned up when a profile goes — the
    // fallback is the same answer a cleanup would have produced, which is why
    // deleting a profile has nothing to chase.
    const workspaces = new Workspaces();
    const work = withAccounts(workspaces, "work", "/w/claude");
    const mixed = workspaces.activeWorkspace.id;
    workspaces.setWorkspaceIdentity(mixed, work);
    workspaces.deleteProfile(work);

    expect(workspaces.identityForWorkspace(mixed).claudeConfigDir).toBeNull();
  });

  it("is a statement about the next terminal, so an unknown workspace is not an error", () => {
    const workspaces = new Workspaces();
    expect(workspaces.identityForWorkspace("nope").claudeConfigDir).toBeNull();
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

  it("fills in an identity a previous version of the server never wrote", () => {
    // A blob from before profiles had one at all: the field is simply absent,
    // and an `undefined` where the type promises three nulls is the class of
    // bug `adopt` exists for.
    const before = new Workspaces();
    const stale = JSON.parse(JSON.stringify(before.all()), (key, value) =>
      key === "identity" ? undefined : value,
    );
    expect(stale[0]).not.toHaveProperty("identity");

    const after = new Workspaces(stale);
    expect(after.active.identity).toEqual({
      claudeConfigDir: null,
      ghConfigDir: null,
      gitConfigGlobal: null,
    });
  });

  it("fills in a borrowed profile a previous version of the server never wrote", () => {
    const before = new Workspaces();
    const stale = JSON.parse(JSON.stringify(before.all()), (key, value) =>
      key === "identityProfileId" ? undefined : value,
    );
    expect(stale[0].workspaces[0]).not.toHaveProperty("identityProfileId");

    const after = new Workspaces(stale);
    expect(after.activeWorkspace.identityProfileId).toBeNull();
  });

  it("drops a stored path that has stopped being absolute", () => {
    const before = new Workspaces();
    before.setProfileIdentity(before.active.id, {
      claudeConfigDir: "/w/claude",
      ghConfigDir: null,
      gitConfigGlobal: null,
    });
    const stale = JSON.parse(JSON.stringify(before.all()));
    stale[0].identity.claudeConfigDir = "relative/claude";

    const after = new Workspaces(stale);
    expect(after.active.identity.claudeConfigDir).toBeNull();
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
