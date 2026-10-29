/**
 * Cards popped out of their boards to float over the window as notes, and
 * where each one was left.
 *
 * It exists because a card is what the work is read from — the plan, the
 * list of what done means, the line somebody pasted in — and the board it
 * lives on is a pane or a sheet that is gone the moment the person turns to
 * the agent the card is about. A note is that card kept in sight over
 * whatever is on screen: every workspace, every board, every pane, the
 * profile's sheet. It is the card itself, drawn again from the snapshot, so
 * an edit from anywhere — the board, Kuru, an agent's run — is in the note
 * on the next message. Nothing about the card is kept here.
 *
 * **This device's, in `localStorage`, on the Needs drawer's terms**
 * (`needsorder.ts`). Where a note sits and how big it is are facts about one
 * screen: the Mac beside the panes and the phone at arm's length want
 * different notes in different places, and a note kept on the server would
 * be one more thing every client is sent and every client moves for the
 * others. So it is lost with the browser's storage, and nothing else is.
 * The `storage` event carries a change to every other page of this origin,
 * so two windows on one Mac keep one set.
 *
 * **Kept by the card's id, per profile key.** A card's id is random and
 * outlives a restart, where a workspace's id does not; and a card sent from
 * the profile's board to a workspace keeps it, so its note follows it there
 * (`locateCard`). The profile's `key` and not its id, for the same reason.
 * Another profile's notes wait under its key for it to be active again,
 * since its cards are not in this window's snapshot to draw.
 *
 * **A box in pixels, as left, fitted into the window when drawn.** The
 * floating pill keeps a share of the free room instead (`place.ts`), because
 * the pill changes size with what it says; a note's size is the person's,
 * and a note collapses to its title bar where it is, which a share of the
 * room would move as the height changed. So what is stored is the box last
 * left, and `fitNote` puts it inside the window at draw time without writing
 * back — a window made narrow and then wide again finds the note where it
 * was put.
 *
 * **A closed note is remembered too,** so the same card popped out again
 * comes back where it was — up to `NOTES_MAX` a profile, closed ones going
 * first. The list's order is the stacking order, the front last.
 */
import { useSyncExternalStore } from "react";
import type { Card } from "../../shared/board";
import type { Profile, Workspace } from "../../shared/model";
import type { MenuItem } from "./components/Menu";

/** A note's place and size in CSS pixels: its left and top edges in the window, and its width and height. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Note extends Box {
  cardId: string;
  /** Folded to its title bar, which is all of it that is drawn. */
  collapsed: boolean;
  /** Drawn. A closed note is kept for its place, for the next time the card is popped out. */
  open: boolean;
}

/** What a note is fitted into: the window, in CSS pixels. */
export interface Room {
  w: number;
  h: number;
}

/**
 * The smallest a note is drawn: its title bar, the column line, and three
 * or four lines of the card. Below that it is a title bar with a scroll
 * box nobody can read in, which is what collapsing is for.
 */
export const NOTE_MIN = { w: 220, h: 140 } as const;
/** A new note's size: a card's first paragraph or two, and its run. */
export const NOTE_SIZE = { w: 340, h: 280 } as const;
/**
 * A collapsed note's height, for fitting it into the window — the drawing
 * takes its own from the title bar. Near enough matters only at the
 * bottom edge, where a few pixels of bar under the edge would still hold.
 */
export const NOTE_HEAD = 36;
/** Notes remembered per profile, open and closed. More than anybody keeps open; the closed ones are the ones dropped. */
export const NOTES_MAX = 40;
/** How far each new note sits from the one before, so a second is never exactly on top of the first. */
const CASCADE = 28;

/** The eight handles a note is resized by: its four edges and four corners. */
export type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export const EDGES: readonly Edge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

/** `value` held between `low` and `high`, `high` winning where the two cross — a room smaller than the floor. */
function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * The box a note is drawn at: no smaller than `NOTE_MIN` unless the window
 * is, no bigger than the window, and wholly inside it. A collapsed note is
 * fitted by its title bar, so one can sit on the bottom edge; opened again,
 * it is fitted whole, and goes up as far as it must.
 */
export function fitNote(box: Box, room: Room, collapsed = false): Box {
  const w = clamp(box.w, NOTE_MIN.w, room.w);
  const h = clamp(box.h, NOTE_MIN.h, room.h);
  const drawn = collapsed ? Math.min(NOTE_HEAD, room.h) : h;
  return {
    x: clamp(box.x, 0, Math.max(0, room.w - w)),
    y: clamp(box.y, 0, Math.max(0, room.h - drawn)),
    w,
    h,
  };
}

