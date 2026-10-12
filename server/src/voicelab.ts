/**
 * The voice lab's processes: the engines on trial, kept out of the server the
 * way Kokoro is.
 *
 * Why they are here at all is `LAB_MODELS`'s header in `shared/voice.ts`, and
 * why Python is `server/voicelab.py`'s. What this module adds is the shape,
 * which is `kokoro.ts`'s for the same reasons: a native runtime belongs in a
 * process of its own, started on the first sentence that wants it, and ended
 * with SIGKILL so that nothing it does on the way out is the server's
 * business. Two processes rather than one, because the environments differ —
 * Pocket TTS on torch, the rest on MLX and onnxruntime — and a process is
 * started only for the environment a chosen voice needs.
 *
 * **These models are big, and the person's Mac is running their agents.** A
 * Chatterbox or a Qwen3 is gigabytes of unified memory, so a process nobody
 * has asked for anything in a quarter of an hour is ended, and the next
 * sentence pays for the load again — seconds, against holding the memory all
 * day for a voice that may not be the one picked.
 *
 * Nothing here installs anything. A model whose files are not under the lab's
 * folder is not offered, and a voice whose model is missing falls back to the
 * Mac's, as a Kokoro voice does before its download.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { LAB_MODELS, labVoice, type LabModel, type LabStatus, type VoiceLang } from "../../shared/voice";

/** A sentence from a model already loaded. Chatterbox takes two or three seconds; a stuck one is ended. */
const SENTENCE_TIMEOUT_MS = 60_000;
/** A sentence that loads its model first. Chatterbox's first load ever compiles for half a minute, and Pocket's first import of torch was as long. */
const LOAD_TIMEOUT_MS = 180_000;
/** How long a process may sit unasked before its memory is given back. */
const IDLE_MS = 15 * 60_000;
/** stderr lines kept from each process, to say why one failed. The rest is progress bars. */
const KEEP_STDERR = 12;

/** Where the lab lives: a cache, beside Kokoro's models, since everything in it can be fetched again. */
export function labRoot(): string {
  return process.env.KURURU_VOICELAB || join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "kururu", "voicelab");
}

/**
 * The Python half. Beside this bundle if a build ever puts it there; from a
 * checkout, where the server runs from `desktop/dist`, it is two levels up
 * in `server/`. The app does not ship it, so the app has no lab — this is a
 * trial, run from a checkout.
 */
const SCRIPTS = [new URL("./voicelab.py", import.meta.url), new URL("../../server/voicelab.py", import.meta.url)].map((url) => fileURLToPath(url));

interface Waiting {
  resolve: (wav: Buffer) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Proc {
  child: ChildProcess;
  waiting: Map<number, Waiting>;
  /** The models this process has loaded, so a sentence for one of them gets the short timeout. */
  loaded: Set<string>;
  stderr: string[];
  idle: ReturnType<typeof setTimeout> | null;
}

type FromLab =
  | { id: number; wav: string; ms: number }
  | { id: number; error: string }
  | { event: "loading" | "loaded" | "unloaded" | "failed"; model: string; ms?: number; error?: string };

export class Lab {
  private readonly procs = new Map<LabModel["runtime"], Proc>();
  private readonly states = new Map<string, LabStatus>();
  private requests = 0;

  /** `changed` is told whenever a model's state moves, for Settings to redraw. */
  constructor(private readonly changed: () => void) {}

  /** The models whose files are on this machine, with an environment to run them and the script to run. */
  installed(): LabModel[] {
    if (!this.script()) return [];
    const root = labRoot();
    return LAB_MODELS.filter((model) => existsSync(join(root, model.marker)) && existsSync(python(root, model.runtime)));
  }

  status(): LabStatus[] {
    return this.installed().map((model) => this.states.get(model.id) ?? { id: model.id, name: model.name, state: "idle", detail: "" });
  }

  /** Whether this voice can speak this language now: a lab voice, whose model speaks it, with the model installed. */
  can(voice: string, lang: VoiceLang): boolean {
    const hit = labVoice(voice);
    return !!hit && hit.model.langs.includes(lang) && this.installed().includes(hit.model);
  }

