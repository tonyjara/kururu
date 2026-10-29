/**
 * Notes: a box always drawn inside the window whatever was stored, a drag
 * and a resize that stop at the edges and the floor rather than pushing the
 * note, a card popped out twice coming back where it was left, and a stored
 * list that cannot put a NaN on screen. And the card found wherever in the
 * profile it has gone since it was popped out, and a note unfolded back at
 * the line it was folded on.
 */
import { describe, expect, it } from "bun:test";
import { addCard, emptyBoard, emptyProfileBoard, transferCard } from "../../shared/board";
import type { Profile, Workspace } from "../../shared/model";
import {
  adoptNotes,
  change,
  fitNote,
  KeptScroll,
  locateCard,
  moveBox,
  NOTE_HEAD,
  NOTE_MIN,
  NOTE_SIZE,
  NOTES_MAX,
  popOut,
  raise,
  resizeBox,
  SCROLL_SETTLE_MS,
  type Note,
} from "../src/notes";

const room = { w: 1200, h: 800 };

function note(cardId: string, over: Partial<Note> = {}): Note {
  return { cardId, x: 100, y: 100, w: 300, h: 240, collapsed: false, open: true, ...over };
}

describe("fitNote", () => {
  it("leaves a box that fits where it is", () => {
    expect(fitNote({ x: 100, y: 50, w: 300, h: 200 }, room)).toEqual({ x: 100, y: 50, w: 300, h: 200 });
  });

  it("brings a box left past an edge back inside, keeping its size", () => {
    expect(fitNote({ x: 1100, y: 700, w: 300, h: 200 }, room)).toEqual({ x: 900, y: 600, w: 300, h: 200 });
    expect(fitNote({ x: -40, y: -10, w: 300, h: 200 }, room)).toEqual({ x: 0, y: 0, w: 300, h: 200 });
  });

  it("is never smaller than the floor, or bigger than the window", () => {
    expect(fitNote({ x: 0, y: 0, w: 20, h: 10 }, room)).toEqual({ x: 0, y: 0, w: NOTE_MIN.w, h: NOTE_MIN.h });
    expect(fitNote({ x: 0, y: 0, w: 5000, h: 5000 }, room)).toEqual({ x: 0, y: 0, w: 1200, h: 800 });
  });

  it("gives a window smaller than the floor all of itself", () => {
    expect(fitNote({ x: 50, y: 50, w: 300, h: 240 }, { w: 180, h: 100 })).toEqual({ x: 0, y: 0, w: 180, h: 100 });
  });

  it("fits a collapsed note by its title bar, so it can sit on the bottom edge", () => {
    const stored = { x: 100, y: 790, w: 300, h: 240 };
    expect(fitNote(stored, room, true).y).toBe(800 - NOTE_HEAD);
    // Opened again, it goes up as far as its whole height needs.
    expect(fitNote(stored, room, false).y).toBe(800 - 240);
  });

  it("keeps the stored box, so a window narrowed and widened again finds it where it was", () => {
    const stored = { x: 900, y: 100, w: 300, h: 240 };
    expect(fitNote(stored, { w: 800, h: 800 }).x).toBe(500);
    expect(fitNote(stored, room).x).toBe(900);
  });
});

describe("moveBox", () => {
  it("moves by the pointer's travel", () => {
    expect(moveBox({ x: 100, y: 100, w: 300, h: 200 }, 40, -20, room)).toEqual({ x: 140, y: 80, w: 300, h: 200 });
  });

  it("holds the note against an edge it is dragged past", () => {
    expect(moveBox({ x: 100, y: 100, w: 300, h: 200 }, 5000, -5000, room)).toEqual({ x: 900, y: 0, w: 300, h: 200 });
  });
});

describe("resizeBox", () => {
  const start = { x: 300, y: 200, w: 300, h: 240 };

  it("grows from the right and the bottom, leaving the top left where it is", () => {
    expect(resizeBox(start, "se", 50, 30, room)).toEqual({ x: 300, y: 200, w: 350, h: 270 });
  });

  it("grows from the left and the top, leaving the bottom right where it is", () => {
    expect(resizeBox(start, "nw", -50, -30, room)).toEqual({ x: 250, y: 170, w: 350, h: 270 });
  });

  it("moves only the edge it was given", () => {
    expect(resizeBox(start, "e", 50, 99, room)).toEqual({ x: 300, y: 200, w: 350, h: 240 });
    expect(resizeBox(start, "n", 99, -40, room)).toEqual({ x: 300, y: 160, w: 300, h: 280 });
  });

  it("stops a left edge at the floor rather than pushing the note right", () => {
    const shrunk = resizeBox(start, "w", 500, 0, room);
    expect(shrunk).toEqual({ x: 600 - NOTE_MIN.w, y: 200, w: NOTE_MIN.w, h: 240 });
    expect(shrunk.x + shrunk.w).toBe(start.x + start.w);
  });

  it("stops at the floor from the right and the bottom too", () => {
    expect(resizeBox(start, "se", -999, -999, room)).toEqual({ x: 300, y: 200, w: NOTE_MIN.w, h: NOTE_MIN.h });
  });

  it("goes no further than the window's edges", () => {
    expect(resizeBox(start, "se", 5000, 5000, room)).toEqual({ x: 300, y: 200, w: 900, h: 600 });
    expect(resizeBox(start, "nw", -5000, -5000, room)).toEqual({ x: 0, y: 0, w: 600, h: 440 });
  });
});

