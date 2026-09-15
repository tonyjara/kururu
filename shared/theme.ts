/**
 * What kururu looks like: one palette, covering both things that draw.
 *
 * This module exists because there were two palettes and they were kept in step
 * by hand. The chrome is CSS custom properties in `styles.css`; the terminal is
 * an object handed to ghostty, which paints into a canvas CSS cannot reach. A
 * comment at the top of the stylesheet used to say so and call it "the price of
 * a renderer CSS cannot reach" — and it was, right up until a *second* palette
 * was worth having, at which point the price stopped being one hand-sync and
 * started being one per theme forever. So a theme names both halves at once and
 * the two consumers are two readers of one record.
 *
 * A theme is a flat set of tokens rather than a scheme that derives them, and
 * that is the one decision in here worth defending. Deriving `--dim` from
 * `--text` by a lightness step is how you get a palette that is correct in the
 * abstract and wrong on the row it is actually drawn on; Catppuccin already did
 * the deriving, by hand, with eyes — `subtext0` is not `text` at 70%. What a
 * theme therefore does is *map* a palette somebody designed onto the handful of
 * jobs kururu has. The palette constants below are the published ones, verbatim,
 * so a flavour can be checked against its source rather than against taste.
 *
 * The user's choice is an **id**, not a copy of the tokens. That is the same
 * argument `shared/keys.ts` makes about storing the difference from the
 * defaults: a saved palette would freeze kururu's tokens at the version you
 * first opened Settings in, and a token added later — the way `--line-high` and
 * `--on-accent` were added the day this module landed — would be unset forever
 * for everybody who had ever picked a theme. An id cannot rot that way. It
 * follows that there is no per-token override here and that is deliberate: a
 * theme is picked, not edited, and a palette somebody wants to amend is a theme
 * that belongs in this list where every flavour of it gets the same treatment.
 *
 * Fonts and the cursor sit beside the theme rather than inside it, because they
 * are a different kind of decision and survive changing your mind about colour.
 * Nobody picks Macchiato and means "and 14px".
 */
import { DEFAULT_SKIN_ID, skinFor } from "./skin";


/**
 * The chrome, as `styles.css` asks for it.
 *
 * These are the names in `var(--…)`, camel-cased — `applyTheme` in
 * `web/src/theme.ts` does the one mechanical translation back. Kept as a record
 * with a key per job rather than per colour, so a theme is forced to answer
 * "what is a danger label here" rather than being allowed to leave it to
 * whatever the last theme happened to set.
 */
export interface UiTokens {
  /** The ground the pane grid sits on. Always the terminal's background too. */
  bg: string;
  /** Sidebar, tab strips, dialogs — everything that is not a terminal. */
  chrome: string;
  /** Hovered and selected chrome. */
  chromeHigh: string;
  /** Borders and rules. */
  line: string;
  /** A border that has been picked out: a focused pane, a focused input. */
  lineHigh: string;
  text: string;
  /** Bold text, and anything that wants to sit a step above `text`. */
  textStrong: string;
  dim: string;
  dimmer: string;
  accent: string;
  /**
   * Text on a bright fill — the accent button, the PREFIX badge, the resize
   * badge. One token for all three rather than one each: they are the same job,
   * and a theme that answered it three times would answer it three ways.
   */
  onAccent: string;

  /** The four agent states, and the fifth that is the absence of one. */
  idle: string;
  /**
   * Orange, and not the accent: "working" was once the same colour as every
   * focus ring and unread mark in the window, which made the one state worth
   * spotting the least distinguishable thing on the row. Warm enough to be told
   * apart from `blocked` above it at a glance.
   */
  working: string;
  blocked: string;
  done: string;
  exited: string;

  /** A destructive label — a close cross, a delete row. Text, not a fill. */
  danger: string;
  /** The one destructive *button*, which is a fill and needs its own pairing. */
  dangerBg: string;
  onDanger: string;

  /** Behind a dialog, and under a menu. Both carry alpha. */
  scrim: string;
  shadow: string;
}

/**
 * The terminal, as ghostty asks for it — `ITheme`, exactly, so it can be handed
 * over without a translation step that could quietly drop a slot.
 *
 * The ANSI mapping is the theme's business and the published Catppuccin ports
 * are followed rather than improved: normal and bright share a hue for the six
 * chromatic slots, which looks like an oversight and is the spec. An agent that
 * prints in bold red is printing Catppuccin red, and a flavour that invented a
 * brighter one would no longer be the thing on the tin.
 */
