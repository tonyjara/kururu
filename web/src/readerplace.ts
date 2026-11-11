/**
 * Where you were in a document, kept for when you come back to it.
 *
 * The reader is not a pane that stays mounted. A strip switched from a document
 * to a terminal draws the terminal instead, and a strip switched between two
 * documents keeps one `ReaderView` and hands it another path; either way the
 * scroller that held the place is gone or about to be reused, and a reader that
 * kept nothing opened every document at its title. So the place lives here, per
 * document, and the view reads it back when it draws that document again — after
 * a tab switch, a document closed and opened again, or a window reload.
 *
 * **A place is a block and how far into it, never a pixel.** `scrollTop` is the
 * obvious thing to keep and is wrong the moment anything above the fold changes
 * height: the reader's zoom (`zoom.ts`) sets every size in `em`, a narrower pane
 * wraps every paragraph again, an image or a diagram arrives late, and each of
 * those moves a pixel offset to some other paragraph. The rendered blocks carry
 * the line they begin on (`data-line`, `server/src/markdown.ts`), so a place is
 * that line and the share of the way from its block's top to the next block's —
 * which is the same words at every zoom and every width, and is exact while the
 * file is the same file.
 *
 * **A file that changed is found by its heading.** Lines move when the file is
 * edited, so a place also remembers the heading above it, by its text and its
 * line, and how many lines below that heading it was. A document that is not the
 * one the place was taken in (`sig`, a hash of the markup) is entered at that
 * heading — the nearest of that name to where it was — and that many lines into
 * its section, never past the next heading; one whose heading is gone is entered
 * at the same fraction of its length. Either is a guess, and both are better
 * than the top, which is the one place the reader is sure you were not.
 *
 * Kept per device in `localStorage`, as the zoom is and for its reason: a phone
 * and a desktop reading the same file are two people's places, or one person's
 * at two sizes, and neither is the server's business. Kept per document rather
 * than per pane, so that the same file reopened in another pane opens where it
 * was left; two panes showing one file each hold their own place while they are
 * drawn, and the last one scrolled is the one remembered.
 *
 * The geometry is pure and takes a list of spans, so `web/test` can hold it to
 * the cases without a layout engine; `Reader.tsx` measures and applies.
 */

/** A block as the reader measured it: its line, its top within the scrolled content, and its text when it is a heading. */
export interface Span {
  line: number;
  top: number;
  heading: string | null;
}

/**
 * A place in one drawn document. `line` 0 is above the first block — the
 * article's own padding — and `nth` tells apart blocks that begin on one line,
 * a list and its first item, so the place is the same block coming back.
 * `within` is the share of the way to the next block further down.
 */
export interface Anchor {
  line: number;
  nth: number;
  within: number;
}

/** A place kept for a document: the anchor, and what finds it again when the file has changed. */
export interface Place extends Anchor {
  /** The heading at or above the anchor, null for none — the preamble. */
  heading: string | null;
  /** That heading's line, 0 for none. */
  headingLine: number;
  /** How far down the scrollable range it was, 0 to 1, for a document whose heading is gone. */
  fraction: number;
  /** The markup the place was taken in (`markupSig`). */
  sig: string;
  /** When, for dropping the oldest. */
  at: number;
}

/** The index of the first span on `line`, or -1. */
function firstOf(spans: readonly Span[], line: number): number {
  return spans.findIndex((span) => span.line === line);
}

