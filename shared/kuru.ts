/**
 * The conversation with Kuru as one list, and the two counts the chip wears.
 *
 * The decision this module embodies is that there is one conversation and it
 * has one home. What you said to Kuru was on the outbox's list, what Kuru said
 * that you did not hear was on the missed list, what you typed into its
 * terminal was nowhere, and the rest was in a terminal's scrollback — three
 * lists and a pty for one exchange, each drawn in a different box on a
 * different corner of one button. The server already sees both halves of
 * every exchange: every prompt Kuru takes arrives on its prompt hook and every
 * reply on its Stop report, and both are kept as turns in the database. So the
 * drawer is a reading of what is already kept, merged with the two lists that
 * say what became of each half — the outbox for your messages' states, the
 * missed list for each reply's fate — and nothing new is captured for it.
 *
 * This file is the pure half: the shapes the wire carries and the merge that
 * makes them, so that "a delivered clip and the turn it became are one item"
 * and "a reply is unheard until it is played out or seen" are arithmetic a
 * test can hold. `server/src/kuru.ts` gathers the inputs and broadcasts;
 * `web/src/components/KuruDrawer.tsx` draws the result.
 */
import type { Turn } from "./store";
import { VOICE_PREFIX } from "./store";
import type { OutboxEntry, OutboxState } from "./voice";

/** How many items the broadcast carries per profile. The rest is a page away (`/api/kuru`). */
export const KURU_RECENT = 60;
/** How many items one request for earlier ones returns. */
export const KURU_PAGE = 60;
/** How long a reply has to be in view in the open drawer before it counts as seen. A glance is not reading; two seconds of it is. */
export const KURU_SEEN_MS = 2000;
/** The most a message typed in the drawer's composer may be: Claude Code's own paste limit is far above it, and nobody types more. */
export const KURU_SAY_MAX = 20_000;

/**
 * One of your messages, from either door: a clip the voice heard, a line the
 * drawer's composer sent through the same outbox, or a prompt typed straight
 * into Kuru's terminal, which arrives already delivered since the only record
 * of it is Kuru's own hook saying it took it.
 */
export interface YouItem {
  kind: "you";
  /** `t<id>` for a turn Kuru took; the outbox message's own id while it is still on its way. */
  id: string;
  at: number;
  /** The words, without the voice's prefix; null while a clip is still being heard. */
  text: string | null;
  via: "voice" | "typed";
  /** The clip's length; zero for anything typed. */
  ms: number;
  state: OutboxState;
  typedAt: number | null;
  /** Why it failed, or what it is waiting on — the outbox's note. */
  note: string | null;
  /** The outbox message behind it, for Resend and Discard. Null for a prompt typed straight into the terminal. */
  outboxId: string | null;
}

/**
 * What became of a reply, as the drawer needs it: `speaking` while any client
 * has it queued or playing, `unheard` once nobody does and nobody played it
 * out, `heard` otherwise. Null for a reply that was never spoken — replies
 * switched off in Settings — which has no fate to show.
 */
export type ReplyFate = "heard" | "unheard" | "speaking";

export interface KuruReply {
  kind: "kuru";
  /** `t<id>` for a recorded turn; `m<utterance>` for a reply only the missed list remembers. */
  id: string;
  at: number;
  text: string;
  /** The utterance it was said as, for Play and Stop; null when it was not spoken. */
  utterance: string | null;
  fate: ReplyFate | null;
  /** A line said mid-turn through the `say` tool rather than a turn's reply. Drawn smaller. */
  aside: boolean;
}

/** A new conversation began here: a fresh session, after the old one was thrown away or could not be resumed. */
export interface SessionMark {
  kind: "session";
  id: string;
  at: number;
  launcher: string | null;
}

export type KuruItem = YouItem | KuruReply | SessionMark;

/** One profile's conversation as the wire carries it. */
export interface KuruConversation {
  profileId: string;
  /** The newest `KURU_RECENT`, oldest first. */
  items: KuruItem[];
  /** Replies nobody played to the end or saw in the drawer. The chip's accent count. */
  unheard: number;
  /** Messages of yours that did not get through. The chip's red count. */
  undelivered: number;
  /** Whether there is anything before `items[0]` to fetch. */
  more: boolean;
}

/** One page of earlier items, from `/api/kuru`. */
export interface KuruPage {
  items: KuruItem[];
  more: boolean;
}

/** A missed reply as the merge needs it: which utterance, when, and whether it is still in flight. */
export interface MissedLike {
  id: string;
  text: string;
  at: number;
  pending: boolean;
}

/** An outbox message as the merge needs it — the wire's fields, whichever side of the wire they come from. */
export type OutboxLike = Pick<OutboxEntry, "id" | "at" | "ms" | "state" | "text" | "typedAt" | "note">;

/**
 * Whether a message of yours was spoken rather than typed. A clip shorter
 * than `CLIP_MIN_MS` is refused before it is a message, so one with no length
 * at all can only have come from the composer — which is what lets the two
 * share one list and one table without a column saying which is which.
 */
export function spokenMessage(entry: Pick<OutboxLike, "ms">): boolean {
  return entry.ms > 0;
}

/** The words of a turn as a person said them: the voice's prefix is the recogniser's, not theirs. */
export function plainWords(text: string): string {
  return text.startsWith(VOICE_PREFIX) ? text.slice(VOICE_PREFIX.length).trim() : text;
}

