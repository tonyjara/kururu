/**
 * Hex as kururu's ears: a local speech engine behind kururu's own key.
 *
 * Why Hex, and why only its engine: `yap` is Apple's recogniser, one locale
 * per run, so kururu ran it twice and kept the likelier half, and a sentence
 * that is half Spanish came out garbled either way ("viernes" as "Beerness");
 * it also cannot be taught a name. Hex (anomalyco/hex, MIT) runs Parakeet v3,
 * which hears the language from the audio in one pass and biases its decoder
 * toward a vocabulary. But Hex is also a dictation app with its own key, its
 * own HUD, its own paste and its own sounds, and kururu already has all four
 * and the conversation they feed. So Hex is driven as a service and its own
 * face is turned off (docs/voice.md says which settings).
 *
 * **Kururu records, Hex only hears.** Hex can record a dictation itself
 * (`hex dictation start` / `stop --print`), and that was the first plan. It
 * is the wrong one: the clip kururu hears is often not this Mac's microphone
 * at all — it is the phone's, or the pill's while the window is shut — and a
 * second recorder would also need a second microphone grant and would race
 * kururu's own for the device. Hex's desktop local API has the other half:
 * `POST /transcriptions` takes a finished WAV and gives back the words,
 * through the same model, with the vocabulary bias applied, and with nothing
 * pasted, played, shown or kept in Hex's history. That is what is used, and
 * every clip kururu already makes — the talk key, the key in every app, the
 * pill, the drawer's and the quote's mics, the phone — is heard the same way.
 *
 * **Hex is found by its discovery file, read at each request and never
 * held.** `~/Library/Application Support/hex/local-api.json` is owner-only
 * and carries a port and a bearer token; the token goes to 127.0.0.1 and
 * nowhere else, and is in no log or client message. A pid that is not alive
 * is a Hex that is not running, whatever the file says.
 *
 * **Started with kururu, never stopped by it.** A server that is to hear
 * through Hex starts it (`hex start`, which opens the app through Launch
 * Services, so it is nobody's child and nobody's coalition) and leaves it
 * running when it goes; Hex lives in the menu bar and is somebody's app.
 *
 * **The vocabulary is a file and Hex's list is made from it** — see
 * `shared/vocabulary.ts`. The file is watched; a change reaches Hex within a
 * second, and so does a Hex that restarted with another list.
 *
 * Restartable side: editing this costs a reconnect, and nothing in it
 * touches the pty host.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { BIASED_TERMS, hexEntries, parseVocabulary, vocabularyPlan } from "../../shared/vocabulary";
import type { ToolStatus } from "../../shared/voice";

const run = promisify(execFile);

/** The one file, and where it lives. `~/Documents/Kururu` is where the user's kururu papers already are. */
export const VOCABULARY_DIR = join(homedir(), "Documents", "Kururu", "dictation");
export const VOCABULARY_FILE = join(VOCABULARY_DIR, "vocabulary.json");
const DISCOVERY = join(homedir(), "Library", "Application Support", "hex", "local-api.json");
/** Where the cask puts the app; the CLI is the app's own binary, and Homebrew links it nowhere. */
const APP_BINARIES = ["/Applications/Hex.app/Contents/MacOS/hex", join(homedir(), "Applications", "Hex.app", "Contents", "MacOS", "hex")];
export const INSTALL_LINE = "brew install --cask anomalyco/tap/hex";
/** The control protocol this was written against (docs/cli.md in Hex). */
const CONTROL_VERSION = 4;
/** How long `hex start` may take: it waits until the app answers. */
const START_TIMEOUT_MS = 30_000;
/** A start is tried at most this often, so a Hex that will not come up is not relaunched on every clip. */
const START_EVERY_MS = 60_000;
/** A clip of a minute takes Parakeet well under a second; this is for a model macOS swapped out, over the clip's own length. */
const HEAR_TIMEOUT_MS = 20_000;

/** The running Hex's local API, as its discovery file says. */
export interface HexDiscovery {
  port: number;
  token: string;
  pid: number;
}

/** The discovery file's text, checked: a port, a token and a pid, all real. Pure. */
export function parseDiscovery(text: string): HexDiscovery | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const rec = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const { port, token, pid } = rec;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1) return null;
  if (typeof token !== "string" || !/^[\w.-]{8,512}$/.test(token)) return null;
  return { port, token, pid };
}

/** The model Hex dictates with, from its `status` reply. Pure. */
export function hexModel(reply: unknown): { id: string; name: string; language: string; installed: boolean } | null {
  const model = reply && typeof reply === "object" ? (reply as Record<string, unknown>).model : null;
  if (!model || typeof model !== "object") return null;
  const m = model as Record<string, unknown>;
  if (typeof m.id !== "string" || !/^[\w-]{1,80}$/.test(m.id)) return null;
  const language = typeof m.language === "string" && /^[\w-]{1,16}$/.test(m.language) ? m.language : "en";
  return { id: m.id, name: typeof m.name === "string" ? m.name : m.id, language, installed: m.installed === true };
}

