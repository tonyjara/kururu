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
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DEFAULT_VOICE } from "../../../shared/voice";
import { desktop } from "../desktop";
import { useKururu } from "../session";
import { applyTalkGesture, installSpeech, setSpeechVolume, setVoiceProfile, useVoiceUi } from "../voice";
import { installReload } from "../reload";
import { VoicePill } from "./VoicePill";

/**
 * How long the tray's Reset shows a pill that has nothing to say. The pill
 * is only up while it is talking, so a reset that did not show it moved an
 * invisible window and looked like it had done nothing. Long enough to see
 * where it went and take hold of it.
 */
const HERE_MS = 5000;

export function Pill() {
  const { snapshot, voice } = useKururu();
  const ui = useVoiceUi();
  const profileRef = useRef("");
  profileRef.current = snapshot?.profile.id ?? "";
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const root = useRef<HTMLDivElement>(null);
  const [here, setHere] = useState(false);

  useEffect(() => {
    document.documentElement.classList.add("pill-page");
    setVoiceProfile(() => profileRef.current);
    setSpeechVolume(() => voiceRef.current?.settings.volume ?? DEFAULT_VOICE.volume);
    const stopSpeech = installSpeech();
    // Reloaded with the window when an agent asks, only while it is idle and
    // so hidden: this page is where the voice module runs, and an old copy of
    // it left behind by a hot update is the one that kept the microphone.
    const stopReload = installReload("pill");
    const stopKeys = desktop()?.voice?.onKey(applyTalkGesture) ?? (() => {});
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
      stopReload();
      stopKeys();
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
  useLayoutEffect(() => {
    const bridge = desktop()?.voice;
    if (!bridge) return;
    const pill = root.current?.querySelector(".voice-pill");
    const box = pill?.getBoundingClientRect();
    bridge.report({ phase: ui.phase, width: box?.width ?? 0, height: box?.height ?? 0, key, locating: here });
  }, [ui.phase, ui.text, ui.detail, ui.toggled, key, here]);

  return (
    <div className="pill-page-root" ref={root}>
      {ui.phase === "idle" && here ? <PillHere /> : <VoicePill floating />}
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
