/**
 * The Needs drawer's own order: groups and cards where the person put them,
 * new ones at the foot, the agent rows nobody can move left where the rule
 * put them, and a saved list that keeps a quiet workspace's place without
 * keeping a deleted one's.
 */
import { describe, expect, it } from "bun:test";
import { addCard, emptyBoard, emptyProfileBoard, moveCard, type Board } from "../../shared/board";
import type { AgentSnapshot, Profile, Workspace } from "../../shared/model";
import { allNeeds, needsOf } from "../../shared/needs";
import {
  arrange,
  arrangedNeeds,
  arrangeNeeds,
  BOARD_GROUP,
  dropIndex,
  moveTo,
  movesFrom,
  NO_ORDER,
  parseOrders,
  reorder,
  withCards,
  withGroups,
} from "../src/needsorder";

function agent(id: string, over: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    id,
    kind: "shell",
    title: null,
    status: "idle",
    agent: "claude",
    unread: false,
    cwd: "/w",
    pid: 1,
    command: "claude",
    createdAt: 0,
    contextUsage: null,
    exited: false,
    ...over,
  } as AgentSnapshot;
}

/** A board with these cards in Review, in this order. */
function review(...ids: string[]): Board {
  let board = emptyBoard();
  for (const id of ids) board = moveCard(addCard(board, { title: id }, id, 0), id, "review");
  return board;
}

function workspace(id: string, agentIds: string[], board: Board | null = null): Workspace {
  return {
    id,
    key: `wk${id}`,
    name: id,
    layout: { type: "pane", pane: { id: `p${id}`, agentIds, activeIdx: 0 } },
    focusedPaneId: `p${id}`,
    lastPaneId: null,
    group: null,
    mascotId: null,
    board,
    dev: null,
    machine: null,
  } as unknown as Workspace;
}

function profile(workspaces: Workspace[]): Profile {
  return { id: "p1", key: "pk1", name: "p", workspaces, board: emptyProfileBoard(), harness: null } as unknown as Profile;
}

const ids = (list: readonly { card: { id: string } | null; agent: AgentSnapshot | null }[]) =>
  list.map((need) => need.card?.id ?? `agent ${need.agent!.id}`);

describe("arrange", () => {
  it("is the order it was given while nothing is saved", () => {
    expect(arrange(["a", "b", "c"], (k) => k, [])).toEqual(["a", "b", "c"]);
  });

  it("puts what the saved list names in its order, and what it does not after, as it came", () => {
    expect(arrange(["a", "b", "c", "d"], (k) => k, ["c", "a"])).toEqual(["c", "a", "b", "d"]);
  });

  it("ignores saved keys for things that are not there", () => {
    expect(arrange(["a", "b"], (k) => k, ["x", "b", "y"])).toEqual(["b", "a"]);
  });
});

describe("reorder", () => {
  const known = () => true;

  it("saves the drawn keys in their new order", () => {
    expect(reorder([], ["a", "b", "c"], ["c", "a", "b"], known)).toEqual(["c", "a", "b"]);
  });

  it("keeps the place of a key that is not drawn now, so it comes back where it was", () => {
    // b went quiet; a and c swap; b is still between them in the saved list.
    const saved = reorder(["a", "b", "c"], ["a", "c"], ["c", "a"], known);
    expect(saved).toEqual(["c", "b", "a"]);
    expect(arrange(["a", "b", "c"], (k) => k, saved)).toEqual(["c", "b", "a"]);
  });

  it("takes in a new one where it was drawn, which is the foot", () => {
    const drawn = arrange(["a", "b", "n"], (k) => k, ["b", "a"]);
    expect(drawn).toEqual(["b", "a", "n"]);
    expect(reorder(["b", "a"], drawn, ["n", "b", "a"], known)).toEqual(["n", "b", "a"]);
  });

  it("drops a key nothing knows any more, and only when it is not drawn", () => {
    expect(reorder(["gone", "a", "b"], ["a", "b"], ["b", "a"], (k) => k !== "gone")).toEqual(["b", "a"]);
  });
});

