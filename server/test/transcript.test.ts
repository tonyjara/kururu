/**
 * Ported alongside `src/transcript.ts`, and kept identical on purpose: the point
 * of copying ghosttown's parsing rather than rewriting it is that both apps
 * agree about what "19%" means, and a test that has drifted is how that stops
 * being true without anybody noticing.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LONG_WINDOW,
  STANDARD_WINDOW,
  contextFrom,
  contextPercent,
  readContext,
  windowFor,
} from "../src/transcript";

const roots: string[] = [];

/** A throwaway transcript, one record per line. */
function transcript(records: unknown[]): string {
  const root = mkdtempSync(join(tmpdir(), "kururu-tx-"));
  roots.push(root);
  const path = join(root, "session.jsonl");
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return path;
}

/** The model announcement Claude Code writes a few records in. */
const modelRecord = (modelId: string) => ({
  type: "attachment",
  isSidechain: false,
  attachment: { type: "model", identity: { modelId, marketingName: modelId } },
});

/** An assistant turn, with the usage shape the real thing carries. */
const assistantRecord = (
  opts: { model?: string; input?: number; cc?: number; cr?: number; out?: number; sidechain?: boolean } = {},
) => ({
  type: "assistant",
  isSidechain: opts.sidechain ?? false,
  message: {
    role: "assistant",
    model: opts.model ?? "claude-opus-5",
    usage: {
      input_tokens: opts.input ?? 0,
      cache_creation_input_tokens: opts.cc ?? 0,
      cache_read_input_tokens: opts.cr ?? 0,
      output_tokens: opts.out ?? 0,
    },
  },
});

const lines = (records: unknown[]) => records.map((r) => JSON.stringify(r)).join("\n");

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("windowFor", () => {
  it("reads the long window off the [1m] suffix", () => {
    expect(windowFor("claude-opus-5[1m]")).toBe(LONG_WINDOW);
    expect(windowFor("claude-opus-5[1M]")).toBe(LONG_WINDOW);
  });

  it("sizes everything else, known or not, as standard", () => {
    expect(windowFor("claude-opus-5")).toBe(STANDARD_WINDOW);
    expect(windowFor("claude-sonnet-5")).toBe(STANDARD_WINDOW);
    expect(windowFor("some-model-from-the-future")).toBe(STANDARD_WINDOW);
  });
});

describe("contextFrom", () => {
  it("adds the prompt, both caches and the reply", () => {
    const tail = lines([assistantRecord({ input: 2, cc: 310, cr: 188949, out: 116 })]);
    expect(contextFrom("", tail)).toEqual({ used: 189377, window: STANDARD_WINDOW });
  });

  it("takes the window from the announcement at the head", () => {
    const head = lines([modelRecord("claude-opus-5[1m]")]);
    const tail = lines([assistantRecord({ cr: 189000 })]);
    expect(contextFrom(head, tail)?.window).toBe(LONG_WINDOW);
  });

  it("takes the last turn, not the first", () => {
    const tail = lines([assistantRecord({ cr: 1000 }), assistantRecord({ cr: 5000 })]);
    expect(contextFrom("", tail)?.used).toBe(5000);
  });

  it("skips sidechains: a subagent fills a window that is not this one", () => {
    const tail = lines([
      assistantRecord({ cr: 5000 }),
      assistantRecord({ cr: 190000, sidechain: true }),
    ]);
    expect(contextFrom("", tail)?.used).toBe(5000);
  });

  it("skips an errored turn that billed nothing", () => {
    const tail = lines([assistantRecord({ cr: 5000 }), assistantRecord({})]);
    expect(contextFrom("", tail)?.used).toBe(5000);
  });

  it("skips the fragment a tail read starts on", () => {
    // A tail read lands mid-record: the first line is half a turn, the rest whole.
    const whole = lines([assistantRecord({ cr: 1000 }), assistantRecord({ cr: 5000 })]);
    expect(contextFrom("", whole.slice(40))?.used).toBe(5000);
  });

  it("sizes as standard when the session has switched off the announced model", () => {
    const head = lines([modelRecord("claude-opus-5[1m]")]);
    const tail = lines([assistantRecord({ model: "claude-sonnet-5", cr: 9000 })]);
    expect(contextFrom(head, tail)?.window).toBe(STANDARD_WINDOW);
  });

  it("prefers a switch announced later over the one at the head", () => {
    const head = lines([modelRecord("claude-sonnet-5")]);
    const tail = lines([modelRecord("claude-opus-5[1m]"), assistantRecord({ cr: 9000 })]);
    expect(contextFrom(head, tail)?.window).toBe(LONG_WINDOW);
  });

  it("has nothing to say about a session with no reply yet", () => {
    expect(contextFrom("", lines([modelRecord("claude-opus-5[1m]")]))).toBeNull();
    expect(contextFrom("", "")).toBeNull();
  });
});

describe("readContext", () => {
  it("reads both ends of a real file", async () => {
    const path = transcript([
      modelRecord("claude-opus-5[1m]"),
      assistantRecord({ input: 2, cc: 310, cr: 188949, out: 116 }),
    ]);
    expect(await readContext(path)).toEqual({ used: 189377, window: LONG_WINDOW });
  });

  it("finds the head announcement past a tail-sized body", async () => {
    // Padding wide enough that the tail read cannot reach the announcement.
    const padding = Array.from({ length: 400 }, () => ({
      type: "user",
      isSidechain: false,
      message: { role: "user", content: "x".repeat(1000) },
    }));
    const path = transcript([
      modelRecord("claude-opus-5[1m]"),
      ...padding,
      assistantRecord({ cr: 300000 }),
    ]);
    expect(await readContext(path)).toEqual({ used: 300000, window: LONG_WINDOW });
  });

  it("says nothing rather than something wrong when there is no file", async () => {
    expect(await readContext("/nonexistent/session.jsonl")).toBeNull();
  });
});

describe("contextPercent", () => {
  it("reports how much of the window is gone", () => {
    expect(contextPercent({ used: 189261, window: LONG_WINDOW })).toBe(19);
    expect(contextPercent({ used: 189261, window: STANDARD_WINDOW })).toBe(95);
    expect(contextPercent({ used: 0, window: STANDARD_WINDOW })).toBe(0);
  });

  it("does not go past full when a window is overrun", () => {
    expect(contextPercent({ used: 400000, window: STANDARD_WINDOW })).toBe(100);
  });
});
