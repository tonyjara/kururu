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
import { channelOfMessage, isChannelKind, withoutChannelMark, type ChannelKind } from "./channels";
import { CROSS_SESSION_TAG, NOTICE_SENDER } from "./harness";
import type { MadeFile } from "./made";
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
  /** The code of the card it runs, such as HOL-45. */
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

/** The words of a turn as a person said them: the voice's prefix is the recogniser's, not theirs, and a channel's mark is kururu's. */
export function plainWords(text: string): string {
  return text.startsWith(VOICE_PREFIX) ? text.slice(VOICE_PREFIX.length).trim() : withoutChannelMark(text);
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
  let text = stripPastedContent(prompt.trim()).replace(PASTED_OPEN, "").replace(PASTED_CLOSE, "").replace(DROPPED, "").trim();
  const envelope = ENVELOPE.exec(text);
  if (envelope) {
    const from = /\bfrom-name="([^"]*)"/.exec(envelope[1] ?? "")?.[1] ?? null;
    const body = (envelope[2] ?? "").replace(PEER_ADVICE, "").trim();
    if (body.startsWith(KURURU_MARK) || from === NOTICE_SENDER) return { kind: "notice", notice: kururuNotice(body) };
    return { kind: "notice", notice: { from: from || "another session", agent: null, what: firstClause(body), event: null, text: body } };
  }
  if (text.startsWith(KURURU_MARK)) return { kind: "notice", notice: kururuNotice(text) };
  if (TASK.test(text)) return { kind: "notice", notice: taskNotice(text) };
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

/** `claude in Holapy, card HOL-45` — the bracket `agentName` writes, without its id. */
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
        items.push({ kind: "notice", id: `t${turn.id}`, at: turn.at, ...read.notice });
        continue;
      }
      // Only a wrapper: nobody's line, and a message it was linked to is not
      // what it carried, so that stands on its own.
      if (!read) continue;
      const entry = turn.voiceId ? byId.get(turn.voiceId) : undefined;
      if (entry) linked.add(entry.id);
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
      via: youVia(null, entry),
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
 * Where a reply names a card — `KUR-67`, `FAS-3` — so the drawer can make
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
