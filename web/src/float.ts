/**
 * The floating Kuru, as a page sees it: whether it is on, whether its chat
 * is open, and which way things face.
 *
 * Module state for `kuru.ts`'s reason — more than one thing reads it and not
 * all of them are under one component: the logo's page, the chat's, the
 * pill's (which draws the voice beside the logo while it is on) and the
 * window's Settings. All of it is the main process's (`desktop/float.js`);
 * a page only asks, listens, and says what was pressed.
 *
 * Null without the bridge — a browser, the phone, or a window of a kururu
 * from before it — which every caller reads as "there is no floating Kuru".
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { desktop, type FloatState } from "./desktop";

/** The least the voice's waveform is drawn at: its width beside a shut chat (`WAVE_WIDTH` in `desktop/floatshape.js`). */
export const FLOAT_WAVE_MIN = 132;

let state: FloatState | null = null;
let asked = false;
const listeners = new Set<() => void>();

function adopt(raw: unknown): FloatState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    on: r.on === true,
    open: r.open === true,
    side: r.side === "below" ? "below" : "above",
    reach: r.reach === "right" ? "right" : "left",
    // From an app before the corner was the person's, the waveform's side was the chat's.
    waveReach: r.waveReach === "right" ? "right" : r.waveReach === "left" ? "left" : r.reach === "right" ? "right" : "left",
    // A number off another process: checked before it is used as a width.
    wave: typeof r.wave === "number" && Number.isFinite(r.wave) ? Math.max(60, Math.min(2000, r.wave)) : 132,
    role: r.role === "logo" || r.role === "panel" ? r.role : (state?.role ?? null),
    wide: r.wide === true,
    pen: r.pen === true,
    logo: typeof r.logo === "number" && Number.isFinite(r.logo) ? Math.max(48, Math.min(240, r.logo)) : undefined,
    give: r.give === true,
    chatAt: typeof r.chatAt === "number" && Number.isFinite(r.chatAt) ? r.chatAt : 0,
  };
}

function take(raw: unknown): void {
  const next = adopt(raw);
  if (!next) return;
  state = next;
  for (const listener of listeners) listener();
}

/**
 * Asked once, on the first reader, and listened to for as long as the page
 * lives: a page has one main process. Exported for a reader that is not a
 * component — the window's `kuruTarget`, which has to know the chat is open
 * when nothing on screen draws the floating Kuru.
 */
export function followFloat(): void {
  ask();
}

function ask(): void {
  if (asked) return;
  asked = true;
  const bridge = desktop()?.float;
  if (!bridge) return;
  void bridge.state().then(take, () => {});
  bridge.onState(take);
}

/** What was last said, for a caller that is not a component. */
export function floatNow(): FloatState | null {
  return state;
}

export function useFloat(): FloatState | null {
  return useSyncExternalStore(
    (listener) => {
      ask();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

/**
 * How far this page is zoomed, 1 for not at all.
 *
 * The window's ⌘+ is Chromium's page zoom, and Chromium keeps a zoom per
 * site, not per window: the logo's page and the pill's come from the same
 * address as the window's, so a window read at 110% makes them 110% too.
 * The chat is welcome to it — it is the drawer, in a box that fills its
 * window, and bigger type there is what was asked for. The logo and the pill
 * (the waveform, docked) are not: each is drawn to the pixel in a window made
 * exactly its size, so at 110% the mark is a tenth too big for its window and
 * its right side, its foot and its count are cut off by the window's edge —
 * which is what the owner saw (2026-11-10), and what more room round the mark
 * only hid until the next step of zoom. The pill at its own place was the
 * same a day later, cut at its right end and its foot while the owner talked.
 *
 * The app cannot set these windows back to 100% without setting the window
 * back too, since the zoom is the site's. So the page asks Chromium for it
 * (`zoom` on the bridge), and whoever draws to the pixel undoes it with the
 * inverse on its root (`zoom` in CSS). A change of zoom changes the page's
 * width in its own pixels, so it arrives as a resize.
 *
 * **It used to be measured, and the measure lied mid-resize.** A window with
 * no frame is as wide outside, in the screen's points, as its page is inside
 * in its own pixels, times the zoom — but the outside size and the inside
 * one reach the page at different moments, and the resize event can come
 * between them. The docked pill goes from 148 points to 497 and back as
 * Shift brings the pen's tools out and puts them away, and read between the
 * two the zoom came out a third or three times what it was; nothing measured
 * again until the next resize, and the report sized the window to the wrong
 * drawing, so it stuck (2026-11-15, the owner's two screenshots: the
 * waveform shrunk to a third, away from the logo, and a dark empty strip —
 * the pen's tools drawn three times too big, their top-left corner all that
 * fitted). A window from before the bridge had it still measures, and takes
 * the measure only when its width and its height say the same zoom, which
 * two sizes caught halfway through a resize do not.
 */
function pageZoom(): number | null {
  if (typeof window === "undefined") return 1;
  const asked = desktop()?.zoom?.();
  let zoom: number;
  if (typeof asked === "number") zoom = asked;
  else {
    // The visual viewport where there is one: it is not rounded to a whole pixel, and a twelfth of a pixel in 73 is a point at the far edge.
    const across = window.outerWidth / (window.visualViewport?.width || window.innerWidth);
    const down = window.outerHeight / (window.visualViewport?.height || window.innerHeight);
    if (!agrees(across, down)) return null;
    zoom = across;
  }
  // Checked before it is used: a window still being made can have no width either way.
  if (!Number.isFinite(zoom) || zoom < 0.2 || zoom > 6) return 1;
  // Whole per-milles, so the measure's own rounding is not a new number on every resize.
  return Math.round(zoom * 1000) / 1000;
}

/** Whether a zoom read off the width and one read off the height are the same zoom: a few per cent, for a height of a few dozen pixels rounded. */
export function agrees(across: number, down: number): boolean {
  return Number.isFinite(across) && Number.isFinite(down) && across > 0 && Math.abs(across - down) <= across * ZOOM_AGREES;
}
const ZOOM_AGREES = 0.04;
/** How many frames a measure that does not agree is tried again for, before it waits for the next resize. */
const ZOOM_TRIES = 20;

export function usePageZoom(): number {
  const [zoom, setZoom] = useState(() => pageZoom() ?? 1);
  useEffect(() => {
    let frame = 0;
    let tries = 0;
    const again = () => {
      cancelAnimationFrame(frame);
      const now = pageZoom();
      if (now !== null) {
        tries = 0;
        setZoom(now);
      } else if (tries++ < ZOOM_TRIES) frame = requestAnimationFrame(again);
    };
    const resized = () => {
      tries = 0;
      again();
    };
    resized();
    window.addEventListener("resize", resized);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resized);
    };
  }, []);
  return zoom;
}
