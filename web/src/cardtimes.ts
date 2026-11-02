/**
 * When a card in Needs you was written, and when it came into the column, as
 * the line an open card shows. The user asked of a card there "since when?",
 * and the history kururu keeps already knew; this is the wording.
 *
 * Absolute times in the reader's own locale and zone — "2 Nov, 14:32" in one,
 * "Nov 2, 2:32 PM" in another — rather than "3d ago", because the question is
 * usually which of two things came first or whether it was before a meeting,
 * and a relative age that changes under you answers neither. The relative age
 * is still there, as the line's hover, the way the board says it elsewhere.
 * The year only when it is not this one.
 *
 * Pure, with the locale and zone as arguments, so the tests pin both.
 */

/** Closer than this and the two times are one fact: a card written straight into Needs you. */
const SAME_MS = 60_000;

export interface CardTimes {
  added: string;
  /** Absent when the card was written in Needs you, or when nobody can say when it came. */
  since?: string;
}

export function stamp(at: number, now: number, locale?: string, timeZone?: string): string {
  const year = (t: number) => new Intl.DateTimeFormat("en", { year: "numeric", timeZone }).format(t);
  // The day and the time apart and joined here, since ICU versions disagree on
  // the joint — "2 Nov, 14:32" in one, "2 Nov at 14:32" in the next — and the
  // window and the tests run different ones.
  const day = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", ...(year(at) === year(now) ? {} : { year: "numeric" }), timeZone }).format(at);
  const time = new Intl.DateTimeFormat(locale, { timeStyle: "short", timeZone }).format(at);
  return `${day}, ${time}`;
}

export function cardTimes(createdAt: number, needsSince: number | undefined, now: number, locale?: string, timeZone?: string): CardTimes {
  const added = stamp(createdAt, now, locale, timeZone);
  if (needsSince === undefined || !Number.isFinite(needsSince) || needsSince - createdAt < SAME_MS) return { added };
  return { added, since: stamp(needsSince, now, locale, timeZone) };
}
