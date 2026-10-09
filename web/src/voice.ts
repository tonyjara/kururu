/**
 * The microphone, the talk key, and the player: the window's half of the
 * voice.
 *
 * Everything that decides anything is on the server (`server/src/voice.ts`):
 * which language was spoken, which voice answers, where the words go. What
 * is left here is holding a microphone open for as long as a key is down and
 * playing sentences in the order they were announced — and the reason this is
 * a module and not a component is that both outlive any component. The key
 * works with Settings open, with a dialog up, with a terminal focused; a
 * sentence keeps playing while you change workspace. So the state lives at
 * module level, the way `session.ts` holds the socket, and the pill and the
 * status bar subscribe to it.
 *
 * **Hold or tap.** The key starts recording on the way down, always — a
 * microphone that waits to find out whether this is a tap loses the first
 * word. On the way up, if it was held for less than `TAP_MS` it was a tap and
 * recording stays on until the next tap; held longer, it was a hold and the
 * clip is sent. Escape throws the clip away. The window losing focus while
 * the key is down sends what there is, because the key-up is never coming.
 *
 * **PCM, not a MediaRecorder.** The browser's recorder writes WebM/Opus,
 * which Apple's recogniser will not open, so the samples are taken off an
 * `AudioWorklet` and written as a WAV by hand (`shared/voice.ts`). It is
 * also what the level meter is read from, so there is one tap on the
 * microphone and not two.
 *
 * **Nothing plays while anybody talks.** From the press until the words are
 * with the server, this page is talking, and it says so (`api.talking`);
 * the server tells every page when any one is (`hush`). While either holds,
 * the player starts nothing and a sentence that arrives waits in the queue.
 * The press still cuts off what was already playing, and so does another
 * page's press. When the hush lifts, what waited plays — unless the words
 * reached Kuru, in which case the server has said what they superseded and
 * that was thrown away on the way in (`server/src/voice.ts` says why).
 */
import { useSyncExternalStore } from "react";
import { CLIP_MIN_MS, CLIP_RATE, TAP_MS, downsample, encodeWav, type Heard, type SpeechChunk } from "../../shared/voice";
import { audioOutput } from "./notify";
import * as api from "./session";

export type VoicePhase = "idle" | "listening" | "sending" | "heard" | "speaking" | "error";

export interface VoiceUi {
  phase: VoicePhase;
  /** 0–1, the microphone's level while listening. */
  level: number;
  /** What was heard, or what is being said, or what went wrong. */
  text: string;
  /** A second line: where the words went, or which key releases. */
  detail: string;
  /** Recording was toggled on by a tap, so the pill can say which gesture ends it. */
  toggled: boolean;
}

const IDLE: VoiceUi = { phase: "idle", level: 0, text: "", detail: "", toggled: false };
let ui: VoiceUi = IDLE;
const listeners = new Set<() => void>();