describe("popOut", () => {
  it("opens a new note at a new note's size, inside the window, in front", () => {
    const notes = popOut([note("a")], "b", room);
    expect(notes.map((n) => n.cardId)).toEqual(["a", "b"]);
    const made = notes[1]!;
    expect(made).toMatchObject({ w: NOTE_SIZE.w, h: NOTE_SIZE.h, open: true, collapsed: false });
    expect(made.x + made.w).toBeLessThanOrEqual(room.w);
    expect(made.y + made.h).toBeLessThanOrEqual(room.h);
  });

  it("puts each new note a step along from the last, so none hides another", () => {
    const one = popOut([], "a", room);
    const two = popOut(one, "b", room);
    expect(two[1]!.x).toBeLessThan(two[0]!.x);
    expect(two[1]!.y).toBeGreaterThan(two[0]!.y);
  });

  it("puts a closed note back where it was left, unfolded and in front", () => {
    const was = [note("a", { x: 40, y: 60, w: 260, h: 300, open: false, collapsed: true }), note("b")];
    const notes = popOut(was, "a", room);
    expect(notes.map((n) => n.cardId)).toEqual(["b", "a"]);
    expect(notes[1]).toEqual({ cardId: "a", x: 40, y: 60, w: 260, h: 300, open: true, collapsed: false });
  });

  it("brings an open note forward rather than making a second one", () => {
    const notes = popOut([note("a"), note("b")], "a", room);
    expect(notes.map((n) => n.cardId)).toEqual(["b", "a"]);
  });

  it("forgets closed notes, the furthest back first, past the limit, and never an open one", () => {
    let notes: Note[] = [];
    for (let i = 0; i < NOTES_MAX; i++) notes.push(note(`c${i}`, { open: i % 2 === 0 }));
    notes = popOut(notes, "new", room);
    expect(notes).toHaveLength(NOTES_MAX);
    expect(notes.some((n) => n.cardId === "c1")).toBe(false);
    expect(notes.some((n) => n.cardId === "c3")).toBe(true);
    expect(notes.filter((n) => n.open)).toHaveLength(NOTES_MAX / 2 + 1);
  });
});

describe("raise and change", () => {
  it("moves a note to the front", () => {
    expect(raise([note("a"), note("b"), note("c")], "a").map((n) => n.cardId)).toEqual(["b", "c", "a"]);
  });

  it("hands back the same list when the note is in front already, so nothing is written", () => {
    const notes = [note("a"), note("b")];
    expect(raise(notes, "b")).toBe(notes);
    expect(raise(notes, "nope")).toBe(notes);
  });

  it("changes one note and leaves the rest", () => {
    const notes = change([note("a"), note("b")], "b", (n) => ({ ...n, open: false }));
    expect(notes.map((n) => n.open)).toEqual([true, false]);
  });
});

describe("adoptNotes", () => {
  it("reads back what it wrote", () => {
    const all = { pk1: [note("a"), note("b", { collapsed: true, open: false })] };
    expect(adoptNotes(JSON.stringify(all))).toEqual(all);
  });

  it("is nothing for nothing, for a string that is not JSON, and for JSON that is not a map", () => {
    expect(adoptNotes(null)).toEqual({});
    expect(adoptNotes("{nope")).toEqual({});
    expect(adoptNotes("[1,2]")).toEqual({});
    expect(adoptNotes('{"pk1": 3}')).toEqual({});
  });

  it("drops a note whose numbers are not finite, rather than drawing it where NaN puts it", () => {
    const raw = '{"pk1":[{"cardId":"a","x":1,"y":2,"w":3,"h":4},{"cardId":"b","x":"1","y":2,"w":3,"h":4},{"cardId":"c","x":null,"y":2,"w":3,"h":4},{"x":1,"y":2,"w":3,"h":4}]}';
    expect(adoptNotes(raw).pk1?.map((n) => n.cardId)).toEqual(["a"]);
  });

  it("keeps the later of a card listed twice, and opens one that does not say", () => {
    const raw = JSON.stringify({ pk1: [{ ...note("a"), x: 1 }, note("b"), { ...note("a"), x: 2, open: undefined }] });
    const notes = adoptNotes(raw).pk1!;
    expect(notes.map((n) => [n.cardId, n.x, n.open])).toEqual([
      ["b", 100, true],
      ["a", 2, true],
    ]);
  });
});

