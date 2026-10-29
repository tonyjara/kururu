/**
 * The note windows' records and boxes. A note read back wrong off the disk is
 * a window drawn where NaN puts it, and a note left on a monitor that is gone
 * is a note nobody can reach — both arithmetic, so both are read here.
 */
import { describe, expect, it } from "bun:test";
import {
  NOTE_MIN,
  NOTE_SIZE,
  NOTES_MAX,
  OPEN_MAX,
  adoptNotes,
  boxOnScreen,
  bringForward,
  cascade,
  fitOnScreen,
  overOpen,
} from "../notelist.js";

const note = (cardId, extra = {}) => ({
  cardId,
  profileKey: "abc123",
  profileName: "Work",
  title: `Card ${cardId}`,
  code: "KUR-1",
  x: 100,
  y: 100,
  width: 340,
  height: 280,
  collapsed: false,
  state: "shown",
  ...extra,
});

const laptop = { id: 1, workArea: { x: 0, y: 25, width: 1512, height: 920 } };
const studio = { id: 2, workArea: { x: 1512, y: -500, width: 2560, height: 1415 } };

describe("adoptNotes", () => {
  it("keeps a good record and drops what is not one", () => {
    const raw = [note("a"), { cardId: "b" }, note("c", { x: Number.NaN }), "nope", note("", {}), note("d", { profileKey: "" })];
    expect(adoptNotes(raw).map((n) => n.cardId)).toEqual(["a"]);
  });

  it("is none for anything that is not a list", () => {
    expect(adoptNotes(null)).toEqual([]);
    expect(adoptNotes({ a: note("a") })).toEqual([]);
  });

  it("raises a box under the floor to it and reads an unknown state as up", () => {
    const [one] = adoptNotes([note("a", { width: 10, height: 10, state: "floating" })]);
    expect(one.width).toBe(NOTE_MIN.width);
    expect(one.height).toBe(NOTE_MIN.height);
    expect(one.state).toBe("shown");
  });

  it("keeps the later of a card listed twice, at the later place", () => {
    const list = adoptNotes([note("a", { x: 1 }), note("b"), note("a", { x: 2 })]);
    expect(list.map((n) => [n.cardId, n.x])).toEqual([
      ["b", 100],
      ["a", 2],
    ]);
  });

  it("holds the list to its size by dropping the closed ones furthest back", () => {
    const many = Array.from({ length: NOTES_MAX + 3 }, (_, i) => note(`c${i}`, { state: i < 5 ? "closed" : "shown" }));
    const list = adoptNotes(many);
    expect(list.length).toBe(NOTES_MAX);
    expect(list.slice(0, 2).map((n) => n.cardId)).toEqual(["c3", "c4"]);
  });
});

describe("bringForward and overOpen", () => {
  it("moves the note to the front of the list with the change", () => {
    const list = bringForward([note("a"), note("b"), note("c")], "a", { state: "hidden" });
    expect(list.map((n) => n.cardId)).toEqual(["b", "c", "a"]);
    expect(list[2].state).toBe("hidden");
  });

  it("names the notes up longest once more than the cap are up", () => {
    const list = Array.from({ length: OPEN_MAX + 2 }, (_, i) => note(`n${i}`));
    expect(overOpen(list)).toEqual(["n0", "n1"]);
    expect(overOpen(list.slice(0, OPEN_MAX))).toEqual([]);
  });
});

describe("fitOnScreen", () => {
  it("leaves a note that is wholly on a display where it is", () => {
    expect(fitOnScreen({ x: 200, y: 300, width: 340, height: 280 }, [laptop, studio])).toEqual({ x: 200, y: 300, width: 340, height: 280 });
  });

  it("brings a note under the menu bar down into the work area", () => {
    expect(fitOnScreen({ x: 200, y: 0, width: 340, height: 280 }, [laptop]).y).toBe(25);
  });

  it("puts a note on the display it overlaps most, whole", () => {
    // Mostly on the studio display, hanging off its left edge onto the laptop.
    const fit = fitOnScreen({ x: 1400, y: 0, width: 340, height: 280 }, [laptop, studio]);
    expect(fit.x).toBe(1512);
  });

  it("moves a note left on a monitor that is gone onto the nearest one", () => {
    // Where the studio display was, with only the laptop left.
    const fit = fitOnScreen({ x: 3000, y: 200, width: 340, height: 280 }, [laptop]);
    expect(fit).toEqual({ x: 1512 - 340, y: 200, width: 340, height: 280 });
  });

  it("is never bigger than the work area", () => {
    const fit = fitOnScreen({ x: 0, y: 0, width: 4000, height: 3000 }, [laptop]);
    expect(fit).toEqual({ x: 0, y: 25, width: 1512, height: 920 });
  });

  it("leaves the box alone with no displays to ask", () => {
    expect(fitOnScreen({ x: 5, y: 6, width: 7, height: 8 }, [])).toEqual({ x: 5, y: 6, width: 7, height: 8 });
  });
});

describe("cascade and boxOnScreen", () => {
  it("puts a first note at the right of what it is placed against, and each next one a step along", () => {
    const anchor = { x: 100, y: 50, width: 1200, height: 800 };
    const first = cascade(anchor, 0, 64);
    const second = cascade(anchor, 1, 64);
    expect(first).toEqual({ x: 100 + 1200 - NOTE_SIZE.width - 32, y: 50 + 64, width: NOTE_SIZE.width, height: NOTE_SIZE.height });
    expect(second.x).toBe(first.x - 28);
    expect(second.y).toBe(first.y + 28);
    expect(cascade(anchor, 8, 64)).toEqual(first);
  });

  it("turns a box in the window's page into one on the screen", () => {
    expect(boxOnScreen({ x: 10, y: 20, w: 300, h: 200 }, { x: 100, y: 200, width: 1000, height: 800 })).toEqual({
      x: 110,
      y: 220,
      width: 300,
      height: 200,
    });
    expect(boxOnScreen({ x: 10, y: Number.NaN, w: 300, h: 200 }, { x: 0, y: 0, width: 1, height: 1 })).toBeNull();
    expect(boxOnScreen(undefined, { x: 0, y: 0, width: 1, height: 1 })).toBeNull();
  });
});