describe("moveTo and movesFrom", () => {
  it("counts the index with the moved one taken out, as moveCard does", () => {
    expect(moveTo(["a", "b", "c", "d"], "a", 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveTo(["a", "b", "c", "d"], "d", 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveTo(["a", "b"], "a", 99)).toEqual(["b", "a"]);
    expect(moveTo(["a", "b"], "x", 0)).toEqual(["a", "b"]);
  });

  it("offers only the moves that go somewhere", () => {
    expect(movesFrom(0, 3)).toEqual({ down: 1, bottom: 2 });
    expect(movesFrom(1, 3)).toEqual({ up: 0, top: 0, down: 2, bottom: 2 });
    expect(movesFrom(2, 3)).toEqual({ up: 1, top: 0 });
    expect(movesFrom(0, 1)).toEqual({});
    expect(movesFrom(-1, 3)).toEqual({});
  });
});

describe("dropIndex", () => {
  const rows = ["ca", "cb", "cc", "cd"];

  it("lands before or after the row it was let go on", () => {
    expect(dropIndex(rows, "ca", "cc", false)).toBe(1);
    expect(dropIndex(rows, "ca", "cc", true)).toBe(2);
    expect(dropIndex(rows, "cd", "ca", false)).toBe(0);
    expect(moveTo(["ca", "cb", "cc", "cd"], "ca", dropIndex(rows, "ca", "cc", true))).toEqual(["cb", "cc", "ca", "cd"]);
  });

  it("counts only the cards, so a drop on an agent row lands among the cards beside it", () => {
    const mixed = ["aX", "ca", "cb", "aY"];
    const isCard = (k: string) => k.startsWith("c");
    expect(dropIndex(mixed, "cb", "aX", false, isCard)).toBe(0);
    expect(dropIndex(mixed, "ca", "aY", false, isCard)).toBe(1);
    expect(dropIndex(mixed, "ca", "aY", true, isCard)).toBe(1);
  });
});

describe("a workspace's needs, arranged", () => {
  // x asks with no card, y finished unseen with no card, and three cards in Review.
  const ws = workspace("w1", ["x", "y"], review("c1", "c2", "c3"));
  const agents = [agent("x", { status: "blocked" }), agent("y", { unread: true, status: "done" })];
  const needs = needsOf(profile([ws]), agents).workspaces[0]!.needs;

  it("is the rule's order with nothing saved", () => {
    expect(ids(arrangeNeeds(needs, undefined))).toEqual(ids(needs));
    expect(ids(needs)).toEqual(["agent x", "c1", "c2", "c3", "agent y"]);
  });

  it("moves the cards and leaves the agent rows where the rule put them", () => {
    expect(ids(arrangeNeeds(needs, ["c3", "c1", "c2"]))).toEqual(["agent x", "c3", "c1", "c2", "agent y"]);
  });

  it("puts a card the saved order has not met in the last card place", () => {
    expect(ids(arrangeNeeds(needs, ["c2", "c1"]))).toEqual(["agent x", "c2", "c1", "c3", "agent y"]);
  });
});

describe("a profile's needs, arranged", () => {
  const p = profile([
    workspace("w1", ["a1"]),
    workspace("w2", ["a2"]),
    workspace("w3", ["a3"]),
    workspace("w4", [], review("c1", "c2")),
  ]);
  const agents = [agent("a1", { status: "blocked" }), agent("a2", { status: "working" }), agent("a3", { status: "blocked" })];
  const needs = needsOf(p, agents);

  it("is the same object with nothing saved", () => {
    expect(arrangedNeeds(needs, NO_ORDER)).toBe(needs);
  });

  it("sorts only the waiting band, into the places it held, and leaves the counts", () => {
    const arranged = arrangedNeeds(needs, { groups: ["wkw4", BOARD_GROUP, "wkw3", "wkw1"], cards: { wkw4: ["c2", "c1"] } });
    // w2 is working, and stays where it was in the list: second.
    expect(arranged.workspaces.map((w) => w.workspace.id)).toEqual(["w4", "w2", "w3", "w1"]);
    expect(arranged.workspaces[0]!.needs.map((n) => n.card?.id)).toEqual(["c2", "c1"]);
    expect(arranged.count).toBe(needs.count);
    expect(arranged.inWorkspaces).toBe(needs.inWorkspaces);
  });

  it("is the order Next walks", () => {
    const arranged = arrangedNeeds(needs, { groups: ["wkw3", "wkw4"], cards: { wkw4: ["c2"] } });
    expect(allNeeds(arranged).map((n) => n.card?.id ?? n.agent!.id)).toEqual(["a3", "c2", "c1", "a1"]);
  });
});

describe("saving an order", () => {
  const p = profile([workspace("w1", [], review("c1", "c2")), workspace("w2", [])]);

  it("saves a group's cards by its key, and forgets a card no longer on its board", () => {
    const order = withCards({ groups: [], cards: { wkw1: ["gone", "c2", "c1"] } }, p, "wkw1", ["c2", "c1"], ["c1", "c2"]);
    expect(order.cards).toEqual({ wkw1: ["c1", "c2"] });
  });

  it("forgets a deleted workspace's cards and place, and never Your board's", () => {
    const order = withGroups({ groups: ["wkold", BOARD_GROUP, "wkw1"], cards: { wkold: ["c9"] } }, p, ["wkw1", "wkw2"], ["wkw2", "wkw1"]);
    expect(order.groups).toEqual([BOARD_GROUP, "wkw2", "wkw1"]);
    expect(order.cards).toEqual({});
  });

  it("reads back only what has the right shape", () => {
    expect(parseOrders(null)).toEqual({});
    expect(parseOrders([1, 2])).toEqual({});
    expect(parseOrders({ pk1: { groups: ["a", 3, "b"], cards: { w: ["c1", null], v: "x" } }, pk2: 7 })).toEqual({
      pk1: { groups: ["a", "b"], cards: { w: ["c1"] } },
    });
  });
});
