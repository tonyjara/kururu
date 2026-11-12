/**
 * The marks folder, as kururu keeps it and as Kuru is told about it.
 *
 * A set of marks is the user pointing at things and saying what is wrong
 * with them. Today the screen pen makes every set (`shared/ink.ts`,
 * docs/plans/screen-annotate.md); the built-in browser made the first ones
 * and was removed on 2026-11-07 (docs/plans/browser-annotate.md, kept on the
 * `browser-annotate` branch). The window posts a set to `POST /api/marks`,
 * the server writes it to a folder (`server/src/marks.ts`), and Kuru's box
 * is given a header line naming the folder and a line per mark, which
 * `shared/chips.ts` draws as chips.
 *
 * This file is what every set shares whoever made it: the caps, what is
 * taken out of somebody else's words before anything is written, how those
 * words are quoted on a line, the names a set's folder and files may have,
 * and the rule that sweeps a set after about thirty days. Pure, so all of it
 * is tested as text.
 *
 * **Whose words are whose.** A label is made of somebody else's words — a
 * window's title, a control's name — and those can say "ignore your
 * instructions" as easily as "Pay now". So they are cut short and quoted on
 * the line, and fenced and labelled in `marks.md`; the user's own words are
 * the one free text.
 */

import { withoutBidi } from "./bidi";

/**
 * The version `marks.json` carries, for whoever reads it next. 2 added
 * `kind`: a set of marks on a page (the browser's, from before its removal),
 * or on the screen (`shared/ink.ts`). A set written before it has no `kind`
 * and is a page's (`setKindOf`).
 */
export const MARKS_VERSION = 2;

/** The most marks one set may hold: Orca's rule, and a message that still reads as one. */
export const MARKS_MAX = 20;

/** How long a set is kept after its newest file was written. */
export const MARKS_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/** The most a posted set may be, pictures included: twenty crops and twenty displays. */
export const MARKS_MAX_BYTES = 64 * 1024 * 1024;

/** How much of somebody else's words a label carries. */
export const LABEL_WORDS_MAX = 48;

/** A box, in points or CSS pixels as the set says. */
export interface MarkBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// What is taken out
// ---------------------------------------------------------------------------

/**
 * Secrets by their look, Orca's list and a few more: a bearer or basic
 * header, a JWT, the shapes of the big providers' keys, a private key block,
 * and `key = value` where the key's name says it is a secret. Each is
 * replaced by `[redacted]`; what is around it stays, so a mark on an error
 * message that quoted a token still says which error.
 */
const SECRETS: readonly RegExp[] = [
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
  /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant|or)?[-_]?[A-Za-z0-9_-]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b((?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd|token)["']?\s*[:=]\s*["']?)[^\s"'&<>,;]{4,}/gi,
];

export const REDACTED = "[redacted]";

/** Text with anything that looks like a secret taken out. */
export function redact(text: string): string {
  let out = text;
  for (const pattern of SECRETS) {
    out = out.replace(pattern, (match, keep?: unknown) => (typeof keep === "string" && match.startsWith(keep) ? `${keep}${REDACTED}` : REDACTED));
  }
  return out;
}

// ---------------------------------------------------------------------------
// The lines Kuru reads
// ---------------------------------------------------------------------------

/**
 * Somebody else's words as a label quotes them: on one line, a `"` as `'`
 * and a bracket as a parenthesis — so nothing they say can close the quote
 * or the line's bracket early — with no bidi control in them (WhatsApp's
 * window title begins with one, see `shared/bidi.ts`), and cut at a word
 * with `…`.
 */
export function labelWords(text: string, max = LABEL_WORDS_MAX): string {
  const flat = withoutBidi(text).replace(/\s+/g, " ").replace(/"/g, "'").replace(/\[/g, "(").replace(/\]/g, ")").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:…]+$/, "")}…`;
}

// ---------------------------------------------------------------------------
// The folder, and its sweep
// ---------------------------------------------------------------------------

/** A set's id: `m` and twelve hex digits, minted by the server and nothing else. */
const SET_ID = /^m[0-9a-f]{12}$/;

export function isMarkSetId(name: string): boolean {
  return SET_ID.test(name);
}

/**
 * The files a set may hold, by name: what a GET may ask for and nothing else.
 * A screen set's whole displays are JPEGs; `view.png` is a browser set's, still
 * served until the last of them is swept.
 */
export function isMarkFile(name: string): boolean {
  return name === "marks.md" || name === "marks.json" || name === "view.png" || /^mark-(?:[1-9]|1\d|20)\.png$/.test(name) || /^frame-(?:[1-9]|1\d|20)\.jpg$/.test(name);
}

/** What a `marks.json` is a set of: a page's, unless it says the screen — a set from before version 2 says nothing and is a page's. */
export function setKindOf(record: unknown): "page" | "screen" {
  return typeof record === "object" && record !== null && (record as { kind?: unknown }).kind === "screen" ? "screen" : "page";
}

/** What the sweep knows of one entry of `marks/`, read with `lstat`. */
export interface MarkEntry {
  name: string;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  /** The newest modification time among the directory and its files, in ms. */
  newestMs: number;
}

/**
 * Whether the sweep removes an entry of `marks/`: a real directory — never a
 * link, followed or not — named as a set the server would have made, whose
 * newest file is more than `MARKS_KEEP_MS` old. Anything else is somebody
 * else's and is left alone.
 */
export function sweepable(entry: MarkEntry, now: number, keepMs = MARKS_KEEP_MS): boolean {
  if (!isMarkSetId(entry.name) || entry.isSymbolicLink || !entry.isDirectory) return false;
  if (!Number.isFinite(entry.newestMs) || !Number.isFinite(now)) return false;
  return now - entry.newestMs > keepMs;
}
