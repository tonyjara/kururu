/**
 * Browser tabs through the server: the verbs that make and move them, and the
 * cold start that brings them back.
 *
 * What these protect is the plan's "restores structure, never processes" rule
 * applied to a page — a restored tab knows its address and its title and
 * loads nothing until the window shows it — and the one fact a page has that
 * a document does not: its address lives beside its id, and has to go
 * wherever the tab goes, including another workspace.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPane, isWebTab, panes, webTabOf } from "../../shared/layout";
import { readSnapshot, snapshotPath, writeSnapshot } from "../src/persist";
import { Workspaces } from "../src/workspaces";

let dir: string;
let previous: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kururu-browser-"));
  previous = process.env.KURURU_STATE_DIR;
  process.env.KURURU_STATE_DIR = dir;
});
afterEach(() => {
  if (previous === undefined) delete process.env.KURURU_STATE_DIR;
  else process.env.KURURU_STATE_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

describe("openBrowser", () => {
  it("opens in the focused pane by default, showing, with a fresh random id", () => {
    const workspaces = new Workspaces();
    const pane = workspaces.focusedPaneId;
    workspaces.addTab("a1", "/p", pane);
    const tabId = workspaces.openBrowser("http://localhost:3000/")!;
    expect(isWebTab(tabId)).toBe(true);
    const shown = findPane(workspaces.activeWorkspace.layout, pane)!;
    expect(shown.agentIds).toEqual(["a1", tabId]);
    expect(shown.activeIdx).toBe(1);
    expect(workspaces.webPage(tabId)).toEqual({ url: "http://localhost:3000/", title: "", nav: 0 });
    expect(workspaces.openBrowser("http://localhost:3000/")).not.toBe(tabId);
  });

  it("opens in the pane it was asked for, and in the agents' pane for a card", () => {
    const workspaces = new Workspaces();
    const first = workspaces.focusedPaneId;
    const second = workspaces.split("row", first)!;
    workspaces.focusPane(first);
    const here = workspaces.openBrowser("https://example.com/", second)!;
    expect(findPane(workspaces.activeWorkspace.layout, second)!.agentIds).toContain(here);
    const forCard = workspaces.openBrowser("http://localhost:5174/", undefined, "agents")!;
    const pane = panes(workspaces.activeWorkspace.layout).find((p) => p.agentIds.includes(forCard))!;
    expect(pane.forAgents).toBe(true);
  });
});

describe("navigate and report", () => {
  it("navigate bumps nav and clears a title that was another page's; report moves neither nav", () => {
    const workspaces = new Workspaces();
    const tabId = workspaces.openBrowser("http://localhost:3000/")!;
    workspaces.reportBrowser(tabId, "http://localhost:3000/", "Home");
    expect(workspaces.webPage(tabId)).toEqual({ url: "http://localhost:3000/", title: "Home", nav: 0 });
    workspaces.navigateBrowser(tabId, "http://localhost:3000/about");
    expect(workspaces.webPage(tabId)).toEqual({ url: "http://localhost:3000/about", title: "", nav: 1 });
    workspaces.reportBrowser(tabId, "http://localhost:3000/about#team", "About");
    expect(workspaces.webPage(tabId)?.nav).toBe(1);
  });

  it("is nothing for a tab that is not there", () => {
    const workspaces = new Workspaces();
    expect(workspaces.navigateBrowser("web:nothinghere1", "https://example.com/")).toBe(false);
    expect(workspaces.reportBrowser("web:nothinghere1", "https://example.com/", "x")).toBe(false);
  });
});

describe("moving between workspaces", () => {
  it("carries the page's address with the tab, by the sidebar row and by a drop", () => {
    const workspaces = new Workspaces();
    const from = workspaces.activeWorkspace.id;
    const tabId = workspaces.openBrowser("http://localhost:3000/")!;
    workspaces.reportBrowser(tabId, "http://localhost:3000/cart", "Cart");
    workspaces.newWorkspace("other");
    const other = workspaces.activeWorkspace.id;
    workspaces.switchWorkspace(from);
    workspaces.moveTabToWorkspace(tabId, other);
    const there = workspaces.all()[0]!.workspaces.find((w) => w.id === other)!;
    expect(webTabOf(there.layout, tabId)).toEqual({ url: "http://localhost:3000/cart", title: "Cart", nav: 0 });
    // And back, by dropping it on a pane of the workspace on screen.
    workspaces.switchWorkspace(from);
    workspaces.moveTab(tabId, workspaces.focusedPaneId);
    expect(webTabOf(workspaces.activeWorkspace.layout, tabId)?.title).toBe("Cart");
    const left = workspaces.all()[0]!.workspaces.find((w) => w.id === other)!;
    expect(webTabOf(left.layout, tabId)).toBeNull();
  });
});

describe("closing", () => {
  it("takes the tab out and closes a pane it emptied, never the last", () => {
    const workspaces = new Workspaces();
    const first = workspaces.focusedPaneId;
    const second = workspaces.split("row", first)!;
    const tabId = workspaces.openBrowser("https://example.com/", second)!;
    workspaces.reapTab(tabId);
    expect(findPane(workspaces.activeWorkspace.layout, second)).toBeNull();
    const only = workspaces.openBrowser("https://example.com/", first)!;
    workspaces.reapTab(only);
    expect(panes(workspaces.activeWorkspace.layout)).toHaveLength(1);
    expect(workspaces.allAgents()).toEqual([]);
  });
});

describe("on disk", () => {
  it("comes back with its id, address, title and nav, unloaded, beside the terminals left out", () => {
    const workspaces = new Workspaces();
    const pane = workspaces.focusedPaneId;
    workspaces.addTab("a1", "/p", pane);
    const tabId = workspaces.openBrowser("http://localhost:3000/")!;
    workspaces.navigateBrowser(tabId, "http://localhost:3000/a");
    workspaces.reportBrowser(tabId, "http://localhost:3000/a", "A page");
    writeSnapshot(workspaces.all(), workspaces.active.id);
    const [restored] = panes(readSnapshot()!.profiles[0]!.workspaces[0]!.layout);
    expect(restored!.agentIds).toEqual([tabId]);
    expect(restored!.web).toEqual({ [tabId]: { url: "http://localhost:3000/a", title: "A page", nav: 1 } });
  });

  it("refuses a page whose address is not one now, and a second tab under one id", () => {
    const workspaces = new Workspaces();
    writeSnapshot(workspaces.all(), workspaces.active.id);
    const session = JSON.parse(readFileSync(snapshotPath(), "utf8"));
    session.profiles[0].workspaces[0].layout = {
      type: "split",
      dir: "row",
      ratio: 0.5,
      a: { type: "pane", pane: { tabs: [{ web: { id: "web:aaaaaaaa1111", url: "file:///etc/passwd" } }, { web: { id: "web:bbbbbbbb2222", url: "https://example.com/", nav: "x" } }] } },
      b: { type: "pane", pane: { tabs: [{ web: { id: "web:bbbbbbbb2222", url: "https://example.org/" } }, { web: { id: "../x", url: "https://example.org/" } }] } },
    };
    writeFileSync(snapshotPath(), JSON.stringify(session));
    const [a, b] = panes(readSnapshot()!.profiles[0]!.workspaces[0]!.layout);
    expect(a!.agentIds).toEqual(["web:bbbbbbbb2222"]);
    expect(a!.web).toEqual({ "web:bbbbbbbb2222": { url: "https://example.com/", title: "", nav: 0 } });
    expect(b!.agentIds).toEqual([]);
    expect(b!.web).toBeUndefined();
  });
});
