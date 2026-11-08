/**
 * The words dictation should know, as one file the user owns and Kuru edits.
 *
 * Why a file in `~/Documents/Kururu/dictation` and not a list in kururu's
 * own settings or Hex's: the list is the user's, it outlives any one
 * recogniser, and the thing that most often adds to it is Kuru, told "it
 * keeps writing Pasapi", which can edit a file and cannot press Hex's
 * Vocabulary sheet. Hex's list is generated from it and nobody edits that by
 * hand: a term added in Hex's window is gone at the next sync.
 *
 * **Order is the point.** Parakeet biases toward the first 64 terms only, so
 * the file's order is Hex's order, and a sync that only ever appended would
 * leave a term moved to the top at the bottom. `vocabularyPlan` keeps what
 * already matches from the front and redoes everything after the first
 * difference, which is idempotent and never more than the list.
 *
 * `phrases` are whole-phrase mishearings ("Tarifa Predator" for "tarifa
 * predeterminada"). They are read and kept for a cleanup pass that is not
 * built; they are never a find-and-replace, which is exactly the rule that
 * fires on the one sentence where the heard words were meant.
 */

/** One term and the ways a transcript has spelled it. */
export interface VocabularyEntry {
  term: string;
  sounds_like: string[];
}

export interface VocabularyPhrase {
  heard: string;
  meant: string;
}

export interface Vocabulary {
  terms: VocabularyEntry[];
  phrases: VocabularyPhrase[];
}

/** Hex's own limits: a term is cut to 64 characters and the list holds 500. */
export const TERM_MAX = 64;
export const TERMS_MAX = 500;
/** How many terms Parakeet's decoder reads, first in the list. */
export const BIASED_TERMS = 64;
const SPELLINGS_MAX = 16;

const clean = (value: unknown, max: number): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");

/**
 * The file as read, made whole: each term once in any case (the first
 * kept, as Hex matches them), its spellings once each and never the term
 * itself, blanks dropped, and a file that is not an object or has no list an
 * empty vocabulary rather than a throw — a typo while Kuru edits it must not
 * empty Hex's list, so the caller is told it was unreadable instead
 * (`parseVocabulary`).
 */
export function adoptVocabulary(value: unknown): Vocabulary {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const terms: VocabularyEntry[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(raw.terms) ? raw.terms : []) {
    const rec = (typeof item === "string" ? { term: item } : item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const term = clean(rec.term, TERM_MAX);
    if (!term || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    const spellings: string[] = [];
    for (const s of Array.isArray(rec.sounds_like) ? rec.sounds_like : []) {
      const spelling = clean(s, TERM_MAX);
      const key = spelling.toLowerCase();
      if (!spelling || key === term.toLowerCase() || spellings.some((x) => x.toLowerCase() === key)) continue;
      if (spellings.length < SPELLINGS_MAX) spellings.push(spelling);
    }
    terms.push({ term, sounds_like: spellings });
    if (terms.length >= TERMS_MAX) break;
  }
  const phrases: VocabularyPhrase[] = [];
  for (const item of Array.isArray(raw.phrases) ? raw.phrases : []) {
    const rec = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const heard = clean(rec.heard, 200);
    const meant = clean(rec.meant, 200);
    if (heard && meant) phrases.push({ heard, meant });
  }
  return { terms, phrases };
}

/** The file's text into a vocabulary, or why it could not be: bad JSON keeps Hex's list as it was. */
export function parseVocabulary(text: string): Vocabulary | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { error: `not JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as Record<string, unknown>).terms)) return { error: "no \"terms\" list" };
  return adoptVocabulary(parsed);
}

/** Hex's `vocabulary-list` reply, as entries; anything unreadable is left out. */
export function hexEntries(reply: unknown): VocabularyEntry[] {
  const entries = reply && typeof reply === "object" ? (reply as Record<string, unknown>).entries : null;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((e) => {
    const rec = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
    const term = typeof rec.term === "string" ? rec.term : "";
    if (!term) return [];
    return [{ term, sounds_like: Array.isArray(rec.sounds_like) ? rec.sounds_like.filter((s): s is string => typeof s === "string") : [] }];
  });
}

const same = (a: VocabularyEntry, b: VocabularyEntry): boolean =>
  a.term === b.term && a.sounds_like.length === b.sounds_like.length && a.sounds_like.every((s, i) => s === b.sounds_like[i]);

/**
 * What turns Hex's list (`have`) into the file's (`want`): the entries that
 * already match from the front stay, and from the first that differs every
 * remaining entry of Hex's is removed and every remaining one of the file's
 * added, in order — Hex's `add` appends, and merges spellings rather than
 * replacing them, so an entry that changed at all has to go and come back.
 * Nothing to do when the two are the same, so running it twice does nothing
 * the second time. Pure.
 */
export function vocabularyPlan(have: readonly VocabularyEntry[], want: readonly VocabularyEntry[]): { remove: string[]; add: VocabularyEntry[] } {
  let keep = 0;
  while (keep < have.length && keep < want.length && same(have[keep]!, want[keep]!)) keep++;
  return { remove: have.slice(keep).map((e) => e.term), add: want.slice(keep).map((e) => ({ term: e.term, sounds_like: [...e.sounds_like] })) };
}
