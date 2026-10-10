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
import { useEffect, useLayoutEffect, useRef } from "react";
import { DEFAULT_VOICE } from "../../../shared/voice";
import { desktop } from "../desktop";
import { useKururu } from "../session";
import { applyTalkGesture, installSpeech, setSpeechVolume, setVoiceProfile, useVoiceUi } from "../voice";
import { VoicePill } from "./VoicePill";

export function Pill() {
  const { snapshot, voice } = useKururu();
  const ui = useVoiceUi();
  const profileRef = useRef("");
  profileRef.current = snapshot?.profile.id ?? "";
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.classList.add("pill-page");
    setVoiceProfile(() => profileRef.current);
    setSpeechVolume(() => voiceRef.current?.settings.volume ?? DEFAULT_VOICE.volume);
    const stopSpeech = installSpeech();
    const stopKeys = desktop()?.voice?.onKey(applyTalkGesture) ?? (() => {});
    // Said once, for the dev shell's terminal: the panel is a window nobody can open the devtools of.
    console.log(`up${desktop()?.voice ? "" : ", with no bridge"}`);
    return () => {
      stopSpeech();
      stopKeys();
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
    bridge.report({ phase: ui.phase, width: box?.width ?? 0, height: box?.height ?? 0, key });
  }, [ui.phase, ui.text, ui.detail, ui.toggled, key]);

  return (
    <div className="pill-page-root" ref={root}>
      <VoicePill floating />
    </div>
  );
}
