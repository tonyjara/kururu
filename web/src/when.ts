/**
 * What a card's dates are called, in the words of whoever is looking.
 *
 * Apart from `shared/days.ts` because that file is arithmetic the server runs
 * too, and this is `Intl`: the month's name and which day a week begins on
 * are the browser's to say, and differ between the desk and the phone without
 * either being wrong. Nothing here decides anything — a label is worked out
 * where it is drawn and is never sent anywhere.
 *
 * Every formatter is pinned to UTC, which is the other half of the rule in
 * `days.ts`: a day is turned into a moment only to be handed to `Intl`, the
 * moment is that day's midnight in UTC, and a formatter left in local time
 * would call it the evening before anywhere west of Greenwich.
 */
import type { CardDates } from "../../shared/board";
import { dayNumber, today, type Day } from "../../shared/days";

const MS = 86_400_000;

const short = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const dated = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const month = new Intl.DateTimeFormat(undefined, { month: "short", timeZone: "UTC" });
const letter = new Intl.DateTimeFormat(undefined, { weekday: "narrow", timeZone: "UTC" });
const full = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

const at = (number: number) => new Date(number * MS);
const yearOf = (number: number) => at(number).getUTCFullYear();

/** `Sep 30`, and the year as well once it is not this one — where leaving it off would be a different day. */
export function dayLabel(number: number, now: Day): string {
  return (yearOf(number) === Number(now.slice(0, 4)) ? short : dated).format(at(number));
}

/** A card's dates in a line: one day, or the two ends with a dash between. */
export function datesLabel(dates: CardDates, now: Day = today(new Date())): string {
  const from = dayNumber(dates.start);
  const to = dayNumber(dates.end);
  if (from === null || to === null) return "";
  return from === to ? dayLabel(from, now) : `${dayLabel(from, now)} – ${dayLabel(to, now)}`;
}

/**
 * Whether a card's dates are behind, around, or ahead of today. Not "overdue":
 * nothing on a board says a card is finished except the name of a column a
 * person made, so a date that has passed is only a date that has passed.
 */
export function datesTense(dates: CardDates, now: Day = today(new Date())): "past" | "now" | "ahead" {
  if (dates.end < now) return "past";
  return dates.start > now ? "ahead" : "now";
}

export const monthLabel = (number: number) => month.format(at(number));
export const weekdayLetter = (number: number) => letter.format(at(number));
export const dayOfMonth = (number: number) => at(number).getUTCDate();
export const dayInFull = (number: number) => full.format(at(number));

/**
 * The day this person's week begins on, Sunday as 0. `weekInfo` is the
 * browser's answer and not every browser has one — Firefox does not — so
 * Monday is what is assumed without it, being ISO's and most of the world's.
 */
export function firstWeekday(): number {
  try {
    const locale = new Intl.Locale(navigator.language) as Intl.Locale & {
      weekInfo?: { firstDay?: number };
      getWeekInfo?: () => { firstDay?: number };
    };
    const first = (locale.getWeekInfo?.() ?? locale.weekInfo)?.firstDay;
    // `weekInfo` counts Monday as 1 and Sunday as 7.
    if (typeof first === "number" && Number.isInteger(first) && first >= 1 && first <= 7) return first % 7;
  } catch {
    // A language tag `Intl.Locale` will not take. Monday.
  }
  return 1;
}
