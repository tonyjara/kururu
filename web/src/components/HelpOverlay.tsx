/**
 * What the prefix can do, on one page.
 *
 * Printed from the same table the keymap is built from, so a key that is rebound
 * or removed cannot go on being documented here — a help overlay that lies is
 * worse than none, because it is believed.
 */
import { HELP, PREFIX_LABEL } from "../keys";

export function HelpOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="scrim" onPointerDown={onClose}>
      <div className="help" onPointerDown={(event) => event.stopPropagation()} role="dialog" aria-modal>
        <h2 className="dialog-title">After {PREFIX_LABEL}</h2>
        <dl className="help-list">
          {HELP.map(([keys, what]) => (
            <div key={keys}>
              <dt>{keys}</dt>
              <dd>{what}</dd>
            </div>
          ))}
        </dl>
        <p className="dialog-hint">
          {PREFIX_LABEL} twice sends it to the terminal. ⌘D, ⇧⌘D, ⌘T, ⇧⌘T, ⇧⌘W and ⌘[ ⌘] still work
          without it.
        </p>
      </div>
    </div>
  );
}
