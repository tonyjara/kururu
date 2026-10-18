/**
 * The right-click a finger does not have.
 *
 * iOS never fires `contextmenu` on a long press, so anything with a menu
 * behind its right-click times one itself. Held still for half a second opens
 * the menu, and the click the lift would otherwise deliver is swallowed — the
 * caller asks `swallowed()` at the top of its own click — so a tab is not also
 * selected, or a row also followed, underneath the menu it just opened.
 *
 * A hook since 2026-10-18, when the tab strip became the third place to want
 * it: the sidebar's rows had grown it first, and a tab and an agent row open
 * the same menu, so they should open it on the same gesture timed the same
 * way. `FileTree.tsx` and `NeedsDrawer.tsx` still keep copies of their own.
 */
import { useRef } from "react";

/** How long a touch has to hold still to open a menu. */
export const LONG_PRESS_MS = 500;

/** How far a finger may wander before the press is a scroll or a drag and not a hold. */
const SLOP = 10;

export interface LongPress {
  /** The pointer handlers to spread onto the element, opening `open` at the touch. */
  longPress: (open: (at: { x: number; y: number }) => void) => {
    onPointerDown: (event: React.PointerEvent) => void;
    onPointerMove: (event: React.PointerEvent) => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
  };
  /** Whether the click now arriving is the lift of a press that opened a menu — and forgets it. */
  swallowed: () => boolean;
}

export function useLongPress(): LongPress {
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const pressed = useRef(false);
  const cancel = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  };
  return {
    longPress: (open) => ({
      onPointerDown: (event) => {
        if (event.pointerType !== "touch") return;
        // A row inside a row — an agent's inside its workspace's group — is one
        // press, and the inner one is the one meant.
        event.stopPropagation();
        cancel();
        const { clientX: x, clientY: y } = event;
        press.current = {
          x,
          y,
          timer: window.setTimeout(() => {
            press.current = null;
            pressed.current = true;
            open({ x, y });
          }, LONG_PRESS_MS),
        };
      },
      onPointerMove: (event) => {
        const at = press.current;
        if (at && Math.hypot(event.clientX - at.x, event.clientY - at.y) > SLOP) cancel();
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
    }),
    swallowed: () => {
      if (!pressed.current) return false;
      pressed.current = false;
      return true;
    },
  };
}
