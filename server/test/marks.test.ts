/**
 * The marks folder: what is taken out of somebody else's words, how they are
 * quoted on a line, the lines `chips.ts` reads back, and the sweep that
 * removes a set after thirty days and nothing else.
 *
 * The redaction and the sweep are the two that matter most. A set holds a
 * window's title and pictures of the screen, so a token in a title must not
 * reach the folder; and the sweep removes directories, so it must remove
 * only what the server made. A screen set's own shape is
 * `screenset.test.ts`'s.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chipsIn, plainChips } from "../../shared/chips";
import { MARKS_KEEP_MS, isMarkFile, isMarkSetId, labelWords, redact, sweepable } from "../../shared/marks";
import { MarksRefused, keepMarks, markFile, markSetExists, marksDir, sweepMarks } from "../src/marks";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).toString("base64");

function screenBody() {
  return {
    kind: "screen",
    at: 10_000,
    audioAt: null,
    displays: [{ id: 1, width: 1440, height: 900, scale: 2 }],
    marks: [{ display: 1, t0: 0, t1: 400, box: { x: 100, y: 100, width: 80, height: 40 }, strokes: [[[100, 100], [180, 140]]], under: null, crop: PNG, frame: "" }],
  };
}

describe("redaction", () => {
  it("replaces what looks like a secret and keeps the words around it", () => {
    expect(redact("Authorization: Bearer abcdefghijklmnop1234")).not.toContain("abcdefghijklmnop1234");
    expect(redact("key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV and more")).toBe("key [redacted] and more");
    expect(redact("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U")).toBe("[redacted]");
    expect(redact("password=hunter2!")).toBe("password=[redacted]");
    expect(redact("api_key: 'abcd1234efgh'")).toBe("api_key: '[redacted]'");
    expect(redact("Token verification failed")).toBe("Token verification failed");
    expect(redact("Pay now")).toBe("Pay now");
  });
});

describe("the lines", () => {
  it("quotes somebody else's words so they cannot close the line", () => {
    expect(labelWords('Say "hi" [now]')).toBe("Say 'hi' (now)");
    expect(labelWords("one two three four five six seven eight nine ten eleven twelve", 30)).toBe("one two three four five six…");
  });

  it("takes the bidi controls out of a window's title, as WhatsApp's starts with one", () => {
    expect(labelWords("\u200eWhatsApp")).toBe("WhatsApp");
    expect(labelWords("pay\u202e\u2066 now\u2069")).toBe("pay now");
  });

  it("still reads a browser set's lines, which sit in old conversations", () => {
    const path = "/Users/me/.local/share/kururu/marks/m0123456789ab/marks.md";
    const lines = [`[marks 3 on localhost:3000/checkout (${path})]`, '[mark 1 button "Pay now"] make it the accent colour', '[mark 2 area 320×180 under "Order summary"] this gap is too big', '[mark 3 text "Totla"] typo'];
    const draft = `look at these\n${lines.join("\n")} `;
    const chips = chipsIn(draft);
    expect(chips.map((c) => c.kind)).toEqual(["marks", "mark", "mark", "mark"]);
    expect(chips[0]).toMatchObject({ label: "3 marks", source: "localhost:3000/checkout", set: "m0123456789ab" });
    expect(chips[1]).toMatchObject({ label: 'button "Pay now"', source: "1", n: 1, set: "m0123456789ab" });
    // The comments stay words, outside the chips.
    expect(draft.slice(chips[1]!.to, chips[2]!.from).trim()).toBe("make it the accent colour");
    expect(plainChips(lines.join("\n"))).toContain('mark 1: button "Pay now" make it the accent colour');
  });

  it("does not read a stray bracket as a mark, and a mark without a header has no set", () => {
    expect(chipsIn("[mark this] please")).toEqual([]);
    const lone = chipsIn('[mark 4 button "Go"] hm');
    expect(lone[0]).toMatchObject({ kind: "mark", n: 4 });
    expect(lone[0]!.set).toBeUndefined();
  });
});

describe("the sweep's rule", () => {
  const now = Date.UTC(2026, 10, 6);
  it("knows a set id and the files a set may hold", () => {
    expect(isMarkSetId("m0123456789ab")).toBe(true);
    expect(isMarkSetId("m0123456789aB")).toBe(false);
    expect(isMarkSetId("m0123456789a")).toBe(false);
    expect(isMarkSetId("../m0123456789ab")).toBe(false);
    expect(isMarkFile("mark-20.png")).toBe(true);
    expect(isMarkFile("mark-21.png")).toBe(false);
    expect(isMarkFile("../marks.md")).toBe(false);
    expect(isMarkFile("view.png")).toBe(true);
  });

  it("sweeps a real set directory past thirty days and nothing else", () => {
    const old = now - MARKS_KEEP_MS - 1000;
    expect(sweepable({ name: "m0123456789ab", isDirectory: true, isSymbolicLink: false, newestMs: old }, now)).toBe(true);
    expect(sweepable({ name: "m0123456789ab", isDirectory: true, isSymbolicLink: false, newestMs: now - MARKS_KEEP_MS + 1000 }, now)).toBe(false);
    expect(sweepable({ name: "m0123456789ab", isDirectory: false, isSymbolicLink: true, newestMs: old }, now)).toBe(false);
    expect(sweepable({ name: "m0123456789ab", isDirectory: false, isSymbolicLink: false, newestMs: old }, now)).toBe(false);
    expect(sweepable({ name: "keepme", isDirectory: true, isSymbolicLink: false, newestMs: old }, now)).toBe(false);
    expect(sweepable({ name: "m0123456789ab", isDirectory: true, isSymbolicLink: false, newestMs: Number.NaN }, now)).toBe(false);
  });
});

describe("the folder", () => {
  let dir = "";
  const was: Record<string, string | undefined> = {};
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kururu-marks-"));
    for (const key of ["KURURU_DATA_DIR", "KURURU_STATE_DIR"]) was[key] = process.env[key];
    process.env.KURURU_DATA_DIR = join(dir, "data");
    process.env.KURURU_STATE_DIR = join(dir, "state");
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(was)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a body that is not a screen set, a browser's page set included, and writes nothing", () => {
    expect(() => keepMarks({ marks: [] })).toThrow(MarksRefused);
    const page = { v: 1, url: "http://localhost:3000/checkout", title: "Checkout", viewport: { width: 1280, height: 800, dpr: 2 }, marks: [{ kind: "element", comment: "x", elements: [], box: {}, pin: {}, crop: PNG }], console: [], view: PNG, at: 0 };
    expect(() => keepMarks(page)).toThrow(MarksRefused);
    expect(existsSync(marksDir()) ? readdirSync(marksDir()) : []).toEqual([]);
  });

  it("serves a set's files by the names a set may hold, and nothing else", () => {
    const kept = keepMarks(screenBody());
    expect(markSetExists(kept.id)).toBe(true);
    expect(markFile(kept.id, "mark-1.png")).toEqual({ path: join(kept.dir, "mark-1.png") });
    expect(markFile(kept.id, "mark-4.png")).toEqual({ missing: "no such file" });
    expect(markFile(kept.id, "../../kururu.db")).toEqual({ missing: "no such file" });
  });

  it("sweeps an old set with a line in lifecycle.log, and leaves a young one, a link and a stranger", () => {
    const old = keepMarks(screenBody());
    const young = keepMarks(screenBody());
    const root = marksDir();
    const back = (Date.now() - MARKS_KEEP_MS - 60_000) / 1000;
    for (const f of readdirSync(old.dir)) utimesSync(join(old.dir, f), back, back);
    utimesSync(old.dir, back, back);
    // A link named like a set, to an old directory elsewhere, and a stranger.
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "precious.txt"), "keep");
    utimesSync(join(elsewhere, "precious.txt"), back, back);
    utimesSync(elsewhere, back, back);
    symlinkSync(elsewhere, join(root, "m00000000beef"));
    mkdirSync(join(root, "notaset"));
    utimesSync(join(root, "notaset"), back, back);

    expect(sweepMarks()).toEqual([old.id]);
    expect(existsSync(old.dir)).toBe(false);
    expect(existsSync(young.dir)).toBe(true);
    expect(existsSync(join(elsewhere, "precious.txt"))).toBe(true);
    expect(lstatSync(join(root, "m00000000beef")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(root, "notaset"))).toBe(true);
    const log = readFileSync(join(dir, "state", "lifecycle.log"), "utf8");
    expect(log).toContain(`"what":"sweep"`);
    expect(log).toContain(`swept marks set ${old.id}`);
    expect(markFile(old.id, "mark-1.png")).toEqual({ missing: "cleaned up" });
    expect(markSetExists(old.id)).toBe(false);
  });
});
