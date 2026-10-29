/**
 * The cards popped out as windows of their own, as data: which ones, where
 * each was left on the screen, and whether it is up, put away from the menu
 * bar, or closed and kept only for where it was.
 *
 * It is apart from `notes.js`, which holds the windows, for `menu.js`'s
 * reason: a record read back off the disk and a box put on a display are
 * arithmetic, and arithmetic is testable when it knows nothing about
 * Electron. A display here is what `screen` lists — an id and a work area —
 * and nothing else is asked of it.
 *
 * **Points on the screen, not a share of a display.** The floating pill
 * keeps a share (`talkkey.js`), because the pill changes size with what it
 * says and a pixel spot is nonsense once its display is unplugged. A note is
 * the size somebody dragged it to, and is put back exactly there; what makes
 * an unplugged display survivable is `fitOnScreen`, which moves a note whose
 * display has gone onto the one it overlaps most, or the nearest, whole.
 *
 * **A closed note is kept too,** so the same card popped out again comes
 * back where it was, as the window's notes do (`web/src/notes.ts`) — up to
 * `NOTES_MAX`, the closed ones furthest back going first. The list's order is
 * the order they were last brought forward, the front last.
 */

/** The smallest a note window is: its title bar, the column line, three or four lines of the card. `web/src/notes.ts`'s `NOTE_MIN`. */
const NOTE_MIN = { width: 220, height: 140 };
/** A new note's size, as in the window. */
const NOTE_SIZE = { width: 340, height: 280 };
/** A folded note's height until its page says what its title bar measures. */
const NOTE_HEAD = 36;
/** Notes remembered, up, away and closed. */
const NOTES_MAX = 40;
/**
 * Notes up at once. Each is a page and a socket of its own, and past this
 * the oldest is put away — still in the menu bar's list, a click from up
 * again — rather than the new one refused.
 */
const OPEN_MAX = 12;
/** How far each new note sits from the one before, so a second is never exactly on top of the first. */
const CASCADE = 28;
/** In from the right edge of whatever a new note is placed against. */
const INSET = 32;

const STATES = ["shown", "hidden", "closed"];

/** A card's id, as the server makes them; anything else off the disk is not a card. */
function isCardId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
}

function short(value, max) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/**
 * One note as `desktop.json` held it, which anybody could have edited: a
 * record with no card or a box that is not four finite numbers is dropped
 * rather than drawn somewhere NaN puts it, and a size under the floor is
 * raised to it.
 */
