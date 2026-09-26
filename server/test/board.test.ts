/**
 * The board's pure half, and the one place a card's text reaches a shell.
 *
 * The run automation is the part worth the most tests, because it is the part
 * that moves things a person arranged: it must move a card once, on the edge,
 * and never out of a column somebody dragged it into.
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  addCard,
  adoptBoard,
  columnCards,
  editCard,
  emptyBoard,
  moveCard,
  noteRun,
  startRun,
  storedBoard,
  type Board,
} from "../../shared/board";
import { withPrompt } from "../../shared/launchers";
import { BOARD_TAB, findPane, isBoardTab, panes, visibleAgents } from "../../shared/layout";
import type { Profile } from "../../shared/model";
import { Workspaces } from "../src/workspaces";

function board(...titles: string[]): Board {
  return titles.reduce((b, title, i) => addCard(b, { title }, `c${i}`, 0), emptyBoard());
}

const titles = (b: Board, column: Parameters<typeof columnCards>[1]) => columnCards(b, column).map((c) => c.title);

describe("cards", () => {
  it("refuses a card with no title, and trims the ones it takes", () => {
    expect(addCard(emptyBoard(), { title: "   " }, "x", 0).cards).toHaveLength(0);
    expect(addCard(emptyBoard(), { title: 42 }, "x", 0).cards).toHaveLength(0);
    expect(addCard(emptyBoard(), { title: "  a  ", column: "nope" }, "x", 0).cards[0]).toMatchObject({ title: "a", column: "todo" });
  });

  it("will not empty a title by editing it", () => {
    const b = board("a");
    expect(editCard(b, "c0", { title: "" })).toBe(b);
    expect(editCard(b, "c0", { body: "more" }).cards[0]!.body).toBe("more");
  });

  it("moves to a place among the destination column's cards", () => {
    let b = board("a", "b", "c");
    b = moveCard(b, "c0", "doing");
    b = moveCard(b, "c1", "doing", 0);
    expect(titles(b, "doing")).toEqual(["b", "a"]);
    b = moveCard(b, "c2", "doing", 1);
    expect(titles(b, "doing")).toEqual(["b", "c", "a"]);
    // Within a column, a reorder.
    b = moveCard(b, "c0", "doing", 0);
    expect(titles(b, "doing")).toEqual(["a", "b", "c"]);
  });

  it("refuses an index that is not a place, through JSON", () => {
    const b = board("a");
    for (const bad of [NaN, -1, 0.5, "0"]) {
      const out = moveCard(b, "c0", "done", bad);
      expect(JSON.stringify(out)).toBe(JSON.stringify(b));
    }
    expect(moveCard(b, "c0", "sideways")).toBe(b);
  });
});

describe("runs", () => {
  const started = () =>
    startRun(board("a"), "c0", { agentId: "a1", launcher: "claude", label: "Claude", startedAt: 0 });

  it("puts a handed card in progress", () => {
    expect(started().cards[0]).toMatchObject({ column: "doing", run: { state: "starting", agentId: "a1" } });
  });

  it("sends a finished turn to review, once", () => {
    let b = noteRun(started(), "a1", "working", false, 1);
    expect(b.cards[0]!.run!.state).toBe("working");
    b = noteRun(b, "a1", "done", false, 2);
    expect(b.cards[0]).toMatchObject({ column: "review", run: { state: "finished", endedAt: 2 } });
    // Somebody drags it back. The agent is still `done`, and that is not news.
    b = moveCard(b, "c0", "doing");
    expect(noteRun(b, "a1", "done", false, 3)).toBe(b);
  });

  it("never pulls a card out of a column somebody chose", () => {
    let b = moveCard(noteRun(started(), "a1", "done", false, 1), "c0", "done");
    b = noteRun(b, "a1", "working", false, 2);
    expect(b.cards[0]).toMatchObject({ column: "done", run: { state: "working" } });
  });

  it("is not news when idle, or about another agent", () => {
    const b = started();
    expect(noteRun(b, "a1", "idle", false, 1)).toBe(b);
    expect(noteRun(b, "a2", "done", false, 1)).toBe(b);
  });

  it("keeps finished when the terminal is closed afterwards", () => {
    const b = noteRun(started(), "a1", "done", false, 1);
    expect(noteRun(b, "a1", "", true, 2)).toBe(b);
    expect(noteRun(started(), "a1", "", true, 2).cards[0]!.run!.state).toBe("ended");
  });
});

describe("on disk and in the blob", () => {
  it("writes no process ids, and reads a run with none as ended", () => {
    const b = noteRun(
      startRun(board("a", "b"), "c1", { agentId: "a1", launcher: "claude", label: "Claude", startedAt: 0 }),
      "a1",
      "working",
      false,
      1,
    );
    const back = adoptBoard(JSON.parse(JSON.stringify(storedBoard(b))));
    expect(back!.cards[1]!.run).toMatchObject({ agentId: null, state: "ended" });
  });

  it("keeps a blob's run as it was", () => {
    const b = startRun(board("a"), "c0", { agentId: "a1", launcher: "claude", label: "Claude", startedAt: 0 });
    expect(adoptBoard(JSON.parse(JSON.stringify(b)))).toEqual(b);
  });

  it("drops what is not a card, and has no board for nothing", () => {
    expect(adoptBoard(undefined)).toBeNull();
    expect(adoptBoard(null)).toBeNull();
    const back = adoptBoard({ cards: [null, { id: 1, title: "x" }, { id: "k", title: "ok", column: 7, run: "no" }] });
    expect(back!.cards).toEqual([{ id: "k", title: "ok", body: "", column: "todo", createdAt: 0, run: null }]);
  });
});

describe("withPrompt", () => {
  /** What `sh` hands the program as its last argument. */
  function lastArg(line: string): string {
    const out = spawnSync("sh", ["-c", `set -- ${line.replace(/^\S+/, "")}; eval 'printf %s "\${'$#'}"'`], {
      encoding: "utf8",
    });
    return out.stdout;
  }

  it("arrives as one argument, whatever the card said", () => {
    for (const prompt of ["plain", "it's a 'quote'", "$(rm -rf ~) `x` $HOME", "two\nlines\n\n", "a\\b ; & |"]) {
      expect(lastArg(withPrompt("claude --model x", prompt))).toBe(prompt);
    }
  });

  it("is not read as a flag, and carries no control characters", () => {
    expect(lastArg(withPrompt("claude", "--help me"))).toBe(" --help me");
    expect(lastArg(withPrompt("claude", "a\u001b[31mb\u0007"))).toBe("a[31mb");
  });
});

