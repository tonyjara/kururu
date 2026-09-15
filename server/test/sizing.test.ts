/**
 * The size policy, which is the part of the sizing rework that has to be right
 * on a machine with two clients on it — and is therefore the part hardest to
 * check by hand, since checking it means two windows of two widths on one agent
 * and a careful look at which one is ragged.
 *
 * Nothing here touches a pty, a socket or a client: `smallestGrid` is the whole
 * decision and it is a fold over some numbers. The cases that matter are the
 * two ends — nobody proposing, and two proposals that are each smaller in a
 * different dimension — because a minimum reads as obviously correct and those
 * are where obviously-correct stops being enough.
 */
import { describe, expect, it } from "bun:test";
import { smallestGrid } from "../src/sizing";

describe("smallestGrid", () => {
  it("gives one client exactly what it asked for", () => {
    expect(smallestGrid([{ cols: 229, rows: 58 }])).toEqual({ cols: 229, rows: 58 });
  });

  it("takes the smaller of two clients, so neither has to clip", () => {
    const desktop = { cols: 229, rows: 58 };
    const phone = { cols: 48, rows: 34 };
    expect(smallestGrid([desktop, phone])).toEqual({ cols: 48, rows: 34 });
    // Order is not the policy. `latest` is the thing this exists to not be.
    expect(smallestGrid([phone, desktop])).toEqual({ cols: 48, rows: 34 });
  });

  it("takes each dimension on its own, not whichever pane is smaller overall", () => {
    // A short wide pane and a tall narrow one: the only shape both can draw is
    // the intersection, which is neither of the two proposals.
    const wide = { cols: 200, rows: 12 };
    const tall = { cols: 60, rows: 80 };
    expect(smallestGrid([wide, tall])).toEqual({ cols: 60, rows: 12 });
  });

  it("says nothing when nobody is looking, rather than resizing to nothing", () => {
    // The last pane showing a terminal closed. It keeps the shape it had — an
    // exited agent's screen is still the only record of what it said, and a
    // live one has no reason to repaint itself for an audience of nobody.
    expect(smallestGrid([])).toBeNull();
  });
});
