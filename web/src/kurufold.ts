/**
 * Which lines of Kuru's drawer are folded to one row, on this device.
 *
 * A conversation with Kuru is a few long answers among many short ones — a
 * status of six agents, a plan, a list of what changed — and once a long
 * one is read it is in the way of everything after it, for as long as the
 * drawer holds it. Folding it leaves who said it, when, and its first line,
 * which is enough to find it again, and a click puts the rest back.
 *
 * **This device's, in `localStorage`, on the draft's terms.** It is how this
 * screen is read, not something that happened in the conversation: the
 * phone at arm's length and the Mac beside the panes want different lines
 * open, and a fold kept on the server would be one more thing every client
 * is sent. So it is lost with the browser's storage, and nothing else is.
 *
 * **Kept by the name a line keeps.** A line's id is not one: a message of
 * yours is its outbox id until Kuru takes it and a turn's `t12` afterwards,
 * and the outbox forgets it a while later, so the turn's id is the key and
 * the outbox's is only looked under as well (`foldKeys`). A reply of Kuru's
 * that was spoken is known by its utterance, which the turn keeps for good,
 * since it may be the missed list's `m…` before it is a turn. Another node's
 * lines keep the `<node id>/` the merge put in front, so two nodes' `t12`
 * are two lines.
 *
 * **Only what differs from the default is written down.** Unfolded is the
 * default, so the list is the folded lines; with "Fold long messages" on, a
 * long line is folded until it is opened, and the opening is what is kept.
 * The list keeps the newest `FOLDS_MAX`, so it cannot grow without end.
 *
 * kururu's notices are not here: they are one line already, with the whole
 * message behind a tap that keeps no state (`Notice` in `KuruDrawer.tsx`).
 */
import { useSyncExternalStore } from "react";
import type { KuruItem, NodeKuruItem } from "../../shared/kuru";

/** Folds and openings, newest last: `true` folded, `false` opened against the default. */
export type Folds = ReadonlyMap<string, boolean>;

/** How many choices are remembered. A busy month of Kuru, folded line by line, and a few pages of "fold all" besides. */
export const FOLDS_MAX = 2000;

/** How long a line has to be for "Fold long messages" to start it folded: about a phone's half screen. */
export const LONG_ROWS = 15;

/** Roughly what the drawer fits on a row at its usual width, for counting the rows a paragraph wraps to. */
const ROW_CHARS = 60;

const FOLDS_KEY = "kururu.kuru.folds";
const FOLD_LONG_KEY = "kururu.kuru.foldLong";

/** The words a line folds, or null for one with nothing to fold: a notice, a session's mark, a clip not yet in words. */
export function foldText(item: KuruItem): string | null {
  if (item.kind === "kuru") return item.text;
  if (item.kind === "you") return item.text;
  return null;
}

/**
 * The names a line's fold is kept under, the one written first: see the
 * header. A message of yours still on its way is its outbox id, which is
 * then the second name of the turn it becomes, so a fold made while it
 * waited for Kuru survives Kuru taking it.
 */
export function foldKeys(item: NodeKuruItem): string[] {
  const slash = item.node === null ? -1 : item.id.indexOf("/");
  const node = item.id.slice(0, slash + 1);
  if (item.kind === "kuru" && item.utterance) return [`${node}m${item.utterance}`];
  if (item.kind === "you" && item.outboxId && item.outboxId !== item.id.slice(slash + 1)) return [item.id, node + item.outboxId];
  return [item.id];
}

/** Whether a line is folded: the first of its names written down, or the default. */
export function isFolded(folds: Folds, keys: readonly string[], byDefault: boolean): boolean {
  for (const key of keys) {
    const folded = folds.get(key);
    if (folded !== undefined) return folded;
  }
  return byDefault;
}

/**
 * The list with one line's choice in it, newest: written under its first
 * name when it differs from the default and taken off when it does not, and
 * its other names taken off either way, so an old outbox id cannot outvote it.
 */
