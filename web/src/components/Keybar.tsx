/**
 * The row of keys a phone keyboard is missing, above the one it has.
 *
 * What a press *means* is `web/src/keybar.ts` — this is the part you touch, and
 * nearly everything in here is about one problem: a toolbar over a soft keyboard
 * is a set of controls you tap while something else holds the focus, and the
 * browser's default answer to a tap is to move the focus to what you tapped. Do
 * nothing about it and the keyboard slides away on the first press of escape,
 * which is both useless and reads as the bar having crashed the page.
 *
 * So the focus is never allowed to move. `mousedown` is the event that moves it
 * — including on a phone, where it arrives synthesised after the touch — so
 * that is the one that is cancelled, and cancelling it is enough. The obvious
 * alternative, cancelling `pointerdown`, also works and was rejected: it is the
 * event a browser is deciding a *scroll* out of, and this row scrolls. Tying
 * the fix to the gesture it would have to fight is how you end up with a
 * toolbar that cannot be panned on one platform and cannot be tapped on
 * another.
 *
 * Which leaves when a press counts, and the answer is `pointerup` on the button
 * `pointerdown` started on. Not `click`, because a click is also what a drag
 * that ends on a button produces, and a bar you cannot scroll past without
 * sending an escape to an agent is worse than one that does not scroll. A pan
 * takes the pointer away and the browser sends `pointercancel`, which drops the
 * press — the gesture disambiguates itself, with no slop threshold to tune.
 *
 * The bar draws whatever terminal has the keyboard, and nothing at all while a
 * dialog is up, for the reason `Terminal.tsx` stops taking keys then: keys do
 * not reach a pty while something modal is over the window, and a row of keys
 * that silently did nothing would be worse than one that is not there.
 */
import { useEffect, useRef, useState } from "react";
import {
  anyMod,
  codeFor,
  consumed,
  cycled,
  isSynthetic,
  keyEvent,
  KEYS,
  NO_MODS,
  type BarKey,
  type Mods,
} from "../keybar";
import { isModifier } from "../keys";
import { input } from "../session";
import { sendKey } from "../terminals";

interface Props {
  /** The terminal the keyboard is pointed at, or null if there is none. */
  agentId: string | null;
  /** False while a dialog, Settings or the help overlay is up. */
  keyboard: boolean;
}

