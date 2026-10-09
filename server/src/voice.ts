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
 * keep to the order it was told. A clip is a file in a temporary directory for the
 * half-second the recogniser takes, and is removed in a `finally`.
 *
 * **Nobody is spoken over.** A client says when its talk key goes down and
 * again once its words are delivered, and while any client is talking every
 * client is told to hold what it is sent (`hush`): the phone on the desk
 * must not answer over the window's microphone any more than the window
 * itself should. Sentences go on being made and announced, so a reply
 * waiting out somebody's sentence is ready the moment they stop. What
 * decides whether it is ever played is whether the words got through: a
 * clip delivered to a harness supersedes every reply of that harness made
 * before it (`superseded`), because Kuru is about to answer what was just
 * said with its earlier reply in front of it, and hearing the earlier one
 * first is being talked over a second time. A clip thrown away, or one
 * that held no words, supersedes nothing, and what waited plays.
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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  CLIP_MIN_MS,
  KOKORO_MODEL,
  KOKORO_VOICES,
  adoptVoice,
  clipMs,
  detectLanguage,
  kokoroVoice,
  parseSayVoices,
  pickTranscript,
  sentencesOf,
  spokenText,
  systemFallback,
  type Heard,
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

/** How long the recogniser may take on one clip. It takes half a second; this is for a locale whose model is still downloading. */
const HEAR_TIMEOUT_MS = 60_000;
/** How long one sentence of speech may take to make. Kokoro does a sentence in a second; `say` in less. */
const SAY_TIMEOUT_MS = 30_000;
/** How many utterances are kept for fetching. A phone that is slow to fetch gets the last few; nothing older is anybody's business. */
const KEEP_UTTERANCES = 24;
/**
 * How long a client may say it is talking before it is not believed. The
 * longest clip the server takes is a minute and a half (`CLIP_MAX_BYTES`)
 * and the recogniser may take one more on a new locale, so this is past
 * anything a working client does. A socket that goes takes its say with
 * it; this is for one that stays and never says it stopped, since Kuru
 * silent everywhere for good is worse than Kuru heard over a broken window.
 */
const TALK_MAX_MS = 3 * 60_000;
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
  /** Hand words to a profile's harness, starting it if it is not running. See `Harness.hear`. */
  deliver: (profileId: string, text: string) => Promise<{ outcome: Heard["outcome"] }>;
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
  /** Its place in the order utterances were made, for telling older from newer. */
  n: number;
  /** Whose harness said it; empty for an audition. */
  profileId: string;
  /** An audition, which only the window that asked hears. Never held, never superseded. */
  quiet: boolean;
  chunks: Buffer[];
  at: number;
  /** A sentence of it was announced while nobody was talking, so somebody heard it begin. */
  heard: boolean;
  /** Superseded by words delivered after it: nothing more of it is made or announced. */
  stale: boolean;
  /** Every sentence has been made, or failed to be. */
  done: boolean;
}

