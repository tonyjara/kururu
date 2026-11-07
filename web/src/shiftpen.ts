/**
 * Shift as the screen pen's key while the voice is recording: tapped, it
 * turns the pen on or off; held, the pen is down while it is held and up
 * when it is let go — the talk key's grammar, with the talk key's threshold
 * (`TAP_MS`) and its test (`pressWasTap`), so Shift and the mic agree on
 * what a tap is. Kept apart from the pill so it can be tested without one.
 *
 * Shift is half of typing, which the talk key is not, and that changes one
 * thing. The talk key starts the microphone on its press and decides on its
 * release; Shift waits. A capital letter typed mid-sentence is a Shift
 * pressed and a key with it inside a few hundred milliseconds, and a pen
 * that went down on every such press — a session started, overlays laid
 * over every display, the mouse taken — and came back up on the letter
 * would flash across the screen at every capital. So nothing happens on the
 * press: a release inside `TAP_MS` is a tap, and still being held at
 * `TAP_MS` is a hold, which puts the pen down then. Anything pressed with
 * it before then (`chord`) and the press was a shortcut's: nothing at all.
 *
 * A click is the one exception, and only once a hold has the pen down: then
 * the click is a stroke on the overlay, not a Shift-click in the application
 * underneath. A key pressed during a hold — Shift held a little long before
 * a capital — still puts the pen back.
 *
 * Only a press that began while recording counts (`shiftDown`); the rest of
 * the time Shift is the applications' and this does nothing.
 */
import { pressWasTap } from "./micpress";

export interface ShiftPress {
  /** The press's own time, from the hook. */
  at: number;
  /** The pen was down when Shift went down. */
  wasPen: boolean;
  /** The press became a hold and put the pen down. */
  holding: boolean;
  /** Something was pressed with Shift, so the press was a shortcut's. */
  chorded: boolean;
}

/** Shift went down: a press to follow, or null — not recording, or a time that is not one. */
export function shiftDown(recording: boolean, penDown: boolean, at: number): ShiftPress | null {
  if (!recording || !Number.isFinite(at)) return null;
  return { at, wasPen: penDown, holding: false, chorded: false };
}

/**
 * Shift still held at `TAP_MS`, nothing pressed with it: a hold. The pen
 * goes down for it if it was up (`true`); one already down stays as it is.
 */
export function shiftHeld(press: ShiftPress, recording: boolean): { press: ShiftPress; pen: boolean | null } {
  if (press.chorded || press.holding || press.wasPen || !recording) return { press, pen: null };
  return { press: { ...press, holding: true }, pen: true };
}

/**
 * Something pressed with Shift. Before a hold, the press was a shortcut's
 * and is nobody's now. During one, a key puts the pen back up; a click is
 * the pen drawing and changes nothing.
 */
export function shiftChord(press: ShiftPress, by: "key" | "mouse"): { press: ShiftPress; pen: boolean | null } {
  if (press.chorded) return { press, pen: null };
  if (press.holding && by === "mouse") return { press, pen: null };
  return { press: { ...press, chorded: true, holding: false }, pen: press.holding ? false : null };
}

/**
 * Shift let go: what the pen becomes, or null for no change. A pen that was
 * down goes up, tapped or held, as a toggled recording ends on the next
 * press; one that was up stays down after a tap and goes up after a hold.
 */
export function shiftUp(press: ShiftPress, at: number): boolean | null {
  if (press.chorded) return null;
  if (press.wasPen) return false;
  if (pressWasTap(press.at, at)) return true;
  return press.holding ? false : null;
}
