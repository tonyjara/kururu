/**
 * A chip on the bottom bar with a popover over it: the shape the Claude and
 * Codex allowances take (`Usage.tsx`), and the machines beside them
 * (`Machines.tsx`).
 *
 * One component rather than one hover-and-pin dance per chip, because the
 * dance is the part that is easy to get subtly wrong twice: a popover that
 * shuts the moment the pointer crosses the gap into it, a pin that nothing
 * unpins, a tap that opens one and a second tap that opens it again. The
 * chips differ in what they draw and nothing else, so what they draw is all
 * they are asked for.
 *
 * Open on a mouse's hover and shut when it leaves — the popover is inside the
 * same box, so moving onto it is not leaving, and it waits a moment after the
 * pointer goes so the gap can be crossed. A press pins it instead, which is
 * the only way a phone can open it and a way for a mouse to keep it while
 * reading; a pinned one shuts on a press anywhere else, on Escape, or when a
 * row in it asks (`close`, handed to the content for a row that opens
 * something else — a shell, Settings — and should not leave the popover
 * standing over it). `mousedown` is prevented for the drawer chips' reason:
 * looking at a chip must not take the focus off a terminal.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

/** How long the popover stays up after the pointer leaves, so it can cross the gap into it. */
const HOVER_LEAVE_MS = 160;

export function BarChip({
  label,
  className = "",
  chip,
  children,
}: {
  /** What the chip is — its title while shut, and the popover's name. */
  label: string;
  /** A class on the chip's box, for one that differs from the allowances' look or width. */
  className?: string;
  /** What the chip itself shows. */
  chip: ReactNode;
  /** The popover's content, or a function of the way to shut it. */
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const leave = useRef<ReturnType<typeof setTimeout> | null>(null);
  const close = () => {
    setPinned(false);
    setOpen(false);
  };

  useEffect(() => {
    if (!pinned) return;
    const away = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [pinned]);
  useEffect(
    () => () => {
      if (leave.current) clearTimeout(leave.current);
    },
    [],
  );

  return (
    <span
      className={`sb-usage ${className}`}
      ref={box}
      onPointerEnter={(event) => {
        if (event.pointerType !== "mouse") return;
        if (leave.current) clearTimeout(leave.current);
        setOpen(true);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== "mouse" || pinned) return;
        leave.current = setTimeout(() => setOpen(false), HOVER_LEAVE_MS);
      }}
    >
      <button
        className={`sb-usage-chip ${open ? "sb-usage-on" : ""}`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          const next = !pinned;
          setPinned(next);
          setOpen(next);
        }}
        aria-expanded={open}
        aria-label={label}
        title={open ? undefined : label}
      >
        {chip}
      </button>
      {open && (
        <span className="usage-pop" role="dialog" aria-label={label}>
          {typeof children === "function" ? children(close) : children}
        </span>
      )}
    </span>
  );
}
