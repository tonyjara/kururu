/**
 * Channels, as the rest of the server sees them: one object that is told
 * what Kuru took in and what it said, and decides what each channel hears.
 *
 * Why a module between `index.ts` and `telegram.ts`, when there is one
 * channel: because what a channel needs from a turn is not what the turn
 * is. The report handler sees a prompt arrive and a reply leave; a channel
 * needs to know *which* replies are answers to it, so that the voice can be
 * told to keep quiet for a reply that is already in somebody's hand
 * (`replySpoken`), and which prompts were yours from somewhere else, so the
 * chat can carry them as a quiet line. That is a little bookkeeping per
 * profile — where this turn's words came from — and it is the same for
 * every kind of channel, so it lives here once and a second channel is a
 * second field beside `telegram`, not a second copy of it.
 *
 * Nothing in here generates a word and nothing reads a disk: the outbox
 * carries messages in, the harness's Stop report carries replies out, and
 * this only routes. On the restartable side, like both of them.
 */
import { channelOfMessage, echoLine, replySpoken, type ChannelsStatus } from "../../shared/channels";
import { plainWords, readPrompt, youVia } from "../../shared/kuru";
import { viaOf, type TurnVia } from "../../shared/store";
import type { OutboxEntry } from "../../shared/voice";
import type { ServerMessage } from "../../shared/wire";
import { TelegramChannel, type TelegramDeps } from "./telegram";

/** How long a burst of status changes settles before one broadcast says all of it — `kuru.ts`'s figure, for its reason. */
const COALESCE_MS = 25;

export interface ChannelsDeps extends Omit<TelegramDeps, "changed"> {
  broadcast: (msg: ServerMessage) => void;
}

export class Channels {
  readonly telegram: TelegramChannel;
  /**
   * Where the words of each profile's current turn came from, since its last
   * reply: filled as Kuru takes prompts and as the outbox confirms messages
   * it read mid-turn, emptied when the turn's reply arrives. Memory, because
   * a turn is seconds to minutes long and a restart in the middle of one
   * costs, at worst, one reply spoken that need not have been.
   */
  private readonly turns = new Map<string, Set<TurnVia>>();
  /** What each outbox message was last seen as, so a failure is told once, as it happens, and not again on every restart that finds it still failed. */
  private readonly seen = new Map<string, OutboxEntry["state"]>();
  private seeded = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: ChannelsDeps) {
    this.telegram = new TelegramChannel({ ...deps, changed: () => this.changed() });
  }

  start(): void {
    this.telegram.start();
  }

  close(): void {
    this.telegram.close();
    if (this.timer) clearTimeout(this.timer);
  }

  status(): ChannelsStatus {
    return { telegram: this.telegram.status() };
  }

  /** What every client is told, on connect and after every change. */
  message(): ServerMessage {
    return { type: "channels", channels: this.status() };
  }

  private changed(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.deps.broadcast(this.message());
    }, COALESCE_MS);
    this.timer.unref();
  }

  private turn(profileKey: string): Set<TurnVia> {
    let set = this.turns.get(profileKey);
    if (!set) this.turns.set(profileKey, (set = new Set()));
    return set;
  }

  /**
   * A prompt Kuru's session took, off its `UserPromptSubmit` report. Noted
   * for the turn, and — when it was yours from here, spoken or typed — sent
   * to the channel as a quiet line, so the reply that follows has its
   * question in front of it.
   *
   * A `[kururu]` notice arrives here too, wrapped as a cross-session message,
   * and is neither: it is kururu talking to Kuru, so a turn that is only a
   * notice answers nobody in particular and is spoken as it always was; and
   * it quotes an agent's last reply, which can quote a file with a secret in
   * it — the reason the backup leaves agents' replies out — so it stays on
   * the machine. Kuru's answer to it is Kuru's own words, and goes.
   */
  prompted(profileKey: string, prompt: string): void {
    // A background task's report is not yours either, and the drawer's
    // reading of a prompt is the one that decides, so a line it draws as a
    // notice is never echoed here as something you typed.
    const read = readPrompt(prompt);
    if (read?.kind !== "you") return;
    const text = read.text;
    const via = viaOf(text);
    this.turn(profileKey).add(via);
    if (via === "voice" || via === "typed") this.telegram.post(profileKey, echoLine(via, plainWords(text)), { silent: true });
  }

  /** One of your messages reached Kuru — perhaps mid-turn, where no prompt hook fires — so the turn answers it too. */
  delivered(profileKey: string, entry: Pick<OutboxEntry, "id" | "ms">): void {
    this.turn(profileKey).add(youVia(null, entry));
  }

  /** Whether what Kuru says now, at the end of this turn or mid-way through it, is said aloud on the Mac. See `replySpoken`. */
  speaks(profileKey: string): boolean {
    return replySpoken(this.turns.get(profileKey) ?? new Set(), this.telegram.speakReplies);
  }

  /**
   * Kuru's turn ended with this reply, off its Stop report: every channel
   * that carries the profile gets it, whatever the turn was answering —
   * a `[kururu]` notice included, which is most of what Kuru says unasked.
   */
  replied(profileKey: string, reply: unknown): void {
    this.turns.delete(profileKey);
    this.telegram.stopTyping(profileKey);
    if (typeof reply === "string" && reply.trim()) this.telegram.post(profileKey, reply.trim());
  }

  /** A line Kuru said mid-turn through its `say` tool: in the drawer, so in the chat. */
  aside(profileKey: string, text: string): void {
    this.telegram.post(profileKey, text);
  }

  /**
   * The outbox moved. A message from a channel that has just failed is said
   * so in the channel — otherwise the phone shows it sent and nothing ever
   * comes back. Only the change is told: the first look after a start
   * learns what is already failed and says nothing about it.
   */
  outboxMoved(entries: readonly OutboxEntry[], profileKeyOf: (profileId: string) => string | null): void {
    for (const entry of entries) {
      const before = this.seen.get(entry.id);
      this.seen.set(entry.id, entry.state);
      if (!this.seeded || entry.state !== "failed" || before === "failed" || !channelOfMessage(entry.id)) continue;
      const profileKey = profileKeyOf(entry.profileId);
      if (!profileKey) continue;
      const words = entry.text ? `"${entry.text.length > 80 ? `${entry.text.slice(0, 80)}…` : entry.text}"` : "Your message";
      this.telegram.warn(profileKey, `⚠️ ${words} did not reach Kuru. ${entry.note ?? ""} Send it again here, or press Resend in the Kuru drawer.`.replace(/\s+/g, " "));
    }
    for (const id of this.seen.keys()) if (!entries.some((entry) => entry.id === id)) this.seen.delete(id);
    this.seeded = true;
  }
}
