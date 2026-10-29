/**
 * The cards the menu bar offers to pop out as notes: what needs you first, by
 * the Needs drawer's own rule, then the profile's board in its order.
 */
import { describe, expect, it } from "bun:test";
import { addCard, emptyBoard, emptyProfileBoard, NEEDS_COLUMN, type Board } from "../../shared/board";
import type { Profile, Workspace } from "../../shared/model";
import { noteCards } from "../../shared/notecards";

function workspace(id: string, board: Board | null): Workspace {
  return {
    id,
    key: `k${id}`,
    name: id,
    layout: { type: "pane", pane: { id: `p${id}`, agentIds: [], activeIdx: 0 } },
    focusedPaneId: `p${id}`,
    lastPaneId: null,
    group: null,
    mascotId: null,
    board,
    dev: null,
    machine: null,
  } as unknown as Workspace;
}

function profile(workspaces: Workspace[], board: Board): Profile {
  return { id: "p1", key: "abc123", name: "Work", workspaces, board, harness: null } as unknown as Profile;
}

describe("noteCards", () => {
  it("puts a workspace's card in Review and the profile's Needs you ahead of the board", () => {
    let api = addCard(emptyBoard(), { title: "Review the migration" }, "w1", 0);
    api = addCard(api, { title: "Still to do" }, "w2", 0);
    api = { ...api, cards: api.cards.map((c) => (c.id === "w1" ? { ...c, column: "review" } : c)) };
    let own = addCard(emptyProfileBoard(), { title: "The plan" }, "p1", 0);
    own = addCard(own, { title: "Call the bank", column: NEEDS_COLUMN }, "p2", 0);
    const cards = noteCards(profile([workspace("api", api)], own), []);

    expect(cards.profileKey).toBe("abc123");
    expect(cards.needs.map((c) => [c.id, c.code, c.where])).toEqual([
      ["w1", "API-1", "api"],
      ["p2", "WOR-2", null],
    ]);
    // The workspace's To do is the window's to browse, not the menu's.
    expect(cards.columns.flatMap((column) => column.cards).map((c) => c.id)).toEqual(["p1", "p2"]);
  });

  it("lists every lane of the profile's board in its order, empty ones too", () => {
    const board = emptyProfileBoard();
    const cards = noteCards(profile([], board), []);
    expect(cards.columns.map((column) => column.id)).toEqual(board.columns!.map((lane) => lane.id));
    expect(cards.needs).toEqual([]);
  });
});
