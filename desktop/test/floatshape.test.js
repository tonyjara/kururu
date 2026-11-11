/**
 * The floating Kuru's sums. A logo read back wrong off the disk is a window
 * put where NaN puts it; a chat that opens off the edge of its display is a
 * composer nobody can type in; and a waveform on the wrong side of a logo in
 * a corner is one drawn off the screen. All arithmetic, so all read here.
 */
import { describe, expect, it } from "bun:test";
import {
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
  adoptFloat,
  draggedHeight,
  draggedWidth,
  heldInside,
  logoBox,
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
    expect(adoptFloat(undefined)).toEqual({ on: false, place: null, height: PANEL_HEIGHT, width: PANEL_WIDTH });
    expect(adoptFloat("yes")).toEqual({ on: false, place: null, height: PANEL_HEIGHT, width: PANEL_WIDTH });
  });

  it("keeps a place that is a share of a display, as it was written", () => {
    const kept = adoptFloat({ on: true, place: { displayId: 2, x: 0.25, y: 0.875 }, height: 400, width: 560 });
    expect(kept).toEqual({ on: true, place: { displayId: 2, x: 0.25, y: 0.875 }, height: 400, width: 560 });
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
    expect(inside(box, main.workArea)).toBe(true);
  });

  it("opens downwards and to the right from the top left corner", () => {
    const logo = logoAt(0, 25);
    const box = panelBox(logo, main.workArea, 520);
    expect(box.side).toBe("below");
    expect(box.reach).toBe("right");
    expect(box.x).toBe(logo.x + LOGO_MARGIN);
    expect(box.y).toBe(logo.y + LOGO - LOGO_MARGIN + GAP);
    expect(inside(box, main.workArea)).toBe(true);
  });

  it("opens downwards and to the left from the top right corner, and upwards and to the right from the bottom left", () => {
    const topRight = panelBox(logoAt(1512 - LOGO, 25), main.workArea, 400);
    expect([topRight.side, topRight.reach]).toEqual(["below", "left"]);
    const bottomLeft = panelBox(logoAt(0, 25 + 900 - LOGO), main.workArea, 400);
    expect([bottomLeft.side, bottomLeft.reach]).toEqual(["above", "right"]);
  });

  it("is never taller than the side it opens on", () => {
    const logo = logoAt(700, 25 + 500);
    const box = panelBox(logo, main.workArea, 2000);
    expect(box.side).toBe("above");
    expect(box.height).toBe(box.room);
    expect(box.y).toBe(main.workArea.y);
    expect(inside(box, main.workArea)).toBe(true);
  });

  it("stays on a display to the left of the main one", () => {
    const logo = logoAt(-1920 + 40, 1080 - LOGO - 30);
    const box = panelBox(logo, left.workArea, 520);
    expect(inside(box, left.workArea)).toBe(true);
    expect(box.reach).toBe("right");
  });

  it("reads a height that is not a number as the default", () => {
    const logo = logoBox(null, [main], main);
    expect(panelBox(logo, main.workArea, Number.NaN).height).toBe(PANEL_HEIGHT);
    expect(panelBox(logo, main.workArea, undefined).height).toBe(PANEL_HEIGHT);
  });

  it("is no wider than the display has from the logo's side of it", () => {
    const narrow = { x: 0, y: 0, width: 360, height: 800 };
    const logo = logoAt(280, 700);
    const box = panelBox(logo, narrow, 400);
    // From the mark's right edge to the display's left, which is less than a chat's own width.
    expect(box.width).toBe(logo.x + LOGO - LOGO_MARGIN);
    expect(box.x).toBe(0);
    expect(box.width).toBeLessThan(PANEL_WIDTH);
    expect(inside(box, narrow)).toBe(true);
  });

  it("is the width it was dragged to, growing away from the logo", () => {
    const logo = logoBox(null, [main], main);
    const box = panelBox(logo, main.workArea, 520, 640);
    expect(box.width).toBe(640);
    // Its right edge is still the mark's: the width went leftwards.
    expect(box.x + box.width).toBe(logo.x + LOGO - LOGO_MARGIN);
    const right = panelBox(logoAt(100, 700), main.workArea, 520, 640);
    expect(right.x).toBe(100 + LOGO_MARGIN);
    expect(right.width).toBe(640);
  });

  it("reads a width that is not a number as the default, and holds one past the ends", () => {
    const logo = logoBox(null, [main], main);
    expect(panelBox(logo, main.workArea, 520, Number.NaN).width).toBe(PANEL_WIDTH);
    expect(panelBox(logo, main.workArea, 520, 12).width).toBe(PANEL_WIDTH_MIN);
    expect(panelBox(logo, main.workArea, 520, 5000).width).toBe(PANEL_WIDTH_MAX);
  });

  it("is never wider than the display has that way", () => {
    // A logo a third of the way in from the right: 500 px of display to its left.
    const logo = logoAt(500 - LOGO + LOGO_MARGIN, 700);
    const box = panelBox(logo, { x: 0, y: 25, width: 900, height: 900 }, 520, 900);
    expect(box.reach).toBe("left");
    expect(box.roomAcross).toBe(500);
    expect(box.width).toBe(500);
    expect(box.x).toBe(0);
  });

  it("still has its least width beside a logo with less room than that, slid inside the display", () => {
    const tiny = { x: 0, y: 0, width: 400, height: 800 };
    // Just left of the middle, so it extends rightwards with well under the least width to do it in.
    const box = panelBox(logoAt(190 - LOGO / 2, 700), tiny, 400, 420);
    expect(box.reach).toBe("right");
    expect(box.width).toBe(PANEL_WIDTH_MIN);
    expect(inside(box, tiny)).toBe(true);
  });
});

