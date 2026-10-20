/**
 * Another node's things on this window (`shared/remote.ts`,
 * `server/src/nodewatch.ts`): the grammar of a qualified id, which node a
 * verb is for, and the rule the whole design rests on — a qualified id is
 * never written. `persist.test.ts`'s sibling: a window drives a remote
 * workspace through the relay, and neither `session.json`, the host's blob
 * nor the database holds an `n:` anywhere afterwards.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocket } from "ws";
import { addCard, emptyBoard, startRun } from "../../shared/board";
import { BOARD_TAB, docTab, panes, type LayoutNode } from "../../shared/layout";
import type { AgentSnapshot, Workspace } from "../../shared/model";
import type { NodeSummary } from "../../shared/nodes";
import {
  containsQualified,
  isRemote,
  nodeHue,
  nodeOfId,
  parseRemote,
  qualify,
  qualifyAgent,
  qualifyReply,
  qualifyTab,
  qualifyWorkspace,
  route,
} from "../../shared/remote";
import type { ClientMessage, ServerMessage } from "../../shared/wire";
import { NodeWatches, type WatchClient } from "../src/nodewatch";
import { readSnapshot, snapshotPath, writeSnapshot } from "../src/persist";
import { Store } from "../src/store";
import { Workspaces } from "../src/workspaces";

const OMARCHY = "n0123456789ab";
const LAPTOP = "nfedcba987654";

describe("the grammar", () => {
  it("qualifies and reads back, and nothing local reads as remote", () => {
    const id = qualify(OMARCHY, "a7");
    expect(id).toBe(`n:${OMARCHY}:a7`);
    expect(parseRemote(id)).toEqual({ node: OMARCHY, id: "a7" });
    expect(nodeOfId(id)).toBe(OMARCHY);
    for (const local of ["a7", "n12", "s3", "w2", BOARD_TAB, docTab("/r", "x.md"), "n:notanode:a7", "n:n0123456789ab", 7, null]) {
      expect(isRemote(local)).toBe(false);
    }
  });
  it("keeps a local id that has colons in it whole", () => {
    expect(parseRemote(qualify(OMARCHY, "doc:x:y"))).toEqual({ node: OMARCHY, id: "doc:x:y" });
  });
  it("finds a qualified id anywhere in a text, and nothing else", () => {
    expect(containsQualified(JSON.stringify({ a: [{ b: qualify(OMARCHY, "a1") }] }))).toBe(true);
    expect(containsQualified(JSON.stringify({ a: "n:", b: "n12", c: "n0123456789ab" }))).toBe(false);
  });
  it("gives a node one hue, from the board palette, everywhere", () => {
    expect(nodeHue(OMARCHY)).toBe(nodeHue(OMARCHY));
    expect(typeof nodeHue(LAPTOP)).toBe("string");
  });
});

function pane(id: string, agentIds: string[]): LayoutNode {
  return { type: "pane", pane: { id, agentIds, activeIdx: 0 } };
}

describe("the child's workspace, as the Mac draws it", () => {
  const board = startRun(addCard(emptyBoard(), { title: "Fix it" }, "c1", 1), "c1", { agentId: "a2", launcher: "claude", label: "Claude", at: 2 });
  const child: Workspace = {
    id: "w1",
    key: "kkk",
    name: "main",
    layout: { type: "split", id: "s1", dir: "row", ratio: 0.5, a: pane("n1", ["a1", BOARD_TAB]), b: pane("n2", ["a2", docTab("/home/o", "README.md")]) },
    focusedPaneId: "n2",
    lastPaneId: "n1",
    mascotId: null,
    group: null,
    board,
    machine: { machineId: "m1", dir: "/srv" },
    agentPlacement: null,
  };

  it("qualifies every id that names a thing, and leaves the board's and a document's tabs as they are", () => {
    const shown = qualifyWorkspace(OMARCHY, child);
    expect(shown.id).toBe(qualify(OMARCHY, "w1"));
    expect(shown.key).toBe("kkk");
    expect(shown.focusedPaneId).toBe(qualify(OMARCHY, "n2"));
    expect(shown.lastPaneId).toBe(qualify(OMARCHY, "n1"));
    expect(panes(shown.layout).map((p) => p.id)).toEqual([qualify(OMARCHY, "n1"), qualify(OMARCHY, "n2")]);
    expect(panes(shown.layout).map((p) => p.agentIds)).toEqual([
      [qualify(OMARCHY, "a1"), BOARD_TAB],
      [qualify(OMARCHY, "a2"), docTab("/home/o", "README.md")],
    ]);
    expect(shown.layout.type === "split" && shown.layout.id).toBe(qualify(OMARCHY, "s1"));
    expect(shown.board?.cards[0]?.run?.agentId).toBe(qualify(OMARCHY, "a2"));
    // A card is found by its workspace, which is what says whose it is.
    expect(shown.board?.cards[0]?.id).toBe("c1");
    // The child's machine list is not this node's.
    expect(shown.machine).toBeNull();
    // And the child's own copy is untouched.
    expect(child.id).toBe("w1");
  });
  it("qualifies an agent and leaves off what it made, which is the child's disk's", () => {
    const agent = { id: "a2", kind: "agent", made: [{ root: "/r", path: "x.md" }] } as unknown as AgentSnapshot;
    const shown = qualifyAgent(OMARCHY, agent);
    expect(shown.id).toBe(qualify(OMARCHY, "a2"));
    expect("made" in shown).toBe(false);
  });
  it("qualifies the agent a reply names, by verb", () => {
    expect(qualifyReply(OMARCHY, "new-tab", { id: "a9" })).toEqual({ id: qualify(OMARCHY, "a9") });
    expect(qualifyReply(OMARCHY, "run-card", { agentId: "a9" })).toEqual({ agentId: qualify(OMARCHY, "a9") });
    expect(qualifyReply(OMARCHY, "worktree-status", { id: "x" })).toEqual({ id: "x" });
    expect(qualifyTab(OMARCHY, BOARD_TAB)).toBe(BOARD_TAB);
  });
});

describe("which node a verb is for", () => {
  const q = (id: string) => qualify(OMARCHY, id);

  it("leaves this node's verbs here", () => {
    expect(route({ type: "input", agentId: "a1", data: "x" }, null)).toEqual({ to: "here" });
    expect(route({ type: "split", dir: "row" }, null)).toEqual({ to: "here" });
    expect(route({ type: "set-theme", themeId: "x" }, OMARCHY)).toEqual({ to: "here" });
    expect(route({ type: "watch", agentIds: [q("a1"), "a2"] }, OMARCHY)).toEqual({ to: "here" });
  });
  it("sends a verb that names a node's things to it, every id bare", () => {
    expect(route({ type: "input", agentId: q("a1"), data: "ls\r" }, null)).toEqual({ to: "node", node: OMARCHY, message: { type: "input", agentId: "a1", data: "ls\r" } });
    expect(route({ type: "move-tab", agentId: q("a1"), paneId: q("n2"), index: 1 }, null)).toEqual({
      to: "node",
      node: OMARCHY,
      message: { type: "move-tab", agentId: "a1", paneId: "n2", index: 1 },
    });
    expect(route({ type: "add-card", workspaceId: q("w1"), title: "t" }, null)).toMatchObject({ to: "node", message: { workspaceId: "w1" } });
  });
  it("sends a verb that means the focused pane to the node on screen", () => {
    expect(route({ type: "split", dir: "col" }, OMARCHY)).toEqual({ to: "node", node: OMARCHY, message: { type: "split", dir: "col" } });
    expect(route({ type: "focus-dir", dir: "left" }, OMARCHY)).toMatchObject({ to: "node" });
    expect(route({ type: "close-tab", agentId: BOARD_TAB }, OMARCHY)).toEqual({ to: "node", node: OMARCHY, message: { type: "close-tab", agentId: BOARD_TAB } });
    // A board or a document tab takes the side of the pane it is named with.
    expect(route({ type: "move-tab", agentId: BOARD_TAB, paneId: q("n2") }, null)).toMatchObject({ to: "node", message: { paneId: "n2" } });
    expect(route({ type: "move-tab", agentId: BOARD_TAB, paneId: "n5" }, OMARCHY)).toEqual({ to: "here" });
  });
  it("refuses a verb that mixes two machines' things", () => {
    expect(route({ type: "move-tab", agentId: q("a1"), paneId: "n5" }, OMARCHY)).toMatchObject({ to: "nowhere", node: OMARCHY });
    expect(route({ type: "move-tab-to-workspace", agentId: "a3", workspaceId: q("w1") }, null)).toMatchObject({ to: "nowhere" });
    expect(route({ type: "swap-panes", paneId: q("n1"), withPaneId: qualify(LAPTOP, "n1") }, null)).toMatchObject({ to: "nowhere" });
  });
  it("refuses a file from this disk into a remote pane", () => {
    expect(route({ type: "open-doc", paneId: q("n1"), root: "/Users/me", path: "a.md" }, OMARCHY)).toMatchObject({ to: "nowhere", why: expect.stringContaining("file") });
  });
  it("refuses, rather than does here, anything else that names a remote thing", () => {
    expect(route({ type: "rename-workspace", workspaceId: q("w1"), name: "x" }, null)).toMatchObject({ to: "nowhere", node: OMARCHY });
    expect(route({ type: "delete-workspace", workspaceId: q("w1") }, OMARCHY)).toMatchObject({ to: "nowhere" });
  });
});

// ---------------------------------------------------------------------------
// Never written
// ---------------------------------------------------------------------------

let dir: string;
const was: Record<string, string | undefined> = {};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kururu-remote-"));
  for (const name of ["KURURU_DATA_DIR", "KURURU_STATE_DIR"]) was[name] = process.env[name];
  process.env.KURURU_DATA_DIR = join(dir, "data");
  process.env.KURURU_STATE_DIR = join(dir, "state");
});
afterEach(() => {
  for (const [name, value] of Object.entries(was)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

/**
 * What `index.ts` does with a verb the relay did not take: the arrangement
 * verbs a window sends, applied to `Workspaces` the way `handleMessage`
 * applies them. Enough of them to put any id the relay let through into the
 * tree, which is what the test is listening for.
 */
