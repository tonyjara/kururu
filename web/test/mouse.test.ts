/**
 * The mouse protocol, which is worth a test for the same reason `grid` is:
 * every value in it is a small integer, and a small integer that is wrong by
 * four looks exactly like a small integer that is right.
 *
 * The cases that matter are the ones where the encoding and the mode disagree
 * about whether there is anything to send at all. A terminal that reports
 * motion to a program which only asked for clicks is not broken in any way a
 * person can see — it is just quietly handing an application thousands of
 * events a second to parse and throw away.
 */
import { describe, expect, it } from "bun:test";
import {
  BUTTON_NONE,
  encodeMouse,
  MODE_ANY,
  MODE_CLICK,
  MODE_DRAG,
  MODE_SGR,
  mouseModes,
  WHEEL_DOWN,
  WHEEL_UP,
} from "../src/mouse";

const from = (...set: number[]) => mouseModes((mode) => set.includes(mode));

/** What nvim asks for, and the only combination it ever asks for. */
const NVIM = from(MODE_DRAG, MODE_SGR);

const at = (col: number, row: number) => ({
  col,
  row,
  shift: false,
  alt: false,
  ctrl: false,
});

describe("mouseModes", () => {
  it("takes the highest rung of the ladder", () => {
    expect(from(MODE_CLICK).tracking).toBe("click");
    expect(from(MODE_DRAG).tracking).toBe("drag");
    expect(from(MODE_ANY).tracking).toBe("any");
    // 1003 implies 1002 implies 1000, and programs do set more than one.
    expect(from(MODE_CLICK, MODE_DRAG, MODE_ANY).tracking).toBe("any");
  });

  it("is off until something turns it on", () => {
    expect(from().tracking).toBe("none");
    expect(from(MODE_SGR).tracking).toBe("none");
  });

  it("reads the encoding separately from the tracking", () => {
    expect(from(MODE_DRAG).sgr).toBe(false);
    expect(NVIM.sgr).toBe(true);
  });
});

describe("encodeMouse", () => {
  it("says nothing at all while tracking is off", () => {
    expect(encodeMouse({ action: "press", button: 0, ...at(0, 0) }, from(MODE_SGR))).toBeNull();
  });

  it("puts a left click one cell in, one-based", () => {
    expect(encodeMouse({ action: "press", button: 0, ...at(0, 0) }, NVIM)).toBe("\x1b[<0;1;1M");
    expect(encodeMouse({ action: "press", button: 0, ...at(41, 11) }, NVIM)).toBe("\x1b[<0;42;12M");
  });

  it("names the button that came up, which is the whole point of SGR", () => {
    expect(encodeMouse({ action: "release", button: 2, ...at(4, 4) }, NVIM)).toBe("\x1b[<2;5;5m");
    // The original cannot, so all three releases are the same three bytes.
    const legacy = from(MODE_DRAG);
    expect(encodeMouse({ action: "release", button: 0, ...at(4, 4) }, legacy)).toBe("\x1b[M#%%");
    expect(encodeMouse({ action: "release", button: 2, ...at(4, 4) }, legacy)).toBe("\x1b[M#%%");
  });

  it("adds 32 for motion and the modifier bits above it", () => {
    expect(encodeMouse({ action: "move", button: 0, ...at(0, 0) }, NVIM)).toBe("\x1b[<32;1;1M");
    expect(
      encodeMouse({ action: "press", button: 0, col: 0, row: 0, shift: true, alt: false, ctrl: false }, NVIM),
    ).toBe("\x1b[<4;1;1M");
    expect(
      encodeMouse({ action: "press", button: 0, col: 0, row: 0, shift: false, alt: true, ctrl: false }, NVIM),
    ).toBe("\x1b[<8;1;1M");
    expect(
      encodeMouse({ action: "press", button: 0, col: 0, row: 0, shift: false, alt: false, ctrl: true }, NVIM),
    ).toBe("\x1b[<16;1;1M");
  });

  it("withholds the motion a program did not ask to hear about", () => {
    const held = { action: "move", button: 0, ...at(3, 3) } as const;
    const hover = { action: "move", button: BUTTON_NONE, ...at(3, 3) } as const;

    // 1000 is presses and releases; a drag over it is thousands of nothings.
    expect(encodeMouse(held, from(MODE_CLICK, MODE_SGR))).toBeNull();
    expect(encodeMouse(hover, from(MODE_CLICK, MODE_SGR))).toBeNull();

    // 1002 is motion with a button down, and only that.
    expect(encodeMouse(held, NVIM)).toBe("\x1b[<32;4;4M");
    expect(encodeMouse(hover, NVIM)).toBeNull();

    // 1003 is everything, which is what `mousemoveevent` turns on.
    expect(encodeMouse(hover, from(MODE_ANY, MODE_SGR))).toBe("\x1b[<35;4;4M");
  });

  it("treats a wheel notch as a button, in every tracking mode", () => {
    expect(encodeMouse({ action: "press", button: WHEEL_UP, ...at(9, 9) }, NVIM)).toBe("\x1b[<64;10;10M");
    expect(encodeMouse({ action: "press", button: WHEEL_DOWN, ...at(9, 9) }, NVIM)).toBe("\x1b[<65;10;10M");
    expect(encodeMouse({ action: "press", button: WHEEL_UP, ...at(0, 0) }, from(MODE_CLICK, MODE_SGR))).toBe(
      "\x1b[<64;1;1M",
    );
  });

  it("refuses a column the original encoding cannot reach, rather than wrapping it", () => {
    const legacy = from(MODE_DRAG);
    // 223 is the last coordinate a byte at an offset of 32 can carry.
    expect(encodeMouse({ action: "press", button: 0, ...at(222, 0) }, legacy)).toBe(
      `\x1b[M${String.fromCharCode(32, 255, 33)}`,
    );
    expect(encodeMouse({ action: "press", button: 0, ...at(223, 0) }, legacy)).toBeNull();
    expect(encodeMouse({ action: "press", button: 0, ...at(0, 223) }, legacy)).toBeNull();
    // SGR has no such limit, which is why a wide pane needs it.
    expect(encodeMouse({ action: "press", button: 0, ...at(400, 0) }, NVIM)).toBe("\x1b[<0;401;1M");
  });

  it("refuses a cell that is off the grid", () => {
    expect(encodeMouse({ action: "press", button: 0, ...at(-1, 0) }, NVIM)).toBeNull();
    expect(encodeMouse({ action: "press", button: 0, ...at(0, -1) }, NVIM)).toBeNull();
  });
});
