/**
 * The touch toolbar's pure half.
 *
 * `codeFor` is the piece worth pinning down, and the reason is that getting it
 * wrong is *silent*. ghostty's key handler reads `event.code` only once a
 * modifier is involved — plain typing goes down a path that reads `event.key`
 * and works regardless — so a missing entry here does not break typing, it
 * breaks ctrl, and only for the characters nobody happened to try. A test is
 * the only thing that looks at all of them.
 *
 * The rest is the latch, which is three lines of arithmetic and is here because
 * the three lines encode a decision (armed is spent, locked is not) that reads
 * as an off-by-one if you meet it in the middle of a click handler.
 */
import { describe, expect, it } from "bun:test";
import { anyMod, codeFor, consumed, cycled, KEYS, NO_MODS } from "../src/keybar";

describe("codeFor", () => {
  it("names the physical key under a letter, whichever case it arrives in", () => {
    expect(codeFor("c")).toBe("KeyC");
    // Shift folds into `key`, so an uppercase letter is the same physical key.
    expect(codeFor("C")).toBe("KeyC");
    expect(codeFor("z")).toBe("KeyZ");
  });

  it("names it under a digit", () => {
    expect(codeFor("0")).toBe("Digit0");
    expect(codeFor("7")).toBe("Digit7");
  });

  it("gives both faces of a key the same code", () => {
    // The point of the pairs: `|` is shift and the backslash key, and an encoder
    // handed `Backslash` can put a ctrl on it. Handed nothing, it sends nothing.
    expect(codeFor("|")).toBe(codeFor("\\"));
    expect(codeFor("~")).toBe(codeFor("`"));
    expect(codeFor("_")).toBe(codeFor("-"));
    expect(codeFor("?")).toBe(codeFor("/"));
    expect(codeFor("{")).toBe(codeFor("["));
  });

  it("answers for every character the bar itself can send", () => {
    // The table names its own codes, so this is the two halves agreeing rather
    // than a second copy of the mapping — a key whose label and code disagreed
    // would encode the wrong position the moment somebody latched ctrl onto it.
    for (const key of KEYS) {
      if (key.key.length !== 1) continue;
      expect(codeFor(key.key)).toBe(key.code);
    }
  });

  it("has nothing to say about a named key, which carries its own code", () => {
    expect(codeFor("ArrowUp")).toBe("");
    expect(codeFor("Escape")).toBe("");
  });
});

describe("the modifier latch", () => {
  it("spends an armed modifier on one key and keeps a locked one", () => {
    expect(consumed({ ctrl: 1, alt: 0 })).toEqual({ ctrl: 0, alt: 0 });
    expect(consumed({ ctrl: 2, alt: 0 })).toEqual({ ctrl: 2, alt: 0 });
    expect(consumed({ ctrl: 1, alt: 2 })).toEqual({ ctrl: 0, alt: 2 });
  });

  it("cycles off, armed, locked and back, one modifier at a time", () => {
    const armed = cycled(NO_MODS, "ctrl");
    expect(armed).toEqual({ ctrl: 1, alt: 0 });
    const locked = cycled(armed, "ctrl");
    expect(locked).toEqual({ ctrl: 2, alt: 0 });
    expect(cycled(locked, "ctrl")).toEqual(NO_MODS);
    // And leaves the other one where it was.
    expect(cycled(locked, "alt")).toEqual({ ctrl: 2, alt: 1 });
  });

  it("is only worth intercepting the keyboard for while something is latched", () => {
    expect(anyMod(NO_MODS)).toBe(false);
    expect(anyMod({ ctrl: 1, alt: 0 })).toBe(true);
    expect(anyMod({ ctrl: 0, alt: 2 })).toBe(true);
  });
});

describe("the table", () => {
  it("gives every key a distinct id, since two of them print the same glyph", () => {
    // `⇥` and `⇧⇥` are one key and two buttons; React keys off the id, and a
    // duplicate would make one of them un-pressable in a way that looks random.
    const ids = KEYS.map((key) => key.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every key something for ghostty to map, which is a code", () => {
    // `handleKeyDown` returns having sent nothing for a code it does not know,
    // so an empty one here is a button that silently does nothing.
    for (const key of KEYS) expect(key.code).not.toBe("");
  });

  it("latches a modifier or sends a key, never both", () => {
    for (const key of KEYS) {
      if (key.mod) expect(key.with).toBeUndefined();
    }
  });
});
