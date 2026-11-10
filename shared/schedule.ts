/**
 * When an automation runs, as one line of words held to a grammar.
 *
 * Cron is not the primary spelling, for three reasons the plan gives
 * (`docs/plans/automations.md`): it cannot say "every second Monday", its
 * day-of-month and day-of-week fields combine in a way that surprises
 * everyone once, and it has no time zone. So the line reads as words:
 *
 * ```
 * every <n> <minutes|hours|days|weeks|months> [on <days>] [at <HH:MM>] <zone> [from <YYYY-MM-DD>]
 * cron <five fields> <zone>
 * once <YYYY-MM-DD> <HH:MM> <zone>
 * manual
 * ```
 *
 * **The zone is part of the schedule.** An IANA name, never the host's own
 * clock: "09:00 America/Asuncion" is that on every host, which is T3 Code's
 * issue #18632 (times in the server's zone, shown with no label) avoided by
 * construction. The arithmetic goes through `Intl.DateTimeFormat`, which
 * Node and every browser carry, so the server and the form's preview of the
 * next five runs are the same code.
 *
 * **`from` is the anchor.** It fixes the first run and which weeks are the
 * on-weeks. Without it the caller passes the day the automation was made,
 * which the server stores, so an edit or a restart never flips the
 * alternation.
 *
 * **Daylight saving.** A wall time that does not exist on a day (the hour a
 * spring-forward skips) fires at the next minute that does; one that happens
 * twice (the hour a fall-back repeats) fires once, the first time. Minutes
 * and hours are elapsed time from the anchor, not wall time: "every 2 hours"
 * stays two hours apart across a change of clocks.
 *
 * Pure: no clock is read here. Every function takes the moment to count from.
 */
import { dayAt, dayNumber, weekday, weekStart } from "./days";

export type Unit = "minutes" | "hours" | "days" | "weeks" | "months";

export type Schedule =
  | {
      kind: "every";
      n: number;
      unit: Unit;
      /** Weekdays (Sunday as 0) for days and weeks; day numbers, with -1 for the last, for months. Null for the anchor's own. */
      on: number[] | null;
      /** Minutes into the day. Required for days, weeks and months; the anchor's time of day for minutes and hours. */
      at: number | null;
      zone: string;
      from: string | null;
    }
  | {
      kind: "cron";
      minutes: number[];
      hours: number[];
      /** Null when the field is `*`, which matters to how it combines with `dows`. */
      doms: number[] | null;
      months: number[];
      dows: number[] | null;
      zone: string;
      fields: string;
    }
  | { kind: "once"; day: string; at: number; zone: string }
  | { kind: "manual" };

export type Parsed = { ok: true; schedule: Schedule } | { ok: false; error: string };

/** Nothing fires more often than this. A schedule that would is refused in words. */
export const FLOOR_MINUTES = 5;

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] as const;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let found = formatters.get(zone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    formatters.set(zone, found);
  }
  return found;
}

/**
 * The zone's own spelling of a name, or null for one that is not a zone.
 * Held to a shape first, so the line never carries anything that would need
 * escaping where it is shown or written, and then asked of `Intl`, which
 * throws for a name it does not know.
 */
export function canonicalZone(name: string): string | null {
  if (!/^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+){0,2}$/.test(name)) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** The wall clock in a zone at an instant: the day's number and the minutes into it. */
export function wallOf(at: number, zone: string): { day: number; minute: number } {
  const parts = formatter(zone).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  const day = dayNumber(`${String(get("year")).padStart(4, "0")}-${String(get("month")).padStart(2, "0")}-${String(get("day")).padStart(2, "0")}`);
  return { day: day ?? Math.floor(at / DAY), minute: get("hour") * 60 + get("minute") };
}

/** The wall clock as one comparable number: a day's midnight in pretend-UTC plus the minutes. */
function wallMs(at: number, zone: string): number {
  const wall = wallOf(at, zone);
  return wall.day * DAY + wall.minute * MINUTE;
}

/**
 * The instant a wall time in a zone names. Each offset seen in the two days
 * around it is tried; one that reads back as the same wall time is an
 * answer, and the earliest of those wins, which is how an hour that happens
 * twice fires once. When none does, the wall time fell in a gap, and the
 * answer is the first minute after the gap, found by halving between the
 * two candidates.
 */
