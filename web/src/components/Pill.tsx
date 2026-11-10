/**
 * The pill as a page of its own: what the floating panel loads.
 *
 * The talk key heard in every application needs a page that exists when
 * there is no window, and a pill that shows over another application needs
 * a window of its own. This is both, and it is deliberately the same build
 * with most of it not mounted: `main.tsx` renders this instead of `App` for
 * a `?pill` address, and what mounts is the session (for the profile and the
 * settings), the voice module (the microphone and the player) and the pill.
 * No panes, no emulators, no notifications — so it has no vote in the size
 * policy and makes no sound that the window is already making.
 *
 * While the hook is live this page is the one voice client on this Mac
 * (`voice.ts` says why one). Its key events come from the main process over
 * the bridge rather than from the DOM, since the key was pressed over some
 * other application, and it tells the main process what it is showing and
 * how big it is, because the window around it is sized to it and shown and
 * hidden as it is. The talk key it names is the server's setting, which is
 * how the hook learns which key to listen for.
 *
 * **It is also where the screen pen's tools are** (`DrawPill`): a session
 * whose tools are not beside the meter has the pill drawn in a draw-only
 * form, at the same spot, while it lasts. The main process makes a panel
 * for that alone when neither the hook nor ⌥Space keeps one, and loads
 * this page with `draw` (`TalkKey.forPen`): then nothing of the voice is
 * installed — no microphone, no speech, no keys — since the pill's page is
 * the one voice client on this Mac while it is one, and a page made for a
 * pen must never be a second.
 *
 * **While the floating Kuru is on, the voice is drawn beside its logo and
 * not as a pill** (`FloatWave` in `Float.tsx`). This page is still the voice
 * client and nothing about the microphone or the player changes; the main
 * process puts this window in the logo's row (`TalkKey.dock`) and what is
 * drawn in it is a waveform. The pen's tools are then always in the
 * draw-only form beside it, since there is no pill's meter to put them by.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DEFAULT_VOICE } from "../../../shared/voice";
import { desktop } from "../desktop";
import { useInterface } from "../fonts";
import { useKururu } from "../session";
import { applyTalkGesture, installSpeech, setSpeechVolume, setVoiceProfile, useVoiceUi, voiceNow } from "../voice";
import { installInk, installShiftPen, useInk } from "../ink";
import { installReload } from "../reload";
import { useFloat } from "../float";
import { FloatWave } from "./Float";
import { DrawPill, VoicePill } from "./VoicePill";

/**
 * How long the tray's Reset shows a pill that has nothing to say. The pill
 * is only up while it is talking, so a reset that did not show it moved an
 * invisible window and looked like it had done nothing. Long enough to see
 * where it went and take hold of it.
 */
const HERE_MS = 5000;
/** How often a pill holding an update looks for a quiet moment to reload in. */
const IDLE_POLL_MS = 500;
/** A panel made for the screen pen alone (`TalkKey.forPen`): its tools, and nothing of the voice. */
const DRAW_ONLY = typeof location !== "undefined" && new URLSearchParams(location.search).has("draw");

/**
 * **The pill page is never hot-updated; it reloads instead, once it is idle.**
 *
 * Everything this page is lives in module state: `voice.ts` holds the
 * microphone, the player and the phase, `session.ts` the socket. A hot update
 * that reaches them — and almost every save does, since `session.ts` imports
 * `shared/` at runtime — makes second copies, and the page comes out split:
 * the bridge's key listener, registered once by the first copy of `Pill`'s
 * mount effect, which Fast Refresh does not run again, still drives the
 * first `voice.ts`, which records and posts as before; and `Pill`, rendered
 * again against the second, reads a phase that never leaves idle. So the
 * clip is sent and the pill never says so, `report` never asks the panel to
 * be shown, and it is not — while the tray's Reset still works, since its
 * listener sets this component's own state, which is the one case that made
 * it look like a placement bug (KUR-216, 2026-11-02: an hour of recordings
 * and not one line in `pill.log`).
 *
 * The window can take its updates in place; this page cannot, and has no
 * reason to: it is hidden, small and quick to load. Vite awaits each
 * `vite:beforeUpdate` and `vite:beforeFullReload` listener before it applies
 * anything, one message at a time (`handleMessage` and `createHMRHandler` in
 * `vite/dist/client/client.mjs`, to recheck after a vite upgrade), so a
 * listener that never settles holds this update and every one after it, and
 * the page keeps the one consistent copy of itself until it reloads — when
 * the voice is idle, so no sentence is cut off and no clip is dropped, the
 * same rule `reloadPanel` keeps in the main process. Registered at module
 * level, which in a page that holds every update runs exactly once.
 */
if (import.meta.hot && typeof location !== "undefined" && new URLSearchParams(location.search).has("pill")) {
  let reloading = false;
  const hold = () => {
    if (!reloading) {
      reloading = true;
      const poll = setInterval(() => {
        if (voiceNow().phase !== "idle") return;
        clearInterval(poll);
        location.reload();
      }, IDLE_POLL_MS);
    }
    return new Promise<never>(() => {});
  };
  import.meta.hot.on("vite:beforeUpdate", hold);
  import.meta.hot.on("vite:beforeFullReload", hold);
}

