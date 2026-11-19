/**
 * The floating Kuru's agent count: which terminals are agents, which state
 * each is in, that the waiting agree with the Needs rule, and that other
 * nodes count only while they are up.
 */
import { describe, expect, it } from "bun:test";
import { addCard, emptyBoard, emptyProfileBoard, moveCard, startRun, type Board } from "../../shared/board";
import { countAgents, countSummary, countWords, groupCounts } from "../../shared/agentcount";
import type { AgentSnapshot, Profile, Workspace } from "../../shared/model";
import { needsOf } from "../../shared/needs";
import type { NodeStatus, NodeSummary, SummaryAgent } from "../../shared/nodes";

function agent(id: string, over: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    id,
    kind: "agent",
    title: null,
    status: "idle",
    agent: "claude",
    unread: false,
    cwd: "/w",
    pid: 1,
    command: "claude",
    createdAt: 0,
    contextUsage: null,
    titleOverride: null,
    exited: false,
    exitCode: null,
    ...over,
  } as AgentSnapshot;
}

function workspace(id: string, agentIds: string[], board: Board | null = null): Workspace {
  return {
    id,
    key: `k${id}`,
    name: `ws ${id}`,
    layout: { type: "pane", pane: { id: `p${id}`, agentIds, activeIdx: 0 } },
    board,
  } as unknown as Workspace;
}

function profile(workspaces: Workspace[], harnessId: string | null = null): Profile {
  return {
    id: "p1",
    name: "p",
    workspaces,
    board: emptyProfileBoard(),
    harness: harnessId ? { sessionId: "s", launcher: "claude", agentId: harnessId, startedAt: 0 } : null,
  } as unknown as Profile;
}

function count(p: Profile, agents: AgentSnapshot[], nodes: NodeStatus[] = []) {
  return countAgents(p, agents, needsOf(p, agents), nodes);
}

function node(id: string, name: string, agents: SummaryAgent[], needs: { agentId: string }[] = [], state: NodeStatus["state"] = "up"): NodeStatus {
  const summary = {
    workspaces: [{ key: "box", name: "Box", folder: null, band: "quiet", needs: needs.map((n) => ({ kind: "asking", agentId: n.agentId, cardId: null, title: "" })), agents }],
  } as unknown as NodeSummary;
  return { id, name, state, summary, parent: false } as unknown as NodeStatus;
}

function remote(id: string, over: Partial<AgentSnapshot> = {}): SummaryAgent {
  const { pid: _pid, command: _command, ...rest } = agent(id, over);
  return { ...rest, card: null } as SummaryAgent;
}

describe("the floating Kuru's agent count", () => {
  it("is nothing for no agents", () => {
    const c = count(profile([workspace("w1", [])]), []);
    expect([c.working, c.waiting, c.quiet, c.groups.length]).toEqual([0, 0, 0, 0]);
    expect(countWords(c)).toBe("no agents");
  });

  it("counts agents and not shells, nor Kuru, nor an exited terminal", () => {
    const p = profile([workspace("w1", ["a", "sh", "k", "x", "was"])], "k");
    const c = count(p, [
      agent("a", { status: "working" }),
      agent("sh", { kind: "shell", agent: null, status: "working" }),
      agent("k", { status: "working" }),
      agent("x", { exited: true, status: "working" }),
      // A shell that ran claude and came back to a prompt is still listed, as the sidebar lists it.
      agent("was", { kind: "shell", agent: null, lastAgent: "claude", status: "idle" }),
    ]);
    expect(c.groups[0]!.agents.map((a) => [a.id, a.state])).toEqual([
      ["a", "working"],
      ["was", "quiet"],
    ]);
    expect([c.working, c.waiting, c.quiet]).toEqual([1, 0, 1]);
  });

  it("puts blocked and unseen as waiting, done and idle as quiet, waiting first", () => {
    const p = profile([workspace("w1", ["idle", "work", "ask", "seen", "unseen"])]);
    const c = count(p, [
      agent("idle"),
      agent("work", { status: "working" }),
      agent("ask", { status: "blocked" }),
      agent("seen", { status: "done" }),
      agent("unseen", { status: "done", unread: true }),
    ]);
    expect(c.groups[0]!.agents.map((a) => [a.id, a.state])).toEqual([
      ["ask", "waiting"],
      ["unseen", "waiting"],
      ["work", "working"],
      ["idle", "quiet"],
      ["seen", "quiet"],
    ]);
    expect(groupCounts(c.groups[0]!)).toEqual({ waiting: 2, working: 1, quiet: 2 });
  });

  it("agrees with the Needs rule: a card in Review with its terminal open is waiting, a queued one too", () => {
    let board = addCard(emptyBoard(), { title: "t" }, "c1", 0);
    board = startRun(board, "c1", { agentId: "r", launcher: "claude", label: "claude", startedAt: 0 });
    board = moveCard(board, "c1", "review", 0);
    const p = profile([workspace("w1", ["r", "q"], board)]);
    const agents = [agent("r", { status: "idle" }), agent("q", { status: "working" })];
    const queued = new Map([["q", { lane: "build", since: 0, reason: "busy" }]]);
    const c = countAgents(p, agents, needsOf(p, agents, queued));
    expect(c.groups[0]!.agents.map((a) => [a.id, a.state])).toEqual([
      ["r", "waiting"],
      ["q", "waiting"],
    ]);
  });

  it("groups by workspace in the profile's order and leaves out a workspace with none", () => {
    const p = profile([workspace("w1", ["a"]), workspace("w2", ["sh"]), workspace("w3", ["b"])]);
    const c = count(p, [agent("a"), agent("sh", { kind: "shell", agent: null }), agent("b", { status: "working" })]);
    expect(c.groups.map((g) => g.name)).toEqual(["ws w1", "ws w3"]);
  });

  it("adds another node's agents while it is up, and not while it is away", () => {
    const p = profile([workspace("w1", ["a"])]);
    const up = node("n1", "omarchy", [remote("r1", { status: "working" }), remote("r2", { status: "idle" }), remote("r3", { kind: "shell", agent: null })], [{ agentId: "r2" }]);
    const c = count(p, [agent("a")], [up]);
    expect([c.working, c.waiting, c.quiet]).toEqual([1, 1, 1]);
    const box = c.groups[1]!;
    expect([box.key, box.node?.name, box.workspaceKey, box.workspaceId]).toEqual(["n1/box", "omarchy", "box", null]);
    expect(box.agents.map((a) => [a.id, a.state])).toEqual([
      ["r2", "waiting"],
      ["r1", "working"],
    ]);

    const away = node("n1", "omarchy", [remote("r1", { status: "working" })], [], "away");
    expect(count(p, [agent("a")], [away]).groups).toHaveLength(1);
  });

  it("says itself in words, a line per workspace, cut with how many more", () => {
    const p = profile([workspace("w1", ["a", "b"]), workspace("w2", ["c"]), workspace("w3", ["d"])]);
    const c = count(p, [agent("a", { status: "working" }), agent("b", { status: "blocked" }), agent("c"), agent("d")], [
      node("n1", "omarchy", [remote("r1", { status: "working" })]),
    ]);
    expect(countSummary(c)).toBe(
      ["Agents: 2 working, 1 waiting on you, 2 done or idle", "ws w1: 1 working, 1 waiting on you", "ws w2: 1 done or idle", "ws w3: 1 done or idle", "omarchy · Box: 1 working"].join("\n"),
    );
    expect(countSummary(c, 2).split("\n").slice(-1)[0]).toBe("and 2 more workspaces");
  });
});