describe("dragging the chat's far side", () => {
  it("follows the pointer with its left edge when it extends leftwards", () => {
    const logo = logoBox(null, [main], main);
    const box = panelBox(logo, main.workArea, 520, 420);
    const anchor = box.x + box.width;
    expect(draggedWidth(box, anchor - 600)).toBe(600);
    expect(draggedWidth(box, anchor - 10)).toBe(PANEL_WIDTH_MIN);
    expect(draggedWidth(box, -99999)).toBe(PANEL_WIDTH_MAX);
  });

  it("follows the pointer with its right edge when it extends rightwards", () => {
    const box = panelBox(logoAt(100, 700), main.workArea, 520, 420);
    expect(draggedWidth(box, box.x + 555)).toBe(555);
    expect(draggedWidth(box, box.x + 1)).toBe(PANEL_WIDTH_MIN);
    expect(draggedWidth(box, 99999)).toBe(PANEL_WIDTH_MAX);
  });

  it("stops at the edge of a display with less than the most that way", () => {
    const area = { x: 0, y: 25, width: 900, height: 900 };
    const box = panelBox(logoAt(500 - LOGO + LOGO_MARGIN, 700), area, 520, 420);
    expect(draggedWidth(box, -4000)).toBe(500);
  });

  it("keeps the width it has for a pointer that is nowhere", () => {
    const box = panelBox(logoAt(100, 700), main.workArea, 520, 480);
    expect(draggedWidth(box, Number.NaN)).toBe(480);
  });
});

describe("dragging the chat's far edge", () => {
  it("follows the pointer with its top when it is above the logo", () => {
    const logo = logoBox(null, [main], main);
    const box = panelBox(logo, main.workArea, 520);
    const foot = box.y + box.height;
    expect(draggedHeight(box, foot - 300)).toBe(300);
    expect(draggedHeight(box, foot - 10)).toBe(PANEL_MIN);
    expect(draggedHeight(box, -5000)).toBe(box.room);
  });

  it("follows the pointer with its foot when it is below the logo", () => {
    const box = panelBox(logoAt(0, 25), main.workArea, 520);
    expect(draggedHeight(box, box.y + 340)).toBe(340);
    expect(draggedHeight(box, 99999)).toBe(box.room);
  });

  it("keeps the height it has for a pointer that is nowhere", () => {
    const box = panelBox(logoAt(0, 25), main.workArea, 520);
    expect(draggedHeight(box, Number.NaN)).toBe(box.height);
  });

  it("never asks for less than the side has", () => {
    const logo = logoAt(700, 25 + 200);
    const box = panelBox(logo, { x: 0, y: 25, width: 1512, height: 440 }, 520);
    expect(box.room).toBeLessThan(PANEL_MIN);
    expect(box.room).toBeGreaterThanOrEqual(PANEL_FLOOR);
    expect(draggedHeight(box, box.y)).toBe(box.room);
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
  it("is on the left of a logo in the right half, a gap from its mark", () => {
    const logo = logoBox(null, [main], main);
    const size = { width: WAVE_WIDTH + 2 * PILL_MARGIN, height: 48 + 2 * PILL_MARGIN };
    const box = waveBox(logo, main.workArea, size);
    expect(box.side).toBe("left");
    // What is drawn ends `WAVE_GAP` before the mark begins.
    expect(box.x + size.width - PILL_MARGIN).toBe(logo.x + LOGO_MARGIN - WAVE_GAP);
    // And is centred on the logo's row.
    expect(box.y + size.height / 2).toBe(logo.y + LOGO / 2);
  });

  it("is on the right of a logo in the left half", () => {
    const logo = logoAt(30, 400);
    const size = { width: 200, height: 40 };
    const box = waveBox(logo, main.workArea, size);
    expect(box.side).toBe("right");
    expect(box.x + PILL_MARGIN).toBe(logo.x + LOGO - LOGO_MARGIN + WAVE_GAP);
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
