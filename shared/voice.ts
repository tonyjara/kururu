/**
 * Talking to the harness, and hearing it: the vocabulary of kururu's voice.
 *
 * The decision this module embodies is that the voice is *not* a second
 * brain. Project after project that put speech in front of a coding agent
 * reached for a speech-to-speech model and ended up with two personalities —
 * one that talks and one that thinks — and a bill per minute for the one that
 * only talks. Kuru is the harness session (`harness.ts`), the same one you
 * type to; what is added is a pair of ears and a mouth around it. Your speech
 * becomes text and is typed into its terminal as your turn; the last message
 * of each of its turns becomes speech. Nothing in between generates a word.
 *
 * Both ears and mouth are local. Transcription is Apple's on-device
 * recogniser through `yap`, and speech is Kokoro, an 82-million-parameter
 * model that runs on the CPU faster than it talks, with the machine's own
 * `say` voices as the fallback that needs nothing installed. No key, no
 * account, nothing leaves the machine — which is also the property that lets
 * the phone use it: the server does the hearing and the speaking, and a phone
 * only ever sends a WAV and plays one back.
 *
 * This file is the pure half: the settings, the catalogue of voices, the
 * text-to-speech grammar (what of a reply is worth saying aloud, and in which
 * language), the choice between two transcripts of one clip, and the WAV
 * encoder the window uses. `server/src/voice.ts` is the half that runs the
 * programs; `web/src/voice.ts` is the half that holds the microphone.
 */

/** The two languages Kuru is spoken to in, and in which it answers. The order is the user's preference. */
export type VoiceLang = "en" | "es";
export const VOICE_LANGS: readonly VoiceLang[] = ["en", "es"];

export const LANG_NAMES: Record<VoiceLang, string> = { en: "English", es: "Spanish" };

/**
 * The transcription locales Apple's recogniser offers for each language, as
 * `yap` lists them. A locale is a *model* on the recogniser's side — one is
 * downloaded the first time it is asked for — so the choice is kept to the
 * ones somebody would actually speak and not every variant Apple ships.
 */
export const LOCALES: Record<VoiceLang, readonly { id: string; name: string }[]> = {
  en: [
    { id: "en-US", name: "English (US)" },
    { id: "en-GB", name: "English (UK)" },
    { id: "en-AU", name: "English (Australia)" },
    { id: "en-CA", name: "English (Canada)" },
    { id: "en-IE", name: "English (Ireland)" },
    { id: "en-IN", name: "English (India)" },
    { id: "en-NZ", name: "English (New Zealand)" },
    { id: "en-SG", name: "English (Singapore)" },
    { id: "en-ZA", name: "English (South Africa)" },
  ],
  es: [
    { id: "es-MX", name: "Spanish (Mexico)" },
    { id: "es-ES", name: "Spanish (Spain)" },
    { id: "es-US", name: "Spanish (US)" },
    { id: "es-CL", name: "Spanish (Chile)" },
  ],
};

/** Which program says the words. */
export type VoiceEngine = "kokoro" | "system";

/** One voice: the engine and its name for it — `af_heart`, or `Samantha (English (US))`. */
export interface VoiceChoice {
  engine: VoiceEngine;
  voice: string;
}

export interface VoiceSettings {
  /** Kuru's replies are read aloud. Off, the key still works and the reply is only on screen. */
  speak: boolean;
  /** The languages you speak to it, in order of preference. At least one. */
  languages: VoiceLang[];
  /** The recogniser's locale per language. */
  locales: Record<VoiceLang, string>;
  /** The voice it answers in, per language. */
  voices: Record<VoiceLang, VoiceChoice>;
  /** Kokoro's speed. 1 is as trained; 1.2 is brisk. */
  speed: number;
  /** 0–1, on the window's output. Its own, not the notification volume — a croak and a sentence want different levels. */
  volume: number;
  /**
   * The key that talks, as a `KeyboardEvent.code`. The default is the right
   * Control key: a modifier on its own types nothing into a terminal and is
   * the one key on the board that nothing else in kururu asks for.
   */
  talkKey: string;
}

