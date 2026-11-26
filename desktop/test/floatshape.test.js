/**
 * The floating Kuru's sums. A logo read back wrong off the disk is a window
 * put where NaN puts it; a chat that opens off the edge of its display is a
 * composer nobody can type in; a chat that turns round its logo as the logo
 * is dragged is the shifting the owner asked to be rid of (2026-11-24); and
 * a waveform on the wrong side of a logo in a corner is one drawn off the
 * screen. All arithmetic, so all read here.
 */
import { describe, expect, it } from "bun:test";
import {
  CORNERS,
  GAP,
  HOME_INSET,
  LOGO,
  LOGO_MARGIN,
  PANEL_FLOOR,
  PANEL_HEIGHT,
  PANEL_MIN,
  PANEL_WIDTH,
  PANEL_WIDTH_MAX,
  PANEL_WIDTH_MIN,
  PILL_MARGIN,
  WAVE_GAP,
  WAVE_WIDTH,
  EDGES,
  adoptEdge,
  adoptFloat,
  grippedBox,
  heldInside,
  logoBox,
  logoFor,
  panelBox,
  placeOf,
  waveBox,
  waveWidth,
} from "../floatshape.js";

/** A laptop's display with a menu bar over it and a Dock under it, and a second one to its left. */
const main = { id: 1, workArea: { x: 0, y: 25, width: 1512, height: 900 } };
const left = { id: 2, workArea: { x: -1920, y: 0, width: 1920, height: 1080 } };

const logoAt = (x, y) => ({ x, y, width: LOGO, height: LOGO });
const inside = (box, area) => box.x >= area.x && box.y >= area.y && box.x + box.width <= area.x + area.width && box.y + box.height <= area.y + area.height;

describe("what desktop.json holds", () => {
  it("is off, nowhere and the default height when there is nothing", () => {
    expect(adoptFloat(undefined)).toEqual({ on: false, place: null, corner: "bottom-right", height: PANEL_HEIGHT, width: PANEL_WIDTH });
    expect(adoptFloat("yes")).toEqual({ on: false, place: null, corner: "bottom-right", height: PANEL_HEIGHT, width: PANEL_WIDTH });
  });

  it("keeps a place that is a share of a display, as it was written", () => {
    const kept = adoptFloat({ on: true, place: { displayId: 2, x: 0.25, y: 0.875 }, corner: "top-left", height: 400, width: 560 });
    expect(kept).toEqual({ on: true, place: { displayId: 2, x: 0.25, y: 0.875 }, corner: "top-left", height: 400, width: 560 });
  });

  it("keeps a corner only if it is one, and starts at the bottom right", () => {
    for (const corner of CORNERS) expect(adoptFloat({ corner }).corner).toBe(corner);
    for (const corner of ["middle", "Bottom-Right", 3, null, ["top-left"]]) expect(adoptFloat({ corner }).corner).toBe("bottom-right");
    expect(CORNERS[0]).toBe("bottom-right");
  });

  it("drops a place that is not one", () => {
    for (const place of [{ x: 0.5, y: 0.5 }, { displayId: 1, x: 300, y: 0.5 }, { displayId: 1, x: Number.NaN, y: 0 }, { displayId: "1", x: 0, y: 0 }, [0, 0]]) {
      expect(adoptFloat({ on: true, place }).place).toBeNull();
    }
  });

  it("checks a height before clamping it", () => {
    expect(adoptFloat({ height: Number.NaN }).height).toBe(PANEL_HEIGHT);
    expect(adoptFloat({ height: "tall" }).height).toBe(PANEL_HEIGHT);
    expect(adoptFloat({ height: 12 }).height).toBe(PANEL_MIN);
    expect(adoptFloat({ height: 301.6 }).height).toBe(302);
  });

  it("checks a width before clamping it, and holds it between the least and the most", () => {
    expect(adoptFloat({ width: Number.NaN }).width).toBe(PANEL_WIDTH);
    expect(adoptFloat({ width: "wide" }).width).toBe(PANEL_WIDTH);
    expect(adoptFloat({ width: 10 }).width).toBe(PANEL_WIDTH_MIN);
    expect(adoptFloat({ width: 99999 }).width).toBe(PANEL_WIDTH_MAX);
    expect(adoptFloat({ width: 500.4 }).width).toBe(500);
  });

  it("is on only for true", () => {
    expect(adoptFloat({ on: 1 }).on).toBe(false);
    expect(adoptFloat({ on: "true" }).on).toBe(false);
  });
});

