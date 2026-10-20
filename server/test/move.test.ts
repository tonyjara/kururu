/**
 * Moving a workspace between nodes: the refusal and the dialog's sentences
 * as text, the offer as the receiving node checks it, the folder as it is
 * judged on a real (temporary) disk, and the whole exchange between two
 * nodes — each a `Workspaces` over a `Store` of its own, with the link
 * replaced by a function call — there, and back again, with the answer lost
 * once on the way.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addCard, editCard, emptyBoard, noteRun, removeCard, setWorktree, sleepRun, startRun, type Board } from "../../shared/board";
import { panes } from "../../shared/layout";
import type { AgentSnapshot, Workspace } from "../../shared/model";
import {
  adoptOffer,
  columnCounts,
  folderSentence,
  moveRefusal,
  movePlan,
  newFolderOk,
  newFolderSentence,
  planText,
  projectsFolder,
  tilde,
  workspaceName,
  type MoveInput,
} from "../../shared/move";
import type { LinkMessage } from "../../shared/nodes";
import { judgeFolder, moveId, Mover } from "../src/move";
import type { NodeHost } from "../src/nodes";
import { Store } from "../src/store";
import { Workspaces } from "../src/workspaces";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kururu-move-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function terminal(id: string, over: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    id,
    kind: "shell",
    title: null,
    status: "idle",
    agent: null,
    unread: false,
    cwd: "/",
    pid: 1,
    command: "zsh",
    createdAt: 0,
    contextUsage: null,
    titleOverride: null,
    exited: false,
    exitCode: null,
    ...over,
  };
}

function workspace(board: Board | null, tabs: string[] = []): Workspace {
  return {
    id: "w1",
    key: "wk000000000001",
    name: "Holapy",
    layout: { type: "pane", pane: { id: "n1", agentIds: tabs, activeIdx: 0 } },
    focusedPaneId: "n1",
    lastPaneId: null,
    mascotId: null,
    group: null,
    board,
    machine: null,
    agentPlacement: null,
  };
}

function input(over: Partial<MoveInput>): MoveInput {
  return { workspace: workspace(emptyBoard()), terminals: [], only: false, harnessId: null, standing: () => true, ...over };
}

describe("the refusal", () => {
  it("refuses the only workspace, Kuru's tab, an agent at work and a worktree standing, in that order", () => {
    expect(moveRefusal(input({ only: true }))).toContain("only workspace");
    expect(moveRefusal(input({ workspace: workspace(emptyBoard(), ["k1"]), terminals: [terminal("k1", { kind: "agent" })], harnessId: "k1" }))).toContain("Kuru's own terminal");

    let board = addCard(emptyBoard(), { title: "Pagos con QR" }, "c1", 1);
    board = startRun(board, "c1", { agentId: "a9", launcher: "claude", label: "Claude", startedAt: 2 });
    const busy = input({ workspace: workspace(board), terminals: [terminal("a9", { kind: "agent", agent: "claude" })] });
    expect(moveRefusal(busy)).toBe(
      "An agent is running in Holapy: claude on HOL-1 “Pagos con QR”. Let it finish and close it, or let it go to sleep, then move it.",
    );

    // A shell somebody started Claude in is an agent too; a plain shell is not.
    expect(moveRefusal(input({ terminals: [terminal("s1", { agent: "claude" })] }))).toContain("running");
    expect(moveRefusal(input({ terminals: [terminal("s1")] }))).toBeNull();
    expect(moveRefusal(input({ terminals: [terminal("a1", { kind: "agent", exited: true })] }))).toBeNull();

    const wt = setWorktree(addCard(emptyBoard(), { title: "Refactor" }, "c2", 1), "c2", { root: "/r", path: "/r.worktrees/x", branch: "x", base: "main" });
    expect(moveRefusal(input({ workspace: workspace(wt) }))).toContain("worktree standing (/r.worktrees/x)");
    // One the disk no longer has is a stale pointer, and moves (without it).
    expect(moveRefusal(input({ workspace: workspace(wt), standing: () => false }))).toBeNull();
  });
});

describe("what the dialog says", () => {
  it("counts the board by column and says what stays, for a project with code, env files and a database", () => {
    let board = emptyBoard();
    for (let i = 1; i <= 5; i++) board = addCard(board, { title: `card ${i}`, column: i <= 3 ? "done" : "todo" }, `c${i}`, i);
    board = startRun(board, "c4", { agentId: null, launcher: "claude", label: "Claude", startedAt: 10, sessionId: "13968279-fd35-448c-8bc5-d041d0d2350d" });
    board = sleepRun(board, "c4", 20);
    expect(columnCounts(board.cards)).toBe("1 To do, 1 In progress, 3 Done");
    const plan = movePlan({
      ...input({ workspace: workspace(board, ["s1"]), terminals: [terminal("s1", { title: "zsh" })] }),
      node: "omarchy",
      here: "mac",
      folder: "~/Projects/holapy",
      databases: [{ host: "localhost", port: 5432, database: "holapy", user: "me", ssl: false }],
      deleted: 2,
      machine: null,
    });
    expect(plan.refusal).toBeNull();
    expect(plan.moves[1]).toBe("The board: 5 cards (1 To do, 1 In progress, 3 Done), and its 2 deleted cards, still deleted. Each keeps its number, dates and history, and its history says it moved.");
    expect(plan.moves[2]).toContain("the one asleep cannot be resumed there");
    expect(plan.stays[0]).toContain("Nothing is copied");
    expect(plan.stays[1]).toContain("Env files (.env and the like) in ~/Projects/holapy");
    expect(plan.stays[2]).toContain("holapy on localhost:5432");
    expect(plan.stays.some((line) => line.startsWith("1 terminal open in it here (zsh)"))).toBe(true);
    expect(plan.stays.at(-1)).toBe("mac's copy of the board: it is kept, marked moved, and found in Search → Deleted.");
  });

  it("words every folder answer", () => {
    expect(folderSentence(null, "omarchy", "~/Projects/holapy")).toBe("~/Projects/holapy is a repository on omarchy.");
    expect(folderSentence("missing", "omarchy", "~/Projects/holapy")).toContain("Clone the project there first");
    expect(folderSentence("not-repo", "omarchy", "~/x")).toContain("not a git repository");
  });

  it("guesses the projects folder from where the workspaces are, else the usual names", () => {
    const home = "/home/me";
    expect(projectsFolder(["/home/me/src/a", "/home/me/src/b", "/home/me/Projects/c"], home, () => false)).toBe("/home/me/src");
    expect(projectsFolder(["/home/me"], home, (p) => p === "/home/me/Projects")).toBe("/home/me/Projects");
    expect(projectsFolder([], home, () => false)).toBe(home);
    expect(tilde("/home/me/Projects/x", home)).toBe("~/Projects/x");
  });
});

describe("the offer, as the receiving node takes it", () => {
  const card = {
    id: "c1",
    number: 7,
    title: "t",
    body: "",
    column: "doing",
    position: 0,
    isolate: false,
    dates: null,
    worktree: { root: "/a", path: "/b", branch: "x", base: "main" },
    createdAt: 1,
    updatedAt: 2,
    deletedAt: null,
    runs: [{ launcher: "claude", label: "Claude", state: "asleep", startedAt: 3, endedAt: 4, sessionId: null, cwd: "/a" }],
    events: [{ at: 1, actor: "user", kind: "created", fromColumn: null, toColumn: "todo", detail: { title: "t" } }],
  };
  const offer = { move: "mv0123456789abcdef", workspace: { key: "wk000000000001", name: " Holapy " }, folder: "~/Projects/holapy", board: { version: 1, profile: {}, workspace: null, board: { id: "b1", next: 8, columns: null, createdAt: 1 }, cards: [card] } };

  it("takes the export's shape, dropping the worktree", () => {
    const got = adoptOffer(offer)!;
    expect(got.workspace.name).toBe("Holapy");
    expect(got.board!.cards[0]!.worktree).toBeNull();
    expect(got.board!.cards[0]!.runs[0]!.state).toBe("asleep");
  });

  it("refuses anything else whole", () => {
    expect(adoptOffer({ ...offer, move: "x" })).toBeNull();
    expect(adoptOffer({ ...offer, board: { ...offer.board, cards: [{ ...card, number: 0 }] } })).toBeNull();
    expect(adoptOffer({ ...offer, board: { ...offer.board, cards: [{ ...card, events: [{ ...card.events[0], kind: "exploded" }] }] } })).toBeNull();
    expect(adoptOffer({ ...offer, board: { ...offer.board, cards: [{ ...card, runs: [{ ...card.runs[0], startedAt: Number.NaN }] }] } })).toBeNull();
    expect(adoptOffer({ ...offer, board: { ...offer.board, cards: [{ ...card, column: "nowhere" }] } })!.board!.cards[0]!.column).toBe("todo");
  });
});

describe("the folder, judged on the disk it names", () => {
  it("expands ~, keeps inside home before and after links, and wants a checkout", () => {
    const home = join(dir, "home");
    mkdirSync(join(home, "Projects", "holapy", ".git"), { recursive: true });
    mkdirSync(join(home, "Projects", "loose"), { recursive: true });
    writeFileSync(join(home, "Projects", "file"), "");
    mkdirSync(join(dir, "elsewhere", ".git"), { recursive: true });
    symlinkSync(join(dir, "elsewhere"), join(home, "Projects", "escape"));
    expect(judgeFolder("~/Projects/holapy", home)).toEqual({ path: join(home, "Projects", "holapy"), problem: null });
    expect(judgeFolder("Projects/holapy", home).problem).toBe("relative");
    expect(judgeFolder("~/../elsewhere", home).problem).toBe("outside");
    expect(judgeFolder("~/Projects/escape", home).problem).toBe("outside");
    expect(judgeFolder("~/Projects/none", home).problem).toBe("missing");
    expect(judgeFolder("~/Projects/file", home).problem).toBe("not-dir");
    expect(judgeFolder("~/Projects/loose", home).problem).toBe("not-repo");
  });

  it("makes the same move id for the same workspace and node, and another for another node", () => {
    expect(moveId("n1", "wk1", "n2")).toBe(moveId("n1", "wk1", "n2"));
    expect(moveId("n1", "wk1", "n3")).not.toBe(moveId("n1", "wk1", "n2"));
    expect(moveId("n1", "wk1", "n2")).toMatch(/^mv[0-9a-f]{16}$/);
  });
});

// ---------------------------------------------------------------------------
// Two nodes
// ---------------------------------------------------------------------------

interface TestNode {
  id: string;
  name: string;
  home: string;
  store: Store;
  ws: Workspaces;
  mover: Mover;
  agents: AgentSnapshot[];
  ended: string[];
  /** Lose the next move's answer after the other side has acted on it. */
  dropNext: boolean;
}

