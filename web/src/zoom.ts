/**
 * How big the reader's type is, on the screen you are reading it on.
 *
 * This is a *device* preference and not the server's, which is the same call the
 * sidebar's width makes in `App.tsx` and for the same reason: a phone and a
 * desktop watching one server are two windows of two shapes, and a zoom level in
 * the snapshot would be each of them overwriting the other's every time somebody
 * made a README readable on the smaller one. It is also the difference from
 * `appearance.json`, where the *terminal's* font size lives — that one decides a
 * cell, a cell decides a grid, and a grid is the server's by policy. Nothing
 * downstream of this reaches a pty at all, so nothing here is worth a round trip.
 *
 * What is stored is a **multiplier on the skin's type step**, never a pixel size.
 * `--fs-lg` is what the reader is set in and a skin is entitled to move it —
 * a monospace chrome might set it to 12px where the default sets 13, and a
 * pixel chrome would go further — so a saved px would be a zoom that quietly
 * undid a skin. It is applied as one custom property
 * on the root element, which is `--sidebar-w`'s trick: the whole document is laid
 * out in `em` and `ch` off that one size, so the headings, the code blocks, the
 * measure and the image captions all move together and the stylesheet needs to
 * know nothing about any of it.
 *
 * A module store rather than React state, subscribed through
 * `useSyncExternalStore` the way `session.ts` is. The two things that touch it —
 * the strip's buttons and the keyboard in `App.tsx` — are four levels apart in
 * the tree, and threading a number and a setter through every pane and split to
 * join them up would put a view state nobody else has an opinion about into the
 * signature of everything in between.
 */

/**
 * The stops, as multipliers. A ladder rather than a free number, so that a zoom
 * level is somewhere you can get back to: "one press smaller" has to land on the
 * size it landed on last time, and a percentage arrived at by multiplying by 1.1
 * repeatedly is a different number every route in.
 *
 * It is wider upwards than downwards because the two directions are answering
 * different questions. Down is an occasional glance at a wide document on a big
 * screen; up is a phone, where the reader is most of the point and the default
 * step is 13px of prose held at arm's length.
 */
export const ZOOM_STOPS = [0.8, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2, 2.4] as const;

export const DEFAULT_ZOOM = 1;

/** Where this device's choice is kept. Per browser, on purpose — see above. */
const STORAGE_KEY = "kururu.reader.zoom";

/**
 * One step along the ladder from wherever this is.
 *
 * It snaps to the nearest stop before stepping rather than looking the value up,
 * so a number that is not on the ladder — a stop retired in a later version, a
 * hand-edited `localStorage` — still moves in the direction that was asked for
 * instead of jumping to an end. Pure, and tested, because this is the whole of
 * what a press means and an off-by-one in it is a zoom that skips a size.
 */
export function stepZoom(zoom: number, delta: number): number {
  let nearest = 0;
  for (let i = 1; i < ZOOM_STOPS.length; i++) {
    if (Math.abs(ZOOM_STOPS[i]! - zoom) < Math.abs(ZOOM_STOPS[nearest]! - zoom)) nearest = i;
  }
  const next = Math.min(ZOOM_STOPS.length - 1, Math.max(0, nearest + delta));
  return ZOOM_STOPS[next]!;
}

/** Whatever was stored, made into a stop. A hand-edited file bends rather than refuses. */
export function adoptZoom(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_ZOOM;
  return stepZoom(n, 0);
}

let zoom = DEFAULT_ZOOM;
const listeners = new Set<() => void>();

/**
 * Written onto `<html>` rather than handed to a component, so the cascade
 * carries it to the one rule that wants it and no React tree re-renders to
 * change a font size. `styles.css` names a fallback of its own, which is what is
 * on screen for a window that has not run this yet.
 */
function apply(): void {
  document.documentElement.style.setProperty("--reader-zoom", String(zoom));
}

/**
 * Read at load rather than on first subscription, because the first paint is the
 * point: a reader restored at 175% that starts at 100% and corrects itself is a
 * document that reflows in front of you every time the window opens.
 *
 * Guarded on `document` rather than on `localStorage` so that importing this
 * module outside a browser — which `web/test` does, for the ladder — touches
 * neither. A storage that refuses to answer is a reader at the default size, not
 * an error anybody needs to hear about.
 */
if (typeof document !== "undefined") {
  try {
    zoom = adoptZoom(localStorage.getItem(STORAGE_KEY));
  } catch {
    // A private window reads back nothing and opens at 100%.
  }
  apply();
}

function set(next: number): void {
  if (next === zoom) return;
  zoom = next;
  apply();
  try {
    localStorage.setItem(STORAGE_KEY, String(zoom));
  } catch {
    // The zoom still holds for this window; it just will not be here tomorrow.
  }
  for (const listener of listeners) listener();
}

/** A press: `+1` bigger, `-1` smaller. */
export function zoomBy(delta: number): void {
  set(stepZoom(zoom, delta));
}

export function resetZoom(): void {
  set(DEFAULT_ZOOM);
}

export function readerZoom(): number {
  return zoom;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const zoomStore = { subscribe, getSnapshot: readerZoom };

/** How the level is written where somebody reads it back. */
export function zoomLabel(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** Whether there is anywhere further to go, so a button that cannot move says so. */
export function canZoom(value: number, delta: number): boolean {
  return stepZoom(value, delta) !== value;
}