function applyHere(workspaces: Workspaces, msg: ClientMessage): void {
  switch (msg.type) {
    case "split":
      workspaces.split(msg.dir, msg.paneId);
      return;
    case "focus-pane":
      workspaces.focusPane(msg.paneId);
      return;
    case "select-tab":
      workspaces.selectTab(msg.paneId, msg.index);
      return;
    case "move-tab":
      workspaces.moveTab(msg.agentId, msg.paneId, msg.index);
      return;
    case "split-with":
      workspaces.splitWith(msg.agentId, msg.paneId, msg.dir, msg.before);
      return;
    case "move-tab-to-workspace":
      workspaces.moveTabToWorkspace(msg.agentId, msg.workspaceId);
      return;
    case "switch-workspace":
      workspaces.switchWorkspace(msg.workspaceId);
      return;
    case "rename-workspace":
      workspaces.renameWorkspace(msg.workspaceId, msg.name);
      return;
    case "reveal-agent":
      workspaces.reveal(msg.agentId);
      return;
    case "add-card":
      workspaces.editBoard(msg.workspaceId, (board) => addCard(board, { title: msg.title }, `card-${msg.title}`, 1));
      return;
    default:
      return;
  }
}

describe("a qualified id is never written", () => {
  it("not to session.json, the host's blob or the database, however the window drives a remote workspace", () => {
    // The child: a workspace with two terminals and a board, as its own
    // server holds it, and as the Mac's clients are shown it.
    const child = new Workspaces();
    child.addTab("a1", "/home/o");
    child.split("row");
    child.addTab("a2", "/home/o");
    const childWorkspace = child.active.workspaces[0]!;
    const shown = qualifyWorkspace(OMARCHY, childWorkspace);
    const [remoteA, remoteB] = panes(shown.layout);

    // The Mac: its own workspace with a terminal in it.
    const mac = new Workspaces();
    mac.addTab("a5", "/Users/me");
    const localPane = panes(mac.activeWorkspace.layout)[0]!.id;
    mac.openBoard(localPane, true);
    const local = mac.activeWorkspace;

    const sent: ServerMessage[] = [];
    const summary = { watchable: 1, workspaces: [{ key: childWorkspace.key, agents: [{ id: "a1" }, { id: "a2" }] }] } as unknown as NodeSummary;
    const watches = new NodeWatches({
      member: (id) => (id === OMARCHY ? { name: "omarchy", address: "127.0.0.1", port: 1 } : null),
      summary: (id) => (id === OMARCHY ? summary : null),
      // Never comes up: what is under test is that nothing reaches here,
      // not what the child makes of it.
      handshake: () => undefined,
      clients: () => clients,
      send: (_ws, msg) => sent.push(msg),
      changed: () => undefined,
      log: () => undefined,
      record: () => undefined,
    });
    const ws = {} as WebSocket;
    const st: WatchClient = { watching: new Set(), warm: new Set(), proposals: new Map(), looking: true, awaiting: new Map() };
    const clients = new Map([[ws, st]]);

    const q = (id: string) => qualify(OMARCHY, id);
    const verbs: ClientMessage[] = [
      { type: "show-node-workspace", nodeId: OMARCHY, workspaceKey: childWorkspace.key },
      { type: "focus-pane", paneId: remoteB!.id },
      { type: "split", dir: "row", paneId: remoteA!.id },
      { type: "split", dir: "col" },
      { type: "focus-dir", dir: "left" },
      { type: "select-tab", paneId: remoteA!.id, index: 0 },
      { type: "move-tab", agentId: q("a1"), paneId: remoteB!.id },
      { type: "input", agentId: q("a1"), data: "ls\r" },
      { type: "propose-size", agentId: q("a1"), cols: 100, rows: 30 },
      { type: "request-backlog", agentId: q("a1") },
      { type: "add-card", workspaceId: shown.id, title: "remote" },
      { type: "switch-workspace", workspaceId: shown.id },
      { type: "reveal-agent", agentId: q("a2") },
      // Across the boundary, both ways, and verbs the relay does not carry.
      { type: "move-tab", agentId: q("a1"), paneId: localPane },
      { type: "move-tab-to-workspace", agentId: q("a2"), workspaceId: local.id },
      { type: "split-with", agentId: q("a2"), paneId: localPane, dir: "row", before: false },
      { type: "split-with", agentId: "a5", paneId: remoteA!.id, dir: "row", before: true },
      { type: "rename-workspace", workspaceId: shown.id, name: "renamed" },
      // And this node's own, which go on as ever and put the Mac back on screen.
      { type: "switch-workspace", workspaceId: local.id },
      { type: "split", dir: "col", paneId: localPane },
      { type: "add-card", workspaceId: local.id, title: "local" },
    ];
    for (const msg of verbs) {
      const taken = watches.handle(ws, st, msg);
      // Everything that names another node's thing is the relay's, and so
      // never reaches the switch in `handleMessage`.
      if (containsQualified(JSON.stringify(msg)) || msg.type === "show-node-workspace") expect(taken).toBe(true);
      if (!taken) applyHere(mac, msg);
    }
    watches.close();

    // This node's own verbs did go through.
    expect(panes(mac.activeWorkspace.layout).length).toBe(2);
    expect(mac.activeWorkspace.board?.cards.map((c) => c.title)).toEqual(["local"]);
    // The id-less verbs went where the screen was while the remote one was on it.
    expect(sent.some((m) => m.type === "remote-said")).toBe(true);

    // The host's blob, as `queueSave` hands it over.
    const blob = JSON.stringify({ profiles: mac.all(), activeProfileId: mac.active.id });
    expect(containsQualified(blob)).toBe(false);

    // session.json.
    writeSnapshot(mac.all(), mac.active.id);
    expect(containsQualified(readFileSync(snapshotPath(), "utf8"))).toBe(false);
    expect(readSnapshot()).not.toBeNull();

    // The database: the profile synced, as every change is, then exported.
    const store = Store.open(join(dir, "data", "kururu.db"));
    try {
      store.syncProfile(null, mac.active, "user");
      expect(containsQualified(JSON.stringify(store.exportAll({ agents: true })))).toBe(false);
    } finally {
      store.close();
    }
    expect(containsQualified(readFileSync(join(dir, "data", "kururu.db")).toString("latin1"))).toBe(false);
  });

  it("would catch one that got through", () => {
    const mac = new Workspaces();
    mac.addTab(qualify(OMARCHY, "a1"), "/x");
    // Terminals are not written to session.json at all, so plant one where a
    // name is: the check reads the whole file, not the fields it expects.
    mac.renameWorkspace(mac.activeWorkspace.id, qualify(OMARCHY, "w1"));
    writeSnapshot(mac.all(), mac.active.id);
    expect(containsQualified(readFileSync(snapshotPath(), "utf8"))).toBe(true);
    expect(containsQualified(JSON.stringify(mac.all()))).toBe(true);
  });
});
