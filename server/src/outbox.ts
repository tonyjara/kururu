/**
 * Your words on their way to Kuru, kept on the disk until Kuru has them.
 *
 * Why this exists, when `Harness.hear` already types words into the harness:
 * because everything between the talk key coming up and those words reaching
 * Kuru's session used to live in memory, in three places, and each of them
 * lost a message. The window held the clip until the upload answered, and a
 * clip over the server's size cap was refused by a reset connection — the
 * error showed for a frame before Kuru's queued reply took the pill over, and
 * the audio went with the page. The server held the clip for the half-second
 * of transcription, which a restart under `bun run dev` cuts in half. And the
 * harness holds words for a busy Kuru in a list that a restart forgets. A
 * message is now a file the moment it arrives, its words are written beside
 * it the moment they are made, and it leaves the list only when Kuru's own
 * session has said it took it.
 *
 * **In the order you said them.** A message is not handed to the harness
 * until every earlier one of its profile is past being heard: "do X" and then
 * "actually, don't" must not arrive the other way round because the first
 * was longer. A transcription that fails is tried a few more times
 * (`transcribeRetryMs`), briefly, because everything after it waits; then it
 * is `failed`, with its audio kept for Resend, and stops holding the rest up.
 *
 * **Delivered means Kuru said so, not that it was typed.** Typing is a write
 * into a pty, and a write can land in a dialog, go to a session that is
 * exiting, or lose its Enter. Kuru's session reports every prompt it takes on
 * its `UserPromptSubmit` hook, and writes it to its transcript, along with
 * anything it queued mid-turn; either carrying the words (`promptCarries`) is
 * delivery. One that Kuru has had its chance at — between turns for a while
 * since it was typed, or gone — and does not have is typed once more, and
 * after that is `failed`: twice in the prompt box is better than never, a
 * third time is a loop.
 *
 * **It is also what holds Kuru quiet** between the key coming up and the
 * words reaching it, the stretch the window used to cover by waiting on the
 * upload. Each new message is a talker to `Voice.talk` until its first
 * attempt at Kuru is over — handed over, or failed — so the window can let go
 * the moment the server has the file, and a restart in the middle cannot
 * leave the hush up: it dies with the server, and `TALK_MAX_MS` bounds it.
 *
 * On the restartable side, which is the point: what a restart interrupts is
 * picked up by the next server from the disk (`resume`).
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AgentStatus } from "../../shared/model";
import {
  CLIP_MIN_MS,
  adoptOutbox,
  capOutbox,
  clipMs,
  promptCarries,
  transcribeRetryMs,
  type OutboxEntry,
  type StoredOutboxEntry,
  type VoiceLang,
} from "../../shared/voice";
import type { ServerMessage } from "../../shared/wire";

/** How long Kuru may sit between turns with a typed message it never took before that message is typed again. Its prompt hook takes a moment; a turn starting is a status change. */
const CONFIRM_MS = 15_000;
/** How often the transcript is looked in while something typed is unconfirmed. */
const CHECK_MS = 2_000;
/** How much of a transcript's end is read for a message typed into it: the newest turns are at the end, and a long tool result is the most there is between. */
const TAIL_BYTES = 1024 * 1024;
/** A message the harness dropped — it exited holding it — goes back to it after this, which starts it again. */
const REHAND_MS = 5_000;
/** How far back of its typing a transcript record may be and still be the message: two clocks, one machine. */
const CLOCK_SLOP_MS = 5_000;
/** An audio file nothing on the list names, from a server that died between writing it and the list. The client retries within seconds; a day is for nobody. */
const ORPHAN_MS = 24 * 60 * 60_000;

/** The profile's harness, as the outbox needs it. */
export interface KuruNow {
  agentId: string;
  status: AgentStatus;
  /** Its session's transcript, as its hooks last reported it. */
  transcript: string | null;
}

