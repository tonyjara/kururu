/**
 * The mouse, as the program in the pty sees it.
 *
 * A terminal has two irreconcilable answers for a drag. It can paint a
 * selection the person can copy, or it can tell the program where the pointer
 * went, and only one of them can have the gesture. Which one is not the
 * terminal's decision to make: the program says, by turning mouse tracking on,
 * and every terminal since xterm has answered the same way — while tracking is
 * on the program gets the mouse, and holding shift takes it back for one drag.
 *
 * Kururu was answering "the selection, always", and not by choice. ghostty-web
 * ships a SelectionManager and no mouse reporting whatsoever: it parses the
 * tracking modes — `hasMouseTracking()` is right there on the terminal — and
 * then has nothing to do with them, because a browser emulator has no pty of
 * its own to report to. So an nvim in a pane could not be clicked into, its
 * visual mode could not be dragged out, its window dividers could not be
 * grabbed, and the browser painted a selection over the top of an editor that
 * has a better one of its own.
 *
 * This module is the protocol half and nothing else: which modes mean what, and
 * what a report looks like on the wire. The policy — that shift is the way back
 * to a local selection — is at the call site in `terminals.ts`, because that is
 * a decision about what a pane does with a gesture rather than a fact about the
 * encoding, and the encoding is the part worth testing.
 */

/**
 * How much of the mouse the program asked for.
 *
 * The three DEC private modes are a ladder rather than a set: 1003 reports
 * everything 1002 does and 1002 everything 1000 does, so the highest one that is
 * set is the entire answer and there is no combination to represent.
 */
export type Tracking = "none" | "click" | "drag" | "any";

/** Button presses and releases only (DECSET 1000). */
export const MODE_CLICK = 1000;
/** ...and motion while a button is held (DECSET 1002). */
export const MODE_DRAG = 1002;
/** ...and motion with no button held at all (DECSET 1003). */
export const MODE_ANY = 1003;
/** The SGR encoding (DECSET 1006). */
export const MODE_SGR = 1006;

export interface MouseModes {
  tracking: Tracking;
  /**
   * Whether to use SGR rather than the original encoding.
   *
   * The original packs each coordinate into one byte at an offset of 32, so it
   * cannot address a column past 223 and cannot say *which* button was
   * released — the receiver is expected to have remembered. SGR fixes both, and
   * everything written this century asks for it. Neovim in particular sets 1002
   * and 1006 together and nothing else (`tui_mouse_on` in its `tui.c`), so that
   * is the path that matters here; the fallback stays because `less` and a
   * couple of decades of ncurses are still out there, and it is ten lines.
   */
  sgr: boolean;
}

/**
 * Read the ladder off whatever can answer for a mode.
 *
 * A function rather than the terminal, because the terminal is a WASM handle
 * and this is the part that should be testable without one.
 */
export function mouseModes(isSet: (mode: number) => boolean): MouseModes {
  const tracking: Tracking = isSet(MODE_ANY)
    ? "any"
    : isSet(MODE_DRAG)
      ? "drag"
      : isSet(MODE_CLICK)
        ? "click"
        : "none";
  return { tracking, sgr: isSet(MODE_SGR) };
}

export type MouseAction = "press" | "release" | "move";

/** No button — what a bare motion carries, and what a legacy release says. */
export const BUTTON_NONE = 3;
/**
 * The wheel, which this protocol calls a button because xterm did and every
 * program on the other end now expects it to. 64 up, 65 down, 66 and 67 for a
 * trackpad going sideways. There is no release for a notch.
 */
export const WHEEL_UP = 64;
export const WHEEL_DOWN = 65;
export const WHEEL_LEFT = 66;
export const WHEEL_RIGHT = 67;

export interface MouseReport {
  action: MouseAction;
  /** 0 left, 1 middle, 2 right, `BUTTON_NONE` for none, or a wheel constant. */
  button: number;
  /** Zero-based, from the emulator's grid. The wire is one-based. */
  col: number;
  row: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

/**
 * The bytes for one report, or null if this one is not to be sent.
 *
 * Null is the common case and not an error: a program that asked for 1000 has
 * said it does not want motion, and sending it anyway is how a terminal drowns
 * an application in events it has to parse and discard. The mode decides, in
 * one place, rather than four handlers each remembering to check.
 */
export function encodeMouse(report: MouseReport, modes: MouseModes): string | null {
  if (modes.tracking === "none") return null;
  if (report.col < 0 || report.row < 0) return null;

  if (report.action === "move") {
    if (modes.tracking === "click") return null;
    // 1002 is motion *while a button is down*; a bare hover is 1003's business.
    if (modes.tracking === "drag" && report.button === BUTTON_NONE) return null;
  }

  // SGR names the button that came up. The original encoding has one code for
  // all three releases, which is the reason it needs the receiver to remember.
  const base = !modes.sgr && report.action === "release" ? BUTTON_NONE : report.button;
  let code = base;
  if (report.action === "move") code += 32;
  if (report.shift) code += 4;
  if (report.alt) code += 8;
  if (report.ctrl) code += 16;

  const col = report.col + 1;
  const row = report.row + 1;

  if (modes.sgr) {
    return `\x1b[<${code};${col};${row}${report.action === "release" ? "m" : "M"}`;
  }

  // One byte per coordinate at an offset of 32, so 223 is as far as it reaches.
  // xterm's answer past that is to say nothing rather than to wrap, because a
  // wrapped coordinate is a click the program acts on in the wrong place.
  if (col > 223 || row > 223) return null;
  return `\x1b[M${String.fromCharCode(32 + code, 32 + col, 32 + row)}`;
}
