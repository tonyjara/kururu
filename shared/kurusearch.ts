/**
 * What a search of Kuru's conversation finds, and which words in a line it lit.
 *
 * Why this is not the `search` tool's FTS5 index, which already covers every
 * turn: that index answers for whole tokens and a last-word prefix, so "delpoy"
 * finds nothing, and it reads a turn as it was written down — envelopes, a
 * reply's reference, a card's ids and all — where somebody searching the drawer
 * is searching what the drawer draws. A trigram index would give substrings and
 * still no typos. The conversation is a few megabytes in the worst year it has
 * had, so the drawer's search reads it through the same merge the drawer does
 * and compares words here, in one function both halves share: the server to
 * find a line anywhere in the history, the window to narrow what it already has
 * on the very keystroke and to light the words in a line once it is drawn.
 *
 * **Fuzzy here means a typo or a part of a word, and not letters in order.** A
 * subsequence match, fzf's, is the obvious pick and is right for a file name; in
 * a three-paragraph reply nearly any short query is a subsequence of something,
 * and every line would match. So each word of the query must be found in the
 * line, in any order: as a substring, which is an exact hit, or failing that as
 * a word within a small edit distance, transposed letters counting as one, which
 * is a close one. How many edits grows with the word, as every search engine's
 * rule does (`allowedEdits`), and a word holding a digit gets none, since 8080
 * is not a misspelling of 8081 and KUR-45 is not KUR-46.
 *
 * No library: fuzzy packages are built to rank short strings, this needs a
 * distance and the ranges, and the ranges have to survive folding (`foldWords`),
 * which is the part a library would not do for us.
 *
 * Pure, tested, and on neither side of the wire. No model hears a query.
 */
import { splitCardRefs, type KuruItem } from "./kuru";
import { splitReply } from "./reply";

/** A query as long as anybody searches, and no more: a pasted page is not a question, and each word is a pass over the history. */
const QUERY_MAX = 200;
const TERMS_MAX = 8;
/** Longer than any word worth correcting. Hashes and base64 are skipped by this before they cost anything. */
const WORD_MAX = 48;

/** How many lines one answer carries. The list has no virtual scroll, and nobody reads the two hundred and first. */
export const KURU_SEARCH_MAX = 200;

export interface KuruQuery {
  /** The words as typed, trimmed: what an answer is matched back to its question by. */
  raw: string;
  terms: Term[];
}

interface Term {
  text: string;
  /** Its runs of letters and digits, so that `foo-bar` close to `foo bar` is still found. */
  parts: string[];
}

/** How close a line came: every word found as written, or at least one only by a typo. */
export type HitTier = "exact" | "near";

/** One page of a search, from `/api/kuru/search`. Oldest first, as the drawer draws. */
export interface KuruSearchAnswer {
  raw: string;
  items: KuruItem[];
  /** Every line that matched, which is more than `items` once the cap is reached. */
  total: number;
  /** How many of `total` matched without a typo. */
  exact: number;
}

/** The lines around a moment, from `/api/kuru/around`: what a jump to an old result opens at. */
export interface KuruAround {
  items: KuruItem[];
  /** Whether there is anything before `items[0]`. */
  older: boolean;
  /** Whether there is anything after the last of `items`. */
  newer: boolean;
}

const WORD = /[\p{L}\p{N}]+/gu;

/** Words to look for, or null for nothing to look for, which is the full chat. */
export function parseKuruQuery(raw: string): KuruQuery | null {
  const trimmed = raw.slice(0, QUERY_MAX).trim();
  if (!trimmed) return null;
  const terms: Term[] = [];
  for (const piece of foldWords(trimmed).text.split(/\s+/)) {
    if (!piece || terms.some((term) => term.text === piece)) continue;
    terms.push({ text: piece, parts: piece.match(WORD) ?? [] });
    if (terms.length === TERMS_MAX) break;
  }
  return terms.length ? { raw: trimmed, terms } : null;
}

/**
 * Text as it is compared: lower case, accents off, as the store's FTS folds
 * them — and, for a line that changed length on the way, where each folded unit
 * came from, so a range found here can be drawn on the words as they were
 * written. Plain ASCII needs no map, and that is nearly all of it.
 */
