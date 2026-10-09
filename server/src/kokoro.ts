/**
 * Kokoro, in a process of its own, so that the server never loads it.
 *
 * It used to live in the server, which cost something worse than memory.
 * `onnxruntime-node` aborts in a static destructor when a process that has
 * loaded it exits (`libc++abi: … mutex lock failed: Invalid argument`), so once
 * the voice had spoken, every exit the server made became a SIGABRT. That
 * included exit 75, which is how the server asks its supervisor for a restart:
 * the request arrived as a signal and the server was left down. Loading the
 * model also takes seconds of the thread the server answers its socket and
 * its signals on.
 *
 * This process is never allowed to exit the ordinary way, because the
 * ordinary way is the one that runs the destructor. It ends by SIGKILL, which
 * runs nothing: the server sends it on the way down, and this process sends
 * it to itself the moment the server's end of the channel goes away, however
 * the server went. Nothing in here needs a clean exit. It holds a model that
 * can be read again and, at most, the sentence it was making.
 *
 * The protocol is the two types below and nothing else. Spanish arrives as
 * phonemes, because `espeak-ng` is a program the server already runs and the
 * substitutions in `voice.ts` belong with it. Audio goes back as a WAV in an
 * ArrayBuffer, which the channel's advanced serialisation carries as bytes
 * rather than as a JSON array of numbers.
 */
import { mkdirSync } from "node:fs";

/** What the server asks. One `load` first, then any number of sentences. */
export type ToKokoro =
  | { type: "load"; cacheDir: string; remote: boolean; model: string }
  | { type: "speak"; id: number; voice: string; speed: number; text: string }
  | { type: "speak"; id: number; voice: string; speed: number; phonemes: string };

/** What it answers. `progress` is transformers.js's own event, passed through for `voice.ts` to filter. */
export type FromKokoro =
  | { type: "progress"; event: { status?: string; file?: string; progress?: number } }
  | { type: "ready" }
  | { type: "failed"; error: string }
  | { type: "audio"; id: number; wav: ArrayBuffer }
  | { type: "error"; id: number; error: string };

type Tts = import("kokoro-js").KokoroTTS;

function end(): never {
  process.kill(process.pid, "SIGKILL");
  // Unreachable: the signal is delivered before the call returns.
  throw new Error("still here");
}

function send(msg: FromKokoro): void {
  process.send?.(msg);
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Started by hand, there is nobody to speak for. Nothing native is loaded yet,
// so an ordinary exit is still safe here and says what happened.
if (!process.send) {
  console.error("kururu: kokoro.mjs is started by the server, not by hand");
  process.exit(1);
}
process.on("disconnect", end);
// A failure in here would otherwise exit the ordinary way and abort on the way
// out, leaving a crash report about the destructor instead of the error. The
// stack goes to stderr, which is the server's, and then the same SIGKILL.
process.on("uncaughtException", (err) => {
  console.error("kururu: the voice process failed:", err);
  end();
});

let tts: Promise<Tts> | null = null;

async function load(msg: Extract<ToKokoro, { type: "load" }>): Promise<Tts> {
  const transformers = await import("@huggingface/transformers");
  transformers.env.cacheDir = msg.cacheDir;
  transformers.env.allowRemoteModels = msg.remote;
  mkdirSync(msg.cacheDir, { recursive: true });
  const { KokoroTTS } = await import("kokoro-js");
  return KokoroTTS.from_pretrained(msg.model, {
    dtype: "q8",
    device: "cpu",
    progress_callback: (event) => {
      const { status, file, progress } = event as { status?: string; file?: string; progress?: number };
      send({ type: "progress", event: { status, file, progress } });
    },
  });
}

async function speak(msg: Extract<ToKokoro, { type: "speak" }>): Promise<void> {
  try {
    if (!tts) throw new Error("asked to speak before the model was loaded");
    const model = await tts;
    const voice = msg.voice as "af_heart";
    const audio =
      "phonemes" in msg
        ? await model.generate_from_ids(model.tokenizer(msg.phonemes, { truncation: true }).input_ids, { voice, speed: msg.speed })
        : await model.generate(msg.text, { voice, speed: msg.speed });
    send({ type: "audio", id: msg.id, wav: audio.toWav() });
  } catch (err) {
    send({ type: "error", id: msg.id, error: message(err) });
  }
}

process.on("message", (msg: ToKokoro) => {
  if (msg.type === "load") {
    if (tts) return;
    tts = load(msg);
    tts.then(
      () => send({ type: "ready" }),
      (err: unknown) => send({ type: "failed", error: message(err) }),
    );
    return;
  }
  void speak(msg);
});