describe("where the logo goes", () => {
  it("starts in the bottom right corner of home", () => {
    const box = logoBox(null, [main, left], main);
    expect(box).toEqual({ x: 1512 - LOGO - HOME_INSET, y: 25 + 900 - LOGO - HOME_INSET, width: LOGO, height: LOGO, displayId: 1 });
  });

  it("goes back to the share it was left at, on its display", () => {
    const box = logoBox({ displayId: 2, x: 0.5, y: 0 }, [main, left], main);
    expect(box.displayId).toBe(2);
    expect(box.x).toBe(-1920 + Math.round((1920 - LOGO) / 2));
    expect(box.y).toBe(0);
  });

  it("keeps the share on home when its display has gone", () => {
    const box = logoBox({ displayId: 2, x: 1, y: 1 }, [main], main);
    expect(box.displayId).toBe(1);
    expect(inside(box, main.workArea)).toBe(true);
    expect(box.x).toBe(1512 - LOGO);
  });

  it("remembers a drop as a share that puts it back in the same spot", () => {
    const dropped = logoAt(-1500, 700);
    const place = placeOf(dropped, left);
    const back = logoBox(place, [main, left], main);
    expect(back.x).toBe(-1500);
    expect(back.y).toBe(700);
  });

  it("cannot be dragged out of the work area it is over", () => {
    expect(heldInside(5000, -40, main.workArea)).toEqual({ x: 1512 - LOGO, y: 25 });
    expect(heldInside(-10, 5000, main.workArea)).toEqual({ x: 0, y: 25 + 900 - LOGO });
  });
});

