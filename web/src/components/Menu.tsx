/**
 * The right-click menu: the actions a row has, where the pointer already is.
 *
 * Everything in here is reachable another way — a keybind, a button, a drag —
 * and that is the point rather than a redundancy. A prefix keymap is worth
 * learning and worth nothing to somebody who has not learnt it yet, and the
 * sidebar has no room to print five buttons on every workspace. Right-click is
 * the one gesture that costs nothing until it is used.
 *
 * It closes on the first thing that happens next: a click anywhere (including
 * inside itself, after the item has run), a second right-click, escape, or a
 * scroll. A menu left open over a moving layout is pointing at the wrong row,
 * and the backdrop that catches those clicks is also what stops one reaching
 * the terminal underneath.
 */
import { useEffect, useRef, useState } from "react";

export interface MenuItem {
  label: string;
  /** Draw a rule above this one — what separates "delete" from the rest. */
  sep?: boolean;
  danger?: boolean;
  disabled?: boolean;
  run: () => void;
}

export interface MenuAt {
  x: number;
  y: number;
}

export function Menu({ at, items, onClose }: { at: MenuAt; items: MenuItem[]; onClose: () => void }) {
  return (
    <Popover at={at} onClose={onClose} className="menu" role="menu">
      {items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          className={`menu-item ${item.danger ? "menu-danger" : ""} ${item.sep ? "menu-sep" : ""}`}
          disabled={item.disabled}
          onClick={() => {
            item.run();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </Popover>
  );
}

/**
 * The box a menu is drawn in, without the menu.
 *
 * Split out when the colour picker needed the same thing and was not a list of
 * labelled items — a grid of swatches has no `label`, and bending `MenuItem`
 * into a shape that could carry one would have made every caller of it carry the
 * possibility. What is actually shared is smaller than a menu and duller: where
 * the box goes when it does not fit, and the four ways it closes. Those are
 * exactly the parts that are easy to get subtly wrong twice.
 */
export function Popover({
  at,
  onClose,
  className,
  role,
  children,
}: {
  at: MenuAt;
  onClose: () => void;
  className: string;
  role?: string;
  children: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  /**
   * Where it actually fits. It is measured rather than guessed because the
   * height depends on how many items a row has, and a menu opened near the
   * bottom of a short window would otherwise hang off the end of it.
   */
  const [at2, setAt2] = useState(at);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setAt2({
      x: Math.max(4, Math.min(at.x, window.innerWidth - width - 4)),
      y: Math.max(4, Math.min(at.y, window.innerHeight - height - 4)),
    });
  }, [at]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return (
    <div
      className="menu-backdrop"
      onPointerDown={onClose}
      onContextMenu={(event) => {
        event.preventDefault();
        onClose();
      }}
      onWheel={onClose}
    >
      <div
        ref={box}
        className={className}
        style={{ left: at2.x, top: at2.y }}
        role={role}
        onPointerDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.preventDefault()}
      >
        {children}
      </div>
    </div>
  );
}
