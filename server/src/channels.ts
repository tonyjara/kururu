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
import { channelOfMessage, echoLine, isChannelKind, postedToChat, readPeerMark, spokenHere, type ChannelKind, type ChannelsStatus, type TurnOrigin } from "../../shared/channels";
import { plainWords, promptPeer, readPrompt, youVia } from "../../shared/kuru";
import { readableReply, splitReply } from "../../shared/reply";
import { viaOf, type TurnVia } from "../../shared/store";
import type { OutboxEntry } from "../../shared/voice";
import type { ServerMessage } from "../../shared/wire";
import { TelegramChannel, type TelegramDeps } from "./telegram";

/** How long a burst of status changes settles before one broadcast says all of it — `kuru.ts`'s figure, for its reason. */
const COALESCE_MS = 25;

/**
 * One turn of Kuru's, as far as who it answers: the doors its words came in
 * by, the other nodes' marks among them (`user@mac`, `kuru@mac`), and the
 * outbox messages it took, by id — which is how an `ask_kuru` on another
 * node knows this reply is its answer.
 */
interface TurnWords {
  vias: Set<TurnVia>;
  peers: Set<string>;
  ids: Set<string>;
}

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
  private readonly turns = new Map<string, TurnWords>();
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

  private turn(profileKey: string): TurnWords {
    let turn = this.turns.get(profileKey);
    if (!turn) this.turns.set(profileKey, (turn = { vias: new Set(), peers: new Set(), ids: new Set() }));
    return turn;
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
    // Another node's words, the user's there or its Kuru's, are that node's
    // to answer and to echo: noted for the turn, and nothing to the chat.
    const peer = promptPeer(prompt);
    if (peer) {
      this.turn(profileKey).peers.add(`${peer.who}@${peer.node}`);
      return;
    }
    // A background task's report is not yours either, and the drawer's
    // reading of a prompt is the one that decides, so a line it draws as a
    // notice is never echoed here as something you typed.
    const read = readPrompt(prompt);
    if (read?.kind !== "you") return;
    const text = read.text;
    const via = viaOf(text);
    this.turn(profileKey).vias.add(via);
    if (via === "voice" || via === "typed") this.telegram.post(profileKey, echoLine(via, readableReply(plainWords(text))), { silent: true });
  }

  /** One of your messages reached Kuru — perhaps mid-turn, where no prompt hook fires — so the turn answers it too. */
  delivered(profileKey: string, entry: Pick<OutboxEntry, "id" | "ms" | "text">): void {
    const turn = this.turn(profileKey);
    turn.ids.add(entry.id);
    const peer = entry.text ? readPeerMark(entry.text) : null;
    if (peer) turn.peers.add(`${peer.who}@${peer.node}`);
    else turn.vias.add(youVia(null, entry));
  }

  /** Where this turn's words came from so far. */
  private origin(profileKey: string): TurnOrigin {
    const turn = this.turns.get(profileKey);
    const vias = [...(turn?.vias ?? [])];
    return {
      here: vias.some((via) => via === "voice" || via === "typed"),
      channels: vias.filter((via): via is ChannelKind => isChannelKind(via)),
      peers: [...(turn?.peers ?? [])],
    };
  }

  /**
   * Whether the turn Kuru is in answers a channel's message: the user is on
   * their phone, where a link on the Mac's sidebar is no use and a picture
   * `show_file` names goes to the chat too.
   */
  answers(profileKey: string, kind: ChannelKind): boolean {
    return this.origin(profileKey).channels.includes(kind);
  }

  /** Whether what Kuru says now, at the end of this turn or mid-way through it, is said aloud on the Mac. See `spokenHere`. */
  speaks(profileKey: string): boolean {
    return spokenHere(this.origin(profileKey), this.telegram.speakReplies);
  }

  /**
   * Kuru's turn ended with this reply, off its Stop report: every channel
   * that carries the profile gets it, whatever the turn was answering —
   * a `[kururu]` notice included, which is most of what Kuru says unasked —
   * but an answer to another node's Kuru alone (`postedToChat`). On a node
   * that does not poll a shared channel, "gets it" is handed to the node
   * that does (`telegram.ts`). What the turn answered comes back, for the
   * other nodes, which hear the reply too (`peerkuru.ts`).
   */
  replied(profileKey: string, reply: unknown): { origin: TurnOrigin; answers: string[] } {
    const origin = this.origin(profileKey);
    const answers = [...(this.turns.get(profileKey)?.ids ?? [])];
    this.turns.delete(profileKey);
    this.telegram.stopTyping(profileKey);
    if (typeof reply === "string" && reply.trim() && postedToChat(origin)) this.telegram.post(profileKey, reply.trim());
    return { origin, answers };
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
      const said = entry.text ? (splitReply(entry.text)?.text ?? entry.text) : null;
      const words = said ? `"${said.length > 80 ? `${said.slice(0, 80)}…` : said}"` : "Your message";
      this.telegram.warn(profileKey, `⚠️ ${words} did not reach Kuru. ${entry.note ?? ""} Send it again here, or press Resend in the Kuru drawer.`.replace(/\s+/g, " "));
    }
    for (const id of this.seen.keys()) if (!entries.some((entry) => entry.id === id)) this.seen.delete(id);
    this.seeded = true;
  }
}