describe("which way the chat opens", () => {
  it("opens upwards and to the left from the bottom right corner", () => {
    const logo = logoBox(null, [main], main);
    const box = panelBox(logo, main.workArea, 520);
    expect(box.side).toBe("above");
    expect(box.reach).toBe("left");
    expect(box.height).toBe(520);
    // Its right edge is the mark's, and its foot is a gap above the mark.
    expect(box.x + box.width).toBe(logo.x + LOGO - LOGO_MARGIN);
    expect(box.y + box.height).toBe(logo.y + LOGO_MARGIN - GAP);
    expect(box.logo).toEqual({ x: logo.x, y: logo.y });
    expect(inside(box, main.workArea)).toBe(true);
  });

  it("keeps the logo at its corner wherever on the display the logo is", () => {
    // The middle of the display, and each quarter of it: the chat never turns round.
    for (const [x, y] of [[700, 500], [400, 700], [1200, 700], [1200, 650], [900, 900 - LOGO]]) {
      const box = panelBox(logoAt(x, y), main.workArea, 400, 420);
      expect([box.side, box.reach]).toEqual(["above", "left"]);
      expect(box.logo).toEqual({ x, y });
      expect(box.x + box.width).toBe(x + LOGO - LOGO_MARGIN);
    }
  });

  it("puts the chat on the side the corner says, for each corner", () => {
    const logo = logoAt(700, 450);
    const area = { x: 0, y: 0, width: 1512, height: 1100 };
    const right = panelBox(logo, area, 400, 420, "bottom-right");
    expect([right.side, right.reach]).toEqual(["above", "left"]);
    const left = panelBox(logo, area, 400, 420, "bottom-left");
    expect([left.side, left.reach]).toEqual(["above", "right"]);
    expect(left.x).toBe(logo.x + LOGO_MARGIN);
    const topRight = panelBox(logo, area, 400, 420, "top-right");
    expect([topRight.side, topRight.reach]).toEqual(["below", "left"]);
    expect(topRight.y).toBe(logo.y + LOGO - LOGO_MARGIN + GAP);
    const topLeft = panelBox(logo, area, 400, 420, "top-left");
    expect([topLeft.side, topLeft.reach]).toEqual(["below", "right"]);
    for (const box of [right, left, topRight, topLeft]) expect(box.logo).toEqual({ x: logo.x, y: logo.y });
  });

  it("brings the logo out with it from a corner of the display it does not fit against, rather than turning round", () => {
    const logo = logoAt(0, 25);
    const box = panelBox(logo, main.workArea, 520, 420);
    expect([box.side, box.reach]).toEqual(["above", "left"]);
    expect(inside(box, main.workArea)).toBe(true);
    // Moved just enough: the chat's top and left edges on the display's.
    expect(box.x).toBe(0);
    expect(box.y).toBe(25);
    expect(box.logo).toEqual({ x: 420 - LOGO + LOGO_MARGIN, y: 25 + 520 - LOGO_MARGIN + GAP });
    // And still at its corner.
    expect(box.x + box.width).toBe(box.logo.x + LOGO - LOGO_MARGIN);
    expect(box.y + box.height).toBe(box.logo.y + LOGO_MARGIN - GAP);
  });

  it("does the same from the other corners for a logo at the top", () => {
    for (const [x, corner] of [[1512 - LOGO, "bottom-left"], [0, "top-right"], [1512 - LOGO, "top-left"]]) {
      const start = corner.startsWith("top") ? 25 + 900 - LOGO : 25;
      const box = panelBox(logoAt(x, start), main.workArea, 520, 420, corner);
      expect(inside(box, main.workArea)).toBe(true);
      expect(inside({ ...box.logo, width: LOGO, height: LOGO }, main.workArea)).toBe(true);
    }
  });

  it("is never taller than the display has with the logo beside it", () => {
    const box = panelBox(logoAt(700, 25 + 500), main.workArea, 2000);
    expect(box.side).toBe("above");
    expect(box.height).toBe(900 - (LOGO - LOGO_MARGIN + GAP));
    expect(box.y).toBe(main.workArea.y);
    expect(box.logo.y).toBe(25 + 900 - LOGO);
    expect(inside(box, main.workArea)).toBe(true);
  });

  it("stays on a display to the left of the main one", () => {
    const logo = logoAt(-1920 + 40, 1080 - LOGO - 30);
    const box = panelBox(logo, left.workArea, 520);
    expect(inside(box, left.workArea)).toBe(true);
    expect(box.reach).toBe("left");
    expect(box.logo.x).toBe(-1920 + PANEL_WIDTH - LOGO + LOGO_MARGIN);
  });

  it("reads a height that is not a number as the default", () => {
    const logo = logoBox(null, [main], main);
    expect(panelBox(logo, main.workArea, Number.NaN).height).toBe(PANEL_HEIGHT);
    expect(panelBox(logo, main.workArea, undefined).height).toBe(PANEL_HEIGHT);
  });

  it("is no wider than the display, less the room to the mark", () => {
    const narrow = { x: 0, y: 0, width: 360, height: 800 };
    const box = panelBox(logoAt(100, 700), narrow, 400);
    expect(box.width).toBe(360 - LOGO_MARGIN);
    expect(box.x).toBe(0);
    expect(box.logo.x).toBe(360 - LOGO);
    expect(inside(box, narrow)).toBe(true);
  });

  it("is the width it was dragged to, growing away from the logo", () => {
    const logo = logoBox(null, [main], main);
    const box = panelBox(logo, main.workArea, 520, 640);
    expect(box.width).toBe(640);
    // Its right edge is still the mark's: the width went leftwards.
    expect(box.x + box.width).toBe(logo.x + LOGO - LOGO_MARGIN);
    const right = panelBox(logoAt(100, 700), main.workArea, 520, 640, "bottom-left");
    expect(right.x).toBe(100 + LOGO_MARGIN);
    expect(right.width).toBe(640);
  });

  it("reads a width that is not a number as the default, and holds one past the ends", () => {
    const logo = logoBox(null, [main], main);
    expect(panelBox(logo, main.workArea, 520, Number.NaN).width).toBe(PANEL_WIDTH);
    expect(panelBox(logo, main.workArea, 520, 12).width).toBe(PANEL_WIDTH_MIN);
    expect(panelBox(logo, main.workArea, 520, 5000).width).toBe(PANEL_WIDTH_MAX);
  });

  it("brings the logo along to make room for the width it was dragged to", () => {
    // A logo a third of the way in from the right: 500 px of display to its left, and a chat 700 wide.
    const area = { x: 0, y: 25, width: 900, height: 900 };
    const box = panelBox(logoAt(500 - LOGO + LOGO_MARGIN, 700), area, 520, 700);
    expect(box.reach).toBe("left");
    expect(box.width).toBe(700);
    expect(box.x).toBe(0);
    expect(box.logo.x).toBe(700 - LOGO + LOGO_MARGIN);
  });

  it("fills a display too short for the height it was dragged to", () => {
    const short = { x: 0, y: 25, width: 1512, height: 440 };
    const box = panelBox(logoAt(700, 25 + 200), short, 520);
    expect(box.height).toBe(440 - (LOGO - LOGO_MARGIN + GAP));
    expect(inside(box, short)).toBe(true);
  });
});

