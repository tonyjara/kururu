/**
 * The reader's place in a document.
 *
 * What is worth holding it to is that a place survives the three things that
 * move pixels without moving the words: the same document laid out at another
 * size (the zoom, a narrower pane), the same document edited above or inside the
 * section you were in, and a document whose heading went away. The first must be
 * exact; the other two must land in the right section, and never at the top.
 */
import { describe, expect, test } from "bun:test";
import {
  adoptPlaces,
  anchorAt,
  fragmentOf,
  headingSlugs,
  keptPlaces,
  lineTop,
  markupSig,
  placeOf,
  resolvePlace,
  topOf,
  type Place,
  type Span,
} from "../src/readerplace";

const h = (line: number, top: number, text: string): Span => ({ line, top, heading: text });
const b = (line: number, top: number): Span => ({ line, top, heading: null });

/** A small document: a title, a preamble, two sections, a list whose first item begins on the list's line. */
const doc: Span[] = [h(1, 20, "Title"), b(3, 60), h(5, 120, "Install"), b(7, 160), b(9, 260), h(12, 400, "Usage"), b(14, 440), b(14, 440), b(16, 470)];
const END = 1000;

/** The same document at twice the size, as a zoom draws it. */
const zoomed: Span[] = doc.map((s) => ({ ...s, top: s.top * 2 }));

describe("anchorAt and topOf", () => {
  test("the very top is no place at all", () => {
    expect(anchorAt(doc, 0, END)).toBeNull();
    expect(topOf(doc, null, END)).toBe(0);
  });

  test("a place is a block and how far into it", () => {
    expect(anchorAt(doc, 210, END)).toEqual({ line: 7, nth: 0, within: 0.5 });
  });

  test("above the first block is line 0", () => {
    expect(anchorAt(doc, 10, END)).toEqual({ line: 0, nth: 0, within: 0.5 });
    expect(topOf(doc, { line: 0, nth: 0, within: 0.5 }, END)).toBe(10);
  });

  test("round-trips at every top", () => {
    for (let top = 1; top < END; top += 7) {
      const anchor = anchorAt(doc, top, END);
      expect(topOf(doc, anchor, END)).toBeCloseTo(top, 6);
    }
  });

  test("a zoom keeps the same words at the top", () => {
    const anchor = anchorAt(doc, 210, END);
    expect(topOf(zoomed, anchor, END * 2)).toBe(420);
  });

  test("blocks beginning on one line are told apart", () => {
    const anchor = anchorAt(doc, 450, END);
    expect(anchor).toEqual({ line: 14, nth: 1, within: 1 / 3 });
    expect(topOf(doc, anchor, END)).toBeCloseTo(450, 6);
  });

  test("past the last block runs to the end of the content", () => {
    expect(anchorAt(doc, 735, END)).toEqual({ line: 16, nth: 0, within: 0.5 });
  });

  test("a line no block begins on is the block above it", () => {
    expect(topOf(doc, { line: 8, nth: 0, within: 0.9 }, END)).toBe(160);
  });
});

