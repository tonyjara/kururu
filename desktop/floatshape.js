/**
 * The floating Kuru as arithmetic: where its logo is put, which way its chat
 * opens, and where the voice's waveform sits beside it.
 *
 * It is apart from `float.js`, which holds the windows, for `notelist.js`'s
 * reason: a place read back off the disk and a box put on a display are
 * sums, and sums are testable when they know nothing about Electron. A
 * display here is what `screen` lists — an id and a work area — and nothing
 * else is asked of it.
 *
 * **Everything hangs off the logo.** The logo is the one thing the person
 * puts somewhere; the chat and the waveform are placed against it every time
 * they are shown, never remembered on their own, so neither can be left
 * behind on a monitor that went or drift away from the thing they belong to.
 * The chat opens above or below the logo, whichever side has the room, with
 * its outer edge on the logo's; the waveform sits in the logo's own row,
 * towards the middle of the display — which is the side the chat extends to
 * as well, so with the chat open the row reads as one bar along its edge,
 * the waveform ending at the logo.
 *
 * **The logo's place is a share of a display,** on the pill's reasoning
 * (`talkkey.js`): a pixel is nonsense the moment its display is unplugged,
 * where a share of any display is a real spot on it.
 */

/**
 * The logo's window: a 48 px mark with clear room around it. The room is for
 * what is drawn outside the mark — its ring and the pulse of it, the count on
 * its corner, the shadow under it, the mark a size up under the pointer —
 * and it was 8 px at first, which the shadow alone (3 px down, 7 of blur)
 * went past: the owner saw the mark's foot and its count cut off at the
 * window's edge (2026-11-10). Sixteen clears all of it with room over.
 */
const LOGO = 80;
/** That room, on every side. What is drawn is `LOGO - 2 * LOGO_MARGIN` across. */
const LOGO_MARGIN = 16;
/** Between the logo's mark and the chat, and between the mark and the waveform. */
const GAP = 8;
const WAVE_GAP = 6;
/** How far in from the corner of its display the window of a logo that was never dragged sits; the mark is `LOGO_MARGIN` further in. */
const HOME_INSET = 12;

/**
 * The chat's width: what Kuru's drawer starts at in the window, the least the
 * drawer is ever dragged to there (`DRAWER_MIN` in `App.tsx`), and a ceiling —
 * it is a pop-up beside a logo, not a second window, and past this the
 * conversation's own measure leaves it mostly gutter.
 */
const PANEL_WIDTH = 420;
const PANEL_WIDTH_MIN = 320;
const PANEL_WIDTH_MAX = 960;
/** A new chat's height, the floor a drag is held to — a header, a few lines and the box — and the least it is ever shown at. */
const PANEL_HEIGHT = 520;
const PANEL_MIN = 260;
const PANEL_FLOOR = 160;

/** The waveform beside a logo whose chat is shut, as the pill's page draws it; with the chat open it runs the chat's width. */
const WAVE_WIDTH = 132;
/** The room the pill's page keeps around what it draws (`.pill-page-root`'s padding, and `PANEL_MARGIN` in `talkkey.js`). */
const PILL_MARGIN = 8;

function clamp(value, low, high) {
  return Math.min(Math.max(value, low), high);
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * What `desktop.json` holds of the floating Kuru, read as if off the wire:
 * whether it is on, where its logo was left, and how tall and how wide its
 * chat was dragged. Anything that is not what it should be is its default,
 * never a throw — and a size is checked with `finite` before it is clamped,
 * since NaN loses every comparison a clamp makes.
 */
function adoptFloat(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    on: r.on === true,
    place: adoptPlace(r.place),
    height: finite(r.height) ? Math.round(clamp(r.height, PANEL_MIN, 4000)) : PANEL_HEIGHT,
    width: finite(r.width) ? Math.round(clamp(r.width, PANEL_WIDTH_MIN, PANEL_WIDTH_MAX)) : PANEL_WIDTH,
  };
}

/** A saved place, or null: a display's id and a share of it on each axis. */
function adoptPlace(raw) {
  if (!raw || typeof raw !== "object") return null;
  const { displayId, x, y } = raw;
  if (!finite(displayId) || !finite(x) || !finite(y)) return null;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { displayId, x, y };
}

/** How far along `free` pixels `at` is, 0–1; with no room to move in, the middle. */
function share(at, free) {
  if (!(free > 0) || !finite(at)) return 0.5;
  return clamp(at / free, 0, 1);
}

/** The place a logo at `bounds` on `display` is remembered as. */
function placeOf(bounds, display) {
  const area = display.workArea;
  return {
    displayId: display.id,
    x: share(bounds.x - area.x, area.width - bounds.width),
    y: share(bounds.y - area.y, area.height - bounds.height),
  };
}

/**
 * Where the logo goes: the share it was left at, on the display it was left
 * on while that display is there, and on `home` when it is not — and for a
 * logo that was never dragged, the bottom right corner of `home`, where a
 * page's chat bubble is looked for. Always wholly inside the work area.
 */
function logoBox(place, displays, home) {
  const pinned = place ? displays.find((d) => d.id === place.displayId) : undefined;
  const display = pinned ?? home ?? displays[0];
  if (!display) return { x: 0, y: 0, width: LOGO, height: LOGO, displayId: null };
  const area = display.workArea;
  const freeX = Math.max(0, area.width - LOGO);
  const freeY = Math.max(0, area.height - LOGO);
  const x = place ? area.x + place.x * freeX : area.x + freeX - HOME_INSET;
  const y = place ? area.y + place.y * freeY : area.y + freeY - HOME_INSET;
  return {
    x: Math.round(clamp(x, area.x, area.x + freeX)),
    y: Math.round(clamp(y, area.y, area.y + freeY)),
    width: LOGO,
    height: LOGO,
    displayId: display.id,
  };
}

