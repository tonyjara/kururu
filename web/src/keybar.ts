/**
 * The keys a phone keyboard does not have, as events rather than as bytes.
 *
 * A soft keyboard is a keyboard with the terminal half removed. There is no
 * escape, no tab, no control, no arrows — which between them are most of how
 * anybody drives an agent, since escape is how you take a turn back, tab is how
 * Claude Code cycles its modes, and up is how you get the last thing you typed.
 * Kururu's whole premise is that the phone is for watching and steering, and
 * steering with the keys that are missing is exactly the half that did not work.
 * So there is a toolbar, the way every ssh client on a phone has had one since
 * Prompt: `Keybar.tsx` draws it and this file is what a press means.
 *
 * **It sends a `KeyboardEvent`, not a byte, and that is the one decision in
 * here.** Encoding a key ourselves looks like the obvious thing — an up arrow
 * is `\x1b[A` and `session.input` takes a string — and it is wrong twice over.
 * An up arrow is `\x1b[A` only in normal cursor mode; in application mode,
 * which is what an agent TUI and vim and less all turn on, it is `\x1bOA`, and
 * a toolbar that sent the first would move the cursor in bash and do nothing at
 * all in the program people actually want the arrows for. ghostty-web already
 * answers this correctly — `handleKeyDown` asks the terminal for DECCKM and
 * tells its encoder — and it also already knows how ctrl and alt fold into a
 * key, which is a table nobody should own twice.
 *
 * The second reason is kururu's own. `App.tsx` listens for keys in the capture
 * phase on `window`, so an event dispatched at a pooled emulator passes the
 * prefix handler on the way down: `C-a` on the toolbar arms the mux exactly as
 * the chord does on a laptop, and every binding behind it — panes, tabs,
 * workspaces, zen — becomes reachable from a phone without this file knowing
 * that any of them exist. A byte written straight to the pty would have gone
 * *under* all of that and typed `\x01` at the shell.
 *
 * The cost of going through ghostty is that its `handleKeyDown` maps by
 * `event.code` and not by `event.key`, so a synthetic event has to carry a
 * plausible physical key — hence `codeFor`, and hence every entry in the table
 * naming one. That is also what makes the *soft* keyboard work under a latched
 * modifier: a phone reports `code: ""` for its own keys, so arming ctrl and
 * tapping `c` on the on-screen keyboard would otherwise encode nothing.
 */

/**
 * The two modifiers worth latching.
 *
 * Shift is deliberately not one of them. Every soft keyboard already has a
 * shift key that works, so a second one on the toolbar would be a control that
 * duplicates the row above it and disagrees with it half the time — and the one
 * shifted key that genuinely cannot be typed, shift+tab, is on the bar as
 * itself. Meta is missing for the opposite reason: nothing in a terminal wants
 * it, and in the browser it is the window manager's.
 */
export type Mod = "ctrl" | "alt";

/**
 * Off, armed for one key, or locked until it is pressed again.
 *
 * The middle state is the one that matters and the third is the one that had to
 * be argued for. Armed-then-consumed is what a modifier on a touch keyboard
 * means — you are composing one chord, and a modifier that stayed on after it
 * would turn the next thing you typed into something you did not ask for. But
 * `ctrl+w` twice is a real gesture, and so is walking a cursor with alt+arrow,
 * and a modifier you have to re-arm for each of those is one you stop using. So
 * a second tap locks it, a third clears it, and the button says which it is —
 * a latched mode that is not labelled is the thing that makes people distrust
 * modal interfaces, which is the same argument the PREFIX badge exists for.
 */
export type ModState = 0 | 1 | 2;

export type Mods = Record<Mod, ModState>;

export const NO_MODS: Mods = { ctrl: 0, alt: 0 };

