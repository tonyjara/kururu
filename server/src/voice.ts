/**
 * The harness's ears and mouth: a clip into words, and words into a WAV.
 *
 * Why this is on the server and not in the window, when the window is the
 * one holding the microphone: the two programs that do the work live on this
 * machine. `yap` is Apple's on-device recogniser behind a command line, and
 * Kokoro is an 82-million-parameter model, loaded once and kept in a process
 * of its own beside the server (`kokoro.ts` says why it is not in this one).
 * Neither is a thing a phone could run, and a phone is the client this
 * was most wanted on. So a client posts a WAV and plays a WAV, and everything
 * between — which language was spoken, which voice answers, where the words
 * go — is decided here, once, for every client at once. It is also what
 * keeps the voice off the pty host: a reply is heard about through the same
 * hook report that already told the harness what was said.
 *
 * **Nothing in here holds audio for long.** An utterance is rendered a
 * sentence at a time, each sentence is announced on the socket the moment it
 * is ready and fetched by whoever wants to play it, and the last two dozen
 * utterances are kept so a phone that was slow to fetch is not told about a
 * sentence that has gone. Utterances are rendered one after another, so the
 * socket carries them in the order they were said and the player only has to
 * keep to the order it was told. A clip is not this module's to keep: it is
 * the outbox's file (`outbox.ts`), kept until Kuru has the words, and the
 * recogniser reads it where it lies.
 *
 * **Nobody is spoken over, and nothing said is lost.** A client says when its
 * talk key goes down and again once the server has its clip, the outbox says
 * so for each clip until its words have reached Kuru, and while anybody is
 * talking every client is told to hold what it is sent (`hush`):
 * the phone on the desk must not answer over the window's microphone any
 * more than the window itself should. Sentences go on being made and
 * announced, so a reply waiting out somebody's sentence is ready the moment
 * they stop, and it plays then — ahead of the answer to what was just said,
 * which is made after it — starting with "While you were talking" so it is
 * not taken for that answer. It used to be dropped once the words got
 * through, on the argument that Kuru would answer with it in front of it
 * anyway. The reply that taught otherwise said a card had finished, and Kuru
 * answering something else does not repeat news.
 *
 * **What was missed is decided here, from what the clients say.** Each says
 * which replies it holds, which sentences it played to their end, and which
 * replies it let go before their end. A reply whose last sentence somebody
 * played was heard; one that every client holding it let go, or that nobody
 * took up at all — no window open, none that could play — was missed
 * (`fateOf`). The missed are kept as words in a file in the state directory,
 * and from the moment they are said rather than the moment they are missed:
 * a server that dies mid-reply, which under `bun run dev` is every save,
 * leaves the reply missed and not forgotten. `replay` says them again, each
 * starting "Earlier", and a replay heard to its end takes its reply off the
 * list.
 *
 * **Spanish is the reason the model is driven by hand.** The library that
 * wraps Kokoro phonemises through an English-only port of espeak and refuses
 * a Spanish voice by name, although it ships one. Kokoro itself was trained
 * on espeak-ng's phonemes for every language but English, so Spanish goes
 * through the real `espeak-ng`, with the same handful of substitutions the
 * model's own tokeniser was trained against, and straight into the model —
 * the library's phonemiser is used for English and nothing else.
 *
 * On the restartable side. Editing it costs a reconnect, and the first
 * sentence after a restart costs the second or two the model takes to load,
 * because the Kokoro process goes down with the server that started it.
 */
import { execFile, fork, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  CLIP_ROLL_MS,
  KOKORO_MODEL,
  KOKORO_VOICES,
  LEAD_INS,
  adoptMissed,
  adoptVoice,
  capMissed,
  detectLanguage,
  kokoroVoice,
  parseSayVoices,
  pickTranscript,
  sentencesOf,
  spokenText,
  systemFallback,
  type LeadIn,
  type MissedReply,
  type ModelStatus,
  type SpeechChunk,
  type ToolStatus,
  type Transcript,
  type VoiceChoice,
  type VoiceLang,
  type VoiceOption,
  type VoiceSettings,
  type VoiceStatus,
} from "../../shared/voice";
import type { ServerMessage } from "../../shared/wire";
import { readConfigFile, writeConfigFile } from "./config";
import type { FromKokoro, ToKokoro } from "./kokoro";

const run = promisify(execFile);

const FILE = "voice.json";

/** How long the recogniser may take on one clip, over the clip's own length. It takes half a second; this is for a locale whose model is still downloading. */
const HEAR_TIMEOUT_MS = 60_000;
/** How long one sentence of speech may take to make. Kokoro does a sentence in a second; `say` in less. */
const SAY_TIMEOUT_MS = 30_000;
/** How many utterances are kept for fetching. A phone that is slow to fetch gets the last few; nothing older is anybody's business. */
const KEEP_UTTERANCES = 24;
/**
 * How long a client may say it is talking before it is not believed. A
 * clip runs five minutes before the window rolls it into the next
 * (`CLIP_ROLL_MS`), a long one takes the recogniser a while more and a new
 * locale a minute on top, so this is past anything a working client does.
 * A socket that goes takes its say with it; this is for one that stays and
 * never says it stopped, since Kuru silent everywhere for good is worse
 * than Kuru heard over a broken window.
 */