export const DEFAULT_VOICE: VoiceSettings = {
  speak: true,
  languages: ["en", "es"],
  locales: { en: "en-US", es: "es-MX" },
  voices: {
    en: { engine: "kokoro", voice: "af_heart" },
    es: { engine: "kokoro", voice: "ef_dora" },
  },
  speed: 1,
  volume: 1,
  talkKey: "ControlRight",
};

/** Kokoro's model on the Hub, and roughly what the quantised build weighs — for the sentence beside the download button. */
export const KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
export const KOKORO_SIZE_MB = 92;

/**
 * Kokoro's voices for the two languages, with the model card's grades.
 *
 * Listed here rather than read from the library because the library knows
 * only the English ones: its phonemiser is English-only, so it refuses a
 * Spanish voice by name even though the voice itself is shipped with it.
 * kururu phonemises Spanish through `espeak-ng` and drives the model
 * directly, which is what lets `ef_dora` be in this list — see
 * `server/src/voice.ts`.
 */
export interface KokoroVoice {
  id: string;
  name: string;
  lang: VoiceLang;
  gender: "F" | "M";
  /** The model card's overall grade, so the picker can put the good ones first. */
  grade: string;
}

export const KOKORO_VOICES: readonly KokoroVoice[] = [
  { id: "af_heart", name: "Heart", lang: "en", gender: "F", grade: "A" },
  { id: "af_bella", name: "Bella", lang: "en", gender: "F", grade: "A-" },
  { id: "af_nicole", name: "Nicole", lang: "en", gender: "F", grade: "B-" },
  { id: "bf_emma", name: "Emma (British)", lang: "en", gender: "F", grade: "B-" },
  { id: "af_aoede", name: "Aoede", lang: "en", gender: "F", grade: "C+" },
  { id: "af_kore", name: "Kore", lang: "en", gender: "F", grade: "C+" },
  { id: "af_sarah", name: "Sarah", lang: "en", gender: "F", grade: "C+" },
  { id: "am_fenrir", name: "Fenrir", lang: "en", gender: "M", grade: "C+" },
  { id: "am_michael", name: "Michael", lang: "en", gender: "M", grade: "C+" },
  { id: "am_puck", name: "Puck", lang: "en", gender: "M", grade: "C+" },
  { id: "bm_george", name: "George (British)", lang: "en", gender: "M", grade: "C" },
  { id: "bm_fable", name: "Fable (British)", lang: "en", gender: "M", grade: "C" },
  { id: "bf_isabella", name: "Isabella (British)", lang: "en", gender: "F", grade: "C" },
  { id: "af_alloy", name: "Alloy", lang: "en", gender: "F", grade: "C" },
  { id: "af_nova", name: "Nova", lang: "en", gender: "F", grade: "C" },
  { id: "af_sky", name: "Sky", lang: "en", gender: "F", grade: "C-" },
  { id: "am_echo", name: "Echo", lang: "en", gender: "M", grade: "D" },
  { id: "am_eric", name: "Eric", lang: "en", gender: "M", grade: "D" },
  { id: "am_liam", name: "Liam", lang: "en", gender: "M", grade: "D" },
  { id: "am_onyx", name: "Onyx", lang: "en", gender: "M", grade: "D" },
  { id: "bm_lewis", name: "Lewis (British)", lang: "en", gender: "M", grade: "D+" },
  { id: "bm_daniel", name: "Daniel (British)", lang: "en", gender: "M", grade: "D" },
  { id: "ef_dora", name: "Dora", lang: "es", gender: "F", grade: "—" },
  { id: "em_alex", name: "Alex", lang: "es", gender: "M", grade: "—" },
  { id: "em_santa", name: "Santa", lang: "es", gender: "M", grade: "—" },
];