/** What `index.ts` lends this module. */
export interface OutboxDeps {
  broadcast: (msg: ServerMessage) => void;
  /** The recogniser — `Voice.transcribe`: words and their language, null for a clip that held none, a rejection when it could not run. */
  transcribe: (path: string, ms: number) => Promise<{ text: string; lang: VoiceLang } | null>;
  /**
   * Words to a profile's harness, as the user's — `Harness.hear`, starting
   * it if need be. `typed` is called when they are written into its terminal
   * and `dropped` if the harness goes before they are.
   */
  deliver: (
    profileId: string,
    text: string,
    events: { typed: () => void; dropped: () => void },
  ) => Promise<{ outcome: "typed" | "held" | "starting" }>;
  /** The profile's harness, or null when none is running. */
  harness: (profileId: string) => KuruNow | null;
  /** Hold every client's speech while `who` is talking — `Voice.talk`. */
  talk: (who: object, on: boolean) => void;
}

/** Where the messages are kept: the state directory, beside `missed.json`. */
function outboxDir(): string {
  const state = process.env.KURURU_STATE_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "kururu");
  return join(state, "outbox");
}

export class Outbox {
  private entries: StoredOutboxEntry[];
  private seq: number;
  /** Not until the harness knows which terminal is Kuru's: handing words over before then would start a second one. */
  private ready = false;
  /** Handed to the harness in this server's life. The harness's own list of them is memory, and the next server hands them again. */
  private readonly handed = new Set<string>();
  /** Transcriptions running, so a retried upload or a Resend does not start a second. */
  private readonly hearing = new Set<string>();
  /** The talker each new message is to `Voice.talk` until its first attempt at Kuru is over. */
  private readonly hush = new Map<string, object>();
  /** Who is waiting for that moment: an old page's upload, answered then. See `firstPass`. */
  private readonly passing = new Map<string, (() => void)[]>();
  /** How many times a Kuru exited holding a message, by message: twice, and starting a third is a loop, not a delivery. */
  private readonly drops = new Map<string, number>();
  /** When Kuru was last seen busy while a message waited on it, by message. */
  private readonly busySince = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private checker: ReturnType<typeof setInterval> | null = null;
  private checking = false;

  constructor(private readonly deps: OutboxDeps) {
    let stored: unknown = null;
    try {
      stored = JSON.parse(readFileSync(this.indexPath(), "utf8"));
    } catch {
      // Nothing kept is nothing owed.
    }
    this.entries = adoptOutbox(stored);
    this.seq = this.entries.reduce((max, entry) => Math.max(max, entry.n), 0);
    this.sweep();
  }

  /** What every client is told, on connect and whenever it changes: every profile's, as the missed list is. */
  message(): ServerMessage {
    return { type: "outbox", outbox: this.entries.map(bare) };
  }

  /**
   * A clip, from `/api/voice/hear`: written to the disk, put on the list, and
   * answered with — before a word of it has been heard. A clip already here is
   * answered with what it has become, so a client that never saw the answer
   * and sends again does not say it twice. Null for one too short to hold a
   * word, which nothing is kept for.
   */
  take(profileId: string, id: string, at: number, wav: Buffer): OutboxEntry | null {
    const known = this.entries.find((entry) => entry.id === id);
    if (known) {
      // Listed, but the file went with a server that died between the two
      // writes the other way round from how they are made — here it is again.
      if (known.state === "transcribing" && !this.hasAudio(id)) {
        this.writeAudio(id, wav);
        this.hear(known);
      }
      return bare(known);
    }
    const ms = Math.round(clipMs(wav.length));
    if (ms < CLIP_MIN_MS) return null;
    // The audio first and the list second, so the list never names a file
    // that is not there; a file the list does not name is swept, later.
    this.writeAudio(id, wav);
    const entry: StoredOutboxEntry = {
      id,
      profileId,
      at,
      ms,
      state: "transcribing",
      text: null,
      lang: null,
      typedAt: null,
      note: null,
      n: ++this.seq,
      attempts: 0,
      typings: 0,
      transcript: null,
    };
    this.entries.push(entry);
    this.changed();
    const who = {};
    this.hush.set(id, who);
    this.deps.talk(who, true);
    this.hear(entry);
    return bare(entry);
  }

