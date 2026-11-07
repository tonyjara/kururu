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
 * It goes the moment the clip is written down. It used to stay a few
 * seconds to read back what was heard and say "Kuru has it", and the user
 * read that in the drawer anyway (2026-11-06), so a message that gets
 * through says nothing here; one that does not brings the pill back with
 * why. While Kuru speaks it shows what is being said — a synthesiser
 * mispronounces an id, and the text under it is how you tell — and goes
 * when the last sentence ends. Over the panes rather than in the status
 * bar, because the status bar is hidden in zen and this must not be.
 *
 * **It can be moved and it can be shut.** Over the panes means over
 * something, and the middle of the bottom edge is where a terminal's prompt
 * is — so it can be dragged anywhere in the window, by mouse or by finger,
 * and is drawn wherever this device last left it (`web/src/place.ts` says
 * why that is kept as a share of the window and not in pixels). A double
 * click puts it back. The ✕ is `dismissVoice`: Kuru stops mid-word and the
 * rest of the reply, and anything queued behind it, is marked unheard in the
 * Kuru drawer — which is what the talk key already does on its way down,
 * without opening a microphone to do it. Escape is the same ✕ while Kuru
 * speaks (`voiceEscape` in `voice.ts`). A plain click — one that travelled
 * less than the drag's own slop, and landed outside the ✕ — opens that
 * drawer at the reply the pill is showing: the full conversation is one tap
 * away from a pill that only ever shows its last line, in the window or from
 * the system-wide panel, which raises the main window with the drawer open
 * rather than itself.
 *
 * **The screen pen's tools are only ever in the floating pill** — on and
 * off, the two pens and the highlighter, Undo, Snap, Send or Done, and the
 * ✕ — so they are always in one place, the pill's, which can be dragged
 * anywhere and is kept a level above the ink (`desktop/ink.js`). While the
 * pill's own recording has the pen they are beside its meter; any other
 * session — the Kuru drawer's pencil, or a recording in the window — has
 * the pill shown in its draw-only form (`DrawPill`), with nothing of the
 * voice, and the pill in the window leaves the pen to it rather than
 * drawing a second set under the ink, where the pen would take its clicks.
 *
 * **The pill is the live indicator and not the record.** Listening and
 * speaking are its, and the failures nobody should miss; what became of
 * every message and every reply is the drawer's, with Resend.
 */
import { useEffect, useRef, useState } from "react";
import type { OutboxEntry } from "../../../shared/voice";
import { desktop } from "../desktop";
import { hasPen, pillPen, useInk } from "../ink";
import { toggleKuru } from "../kuru";
import { adoptPlace, placeAt, type Place } from "../place";
import { useKururu } from "../session";
import { dismissVoice, finishTalk, useMine, useOutgoing, useVoiceUi, voiceIsRemote, type Outgoing } from "../voice";
import { Icon } from "./Icon";
import { PenIcon, SnapIcon, UndoIcon } from "./VoiceIcons";

const BARS = [0.35, 0.6, 0.85, 1, 0.85, 0.6, 0.35];

/**
 * The pens as the ink is drawn with them (`LOOKS` in `desktop/ink.html`):
 * the ink's own colours and not the theme's, since a swatch that does not
 * match its ink is a lie about it.
 */
