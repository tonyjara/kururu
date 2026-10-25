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
import { channelOfMessage, isChannelKind, readPeerMark, withoutChannelMark, type ChannelKind } from "./channels";
import { CROSS_SESSION_TAG, NOTICE_SENDER } from "./harness";
import type { MadeFile } from "./made";
import { parseRemote } from "./remote";
import { REPLY_ME, REPLY_QUOTE_MAX, cutQuoted, replyClock, splitReply, type ReplyRef } from "./reply";
import type { Turn } from "./store";
import { VOICE_PREFIX, stripPastedContent, viaOf } from "./store";
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
 * One of your messages, from any door: a clip the voice heard, a line the
 * drawer's composer sent through the same outbox, a message from a channel
 * such as Telegram through that outbox too, or a prompt typed straight into
 * Kuru's terminal, which arrives already delivered since the only record of
 * it is Kuru's own hook saying it took it.
 */
export interface YouItem {
  kind: "you";
  /** `t<id>` for a turn Kuru took; the outbox message's own id while it is still on its way. */
  id: string;
  at: number;
  /** The words, without the voice's prefix; null while a clip is still being heard. */
  text: string | null;
  /** Spoken, typed here, or written in a channel — the drawer marks each, and so does what Kuru is typed. */
  via: "voice" | "typed" | ChannelKind;
  /** The clip's length; zero for anything typed. */
  ms: number;
  state: OutboxState;
  typedAt: number | null;
  /** Why it failed, or what it is waiting on — the outbox's note. */
  note: string | null;
  /** The outbox message behind it, for Resend and Discard. Null for a prompt typed straight into the terminal. */
  outboxId: string | null;
  /** The node it was written or spoken at, when that was another kururu's drawer: `[user@mac]`. */
  through?: string;
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
  /**
   * The paths in `text` that are files kururu can open, each by the words it
   * was written as — `splitMentions` finds the same words in the drawer and
   * draws them as links. Found by the server (`server/src/kuru.ts`), since
   * only it can look at the disk; absent when the reply names none.
   */
  files?: KuruFile[];
}

/** A path in one of Kuru's replies, found on disk. */
export interface KuruFile extends MadeFile {
  /** The words as the reply wrote them: `Mention.text`. */
  text: string;
}

/**
 * Something Kuru was told that was neither you nor Kuru: kururu's own notice
 * that an agent finished its turn or blocked, a background task of Kuru's
 * reporting back, another session's message.
 *
 * Its own kind because every one of them arrives in Kuru's session as a user
 * turn — the prompt hook cannot tell them from yours — and drawn as yours
 * they were most of "your" messages: two lines in three on a busy afternoon,
 * each a bubble in your colour holding kururu's words, and the colours that
 * were meant to say who spoke said nothing. So the drawer gives them a quiet
 * line of their own, and the whole text behind a tap.
 */
export interface NoticeItem {
  kind: "notice";
  /** `t<id>`, the turn it arrived as. */
  id: string;
  at: number;
  /** Who it is from, as the line names it: `kururu`, `Kuru's task`, or the name another session signed with. */
  from: string;
  /** The agent it is about, when it names one — the part of the line cut short when the drawer is narrow. */
  agent: NoticeAgent | null;
  /** What happened, in a few words: `finished its turn`, `is blocked`, `exited`, or the message's first clause. */
  what: string;
  /** Which of kururu's edges it reports, for the ink; null for anything else. */
  event: "done" | "blocked" | "exited" | null;
  /** The whole message out of its wrapper, for a tap to show. */
  text: string;
}

/** An agent as a notice names it — `agentName`'s parts, read back. */
export interface NoticeAgent {
  /** The words in its quotes: a rename, its card's title, what it said it was doing. Null for one known only by its program. */
  name: string | null;
  program: string;
  workspace: string | null;
  /** The code of the card it runs, such as TRK-45. */
  card: string | null;
}

/** A new conversation began here: a fresh session, after the old one was thrown away or could not be resumed. */
export interface SessionMark {
  kind: "session";
  id: string;
  at: number;
  launcher: string | null;
}

