/**
 * A message of yours that answers one message in particular, as words in
 * front of it: `[reply to Kuru 18:42 "Want me to tell it to go ahead? …" (t1234)]`.
 *
 * It exists because a conversation with Kuru is never one thread. Kuru asks
 * whether to let an agent go ahead, kururu relays that two others finished,
 * Kuru asks something else about one of them — and "yes" after all of that
 * answers whichever Kuru takes to be the last question, which is a guess
 * the user cannot see being made. A reference says which one they meant,
 * and Kuru answers in the context of that message.
 *
 * Words and not a field beside them, for the card reference's reason
 * (`cardReference` in `shared/kuru.ts`): what reaches Kuru is what is typed
 * into its terminal, and everything that reads a turn afterwards — the
 * drawer, the search, the backup, the Telegram echo, another node's Kuru —
 * reads words. So it is written for every reader at once. Who said it, when,
 * and its opening, cut short, are for Kuru and the person both: Kuru's
 * transcript has no clock on it, and finds the message by its words. The id
 * in parentheses is the drawer's own, so the quote it draws is a door back to
 * the message; a reply from Telegram has none, since Telegram knows only its
 * own ids, and the drawer finds that message by its words too.
 *
 * Its own module, with nothing imported, because both `shared/kuru.ts` and
 * `shared/channels.ts` write one and the first already imports the second.
 */

export interface ReplyRef {
  /** Whose message: `Kuru`, `kururu`, `me` for one of the user's own, or the name a notice was signed with. */
  who: string;
  /** When it was said, as the reference writes it: `18:42`, or `Oct 24 18:42` from another day. */
  when: string;
  /** Its opening, on one line and cut short (`REPLY_QUOTE_MAX`). */
  quote: string;
  /** The drawer's id for it, in the conversation it is in; null for one answered from Telegram. */
  id: string | null;
}

/** How much of the message a reference quotes: enough to tell two of Kuru's questions apart, and short enough to read past. */
export const REPLY_QUOTE_MAX = 80;

/** Who a reference says wrote one of the user's own messages. The words are the user's, so `me` is the user. */
export const REPLY_ME = "me";

/** An id as a reference may carry one: a turn's `t12`, an outbox id, another node's `n…/t12` never — that node's own `t12` is written. */
const REPLY_ID = /^[\w:.-]{1,96}$/;

/**
 * The shape `replyReference` writes, at the very front of a message or just
 * after the `@node` that routes it to another node's Kuru, which has to stay
 * first because the server reads an address only there. The quote cannot
 * hold a `"` — `cutQuoted` turns one into `'` — so a bracket inside it never
 * ends the reference early.
 */
const REPLY = /^(\s*@[\p{L}\p{N}-]+[,:]?\s*)?\[reply to ([^"[\]\n]{1,40}?) ((?:[A-Z][a-z]{2} \d{1,2} )?\d{1,2}:\d{2}) "([^"\n]*)"(?: \(([\w:.-]{1,96})\))?\]\s*/u;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Words on one line, without a `"` to end a quote early, and cut at a word
 * near `max` when there is one, with `…` where they were cut — the card
 * reference's title and the reply's quote alike.
 */
export function cutQuoted(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").replace(/"/g, "'").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  // Cut just before a space is a cut at a word's end already.
  const space = flat[cut.length] === " " ? cut.length : cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * When a message was said, as a reference writes it: the clock on the day
 * of `now`, and the month and day before it as well on any other. Spelt the
 * same in every locale, since Kuru reads it, and in the Mac's own time zone,
 * the one the drawer and the user go by.
 */
export function replyClock(at: number, now: number): string {
  const when = new Date(at);
  const time = `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
  return when.toDateString() === new Date(now).toDateString() ? time : `${MONTHS[when.getMonth()]} ${when.getDate()} ${time}`;
}

export function replyReference(ref: ReplyRef): string {
  const who = ref.who.replace(/["[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 40).trim() || "someone";
  const quote = cutQuoted(ref.quote, REPLY_QUOTE_MAX);
  const id = ref.id !== null && REPLY_ID.test(ref.id) ? ` (${ref.id})` : "";
  return `[reply to ${who} ${ref.when} "${quote}"${id}]`;
}

/**
 * The reference a message starts with, and the message without it — an
 * address in front of it kept, so `@omarchy [reply to …] yes` is the
 * reference and `@omarchy yes`. Null for a message that is not a reply.
 */
export function splitReply(text: string): { ref: ReplyRef; text: string } | null {
  const match = REPLY.exec(text);
  if (!match) return null;
  return {
    ref: { who: match[2]!, when: match[3]!, quote: match[4]!, id: match[5] ?? null },
    text: `${match[1] ?? ""}${text.slice(match[0].length)}`,
  };
}

/**
 * The words that are sent: the reference in front, after the `@node` that
 * routes them when there is one (`to` is where that address ends, from
 * `typedAddress`), since the server reads an address only at the very front.
 */
export function withReply(words: string, reference: string, to: number | null = null): string {
  if (to === null) return `${reference} ${words}`;
  return `${words.slice(0, to)} ${reference} ${words.slice(to).replace(/^[,:]?\s*/, "")}`;
}

/**
 * A reply as a person reads it where only text can be shown — your words
 * echoed into Telegram — rather than as the brackets written for Kuru:
 * `↩ Kuru 18:42: "Want me to…"` on a line above the words.
 */
export function readableReply(text: string): string {
  const reply = splitReply(text);
  if (!reply) return text;
  const who = reply.ref.who === REPLY_ME ? "you" : reply.ref.who;
  return `↩ ${who} ${reply.ref.when}: "${reply.ref.quote}"\n${reply.text}`;
}
