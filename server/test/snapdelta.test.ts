/**
 * The snapshot as deltas: whatever moved between two snapshots, applied to
 * the first, is the second — and what did not move is not sent, nor redrawn.
 */
import { describe, expect, it } from "bun:test";
import { addCard, emptyBoard, emptyProfileBoard, type Board } from "../../shared/board";
import type { AgentSnapshot, Profile, SessionSnapshot, Workspace } from "../../shared/model";
import { applyDelta, DeltaMismatch, diffFrames, Framer, type SnapshotDelta } from "../../shared/snapdelta";

function workspace(id: string, board: Board | null): Workspace {
  return {
    id,
    key: `k${id}`,
    name: id,
    layout: { type: "pane", pane: { id: `p${id}`, agentIds: [], activeIdx: 0, board: false } },
    focusedPaneId: `p${id}`,
    lastPaneId: null,
    group: null,
    mascotId: null,
    board,
    machine: null,
    agentPlacement: null,
  } as unknown as Workspace;
}

function agent(id: string, status = "idle", activity: string | null = null): AgentSnapshot {
  return { id, kind: "agent", status, activity, exited: false } as unknown as AgentSnapshot;
}

function snapshot(profile: Profile, agents: AgentSnapshot[], extra: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    session: "kururu",
    profile,
    profiles: [{ id: profile.id, name: profile.name }],
    agents,
    mascots: { mascots: [], active: null },
    keys: {},
    remote: null,
    ...extra,
  } as unknown as SessionSnapshot;
}

function profile(id: string, workspaces: Workspace[], board: Board = emptyProfileBoard()): Profile {
  return { id, key: `key-${id}`, name: id, workspaces, board, activeWorkspaceId: workspaces[0]?.id ?? "", agentOrder: [] } as unknown as Profile;
}

function cards(n: number, prefix: string): Board {
  let board = emptyBoard();
  for (let i = 0; i < n; i++) board = addCard(board, { title: `${prefix} ${i}` }, `${prefix}${i}`, i);
  return board;
}

/** Diff, through JSON as the socket would carry it, and apply. */
function roundTrip(framer: Framer, before: SessionSnapshot, after: SessionSnapshot): { applied: SessionSnapshot; delta: SnapshotDelta | null } {
  const delta = diffFrames(framer.frame(before), framer.frame(after));
  const wire = delta ? (JSON.parse(JSON.stringify(delta)) as SnapshotDelta) : null;
  return { applied: wire ? applyDelta(before, wire) : before, delta };
}

describe("snapshot deltas", () => {
  const big = cards(50, "c");
  const base = snapshot(profile("p1", [workspace("w1", big), workspace("w2", null)]), [agent("a1"), agent("a2")]);

  it("sends nothing when nothing moved, even as new objects", () => {
    const framer = new Framer();
    const again = JSON.parse(JSON.stringify(base)) as SessionSnapshot;
    // A board re-read as a new object costs a stringify, never a send.
    expect(roundTrip(framer, base, again).delta).toBeNull();
  });

  it("sends one agent for a report, and no board", () => {
    const framer = new Framer();
    const after = { ...base, agents: [agent("a1", "working", "Reading files"), agent("a2")] };
    const { applied, delta } = roundTrip(framer, base, after);
    expect(delta).toEqual({ agents: { put: [after.agents[0]!] } });
    expect(applied).toEqual(after);
    // The agent that did not move, and the whole profile, keep their identity.
    expect(applied.agents[1]).toBe(base.agents[1]!);
    expect(applied.profile).toBe(base.profile);
  });

  it("sends one card when one card moved, and keeps the others' identity", () => {
    const framer = new Framer();
    const moved: Board = { ...big, cards: big.cards.map((c, i) => (i === 7 ? { ...c, column: "doing" } : c)) };
    const after = snapshot(profile("p1", [workspace("w1", moved), workspace("w2", null)]), base.agents);
    const { applied, delta } = roundTrip(framer, base, after);
    expect(delta).toEqual({ boards: { "p1/w1": { cards: { put: [moved.cards[7]!] } } } });
    expect(applied).toEqual(after);
    const board = applied.profile.workspaces[0]!.board!;
    expect(board.cards[0]).toBe(big.cards[0]!);
    expect(applied.profile.workspaces[1]).toBe(base.profile.workspaces[1]!);
    expect(applied.profile.board).toBe(base.profile.board);
  });

  it("carries reordering, removal and a board appearing", () => {
    const framer = new Framer();
    const reordered: Board = { ...big, cards: [big.cards[3]!, ...big.cards.filter((_, i) => i !== 3 && i !== 4)] };
    const fresh = cards(2, "n");
    const after = snapshot(profile("p1", [workspace("w1", reordered), workspace("w2", fresh)]), [agent("a2"), agent("a3")]);
    const { applied, delta } = roundTrip(framer, base, after);
    expect(applied).toEqual(after);
    expect(delta!.boards!["p1/w2"]!.cards!.put).toHaveLength(2);
    expect(delta!.boards!["p1/w1"]!.cards!.put).toBeUndefined();
    expect(delta!.agents).toEqual({ order: ["a2", "a3"], put: [agent("a3")] });
  });

  it("sends the profile without boards when the layout moved", () => {
    const framer = new Framer();
    const after = snapshot({ ...base.profile, activeWorkspaceId: "w2" }, base.agents);
    const { applied, delta } = roundTrip(framer, base, after);
    expect(delta!.boards).toBeUndefined();
    expect(JSON.stringify(delta!.profile)).not.toContain('"cards"');
    expect(applied).toEqual(after);
  });

  it("switches profile: the old boards go and the new arrive whole", () => {
    const framer = new Framer();
    const other = profile("p2", [workspace("w9", cards(3, "x"))], addCard(emptyProfileBoard(), { title: "mine" }, "m1", 0));
    const after = snapshot(other, []);
    const { applied, delta } = roundTrip(framer, base, after);
    expect(delta!.boards!["p1"]).toBeNull();
    expect(delta!.boards!["p1/w1"]).toBeNull();
    expect(applied).toEqual(after);
  });

  it("drops a field that went and sets one that changed", () => {
    const framer = new Framer();
    const { remote: _r, ...rest } = base;
    const after = { ...rest, keys: { split: "C-a s" } } as unknown as SessionSnapshot;
    const { applied, delta } = roundTrip(framer, base, after);
    expect(delta).toEqual({ set: { keys: { split: "C-a s" } }, drop: ["remote"] } as unknown as SnapshotDelta);
    expect(applied).toEqual(after);
  });

  it("refuses a delta that names what the snapshot does not have", () => {
    expect(() => applyDelta(base, { agents: { order: ["a1", "ghost"] } })).toThrow(DeltaMismatch);
    expect(() => applyDelta(base, { boards: { "p1/w2": { cards: { put: [] } } } })).toThrow(DeltaMismatch);
  });

  it("keeps a board's frame by identity, so an unchanged board is not stringified again", () => {
    const framer = new Framer();
    expect(framer.frame(base).boards.get("p1/w1")).toBe(framer.frame({ ...base }).boards.get("p1/w1")!);
  });
});