  /**
   * Once the harness has adopted its terminals: everything a restart cut
   * short is taken up again. Words that were waiting are handed over; audio
   * that was being heard is heard; anything typed is looked for in Kuru's
   * transcript before it is typed again.
   */
  resume(): void {
    this.ready = true;
    for (const entry of this.entries) if (entry.state === "transcribing") this.hear(entry);
    this.flow();
  }

  /**
   * The message once its first attempt at Kuru is over — handed over, failed,
   * or put off to a retry — for a page from before the outbox, which holds
   * its upload open for the words and reads the answer as they were sent
   * then (`legacyHeard`). Bounded, since an old page holds Kuru quiet for as
   * long as it waits.
   */
  firstPass(id: string, within = 90_000): Promise<OutboxEntry | null> {
    const now = () => {
      const entry = this.entries.find((e) => e.id === id);
      return entry ? bare(entry) : null;
    };
    if (!this.hush.has(id)) return Promise.resolve(now());
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve(now());
      };
      const timer = setTimeout(done, within);
      this.passing.set(id, [...(this.passing.get(id) ?? []), done]);
    });
  }

  /** Resend from the list: a failed message is heard again if it has no words yet, and handed to Kuru again if it has. */
  resend(id: string): void {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry || entry.state !== "failed") return;
    entry.attempts = 0;
    entry.typings = 0;
    entry.typedAt = null;
    entry.note = null;
    if (entry.text) {
      entry.state = "queued";
      this.changed();
      this.flow();
      return;
    }
    if (!this.hasAudio(id)) {
      entry.note = "The audio is gone from the disk, so there is nothing to hear again.";
      this.changed();
      return;
    }
    entry.state = "transcribing";
    this.changed();
    this.hear(entry);
  }

  /** Take a failed message off the list, and its audio off the disk. Only a failed one: the rest are on their way or done. */
  discard(id: string): void {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry || entry.state !== "failed") return;
    this.entries = this.entries.filter((e) => e !== entry);
    this.removeAudio(id);
    this.quiet(id);
    this.changed();
  }

  /** A prompt Kuru's session took, off its `UserPromptSubmit` report. Whatever typed message it carries is delivered. */
  prompted(profileId: string, prompt: string): void {
    for (const entry of this.entries) {
      if (entry.profileId === profileId && entry.state === "queued" && entry.typedAt !== null && entry.text && promptCarries(prompt, entry.text)) {
        this.delivered(entry);
      }
    }
  }

  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (this.checker) clearInterval(this.checker);
    this.checker = null;
  }

  // ---------------------------------------------------------------------------
  // The way through
  // ---------------------------------------------------------------------------

  private hear(entry: StoredOutboxEntry): void {
    if (this.hearing.has(entry.id)) return;
    this.hearing.add(entry.id);
    void (async () => {
      try {
        const heard = await this.deps.transcribe(this.audioPath(entry.id), entry.ms);
        if (entry.state !== "transcribing") return;
        if (!heard) {
          this.fail(entry, "Nothing heard in it. The audio is kept: Resend listens again.");
          return;
        }
        entry.text = heard.text;
        entry.lang = heard.lang;
        entry.state = "queued";
        entry.attempts = 0;
        entry.note = this.ready ? null : "Waiting for the server to find Kuru's terminal.";
        this.changed();
      } catch (err) {
        if (entry.state !== "transcribing") return;
        const why = err instanceof Error ? err.message : String(err);
        entry.attempts++;
        const wait = transcribeRetryMs(entry.attempts);
        if (wait === null) {
          this.fail(entry, `Could not be heard: ${why}. The audio is kept: Resend tries again.`);
          return;
        }
        entry.note = `Could not be heard (${why}); trying again.`;
        this.changed();
        // A retry is not worth keeping Kuru quiet for.
        this.quiet(entry.id);
        this.later(entry.id, wait, () => this.hear(entry));
      } finally {
        this.hearing.delete(entry.id);
        this.flow();
      }
    })();
  }

  /** Hand over whatever may go now, in order. */
  private flow(): void {
    if (!this.ready) return;
    for (const entry of handable(this.entries, this.handed)) void this.hand(entry);
    this.watch();
  }

  private async hand(entry: StoredOutboxEntry): Promise<void> {
    if (!entry.text) return;
    this.handed.add(entry.id);
    try {
      const { outcome } = await this.deps.deliver(entry.profileId, `[voice] ${entry.text}`, {
        typed: () => this.typed(entry),
        dropped: () => {
          // Kuru exited holding it: it goes back to the next one, once.
          this.handed.delete(entry.id);
          if (entry.state !== "queued" || entry.typedAt !== null) return;
          const drops = (this.drops.get(entry.id) ?? 0) + 1;
          this.drops.set(entry.id, drops);
          if (drops >= 2) this.fail(entry, "Kuru went twice before it could take this. Resend once it is running.");
          else this.later(entry.id, REHAND_MS, () => this.flow());
        },
      });
      if (entry.state === "queued" && entry.typedAt === null) {
        entry.note = outcome === "starting" ? "Kuru is starting; it hears this first." : "Kuru is busy or asking something; this is typed the moment it can be.";
        this.changed();
      }
    } catch (err) {
      this.handed.delete(entry.id);
      if (entry.state === "queued") this.fail(entry, `Could not reach Kuru: ${err instanceof Error ? err.message : String(err)}.`);
    } finally {
      this.quiet(entry.id);
    }
  }

  private typed(entry: StoredOutboxEntry): void {
    if (entry.state !== "queued") return;
    entry.typedAt = Date.now();
    entry.typings++;
    entry.transcript = this.deps.harness(entry.profileId)?.transcript ?? entry.transcript;
    entry.note = "Typed into Kuru's terminal; waiting for it to take it.";
    this.busySince.delete(entry.id);
    this.changed();
    this.watch();
  }

  private delivered(entry: StoredOutboxEntry): void {
    entry.state = "delivered";
    entry.note = null;
    this.handed.delete(entry.id);
    this.drops.delete(entry.id);
    this.busySince.delete(entry.id);
    this.removeAudio(entry.id);
    this.changed();
  }

  private fail(entry: StoredOutboxEntry, note: string): void {
    entry.state = "failed";
    entry.note = note;
    entry.typedAt = null;
    this.handed.delete(entry.id);
    this.drops.delete(entry.id);
    this.busySince.delete(entry.id);
    this.quiet(entry.id);
    this.changed();
    // It no longer holds up what came after it.
    this.flow();
  }

  /** The end of a message's first attempt at Kuru, and so of the hush it held. Once. */
  private quiet(id: string): void {
    const who = this.hush.get(id);
    if (!who) return;
    this.hush.delete(id);
    this.deps.talk(who, false);
    for (const done of this.passing.get(id) ?? []) done();
    this.passing.delete(id);
  }

  // ---------------------------------------------------------------------------
  // Did Kuru take it?
  // ---------------------------------------------------------------------------

  /** Look in the transcripts every little while, for as long as something typed is unconfirmed. */
  private watch(): void {
    const waiting = this.entries.some((e) => e.state === "queued" && e.typedAt !== null);
    if (waiting && !this.checker) this.checker = setInterval(() => void this.check(), CHECK_MS).unref();
    else if (!waiting && this.checker) {
      clearInterval(this.checker);
      this.checker = null;
    }
  }

  /**
   * Every typed message not yet confirmed: found in Kuru's transcript, it is
   * delivered. Not found, it waits while Kuru is busy — a message typed
   * mid-turn is taken at the next gap — and once Kuru has sat between turns
   * for `CONFIRM_MS` since it was typed, or is not running at all, it was not
   * taken, and is typed again once or failed.
   */
  private async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const typed = this.entries.filter((e) => e.state === "queued" && e.typedAt !== null);
      const byProfile = new Map<string, StoredOutboxEntry[]>();
      for (const entry of typed) byProfile.set(entry.profileId, [...(byProfile.get(entry.profileId) ?? []), entry]);
      const now = Date.now();
      for (const [profileId, waiting] of byProfile) {
        const kuru = this.deps.harness(profileId);
        const since = Math.min(...waiting.map((e) => e.typedAt!)) - CLOCK_SLOP_MS;
        const paths = new Set([kuru?.transcript, ...waiting.map((e) => e.transcript)].filter((p): p is string => Boolean(p)));
        const taken: string[] = [];
        for (const path of paths) taken.push(...(await takenFrom(path, since)));
        for (const entry of waiting) {
          if (entry.state !== "queued" || entry.typedAt === null || !entry.text) continue;
          const text = entry.text;
          if (taken.some((prompt) => promptCarries(prompt, text))) {
            this.delivered(entry);
            continue;
          }
          if (kuru && (kuru.status === "working" || kuru.status === "blocked")) {
            this.busySince.set(entry.id, now);
            continue;
          }
          const quietFor = now - Math.max(entry.typedAt, this.busySince.get(entry.id) ?? 0);
          if (kuru && quietFor < CONFIRM_MS) continue;
          if (entry.typings < 2) {
            entry.typedAt = null;
            entry.note = kuru ? "Typed, but Kuru never took it; typing it again." : "Kuru went before it took this; starting it again.";
            this.handed.delete(entry.id);
            this.changed();
          } else {
            this.fail(entry, "Typed twice, and Kuru never took it. Look at Kuru's prompt, or Resend.");
          }
        }
      }
      this.flow();
    } finally {
      this.checking = false;
    }
  }

  // ---------------------------------------------------------------------------
  // The disk
  // ---------------------------------------------------------------------------

  private changed(): void {
    this.entries = capOutbox(this.entries);
    const path = this.indexPath();
    try {
      mkdirSync(outboxDir(), { recursive: true });
      const temp = `${path}.tmp`;
      writeFileSync(temp, `${JSON.stringify(this.entries)}\n`, "utf8");
      renameSync(temp, path);
    } catch (err) {
      // The list in memory is still the list; the next change writes it again.
      console.error("kururu: the outbox could not be written", err);
    }
    this.deps.broadcast(this.message());
  }

  private later(id: string, ms: number, run: () => void): void {
    clearTimeout(this.timers.get(id));
    const timer = setTimeout(() => {
      this.timers.delete(id);
      run();
    }, ms);
    timer.unref();
    this.timers.set(id, timer);
  }

  private indexPath(): string {
    return join(outboxDir(), "outbox.json");
  }

  private audioPath(id: string): string {
    return join(outboxDir(), `${id}.wav`);
  }

  private hasAudio(id: string): boolean {
    try {
      return statSync(this.audioPath(id)).isFile();
    } catch {
      return false;
    }
  }

  /** Through a temporary file, so a file under its own name is always a whole clip. Throws: a clip that could not be kept must not be answered as kept. */
  private writeAudio(id: string, wav: Buffer): void {
    mkdirSync(outboxDir(), { recursive: true });
    const path = this.audioPath(id);
    writeFileSync(`${path}.tmp`, wav);
    renameSync(`${path}.tmp`, path);
  }

  private removeAudio(id: string): void {
    rmSync(this.audioPath(id), { force: true });
  }

  /** Audio nobody names any more, and only once it is old: one a client is about to send again is renamed over, not swept. */
  private sweep(): void {
    let names: string[];
    try {
      names = readdirSync(outboxDir());
    } catch {
      return;
    }
    const kept = new Set(this.entries.filter((e) => e.state !== "delivered").map((e) => `${e.id}.wav`));
    for (const name of names) {
      if (!name.endsWith(".wav") && !name.endsWith(".tmp")) continue;
      if (kept.has(name) || name === "outbox.json.tmp") continue;
      const path = join(outboxDir(), name);
      try {
        if (Date.now() - statSync(path).mtimeMs > ORPHAN_MS) rmSync(path, { force: true });
      } catch {
        // Gone already.
      }
    }
  }
}