export function Pill() {
  const { snapshot, voice } = useKururu();
  useInterface(snapshot);
  const ui = useVoiceUi();
  const ink = useInk();
  const profileRef = useRef("");
  profileRef.current = snapshot?.profile.id ?? "";
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const root = useRef<HTMLDivElement>(null);
  const [here, setHere] = useState(false);

  useEffect(() => {
    document.documentElement.classList.add("pill-page");
    if (DRAW_ONLY) {
      // The pen's state, and the reload an agent asks for; no voice at all.
      const stopInk = installInk();
      const stopReload = installReload("pill");
      return () => {
        stopInk();
        stopReload();
        document.documentElement.classList.remove("pill-page");
      };
    }
    setVoiceProfile(() => profileRef.current);
    setSpeechVolume(() => voiceRef.current?.settings.volume ?? DEFAULT_VOICE.volume);
    const stopSpeech = installSpeech();
    // The screen pen's sessions with the voice are this page's while it is the voice client.
    const stopInk = installInk();
    // Reloaded with the window when an agent asks, only while it is idle and
    // so hidden: this page is where the voice module runs, and an old copy of
    // it left behind by a hot update is the one that kept the microphone.
    const stopReload = installReload("pill");
    const stopKeys = desktop()?.voice?.onKey(applyTalkGesture) ?? (() => {});
    // Shift while recording: the pen, tapped on and off or held down.
    const stopShift = installShiftPen();
    let hereTimer: ReturnType<typeof setTimeout> | undefined;
    const stopLocate =
      desktop()?.voice?.onLocate?.(() => {
        setHere(true);
        clearTimeout(hereTimer);
        hereTimer = setTimeout(() => setHere(false), HERE_MS);
      }) ?? (() => {});
    // Said once, for the dev shell's terminal: the panel is a window nobody can open the devtools of.
    console.log(`up${desktop()?.voice ? "" : ", with no bridge"}`);
    return () => {
      stopSpeech();
      stopInk();
      stopReload();
      stopKeys();
      stopShift();
      stopLocate();
      clearTimeout(hereTimer);
      document.documentElement.classList.remove("pill-page");
    };
  }, []);

  /**
   * Said after layout, so the box is the one about to be painted. On the
   * words rather than on every render: the level moves thirty times a second
   * and changes nothing about the pill's size.
   */
  const key = voice?.settings.talkKey ?? DEFAULT_VOICE.talkKey;
  // The pen's tools, drawn here for a session whose tools are not beside the meter.
  const float = useFloat();
  const docked = float?.on === true ? float : null;
  const drawing = ink.state.on && (ink.state.tools === "draw" || docked !== null);
  const phase = DRAW_ONLY ? "idle" : ui.phase;
  const report = useRef(() => {});
  report.current = () => {
    const bridge = desktop()?.voice;
    if (!bridge) return;
    // The stack, which is the voice's pill, the pen's, or both while a
    // recording is made during a pen session that is not its own.
    const box = root.current?.querySelector(".pill-stack")?.getBoundingClientRect();
    bridge.report({ phase, width: box?.width ?? 0, height: box?.height ?? 0, key, locating: here, drawing });
  };
  useLayoutEffect(() => {
    report.current();
    // The pen's tools come and go with its session, its label counts the marks, and the panel is sized to them.
    // And docked to the floating Kuru it is the waveform's box, which is as wide as the chat it runs along.
  }, [phase, ui.text, ui.detail, ui.toggled, key, here, drawing, ink.state.on, ink.state.pen, ink.state.marks, ink.state.ending, ink.state.voice, docked?.wave, docked?.reach]);
  // Docked, the box also changes for a reason that is none of those: the
  // waveform gives way to words when the server will not take a clip. The
  // window beside the logo has to be exactly what is drawn, so it is watched.
  const isDocked = docked !== null;
  useEffect(() => {
    const stack = isDocked ? root.current?.querySelector(".pill-stack") : null;
    if (!stack) return;
    const watch = new ResizeObserver(() => report.current());
    watch.observe(stack);
    return () => watch.disconnect();
  }, [isDocked]);

  return (
    <div className={`pill-page-root ${docked ? `pill-docked pill-docked-${docked.reach}` : ""}`} ref={root}>
      <div className="pill-stack">
        {drawing && <DrawPill />}
        {DRAW_ONLY ? null : ui.phase === "idle" && here ? <PillHere /> : docked ? <FloatWave float={docked} /> : <VoicePill floating />}
      </div>
    </div>
  );
}

/**
 * Reset's answer when the pill has nothing to say: where it is now, and that
 * it can be moved. Nothing on it is carved out of the drag, since there is
 * nothing on it to press — the whole of it is the handle.
 */
function PillHere() {
  return (
    <div className="voice-pill voice-pill-floating voice-pill-here" role="status" aria-live="polite">
      <span className="voice-meter" aria-hidden="true">
        {Array.from({ length: 7 }, (_, i) => (
          <span key={i} className="voice-bar" />
        ))}
      </span>
      <span className="voice-label">Kuru's pill is here — drag it anywhere</span>
    </div>
  );
}