export function kokoroVoice(id: string): KokoroVoice | undefined {
  return KOKORO_VOICES.find((voice) => voice.id === id);
}

/** A voice the picker can offer: either engine, one shape. */
export interface VoiceOption {
  engine: VoiceEngine;
  id: string;
  name: string;
  lang: VoiceLang;
  /** The model card's grade for a Kokoro voice; the locale for a system one. */
  note: string;
}

/**
 * The machine's own voices, off `say -v '?'`.
 *
 * One line each: the name, the locale, and a sample sentence after a `#`. The
 * name may hold spaces and parentheses (`Eddy (Spanish (Mexico))`) and the
 * locale is the one token shaped `xx_YY`, so the line is split on that rather
 * than on columns. A voice with an Enhanced copy installed is listed twice
 * under one name, and `say -v` takes the name, so the second is dropped. Only
 * the two languages Kuru speaks are kept.
 */
export function parseSayVoices(listing: string): VoiceOption[] {
  const seen = new Set<string>();
  const out: VoiceOption[] = [];
  for (const line of listing.split("\n")) {
    const match = /^(.*?)\s+([a-z]{2,3})_([A-Za-z0-9]{2,})\s+#/.exec(line);
    if (!match) continue;
    const name = match[1]!.trim();
    const lang = match[2]!;
    if (!name || seen.has(name) || (lang !== "en" && lang !== "es")) continue;
    seen.add(name);
    out.push({ engine: "system", id: name, name, lang, note: `${lang}_${match[3]}` });
  }
  return out;
}

/** The voice to fall back to when the chosen one cannot speak right now: the machine's, in that language. */
export function systemFallback(lang: VoiceLang, system: readonly VoiceOption[]): VoiceChoice | null {
  const preferred = lang === "en" ? ["Samantha", "Ava", "Allison", "Daniel"] : ["Mónica", "Paulina", "Jorge", "Juan"];
  const ours = system.filter((voice) => voice.lang === lang);
  for (const name of preferred) {
    const hit = ours.find((voice) => voice.name === name || voice.name.startsWith(`${name} (`));
    if (hit) return { engine: "system", voice: hit.id };
  }
  const any = ours[0];
  return any ? { engine: "system", voice: any.id } : null;
}

// ---------------------------------------------------------------------------
// Which language
// ---------------------------------------------------------------------------

/**
 * The commonest words of each language, for telling which one a reply is in.
 *
 * Function words rather than a dictionary: they are the words no sentence in
 * the language goes without and the words the other language never uses, so a
 * few dozen of each decide a sentence of ten words. Only words that are
 * *not* shared — `a`, `no`, `me`, `son` are in both and would vote for both —
 * and nothing that is a programming term, since a Spanish sentence about `git
 * commit` is still Spanish.
 */
const STOPWORDS: Record<VoiceLang, ReadonlySet<string>> = {
  en: new Set([
    "the", "and", "is", "are", "was", "were", "it", "its", "it's", "to", "of", "in", "on", "for", "with", "that", "this",
    "there", "here", "you", "your", "i", "i'm", "i've", "we", "they", "he", "she", "has", "have", "had", "not", "but", "or",
    "an", "at", "by", "from", "be", "been", "will", "would", "can", "could", "should", "do", "does", "did", "done",
    "what", "which", "when", "where", "who", "how", "now", "then", "still", "yet", "also", "just", "one", "two", "three",
    "all", "any", "some", "if", "so", "as", "than", "into", "about", "after", "before", "while", "running", "finished",
    "waiting", "started", "agent", "agents", "card", "cards", "board", "turn", "nothing", "something", "both",
  ]),
  es: new Set([
    "el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del", "que", "qué", "y", "en", "es", "está", "están",
    "son", "por", "para", "con", "sin", "se", "su", "sus", "lo", "le", "les", "al", "ya", "pero", "como", "cómo",
    "cuando", "cuándo", "donde", "dónde", "quién", "porque", "también", "muy", "más", "menos", "este", "esta", "esto",
    "ese", "esa", "eso", "hay", "fue", "ser", "estar", "tiene", "tienen", "hace", "hacer", "puede", "pueden", "todo",
    "todos", "nada", "algo", "ahora", "luego", "aún", "todavía", "sí", "tarjeta", "tarjetas", "tablero", "agente",
    "agentes", "terminó", "esperando", "corriendo", "trabajando", "nuevo", "nueva", "dos", "tres", "uno",
  ]),
};