const SWATCHES = [
  { id: "red", tool: "pen", color: "red", ink: "rgb(255, 46, 84)", name: "The red pen" },
  { id: "blue", tool: "pen", color: "blue", ink: "rgb(10, 132, 255)", name: "The blue pen" },
  { id: "highlighter", tool: "highlighter", color: null, ink: "rgb(255, 214, 0)", name: "The highlighter, for a line of text" },
] as const;

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
  const mineId = useMine();
  const { outbox } = useKururu();
  const outgoing = useOutgoing();
  const ink = useInk();
  const mine: OutboxEntry | Outgoing | null = mineId ? (outbox.find((e) => e.id === mineId) ?? outgoing.find((c) => c.id === mineId) ?? null) : null;
  const [place, setPlace] = useState<Place | null>(storedPlace);
  const held = useRef<Held | null>(null);
  // Set by `drop` before it clears `held`, since the click that follows a
  // pointerup needs to know a drag happened after the ref that recorded it is
  // already gone.
  const dragged = useRef(false);

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
  /**
   * The screen pen, while the microphone is open on this page: a pen for
   * the recording, or the pen on and off once it has one, and Send — since
   * with the pen down the talk key may be the only other way to end it, and
   * the pill is kept over the ink for exactly this (`desktop/ink.js`).
   */
  const penHere = ui.phase === "listening" && hasPen() && (floating || !voiceIsRemote());
  const inked = penHere && ink.state.on && ink.state.voice;
  // The whole set here when this is the pill the session's tools are in; none
  // in the window's pill when the floating one's draw-only form has them.
  const tools = inked && floating;
  const elsewhere = inked && !floating && ink.state.tools === "draw";
  const marks = ink.state.marks;
  const label =
    ui.phase === "listening"
      ? inked
        ? ink.state.pen
          ? `Listening, drawing${marks ? ` — ${marks} mark${marks === 1 ? "" : "s"}` : ""}`
          : "Listening, pen up — clicks go to the apps"
        : ui.toggled
          ? "Listening — tap again to send, Esc to drop"
          : "Listening — let go to send, Esc to drop"
      : ui.phase === "sending"
        ? sendingLabel(mine)
        : ui.phase === "speaking"
          ? "Kuru"
          : ui.text;
  // No ✕ while the clip is on its way, which is a moment — except when the
  // server is not taking it, which can be as long as the server is down: then
  // the ✕ puts the pill away and the clip goes on being sent without it.
  const stuck = ui.phase === "sending" && mine !== null && !("state" in mine) && mine.error !== null;
  const dismiss =
    ui.phase === "listening"
      ? "Drop the clip"
      : ui.phase === "speaking"
        ? "Stop Kuru (Esc)"
        : ui.phase === "sending"
          ? stuck
            ? "Hide — it keeps trying, and it is in your messages"
            : null
          : "Dismiss";

  const onClose = (target: EventTarget) => target instanceof Element && target.closest(".voice-close, .voice-act") !== null;

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
    dragged.current = held.current?.moved ?? false;
    held.current = null;
  };

  /**
   * The pill clicked: the Kuru drawer, at the reply the pill is showing — a
   * pill that only ever shows its last line is one tap from the whole
   * conversation. A second click puts it away, since a pill that only ever
   * opened would be a one-way door onto a window the user is already in.
   *
   * The floating panel has to raise the *main* window — `desktop()?.show?.()`
   * would raise the panel itself, which is non-focusable and may be all that
   * is open — and whether that click opens or closes the drawer is decided
   * in the main process (`desktop/main.js`'s `kururu:raise-main`), the one
   * side that knows whether the window was already in front; it tells this
   * page which of the two it meant, since only this page knows whether the
   * drawer is already open. The in-window pill is already in the window, so
   * there is nothing to raise and it toggles directly.
   */
  const openHarness = () => {
    if (floating) {
      desktop()?.raiseMain?.(ui.utterance);
    } else {
      toggleKuru(ui.utterance);
      desktop()?.show?.();
      window.focus();
    }
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
      onClick={(event) => {
        if (onClose(event.target)) return;
        if (dragged.current) {
          dragged.current = false;
          return;
        }
        openHarness();
      }}
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
        {(ui.phase === "speaking" || (ui.phase === "error" && ui.detail)) && (
          <span className="voice-text">{ui.phase === "error" ? ui.detail : ui.text}</span>
        )}
      </span>
      {penHere && !elsewhere && (
        <button
          className={`voice-act ${inked && ink.state.pen ? "voice-act-on" : ""}`}
          onClick={pillPen}
          title={inked ? (ink.state.pen ? "Lift the pen: clicks go to the apps (⌃⌥⌘D, Esc)" : "Put the pen down again (⌃⌥⌘D)") : "Draw on the screen while you talk (⌃⌥⌘D)"}
          aria-label={inked ? "Pen on or off" : "Draw on the screen"}
          aria-pressed={inked && ink.state.pen}
        >
          <PenIcon />
        </button>
      )}
      {tools && <PenTools />}
      {inked && !elsewhere && (
        <button className="voice-act voice-act-send" onClick={finishTalk} title="Send what you said and drew to Kuru">
          Send
        </button>
      )}
      {dismiss && (
        <button className="voice-close" onClick={dismissVoice} title={dismiss} aria-label={dismiss}>
          <Icon name="close" />
        </button>
      )}
    </div>
  );
}

