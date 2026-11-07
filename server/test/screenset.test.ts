/**
 * A set of marks on the screen through the server: written to the marks
 * folder, finished once its clip is heard, and the clip
 * carried through the outbox to one line for Kuru with the marks in the
 * words. The recogniser and Kuru are stubs; the folder and the outbox's
 * files are real, on a temporary directory.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chipsIn } from "../../shared/chips";
import { timedTranscript } from "../../shared/ink";
import { isMarkFile, setKindOf } from "../../shared/marks";
import { encodeWav } from "../../shared/voice";
import { finishScreenSet, keepMarks, markFile, marksDir, sweepMarks } from "../src/marks";
import { Outbox, outboxDir, type OutboxDeps } from "../src/outbox";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).toString("base64");
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]).toString("base64");

const SAFARI = { app: "Safari", bundle: "com.apple.Safari", window: "Stripe — Payments", bounds: { x: 0, y: 0, width: 1440, height: 900 }, front: { app: "Kururu", bundle: "io.github.tonyjara.kururu" } };

function body(over: Record<string, unknown> = {}) {
  return {
    kind: "screen",
    at: 10_000,
    audioAt: 10_000,
    displays: [{ id: 1, width: 1440, height: 900, scale: 2 }],
    marks: [
      { display: 1, t0: 0, t1: 400, box: { x: 100, y: 100, width: 80, height: 40 }, strokes: [[[100, 100], [180, 140]]], under: SAFARI, crop: PNG, frame: JPG },
      { display: 1, t0: 2_600, t1: 3_000, box: { x: 500, y: 500, width: 30, height: 30 }, strokes: [[[500, 500]]], under: { ...SAFARI, app: "Xcode", window: "token=sk-ant-abcdefghijklmnopqrstuvwxyz" }, secure: true, crop: "", frame: "" },
    ],
    ...over,
  };
}

/** yap's answer for "this button is too big and that one is fine", a word every 0.3 s from the clip's start. */
function yapJson(): string {
  const words = "this button is too big and that one is fine".split(" ");
  return JSON.stringify({ segments: [{ text: "This button is too big, and that one is fine.", words: words.map((text, i) => ({ text, start: i * 0.3, end: (i + 1) * 0.3 })) }] });
}

