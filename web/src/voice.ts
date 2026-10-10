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
 * **Nothing plays while anybody talks, and nothing is thrown away.** From
 * the press until the words are with the server, this page is talking, and
 * it says so (`api.talking`); the server tells every page when any one is
 * (`hush`). While either holds, the player starts nothing and a sentence that
 * arrives waits in the queue. The press still cuts off what was already
 * playing, and so does another page's press. When the hush lifts, what
 * waited plays, ahead of the answer to what was just said; the server put
 * "While you were talking" at the front of it.
 *
 * **The player says what became of each reply**, because what was missed is
 * the server's to decide and only a player knows: held, each sentence played
 * to its end, or let go before it (`api.speechHeld`, `api.speechPlayed`).
 * Whatever was cut off, dismissed or never loaded is on the list behind the
 * harness button's badge.
 *
 * **A clip is kept until the server has it, and then the server keeps it.**
 * The moment the key comes up the clip is written to IndexedDB (`unsent.ts`)
 * and sent under an id minted here; the server answers once it is on its
 * disk, and only then is it dropped from this side. A server that is down
 * or restarting is tried again, on a timer and on every reconnect, and a
 * page reloaded in the meantime finds its clips and sends them on start. The
 * id makes sending twice harmless. Past that point the clip is the outbox's
 * (`server/src/outbox.ts`), and what this page knows of it comes back on the
 * socket — which is also how the pill says whether the words got through
 * while Kuru talks over the top of it, rather than losing that line to the
 * first sentence of a reply.
 */
import { useSyncExternalStore } from "react";
import { CLIP_MIN_MS, CLIP_RATE, CLIP_ROLL_MS, TAP_MS, downsample, encodeWav, type OutboxEntry, type SpeechChunk } from "../../shared/voice";
import type { TalkGesture } from "./desktop";
import { audioOutput } from "./notify";
import * as api from "./session";
import { dropClip, keepClip, keptClips, type StoredClip } from "./unsent";

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

// ---------------------------------------------------------------------------
// The one voice client on this Mac
// ---------------------------------------------------------------------------

/**
 * Where this page's gestures go when another page holds the microphone.
 *
 * With the talk key hooked system-wide, the page that records, posts and
 * plays is the floating pill (`Pill.tsx`), because it is the one that exists
 * when there is no window. This page then stops being a voice client: its
 * key handler stands down, its mic button and its Escape are sent across the
 * bridge, and the sentences it would have played are left to the pill. One
 * client is one microphone, one player and one state — and it is also what
 * keeps a key the hook *and* this window both saw from firing twice.
 *
 * `remotePhase` is the pill's phase, so Escape pressed here is swallowed
 * only while there is a clip to drop, and reaches the prefix handler and the
 * terminal otherwise.
 */
let remote: ((gesture: TalkGesture) => void) | null = null;
let remotePhase: VoicePhase = "idle";

export function setVoiceRemote(send: ((gesture: TalkGesture) => void) | null, phase: VoicePhase = "idle"): void {
  const handingOver = Boolean(send) && !remote;
  remote = send;
  remotePhase = phase;
  if (!handingOver) return;
  // A clip this page was taking when the hook came on is sent rather than
  // lost, and what it was saying is cut off: the pill is the mouth now.
  if (recording || opening) void close(true);
  stopSpeaking();
}

/** Whether another page is the voice client, for the pill and the status bar. */
export function voiceIsRemote(): boolean {
  return remote !== null;
}

/**
 * A gesture from the hook, as the pill page receives it over the bridge.
 * The grammar — hold, tap, Escape — is the same three functions the key
 * handler calls, so nothing is decided twice. A chord is the one word the
 * hook has that a window never needed: another key pressed during a hold is
 * a shortcut for the application in front, so the clip is dropped and the
 * release that follows is the chord's, not a send.
 */
let chordedHold = false;

export function applyTalkGesture(gesture: TalkGesture): void {
  switch (gesture) {
    case "down":
      chordedHold = false;
      talkDown();
      return;
    case "up":
      if (chordedHold) {
        chordedHold = false;
        return;
      }
      talkUp();
      return;
    case "chord":
      chordedHold = true;
      cancelTalk();
      return;
    case "escape":
      cancelTalk();
      return;
    case "dismiss":
      dismissVoice();
      return;
    case "toggle":
      // ⌥Space has no key-up, so it is a tap: down and up in the same breath.
      talkDown();
      talkUp();
      return;
  }
}

