/**
 * The conversation's pure half: turns, your messages and the missed list as
 * one timeline, the two counts the chip wears, and the card codes in a reply.
 * The merge is where a delivered clip would be shown twice, a reply's fate
 * would be put beside the wrong words, or a line of yours would lose its
 * Resend — so it is tested against the shapes the three sources actually
 * produce, the outbox's `say` included.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentName, envelope } from "../../shared/harness";
import { KURU_RECENT, clipLength, kuruCounts, mergeConversation, plainWords, readPrompt, splitCardCodes, spokenMessage, type KuruItem, type OutboxLike } from "../../shared/kuru";
import type { Turn } from "../../shared/store";
import type { StoredOutboxEntry } from "../../shared/voice";
import { Kuru } from "../src/kuru";
import { Outbox, type OutboxDeps } from "../src/outbox";
import { Store } from "../src/store";

function turn(id: number, role: Turn["role"], text: string, at: number, extra: Partial<Turn> = {}): Turn {
  return { id, conversationId: "s1", at, role, via: role === "you" && text.startsWith("[voice]") ? "voice" : "typed", text, lang: null, voiceId: null, ...extra };
}

function message(id: string, at: number, patch: Partial<OutboxLike> = {}): OutboxLike {
  return { id, at, ms: 2_000, state: "queued", text: `words of ${id}`, typedAt: null, note: null, ...patch };
}

const kinds = (items: KuruItem[]) => items.map((item) => `${item.kind}:${item.id}`);

describe("mergeConversation", () => {
  test("a delivered clip and the turn it became are one item, with the clip's length and the outbox id", () => {
    const items = mergeConversation({
      turns: [turn(1, "you", "[voice] move the login card to done", 1_000, { voiceId: "clip-a" }), turn(2, "kuru", "Done.", 2_000, { voiceId: "u1" })],
      outbox: [message("clip-a", 900, { state: "delivered", ms: 3_400, text: "move the login card to done" })],
      missed: [],
    });
    expect(kinds(items)).toEqual(["you:t1", "kuru:t2"]);
    const you = items[0]!;
    expect(you.kind === "you" && you).toMatchObject({ text: "move the login card to done", via: "voice", ms: 3_400, state: "delivered", outboxId: "clip-a" });
  });

  test("a message still on its way stands on its own, and a typed one has no mic", () => {
    const items = mergeConversation({
      turns: [],
      outbox: [message("clip-b", 1_000, { state: "transcribing", text: null }), message("line-c", 2_000, { ms: 0, state: "failed", note: "Typed twice." })],
      missed: [],
    });
    expect(kinds(items)).toEqual(["you:clip-b", "you:line-c"]);
    expect(items[0]).toMatchObject({ via: "voice", state: "transcribing", text: null, outboxId: "clip-b" });
    expect(items[1]).toMatchObject({ via: "typed", state: "failed", note: "Typed twice.", outboxId: "line-c" });
  });

  test("a prompt typed straight into the terminal is delivered with nothing to resend", () => {
    const items = mergeConversation({ turns: [turn(1, "you", "what is running?", 1_000)], outbox: [], missed: [] });
    expect(items[0]).toMatchObject({ kind: "you", via: "typed", state: "delivered", outboxId: null, ms: 0 });
  });

  test("a reply's fate is the missed list's word, and a reply never spoken has none", () => {
    const items = mergeConversation({
      turns: [
        turn(1, "kuru", "Heard one.", 1_000, { voiceId: "u1" }),
        turn(2, "kuru", "Unheard one.", 2_000, { voiceId: "u2" }),
        turn(3, "kuru", "Being said.", 3_000, { voiceId: "u3" }),
        turn(4, "kuru", "Never spoken.", 4_000),
      ],
      outbox: [],
      missed: [
        { id: "u2", text: "Unheard one.", at: 2_000, pending: false },
        { id: "u3", text: "Being said.", at: 3_000, pending: true },
      ],
    });
    expect(items.map((item) => (item.kind === "kuru" ? item.fate : "?"))).toEqual(["heard", "unheard", "speaking", null]);
  });

  test("a reply only the missed list remembers is drawn from it, once", () => {
    const items = mergeConversation({
      turns: [turn(1, "kuru", "On the record.", 1_000, { voiceId: "u1" })],
      outbox: [],
      missed: [
        { id: "u1", text: "On the record.", at: 1_000, pending: false },
        { id: "u9", text: "Orphan.", at: 5_000, pending: false },
      ],
    });
    expect(kinds(items)).toEqual(["kuru:t1", "kuru:mu9"]);
    expect(items[1]).toMatchObject({ text: "Orphan.", utterance: "u9", fate: "unheard" });
  });

  test("a say line is an aside, and a new session is a mark with its launcher", () => {
    const items = mergeConversation({
      turns: [
        turn(1, "kuru", "First session.", 1_000),
        { ...turn(2, "kuru", "Starting three agents.", 2_000, { via: "kururu" }), conversationId: "s2" },
        { ...turn(3, "kuru", "Done.", 3_000), conversationId: "s2" },
      ],
      outbox: [],
      missed: [],
      launchers: new Map([["s2", "claude-opus"]]),
    });
    expect(kinds(items)).toEqual(["kuru:t1", "session:ss2", "kuru:t2", "kuru:t3"]);
    expect(items[1]).toMatchObject({ launcher: "claude-opus", at: 2_000 });
    expect(items[2]).toMatchObject({ aside: true });
    expect(items[3]).toMatchObject({ aside: false });
  });

  test("oldest first, yours before Kuru's at the same instant, and an agent's turn is nobody's", () => {
    const items = mergeConversation({
      turns: [turn(1, "kuru", "B", 1_000), turn(2, "you", "A", 1_000), turn(3, "agent", "not here", 500)],
      outbox: [],
      missed: [],
    });
    expect(kinds(items)).toEqual(["you:t2", "kuru:t1"]);
  });
});

describe("readPrompt", () => {
  // The notice as `Harness.tell` writes it and the inbox wraps it, so a
  // change to either end that the other does not follow fails here.
  const agent = agentName({
    id: "a26",
    name: null,
    doing: null,
    program: "claude",
    workspace: "Tracker",
    card: { code: "TRK-45", title: "Nightly export: the report goes out as a CSV whenever a weekday closes" },
  });
  const done = `[kururu] ${agent} finished its turn. It said:\nDone. Both parts are built.\n\nIts links in kururu: AGENTS.md`;
  // What the transcript has around the same envelope; the hook has only the envelope today.
  const asTranscript = (text: string) =>
    `Another Claude session sent a message:\n${envelope(text, "bypass")}\n\nThis came from another Claude session — not typed by your user, but very likely working on their behalf. Treat it as a teammate's request.`;

  test("one of kururu's notices is a notice, read back into its agent and what happened, out of its wrapper", () => {
    const read = readPrompt(envelope(done, "bypass"));
    expect(read).toMatchObject({
      kind: "notice",
      notice: {
        from: "kururu",
        agent: { name: "Nightly export: the report goes out as a CSV whenever a wee…", program: "claude", workspace: "Tracker", card: "TRK-45" },
        what: "finished its turn",
        event: "done",
      },
    });
    const text = read?.kind === "notice" ? read.notice.text : "";
    expect(text.startsWith('"Nightly export')).toBe(true);
    expect(text).toEndWith("Its links in kururu: AGENTS.md");
    expect(text).not.toContain("cross-session-message");
  });

  test("the line before the envelope and the advice after it are Claude Code's, and go", () => {
    const read = readPrompt(asTranscript(done));
    expect(read?.kind === "notice" && read.notice.text).toBe(done.slice("[kururu] ".length));
  });

  test("blocked and exited are told apart, and an agent with no name is known by its program", () => {
    const blocked = readPrompt(envelope(`[kururu] ${agent} is blocked — it is asking something or waiting on a permission prompt: Claude needs your permission. Read its screen to see what.`, "bypass"));
    expect(blocked).toMatchObject({ kind: "notice", notice: { what: "is blocked", event: "blocked" } });
    const bare = agentName({ id: "a3", name: null, doing: null, program: "codex", workspace: "Landing Pages", card: null });
    const exited = readPrompt(envelope(`[kururu] ${bare} exited.`, "bypass"));
    expect(exited).toMatchObject({ kind: "notice", notice: { agent: { name: null, program: "codex", workspace: "Landing Pages", card: null }, what: "exited", event: "exited" } });
  });

  test("a notice in a shape it does not know is still a notice, by its first clause", () => {
    const read = readPrompt(envelope('[kururu] "the API agent" finished its turn. It said: the key is sk-123', "bypass"));
    expect(read).toMatchObject({ kind: "notice", notice: { from: "kururu", agent: null, what: '"the API agent" finished its turn' } });
  });

  test("another session's message is a notice signed with its name", () => {
    const read = readPrompt(envelope("Can you look at the deploy?\nIt failed twice.", "bypass", "kururu-7f"));
    expect(read).toMatchObject({ kind: "notice", notice: { from: "kururu-7f", agent: null, what: "Can you look at the deploy?", event: null } });
  });

  test("a background task's report is a notice, its summary the line and its result the text", () => {
    const report = [
      "<task-notification>",
      "<task-id>a5dd</task-id>",
      "<status>completed</status>",
      '<summary>Agent "Research browser-use self-hosting" finished</summary>',
      "<result>Browser Use is mainly an MIT-licensed Python library.</result>",
      "</task-notification>",
    ].join("\n");
    expect(readPrompt(report)).toMatchObject({
      kind: "notice",
      notice: { from: "Kuru's task", what: 'Agent "Research browser-use self-hosting" finished', text: "Browser Use is mainly an MIT-licensed Python library." },
    });
  });

  test("your words come out of every wrapper that is not theirs, prefix and all", () => {
    expect(readPrompt("<system-reminder>\nToday is Tuesday.\n</system-reminder>\nwhat is running?")).toEqual({ kind: "you", text: "what is running?" });
    expect(readPrompt('<pasted_content id="8c73">\n[voice] a long thought\nover two lines\n</pasted_content id="8c73">')).toEqual({ kind: "you", text: "[voice] a long thought\nover two lines" });
    // From before the paste was unwrapped on the way in: the envelope's end was cut off.
    expect(readPrompt('<pasted_content id="8c73">\n[voice] cut off mid-way')).toEqual({ kind: "you", text: "[voice] cut off mid-way" });
    expect(readPrompt("<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>keep the plan</command-args>")).toEqual({ kind: "you", text: "/compact keep the plan" });
    expect(readPrompt("[telegram] check the build")).toEqual({ kind: "you", text: "[telegram] check the build" });
    expect(readPrompt("<system-reminder>only this</system-reminder>")).toBeNull();
  });

  test("in the merge, a notice is its own kind between yours and Kuru's, and a half-wrapped clip is yours and spoken", () => {
    const items = mergeConversation({
      turns: [
        turn(1, "you", envelope(done, "bypass"), 1_000),
        turn(2, "kuru", "The tracking agent is done.", 1_500),
        turn(3, "you", '<pasted_content id="8c73">\n[voice] commit it', 2_000),
        turn(4, "you", "<system-reminder>nothing</system-reminder>", 2_500),
        turn(5, "you", "[telegram] and push", 3_000, { via: "telegram" }),
      ],
      outbox: [],
      missed: [],
    });
    expect(kinds(items)).toEqual(["notice:t1", "kuru:t2", "you:t3", "you:t5"]);
    expect(items[2]).toMatchObject({ text: "commit it", via: "voice" });
    expect(items[3]).toMatchObject({ text: "and push", via: "telegram" });
  });
});

describe("the counts and the small words", () => {
  test("kuruCounts: unheard is settled and not pending; undelivered is failed", () => {
    expect(kuruCounts([{ state: "failed" }, { state: "queued" }, { state: "failed" }], [{ pending: false }, { pending: true }])).toEqual({ unheard: 1, undelivered: 2 });
  });

  test("spokenMessage is a clip with length; plainWords drops the voice's prefix", () => {
    expect(spokenMessage({ ms: 1 })).toBe(true);
    expect(spokenMessage({ ms: 0 })).toBe(false);
    expect(plainWords("[voice] hello there")).toBe("hello there");
    expect(plainWords("hello there")).toBe("hello there");
  });

  test("clipLength is a clock", () => {
    expect(clipLength(7_200)).toBe("0:07");
    expect(clipLength(272_000)).toBe("4:32");
    expect(clipLength(10)).toBe("0:01");
  });

  test("KURU_RECENT is more than a long afternoon's turns", () => {
    expect(KURU_RECENT).toBeGreaterThanOrEqual(40);
  });
});

describe("splitCardCodes", () => {
  test("finds the codes and leaves the words", () => {
    expect(splitCardCodes("KUR-67 is done and ACM-3 is waiting on you.")).toEqual([
      { code: "KUR-67" },
      { text: " is done and " },
      { code: "ACM-3" },
      { text: " is waiting on you." },
    ]);
  });

  test("a dash inside a word, a lowercase prefix and a long prefix are not codes", () => {
    expect(splitCardCodes("re-run on kur-67 and ABCD-12, pre-2 steps")).toEqual([{ text: "re-run on kur-67 and ABCD-12, pre-2 steps" }]);
  });

  test("a word shaped like a code is a candidate — the drawer decides against the boards", () => {
    expect(splitCardCodes("UTF-8")).toEqual([{ code: "UTF-8" }]);
  });

  test("nothing is one text part, and a code alone is one code part", () => {
    expect(splitCardCodes("")).toEqual([]);
    expect(splitCardCodes("KUR-1")).toEqual([{ code: "KUR-1" }]);
  });
});

/**
 * The assembled conversation, against a real store: the window the socket
 * carries, and the message behind its first turn — released a moment before
 * the prompt hook reported it, so older than the window — coming along by
 * its link rather than being lost to the window's edge.
 */