export interface TerminalTokens {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/**
 * The eight workspace tags, which are in the theme for the reason
 * `web/src/colors.ts` gives for existing at all: these sit on `--chrome` at a
 * few pixels wide, so they are chosen *against the chrome* rather than against
 * each other — and a palette chosen against one chrome is wrong on another. The
 * first two are `accent` and `done` exactly in every theme, so a tagged
 * workspace never introduces a colour the window did not already have.
 */
export type WorkspaceColorName =
  | "green"
  | "blue"
  | "amber"
  | "coral"
  | "violet"
  | "cyan"
  | "rose"
  | "lime";

export interface Theme {
  id: string;
  name: string;
  /**
   * Which way round this one is. Nothing in kururu reads it to *derive* a
   * colour — every token is named — but a light theme has to be able to say so
   * for the things outside the token system: `color-scheme`, which is what
   * makes a native scrollbar and a form control stop being dark, and the
   * emulator's own idea of what a default background is.
   */
  appearance: "dark" | "light";
  ui: UiTokens;
  terminal: TerminalTokens;
  workspace: Record<WorkspaceColorName, string>;
}

// ---------------------------------------------------------------------------
// Catppuccin
// ---------------------------------------------------------------------------

/**
 * The four flavours, as published. Copied verbatim and named by their own names
 * so the mapping below reads as the port it is — `base`, `mantle`, `surface0`
 * mean something to anybody who has themed anything else with these, and a
 * hex here would mean nothing to anybody.
 */
interface Catppuccin {
  rosewater: string;
  flamingo: string;
  pink: string;
  mauve: string;
  red: string;
  maroon: string;
  peach: string;
  yellow: string;
  green: string;
  teal: string;
  sky: string;
  sapphire: string;
  blue: string;
  lavender: string;
  text: string;
  subtext1: string;
  subtext0: string;
  overlay2: string;
  overlay1: string;
  overlay0: string;
  surface2: string;
  surface1: string;
  surface0: string;
  base: string;
  mantle: string;
  crust: string;
}

const MOCHA: Catppuccin = {
  rosewater: "#f5e0dc",
  flamingo: "#f2cdcd",
  pink: "#f5c2e7",
  mauve: "#cba6f7",
  red: "#f38ba8",
  maroon: "#eba0ac",
  peach: "#fab387",
  yellow: "#f9e2af",
  green: "#a6e3a1",
  teal: "#94e2d5",
  sky: "#89dceb",
  sapphire: "#74c7ec",
  blue: "#89b4fa",
  lavender: "#b4befe",
  text: "#cdd6f4",
  subtext1: "#bac2de",
  subtext0: "#a6adc8",
  overlay2: "#9399b2",
  overlay1: "#7f849c",
  overlay0: "#6c7086",
  surface2: "#585b70",
  surface1: "#45475a",
  surface0: "#313244",
  base: "#1e1e2e",
  mantle: "#181825",
  crust: "#11111b",
};

const MACCHIATO: Catppuccin = {
  rosewater: "#f4dbd6",
  flamingo: "#f0c6c6",
  pink: "#f5bde6",
  mauve: "#c6a0f6",
  red: "#ed8796",
  maroon: "#ee99a0",
  peach: "#f5a97f",
  yellow: "#eed49f",
  green: "#a6da95",
  teal: "#8bd5ca",
  sky: "#91d7e3",
  sapphire: "#7dc4e4",
  blue: "#8aadf4",
  lavender: "#b7bdf8",
  text: "#cad3f5",
  subtext1: "#b8c0e0",
  subtext0: "#a5adcb",
  overlay2: "#939ab7",
  overlay1: "#8087a2",
  overlay0: "#6e738d",
  surface2: "#5b6078",
  surface1: "#494d64",
  surface0: "#363a4f",
  base: "#24273a",
  mantle: "#1e2030",
  crust: "#181926",
};

const FRAPPE: Catppuccin = {
  rosewater: "#f2d5cf",
  flamingo: "#eebebe",
  pink: "#f4b8e4",
  mauve: "#ca9ee6",
  red: "#e78284",
  maroon: "#ea999c",
  peach: "#ef9f76",
  yellow: "#e5c890",
  green: "#a6d189",
  teal: "#81c8be",
  sky: "#99d1db",
  sapphire: "#85c1dc",
  blue: "#8caaee",
  lavender: "#babbf1",
  text: "#c6d0f5",
  subtext1: "#b5bfe2",
  subtext0: "#a5adce",
  overlay2: "#949cbb",
  overlay1: "#838ba7",
  overlay0: "#737994",
  surface2: "#626880",
  surface1: "#51576d",
  surface0: "#414559",
  base: "#303446",
  mantle: "#292c3c",
  crust: "#232634",
};

const LATTE: Catppuccin = {
  rosewater: "#dc8a78",
  flamingo: "#dd7878",
  pink: "#ea76cb",
  mauve: "#8839ef",
  red: "#d20f39",
  maroon: "#e64553",
  peach: "#fe640b",
  yellow: "#df8e1d",
  green: "#40a02b",
  teal: "#179299",
  sky: "#04a5e5",
  sapphire: "#209fb5",
  blue: "#1e66f5",
  lavender: "#7287fd",
  text: "#4c4f69",
  subtext1: "#5c5f77",
  subtext0: "#6c6f85",
  overlay2: "#7c7f93",
  overlay1: "#8c8fa1",
  overlay0: "#9ca0b0",
  surface2: "#acb0be",
  surface1: "#bcc0cc",
  surface0: "#ccd0da",
  base: "#eff1f5",
  mantle: "#e6e9ef",
  crust: "#dce0e8",
};

/**
 * One flavour, mapped onto kururu's jobs.
 *
 * Two mappings here are choices rather than transcription and are worth naming.
 *
 * `bg` is `base` and `chrome` is `mantle`, which puts the chrome *darker* than
 * the ground — the reverse of what kururu's own palette does. That is
 * Catppuccin's own convention (it is what its VS Code and Zed ports do with a
 * sidebar) and it is also right here for a reason of kururu's: `bg` is the
 * terminal background as well, so tying it to `base` is what makes a pane and
 * the emulator inside it one surface instead of two that nearly match.
 *
 * `accent` is `green` rather than `mauve`, which is Catppuccin's signature. The
 * accent is load-bearing in a way a brand colour is not: it is the focus ring,
 * the unread mark, the first workspace tag, and the terminal cursor, and it has
 * been green in every screenshot of this app. Wearing Catppuccin is not the same
 * as becoming it — and there is a frog.
 *
 * `onAccent` is `crust` on the dark flavours and `base` on Latte, and that
 * asymmetry is the whole reason a light theme was worth shipping: every token
 * that reads "the dark one" was hardcoded to a near-black before this, and
 * Latte is what found them.
 */
function catppuccin(id: string, name: string, p: Catppuccin, appearance: "dark" | "light"): Theme {
  const dark = appearance === "dark";
  return {
    id,
    name,
    appearance,
    ui: {
      bg: p.base,
      chrome: p.mantle,
      chromeHigh: p.surface0,
      line: p.surface1,
      lineHigh: p.surface2,
      text: p.text,
      // `text` is the end of Catppuccin's neutral ramp in both directions —
      // there is nothing lighter on a dark flavour and nothing darker on Latte,
      // by design — so emphasis here comes from weight rather than from a step
      // this palette deliberately does not offer. Kururu's own theme, which has
      // one, still uses it.
      textStrong: p.text,
      dim: p.subtext0,
      dimmer: p.overlay0,
      accent: p.green,
      onAccent: dark ? p.crust : p.base,

      idle: p.overlay1,
      working: p.peach,
      blocked: p.yellow,
      done: p.blue,
      exited: p.surface2,

      danger: p.red,
      dangerBg: p.red,
      onDanger: dark ? p.crust : p.base,

      // Alpha, and the one place a theme cannot name a palette entry: a scrim
      // over a light window has to be a light window's scrim or the dialog
      // reads as a modal over a photograph.
      scrim: dark ? "rgba(0, 0, 0, 0.5)" : "rgba(76, 79, 105, 0.28)",
      shadow: dark ? "rgba(0, 0, 0, 0.5)" : "rgba(76, 79, 105, 0.18)",
    },
    terminal: {
      background: p.base,
      foreground: p.text,
      cursor: p.green,
      cursorAccent: p.base,
      selectionBackground: p.surface2,
      // The published ANSI port. Normal and bright share a hue on the six
      // chromatic slots; see `TerminalTokens`.
      black: p.surface1,
      red: p.red,
      green: p.green,
      yellow: p.yellow,
      blue: p.blue,
      magenta: p.pink,
      cyan: p.teal,
      white: p.subtext1,
      brightBlack: p.surface2,
      brightRed: p.red,
      brightGreen: p.green,
      brightYellow: p.yellow,
      brightBlue: p.blue,
      brightMagenta: p.pink,
      brightCyan: p.teal,
      brightWhite: p.subtext0,
    },
    workspace: {
      // `accent` and `done` exactly, then six more that are already in the
      // flavour rather than chosen beside it. The names are wire slots — the
      // server stores one of `WORKSPACE_COLORS` and nothing else — so each takes
      // the nearest published accent. `lime` is the one that bends furthest,
      // because Catppuccin publishes no yellow-green and inventing one would
      // make this a palette that is nearly the thing on the tin.
      green: p.green,
      blue: p.blue,
      amber: p.yellow,
      coral: p.peach,
      violet: p.mauve,
      cyan: p.sky,
      rose: p.pink,
      lime: p.teal,
    },
  };
}

// ---------------------------------------------------------------------------
// Kururu's own
// ---------------------------------------------------------------------------

/**
 * The palette kururu had before it had a choice, kept so that picking it changes
 * nothing. Every value here is one that was already in `styles.css`,
 * `terminals.ts` or `colors.ts` — this theme is those three files, gathered.
 */
const KURURU: Theme = {
  id: "kururu",
  name: "Kururu",
  appearance: "dark",
  ui: {
    bg: "#0d0f0e",
    chrome: "#141817",
    chromeHigh: "#1b201e",
    line: "#242b28",
    lineHigh: "#33413a",
    text: "#d7dbd8",
    textStrong: "#eef1ef",
    dim: "#7c857f",
    dimmer: "#565e59",
    accent: "#7fd6a2",
    onAccent: "#06100b",

    idle: "#6b736e",
    working: "#ff9f43",
    blocked: "#e3c46a",
    done: "#7aa6da",
    exited: "#4a524d",

    danger: "#ff8a80",
    dangerBg: "#b3453c",
    onDanger: "#ffffff",

    scrim: "rgba(0, 0, 0, 0.5)",
    shadow: "rgba(0, 0, 0, 0.5)",
  },
  terminal: {
    background: "#0d0f0e",
    foreground: "#d7dbd8",
    cursor: "#7fd6a2",
    cursorAccent: "#0d0f0e",
    selectionBackground: "#2b3a33",
    black: "#1b1f1d",
    red: "#e57373",
    green: "#7fd6a2",
    yellow: "#e3c46a",
    blue: "#7aa6da",
    magenta: "#c28fd8",
    cyan: "#77c8c8",
    white: "#c8cec9",
    brightBlack: "#5a635e",
    brightRed: "#ff8a80",
    brightGreen: "#9bf0bd",
    brightYellow: "#ffdd8a",
    brightBlue: "#9cc3f0",
    brightMagenta: "#dbabef",
    brightCyan: "#96e5e5",
    brightWhite: "#f0f3f1",
  },
  workspace: {
    green: "#7fd6a2",
    blue: "#7aa6da",
    amber: "#e3c46a",
    coral: "#e08f7a",
    violet: "#b49ae0",
    cyan: "#74c7c4",
    rose: "#dd8fae",
    lime: "#b5cf7a",
  },
};

/**
 * Every theme, in the order Settings lists them. Mocha first because it is the
 * default, and the default is Catppuccin rather than kururu's own green on
 * purpose — the green was never chosen so much as arrived at, and the thing a
 * new window should open in is the one somebody designed.
 */
export const THEMES: readonly Theme[] = [
  catppuccin("catppuccin-mocha", "Catppuccin Mocha", MOCHA, "dark"),
  catppuccin("catppuccin-macchiato", "Catppuccin Macchiato", MACCHIATO, "dark"),
  catppuccin("catppuccin-frappe", "Catppuccin Frappé", FRAPPE, "dark"),
  catppuccin("catppuccin-latte", "Catppuccin Latte", LATTE, "light"),
  KURURU,
];

export const DEFAULT_THEME_ID = "catppuccin-mocha";

/**
 * The theme for an id, falling back rather than refusing.
 *
 * An id naming nothing is what a downgrade looks like — a config written by a
 * version that had a flavour this one does not — and the right answer to that is
 * the default, drawn, rather than a window with no colours in it. It is the same
 * call `mascotFor` makes about a deleted mascot, for the same reason: the
 * fallback *is* the answer, so there is nothing a check would buy.
 */
export function themeFor(id: string | null | undefined): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_THEME_ID) ?? THEMES[0]!;
}

