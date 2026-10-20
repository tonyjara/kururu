/**
 * The prefix keymap: ghosttown's, in a browser.
 *
 * A multiplexer cannot have plain shortcuts, because every key belongs to the
 * program in the pane. tmux solved this in 1997 and the solution has not been
 * improved on: one chord arms the mux, the next key is a command, and everything
 * else goes to the pty untouched. Press the chord twice to send it literally,
 * which is what makes ctrl+a still reachable inside readline.
 *
 * The table itself moved to `shared/keys.ts` when the keys became rebindable —
 * an override arrives from a client and the server has to validate it against
 * the list of actions, so both halves need the list. What is left in here is the
 * half that cannot move: turning a `KeyboardEvent` into something that table can
 * be looked up by.
 *
 * The ⌘ shortcuts still work; they are a second door, not a replacement. This
 * file is only about the prefixed half.
 */
import type { Action } from "../../shared/keys";

export type { Action };

/**
 * The chord, and the byte it sends when you press it twice.
 *
 * Not rebindable, unlike everything after it. The prefix is the one key that has
 * to be reachable to fix a keyboard you have broken, and a chord you have bound
 * to something unreachable is a window you can only fix by editing JSON — which
 * is the failure mode the whole settings page exists to avoid.
 */
export const PREFIX = { ctrl: true, key: "a" } as const;
/** ctrl+a is 0x01 — the C0 control the terminal expects for it. */
export const PREFIX_BYTE = String.fromCharCode(PREFIX.key.charCodeAt(0) - 96);
export const PREFIX_LABEL = "C-a";

/** How long the prefix stays armed. Ghosttown's number, for the same reason. */
export const PREFIX_TIMEOUT_MS = 3000;

/**
 * A browser KeyboardEvent, as one string the table can be looked up by.
 *
 * `event.key` already folds shift into the character — shift+t arrives as "T",
 * shift+\ as "|" — which is why the table can be written the way ghosttown's
 * config is and why there is no separate shift flag to get wrong. It is also why
 * a rebinding needs no encoding of its own: what Settings captures is this
 * string, and what it stores is this string.
 */
export function keyName(event: KeyboardEvent): string {
  const named: Record<string, string> = {
    ArrowLeft: "left",
    ArrowRight: "right",
    ArrowUp: "up",
    ArrowDown: "down",
    Escape: "escape",
    Enter: "enter",
    Backspace: "backspace",
    Tab: "tab",
    " ": "space",
  };
  return named[event.key] ?? event.key;
}

/** How a key is printed where somebody reads it back. */
export function keyLabel(key: string): string {
  const arrows: Record<string, string> = { left: "←", right: "→", up: "↑", down: "↓" };
  return arrows[key] ?? (key === "space" ? "space" : key);
}

/**
 * Shift, control, alt and the rest each raise a `keydown` of their own, before
 * the key they modify raises its. None of them is ever a command here.
 *
 * This matters more than it sounds, because an armed prefix is spent on the
 * *next* keydown whatever that key turns out to be. Treating a lone modifier as
 * simply "a key that is not in the table" spends the prefix on it, so reaching
 * for any shifted binding — T, D, C, W, X, |, %, ? — disarmed the prefix before
 * the letter itself ever arrived. Which is most of the destructive ones, and all
 * of the ones people reach for deliberately.
 */
const MODIFIERS = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "AltGraph",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "Fn",
  "FnLock",
  "Hyper",
  "Super",
  "Symbol",
  "SymbolLock",
]);

/** True for a modifier pressed on its own — the first half of a chord. */
export function isModifier(event: KeyboardEvent): boolean {
  return MODIFIERS.has(event.key);
}

export function isPrefix(event: KeyboardEvent): boolean {
  return event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === PREFIX.key;
}

/**
 * ⌘, and ⌘. — the two drawers, Kuru and what needs you, open or shut, with no
 * prefix. The comma and the period sit side by side, the way `a` and `i` do
 * not, so the pair of drawers is a pair of neighbouring keys.
 *
 * ⌘, is the key every Mac app gives its Settings, taken for Kuru because the
 * drawer is what gets reached for and Settings is not; Settings stays on the
 * prefix's `g`. ⌘. is a Cocoa dialog's cancel and Terminal.app's interrupt,
 * and neither is anything here: the page has no Cocoa sheet, and ghostty-web
 * never made it ^C — interrupt in a pane is ctrl+c. Nothing else in kururu
 * had either key, and the Electron menu's app section is the stock role, which
 * binds no Preferences item, so taking them moved nothing. Shift and option
 * are refused so that ⇧⌘, and ⌥⌘. stay free for whatever wants them.
 *
 * Not in the rebindable table, which is what follows the prefix: a key there
 * is one character with no modifiers, and a chord would need a grammar of its
 * own on both halves for the sake of two entries.
 */
export function drawerChord(event: KeyboardEvent): "open-harness" | "open-needs" | null {
  if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  if (event.key === ",") return "open-harness";
  if (event.key === ".") return "open-needs";
  return null;
}

/**
 * What this key does, in the keymap this window is currently using. The map is
 * passed in rather than read from a module constant because it is the user's
 * now, and the user's things live in the snapshot.
 */
export function actionFor(event: KeyboardEvent, keymap: Record<string, Action>): Action | undefined {
  return keymap[keyName(event)];
}

/**
 * prefix+1..9. Returns a zero-based workspace index, or null.
 *
 * Nine bindings to one parameterised action, which is why it is not in the table
 * and not rebindable — and why `isBindableKey` refuses those digits, so nothing
 * in Settings can take a workspace out of reach.
 */
export function workspaceDigit(event: KeyboardEvent): number | null {
  const key = keyName(event);
  return /^[1-9]$/.test(key) ? Number(key) - 1 : null;
}