export type KuruItem = YouItem | KuruReply | NoticeItem | SessionMark;

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

/**
 * The words of a turn as a person said them: the voice's prefix is the
 * recogniser's, not theirs, and a channel's or another node's mark is
 * kururu's.
 */
export function plainWords(text: string): string {
  const words = readPeerMark(text)?.rest ?? text;
  return words.startsWith(VOICE_PREFIX) ? words.slice(VOICE_PREFIX.length).trim() : withoutChannelMark(words);
}

/**
 * Where a message of yours came from, from what the outbox and the turn
 * each know: a turn knows by the mark its words carried, the outbox by the
 * message's length (a clip) or its id (a channel's). Either is enough, since
 * a turn the outbox did not deliver has only the first and a message still
 * on its way has only the second.
 */
export function youVia(turnVia: Turn["via"] | null, entry: Pick<OutboxLike, "id" | "ms"> | undefined): YouItem["via"] {
  if (turnVia === "voice" || (entry !== undefined && spokenMessage(entry))) return "voice";
  if (turnVia !== null && isChannelKind(turnVia)) return turnVia;
  return (entry && channelOfMessage(entry.id)) ?? "typed";
}

// ---------------------------------------------------------------------------
// What a prompt Kuru took was
// ---------------------------------------------------------------------------

/** What a notice is, without where it sits in the list. */
export type Notice = Omit<NoticeItem, "kind" | "id" | "at">;

/**
 * A prompt as Kuru's hook reported it: your words, out of whatever wrapper
 * they came in, or a notice that was never yours, or nothing at all.
 */
export type PromptReading = { kind: "you"; text: string } | { kind: "notice"; notice: Notice } | null;

/**
 * Wrappers Claude Code puts around something in a user turn that is for the
 * model and not for a person: a reminder it attaches, and the record it keeps
 * of a command run in its own prompt. Dropped whole, words and all.
 */
const DROPPED = /<(system-reminder|local-command-caveat|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/g;

/** A slash command typed into Kuru's terminal, as the turn records it. */
const COMMAND = /^<command-name>([^<]*)<\/command-name>\s*(?:<command-message>[^<]*<\/command-message>\s*)?(?:<command-args>([\s\S]*?)<\/command-args>)?/;

/**
 * A paste wrapper that never closed. `stripPastedContent` takes the whole
 * envelope off when it is whole, and has since the turns were first written
 * down; a few from before it are only half an envelope — the opening tag and
 * the words, the end cut off — and are still in the database.
 */
const PASTED_OPEN = /^<pasted_content id="[^"]*">\s*/;
const PASTED_CLOSE = /\s*<\/pasted_content(?: id="[^"]*")?>$/;

/**
 * kururu's notices and other sessions' messages, as Claude Code hands them
 * over: the envelope `envelope` writes (`shared/harness.ts`), and — in the
 * transcript, though not on the prompt hook today — a line before it and a
 * paragraph of advice after it. Whatever is outside the envelope is Claude
 * Code's and goes; an envelope that never closed runs to the advice.
 */
const ENVELOPE = new RegExp(`<${CROSS_SESSION_TAG}((?:\\s+[\\w-]+="[^"]*")*)\\s*>\\n?([\\s\\S]*?)(?:\\n?</${CROSS_SESSION_TAG}>|$)`, "i");
const PEER_ADVICE = /\s*\n\s*This came from another Claude session\b[\s\S]*$/;

/** What kururu's notices start with — `Harness.tell` writes them — wrapped or, from an older kururu, typed bare. */
const KURURU_MARK = "[kururu]";

/** A Claude Code background task reporting back, which arrives as a user turn of its own. */
const TASK = /^<task-notification>[\s\S]*<\/task-notification>$/;

/** A prompt without the wrappers that are never anybody's words: a paste envelope, a reminder, a command's record. */
function unwrapPrompt(prompt: string): string {
  return stripPastedContent(prompt.trim()).replace(PASTED_OPEN, "").replace(PASTED_CLOSE, "").replace(DROPPED, "").trim();
}