// ---------------------------------------------------------------------------
// The terminal's type
// ---------------------------------------------------------------------------

export type CursorStyle = "block" | "bar" | "underline";

export const CURSOR_STYLES: readonly CursorStyle[] = ["block", "bar", "underline"];

/**
 * How big a terminal's type may be.
 *
 * A range rather than a free number because this one has teeth: the font size
 * decides the cell size, the cell size decides the grid the pane proposes, and
 * the grid is what the pty is resized to. A `0` typed into a number box would
 * propose a grid of some enormous number of columns and SIGWINCH every agent
 * watching into it. Clamped rather than refused, on `adoptMascot`'s reasoning —
 * a number dragged too far is a slider dragged too far, and the nearest legal
 * value is what was meant.
 */
export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 32;
export const DEFAULT_FONT_SIZE = 12;

/**
 * The type a terminal is set in, and the shape of its cursor.
 *
 * Beside the theme rather than in it, because they outlive a change of mind
 * about colour: nobody picks Macchiato and means "and 14px". Server-owned like
 * the theme, which means one font size for the desktop and the phone — and that
 * is correct rather than merely simple, because the size policy is already
 * `smallest` over the clients that can see a terminal (`server/src/sizing.ts`).
 * A phone at 16px proposes fewer columns and the pty follows it; the desktop is
 * then drawing the same grid the phone is, which is the whole point of that
 * policy and not a side effect to be worked around here.
 */