/**
 * The pill in its draw-only form: the screen pen's tools and nothing of the
 * voice, for a session whose tools are not beside the meter (`tools:
 * "draw"`) — the Kuru drawer's pencil, or a recording the window owns. The
 * floating panel draws it at the pill's own spot, and dragging it moves
 * that spot, so the tools are always in one place. Nothing here touches
 * `voice.ts`: it opens no microphone and says nothing, and in a panel made
 * for the pen alone (`?pill&draw`) the voice is not even installed.
 *
 * Done is the drawer's pencil pressed again, which puts the marks in Kuru's
 * box; for a recording it is Send, which ends the clip with its marks. The
 * ✕ drops the marks, and the clip with them.
 */
export function DrawPill() {
  const { state } = useInk();
  const ink = desktop()?.ink;
  if (!ink || !state.on) return null;
  const marks = state.marks ? ` — ${state.marks} mark${state.marks === 1 ? "" : "s"}` : "";
  const label = state.ending ? "Keeping the marks…" : state.pen ? `Drawing${marks}` : `Pen up${marks}`;
  const done = state.voice ? "Send" : "Done";
  const drop = state.voice ? "Drop the clip and the marks" : "Drop the marks and put the pen away";
  return (
    <div
      className="voice-pill voice-pill-floating voice-pill-drawing"
      role="status"
      aria-live="polite"
      title={state.pen ? "Drawing on the screen: Esc or ⌃⌥⌘D lifts the pen" : "The pen is up: clicks go to the apps"}
      onMouseDown={(event) => event.preventDefault()}
    >
      <button
        className={`voice-act ${state.pen ? "voice-act-on" : ""}`}
        onClick={() => ink.pen()}
        title={state.pen ? "Lift the pen: clicks go to the apps (⌃⌥⌘D, Esc)" : "Put the pen down again (⌃⌥⌘D)"}
        aria-label="Pen on or off"
        aria-pressed={state.pen}
      >
        <PenIcon />
      </button>
      <span className="voice-label">{label}</span>
      <PenTools />
      <button
        className="voice-act voice-act-send"
        onClick={() => ink.done()}
        disabled={state.ending}
        title={state.voice ? "Send what you said and drew to Kuru" : "Put the marks in Kuru's box"}
      >
        {done}
      </button>
      <button className="voice-close" onClick={() => ink.drop()} title={drop} aria-label={drop}>
        <Icon name="close" />
      </button>
    </div>
  );
}

/**
 * The pen's tools beside its on-and-off: the two pens and the highlighter,
 * Undo and Snap. What is picked is main's (`tool`,
 * `color`), so the pill and a stroke never disagree about the next one.
 */
function PenTools() {
  const { state } = useInk();
  const ink = desktop()?.ink;
  if (!ink?.style) return null;
  const tool = state.tool ?? "pen";
  const color = state.color ?? "red";
  return (
    <span className="voice-pen-tools">
      {SWATCHES.map((s) => {
        const picked = s.tool === "highlighter" ? tool === "highlighter" : tool === "pen" && color === s.color;
        return (
          <button
            key={s.id}
            className={`voice-act voice-swatch voice-swatch-${s.id} ${picked ? "voice-swatch-picked" : ""}`}
            style={{ "--swatch": s.ink } as React.CSSProperties}
            onClick={() => ink.style?.({ tool: s.tool, color: s.color ?? color })}
            title={s.name}
            aria-label={s.name}
            aria-pressed={picked}
          />
        );
      })}
      {ink.undo && (
        <button className="voice-act" onClick={() => ink.undo?.()} disabled={state.marks === 0} title="Take the last mark back (⌘Z with the pen down)" aria-label="Undo the last mark">
          <UndoIcon />
        </button>
      )}
      {ink.snap && (
        <button className="voice-act" onClick={() => ink.snap?.()} title="A picture of the display under the pointer, now, as a mark with no ink (⌃⌥⌘S)" aria-label="Snap the display">
          <SnapIcon />
        </button>
      )}
    </span>
  );
}

/** What the pill says between the key coming up and the clip being written down, or while the server will not take it. */
function sendingLabel(mine: OutboxEntry | Outgoing | null): string {
  return mine && !("state" in mine) && mine.error ? "Not with the server yet — kept here, retrying" : "Saving…";
}

/** Where this device left it, or its own spot. Storage that will not answer is the latter. */
function storedPlace(): Place | null {
  try {
    return adoptPlace(localStorage.getItem(PLACE_KEY));
  } catch {
    return null;
  }
}