/** The other node a prompt came from, by its mark, and who there: `[user@mac]`, `[kuru@mac]`. Null for one from here. */
export function promptPeer(prompt: string): { node: string; who: "user" | "kuru" } | null {
  const peer = readPeerMark(unwrapPrompt(prompt));
  return peer ? { node: peer.node, who: peer.who } : null;
}

/**
 * Read a prompt for who it is from.
 *
 * Done on the way out of the database and not on the way in, because the
 * hundreds of notices already written down are as much of the problem as the
 * next one, and a rule that lives in one pure function can be changed without
 * a migration. Every reading starts by taking off the wrappers that are never
 * anybody's words — a paste envelope, a reminder, a command's record — and
 * then looks at what is left: an envelope or a `[kururu]` line is a notice, a
 * background task's report is a notice, and anything else is yours, with its
 * voice prefix or channel mark still on so the caller can say which door it
 * came through. Nothing left at all is a prompt that was only a wrapper, and
 * is nobody's line.
 */
export function readPrompt(prompt: string): PromptReading {
  let text = unwrapPrompt(prompt);
  const envelope = ENVELOPE.exec(text);
  if (envelope) {
    const from = /\bfrom-name="([^"]*)"/.exec(envelope[1] ?? "")?.[1] ?? null;
    const body = (envelope[2] ?? "").replace(PEER_ADVICE, "").trim();
    if (body.startsWith(KURURU_MARK) || from === NOTICE_SENDER) return { kind: "notice", notice: kururuNotice(body) };
    return { kind: "notice", notice: { from: from || "another session", agent: null, what: firstClause(body), event: null, text: body } };
  }
  if (text.startsWith(KURURU_MARK)) return { kind: "notice", notice: kururuNotice(text) };
  if (TASK.test(text)) return { kind: "notice", notice: taskNotice(text) };
  // Another node's Kuru asking, through `ask_kuru`: a colleague's words, not
  // yours, so a line of their own as a notice is, with all of it a tap away.
  const peer = readPeerMark(text);
  if (peer?.who === "kuru") return { kind: "notice", notice: { from: `Kuru on ${peer.node}`, agent: null, what: firstClause(peer.rest), event: null, text: peer.rest.trim() } };
  const command = COMMAND.exec(text);
  if (command) text = `${command[1]!.trim()} ${command[2]?.trim() ?? ""}`.trim();
  return text ? { kind: "you", text } : null;
}

/**
 * One of kururu's notices, read back into its parts: `[kururu]`, the agent
 * as `agentName` writes it — `"name" (program in workspace, card CODE; id
 * a26)`, or `program in workspace (id a26)` for one with no name — and then
 * what happened, which `Harness.tell` starts with one of three phrases. Read
 * off the first line only, since what follows is the agent's own reply and
 * can say anything. A notice in a shape this does not know still makes a
 * line: its first clause, with no agent.
 */
function kururuNotice(body: string): Notice {
  const text = body.startsWith(KURURU_MARK) ? body.slice(KURURU_MARK.length).trim() : body;
  const line = text.split("\n", 1)[0] ?? "";
  // The name is greedy so a title with `" (` in it stays whole: the match
  // that leaves the shortest `(…; id …)` is the agent's own brackets.
  const named = /^"(.*)" \((.*?); id ([\w-]+)\)(?: |$)/.exec(line);
  const bare = named ? null : /^(.*?) \(id ([\w-]+)\)(?: |$)/.exec(line);
  const match = named ?? bare;
  const where = match ? whereOf((named ? named[2] : bare?.[1]) ?? "") : null;
  const agent = where && match ? { name: named ? named[1]! : null, ...where } : null;
  const rest = match ? text.slice(match[0].length).trim() : text;
  const event = rest.startsWith("finished its turn") ? "done" : rest.startsWith("is blocked") ? "blocked" : rest.startsWith("exited") ? "exited" : null;
  const what = event === "done" ? "finished its turn" : event === "blocked" ? "is blocked" : event === "exited" ? "exited" : firstClause(rest);
  return { from: "kururu", agent, what, event, text };
}

