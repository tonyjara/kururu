/**
 * Each machine's specs, kept: the last reading off it, what the user typed
 * beside it, and its history, in `specs.json` — and the decision of when to
 * read a machine again.
 *
 * On disk rather than in memory beside the gauges, because the reading is
 * wanted most on the day the machine will not answer: a PC that stopped
 * turning on, a VPS that dropped off the tailnet. The gauges are about now
 * and may forget; this is about what is in the box, and must not.
 *
 * A config file and not the database, though what is typed here is the
 * user's own and cannot be made again: it is a few kilobytes per machine,
 * nothing searches it, and `shared/backup.ts` names it, so it goes to the
 * private repository with `vps.json` beside it. Keyed by machine id, with a
 * copy of the host, and never deleted with the machine: what was typed about
 * a box is not the same decision as watching it, and a machine removed and
 * added again under the same host finds its specs where it left them
 * (`adoptSpecs`).
 *
 * When to read: a reading costs the machine a second or two, and hardware
 * does not move, so not on the gauges' fifteen seconds. A machine is read
 * when it has never been, when its reading is six hours old, and the moment
 * it answers again after not answering — because a swap means the machine
 * was off, and that is the reading that finds it. A reading that failed is
 * not tried again for ten minutes unless the machine comes back in between,
 * so a box that answers the gauges and not this (a Mac, which has no
 * `lscpu`) is not asked every poll.
 */
import { randomUUID } from "node:crypto";

import type { MachineEntry, MachineStatus } from "../../shared/machines";
import {
  adoptSpecsFile,
  changesBetween,
  cleanTyped,
  HISTORY_MAX,
  HISTORY_TEXT_MAX,
  isTypedKey,
  localDay,
  parseSpecs,
  sortHistory,
  SPECS_MAX_AGE_MS,
  validHistoryDate,
  type HistoryEntry,
  type MachineSpecs,
  type StoredSpecs,
} from "../../shared/specs";
import { readConfigFile, writeConfigFile } from "./config";
import { findMachine, hardwareOn } from "./machines";

const FILE = "specs.json";

/** How long a failed reading waits before the poll tries it again. */
const RETRY_MS = 10 * 60 * 1000;

let stored: Record<string, StoredSpecs> = adoptSpecsFile(readConfigFile(FILE));
const busy = new Set<string>();
const errors = new Map<string, string>();
const tried = new Map<string, number>();
/** Whether each machine answered the last poll. Unknown after a start, which is not "came back". */
const answered = new Map<string, boolean>();

function save(): void {
  writeConfigFile(FILE, { machines: stored });
}

/** The machine's record, made when it has none, its host and name brought up to date. */
function recordOf(machine: MachineEntry): StoredSpecs {
  const have = stored[machine.id];
  if (have) {
    have.host = machine.host;
    have.name = machine.name;
    return have;
  }
  const made: StoredSpecs = { host: machine.host, name: machine.name, typed: {}, history: [], reading: null };
  stored[machine.id] = made;
  return made;
}

export function specsSnapshot(machines: readonly MachineEntry[]): Record<string, MachineSpecs> {
  const out: Record<string, MachineSpecs> = {};
  for (const machine of machines) {
    const s = stored[machine.id];
    out[machine.id] = {
      typed: s?.typed ?? {},
      history: sortHistory(s?.history ?? []),
      reading: s?.reading ?? null,
      busy: busy.has(machine.id),
      error: errors.get(machine.id) ?? null,
    };
  }
  return out;
}

/**
 * A machine just added takes the specs of one removed under the same host,
 * if nothing else has. Only from a record no machine in the list holds, so
 * two aliases for one box never trade.
 */
export function adoptSpecs(machine: MachineEntry, machines: readonly MachineEntry[]): void {
  if (stored[machine.id]) return;
  const held = new Set(machines.map((m) => m.id));
  const orphan = Object.entries(stored).find(([id, s]) => !held.has(id) && s.host === machine.host);
  if (!orphan) return;
  delete stored[orphan[0]];
  stored[machine.id] = orphan[1];
  recordOf(machine);
  save();
}

/** A machine stopped being watched: what is kept stays, what was only about this run goes. */
export function forgetSpecsRun(id: string): void {
  busy.delete(id);
  errors.delete(id);
  tried.delete(id);
  answered.delete(id);
}

/** Set one typed field; blank removes it. Throws a sentence for a key that is not one. */
export function setTyped(machine: MachineEntry, key: unknown, value: unknown): void {
  if (!isTypedKey(key)) throw new Error("That is not something kururu keeps about a machine.");
  const record = recordOf(machine);
  const clean = cleanTyped(key, value);
  if ((record.typed[key] ?? "") === clean) return;
  if (clean) record.typed[key] = clean;
  else delete record.typed[key];
  save();
}