describe("Kuru", () => {
  let dir: string;
  let store: Store;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "kururu-kuru-"));
    store = Store.open(join(dir, "kururu.db"));
  });
  afterAll(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a reply carries the files it names, as the server found them, and nothing else does", () => {
    const key = "pk000000000003";
    const base = { conversationId: "c3", profileKey: key, kind: "harness" as const, launcher: "claude", cwd: null };
    store.recordTurn({ ...base, role: "you", text: "where is docs/plan.md?", at: 1_000 });
    store.recordTurn({ ...base, role: "kuru", text: "Written to docs/plan.md.", at: 2_000 });
    store.recordTurn({ ...base, role: "kuru", text: "Nothing to open here.", at: 3_000 });
    const asked: string[] = [];
    const kuru = new Kuru({
      store,
      profiles: () => [{ id: "p3", key }],
      outbox: () => [],
      missed: () => [],
      broadcast: () => {},
      files: (_key, reply) => {
        asked.push(reply.text);
        return reply.text.includes("docs/plan.md") ? [{ text: "docs/plan.md", root: "/p", path: "docs/plan.md", line: null }] : [];
      },
    });
    const message = kuru.message();
    const items = message.type === "kuru" ? message.kuru[0]!.items : [];
    expect(items.map((item) => (item.kind === "kuru" ? (item.files?.map((f) => f.path) ?? []) : item.kind))).toEqual(["you", ["docs/plan.md"], []]);
    // Only Kuru's words are looked through: a path in your own message is yours, not a deliverable.
    expect(asked).toEqual(["Written to docs/plan.md.", "Nothing to open here."]);
  });

  test("the window's first turn keeps its clip, and a page before it finds the rest", () => {
    const key = "pk000000000002";
    const base = { conversationId: "c1", profileKey: key, kind: "harness" as const, launcher: "claude", cwd: null };
    // Thirty exchanges, each a clip released a second before its prompt.
    const outbox: StoredOutboxEntry[] = [];
    for (let n = 0; n < 30; n++) {
      const at = 100_000 + n * 10_000;
      outbox.push({ id: `clip-${n}`, profileKey: key, at: at - 1_000, ms: 2_500, state: "delivered", text: `message ${n}`, lang: "en", typedAt: null, note: null, n, attempts: 0, typings: 1, transcript: null });
      expect(store.recordTurn({ ...base, role: "you", text: `[voice] message ${n}`, at, voiceId: `clip-${n}` })).not.toBeNull();
      expect(store.recordTurn({ ...base, role: "kuru", text: `reply ${n}`, at: at + 2_000, voiceId: `u${n}` })).not.toBeNull();
    }
    const sent: unknown[] = [];
    const kuru = new Kuru({
      store,
      profiles: () => [{ id: "p1", key }],
      outbox: () => outbox,
      missed: () => [{ id: "u29", profileKey: key, text: "reply 29", lang: "en", at: 100_000 + 29 * 10_000 + 2_000, pending: false }],
      broadcast: (msg) => sent.push(msg),
    });
    const message = kuru.message();
    expect(message.type).toBe("kuru");
    const conversation = message.type === "kuru" ? message.kuru[0]! : null!;
    expect(conversation).toMatchObject({ profileId: "p1", unheard: 1, undelivered: 0, more: false });
    expect(conversation.items).toHaveLength(60);
    const first = conversation.items[0]!;
    expect(first).toMatchObject({ kind: "you", id: expect.stringMatching(/^t/), via: "voice", ms: 2_500, outboxId: "clip-0", state: "delivered" });
    const last = conversation.items.at(-1)!;
    expect(last).toMatchObject({ kind: "kuru", utterance: "u29", fate: "unheard" });
    // A reply missed before the conversation was written down — older than
    // every turn — is on the first page and in the window, since neither has
    // an earlier page to leave it to.
    const early = new Kuru({
      store,
      profiles: () => [{ id: "p1", key }],
      outbox: () => [],
      missed: () => [{ id: "u-early", profileKey: key, text: "from before", lang: "en", at: 50_000, pending: false }],
      broadcast: () => {},
    });
    const whole = early.page(key, null, 100);
    expect(whole.more).toBe(false);
    expect(whole.items[0]).toMatchObject({ kind: "kuru", id: "mu-early", fate: "unheard", at: 50_000 });
    const message2 = early.message();
    expect(message2.type === "kuru" && message2.kuru[0]!.items[0]).toMatchObject({ id: "mu-early" });
    // But a page that is not the first leaves it to the one that is.
    expect(early.page(key, 100_000 + 29 * 10_000 + 2_000, 3).items.some((item) => item.id === "mu-early")).toBe(false);
    // A page of three before the last reply: your 28th, its reply, your 29th —
    // and the clips behind both of yours come along, the first of them older
    // than the page's span.
    const page = kuru.page(key, 100_000 + 29 * 10_000 + 2_000, 3);
    expect(page.more).toBe(true);
    expect(page.items.map((item) => (item.kind === "you" ? item.outboxId : item.kind))).toEqual(["clip-28", "kuru", "clip-29"]);
    // One change is one broadcast, however many times it is said.
    kuru.changed();
    kuru.changed();
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        expect(sent).toHaveLength(1);
        resolve();
      }, 60),
    );
  });
});