/** A note dragged by its title bar from `start` — the box as drawn when the drag began — held inside the window. */
export function moveBox(start: Box, dx: number, dy: number, room: Room, collapsed = false): Box {
  return fitNote({ ...start, x: start.x + dx, y: start.y + dy }, room, collapsed);
}

/**
 * A note resized by one of its handles from `start`, the box as drawn when
 * the drag began. The edge opposite the handle stays where it is: a left
 * edge dragged in past the floor stops at it rather than pushing the note
 * right, and no edge goes past the window's.
 */
export function resizeBox(start: Box, edge: Edge, dx: number, dy: number, room: Room): Box {
  let { x, y, w, h } = start;
  const right = start.x + start.w;
  const bottom = start.y + start.h;
  if (edge.includes("e")) w = clamp(start.w + dx, NOTE_MIN.w, room.w - start.x);
  if (edge.includes("s")) h = clamp(start.h + dy, NOTE_MIN.h, room.h - start.y);
  if (edge.includes("w")) {
    x = clamp(start.x + dx, 0, right - NOTE_MIN.w);
    w = right - x;
  }
  if (edge.includes("n")) {
    y = clamp(start.y + dy, 0, bottom - NOTE_MIN.h);
    h = bottom - y;
  }
  return { x, y, w, h };
}

/**
 * The profile's board's height at most (`.profile-board`), which a new
 * note is placed below the header of: the sheet is centred, so its ✕ is
 * at the top right of the window's middle, which is where a note popped
 * out of it would otherwise land on it.
 */
const SHEET_H = 760;

/**
 * Where a card popped out for the first time goes: the right of the
 * window, just under the profile board's header (`SHEET_H`) and never
 * higher than the window's top band, each open note one step down and
 * left of the last so none hides another. The right because the board is
 * usually on the left of what is being worked on.
 */
function cascade(notes: readonly Note[], room: Room): Box {
  const step = notes.filter((note) => note.open).length % 8;
  const top = Math.max(64, Math.round((room.h - SHEET_H) / 2 + 50));
  return fitNote(
    {
      x: room.w - NOTE_SIZE.w - 32 - step * CASCADE,
      y: top + step * CASCADE,
      w: NOTE_SIZE.w,
      h: NOTE_SIZE.h,
    },
    room,
  );
}

/**
 * The card popped out: its note open, unfolded and in front — where it was
 * last left, if it has had one, and otherwise the next place along.
 * Popping out a card that is already a note brings that note forward, which
 * is what the person wanted: to see it.
 */
export function popOut(notes: readonly Note[], cardId: string, room: Room): Note[] {
  const had = notes.find((note) => note.cardId === cardId);
  const note: Note = had
    ? { ...had, open: true, collapsed: false }
    : { cardId, ...cascade(notes, room), collapsed: false, open: true };
  return trim([...notes.filter((one) => one.cardId !== cardId), note]);
}

/** The note in front of the others. The same list when it already is, so a click on the front note writes nothing. */
export function raise(notes: readonly Note[], cardId: string): readonly Note[] {
  const index = notes.findIndex((note) => note.cardId === cardId);
  if (index < 0 || index === notes.length - 1) return notes;
  return [...notes.slice(0, index), ...notes.slice(index + 1), notes[index]!];
}

/** One note changed by `fn`, the rest as they were. */
export function change(notes: readonly Note[], cardId: string, fn: (note: Note) => Note): Note[] {
  return trim(notes.map((note) => (note.cardId === cardId ? fn(note) : note)));
}

/**
 * The list held to `NOTES_MAX`, closed notes going first and, of them, the
 * ones furthest back — the stack is the order, so those are the notes that
 * went longest without being in front.
 */
function trim(notes: Note[]): Note[] {
  let over = notes.length - NOTES_MAX;
  if (over <= 0) return notes;
  return notes.filter((note) => note.open || over-- <= 0);
}

/**
 * The card a note is of, and the workspace whose board it is on — null for
 * the profile's own board. Looked for everywhere in the profile, since a
 * card keeps its id when it is sent from the profile's board to a
 * workspace's, and a note of it should go with it. Null for a card that is
 * no longer in the profile: deleted, or gone with its workspace to
 * another node.
 */
export function locateCard(profile: Profile, cardId: string): { card: Card; workspace: Workspace | null } | null {
  const own = profile.board.cards.find((card) => card.id === cardId);
  if (own) return { card: own, workspace: null };
  for (const workspace of profile.workspaces) {
    const card = workspace.board?.cards.find((c) => c.id === cardId);
    if (card) return { card, workspace };
  }
  return null;
}

