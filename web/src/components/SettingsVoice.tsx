/**
 * Settings → Voice: how you talk to Kuru and what it sounds like.
 *
 * **Picking a voice plays it**, for `SettingsNotify`'s reason: a list of
 * names like `af_heart` and `Paulina` is a list nobody can map to a sound,
 * so the select auditions on change and there is a button to hear it again.
 * The audition is made on the server like everything else and comes back
 * as an utterance to fetch, so the phone hears the same voice the desktop
 * chose — but only the window that asked plays it.
 *
 * **Two voices, one per language**, rather than one voice and a language
 * switch. Kokoro's voices are each of one language, and a Spanish voice
 * reading English is a Spanish accent on every word; the server tells
 * which language a reply is in and picks the voice for it, so what is
 * chosen here is the pair.
 *
 * The page also says what is installed. The ears and the Spanish phonemes
 * are Homebrew programs and the model is a download, and a key that does
 * nothing because a program is missing is the worst kind of broken — so
 * each row says found or not, and what to type when not.
 */
import { useEffect, useState } from "react";
import {
  KOKORO_SIZE_MB,
  LANG_NAMES,
  LOCALES,
  VOICE_LANGS,
  keyCodeLabel,
  type VoiceChoice,
  type VoiceLang,
  type VoiceSettings,
  type VoiceStatus,
} from "../../../shared/voice";
import { audioOutput } from "../notify";
import * as api from "../session";
import { useKururu } from "../session";