function makeNode(id: string, name: string, peers: Map<string, TestNode>): TestNode {
  const home = join(dir, name);
  mkdirSync(join(home, "Projects", "holapy", ".git"), { recursive: true });
  const store = Store.open(join(dir, `${name}.db`));
  const ws = new Workspaces();
  ws.attachStore(store, store.attach(ws.all(), new Set()).profiles);
  const node = { id, name, home, store, ws, agents: [], ended: [], dropNext: false } as unknown as TestNode;
  const nodes = {
    selfId: () => id,
    name: () => name,
    nameOf: (other: string) => peers.get(other)?.name ?? null,
    linked: (other: string) => peers.has(other) && other !== id,
    statuses: () => [...peers.values()].filter((p) => p.id !== id).map((p) => ({ id: p.id, url: `http://${p.name}:7717/` })),
    ask: async (other: string, build: (rid: string) => LinkMessage, _ms: number, silent: string): Promise<LinkMessage> => {
      const there = peers.get(other)!;
      // Through JSON, as the socket would carry it.
      const message = JSON.parse(JSON.stringify(build("r1"))) as LinkMessage;
      if (message.type === "workspace-move-check") return { type: "workspace-move-checked", id: "r1", check: there.mover.check(name, message.ask), error: null };
      if (message.type === "workspace-new") {
        try {
          return { type: "workspace-made", id: "r1", made: there.mover.make(name, message.ask), error: null };
        } catch (err) {
          return { type: "workspace-made", id: "r1", made: null, error: err instanceof Error ? err.message : String(err) };
        }
      }
      if (message.type !== "workspace-move") throw new Error("unexpected");
      try {
        const done = await there.mover.adopt(name, message.offer);
        if (node.dropNext) {
          node.dropNext = false;
          throw new Error(silent);
        }
        return { type: "workspace-moved", id: "r1", done, error: null };
      } catch (err) {
        if (err instanceof Error && err.message === silent) throw err;
        return { type: "workspace-moved", id: "r1", done: null, error: err instanceof Error ? err.message : String(err) };
      }
    },
  } as unknown as NodeHost;
  node.mover = new Mover({
    workspaces: ws,
    store,
    nodes,
    agents: () => node.agents,
    harnessOf: () => null,
    dirsOf: (w) => panes(w.layout).flatMap((p) => (p.cwd ? [p.cwd] : [])),
    databasesOf: () => [],
    machineOf: () => null,
    standing: () => true,
    endTerminals: (ids) => node.ended.push(...ids),
    home,
    log: () => undefined,
  });
  peers.set(id, node);
  return node;
}

