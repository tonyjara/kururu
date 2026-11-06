/**
 * The profile's Dashboard: the rule that says what it may hold, and the
 * server keeping it — through every verb that could break it, across the
 * host's blob and across a cold start.
 *
 * What these protect is the user's ask: the profile board is a tab that
 * cannot be closed, cannot leave the Dashboard, and comes back where it was
 * after a restart; and the Dashboard is not a workspace, so nothing that
 * lists workspaces lists it and no workspace verb reaches it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  arrangeDashboard,
  DASHBOARD_TABS,
  dashboardLayout,
  fitsDashboard,
  holdsDashTab,
  makeDashboard,
  PROFILE_BOARD_TAB,
} from "../../shared/dashboard";
import { activeTerminal, findPane, panes, terminalsOf, type LayoutNode } from "../../shared/layout";
import { hostBlob, readSnapshot, writeSnapshot } from "../src/persist";
import { Workspaces } from "../src/workspaces";

let dir: string;
let previous: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kururu-dashboard-"));
  previous = process.env.KURURU_STATE_DIR;
  process.env.KURURU_STATE_DIR = dir;
});
afterEach(() => {
  if (previous === undefined) delete process.env.KURURU_STATE_DIR;
  else process.env.KURURU_STATE_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

const pane = (id: string, agentIds: string[], activeIdx = 0): LayoutNode => ({ type: "pane", pane: { id, agentIds, activeIdx } });
const split = (a: LayoutNode, b: LayoutNode): LayoutNode => ({ type: "split", id: "s1", dir: "row", ratio: 0.5, a, b });
const every = DASHBOARD_TABS.map((tab) => tab.id as string);

describe("fitsDashboard", () => {
  it("takes every fixed tab once, and nothing else", () => {
    expect(fitsDashboard(pane("n1", every))).toBe(true);
    expect(fitsDashboard(pane("n1", [...every, "a1"]))).toBe(false);
    expect(fitsDashboard(pane("n1", [...every, "board"]))).toBe(false);
    expect(fitsDashboard(pane("n1", [...every, "dash:nope"]))).toBe(false);
    expect(fitsDashboard(pane("n1", []))).toBe(false);
    expect(fitsDashboard(split(pane("n1", every), pane("n2", [PROFILE_BOARD_TAB])))).toBe(false);
  });

  it("refuses an empty pane beside the tabs, which would offer a terminal", () => {
    expect(fitsDashboard(split(pane("n1", every), pane("n2", [])))).toBe(false);
  });
});

describe("dashboardLayout", () => {
  it("makes a fresh one with every fixed tab when there is nothing", () => {
    const made = dashboardLayout(null, () => "n9");
    expect(made).toEqual(pane("n9", every));
    expect(fitsDashboard(made)).toBe(true);
  });

  it("takes out what is not a fixed tab, keeps one of each, and closes what is left empty", () => {
    const made = dashboardLayout(split(pane("n1", ["a1", PROFILE_BOARD_TAB, PROFILE_BOARD_TAB], 1), pane("n2", ["a2", "board"])), () => "nx");
    expect(made).toEqual(pane("n1", [PROFILE_BOARD_TAB], 0));
  });

  it("puts a missing fixed tab in the first pane, for a profile from before it", () => {
    const made = dashboardLayout(pane("n1", ["a1"]), () => "n5");
    expect(made).toEqual(pane("n5", every));
  });

  it("reads anything off a blob without throwing", () => {
    for (const junk of [undefined, 3, "x", { type: "pane" }, { type: "split", a: null, b: 5 }]) {
      expect(fitsDashboard(dashboardLayout(junk as unknown as LayoutNode, () => "n1"))).toBe(true);
    }
  });
});

describe("arrangeDashboard and holdsDashTab", () => {
  it("keeps the arrangement of a change that fits, and nothing else of it", () => {
    const before = makeDashboard("d1", "k", pane("n1", every));
    const after = arrangeDashboard(before, { ...before, name: "Mine", board: { columns: [] } as never, layout: pane("n1", every, 0), focusedPaneId: "gone" });
    expect(after.name).toBe("Dashboard");
    expect(after.board).toBeNull();
    expect(after.focusedPaneId).toBe("n1");
  });

  it("keeps the old one whole when a change does not fit", () => {
    const before = makeDashboard("d1", "k", pane("n1", every));
    expect(arrangeDashboard(before, { ...before, layout: pane("n1", []) })).toBe(before);
    expect(arrangeDashboard(before, { ...before, layout: pane("n1", [...every, "a3"]) })).toBe(before);
  });

  it("says when a workspace's layout holds a fixed tab", () => {
    expect(holdsDashTab(pane("n1", ["a1", PROFILE_BOARD_TAB]))).toBe(true);
    expect(holdsDashTab(pane("n1", ["a1", "board"]))).toBe(false);
  });

  it("a fixed tab is never a terminal", () => {
    expect(terminalsOf(["a1", PROFILE_BOARD_TAB])).toEqual(["a1"]);
    expect(activeTerminal({ id: "n1", agentIds: [PROFILE_BOARD_TAB], activeIdx: 0 })).toBeNull();
  });
});

describe("the Dashboard in Workspaces", () => {
  it("is every profile's, outside its workspaces, with the board in it", () => {
    const workspaces = new Workspaces();
    const profile = workspaces.active;
    expect(profile.workspaces.some((w) => w.id === profile.dashboard.id)).toBe(false);
    expect(fitsDashboard(profile.dashboard.layout)).toBe(true);
    expect(profile.onDashboard).toBe(false);
  });

  it("opens on a tab and leaves by any switch, back to the workspace it was opened over", () => {
    const workspaces = new Workspaces();
    const home = workspaces.activeWorkspace.id;
    workspaces.openDashboard(PROFILE_BOARD_TAB);
    expect(workspaces.onDashboard).toBe(true);
    expect(workspaces.activeWorkspace.id).toBe(workspaces.active.dashboard.id);
    expect(workspaces.active.activeWorkspaceId).toBe(home);
    workspaces.lastWorkspace();
    expect(workspaces.onDashboard).toBe(false);
    expect(workspaces.activeWorkspace.id).toBe(home);

    workspaces.openDashboard();
    workspaces.switchWorkspace(home);
    expect(workspaces.onDashboard).toBe(false);
    expect(workspaces.active.lastWorkspaceId).toBeNull();

    const other = workspaces.newWorkspace("two");
    workspaces.openDashboard();
    workspaces.stepWorkspace(1);
    expect(workspaces.onDashboard).toBe(false);
    expect([home, other]).toContain(workspaces.activeWorkspace.id);
  });

  it("refuses to close its tab or its pane, or to split off an empty pane", () => {
    const workspaces = new Workspaces();
    workspaces.openDashboard();
    const before = workspaces.active.dashboard;
    workspaces.removeTab(PROFILE_BOARD_TAB);
    workspaces.reapTab(PROFILE_BOARD_TAB);
    expect(workspaces.closePane()).toEqual([]);
    expect(workspaces.split("row")).toBeNull();
    expect(workspaces.active.dashboard).toBe(before);
  });

  it("takes no terminal, and a terminal dropped on it stays where it was", () => {
    const workspaces = new Workspaces();
    const home = workspaces.activeWorkspace;
    workspaces.addTab("a1", "/p", home.focusedPaneId);
    workspaces.openDashboard();
    const dash = workspaces.focusedPaneId;
    workspaces.moveTab("a1", dash);
    workspaces.splitWith("a1", dash, "row", false);
    workspaces.addTab("a2", "/p");
    expect(workspaces.active.dashboard.layout).toEqual(pane(dash, every));
    expect(workspaces.active.workspaces[0]!.layout.type === "pane" && workspaces.active.workspaces[0]!.layout.pane.agentIds).toEqual(["a1"]);
  });

  it("never lets its tab into a workspace", () => {
    const workspaces = new Workspaces();
    const home = workspaces.activeWorkspace.id;
    const other = workspaces.newWorkspace("two");
    workspaces.openDashboard();
    workspaces.moveTabToWorkspace(PROFILE_BOARD_TAB, home);
    workspaces.switchWorkspace(other);
    workspaces.moveTab(PROFILE_BOARD_TAB, workspaces.focusedPaneId);
    workspaces.addTab(PROFILE_BOARD_TAB, undefined);
    for (const w of workspaces.active.workspaces) expect(holdsDashTab(w.layout)).toBe(false);
    expect(fitsDashboard(workspaces.active.dashboard.layout)).toBe(true);
  });

  it("is not renamed, and is not reached by the verbs that find a workspace by id", () => {
    const workspaces = new Workspaces();
    const id = workspaces.active.dashboard.id;
    workspaces.renameWorkspace(id, "Mine");
    expect(workspaces.active.dashboard.name).toBe("Dashboard");
    expect(workspaces.deleteWorkspace(id)).toEqual([]);
    workspaces.switchWorkspace(id);
    expect(workspaces.onDashboard).toBe(false);
    expect(workspaces.workspaceIn(workspaces.active.id, id)).toBeNull();
  });

  it("comes back from the host's blob, and is made for a blob from before it", () => {
    const first = new Workspaces();
    first.openDashboard();
    const blob = JSON.parse(hostBlob(first.all(), first.active.id)) as { profiles: unknown[] };
    const again = new Workspaces(blob.profiles as never);
    expect(again.active.dashboard).toEqual(first.active.dashboard);
    expect(again.onDashboard).toBe(true);

    const old = blob.profiles.map((p) => {
      const { dashboard: _d, onDashboard: _o, ...rest } = p as Record<string, unknown>;
      return rest;
    });
    const older = new Workspaces(old as never);
    expect(fitsDashboard(older.active.dashboard.layout)).toBe(true);
    expect(older.onDashboard).toBe(false);
    // Its ids are minted past everything the blob holds.
    const ids = new Set(older.all().flatMap((p) => [...p.workspaces.flatMap((w) => panes(w.layout).map((x) => x.id)), ...panes(p.dashboard.layout).map((x) => x.id)]));
    expect(ids.size).toBe(older.all().flatMap((p) => [...p.workspaces.flatMap((w) => panes(w.layout)), ...panes(p.dashboard.layout)]).length);
  });

  it("survives a cold start, on screen or not", () => {
    const first = new Workspaces();
    first.openDashboard();
    writeSnapshot(first.all(), first.active.id);
    const read = readSnapshot()!;
    const profile = read.profiles[0]!;
    expect(profile.onDashboard).toBe(true);
    expect(fitsDashboard(profile.dashboard.layout)).toBe(true);
    expect(findPane(profile.dashboard.layout, profile.dashboard.focusedPaneId)).not.toBeNull();
    for (const w of profile.workspaces) expect(holdsDashTab(w.layout)).toBe(false);
  });
});
