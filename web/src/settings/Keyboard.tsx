/**
 * Settings → General → Keyboard: every action, the keys that reach it, and a
 * way to change them.
 *
 * By action rather than by key, which is the way round people ask the question
 * — "how do I split a pane" happens far more often than "what does `%` do",
 * and the second one is what the help overlay is for. A key means exactly one
 * thing but an action can have several keys, so a row is a list of chips.
 *
 * Binding is a capture rather than a text box: a field you type `|` into
 * cannot tell you that `|` is taken, cannot represent the arrow keys, and
 * invites somebody to type the word "shift". Taking a key another action had
 * is allowed and said out loud rather than refused.
 */
import { useEffect, useState } from "react";
import { ACTION_GROUPS, ACTION_INFO, DEFAULT_KEYMAP, isBindableKey, keymapFrom, keysByAction, type Action, type KeyOverrides } from "../../../shared/keys";
import { Icon } from "../components/Icon";
import { isModifier, keyLabel, keyName, PREFIX_LABEL } from "../keys";
import * as api from "../session";
import { Banner, Danger, Group, Item, useEditing } from "./ui";

export function KeyboardPage({ keys }: { keys: KeyOverrides }) {
  const keymap = keymapFrom(keys);
  const bound = keysByAction(keymap);
  const fromDefault = keysByAction(DEFAULT_KEYMAP);
  const [capturing, setCapturing] = useState<Action | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const tell = useEditing();

  /**
   * While a key is being captured the window's own keyboard stands down, so
   * this listener sees everything. On the window rather than the button
   * because the button would lose the capture the moment focus moved.
   */
  useEffect(() => {
    if (!capturing) return;
    tell(true);
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
        setNote(/^[1-9]$/.test(key) ? "1–9 jump to workspaces by number, so they cannot be rebound." : `${PREFIX_LABEL} cannot be followed by that key.`);
        return;
      }
      const taken = keymap[key];
      api.bindKey(key, capturing);
      setNote(taken && taken !== capturing ? `“${keyLabel(key)}” was ${ACTION_INFO[taken].label}, and is now ${ACTION_INFO[capturing].label}.` : null);
      setCapturing(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      tell(false);
    };
  }, [capturing, keymap, tell]);

  const changed = Object.keys(keys).length;

  return (
    <>
      {note && <Banner>{note}</Banner>}

      {ACTION_GROUPS.map(([group, title], i) => (
        <Group key={group} title={title} foot={i === 0 ? `Every key is pressed after ${PREFIX_LABEL}. Press + and then the key you want; press a key to unbind it.` : undefined}>
          {(Object.keys(ACTION_INFO) as Action[])
            .filter((action) => ACTION_INFO[action].group === group)
            .map((action) => {
              const mine = bound[action] ?? [];
              const moved = mine.join(" ") !== (fromDefault[action] ?? []).join(" ");
              return (
                <Item key={action} name={ACTION_INFO[action].label} className={moved ? "st-item-moved" : undefined}>
                  {mine.map((key) => (
                    <button key={key} type="button" className="st-key" title={`Unbind ${keyLabel(key)}`} onClick={() => api.bindKey(key, null)}>
                      {keyLabel(key)}
                      <Icon name="close" className="st-key-x" />
                    </button>
                  ))}
                  {mine.length === 0 && capturing !== action && <span className="st-key-none">unbound</span>}
                  {capturing === action ? (
                    <button type="button" className="st-key-add st-key-add-armed" onClick={() => setCapturing(null)}>
                      press a key…
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="st-key-add"
                      title={`Add a key for ${ACTION_INFO[action].label}`}
                      onClick={() => {
                        setNote(null);
                        setCapturing(action);
                      }}
                    >
                      +
                    </button>
                  )}
                </Item>
              );
            })}
        </Group>
      ))}

      <Group>
        <Danger
          label="Reset to defaults"
          hint={changed === 0 ? "Unchanged from the defaults, which are ghosttown's." : `${changed} ${changed === 1 ? "key" : "keys"} changed.`}
          button="Reset"
          ask="Put every key back to its default?"
          disabled={changed === 0}
          onConfirm={() => api.resetKeys()}
        />
      </Group>
    </>
  );
}