function set(patch: Partial<VoiceUi>): void {
  ui = { ...ui, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useVoiceUi(): VoiceUi {
  return useSyncExternalStore(subscribe, () => ui);
}

/** How long a heard sentence or an error stays on screen once nothing else is happening. */
const LINGER_MS = 4000;
let linger: ReturnType<typeof setTimeout> | null = null;

function settle(): void {
  if (linger) clearTimeout(linger);
  linger = setTimeout(() => {
    linger = null;
    if (ui.phase === "heard" || ui.phase === "error") set({ ...IDLE });
  }, LINGER_MS);
}

// ---------------------------------------------------------------------------
// The microphone
// ---------------------------------------------------------------------------

/**
 * The worklet, as source. A worklet is loaded from a URL and there is no
 * file to point at inside one bundle, so it is a blob of this string. It
 * forwards every block of samples it is given and does nothing else; the
 * level and the downsampling happen on this side, where the numbers are.
 */
const WORKLET = `class KururuPcm extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) this.port.postMessage(new Float32Array(channel));
    return true;
  }
}
registerProcessor("kururu-pcm", KururuPcm);`;

let workletUrl: string | null = null;

interface Recording {
  ctx: AudioContext;
  stream: MediaStream;
  chunks: Float32Array[];
  rate: number;
  startedAt: number;
}

let recording: Recording | null = null;
/** The microphone being opened — a promise, so a release that lands before it is open can wait for it. */
let opening: Promise<void> | null = null;
let mode: "hold" | "toggle" = "hold";
let pressedAt = 0;
/** The press that stopped a toggled recording; its release must not start another. */
let pressConsumed = false;
let lastLevelAt = 0;
let profileOf: () => string = () => "";

/** Who the clip is for. `App` tells this module which profile is on screen, since the module cannot see the snapshot. */
export function setVoiceProfile(get: () => string): void {
  profileOf = get;
}

async function open(): Promise<void> {
  if (recording || opening) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    // No microphone to hold anything for, but the press still means quiet.
    stopSpeaking();
    set({
      phase: "error",
      text: "No microphone here.",
      detail: location.protocol === "https:" ? "This browser offers none." : "A browser only opens the microphone over https — see docs/voice.md.",
    });
    settle();
    return;
  }
  beginTalk();
  set({ phase: "listening", level: 0, text: "", detail: "", toggled: false });
  opening = (async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      let ctx: AudioContext;
      try {
        ctx = new AudioContext({ sampleRate: CLIP_RATE });
      } catch {
        ctx = new AudioContext();
      }
      if (ctx.state === "suspended") await ctx.resume().catch(() => {});
      workletUrl ??= URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
      await ctx.audioWorklet.addModule(workletUrl);
      const node = new AudioWorkletNode(ctx, "kururu-pcm", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      const chunks: Float32Array[] = [];
      node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        const block = event.data;
        chunks.push(block);
        // The worklet posts a block every few milliseconds; the meter wants
        // thirty frames a second, and React does not want more.
        const now = performance.now();
        if (now - lastLevelAt < 33) return;
        lastLevelAt = now;
        let sum = 0;
        for (let i = 0; i < block.length; i++) sum += block[i]! * block[i]!;
        set({ level: Math.min(1, Math.sqrt(sum / block.length) * 6) });
      };
      // A worklet with nowhere to go is a worklet that is never run, so it
      // runs into a muted gain and out: the speakers hear nothing.
      const source = ctx.createMediaStreamSource(stream);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      source.connect(node);
      node.connect(mute);
      mute.connect(ctx.destination);
      recording = { ctx, stream, chunks, rate: ctx.sampleRate, startedAt: performance.now() };
    } catch (err) {
      const refused = err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError");
      set({
        phase: "error",
        text: refused ? "The microphone was refused." : "The microphone could not be opened.",
        detail: refused ? "Allow it for kururu in System Settings → Privacy → Microphone." : err instanceof Error ? err.message : String(err),
      });
      settle();
      // No recording was made, so no `close` will end this talk.
      endTalk();
    } finally {
      opening = null;
    }
  })();
  await opening;
}

async function close(send: boolean): Promise<void> {
  if (opening) await opening;
  const rec = recording;
  recording = null;
  if (!rec) {
    if (ui.phase === "listening") set({ ...IDLE });
    return;
  }
  // Whoever took the recording ends the talk, once, however it goes — and
  // not before the server has answered, because "until my message has been
  // sent" is the hush's whole length.
  try {
    for (const track of rec.stream.getTracks()) track.stop();
    void rec.ctx.close().catch(() => {});
    let length = 0;
    for (const chunk of rec.chunks) length += chunk.length;
    const samples = new Float32Array(length);
    let at = 0;
    for (const chunk of rec.chunks) {
      samples.set(chunk, at);
      at += chunk.length;
    }
    const pcm = downsample(samples, rec.rate, CLIP_RATE);
    const ms = (pcm.length / CLIP_RATE) * 1000;
    if (!send || ms < CLIP_MIN_MS) {
      set({ ...IDLE });
      return;
    }
    set({ phase: "sending", level: 0, text: "", detail: "", toggled: false });
    try {
      const heard = await api.hearClip(profileOf(), encodeWav(pcm, CLIP_RATE));
      tell(heard);
    } catch (err) {
      set({ phase: "error", text: "Could not send the clip.", detail: err instanceof Error ? err.message : String(err) });
      settle();
    }
  } finally {
    endTalk();
  }
}