/** `claude in Tracker, card TRK-45` — the bracket `agentName` writes, without its id. */
function whereOf(where: string): Omit<NoticeAgent, "name"> | null {
  const match = /^(.+?)(?: in (.+?))?(?:, card ([\p{Lu}\p{N}]{1,3}-\d{1,6})(?: "[\s\S]*")?)?$/u.exec(where.trim());
  if (!match) return null;
  return { program: match[1]!, workspace: match[2] ?? null, card: match[3] ?? null };
}

/** A background task's report: its summary for the line, and what it found for the tap. */
function taskNotice(text: string): Notice {
  const field = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim() || null;
  const summary = field("summary");
  const result = field("result");
  return {
    from: "Kuru's task",
    agent: null,
    what: summary ?? `a background task ${field("status") ?? "reported back"}`,
    event: null,
    text: result ?? summary ?? text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
  };
}

/** A message's opening, for a line that has room for only that. */
function firstClause(text: string): string {
  return (text.split(/\n|\.\s|:\s| — /, 1)[0] ?? "").trim() || text.trim();
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
 * A prompt is read for who it is from before it is anything (`readPrompt`):
 * kururu's notices, a background task's report and another session's message
 * all arrive as Kuru's user turns, and are notices here, never yours.
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
      const read = readPrompt(turn.text);
      if (read?.kind === "notice") {
        // Another Kuru's message came by the outbox, and is this turn now.
        if (turn.voiceId && byId.has(turn.voiceId)) linked.add(turn.voiceId);
        items.push({ kind: "notice", id: `t${turn.id}`, at: turn.at, ...read.notice });
        continue;
      }
      // Only a wrapper: nobody's line, and a message it was linked to is not
      // what it carried, so that stands on its own.
      if (!read) continue;
      const entry = turn.voiceId ? byId.get(turn.voiceId) : undefined;
      if (entry) linked.add(entry.id);
      const through = readPeerMark(read.text)?.node;
      items.push({
        kind: "you",
        id: `t${turn.id}`,
        at: turn.at,
        text: plainWords(read.text),
        // `typed` is what a turn was called when nothing on its words said
        // otherwise, and words that were inside a wrapper then may say so now.
        via: youVia(turn.via === "typed" ? viaOf(read.text) : turn.via, entry),
        ms: entry?.ms ?? 0,
        // A turn is Kuru's own word that it took the message, whatever the
        // outbox has got round to writing.
        state: "delivered",
        typedAt: entry?.typedAt ?? null,
        note: null,
        outboxId: entry?.id ?? null,
        ...(through ? { through } : {}),
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
    const peer = entry.text ? readPeerMark(entry.text) : null;
    if (peer?.who === "kuru") {
      // On its way from another Kuru: the line it will be once taken.
      items.push({ kind: "notice", id: entry.id, at: entry.at, from: `Kuru on ${peer.node}`, agent: null, what: firstClause(peer.rest), event: null, text: peer.rest.trim() });
      continue;
    }
    const through = peer?.node;
    items.push({
      kind: "you",
      id: entry.id,
      at: entry.at,
      text: entry.text && through ? plainWords(entry.text) : entry.text,
      via: youVia(null, entry),
      ms: entry.ms,
      state: entry.state,
      typedAt: entry.typedAt,
      note: entry.note,
      outboxId: entry.id,
      ...(through ? { through } : {}),
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
  return item.kind === "session" ? 0 : item.kind === "kuru" ? 2 : 1;
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

// ---------------------------------------------------------------------------
// Card references in a message of yours
// ---------------------------------------------------------------------------

/**
 * A card pointed at from its menu — "Reference in Kuru" — as words in the
 * composer: `[card ACM-16 "Design the checkout…" (w8/c3f9a1e07b2d4)]`.
 *
 * Text, and not a chip in the box, because the box is a textarea for the
 * reasons `Composer` gives, and because what reaches Kuru is what was typed
 * into its terminal: whatever the box drew, Kuru would read these words. So
 * they are written for both readers. The code and the title are for you,
 * the title cut short because the box is narrow and you know which card you
 * just picked; the brackets are for Kuru, and hold the two ids its tools
 * take — where the card is and which it is — so it goes to that card without
 * a search, even when two boards have a card of the same name.
 *
 * Where is a workspace id (`w8`), `profile` for the profile's own board, or
 * `omarchy:w3` for a workspace of another node shown here — the node's name,
 * which its tools take, and its own id, never the `n:…` spelling this
 * window keeps, which no tool of Kuru's accepts. A workspace id is this run's
 * and can be stale by the time a draft is sent; the card id is minted once
 * and never reused, which is why it is the half the role tells Kuru to trust.
 */
export interface CardRef {
  code: string;
  title: string;
  place: string;
  cardId: string;
}

/** How much of a card's title a reference carries, so the box shows the rest of the sentence. */
export const CARD_REF_TITLE_MAX = 32;

/**
 * The shape `cardReference` writes, for the drawer to draw your message
 * with the reference as a door onto the card. The title cannot hold a `"`,
 * since `cardReference` turns one into `'`, so anything it does hold — a
 * bracket, a slash — stays inside the quotes.
 */
const CARD_REF = /\[card (\S+) "([^"\n]*)" \(([^\s()/]+)\/(c[0-9a-f]{12})\)\]/g;

/**
 * Where a card is, as a reference writes it: its workspace's id, `profile`
 * for the profile's board (null), and for a workspace of another node shown
 * in this window that node's name and the node's own id for it — `nameOf`
 * reads the name, and an id is the fallback for a node it does not know,
 * which would still tell Kuru there was one.
 */
export function cardPlace(workspaceId: string | null, nameOf: (nodeId: string) => string | null): string {
  if (workspaceId === null) return "profile";
  const there = parseRemote(workspaceId);
  return there ? `${nameOf(there.node) ?? there.node}:${there.id}` : workspaceId;
}

export function cardReference(ref: CardRef): string {
  return `[card ${ref.code} "${cutQuoted(ref.title, CARD_REF_TITLE_MAX)}" (${ref.place}/${ref.cardId})]`;
}

/** A message split into its words and the card references among them, in order. */
export function splitCardRefs(text: string): ({ text: string } | { ref: CardRef })[] {
  const parts: ({ text: string } | { ref: CardRef })[] = [];
  let last = 0;
  for (const match of text.matchAll(CARD_REF)) {
    const at = match.index ?? 0;
    if (at > last) parts.push({ text: text.slice(last, at) });
    parts.push({ ref: { code: match[1]!, title: match[2]!, place: match[3]!, cardId: match[4]! } });
    last = at + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/**
 * Words put into a draft over its selection, with a space either side where
 * the draft has none, and where the cursor goes after them: past the space,
 * so the next thing typed is the next word. A reference dropped against a
 * word would read as part of it — `fix[card …]` — and one at the end with no
 * space after it would have the first key typed run into its bracket.
 */
export function insertWords(draft: string, from: number, to: number, words: string): { text: string; caret: number } {
  const start = Number.isFinite(from) ? Math.max(0, Math.min(draft.length, Math.trunc(from))) : draft.length;
  const end = Number.isFinite(to) ? Math.max(start, Math.min(draft.length, Math.trunc(to))) : start;
  const before = draft.slice(0, start);
  const after = draft.slice(end);
  const head = `${before}${before && !/\s$/.test(before) ? " " : ""}${words}`;
  // A space already there is used rather than doubled.
  if (after.startsWith(" ")) return { text: head + after, caret: head.length + 1 };
  return { text: `${head} ${after}`, caret: head.length + 1 };
}

// ---------------------------------------------------------------------------
// A message replied to
// ---------------------------------------------------------------------------

/**
 * One of the drawer's lines as a reply to it quotes it (`shared/reply.ts`):
 * Kuru's reply as `Kuru`, a notice under the name it came from, and one of
 * your own as `me`. `id` is the line's id in the conversation it is in —
 * another node's line by that node's own id, which is the one its Kuru and
 * its drawer know — and `now` the moment of the reply, which decides whether
 * the time needs its day. Null for a line with nothing to quote: a clip not
 * yet in words.
 *
 * Your message is quoted as the drawer drew it: without a reference of its
 * own, so a reply to a reply quotes what was said rather than what that
 * answered, and with a card reference as its code and title, not its ids.
 * A notice from another node crossed without its text (`peerItems`), and is
 * quoted by the line that is left.
 */
export function replyRefOf(item: YouItem | KuruReply | NoticeItem, id: string, now: number): ReplyRef | null {
  let who: string;
  let words: string;
  if (item.kind === "kuru") {
    who = "Kuru";
    words = item.text;
  } else if (item.kind === "you") {
    if (item.text === null) return null;
    who = REPLY_ME;
    const own = splitReply(item.text)?.text ?? item.text;
    words = splitCardRefs(own)
      .map((part) => ("text" in part ? part.text : `${part.ref.code} ${part.ref.title}`))
      .join("");
  } else {
    who = item.from;
    const agent = item.agent ? (item.agent.name ?? item.agent.program) : null;
    words = item.text.trim() || [agent, item.what].filter(Boolean).join(" ");
  }
  const quote = cutQuoted(words, REPLY_QUOTE_MAX);
  return quote ? { who, when: replyClock(item.at, now), quote, id } : null;
}

/**
 * The line a reply quotes, among the lines a drawer has: by its id first —
 * which a message of yours changes once Kuru takes it, from the outbox's to
 * the turn's, and a reply only the missed list remembered changes once its
 * turn is written — and failing that, as a reply from Telegram has no id, by
 * its words: the nearest line before the reply whose words hold the quote,
 * since Telegram may have quoted the second part of a long reply. `lines`
 * are one conversation's, oldest first, under the ids `ref.id` names them by.
 */
export function quotedLine<T extends KuruItem>(lines: readonly T[], ref: ReplyRef, before: number): T | null {
  if (ref.id !== null) {
    const id = ref.id;
    const found = lines.find(
      (line) => line.id === id || (line.kind === "you" && line.outboxId === id) || (line.kind === "kuru" && id.startsWith("m") && line.utterance === id.slice(1)),
    );
    if (found) return found;
  }
  const quote = flatWords(ref.quote.replace(/…$/, ""));
  if (!quote) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.at > before || line.kind === "session") continue;
    const words = line.kind === "you" ? (line.text === null ? "" : (splitReply(line.text)?.text ?? line.text)) : line.text;
    if (flatWords(words).includes(quote)) return line;
  }
  return null;
}

/** Words as a quote is compared: one line, and the `"` a quote cannot hold read as the `'` it became. */
function flatWords(text: string): string {
  return text.replace(/\s+/g, " ").replace(/"/g, "'").trim();
}

// ---------------------------------------------------------------------------
// Other nodes' Kurus
// ---------------------------------------------------------------------------

/**
 * Who a message of yours is for, when it is for another node's Kuru: the
 * drawer's `@omarchy start the build`, or the same said aloud. Null for one
 * that is this node's own, which is every message that does not open with a
 * peer's name — a name nobody has, this node's own, or no name at all.
 *
 * Typed, the address is `@name` and nothing looser, so a sentence that
 * happens to start with a word that is also a node's name stays here. A
 * recogniser never writes an `@`, so spoken words are read for how somebody
 * says it: "at omarchy, …", "hey omarchy …", "omarchy, …" — the bare name
 * only with the comma a recogniser writes after an address, so "omarchy is
 * slow today" stays here — and the `@` too, since some recognisers do turn
 * "at" into one. A dash in a name may be heard as a space. The words that
 * are left are what the peer is typed.
 */
export function addressOf(text: string, names: readonly string[], spoken: boolean): { node: string; rest: string } | null {
  if (!spoken) {
    const at = typedAddress(text, names);
    return at?.rest ? { node: at.node, rest: at.rest } : null;
  }
  const said = text.trim();
  for (const node of [...names].sort((a, b) => b.length - a.length)) {
    const shape = `^(?:(?:@|at\\s+|hey\\s+)${namePattern(node)}(?:[,:!.]\\s*|\\s+)|${namePattern(node)}[,:!]\\s*)`;
    const match = new RegExp(shape, "i").exec(said);
    if (!match) continue;
    const rest = said.slice(match[0].length).trim();
    // Spoken, a bare name with a space after it is only an address when
    // something follows it that is worth sending.
    if (rest) return { node, rest: rest.charAt(0).toUpperCase() + rest.slice(1) };
  }
  return null;
}

/** A node's name as the address reads it: escaped, and a dash that may be a space or nothing. */
function namePattern(node: string): string {
  return node.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/-/g, "[- ]?");
}

/** Where a typed address sits in a draft: the `@name` from `from` to `to`, and the words after it. */
export interface TypedAddress {
  node: string;
  from: number;
  to: number;
  rest: string;
}

/**
 * The typed address in a draft, where it is — which is `addressOf`'s typed
 * grammar itself, so that the composer drawing `@omarchy` in bold and the
 * server routing the message there are one decision and not two that agree.
 *
 * It also finds an address with nothing after it yet (`rest` empty), which
 * routes nowhere on its own: that is `@omarchy` just picked, and the bold
 * says the words that follow will go there. A name that has an address only
 * with words after it — `@box 2` for `box-2`, when `box` is a node too and
 * the `2` would be its words — is read the way `addressOf` reads it, the
 * longest name with words first.
 */
export function typedAddress(text: string, names: readonly string[]): TypedAddress | null {
  let bare: TypedAddress | null = null;
  for (const node of [...names].sort((a, b) => b.length - a.length)) {
    const match = new RegExp(`^(\\s*)(@${namePattern(node)})(?:[,:]\\s*|\\s+|$)`, "i").exec(text);
    if (!match) continue;
    const from = match[1]!.length;
    const at = { node, from, to: from + match[2]!.length, rest: text.slice(match[0].length).trim() };
    if (at.rest) return at;
    bare ??= at;
  }
  return bare;
}

/**
 * The `@` being typed at the front of a draft, while the caret is in it:
 * what follows the `@` up to the caret, and the span the whole word covers,
 * which a pick replaces. Only at the front, because only there is an `@` an
 * address — offering names to "ask @om" would offer a route that is not one.
 */
export function addressQuery(text: string, caret: number): { query: string; from: number; to: number } | null {
  const before = /^\s*@([\p{L}\p{N}-]*)$/u.exec(text.slice(0, caret));
  if (!before) return null;
  const after = /^[\p{L}\p{N}-]*/u.exec(text.slice(caret))![0];
  return { query: before[1]!, from: text.indexOf("@"), to: caret + after.length };
}

/** The names a query offers: those that start with it first, then those that only contain it, each in roster order. */
export function addressMatches(query: string, names: readonly string[]): string[] {
  const q = query.toLowerCase();
  const starts = names.filter((name) => name.toLowerCase().startsWith(q));
  return [...starts, ...names.filter((name) => !starts.includes(name) && name.toLowerCase().includes(q))];
}

/**
 * A draft with a name picked for the `@` being typed: the word replaced by
 * `@name` and a space, unless a space or the address's own `,` or `:` is
 * already there, and where the caret goes — past the space, ready for the
 * words.
 */
export function pickAddress(text: string, at: { from: number; to: number }, node: string): { text: string; caret: number } {
  const after = text.slice(at.to);
  const head = `${text.slice(0, at.from)}@${node}`;
  const space = /^[\s,:]/.test(after) ? "" : " ";
  return { text: head + space + after, caret: head.length + 1 };
}

/**
 * Another node's Kuru, as this one's drawer draws it: whose, whether it can
 * be heard from, and its last items. `items` is what that node pushed about
 * its own conversation (`peerItems`), with each reply's utterance and fate
 * put right by this node — a reply is unheard *here*, or was never said
 * here, whatever the node it came from thinks.
 */
export interface PeerKuru {
  node: { id: string; name: string };
  state: "up" | "connecting" | "away";
  /** When it was last heard from: "last seen 23:10" for one that is away. */
  lastSeen: number | null;
  items: KuruItem[];
  /** Its replies said aloud here that nobody heard out or read. */
  unheard: number;
  /** Whether its kururu takes messages for its Kuru at all — an older one does not, and `@` to it says so. */
  talks: boolean;
}

/** How many items a node pushes about its conversation. The drawer's window is `KURU_RECENT`; another node's is a glance. */
export const PEER_RECENT = 40;
/** What one item's words are cut to on the link. A reply longer than this is read where it was made. */
const PEER_TEXT_MAX = 6000;

function capWords(text: string): string {
  return text.length > PEER_TEXT_MAX ? `${text.slice(0, PEER_TEXT_MAX - 1)}…` : text;
}

/**
 * This node's conversation as it crosses to another: the newest
 * `PEER_RECENT` items, each without what only means something here.
 *
 * A reply loses its links, which name files on this disk, and its
 * utterance and fate, which are this node's voice's. A notice from kururu
 * or a background task loses its text — kururu's quotes an agent's last
 * reply, which can quote a file with a secret in it, and that is the reason
 * the Telegram channel never carries one either — and keeps its line: which
 * agent, where, what happened, which the summary already says. Another
 * Kuru's message keeps its words, since they were that Kuru's to begin with.
 */
export function peerItems(items: readonly KuruItem[]): KuruItem[] {
  return items.slice(-PEER_RECENT).map((item): KuruItem => {
    switch (item.kind) {
      case "kuru": {
        const { files: _files, ...rest } = item;
        return { ...rest, text: capWords(item.text), utterance: null, fate: null };
      }
      case "notice":
        return { ...item, text: item.from.startsWith("Kuru on ") ? capWords(item.text) : "" };
      case "you":
        return { ...item, text: item.text === null ? null : capWords(item.text) };
      default:
        return item;
    }
  });
}

/** An item of the merged drawer: whose conversation it is in, null for this node's own. */
export type NodeKuruItem = KuruItem & { node: string | null };

/**
 * This node's conversation and every other node's, as one timeline.
 *
 * Nothing is copied into anybody's database to make it: each node's items
 * are what that node said about its own conversation, tagged with its name,
 * and the merge is by time. One rule is the merge's own. A message sent from
 * one node's drawer to another node's Kuru is on the first node's outbox,
 * as an item of its own, and on the second's turns once that Kuru took it,
 * under the same outbox id — so it is in two conversations at once, either
 * way round. Once some node has it as a turn, that copy is the one drawn,
 * since it carries Kuru's word that it was taken; until then the outbox's
 * copy is, with its state and, on the node that sent it, its Resend.
 */
export function mergeNodes(local: readonly KuruItem[], peers: readonly PeerKuru[]): NodeKuruItem[] {
  // An item that is a turn has an id of its own beside the outbox id; one
  // that is only on an outbox is known by the outbox id itself.
  const outboxOnly = (item: KuruItem): boolean => item.kind === "you" && item.outboxId !== null && item.id === item.outboxId;
  const taken = new Set<string>();
  for (const item of [...local, ...peers.flatMap((peer) => peer.items)]) if (item.kind === "you" && item.outboxId && !outboxOnly(item)) taken.add(item.outboxId);
  const shown = (item: KuruItem): boolean => !(outboxOnly(item) && taken.has((item as YouItem).outboxId!));
  const out: NodeKuruItem[] = local.filter(shown).map((item) => ({ ...item, node: null }));
  // Ids are each node's own and two nodes both have a `t12`, so another
  // node's are made unique by its id. Its messages lose their outbox id:
  // Resend and Discard are for this node's own list.
  for (const peer of peers) {
    for (const item of peer.items) {
      if (!shown(item)) continue;
      const id = `${peer.node.id}/${item.id}`;
      out.push(item.kind === "you" ? { ...item, id, outboxId: null, node: peer.node.name } : { ...item, id, node: peer.node.name });
    }
  }
  return out.sort((a, b) => a.at - b.at || rank(a) - rank(b));
}