/**
 * Wait out the millisecond. A history is ordered by when, then by row id,
 * and the id is only this database's order of writing: a line copied back
 * from the other node is written after one made here, whenever it
 * happened. So two steps whose order a test reads off a history must not
 * share a millisecond, or the tie goes to the id and the order can flip —
 * which it did in CI about one run in ten.
 */
function nextMs(): void {
  const now = Date.now();
  while (Date.now() === now) {
    // A millisecond at most.
  }
}

function holapyOn(node: TestNode): Workspace | undefined {
  return node.ws.active.workspaces.find((w) => w.name === "Holapy");
}

describe("the exchange", () => {
  it("moves a board there with its history, answers a lost acknowledgement the same way, and comes back", async () => {
    const peers = new Map<string, TestNode>();
    const mac = makeNode("n000000000001", "mac", peers);
    const box = makeNode("n000000000002", "omarchy", peers);
    const profile = mac.ws.active;
    const wsId = mac.ws.newWorkspaceIn(profile.id, "Holapy", join(mac.home, "Projects", "holapy"))!;
    mac.ws.ensureBoardIn(profile.id, wsId);
    mac.ws.editBoardIn(profile.id, wsId, (b) => {
      let board = addCard(b, { title: "Pagos con QR", column: "done" }, "c1", 1_000);
      board = addCard(board, { title: "Migración de órdenes" }, "c2", 2_000);
      board = addCard(board, { title: "Landing", dates: { start: "2026-10-20", end: "2026-10-22" } }, "c3", 3_000);
      board = addCard(board, { title: "Borrador" }, "c4", 4_000);
      return board;
    });
    mac.ws.editBoardIn(profile.id, wsId, (b) => startRun(b, "c2", { agentId: "a2", launcher: "claude", label: "Claude", startedAt: 5_000, sessionId: "13968279-fd35-448c-8bc5-d041d0d2350d" }));
    mac.ws.editBoardIn(profile.id, wsId, (b) => noteRun(b, "a2", "done", false, 6_000));
    mac.ws.editBoardIn(profile.id, wsId, (b) => sleepRun(b, "c2", 7_000));
    mac.ws.editBoardIn(profile.id, wsId, (b) => removeCard(b, "c4"));
    mac.ws.editBoardIn(profile.id, wsId, (b) => editCard(b, "c3", { body: "con fotos" }));
    const pane = mac.ws.workspaceIn(profile.id, wsId)!.focusedPaneId;
    mac.ws.addTabIn(profile.id, wsId, pane, "s1", undefined);
    mac.agents = [terminal("s1")];

    const plan = await mac.mover.plan(profile.id, wsId, box.id, null);
    expect(plan.refusal).toBeNull();
    expect(plan.check).toMatchObject({ shown: "~/Projects/holapy", problem: null, profile: "main", clash: false });
    expect(planText(plan)).toContain("What stays:");

    // The answer is lost: the box has it, the Mac keeps its copy and says so.
    mac.dropNext = true;
    nextMs();
    await expect(mac.mover.move(profile.id, wsId, box.id, plan.check!.folder, "user")).rejects.toThrow("did not answer, so nothing was removed here");
    expect(holapyOn(mac)?.id).toBe(wsId);
    expect(holapyOn(box)).toBeDefined();

    // Pressed again: the same move, answered the same way, made once.
    nextMs();
    const moved = await mac.mover.move(profile.id, wsId, box.id, plan.check!.folder, "user");
    expect(moved.done).toMatchObject({ name: "Holapy", cards: 3, again: true, profile: "main" });
    expect(box.ws.active.workspaces.filter((w) => w.name === "Holapy")).toHaveLength(1);
    expect(holapyOn(mac)).toBeUndefined();
    expect(mac.ended).toEqual(["s1"]);

    // On the box: the cards, numbers and dates, a run that cannot resume, the history and its arrival.
    const there = holapyOn(box)!;
    expect(panes(there.layout)[0]!.cwd).toBe(join(box.home, "Projects", "holapy"));
    const cards = there.board!.cards;
    expect(cards.map((c) => [c.number, c.title, c.column])).toEqual([
      [1, "Pagos con QR", "done"],
      [2, "Migración de órdenes", "review"],
      [3, "Landing", "todo"],
    ]);
    expect(there.board!.next).toBe(5);
    expect(cards[2]!.dates).toEqual({ start: "2026-10-20", end: "2026-10-22" });
    expect(cards[1]!.run).toMatchObject({ state: "ended", sessionId: "13968279-fd35-448c-8bc5-d041d0d2350d", agentId: null });
    const boxHistory = box.store.cardHistory("c2").map((e) => e.kind);
    expect(boxHistory[0]).toBe("created");
    expect(boxHistory.at(-1)).toBe("imported");
    expect(box.store.cardHistory("c2").at(-1)!.detail).toMatchObject({ from: "mac", to: "omarchy" });
    expect(box.store.findCard("c4")!.deleted).toBe(true);

    // On the Mac: every card kept, deleted, with the line that says where it went.
    const deleted = mac.store.deletedCards(profile.key).map((c) => c.id).sort();
    expect(deleted).toEqual(["c1", "c2", "c3", "c4"]);
    expect(mac.store.cardHistory("c1").at(-1)).toMatchObject({ kind: "moved", detail: { node: "omarchy", workspace: there.key, carried: true } });

    // A running agent there refuses the way back, with the reason.
    const boxPane = there.focusedPaneId;
    box.ws.addTabIn(box.ws.active.id, there.id, boxPane, "a7", undefined);
    box.agents = [terminal("a7", { kind: "agent", agent: "claude" })];
    await expect(box.mover.move(box.ws.active.id, there.id, mac.id, join(mac.home, "Projects", "holapy"), "user")).rejects.toThrow("An agent is running in Holapy");
    box.agents = [terminal("a7", { kind: "agent", agent: "claude", exited: true })];

    // And back: the same rows taken up again, no event twice.
    nextMs();
    box.ws.editBoardIn(box.ws.active.id, there.id, (b) => editCard(b, "c3", { title: "Landing nueva" }));
    nextMs();
    const back = await box.mover.move(box.ws.active.id, there.id, mac.id, "~/Projects/holapy", "user");
    expect(back.done).toMatchObject({ cards: 3, again: false });
    const home = holapyOn(mac)!;
    expect(home.key).not.toBe(mac.store.cardHistory("c1").at(-1)!.detail!.workspace);
    expect(home.board!.cards.map((c) => c.title)).toEqual(["Pagos con QR", "Migración de órdenes", "Landing nueva"]);
    const found = mac.store.findCard("c3")!;
    expect(found).toMatchObject({ workspaceKey: home.key, deleted: false });
    const kinds = mac.store.cardHistory("c3").map((e) => e.kind);
    expect(kinds.filter((k) => k === "created")).toHaveLength(1);
    // By when: the box adopted on the first press, the Mac wrote its line on the second.
    expect(kinds.slice(-4)).toEqual(["imported", "moved", "edited", "imported"]);
    expect(mac.store.findCard("c4")!.deleted).toBe(true);
  });

  it("refuses a folder that is not there, and leaves both sides as they were", async () => {
    const peers = new Map<string, TestNode>();
    const mac = makeNode("n000000000001", "mac", peers);
    const box = makeNode("n000000000002", "omarchy", peers);
    const profile = mac.ws.active;
    const wsId = mac.ws.newWorkspaceIn(profile.id, "Holapy", join(mac.home, "Projects", "holapy"))!;
    const plan = await mac.mover.plan(profile.id, wsId, box.id, "~/Projects/nothing");
    expect(plan.check!.problem).toBe("missing");
    await expect(mac.mover.move(profile.id, wsId, box.id, "~/Projects/nothing", "user")).rejects.toThrow("omarchy has no ~/Projects/nothing");
    expect(holapyOn(mac)?.id).toBe(wsId);
    expect(holapyOn(box)).toBeUndefined();
    expect(box.ws.active.workspaces).toHaveLength(1);
  });
});