let dir: string;
const was: Record<string, string | undefined> = {};
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kururu-screenset-"));
  for (const key of ["KURURU_DATA_DIR", "KURURU_STATE_DIR"]) was[key] = process.env[key];
  process.env.KURURU_DATA_DIR = join(dir, "data");
  process.env.KURURU_STATE_DIR = join(dir, "state");
});
afterAll(() => {
  for (const [key, value] of Object.entries(was)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("a screen set's folder", () => {
  test("is written to the marks folder, pictures judged by their bytes, titles redacted, words pending", () => {
    const kept = keepMarks(body());
    expect(kept.dir.startsWith(marksDir())).toBe(true);
    expect(readdirSync(kept.dir).sort()).toEqual(["frame-1.jpg", "mark-1.png", "marks.json", "marks.md"]);
    expect(statSync(kept.dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(kept.dir, "mark-1.png")).mode & 0o777).toBe(0o600);
    const record = JSON.parse(readFileSync(join(kept.dir, "marks.json"), "utf8"));
    expect(setKindOf(record)).toBe("screen");
    expect(record.v).toBe(2);
    expect(record.marks[1].under.window).toBe("token=[redacted]");
    expect(readFileSync(kept.path, "utf8")).toContain("Still being heard");
    expect(markFile(kept.id, "frame-1.jpg")).toEqual({ path: join(kept.dir, "frame-1.jpg") });
    expect(isMarkFile("frame-21.jpg")).toBe(false);
    // A page's set from before version 2 says nothing of its kind.
    expect(setKindOf({ v: 1, url: "http://x" })).toBe("page");
  });

  test("a picture that is not what it says is left out, and the mark kept", () => {
    const kept = keepMarks(body({ marks: [{ display: 1, t0: 0, t1: 1, crop: JPG, frame: PNG, under: SAFARI }] }));
    expect(readdirSync(kept.dir).sort()).toEqual(["marks.json", "marks.md"]);
  });

  test("is finished with the words: each mark where it was meant, the file written again, one line for Kuru", () => {
    const kept = keepMarks(body());
    const line = finishScreenSet(kept.id, timedTranscript(yapJson()));
    // Mark 1 is drawn as "this" is said; mark 2 just after "that" (1.8 s).
    expect(line).toBe(`[marks 2 on screen (${kept.path})] This button [mark 1 Safari "Stripe — Payments"] is too big, and that one [mark 2 Xcode "token=(redacted)", no picture: a password field was focused] is fine.`);
    expect(chipsIn(line!).map((c) => c.kind)).toEqual(["marks", "mark", "mark"]);
    const md = readFileSync(kept.path, "utf8");
    expect(md).not.toContain("Still being heard");
    expect(md).toContain("### What was said");
    expect(md).toContain(`- Crop: \`${join(kept.dir, "mark-1.png")}\``);
    const record = JSON.parse(readFileSync(join(kept.dir, "marks.json"), "utf8"));
    expect(record.places.map((p: { by: string }) => p.by)).toEqual(["pointing", "pointing"]);
    expect(readdirSync(kept.dir).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  test("with nothing said, the marks still go", () => {
    const kept = keepMarks(body());
    expect(finishScreenSet(kept.id, null)).toBe(`[marks 2 on screen (${kept.path})] [mark 1 Safari "Stripe — Payments"] [mark 2 Xcode "token=(redacted)", no picture: a password field was focused] (nothing said)`);
  });

  test("a set with no voice is finished at once, as lines for the box", () => {
    const kept = keepMarks(body({ audioAt: null }));
    expect(kept.lines).toEqual([`[marks 2 on screen (${kept.path})]`, '[mark 1 Safari "Stripe — Payments"]', '[mark 2 Xcode "token=(redacted)", no picture: a password field was focused]']);
    expect(readFileSync(kept.path, "utf8")).toContain("without talking");
  });

  test("a set that is gone, or a page's, finishes as nothing", () => {
    expect(finishScreenSet("m000000000000", null)).toBeNull();
    expect(finishScreenSet("../etc", null)).toBeNull();
  });

  test("is swept by the folder's rule", () => {
    const kept = keepMarks(body());
    expect(sweepMarks(Date.now() + 31 * 24 * 60 * 60 * 1000)).toContain(kept.id);
    expect(existsSync(kept.dir)).toBe(false);
  });
});

describe("a clip drawn over, through the outbox", () => {
  const second = encodeWav(new Float32Array(16_000), 16_000);
  const delivered: string[] = [];
  const asked: boolean[] = [];
  const deps = (heard: () => Promise<{ text: string; lang: "en"; said?: ReturnType<typeof timedTranscript> & object } | null>): OutboxDeps => ({
    broadcast: () => {},
    index: { load: () => [], save: () => {}, remove: () => {} },
    profileIdOf: () => "p1",
    transcribe: (_path, _ms, timed) => {
      asked.push(timed === true);
      return heard();
    },
    screenWords: (setId, said) => finishScreenSet(setId, said),
    deliver: (_key, text, events) => {
      delivered.push(text);
      events.typed();
      return Promise.resolve({ outcome: "typed" as const });
    },
    harness: () => ({ agentId: "a1", status: "idle", transcript: null }),
    talk: () => {},
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  test("is heard with word times and goes to Kuru as one line with the marks in the words, and its files go with it", async () => {
    const kept = keepMarks(body());
    const said = timedTranscript(yapJson())!;
    const outbox = new Outbox(deps(() => Promise.resolve({ text: said.text, lang: "en", said })));
    outbox.resume();
    outbox.take("pk000000000001", "clip-screen-1", 1_000, Buffer.from(second), kept.id);
    expect(existsSync(join(outboxDir(), "clip-screen-1.marks"))).toBe(true);
    await settle();
    expect(asked.at(-1)).toBe(true);
    expect(delivered.at(-1)).toBe(`[voice] [marks 2 on screen (${kept.path})] This button [mark 1 Safari "Stripe — Payments"] is too big, and that one [mark 2 Xcode "token=(redacted)", no picture: a password field was focused] is fine.`);
    outbox.prompted("pk000000000001", delivered.at(-1)!);
    expect(outbox.entriesOf("pk000000000001").find((e) => e.id === "clip-screen-1")?.state).toBe("delivered");
    expect(existsSync(join(outboxDir(), "clip-screen-1.marks"))).toBe(false);
    outbox.close();
  });

  test("a clip with nothing in it still carries its marks", async () => {
    const kept = keepMarks(body());
    const outbox = new Outbox(deps(() => Promise.resolve(null)));
    outbox.resume();
    outbox.take("pk000000000001", "clip-screen-2", 1_000, Buffer.from(encodeWav(new Float32Array(800), 16_000)), kept.id);
    await settle();
    expect(delivered.at(-1)).toContain("(nothing said)");
    outbox.close();
  });

  test("an ordinary clip is heard without times, and one whose set is gone goes as its words", async () => {
    const outbox = new Outbox(deps(() => Promise.resolve({ text: "just words", lang: "en" })));
    outbox.resume();
    outbox.take("pk000000000001", "clip-plain", 1_000, Buffer.from(second));
    await settle();
    expect(asked.at(-1)).toBe(false);
    expect(delivered.at(-1)).toBe("[voice] just words");
    outbox.take("pk000000000001", "clip-gone", 1_000, Buffer.from(second), "m0123456789ab");
    await settle();
    expect(asked.at(-1)).toBe(true);
    expect(delivered.at(-1)).toBe("[voice] just words");
    outbox.close();
  });
});
