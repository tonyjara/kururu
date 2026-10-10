/**
 * The outbox's pure half: what may go to Kuru now, what counts as Kuru having
 * it, and what the disk is trusted for. The rest of `outbox.ts` is files and
 * timers around these, and these are where a message would be lost, sent
 * twice, or sent out of order.
 */
import { describe, expect, test } from "bun:test";
import {
  OUTBOX_KEEP,
  adoptOutbox,
  capOutbox,
  isClipId,
  promptCarries,
  transcribeRetryMs,
  type StoredOutboxEntry,
} from "../../shared/voice";
import { handable, legacyHeard, takenSince } from "../src/outbox";

function entry(n: number, patch: Partial<StoredOutboxEntry> = {}): StoredOutboxEntry {
  return {
    id: `clip-${String(n).padStart(4, "0")}`,
    profileId: "p1",
    at: 1_000 + n,
    ms: 2_000,
    state: "queued",
    text: `message ${n}`,
    lang: "en",
    typedAt: null,
    note: null,
    n,
    attempts: 0,
    typings: 0,
    transcript: null,
    ...patch,
  };
}

describe("handable", () => {
  test("hands over every queued message, in order", () => {
    const list = [entry(2), entry(1)];
    expect(handable(list, new Set()).map((e) => e.n)).toEqual([1, 2]);
  });

  test("waits behind a message still being heard, so Kuru gets them in the order they were said", () => {
    const list = [entry(1), entry(2, { state: "transcribing", text: null }), entry(3)];
    expect(handable(list, new Set()).map((e) => e.n)).toEqual([1]);
  });

  test("a failed message holds nothing up, and nor does one already typed or delivered", () => {
    const list = [
      entry(1, { state: "failed" }),
      entry(2, { typedAt: 5_000 }),
      entry(3, { state: "delivered" }),
      entry(4),
    ];
    expect(handable(list, new Set()).map((e) => e.n)).toEqual([4]);
  });

  test("never hands one over twice in a server's life", () => {
    expect(handable([entry(1), entry(2)], new Set(["clip-0001"])).map((e) => e.n)).toEqual([2]);
  });

  test("one profile's slow message does not hold up another's", () => {
    const list = [entry(1, { state: "transcribing", text: null }), entry(2, { profileId: "p2" })];
    expect(handable(list, new Set()).map((e) => e.n)).toEqual([2]);
  });
});

describe("promptCarries", () => {
  const said = "Okay, so we have a bug with the voice thing.  It seems like I start recording something.";

  test("finds the words in a long paste Claude Code wrapped", () => {
    const prompt = `\n\n<pasted_content id="8c73">\n[voice] ${said.replace("  ", " ")}\n</pasted_content id="8c73">\n\n`;
    expect(promptCarries(prompt, said)).toBe(true);
  });

  test("finds each of two messages typed as one turn", () => {
    const prompt = "[voice] first thing\n\n[voice] second thing";
    expect(promptCarries(prompt, "first thing")).toBe(true);
    expect(promptCarries(prompt, "second thing")).toBe(true);
  });

  test("is not fooled by a different message", () => {
    expect(promptCarries("[voice] something else entirely", said)).toBe(false);
    expect(promptCarries("anything", "")).toBe(false);
  });

  test("looks for the beginning, so a tail the terminal took differently does not make a delivered message look lost", () => {
    const long = `${"word ".repeat(80)}and a different ending`;
    expect(promptCarries(`${"word ".repeat(80)}and an ending that changed`, long)).toBe(true);
  });
});

