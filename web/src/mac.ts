/**
 * What this Mac is using, as the server last said it, kept apart from the
 * session's state.
 *
 * Apart because it arrives every few seconds for as long as the window is
 * open, and `useKururu` hands every component the whole state: a figure that
 * only one chip on the bottom bar draws would have redrawn the sidebar, the
 * panes and the board each time the processors moved a point. Here, the chip
 * is the only thing listening.
 */
import { useSyncExternalStore } from "react";
import type { MacView } from "../../shared/mac";

let mac: MacView | null = null;
const listeners = new Set<() => void>();

/** The server's reading, from `session.ts`. */
export function setMac(view: MacView | null): void {
  mac = view;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The last reading, or null until the server has taken one. */
export function useMac(): MacView | null {
  return useSyncExternalStore(subscribe, () => mac);
}