export function instantOf(day: number, minute: number, zone: string): number {
  const local = day * DAY + minute * MINUTE;
  const offsets = new Set<number>();
  for (const probe of [local - DAY, local, local + DAY]) offsets.add(wallMs(probe, zone) - Math.floor(probe / MINUTE) * MINUTE);
  const candidates = [...offsets].map((offset) => local - offset);
  const exact = candidates.filter((at) => wallMs(at, zone) === local);
  if (exact.length) return Math.min(...exact);
  let lo = Math.min(...candidates);
  let hi = Math.max(...candidates);
  if (wallMs(hi, zone) < local) return hi;
  while (hi - lo > MINUTE) {
    const mid = lo + Math.floor((hi - lo) / 2 / MINUTE) * MINUTE;
    if (wallMs(mid, zone) >= local) hi = mid;
    else lo = mid;
  }
  return hi;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function clock(text: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  return h < 24 && m < 60 ? h * 60 + m : null;
}

function unitOf(word: string): Unit | null {
  const plain = word.toLowerCase().replace(/s$/, "");
  return plain === "minute" || plain === "hour" || plain === "day" || plain === "week" || plain === "month" ? (`${plain}s` as Unit) : null;
}

function weekdayOf(word: string): number | null {
  const at = WEEKDAYS.indexOf(word.toLowerCase().slice(0, 3) as (typeof WEEKDAYS)[number]);
  if (at < 0) return null;
  const full = WEEKDAY_NAMES[at]!.toLowerCase();
  return full.startsWith(word.toLowerCase()) ? at : null;
}

/** `mon,wed`, `mon-fri`, `monday`: the weekdays, or why not. */
function weekdays(list: string): number[] | string {
  const days = new Set<number>();
  for (const piece of list.split(",").filter(Boolean)) {
    const [from, to, extra] = piece.split("-");
    const a = weekdayOf(from ?? "");
    const b = to === undefined ? a : weekdayOf(to);
    if (a === null || b === null || extra !== undefined) return `"${piece}" is not a day of the week (mon, tue, … or a range like mon-fri)`;
    for (let d = a; ; d = (d + 1) % 7) {
      days.add(d);
      if (d === b) break;
    }
  }
  return days.size ? [...days].sort((x, y) => x - y) : "say which days after on";
}

/** `1,15`, `last`: days of the month, -1 for the last, or why not. */
function monthDays(list: string): number[] | string {
  const days = new Set<number>();
  for (const piece of list.split(",").filter(Boolean)) {
    if (piece.toLowerCase() === "last") {
      days.add(-1);
      continue;
    }
    const n = /^\d{1,2}$/.test(piece) ? Number(piece) : NaN;
    if (!(n >= 1 && n <= 31)) return `"${piece}" is not a day of the month (1 to 31, or last)`;
    days.add(n);
  }
  return days.size ? [...days].sort((x, y) => (x === -1 ? 1 : y === -1 ? -1 : x - y)) : "say which days after on";
}

function isKeyword(word: string): boolean {
  return word === "on" || word === "at" || word === "from";
}

/** The line, read; or the first thing wrong with it, in words. */
export function parseSchedule(text: string): Parsed {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const head = words[0]?.toLowerCase();
  const fail = (error: string): Parsed => ({ ok: false, error });
  if (!head) return fail("say when: every 2 weeks on mon at 09:00 America/Asuncion, cron …, once …, or manual");
  if (head === "manual") return words.length === 1 ? { ok: true, schedule: { kind: "manual" } } : fail("manual takes nothing after it");

  if (head === "once") {
    if (words.length !== 4) return fail("once takes a day, a time and a zone: once 2026-11-23 09:00 America/Asuncion");
    const day = words[1]!;
    if (dayNumber(day) === null) return fail(`"${day}" is not a day (YYYY-MM-DD)`);
    const at = clock(words[2]!);
    if (at === null) return fail(`"${words[2]}" is not a time (HH:MM, 24-hour)`);
    const zone = canonicalZone(words[3]!);
    if (!zone) return fail(`"${words[3]}" is not a time zone (an IANA name, like America/Asuncion or UTC)`);
    return { ok: true, schedule: { kind: "once", day, at, zone } };
  }

  if (head === "cron") {
    if (words.length !== 7) return fail("cron takes five fields and a zone: cron 0 9 * * mon America/Asuncion");
    const zone = canonicalZone(words[6]!);
    if (!zone) return fail(`"${words[6]}" is not a time zone (an IANA name, like America/Asuncion or UTC)`);
    return parseCron(words.slice(1, 6), zone);
  }

  if (head !== "every") return fail(`a schedule starts with every, cron, once or manual, not "${words[0]}"`);
  let i = 1;
  let n = 1;
  if (/^\d+$/.test(words[i] ?? "")) n = Number(words[i++]);
  const unit = unitOf(words[i] ?? "");
  if (!unit) return fail(`after every comes a count and minutes, hours, days, weeks or months, not "${words[i] ?? ""}"`);
  i++;
  if (!Number.isFinite(n) || n < 1 || n > 1000) return fail("the count is a whole number from 1 to 1000");
  if (unit === "minutes" && n < FLOOR_MINUTES) return fail(`nothing runs more often than every ${FLOOR_MINUTES} minutes`);

  let on: number[] | null = null;
  let at: number | null = null;
  let zone: string | null = null;
  let from: string | null = null;
  while (i < words.length) {
    const word = words[i]!;
    const key = word.toLowerCase();
    if (key === "on") {
      const list: string[] = [];
      i++;
      while (i < words.length && !isKeyword(words[i]!.toLowerCase()) && (list.length === 0 || /,$/.test(list.at(-1)!) || /^,/.test(words[i]!))) list.push(words[i++]!);
      const joined = list.join("");
      if (unit === "minutes" || unit === "hours") return fail("on is for days, weeks and months");
      if (unit === "days" && n > 1) return fail("on with days is for every day; for every few weeks use weeks");
      const days = unit === "months" ? monthDays(joined) : weekdays(joined);
      if (typeof days === "string") return fail(days);
      on = days;
      continue;
    }
    if (key === "at") {
      const value = clock(words[i + 1] ?? "");
      if (value === null) return fail(`"${words[i + 1] ?? ""}" is not a time (HH:MM, 24-hour)`);
      at = value;
      i += 2;
      continue;
    }
    if (key === "from") {
      const day = words[i + 1] ?? "";
      if (dayNumber(day) === null) return fail(`"${day}" is not a day (YYYY-MM-DD)`);
      from = day;
      i += 2;
      continue;
    }
    if (zone) return fail(`"${word}" is not part of the schedule`);
    zone = canonicalZone(word);
    if (!zone) return fail(`"${word}" is not a time zone (an IANA name, like America/Asuncion or UTC)`);
    i++;
  }
  if (!zone) return fail("say which time zone, like America/Asuncion or UTC");
  if (at === null && (unit === "days" || unit === "weeks" || unit === "months")) return fail("say when in the day: at 09:00");
  return { ok: true, schedule: { kind: "every", n, unit, on, at, zone, from } };
}

/** One cron field: `*`, lists, ranges, steps, and names where the field has them. */
function cronField(field: string, lo: number, hi: number, names?: readonly string[]): number[] | string {
  const values = new Set<number>();
  const value = (text: string): number | null => {
    if (/^\d+$/.test(text)) return Number(text);
    const at = names?.indexOf(text.toLowerCase().slice(0, 3)) ?? -1;
    return at >= 0 ? at + (lo === 1 ? 1 : 0) : null;
  };
  for (const piece of field.split(",")) {
    const [range, stepText, extra] = piece.split("/");
    if (extra !== undefined || range === undefined) return `"${field}" is not a cron field`;
    const step = stepText === undefined ? 1 : /^\d+$/.test(stepText) ? Number(stepText) : NaN;
    if (!(step >= 1)) return `"${field}" is not a cron field`;
    let a: number | null;
    let b: number | null;
    if (range === "*") {
      a = lo;
      b = hi;
    } else {
      const [x, y, more] = range.split("-");
      if (more !== undefined) return `"${field}" is not a cron field`;
      a = value(x ?? "");
      b = y === undefined ? (stepText === undefined ? a : hi) : value(y);
    }
    if (a === null || b === null || a < lo || b > hi || a > b) return `"${field}" is out of range (${lo} to ${hi})`;
    for (let v = a; v <= b; v += step) values.add(v);
  }
  return [...values].sort((x, y) => x - y);
}

function parseCron(fields: string[], zone: string): Parsed {
  const minutes = cronField(fields[0]!, 0, 59);
  const hours = cronField(fields[1]!, 0, 23);
  const doms = cronField(fields[2]!, 1, 31);
  const months = cronField(fields[3]!, 1, 12, MONTHS);
  // Sunday is 0 and 7 alike, as every cron has it.
  const dowsRaw = cronField(fields[4]!.replace(/\b7\b/g, "0"), 0, 6, WEEKDAYS);
  for (const field of [minutes, hours, doms, months, dowsRaw]) if (typeof field === "string") return { ok: false, error: field };
  const mins = minutes as number[];
  // Every minute of a day the line can fire at, and the gap between each
  // and the next, round past midnight as if every day matched.
  const times = (hours as number[]).flatMap((h) => mins.map((m) => h * 60 + m));
  for (let k = 0; k < times.length; k++) {
    const gap = k + 1 < times.length ? times[k + 1]! - times[k]! : times[0]! + 1440 - times[k]!;
    if (times.length > 1 && gap < FLOOR_MINUTES) return { ok: false, error: `nothing runs more often than every ${FLOOR_MINUTES} minutes` };
  }
  return {
    ok: true,
    schedule: {
      kind: "cron",
      minutes: mins,
      hours: hours as number[],
      doms: fields[2] === "*" ? null : (doms as number[]),
      months: months as number[],
      dows: fields[4] === "*" ? null : (dowsRaw as number[]),
      zone,
      fields: fields.join(" "),
    },
  };
}

// ---------------------------------------------------------------------------
// When
// ---------------------------------------------------------------------------

function monthLength(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

function ymd(day: number): { y: number; m0: number; d: number } {
  const date = new Date(day * DAY);
  return { y: date.getUTCFullYear(), m0: date.getUTCMonth(), d: date.getUTCDate() };
}

/**
 * The first slot strictly after `after`, or null when there is none (a
 * `once` already past, `manual`, or a combination no calendar reaches).
 * `anchor` is the stored day the automation was made, used when the line
 * has no `from`.
 */
export function nextRun(schedule: Schedule, after: number, anchor: string): number | null {
  if (!Number.isFinite(after)) return null;
  switch (schedule.kind) {
    case "manual":
      return null;
    case "once": {
      const at = instantOf(dayNumber(schedule.day)!, schedule.at, schedule.zone);
      return at > after ? at : null;
    }
    case "cron":
      return nextCron(schedule, after);
    case "every":
      return nextEvery(schedule, after, anchor);
  }
}

function nextEvery(s: Extract<Schedule, { kind: "every" }>, after: number, anchor: string): number | null {
  const anchorDay = dayNumber(s.from ?? anchor);
  if (anchorDay === null) return null;
  if (s.unit === "minutes" || s.unit === "hours") {
    const period = s.n * (s.unit === "minutes" ? MINUTE : HOUR);
    const start = instantOf(anchorDay, s.at ?? 0, s.zone);
    if (after < start) return start;
    return start + (Math.floor((after - start) / period) + 1) * period;
  }
  const at = s.at ?? 0;
  const startDay = Math.max(anchorDay, wallOf(after, s.zone).day - 1);
  if (s.unit === "days") {
    for (let d = startDay, k = 0; k < 7 * s.n + 14; d++, k++) {
      if ((d - anchorDay) % s.n !== 0) continue;
      if (s.on && !s.on.includes(weekday(d))) continue;
      const t = instantOf(d, at, s.zone);
      if (t > after) return t;
    }
    return null;
  }
  if (s.unit === "weeks") {
    const on = s.on ?? [weekday(anchorDay)];
    const anchorWeek = weekStart(anchorDay, 1);
    for (let d = startDay, k = 0; k < 7 * s.n + 14; d++, k++) {
      if (((weekStart(d, 1) - anchorWeek) / 7) % s.n !== 0) continue;
      if (!on.includes(weekday(d))) continue;
      const t = instantOf(d, at, s.zone);
      if (t > after) return t;
    }
    return null;
  }
  // Months: the month's index from the anchor's, every n-th, each day asked for.
  const a = ymd(anchorDay);
  const on = s.on ?? [a.d];
  const first = ymd(startDay);
  for (let k = 0, index = first.y * 12 + first.m0; k < 24 * s.n + 24; k++, index++) {
    if ((index - (a.y * 12 + a.m0)) % s.n !== 0) continue;
    const y = Math.floor(index / 12);
    const m0 = index % 12;
    const length = monthLength(y, m0);
    // A day the month does not have is skipped, as cron skips it; `last` is the way to say the end.
    const days = [...new Set(on.map((d) => (d === -1 ? length : d)).filter((d) => d <= length))].sort((x, z) => x - z);
    for (const d of days) {
      const day = Math.round(Date.UTC(y, m0, d) / DAY);
      if (day < anchorDay) continue;
      const t = instantOf(day, at, s.zone);
      if (t > after) return t;
    }
  }
  return null;
}

/**
 * Cron's rule for the two day fields, kept because it is what a line copied
 * from anywhere else means: when both are restricted, a day matches either;
 * when one is `*`, only the other counts.
 */
function nextCron(s: Extract<Schedule, { kind: "cron" }>, after: number): number | null {
  const startDay = wallOf(after, s.zone).day - 1;
  for (let d = startDay, k = 0; k < 366 * 8; d++, k++) {
    const { m0, d: dom } = ymd(d);
    if (!s.months.includes(m0 + 1)) continue;
    const domOk = s.doms === null || s.doms.includes(dom);
    const dowOk = s.dows === null || s.dows.includes(weekday(d));
    const dayOk = s.doms !== null && s.dows !== null ? domOk || dowOk : domOk && dowOk;
    if (!dayOk) continue;
    for (const h of s.hours) {
      for (const m of s.minutes) {
        const t = instantOf(d, h * 60 + m, s.zone);
        if (t > after) return t;
      }
    }
  }
  return null;
}

/**
 * The most recent slot at or before `now`, walking on from one that has come
 * round (`due`), and how many it passed on the way: the clock considers only
 * the newest missed slot and says how many went by. Minutes and hours are
 * stepped by arithmetic, since a week asleep is two thousand five-minute
 * slots; the rest walk, which is a handful a year.
 */
export function latestSlot(schedule: Schedule, due: number, now: number, anchor: string): { slot: number; passed: number } {
  if (schedule.kind === "every" && (schedule.unit === "minutes" || schedule.unit === "hours") && now > due) {
    const period = schedule.n * (schedule.unit === "minutes" ? MINUTE : HOUR);
    const passed = Math.floor((now - due) / period);
    return { slot: due + passed * period, passed };
  }
  let slot = due;
  let passed = 0;
  for (let k = 0; k < 100_000; k++) {
    const next = nextRun(schedule, slot, anchor);
    if (next === null || next > now) break;
    slot = next;
    passed++;
  }
  return { slot, passed };
}

/** The next five slots after a moment: what the form shows before anything is saved. */
export function nextFive(schedule: Schedule, after: number, anchor: string): number[] {
  const out: number[] = [];
  let at = after;
  while (out.length < 5) {
    const next = nextRun(schedule, at, anchor);
    if (next === null) break;
    out.push(next);
    at = next;
  }
  return out;
}

/**
 * Whether a schedule runs at most once a day, which is what decides the
 * catch-up window an automation gets when it names none: half a day for a
 * daily or slower one, and none for anything faster, whose next slot is
 * never far off.
 */
export function dailyOrSlower(schedule: Schedule): boolean {
  switch (schedule.kind) {
    case "manual":
    case "once":
      return true;
    case "cron":
      return schedule.minutes.length === 1 && schedule.hours.length === 1;
    case "every":
      return schedule.unit === "days" || schedule.unit === "weeks" || schedule.unit === "months" || (schedule.unit === "hours" && schedule.n >= 24);
  }
}

/** The zone a schedule is in, or null for `manual`. */
export function zoneOf(schedule: Schedule): string | null {
  return schedule.kind === "manual" ? null : schedule.zone;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

function hhmm(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function dayWords(day: string): string {
  const { y, m0, d } = ymd(dayNumber(day)!);
  return `${d} ${MONTH_NAMES[m0]} ${y}`;
}

function listWords(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function ordinal(n: number): string {
  const tail = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${tail}`;
}

/** The schedule as a sentence, with its zone, for a row's tooltip and the sheet. */
export function inWords(schedule: Schedule): string {
  switch (schedule.kind) {
    case "manual":
      return "only when run by hand";
    case "once":
      return `once, on ${dayWords(schedule.day)} at ${hhmm(schedule.at)} ${schedule.zone}`;
    case "cron":
      return `cron ${schedule.fields}, ${schedule.zone}`;
    case "every": {
      const singular = schedule.unit.slice(0, -1);
      let text = schedule.n === 1 ? `every ${singular}` : `every ${schedule.n} ${schedule.unit}`;
      if (schedule.on) {
        text +=
          schedule.unit === "months"
            ? ` on the ${listWords(schedule.on.map((d) => (d === -1 ? "last day" : ordinal(d))))}`
            : ` on ${listWords(schedule.on.map((d) => WEEKDAY_NAMES[d]!))}`;
      }
      if (schedule.at !== null) text += ` at ${hhmm(schedule.at)}`;
      text += ` ${schedule.zone}`;
      if (schedule.from) text += `, from ${dayWords(schedule.from)}`;
      return text;
    }
  }
}

/** A slot as a short label in a zone: `Mon 23 Nov, 09:00`. The zone is said beside it by the caller. */
export function slotLabel(at: number, zone: string): string {
  const { day, minute } = wallOf(at, zone);
  const { m0, d } = ymd(day);
  return `${WEEKDAY_NAMES[weekday(day)]!.slice(0, 3)} ${d} ${MONTH_NAMES[m0]}, ${hhmm(minute)}`;
}

/** Today in a zone, as the anchor a schedule with no `from` is stored with. */
export function todayIn(zone: string | null, now: number): string {
  return dayAt(wallOf(now, zone ?? "UTC").day);
}
