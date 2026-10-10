/**
 * OSC 52, which is worth a test because every way of getting it wrong is
 * silent: a copy that never reaches the clipboard looks exactly like a copy
 * that was never made, and the person blames their selection.
 *
 * The cases that matter are the cuts. A pty's writes end wherever the read
 * did, so the sequence arrives in pieces — split inside the introducer, inside
 * the base64, between the ESC and the backslash of its terminator — and a
 * scanner that only matches whole sequences sees none of those.
 */
import { describe, expect, it } from "bun:test";
import { clipboardScanner } from "../src/osc52";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const osc52 = (text: string, end = "\x07", selector = "c") => `\x1b]52;${selector};${b64(text)}${end}`;

/** Feed every chunk, and collect what each one finished. */
function feed(...chunks: string[]): (string | undefined)[] {
  const scan = clipboardScanner();
  return chunks.map((chunk) => scan(chunk));
}

describe("clipboardScanner", () => {
  it("reads a copy terminated by BEL, and by ST", () => {
    expect(feed(osc52("hello"))).toEqual(["hello"]);
    expect(feed(osc52("hello", "\x1b\\"))).toEqual(["hello"]);
  });

  it("reads it out of the middle of ordinary output", () => {
    expect(feed(`\x1b[1mbold\x1b[0m${osc52("copied")}\r\nprompt$ `)).toEqual(["copied"]);
  });

  it("decodes UTF-8 rather than handing back bytes as characters", () => {
    expect(feed(osc52("ñandú — 🦤"))).toEqual(["ñandú — 🦤"]);
  });

  it("takes every selector a Mac has one clipboard for, and none", () => {
    for (const selector of ["c", "p", "s", "0", "cs", ""]) {
      expect(feed(osc52("x", "\x07", selector))).toEqual(["x"]);
    }
  });

  it("answers the last copy when one chunk finishes several", () => {
    expect(feed(osc52("first") + osc52("second"))).toEqual(["second"]);
  });

  it("finds a sequence cut at every possible point", () => {
    const whole = `before ${osc52("a selection worth keeping", "\x1b\\")} after`;
    for (let cut = 1; cut < whole.length; cut++) {
      const results = feed(whole.slice(0, cut), whole.slice(cut));
      expect(results.filter(Boolean)).toEqual(["a selection worth keeping"]);
    }
  });

  it("survives a large copy arriving a few bytes at a time", () => {
    const text = "x".repeat(200_000);
    const whole = osc52(text);
    const chunks: string[] = [];
    for (let i = 0; i < whole.length; i += 4096) chunks.push(whole.slice(i, i + 4096));
    expect(feed(...chunks).filter(Boolean)).toEqual([text]);
  });

  it("never answers a query", () => {
    expect(feed("\x1b]52;c;?\x07")).toEqual([undefined]);
  });

  it("ignores an empty write rather than clearing the clipboard", () => {
    expect(feed("\x1b]52;c;\x07")).toEqual([undefined]);
  });

  it("refuses a body that is not base64, and goes on scanning after it", () => {
    expect(feed(`\x1b]52;c;not base64!\x07${osc52("next")}`)).toEqual(["next"]);
  });

  it("refuses a selector it does not know", () => {
    expect(feed(osc52("x", "\x07", "zz"))).toEqual([undefined]);
  });

  it("abandons a sequence another escape breaks into", () => {
    const scan = clipboardScanner();
    expect(scan(`\x1b]52;c;${b64("half")}`)).toBeUndefined();
    // ESC then something that is not a backslash: a new sequence, so the copy
    // never finished and must not land.
    expect(scan(`\x1b[2Jcleared${osc52("whole")}`)).toBe("whole");
  });

  it("is not fooled by other OSCs", () => {
    expect(feed("\x1b]0;a title\x07\x1b]12;#ff0000\x07\x1b]8;;https://x\x1b\\")).toEqual([undefined]);
  });
});