export function foldWords(text: string): { text: string; map: number[] | null } {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(text)) return { text: text.toLowerCase(), map: null };
  let folded = "";
  const map: number[] = [];
  let at = 0;
  for (const char of text) {
    const bare = char.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
    for (let i = 0; i < bare.length; i++) map.push(at);
    folded += bare;
    at += char.length;
  }
  map.push(at);
  return { text: folded, map };
}

/** A range in the words as written, and how it was found. */
interface Range {
  from: number;
  to: number;
  hit: HitTier;
}

/** How many typos a word of this length may have. Under four letters one edit makes it another word; `test` has `rest`, and that is the price of one. */
function allowedEdits(word: string): number {
  if (/\d/.test(word) || word.length < 4 || word.length > WORD_MAX) return 0;
  return word.length < 8 ? 1 : 2;
}

// Two rows and the one before them, kept between calls: this runs once per
// plausible word in the history, per keystroke, and allocating here would be
// most of what the search costs.
const ROWS = [new Int32Array(WORD_MAX + 3), new Int32Array(WORD_MAX + 3), new Int32Array(WORD_MAX + 3)] as const;

/**
 * Whether two words are within `limit` edits, a swap of neighbours being one —
 * the commonest typo there is, and two under plain Levenshtein. Gives up on a
 * row with nothing left under the limit.
 */
export function withinEdits(a: string, b: string, limit: number): boolean {
  if (Math.abs(a.length - b.length) > limit) return false;
  if (a.length > WORD_MAX || b.length > WORD_MAX) return false;
  let [before, last, row] = ROWS;
  for (let j = 0; j <= b.length; j++) last[j] = j;
  for (let i = 1; i <= a.length; i++) {
    row[0] = i;
    let least = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let best = Math.min(last[j]! + 1, row[j - 1]! + 1, last[j - 1]! + cost);
      if (i > 1 && j > 1 && a.charCodeAt(i - 1) === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) best = Math.min(best, before[j - 2]! + 1);
      row[j] = best;
      if (best < least) least = best;
    }
    if (least > limit) return false;
    [before, last, row] = [last, row, before];
  }
  return last[b.length]! <= limit;
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}]/u.test(char);
}

/**
 * Where a word is written, in folded text. Two letters or fewer only at the
 * start of a word: "at" is in half the words of a reply, and the second line of
 * highlights is not what somebody typing the first two letters wants to see.
 */
function exactIn(text: string, word: string): [number, number][] {
  const found: [number, number][] = [];
  let at = text.indexOf(word);
  while (at !== -1) {
    if (word.length > 2 || !isWordChar(text[at - 1])) found.push([at, at + word.length]);
    at = text.indexOf(word, at + word.length);
  }
  return found;
}

/**
 * The words of a folded text a typo away from this one. A first letter is
 * rarely the one mistyped, and in a short word changing it is usually another
 * word, so under six letters it has to agree. A word's opening may be what is
 * mistyped ("delpoy" for "deployment"), once there is enough of it to go on.
 */
function typosIn(text: string, word: string): [number, number][] {
  const limit = allowedEdits(word);
  if (!limit) return [];
  const found: [number, number][] = [];
  for (const match of text.matchAll(WORD)) {
    const other = match[0];
    if (word.length < 6 && other.charCodeAt(0) !== word.charCodeAt(0)) continue;
    if (other.length < word.length - limit || /\d/.test(other)) continue;
    if (withinEdits(word, other, limit) || (word.length >= 5 && other.length > word.length && withinEdits(word, other.slice(0, word.length), limit))) found.push([match.index, match.index + other.length]);
  }
  return found;
}

