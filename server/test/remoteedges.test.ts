/**
 * Remote workspaces' edges (phase 5 of `docs/plans/remote-workspaces.md`):
 * the walk `C-a N`, `C-a P` and `C-a w` take across nodes, `C-a z` back to a
 * remote workspace, and what a drop target says to a thing of the other
 * machine's before anybody lets go of it.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { WebSocket } from "ws";
import { BOARD_TAB } from "../../shared/layout";
import type { NodeStatus, NodeSummary } from "../../shared/nodes";
import { dropRefusal, finderRefusal, qualify, sideOf, stepAcross, workspacesAcross, type WorkspacePlace } from "../../shared/remote";
import { NodeWatches, type WatchClient } from "../src/nodewatch";

const OMARCHY = "n0123456789ab";
const BOX = "n00000000000b";

function summary(keys: string[], watchable = 2): NodeSummary {
  return {
    watchable,
    workspaces: keys.map((key) => ({ key, name: key, folder: null, band: "quiet", needs: [], agents: [] })),
  } as unknown as NodeSummary;
}

function node(id: string, keys: string[], state: NodeStatus["state"] = "up", watchable = 2): Pick<NodeStatus, "id" | "state" | "summary"> {
  return { id, state, summary: summary(keys, watchable) };
}

const there = (n: string, workspaceKey: string): WorkspacePlace => ({ there: { node: n, workspaceKey } });

describe("the walk across nodes", () => {
  it("is this node's workspaces, then each node's that can be gone to, in the sidebar's order", () => {
    const places = workspacesAcross(
      ["w1", "w2"],
      [node(OMARCHY, ["k1", "k2"]), node(BOX, ["b1"], "away"), node("n0000000000aa", ["old"], "up", 0)],
    );
    expect(places).toEqual([{ here: "w1" }, { here: "w2" }, there(OMARCHY, "k1"), there(OMARCHY, "k2")]);
  });

  it("steps from the remote workspace on screen, or from the local one, and wraps both ways", () => {
    const places = workspacesAcross(["w1", "w2"], [node(OMARCHY, ["k1", "k2"])]);
    expect(stepAcross(places, { activeId: "w2", remote: null }, 1)).toEqual(there(OMARCHY, "k1"));
    expect(stepAcross(places, { activeId: "w2", remote: { node: OMARCHY, workspaceKey: "k1" } }, 1)).toEqual(there(OMARCHY, "k2"));
    // Off the end of the last node, round to this node's first.
    expect(stepAcross(places, { activeId: "w2", remote: { node: OMARCHY, workspaceKey: "k2" } }, 1)).toEqual({ here: "w1" });
    expect(stepAcross(places, { activeId: "w1", remote: null }, -1)).toEqual(there(OMARCHY, "k2"));
    // Back off the node's first, onto this node's last.
    expect(stepAcross(places, { activeId: "w1", remote: { node: OMARCHY, workspaceKey: "k1" } }, -1)).toEqual({ here: "w2" });
  });

  it("steps from the local workspace when the remote one on screen has left the walk", () => {
    const places = workspacesAcross(["w1", "w2"], [node(OMARCHY, ["k1"], "away")]);
    expect(stepAcross(places, { activeId: "w1", remote: { node: OMARCHY, workspaceKey: "k1" } }, 1)).toEqual({ here: "w2" });
    // A list of one is nowhere to go from itself, and the way home from a node.
    const alone = workspacesAcross(["w1"], []);
    expect(stepAcross(alone, { activeId: "w1", remote: null }, 1)).toBeNull();
    expect(stepAcross(alone, { activeId: "w1", remote: { node: OMARCHY, workspaceKey: "k1" } }, 1)).toEqual({ here: "w1" });
    expect(stepAcross(alone, { activeId: "w1", remote: null }, Number.NaN)).toBeNull();
  });
});

describe("drops across the boundary", () => {
  const names = (n: string | null) => (n === null ? "mac" : n === OMARCHY ? "omarchy" : "?");

  it("knows which machine each dragged thing is on", () => {
    expect(sideOf("agent", "a7")).toBeNull();
    expect(sideOf("agent", qualify(OMARCHY, "a7"))).toBe(OMARCHY);
    expect(sideOf("agent", BOARD_TAB)).toBeUndefined();
    expect(sideOf("pane", qualify(OMARCHY, "p2"))).toBe(OMARCHY);
    // A document's tab is where its pane is: `docId` is index, then the pane.
    expect(sideOf("doc", `0:${qualify(OMARCHY, "p2")}`)).toBe(OMARCHY);
    expect(sideOf("doc", "3:p2")).toBeNull();
    // A file is where its root is.
    expect(sideOf("file", JSON.stringify([qualify(OMARCHY, "/home/o/api"), "README.md"]))).toBe(OMARCHY);
    expect(sideOf("file", JSON.stringify(["/Users/me/api", "README.md"]))).toBeNull();
    expect(sideOf("file", "not json")).toBeNull();
  });

  it("refuses a thing of one machine over the other's pane, in the sentence `route` answers with", () => {
    const remotePane = sideOf("pane", qualify(OMARCHY, "p1"));
    expect(dropRefusal(sideOf("agent", "a3"), remotePane, "agent", names)).toBe("Stays on mac: a terminal cannot move between computers");
    expect(dropRefusal(sideOf("agent", qualify(OMARCHY, "a3")), sideOf("pane", "p1"), "agent", names)).toBe(
      "Stays on omarchy: a terminal cannot move between computers",
    );
    expect(dropRefusal(sideOf("file", JSON.stringify(["/Users/me", "a.md"])), remotePane, "file", names)).toBe(
      "Stays on mac: a file opens only on the computer it is on",
    );
    // The same machine's is an ordinary drop, and the board's tab goes anywhere.
    expect(dropRefusal(sideOf("agent", qualify(OMARCHY, "a3")), remotePane, "agent", names)).toBeNull();
    expect(dropRefusal(sideOf("agent", BOARD_TAB), remotePane, "agent", names)).toBeNull();
    expect(finderRefusal("omarchy")).toContain("not on omarchy");
  });
});

describe("C-a N, C-a P and C-a z, through the relay", () => {
  let watches: NodeWatches | null = null;
  afterEach(() => {
    watches?.close();
    watches = null;
  });

  function setup() {
    const st: WatchClient = { watching: new Set(), warm: new Set(), proposals: new Map(), looking: true, awaiting: new Map() };
    const ws = {} as WebSocket;
    const local = { ids: ["w1", "w2"], activeId: "w1", profile: "p1" };
    const switched: string[] = [];
    const nodes = [{ id: OMARCHY, state: "up", summary: summary(["k1", "k2"]) } as NodeStatus];
    watches = new NodeWatches({
      // Port 9 has nobody on it: the watch stays opening, which is all the stepping needs.
      member: (id) => (id === OMARCHY ? { name: "omarchy", address: "127.0.0.1", port: 9 } : null),
      summary: (id) => (id === OMARCHY ? (nodes[0]!.summary as NodeSummary) : null),
      handshake: () => undefined,
      clients: () => new Map([[ws, st]]),
      send: () => undefined,
      changed: () => undefined,
      log: () => undefined,
      record: () => undefined,
      across: {
        local: () => ({ ids: local.ids, activeId: local.activeId, key: `${local.profile}/${local.activeId}` }),
        nodes: () => nodes,
        switchLocal: (id) => {
          switched.push(id);
          local.activeId = id;
          watches!.noteLocal(`${local.profile}/${id}`);
        },
      },
    });
    watches.noteLocal("p1/w1");
    const step = (delta: number) => watches!.handle(ws, st, { type: "step-workspace", delta });
    const back = () => watches!.handle(ws, st, { type: "last-workspace" });
    const tick = () => new Promise((r) => setTimeout(r, 0));
    return { watches, ws, st, local, switched, nodes, step, back, tick };
  }

  it("walks this node's workspaces, then the node's, and home again", () => {
    const { watches, step, switched } = setup();
    expect(step(1)).toBe(true);
    expect(switched).toEqual(["w2"]);
    expect(watches.view()).toBeNull();
    step(1);
    expect(watches.view()?.workspaceKey).toBe("k1");
    step(1);
    expect(watches.view()?.workspaceKey).toBe("k2");
    step(1);
    expect(watches.view()).toBeNull();
    expect(switched).toEqual(["w2", "w1"]);
    step(-1);
    expect(watches.view()?.workspaceKey).toBe("k2");
  });

  it("toggles between a remote workspace and the local one it was put up over", async () => {
    const { watches, ws, st, step, back, tick, switched } = setup();
    watches.handle(ws, st, { type: "show-node-workspace", nodeId: OMARCHY, workspaceKey: "k2" });
    expect(watches.view()?.workspaceKey).toBe("k2");
    // From the node's, back to w1, without asking the local list for its last.
    expect(back()).toBe(true);
    expect(watches.view()).toBeNull();
    expect(switched).toEqual([]);
    await tick();
    // And from w1, back to the node's.
    expect(back()).toBe(true);
    expect(watches.view()?.workspaceKey).toBe("k2");
    // Taken off screen by a step to a local workspace: z from there goes back to it too.
    step(1);
    expect(watches.view()).toBeNull();
    expect(switched).toEqual(["w1"]);
    await tick();
    expect(back()).toBe(true);
    expect(watches.view()?.workspaceKey).toBe("k2");
  });

  it("leaves z to the local list once the window has moved on, or the node has gone", async () => {
    const { watches, ws, st, local, back, tick, nodes } = setup();
    watches.handle(ws, st, { type: "show-node-workspace", nodeId: OMARCHY, workspaceKey: "k1" });
    back();
    await tick();
    // Somewhere else locally since: z is that workspace's own toggle.
    local.activeId = "w2";
    watches.noteLocal("p1/w2");
    expect(back()).toBe(false);
    local.activeId = "w1";
    watches.noteLocal("p1/w1");
    // Back where the node's was given way to, but the node is away now.
    nodes[0] = { ...nodes[0]!, state: "away" };
    expect(back()).toBe(false);
  });
});