export class Voice {
  private settings: VoiceSettings;
  private readonly utterances = new Map<string, Utterance>();
  private utteranceCount = 0;
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
   * A clip, into words, into the harness.
   *
   * Transcribed once per language the user speaks, all at once — the
   * recogniser is one model per locale and cannot tell which was spoken —
   * and the transcripts compared (`pickTranscript`). The words go to the
   * profile's harness with a mark saying they were spoken, so it knows a
   * misheard name is a thing that can happen to them.
   */
  async hear(profileId: string, wav: Buffer): Promise<Heard> {
    const yap = findTool("yap");
    if (!yap) {
      this.ears = { ok: false, detail: "Not installed. In a terminal: brew install yap" };
      return { text: "", lang: null, outcome: "failed", why: "yap is not installed — brew install yap, then try again.", skipped: 0 };
    }
    if (clipMs(wav.length) < CLIP_MIN_MS) return { text: "", lang: null, outcome: "nothing", why: null, skipped: 0 };
    const dir = mkdtempSync(join(tmpdir(), "kururu-clip-"));
    let candidates: Transcript[];
    try {
      const path = join(dir, "clip.wav");
      writeFileSync(path, wav);
      candidates = await Promise.all(
        this.settings.languages.map(async (lang): Promise<Transcript> => {
          try {
            const { stdout } = await run(yap, ["transcribe", "--locale", this.settings.locales[lang], path, "--txt"], {
              timeout: HEAR_TIMEOUT_MS,
              maxBuffer: 1024 * 1024,
            });
            return { lang, text: stdout.replace(/\s+/g, " ").trim() };
          } catch {
            // A locale whose model has not finished downloading says so on
            // stderr and exits non-zero; the other language's transcript is
            // still an answer.
            return { lang, text: "" };
          }
        }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const picked = pickTranscript(candidates, this.settings.languages);
    if (!picked) return { text: "", lang: null, outcome: "nothing", why: null, skipped: 0 };
    // Counted before the words go, not after: a reply that lands while they
    // are being typed may be the turn that took them in, and is not older.
    const through = this.utteranceCount;
    try {
      const { outcome } = await this.deps.deliver(profileId, `[voice] ${picked.text}`);
      return { text: picked.text, lang: picked.lang, outcome, why: null, skipped: this.supersede(profileId, through) };
    } catch (err) {
      return { text: picked.text, lang: picked.lang, outcome: "failed", why: err instanceof Error ? err.message : String(err), skipped: 0 };
    }
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
  hush(drop: string[] = []): ServerMessage {
    return { type: "hush", hushed: this.hushed(), drop };
  }

  private hushed(): boolean {
    return this.talkers.size > 0;
  }

  /**
   * Words reached a harness: what it said before them is stale. Marked so
   * the rest of it is never made, and told to every client so what of it is
   * waiting there is thrown away. Resolves to how many of those replies
   * nobody had heard a word of, for the pill.
   */
  private supersede(profileId: string, through: number): number {
    const { drop, skipped } = superseded(this.utterances.values(), profileId, through);
    if (!drop.length) return 0;
    for (const id of drop) {
      const made = this.utterances.get(id);
      if (made) made.stale = true;
    }
    this.deps.broadcast(this.hush(drop));
    return skipped;
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
   */
  speak(profileId: string, text: string, options: { lang?: VoiceLang; choice?: VoiceChoice; quiet?: boolean } = {}): string | null {
    const spoken = spokenText(text);
    if (!spoken) return null;
    const lang = options.lang ?? detectLanguage(spoken, this.settings.languages);
    const n = ++this.utteranceCount;
    const id = `u${n}-${Date.now().toString(36)}`;
    this.utterances.set(id, {
      id,
      n,
      profileId,
      quiet: options.quiet === true,
      chunks: [],
      at: Date.now(),
      heard: false,
      stale: false,
      done: false,
    });
    this.prune();
    this.queue = this.queue.then(() => this.render(id, profileId, spoken, lang, options)).catch(() => {});
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

  private async render(id: string, profileId: string, spoken: string, lang: VoiceLang, options: { choice?: VoiceChoice; quiet?: boolean }): Promise<void> {
    const made = this.utterances.get(id);
    if (!made) return;
    try {
      const choice = options.choice ?? (await this.resolve(lang));
      if (!choice) return;
      const sentences = sentencesOf(spoken);
      // Each sentence is announced as soon as it is made, not once the reply
      // is: Kokoro takes about a second a sentence, and waiting for the whole
      // of a six-sentence reply is six seconds of silence before the first
      // word. The client queues them, so the next one is made while the one
      // before it plays.
      for (const [index, sentence] of sentences.entries()) {
        // Superseded part way through: the rest is nobody's, and the reply
        // that superseded it is queued behind it, a second a sentence.
        if (made.stale) return;
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
        // `seq` counts what was made rather than what was planned, so a skipped
        // sentence leaves no hole for `/api/speech` to be asked about.
        const seq = made.chunks.push(bytes) - 1;
        if (options.quiet || made.stale) continue;
        // Announced while somebody talks, it waits in every client's queue,
        // and nobody has heard it begin until somebody has.
        if (!this.hushed()) made.heard = true;
        const chunk: SpeechChunk = { utterance: id, seq, last: index === sentences.length - 1, text: sentence, lang, profileId };
        this.deps.broadcast({ type: "speech", speech: chunk });
      }
    } finally {
      made.done = true;
    }
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

  private prune(): void {
    while (this.utterances.size > KEEP_UTTERANCES) {
      const oldest = this.utterances.keys().next().value;
      if (oldest === undefined) break;
      this.utterances.delete(oldest);
    }
  }
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
 * What words delivered to a profile's harness supersede: every reply of
 * that harness made up to `through`, the count before the words went. Not
 * another profile's, whose harness was not spoken to and will not answer
 * for it, and not an audition. Pure; see `Voice.supersede`.
 *
 * `skipped` is the ones nobody heard begin — the pill's "dropped the reply
 * it gave while you talked". A reply cut off by the talk key was heard
 * begin, and cutting it off was the point of the press; one that came to
 * nothing because every sentence failed was never going to be heard.
 */
export function superseded(said: Iterable<Utterance>, profileId: string, through: number): { drop: string[]; skipped: number } {
  const drop: string[] = [];
  let skipped = 0;
  for (const made of said) {
    if (made.quiet || made.stale || made.profileId !== profileId || made.n > through) continue;
    drop.push(made.id);
    if (!made.heard && !(made.done && made.chunks.length === 0)) skipped++;
  }
  return { drop, skipped };
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
