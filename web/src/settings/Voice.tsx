/**
 * Settings → Kuru → Voice: how you talk to Kuru and what it sounds like.
 *
 * **Picking a voice plays it**, for Notifications' reason: a list of names
 * like `af_heart` and `Paulina` is a list nobody can map to a sound. The
 * audition is made on the server like everything else and comes back as an
 * utterance to fetch, so the phone hears the same voice the desktop chose.
 *
 * **A voice per language** rather than one voice and a language switch,
 * because Kokoro's voices are each of one language and a Spanish voice
 * reading English is a Spanish accent on every word. So the page is one group
 * per language: whether it is heard, which accent, which voice.
 *
 * The page also says what is installed: the ears and the Spanish phonemes are
 * Homebrew programs and the model is a download, and a key that does nothing
 * because a program is missing is the worst kind of broken.
 *
 * **One switch is about reading rather than hearing:** whether a long
 * message starts folded in Kuru's drawer. It is here because Voice is the
 * Kuru group's page for this conversation as you take it in, and a page of
 * its own for one switch would be a door nobody looks behind. It is this
 * device's, as the folds it starts are (`kurufold.ts`), so it says so.
 */
import { useEffect, useState } from "react";
import { KOKORO_SIZE_MB, LANG_NAMES, LOCALES, VOICE_LANGS, keyCodeLabel, type VoiceChoice, type VoiceLang, type VoiceSettings } from "../../../shared/voice";
import { desktop, type VoiceGlobalState } from "../desktop";
import { setFoldLong, useFoldLong } from "../kurufold";
import { audioOutput } from "../notify";
import * as api from "../session";
import { useKururu } from "../session";
import { Action, Banner, Btn, Empty, Group, Mono, Readout, Select, Slider, Toggle, useEditing, type Tone } from "./ui";

/** What the hook is doing, in a line under its switch. */
function globalLine(state: VoiceGlobalState): string {
  switch (state.status) {
    case "live":
      return "On: hold the key in any app and the pill floats over it.";
    case "starting":
      return "Starting the hook…";
    case "denied":
      return "macOS has not allowed it yet: switch Kururu on under Input Monitoring.";
    case "missing":
      return "This build has no hook in it. The key works while this window is focused.";
    case "unsupported":
      return "That key cannot be hooked system-wide. Pick another talk key.";
    case "crashed":
      return "The hook stopped. Switch it off and on again.";
    default:
      return "Off: the key works while this window is focused. macOS asks for Input Monitoring once.";
  }
}