export function Keybar({ agentId, keyboard }: Props) {
  const [mods, setMods] = useState<Mods>(NO_MODS);
  /**
   * Which button the current gesture started on. A ref rather than state
   * alongside `held` below, because this one is read inside an event handler
   * and never drawn — keeping it in state would re-render the row on the way
   * down as well as on the way back up, to tell it something it does not paint.
   */
  const from = useRef<string | null>(null);
  /** The same press, as something to draw. See `from` for why they are two. */
  const [held, setHeld] = useState<string | null>(null);

  /**
   * A latch belongs to the terminal it was armed for. Carrying one across a tab
   * switch would put a ctrl on the first thing typed into a terminal somebody
   * had only just looked at, which is exactly the class of surprise the latch
   * being visible on the button is meant to rule out — and the button would be
   * telling the truth, about a pane that is no longer there.
   */
  useEffect(() => setMods(NO_MODS), [agentId]);

  /**
   * While a modifier is latched, the *soft* keyboard's keys go through it too.
   *
   * This is the half that makes the latch worth having. Arming ctrl and then
   * tapping `c` on the on-screen keyboard is how anybody would expect a
   * modifier to work, and without this the bar could only ever modify its own
   * twenty-odd keys — so every ctrl chord that is not on the bar would need a
   * button, which is a keyboard, which is the thing the phone already has.
   *
   * A `KeyboardEvent` cannot be edited on its way past, so the original is
   * stopped dead and a new one is dispatched in its place. `codeFor` is what
   * makes that possible at all: a phone reports no `code` for its own keys, and
   * ghostty's encoder is driven by `code` the moment a modifier is involved.
   *
   * `stopImmediatePropagation` rather than `stopPropagation`, because the
   * listener it has to get in front of — `App.tsx`'s prefix handler — is also a
   * capturing listener on `window`, and stopping the ordinary kind does nothing
   * about a listener on the same node. Which leaves one ordering this cannot
   * control: capturing listeners on one node fire in the order they were added,
   * so if the prefix is *also* armed at this moment, whichever of the two
   * registered first wins the key. That is two latched modes at once and it is
   * left alone deliberately — the fix is a shared key pipeline, which is a great
   * deal of machinery for a state nobody reaches by accident.
   */
  useEffect(() => {
    if (!agentId || !keyboard || !anyMod(mods)) return;
    const onKey = (event: KeyboardEvent) => {
      // Our own re-dispatch, on its way to the emulator. Letting this through is
      // what stops the rewrite being infinite.
      if (isSynthetic(event)) return;
      // A modifier pressed on its own is the first half of somebody's chord, not
      // a key to spend the latch on — the same reason `App.tsx` checks.
      if (isModifier(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      sendKey(
        agentId,
        keyEvent({
          key: event.key,
          code: event.code || codeFor(event.key),
          ctrlKey: event.ctrlKey || mods.ctrl > 0,
          altKey: event.altKey || mods.alt > 0,
          shiftKey: event.shiftKey,
        }),
      );
      setMods(consumed);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [agentId, keyboard, mods]);

  if (!agentId || !keyboard) return null;

  const press = (key: BarKey) => {
    if (key.mod) return setMods((current) => cycled(current, key.mod!));
    /* The one key that writes to the pty rather than going through the
       emulator, because the emulator gets it wrong. `BarKey.data` has the
       whole argument, and it stays a per-key exception rather than becoming a
       branch anybody is tempted to reuse. */
    if (key.data) {
      input(agentId, key.data);
      return setMods(consumed);
    }
    const baked = key.with ?? [];
    sendKey(
      agentId,
      keyEvent({
        key: key.key,
        code: key.code,
        ctrlKey: mods.ctrl > 0 || baked.includes("ctrl"),
        altKey: mods.alt > 0 || baked.includes("alt"),
        shiftKey: key.shift ?? false,
      }),
    );
    setMods(consumed);
  };

  return (
    <div className="keybar" role="toolbar" aria-label="Terminal keys">
      <div className="keybar-keys">
        {KEYS.map((key) => {
          const latch = key.mod ? mods[key.mod] : 0;
          return (
            <button
              key={key.id}
              type="button"
              className={[
                "keybar-key",
                key.wide ? "keybar-key-wide" : "",
                held === key.id ? "keybar-key-held" : "",
                latch === 1 ? "keybar-key-armed" : "",
                latch === 2 ? "keybar-key-locked" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              title={key.title ?? key.label}
              aria-label={key.title ?? key.label}
              /* A latched modifier is a mode, so it says so to a screen reader
                 as well as in the paint. The other keys are momentary and have
                 no pressed state to report. */
              aria-pressed={key.mod ? latch > 0 : undefined}
              /* The whole of the focus fix — see the header. */
              onMouseDown={(event) => event.preventDefault()}
              onPointerDown={() => {
                from.current = key.id;
                setHeld(key.id);
              }}
              onPointerUp={() => {
                if (from.current === key.id) press(key);
                from.current = null;
                setHeld(null);
              }}
              /* The browser taking the gesture for a scroll, or the finger
                 leaving the button before it came up. Both are somebody who did
                 not mean to press this. */
              onPointerCancel={() => {
                from.current = null;
                setHeld(null);
              }}
              onPointerLeave={() => {
                from.current = null;
                setHeld(null);
              }}
              /* A long press on a button is a context menu and a text selection
                 on most phones, and neither is anything somebody wants from a
                 key. */
              onContextMenu={(event) => event.preventDefault()}
              /* Nothing binds `click`, because a click is also how a drag that
                 happens to end on a button finishes. Which would leave this bar
                 unreachable from a keyboard on a tablet that has one — so the
                 one kind of click a pointer cannot produce is let through.
                 `detail` is 0 only for an activation that came from enter or
                 space. */
              onClick={(event) => {
                if (event.detail === 0) press(key);
              }}
            >
              {key.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