export interface TerminalAppearance {
  /**
   * A face to put in front of the built-in stack, or empty for the stack alone.
   *
   * Prepended rather than replacing, and that is what makes this setting safe to
   * offer: the built-in stack ends in four patched Nerd Font faces that exist so
   * an agent TUI's devicons and powerline separators are not tofu, and a user
   * who names "Berkeley Mono" has not said anything about wanting those to stop
   * working. It does change the grid metrics, because the cell is measured from
   * the first face — which is exactly what somebody choosing a font is asking
   * for, and the reason the built-in faces are *appended* in `terminals.ts`.
   */
  fontFamily: string;
  fontSize: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
}

/**
 * Everything about how kururu looks, as one saved decision.
 *
 * One file rather than two — `~/.config/kururu/appearance.json` — because these
 * are one subject and a person changing them is on one page. `keys.json` is
 * separate for the opposite reason: a keyboard is not a look.
 */
export interface Appearance {
  themeId: string;
  /**
   * Which *shape* the window is, independent of which colours it is in.
   *
   * Beside `themeId` rather than inside the theme because the two axes are
   * orthogonal — see the header of `shared/skin.ts` — and the test of that is
   * that both crossings are things somebody wants: an eight-bit chrome in
   * Catppuccin, and rounded chrome in an eight-bit palette. An id rather than
   * the tokens, for the reason every other saved decision in kururu is an id.
   */
  skinId: string;
  terminal: TerminalAppearance;
}

