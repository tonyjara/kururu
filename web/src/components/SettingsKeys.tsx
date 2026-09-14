/**
 * The keyboard page: every action, the keys that reach it, and a way to change
 * them.
 *
 * The list is by action rather than by key, which is the way round people ask
 * the question — "how do I split a pane" happens far more often than "what does
 * `%` do", and the second one is what the help overlay is for. It also makes the
 * one asymmetry visible: a key means exactly one thing, but an action can have
 * several keys, so a row is a list of chips rather than a single field.
 *
 * Binding is a capture rather than a text box. A field you type `|` into cannot
 * tell you that `|` is already taken, cannot represent the arrow keys, and
 * invites somebody to type the word "shift" — whereas pressing the key you want
 * is the actual gesture, and the thing pressed is exactly the string the keymap
 * is looked up by. Taking a key that another action had is allowed and said out
 * loud rather than refused: you nearly always mean it, and the row it came from
 * is on the same screen.
 *
 * Nothing here holds the keymap. Each change is a `bind-key` and what comes back
 * in the snapshot is what gets drawn — which is what makes the overrides worth
 * storing on the server, and what lets the phone and the desktop have the same
 * keyboard.
 */
import { useEffect, useState } from "react";
import {
  ACTION_GROUPS,
  ACTION_INFO,
  DEFAULT_KEYMAP,
  isBindableKey,
  keymapFrom,
  keysByAction,
  type Action,
  type KeyOverrides,
} from "../../../shared/keys";
import { isModifier, keyLabel, keyName, PREFIX_LABEL } from "../keys";
import * as api from "../session";

export function KeySettings({
  keys,
  onEditing,
}: {
  keys: KeyOverrides;
  onEditing: (on: boolean) => void;
}) {
  const keymap = keymapFrom(keys);
  const bound = keysByAction(keymap);
  const fromDefault = keysByAction(DEFAULT_KEYMAP);

  /** The action waiting for a key, if any. */
  const [capturing, setCapturing] = useState<Action | null>(null);
  /** What just happened, in one line. Cleared by the next capture. */
  const [note, setNote] = useState<string | null>(null);

  /**
   * While a key is being captured the window's own keyboard stands down (via
   * `onEditing`), so this listener sees everything — which is the point. It is
   * on the window rather than on the button because the button would lose the
   * capture the moment focus moved, and a keystroke that lands nowhere reads as
   * the feature being broken.
   */
  useEffect(() => {
    onEditing(capturing !== null);
    if (!capturing) return;

    const onKey = (event: KeyboardEvent) => {
      if (isModifier(event)) return;
      event.preventDefault();
      event.stopPropagation();

      const key = keyName(event);
      if (key === "escape") {
        setCapturing(null);
        return;
      }
      if (!isBindableKey(key)) {
        setNote(
          /^[1-9]$/.test(key)
            ? "1–9 jump to workspaces by number, so they cannot be rebound."
            : `${PREFIX_LABEL} cannot be followed by that key.`,
        );
        return;
      }

      const taken = keymap[key];
      api.bindKey(key, capturing);
      setNote(
        taken && taken !== capturing
          ? `“${keyLabel(key)}” was ${ACTION_INFO[taken].label}, and is now ${ACTION_INFO[capturing].label}.`
          : null,
      );
      setCapturing(null);
    };

    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing, keymap, onEditing]);

  const changed = Object.keys(keys).length;

  return (
    <div className="keys">
      <p className="set-hint">
        Every key below is pressed <em>after</em> {PREFIX_LABEL}. Click <span className="key-add">+</span>{" "}
        and press the key you want; click a key to unbind it.
      </p>
      {note && <p className="set-hint key-note">{note}</p>}

      {ACTION_GROUPS.map(([group, title]) => (
        <section key={group} className="key-group">
          <h3 className="set-head">{title}</h3>
          {(Object.keys(ACTION_INFO) as Action[])
            .filter((action) => ACTION_INFO[action].group === group)
            .map((action) => {
              const mine = bound[action] ?? [];
              const moved = mine.join(" ") !== (fromDefault[action] ?? []).join(" ");
              return (
                <div key={action} className={`key-row ${moved ? "key-row-moved" : ""}`}>
                  <span className="key-what">{ACTION_INFO[action].label}</span>
                  <span className="key-keys">
                    {mine.map((key) => (
                      <button
                        key={key}
                        className="key-chip"
                        title={`Unbind ${keyLabel(key)}`}
                        onClick={() => api.bindKey(key, null)}
                      >
                        {keyLabel(key)}
                        <span className="key-x">×</span>
                      </button>
                    ))}
                    {/* An action with nothing bound to it is not an error — it is
                        a key somebody took away, and saying so where the key
                        would have been is the only place it reads as deliberate. */}
                    {mine.length === 0 && capturing !== action && (
                      <span className="key-none">unbound</span>
                    )}
                    {capturing === action ? (
                      <button className="key-add key-add-armed" onClick={() => setCapturing(null)}>
                        press a key…
                      </button>
                    ) : (
                      <button
                        className="key-add"
                        title={`Add a key for ${ACTION_INFO[action].label}`}
                        onClick={() => {
                          setNote(null);
                          setCapturing(action);
                        }}
                      >
                        +
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
        </section>
      ))}

      <div className="key-foot">
        <span className="set-note">
          {changed === 0
            ? "Unchanged from the defaults, which are ghosttown's."
            : `${changed} key${changed === 1 ? "" : "s"} changed.`}
        </span>
        <button className="button-quiet" disabled={changed === 0} onClick={() => api.resetKeys()}>
          Reset to defaults
        </button>
      </div>
    </div>
  );
}
