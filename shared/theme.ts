/**
 * What kururu looks like, for the half CSS cannot reach: the terminal.
 *
 * Kururu has one look. It had a theme registry, skins, packs and a studio, and
 * all of that was taken out on 2026-11-09 so the look could be started again
 * from one set of values with nothing to keep in step. The chrome's colours and
 * shape are plain custom properties in the `:root` block of
 * `web/src/styles.css`; this module holds what cannot live there, because the
 * emulator paints into a canvas: the terminal's palette, handed to ghostty as
 * an object in `web/src/terminals.ts`.
 *
 * The two halves are kept in step by hand, and with one palette that is a
 * fair price: `TERMINAL.background` is `--bg`, and the rest of the ANSI set is
 * the published Dracula one, which is where the chrome's colours came from.
 *
 * What a person may still change is the terminal's type and cursor, the face
 * and the size the interface is set in, and the bottom bar's chips:
 * preferences, not a look. They are the `Appearance` at the foot, saved in
 * `~/.config/kururu/appearance.json`.
 */
import { adoptBar, DEFAULT_BAR, type BarSettings } from "./statusbar";

/**
 * The terminal, as ghostty asks for it: `ITheme`, exactly, so it can be handed
 * over without a translation step that could quietly drop a slot.
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
 * The palette every terminal is built with. Dracula's published ANSI set,
 * verbatim, with the cursor in the chrome's accent. A constant because
 * ghostty-vt resolves colour inside the wasm as it parses, so a terminal's
 * palette is settled when it is made and nothing here ever changes it.
 */
export const TERMINAL: TerminalTokens = {
  background: "#282a36",
  foreground: "#f8f8f2",
  cursor: "#50fa7b",
  cursorAccent: "#282a36",
  selectionBackground: "#44475a",
  black: "#21222c",
  red: "#ff5555",
  green: "#50fa7b",
  yellow: "#f1fa8c",
  blue: "#bd93f9",
  magenta: "#ff79c6",
  cyan: "#8be9fd",
  white: "#f8f8f2",
  brightBlack: "#6272a4",
  brightRed: "#ff6e6e",
  brightGreen: "#69ff94",
  brightYellow: "#ffffa5",
  brightBlue: "#d6acff",
  brightMagenta: "#ff92df",
  brightCyan: "#a4ffff",
  brightWhite: "#ffffff",
};

/**
 * The fourteen tag colours board columns wear, by name; the values are
 * `--ws-<name>` in the stylesheet. Named for the workspaces that wore them
 * first (see `WORKSPACE_COLORS`). The order is the picker's, and it is a
 * spectrum: warm through to cool.
 */
export type WorkspaceColorName =
  | "green"
  | "amber"
  | "sand"
  | "coral"
  | "red"
  | "brick"
  | "blush"
  | "rose"
  | "violet"
  | "lavender"
  | "azure"
  | "blue"
  | "cyan"
  | "lime";

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
 * Server-owned, which means one font size for the desktop and the phone — and that
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

// ---------------------------------------------------------------------------
// The interface's type
// ---------------------------------------------------------------------------

/**
 * How big the interface's type may be: the size of running text, which the
 * stylesheet calls `--fs-lg`, with the rest of the ramp scaled round it.
 *
 * A narrower range than the terminal's, because this one scales a layout
 * rather than a grid: under 11 the smallest step of the ramp is under eight
 * pixels and stops being type, and over 18 a strip of tabs is a third of a
 * small pane. Clamped rather than refused, on `MIN_FONT_SIZE`'s reasoning.
 */
export const MIN_UI_FONT_SIZE = 11;
export const MAX_UI_FONT_SIZE = 18;
export const DEFAULT_UI_FONT_SIZE = 13;

/**
 * The type kururu's own interface is set in: the sidebar, the boards, the
 * drawers, the reader, Settings. Everything that is not a terminal, which
 * has its own above.
 *
 * Server-owned like the terminal's, so one choice for the desktop and the
 * phone. It reaches the page as two custom properties on the root and nothing
 * else (`applyInterface` in `web/src/fonts.ts`): `--ui-font`, which goes in
 * front of the system's stack, and `--ui-scale`, the size over the default.
 */
