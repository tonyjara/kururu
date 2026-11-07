import { describe, expect, test } from "bun:test";
import { TAP_MS } from "../../shared/voice";
import { shiftChord, shiftDown, shiftHeld, shiftUp } from "../src/shiftpen";

describe("shift and the pen", () => {
  test("nothing unless recording, or with no time", () => {
    expect(shiftDown(false, false, 100)).toBeNull();
    expect(shiftDown(true, false, Number.NaN)).toBeNull();
    expect(shiftDown(true, false, 100)).toEqual({ at: 100, wasPen: false, holding: false, chorded: false });
  });

  test("a tap turns a pen that is up on, and one that is down off", () => {
    const up = shiftDown(true, false, 1000)!;
    expect(shiftUp(up, 1000 + TAP_MS - 1)).toBe(true);
    const down = shiftDown(true, true, 1000)!;
    expect(shiftUp(down, 1000 + 50)).toBe(false);
  });

  test("the tap's threshold is the mic's", () => {
    const press = shiftDown(true, false, 0)!;
    expect(shiftUp(press, TAP_MS - 1)).toBe(true);
    expect(shiftUp(press, TAP_MS)).toBeNull();
  });

  test("a hold puts the pen down at the threshold and up on release", () => {
    let press = shiftDown(true, false, 0)!;
    const held = shiftHeld(press, true);
    expect(held.pen).toBe(true);
    press = held.press;
    expect(shiftUp(press, 2000)).toBe(false);
  });

  test("a hold whose timer ran late but whose stamps say tap stays on", () => {
    const press = shiftHeld(shiftDown(true, false, 0)!, true).press;
    expect(shiftUp(press, 100)).toBe(true);
  });

  test("a hold of a pen already down changes nothing until release, which lifts it", () => {
    const press = shiftDown(true, true, 0)!;
    expect(shiftHeld(press, true).pen).toBeNull();
    expect(shiftUp(press, 2000)).toBe(false);
  });

  test("no hold once the recording is over", () => {
    expect(shiftHeld(shiftDown(true, false, 0)!, false).pen).toBeNull();
  });

  test("a capital letter is nothing", () => {
    const { press, pen } = shiftChord(shiftDown(true, false, 0)!, "key");
    expect(pen).toBeNull();
    expect(shiftHeld(press, true).pen).toBeNull();
    expect(shiftUp(press, 50)).toBeNull();
    expect(shiftUp(press, 2000)).toBeNull();
  });

  test("a capital letter typed with a pen that is down leaves it down", () => {
    const { press } = shiftChord(shiftDown(true, true, 0)!, "key");
    expect(shiftUp(press, 50)).toBeNull();
  });

  test("a Shift-click before a hold is the application's", () => {
    const { press, pen } = shiftChord(shiftDown(true, false, 0)!, "mouse");
    expect(pen).toBeNull();
    expect(shiftUp(press, 50)).toBeNull();
  });

  test("a click during a hold is a stroke and the pen stays down until release", () => {
    const held = shiftHeld(shiftDown(true, false, 0)!, true).press;
    const clicked = shiftChord(held, "mouse");
    expect(clicked.pen).toBeNull();
    expect(clicked.press.holding).toBe(true);
    expect(shiftUp(clicked.press, 3000)).toBe(false);
  });

  test("a key during a hold puts the pen back up, and the release is nothing", () => {
    const held = shiftHeld(shiftDown(true, false, 0)!, true).press;
    const keyed = shiftChord(held, "key");
    expect(keyed.pen).toBe(false);
    expect(shiftUp(keyed.press, 3000)).toBeNull();
    expect(shiftChord(keyed.press, "key").pen).toBeNull();
  });
});