/** The Hex app's CLI, or null when it is not installed. */
export function hexBinary(): string | null {
  return APP_BINARIES.find((path) => existsSync(path)) ?? null;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM is a process that is there and not ours to signal — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whoever wants to know that what Settings shows has changed. */
export interface HexDeps {
  changed: () => void;
}

export class Hex {
  /** What Settings → Voice says about Hex itself. */
  status: ToolStatus = { ok: false, detail: "Looking…" };
  /** And about the vocabulary file and Hex's copy of it. */
  vocabulary: ToolStatus = { ok: false, detail: "Not read yet" };
  private starting: Promise<void> | null = null;
  private lastStart = 0;
  /** The Hex and the file the last good sync was of, so an unchanged pair is not synced again. */
  private synced = "";
  private syncing: Promise<void> = Promise.resolve();
  /** Whether Hex's Labs › Vocabulary biasing was on when last asked; null before anybody asked. */
  private biasing: boolean | null = null;
  private watcher: FSWatcher | null = null;
  private watchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: HexDeps) {}

  installed(): boolean {
    return process.platform === "darwin" && hexBinary() !== null;
  }

  // ---------------------------------------------------------------------------
  // Reaching it
  // ---------------------------------------------------------------------------

  private discover(): HexDiscovery | null {
    let text: string;
    try {
      text = readFileSync(DISCOVERY, "utf8");
    } catch {
      return null;
    }
    const found = parseDiscovery(text);
    return found && alive(found.pid) ? found : null;
  }

  /** One control command, its reply, or a throw that says why there was none. */
  private async control(command: Record<string, unknown>, timeoutMs = 12_000): Promise<Record<string, unknown>> {
    const at = this.discover();
    if (!at) throw new Error("Hex is not running");
    const res = await fetch(`http://127.0.0.1:${at.port}/control`, {
      method: "POST",
      headers: { authorization: `Bearer ${at.token}`, "content-type": "application/json" },
      body: JSON.stringify({ version: CONTROL_VERSION, ...command }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Hex answered ${res.status}`);
    const reply = (await res.json()) as Record<string, unknown>;
    if (reply.status === "error") throw new Error(`Hex: ${typeof reply.message === "string" ? reply.message : String(reply.code)}`);
    return reply;
  }

  /**
   * Start Hex if it is installed and not answering, at most once a minute,
   * and sync the vocabulary into it once it is up. Never throws.
   */
  ensure(): Promise<void> {
    if (!this.installed()) {
      // A child is heard through the Mac, as `missingTool` says of `yap`.
      this.set({ ok: false, detail: process.platform === "darwin" ? `Not installed. In a terminal: ${INSTALL_LINE}` : "Not on this platform: this machine is heard through the Mac" });
      return Promise.resolve();
    }
    if (this.discover()) return this.refresh();
    if (this.starting) return this.starting;
    if (Date.now() - this.lastStart < START_EVERY_MS) return Promise.resolve();
    this.lastStart = Date.now();
    this.set({ ok: false, detail: "Starting Hex…" });
    this.starting = run(hexBinary()!, ["start", "--json"], { timeout: START_TIMEOUT_MS })
      .then(() => this.refresh())
      .catch((err: unknown) => this.set({ ok: false, detail: `Hex would not start: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` }))
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  /** Ask Hex what it is doing, say so, and sync the vocabulary if Hex or the file changed. */
  async refresh(): Promise<void> {
    try {
      const reply = await this.control({ command: "status" });
      const model = hexModel(reply);
      const version = typeof reply.app_version === "string" ? reply.app_version : "";
      if (!model) this.set({ ok: false, detail: "Hex answered without a model" });
      else if (!model.installed) this.set({ ok: false, detail: `${model.name} is not downloaded. In a terminal: ${hexBinary() ?? "hex"} model install ${model.id}` });
      else this.set({ ok: true, detail: `${model.name}${version ? `, Hex ${version}` : ""}` });
      const labs = Array.isArray(reply.labs) ? reply.labs : [];
      void this.syncVocabulary(labs.includes("vocabulary-biasing"));
    } catch (err) {
      this.set({ ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  }

  private set(status: ToolStatus): void {
    if (status.ok === this.status.ok && status.detail === this.status.detail) return;
    this.status = status;
    this.deps.changed();
  }

  // ---------------------------------------------------------------------------
  // Hearing
  // ---------------------------------------------------------------------------

  /**
   * A WAV on the disk, into words: the transcript, empty for a clip that held
   * none. Throws when Hex could not be asked or could not answer, which is
   * the caller's cue to hear the clip some other way — and starts Hex, for
   * the next clip, when it was not running.
   */
  async transcribe(path: string, ms: number): Promise<string> {
    const at = this.discover();
    if (!at) {
      void this.ensure();
      throw new Error("Hex is not running");
    }
    const reply = await this.control({ command: "status" });
    const model = hexModel(reply);
    if (!model?.installed) throw new Error(model ? `${model.name} is not downloaded` : "Hex has no model");
    const body = readFileSync(path);
    const res = await fetch(`http://127.0.0.1:${at.port}/transcriptions?model=${encodeURIComponent(model.id)}&language=${encodeURIComponent(model.language)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${at.token}`, "content-type": "audio/wav" },
      body,
      signal: AbortSignal.timeout(HEAR_TIMEOUT_MS + Math.ceil(Number.isFinite(ms) ? Math.max(0, ms) : 0)),
    });
    const answer = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) throw new Error(`Hex could not hear it: ${typeof answer?.error === "string" ? answer.error : typeof answer?.code === "string" ? answer.code : res.status}`);
    const text = typeof answer?.transcript === "string" ? answer.transcript : typeof answer?.text === "string" ? answer.text : null;
    if (text === null) throw new Error("Hex's answer had no transcript");
    return text.replace(/\s+/g, " ").trim();
  }

  /**
   * Somebody started talking: have the model warm by the time they stop.
   * Hex keeps its weights resident for three minutes after a run and macOS
   * may swap them out after that, and a prepare costs nothing when the
   * model ran in the last minute. Fire and forget; the answer is a stream
   * of progress nobody here needs.
   */
  warm(): void {
    const at = this.discover();
    if (!at) {
      void this.ensure();
      return;
    }
    void (async () => {
      const reply = await this.control({ command: "status" });
      const model = hexModel(reply);
      if (!model?.installed) return;
      const res = await fetch(`http://127.0.0.1:${at.port}/models/${encodeURIComponent(model.id)}/prepare?language=${encodeURIComponent(model.language)}`, {
        method: "POST",
        headers: { authorization: `Bearer ${at.token}` },
        signal: AbortSignal.timeout(30_000),
      });
      await res.arrayBuffer();
    })().catch(() => {});
    void this.syncVocabulary(null);
  }

  // ---------------------------------------------------------------------------
  // The vocabulary
  // ---------------------------------------------------------------------------

  /** Watch the file's folder (an editor saves by replacing the file) and sync on a change. */
  watchVocabulary(): void {
    if (this.watcher || !existsSync(VOCABULARY_DIR)) return;
    try {
      this.watcher = watch(VOCABULARY_DIR, () => {
        if (this.watchTimer) clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => void this.syncVocabulary(null), 300);
      });
      this.watcher.on("error", () => {
        this.watcher?.close();
        this.watcher = null;
      });
    } catch {
      this.watcher = null;
    }
  }

  /**
   * Make Hex's list the file's, unless the same Hex already has the same
   * file. One at a time. `biasing` is whether Hex's Labs › Vocabulary
   * biasing is on, when the caller has just asked; without it Parakeet takes
   * no list at all, and Settings says so.
   */
  syncVocabulary(biasing: boolean | null): Promise<void> {
    this.syncing = this.syncing.then(() => this.sync(biasing)).catch(() => {});
    return this.syncing;
  }

  private async sync(biasing: boolean | null): Promise<void> {
    if (biasing !== null) this.biasing = biasing;
    let stamp: string;
    let text: string;
    try {
      const st = statSync(VOCABULARY_FILE);
      stamp = `${st.mtimeMs}:${st.size}`;
      text = readFileSync(VOCABULARY_FILE, "utf8");
    } catch {
      this.setVocabulary({ ok: false, detail: `No file at ${VOCABULARY_FILE.replace(homedir(), "~")}` });
      return;
    }
    const want = parseVocabulary(text);
    if ("error" in want) {
      this.setVocabulary({ ok: false, detail: `${VOCABULARY_FILE.replace(homedir(), "~")} is ${want.error}; Hex keeps the list it had` });
      return;
    }
    const at = this.discover();
    if (!at) {
      this.setVocabulary({ ok: false, detail: `${want.terms.length} terms, waiting for Hex` });
      return;
    }
    const key = `${at.pid}:${stamp}`;
    if (key !== this.synced) {
      try {
        const have = hexEntries(await this.control({ command: "vocabulary-list" }));
        const plan = vocabularyPlan(have, want.terms);
        for (const term of plan.remove) await this.control({ command: "vocabulary-remove", term });
        for (const entry of plan.add) await this.control({ command: "vocabulary-add", term: entry.term, sounds_like: entry.sounds_like });
        const after = hexEntries(await this.control({ command: "vocabulary-list" }));
        if (vocabularyPlan(after, want.terms).add.length) throw new Error("Hex's list still differs from the file after the sync");
        this.synced = key;
      } catch (err) {
        this.setVocabulary({ ok: false, detail: `Could not sync into Hex: ${err instanceof Error ? err.message : String(err)}` });
        return;
      }
    }
    const read = Math.min(BIASED_TERMS, want.terms.length);
    const steer = this.biasing === false ? "Hex's Labs › Vocabulary biasing is off, so Parakeet ignores them" : read < want.terms.length ? `Parakeet reads the first ${read}` : "all of them steer Parakeet";
    this.setVocabulary({ ok: this.biasing !== false, detail: `${want.terms.length} terms in Hex; ${steer}` });
  }

  private setVocabulary(status: ToolStatus): void {
    if (status.ok === this.vocabulary.ok && status.detail === this.vocabulary.detail) return;
    this.vocabulary = status;
    this.deps.changed();
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.watchTimer) clearTimeout(this.watchTimer);
  }
}
