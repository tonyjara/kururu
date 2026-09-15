/**
 * The pane's half of a terminal: a box to put one in, and the file drop.
 *
 * It does not own an emulator and it deliberately cannot. Emulators are pooled
 * by agent id in `terminals.ts` and live as long as their terminal does, because
 * tying one to the view that draws it is what made a tab switch, a workspace
 * change and a drag each throw a screen away and rebuild it from a
 * reconstruction. Nor does it own a *size*: a pane proposes one and the server
 * decides, so there is nothing here that fits, measures or resizes anything.
 * This component borrows an emulator on mount and hands it back on unmount, and
 * the handing back is a `removeChild` rather than a teardown.
 *
 * The pooled element is appended imperatively into the ref'd mount rather than
 * rendered as a child, and that is not a style choice: React owns what it
 * renders, and it would remove the element the next time this subtree
 * reconciled. Appending into a node React thinks is empty is what makes moving a
 * pane a DOM move.
 *
 * `useLayoutEffect` rather than `useEffect`, because the difference is visible.
 * A pooled emulator already has a screen in it; borrowing it after the browser
 * has painted shows an empty pane for a frame, which is precisely the flash this
 * whole change exists to remove.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { isFileDrag, textForDrop } from "../drop";
import { input } from "../session";
import { borrow, release, setFocused } from "../terminals";

interface Props {
  agentId: string;
  /** This is the focused pane. Only one is. Drives the cursor. */
  focused: boolean;
  /**
   * Keys may reach a pty — false while a dialog, Settings or the help overlay
   * is up. Drives the DOM focus, and deliberately not the cursor: see
   * `setFocused`.
   */
  keyboard: boolean;
}

export function TerminalView({ agentId, focused, keyboard }: Props) {
  const mount = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const box = mount.current;
    if (!box) return;
    borrow(agentId, box);
    return () => release(agentId, box);
  }, [agentId]);

  // Focus follows the pane, so ⌘] and a click land in the same place. Stated
  // rather than applied once, because the first emulator of a session is still
  // waiting on the WASM when the pane that would focus it mounts.
  useEffect(() => {
    setFocused(agentId, focused, keyboard);
  }, [agentId, focused, keyboard]);

  /**
   * A file dropped from the Finder is typed in, escaped, exactly as every other
   * terminal has done it for thirty years — which is how you hand a screenshot
   * to an agent that only takes text.
   *
   * It goes to *this* terminal rather than the focused one, because the pane you
   * dropped on is the one you were pointing at, and a drop that landed somewhere
   * other than where it was aimed would be worse than no drop at all. The
   * handler sits on the mount rather than on the emulator's own element because
   * the emulator's element is not this component's to put props on; the events
   * bubble out of it into here, which is the same reach with none of the
   * ownership.
   *
   * `dragover` has to preventDefault or `drop` never fires, and it checks the
   * types rather than the payload because the payload is unreadable until the
   * drop — the same restriction `drag.ts` exists to work around. Kururu's own
   * tab and pane drags carry custom MIME types, not `Files`, so they fall
   * straight through this to the drop zones that handle them.
   */
  return (
    <div
      className="term-mount"
      ref={mount}
      onDragOver={(event) => {
        if (!isFileDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        if (!isFileDrag(event.dataTransfer)) return;
        event.preventDefault();
        const text = textForDrop(event.dataTransfer);
        if (text) input(agentId, text);
      }}
    />
  );
}
