import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Kuru } from "../src/kuru";
import { Store } from "../src/store";

describe("the store's tags", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kururu-tags-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const KEY = "pk000000000001";
  const OTHER = "pk000000000002";
  const base = { conversationId: "c1", profileKey: KEY, kind: "harness" as const, launcher: "claude", cwd: null };

  /** A database with a profile, two of its workspaces and one of another profile's. */
  const open = (name = "kururu.db"): Store => {
    const path = join(dir, name);
    Store.open(path).close();
    const raw = new DatabaseSync(path);
    raw.prepare("insert into profiles(key, name, login_key, created_at, gone_at) values (?, 'Work', null, 0, null)").run(KEY);
    raw.prepare("insert into profiles(key, name, login_key, created_at, gone_at) values (?, 'Home', null, 0, null)").run(OTHER);
    raw.prepare("insert into workspaces(key, profile_key, name, created_at, gone_at) values ('wkhol', ?, 'Holapy', 0, null)").run(KEY);
    raw.prepare("insert into workspaces(key, profile_key, name, created_at, gone_at) values ('wkpas', ?, 'Pasapy', 0, null)").run(KEY);
    raw.prepare("insert into workspaces(key, profile_key, name, created_at, gone_at) values ('wkhome', ?, 'Garden', 0, null)").run(OTHER);
    raw.close();
    return Store.open(path);
  };

  test("the owner's corrections: only the profile's own turns and workspaces, and a change only when there is one", () => {
    const store = open();
    const turn = store.recordTurn({ ...base, role: "kuru", text: "Done.", at: 1_000 })!;
    const agents = store.recordTurn({ ...base, conversationId: "a1", kind: "agent", role: "agent", text: "I fixed it.", at: 2_000 })!;
    expect(store.tagTurn(KEY, turn, "wkhol", true)).toBe(true);
    expect(store.tagTurn(KEY, turn, "wkhol", true)).toBe(false);
    expect(store.tagTurn(KEY, turn, "wkpas", false)).toBe(true);
    expect(store.tagTurn(KEY, turn, "wkhome", true)).toBe(false);
    expect(store.tagTurn(OTHER, turn, "wkhome", true)).toBe(false);
    expect(store.tagTurn(KEY, agents, "wkhol", true)).toBe(false);
    expect(store.turnTags([turn])).toEqual(new Map([[turn, { add: ["wkhol"], drop: ["wkpas"] }]]));
    expect(store.tagTurn(KEY, turn, "wkpas", true)).toBe(true);
    expect(store.turnTags([turn, agents]).get(turn)).toEqual({ add: ["wkhol", "wkpas"] });
    store.close();
  });

  test("Kuru's tag line sits beside the owner's, and both ride on the drawer's lines", async () => {
    const store = open();
    store.recordTurn({ ...base, role: "you", text: "and the cart?", at: 1_000 });
    const turn = store.recordTurn({ ...base, role: "kuru", text: "Fixed.", at: 2_000 })!;
    store.kuruTagTurn(turn, ["wkpas"]);
    store.tagTurn(KEY, turn, "wkpas", false);
    store.tagTurn(KEY, turn, "wkhol", true);
    const kuru = new Kuru({ store, profiles: () => [{ id: "p1", key: KEY }], outbox: () => [], missed: () => [], broadcast: () => {} });
    const lines = kuru.page(KEY, null).items;
    expect(lines.map((line) => (line.kind === "session" ? null : (line.tags ?? null)))).toEqual([null, { kuru: ["wkpas"], add: ["wkhol"], drop: ["wkpas"] }]);
    expect(kuru.tag(KEY, `t${turn}`, "wkpas", true)).toBe(true);
    expect(kuru.tag(KEY, "m123", "wkpas", true)).toBe(false);
    // The broadcast a change asks for, before the database it reads is shut.
    await new Promise((resume) => setTimeout(resume, 60));
    store.close();
  });

  test("travel in the export on their turn's line and come back onto the same words", () => {
    const store = open("a.db");
    store.recordTurn({ ...base, role: "you", text: "first", at: 1_000 });
    const second = store.recordTurn({ ...base, role: "kuru", text: "second", at: 2_000 })!;
    store.kuruTagTurn(second, ["wkhol"]);
    store.tagTurn(KEY, second, "wkpas", true);
    const data = store.exportAll();
    store.close();
    expect(data.conversations[0]!.turns.map((turn) => turn.tags ?? null)).toEqual([null, { kuru: ["wkhol"], add: ["wkpas"] }]);

    const restored = Store.open(join(dir, "b.db"));
    restored.recordTurn({ ...base, conversationId: "c0", role: "you", text: "unrelated", at: 500 });
    restored.importExport(data);
    restored.importExport(data);
    const kuru = new Kuru({ store: restored, profiles: () => [{ id: "p1", key: KEY }], outbox: () => [], missed: () => [], broadcast: () => {} });
    const line = kuru.page(KEY, null).items.find((item) => item.kind === "kuru" && item.text === "second");
    expect(line && line.kind !== "session" ? line.tags : null).toEqual({ kuru: ["wkhol"], add: ["wkpas"] });
    restored.close();
  });
});