describe("resolvePlace", () => {
  const sig = "a";
  const at = (top: number) => placeOf(doc, top, END, END - 300, sig, 1)!;

  test("a place remembers its heading and how far below it", () => {
    const place = at(300);
    expect(place.line).toBe(9);
    expect(place.heading).toBe("Install");
    expect(place.headingLine).toBe(5);
  });

  test("the same markup comes back exactly", () => {
    const place = at(300);
    expect(topOf(doc, resolvePlace(place, doc, sig, END, END - 300), END)).toBeCloseTo(300, 6);
  });

  test("lines added above: found by the heading, the same distance into its section", () => {
    const place = at(300);
    // Ten lines added to the preamble: every line below moves by ten.
    const edited = doc.map((s) => (s.line > 3 ? { ...s, line: s.line + 10, top: s.top + 200 } : s));
    const anchor = resolvePlace(place, edited, "b", END + 200, END - 100);
    expect(anchor?.line).toBe(19);
    expect(topOf(edited, anchor, END + 200)).toBeCloseTo(500, 6);
  });

  test("a section that got shorter never spills into the next one", () => {
    const place = at(300);
    // Install's second paragraph removed.
    const edited = [h(1, 20, "Title"), b(3, 60), h(5, 120, "Install"), b(7, 160), h(10, 400, "Usage"), b(12, 440)];
    const anchor = resolvePlace(place, edited, "b", END, END - 300);
    expect(anchor).toEqual({ line: 7, nth: 0, within: 0 });
  });

  test("of two headings with one name, the one nearest where it was", () => {
    const twice = [h(1, 0, "Notes"), b(3, 40), h(40, 800, "Notes"), b(42, 840), b(44, 900)];
    const place = placeOf(twice, 870, 1200, 900, "a", 1)!;
    const edited = twice.map((s) => ({ ...s, line: s.line + 2, top: s.top + 30 }));
    expect(resolvePlace(place, edited, "b", 1230, 930)?.line).toBe(44);
  });

  test("a heading that is gone falls back to the fraction", () => {
    const place = at(350);
    const renamed = doc.map((s) => (s.heading === "Install" ? { ...s, heading: "Setup" } : s));
    const anchor = resolvePlace(place, renamed, "b", END, END - 300);
    expect(topOf(renamed, anchor, END)).toBeCloseTo(350, 6);
  });

  test("the preamble is found by its line", () => {
    const place = at(80);
    expect(place.heading).toBe("Title");
    const noTitle = doc.slice(1);
    const preamble = placeOf(noTitle, 80, END, 700, "a", 1)!;
    expect(preamble.heading).toBeNull();
    expect(resolvePlace(preamble, noTitle, "b", END, 700)?.line).toBe(3);
  });
});

describe("lineTop", () => {
  test("the first block on the line, or the last before it", () => {
    expect(lineTop(doc, 14)).toBe(440);
    expect(lineTop(doc, 10)).toBe(260);
    expect(lineTop(doc, 1)).toBe(20);
    expect(lineTop([b(5, 100)], 2)).toBe(0);
  });
});

describe("headingSlugs", () => {
  test("GitHub's anchors", () => {
    expect(headingSlugs(["The pool", "What's left?", "The pool", "Café & co", "  A  b "])).toEqual(["the-pool", "whats-left", "the-pool-1", "café--co", "a--b"]);
  });

  test("fragments are decoded, and only fragments", () => {
    expect(fragmentOf("#caf%C3%A9")).toBe("café");
    expect(fragmentOf("#%E0%A4%A")).toBe("%E0%A4%A");
    expect(fragmentOf("#")).toBeNull();
    expect(fragmentOf("/api/file-raw?x#y")).toBeNull();
    expect(fragmentOf(null)).toBeNull();
  });
});

describe("storage", () => {
  const place: Place = { line: 9, nth: 0, within: 0.4, heading: "Install", headingLine: 5, fraction: 0.3, sig: "x", at: 5 };

  test("malformed entries are dropped, the rest kept", () => {
    const got = adoptPlaces({ good: place, bad: { ...place, line: Number.NaN }, worse: "nope", alsoBad: { ...place, sig: 3 } });
    expect([...got.keys()]).toEqual(["good"]);
    expect(adoptPlaces(null).size).toBe(0);
    expect(adoptPlaces([place]).size).toBe(0);
  });

  test("the oldest go first", () => {
    const many = new Map<string, Place>();
    for (let i = 0; i < 5; i++) many.set(`k${i}`, { ...place, at: i });
    expect(Object.keys(keptPlaces(many, 3)).sort()).toEqual(["k2", "k3", "k4"]);
  });

  test("a signature changes with the markup", () => {
    expect(markupSig("<p>a</p>")).toBe(markupSig("<p>a</p>"));
    expect(markupSig("<p>a</p>")).not.toBe(markupSig("<p>b</p>"));
  });
});