/**
 * Turns, your messages and the missed list, as one timeline.
 *
 * A turn Kuru took that the outbox delivered is one item, not two: the turn
 * carries the state, the clip's length and the outbox id, so Resend is never
 * offered for something that arrived. The link is the turn's `voiceId`,
 * written when the turn was recorded (`Store.recordTurn`). A message still on
 * its way — being heard, queued, typed and unconfirmed, failed — has no turn
 * yet and stands on its own; a delivered one the link missed stands on its
 * own too, which is a duplicate line and not a lost message.
 *
 * A reply's fate is the missed list's word: on it and pending, it is being
 * said; on it and not, nobody heard it out; off it, with an utterance, it was
 * heard or seen. A reply the list remembers that no turn does — the record
 * was deduplicated, or the server died between the two writes — is drawn from
 * the list, so Play is never offered for words the drawer does not show.
 *
 * Oldest first, and a message of yours before a reply at the same instant,
 * since that is the order they happened in.
 */
export function mergeConversation(args: {
  turns: readonly Turn[];
  outbox: readonly OutboxLike[];
  missed: readonly MissedLike[];
  /** The launcher each conversation was started on, for the mark where one begins. */
  launchers?: ReadonlyMap<string, string | null>;
}): KuruItem[] {
  const byId = new Map(args.outbox.map((entry) => [entry.id, entry] as const));
  const missed = new Map(args.missed.map((entry) => [entry.id, entry] as const));
  const linked = new Set<string>();
  const spoken = new Set<string>();
  const items: KuruItem[] = [];
  let conversation: string | null = null;
  for (const turn of args.turns) {
    if (turn.role === "agent") continue;
    if (conversation !== null && turn.conversationId !== conversation) {
      items.push({ kind: "session", id: `s${turn.conversationId}`, at: turn.at, launcher: args.launchers?.get(turn.conversationId) ?? null });
    }
    conversation = turn.conversationId;
    if (turn.role === "you") {
      const entry = turn.voiceId ? byId.get(turn.voiceId) : undefined;
      if (entry) linked.add(entry.id);
      items.push({
        kind: "you",
        id: `t${turn.id}`,
        at: turn.at,
        text: plainWords(turn.text),
        via: turn.via === "voice" || (entry !== undefined && spokenMessage(entry)) ? "voice" : "typed",
        ms: entry?.ms ?? 0,
        // A turn is Kuru's own word that it took the message, whatever the
        // outbox has got round to writing.
        state: "delivered",
        typedAt: entry?.typedAt ?? null,
        note: null,
        outboxId: entry?.id ?? null,
      });
      continue;
    }
    const utterance = turn.voiceId;
    if (utterance) spoken.add(utterance);
    items.push({
      kind: "kuru",
      id: `t${turn.id}`,
      at: turn.at,
      text: turn.text,
      utterance,
      fate: utterance ? fateOf(missed.get(utterance)) : null,
      aside: turn.via === "kururu",
    });
  }
  for (const entry of args.outbox) {
    if (linked.has(entry.id)) continue;
    items.push({
      kind: "you",
      id: entry.id,
      at: entry.at,
      text: entry.text,
      via: spokenMessage(entry) ? "voice" : "typed",
      ms: entry.ms,
      state: entry.state,
      typedAt: entry.typedAt,
      note: entry.note,
      outboxId: entry.id,
    });
  }
  for (const entry of args.missed) {
    if (spoken.has(entry.id)) continue;
    items.push({ kind: "kuru", id: `m${entry.id}`, at: entry.at, text: entry.text, utterance: entry.id, fate: fateOf(entry), aside: false });
  }
  return items.sort((a, b) => a.at - b.at || rank(a) - rank(b));
}

function fateOf(entry: MissedLike | undefined): ReplyFate {
  if (!entry) return "heard";
  return entry.pending ? "speaking" : "unheard";
}

function rank(item: KuruItem): number {
  return item.kind === "session" ? 0 : item.kind === "you" ? 1 : 2;
}

/** The chip's two numbers, from the same lists the merge reads. */
export function kuruCounts(outbox: readonly Pick<OutboxLike, "state">[], missed: readonly Pick<MissedLike, "pending">[]): { unheard: number; undelivered: number } {
  return {
    unheard: missed.filter((entry) => !entry.pending).length,
    undelivered: outbox.filter((entry) => entry.state === "failed").length,
  };
}

/** How long a clip ran, as a clock: 0:07, 4:32. */
export function clipLength(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Card codes in a reply
// ---------------------------------------------------------------------------

/**
 * Where a reply names a card — `KUR-67`, `ACM-3` — so the drawer can make
 * each one a door onto the board. The shape is `cardCode`'s: up to three
 * letters or digits, a dash, a number. Which of them *are* cards is the
 * caller's to decide against the profile's boards; this only finds the
 * candidates, and a dash inside a longer word (`re-run`, `UTF-8`) is not one.
 */
const CARD_CODE = /(?<![\p{L}\p{N}_-])([\p{Lu}\p{N}]{1,3}-\d{1,6})(?![\p{L}\p{N}_-])/gu;

export type TextPart = { text: string } | { code: string };

/** A reply split into words and the card codes among them, in order. */
export function splitCardCodes(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(CARD_CODE)) {
    const at = match.index ?? 0;
    if (at > last) parts.push({ text: text.slice(last, at) });
    parts.push({ code: match[1]! });
    last = at + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