/** What the server made of the clip, in the pill's words. */
function tell(heard: Heard): void {
  if (heard.outcome === "nothing") {
    set({ phase: "error", text: "Nothing heard.", detail: "" });
  } else if (heard.outcome === "failed") {
    set({ phase: "error", text: heard.text ? `“${heard.text}”` : "Could not hear that.", detail: heard.why ?? "" });
  } else {
    const where =
      heard.outcome === "typed" ? "Sent to Kuru." : heard.outcome === "held" ? "Kuru's terminal is busy; it will hear this next." : "Kuru is starting; it will hear this first.";
    const dropped =
      heard.skipped > 1 ? ` Dropped the ${heard.skipped} replies it gave while you talked.` : heard.skipped === 1 ? " Dropped the reply it gave while you talked." : "";
    set({ phase: "heard", text: `“${heard.text}”`, detail: where + dropped });
  }
  settle();
}

// ---------------------------------------------------------------------------
// The key, and the button that is the same key for a thumb
// ---------------------------------------------------------------------------

/** The talk key or the mic button went down. */
export function talkDown(): void {
  pressedAt = performance.now();
  pressConsumed = false;
  if ((recording || opening) && mode === "toggle") {
    // A toggled recording ends on the next press, and that press's release
    // must not start a fresh one.
    pressConsumed = true;
    void close(true);
    return;
  }
  if (recording || opening) return;
  mode = "hold";
  void open();
}

/** …and came back up. */
export function talkUp(): void {
  if (pressConsumed) {
    pressConsumed = false;
    return;
  }
  if (!recording && !opening) return;
  if (performance.now() - pressedAt < TAP_MS) {
    mode = "toggle";
    set({ toggled: true });
    return;
  }
  void close(true);
}

/** Throw the clip away. */
export function cancelTalk(): void {
  if (recording || opening) void close(false);
}

/** Whether a clip is being recorded, for the key handler to know whether Escape is its business. */
export function isListening(): boolean {
  return recording !== null || opening !== null;
}

/**
 * The key, on the window, both ways, in the capture phase — before the
 * terminal's own listener, which sees a bare modifier and sends nothing for
 * it anyway. `code` rather than `key`, because the right Control key and
 * the left are one `key` and two `code`s, and the whole point is one of them.
 * `repeat` is the key held down, which is already known.
 */
export function installTalkKey(codeOf: () => string): () => void {
  const down = (event: KeyboardEvent) => {
    if (isListening() && event.key === "Escape") {
      // Immediate, because the prefix handler listens on this same window
      // and would otherwise take the Escape as well and close whatever it
      // thinks it is for.
      event.preventDefault();
      event.stopImmediatePropagation();
      cancelTalk();
      return;
    }
    if (event.code !== codeOf() || event.repeat) return;
    event.preventDefault();
    talkDown();
  };
  const up = (event: KeyboardEvent) => {
    if (event.code !== codeOf()) return;
    event.preventDefault();
    talkUp();
  };
  // The key-up is lost when the window loses focus with the key down —
  // Command-Tab mid-sentence — and a microphone left open is worse than a
  // clip sent early.
  const blur = () => {
    if (isListening() && mode === "hold") void close(true);
  };
  window.addEventListener("keydown", down, true);
  window.addEventListener("keyup", up, true);
  window.addEventListener("blur", blur);
  return () => {
    window.removeEventListener("keydown", down, true);
    window.removeEventListener("keyup", up, true);
    window.removeEventListener("blur", blur);
  };
}

// ---------------------------------------------------------------------------
// The player
// ---------------------------------------------------------------------------

const queue: SpeechChunk[] = [];
let playing: AudioBufferSourceNode | null = null;
/**
 * A sentence is being fetched and decoded: the gap before `playing` is set.
 * Without it, a chunk that arrives in that gap finds nothing playing and
 * starts a fetch of its own, and the two play over each other. Sentences
 * arriving a second apart rarely land in it; a short sentence after a long
 * one, or two replies back to back, do.
 */
let loading = false;
let current: string | null = null;
/** Utterances that were cut off or superseded: their later sentences are still announced, and are dropped on arrival. */
const cancelled = new Set<string>();
let speechGain: GainNode | null = null;
let volumeOf: () => number = () => 1;

/** The volume slider, read at the moment of playing. */
export function setSpeechVolume(get: () => number): void {
  volumeOf = get;
}

/**
 * Talks on this page that have not ended: a count and not a flag, because
 * the key can go down again while the last clip is still being heard, and
 * the first one ending must not lift the second one's hush.
 */
let talks = 0;
/** Somebody is talking, this page or another, as the server last said. */
let hushedByServer = false;

function hushed(): boolean {
  return talks > 0 || hushedByServer;
}