describe("a new workspace on another node", () => {
  it("lets through a folder that is not a checkout, and nothing a move would refuse besides", () => {
    expect(newFolderOk(null)).toBe(true);
    expect(newFolderOk("not-repo")).toBe(true);
    for (const problem of ["relative", "outside", "missing", "not-dir"] as const) expect(newFolderOk(problem)).toBe(false);
    expect(newFolderSentence("not-repo", "omarchy", "~/notes")).toBe("~/notes is a folder on omarchy, not a git repository: its cards cannot have worktrees.");
    expect(newFolderSentence("missing", "omarchy", "~/x")).toContain("omarchy has no ~/x");
    expect(newFolderSentence("relative", "omarchy", "x")).toBe(folderSentence("relative", "omarchy", "x"));
  });

  it("names it after the folder unless it was named", () => {
    expect(workspaceName("  Pagos   web ", "/home/me/pagos")).toBe("Pagos web");
    expect(workspaceName("", "/home/me/pagos/")).toBe("pagos");
    expect(workspaceName(undefined, "/")).toBe("workspace");
    expect(workspaceName("x".repeat(100), "/a")).toHaveLength(60);
  });

  it("is made there in the folder the node judged, and refused there with its sentence", async () => {
    const peers = new Map<string, TestNode>();
    const mac = makeNode("n000000000001", "mac", peers);
    const box = makeNode("n000000000002", "omarchy", peers);
    mkdirSync(join(box.home, "notes"));

    // The guess, before anything is typed, is where its projects are.
    expect(await mac.mover.newCheck(box.id, "", null)).toMatchObject({ shown: "~/Projects", problem: "not-repo" });
    expect(await mac.mover.newCheck(box.id, "", "~/Projects/holapy")).toMatchObject({ shown: "~/Projects/holapy", problem: null });

    const before = box.ws.active.workspaces.length;
    const active = box.ws.active.activeWorkspaceId;
    const made = await mac.mover.newOn(box.id, "", "~/notes");
    expect(made).toMatchObject({ name: "notes", folder: join(box.home, "notes"), shown: "~/notes", profile: "main" });
    const there = box.ws.active.workspaces.find((w) => w.key === made.key)!;
    expect(panes(there.layout)[0]!.cwd).toBe(join(box.home, "notes"));
    expect(box.ws.active.workspaces).toHaveLength(before + 1);
    // Made, not switched to: the window that asked puts it on screen through its watch.
    expect(box.ws.active.activeWorkspaceId).toBe(active);

    await expect(mac.mover.newOn(box.id, "Lejos", "/etc")).rejects.toThrow("outside the home folder on omarchy");
    await expect(mac.mover.newOn(box.id, "Nada", "~/nothing")).rejects.toThrow("omarchy has no ~/nothing");
    expect(box.ws.active.workspaces).toHaveLength(before + 1);
    // Nothing of it on the Mac.
    expect(mac.ws.active.workspaces.some((w) => w.key === made.key)).toBe(false);
  });
});