describe("locateCard", () => {
  function workspace(id: string, board = emptyBoard()): Workspace {
    return { id, key: `wk${id}`, name: id, board, mascotId: null } as unknown as Workspace;
  }

  it("finds a card on the profile's board, and one on a workspace's", () => {
    const profileBoard = addCard(emptyProfileBoard(), { title: "mine" }, "cmine");
    const w = workspace("w1", addCard(emptyBoard(), { title: "theirs" }, "ctheirs"));
    const profile = { key: "pk1", board: profileBoard, workspaces: [workspace("w0"), w] } as unknown as Profile;
    expect(locateCard(profile, "cmine")).toMatchObject({ card: { title: "mine" }, workspace: null });
    expect(locateCard(profile, "ctheirs")?.workspace?.id).toBe("w1");
    expect(locateCard(profile, "cnone")).toBeNull();
  });

  it("follows a card sent from the profile's board to a workspace, which keeps its id", () => {
    const { from, to } = transferCard(addCard(emptyProfileBoard(), { title: "sent" }, "csent"), emptyBoard(), "csent");
    const profile = { key: "pk1", board: from, workspaces: [workspace("w1", to)] } as unknown as Profile;
    expect(locateCard(profile, "csent")?.workspace?.id).toBe("w1");
  });
});

describe("KeptScroll", () => {
  /** A note read down to `top` and folded — a fold tells the keeper nothing, since the box is simply gone. */
  function leftAt(top: number): KeptScroll {
    const kept = new KeptScroll();
    kept.scrolled(top);
    return kept;
  }

  it("puts an unfolded body back where it was left", () => {
    const kept = leftAt(240);
    kept.shown(0);
    expect(kept.frame(0, 0, 1000)).toBe(240);
  });

  it("holds the place asked for while the window grows back and the markup lands, not the first clamp", () => {
    const kept = leftAt(240);
    kept.shown(0);
    // The card's text alone, before its markup and diagrams: shorter.
    expect(kept.frame(0, 0, 100)).toBe(100);
    // The browser's clamp and the frame's own write both fire a scroll event; neither is the place.
    kept.scrolled(100);
    expect(kept.top).toBe(240);
    expect(kept.frame(16, 100, 900)).toBe(240);
    // The note window grown to its height, which can scroll less far.
    expect(kept.frame(80, 240, 700)).toBe(240);
  });

  it("shows a card that got shorter while folded to its end, and keeps that once settled", () => {
    const kept = leftAt(240);
    kept.shown(0);
    expect(kept.frame(0, 0, 60)).toBe(60);
    expect(kept.frame(SCROLL_SETTLE_MS, 60, 60)).toBeNull();
    expect(kept.top).toBe(60);
  });

  it("holds a body with nothing to scroll at the top", () => {
    const kept = leftAt(240);
    kept.shown(0);
    expect(kept.frame(0, 0, 0)).toBe(0);
    expect(kept.frame(0, 0, -4)).toBe(0);
  });

  it("lets go the moment the person scrolls, and follows them from there", () => {
    const kept = leftAt(240);
    kept.shown(0);
    expect(kept.frame(0, 0, 1000)).toBe(240);
    kept.touched(240);
    expect(kept.frame(16, 240, 1000)).toBeNull();
    kept.scrolled(520);
    expect(kept.top).toBe(520);
  });

  it("follows every scroll once settled", () => {
    const kept = leftAt(240);
    kept.shown(0);
    expect(kept.frame(SCROLL_SETTLE_MS + 1, 240, 1000)).toBeNull();
    kept.scrolled(80);
    expect(kept.top).toBe(80);
  });

  it("keeps the place asked for through a fold made before the body settled", () => {
    const kept = leftAt(240);
    kept.shown(0);
    expect(kept.frame(0, 0, 100)).toBe(100);
    // Folded again here; the next unfold draws the whole card.
    kept.shown(500);
    expect(kept.frame(500, 0, 1000)).toBe(240);
  });

  it("forgets an editor's place with its draft", () => {
    const kept = leftAt(240);
    kept.forget();
    kept.shown(0);
    expect(kept.frame(0, 0, 1000)).toBe(0);
  });
});
