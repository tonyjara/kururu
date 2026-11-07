import { describe, expect, test } from "bun:test";
import { TAP_MS } from "../../shared/voice";
import { micPress, micTitle, pressWasTap, sayLine } from "../src/micpress";

describe("a comment mic's press", () => {
  test("a release inside TAP_MS is a tap, which keeps listening", () => {
    expect(pressWasTap(1000, 1000 + TAP_MS - 1)).toBe(true);
    expect(pressWasTap(1000, 1080)).toBe(true);
  });

  test("a release at TAP_MS or later is a hold, which has ended", () => {
    expect(pressWasTap(1000, 1000 + TAP_MS)).toBe(false);
    expect(pressWasTap(1000, 4000)).toBe(false);
  });

  test("a stamp that is not a number is never a tap: the dictation stops rather than listening on", () => {
    expect(pressWasTap(Number.NaN, 1000)).toBe(false);
    expect(pressWasTap(1000, Number.NaN)).toBe(false);
  });

  test("the first press starts; the next stops a tapped one", () => {
    expect(micPress("idle", false)).toBe("start");
    expect(micPress("listening", true)).toBe("stop");
  });

  test("a press while a held one listens, or while one is heard, does nothing", () => {
    expect(micPress("listening", false)).toBe("none");
    expect(micPress("hearing", true)).toBe("none");
    expect(micPress("hearing", false)).toBe("none");
  });
});

describe("what the quote popover says", () => {
  test("a tapped one says how to stop it and that Esc drops it", () => {
    expect(sayLine("listening", true, null, true)).toContain("press the mic again");
    expect(sayLine("listening", true, null, true)).toContain("Esc");
    expect(sayLine("listening", false, null, true)).toContain("let go");
  });

  test("beside the mark only the phase", () => {
    expect(sayLine("listening", true, null, false)).toBe("Listening…");
    expect(sayLine("hearing", false, null, false)).toBe("Hearing…");
  });

  test("words that did not come keep the quote, with a press to try again, not a hold", () => {
    const line = sayLine("idle", false, "Nothing was heard.", true);
    expect(line).toStartWith("Nothing was heard.");
    expect(line).toContain("press the mic again");
    expect(sayLine("idle", false, null, true)).toBeNull();
  });

  test("the mic's name says both ways in, and how a tapped one stops", () => {
    expect(micTitle("idle", false)).toContain("hold, or tap");
    expect(micTitle("listening", true)).toContain("Esc drops it");
    expect(micTitle("listening", false)).toContain("Let go");
  });
});
