/**
 * Pinned lines in Kuru's drawer: which lines can be pinned, and what the
 * drawer's list of them says about each.
 *
 * A pin is a mark on a turn, kept in the database beside the turn
 * (`turn_pins`, `server/src/store.ts`), and not a copy of the line nor a
 * setting of this device. Not a copy, because the turn is already the one
 * place the words live, and a pinned copy would be a second place for them to
 * disagree in. Not this device's, as a fold is (`web/src/kurufold.ts`),
 * because a fold is about how a line reads here — a phone folds what a wide
 * window shows open — while a pin is about the line itself: "come back to
 * this" means from the phone too, and after a restart.
 *
 * So only a line that is a turn can be pinned: an item whose id is `t<turn>`.
 * A clip still on its way is the outbox's, under an id that changes once Kuru
 * takes it; a reply only the missed list remembers (`m<utterance>`) has no
 * turn behind it; a new conversation's mark is not anybody's words; and
 * another node's line is that node's turn, under that node's ids, in a
 * database this one does not have.
 *
 * The wire carries each pin with the whole line, merged as the drawer would
 * merge it, so a pin whose line is not among the ones a window has loaded —
 * months back, in a session long since thrown away — is still there in full
 * to be shown, with nothing more to ask for.
 */
import type { KuruItem, NoticeItem, KuruReply, YouItem } from "./kuru";
import { splitReply } from "./reply";

/** One pinned line, as the drawer is sent it. */
export interface KuruPin {
  /** The line's id, `t<turn>`, which is the item's own. */
  id: string;
  /** When it was pinned, which is not when it was said. */
  pinnedAt: number;
  /** The line, merged as the conversation's lines are. */
  item: YouItem | KuruReply | NoticeItem;
}

/** How much of a pinned line its entry in the list shows. */
export const PIN_OPENING_MAX = 140;

/** The turn a line is, by its id: `t123` is 123. Null for anything else, which cannot be pinned. */
export function pinnedTurnId(id: unknown): number | null {
  if (typeof id !== "string" || !/^t[1-9]\d{0,15}$/.test(id)) return null;
  const n = Number(id.slice(1));
  return Number.isSafeInteger(n) ? n : null;
}

/** Whether a line of the drawer's can carry a pin: this node's, and a turn. */
export function canPin(item: KuruItem & { node?: string | null }): item is (YouItem | KuruReply | NoticeItem) & { node?: string | null } {
  if (item.kind === "session") return false;
  if (item.node != null) return false;
  if (item.kind === "you" && item.text === null) return false;
  return pinnedTurnId(item.id) !== null;
}

/**
 * What a pin's entry says of its line: the words it opens with, on one line,
 * without the reference a reply carries in front (which the line itself draws
 * as a quote), and with the marks of Markdown a reply is written in taken off —
 * a list's dash, a heading's hashes, the stars and ticks around words — since
 * the entry is one line of plain words and a `##` there is noise.
 */
export function pinOpening(item: YouItem | KuruReply | NoticeItem, max = PIN_OPENING_MAX): string {
  let words: string;
  if (item.kind === "notice") words = [item.from, item.agent?.name ? `"${item.agent.name}"` : item.agent?.program, item.what].filter(Boolean).join(" · ");
  else if (item.kind === "you") words = item.text === null ? "" : (splitReply(item.text)?.text ?? item.text);
  else words = item.text;
  const plain = words
    .split("\n")
    .map((line) => line.replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, ""))
    .filter((line) => !/^\s*(?:```|~~~|\|?\s*:?-{3,})/.test(line))
    .join(" ")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

/** Newest said first: the list is for finding a line again, and the newest pin is the likeliest wanted. */
export function sortPins(pins: readonly KuruPin[]): KuruPin[] {
  return [...pins].sort((a, b) => b.item.at - a.item.at || b.pinnedAt - a.pinnedAt);
}
