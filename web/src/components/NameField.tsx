/**
 * A terminal's name as a field, where the name was — in its tab, or in its
 * row of the sidebar.
 *
 * In place rather than the prompt C-a , opens, because Rename is picked off a
 * menu that hung from the thing being renamed, and an answer that appears in
 * the middle of the window is an answer somewhere else. All three send the
 * same `rename-tab`, and the tab and the sidebar row draw the same
 * `titleOverride`, so a name typed into either is the name on both: they can
 * only differ in where you type.
 *
 * It starts on the name you can see there, not on the override alone: the
 * field should hold what the tab or the row said. Which is also why an
 * unchanged name is not sent — that would turn a summary the agent keeps
 * rewriting into a name somebody typed, and pin it there, for a Rename and an
 * enter. Empty is sent, and hands the terminal back to whatever it would
 * otherwise be called.
 *
 * The keyboard is claimed for as long as the field exists, not for as long as
 * the parent's state says so. A tab can go out from under it — closed by
 * another client, the agent ending — and a field removed from the document
 * fires no blur, so a claim released only on blur would leave every pane deaf
 * with nothing on screen to say why. The effect's cleanup is the exit every
 * path goes through. It releases and does not also end the rename, because
 * StrictMode runs every cleanup once on mount, and a field that put itself
 * away there would never be seen in development at all; the parent clears a
 * rename whose terminal has left it.
 */
import { useEffect, useRef } from "react";
import * as api from "../session";

export function NameField({
  agentId,
  shown,
  className,
  onEditing,
  onDone,
}: {
  agentId: string;
  /** What the name reads as where the field stands — what it starts on. */
  shown: string;
  className: string;
  onEditing: (on: boolean) => void;
  onDone: () => void;
}) {
  /** Escape blurs, as enter and clicking away do; this says it was not a commit. */
  const cancelled = useRef(false);

  useEffect(() => {
    onEditing(true);
    return () => onEditing(false);
  }, [onEditing]);

  return (
    <input
      className={className}
      defaultValue={shown}
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={(event) => {
        // The app listens on window in the capture phase, so this stops
        // nothing it does; it is here for the pane or the row underneath.
        event.stopPropagation();
        if (event.key === "Escape") cancelled.current = true;
        if (event.key === "Enter" || event.key === "Escape") event.currentTarget.blur();
      }}
      onBlur={(event) => {
        const name = event.currentTarget.value.trim();
        if (!cancelled.current && name !== shown) api.renameTab(agentId, name);
        cancelled.current = false;
        onDone();
      }}
      spellCheck={false}
      autoComplete="off"
      aria-label="Name"
    />
  );
}
