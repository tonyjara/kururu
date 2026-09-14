/**
 * The recorder exists to be read after something has already gone wrong, so the
 * two things worth pinning down are that it keeps the *end* of the stream rather
 * than the start, and that printing it can never be a terminal escape sequence
 * itself — a diagnostic that repaints the screen you are reading it on is a
 * practical joke.
 */
import { describe, expect, it } from "bun:test";
import { dump, forget, recordInput, recordNote, recordOutput } from "../src/record";

describe("dump", () => {
  it("spells control characters out instead of emitting them", () => {
    const id = "t-escapes";
    forget(id);
    recordOutput(id, "\x1b[?1049h\x1b[2J\r\n\tx\x07");
    const out = dump(id);
    expect(out).toContain("\\e[?1049h\\e[2J\\r\\n\\tx\\x07");
    // Nothing that could move a cursor or switch a buffer.
    expect(out).not.toContain("\x1b");
    expect(out).not.toContain("\x07");
  });

  it("interleaves what kururu did with what the pty said", () => {
    const id = "t-order";
    forget(id);
    recordOutput(id, "before");
    recordNote(id, "resize", "100x30");
    recordOutput(id, "after");
    const out = dump(id);
    expect(out.indexOf("before")).toBeLessThan(out.indexOf("resize: 100x30"));
    expect(out.indexOf("resize: 100x30")).toBeLessThan(out.indexOf("after"));
  });

  it("marks which direction each chunk went", () => {
    const id = "t-dir";
    forget(id);
    recordOutput(id, "out");
    recordInput(id, "in");
    expect(dump(id)).toContain("<< out");
    expect(dump(id)).toContain(">> in");
  });

  it("drops the oldest first, so what is left is what just happened", () => {
    const id = "t-budget";
    forget(id);
    recordOutput(id, `oldest${"x".repeat(100_000)}`);
    recordOutput(id, `newer${"y".repeat(100_000)}`);
    recordOutput(id, "newest");
    const out = dump(id);
    expect(out).toContain("newest");
    expect(out).not.toContain("oldest");
  });

  it("returns the end of the tape when asked for a tail", () => {
    const id = "t-tail";
    forget(id);
    for (let i = 0; i < 20; i++) recordOutput(id, `chunk${i}`);
    const out = dump(id, 3);
    expect(out).toContain("3 of 20 entries");
    expect(out).toContain("chunk19");
    expect(out).not.toContain("chunk16");
  });

  it("says so rather than inventing a tape for an agent it never saw", () => {
    expect(dump("t-never")).toContain("no recording");
  });
});