/** Where one word of the query is in a folded text, or null when it is not — every part of it, for a word with punctuation that is not there as written. */
function termIn(text: string, term: Term): { ranges: [number, number][]; hit: HitTier } | null {
  const exact = exactIn(text, term.text);
  if (exact.length) return { ranges: exact, hit: "exact" };
  // KUR-65 is one thing with a number in it: "kur" here and "65" there is not it.
  if (!term.parts.length || (term.parts.length > 1 && /\d/.test(term.text))) return null;
  const ranges: [number, number][] = [];
  for (const part of term.parts) {
    let found = part === term.text ? [] : exactIn(text, part);
    if (!found.length) found = typosIn(text, part);
    if (!found.length) return null;
    ranges.push(...found);
  }
  return { ranges, hit: "near" };
}

/**
 * The words a line draws, which is what a search has to go by: a message of
 * yours without the reply reference in front of it and with a card reference as
 * its code and title rather than its ids, which are Kuru's to read; a notice's
 * line and the message behind it. A clip not yet in words and a session's mark
 * have none. A quote is not its message's words: it would find every reply to a
 * line along with the line.
 */
export function itemWords(item: KuruItem): string[] {
  switch (item.kind) {
    case "kuru":
      return [item.text];
    case "you": {
      if (item.text === null) return [];
      const own = splitReply(item.text)?.text ?? item.text;
      return [
        splitCardRefs(own)
          .map((part) => ("text" in part ? part.text : `${part.ref.code} ${part.ref.title}`))
          .join(""),
      ];
    }
    case "notice":
      return [item.from, item.agent?.name ?? item.agent?.program ?? "", item.agent?.workspace ?? "", item.what, item.text].filter(Boolean);
    default:
      return [];
  }
}

/** Whether a line has every word of the query, somewhere among what it draws, and how close it came. */
export function matchItem(query: KuruQuery, item: KuruItem): HitTier | null {
  const words = itemWords(item);
  if (!words.length) return null;
  const text = foldWords(words.join("\n")).text;
  let tier: HitTier = "exact";
  for (const term of query.terms) {
    const found = termIn(text, term);
    if (!found) return null;
    if (found.hit === "near") tier = "near";
  }
  return tier;
}

/**
 * Text cut where the query lit it, for the drawer to put a `<mark>` round the
 * lit pieces. Strings and not markup, so nothing in a line can become HTML on
 * the way: React escapes every piece as it does any other text, and joined
 * back up they are the text that came in, to the character.
 *
 * Any word of the query lights where it is, without asking whether the others
 * are in this same piece: a line is split among a path's link and a card's door
 * and the words between, and the row was already judged on all of them.
 */
export function splitHits(query: KuruQuery, text: string): { text: string; hit: HitTier | null }[] {
  const folded = foldWords(text);
  const ranges: Range[] = [];
  const back = (at: number): number => (folded.map ? (folded.map[at] ?? text.length) : at);
  for (const term of query.terms) {
    const found = termIn(folded.text, term);
    if (!found) continue;
    for (const [from, to] of found.ranges) ranges.push({ from: back(from), to: back(to), hit: found.hit });
  }
  ranges.sort((a, b) => a.from - b.from || b.to - a.to);
  const parts: { text: string; hit: HitTier | null }[] = [];
  let last = 0;
  for (const range of ranges) {
    if (range.to <= last) continue;
    const from = Math.max(range.from, last);
    if (from > last) parts.push({ text: text.slice(last, from), hit: null });
    parts.push({ text: text.slice(from, range.to), hit: range.hit });
    last = range.to;
  }
  if (last < text.length) parts.push({ text: text.slice(last), hit: null });
  return parts;
}

/**
 * The lines one answer carries, oldest first, as the chat is: time order is what
 * a conversation means, and shuffled by score the lines around a decision would
 * read as nonsense. So rank decides only what gets left out when there are more
 * than the cap — every exact hit before a close one, the newest before the
 * older — and never where a line sits.
 */
export function pickHits(found: readonly { item: KuruItem; tier: HitTier }[], cap = KURU_SEARCH_MAX): KuruItem[] {
  if (found.length <= cap) return found.map((hit) => hit.item);
  const kept = found
    .map((hit, at) => ({ ...hit, at }))
    .sort((a, b) => (a.tier === b.tier ? b.at - a.at : a.tier === "exact" ? -1 : 1))
    .slice(0, cap)
    .sort((a, b) => a.at - b.at);
  return kept.map((hit) => hit.item);
}