/** A logo dragged to `x`, `y`, held inside the work area it is over: it cannot be dropped where it cannot be reached. */
function heldInside(x, y, area) {
  return {
    x: Math.round(clamp(x, area.x, area.x + Math.max(0, area.width - LOGO))),
    y: Math.round(clamp(y, area.y, area.y + Math.max(0, area.height - LOGO))),
  };
}

/** Which way things extend from the logo along its row: towards the middle of its display. */
function reach(logo, area) {
  return logo.x + logo.width / 2 > area.x + area.width / 2 ? "left" : "right";
}

/**
 * The chat's box against the logo: above it or below, whichever has more
 * room — so a logo in the lower half of its display opens upwards and one in
 * the upper half downwards — at the height and the width it was dragged to,
 * or as much of each as there is. Its outer edge is on the logo's mark, and
 * it extends the way `reach` says, held inside the work area.
 *
 * `side` is where the chat is from the logo, and `reach` which way it
 * extends; the two edges away from the logo, and the corner between them,
 * are what the page lets be dragged. `room` and `roomAcross` are the most
 * each drag may ask for: from the logo's side of the chat to the edge of the
 * work area.
 */
function panelBox(logo, area, wantedHeight, wantedWidth) {
  const top = logo.y + LOGO_MARGIN - GAP;
  const bottom = logo.y + logo.height - LOGO_MARGIN + GAP;
  const above = top - area.y;
  const below = area.y + area.height - bottom;
  const side = above >= below ? "above" : "below";
  const room = Math.max(PANEL_FLOOR, side === "above" ? above : below);
  const want = finite(wantedHeight) ? clamp(wantedHeight, PANEL_MIN, 4000) : PANEL_HEIGHT;
  const height = Math.round(Math.min(want, room));
  const way = reach(logo, area);
  // The logo's side of the chat, which stays; the chat runs from it towards the middle of the display.
  const anchor = way === "left" ? logo.x + logo.width - LOGO_MARGIN : logo.x + LOGO_MARGIN;
  const across = way === "left" ? anchor - area.x : area.x + area.width - anchor;
  // A logo dragged hard against the far side of a narrow display leaves less than the least width; the chat is then slid inside instead.
  const roomAcross = Math.min(PANEL_WIDTH_MAX, area.width, Math.max(PANEL_WIDTH_MIN, across));
  const wide = finite(wantedWidth) ? clamp(wantedWidth, PANEL_WIDTH_MIN, PANEL_WIDTH_MAX) : PANEL_WIDTH;
  const width = Math.round(Math.min(wide, roomAcross));
  const x = way === "left" ? anchor - width : anchor;
  return {
    x: Math.round(clamp(x, area.x, area.x + area.width - width)),
    y: Math.round(side === "above" ? top - height : bottom),
    width,
    height,
    side,
    reach: way,
    /** The tallest this side lets it be dragged, for the handle. */
    room: Math.round(room),
    /** And the widest. */
    roomAcross: Math.round(roomAcross),
  };
}

/**
 * The chat's height while its far edge is dragged to `pointerY`: the logo's
 * side of it stays where it is, so above the logo it is the top that follows
 * the pointer, and below it the bottom. Held between the floor and the room.
 */
function draggedHeight(box, pointerY) {
  const raw = box.side === "above" ? box.y + box.height - pointerY : pointerY - box.y;
  if (!finite(raw)) return box.height;
  return Math.round(clamp(raw, Math.min(PANEL_MIN, box.room), box.room));
}

/**
 * The same across: the edge away from the logo follows `pointerX` — the left
 * one of a chat that extends leftwards, the right one of one that extends
 * rightwards — between the least width and what the display has that way.
 */
function draggedWidth(box, pointerX) {
  const raw = box.reach === "left" ? box.x + box.width - pointerX : pointerX - box.x;
  if (!finite(raw)) return box.width;
  return Math.round(clamp(raw, Math.min(PANEL_WIDTH_MIN, box.roomAcross), box.roomAcross));
}

/**
 * How wide the waveform is drawn: beside a shut chat, its own width; along an
 * open one, the rest of the chat's width after the logo's mark.
 */
function waveWidth(panel) {
  if (!panel) return WAVE_WIDTH;
  return Math.max(WAVE_WIDTH, panel.width - (LOGO - 2 * LOGO_MARGIN) - WAVE_GAP);
}

/**
 * Where the pill's window goes while it is docked to the logo: in the logo's
 * row, centred on it, its drawn edge `WAVE_GAP` from the mark's, on the side
 * `reach` says. `size` is the window's, which is what it draws plus
 * `PILL_MARGIN` all round; the two windows' clear margins overlap, which is
 * what lets the gap be smaller than both.
 */
function waveBox(logo, area, size) {
  const way = reach(logo, area);
  const x =
    way === "left"
      ? logo.x + LOGO_MARGIN - WAVE_GAP + PILL_MARGIN - size.width
      : logo.x + logo.width - LOGO_MARGIN + WAVE_GAP - PILL_MARGIN;
  return {
    x: Math.round(x),
    y: Math.round(logo.y + (logo.height - size.height) / 2),
    side: way,
  };
}

module.exports = {
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
  adoptPlace,
  draggedHeight,
  draggedWidth,
  heldInside,
  logoBox,
  panelBox,
  placeOf,
  reach,
  waveBox,
  waveWidth,
};