const TALK_MAX_MS = CLIP_ROLL_MS + 3 * 60_000;
/**
 * How long a reply nobody took up waits before it is missed. A client says
 * it holds a reply once the first sentence reaches it, which for a reply of
 * one sentence is a few milliseconds after that sentence was the last one
 * made — so "done and nobody holds it" is true for a moment of every short
 * reply, and counting it then would flash the badge for each of them.
 */
const UNHELD_GRACE_MS = 2_000;
/** The sentence a voice is auditioned with, in each language. */
const PREVIEW: Record<VoiceLang, string> = {
  en: "Three agents are running. The login card finished its turn, and one is waiting on you.",
  es: "Tres agentes están trabajando. La tarjeta del login terminó, y uno está esperando.",
};
/** Where Homebrew puts things, for a server whose PATH was not a shell's. */
const BREW_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

/**
 * espeak-ng's tie character, and what the model's tokeniser was trained to
 * see in its place. These are misaki's — the phonemiser Kokoro was trained
 * through — applied in the same order, longest first. The tie binds the two
 * halves of an affricate or a diphthong; the tokeniser has one symbol for
 * each. Anything still tied afterwards is untied and left as its parts.
 */
const TIE = "͡";
const ESPEAK_TO_MODEL: readonly [string, string][] = [
  [`a${TIE}ɪ`, "I"],
  [`a${TIE}ʊ`, "W"],
  [`d${TIE}z`, "ʣ"],
  [`d${TIE}ʒ`, "ʤ"],
  [`e${TIE}ɪ`, "A"],
  [`o${TIE}ʊ`, "O"],
  [`ə${TIE}ʊ`, "Q"],
  [`s${TIE}s`, "S"],
  [`t${TIE}s`, "ʦ"],
  [`t${TIE}ʃ`, "ʧ"],
  [`ɔ${TIE}ɪ`, "Y"],
];

/** What `index.ts` lends this module. */
export interface VoiceDeps {
  broadcast: (msg: ServerMessage) => void;
}

/**
 * The Kokoro process: beside this bundle, as the pty host is. In the app that
 * is `Resources/server`, so it finds the voice's packages by the same walk up
 * to `Resources/node_modules` that the server does.
 */
const KOKORO_ENTRY = fileURLToPath(new URL("./kokoro.mjs", import.meta.url));

/** The running Kokoro process, and the sentences it has been asked for and not yet answered. */
interface Speaker {
  child: ChildProcess;
  waiting: Map<number, { resolve: (wav: Buffer) => void; reject: (err: Error) => void }>;
}

/** One sentence for it: English as text, Spanish as the phonemes `phonemesEs` made. */
type SpeakRequest = { voice: string; speed: number } & ({ text: string } | { phonemes: string });

export interface Utterance {
  id: string;
  /** Its place in the order utterances were made. */
  n: number;
  /** Whose harness said it; empty for an audition. */
  profileId: string;
  /** An audition, which only the window that asked hears. Never held, never missed. */
  quiet: boolean;
  /** What it says, as spoken — what the missed list keeps. */
  text: string;
  lang: VoiceLang;
  chunks: Buffer[];
  at: number;
  /** Said while somebody was talking, so it waited, and starts by saying so. */
  during: boolean;
  /** What it starts with, when that is known before the first sentence: a replay's "Earlier". */
  lead: LeadIn | null;
  /** The missed reply this says again. A replay is never missed itself; its reply stays on the list instead. */
  replays: string | null;
  /** The clients that have it queued or playing, keyed as `talkers` are. */
  holders: Set<object>;
  /** Sentences somebody played to their end. */
  played: Set<number>;
  /** A client let it go before its end. With nobody else holding it, nothing more of it is made. */
  dropped: boolean;
  /** Every sentence has been made, or failed to be, or it was let go everywhere. */
  done: boolean;
  doneAt: number;
  /** What came of it, once that is known. Heard is final; missed becomes heard if a late client plays it out. */
  fate: Fate | null;
}

export type Fate = "heard" | "missed";

/** A missed reply as the server keeps it: pending while it may yet be heard, and the replay of it in flight. */
interface Missed extends MissedReply {
  pending: boolean;
  replaying: string | null;
}

/** Where the missed list is kept: the state directory, since it is a thing kururu wants back and nobody chose. */
function missedPath(): string {
  const dir = process.env.KURURU_STATE_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "kururu");
  return join(dir, "missed.json");
}

