/**
 * The comment mics' press, kept apart from the components so it can be
 * tested without a page: the quote popover's and a browser mark's both
 * dictate a held press until it is let go and a tapped one until the next
 * press, as Kuru's box does.
 *
 * A tap is told from a hold by the two pointer events' own `timeStamp`s,
 * never by the clock when each is handled: opening the microphone can hold
 * the page for a few hundred milliseconds, and a tap whose release waited
 * behind it measured as a hold, was ended on the spot and was too short to
 * hear (`docs/voice.md`, dictating into Kuru's box).
 */
import { TAP_MS } from "../../shared/voice";

/** Whether a press let go of at `releasedAt` was a tap, which listens until the next press, rather than a hold, which has ended. */
export function pressWasTap(pressedAt: number, releasedAt: number): boolean {
  return Number.isFinite(pressedAt) && Number.isFinite(releasedAt) && releasedAt - pressedAt < TAP_MS;
}

/** What the next press of a comment's mic does: start, stop a tapped one, or nothing — a held one stops on its own release, and one being heard has nothing left to stop. */
export function micPress(phase: "idle" | "listening" | "hearing", toggled: boolean): "start" | "stop" | "none" {
  if (phase === "idle") return "start";
  return phase === "listening" && toggled ? "stop" : "none";
}

/**
 * The line under the quote's field while its comment is said, or why the
 * words did not come. Beside the mark only the phase fits, so `full` is the
 * field's longer line.
 */
export function sayLine(phase: "idle" | "listening" | "hearing", toggled: boolean, note: string | null, full: boolean): string | null {
  if (phase === "listening") {
    if (!full) return "Listening…";
    return toggled ? "Listening… press the mic again when you are done, or Esc to drop it." : "Listening… let go when you are done.";
  }
  if (phase === "hearing") return "Hearing…";
  if (note === null) return null;
  return full ? `${note} The quote is kept: type your comment, or press the mic again.` : note;
}

/** The mic's tooltip, which is also its name to a screen reader. */
export function micTitle(phase: "idle" | "listening" | "hearing", toggled: boolean): string {
  if (phase === "listening") return toggled ? "Stop and put in what you said (Esc drops it)" : "Let go to put in what you said";
  if (phase === "hearing") return "Hearing what you said…";
  return "Say your comment — hold, or tap to start and again to stop";
}
