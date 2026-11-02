/**
 * Slots: the lanes several agents queue in to use the expensive parts of one
 * Mac — a native build, a simulator booting, a UI test driving one, a heavy
 * suite, the phone on the cable — and the rule that says who goes next.
 *
 * It exists because the alternative was a lock, and then a script. A lock in
 * `mkdir` serialised a 24-second test behind a 20-minute build, had no idea
 * who was waiting or why, and was released when its holder remembered to:
 * an agent that died holding it held it for the 45 minutes of its stale rule.
 * The `ios-q` script fixed the shape — lanes of their own widths, a line with
 * places in it, admission by load, a priority the orchestrator sets — and
 * could still only learn that a holder had gone by polling its pid, could not
 * show the queue anywhere but a terminal, and could not tell Kuru why an
 * agent sat idle. The server knows every agent it started and the moment each
 * one exits, so the queue lives there now, and this is its pure half: the
 * state, what a waiter may take, the pool of simulators a project has, and
 * the sentences the CLI, the window and Kuru all say about it.
 *
 * The lanes, widths, gates and exit codes are `ios-q`'s, unchanged, so a
 * brief written for the script reads the same against `slot` and the script
 * can become a shim (`docs/slots.md`).
 *
 * Pure, tested in `server/test/slots.test.ts`. No clock is read here: every
 * function that needs the time is handed it.
 */
import type { QueuedWait } from "./needs";

/** The lanes, in the order `status` lists them. */
export const LANES = ["build", "boot", "maestro", "heavy", "device"] as const;
export type Lane = (typeof LANES)[number];
/** What a lease is for: a lane, or a simulator lent out of a project's pool. */
export type LeaseLane = Lane | "sim";