describe("takenSince", () => {
  const line = (rec: Record<string, unknown>) => JSON.stringify(rec);
  const tail = [
    line({ type: "user", timestamp: "2026-10-10T02:00:00.000Z", message: { role: "user", content: "[voice] too old" } }),
    line({ type: "user", timestamp: "2026-10-10T02:41:30.000Z", message: { role: "user", content: "[voice] a prompt" } }),
    line({ type: "queue-operation", operation: "enqueue", timestamp: "2026-10-10T02:41:31.000Z", content: "[voice] typed mid-turn" }),
    line({ type: "user", timestamp: "2026-10-10T02:41:32.000Z", message: { content: [{ type: "text", text: "[voice] in blocks" }, { type: "tool_result", content: "no" }] } }),
    line({ type: "assistant", timestamp: "2026-10-10T02:41:33.000Z", message: { content: [{ type: "text", text: "[voice] not a prompt" }] } }),
    line({ type: "user", isSidechain: true, timestamp: "2026-10-10T02:41:34.000Z", message: { content: "[voice] a subagent's" } }),
    '{"type":"user","timestamp":"2026-10-10T02:41:35.000Z","message":{"content":"half a li',
  ].join("\n");

  test("reads prompts, queued input and text blocks after the moment, and nothing else", () => {
    expect(takenSince(tail, Date.parse("2026-10-10T02:41:00.000Z"))).toEqual(["[voice] a prompt", "[voice] typed mid-turn", "[voice] in blocks"]);
  });
});

describe("the outbox on disk", () => {
  test("keeps what is shaped like a message and drops the rest", () => {
    const kept = adoptOutbox([
      entry(1),
      { ...entry(2), id: "../../etc/passwd" },
      { ...entry(3), at: Number.NaN },
      { ...entry(4), profileId: "" },
      entry(1),
      "nonsense",
    ]);
    expect(kept.map((e) => e.n)).toEqual([1]);
  });

  test("a message that says it has words and has none is heard again", () => {
    const [kept] = adoptOutbox([{ ...entry(1), state: "delivered", text: null }]);
    expect(kept?.state).toBe("transcribing");
  });

  test("an unknown state is read as still being heard, never as delivered", () => {
    const [kept] = adoptOutbox([{ ...entry(1), state: "sent" }]);
    expect(kept?.state).toBe("transcribing");
  });

  test("only delivered messages age out, the newest kept", () => {
    const list = [
      ...Array.from({ length: OUTBOX_KEEP + 5 }, (_, i) => entry(i + 1, { state: "delivered" })),
      entry(100, { state: "failed" }),
      entry(0, { state: "queued" }),
    ];
    const kept = capOutbox(list);
    expect(kept.filter((e) => e.state === "delivered")).toHaveLength(OUTBOX_KEEP);
    expect(kept.filter((e) => e.state === "delivered")[0]?.n).toBe(6);
    expect(kept.map((e) => e.n)).toContain(100);
    expect(kept[0]?.n).toBe(0);
  });
});

describe("the clip's id and its retries", () => {
  test("an id is what a browser mints, and never a path", () => {
    expect(isClipId(crypto.randomUUID())).toBe(true);
    expect(isClipId("0123456789abcdef0123456789abcdef")).toBe(true);
    expect(isClipId("../outbox")).toBe(false);
    expect(isClipId("short")).toBe(false);
    expect(isClipId(42)).toBe(false);
  });

  test("a transcription is tried three more times, briefly, and then is failed", () => {
    expect([1, 2, 3, 4].map(transcribeRetryMs)).toEqual([3_000, 10_000, 30_000, null]);
  });
});

describe("legacyHeard", () => {
  test("a page from before the outbox gets the words and where they went, never undefined", () => {
    expect(legacyHeard(entry(1, { typedAt: 5 }))).toEqual({ text: "message 1", lang: "en", outcome: "typed", why: null });
    expect(legacyHeard(entry(1, { note: "Kuru is busy or asking something; this is typed the moment it can be." })).outcome).toBe("held");
    expect(legacyHeard(entry(1, { note: "Kuru is starting; it hears this first." })).outcome).toBe("starting");
    expect(legacyHeard(entry(1, { state: "delivered" })).outcome).toBe("typed");
  });

  test("silence is nothing, and a failure says why", () => {
    expect(legacyHeard(null).outcome).toBe("nothing");
    expect(legacyHeard(entry(1, { state: "failed", text: null, note: "Nothing heard in it." })).outcome).toBe("nothing");
    const failed = legacyHeard(entry(1, { state: "transcribing", text: null, note: "Could not be heard (x); trying again." }));
    expect(failed).toEqual({ text: "", lang: "en", outcome: "failed", why: "Could not be heard (x); trying again." });
  });
});
