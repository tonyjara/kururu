/**
 * DECSCUSR, in both directions, because the two are a seam.
 *
 * The client reads the cursor's shape off the byte stream — the emulator parses
 * it and will not say what it parsed — and the server writes it back onto the
 * end of a backlog so that a pane opened late is not the only one drawing the
 * wrong cursor. Those are the same sequence written by one half and read by the
 * other, and a disagreement between them would look like a cursor that changed
 * shape whenever a terminal was reopened, which is a symptom nobody would think
 * to attribute to a table of six numbers.
 *
 * The parameters themselves come from a real session: nvim under
 * `guicursor=n-v-c-sm:block,i-ci-ve:ver25,r-cr-o:hor20` in a pty was observed
 * sending exactly `2`, `6`, `4` and, on the way out, `0`.
 */
import { describe, expect, it } from "bun:test";
import { decscusr, osc12, type ProgramCursor, scanCursor } from "../../shared/cursor";

/** What a chunk asked for, with the carry dropped: most tests are about one. */
const read = (chunk: string, carry = "") => scanCursor(chunk, carry).shape;

describe("scanCursor", () => {
  it("reads the shapes an editor actually sends", () => {
    expect(read("\x1b[2 q")).toEqual({ style: "block", blink: false });
    expect(read("\x1b[6 q")).toEqual({ style: "bar", blink: false });
    expect(read("\x1b[4 q")).toEqual({ style: "underline", blink: false });
    expect(read("\x1b[1 q")).toEqual({ style: "block", blink: true });
    expect(read("\x1b[5 q")).toEqual({ style: "bar", blink: true });
    expect(read("\x1b[3 q")).toEqual({ style: "underline", blink: true });
  });

  it("reads the reset as the user's cursor back, which is what nvim quits with", () => {
    expect(read("\x1b[0 q")).toBeNull();
  });

  it("says nothing about a chunk that has no cursor in it", () => {
    expect(read("")).toBeUndefined();
    expect(read("npm run dev\r\n")).toBeUndefined();
    // Prose with the intermediate byte in it, which is the cheap test's only
    // false positive and has to fall through the real one.
    expect(read("press a q to quit")).toBeUndefined();
    // A sequence that ends in something else entirely: the parameter class
    // cannot run past a final byte, so there is nothing here to match.
    expect(read("\x1b[31mred q")).toBeUndefined();
  });

  it("ignores a parameter that is not a shape, rather than resetting on it", () => {
    expect(read("\x1b[9 q")).toBeUndefined();
    expect(read("\x1b[6 q\x1b[9 q")).toEqual({ style: "bar", blink: false });
  });

  it("takes the last one, since a chunk can hold a mode change and its undo", () => {
    expect(read("\x1b[6 qtyping\x1b[2 q")).toEqual({ style: "block", blink: false });
    expect(read("\x1b[6 q\x1b[0 q")).toBeNull();
  });

  it("carries a sequence a read boundary cut in half", () => {
    // A pty's writes end wherever the read did, and a scan that missed this
    // would leave the cursor in the shape the program has already moved on
    // from — unlike a cut sequence *written* to an emulator, which the parser
    // resynchronises on its own.
    const first = scanCursor("insert\x1b[6");
    expect(first.shape).toBeUndefined();
    expect(first.carry).toBe("\x1b[6");

    const second = scanCursor(" q", first.carry);
    expect(second.shape).toEqual({ style: "bar", blink: false });
    expect(second.carry).toBe("");
  });

  it("keeps the carry bounded, so it can never become a buffer", () => {
    // The longest thing that could be the front of one is CSI, a parameter and
    // the space; everything else has to be dropped rather than accumulated.
    expect(scanCursor("\x1b[38;2;255;0").carry).toBe("");
    expect(scanCursor("x".repeat(10000)).carry).toBe("");
    expect(scanCursor("\x1b[6 ").carry.length).toBeLessThanOrEqual(7);
  });
});

