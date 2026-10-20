/**
 * What needs a person, across a profile: which things count, which do not,
 * and the walk from one to the next.
 *
 * Every case that counts is one where nothing moves without somebody, and
 * every case that does not is one that would have taught a person to ignore
 * the chip — a working agent, a reminder, a shell that finished a command,
 * Kuru asking in its own chip's place.
 */
import { describe, expect, it } from "bun:test";
import { addCard, emptyBoard, moveCard, noteRun, startRun, type Board, type Card } from "../../shared/board";
import type { AgentSnapshot, Profile, Workspace } from "../../shared/model";
import { allNeeds, doneRefusal, needsOf, nextNeed } from "../../shared/needs";

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

function workspace(id: string, agentIds: string[], board: Board | null = null): Workspace {
  return {
    id,
    key: `k${id}`,
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

function profile(workspaces: Workspace[], harnessId: string | null = null): Profile {
  return {
    id: "p1",
    name: "p",
    workspaces,
    harness: harnessId ? { sessionId: "s", launcher: "claude", agentId: harnessId, startedAt: 0 } : null,
  } as unknown as Profile;
}

/** A board with one card handed to `agentId`, carried to `status` the way the server carries it. */
function cardOn(agentId: string, status: "working" | "done" | "blocked", column?: "review" | "doing"): Board {
  let board = addCard(emptyBoard(), { title: "the card" }, "c1", 0);
  board = startRun(board, "c1", { agentId, launcher: "claude", label: "claude", startedAt: 0 });
  board = noteRun(board, agentId, "working", false, 1);
  if (status !== "working") board = noteRun(board, agentId, status, false, 2);
  if (column) board = { ...board, cards: board.cards.map((c) => ({ ...c, column })) };
  return board;
}

describe("what needs you", () => {
  it("counts an agent asking, before anything else in its workspace", () => {
    const p = profile([workspace("w1", ["a", "b"])]);
    const needs = needsOf(p, [agent("a", { unread: true, status: "done" }), agent("b", { status: "blocked" })]);
    expect(needs.count).toBe(2);
    expect(needs.inWorkspaces).toBe(1);
    expect(needs.workspaces[0]!.band).toBe("needs");
    expect(needs.workspaces[0]!.needs.map((n) => [n.kind, n.agent?.id])).toEqual([
      ["asking", "b"],
      ["unseen", "a"],
    ]);
  });

  it("does not count a working agent, but says the workspace is working", () => {
    const p = profile([workspace("w1", ["a"])]);
    const needs = needsOf(p, [agent("a", { status: "working" })]);
    expect(needs.count).toBe(0);
    expect(needs.workspaces[0]!.band).toBe("working");
    expect(needs.workspaces[0]!.working.map((a) => a.id)).toEqual(["a"]);
  });

  it("is quiet for an idle agent, a done one somebody saw, and an exited one", () => {
    const p = profile([workspace("w1", ["a", "b", "c"])]);
    const needs = needsOf(p, [agent("a"), agent("b", { status: "done" }), agent("c", { status: "blocked", exited: true })]);
    expect(needs.count).toBe(0);
    expect(needs.workspaces[0]!.band).toBe("quiet");
  });

  it("never counts the harness: Kuru asking is the chip's", () => {
    const p = profile([workspace("w1", ["k", "a"])], "k");
    const needs = needsOf(p, [agent("k", { status: "blocked" }), agent("a", { status: "working" })]);
    expect(needs.count).toBe(0);
    expect(needs.workspaces[0]!.band).toBe("working");
    expect(needs.workspaces[0]!.working.map((a) => a.id)).toEqual(["a"]);
  });

  it("ignores a shell that finished a command off screen", () => {
    const p = profile([workspace("w1", ["s"])]);
    const needs = needsOf(p, [agent("s", { agent: null, lastAgent: null, unread: true, status: "done" } as Partial<AgentSnapshot>)]);
    expect(needs.count).toBe(0);
  });

  it("counts a card in Review as the card, with its agent, and never twice", () => {
    const p = profile([workspace("w1", ["a"], cardOn("a", "done"))]);
    const needs = needsOf(p, [agent("a", { status: "done", unread: true })]);
    expect(needs.count).toBe(1);
    const need = needs.workspaces[0]!.needs[0]!;
    expect(need.kind).toBe("review");
    expect(need.card?.id).toBe("c1");
    expect(need.agent?.id).toBe("a");
    // Its terminal is still open, so Done would ask about ending it: not plain.
    expect(need.plainDone).toBe(false);
  });

  it("offers a plain Done for a Review card with no worktree and no terminal", () => {
    const board = cardOn("gone", "done");
    const p = profile([workspace("w1", [], board)]);
    const needs = needsOf(p, []);
    expect(needs.workspaces[0]!.needs.map((n) => [n.kind, n.plainDone, n.agent])).toEqual([["review", true, null]]);
  });

  it("counts a Review card whose agent is asking as asking, and not as plain", () => {
    const p = profile([workspace("w1", ["a"], cardOn("a", "blocked", "review"))]);
    const needs = needsOf(p, [agent("a", { status: "blocked" })]);
    expect(needs.workspaces[0]!.needs.map((n) => [n.kind, n.plainDone])).toEqual([["asking", false]]);
  });

  it("counts an In progress card whose agent ended without finishing, and not one still working", () => {
    const stalled = noteRun(cardOn("a", "working"), "a", "idle", true, 3);
    expect(stalled.cards[0]!.run?.state).toBe("ended");
    const p = profile([workspace("w1", [], stalled), workspace("w2", ["b"], cardOn("b", "working"))]);
    const needs = needsOf(p, [agent("b", { status: "working" })]);
    expect(needs.workspaces.map((w) => [w.band, w.needs.map((n) => n.kind)])).toEqual([
      ["needs", ["stalled"]],
      ["working", []],
    ]);
  });

  it("leaves To do and Done cards alone, and their agents show as themselves", () => {
    const done = { ...cardOn("a", "done"), cards: cardOn("a", "done").cards.map((c) => ({ ...c, column: "done" })) };
    const p = profile([workspace("w1", ["a"], done)]);
    const needs = needsOf(p, [agent("a", { status: "blocked" })]);
    expect(needs.workspaces[0]!.needs.map((n) => [n.kind, n.card])).toEqual([["asking", null]]);
  });

  it("files a card's agent under the card's workspace wherever its tab was dragged", () => {
    // The card is on w1; its agent's tab was moved to w2.
    const p = profile([workspace("w1", [], cardOn("a", "blocked")), workspace("w2", ["a"])]);
    const needs = needsOf(p, [agent("a", { status: "blocked" })]);
    expect(needs.workspaces.map((w) => [w.workspace.id, w.band, w.needs.length])).toEqual([
      ["w1", "needs", 1],
      ["w2", "quiet", 0],
    ]);
  });

  it("keeps the workspaces in the sidebar's order, every one of them", () => {
    const p = profile([workspace("q", []), workspace("n", ["a"]), workspace("w", ["b"])]);
    const needs = needsOf(p, [agent("a", { status: "blocked" }), agent("b", { status: "working" })]);
    expect(needs.workspaces.map((w) => [w.workspace.id, w.band])).toEqual([
      ["q", "quiet"],
      ["n", "needs"],
      ["w", "working"],
    ]);
  });
});

describe("the walk", () => {
  const p = profile([workspace("w1", ["a", "b"]), workspace("w2", [], cardOn("gone", "done"))]);
  const needs = needsOf(p, [agent("a", { status: "blocked" }), agent("b", { status: "done", unread: true })]);

  it("goes to the first when you are on none", () => {
    expect(allNeeds(needs).map((n) => n.kind)).toEqual(["asking", "unseen", "review"]);
    expect(nextNeed(needs, { focusedAgentId: null, workspaceId: "w1", boardShowing: false })?.agent?.id).toBe("a");
  });

  it("steps past the one you are on, and round to the first", () => {
    expect(nextNeed(needs, { focusedAgentId: "a", workspaceId: "w1", boardShowing: false })?.agent?.id).toBe("b");
    const last = nextNeed(needs, { focusedAgentId: "b", workspaceId: "w1", boardShowing: false });
    expect(last?.card?.id).toBe("c1");
    // On the card — its workspace showing its board — the walk wraps.
    expect(nextNeed(needs, { focusedAgentId: null, workspaceId: "w2", boardShowing: true })?.agent?.id).toBe("a");
  });

  it("is nothing when nothing needs you", () => {
    expect(nextNeed(needsOf(profile([workspace("w1", [])]), []), { focusedAgentId: null, workspaceId: null, boardShowing: false })).toBeNull();
  });
});

describe("doneRefusal: whether Done is a plain move, said as why not", () => {
  const review = (over: Partial<Card> = {}): Card => ({ ...moveCard(addCard(emptyBoard(), { title: "t" }, "c1", 0), "c1", "review").cards[0]!, ...over });
  it("is null for a card in Review with no worktree and no terminal open", () => {
    expect(doneRefusal(review(), null)).toBeNull();
  });
  it("says why for every other card, in the order the board would ask", () => {
    expect(doneRefusal({ ...review(), column: "done" }, null)).toBe("It is in Done already.");
    expect(doneRefusal({ ...review(), column: "doing" }, null)).toBe("It is not in Review any more.");
    expect(doneRefusal(review(), agent("a1", { status: "blocked" }))).toBe("Its agent is asking something.");
    expect(doneRefusal(review({ worktree: { path: "/w/.kururu/x", branch: "kururu/x", base: "main" } as Card["worktree"] }), null)).toContain("worktree is still standing");
    expect(doneRefusal(review(), agent("a1"))).toContain("agent is still open");
  });
  it("is what plainDone is drawn by", () => {
    const board = cardOn("a1", "done", "review");
    const plain = needsOf(profile([workspace("w1", [], board)]), [agent("a1", { exited: true })]);
    expect(plain.workspaces[0]!.needs[0]!.plainDone).toBe(doneRefusal(board.cards[0]!, null) === null);
  });
});