/** How long a heard sentence or an error stays on screen once nothing else is happening. */
const LINGER_MS = 4000;
/** …and a message of yours that did not get through, which is worth more than four seconds of anybody's attention. */
const FAILED_LINGER_MS = 15_000;
let linger: ReturnType<typeof setTimeout> | null = null;

function settle(ms = LINGER_MS): void {
  if (linger) clearTimeout(linger);
  linger = setTimeout(() => {
    linger = null;
    if (ui.phase === "heard" || ui.phase === "error") set({ ...IDLE });
  }, ms);
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
  setMine(null);
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
      let held = 0;
      node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        const block = event.data;
        chunks.push(block);
        held += block.length;
        // Five minutes in, what there is goes as a message of its own and the
        // recording carries on into the next: a clip is never too long to send.
        if ((held / ctx.sampleRate) * 1000 >= CLIP_ROLL_MS) {
          held = 0;
          void post(pcmOf(chunks.splice(0), ctx.sampleRate));
        }
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
  // not before the server has the clip, so nothing plays in the gap between
  // the key and the words being safe. From there the outbox holds Kuru quiet
  // until they reach it.
  try {
    for (const track of rec.stream.getTracks()) track.stop();
    void rec.ctx.close().catch(() => {});
    if (!send) {
      set({ ...IDLE });
      return;
    }
    await post(pcmOf(rec.chunks, rec.rate));
  } finally {
    endTalk();
  }
}

/** Samples at whatever rate the microphone gave, as one run at the clip's rate. */
function pcmOf(chunks: readonly Float32Array[], rate: number): Float32Array {
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const samples = new Float32Array(length);
  let at = 0;
  for (const chunk of chunks) {
    samples.set(chunk, at);
    at += chunk.length;
  }
  return downsample(samples, rate, CLIP_RATE);
}

/**
 * A recording, as a message: kept, sent, and followed. Resolves once the
 * server has it or the first try has failed — which is when the talk may end,
 * the clip being safe either way.
 */
async function post(pcm: Float32Array): Promise<void> {
  const ms = (pcm.length / CLIP_RATE) * 1000;
  if (ms < CLIP_MIN_MS) {
    if (ui.phase === "listening") set({ ...IDLE });
    return;
  }
  const clip: StoredClip = { id: clipId(), profileId: profileOf(), at: Date.now(), ms, wav: encodeWav(pcm, CLIP_RATE) };
  setMine(clip.id);
  // A clip rolled over mid-recording leaves the pill listening.
  if (!isListening()) set({ phase: "sending", level: 0, text: "", detail: "", toggled: false });
  await hold(clip);
}

// ---------------------------------------------------------------------------
// The clips the server has not taken yet
// ---------------------------------------------------------------------------

/** A clip on its way to the server, and how its last try went. */
export interface Outgoing {
  id: string;
  profileId: string;
  at: number;
  ms: number;
  /** Why the last try failed; null while the first is under way. */
  error: string | null;
}

