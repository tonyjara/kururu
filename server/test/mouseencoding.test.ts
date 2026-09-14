/**
 * The encoding half of mouse support is the half `@xterm/addon-serialize` drops,
 * and dropping it does not degrade to "no mouse" — it degrades to raw bytes
 * arriving at a program that asked for text, which in neovim is a keystroke.
 * So what is pinned here is that the last encoding to be enabled is the one
 * repeated, that turning it off is repeated as silence, and that a mode cut in
 * half by a chunk boundary is still seen.
 */
import { describe, expect, it } from "bun:test";
import { MouseEncoding } from "../src/mouseencoding";

describe("MouseEncoding", () => {
  it("says nothing about a terminal that never asked for the mouse", () => {
    const e = new MouseEncoding();
    e.read("\x1b[?1049h\x1b[2J\x1b[?25l plain output \x1b[?2004h");
    expect(e.suffix()).toBe("");
  });

  it("repeats the encoding a program turned on", () => {
    const e = new MouseEncoding();
    e.read("\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h");
    expect(e.suffix()).toBe("\x1b[?1006h");
  });

  it("reads them out of one combined DECSET", () => {
    const e = new MouseEncoding();
    e.read("\x1b[?1000;1002;1003;1006h");
    expect(e.suffix()).toBe("\x1b[?1006h");
  });

  it("forgets one that was turned off", () => {
    const e = new MouseEncoding();
    e.read("\x1b[?1006h");
    e.read("\x1b[?1006l");
    expect(e.suffix()).toBe("");
  });

  it("keeps the last one enabled last, because that is the one in force", () => {
    const e = new MouseEncoding();
    e.read("\x1b[?1006h");
    e.read("\x1b[?1016h");
    expect(e.suffix()).toBe("\x1b[?1006h\x1b[?1016h");
    e.read("\x1b[?1006h");
    expect(e.suffix()).toBe("\x1b[?1016h\x1b[?1006h");
  });

  it("sees a mode split across two chunks of output", () => {
    const e = new MouseEncoding();
    e.read("lots of output\x1b[?10");
    e.read("06h and more");
    expect(e.suffix()).toBe("\x1b[?1006h");
  });

  it("is not fooled by a DECRQM asking about the same mode", () => {
    const e = new MouseEncoding();
    e.read("\x1b[?1006$p");
    expect(e.suffix()).toBe("");
  });

  it("leaves tracking modes to the serializer, which already restores them", () => {
    const e = new MouseEncoding();
    e.read("\x1b[?1000h\x1b[?1003h");
    expect(e.suffix()).toBe("");
  });
});