describe("scanCursor, on the colour", () => {
  const color = (chunk, carry = "") => scanCursor(chunk, carry).color;

  it("reads the hex an editor sends, in either terminator", () => {
    expect(color("\x1b]12;#f4dbd6\x07")).toBe("#f4dbd6");
    expect(color("\x1b]12;#9745be\x1b\\")).toBe("#9745be");
  });

  it("reads the other spellings of one colour", () => {
    // #rgb doubles each digit; the X11 forms keep the high byte, and `rgb:`
    // scales from however many digits each channel was written with — which is
    // what makes `rgb:f/f/f` white rather than very nearly black.
    expect(color("\x1b]12;#F4DBD6\x07")).toBe("#f4dbd6");
    expect(color("\x1b]12;#fff\x07")).toBe("#ffffff");
    expect(color("\x1b]12;#f4f4dbdbd6d6\x07")).toBe("#f4dbd6");
    expect(color("\x1b]12;rgb:f4/db/d6\x07")).toBe("#f4dbd6");
    expect(color("\x1b]12;rgb:f/f/f\x07")).toBe("#ffffff");
  });

  it("reads OSC 112 as the theme's cursor back, which is what nvim quits with", () => {
    expect(color("\x1b]112\x07")).toBeNull();
    expect(color("\x1b]112;\x07")).toBeNull();
    expect(color("\x1b]12;#f4dbd6\x07\x1b]112\x07")).toBeNull();
  });

  it("refuses what it cannot turn into a colour, rather than passing it on", () => {
    // A fillStyle the canvas rejects is not an error: it keeps the colour it
    // had, so an unreadable value has to stop here or it looks like a bug three
    // rooms away. A name is legal and deliberately not guessed at, and `?` is a
    // query for the terminal to answer, which kururu has no way to do.
    expect(color("\x1b]12;rebeccapurple\x07")).toBeUndefined();
    expect(color("\x1b]12;?\x07")).toBeUndefined();
    expect(color("\x1b]12;#12345\x07")).toBeUndefined();
    expect(color("\x1b]12;\x07")).toBeUndefined();
  });

  it("says nothing about the colour when only the shape moved, and the reverse", () => {
    const shapeOnly = scanCursor("\x1b[6 q");
    expect(shapeOnly.color).toBeUndefined();
    const colorOnly = scanCursor("\x1b]12;#787878\x07");
    expect(colorOnly.shape).toBeUndefined();
  });

  it("reads both of a mode change, which arrive together", () => {
    // What nvim actually sends on `i` under the stock guicursor.
    const scan = scanCursor("\x1b[6 q\x1b]12;#787878\x07");
    expect(scan.shape).toEqual({ style: "bar", blink: false });
    expect(scan.color).toBe("#787878");
  });

  it("carries a colour a read boundary cut in half", () => {
    const first = scanCursor("\x1b]12;#f4d");
    expect(first.color).toBeUndefined();
    expect(first.carry).toBe("\x1b]12;#f4d");
    expect(scanCursor("bd6\x07", first.carry).color).toBe("#f4dbd6");
  });

  it("does not report a colour twice across the boundary it did not straddle", () => {
    const first = scanCursor("\x1b]12;#f4dbd6\x07");
    expect(first.color).toBe("#f4dbd6");
    expect(first.carry).toBe("");
    expect(scanCursor("ordinary output", first.carry).color).toBeUndefined();
  });
});

describe("decscusr", () => {
  const every: ProgramCursor[] = [
    { style: "block", blink: true },
    { style: "block", blink: false },
    { style: "underline", blink: true },
    { style: "underline", blink: false },
    { style: "bar", blink: true },
    { style: "bar", blink: false },
  ];

  it("writes the parameters the spec numbers, in pairs", () => {
    expect(every.map(decscusr)).toEqual([
      "\x1b[1 q",
      "\x1b[2 q",
      "\x1b[3 q",
      "\x1b[4 q",
      "\x1b[5 q",
      "\x1b[6 q",
    ]);
  });

  it("round-trips, which is the whole of what holds the two halves together", () => {
    for (const cursor of every) expect(read(decscusr(cursor))).toEqual(cursor);
  });

  it("round-trips the colour too", () => {
    expect(scanCursor(osc12("#9745be")).color).toBe("#9745be");
  });
});
