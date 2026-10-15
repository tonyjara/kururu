/**
 * The colour picker, on its own because the sidebar no longer has a use for it.
 *
 * It lived in `Sidebar.tsx` for as long as workspaces wore a colour, and the
 * profile board borrowed it from there for its columns. Workspaces stopped
 * wearing one on 2026-10-12 — the mascot already told them apart — and a board
 * importing a picker out of a sidebar that does not draw it would be a
 * dependency on a module that has nothing to do with it.
 */
import { WORKSPACE_COLORS, type WorkspaceColor } from "../../../shared/model";
import { colorValues } from "../colors";
import { Popover } from "./Menu";

/**
 * Fourteen swatches and a way back out of them.
 *
 * A grid rather than a list of colour names, because nobody picks "coral" — they
 * pick the one that is not the one the column beside it is wearing, and that is
 * a comparison you make by looking. The colour currently set is ringed rather
 * than ticked for the same reason: a tick would have to sit on top of the
 * colour it is describing.
 *
 * "None" is a swatch too, not a separate control. Clearing a tag is the same
 * kind of decision as changing it, and burying the undo of a thing one row lower
 * than the thing is how people end up with a palette they cannot get out of.
 */
export function ColorPicker({
  at,
  current,
  onPick,
  onClose,
}: {
  at: { x: number; y: number };
  current: WorkspaceColor | null;
  onPick: (color: WorkspaceColor | null) => void;
  onClose: () => void;
}) {
  return (
    <Popover at={at} onClose={onClose} className="picker" role="listbox">
      <div className="picker-grid">
        {WORKSPACE_COLORS.map((color) => (
          <button
            key={color}
            role="option"
            aria-selected={current === color}
            className={`chip ${current === color ? "chip-on" : ""}`}
            style={{ background: colorValues()[color] }}
            title={color}
            aria-label={color}
            onClick={() => onPick(color)}
          />
        ))}
      </div>
      <button
        role="option"
        aria-selected={current === null}
        className={`picker-none ${current === null ? "picker-none-on" : ""}`}
        onClick={() => onPick(null)}
      >
        No colour
      </button>
    </Popover>
  );
}