export interface InterfaceAppearance {
  /** A face to put in front of the system's, or empty for the system's alone. */
  fontFamily: string;
  fontSize: number;
}

/**
 * What a person may change about how kururu looks, as one saved decision:
 * `~/.config/kururu/appearance.json`. The colours and the shape are not in
 * it; there is one look and it is the stylesheet's.
 */
export interface Appearance {
  terminal: TerminalAppearance;
  /**
   * Absent in a snapshot from a server older than 2026-11-10 — another node's,
   * say — which is why a page reads it through `interfaceOf`.
   */
  ui: InterfaceAppearance;
  /**
   * Which of the bottom bar's chips are drawn — see `shared/statusbar.ts`. In
   * here rather than a file of its own because it is what the window looks
   * like and nothing more.
   */
  bar: BarSettings;
}

export const DEFAULT_APPEARANCE: Appearance = {
  terminal: {
    fontFamily: "",
    fontSize: DEFAULT_FONT_SIZE,
    cursorStyle: "block",
    cursorBlink: true,
  },
  ui: {
    fontFamily: "",
    fontSize: DEFAULT_UI_FONT_SIZE,
  },
  bar: DEFAULT_BAR,
};

/** The interface's type out of an appearance that may predate it. */
export function interfaceOf(appearance: Partial<Appearance> | null | undefined): InterfaceAppearance {
  return appearance?.ui ?? DEFAULT_APPEARANCE.ui;
}

/**
 * The interface's size as the stylesheet wants it: a factor on the ramp it
 * was written at. Rounded to a thousandth so the same size is always the same
 * string on the root, and a snapshot that changed nothing writes nothing.
 */
export function interfaceScale(ui: InterfaceAppearance): number {
  return Math.round((clampUiFontSize(ui.fontSize) / DEFAULT_UI_FONT_SIZE) * 1000) / 1000;
}

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
 * somebody's machine and the server has no way to know them — the client
 * enumerates them and offers a dropdown, which is a different question from what
 * is *valid*, and this is the one that has to hold for a hand-edited file.
 *
 * A `themeId` or `skinId` in a file from before 2026-11-09 is not read and is
 * dropped the next time the file is written.
 */
export function adoptAppearance(value: unknown): Appearance {
  const raw = (value ?? {}) as { terminal?: unknown; ui?: unknown; bar?: unknown };
  const ui = (raw.ui ?? {}) as Partial<Record<keyof InterfaceAppearance, unknown>>;
  const term = (raw.terminal ?? {}) as Partial<Record<keyof TerminalAppearance, unknown>>;
  const d = DEFAULT_APPEARANCE.terminal;
  return {
    terminal: {
      fontFamily: adoptFontFamily(term.fontFamily),
      fontSize: clampFontSize(term.fontSize),
      cursorStyle: CURSOR_STYLES.includes(term.cursorStyle as CursorStyle)
        ? (term.cursorStyle as CursorStyle)
        : d.cursorStyle,
      cursorBlink: typeof term.cursorBlink === "boolean" ? term.cursorBlink : d.cursorBlink,
    },
    ui: {
      fontFamily: adoptFontFamily(ui.fontFamily),
      fontSize: clampUiFontSize(ui.fontSize),
    },
    bar: adoptBar(raw.bar),
  };
}

function clampFontSize(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : DEFAULT_FONT_SIZE;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, n));
}

function clampUiFontSize(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : DEFAULT_UI_FONT_SIZE;
  return Math.min(MAX_UI_FONT_SIZE, Math.max(MIN_UI_FONT_SIZE, n));
}
/** A face somebody named, made safe to put in a `font-family`. */
export function adoptFontFamily(value: unknown): string {
  if (typeof value !== "string") return "";
  // `;` and `}` are the two that could close this declaration and open a rule of
  // somebody else's choosing; quotes go because the name is quoted on the way
  // out and a quote inside would end that quoting early.
  return value.replace(/[;}"'<>]/g, "").trim().slice(0, 120);
}
