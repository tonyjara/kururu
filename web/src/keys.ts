/**
 * The prefix keymap: ghosttown's, in a browser.
 *
 * A multiplexer cannot have plain shortcuts, because every key belongs to the
 * program in the pane. tmux solved this in 1997 and the solution has not been
 * improved on: one chord arms the mux, the next key is a command, and everything
 * else goes to the pty untouched. Press the chord twice to send it literally,
 * which is what makes ctrl+a still reachable inside readline.
 *
 * The table below is deliberately the same as `config.default.toml` in
 * ghosttown, key for key, because the whole value of a prefix is that your hands
 * already know it. Where kururu has no equivalent (detach, reboot, the markdown
 * reader) the key is simply unbound rather than given a different meaning — a
 * key that does something *else* in the sibling app is worse than one that does
 * nothing. `A` is unbound for the same reason from the other direction: it
 * opened an agent rather than a terminal, and there is only one kind of thing to
 * open now.
 *
 * `]` and `[` are the one deliberate addition: they split right and down beside
 * the shifted `|` and `-` they sit under on the keyboard, which is the pair of
 * splits without the reach for shift. They are safe to add precisely because
 * ghosttown leaves them unbound — this gives a key a meaning where the sibling
 * app has none, which is the opposite of the case the rule above forbids.
 *
 * The ⌘ shortcuts still work; they are a second door, not a replacement. This
 * file is only about the prefixed half.
 */

/**
 * The chord, and the byte it sends when you press it twice. One constant rather
 * than a config file: kururu has no config system yet, and inventing one for a
 * single value would be the wrong first user of it.
 */
export const PREFIX = { ctrl: true, key: "a" } as const;
/** ctrl+a is 0x01 — the C0 control the terminal expects for it. */
export const PREFIX_BYTE = String.fromCharCode(PREFIX.key.charCodeAt(0) - 96);
export const PREFIX_LABEL = "C-a";

/** How long the prefix stays armed. Ghosttown's number, for the same reason. */
export const PREFIX_TIMEOUT_MS = 3000;

export type Action =
  | "split-right"
  | "split-down"
  | "new-tab"
  | "next-tab"
  | "prev-tab"
  | "close-tab"
  | "rename-tab"
  | "close-pane"
  | "focus-left"
  | "focus-right"
  | "focus-up"
  | "focus-down"
  | "toggle-sidebar"
  | "zen-mode"
  | "resize-mode"
  | "switch-profile"
  | "new-profile"
  | "new-workspace"
  | "next-workspace"
  | "prev-workspace"
  | "last-workspace"
  | "rename-workspace"
  | "delete-workspace"
  | "find-workspace"
  | "find-agent"
  | "reload"
  | "restart-server"
  | "help";

/**
 * Key → action. An uppercase letter means shift, exactly as in ghosttown's
 * config, and the destructive ones are shifted for exactly that reason.
 */
export const KEYMAP: Record<string, Action> = {
  "|": "split-right",
  "\\": "split-right",
  "%": "split-right",
  "]": "split-right",
  "-": "split-down",
  '"': "split-down",
  "[": "split-down",
  T: "new-tab",
  n: "next-tab",
  p: "prev-tab",
  D: "close-tab",
  ",": "rename-tab",
  x: "close-pane",
  h: "focus-left",
  left: "focus-left",
  l: "focus-right",
  right: "focus-right",
  k: "focus-up",
  up: "focus-up",
  j: "focus-down",
  down: "focus-down",
  b: "toggle-sidebar",
  m: "zen-mode",
  r: "resize-mode",
  s: "switch-profile",
  S: "new-profile",
  C: "new-workspace",
  N: "next-workspace",
  P: "prev-workspace",
  z: "last-workspace",
  W: "rename-workspace",
  X: "delete-workspace",
  w: "find-workspace",
  a: "find-agent",
  R: "reload",
  B: "restart-server",
  "?": "help",
};

/** What the help overlay prints, in the order it prints it. */
export const HELP: Array<[string, string]> = [
  ["| \\ % ]", "split right"],
  ["- \" [", "split down"],
  ["T", "new terminal"],
  ["n p", "next / previous tab"],
  ["D", "close tab (ends it)"],
  [",", "rename tab"],
  ["x", "close pane and everything in it"],
  ["h j k l", "focus pane left / down / up / right"],
  ["1…9", "jump to workspace"],
  ["C", "new workspace"],
  ["N P", "next / previous workspace"],
  ["z", "last workspace (a toggle)"],
  ["W X", "rename / delete workspace"],
  ["w a", "find workspace / agent"],
  ["s S", "switch / new profile"],
  ["r", "resize mode — then h j k l, esc to leave"],
  ["m", "zen mode"],
  ["b", "toggle sidebar"],
  ["R", "reload the window"],
  ["B", "restart the server (agents keep running)"],
  ["?", "this"],
];

/**
 * A browser KeyboardEvent, as one string the table can be looked up by.
 *
 * `event.key` already folds shift into the character — shift+t arrives as "T",
 * shift+\ as "|" — which is why the table can be written the way ghosttown's
 * config is and why there is no separate shift flag to get wrong.
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

export function actionFor(event: KeyboardEvent): Action | undefined {
  return KEYMAP[keyName(event)];
}

/** prefix+1..9. Returns a zero-based workspace index, or null. */
export function workspaceDigit(event: KeyboardEvent): number | null {
  const key = keyName(event);
  return /^[1-9]$/.test(key) ? Number(key) - 1 : null;
}