export const DEFAULT_APPEARANCE: Appearance = {
  themeId: DEFAULT_THEME_ID,
  skinId: DEFAULT_SKIN_ID,
  terminal: {
    fontFamily: "",
    fontSize: DEFAULT_FONT_SIZE,
    cursorStyle: "block",
    cursorBlink: true,
  },
};

/**
 * Whatever arrived, made into something that can be drawn.
 *
 * It arrives from two places that deserve the same suspicion: a file somebody
 * may have edited by hand, and a client message, which on this app may have come
 * from a phone on the tailnet. Numbers are clamped and enumerations fall back,
 * which is `adoptMascot`'s split and drawn on the same line — a number out of
 * range has a nearest legal value and a *name* does not, so one bends and the
 * other falls back to the default.
 *
 * `fontFamily` is the one free string, and it ends up in a CSS `font-family`,
 * so it is stripped of the two characters that could end the declaration and
 * start another. It is not a name from a list because the list is the fonts on
 * somebody's machine and the server has no way to know them.
 */
export function adoptAppearance(value: unknown): Appearance {
  const raw = (value ?? {}) as { themeId?: unknown; skinId?: unknown; terminal?: unknown };
  const term = (raw.terminal ?? {}) as Partial<Record<keyof TerminalAppearance, unknown>>;
  const d = DEFAULT_APPEARANCE.terminal;
  return {
    themeId: themeFor(typeof raw.themeId === "string" ? raw.themeId : null).id,
    skinId: skinFor(typeof raw.skinId === "string" ? raw.skinId : null).id,
    terminal: {
      fontFamily: adoptFontFamily(term.fontFamily),
      fontSize: clampFontSize(term.fontSize),
      cursorStyle: CURSOR_STYLES.includes(term.cursorStyle as CursorStyle)
        ? (term.cursorStyle as CursorStyle)
        : d.cursorStyle,
      cursorBlink: typeof term.cursorBlink === "boolean" ? term.cursorBlink : d.cursorBlink,
    },
  };
}

function clampFontSize(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : DEFAULT_FONT_SIZE;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, n));
}

function adoptFontFamily(value: unknown): string {
  if (typeof value !== "string") return "";
  // `;` and `}` are the two that could close this declaration and open a rule of
  // somebody else's choosing; quotes go because the name is quoted on the way
  // out and a quote inside would end that quoting early.
  return value.replace(/[;}"'<>]/g, "").trim().slice(0, 120);
}