function adoptNote(value) {
  if (!value || typeof value !== "object") return null;
  const r = value;
  if (!isCardId(r.cardId) || typeof r.profileKey !== "string" || !r.profileKey) return null;
  const box = [r.x, r.y, r.width, r.height];
  if (!box.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return {
    cardId: r.cardId,
    profileKey: short(r.profileKey, 64),
    profileName: short(r.profileName, 80),
    title: short(r.title, 200),
    code: short(r.code, 40),
    x: Math.round(r.x),
    y: Math.round(r.y),
    width: Math.max(NOTE_MIN.width, Math.round(r.width)),
    height: Math.max(NOTE_MIN.height, Math.round(r.height)),
    collapsed: r.collapsed === true,
    state: STATES.includes(r.state) ? r.state : "shown",
  };
}

/** The notes off the disk, checked: not a list is none, and a card listed twice keeps its later record. */
function adoptNotes(raw) {
  if (!Array.isArray(raw)) return [];
  const byCard = new Map();
  for (const item of raw) {
    const note = adoptNote(item);
    if (!note) continue;
    byCard.delete(note.cardId);
    byCard.set(note.cardId, note);
  }
  return trimNotes([...byCard.values()]);
}

/** The list held to `NOTES_MAX`, closed notes going first and, of them, the ones furthest back. */
function trimNotes(notes) {
  let over = notes.length - NOTES_MAX;
  if (over <= 0) return notes;
  return notes.filter((note) => note.state !== "closed" || over-- <= 0);
}

/** One note brought to the front of the list, changed by `patch`, the list trimmed. */
function bringForward(notes, cardId, patch = {}) {
  const had = notes.find((note) => note.cardId === cardId);
  if (!had) return notes;
  return trimNotes([...notes.filter((note) => note.cardId !== cardId), { ...had, ...patch }]);
}

/** One note changed by `patch` where it is in the list. */
function changeNote(notes, cardId, patch) {
  return notes.map((note) => (note.cardId === cardId ? { ...note, ...patch } : note));
}

/**
 * The up notes past `OPEN_MAX`, oldest first — the ones to put away so the
 * one just brought forward can be up.
 */
function overOpen(notes) {
  const up = notes.filter((note) => note.state === "shown");
  return up.slice(0, Math.max(0, up.length - OPEN_MAX)).map((note) => note.cardId);
}

function clamp(value, low, high) {
  return Math.min(Math.max(value, low), high);
}

function overlap(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function distance(a, b) {
  const ax = a.x + a.width / 2;
  const ay = a.y + a.height / 2;
  const bx = b.x + b.width / 2;
  const by = b.y + b.height / 2;
  return Math.hypot(ax - bx, ay - by);
}

/**
 * The work area a box belongs on: the display it overlaps most, or — on
 * none, which is a note left on a monitor that is gone — the nearest.
 */
function displayFor(bounds, displays) {
  let best = null;
  let most = 0;
  for (const display of displays) {
    const area = overlap(bounds, display.workArea);
    if (area > most) {
      most = area;
      best = display;
    }
  }
  if (best) return best;
  let near = null;
  let nearest = Infinity;
  for (const display of displays) {
    const d = distance(bounds, display.workArea);
    if (d < nearest) {
      nearest = d;
      near = display;
    }
  }
  return near;
}

/**
 * The box a note window is put at: wholly inside the work area of the
 * display it belongs on, and no bigger than it — the menu bar and the Dock
 * are never over its title bar, which is the only thing it is moved by.
 * Unchanged when there are no displays to ask.
 */
function fitOnScreen(bounds, displays) {
  const display = displayFor(bounds, displays);
  if (!display) return { ...bounds };
  const area = display.workArea;
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  return {
    x: Math.round(clamp(bounds.x, area.x, area.x + area.width - width)),
    y: Math.round(clamp(bounds.y, area.y, area.y + area.height - height)),
    width: Math.round(width),
    height: Math.round(height),
  };
}

/**
 * Where a card popped out for the first time goes: the right of `anchor` —
 * the window it was popped out of, or the work area of the display the
 * pointer is on when it came from the menu bar — `top` points down, each up
 * note one step down and left of the last so none hides another.
 */
function cascade(anchor, upCount, top) {
  const step = upCount % 8;
  return {
    x: Math.round(anchor.x + anchor.width - NOTE_SIZE.width - INSET - step * CASCADE),
    y: Math.round(anchor.y + top + step * CASCADE),
    width: NOTE_SIZE.width,
    height: NOTE_SIZE.height,
  };
}

/**
 * A box in a window's page, in its CSS pixels, as a box on the screen: the
 * window's own note handed over, which goes up as a window exactly where it
 * was drawn. Null for anything that is not four finite numbers.
 */
function boxOnScreen(box, content) {
  if (!box || typeof box !== "object") return null;
  const { x, y, w, h } = box;
  if (![x, y, w, h].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return {
    x: Math.round(content.x + x),
    y: Math.round(content.y + y),
    width: Math.max(NOTE_MIN.width, Math.round(w)),
    height: Math.max(NOTE_MIN.height, Math.round(h)),
  };
}

module.exports = {
  CASCADE,
  NOTE_HEAD,
  NOTE_MIN,
  NOTE_SIZE,
  NOTES_MAX,
  OPEN_MAX,
  adoptNotes,
  boxOnScreen,
  bringForward,
  cascade,
  changeNote,
  fitOnScreen,
  isCardId,
  overOpen,
  trimNotes,
};
