/**
 * The pill that says the microphone is open.
 *
 * A hold-to-talk key is a mode, and `StatusBar.tsx` already argues why a
 * mode must be labelled — the difference here is that this one is a
 * microphone, and the thing somebody needs to know is not "is it on" but "is
 * it hearing me". So the pill is mostly a level meter: seven bars that move
 * with the room, which is the one picture that answers both questions at
 * once. The words beside it say which gesture ends the recording, since a tap
 * and a hold end differently and the person may not remember which this was.
 *
 * It stays up a few seconds after the clip is heard, to show what was heard
 * and where it went, and while Kuru speaks, to show what is being said — a
 * synthesiser mispronounces an id, and the text under it is how you tell.
 * Over the panes rather than in the status bar, because the status bar is
 * hidden in zen and this must not be.
 *
 * **It can be moved and it can be shut.** Over the panes means over
 * something, and the middle of the bottom edge is where a terminal's prompt
 * is — so it can be dragged anywhere in the window, by mouse or by finger,
 * and is drawn wherever this device last left it (`web/src/place.ts` says
 * why that is kept as a share of the window and not in pixels). A double
 * click puts it back. The ✕ is `dismissVoice`: Kuru stops mid-word and the
 * rest of the reply, and anything queued behind it, goes to the missed list
 * behind the harness button — which is what the talk key already does on its
 * way down, without opening a microphone to do it.
 */
import { useEffect, useRef, useState } from "react";
import { adoptPlace, placeAt, type Place } from "../place";
import { dismissVoice, useVoiceUi } from "../voice";
import { Icon } from "./Icon";

const BARS = [0.35, 0.6, 0.85, 1, 0.85, 0.6, 0.35];

/**
 * Where this device last left the pill. Per browser rather than in the
 * snapshot, on the sidebar width's reasoning: a phone and a desktop are two
 * windows of two shapes, and the spot that clears one's prompt is nothing to
 * the other.
 */
const PLACE_KEY = "kururu.voice.place";

/**
 * How far a press travels before it is a drag. Without it a tap is a drag of
 * nothing, which pins a pill sitting in its own spot to wherever that spot
 * happened to be — and its own spot moves with zen, and a pinned one does not.
 */
const SLOP_PX = 4;

/** Where the press began: the pointer, and the pill's corner under it. */
interface Held {
  x: number;
  y: number;
  left: number;
  top: number;
  moved: boolean;
}

/**
 * `floating` is the pill as a window of its own (`Pill.tsx`): laid out in
 * flow rather than fixed, so the page is exactly the pill and the main
 * process can size the panel to it, and dragged by the window system rather
 * than by the pointer logic below — a window has no room to be placed in
 * but the screen, and the screen is the main process's.
 */
export function VoicePill({ floating = false }: { floating?: boolean } = {}) {
  const ui = useVoiceUi();
  const [place, setPlace] = useState<Place | null>(storedPlace);
  const held = useRef<Held | null>(null);

  // Written as it moves, the way the sidebar's width is: a pill that unmounts
  // mid-drag, because Kuru finished, never sees the pointer come up.
  useEffect(() => {
    try {
      if (place) localStorage.setItem(PLACE_KEY, JSON.stringify(place));
      else localStorage.removeItem(PLACE_KEY);
    } catch {
      // No storage is a pill that starts in its own spot next time, not a failure.
    }
  }, [place]);

  if (ui.phase === "idle") return null;
  const label =
    ui.phase === "listening"
      ? ui.toggled
        ? "Listening — tap again to send, Esc to drop"
        : "Listening — let go to send, Esc to drop"
      : ui.phase === "sending"
        ? "Hearing…"
        : ui.phase === "speaking"
          ? "Kuru"
          : ui.phase === "heard"
            ? ui.detail
            : ui.text;
  // No ✕ while the clip is on its way: the server has it, and there is
  // nothing on this side left to stop.
  const dismiss =
    ui.phase === "listening" ? "Drop the clip" : ui.phase === "speaking" ? "Stop Kuru" : ui.phase === "sending" ? null : "Dismiss";

  const onClose = (target: EventTarget) => target instanceof Element && target.closest(".voice-close") !== null;

  const grab = (event: React.PointerEvent<HTMLDivElement>) => {
    held.current = null;
    if (event.button !== 0 || onClose(event.target)) return;
    // Captured, so a drag faster than the pill can follow still lands here,
    // and so a finger is not taken for a scroll — `touch-action` does the rest.
    event.currentTarget.setPointerCapture(event.pointerId);
    const box = event.currentTarget.getBoundingClientRect();
    held.current = { x: event.clientX, y: event.clientY, left: box.left, top: box.top, moved: false };
  };
  const drag = (event: React.PointerEvent<HTMLDivElement>) => {
    const from = held.current;
    // The capture, not only the ref: a pill that went away mid-drag and came
    // back under a mouse whose button is long up must not follow the hover.
    if (!from || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const dx = event.clientX - from.x;
    const dy = event.clientY - from.y;
    if (!from.moved && Math.hypot(dx, dy) < SLOP_PX) return;
    from.moved = true;
    // Measured now rather than at the press, because the pill changes size
    // with every sentence and Kuru does not stop talking for a drag.
    const box = event.currentTarget.getBoundingClientRect();
    // The root's client box is the viewport a fixed element is laid out in.
    const room = document.documentElement;
    setPlace(placeAt(from.left + dx, from.top + dy, box.width, box.height, room.clientWidth, room.clientHeight));
  };
  const drop = () => {
    held.current = null;
  };

  return (
    <div
      className={`voice-pill voice-pill-${ui.phase}${floating ? " voice-pill-floating" : place ? " voice-pill-placed" : ""}`}
      style={!floating && place ? ({ "--pill-x": String(place.x), "--pill-y": String(place.y) } as React.CSSProperties) : undefined}
      role="status"
      aria-live="polite"
      onPointerDown={floating ? undefined : grab}
      onPointerMove={floating ? undefined : drag}
      onPointerUp={floating ? undefined : drop}
      onPointerCancel={floating ? undefined : drop}
      /* The status bar's mic button's fix: a press here never takes the focus
         off the terminal that was being typed into — the ✕ included, since
         the default being prevented is the press's and it bubbles. */
      onMouseDown={(event) => event.preventDefault()}
      onDoubleClick={(event) => {
        if (!floating && !onClose(event.target)) setPlace(null);
      }}
    >
      <span className="voice-meter" aria-hidden="true">
        {BARS.map((scale, i) => (
          <span
            key={i}
            className="voice-bar"
            style={{ transform: `scaleY(${ui.phase === "listening" ? Math.max(0.12, Math.min(1, ui.level * scale + 0.08)).toFixed(2) : "0.12"})` }}
          />
        ))}
      </span>
      <span className="voice-words">
        <span className="voice-label">{label}</span>
        {(ui.phase === "speaking" || ui.phase === "heard" || (ui.phase === "error" && ui.detail)) && (
          <span className="voice-text">{ui.phase === "error" ? ui.detail : ui.text}</span>
        )}
      </span>
      {dismiss && (
        <button className="voice-close" onClick={dismissVoice} title={dismiss} aria-label={dismiss}>
          <Icon name="close" />
        </button>
      )}
    </div>
  );
}

/** Where this device left it, or its own spot. Storage that will not answer is the latter. */
function storedPlace(): Place | null {
  try {
    return adoptPlace(localStorage.getItem(PLACE_KEY));
  } catch {
    return null;
  }
}
