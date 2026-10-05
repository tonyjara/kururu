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
  addLane,
  adoptBoard,
  adoptDates,
  colorLane,
  shiftDates,
  timeline,
  adoptProfileBoard,
  boardLanes,
  emptyProfileBoard,
  moveLane,
  removeLane,
  renameLane,
  canResume,
  cardCode,
  columnCards,
  editCard,
  emptyBoard,
  moveCard,
  noteRun,
  removeCard,
  transferCard,
  setWorktree,
  startRun,
  storedBoard,
  type Board,
} from "../../shared/board";
import { findLauncher, resumeCommand, withPrompt } from "../../shared/launchers";
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

  it("keeps a session id and cwd across a cold start, and drops ones that could not be", () => {
    const id = "0b6c2f1e-8d7a-4c3b-9e2f-1a2b3c4d5e6f";
    const b = startRun(board("a"), "c0", { agentId: "a1", launcher: "claude", label: "Claude", startedAt: 0, sessionId: id, cwd: "/w" });
    expect(adoptBoard(JSON.parse(JSON.stringify(storedBoard(b))))!.cards[0]!.run).toMatchObject({ sessionId: id, cwd: "/w" });
    const bad = adoptBoard({ cards: [{ id: "k", title: "t", run: { launcher: "claude", sessionId: "x; rm -rf ~", cwd: "rel" } }] });
    expect(bad!.cards[0]!.run).toMatchObject({ sessionId: null, cwd: null });
  });

  /**
   * A card's number is its place in the order the board was written in, and
   * is never handed out twice — deleting the newest card does not give its
   * number to the next one.
   */
  it("numbers cards in the order they were written, and never reuses a number", () => {
    const b = board("a", "b", "c");
    expect(b.cards.map((c) => c.number)).toEqual([1, 2, 3]);
    const again = addCard(removeCard(b, "c2"), { title: "d" }, "c3", 0);
    expect(again.cards.map((c) => c.number)).toEqual([1, 2, 4]);
    expect(adoptBoard(JSON.parse(JSON.stringify(storedBoard(again))))).toEqual(again);
  });

  it("numbers a board from before numbers by when its cards were written, after any it has", () => {
    const back = adoptBoard({
      cards: [
        { id: "x", title: "late", createdAt: 30 },
        { id: "y", title: "kept", createdAt: 10, number: 5 },
        { id: "z", title: "early", createdAt: 20 },
        { id: "w", title: "clash", createdAt: 40, number: 5 },
      ],
    })!;
    expect(back.cards.map((c) => [c.id, c.number])).toEqual([["x", 7], ["y", 5], ["z", 6], ["w", 8]]);
    expect(back.next).toBe(9);
    expect(adoptBoard({ cards: [], next: 12 })!.next).toBe(12);
  });

  it("codes a card with its workspace's first three letters", () => {
    expect(cardCode("kururu", 12)).toBe("KUR-12");
    expect(cardCode("my app", 3)).toBe("MYA-3");
    expect(cardCode("ok", 1)).toBe("OK-1");
    expect(cardCode("—", 4)).toBe("#4");
  });

  it("drops what is not a card, and has no board for nothing", () => {
    expect(adoptBoard(undefined)).toBeNull();
    expect(adoptBoard(null)).toBeNull();
    const back = adoptBoard({ cards: [null, { id: 1, title: "x" }, { id: "k", title: "ok", column: 7, run: "no" }] });
    expect(back!.cards).toEqual([{ id: "k", number: 1, title: "ok", body: "", column: "todo", createdAt: 0, run: null, isolate: false, worktree: null, dev: null, dates: null }]);
  });

  /**
   * The worktree box is the card's, off unless ticked. A card from before it
   * was — one with a worktree standing — reads as having ticked it.
   */
  it("keeps a card's worktree box, and ticks it for a card that already has a worktree", () => {
    const b = addCard(emptyBoard(), { title: "a", isolate: true }, "c0", 0);
    expect(b.cards[0]!.isolate).toBe(true);
    expect(addCard(emptyBoard(), { title: "a", isolate: "yes" }, "c0", 0).cards[0]!.isolate).toBe(false);
    expect(adoptBoard(JSON.parse(JSON.stringify(storedBoard(b))))!.cards[0]!.isolate).toBe(true);
    expect(editCard(b, "c0", { isolate: false }).cards[0]!.isolate).toBe(false);
    expect(editCard(b, "c0", { title: "b" }).cards[0]!.isolate).toBe(true);
    const tree = { root: "/r/app", path: "/r/app.worktrees/fix-c0", branch: "kururu/fix-c0", base: "main" };
    expect(adoptBoard({ cards: [{ id: "k", title: "ok", worktree: tree }] })!.cards[0]!.isolate).toBe(true);
  });

  /**
   * A worktree is paths and refs, and all of it goes to disk: the checkout is
   * still standing after a cold start and the card has to know where. Half a
   * worktree is dropped — kururu cannot merge or remove what it cannot name.
   */
  it("keeps a card's worktree across the disk, and drops one with a field missing", () => {
    const tree = { root: "/r/app", path: "/r/app.worktrees/fix-c0", branch: "kururu/fix-c0", base: "main" };
    const b = setWorktree(board("a"), "c0", tree);
    const back = adoptBoard(JSON.parse(JSON.stringify(storedBoard(b))));
    expect(back!.cards[0]!.worktree).toEqual(tree);
    const half = adoptBoard({ cards: [{ id: "k", title: "ok", worktree: { root: "/r", path: "rel", branch: "b", base: "m" } }] });
    expect(half!.cards[0]!.worktree).toBeNull();
    expect(adoptBoard({ cards: [{ id: "k", title: "ok", worktree: { root: "/r", branch: "b" } }] })!.cards[0]!.worktree).toBeNull();
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
    expect(w.activeWorkspace.board).toEqual({ cards: [], next: 1 });
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

describe("resuming a card", () => {
  const id = "0b6c2f1e-8d7a-4c3b-9e2f-1a2b3c4d5e6f";
  const run = (launcher: string, sessionId: string | null) =>
    startRun(board("a"), "c0", { agentId: null, launcher, label: launcher, startedAt: 0, sessionId }).cards[0]!.run;

  it("needs the agent gone, and a conversation it can find", () => {
    expect(canResume(run("claude", id), false)).toBe(true);
    expect(canResume(run("claude", id), true)).toBe(false);
    expect(canResume(run("claude", null), false)).toBe(false);
    expect(canResume(run("codex", null), false)).toBe(true);
    expect(canResume(null, false)).toBe(false);
  });

  it("hands Claude its id and Codex its picker", () => {
    const settings = { offClis: [], offLaunchers: [], bypassClis: ["claude" as const], loginsPerProfile: false };
    expect(resumeCommand(findLauncher("claude:claude-opus-5-5")!, settings, id, false)).toBe(
      `claude --model claude-opus-5-5 --dangerously-skip-permissions --resume ${id}`,
    );
    expect(resumeCommand(findLauncher("claude")!, settings, "not-a-uuid", false)).toBeNull();
    expect(resumeCommand(findLauncher("codex")!, settings, null, false)).toBe("codex resume");
    expect(resumeCommand(findLauncher("codex:gpt-5.5")!, settings, null, true)).toBe("codex resume --all --model gpt-5.5");
  });
});

describe("transferCard", () => {
  const two = () => {
    let from = emptyBoard();
    from = addCard(from, { title: "flicker", body: "on the phone", column: "doing" }, "c1", 1);
    from = addCard(from, { title: "other" }, "c2", 2);
    let to = emptyBoard();
    for (const n of [1, 2, 3]) to = addCard(to, { title: `t${n}` }, `w${n}`, n);
    return { from, to };
  };

  it("takes the card off one board and numbers it on the other", () => {
    const { from, to } = two();
    const out = transferCard(from, to, "c1");
    expect(out.from.cards.map((c) => c.id)).toEqual(["c2"]);
    const moved = out.to.cards.find((c) => c.id === "c1")!;
    expect(moved).toMatchObject({ title: "flicker", body: "on the phone", column: "doing", number: 4, run: null, worktree: null });
    expect(out.to.next).toBe(5);
    // The profile's counter is not given back: a number is never handed out twice.
    expect(out.from.next).toBe(3);
  });

  it("lands at the foot of its column", () => {
    const { from, to } = two();
    const out = transferCard(from, to, "c2");
    expect(columnCards(out.to, "todo").map((c) => c.id)).toEqual(["w1", "w2", "w3", "c2"]);
  });

  it("changes nothing for a card that is not there", () => {
    const { from, to } = two();
    const out = transferCard(from, to, "nope");
    expect(out.from).toBe(from);
    expect(out.to).toBe(to);
  });
});

describe("the profile's columns", () => {
  const withCards = () => {
    let board = emptyProfileBoard();
    board = addCard(board, { title: "a", column: "todo" }, "c1", 1);
    board = addCard(board, { title: "b", column: "doing" }, "c2", 2);
    board = addCard(board, { title: "c", column: "doing" }, "c3", 3);
    return board;
  };

  it("adds, renames and moves a column, and cards can go in it", () => {
    let board = addLane(emptyProfileBoard(), "  Someday ", "k1");
    expect(boardLanes(board).map((l) => l.name)).toEqual(["To do", "In progress", "Done", "Someday"]);
    board = renameLane(board, "k1", "Later");
    board = moveLane(board, "k1", 0);
    expect(boardLanes(board).map((l) => l.id)).toEqual(["k1", "todo", "doing", "done"]);
    board = addCard(board, { title: "x", column: "k1" }, "c1", 1);
    expect(columnCards(board, "k1").map((c) => c.id)).toEqual(["c1"]);
  });

  it("refuses an empty name, a duplicate id, a bad index, and a workspace board", () => {
    const board = emptyProfileBoard();
    expect(addLane(board, "   ", "k1")).toBe(board);
    expect(addLane(board, "Again", "todo")).toBe(board);
    expect(moveLane(board, "todo", Number.NaN)).toBe(board);
    expect(renameLane(board, "nope", "x")).toBe(board);
    const workspace = emptyBoard();
    expect(addLane(workspace, "Someday", "k1")).toBe(workspace);
  });

  it("keeps a column's cards when it is deleted, moving them to its neighbour", () => {
    const board = removeLane(withCards(), "doing");
    expect(boardLanes(board).map((l) => l.id)).toEqual(["todo", "done"]);
    expect(columnCards(board, "todo").map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(columnCards(removeLane(withCards(), "todo"), "doing").map((c) => c.id)).toEqual(["c2", "c3", "c1"]);
  });

  it("never deletes the last column", () => {
    let board = emptyProfileBoard();
    board = removeLane(removeLane(board, "todo"), "doing");
    expect(removeLane(board, "done")).toBe(board);
  });

  it("holds a card to the board's own columns", () => {
    const board = withCards();
    expect(moveCard(board, "c1", "review")).toBe(board);
    expect(addCard(board, { title: "d", column: "review" }, "c4", 4).cards.at(-1)!.column).toBe("todo");
  });

  it("sends a card from a made column to the workspace's To do", () => {
    let from = addLane(emptyProfileBoard(), "Someday", "k1");
    from = addCard(from, { title: "x", column: "k1" }, "c1", 1);
    const out = transferCard(from, emptyBoard(), "c1");
    expect(out.to.cards[0]!.column).toBe("todo");
    expect(out.to.columns).toBeUndefined();
  });

  it("gives a board from before columns the three it drew, and keeps made ones", () => {
    const old = adoptProfileBoard({ cards: [{ id: "c1", title: "a", column: "doing" }] });
    expect(boardLanes(old).map((l) => l.id)).toEqual(["todo", "doing", "done"]);
    expect(old.cards[0]!.column).toBe("doing");
    const made = adoptProfileBoard(storedBoard(addLane(withCards(), "Someday", "k1")));
    expect(boardLanes(made).map((l) => l.id)).toEqual(["todo", "doing", "done", "k1"]);
    const orphan = adoptProfileBoard({ columns: [{ id: "k1", name: "Only" }], cards: [{ id: "c1", title: "a", column: "gone" }] });
    expect(orphan.cards[0]!.column).toBe("k1");
  });
});

describe("a card's dates", () => {
  const week = { start: "2026-09-28", end: "2026-10-02" };

  it("takes one day as a range of one, and refuses what is not a calendar's", () => {
    expect(adoptDates({ start: "2026-09-28" })).toEqual({ start: "2026-09-28", end: "2026-09-28" });
    expect(adoptDates(week)).toEqual(week);
    expect(adoptDates({ start: "2026-02-30" })).toBeNull();
    expect(adoptDates({ start: "2026-9-28" })).toBeNull();
    expect(adoptDates({ start: 20260928 })).toBeNull();
    expect(adoptDates({ start: "2026-09-28", end: "soon" })).toBeNull();
    expect(adoptDates("2026-09-28")).toBeNull();
  });

  it("refuses a range that runs backwards rather than guessing which end was meant", () => {
    expect(adoptDates({ start: "2026-10-02", end: "2026-09-28" })).toBeNull();
  });

  it("adds a card with them, and one with bad ones as a card with none", () => {
    expect(addCard(emptyBoard(), { title: "a", dates: week }, "c0", 0).cards[0]!.dates).toEqual(week);
    expect(addCard(emptyBoard(), { title: "a", dates: { start: "never" } }, "c0", 0).cards[0]!.dates).toBeNull();
    expect(board("a").cards[0]!.dates).toBeNull();
  });

  it("leaves them alone when an edit does not name them, and takes them off for null", () => {
    const b = addCard(emptyBoard(), { title: "a", dates: week }, "c0", 0);
    expect(editCard(b, "c0", { title: "b" }).cards[0]!.dates).toEqual(week);
    expect(editCard(b, "c0", { dates: { start: "2026-10-05" } }).cards[0]!.dates).toEqual({ start: "2026-10-05", end: "2026-10-05" });
    expect(editCard(b, "c0", { dates: null }).cards[0]!.dates).toBeNull();
  });

  it("refuses the whole edit for dates that are not dates, so a bad range is never a cleared one", () => {
    const b = addCard(emptyBoard(), { title: "a", dates: week }, "c0", 0);
    expect(editCard(b, "c0", { title: "b", dates: { start: "2026-10-02", end: "2026-09-28" } })).toBe(b);
    expect(editCard(b, "c0", { dates: 0 })).toBe(b);
    expect(editCard(b, "c0", { dates: "" })).toBe(b);
  });

  it("keeps them to disk and back, and across being sent to a workspace", () => {
    const b = addCard(emptyProfileBoard(), { title: "a", dates: week }, "c0", 0);
    expect(adoptProfileBoard(JSON.parse(JSON.stringify(storedBoard(b)))).cards[0]!.dates).toEqual(week);
    expect(adoptBoard({ cards: [{ id: "c1", title: "old" }] })!.cards[0]!.dates).toBeNull();
    expect(adoptBoard({ cards: [{ id: "c1", title: "edited", dates: { start: "2026-13-01" } }] })!.cards[0]!.dates).toBeNull();
    expect(transferCard(b, emptyBoard(), "c0").to.cards[0]!.dates).toEqual(week);
  });

  it("moves a dragged bar whole, and stops a dragged end at the other", () => {
    expect(shiftDates(week, 3, "both")).toEqual({ start: "2026-10-01", end: "2026-10-05" });
    expect(shiftDates(week, -28, "both")).toEqual({ start: "2026-08-31", end: "2026-09-04" });
    expect(shiftDates(week, 2, "end")).toEqual({ start: "2026-09-28", end: "2026-10-04" });
    expect(shiftDates(week, -1, "start")).toEqual({ start: "2026-09-27", end: "2026-10-02" });
    expect(shiftDates(week, 9, "start")).toEqual({ start: "2026-10-02", end: "2026-10-02" });
    expect(shiftDates(week, -9, "end")).toEqual({ start: "2026-09-28", end: "2026-09-28" });
    expect(shiftDates(week, Number.NaN, "both")).toBe(week);
  });
});

describe("the timeline", () => {
  // 2026-09-28 is a Monday, and day 20724 since 1970.
  const first = 20724;
  const dated = (...cards: [string, string, string?][]) =>
    cards.reduce((b, [title, start, end], i) => addCard(b, { title, dates: { start, end } }, `c${i}`, i), emptyProfileBoard());

  it("places a bar by the days it covers, counted from the window's first", () => {
    const { rows } = timeline(dated(["a", "2026-09-30", "2026-10-02"]), first, 35);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ at: 2, span: 3, cutStart: false, cutEnd: false });
  });

  it("cuts a bar that runs past an edge, and says which", () => {
    const { rows } = timeline(dated(["before", "2026-09-20", "2026-09-29"], ["after", "2026-10-31", "2026-11-20"], ["both", "2026-01-01", "2026-12-31"]), first, 35);
    expect(rows.map((r) => [r.card.title, r.at, r.span, r.cutStart, r.cutEnd])).toEqual([
      ["both", 0, 35, true, true],
      ["before", 0, 2, true, false],
      ["after", 33, 2, false, true],
    ]);
  });

  it("counts what is outside the window instead of drawing it", () => {
    const out = timeline(dated(["gone", "2026-09-01"], ["last day before", "2026-09-27"], ["first day after", "2026-11-02"], ["in", "2026-11-01"]), first, 35);
    expect(out.rows.map((r) => r.card.title)).toEqual(["in"]);
    expect(out.earlier).toBe(2);
    expect(out.later).toBe(1);
  });

  it("reads down the page in the order the days read across it", () => {
    const { rows } = timeline(
      dated(["late", "2026-10-10"], ["long", "2026-09-29", "2026-10-09"], ["short", "2026-09-29"], ["twin", "2026-09-29"]),
      first,
      35,
    );
    expect(rows.map((r) => r.card.title)).toEqual(["short", "twin", "long", "late"]);
  });

  it("keeps the cards with no date apart, in the board's order", () => {
    let b = dated(["when", "2026-09-30"]);
    b = addCard(b, { title: "someday" }, "x1", 0);
    b = addCard(b, { title: "maybe" }, "x2", 0);
    const out = timeline(b, first, 35);
    expect(out.loose.map((c) => c.title)).toEqual(["someday", "maybe"]);
    expect(out.rows).toHaveLength(1);
  });

  it("draws nothing for a window that is not a whole number of days", () => {
    const b = dated(["a", "2026-09-30"]);
    expect(timeline(b, Number.NaN, 35).rows).toEqual([]);
    expect(timeline(b, first, 0).rows).toEqual([]);
    expect(timeline(b, first, 3.5).rows).toEqual([]);
  });
});

describe("a column's colour", () => {
  const colors = (b: Board) => boardLanes(b).map((l) => l.color);

  it("starts the profile's three on the colours kururu already means by them", () => {
    expect(colors(emptyProfileBoard())).toEqual(["blue", "amber", "green"]);
    expect(colors(emptyBoard())).toEqual([null, null, null, null]);
  });

  it("makes a new column in a colour nobody else is wearing", () => {
    let b = addLane(emptyProfileBoard(), "Someday", "k1");
    b = addLane(b, "Bugs", "k2");
    expect(new Set(colors(b)).size).toBe(5);
    expect(colors(b)).not.toContain(null);
  });

  it("takes a colour by name, and none, and refuses anything else", () => {
    const b = emptyProfileBoard();
    expect(colors(colorLane(b, "doing", "violet"))).toEqual(["blue", "violet", "green"]);
    expect(colors(colorLane(b, "doing", null))).toEqual(["blue", null, "green"]);
    expect(colorLane(b, "doing", "#ff0000")).toBe(b);
    expect(colorLane(b, "doing", "url(x)")).toBe(b);
    expect(colorLane(b, "doing", undefined)).toBe(b);
    expect(colorLane(b, "nope", "violet")).toBe(b);
    expect(colorLane(emptyBoard(), "doing", "violet").columns).toBeUndefined();
  });

  it("colours a board from before columns had one, and the same way twice", () => {
    const old = { columns: [{ id: "todo", name: "To do" }, { id: "k1", name: "Someday" }, { id: "doing", name: "Doing" }, { id: "k2", name: "Bugs" }], cards: [] };
    const back = adoptProfileBoard(old);
    expect(colors(back).slice(0, 3)).toEqual(["blue", colors(back)[1]!, "amber"]);
    expect(new Set(colors(back)).size).toBe(4);
    expect(colors(back)).not.toContain(null);
    expect(colors(adoptProfileBoard(old))).toEqual(colors(back));
  });

  it("keeps a chosen colour and a chosen none to disk and back, and drops what is not one", () => {
    let b = colorLane(emptyProfileBoard(), "todo", null);
    b = colorLane(b, "done", "rose");
    expect(colors(adoptProfileBoard(JSON.parse(JSON.stringify(storedBoard(b)))))).toEqual([null, "amber", "rose"]);
    expect(colors(adoptProfileBoard({ columns: [{ id: "k1", name: "Edited", color: "javascript:1" }], cards: [] }))).toEqual([null]);
  });

  it("does not hand a spare colour to one column that another has chosen", () => {
    const back = adoptProfileBoard({ columns: [{ id: "k1", name: "Old" }, { id: "k2", name: "Chosen", color: "violet" }], cards: [] });
    expect(colors(back)[1]).toBe("violet");
    expect(colors(back)[0]).not.toBe("violet");
  });
});