export function isLane(value: unknown): value is Lane {
  return typeof value === "string" && (LANES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * What can be tuned, in `~/.config/kururu/slots.json`. Every default is the
 * script's, so moving from it changes nothing until somebody edits the file.
 */
export interface SlotSettings {
  /** How many leases a lane holds at once. */
  widths: Record<Lane, number>;
  /**
   * The 1-minute load average a lane is closed above, as a multiple of the
   * cores; null for a lane with no gate. The device lane has none: the phone
   * on the cable does not care how busy the Mac is.
   */
  load: Record<Lane, number | null>;
  /** The memory floor, in GB of free + inactive + speculative + purgeable pages. */
  minFreeGb: number;
  /** How many simulators may be booted at once, and how many when the user is waiting. About 4 GB each. */
  bootedMax: number;
  bootedMaxPriority: number;
  /** Metro ports are handed out from this plus one. */
  metroBase: number;
  /** `-jobs` added to a bare `xcodebuild` under `slot run build`. */
  jobs: number;
  /** `taskpolicy -c utility` around a build under `slot run build`. */
  polite: boolean;
  /** Exported as `CCACHE_CONFIGPATH` to a build under `slot run build`, or null. */
  ccacheConfigPath: string | null;
  /** `exact`: a project's pool is `<Project>`, `<Project> B`, `<Project> C`…; `prefix`: any simulator named `<Project> …`. */
  simMatch: "exact" | "prefix";
  /** How long `prioritize` lasts when it is not told. */
  priorityForMs: number;
  /** Where Xcode keeps DerivedData, for the nightly sweep. Null is Xcode's own default. */
  derivedData: string | null;
  /** Whether the nightly sweep runs at all. It only ever has work once a pool exists. */
  sweep: boolean;
}

export const DEFAULT_SLOT_SETTINGS: SlotSettings = {
  widths: { build: 1, boot: 1, maestro: 2, heavy: 1, device: 1 },
  load: { build: 2, boot: 2, maestro: 4, heavy: 2, device: null },
  minFreeGb: 4,
  bootedMax: 3,
  bootedMaxPriority: 4,
  metroBase: 8081,
  jobs: 8,
  polite: true,
  ccacheConfigPath: null,
  simMatch: "exact",
  priorityForMs: 60 * 60_000,
  derivedData: null,
  sweep: true,
};

/** How long a lease lasts when the take does not say. */
export const DEFAULT_MAX_MS: Record<LeaseLane, number> = {
  build: 60 * 60_000,
  boot: 10 * 60_000,
  maestro: 25 * 60_000,
  heavy: 60 * 60_000,
  device: 30 * 60_000,
  sim: 60 * 60_000,
};

/** The longest a lease may be asked for. A day is a lease nobody meant. */
export const MAX_LEASE_MS = 12 * 60 * 60_000;

function count(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function multiple(value: unknown, fallback: number | null): number | null {
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100 ? value : fallback;
}

/** The file's settings, each field checked and anything wrong left at its default. */
export function adoptSlotSettings(raw: unknown): SlotSettings {
  const d = DEFAULT_SLOT_SETTINGS;
  if (!raw || typeof raw !== "object") return { ...d, widths: { ...d.widths }, load: { ...d.load } };
  const r = raw as Record<string, unknown>;
  const widths = { ...d.widths };
  const load = { ...d.load };
  const rw = (r.widths && typeof r.widths === "object" ? r.widths : {}) as Record<string, unknown>;
  const rl = (r.load && typeof r.load === "object" ? r.load : {}) as Record<string, unknown>;
  for (const lane of LANES) {
    widths[lane] = count(rw[lane], d.widths[lane], 1, 16);
    if (lane in rl) load[lane] = multiple(rl[lane], d.load[lane]);
  }
  const minFreeGb = typeof r.minFreeGb === "number" && Number.isFinite(r.minFreeGb) && r.minFreeGb >= 0 && r.minFreeGb <= 1024 ? r.minFreeGb : d.minFreeGb;
  const bootedMax = count(r.bootedMax, d.bootedMax, 1, 32);
  const bootedMaxPriority = Math.max(bootedMax, count(r.bootedMaxPriority, Math.max(bootedMax, d.bootedMaxPriority), 1, 32));
  const priorityMinutes = count(r.priorityMinutes, d.priorityForMs / 60_000, 1, 24 * 60);
  return {
    widths,
    load,
    minFreeGb,
    bootedMax,
    bootedMaxPriority,
    metroBase: count(r.metroBase, d.metroBase, 1024, 65000),
    jobs: count(r.jobs, d.jobs, 1, 128),
    polite: typeof r.polite === "boolean" ? r.polite : d.polite,
    ccacheConfigPath: typeof r.ccacheConfigPath === "string" && r.ccacheConfigPath.startsWith("/") ? r.ccacheConfigPath : null,
    simMatch: r.simMatch === "prefix" ? "prefix" : "exact",
    priorityForMs: priorityMinutes * 60_000,
    derivedData: typeof r.derivedData === "string" && r.derivedData.startsWith("/") ? r.derivedData : null,
    sweep: typeof r.sweep === "boolean" ? r.sweep : d.sweep,
  };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * Whose a lease or a place in line is. Either half may be missing, and the
 * holder is gone when any half it has is gone.
 *
 * `agentId` is the kururu terminal the take was typed in (`KURURU_AGENT_ID`),
 * which the server hears end the moment it does — the reason the queue moved
 * here. `pid` is the process that took it, with its start time so that a
 * reused pid is not the same holder: for a take typed by an agent, the agent
 * itself, found as the first ancestor that is not a shell; for `slot run`,
 * the CLI, which releases when its command ends. A caller outside kururu has
 * only the pid, and is reaped by polling it, as the script did.
 */
export interface Holder {
  agentId: string | null;
  pid: number | null;
  pstart: string | null;
}

export interface Lease {
  /** `<lane>.<n>`, as the script named them, so `release <lease>` reads the same. */
  id: string;
  lane: LeaseLane;
  who: string;
  why: string;
  holder: Holder;
  since: number;
  until: number;
  udid: string | null;
  /** The Metro port lent with a simulator. */
  port: number | null;
  project: string | null;
  /** The simulator's name, for a sim lease. */
  name: string | null;
  /** The checkout the take was made from: two builds of one copy must not share a DerivedData. */
  root: string | null;
}

export interface Waiter {
  id: string;
  /** A lane, or `sim:<project>` for a simulator out of that project's pool. */
  lane: Lane | `sim:${string}`;
  who: string;
  why: string;
  holder: Holder;
  /** The CLI waiting, which a Ctrl-C ends: its place goes with it. */
  cliPid: number | null;
  since: number;
  /** Arrival order. Priority is applied on top, at sorting time. */
  seq: number;
  /** The last time the CLI asked. A waiter not heard from for `WAITER_GONE_MS` has gone. */
  seen: number;
  udid: string | null;
  root: string | null;
  maxMs: number;
  noBoot: boolean;
}

export interface SlotState {
  seq: number;
  leaseSeq: number;
  leases: Lease[];
  waiters: Waiter[];
  /** Who the user is waiting on, until when: a `--who`, or `agent:<id>` from `prioritize_agent`. */
  priority: Record<string, number>;
  /** The local day the nightly sweep last ran, `YYYY-MM-DD`, or null. */
  sweptOn: string | null;
}

export function emptySlotState(): SlotState {
  return { seq: 0, leaseSeq: 0, leases: [], waiters: [], priority: {}, sweptOn: null };
}

/** A CLI re-asks at once after every answer, and a server restart takes seconds. Silence past this is a waiter that left. */
export const WAITER_GONE_MS = 90_000;

/** How long a wait goes before it is something that needs you. */
export const SLOT_NEEDS_MS = 10 * 60_000;

const str = (value: unknown, max = 200): string | null => (typeof value === "string" ? oneLine(value).slice(0, max) : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const pid = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) && value > 1 ? value : null);

function adoptHolder(raw: unknown): Holder | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const holder = { agentId: str(r.agentId, 40), pid: pid(r.pid), pstart: str(r.pstart, 60) };
  return holder.agentId || holder.pid ? holder : null;
}

/** The state file read back, each record checked; a record that does not hold together is dropped rather than repaired. */
export function adoptSlotState(raw: unknown): SlotState {
  const state = emptySlotState();
  if (!raw || typeof raw !== "object") return state;
  const r = raw as Record<string, unknown>;
  state.seq = count(r.seq, 0, 0, Number.MAX_SAFE_INTEGER);
  state.leaseSeq = count(r.leaseSeq, 0, 0, Number.MAX_SAFE_INTEGER);
  for (const item of Array.isArray(r.leases) ? r.leases : []) {
    const l = item as Record<string, unknown>;
    const holder = adoptHolder(l?.holder);
    const lane = l?.lane;
    const id = str(l?.id, 80);
    const since = num(l?.since);
    const until = num(l?.until);
    if (!holder || !id || since === null || until === null || !(isLane(lane) || lane === "sim")) continue;
    state.leases.push({
      id,
      lane,
      who: str(l.who) ?? "?",
      why: str(l.why) ?? "",
      holder,
      since,
      until,
      udid: str(l.udid, 60),
      port: count(l.port, 0, 1, 65535) || null,
      project: str(l.project, 80),
      name: str(l.name, 80),
      root: str(l.root, 1024),
    });
  }
  for (const item of Array.isArray(r.waiters) ? r.waiters : []) {
    const w = item as Record<string, unknown>;
    const holder = adoptHolder(w?.holder);
    const lane = w?.lane;
    const id = str(w?.id, 80);
    const since = num(w?.since);
    const seq = num(w?.seq);
    const okLane = isLane(lane) || (typeof lane === "string" && lane.startsWith("sim:") && lane.length > 4);
    if (!holder || !id || since === null || seq === null || !okLane) continue;
    state.waiters.push({
      id,
      lane: lane as Waiter["lane"],
      who: str(w.who) ?? "?",
      why: str(w.why) ?? "",
      holder,
      cliPid: pid(w.cliPid),
      since,
      seq,
      seen: num(w.seen) ?? since,
      udid: str(w.udid, 60),
      root: str(w.root, 1024),
      maxMs: count(w.maxMs, 30 * 60_000, 1000, MAX_LEASE_MS),
      noBoot: w.noBoot === true,
    });
  }
  if (r.priority && typeof r.priority === "object") {
    for (const [who, until] of Object.entries(r.priority as Record<string, unknown>)) {
      const at = num(until);
      if (at !== null && who.length <= 200) state.priority[who] = at;
    }
  }
  if (typeof r.sweptOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.sweptOn)) state.sweptOn = r.sweptOn;
  return state;
}

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

/** What the machine looks like at one moment. `booted` is null until a simulator has been asked about. */
export interface Reading {
  load1: number;
  cores: number;
  freeMb: number;
  booted: number | null;
}

/** Whether the user is waiting on this waiter or holder: by its `--who`, or by its agent. */
export function isPriority(state: SlotState, who: string, agentId: string | null, now: number): boolean {
  const byWho = state.priority[who];
  if (byWho !== undefined && byWho > now) return true;
  if (!agentId) return false;
  const byAgent = state.priority[`agent:${agentId}`];
  return byAgent !== undefined && byAgent > now;
}

/** A lane's waiters, front of the line first: the ones the user waits on, then by arrival. */
export function sortedWaiters(state: SlotState, lane: Waiter["lane"], now: number): Waiter[] {
  return state.waiters
    .filter((w) => w.lane === lane)
    .map((w) => ({ w, p: isPriority(state, w.who, w.holder.agentId, now) ? 0 : 1 }))
    .sort((a, b) => a.p - b.p || a.w.seq - b.w.seq)
    .map(({ w }) => w);
}

/**
 * Why the machine will not let this lane start anything now, or null. Checked
 * for the lane as a whole, so while the load is high nobody in it starts and
 * the line keeps its order. Somebody the user is waiting on skips the load
 * gate (never the memory floor: a Mac that swaps is slower for them too) and
 * may boot one simulator more.
 */
export function admission(lane: Lane, priority: boolean, reading: Reading, settings: SlotSettings): string | null {
  const reasons: string[] = [];
  const mult = settings.load[lane];
  if (mult !== null && !priority) {
    const limit = mult * reading.cores;
    if (reading.load1 > limit) reasons.push(`load ${round1(reading.load1)} is over ${round1(limit)} (${mult}x ${reading.cores} cores)`);
  }
  if (lane !== "device" && reading.freeMb < settings.minFreeGb * 1024) {
    reasons.push(`free memory ${(reading.freeMb / 1024).toFixed(1)} GB is under ${settings.minFreeGb} GB`);
  }
  if (lane === "boot" && reading.booted !== null) {
    const cap = priority ? settings.bootedMaxPriority : settings.bootedMax;
    if (reading.booted >= cap) reasons.push(`${reading.booted} simulators are booted (at most ${cap}; ${settings.bootedMaxPriority} when the user is waiting)`);
  }
  return reasons.length ? reasons.join("; ") : null;
}

export interface Decision {
  ok: boolean;
  /** Why not, in the script's words; empty when ok. */
  reason: string;
  /** 1 is the front of the line. */
  place: number;
  ahead: string[];
  /** Who holds the lane, each with what for and how long of how long. */
  holders: string[];
}

/**
 * Whether two holders are one: the same kururu terminal when both name one —
 * two terminals are two agents whatever pid each was traced to — else the
 * same process.
 */
export function sameHolder(a: Holder, b: Holder): boolean {
  if (a.agentId && b.agentId) return a.agentId === b.agentId;
  return a.pid !== null && a.pid === b.pid;
}

/** Your own sim lease never blocks your own Maestro run on it: the same holder, or the same `--who`. */
function sameTaker(a: Holder, b: Holder, aWho: string, bWho: string): boolean {
  return aWho === bWho || sameHolder(a, b);
}

/**
 * May this waiter take its lane now? The script's `decide` and `admit`,
 * one function: the lane's holders and width, a build of the same copy, a
 * simulator lent to somebody else, the waiters ahead — each with a
 * simulator that is busy anyway not counted against the width, since it
 * could not have run — then the machine.
 */
export function decide(state: SlotState, waiter: Waiter, reading: Reading, settings: SlotSettings, now: number): Decision {
  const lane = waiter.lane as Lane;
  const width = settings.widths[lane];
  const busy = new Set<string>();
  const holders: string[] = [];
  let held = 0;
  let reason = "";
  for (const lease of state.leases) {
    if (lease.lane !== lane) continue;
    held++;
    if (lease.udid) busy.add(lease.udid);
    holders.push(`${lease.who} "${lease.why}" (${fmtDur(now - lease.since)} of ${fmtDur(lease.until - lease.since)})`);
    if (lane === "build" && width > 1 && waiter.root && lease.root === waiter.root) {
      reason = `a build of this copy is running (${lease.who}); two builds must not share one DerivedData`;
    }
  }
  if (lane === "maestro") {
    for (const lease of state.leases) {
      if (lease.lane !== "sim" || !lease.udid) continue;
      if (sameTaker(lease.holder, waiter.holder, lease.who, waiter.who)) continue;
      busy.add(lease.udid);
      if (waiter.udid && lease.udid === waiter.udid) reason = `simulator ${waiter.udid} is lent to ${lease.who}`;
    }
  }
  let free = width - held;
  let place = 1;
  const ahead: string[] = [];
  for (const other of sortedWaiters(state, lane, now)) {
    if (other.id === waiter.id) break;
    place++;
    ahead.push(other.who);
    if (other.udid) {
      if (busy.has(other.udid)) continue;
      busy.add(other.udid);
    }
    free--;
  }
  const base = { place, ahead, holders };
  if (reason) return { ok: false, reason, ...base };
  if (waiter.udid && busy.has(waiter.udid)) return { ok: false, reason: `simulator ${waiter.udid} is in use`, ...base };
  if (free <= 0) return { ok: false, reason: `lane is full (width ${width})`, ...base };
  const machine = admission(lane, isPriority(state, waiter.who, waiter.holder.agentId, now), reading, settings);
  if (machine) return { ok: false, reason: machine, ...base };
  return { ok: true, reason: "", ...base };
}

// ---------------------------------------------------------------------------
// Simulators
// ---------------------------------------------------------------------------

export interface Simulator {
  udid: string;
  name: string;
  state: string;
  runtime: string;
}

/**
 * Every available simulator in `xcrun simctl list devices available -j`.
 * The JSON rather than the text the script parsed, since a name with
 * parentheses in it is a name the text cannot be split around.
 */
export function parseSimctlList(text: string): Simulator[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const devices = (parsed as { devices?: unknown })?.devices;
  if (!devices || typeof devices !== "object") return [];
  const out: Simulator[] = [];
  for (const [runtime, list] of Object.entries(devices as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    for (const d of list) {
      const r = d as Record<string, unknown>;
      if (typeof r?.udid !== "string" || typeof r.name !== "string" || typeof r.state !== "string") continue;
      if (r.isAvailable === false) continue;
      out.push({ udid: r.udid, name: r.name, state: r.state, runtime });
    }
  }
  return out;
}

/** How many are up, or coming up: what the booted ceiling counts. */
export function bootedCount(sims: readonly Simulator[]): number {
  return sims.filter((s) => s.state === "Booted" || s.state === "Booting").length;
}

/**
 * A project's pool, in the order it is lent: `<Project>` first, then
 * `<Project> B`, `<Project> C`…, then (with `prefix`) anything else named
 * `<Project> …`, each group by name. Matched without case.
 */
export function poolOf(sims: readonly Simulator[], project: string, match: SlotSettings["simMatch"]): Simulator[] {
  const p = project.toLowerCase();
  const ranked: Array<{ rank: number; sim: Simulator }> = [];
  for (const sim of sims) {
    const n = sim.name.toLowerCase();
    if (n === p) ranked.push({ rank: 0, sim });
    else if (n.length === p.length + 2 && n.startsWith(`${p} `) && /[a-z]/.test(n[p.length + 1]!)) ranked.push({ rank: 1, sim });
    else if (match === "prefix" && n.startsWith(`${p} `)) ranked.push({ rank: 2, sim });
  }
  return ranked.sort((a, b) => a.rank - b.rank || a.sim.name.localeCompare(b.sim.name)).map(({ sim }) => sim);
}

/** The simulators that are lent, booting or driven, whoever by: none of them is free to lend. */
export function busySims(state: SlotState): Set<string> {
  const busy = new Set<string>();
  for (const lease of state.leases) if (lease.udid && (lease.lane === "sim" || lease.lane === "maestro" || lease.lane === "boot")) busy.add(lease.udid);
  return busy;
}

/** A Metro port: from the base up, never one another lease holds or something already listens on. */
export function pickPort(state: SlotState, base: number, listening: ReadonlySet<number>): number {
  const used = new Set(state.leases.map((l) => l.port).filter((p): p is number => p !== null));
  let port = base + 1;
  while (used.has(port) || listening.has(port)) port++;
  return port;
}

export type SimPlan =
  | { kind: "none" }
  | { kind: "lend"; sim: Simulator }
  | { kind: "boot"; sim: Simulator }
  | { kind: "wait"; reason: string; place: number; ahead: string[] };

/**
 * What a waiter for a project's simulator gets now: one booted and free, in
 * pool order by its place in line; or, for the first waiter nothing booted
 * is left for, the next shut-down one booted for it — if nobody holds or
 * waits for the boot lane and the machine admits a boot; or a wait.
 */
export function planSim(
  state: SlotState,
  waiter: Waiter,
  pool: readonly Simulator[],
  reading: Reading,
  settings: SlotSettings,
  now: number,
): SimPlan {
  if (pool.length === 0) return { kind: "none" };
  const project = waiter.lane.slice(4);
  const busy = busySims(state);
  const free = pool.filter((s) => s.state === "Booted" && !busy.has(s.udid));
  const shut = pool.find((s) => s.state === "Shutdown" && !busy.has(s.udid));
  let place = 1;
  const ahead: string[] = [];
  for (const other of sortedWaiters(state, waiter.lane, now)) {
    if (other.id === waiter.id) break;
    place++;
    ahead.push(other.who);
  }
  if (free.length >= place) return { kind: "lend", sim: free[place - 1]! };
  const booting = state.leases.some((l) => l.lane === "boot");
  const bootQueue = state.waiters.some((w) => w.lane === "boot");
  if (!waiter.noBoot && shut && place === free.length + 1 && !booting && !bootQueue) {
    const why = admission("boot", isPriority(state, waiter.who, waiter.holder.agentId, now), reading, settings);
    if (!why) return { kind: "boot", sim: shut };
    return { kind: "wait", reason: why, place, ahead };
  }
  const reason = booting
    ? "a simulator is booting"
    : shut && !waiter.noBoot
      ? `every booted '${project}' simulator is lent out; '${shut.name}' boots when the boot lane is free`
      : `every '${project}' simulator is lent out`;
  return { kind: "wait", reason, place, ahead };
}

// ---------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------

/**
 * What macOS hands out without swapping, in MB, off `vm_stat`: free,
 * inactive, speculative and purgeable pages, at the page size it prints.
 * Null for a text that is not `vm_stat`'s.
 */
export function parseVmStat(text: string): number | null {
  const size = /page size of (\d+) bytes/.exec(text);
  const page = size ? Number(size[1]) : 16384;
  const pages = (label: string): number => {
    const m = new RegExp(`^Pages ${label}:\\s+(\\d+)`, "m").exec(text);
    return m ? Number(m[1]) : 0;
  };
  if (!/^Pages free:/m.test(text)) return null;
  const total = pages("free") + pages("inactive") + pages("speculative") + pages("purgeable");
  return Math.floor((total * page) / 1048576);
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

export function oneLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

function round1(n: number): string {
  return String(Math.round(n * 10) / 10);
}

export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

export function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  return n % 10 === 1 ? `${n}st` : n % 10 === 2 ? `${n}nd` : n % 10 === 3 ? `${n}rd` : `${n}th`;
}

/** `30m`, `2h`, `90s`, `1d`, or a bare number of minutes, as the script took them. Null for anything else. */
export function parseDuration(text: string): number | null {
  const m = /^(\d+)([smhd]?)$/.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] || "m";
  return n * (unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000);
}

/** What the lane is called where a sim waiter's lane is `sim:<project>`. */
export function laneLabel(lane: Waiter["lane"] | LeaseLane): string {
  return lane.startsWith("sim:") ? `a '${lane.slice(4)}' simulator` : lane;
}

/** The line a waiting CLI prints every minute, and the window and Kuru say. */
export function waitLine(lane: Waiter["lane"], place: number, ahead: readonly string[], holders: readonly string[], reason: string, waitedMs: number): string {
  return (
    `waiting for ${laneLabel(lane)}, ${ordinal(place)} in line` +
    (ahead.length ? ` behind ${ahead.join(", ")}` : "") +
    (holders.length ? `; held by ${holders.join(", ")}` : "") +
    `. Why: ${reason || "its turn has come; taking it"}. Waiting ${fmtDur(waitedMs)}.`
  );
}

// ---------------------------------------------------------------------------
// What the window is sent
// ---------------------------------------------------------------------------

export interface SlotLeaseView {
  id: string;
  lane: LeaseLane;
  who: string;
  why: string;
  agentId: string | null;
  since: number;
  until: number;
  udid: string | null;
  port: number | null;
  name: string | null;
}

export interface SlotWaitView {
  id: string;
  lane: Waiter["lane"];
  who: string;
  why: string;
  agentId: string | null;
  since: number;
  place: number;
  ahead: string[];
  reason: string;
  /** Past `SLOT_NEEDS_MS`: what `needsOf` counts. Decided by the server's clock, so every window agrees. */
  long: boolean;
  priority: boolean;
}

export interface SlotsView {
  /** The last reading, rounded so that a load that never holds still is not a broadcast that never stops. */
  load1: number;
  cores: number;
  freeGb: number;
  booted: number | null;
  /** The two gates the bar colours the load by: a build's and a test's, as loads. */
  buildGate: number | null;
  maestroGate: number | null;
  minFreeGb: number;
  bootedMax: number;
  leases: SlotLeaseView[];
  waiting: SlotWaitView[];
  priority: Array<{ who: string; until: number }>;
}

/** The load as the bar says it, and the free memory in GB: one decimal under ten, whole above. */
export function roundLoad(load: number): number {
  return load < 10 ? Math.round(load * 10) / 10 : Math.round(load);
}

/** Which colour the load is: over a build's gate is a warning, over a test's is critical. */
export function loadSeverity(view: Pick<SlotsView, "load1" | "freeGb" | "minFreeGb" | "buildGate" | "maestroGate">): "normal" | "warning" | "critical" {
  if ((view.maestroGate !== null && view.load1 > view.maestroGate) || view.freeGb < view.minFreeGb / 2) return "critical";
  if ((view.buildGate !== null && view.load1 > view.buildGate) || view.freeGb < view.minFreeGb) return "warning";
  return "normal";
}

/** The agents whose wait has gone past `SLOT_NEEDS_MS`, by agent, which is what `needsOf` is handed. The longest wait an agent has. */
export function longWaits(view: SlotsView | null): Map<string, QueuedWait> {
  const waits = new Map<string, QueuedWait>();
  for (const w of view?.waiting ?? []) {
    if (!w.long || !w.agentId) continue;
    const had = waits.get(w.agentId);
    if (!had || w.since < had.since) waits.set(w.agentId, { lane: laneLabel(w.lane), since: w.since, reason: w.reason });
  }
  return waits;
}

/**
 * What a slot line under a pane says about one agent: each wait, then each
 * lease it holds. "P5 · waiting for build behind P2 (14m in)".
 */
export function agentSlotLines(view: SlotsView | null, agentIds: ReadonlySet<string>, now: number): string[] {
  if (!view) return [];
  const lines: string[] = [];
  for (const w of view.waiting) {
    if (!w.agentId || !agentIds.has(w.agentId)) continue;
    const behind = w.ahead.length ? ` behind ${w.ahead.join(", ")}` : view.leases.some((l) => l.lane === w.lane) ? ` behind ${view.leases.filter((l) => l.lane === w.lane).map((l) => l.who).join(", ")}` : "";
    lines.push(`${w.who} · waiting for ${laneLabel(w.lane)}${behind} (${fmtDur(now - w.since)} in)${w.priority ? " · you're waiting" : ""}`);
  }
  for (const l of view.leases) {
    if (!l.agentId || !agentIds.has(l.agentId)) continue;
    const what = l.lane === "sim" ? `${l.name ?? "simulator"}${l.port ? ` · Metro ${l.port}` : ""}` : l.lane;
    lines.push(`${l.who} · ${what} (${fmtDur(now - l.since)} of ${fmtDur(l.until - l.since)})`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// The brief
// ---------------------------------------------------------------------------

/**
 * The paragraph `run_card` puts ahead of a card's prompt in a workspace
 * marked mobile, unless `~/.config/kururu/slots-brief.md` says otherwise —
 * which is where anything about one project goes, since this text is in a
 * public repository and has to be true of anybody's Mac. `{slot}` is the
 * command, which the server knows the path of.
 */
export const DEFAULT_BRIEF = `**Building and testing mobile apps on this Mac.** Other agents share it, so everything that builds, boots, installs or drives a simulator goes through kururu's slot queue, \`{slot}\`; never run \`xcodebuild\`, \`expo run:ios\`, \`pod install\`, \`simctl boot\` or \`maestro\` bare. Wrap the command in the lane it needs — \`{slot} run build --who <your card code> --why "<what for>" -- <command>\` (also \`maestro\`, \`heavy\` for Playwright, Docker builds and big test suites, \`device\` for the phone on the cable); it waits in line, prints your place, and releases when the command ends. Do not boot a simulator yourself: \`eval "$({slot} sim <project> --who <code> --why "<what for>")"\` lends you the project's booted one as \`$IOS_Q_UDID\` with a Metro port in \`$IOS_Q_PORT\`. Never shut a simulator down, erase it, or kill CoreSimulatorService; reset state with \`xcrun simctl terminate\` instead. Rebuild native code only when the native fingerprint changed. Run unit tests before any UI flow, and stop after one red flow to read its output rather than rerunning. \`{slot} status\` shows the queue. Leases end when you exit, so never call \`{slot} prioritize\` for yourself.`;

/** The brief with its command filled in. */
export function briefFor(template: string, command: string): string {
  return template.replaceAll("{slot}", command).trim();
}