const WORD = /[\p{L}\p{M}'’]+/gu;

/**
 * Which of the user's languages a text is in — the one whose function words
 * it uses more of, per word, with the first-listed language winning a tie and
 * an empty text. Decides which voice reads a reply and which transcript of a
 * clip is the real one, and is deliberately a count and not a model: a reply
 * is a few sentences long and the answer has to be instant.
 */
export function detectLanguage(text: string, languages: readonly VoiceLang[]): VoiceLang {
  const first = languages[0] ?? "en";
  if (languages.length < 2) return first;
  const words = (text.toLowerCase().match(WORD) ?? []).filter((w) => w.length > 0);
  if (!words.length) return first;
  let best = first;
  let bestScore = -1;
  for (const lang of languages) {
    const set = STOPWORDS[lang];
    let hits = 0;
    for (const word of words) if (set.has(word)) hits++;
    const score = hits / words.length;
    if (score > bestScore) {
      best = lang;
      bestScore = score;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Which transcript
// ---------------------------------------------------------------------------

export interface Transcript {
  lang: VoiceLang;
  text: string;
}

/**
 * Of one clip transcribed once per language, the transcript that is of what
 * was said.
 *
 * Apple's recogniser is one model per locale and has no language detection,
 * so a clip is run through every language the user speaks and the results
 * compared. The wrong model's output is recognisable: the Spanish model
 * hearing English writes Spanish-looking nonsense with almost none of the
 * language's function words in it, and the English one hearing Spanish writes
 * a row of commas. So a transcript with no letters is out, and of the rest
 * the one that uses more of its own language's commonest words — per word —
 * wins, with the user's first language taking a tie. A clip that is half and
 * half goes to whichever half was longer, and the other half is garbled
 * either way; that is the recogniser's limit, not a bug here.
 */
export function pickTranscript(candidates: readonly Transcript[], languages: readonly VoiceLang[]): Transcript | null {
  const real = candidates.filter((c) => /\p{L}/u.test(c.text));
  if (!real.length) return null;
  if (real.length === 1) return real[0]!;
  const order = (lang: VoiceLang) => {
    const i = languages.indexOf(lang);
    return i < 0 ? languages.length : i;
  };
  let best: Transcript | null = null;
  let bestScore = -1;
  for (const candidate of real) {
    const words = candidate.text.toLowerCase().match(WORD) ?? [];
    if (!words.length) continue;
    let hits = 0;
    for (const word of words) if (STOPWORDS[candidate.lang].has(word)) hits++;
    const score = hits / words.length;
    if (score > bestScore || (score === bestScore && best && order(candidate.lang) < order(best.lang))) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// What to say
// ---------------------------------------------------------------------------

/** The most of a reply that is read aloud. Kuru is told its replies are spoken and to keep them short; this is for when it forgets. */
export const SPOKEN_MAX = 1600;

/**
 * A reply as speech: the markdown taken out, the code left unsaid, the length
 * held.
 *
 * Code blocks are replaced by a word rather than read, because a synthesiser
 * reading a diff is a minute of punctuation and nobody wanted it; the role
 * prompt tells Kuru to put such things on a card. Inline code keeps its text,
 * since `a220` in a sentence is a name. Lists become sentences, headings
 * become sentences, links become their text. The cut, when it comes, is at a
 * sentence end so the voice does not stop mid-word.
 */
export function spokenText(markdown: string): string {
  let text = markdown
    .replace(/```[\s\S]*?```/g, " (code left out) ")
    .replace(/~~~[\s\S]*?~~~/g, " (code left out) ")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+(.*)$/gm, "$1.")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/^\s*[-*_]{3,}\s*$/gm, " ")
    .replace(/\|/g, ", ")
    .replace(/https?:\/\/\S+/g, " a link ")
    .replace(/\s*\n\s*\n\s*/g, ". ")
    .replace(/\s*\n\s*/g, ", ")
    .replace(/\.\s*\./g, ".")
    .replace(/,\s*\./g, ".")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > SPOKEN_MAX) {
    const cut = text.slice(0, SPOKEN_MAX);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
    text = end > SPOKEN_MAX / 2 ? cut.slice(0, end + 1) : `${cut.trimEnd()}.`;
  }
  return text;
}

/**
 * A reply into sentences, each short enough for one Kokoro pass.
 *
 * Kokoro takes about 500 phonemes a call and is fastest well under that, and
 * the first sentence is what the user is waiting for — so a reply is spoken a
 * sentence at a time, each one on its way to the window while the next is
 * being made. Sentences end at `.`, `?` or `!` followed by space; a run with
 * no such end is cut at a comma, and failing that at a word, near the limit.
 */
export function sentencesOf(text: string, max = 300): string[] {
  const out: string[] = [];
  const parts = text.match(/[^.!?]+[.!?]+["»)]?\s*|[^.!?]+$/g) ?? [text];
  for (const raw of parts) {
    let part = raw.trim();
    while (part.length > max) {
      let at = part.lastIndexOf(", ", max);
      if (at < max / 3) at = part.lastIndexOf(" ", max);
      if (at <= 0) at = max;
      out.push(part.slice(0, at + 1).trim());
      part = part.slice(at + 1).trim();
    }
    if (part) out.push(part);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The clip
// ---------------------------------------------------------------------------

/** What the window records at. The recogniser is happy with anything; 16 kHz mono is what speech models expect and is 32 kB a second. */
export const CLIP_RATE = 16_000;
/** The most of a clip the server will take: a minute and a half at that rate, which is a speech, not a command. */
export const CLIP_MAX_BYTES = 3 * 1024 * 1024;
/** Shorter than this and nothing was said — a tap in toggle mode let go before the microphone was warm. */
export const CLIP_MIN_MS = 300;
/** Held longer than this, the talk key is a hold and stops on release; shorter is a tap, which toggles. */
export const TAP_MS = 320;

/**
 * 16-bit little-endian PCM in a RIFF header: the WAV the window posts.
 *
 * Written here rather than with a library because it is forty-four bytes of
 * header over the samples, and because it is the one shape every program on
 * the far side — the recogniser, `afconvert`, a browser's decoder — agrees
 * on without being asked.
 */
export function encodeWav(samples: Float32Array, rate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let at = 44;
  for (let i = 0; i < samples.length; i++, at += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(at, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

/**
 * Fewer samples, by averaging. A browser that would not open the microphone
 * at 16 kHz gives 44.1 or 48, and the ratio is not whole — so each output
 * sample is the mean of the input samples that fall under it, which is a
 * box filter and good enough for speech going into a recogniser.
 */
export function downsample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to || from < to) return samples;
  const ratio = from / to;
  const length = Math.floor(samples.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += samples[j]!;
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

/** The duration a WAV at `CLIP_RATE` holds, from its byte length — for refusing a tap. */
export function clipMs(bytes: number, rate = CLIP_RATE): number {
  return Math.max(0, ((bytes - 44) / 2 / rate) * 1000);
}

// ---------------------------------------------------------------------------
// The settings off the disk or the wire
// ---------------------------------------------------------------------------

/**
 * Settings from anywhere, made whole. Every field has the default behind it,
 * every number is finite and in range, and the languages are at least one
 * and are the two this module knows: a file from a later version with a third
 * language in it loses that language rather than crashing the page.
 */
export function adoptVoice(value: unknown): VoiceSettings {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const languages = Array.isArray(raw.languages)
    ? (raw.languages.filter((l): l is VoiceLang => l === "en" || l === "es") as VoiceLang[]).filter((l, i, a) => a.indexOf(l) === i)
    : [...DEFAULT_VOICE.languages];
  const locales = { ...DEFAULT_VOICE.locales };
  const rawLocales = (raw.locales && typeof raw.locales === "object" ? raw.locales : {}) as Record<string, unknown>;
  for (const lang of VOICE_LANGS) {
    const id = rawLocales[lang];
    if (typeof id === "string" && LOCALES[lang].some((l) => l.id === id)) locales[lang] = id;
  }
  const voices = { en: { ...DEFAULT_VOICE.voices.en }, es: { ...DEFAULT_VOICE.voices.es } };
  const rawVoices = (raw.voices && typeof raw.voices === "object" ? raw.voices : {}) as Record<string, unknown>;
  for (const lang of VOICE_LANGS) {
    const choice = rawVoices[lang] as { engine?: unknown; voice?: unknown } | undefined;
    if (choice && (choice.engine === "kokoro" || choice.engine === "system") && typeof choice.voice === "string" && choice.voice.trim()) {
      voices[lang] = { engine: choice.engine, voice: choice.voice.trim().slice(0, 80) };
    }
  }
  const num = (v: unknown, fallback: number, lo: number, hi: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
  return {
    speak: typeof raw.speak === "boolean" ? raw.speak : DEFAULT_VOICE.speak,
    languages: languages.length ? languages : [...DEFAULT_VOICE.languages],
    locales,
    voices,
    speed: num(raw.speed, DEFAULT_VOICE.speed, 0.5, 2),
    volume: num(raw.volume, DEFAULT_VOICE.volume, 0, 1),
    talkKey: typeof raw.talkKey === "string" && /^[A-Za-z0-9]{1,32}$/.test(raw.talkKey) ? raw.talkKey : DEFAULT_VOICE.talkKey,
  };
}

/** A `KeyboardEvent.code` as a person would say it, for the settings row. */
export function keyCodeLabel(code: string): string {
  const named: Record<string, string> = {
    ControlRight: "Right Control",
    ControlLeft: "Left Control",
    AltRight: "Right Option",
    AltLeft: "Left Option",
    MetaRight: "Right Command",
    MetaLeft: "Left Command",
    ShiftRight: "Right Shift",
    ShiftLeft: "Left Shift",
    CapsLock: "Caps Lock",
    Space: "Space",
    Backquote: "`",
  };
  if (named[code]) return named[code]!;
  const fn = /^F(\d{1,2})$/.exec(code);
  if (fn) return `F${fn[1]}`;
  const key = /^Key([A-Z])$/.exec(code);
  if (key) return key[1]!;
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1]!;
  return code;
}

// ---------------------------------------------------------------------------
// What the clients are told
// ---------------------------------------------------------------------------

/** Whether a program the voice needs is on this machine, and the sentence to show when it is not. */
export interface ToolStatus {
  ok: boolean;
  /** What it is, when found — a version — and what to do, when not. */
  detail: string;
}

/** The speech model: where it is between absent and ready. */
export interface ModelStatus {
  state: "missing" | "downloading" | "loading" | "ready" | "error";
  /** 0–100 while downloading. */
  progress: number;
  error: string | null;
}

/** Everything a window needs to draw Settings → Voice and to know whether the key will do anything. Never carries audio. */
export interface VoiceStatus {
  settings: VoiceSettings;
  /** `yap`, the ears. */
  ears: ToolStatus;
  /** `espeak-ng`, which Spanish needs for Kokoro. English does not. */
  spanish: ToolStatus;
  /** Kokoro. */
  model: ModelStatus;
  /** Every voice the picker can offer, both engines. */
  voices: VoiceOption[];
}

/** One sentence of an utterance, ready to play. The bytes are fetched, not sent, so the socket carries only words. */
export interface SpeechChunk {
  /** The utterance this is a sentence of. */
  utterance: string;
  /** Its place in the utterance, from 0. */
  seq: number;
  /**
   * Whether it is the reply's last sentence. A sentence is announced as it is
   * made and one the engine chokes on is skipped, so a reply whose last
   * sentence failed never sends one marked last — nothing waits on it.
   */
  last: boolean;
  /** What is said, for the pill. */
  text: string;
  lang: VoiceLang;
  /** Which profile's harness is speaking. */
  profileId: string;
}

/** What came of a clip: what was heard, and what became of it. */
export interface Heard {
  text: string;
  lang: VoiceLang | null;
  /**
   * `typed`: typed into the harness's terminal, as the user. `held`: waiting
   * to be — it is showing a prompt, or the user is typing there. `starting`:
   * the harness was not running and has been started; the words follow once
   * it is listening. `nothing`: the clip held no words. `failed`: with `why`.
   */
  outcome: "typed" | "held" | "starting" | "nothing" | "failed";
  why: string | null;
}

// ---------------------------------------------------------------------------
// What was missed
// ---------------------------------------------------------------------------

/**
 * What a reply that is not the newest thing Kuru said starts with, so it is
 * not taken for the answer to what was just said. `while`: it was said, or
 * came out, while somebody was talking, and waited. `earlier`: it is a
 * missed reply played again, on asking.
 */
export type LeadIn = "while" | "earlier";

export const LEAD_INS: Record<LeadIn, Record<VoiceLang, string>> = {
  while: { en: "While you were talking.", es: "Mientras hablabas." },
  earlier: { en: "Earlier.", es: "Antes." },
};

/** One reply of Kuru's that nobody played to its end. Text and not audio: it is spoken again from the words, in whatever voice is chosen then. */
export interface MissedReply {
  /** The utterance it was. */
  id: string;
  profileId: string;
  /** As it would have been heard: `spokenText` of the reply. */
  text: string;
  lang: VoiceLang;
  /** When it was said, epoch ms. */
  at: number;
}

/** The most missed replies kept per profile. A day away is a few dozen; older than that is the transcript's to hold. */
export const MISSED_MAX = 30;

/**
 * Missed replies from the disk, made whole: anything not shaped like one is
 * dropped rather than trusted, and each profile keeps its newest
 * `MISSED_MAX`. `pending` is kept as it was written, for the server to decide
 * what a reply in flight when the last one died has become.
 */
export function adoptMissed(value: unknown): (MissedReply & { pending: boolean })[] {
  if (!Array.isArray(value)) return [];
  const out: (MissedReply & { pending: boolean })[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== "string" || !r.id || seen.has(r.id)) continue;
    if (typeof r.profileId !== "string" || !r.profileId) continue;
    if (typeof r.text !== "string" || !r.text.trim()) continue;
    if (typeof r.at !== "number" || !Number.isFinite(r.at)) continue;
    seen.add(r.id);
    out.push({
      id: r.id.slice(0, 80),
      profileId: r.profileId.slice(0, 80),
      text: r.text.slice(0, SPOKEN_MAX),
      lang: r.lang === "es" ? "es" : "en",
      at: r.at,
      pending: r.pending === true,
    });
  }
  return capMissed(out);
}

/** The newest `MISSED_MAX` of each profile, in the order they were said. */
export function capMissed<T extends MissedReply>(list: readonly T[]): T[] {
  const sorted = [...list].sort((a, b) => a.at - b.at);
  const count = new Map<string, number>();
  const kept: T[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const entry = sorted[i]!;
    const n = count.get(entry.profileId) ?? 0;
    if (n >= MISSED_MAX) continue;
    count.set(entry.profileId, n + 1);
    kept.push(entry);
  }
  return kept.reverse();
}