describe("the board as a tab", () => {
  const tabsOf = (w: Workspaces) =>
    panes(w.activeWorkspace.layout).map((p) => ({ id: p.id, tabs: p.agentIds, showing: p.agentIds[p.activeIdx] }));

  it("is made only when asked for, into an empty pane, and shown", () => {
    const w = new Workspaces();
    expect(w.activeWorkspace.board).toBeNull();
    const pane = w.activeWorkspace.focusedPaneId;
    expect(w.openBoard(pane)).toBe(pane);
    expect(w.activeWorkspace.board).toEqual({ cards: [] });
    expect(tabsOf(w)).toEqual([{ id: pane, tabs: [BOARD_TAB], showing: BOARD_TAB }]);
  });

  it("goes beside a pane that is busy, and a second ask finds the same one", () => {
    const w = new Workspaces();
    const first = w.activeWorkspace.focusedPaneId;
    w.addTab("a1", "/x", first);
    const made = w.openBoard(first)!;
    expect(made).not.toBe(first);
    w.addTab("a2", "/x", made);
    expect(w.openBoard(first)).toBe(made);
    expect(findPane(w.activeWorkspace.layout, made)!.agentIds[findPane(w.activeWorkspace.layout, made)!.activeIdx]).toBe(BOARD_TAB);
    expect(panes(w.activeWorkspace.layout).flatMap((p) => p.agentIds).filter(isBoardTab)).toHaveLength(1);
  });

  it("moves into a pane when opened `here`, beside the terminals already in it", () => {
    const w = new Workspaces();
    const first = w.activeWorkspace.focusedPaneId;
    w.addTab("a1", "/x", first);
    const other = w.openBoard(first)!;
    w.addTab("a2", "/x", other);
    w.openBoard(first, true);
    expect(findPane(w.activeWorkspace.layout, first)!.agentIds).toEqual(["a1", BOARD_TAB]);
    expect(findPane(w.activeWorkspace.layout, other)!.agentIds).toEqual(["a2"]);
  });

  it("is never handed back to be killed, watched or typed into", () => {
    const w = new Workspaces();
    const pane = w.activeWorkspace.focusedPaneId;
    w.addTab("a1", "/x", pane);
    w.openBoard(pane, true);
    expect(w.visible()).toEqual([]);
    expect(w.focusedAgent()).toBeNull();
    expect(w.agentsHere()).toEqual(["a1"]);
    expect(w.allAgents()).toEqual(["a1"]);
    const beside = w.split("row", pane)!;
    expect(w.closePane(pane)).toEqual(["a1"]);
    expect(w.hasPane(beside)).toBe(true);
    // The cards outlive the tab.
    expect(w.activeWorkspace.board).not.toBeNull();
  });

  it("stays in its own workspace", () => {
    const w = new Workspaces();
    const home = w.activeWorkspace.id;
    w.openBoard(w.activeWorkspace.focusedPaneId);
    const away = w.newWorkspace("b");
    w.openBoard(w.activeWorkspace.focusedPaneId);
    w.removeTab(BOARD_TAB);
    w.switchWorkspace(home);
    expect(visibleAgents(w.activeWorkspace.layout)).toEqual([]);
    expect(panes(w.activeWorkspace.layout)[0]!.agentIds).toEqual([BOARD_TAB]);
    w.moveTabToWorkspace(BOARD_TAB, away);
    expect(panes(w.activeWorkspace.layout)[0]!.agentIds).toEqual([BOARD_TAB]);
  });

  it("turns a board pane from the first version into a board tab", () => {
    const w = new Workspaces();
    const blob = JSON.parse(JSON.stringify(w.all())) as Profile[];
    const pane = blob[0]!.workspaces[0]!.layout as { pane: Record<string, unknown> };
    pane.pane.board = true;
    blob[0]!.workspaces[0]!.board = { cards: [] };
    const back = new Workspaces(blob);
    const restored = panes(back.activeWorkspace.layout)[0]!;
    expect(restored.agentIds).toEqual([BOARD_TAB]);
    expect("board" in restored).toBe(false);
  });
});
