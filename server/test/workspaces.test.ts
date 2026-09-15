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
import { Workspaces } from "../src/workspaces";

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