export function VoicePage() {
  const { voice } = useKururu();
  const [capturing, setCapturing] = useState(false);
  const [auditioning, setAuditioning] = useState<VoiceLang | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const bridge = desktop()?.voice ?? null;
  const [global, setGlobal] = useState<VoiceGlobalState | null>(null);
  const tell = useEditing();
  const foldLong = useFoldLong();

  useEffect(() => {
    if (!bridge) return;
    void bridge.global().then(setGlobal);
    return bridge.onGlobal(setGlobal);
  }, [bridge]);

  useEffect(() => {
    if (!capturing) return;
    tell(true);
    // The press that picks the new key is not a word for Kuru.
    bridge?.pause(true);
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setCapturing(false);
        return;
      }
      if (voice) api.setVoice({ ...voice.settings, talkKey: event.code });
      setCapturing(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      bridge?.pause(false);
      tell(false);
    };
  }, [bridge, capturing, tell, voice]);

  if (!voice) {
    return (
      <Group>
        <Empty>Waiting for the server…</Empty>
      </Group>
    );
  }
  const { settings, ears, spanish, model, voices } = voice;
  const set = (patch: Partial<VoiceSettings>) => api.setVoice({ ...settings, ...patch });

  const toggleLang = (lang: VoiceLang, on: boolean) => {
    const languages = VOICE_LANGS.filter((l) => (l === lang ? on : settings.languages.includes(l)));
    if (!languages.length) return;
    // The order is the preference, and the one just switched on goes last.
    set({ languages: [...settings.languages.filter((l) => languages.includes(l)), ...languages.filter((l) => !settings.languages.includes(l))] });
  };

  const audition = async (choice: VoiceChoice, lang: VoiceLang) => {
    setProblem(null);
    setAuditioning(lang);
    const out = audioOutput();
    if (out?.ctx.state === "suspended") await out.ctx.resume().catch(() => {});
    try {
      const { utterance } = await api.previewVoice(choice, lang);
      if (!out) return;
      const res = await fetch(api.speechUrl(utterance, 0));
      const buffer = await out.ctx.decodeAudioData(await res.arrayBuffer());
      const gain = out.ctx.createGain();
      gain.gain.value = settings.volume;
      gain.connect(out.ctx.destination);
      const source = out.ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      source.start();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setAuditioning(null);
    }
  };

  const choose = (lang: VoiceLang, value: string) => {
    const [engine, ...rest] = value.split(":");
    const choice: VoiceChoice = { engine: engine === "system" ? "system" : engine === "lab" ? "lab" : "kokoro", voice: rest.join(":") };
    set({ voices: { ...settings.voices, [lang]: choice } });
    void audition(choice, lang);
  };

  const modelTone: Tone = model.state === "ready" ? "ok" : model.state === "error" ? "bad" : model.state === "missing" ? "off" : "busy";
  const modelLine =
    model.state === "ready"
      ? "Downloaded"
      : model.state === "downloading"
        ? `Downloading… ${model.progress}%`
        : model.state === "loading"
          ? "Loading…"
          : model.state === "error"
            ? `Could not load it: ${model.error ?? "unknown"}`
            : `Not downloaded, about ${KOKORO_SIZE_MB} MB once`;

  return (
    <>
      {problem && <Banner tone="bad">{problem}</Banner>}

      <Group title="Talking" foot="Hold the talk key to speak; tap it to leave the microphone open until the next tap.">
        <Toggle label="Speak replies" hint="What Kuru says at the end of each turn, read aloud." on={settings.speak} onChange={(speak) => set({ speak })} />
        <Readout label="Talk key" hint="Works anywhere in the window." value={capturing ? "press a key…" : <Mono>{keyCodeLabel(settings.talkKey)}</Mono>}>
          <Btn onClick={() => setCapturing((on) => !on)}>{capturing ? "Cancel" : "Change"}</Btn>
        </Readout>
        {bridge && global && (
          <>
            <Toggle label="Talk key in every app" hint={globalLine(global)} on={global.on} onChange={(on) => bridge.setGlobal(on)} />
            {global.status === "denied" && <Action label="Input Monitoring" hint="No restart is needed once it is allowed." button="Open System Settings" onClick={() => bridge.openInputMonitoring()} />}
            <Toggle label="⌥Space toggles the microphone" hint="From any app, no permission needed. Tap to open, tap again to send." on={global.altSpace} onChange={(on) => bridge.setAltSpace(on)} />
          </>
        )}
      </Group>

      <Group title="Sound">
        <Slider label="Volume" min={0} max={1} step={0.05} value={settings.volume} format={(n) => `${Math.round(n * 100)}%`} onChange={(volume) => set({ volume })} />
        <Slider label="Speed" min={0.7} max={1.5} step={0.05} value={settings.speed} format={(n) => `${n.toFixed(2)}×`} onChange={(speed) => set({ speed })} />
      </Group>

      {VOICE_LANGS.map((lang, i) => {
        const heard = settings.languages.includes(lang);
        const chosen = settings.voices[lang];
        const value = `${chosen.engine}:${chosen.voice}`;
        const kokoro = voices.filter((v) => v.engine === "kokoro" && v.lang === lang);
        const system = voices.filter((v) => v.engine === "system" && v.lang === lang);
        const lab = voices.filter((v) => v.engine === "lab" && v.lang === lang);
        const labGroups = [...new Set(lab.map((v) => v.group ?? "Trial"))];
        const known = voices.some((v) => v.engine === chosen.engine && v.id === chosen.voice);
        return (
          <Group key={lang} title={LANG_NAMES[lang]} foot={i === 0 ? "Each clip is heard in every language switched on and the one it was in wins; the first switched on is the tie-breaker." : undefined}>
            <Toggle label="Heard" on={heard} onChange={(on) => toggleLang(lang, on)} />
            <Select label="Accent" value={settings.locales[lang]} disabled={!heard} ariaLabel={`${LANG_NAMES[lang]} accent`} onChange={(locale) => set({ locales: { ...settings.locales, [lang]: locale } })}>
              {LOCALES[lang].map((locale) => (
                <option key={locale.id} value={locale.id}>
                  {locale.name}
                </option>
              ))}
            </Select>
            <Select label="Voice" hint="Picking one plays it." value={value} wide disabled={!heard} ariaLabel={`${LANG_NAMES[lang]} voice`} onChange={(next) => choose(lang, next)}>
              {!known && <option value={value}>{chosen.voice} (not on this machine)</option>}
              <optgroup label="Kokoro">
                {kokoro.map((v) => (
                  <option key={v.id} value={`kokoro:${v.id}`}>
                    {v.name}: {v.note}
                  </option>
                ))}
              </optgroup>
              {labGroups.map((group) => (
                <optgroup key={group} label={group}>
                  {lab
                    .filter((v) => (v.group ?? "Trial") === group)
                    .map((v) => (
                      <option key={v.id} value={`lab:${v.id}`}>
                        {v.name}: {v.note}
                      </option>
                    ))}
                </optgroup>
              ))}
              <optgroup label="This Mac">
                {system.map((v) => (
                  <option key={v.id} value={`system:${v.id}`}>
                    {v.name}: {v.note}
                  </option>
                ))}
              </optgroup>
            </Select>
            <Action label="Hear it" button="Play" disabled={!heard || auditioning !== null} busy={auditioning === lang} busyLabel="…" onClick={() => void audition(chosen, lang)} />
          </Group>
        );
      })}

      <Group title="Reading" foot="On this device only, as the folds themselves are: the phone and the Mac each keep their own.">
        <Toggle label="Fold long messages" hint="A message longer than about fifteen lines starts as one row in Kuru's drawer. Unfolding one keeps it open." on={foldLong} onChange={setFoldLong} />
      </Group>

      <Group
        title="On this Mac"
        foot={
          <>
            Kokoro is the better voice and runs on the CPU; the Mac's own voices are used until it is ready. The ears are Apple's recogniser through <Mono>yap</Mono>.
            {!!voice.lab?.length && <> Trial voices come from <Mono>~/.cache/kururu/voicelab</Mono>; the first sentence after a pick loads the model.</>}
          </>
        }
      >
        <Readout label="Ears" tone={ears.ok ? "ok" : "bad"} value={ears.ok ? `yap: ${ears.detail}` : ears.detail} />
        <Readout label="Voice model" tone={modelTone} value={modelLine}>
          {(model.state === "missing" || model.state === "error") && (
            <Btn primary onClick={() => api.downloadVoiceModel()}>
              Download
            </Btn>
          )}
        </Readout>
        <Readout label="Spanish" tone={spanish.ok ? "ok" : "bad"} value={spanish.ok ? `espeak-ng: ${spanish.detail}` : spanish.detail} />
        {!!voice.lab?.length && (
          <Readout
            label="Trial engines"
            tone={voice.lab.some((m) => m.state === "error") ? "bad" : voice.lab.some((m) => m.state === "ready") ? "ok" : "off"}
            value={voice.lab
              .map((m) => `${m.name}: ${m.state === "idle" ? "not loaded" : m.state === "loading" ? "loading…" : m.state === "ready" ? m.detail || "ready" : `failed, ${m.detail}`}`)
              .join(" · ")}
          />
        )}
      </Group>
    </>
  );
}
