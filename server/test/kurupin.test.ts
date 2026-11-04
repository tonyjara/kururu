/**
 * Pins in Kuru's drawer: which lines take one, what the list says of each,
 * and the store's half — a pin only on the profile's own harness turns, in
 * the search's hits, through the export and back onto the same words after
 * a restore has given every turn a new id, and the table made on an older
 * database without a step of `user_version`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { KuruReply, NoticeItem, YouItem } from "../../shared/kuru";
import { canPin, pinOpening, pinnedTurnId, sortPins, type KuruPin } from "../../shared/kurupin";
import { Kuru } from "../src/kuru";
import { Store } from "../src/store";

const you = (patch: Partial<YouItem> = {}): YouItem => ({ kind: "you", id: "t1", at: 1, text: "hello", via: "typed", ms: 0, state: "delivered", typedAt: null, note: null, outboxId: null, ...patch });
const reply = (patch: Partial<KuruReply> = {}): KuruReply => ({ kind: "kuru", id: "t2", at: 2, text: "Done.", utterance: null, fate: null, aside: false, ...patch });
const notice = (patch: Partial<NoticeItem> = {}): NoticeItem => ({ kind: "notice", id: "t3", at: 3, from: "kururu", agent: { name: "Login fix", program: "claude", workspace: "app", card: null }, what: "finished its turn", event: "done", text: "…", ...patch });

describe("which lines take a pin", () => {
  test("a turn's id, and nothing else", () => {
    expect(pinnedTurnId("t42")).toBe(42);
    expect(pinnedTurnId("t0")).toBeNull();
    expect(pinnedTurnId("m42")).toBeNull();
    expect(pinnedTurnId("t42x")).toBeNull();
    expect(pinnedTurnId("t99999999999999999")).toBeNull();
    expect(pinnedTurnId(42)).toBeNull();
  });

  test("this node's turns only: not a clip on its way, a missed-only reply, a mark, or another node's line", () => {
    expect(canPin({ ...you(), node: null })).toBe(true);
    expect(canPin({ ...reply(), node: null })).toBe(true);
    expect(canPin({ ...notice(), node: null })).toBe(true);
    expect(canPin({ ...you({ id: "clip-0001" }), node: null })).toBe(false);
    expect(canPin({ ...you({ text: null }), node: null })).toBe(false);
    expect(canPin({ ...reply({ id: "mu1" }), node: null })).toBe(false);
    expect(canPin({ kind: "session", id: "sc1", at: 1, launcher: null, node: null })).toBe(false);
    expect(canPin({ ...reply(), node: "omarchy" })).toBe(false);
  });
});

describe("a pin's entry", () => {
  test("opens with the words, on one line, without a reply's reference or Markdown's marks", () => {
    expect(pinOpening(you({ text: '[reply to Kuru 18:42 "Shall I merge?" (t9)] yes, merge it' }))).toBe("yes, merge it");
    expect(pinOpening(you({ text: '[reply to Kuru 18:42 "Shall I merge?" (t9)] [quote "merge the branch into main and push it"] yes' }))).toBe("“merge the branch into main…” yes");
    expect(pinOpening(you({ text: '[card JAJ-53 "Check whether…" (w34/c5e803f7ca1c7)] brand was taken' }))).toBe('JAJ-53 "Check whether…" brand was taken');
    expect(pinOpening(reply({ text: "## Plan\n\n- **first** the `store`\n- then the drawer" }))).toBe("Plan first the store then the drawer");
    expect(pinOpening(reply({ text: "| a | b |\n|---|---|\n| 1 | 2 |" }))).toBe("| a | b | | 1 | 2 |");
    expect(pinOpening(notice())).toBe('kururu · "Login fix" · finished its turn');
  });

  test("cut with an ellipsis past the cap", () => {
    const opening = pinOpening(reply({ text: "word ".repeat(100) }), 20);
    expect(opening.length).toBeLessThanOrEqual(20);
    expect(opening.endsWith("…")).toBe(true);
  });

  test("the list is newest said first", () => {
    const pin = (id: string, at: number, pinnedAt: number): KuruPin => ({ id, pinnedAt, item: reply({ id, at }) });
    expect(sortPins([pin("t1", 10, 100), pin("t2", 30, 50), pin("t3", 20, 70)]).map((p) => p.id)).toEqual(["t2", "t3", "t1"]);
  });
});

describe("the store's pins", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kururu-pins-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const KEY = "pk000000000001";
  const OTHER = "pk000000000002";
  const base = { conversationId: "c1", profileKey: KEY, kind: "harness" as const, launcher: "claude", cwd: null };

  test("only on the profile's own harness turns, and once each", () => {
    const store = Store.open(join(dir, "kururu.db"));
    const asked = store.recordTurn({ ...base, role: "you", text: "what is running?", at: 1_000 })!;
    const answer = store.recordTurn({ ...base, role: "kuru", text: "Two agents.", at: 2_000 })!;
    const theirs = store.recordTurn({ ...base, conversationId: "c2", profileKey: OTHER, role: "kuru", text: "Elsewhere.", at: 3_000 })!;
    const agents = store.recordTurn({ ...base, conversationId: "a1", kind: "agent", role: "agent", text: "I fixed it.", at: 4_000 })!;
    expect(store.pinTurn(KEY, answer, true, 5_000)).toBe(true);
    expect(store.pinTurn(KEY, answer, true, 6_000)).toBe(false);
    expect(store.pinTurn(KEY, theirs, true)).toBe(false);
    expect(store.pinTurn(KEY, agents, true)).toBe(false);
    expect(store.pinTurn(KEY, 999_999, true)).toBe(false);
    expect(store.pinTurn(KEY, asked, true, 7_000)).toBe(true);
    expect(store.pinnedTurns(KEY).map(({ turn, pinnedAt }) => [turn.text, pinnedAt])).toEqual([
      ["what is running?", 7_000],
      ["Two agents.", 5_000],
    ]);
    expect(store.pinnedTurns(OTHER)).toEqual([]);
    expect(store.pinTurn(KEY, asked, false)).toBe(true);
    expect(store.pinTurn(KEY, asked, false)).toBe(false);
    expect(store.pinnedTurns(KEY)).toHaveLength(1);
    store.close();
  });

  test("a pinned turn says so in the search, and an unpinned one says nothing", () => {
    const store = Store.open(join(dir, "kururu.db"));
    const pinned = store.recordTurn({ ...base, role: "kuru", text: "The deploy key is in the vault.", at: 1_000 })!;
    store.recordTurn({ ...base, role: "kuru", text: "The deploy ran green.", at: 2_000 });
    store.pinTurn(KEY, pinned, true);
    const hits = store.search("deploy", "turns", KEY);
    expect(hits.map((hit) => [hit.kind === "turn" && hit.text, hit.kind === "turn" ? (hit.pinned ?? false) : null]).sort()).toEqual([
      ["The deploy key is in the vault.", true],
      ["The deploy ran green.", false],
    ]);
    store.close();
  });

  test("travel in the export on their turn's line and come back onto the same words, twice adding nothing", () => {
    const store = Store.open(join(dir, "a.db"));
    // The export names each conversation's profile, so there has to be one.
    const raw = new DatabaseSync(join(dir, "a.db"));
    raw.prepare("insert into profiles(key, name, login_key, created_at, gone_at) values (?, 'Work', null, 0, null)").run(KEY);
    raw.close();
    store.recordTurn({ ...base, role: "you", text: "first", at: 1_000 });
    const second = store.recordTurn({ ...base, role: "kuru", text: "second", at: 2_000 })!;
    store.pinTurn(KEY, second, true, 9_000);
    const data = store.exportAll();
    store.close();
    expect(data.conversations[0]!.turns.map((turn) => turn.pinnedAt ?? null)).toEqual([null, 9_000]);

    const restored = Store.open(join(dir, "b.db"));
    // Another turn first, so the ids do not line up with the first database's.
    restored.recordTurn({ ...base, conversationId: "c0", role: "you", text: "unrelated", at: 500 });
    restored.importExport(data);
    restored.importExport(data);
    expect(restored.pinnedTurns(KEY).map(({ turn, pinnedAt }) => [turn.text, pinnedAt])).toEqual([["second", 9_000]]);
    restored.close();
  });

  test("the table is made on a database from before it, without stepping the version an installed app checks", () => {
    const path = join(dir, "kururu.db");
    Store.open(path).close();
    const raw = new DatabaseSync(path);
    raw.exec("drop table turn_pins");
    const version = (raw.prepare("pragma user_version").get() as { user_version: number }).user_version;
    raw.close();
    const store = Store.open(path);
    const turn = store.recordTurn({ ...base, role: "kuru", text: "kept", at: 1_000 })!;
    expect(store.pinTurn(KEY, turn, true)).toBe(true);
    store.close();
    const again = new DatabaseSync(path);
    expect((again.prepare("pragma user_version").get() as { user_version: number }).user_version).toBe(version);
    again.close();
  });
});

describe("Kuru's pins", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kururu-pins-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("ride on the conversation in full, merged as the drawer's lines are, however far back", async () => {
    const store = Store.open(join(dir, "kururu.db"));
    const key = "pk000000000003";
    const base = { conversationId: "c1", profileKey: key, kind: "harness" as const, launcher: "claude", cwd: null };
    const old = store.recordTurn({ ...base, role: "kuru", text: "The long answer from the first day.", at: 1_000, voiceId: "u1" })!;
    // A whole window of newer lines, so the pinned one is long past it.
    for (let n = 0; n < 80; n++) store.recordTurn({ ...base, conversationId: "c2", role: "you", text: `line ${n}`, at: 10_000 + n * 1_000 });
    const sent: unknown[] = [];
    const kuru = new Kuru({
      store,
      profiles: () => [{ id: "p1", key }],
      outbox: () => [],
      missed: () => [{ id: "u1", profileKey: key, text: "The long answer from the first day.", lang: "en", at: 1_000, pending: false }],
      broadcast: (msg) => sent.push(msg),
    });
    expect(kuru.pin(key, `t${old}`, true)).toBe(true);
    expect(kuru.pin(key, "mu1", true)).toBe(false);
    expect(kuru.pin(key, `t${old}`, true)).toBe(false);
    const message = kuru.message();
    const conversation = message.type === "kuru" ? message.kuru[0]! : null!;
    expect(conversation.items.some((item) => item.id === `t${old}`)).toBe(false);
    expect(conversation.pins).toHaveLength(1);
    expect(conversation.pins![0]!.item).toMatchObject({ kind: "kuru", id: `t${old}`, text: "The long answer from the first day.", utterance: "u1", fate: "unheard" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(sent).toHaveLength(1);
    expect(kuru.pin(key, `t${old}`, false)).toBe(true);
    const after = kuru.message();
    expect(after.type === "kuru" ? after.kuru[0]!.pins : null).toEqual([]);
    // The broadcast the unpin asked for, out before the store closes under it.
    await new Promise((resolve) => setTimeout(resolve, 40));
    store.close();
  });
});
