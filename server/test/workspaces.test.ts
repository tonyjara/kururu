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