describe("picking another corner", () => {
  it("moves the logo to that corner of a chat that stays where it is", () => {
    const area = { x: 0, y: 0, width: 1512, height: 1100 };
    const chat = panelBox(logoAt(900, 700), area, 400, 420);
    for (const corner of CORNERS) {
      const to = logoFor(chat, corner);
      const again = panelBox({ ...to, width: LOGO, height: LOGO }, area, 400, 420, corner);
      expect(again.logo).toEqual(to);
      expect({ x: again.x, y: again.y, width: again.width, height: again.height }).toEqual({ x: chat.x, y: chat.y, width: chat.width, height: chat.height });
    }
  });

  it("is the same spot for the corner it is already at", () => {
    const chat = panelBox(logoAt(900, 700), main.workArea, 400, 420);
    expect(logoFor(chat, "bottom-right")).toEqual({ x: 900, y: 700 });
  });
});

/** The box `panelBox` gives back for a logo put where `logoFor` says of `box`: the box again, if the drag kept the pair inside. */
const settled = (box, area, corner) => {
  const to = logoFor(box, corner);
  const again = panelBox({ ...to, width: LOGO, height: LOGO }, area, box.height, box.width, corner);
  return { x: again.x, y: again.y, width: again.width, height: again.height };
};

describe("resizing the chat from any edge", () => {
  // The default corner: the logo at the chat's bottom right, the chat above it and extending left.
  const area = main.workArea;
  const box = panelBox(logoAt(1000, 600), area, 520, 420);
  const right = box.x + box.width;
  const foot = box.y + box.height;

  it("names every edge and corner, and reads an older page's names as the far ones", () => {
    for (const edge of EDGES) expect(adoptEdge(edge)).toBe(edge);
    expect(adoptEdge("height")).toBe("n");
    expect(adoptEdge("width")).toBe("w");
    expect(adoptEdge("both")).toBe("nw");
    expect(adoptEdge(undefined)).toBe("n");
    expect(adoptEdge("both", "top-left")).toBe("se");
    expect(adoptEdge("width", "bottom-left")).toBe("e");
    expect(adoptEdge("height", "top-right")).toBe("s");
  });

  it("moves the far edges and leaves the logo's side where it is", () => {
    const next = grippedBox(box, "nw", { x: right - 600, y: foot - 300 }, area);
    expect(next).toEqual({ x: right - 600, y: foot - 300, width: 600, height: 300 });
  });

  it("moves a near edge and leaves the far one where it is, which the owner's top right asked for", () => {
    // The top right corner: the top is far, the right is the logo's side.
    const next = grippedBox(box, "ne", { x: right + 100, y: box.y - 40 }, area);
    expect(next).toEqual({ x: box.x, y: box.y - 40, width: box.width + 100, height: box.height + 40 });
    // The logo goes along to its corner of the new box, and the box is what panelBox then gives.
    expect(logoFor(next, "bottom-right").x).toBe(logoFor(box, "bottom-right").x + 100);
    expect(settled(next, area, "bottom-right")).toEqual(next);
  });

  it("moves the bottom with the logo under it, and narrows from the right", () => {
    const next = grippedBox(box, "se", { x: right - 50, y: foot + 30 }, area);
    expect(next).toEqual({ x: box.x, y: box.y, width: box.width - 50, height: box.height + 30 });
    expect(settled(next, area, "bottom-right")).toEqual(next);
  });

  it("drags one axis from an edge and both from a corner", () => {
    expect(grippedBox(box, "e", { x: right + 20, y: 0 }, area)).toEqual({ x: box.x, y: box.y, width: box.width + 20, height: box.height });
    expect(grippedBox(box, "s", { x: 0, y: foot - 20 }, area)).toEqual({ x: box.x, y: box.y, width: box.width, height: box.height - 20 });
  });

  it("holds each size between its least and its most", () => {
    expect(grippedBox(box, "w", { x: right - 10, y: 0 }, area).width).toBe(PANEL_WIDTH_MIN);
    expect(grippedBox(box, "e", { x: box.x + 10, y: 0 }, area).width).toBe(PANEL_WIDTH_MIN);
    expect(grippedBox(box, "n", { x: 0, y: foot - 10 }, area).height).toBe(PANEL_MIN);
    expect(grippedBox(box, "s", { x: 0, y: box.y + 10 }, area).height).toBe(PANEL_MIN);
    expect(grippedBox(box, "w", { x: -99999, y: 0 }, area).width).toBe(PANEL_WIDTH_MAX);
  });

  it("stops where the logo would leave the display, on the logo's sides", () => {
    const near = LOGO - LOGO_MARGIN + GAP;
    const wide = grippedBox(box, "e", { x: 99999, y: 0 }, area);
    expect(wide.x + wide.width).toBe(area.x + area.width - LOGO_MARGIN);
    const tall = grippedBox(box, "s", { x: 0, y: 99999 }, area);
    expect(tall.y + tall.height).toBe(area.y + area.height - near);
    for (const next of [wide, tall]) {
      const to = logoFor(next, "bottom-right");
      expect(inside({ ...to, width: LOGO, height: LOGO }, area)).toBe(true);
      expect(settled(next, area, "bottom-right")).toEqual(next);
    }
  });

  it("stops at the display's edge on the far sides", () => {
    expect(grippedBox(box, "n", { x: 0, y: -5000 }, area).y).toBe(area.y);
    const short = { x: 0, y: 25, width: 900, height: 900 };
    const narrow = panelBox(logoAt(500 - LOGO + LOGO_MARGIN, 700), short, 520, 420);
    expect(grippedBox(narrow, "w", { x: -4000, y: 0 }, short).x).toBe(0);
  });

  it("knows the logo's sides at every corner", () => {
    const near = LOGO - LOGO_MARGIN + GAP;
    for (const corner of CORNERS) {
      const at = panelBox(logoAt(700, 400), area, 520, 420, corner);
      const out = { x: at.x, y: at.y, width: at.width, height: at.height };
      for (const edge of EDGES) {
        const next = grippedBox(out, edge, { x: edge.includes("w") ? -99999 : 99999, y: edge.includes("n") ? -99999 : 99999 }, area, corner);
        expect(inside(next, area)).toBe(true);
        const to = logoFor(next, corner);
        expect(inside({ ...to, width: LOGO, height: LOGO }, area)).toBe(true);
        expect(settled(next, area, corner)).toEqual(next);
      }
      // The logo's own row is kept clear on its side: below the chat for a bottom corner, above it for a top one.
      const down = grippedBox(out, "s", { x: 0, y: 99999 }, area, corner);
      const up = grippedBox(out, "n", { x: 0, y: -99999 }, area, corner);
      if (corner.startsWith("bottom")) expect(down.y + down.height).toBe(area.y + area.height - near);
      else expect(up.y).toBe(area.y + near);
    }
  });

  it("keeps the box it has for a pointer that is nowhere", () => {
    expect(grippedBox(box, "nw", { x: Number.NaN, y: Number.NaN }, area)).toEqual({ x: box.x, y: box.y, width: box.width, height: box.height });
  });
});