export interface BarKey {
  /** Stable identity, since two keys may print the same glyph. */
  id: string;
  /** What the button says. */
  label: string;
  /** `KeyboardEvent.key`, which is what ghostty sends for a printable one. */
  key: string;
  /** `KeyboardEvent.code`. ghostty maps by this; see the header. */
  code: string;
  /** This button latches a modifier instead of sending anything. */
  mod?: Mod;
  /** Modifiers baked in, so a chord people reach for constantly is one tap. */
  with?: Mod[];
  /**
   * Bytes to write to the pty instead of dispatching an event, for the one key
   * where going through ghostty-web is known to produce the wrong answer.
   *
   * `handleKeyDown` has a shortcut path it takes whenever the modifiers are
   * none or shift *alone*, and that path maps TAB to a literal `\t` before the
   * encoder is ever reached — so shift+tab arrives at the program as an
   * ordinary tab, and the button would have been an expensive duplicate of the
   * one next to it. Every terminal since xterm sends CBT, `ESC [ Z`, and unlike
   * an arrow that is the same sequence in either cursor mode, so writing it
   * directly costs none of the correctness the header argues for. The escape
   * hatch is deliberately per key and deliberately this narrow: it is a
   * statement about one bug in one library, not a second encoder.
   *
   * What it does cost is the trip past `App.tsx`, so a key with `data` on it
   * cannot be a kururu binding and will not spend an armed prefix. Nothing that
   * needs one is in here.
   */
  data?: string;
  /**
   * Shift, which is baked in and never latched — see `Mod`. Only shift+tab
   * needs it: the shifted punctuation on the bar travels as its own character,
   * which is what ghostty sends for a key with no ctrl or alt on it.
   */
  shift?: boolean;
  /** Set on the ones with a word on them rather than a glyph. */
  wide?: boolean;
  /** Said out loud, for the ones whose label is a symbol. */
  title?: string;
}

/**
 * The bar, in the order it is drawn — which is the order it is *worth*, because
 * the row scrolls and everything past the right edge costs a swipe to reach.
 *
 * So the front of it is not a keyboard layout, it is a frequency list: the keys
 * with no other way in at all (escape, the modifiers, tab, the arrows), then
 * the two chords that are worth a button of their own, then the punctuation a
 * phone buries a page deep, then the things you can live without. Anything
 * reachable in one tap on the soft keyboard has to earn its place here against
 * the keys that are reachable in none, which is why there are no digits and
 * only a handful of symbols.
 */
export const KEYS: BarKey[] = [
  { id: "esc", label: "esc", key: "Escape", code: "Escape", wide: true, title: "Escape" },
  { id: "ctrl", label: "ctrl", key: "Control", code: "ControlLeft", mod: "ctrl", wide: true,
    title: "Control — tap to arm it for one key, twice to lock it" },
  { id: "alt", label: "alt", key: "Alt", code: "AltLeft", mod: "alt", wide: true,
    title: "Alt — tap to arm it for one key, twice to lock it" },
  { id: "tab", label: "⇥", key: "Tab", code: "Tab", title: "Tab" },
  { id: "left", label: "←", key: "ArrowLeft", code: "ArrowLeft", title: "Left" },
  { id: "down", label: "↓", key: "ArrowDown", code: "ArrowDown", title: "Down" },
  { id: "up", label: "↑", key: "ArrowUp", code: "ArrowUp", title: "Up" },
  { id: "right", label: "→", key: "ArrowRight", code: "ArrowRight", title: "Right" },

  /* The interrupt, and the mux. Both are ctrl chords that the latch above could
     express in two taps, and both are here as one because of how often they are
     wanted: ^C is how you stop a thing that is running away with itself, and
     C-a is the door onto every other key kururu has. */
  { id: "int", label: "^C", key: "c", code: "KeyC", with: ["ctrl"], title: "Interrupt" },
  { id: "prefix", label: "C-a", key: "a", code: "KeyA", with: ["ctrl"], wide: true,
    title: "The kururu prefix — panes, tabs and workspaces are behind it" },
  /* Worth a button because it is how Claude Code cycles its modes, which is
     about as central to steering an agent from a phone as anything gets. See
     `data` for why this one key does not go through the emulator. */
  { id: "shifttab", label: "⇧⇥", key: "Tab", code: "Tab", shift: true, data: "\x1b[Z",
    title: "Shift-Tab" },

  { id: "pipe", label: "|", key: "|", code: "Backslash", title: "Pipe" },
  { id: "tilde", label: "~", key: "~", code: "Backquote", title: "Tilde" },
  { id: "slash", label: "/", key: "/", code: "Slash", title: "Slash" },
  { id: "dash", label: "-", key: "-", code: "Minus", title: "Minus" },
  { id: "under", label: "_", key: "_", code: "Minus", title: "Underscore" },
  { id: "tick", label: "`", key: "`", code: "Backquote", title: "Backtick" },
  { id: "dollar", label: "$", key: "$", code: "Digit4", title: "Dollar" },

  { id: "eot", label: "^D", key: "d", code: "KeyD", with: ["ctrl"], title: "End of file" },
  { id: "susp", label: "^Z", key: "z", code: "KeyZ", with: ["ctrl"], title: "Suspend" },
  { id: "clear", label: "^L", key: "l", code: "KeyL", with: ["ctrl"], title: "Clear the screen" },
  { id: "rsearch", label: "^R", key: "r", code: "KeyR", with: ["ctrl"], title: "Search the history" },

  { id: "home", label: "home", key: "Home", code: "Home", wide: true, title: "Home" },
  { id: "end", label: "end", key: "End", code: "End", wide: true, title: "End" },
  { id: "pgup", label: "pgup", key: "PageUp", code: "PageUp", wide: true, title: "Page up" },
  { id: "pgdn", label: "pgdn", key: "PageDown", code: "PageDown", wide: true, title: "Page down" },
  { id: "del", label: "del", key: "Delete", code: "Delete", wide: true, title: "Forward delete" },
];

