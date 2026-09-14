/**
 * What the prefix can do, on one page.
 *
 * Printed from the keymap the window is actually using, rather than from a list
 * beside it — which is the only version that stays true now that the keys are
 * rebindable. A help overlay that lies is worse than none, because it is
 * believed, and a static table would start lying the first time somebody moved a
 * key. So this inverts the live map: every action that has a key, with the keys
 * it has, and nothing for the ones somebody has unbound.
 */
import { ACTION_GROUPS, ACTION_INFO, keysByAction, type Action } from "../../../shared/keys";
import { keyLabel, PREFIX_LABEL } from "../keys";

export function HelpOverlay({
  keymap,
  onClose,
}: {
  keymap: Record<string, Action>;
  onClose: () => void;
}) {
  const bound = keysByAction(keymap);
  return (
    <div className="scrim" onPointerDown={onClose}>
      <div className="help" onPointerDown={(event) => event.stopPropagation()} role="dialog" aria-modal>
        <h2 className="dialog-title">After {PREFIX_LABEL}</h2>
        <dl className="help-list">
          {ACTION_GROUPS.flatMap(([group]) =>
            (Object.keys(ACTION_INFO) as Action[])
              .filter((action) => ACTION_INFO[action].group === group && bound[action]?.length)
              .map((action) => (
                <div key={action}>
                  <dt>{bound[action]!.map(keyLabel).join(" ")}</dt>
                  <dd>{ACTION_INFO[action].label}</dd>
                </div>
              )),
          )}
          <div key="workspace-digits">
            <dt>1…9</dt>
            <dd>jump to workspace</dd>
          </div>
        </dl>
        <p className="dialog-hint">
          {PREFIX_LABEL} twice sends it to the terminal. ⌘D, ⇧⌘D, ⌘T, ⇧⌘W and ⌘[ ⌘] still work
          without it. The keys above are yours to change, under the cog.
        </p>
      </div>
    </div>
  );
}