interface Sending {
  clip: StoredClip;
  error: string | null;
  tries: number;
  busy: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

/** How long after each failed try a clip is sent again. The last repeats: the server is down until it is not. */
const RESEND_MS = [1000, 2000, 5000, 10_000, 30_000];

const sending = new Map<string, Sending>();
let outgoing: Outgoing[] = [];
const outgoingListeners = new Set<() => void>();

function told(): void {
  outgoing = [...sending.values()].map(({ clip, error }) => ({ id: clip.id, profileId: clip.profileId, at: clip.at, ms: clip.ms, error }));
  for (const listener of outgoingListeners) listener();
}

/** The clips this page holds that the server does not have yet — the "saving" end of your messages. */
export function useOutgoing(): readonly Outgoing[] {
  return useSyncExternalStore(
    (listener) => {
      outgoingListeners.add(listener);
      return () => outgoingListeners.delete(listener);
    },
    () => outgoing,
  );
}

/** Written down, then sent. A clip already held is not held twice: two pages of one origin both find it on start. */
async function hold(clip: StoredClip): Promise<void> {
  if (sending.has(clip.id)) return;
  sending.set(clip.id, { clip, error: null, tries: 0, busy: false, timer: null });
  told();
  await keepClip(clip);
  await ship(clip.id);
}

async function ship(id: string): Promise<void> {
  const item = sending.get(id);
  if (!item || item.busy) return;
  if (item.timer) clearTimeout(item.timer);
  item.timer = null;
  item.busy = true;
  try {
    await api.sendClip(item.clip);
    sending.delete(id);
    void dropClip(id);
    told();
  } catch (err) {
    item.tries++;
    item.error = err instanceof Error ? err.message : String(err);
    item.timer = setTimeout(() => void ship(id), RESEND_MS[Math.min(item.tries, RESEND_MS.length) - 1]!);
    told();
    if (mine === id) follow();
  } finally {
    item.busy = false;
  }
}

/** An id for a clip, minted here so a retry is the same message. `randomUUID` wants a secure context, which a phone over the tailnet's http is not. */
function clipId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// The last thing you said, as the pill tells it
// ---------------------------------------------------------------------------

/** This page's latest message, until the pill has said what became of it or is dismissed. */
let mine: string | null = null;
const mineListeners = new Set<() => void>();
/** What the pill last said about it, so a broadcast that changes nothing about it says nothing again. */
let mineSaid = "";
/** The outbox as the server last sent it. */
let lastOutbox: readonly OutboxEntry[] = [];

function setMine(id: string | null): void {
  mine = id;
  mineSaid = "";
  for (const listener of mineListeners) listener();
}

/** Which message is this page's latest, for the pill's line under Kuru's. */
export function useMine(): string | null {
  return useSyncExternalStore(
    (listener) => {
      mineListeners.add(listener);
      return () => mineListeners.delete(listener);
    },
    () => mine,
  );
}

/**
 * The outbox moved: if this page's latest message did, the pill says so. Not
 * over the microphone or over Kuru — the pill draws a line of its own for it
 * then, from the same list — and only on a change, so every broadcast is not
 * a fresh four seconds on screen. Getting through is said once; not getting
 * through stays up longer, and brings the pill back if it had gone.
 */
function follow(): void {
  if (!mine) return;
  const entry = lastOutbox.find((e) => e.id === mine);
  const unsent = sending.get(mine);
  const said = entry ? `${entry.state}:${entry.typedAt ?? ""}:${entry.note ?? ""}` : unsent ? `unsent:${unsent.error ?? ""}` : "";
  if (!said || said === mineSaid) return;
  mineSaid = said;
  if (ui.phase === "listening" || ui.phase === "speaking") return;
  if (!entry) {
    if (unsent?.error && ui.phase === "sending") {
      set({ phase: "sending", text: "", detail: "" });
    }
    return;
  }
  if (entry.state === "transcribing") {
    // Redrawn, since the pill's label reads the entry's note: "trying again".
    if (ui.phase === "sending") set({ phase: "sending", text: "", detail: "" });
    return;
  }
  if (entry.state === "failed") {
    set({ phase: "error", text: "Your message did not get through.", detail: entry.note ?? "It is kept in your messages, behind the harness button." });
    settle(FAILED_LINGER_MS);
    return;
  }
  // Queued or delivered: said once, as the words and where they went.
  if (ui.phase !== "sending" && ui.phase !== "heard") return;
  set({ phase: "heard", text: `“${entry.text ?? ""}”`, detail: whereItWent(entry) });
  settle();
}

/** Where a message is, in the pill's words. */
export function whereItWent(entry: OutboxEntry): string {
  if (entry.state === "delivered") return "Kuru has it.";
  if (entry.state === "failed") return entry.note ?? "Did not get through.";
  if (entry.state === "transcribing") return entry.note ?? "Hearing…";
  return entry.typedAt !== null ? "Sent to Kuru." : (entry.note ?? "Waiting for Kuru.");
}

/** Start following the outbox, and send whatever an earlier page left unsent. Called once, with `installSpeech`. */
function installOutbox(): () => void {
  const stopOutbox = api.onOutbox((outbox) => {
    lastOutbox = outbox;
    follow();
  });
  // Back from a dropped socket: whatever was waiting on a server goes now
  // rather than at the end of its backoff.
  const stopConnect = api.onConnect(() => {
    for (const id of sending.keys()) void ship(id);
  });
  void keptClips().then((clips) => {
    for (const clip of clips) void hold(clip);
  });
  return () => {
    stopOutbox();
    stopConnect();
  };
}

// ---------------------------------------------------------------------------
// The key, and the button that is the same key for a thumb
// ---------------------------------------------------------------------------

/** The talk key or the mic button went down. */
export function talkDown(): void {
  if (remote) {
    remote("down");
    return;
  }
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
  if (remote) {
    remote("up");
    return;
  }
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
  if (remote) {
    remote("escape");
    return;
  }
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
    if (remote) {
      // The hook has the key; what is left to this window is to keep the
      // key from typing, and to drop a clip the pill is taking.
      if (event.key === "Escape" && remotePhase === "listening") {
        event.preventDefault();
        event.stopImmediatePropagation();
        remote("escape");
        return;
      }
      if (event.code === codeOf()) event.preventDefault();
      return;
    }
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
    if (remote) return;
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
/** Utterances that were cut off: their later sentences may still be announced, and are dropped on arrival. */
const cancelled = new Set<string>();
/**
 * Utterances this page has told the server it holds and has not let go or
 * played out — so a reply is held once, and let go only by a page that had
 * it. A reply played to its last sentence leaves; one whose last sentence
 * never came stays until it is pushed out, and letting go of it then is a
 * word the server ignores, since it was heard.
 */
const held = new Set<string>();
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
    // Another page is the mouth. Never held here, so never let go here, and
    // the server counts it by what that page says.
    if (remote) return;
    if (cancelled.has(chunk.utterance)) return;
    if (!held.has(chunk.utterance)) {
      held.add(chunk.utterance);
      api.speechHeld(chunk.utterance, true);
      trim(held);
    }
    queue.push(chunk);
    void pump();
  });
  const stopHush = api.onHush((on) => {
    hush(() => {
      hushedByServer = on;
    });
  });
  const stopOutbox = installOutbox();
  return () => {
    stopSpeech();
    stopHush();
    stopOutbox();
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
  if (!out) {
    // Nothing to play anything on: everything held here is let go, so the
    // server can count it missed rather than wait on this page for good.
    cancel([chunk.utterance, ...queue.map((c) => c.utterance)]);
    queue.length = 0;
    return;
  }
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
  if (cancelled.has(chunk.utterance)) return pump();
  if (out.ctx.state !== "running") {
    // A phone nobody has touched since the page loaded: the browser will not
    // let it make a sound, and a source started now would wait there for
    // good, holding the reply and every one behind it. Let them go, so they
    // are missed rather than stuck; the next touch unlocks the next reply.
    cancel([chunk.utterance, ...queue.map((c) => c.utterance)]);
    queue.length = 0;
    return;
  }
  if (!buffer) {
    // A sentence that would not load is a hole in the reply, and a reply
    // with a hole was not heard: let it go whole, and it is on the list.
    cancel([chunk.utterance]);
    return pump();
  }
  if (!speechGain) {
    speechGain = out.ctx.createGain();
    speechGain.connect(out.ctx.destination);
  }
  const volume = Math.min(1, Math.max(0, volumeOf()));
  speechGain.gain.value = volume;
  const source = out.ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(speechGain);
  playing = source;
  set({ phase: "speaking", text: chunk.text, detail: "Kuru", level: 0, toggled: false });
  source.onended = () => {
    if (playing === source) playing = null;
    // Played at no volume is not heard. Saying nothing leaves it to the
    // server, which counts it missed once nobody else plays it.
    if (volume > 0) {
      api.speechPlayed(chunk.utterance, chunk.seq);
      if (chunk.last) held.delete(chunk.utterance);
    }
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

/**
 * Utterances never to be played here: the rest of their sentences are
 * dropped on arrival, and whatever of them is queued when its turn comes.
 * Each one this page held is let go, which is what puts it on the missed
 * list.
 */
function cancel(ids: Iterable<string>): void {
  for (const id of ids) {
    cancelled.add(id);
    if (held.delete(id)) api.speechHeld(id, false);
  }
  trim(cancelled);
}

/** A set that would grow one id per reply forever: nothing announced is older than the server keeps, so a few dozen is every id that can still arrive. */
function trim(ids: Set<string>): void {
  if (ids.size <= 64) return;
  for (const id of [...ids].slice(0, ids.size - 32)) ids.delete(id);
}

/**
 * The pill's ✕: stop whatever it is showing, now.
 *
 * While Kuru speaks that is `stopSpeaking` — the talk key's own cut-off,
 * without the microphone the key opens after it. What it stops is not lost:
 * the server puts it on the missed list. While the microphone is open
 * it is Escape, which a phone has no key for. Otherwise it is words lingering,
 * and the ✕ takes them down early — and still cuts Kuru off, because the pill
 * says "heard" in the gap between two sentences when the next is still being
 * made, and a ✕ pressed in that gap means the rest of the reply as surely as
 * one pressed a moment before it.
 */
export function dismissVoice(): void {
  if (remote) {
    remote("dismiss");
    return;
  }
  if (isListening()) {
    cancelTalk();
    return;
  }
  stopSpeaking();
  if (linger) {
    clearTimeout(linger);
    linger = null;
  }
  // What became of your last message has been seen, or is waiting on a
  // server that is not there and keeps trying without the pill; the list
  // keeps it either way.
  if (ui.phase === "heard" || ui.phase === "error" || ui.phase === "sending") {
    setMine(null);
    set({ ...IDLE });
  }
}