describe("the room around the logo's mark", () => {
  it("clears the shadow, the ring and the count, which 8 px did not", () => {
    // The shadow is 3 px down with 7 of blur (`float.css`); the count's ring ends 7 px out; the mark a size up adds under 2.
    expect(LOGO_MARGIN).toBeGreaterThanOrEqual(3 + 7 + 2);
    expect(LOGO - 2 * LOGO_MARGIN).toBe(48);
  });
});

describe("where the waveform sits", () => {
  it("is on the chat's side of the logo, a gap from its mark", () => {
    const logo = logoBox(null, [main], main);
    const size = { width: WAVE_WIDTH + 2 * PILL_MARGIN, height: 48 + 2 * PILL_MARGIN };
    const box = waveBox(logo, main.workArea, size);
    expect(box.side).toBe("left");
    // What is drawn ends `WAVE_GAP` before the mark begins.
    expect(box.x + size.width - PILL_MARGIN).toBe(logo.x + LOGO_MARGIN - WAVE_GAP);
    // And is centred on the logo's row.
    expect(box.y + size.height / 2).toBe(logo.y + LOGO / 2);
  });

  it("stays on the chat's side in the left half of the display, and with the logo at a left corner goes right", () => {
    const size = { width: 200, height: 40 };
    expect(waveBox(logoAt(400, 400), main.workArea, size).side).toBe("left");
    const box = waveBox(logoAt(400, 400), main.workArea, size, "bottom-left");
    expect(box.side).toBe("right");
    expect(box.x + PILL_MARGIN).toBe(400 + LOGO - LOGO_MARGIN + WAVE_GAP);
  });

  it("goes the other way beside a shut chat whose logo is hard against the chat's edge, and never with it open", () => {
    const size = { width: 200, height: 40 };
    const logo = logoAt(30, 400);
    expect(waveBox(logo, main.workArea, size).side).toBe("right");
    expect(waveBox(logo, main.workArea, size, "bottom-right", true).side).toBe("left");
    expect(waveBox(logoAt(1512 - LOGO, 400), main.workArea, size, "top-left").side).toBe("left");
  });

  it("runs the rest of the chat's width when the chat is open", () => {
    const logo = logoBox(null, [main], main);
    const panel = panelBox(logo, main.workArea, 520);
    const width = waveWidth(panel);
    expect(width).toBe(PANEL_WIDTH - (LOGO - 2 * LOGO_MARGIN) - WAVE_GAP);
    // And of a chat dragged wider, the rest of that.
    expect(waveWidth(panelBox(logo, main.workArea, 520, 700))).toBe(700 - (LOGO - 2 * LOGO_MARGIN) - WAVE_GAP);
    // The bar and the mark together are exactly as wide as the chat over them.
    const box = waveBox(logo, main.workArea, { width: width + 2 * PILL_MARGIN, height: 64 });
    expect(box.x + PILL_MARGIN).toBe(panel.x);
    expect(waveWidth(null)).toBe(WAVE_WIDTH);
  });
});