/**
 * Which physical key would have produced this character.
 *
 * ghostty's key handler switches on `event.code`, so this is what stands
 * between a latched ctrl and the on-screen keyboard: a phone reports no `code`
 * at all for its own keys, and an unmapped code makes `handleKeyDown` return
 * having sent nothing. Which is a particularly nasty failure to be handed,
 * because it is silent and it is *conditional* — plain typing goes down
 * ghostty's printable path, which reads `key` and works fine, so the bug would
 * only ever show up in the one gesture the toolbar exists for.
 *
 * A US layout, and knowingly. `code` is a position on a keyboard and the true
 * answer depends on the layout the phone is set to, which the browser will not
 * say; what makes the guess safe is that it is only ever consulted for a key
 * that is being *modified*, where the encoder wants somewhere to put the ctrl
 * and the character itself still travels in `utf8`. A French phone's `!` is a
 * different physical key and would encode alt+`!` from the wrong position, and
 * that is a fair trade against ctrl not working for anybody.
 */
export function codeFor(key: string): string {
  if (key.length !== 1) return "";
  const lower = key.toLowerCase();
  if (lower >= "a" && lower <= "z") return `Key${lower.toUpperCase()}`;
  if (key >= "0" && key <= "9") return `Digit${key}`;
  /* Both faces of each key, because a shifted character arrives as itself and
     the code is the unshifted position underneath it. */
  const punctuation: Record<string, string> = {
    "-": "Minus", _: "Minus",
    "=": "Equal", "+": "Equal",
    "[": "BracketLeft", "{": "BracketLeft",
    "]": "BracketRight", "}": "BracketRight",
    "\\": "Backslash", "|": "Backslash",
    ";": "Semicolon", ":": "Semicolon",
    "'": "Quote", '"': "Quote",
    "`": "Backquote", "~": "Backquote",
    ",": "Comma", "<": "Comma",
    ".": "Period", ">": "Period",
    "/": "Slash", "?": "Slash",
    " ": "Space",
    "!": "Digit1", "@": "Digit2", "#": "Digit3", $: "Digit4", "%": "Digit5",
    "^": "Digit6", "&": "Digit7", "*": "Digit8", "(": "Digit9", ")": "Digit0",
  };
  return punctuation[key] ?? "";
}

/**
 * The events this file made, so the listener that rewrites keys can tell its
 * own output from somebody's actual keyboard.
 *
 * A `WeakSet` rather than a flag set around the dispatch. Dispatch is
 * synchronous, so a flag would in fact work today and would keep working right
 * up until something in the path scheduled anything — and a re-entrancy guard
 * that is correct by timing rather than by construction is the kind that fails
 * once, in front of somebody, and cannot be reproduced. Marking the object
 * costs nothing and cannot be wrong.
 */
const synthetic = new WeakSet<KeyboardEvent>();

/** Did kururu make this event, rather than a keyboard? */
export function isSynthetic(event: KeyboardEvent): boolean {
  return synthetic.has(event);
}

/**
 * A keydown indistinguishable from a real one, to whoever is listening.
 *
 * `cancelable` because ghostty calls `preventDefault` on everything it handles,
 * and `bubbles` to match a real key — neither is what carries it past
 * `App.tsx`, since capturing listeners fire along the path whether or not an
 * event bubbles, but an event that lies about itself is one that behaves
 * differently the first time somebody adds a listener in the bubble phase.
 */
export function keyEvent(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  synthetic.add(event);
  return event;
}

/**
 * The modifier state after a key has been sent through it: armed is spent,
 * locked is not. The whole of the latch, kept here so that the rule lives next
 * to the type that states it rather than inside a click handler.
 */
export function consumed(mods: Mods): Mods {
  return { ctrl: mods.ctrl === 1 ? 0 : mods.ctrl, alt: mods.alt === 1 ? 0 : mods.alt };
}

/** Off → armed → locked → off. */
export function cycled(mods: Mods, mod: Mod): Mods {
  return { ...mods, [mod]: ((mods[mod] + 1) % 3) as ModState };
}

/** Is anything latched at all? Nothing is intercepted while nothing is. */
export function anyMod(mods: Mods): boolean {
  return mods.ctrl > 0 || mods.alt > 0;
}