/**
 * The notes as `localStorage` held them, which is a string anybody could
 * have edited: a profile's list that is not a list is none, a note with no
 * card or a number that is not finite is dropped rather than drawn
 * somewhere NaN puts it, and a card listed twice keeps its later entry.
 * Out-of-window numbers are kept; `fitNote` is what puts them in.
 */
export function adoptNotes(raw: string | null): Record<string, Note[]> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: Record<string, Note[]> = {};
  for (const [profileKey, list] of Object.entries(parsed)) {
    if (!Array.isArray(list)) continue;
    const notes = new Map<string, Note>();
    for (const item of list) {
      const note = adoptNote(item);
      if (!note) continue;
      notes.delete(note.cardId);
      notes.set(note.cardId, note);
    }
    if (notes.size) out[profileKey] = trim([...notes.values()]);
  }
  return out;
}

function adoptNote(value: unknown): Note | null {
  if (typeof value !== "object" || value === null) return null;
  const { cardId, x, y, w, h, collapsed, open } = value as Record<string, unknown>;
  if (typeof cardId !== "string" || !cardId) return null;
  const numbers = [x, y, w, h];
  if (!numbers.every((n): n is number => typeof n === "number" && Number.isFinite(n))) return null;
  return {
    cardId,
    x: x as number,
    y: y as number,
    w: w as number,
    h: h as number,
    collapsed: collapsed === true,
    open: open !== false,
  };
}

// ---------------------------------------------------------------------------
// The store: this device's notes, one list per profile key.

const NOTES_KEY = "kururu.notes";

let all: Record<string, Note[]> | null = null;
const listeners = new Set<() => void>();
const NONE: readonly Note[] = [];

/** Storage can throw — a private window, blocked site data — and then there are no notes until one is popped out. */
function read(): Record<string, Note[]> {
  if (all) return all;
  try {
    all = adoptNotes(localStorage.getItem(NOTES_KEY));
  } catch {
    all = {};
  }
  return all;
}

function write(profileKey: string, notes: readonly Note[]): void {
  const was = read();
  if (was[profileKey] === notes) return;
  const { [profileKey]: _old, ...rest } = was;
  all = notes.length ? { ...rest, [profileKey]: [...notes] } : rest;
  try {
    localStorage.setItem(NOTES_KEY, JSON.stringify(all));
  } catch {
    // Not remembered; still drawn so until the page goes.
  }
  for (const listener of listeners) listener();
}

/** Another page of this origin wrote the notes: read them again. */
function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== NOTES_KEY) return;
  all = null;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== "undefined") window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

/** This device's notes for one profile, open and closed, in stacking order. */
export function useNotes(profileKey: string): readonly Note[] {
  return useSyncExternalStore(subscribe, () => read()[profileKey] ?? NONE);
}

/** Change one profile's notes. */
export function updateNotes(profileKey: string, fn: (notes: readonly Note[]) => readonly Note[]): void {
  write(profileKey, fn(read()[profileKey] ?? NONE));
}

/**
 * The profile whose notes are on screen — set by the layer that draws them
 * (`Notes.tsx`), so a card's menu can pop one out without being handed the
 * profile: a workspace's board is drawn in a pane, which knows its
 * workspace and not whose it is.
 */
let here: string | null = null;
export function notesProfile(profileKey: string | null): void {
  here = profileKey;
}

/** The window's size, which a new note is placed in. */
export function windowRoom(): Room {
  return { w: window.innerWidth, h: window.innerHeight };
}

/** Pop a card out as a note of the profile on screen — see `popOut`. */
export function popOutNote(cardId: string): void {
  if (here === null) return;
  const room = windowRoom();
  updateNotes(here, (notes) => popOut(notes, cardId, room));
}

/** Whether a card of the profile on screen is a note that is open now — which its menu says. */
export function noteOpen(cardId: string): boolean {
  return here !== null && (read()[here] ?? NONE).some((note) => note.cardId === cardId && note.open);
}

/**
 * The row on a card's menu that pops it out — one builder for the profile's
 * board, a workspace's board and the Needs drawer, so the menus say it the
 * same way, as `referItem` is for Kuru. A card that is a note already has
 * its note brought forward, and the row says so.
 */
export function noteItem(cardId: string): MenuItem {
  return {
    label: noteOpen(cardId) ? "Bring its note forward" : "Pop out as a note",
    run: () => popOutNote(cardId),
  };
}
