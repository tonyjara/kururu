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
import { useSyncExternalStore } from "react";
import { desktop, type FloatState } from "./desktop";

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
    // A number off another process: checked before it is used as a width.
    wave: typeof r.wave === "number" && Number.isFinite(r.wave) ? Math.max(60, Math.min(2000, r.wave)) : 132,
    role: r.role === "logo" || r.role === "panel" ? r.role : (state?.role ?? null),
    wide: r.wide === true,
    pen: r.pen === true,
    logo: typeof r.logo === "number" && Number.isFinite(r.logo) ? Math.max(48, Math.min(240, r.logo)) : undefined,
  };
}

function take(raw: unknown): void {
  const next = adopt(raw);
  if (!next) return;
  state = next;
  for (const listener of listeners) listener();
}

/** Asked once, on the first reader, and listened to for as long as the page lives: a page has one main process. */
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