export function withFold(folds: Folds, keys: readonly string[], folded: boolean, byDefault: boolean): Map<string, boolean> {
  return withFolds(folds, [{ keys, byDefault }], folded);
}

/** Many lines given the same choice at once — "fold all" — on `withFold`'s terms, in one copy of the list rather than one each. */
export function withFolds(folds: Folds, lines: readonly { keys: readonly string[]; byDefault: boolean }[], folded: boolean): Map<string, boolean> {
  const next = new Map(folds);
  for (const { keys, byDefault } of lines) {
    for (const key of keys) next.delete(key);
    if (folded !== byDefault && keys[0] !== undefined) next.set(keys[0], folded);
  }
  return trim(next);
}

function trim(folds: Map<string, boolean>): Map<string, boolean> {
  if (folds.size <= FOLDS_MAX) return folds;
  return new Map([...folds].slice(folds.size - FOLDS_MAX));
}

/**
 * Whether a line is long enough for "Fold long messages" to start it folded:
 * the rows it takes in the drawer, a paragraph counted as the rows it wraps
 * to, so a wall of one paragraph and a column of short lines are judged alike.
 */
export function isLong(text: string): boolean {
  let rows = 0;
  for (const line of text.split("\n")) {
    rows += Math.max(1, Math.ceil(line.length / ROW_CHARS));
    if (rows > LONG_ROWS) return true;
  }
  return false;
}

/** What a folded line shows of its words: the first that are not blank, and whether there is more after them. */
export function firstLine(text: string): { line: string; more: boolean } {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.trim() !== "");
  if (at < 0) return { line: "", more: false };
  return { line: lines[at]!.trim(), more: lines.slice(at + 1).some((line) => line.trim() !== "") };
}

/**
 * The list as `localStorage` held it, which is a string anybody could have
 * edited: pairs of a name and a boolean, and anything else dropped, the
 * newest `FOLDS_MAX` kept.
 */
export function parseFolds(raw: string | null): Map<string, boolean> {
  const folds = new Map<string, boolean>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? "[]");
  } catch {
    return folds;
  }
  if (!Array.isArray(parsed)) return folds;
  for (const pair of parsed) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const [key, folded] = pair as unknown[];
    if (typeof key !== "string" || key === "" || typeof folded !== "boolean") continue;
    folds.delete(key);
    folds.set(key, folded);
  }
  return trim(folds);
}

/** Pairs rather than an object, because an object puts a name that reads as a number first, and the order is what the trim keeps by. */
export function serializeFolds(folds: Folds): string {
  return JSON.stringify([...folds]);
}

export function readFolds(): Map<string, boolean> {
  try {
    return parseFolds(localStorage.getItem(FOLDS_KEY));
  } catch {
    return new Map();
  }
}

export function writeFolds(folds: Folds): void {
  try {
    if (folds.size) localStorage.setItem(FOLDS_KEY, serializeFolds(folds));
    else localStorage.removeItem(FOLDS_KEY);
  } catch {
    // Not remembered past this window; the folds still hold while it is open.
  }
}

/**
 * "Fold long messages", Settings → Voice's one switch for this device, off
 * unless it was put on here. Module state with listeners, because Settings
 * flips it while the drawer is open beside it, and the drawer has to hear.
 */
let foldLong: boolean | null = null;
const listeners = new Set<() => void>();

function foldLongNow(): boolean {
  if (foldLong === null) {
    try {
      foldLong = localStorage.getItem(FOLD_LONG_KEY) === "1";
    } catch {
      foldLong = false;
    }
  }
  return foldLong;
}

export function useFoldLong(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    foldLongNow,
  );
}

export function setFoldLong(on: boolean): void {
  foldLong = on;
  try {
    if (on) localStorage.setItem(FOLD_LONG_KEY, "1");
    else localStorage.removeItem(FOLD_LONG_KEY);
  } catch {
    // On for this window only.
  }
  for (const listener of listeners) listener();
}
