/**
 * Whether the drawer of things that need you is open.
 *
 * Module state rather than a flag in `App`, on `kuru.ts`'s argument: the
 * chip in the status bar opens it, so does a key, and a notification or
 * the pill may one day want the same door. One function, and `App`
 * subscribes to the answer. View state and nothing else — a phone must not
 * be shown the drawer because the desktop opened it.
 *
 * One drawer at a time: opening this one closes Kuru's, since both sit
 * over the same edge of the window. The other direction is `App`'s to
 * keep, so that this module and `kuru.ts` import one way.
 */
import { useSyncExternalStore } from "react";
import { closeKuru } from "./kuru";

let open = false;
const listeners = new Set<() => void>();

function set(next: boolean): void {
  if (next === open) return;
  open = next;
  for (const listener of listeners) listener();
}

export function useNeedsDrawer(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => open,
  );
}

export function openNeeds(): void {
  closeKuru();
  set(true);
}

export function closeNeeds(): void {
  set(false);
}

/** The chip and the key: one press opens, the next closes. */
export function toggleNeeds(): void {
  if (open) closeNeeds();
  else openNeeds();
}
