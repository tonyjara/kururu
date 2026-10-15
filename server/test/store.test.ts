/**
 * The database, against a temp directory: that a board written is a board
 * read, that the history says what moved and who moved it, that a card
 * deleted is a card kept, that the file never takes a card off the
 * database and the database always takes one from the file, that keys
 * lost by the file are found again by name, and that the export is the
 * whole thing — a database rebuilt from it is the database.
 *
 * Bun implements `node:sqlite`, which is what makes this a `bun test` and
 * not a thing run by hand.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { addCard, editCard, emptyBoard, emptyProfileBoard, moveCard, noteRun, pruneMade, removeCard, resizeLane, setMade, startRun, transferCard, type Board } from "../../shared/board";
import type { Profile, Workspace } from "../../shared/model";
import { diffBoards, exportName, ftsQuery, pairTransfers, sessionOfTranscript, stripPastedContent } from "../../shared/store";
import { adoptBackupSettings, commitSubject, validRepoUrl } from "../../shared/backup";
import { readMirror, scrubSettings, writeMirror } from "../src/export";
import { dbPath, Store } from "../src/store";

let dir: string;
const was: Record<string, string | undefined> = {};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kururu-store-"));
  for (const name of ["KURURU_DATA_DIR", "KURURU_STATE_DIR", "XDG_CONFIG_HOME"]) was[name] = process.env[name];
  process.env.KURURU_DATA_DIR = join(dir, "data");
  process.env.KURURU_STATE_DIR = join(dir, "state");
  process.env.XDG_CONFIG_HOME = join(dir, "config");
});
afterEach(() => {
  for (const [name, value] of Object.entries(was)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

function workspace(key: string, name: string, board: Board | null): Workspace {
  return {
    id: `w-${key}`,
    key,
    name,
    layout: { type: "pane", pane: { id: `n-${key}`, agentIds: [], activeIdx: 0 } },
    focusedPaneId: `n-${key}`,
    lastPaneId: null,
    mascotId: null,
    group: null,
    board,
    machine: null,
  };
}

function profile(key: string, name: string, workspaces: Workspace[], board = emptyProfileBoard()): Profile {
  return {
    id: `p-${key}`,
    key,
    name,
    loginKey: "0123456789ab",
    workspaces,
    board,
    activeWorkspaceId: workspaces[0]?.id ?? "",
    lastWorkspaceId: null,
    agentOrder: [],
    hiddenAgents: [],
    harness: null,
    autoSwap: false,
  };
}

const PK = "pk000000000001";
const WK = "wk000000000001";

describe("the pure half", () => {
  it("turns a change into events: made, moved, edited, run, deleted", () => {
    let a: Board = emptyBoard();
    a = addCard(a, { title: "Fix the flaky test" }, "c1", 1_000);
    const made = diffBoards(null, a, 1_000, "user");
    expect(made.added.map((c) => c.id)).toEqual(["c1"]);
    expect(made.events.map((e) => e.kind)).toEqual(["created"]);

    const b = moveCard(a, "c1", "doing");
    const moved = diffBoards(a, b, 2_000, "harness");
    expect(moved.events).toEqual([{ at: 2_000, cardId: "c1", actor: "harness", kind: "moved", fromColumn: "todo", toColumn: "doing", detail: null }]);

    const c = editCard(b, "c1", { title: "Fix the flaky login test", body: "it fails on CI" });
    const edited = diffBoards(b, c, 3_000, "user");
    expect(edited.events[0]!.kind).toBe("edited");
    expect((edited.events[0]!.detail as { fields: string[] }).fields).toEqual(["title", "body"]);

    const d = startRun(c, "c1", { agentId: "a1", launcher: "claude", label: "Claude", startedAt: 4_000 });
    const ran = diffBoards(c, d, 4_000, "user");
    expect(ran.events.map((e) => e.kind)).toEqual(["run"]);
    expect((ran.events[0]!.detail as { state: string }).state).toBe("started");

    const e = noteRun(d, "a1", "done", false, 5_000);
    const finished = diffBoards(d, e, 5_000, "automation");
    expect(finished.events.map((ev) => ev.kind).sort()).toEqual(["moved", "run"]);
    expect(finished.events.find((ev) => ev.kind === "moved")!.toColumn).toBe("review");

    const f = removeCard(e, "c1");
    const gone = diffBoards(e, f, 6_000, "user");
    expect(gone.removed.map((c) => c.id)).toEqual(["c1"]);
    expect(gone.events[0]!.kind).toBe("deleted");
  });

  it("is silent when nothing changed", () => {
    const a = addCard(emptyBoard(), { title: "x" }, "c1", 1);
    expect(diffBoards(a, a, 2, "user").events).toEqual([]);
    expect(diffBoards(a, { ...a, cards: [...a.cards] }, 2, "user").events).toEqual([]);
  });

  it("pairs a card leaving one board and arriving on another as a transfer", () => {
    const from = addCard(emptyProfileBoard(), { title: "x" }, "c1", 1);
    const moved = transferCard(from, emptyBoard(), "c1");
    const diffs = [
      { boardId: "A", diff: diffBoards(from, moved.from, 2, "user") },
      { boardId: "B", diff: diffBoards(null, moved.to, 2, "user") },
    ];
    expect(pairTransfers(diffs)).toEqual([{ cardId: "c1", from: "A", to: "B" }]);
  });

  it("makes a query FTS5 will take out of anything typed", () => {
    expect(ftsQuery("migr ord")).toBe('"migr" "ord"*');
    expect(ftsQuery('he said "hi" NOT')).toBe('"he" "said" "hi" "NOT"*');
    expect(ftsQuery("   ")).toBeNull();
    expect(ftsQuery("órdenes")).toBe('"órdenes"*');
  });

  it("names export files by the name and the key, folded", () => {
    expect(exportName("Img Bench", WK)).toBe(`img-bench-${WK}`);
    expect(exportName("Migración de órdenes", WK)).toBe(`migracion-de-ordenes-${WK}`);
    expect(exportName("***", WK)).toBe(WK);
  });

  it("reads a session id off a transcript path and nothing else", () => {
    expect(sessionOfTranscript("/x/projects/-a/13968279-fd35-448c-8bc5-d041d0d2350d.jsonl")).toBe("13968279-fd35-448c-8bc5-d041d0d2350d");
    expect(sessionOfTranscript("/x/notes.jsonl")).toBeNull();
    expect(sessionOfTranscript(null)).toBeNull();
  });

  it("holds the backup settings to their shape", () => {
    expect(adoptBackupSettings(null)).toEqual({ url: null, enabled: false, intervalMin: 5 });
    expect(adoptBackupSettings({ url: "git@github.com:me/b.git", enabled: true, intervalMin: 0.4 })).toEqual({ url: "git@github.com:me/b.git", enabled: true, intervalMin: 1 });
    expect(adoptBackupSettings({ url: "not a url", enabled: true })).toEqual({ url: null, enabled: false, intervalMin: 5 });
    expect(validRepoUrl("https://github.com/me/b.git")).toBe(true);
    expect(validRepoUrl("/tmp/bare.git")).toBe(true);
    expect(validRepoUrl("-oProxyCommand=evil")).toBe(false);
    expect(validRepoUrl("git@host:path with space")).toBe(false);
    expect(commitSubject(Date.UTC(2026, 9, 10, 12, 0), { cards: 2, turns: 1, files: 3 })).toBe("kururu backup 2026-10-10 12:00: 2 card changes, 1 turn, 3 files");
  });

  it("drops a settings file's env block and nothing else", () => {
    expect(JSON.parse(scrubSettings('{"hooks":{"a":1},"env":{"KEY":"x"}}')!)).toEqual({ hooks: { a: 1 } });
    expect(scrubSettings("not json")).toBeNull();
  });

  it("strips a paste wrapper around a whole prompt, and nothing else", () => {
    expect(stripPastedContent('<pasted_content id="8c73">\n[voice] hi\n</pasted_content id="8c73">')).toBe("[voice] hi");
    expect(stripPastedContent('\n\n<pasted_content id="1">words\n</pasted_content id="1">\n\n')).toBe("words");
    expect(stripPastedContent("plain, no wrapper")).toBe("plain, no wrapper");
    // The closing id has to match the opening one, or it is not the hook's own wrapper.
    expect(stripPastedContent('<pasted_content id="1">x</pasted_content id="2">')).toBe('<pasted_content id="1">x</pasted_content id="2">');
    // Only strips when the tag wraps the entire message, not when it is mentioned inside one.
    expect(stripPastedContent('I pasted <pasted_content id="1">x</pasted_content id="1"> into the chat')).toBe('I pasted <pasted_content id="1">x</pasted_content id="1"> into the chat');
  });
});

describe("the store", () => {
  it("is made on the first open, a layout file beside it or not, and readable only by its owner", () => {
    const { mkdirSync, statSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(process.env.KURURU_STATE_DIR!, { recursive: true });
    writeFileSync(join(process.env.KURURU_STATE_DIR!, "session.json"), "{}");
    expect(existsSync(dbPath())).toBe(false);
    Store.open().close();
    expect(existsSync(dbPath())).toBe(true);
    expect(statSync(dbPath()).mode & 0o777).toBe(0o600);
  });

  it("writes a board through and reads it back, history included", () => {
    const store = Store.open();
    let board = addCard(emptyBoard(), { title: "Fix the flaky test", body: "on CI only" }, "c1", 1_000);
    const before = profile(PK, "MV", [workspace(WK, "Kururu", null)]);
    const after = { ...before, workspaces: [workspace(WK, "Kururu", board)] };
    store.syncProfile(null, before, "user", 1_000);
    store.syncProfile(before, after, "user", 1_000);
    expect(store.loadBoard(PK, WK)).toEqual(board);

    const next = moveCard(board, "c1", "doing");
    store.syncProfile(after, { ...after, workspaces: [workspace(WK, "Kururu", next)] }, "harness", 2_000);
    expect(store.loadBoard(PK, WK)!.cards[0]!.column).toBe("doing");
    const history = store.cardHistory("c1");
    expect(history.map((e) => [e.kind, e.actor])).toEqual([
      ["created", "user"],
      ["moved", "harness"],
    ]);
    expect(history[1]!.fromColumn).toBe("todo");
    board = next;
    store.close();
  });

  it("keeps a column's width through a restart, on a workspace's board and the profile's", () => {
    const store = Store.open();
    const board = resizeLane(addCard(emptyBoard(), { title: "x" }, "c1", 1), "doing", 400);
    const p0 = profile(PK, "MV", [workspace(WK, "Kururu", board)]);
    store.syncProfile(null, p0, "user", 1);
    const p1 = { ...p0, board: resizeLane(p0.board, "todo", 320) };
    store.syncProfile(p0, p1, "user", 2);
    store.close();

    const again = Store.open();
    expect(again.loadBoard(PK, WK)!.widths).toEqual({ doing: 400 });
    expect(again.loadBoard(PK, null)!.widths).toEqual({ todo: 320 });
    again.close();
  });

  it("keeps a deleted card, lists it, and restores it into the column it left", () => {
    const store = Store.open();
    const board = addCard(addCard(emptyBoard(), { title: "keep me", column: "doing" }, "c1", 1), { title: "other" }, "c2", 2);
    const p0 = profile(PK, "MV", [workspace(WK, "Kururu", board)]);
    store.syncProfile(null, p0, "user", 10);
    const p1 = { ...p0, workspaces: [workspace(WK, "Kururu", removeCard(board, "c1"))] };
    store.syncProfile(p0, p1, "user", 20);
    expect(store.loadBoard(PK, WK)!.cards.map((c) => c.id)).toEqual(["c2"]);
    expect(store.deletedCards(PK).map((c) => [c.id, c.column, c.workspaceName])).toEqual([["c1", "doing", "Kururu"]]);
    expect(store.restoreCard("c1", "user", 30)).toEqual({ profileKey: PK, workspaceKey: WK });
    const restored = store.loadBoard(PK, WK)!;
    expect(restored.cards.map((c) => c.id)).toEqual(["c2", "c1"]);
    expect(restored.cards[1]!.column).toBe("doing");
    expect(store.cardHistory("c1").map((e) => e.kind)).toEqual(["created", "deleted", "restored"]);
    store.close();
  });

  it("keeps every run a card had, and reads the last one back with its agent checked against the host", () => {
    const store = Store.open();
    let board = addCard(emptyBoard(), { title: "x" }, "c1", 1);
    let p = profile(PK, "MV", [workspace(WK, "Kururu", board)]);
    store.syncProfile(null, p, "user", 1);
    const step = (next: Board, at: number) => {
      const q = { ...p, workspaces: [workspace(WK, "Kururu", next)] };
      store.syncProfile(p, q, "user", at);
      p = q;
      board = next;
    };
    step(startRun(board, "c1", { agentId: "a1", launcher: "claude", label: "Claude", startedAt: 100 }), 100);
    step(noteRun(board, "a1", "", true, 200), 200);
    step(startRun(board, "c1", { agentId: "a2", launcher: "codex", label: "Codex", startedAt: 300 }), 300);
    const file = store.exportAll().boards.find((b) => b.workspace?.key === WK)!;
    expect(file.cards[0]!.runs.map((r) => [r.launcher, r.state])).toEqual([
      ["claude", "ended"],
      ["codex", "starting"],
    ]);
    // Attached with a2 gone: the run is ended, not left pointing at a terminal that is not there.
    const attached = store.attach([p], new Set(["a1"]), 400);
    expect(attached.profiles[0]!.workspaces[0]!.board!.cards[0]!.run).toMatchObject({ launcher: "codex", state: "ended", agentId: null });
    store.close();
  });

  it("keeps the links to what a card's agent made, and writes no history for them", () => {
    const store = Store.open();
    let board = startRun(addCard(emptyBoard(), { title: "research tablet mounts" }, "c1", 1), "c1", { agentId: "a1", launcher: "claude", label: "Claude", startedAt: 10 });
    let p = profile(PK, "MV", [workspace(WK, "Holapy", board)]);
    store.syncProfile(null, p, "user", 1);
    const made = [{ root: "/Users/me/holapy", path: "docs/research/soportes-tablet.md", line: null }];
    const next = setMade(board, "a1", made);
    const q = { ...p, workspaces: [workspace(WK, "Holapy", next)] };
    store.syncProfile(p, q, "automation", 20);
    p = q;
    board = next;
    expect(store.loadBoard(PK, WK)!.cards[0]!.made).toEqual(made);
    expect(store.cardHistory("c1").map((e) => e.kind)).toEqual(["created"]);
    // Taken off again when the file goes: the card reads as one nothing was made from.
    const pruned = pruneMade(board, () => false);
    store.syncProfile(p, { ...p, workspaces: [workspace(WK, "Holapy", pruned)] }, "automation", 30);
    expect(store.loadBoard(PK, WK)!.cards[0]!.made).toBeUndefined();
    store.close();
  });

  it("sends a card between boards as one row that moved", () => {
    const store = Store.open();
    const own = addCard(emptyProfileBoard(), { title: "inbox thought" }, "c1", 1);
    const p0 = profile(PK, "MV", [workspace(WK, "Kururu", emptyBoard())], own);
    store.syncProfile(null, p0, "user", 1);
    const { from, to } = transferCard(own, emptyBoard(), "c1");
    const p1 = { ...p0, board: from, workspaces: [workspace(WK, "Kururu", to)] };
    store.syncProfile(p0, p1, "user", 2);
    expect(store.loadBoard(PK, null)!.cards).toEqual([]);
    expect(store.loadBoard(PK, WK)!.cards.map((c) => c.id)).toEqual(["c1"]);
    expect(store.cardHistory("c1").map((e) => e.kind)).toEqual(["created", "sent"]);
    expect(store.deletedCards(PK)).toEqual([]);
    store.close();
  });

  it("adopts a card the file holds that it has never seen, and never lets the file move or delete one it has", () => {
    const store = Store.open();
    const board = addCard(emptyBoard(), { title: "in the database" }, "c1", 1);
    const p0 = profile(PK, "MV", [workspace(WK, "Kururu", board)]);
    store.syncProfile(null, p0, "user", 1);
    // The file says c1 is in done and c2 exists; the database knows c1 is in todo.
    const fileBoard: Board = { ...board, cards: [{ ...board.cards[0]!, column: "done" }, addCard(emptyBoard(), { title: "from an older server" }, "c2", 5).cards[0]!] };
    const attached = store.attach([{ ...p0, workspaces: [workspace(WK, "Kururu", fileBoard)] }], new Set(), 10);
    expect(attached.adopted).toBe(1);
    const got = attached.profiles[0]!.workspaces[0]!.board!;
    expect(got.cards.map((c) => [c.id, c.column])).toEqual([
      ["c1", "todo"],
      ["c2", "todo"],
    ]);
    expect(store.cardHistory("c2").map((e) => e.kind)).toEqual(["imported"]);
    // And a file that lost the card does not delete it.
    const again = store.attach([{ ...p0, workspaces: [workspace(WK, "Kururu", emptyBoard())] }], new Set(), 20);
    expect(again.profiles[0]!.workspaces[0]!.board!.cards.map((c) => c.id)).toEqual(["c1", "c2"]);
    store.close();
  });

  it("matches a workspace whose key the file lost back to its board by name", () => {
    const store = Store.open();
    const board = addCard(emptyBoard(), { title: "mine" }, "c1", 1);
    store.syncProfile(null, profile(PK, "MV", [workspace(WK, "Kururu", board), workspace("wk000000000002", "Other", null)]), "user", 1);
    // A fresh session file: new keys for everything, same names.
    const fresh = profile("pk000000000009", "MV", [workspace("wk000000000009", "Kururu", null), workspace("wk000000000008", "Other", null)]);
    const attached = store.attach([fresh], new Set(), 2);
    expect(attached.recovered).toBe(3);
    expect(attached.profiles[0]!.key).toBe(PK);
    expect(attached.profiles[0]!.workspaces[0]!.key).toBe(WK);
    expect(attached.profiles[0]!.workspaces[0]!.board!.cards.map((c) => c.id)).toEqual(["c1"]);
    store.close();
  });

  it("keeps a board whose workspace went, and gives it back to a workspace of that name", () => {
    const store = Store.open();
    const board = addCard(emptyBoard(), { title: "orphaned" }, "c1", 1);
    const p0 = profile(PK, "MV", [workspace(WK, "Kururu", board)]);
    store.syncProfile(null, p0, "user", 1);
    store.syncProfile(p0, { ...p0, workspaces: [] }, "user", 2);
    expect(store.loadBoard(PK, WK)!.cards.map((c) => c.id)).toEqual(["c1"]);
    expect(store.search("orphaned").map((hit) => hit.kind === "card" && hit.workspaceName)).toEqual(["Kururu"]);
    const back = store.attach([{ ...p0, workspaces: [workspace("wk000000000007", "Kururu", null)] }], new Set(), 3);
    expect(back.profiles[0]!.workspaces[0]!.key).toBe(WK);
    expect(back.profiles[0]!.workspaces[0]!.board!.cards.map((c) => c.id)).toEqual(["c1"]);
    store.close();
  });

  it("writes turns down, once each, links a spoken one to its message, and finds them", () => {
    const store = Store.open();
    store.syncProfile(null, profile(PK, "MV", []), "user", 1);
    store.saveOutbox([{ id: "clip-0001", profileKey: PK, at: 10, ms: 2000, state: "delivered", text: "move the login card to done", lang: "en", typedAt: 11, note: null, n: 1, attempts: 0, typings: 1, transcript: null }]);
    const base = { conversationId: "s1", profileKey: PK, kind: "harness" as const, launcher: "claude", cwd: "/x" };
    const first = store.recordTurn({ ...base, role: "you", text: "[voice] move the login card to done", at: 20 });
    expect(first).not.toBeNull();
    expect(store.recordTurn({ ...base, role: "you", text: "[voice] move the login card to done", at: 25 })).toBeNull();
    store.recordTurn({ ...base, role: "kuru", text: "Done: the login card is in Done.", at: 30 });
    const turns = store.turns("s1");
    expect(turns.map((t) => [t.role, t.via, t.voiceId])).toEqual([
      ["you", "voice", "clip-0001"],
      ["kuru", "typed", null],
    ]);
    const hits = store.search("login card", "turns", PK);
    expect(hits.map((h) => h.kind)).toEqual(["turn", "turn"]);
    expect(store.search("login", "cards", PK)).toEqual([]);
    store.close();
  });

  it("strips the paste wrapper Claude Code's hook puts around a voice turn, on write and on an older database", () => {
    const store = Store.open();
    store.syncProfile(null, profile(PK, "MV", []), "user", 1);
    const base = { conversationId: "s1", profileKey: PK, kind: "harness" as const, launcher: "claude", cwd: "/x" };
    store.recordTurn({ ...base, role: "you", text: '<pasted_content id="8c73">\n[voice] move the login card to done\n</pasted_content id="8c73">', at: 20 });
    expect(store.turns("s1").map((t) => [t.text, t.via])).toEqual([["[voice] move the login card to done", "voice"]]);
    store.close();

    // A turn written before the hook's wrapper was stripped — reopening must clean it up and fix `via`.
    const raw = new DatabaseSync(dbPath(), { enableForeignKeyConstraints: false });
    raw.exec("pragma user_version = 1");
    raw.prepare("insert into conversations(id, profile_key, kind, launcher, cwd, started_at) values ('s2', ?, 'harness', 'claude', '/x', 30)").run(PK);
    raw
      .prepare("insert into turns(conversation_id, at, role, via, text, lang, voice_id) values ('s2', 30, 'you', 'typed', ?, null, null)")
      .run('<pasted_content id="9">\n[voice] a wrapped turn\n</pasted_content id="9">');
    raw.close();

    const reopened = Store.open();
    expect(reopened.turns("s2").map((t) => [t.text, t.via])).toEqual([["[voice] a wrapped turn", "voice"]]);
    expect(reopened.search("wrapped turn", "turns", PK).map((h) => (h.kind === "turn" ? h.text : null))).toEqual(["[voice] a wrapped turn"]);
    reopened.close();
  });

  it("searches cards with accents folded and a prefix on the last word", () => {
    const store = Store.open();
    const board = addCard(addCard(emptyBoard(), { title: "Migración de órdenes", body: "usar Mailpit" }, "c1", 1), { title: "unrelated" }, "c2", 2);
    store.syncProfile(null, profile(PK, "MV", [workspace(WK, "Fastermenu", board)]), "user", 1);
    const hits = store.search("migracion ord", "cards", PK);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: "card", id: "c1", workspaceName: "Fastermenu", column: "todo" });
    expect(store.search("mailpit", "all", PK).map((h) => h.kind)).toEqual(["card"]);
    expect(store.search("mailpit", "all", "pk000000000002")).toEqual([]);
    store.close();
  });

  it("keeps the voice lists by key, and remembers what left the missed list", () => {
    const store = Store.open();
    store.saveMissed([{ id: "u1", profileKey: PK, text: "a", lang: "en", at: 1, pending: true }, { id: "u2", profileKey: PK, text: "b", lang: "es", at: 2, pending: false }]);
    expect(store.loadMissed().map((m) => m.id)).toEqual(["u1", "u2"]);
    store.saveMissed([{ id: "u2", profileKey: PK, text: "b", lang: "es", at: 2, pending: false }], 50);
    expect(store.loadMissed().map((m) => m.id)).toEqual(["u2"]);
    store.saveOutbox([{ id: "clip-0001", profileKey: PK, at: 10, ms: 2000, state: "queued", text: "hi", lang: "en", typedAt: null, note: null, n: 1, attempts: 0, typings: 0, transcript: null }]);
    expect(store.loadOutbox()[0]).toMatchObject({ id: "clip-0001", state: "queued" });
    store.removeVoice("clip-0001");
    expect(store.loadOutbox()).toEqual([]);
    store.close();
  });

  it("refuses a change the disk cannot take, whole", () => {
    const store = Store.open();
    const p0 = profile(PK, "MV", [workspace(WK, "Kururu", addCard(emptyBoard(), { title: "x" }, "c1", 1))]);
    store.syncProfile(null, p0, "user", 1);
    store.close();
    expect(() => store.syncProfile(p0, { ...p0, name: "renamed" }, "user", 2)).toThrow();
  });
});

describe("the mirror", () => {
  it("writes the database as text and reads it back as the same database", () => {
    const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    const config = join(process.env.XDG_CONFIG_HOME!, "kururu");
    mkdirSync(join(config, "profiles", "0123456789ab", "claude", "projects", "-Users-me-proj", "memory"), { recursive: true });
    writeFileSync(join(config, "appearance.json"), '{"theme":"x"}\n');
    writeFileSync(join(config, "openrouter.json"), '{"key":"SECRET"}\n');
    writeFileSync(join(config, "telegram.json"), '{"token":"SECRET"}\n');
    writeFileSync(join(config, "access.json"), '{"token":"SECRET"}\n');
    writeFileSync(join(config, "profiles", "0123456789ab", "claude", "projects", "-Users-me-proj", "memory", "note.md"), "# remember\n");
    writeFileSync(join(config, "profiles", "0123456789ab", "claude", "settings.json"), '{"hooks":{},"env":{"ANTHROPIC_API_KEY":"SECRET"}}\n');
    writeFileSync(join(config, "profiles", "0123456789ab", "claude", ".claude.json"), '{"oauthAccount":"SECRET"}\n');

    const store = Store.open();
    let board = addCard(emptyBoard(), { title: "Fix the flaky test", body: "on CI", column: "doing" }, "c1", 1_000);
    board = addCard(board, { title: "gone" }, "c2", 1_001);
    const p0 = profile(PK, "MV", [workspace(WK, "Kururu", board)], addCard(emptyProfileBoard(), { title: "inbox" }, "c3", 1_002));
    store.syncProfile(null, p0, "user", 1_000);
    store.syncProfile(p0, { ...p0, workspaces: [workspace(WK, "Kururu", removeCard(startRun(board, "c1", { agentId: "a1", launcher: "claude", label: "Claude", startedAt: 2_000 }), "c2"))] }, "harness", 2_000);
    store.recordTurn({ conversationId: "s1", profileKey: PK, kind: "harness", launcher: "claude", cwd: "/x", role: "you", text: "hello", at: 3_000 });
    store.recordTurn({ conversationId: "s1", profileKey: PK, kind: "harness", launcher: "claude", cwd: "/x", role: "kuru", text: "hi there", at: 3_001 });
    store.recordTurn({ conversationId: "s2", profileKey: PK, kind: "agent", launcher: null, cwd: "/x", role: "agent", text: "an agent said a secret", at: 3_002 });

    const mirror = join(dir, "mirror");
    const written = writeMirror(mirror, { store, configDir: config, stateDir: process.env.KURURU_STATE_DIR! });
    expect(written.changed).toBeGreaterThan(0);
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const text = (rel: string) => readFileSync(join(mirror, rel), "utf8");
    expect(existsSync(join(mirror, "config", "appearance.json"))).toBe(true);
    expect(existsSync(join(mirror, "config", "openrouter.json"))).toBe(false);
    expect(existsSync(join(mirror, "config", "telegram.json"))).toBe(false);
    expect(existsSync(join(mirror, "config", "access.json"))).toBe(false);
    expect(text("memory/0123456789ab/-Users-me-proj/note.md")).toBe("# remember\n");
    expect(text("profiles/0123456789ab/settings.json")).not.toContain("SECRET");
    expect(existsSync(join(mirror, "profiles", "0123456789ab", ".claude.json"))).toBe(false);
    const all = JSON.stringify(require("node:fs").readdirSync(mirror, { recursive: true }));
    expect(all).not.toContain("s2.jsonl");
    expect(text(`conversations/mv-${PK}/s1.jsonl`).split("\n").filter(Boolean)).toHaveLength(3);
    // Unchanged, nothing written.
    expect(writeMirror(mirror, { store, configDir: config, stateDir: process.env.KURURU_STATE_DIR! }).changed).toBe(0);

    // And back, into a fresh database: the same boards, runs, events, deleted cards and turns.
    const { data, skipped } = readMirror(mirror);
    expect(skipped).toEqual([]);
    process.env.KURURU_DATA_DIR = join(dir, "data2");
    const again = Store.open();
    const counts = again.importExport(data);
    expect(counts.cards).toBe(3);
    // The same board, less the one thing an export cannot carry: a live
    // terminal. The run on it is read as ended, with no agent, on `adoptRun`'s rule.
    const here = store.loadBoard(PK, WK)!;
    expect(again.loadBoard(PK, WK)).toEqual({ ...here, cards: here.cards.map((c) => ({ ...c, run: c.run ? { ...c.run, agentId: null, state: "ended" } : null })) });
    expect(again.loadBoard(PK, null)).toEqual(store.loadBoard(PK, null));
    expect(again.deletedCards(PK).map((c) => c.id)).toEqual(["c2"]);
    expect(again.cardHistory("c1").map((e) => [e.kind, e.actor])).toEqual(store.cardHistory("c1").map((e) => [e.kind, e.actor]));
    expect(again.turns("s1").map((t) => t.text)).toEqual(["hello", "hi there"]);
    expect(again.turns("s2")).toEqual([]);
    // Twice adds nothing twice.
    expect(again.importExport(data).cards).toBe(0);
    again.close();
    store.close();
  });
});
