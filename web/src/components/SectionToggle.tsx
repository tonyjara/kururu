/**
 * The sidebar's foldable section heading and the per-device memory of whether
 * it is open, in a module of their own so that a section drawn outside
 * Sidebar.tsx — Automations — folds the same way Nodes and Dev servers do,
 * without Automations.tsx importing back the file that imports it.
 */
import { useState, type ReactNode } from "react";
import { Icon } from "./Icon";

/**
 * Whether one of the sidebar's foot sections is open, remembered per device.
 *
 * Local rather than the server's, on the argument the sidebar's drawer makes
 * in Sidebar.tsx: a disclosure
 * is a thing you do with your eyes, and a phone opening the dev servers to tap
 * one must not reach over and open them on the desktop. Remembered at all
 * because the sidebar is unmounted every time a phone puts it away, and a
 * section that shut itself each time would have to be opened each time.
 *
 * Storage can throw — a private window, blocked site data — and when it does
 * the section simply starts at its default.
 */
export function useDisclosure(key: string, initial: boolean): [boolean, () => void] {
  const [open, setOpen] = useState(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved === null ? initial : saved === "1";
    } catch {
      return initial;
    }
  });
  const toggle = () =>
    setOpen((was) => {
      try {
        localStorage.setItem(key, was ? "0" : "1");
      } catch {
        // Not remembered; still toggled.
      }
      return !was;
    });
  return [open, toggle];
}

/**
 * A section heading that is also its disclosure. The whole heading is the
 * target, and the caret is the drawer's — rotated shut rather than swapped —
 * so the two ways the sidebar folds something away look like one.
 */
export function SectionToggle({
  open,
  onToggle,
  label,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  children?: ReactNode;
}) {
  return (
    <button className="side-toggle" onClick={onToggle} aria-expanded={open}>
      <Icon name="caret" className={open ? "" : "drawer-caret-shut"} />
      <span>{label}</span>
      {children}
    </button>
  );
}