/** A message as the wire carries it, without the server's bookkeeping. */
function bare(entry: OutboxEntry): OutboxEntry {
  return {
    id: entry.id,
    profileId: entry.profileId,
    at: entry.at,
    ms: entry.ms,
    state: entry.state,
    text: entry.text,
    lang: entry.lang,
    typedAt: entry.typedAt,
    note: entry.note,
  };
}

/** What `/api/voice/hear` answered before the outbox, which a page loaded before it still reads. */
export interface LegacyHeard {
  text: string;
  lang: VoiceLang | null;
  outcome: "typed" | "held" | "starting" | "nothing" | "failed";
  why: string | null;
}

/**
 * A message after its first pass, as a page from before the outbox reads an
 * answer. Pure. Without it such a page — the floating pill, which loads once
 * and keeps its build for as long as the app runs, or a phone left open —
 * quoted `undefined` where the words go and said Kuru was starting, since
 * every field it looked for was gone. It can go once no such page is open.
 */
export function legacyHeard(entry: OutboxEntry | null): LegacyHeard {
  if (!entry) return { text: "", lang: null, outcome: "nothing", why: null };
  const text = entry.text ?? "";
  if (entry.state === "failed" && !entry.text && entry.note?.startsWith("Nothing heard")) return { text, lang: null, outcome: "nothing", why: null };
  if (entry.state === "failed" || entry.state === "transcribing") {
    return { text, lang: entry.lang, outcome: "failed", why: entry.note ?? "Not heard yet; the audio is kept, in your messages." };
  }
  if (entry.state === "delivered" || entry.typedAt !== null) return { text, lang: entry.lang, outcome: "typed", why: null };
  return { text, lang: entry.lang, outcome: entry.note?.startsWith("Kuru is starting") ? "starting" : "held", why: null };
}