/** The top of whatever comes after span `i`: the next span further down, or the end of the content. */
function nextTop(spans: readonly Span[], i: number, end: number): number {
  const top = spans[i]!.top;
  for (let j = i + 1; j < spans.length; j++) if (spans[j]!.top > top) return spans[j]!.top;
  return Math.max(end, top);
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/**
 * The place at `top`, or null at the very top — which is the default and not
 * worth keeping. `end` is the content's whole height.
 */
export function anchorAt(spans: readonly Span[], top: number, end: number): Anchor | null {
  if (!(top >= 1)) return null;
  let i = -1;
  for (let j = 0; j < spans.length; j++) {
    if (spans[j]!.top > top + 0.5) break;
    i = j;
  }
  if (i < 0) {
    const first = spans[0]?.top ?? end;
    return { line: 0, nth: 0, within: first > 0 ? clamp01(top / first) : 0 };
  }
  const span = spans[i]!;
  const next = nextTop(spans, i, end);
  return { line: span.line, nth: i - firstOf(spans, span.line), within: next > span.top ? clamp01((top - span.top) / (next - span.top)) : 0 };
}

/**
 * Where an anchor is in this drawing of the document. A line no block begins
 * on — an anchor from a document since edited — is the block above it.
 */
export function topOf(spans: readonly Span[], anchor: Anchor | null, end: number): number {
  if (!anchor) return 0;
  if (anchor.line === 0 || spans.length === 0) return clamp01(anchor.within) * (spans[0]?.top ?? 0);
  let i = firstOf(spans, anchor.line);
  if (i >= 0) {
    const want = i + Math.max(0, Math.floor(anchor.nth));
    while (i < want && spans[i + 1]?.line === anchor.line) i++;
  } else {
    for (let j = 0; j < spans.length; j++) if (spans[j]!.line < anchor.line) i = j;
    if (i < 0) return 0;
    return spans[i]!.top;
  }
  const span = spans[i]!;
  return span.top + clamp01(anchor.within) * (nextTop(spans, i, end) - span.top);
}

/** The heading a span at index `i` is under: its own when it is one. */
function headingAt(spans: readonly Span[], i: number): Span | null {
  for (let j = i; j >= 0; j--) if (spans[j]!.heading !== null) return spans[j]!;
  return null;
}

/** A place to keep, or null for the top of the file. `scrollable` is how far the reader can scroll. */
export function placeOf(spans: readonly Span[], top: number, end: number, scrollable: number, sig: string, at: number): Place | null {
  const anchor = anchorAt(spans, top, end);
  if (!anchor) return null;
  const i = anchor.line === 0 ? -1 : firstOf(spans, anchor.line) + anchor.nth;
  const heading = i >= 0 ? headingAt(spans, i) : null;
  return {
    ...anchor,
    heading: heading?.heading ?? null,
    headingLine: heading?.line ?? 0,
    fraction: scrollable > 0 ? clamp01(top / scrollable) : 0,
    sig,
    at,
  };
}

/**
 * The anchor a kept place comes to in the document as it is drawn now: itself
 * when the markup is the one it was taken in, else found by its heading, else
 * by its fraction. See the top of the file for why that order.
 */
export function resolvePlace(place: Place, spans: readonly Span[], sig: string, end: number, scrollable: number): Anchor | null {
  if (place.sig === sig) return place;
  let from = -1;
  let startLine = 0;
  if (place.heading !== null) {
    let best = -1;
    for (let j = 0; j < spans.length; j++) {
      const span = spans[j]!;
      if (span.heading !== place.heading) continue;
      if (best < 0 || Math.abs(span.line - place.headingLine) < Math.abs(spans[best]!.line - place.headingLine)) best = j;
    }
    if (best < 0) return anchorAt(spans, place.fraction * scrollable, end);
    from = best;
    startLine = spans[best]!.line;
  }
  const target = startLine + Math.max(0, place.line - place.headingLine);
  // The section: from its heading up to the next one, whichever level.
  let found = from;
  for (let j = from + 1; j < spans.length; j++) {
    const span = spans[j]!;
    if (span.heading !== null || span.line > target) break;
    found = j;
  }
  if (found < 0) return place.line === 0 ? { line: 0, nth: 0, within: place.within } : null;
  const span = spans[found]!;
  if (span.line === target) return { line: target, nth: place.nth, within: place.within };
  return { line: span.line, nth: found - firstOf(spans, span.line), within: 0 };
}

/** The top of the block a line of the file is in: the first block beginning on it, else the last one before it. */
export function lineTop(spans: readonly Span[], line: number): number {
  let i = -1;
  for (let j = 0; j < spans.length; j++) {
    if (spans[j]!.line > line) break;
    if (i < 0 || spans[j]!.line !== spans[i]!.line) i = j;
  }
  return i < 0 ? 0 : spans[i]!.top;
}

/**
 * A heading's anchor the way GitHub writes one, which is the way a README's
 * own table of contents is written: lower case, punctuation out, spaces to
 * hyphens, and a second heading of one name `-1`. The renderer gives headings
 * no ids, so a `#section` link is matched here against these.
 */
export function headingSlugs(texts: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return texts.map((text) => {
    const base = text
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
      .replace(/ /g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  });
}

/** The fragment a link names, decoded, or null for one that is not a fragment. */
export function fragmentOf(href: string | null): string | null {
  if (!href || !href.startsWith("#") || href.length < 2) return null;
  try {
    return decodeURIComponent(href.slice(1));
  } catch {
    return href.slice(1);
  }
}

/**
 * Which markup a place was taken in. FNV-1a over the whole string: a render is
 * hashed once when it arrives, and the cost of a collision is a place restored
 * exactly into a document that changed, which is what happened before anyway.
 */
export function markupSig(html: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < html.length; i++) {
    h ^= html.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${html.length}:${(h >>> 0).toString(36)}`;
}

/** One document's key: its root as its tab holds it, and its path under that. */
export function placeKey(root: string, path: string): string {
  return `${root}\n${path}`;
}

/** How many documents' places a device keeps; the oldest go first. */
export const PLACES_MAX = 200;

/** Whatever was stored, as places, with anything malformed left out rather than refused. */
export function adoptPlaces(raw: unknown): Map<string, Place> {
  const out = new Map<string, Place>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const num = (n: unknown) => typeof n === "number" && Number.isFinite(n);
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const p = value as Partial<Place> | null;
    if (!p || typeof p !== "object") continue;
    if (!num(p.line) || !num(p.nth) || !num(p.within) || !num(p.headingLine) || !num(p.fraction) || !num(p.at)) continue;
    if (typeof p.sig !== "string" || (p.heading !== null && typeof p.heading !== "string")) continue;
    out.set(key, {
      line: Math.max(0, Math.floor(p.line!)),
      nth: Math.max(0, Math.floor(p.nth!)),
      within: clamp01(p.within!),
      heading: p.heading ?? null,
      headingLine: Math.max(0, Math.floor(p.headingLine!)),
      fraction: clamp01(p.fraction!),
      sig: p.sig,
      at: p.at!,
    });
  }
  return out;
}

/** The newest `max`, for writing back. */
export function keptPlaces(places: ReadonlyMap<string, Place>, max = PLACES_MAX): Record<string, Place> {
  const newest = [...places].sort((a, b) => b[1].at - a[1].at).slice(0, max);
  return Object.fromEntries(newest);
}

// ---------------------------------------------------------------------------
// The device's store
// ---------------------------------------------------------------------------

const STORAGE_KEY = "kururu.reader.places";

let places: Map<string, Place> | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;

function loaded(): Map<string, Place> {
  if (places) return places;
  try {
    places = adoptPlaces(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"));
  } catch {
    places = new Map();
  }
  return places;
}

/** Written once scrolling has settled rather than on every frame of it, and on the way out. */
function flush(): void {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = null;
  if (!places) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(keptPlaces(places)));
  } catch {
    // The place still holds in this window; it just will not survive a reload.
  }
}

if (typeof window !== "undefined") window.addEventListener("pagehide", flush);

export function savedPlace(key: string): Place | null {
  return loaded().get(key) ?? null;
}

/** Keep a place, or forget one — null is the top of the file. */
export function keepPlace(key: string, place: Place | null): void {
  const map = loaded();
  if (place) map.set(key, place);
  else if (!map.delete(key)) return;
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(flush, 500);
}

/**
 * A link that opens a document at a line — a path with `:40` in Kuru's reply,
 * on an agent's row or on a card — asked to land there. The server opens the
 * document and never hears of the line (it is nvim's `+N` there), so the page
 * that clicked leaves word here and the reader that draws that document next
 * takes it, ahead of the place it would have restored. Short-lived, so a link
 * that failed to open does not move a document opened by hand later.
 */
interface Jump {
  key: string;
  line: number;
  until: number;
}

const JUMP_MS = 10_000;
let jump: Jump | null = null;
const jumpListeners = new Set<() => void>();

export function requestJump(root: string, path: string, line: number): void {
  if (!Number.isInteger(line) || line < 1) return;
  jump = { key: placeKey(root, path), line, until: Date.now() + JUMP_MS };
  for (const listener of jumpListeners) listener();
}

/** The line a document was asked to open at, taken so that only one reader acts on it. */
export function takeJump(key: string): number | null {
  if (!jump || jump.key !== key) return null;
  const { line, until } = jump;
  jump = null;
  return Date.now() <= until ? line : null;
}

export function onJump(listener: () => void): () => void {
  jumpListeners.add(listener);
  return () => jumpListeners.delete(listener);
}

/**
 * A heading another document's link named — `contador.md#preguntas` — asked
 * of whichever reader draws that document next. The jump's arrangement and for
 * the jump's reason: the server opens the document and never hears of the
 * heading, so the page that clicked leaves word here. Short-lived, so a link to
 * a file that did not open does not move the same file opened by hand later.
 */
let fragment: { key: string; fragment: string; until: number } | null = null;

export function askFragment(key: string, wanted: string): void {
  fragment = wanted ? { key, fragment: wanted, until: Date.now() + JUMP_MS } : null;
}

/** The heading a document was asked to open at, taken so that only one reader acts on it. */
export function takeFragment(key: string): string | null {
  if (!fragment || fragment.key !== key) return null;
  const { fragment: wanted, until } = fragment;
  fragment = null;
  return Date.now() <= until ? wanted : null;
}