  /** One sentence, as a WAV. */
  speak(voice: string, lang: VoiceLang, text: string, speed: number): Promise<Buffer> {
    const hit = labVoice(voice);
    if (!hit) return Promise.reject(new Error(`no lab voice ${voice}`));
    const { model } = hit;
    let proc: Proc;
    try {
      proc = this.start(model.runtime);
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    const id = ++this.requests;
    this.touch(model.runtime, proc);
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          proc.waiting.delete(id);
          reject(new Error(`${model.name} took too long over one sentence`));
          proc.child.kill("SIGKILL");
        },
        proc.loaded.has(model.id) ? SENTENCE_TIMEOUT_MS : LOAD_TIMEOUT_MS,
      );
      proc.waiting.set(id, { resolve, reject, timer });
      const line = JSON.stringify({ id, model: model.id, voice: hit.voice.id, lang, text, speed });
      proc.child.stdin?.write(`${line}\n`, (err) => {
        if (!err) return;
        const waiting = proc.waiting.get(id);
        if (!waiting) return;
        clearTimeout(waiting.timer);
        proc.waiting.delete(id);
        waiting.reject(err);
      });
    });
  }

  /** End every process, for a server on its way down. */
  close(): void {
    for (const proc of this.procs.values()) proc.child.kill("SIGKILL");
  }

  private script(): string | null {
    return SCRIPTS.find((path) => existsSync(path)) ?? null;
  }

  /** The process for an environment, started if it is not running. */
  private start(runtime: LabModel["runtime"]): Proc {
    const running = this.procs.get(runtime);
    if (running) return running;
    const script = this.script();
    if (!script) throw new Error("the voice lab's script is not here — it runs from a checkout");
    const root = labRoot();
    const child = spawn(python(root, runtime), ["-I", script, root], {
      stdio: ["pipe", "pipe", "pipe"],
      // Offline, and every cache the libraries keep pointed into the lab, so
      // nothing lands in the person's home and nothing is fetched behind
      // their back. `-I` ignores PYTHON* variables; these are the libraries'.
      env: {
        ...process.env,
        HF_HOME: join(root, "hf"),
        HF_HUB_OFFLINE: "1",
        HF_HUB_DISABLE_TELEMETRY: "1",
        XDG_CACHE_HOME: join(root, "xdg"),
        TORCH_HOME: join(root, "xdg", "torch"),
        MPLCONFIGDIR: join(root, "xdg", "matplotlib"),
        NUMBA_CACHE_DIR: join(root, "xdg", "numba"),
        TOKENIZERS_PARALLELISM: "false",
      },
    });
    const proc: Proc = { child, waiting: new Map(), loaded: new Set(), stderr: [], idle: null };
    this.procs.set(runtime, proc);
    if (child.stdout) createInterface({ input: child.stdout }).on("line", (line) => this.heard(proc, line));
    if (child.stderr) {
      createInterface({ input: child.stderr }).on("line", (line) => {
        proc.stderr.push(line);
        if (proc.stderr.length > KEEP_STDERR) proc.stderr.shift();
      });
    }
    const gone = (why: string) => {
      if (this.procs.get(runtime) === proc) this.procs.delete(runtime);
      if (proc.idle) clearTimeout(proc.idle);
      const last = proc.stderr.filter((l) => l.trim()).pop();
      const error = new Error(last ? `${why}: ${last}` : why);
      for (const waiting of proc.waiting.values()) {
        clearTimeout(waiting.timer);
        waiting.reject(error);
      }
      proc.waiting.clear();
      // What it had loaded is not loaded any more; what was loading failed.
      let moved = false;
      for (const model of LAB_MODELS) {
        if (model.runtime !== runtime) continue;
        const state = this.states.get(model.id);
        if (!state || state.state === "idle" || state.state === "error") continue;
        this.states.set(model.id, state.state === "loading" ? { ...state, state: "error", detail: error.message } : { ...state, state: "idle", detail: "" });
        moved = true;
      }
      if (moved) this.changed();
    };
    child.on("error", (err) => gone(err.message));
    child.on("exit", (code, signal) => gone(signal ? `the lab process was ended by ${signal}` : `the lab process exited with code ${code}`));
    return proc;
  }

  private heard(proc: Proc, line: string): void {
    const msg = parse(line);
    if (!msg) return;
    if ("event" in msg) {
      const model = LAB_MODELS.find((m) => m.id === msg.model);
      if (!model) return;
      if (msg.event === "loaded") proc.loaded.add(model.id);
      if (msg.event === "unloaded") proc.loaded.delete(model.id);
      const state: LabStatus["state"] = msg.event === "loading" ? "loading" : msg.event === "loaded" ? "ready" : msg.event === "failed" ? "error" : "idle";
      const detail = msg.event === "loaded" && typeof msg.ms === "number" ? `loaded in ${(msg.ms / 1000).toFixed(1)} s` : msg.event === "failed" ? (msg.error ?? "") : "";
      this.states.set(model.id, { id: model.id, name: model.name, state, detail });
      this.changed();
      return;
    }
    const waiting = proc.waiting.get(msg.id);
    if (!waiting) return;
    clearTimeout(waiting.timer);
    proc.waiting.delete(msg.id);
    if ("wav" in msg) waiting.resolve(Buffer.from(msg.wav, "base64"));
    else waiting.reject(new Error(msg.error));
  }

  /** Put off the idle ending: this process was just asked for something. */
  private touch(runtime: LabModel["runtime"], proc: Proc): void {
    if (proc.idle) clearTimeout(proc.idle);
    proc.idle = setTimeout(() => {
      if (proc.waiting.size) return this.touch(runtime, proc);
      proc.child.kill("SIGKILL");
    }, IDLE_MS).unref();
  }
}

function parse(line: string): FromLab | null {
  try {
    const msg: unknown = JSON.parse(line);
    return msg && typeof msg === "object" ? (msg as FromLab) : null;
  } catch {
    return null;
  }
}

function python(root: string, runtime: LabModel["runtime"]): string {
  return join(root, `venv-${runtime}`, "bin", "python");
}