function historyText(text: unknown): string {
  const clean = typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, HISTORY_TEXT_MAX) : "";
  if (!clean) throw new Error("Say what changed.");
  return clean;
}

function historyDate(date: unknown): string {
  const clean = validHistoryDate(date);
  if (clean === null) throw new Error("A date is 2026, 2026-10 or 2026-10-31.");
  return clean;
}

/** Keep the newest `HISTORY_MAX`, by date. */
function bounded(entries: HistoryEntry[]): HistoryEntry[] {
  if (entries.length <= HISTORY_MAX) return entries;
  const keep = new Set(sortHistory(entries).slice(0, HISTORY_MAX).map((e) => e.id));
  return entries.filter((e) => keep.has(e.id));
}

export function addHistory(machine: MachineEntry, date: unknown, text: unknown): HistoryEntry {
  const record = recordOf(machine);
  const entry: HistoryEntry = { id: randomUUID().slice(0, 8), date: historyDate(date), text: historyText(text), by: "you" };
  record.history = bounded([...record.history, entry]);
  save();
  return entry;
}

/** A line's date or words, or both. A line a reading wrote becomes the user's once they have edited it. */
export function editHistory(machine: MachineEntry, entryId: unknown, change: { date?: unknown; text?: unknown }): void {
  const record = recordOf(machine);
  const entry = record.history.find((e) => e.id === entryId);
  if (!entry) throw new Error("That line is not in the history any more.");
  const date = change.date === undefined ? entry.date : historyDate(change.date);
  const text = change.text === undefined ? entry.text : historyText(change.text);
  if (date === entry.date && text === entry.text) return;
  record.history = record.history.map((e) => (e.id === entry.id ? { ...e, date, text, by: "you" } : e));
  save();
}

export function removeHistory(machine: MachineEntry, entryId: unknown): void {
  const record = recordOf(machine);
  const before = record.history.length;
  record.history = record.history.filter((e) => e.id !== entryId);
  if (record.history.length !== before) save();
}

/**
 * Read a machine now. `changed` is told when it starts and when it ends, so
 * a window can say "Reading…" and then draw what came back. Resolves with
 * the error in a sentence, or null when a reading was kept.
 */
export async function readSpecs(machine: MachineEntry, changed: () => void): Promise<string | null> {
  if (busy.has(machine.id)) return null;
  busy.add(machine.id);
  tried.set(machine.id, Date.now());
  changed();
  let error: string | null = null;
  try {
    const result = await hardwareOn(machine.host);
    // Removed while it was in flight: nobody is drawing it, and its record stays as it was.
    if (!findMachine(machine.id)) return null;
    if (!result.ok) {
      error = result.error;
      return error;
    }
    const now = Date.now();
    const reading = parseSpecs(result.text, now);
    if (!reading) {
      error = "It answered, but nothing it said could be read. Specs are read from Linux: lscpu, /proc and /sys.";
      return error;
    }
    const record = recordOf(machine);
    const lines = record.reading ? changesBetween(record.reading, reading) : [];
    if (lines.length) {
      const day = localDay(now);
      record.history = bounded([...record.history, ...lines.map((text): HistoryEntry => ({ id: randomUUID().slice(0, 8), date: day, text, by: "read" }))]);
    }
    record.reading = reading;
    save();
    return null;
  } finally {
    busy.delete(machine.id);
    if (error) errors.set(machine.id, error);
    else errors.delete(machine.id);
    changed();
  }
}

/**
 * After a poll of the gauges: the machines to read now. A machine answered
 * the poll when it has a reading and no error; one that did not is left
 * alone, and remembered as not answering, so the next poll it does answer
 * reads it straight away.
 */
export function dueForReading(statuses: readonly MachineStatus[], now: number): MachineEntry[] {
  const due: MachineEntry[] = [];
  for (const status of statuses) {
    const ok = status.error === null && status.reading !== null;
    const was = answered.get(status.id);
    answered.set(status.id, ok);
    if (!ok || busy.has(status.id)) continue;
    const cameBack = was === false;
    const last = stored[status.id]?.reading?.at ?? 0;
    const lastTry = tried.get(status.id) ?? 0;
    const failedLately = errors.has(status.id) && now - lastTry < RETRY_MS;
    if (cameBack || (now - last > SPECS_MAX_AGE_MS && !failedLately)) due.push(status);
  }
  return due;
}
