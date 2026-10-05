/**
 * Calendar days, as a card keeps them: `2026-09-28`, a string, and the
 * arithmetic a timeline needs over them.
 *
 * It exists because a card's date is a *day* and not a moment. The obvious
 * thing to store is a timestamp, and a timestamp is a day only in the timezone
 * it was written in: midnight on the desk is eight in the evening of the day
 * before on a phone that has flown somewhere, and the card planned for Tuesday
 * is drawn on Monday by the one client that is supposed to be for glancing at
 * the plan. A day written down as a day is Tuesday everywhere.
 *
 * The arithmetic is done on a count of days since 1970-01-01 rather than on
 * `Date`s, and in UTC, which has no daylight saving: adding 86 400 000
 * milliseconds to a local midnight is the day after on all but two days a
 * year, and on those it is the same day again or the one after next. The one
 * function here that reads a clock in local time is `today`, because which day
 * it is *is* a local question.
 *
 * Pure, and free of `Intl`: what a day is called is the window's business, and
 * the server only ever needs to know whether one is real.
 */

export type Day = string;

const SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS = 86_400_000;

/**
 * The count of days from 1970-01-01 to this one, or null for anything that is
 * not a day. `Date.UTC` rolls the thirtieth of February over into March
 * rather than refusing it, so the answer is read back and compared — a date
 * that does not survive the round trip was never on a calendar.
 */
export function dayNumber(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = SHAPE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const at = new Date(Date.UTC(year, month - 1, date));
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== date) return null;
  return Math.round(at.getTime() / MS);
}

/** The day a count names. The inverse of `dayNumber`, for the counts that one can return. */
export function dayAt(number: number): Day {
  return new Date(number * MS).toISOString().slice(0, 10);
}

/** Which day it is, where the person looking is. */
export function today(now: Date): Day {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

/** The day of the week a count falls on, Sunday as 0. 1970 began on a Thursday. */
export function weekday(number: number): number {
  return (((number + 4) % 7) + 7) % 7;
}

/** The first day of the week a count is in, for a week that starts on `first` — Sunday as 0. */
export function weekStart(number: number, first: number): number {
  return number - ((((weekday(number) - first) % 7) + 7) % 7);
}