export class Voice {
  private settings: VoiceSettings;
  private readonly utterances = new Map<string, Utterance>();
  private utteranceCount = 0;
  /** Every reply not yet heard, the pending ones included, oldest first. */
  private missed: Missed[];
  /** When `review` looks again for a reply nobody took up. */
  private reviewTimer: ReturnType<typeof setTimeout> | null = null;
  /** One utterance after another, so two replies landing together do not interleave sentences. */
  private queue: Promise<void> = Promise.resolve();
  private system: VoiceOption[] = [];
  private ears: ToolStatus = { ok: false, detail: "Looking…" };
  private spanish: ToolStatus = { ok: false, detail: "Looking…" };
  private model: ModelStatus = { state: "missing", progress: 0, error: null };
  /** The Kokoro process once it has loaded the model, or while it is loading it. */
  private speaker: Promise<Speaker> | null = null;
  private child: ChildProcess | null = null;
  private requests = 0;
  private lastProgressSent = -1;
  /** The clients talking, each with the timer that stops believing it. Keyed by whatever `index.ts` knows a client by. */
  private readonly talkers = new Map<object, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: VoiceDeps) {
    this.settings = adoptVoice(readConfigFile(FILE));
    this.model.state = existsSync(this.modelFile()) ? "ready" : "missing";
    // What was pending when the last server went is missed now: whatever was
    // playing it fetched its next sentence from a server that is not there.
    let stored: unknown = null;
    try {
      stored = JSON.parse(readFileSync(missedPath(), "utf8"));
    } catch {
      // Nothing kept is nothing missed.
    }
    this.missed = adoptMissed(stored).map((entry) => ({ ...entry, pending: false, replaying: null }));
    void this.look();
  }

  // ---------------------------------------------------------------------------
  // Settings and status
  // ---------------------------------------------------------------------------

  status(): VoiceStatus {
    const kokoro: VoiceOption[] = KOKORO_VOICES.map((v) => ({
      engine: "kokoro",
      id: v.id,
      name: v.name,
      lang: v.lang,
      note: v.grade === "—" ? `${v.gender === "F" ? "female" : "male"}` : `${v.gender === "F" ? "female" : "male"}, grade ${v.grade}`,
    }));
    return {
      settings: this.settings,
      ears: this.ears,
      spanish: this.spanish,
      model: this.model,
      voices: [...kokoro, ...this.system],
    };
  }

  /** Take settings from a client: made whole, written, and told to every window. */
  set(value: unknown): void {
    this.settings = adoptVoice(value);
    writeConfigFile(FILE, this.settings);
    this.tell();
    // Choosing a Kokoro voice is wanting Kokoro; fetch it rather than fall
    // back to `say` and leave the person wondering why the pick did nothing.
    if (this.model.state === "missing" && Object.values(this.settings.voices).some((v) => v.engine === "kokoro")) void this.download();
  }

  private tell(): void {
    this.deps.broadcast({ type: "voice", voice: this.status() });
  }

  /**
   * What is on this machine, found once at start and again whenever Settings
   * asks. `yap` and `espeak-ng` are Homebrew's, and a server started from the
   * app rather than a shell has a PATH that does not know Homebrew, so the
   * two places it installs to are looked in as well. The voices are read off
   * `say`, which is on every macOS.
   */
  async look(): Promise<void> {
    const yap = findTool("yap");
    const espeak = findTool("espeak-ng");
    this.ears = yap ? { ok: true, detail: yap } : { ok: false, detail: "Not installed. In a terminal: brew install yap" };
    this.spanish = espeak ? { ok: true, detail: espeak } : { ok: false, detail: "Not installed. In a terminal: brew install espeak-ng" };
    if (process.platform === "darwin" && !this.system.length) {
      try {
        const { stdout } = await run("/usr/bin/say", ["-v", "?"], { timeout: 10_000, maxBuffer: 1024 * 1024 });
        this.system = parseSayVoices(stdout);
      } catch {
        this.system = [];
      }
    }
    this.tell();
  }

  // ---------------------------------------------------------------------------
  // Hearing
  // ---------------------------------------------------------------------------

  /**
   * A clip on the disk, into words: what was said and in which language,
   * null for a clip that held none, a rejection for a recogniser that could
   * not run — which the outbox tries again, and which is not the same as
   * hearing nothing.
   *
   * Transcribed once per language the user speaks, all at once — the
   * recogniser is one model per locale and cannot tell which was spoken —
   * and the transcripts compared (`pickTranscript`). A locale whose model has
   * not finished downloading says so on stderr and exits non-zero, and the
   * other language's transcript is still an answer; only every locale
   * failing is a failure. Where the words go is the outbox's business.
   */
  async transcribe(path: string, ms: number): Promise<{ text: string; lang: VoiceLang } | null> {
    const yap = findTool("yap");
    if (!yap) {
      this.ears = { ok: false, detail: "Not installed. In a terminal: brew install yap" };
      throw new Error("yap is not installed — brew install yap");
    }
    const failures: string[] = [];
    const candidates = await Promise.all(
      this.settings.languages.map(async (lang): Promise<Transcript | null> => {
        try {
          const { stdout } = await run(yap, ["transcribe", "--locale", this.settings.locales[lang], path, "--txt"], {
            // Whole milliseconds: `execFile` throws on a fraction, and a clip's length is one.
            timeout: HEAR_TIMEOUT_MS + Math.ceil(Number.isFinite(ms) ? Math.max(0, ms) : 0),
            maxBuffer: 4 * 1024 * 1024,
          });
          return { lang, text: stdout.replace(/\s+/g, " ").trim() };
        } catch (err) {
          failures.push(err instanceof Error ? err.message.split("\n")[0]! : String(err));
          return null;
        }
      }),
    );
    const ran = candidates.filter((c): c is Transcript => c !== null);
    if (!ran.length) throw new Error(failures[0] ?? "the recogniser did not run");
    const picked = pickTranscript(ran, this.settings.languages);
    return picked ? { text: picked.text, lang: picked.lang } : null;
  }

  // ---------------------------------------------------------------------------
  // The hush
  // ---------------------------------------------------------------------------

  /** A client's talk key went down, or its clip has been dealt with. The rest is the module header's "nobody is spoken over". */
  talk(who: object, on: boolean): void {
    const was = this.hushed();
    const timer = this.talkers.get(who);
    if (timer) clearTimeout(timer);
    if (on) this.talkers.set(who, setTimeout(() => this.talk(who, false), TALK_MAX_MS).unref());
    else this.talkers.delete(who);
    if (this.hushed() !== was) this.deps.broadcast(this.hush());
  }

  /** What every client is told, on connect and whenever it changes. */
  hush(): ServerMessage {
    return { type: "hush", hushed: this.hushed() };
  }

  private hushed(): boolean {
    return this.talkers.size > 0;
  }

  // ---------------------------------------------------------------------------
  // What was missed
  // ---------------------------------------------------------------------------

  /**
   * A client has a reply queued or playing, or has let it go before its end.
   * Letting go is the ✕, the talk key's press, or a sentence it could not
   * load. A reply let go by everybody who held it is not made any further,
   * which is what lets whatever is queued behind it start sooner.
   */
  held(who: object, utterance: string, on: boolean): void {
    const made = this.utterances.get(utterance);
    if (!made || made.quiet) return;
    if (on) made.holders.add(who);
    else if (made.holders.delete(who)) made.dropped = true;
    this.review();
  }

  /** A client played one sentence of a reply to its end. */
  played(utterance: string, seq: number): void {
    const made = this.utterances.get(utterance);
    if (!made || made.quiet || !Number.isFinite(seq) || seq < 0) return;
    made.played.add(Math.floor(seq));
    this.review();
  }

  /**
   * A client went: it is no longer talking, and what it held is let go. Let
   * go and not merely forgotten, because a page that comes back gets the
   * sentences said after it returned and not the ones before.
   */
  leave(who: object): void {
    this.talk(who, false);
    for (const made of this.utterances.values()) {
      if (made.holders.delete(who)) made.dropped = true;
    }
    this.review();
  }

  /** What every client is told, on connect and whenever it changes: every profile's, since the badge is drawn for whichever is on screen. */
  missedMessage(): ServerMessage {
    return { type: "missed", missed: this.missed.filter((entry) => !entry.pending).map(bare) };
  }

  /**
   * Say every missed reply of a profile again, oldest first, each starting
   * "Earlier". Resolves to what was queued, for the harness's tool to say what
   * it played. A reply whose replay is still on its way is not queued twice.
   * They stay on the list until a replay of them is heard to the end.
   */
  replay(profileId: string): MissedReply[] {
    const queued: MissedReply[] = [];
    for (const entry of this.missed) {
      if (entry.profileId !== profileId || entry.pending || entry.replaying) continue;
      const id = this.speak(profileId, entry.text, { lang: entry.lang, lead: "earlier", replays: entry.id, spoken: true });
      if (!id) continue;
      entry.replaying = id;
      queued.push(bare(entry));
    }
    return queued;
  }

  /** Take a profile's missed replies off the list unheard: the person has read them, or does not care to. */
  clear(profileId: string): void {
    const before = this.missed.length;
    this.missed = this.missed.filter((entry) => entry.profileId !== profileId || entry.pending);
    if (this.missed.length === before) return;
    this.saveMissed();
    this.deps.broadcast(this.missedMessage());
  }

  /**
   * Settle what can be settled: a reply heard leaves the list, one missed
   * joins it. Called on every report a client makes and every reply that
   * finishes being made, and again once the grace of a reply nobody took up
   * has run.
   */
  private review(): void {
    const now = Date.now();
    let changed = false;
    let wake = Infinity;
    for (const made of this.utterances.values()) {
      if (made.quiet || !made.profileId || made.fate === "heard") continue;
      const fate = fateOf(made, now);
      if (fate && fate !== made.fate) {
        made.fate = fate;
        this.settle(made);
        changed = true;
      } else if (!fate && made.done && made.holders.size === 0) {
        wake = Math.min(wake, made.doneAt + UNHELD_GRACE_MS - now);
      }
    }
    if (changed) {
      this.saveMissed();
      this.deps.broadcast(this.missedMessage());
    }
    if (wake < Infinity && !this.reviewTimer) {
      this.reviewTimer = setTimeout(
        () => {
          this.reviewTimer = null;
          this.review();
        },
        Math.max(50, wake),
      ).unref();
    }
  }

  /** What a reply's fate does to the list. A replay settles the reply it replays, never one of its own. */
  private settle(made: Utterance): void {
    const id = made.replays ?? made.id;
    const entry = this.missed.find((e) => e.id === id);
    if (!entry) return;
    if (made.fate === "heard") this.missed = this.missed.filter((e) => e !== entry);
    else if (made.replays) {
      if (entry.replaying === made.id) entry.replaying = null;
    } else entry.pending = false;
  }

  /** Written whole, through a temporary file, the way `persist.ts` writes. A list that could not be written is still the list until the next start. */
  private saveMissed(): void {
    this.missed = capMissed(this.missed);
    const path = missedPath();
    try {
      mkdirSync(dirname(path), { recursive: true });
      const temp = `${path}.tmp`;
      writeFileSync(temp, `${JSON.stringify(this.missed.map((entry) => ({ ...bare(entry), pending: entry.pending })))}\n`, "utf8");
      renameSync(temp, path);
    } catch {
      // See above.
    }
  }

  // ---------------------------------------------------------------------------
  // Speaking
  // ---------------------------------------------------------------------------

  /** A harness's reply, if replies are spoken. What `index.ts` calls on the harness's own Stop report. */
  spoke(profileId: string, reply: unknown): void {
    if (!this.settings.speak || typeof reply !== "string") return;
    void this.speak(profileId, reply);
  }

  /**
   * Say something, as the profile's harness. Resolves to the utterance id
   * once it is queued, not once it is said: the sentences are announced on
   * the socket as each is made. `choice` overrides the voice the language
   * would pick, for an audition; `quiet` keeps the sentences off the socket,
   * also for an audition, which only the window that asked should hear.
   * `replays` and `lead` are a missed reply said again, and `spoken` says the
   * text has been through `spokenText` already — a second pass would eat the
   * underscores of a name the first one left alone.
   */
  speak(
    profileId: string,
    text: string,
    options: { lang?: VoiceLang; choice?: VoiceChoice; quiet?: boolean; lead?: LeadIn; replays?: string; spoken?: boolean } = {},
  ): string | null {
    const spoken = options.spoken ? text.trim() : spokenText(text);
    if (!spoken) return null;
    const lang = options.lang ?? detectLanguage(spoken, this.settings.languages);
    const n = ++this.utteranceCount;
    const id = `u${n}-${Date.now().toString(36)}`;
    const quiet = options.quiet === true;
    const made: Utterance = {
      id,
      n,
      profileId,
      quiet,
      text: spoken,
      lang,
      chunks: [],
      at: Date.now(),
      during: this.hushed(),
      lead: options.lead ?? null,
      replays: options.replays ?? null,
      holders: new Set(),
      played: new Set(),
      dropped: false,
      done: false,
      doneAt: 0,
      fate: null,
    };
    this.utterances.set(id, made);
    // On the list from the start, pending, so a server that goes before it
    // is heard leaves it there. Not an audition, and not a replay, whose
    // reply is on the list already.
    if (!quiet && profileId && !made.replays) {
      this.missed.push({ id, profileId, text: spoken, lang, at: made.at, pending: true, replaying: null });
      this.saveMissed();
    }
    this.prune();
    this.queue = this.queue.then(() => this.render(id, options)).catch(() => {});
    return id;
  }

  /** One sentence in a voice, for Settings. Resolves once it can be fetched. */
  async preview(choice: VoiceChoice, lang: VoiceLang): Promise<{ utterance: string }> {
    const id = this.speak("", PREVIEW[lang], { lang, choice, quiet: true });
    if (!id) throw new Error("nothing to say");
    await this.queue;
    const made = this.utterances.get(id);
    if (!made || !made.chunks.length) throw new Error(this.model.error ?? "That voice could not speak. Is the model downloaded?");
    return { utterance: id };
  }

  /** The bytes of one sentence, for `/api/speech`. */
  chunk(utterance: string, seq: number): Buffer | null {
    return this.utterances.get(utterance)?.chunks[seq] ?? null;
  }

  private async render(id: string, options: { choice?: VoiceChoice }): Promise<void> {
    const made = this.utterances.get(id);
    if (!made) return;
    const lang = made.lang;
    try {
      const choice = options.choice ?? (await this.resolve(lang));
      if (!choice) return;
      const sentences = sentencesOf(made.text);
      // Each sentence is announced as soon as it is made, not once the reply
      // is: Kokoro takes about a second a sentence, and waiting for the whole
      // of a six-sentence reply is six seconds of silence before the first
      // word. The client queues them, so the next one is made while the one
      // before it plays.
      for (const [index, sentence] of sentences.entries()) {
        // Let go everywhere part way through: the rest is nobody's, and
        // whatever is queued behind it waits a second a sentence. It is on
        // the missed list, and a replay makes it again from the words.
        if (abandoned(made)) return;
        let bytes: Buffer;
        try {
          bytes = await this.synthesize(sentence, choice, lang);
        } catch (err) {
          // A sentence the engine choked on is skipped, not the utterance: the
          // next one is usually fine, and a reply with a hole in it beats a
          // reply that was never heard. An audition is told, since it asked.
          if (options.choice) this.model.error = err instanceof Error ? err.message : String(err);
          continue;
        }
        if (abandoned(made)) return;
        // The lead-in is decided at the last moment it can be: the first
        // sentence is made and about to go out, and if anybody is talking it
        // will wait for them, so it starts by saying it did. Its own
        // sentence, made now, a fraction of a second for two words.
        if (made.chunks.length === 0 && !made.quiet) {
          const lead = made.lead ?? (made.during || this.hushed() ? "while" : null);
          if (lead) {
            const line = LEAD_INS[lead][lang];
            try {
              this.announce(made, await this.synthesize(line, choice, lang), line, false);
            } catch {
              // The reply without its lead-in beats no reply.
            }
          }
        }
        this.announce(made, bytes, sentence, index === sentences.length - 1);
      }
    } finally {
      made.done = true;
      made.doneAt = Date.now();
      this.review();
    }
  }

  /**
   * One sentence, kept for `/api/speech` and told to every client. `seq`
   * counts what was made rather than what was planned, so a skipped sentence
   * leaves no hole for `/api/speech` to be asked about.
   */
  private announce(made: Utterance, bytes: Buffer, text: string, last: boolean): void {
    const seq = made.chunks.push(bytes) - 1;
    if (made.quiet) return;
    const chunk: SpeechChunk = { utterance: made.id, seq, last, text, lang: made.lang, profileId: made.profileId };
    this.deps.broadcast({ type: "speech", speech: chunk });
  }

  /**
   * The voice for a language, as things stand: the chosen one when its
   * engine can speak right now, else the machine's own in that language.
   * Kokoro cannot speak before it is downloaded, and cannot speak Spanish
   * without `espeak-ng`; `say` can always speak, worse.
   */
  private async resolve(lang: VoiceLang): Promise<VoiceChoice | null> {
    const chosen = this.settings.voices[lang];
    if (chosen.engine === "system") return chosen;
    const voice = kokoroVoice(chosen.voice);
    const can = voice && this.model.state !== "missing" && this.model.state !== "error" && (voice.lang === "en" || findTool("espeak-ng"));
    if (can) return chosen;
    return systemFallback(lang, this.system);
  }

  private async synthesize(sentence: string, choice: VoiceChoice, lang: VoiceLang): Promise<Buffer> {
    if (choice.engine === "system") return this.say(sentence, choice.voice);
    const voice = kokoroVoice(choice.voice);
    if (!voice) throw new Error(`no Kokoro voice ${choice.voice}`);
    const speaker = await this.load(false);
    const speed = this.settings.speed;
    void lang;
    if (voice.lang === "en") return this.ask(speaker, { voice: voice.id, speed, text: sentence });
    return this.ask(speaker, { voice: voice.id, speed, phonemes: await phonemesEs(sentence) });
  }

  /**
   * One sentence, from the Kokoro process. A process that has not answered in
   * time is ended, so the next sentence gets a fresh one rather than waiting in
   * a queue behind a hang.
   */
  private ask(speaker: Speaker, request: SpeakRequest): Promise<Buffer> {
    const id = ++this.requests;
    return new Promise<Buffer>((resolve, reject) => {
      if (!speaker.child.connected) {
        reject(new Error("the voice process has gone"));
        return;
      }
      const timer = setTimeout(() => {
        speaker.waiting.delete(id);
        reject(new Error("the voice took too long over one sentence"));
        speaker.child.kill("SIGKILL");
      }, SAY_TIMEOUT_MS);
      const settle = (done: () => void) => {
        clearTimeout(timer);
        speaker.waiting.delete(id);
        done();
      };
      speaker.waiting.set(id, {
        resolve: (wav) => settle(() => resolve(wav)),
        reject: (err) => settle(() => reject(err)),
      });
      const message = { type: "speak", id, ...request } as ToKokoro;
      speaker.child.send(message, (err) => {
        if (err) speaker.waiting.get(id)?.reject(err);
      });
    });
  }

  /**
   * The machine's voice, through `say`. Text on stdin rather than on the
   * line, so a sentence with a quote in it is a sentence and not an
   * argument. 22 kHz, which is what those voices are, and the rate follows
   * the Kokoro speed so one slider means one thing.
   */
  private async say(sentence: string, voice: string): Promise<Buffer> {
    if (process.platform !== "darwin") throw new Error("the system voice is macOS only");
    const dir = mkdtempSync(join(tmpdir(), "kururu-say-"));
    try {
      const out = join(dir, "out.wav");
      const rate = Math.round(175 * this.settings.speed);
      await new Promise<void>((resolve, reject) => {
        const child = execFile(
          "/usr/bin/say",
          ["-v", voice, "-r", String(rate), "-f", "-", "-o", out, "--file-format=WAVE", "--data-format=LEI16@22050"],
          { timeout: SAY_TIMEOUT_MS },
          (err) => (err ? reject(err) : resolve()),
        );
        child.stdin?.end(sentence);
      });
      return readFileSync(out);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // ---------------------------------------------------------------------------
  // The model
  // ---------------------------------------------------------------------------

  /** Where the model's files go: a cache, since they can be fetched again, and never the config directory. */
  private modelDir(): string {
    return process.env.KURURU_MODELS || join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "kururu", "models");
  }

  private modelFile(): string {
    return join(this.modelDir(), KOKORO_MODEL, "onnx", "model_quantized.onnx");
  }

  /** Fetch Kokoro, from Settings. Progress goes out on the socket as it comes in. */
  async download(): Promise<void> {
    if (this.model.state === "downloading" || this.model.state === "loading") return;
    try {
      await this.load(true);
    } catch {
      // `load` recorded why.
    }
  }

  /**
   * The Kokoro process with the model loaded in it. Started on the first
   * sentence rather than at start, because the server restarts on every edit
   * under `bun run dev` and a restart should not pay for a model that may not
   * be spoken to for an hour.
   *
   * It is a process and not an import for the reason `kokoro.ts` gives: the
   * ONNX runtime turns any exit of the process that loaded it into an abort,
   * and that must not be the server. A process that cannot start, or cannot
   * find the library, leaves the model in `error` and the voice on `say`. One
   * that dies after it was ready is started again by the next sentence.
   */
  private load(remote: boolean): Promise<Speaker> {
    if (this.speaker) return this.speaker;
    const onDisk = existsSync(this.modelFile());
    if (!onDisk && !remote) return Promise.reject(new Error("the voice model is not downloaded"));
    this.model = { state: onDisk ? "loading" : "downloading", progress: 0, error: null };
    this.tell();
    const starting = new Promise<Speaker>((resolve, reject) => {
      if (!existsSync(KOKORO_ENTRY)) throw new Error(`no voice process to start at ${KOKORO_ENTRY} — bun run build:server`);
      const child = fork(KOKORO_ENTRY, [], {
        serialization: "advanced",
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        // In the app the server is Electron's binary running as node, and so
        // must this be.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      });
      this.child = child;
      const speaker: Speaker = { child, waiting: new Map() };
      child.on("message", (msg: FromKokoro) => {
        if (msg.type === "progress") this.progress(msg.event);
        else if (msg.type === "ready") {
          this.model = { state: "ready", progress: 100, error: null };
          this.tell();
          resolve(speaker);
        } else if (msg.type === "failed") {
          reject(new Error(msg.error));
          child.kill("SIGKILL");
        } else if (msg.type === "audio") speaker.waiting.get(msg.id)?.resolve(Buffer.from(msg.wav));
        else speaker.waiting.get(msg.id)?.reject(new Error(msg.error));
      });
      child.on("error", (err) => {
        if (this.child === child) this.child = null;
        reject(err);
      });
      child.on("exit", (code, signal) => {
        const gone = new Error(`the voice process ${signal ? `was killed by ${signal}` : `exited with code ${code}`}`);
        for (const waiting of [...speaker.waiting.values()]) waiting.reject(gone);
        // A no-op once it was ready; the reason a load failed if it was not.
        reject(gone);
        if (this.child === child) {
          this.child = null;
          this.speaker = null;
        }
      });
      const load: ToKokoro = { type: "load", cacheDir: this.modelDir(), remote, model: KOKORO_MODEL };
      child.send(load);
    });
    this.speaker = starting;
    starting.catch((err: unknown) => {
      if (this.speaker === starting) this.speaker = null;
      const why = err instanceof Error ? err.message : String(err);
      this.model = { state: existsSync(this.modelFile()) ? "error" : "missing", progress: 0, error: why };
      this.tell();
    });
    return starting;
  }

  /**
   * End the Kokoro process, for a server on its way down. SIGKILL, for the
   * reason `kokoro.ts` gives. It would end itself when the channel closed
   * anyway; this only saves it the noticing.
   */
  close(): void {
    this.child?.kill("SIGKILL");
  }

  /** The one file that is big is the model itself; the rest are kilobytes. Progress is its progress, told every few percent. */
  private progress(event: { status?: string; file?: string; progress?: number }): void {
    if (event.status !== "progress" || !event.file?.endsWith(".onnx") || typeof event.progress !== "number" || !Number.isFinite(event.progress)) return;
    const pct = Math.max(0, Math.min(100, Math.floor(event.progress)));
    if (pct === this.lastProgressSent || (pct % 4 !== 0 && pct !== 100)) return;
    this.lastProgressSent = pct;
    this.model = { state: "downloading", progress: pct, error: null };
    this.tell();
  }

  /** The oldest utterances go, and one going unsettled is missed: nobody can report on a reply that is no longer here. */
  private prune(): void {
    let changed = false;
    while (this.utterances.size > KEEP_UTTERANCES) {
      const oldest = this.utterances.keys().next().value;
      if (oldest === undefined) break;
      const made = this.utterances.get(oldest);
      this.utterances.delete(oldest);
      if (made && !made.quiet && made.profileId && !made.fate) {
        made.fate = "missed";
        this.settle(made);
        changed = true;
      }
    }
    if (changed) {
      this.saveMissed();
      this.deps.broadcast(this.missedMessage());
    }
  }
}

/** A missed reply as the wire carries it, without the server's bookkeeping. */
function bare(entry: MissedReply): MissedReply {
  return { id: entry.id, profileId: entry.profileId, text: entry.text, lang: entry.lang, at: entry.at };
}

/** Let go by everybody who held it: nothing more of it is worth making. */
function abandoned(made: Utterance): boolean {
  return made.dropped && made.holders.size === 0;
}

/**
 * Spanish text as the phonemes Kokoro expects, through `espeak-ng`.
 *
 * The command line drops punctuation, and Kokoro's prosody is in the
 * punctuation, so the sentence is phonemised a clause at a time between its
 * marks and the marks are put back where they were — which is what the
 * Python phonemiser's `preserve_punctuation` does, done by hand. One process
 * per clause is a few tens of milliseconds each; a sentence has a handful.
 */
export async function phonemesEs(sentence: string): Promise<string> {
  const espeak = findTool("espeak-ng");
  if (!espeak) throw new Error("espeak-ng is not installed — brew install espeak-ng");
  const parts = sentence.split(/([,;:.!?¡¿…]+)/);
  let out = "";
  for (const part of parts) {
    if (!part.trim()) continue;
    if (/^[,;:.!?¡¿…]+$/.test(part)) {
      out += `${part} `;
      continue;
    }
    const { stdout } = await run(espeak, ["-q", "-v", "es", "--ipa=2", "--", part.trim()], { timeout: SAY_TIMEOUT_MS, maxBuffer: 256 * 1024 });
    out += `${modelPhonemes(stdout)} `;
  }
  return out.replace(/\s+([,;:.!?…])/g, "$1").replace(/\s+/g, " ").trim();
}

/**
 * What has become of a reply, as far as can be told yet. Pure; see
 * `Voice.review`.
 *
 * Heard is somebody playing its last sentence to the end — the end, and not
 * every sentence, because a page that opened half way through and played the
 * rest is somebody who heard how it came out. Missed is everybody who held
 * it letting it go, or nobody having taken it up once it was all made and
 * the grace has run: no window was open, or none could play it. While anybody
 * still holds it, it is neither. A reply none of whose sentences could be
 * made is missed too, since its words are still worth reading.
 */
export function fateOf(
  made: Pick<Utterance, "quiet" | "chunks" | "played" | "holders" | "dropped" | "done" | "doneAt">,
  now: number,
): Fate | null {
  if (made.quiet) return null;
  const last = made.chunks.length - 1;
  if (made.done && last >= 0 && made.played.has(last)) return "heard";
  if (made.holders.size > 0) return null;
  if (made.dropped) return "missed";
  if (made.done && now - made.doneAt >= UNHELD_GRACE_MS) return "missed";
  return null;
}

/** espeak-ng's IPA, as the model's tokeniser was trained to see it. Pure; see `ESPEAK_TO_MODEL`. */
export function modelPhonemes(ipa: string): string {
  let ps = ipa.replace(/\s+/g, " ").trim();
  for (const [from, to] of ESPEAK_TO_MODEL) ps = ps.split(from).join(to);
  return ps.replaceAll(TIE, "").replaceAll("-", "");
}

/** A program by name, on the PATH or in Homebrew's two directories; its path, or null. */
export function findTool(name: string): string | null {
  const dirs = [...(process.env.PATH ?? "").split(delimiter).filter(Boolean), ...BREW_DIRS];
  for (const dir of dirs) {
    const path = join(dir, name);
    if (existsSync(path)) return path;
  }
  return null;
}