/**
 * Change what the hush is made of, and act on the edge: going quiet cuts
 * off what is playing, as the press always has; coming back plays what
 * waited. Only on the edge, so a second page's press while this one already
 * holds a reply does not throw that reply away.
 */
function hush(change: () => void): void {
  const was = hushed();
  change();
  if (!was && hushed()) stopSpeaking();
  else if (was && !hushed()) void pump();
}

function beginTalk(): void {
  hush(() => talks++);
  api.talking(true);
}

function endTalk(): void {
  hush(() => {
    talks = Math.max(0, talks - 1);
  });
  if (talks === 0) api.talking(false);
}

/** Start taking what the harness says off the socket. Called once, by `App`. */
export function installSpeech(): () => void {
  const stopSpeech = api.onSpeech((chunk) => {
    if (cancelled.has(chunk.utterance)) return;
    queue.push(chunk);
    void pump();
  });
  const stopHush = api.onHush((on, drop) => {
    // Before the hush can lift, so what was superseded is gone by the time
    // the queue is played.
    cancel(drop);
    hush(() => {
      hushedByServer = on;
    });
  });
  return () => {
    stopSpeech();
    stopHush();
  };
}

async function pump(): Promise<void> {
  if (playing || loading || hushed()) return;
  const chunk = queue.shift();
  if (!chunk) {
    if (ui.phase === "speaking") {
      set({ phase: "heard", level: 0 });
      settle();
    }
    return;
  }
  if (cancelled.has(chunk.utterance)) return pump();
  const out = audioOutput();
  if (!out) return;
  // Before the first await, so the talk key going down mid-fetch cuts off
  // the sentence being fetched and not only the ones behind it.
  current = chunk.utterance;
  loading = true;
  let buffer: AudioBuffer | null = null;
  try {
    if (out.ctx.state === "suspended") await out.ctx.resume().catch(() => {});
    const res = await fetch(api.speechUrl(chunk.utterance, chunk.seq));
    if (res.ok) buffer = await out.ctx.decodeAudioData(await res.arrayBuffer());
  } catch {
    buffer = null;
  } finally {
    loading = false;
  }
  if (!buffer || cancelled.has(chunk.utterance)) return pump();
  if (!speechGain) {
    speechGain = out.ctx.createGain();
    speechGain.connect(out.ctx.destination);
  }
  speechGain.gain.value = Math.min(1, Math.max(0, volumeOf()));
  const source = out.ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(speechGain);
  playing = source;
  set({ phase: "speaking", text: chunk.text, detail: "Kuru", level: 0, toggled: false });
  source.onended = () => {
    if (playing === source) playing = null;
    void pump();
  };
  source.start();
}

/** Cut Kuru off. The talk key does this on its way down, and the pill's ✕ through `dismissVoice`. */
export function stopSpeaking(): void {
  cancel([...(current ? [current] : []), ...queue.map((chunk) => chunk.utterance)]);
  queue.length = 0;
  if (playing) {
    const source = playing;
    playing = null;
    try {
      source.onended = null;
      source.stop();
    } catch {
      // Already over.
    }
  }
  if (ui.phase === "speaking") set({ ...IDLE });
}

/** Utterances never to be played: the rest of their sentences are dropped on arrival, and whatever of them is queued when its turn comes. */
function cancel(ids: Iterable<string>): void {
  for (const id of ids) cancelled.add(id);
  // The set would grow one id per reply forever; nothing announced is older
  // than the server keeps, so a few dozen is every id that can still arrive.
  if (cancelled.size > 64) {
    for (const id of [...cancelled].slice(0, cancelled.size - 32)) cancelled.delete(id);
  }
}

/**
 * The pill's ✕: stop whatever it is showing, now.
 *
 * While Kuru speaks that is `stopSpeaking` — the talk key's own cut-off,
 * without the microphone the key opens after it. While the microphone is open
 * it is Escape, which a phone has no key for. Otherwise it is words lingering,
 * and the ✕ takes them down early — and still cuts Kuru off, because the pill
 * says "heard" in the gap between two sentences when the next is still being
 * made, and a ✕ pressed in that gap means the rest of the reply as surely as
 * one pressed a moment before it.
 */
export function dismissVoice(): void {
  if (isListening()) {
    cancelTalk();
    return;
  }
  stopSpeaking();
  if (linger) {
    clearTimeout(linger);
    linger = null;
  }
  if (ui.phase === "heard" || ui.phase === "error") set({ ...IDLE });
}