/**
 * The outbox's typed road: a line from the drawer joins the list queued, with
 * its words made and no audio, and goes to Kuru without the voice's prefix.
 * The deps are stubs; what is checked is what the outbox hands over.
 */
describe("Outbox.say", () => {
  let dir: string;
  const saved: StoredOutboxEntry[][] = [];
  const delivered: string[] = [];
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "kururu-outbox-"));
    process.env.KURURU_STATE_DIR = dir;
  });
  afterAll(() => {
    delete process.env.KURURU_STATE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  const deps = (): OutboxDeps => ({
    broadcast: () => {},
    index: { load: () => [], save: (entries) => void saved.push([...entries]), remove: () => {} },
    profileIdOf: () => "p1",
    transcribe: () => Promise.reject(new Error("not asked")),
    deliver: (_key, text, events) => {
      delivered.push(text);
      events.typed();
      return Promise.resolve({ outcome: "typed" as const });
    },
    harness: () => ({ agentId: "a1", status: "idle", transcript: null }),
    talk: () => {},
  });

  test("joins the list queued, with no audio, and is typed without the voice's prefix", async () => {
    const outbox = new Outbox(deps());
    outbox.resume();
    const entry = outbox.say("pk000000000001", "line-1", 1_000, "move the login card to done");
    expect(entry).toMatchObject({ id: "line-1", state: "queued", ms: 0, text: "move the login card to done", profileId: "p1" });
    expect(spokenMessage(entry)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(delivered).toEqual(["move the login card to done"]);
    expect(outbox.entriesOf("pk000000000001")[0]).toMatchObject({ typedAt: expect.any(Number), typings: 1 });
    // Said again under the same id, it is the same message.
    expect(outbox.say("pk000000000001", "line-1", 1_000, "something else").text).toBe("move the login card to done");
    expect(outbox.entriesOf("pk000000000001")).toHaveLength(1);
    outbox.close();
  });

  test("Kuru's prompt hook carrying the words is delivery, as for a clip", async () => {
    const outbox = new Outbox(deps());
    outbox.resume();
    outbox.say("pk000000000001", "line-2", 2_000, "what is running?");
    await new Promise((resolve) => setTimeout(resolve, 10));
    outbox.prompted("pk000000000001", "what is running?");
    expect(outbox.entriesOf("pk000000000001").find((e) => e.id === "line-2")).toMatchObject({ state: "delivered" });
    outbox.close();
  });
});