/**
 * Which messages may be handed to the harness now. Pure; see `Outbox.flow`.
 *
 * Each profile's, in the order they arrived, up to the first still being
 * heard: what comes after it waits, so Kuru gets them in the order they were
 * said. A failed one holds nothing up, and nor does one already typed —
 * it is in Kuru's terminal ahead of whatever is typed next.
 */
export function handable<T extends OutboxEntry & { n: number }>(entries: readonly T[], handed: ReadonlySet<string>): T[] {
  const blocked = new Set<string>();
  const out: T[] = [];
  for (const entry of [...entries].sort((a, b) => a.n - b.n)) {
    if (blocked.has(entry.profileId)) continue;
    if (entry.state === "transcribing") {
      blocked.add(entry.profileId);
      continue;
    }
    if (entry.state === "queued" && entry.typedAt === null && entry.text && !handed.has(entry.id)) out.push(entry);
  }
  return out;
}

/**
 * What a Claude Code session took in since a moment, from its transcript:
 * every prompt, and everything it queued to read mid-turn — typed into its
 * box while it worked, or posted to its inbox. Pure; see `Outbox.check`.
 */
export function takenSince(tail: string, since: number): string[] {
  const out: string[] = [];
  for (const line of tail.split("\n")) {
    if (!line.startsWith("{")) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const at = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
    if (!Number.isFinite(at) || at < since || rec.isSidechain) continue;
    if (rec.type === "queue-operation" && typeof rec.content === "string") {
      out.push(rec.content);
      continue;
    }
    if (rec.type !== "user") continue;
    const content = (rec.message as { content?: unknown } | undefined)?.content;
    if (typeof content === "string") out.push(content);
    else if (Array.isArray(content)) {
      for (const block of content as { type?: unknown; text?: unknown }[]) {
        if (block && block.type === "text" && typeof block.text === "string") out.push(block.text);
      }
    }
  }
  return out;
}

/** The end of a transcript, read for what it took since a moment. A transcript that cannot be read has taken nothing anybody can see. */
async function takenFrom(path: string, since: number): Promise<string[]> {
  try {
    const { size } = await stat(path);
    const start = Math.max(0, size - TAIL_BYTES);
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      return takenSince(buffer.toString("utf8"), since);
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
}