export function VoiceSettings({ onEditing }: { onEditing: (on: boolean) => void }) {
  const { voice } = useKururu();
  const [capturing, setCapturing] = useState(false);
  const [auditioning, setAuditioning] = useState<VoiceLang | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!capturing) return;
    onEditing(true);
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
      onEditing(false);
    };
  }, [capturing, onEditing, voice]);

  if (!voice) {
    return (
      <div className="set-page">
        <p className="set-note">Waiting for the server…</p>
      </div>
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
    const choice: VoiceChoice = { engine: engine === "system" ? "system" : "kokoro", voice: rest.join(":") };
    set({ voices: { ...settings.voices, [lang]: choice } });
    void audition(choice, lang);
  };

  const modelLine =
    model.state === "ready"
      ? "Downloaded."
      : model.state === "downloading"
        ? `Downloading… ${model.progress}%`
        : model.state === "loading"
          ? "Loading…"
          : model.state === "error"
            ? `Could not load it: ${model.error ?? "unknown"}`
            : `Not downloaded (about ${KOKORO_SIZE_MB} MB, once). Until it is, the machine's own voices speak.`;

  return (
    <div className="set-page">
      <section className="set-section">
        <h3 className="set-h">Voice</h3>
        <p className="set-note">
          Hold the talk key to speak to Kuru, the profile's harness; tap it to leave the microphone open until the next tap.
          What Kuru says at the end of each turn is read aloud. Everything runs on this machine: nothing is sent anywhere.
        </p>
        <label className="set-check set-check-row">
          <input type="checkbox" checked={settings.speak} onChange={(event) => set({ speak: event.target.checked })} />
          Read Kuru's replies aloud
        </label>
        <div className="set-row">
          <span className="set-label">Talk key</span>
          <span className="set-mono">{capturing ? "press a key…" : keyCodeLabel(settings.talkKey)}</span>
          <button className="set-choice set-reset" onClick={() => setCapturing((on) => !on)}>
            {capturing ? "Cancel" : "Change"}
          </button>
          <span className="set-note set-note-inline">— works anywhere in the window</span>
        </div>
        <label className="set-row">
          <span className="set-label">Volume</span>
          <input
            className="set-range"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={settings.volume}
            onChange={(event) => set({ volume: Number(event.target.value) })}
          />
        </label>
        <label className="set-row">
          <span className="set-label">Speed</span>
          <input
            className="set-range"
            type="range"
            min={0.7}
            max={1.5}
            step={0.05}
            value={settings.speed}
            onChange={(event) => set({ speed: Number(event.target.value) })}
          />
          <span className="set-note set-note-inline">{settings.speed.toFixed(2)}×</span>
        </label>
      </section>

      <section className="set-section">
        <h3 className="set-h">Languages</h3>
        <p className="set-note">
          Each clip is heard in every language ticked and the one it was in wins. The first is the tie-breaker.
        </p>
        {VOICE_LANGS.map((lang) => (
          <div key={lang} className="set-row">
            <label className="set-check">
              <input type="checkbox" checked={settings.languages.includes(lang)} onChange={(event) => toggleLang(lang, event.target.checked)} />
              {LANG_NAMES[lang]}
            </label>
            <select
              className="set-select"
              value={settings.locales[lang]}
              disabled={!settings.languages.includes(lang)}
              aria-label={`${LANG_NAMES[lang]} accent`}
              onChange={(event) => set({ locales: { ...settings.locales, [lang]: event.target.value } })}
            >
              {LOCALES[lang].map((locale) => (
                <option key={locale.id} value={locale.id}>
                  {locale.name}
                </option>
              ))}
            </select>
          </div>
        ))}
      </section>

      <section className="set-section">
        <h3 className="set-h">Voices</h3>
        {VOICE_LANGS.filter((lang) => settings.languages.includes(lang)).map((lang) => {
          const chosen = settings.voices[lang];
          const value = `${chosen.engine}:${chosen.voice}`;
          const kokoro = voices.filter((v) => v.engine === "kokoro" && v.lang === lang);
          const system = voices.filter((v) => v.engine === "system" && v.lang === lang);
          const known = voices.some((v) => v.engine === chosen.engine && v.id === chosen.voice);
          return (
            <div key={lang} className="set-row">
              <span className="set-label">{LANG_NAMES[lang]}</span>
              <select className="set-select set-select-wide" value={value} aria-label={`${LANG_NAMES[lang]} voice`} onChange={(event) => choose(lang, event.target.value)}>
                {!known && <option value={value}>{chosen.voice} (not on this machine)</option>}
                <optgroup label="Kokoro">
                  {kokoro.map((v) => (
                    <option key={v.id} value={`kokoro:${v.id}`}>
                      {v.name} — {v.note}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="This Mac">
                  {system.map((v) => (
                    <option key={v.id} value={`system:${v.id}`}>
                      {v.name} — {v.note}
                    </option>
                  ))}
                </optgroup>
              </select>
              <button className="set-choice" disabled={auditioning !== null} onClick={() => void audition(chosen, lang)}>
                {auditioning === lang ? "…" : "Hear it"}
              </button>
            </div>
          );
        })}
        {problem && <p className="set-warn">{problem}</p>}
        <p className="set-note set-note-under">
          Kokoro is the better voice and runs on this machine's CPU. The Mac's own voices need nothing and are used
          until Kokoro is ready, and for Spanish until espeak-ng is installed.
        </p>
      </section>

      <section className="set-section">
        <h3 className="set-h">On this machine</h3>
        <div className="set-row">
          <span className="set-label">Ears</span>
          <span className={`set-note set-note-inline ${ears.ok ? "" : "set-note-bad"}`}>
            {ears.ok ? `yap — ${ears.detail}` : ears.detail}
          </span>
        </div>
        <div className="set-row">
          <span className="set-label">Voice model</span>
          <span className={`set-note set-note-inline ${model.state === "error" ? "set-note-bad" : ""}`}>{modelLine}</span>
          {(model.state === "missing" || model.state === "error") && (
            <button className="button" onClick={() => api.downloadVoiceModel()}>
              Download
            </button>
          )}
        </div>
        <div className="set-row">
          <span className="set-label">Spanish</span>
          <span className={`set-note set-note-inline ${spanish.ok ? "" : "set-note-bad"}`}>
            {spanish.ok ? `espeak-ng — ${spanish.detail}` : spanish.detail}
          </span>
        </div>
        <p className="set-note set-note-under">
          The ears are Apple's on-device recogniser through <code>yap</code>; a language's model is fetched by macOS the
          first time it is asked for. On a phone the microphone needs https — see <code>docs/voice.md</code>.
        </p>
      </section>
    </div>
  );
}
