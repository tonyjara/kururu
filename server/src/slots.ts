/**
 * The slot queue, held by the server: the lanes agents wait in for a build,
 * a simulator, a UI test, a heavy suite or the phone, and the simulators
 * each project lends out of its pool.
 *
 * Here because the server is the one process that knows when an agent has
 * gone. The `ios-q` script it replaces recorded the pid of whoever took a
 * lane and could only find out that it had died when somebody next called
 * the script and polled it; a lease here names the kururu terminal it was
 * taken from, and `host.onAgents` ends it the moment that terminal exits.
 * The pid is still kept beside it — with its start time, so a reused pid is
 * not the same holder — for the agent that quits back to a shell in a pty
 * that goes on living, and for a caller from outside kururu, which has only
 * that.
 *
 * A take is a long poll rather than a socket. The CLI asks, the server holds
 * the request until the waiter is granted or `POLL_MS` passes, and the CLI
 * asks again at once with the id it was given, so a server restarted under
 * `bun run dev` — which happens all day — costs a waiter nothing: the state
 * is on disk, and its place is kept for `WAITER_GONE_MS` while it reconnects.
 * Only a waiter with a request open is granted, so a lane is never handed to
 * a CLI that has been Ctrl-C'd between two asks; its pid is reaped instead.
 *
 * `xcrun` is run only once somebody asks about a simulator. On a Mac without
 * the command-line tools, a bare `xcrun` puts up the installer's dialog, and
 * a footer that read the simulators to say how many were booted would put it
 * up for everybody who never builds for iOS.
 *
 * Nothing here is the pty host's: editing this costs a reconnect.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, appendFileSync } from "node:fs";
import { cpus, freemem, homedir, loadavg } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  adoptSlotSettings,
  adoptSlotState,
  briefFor,
  DEFAULT_BRIEF,
  bootedCount,
  busySims,
  decide,
  DEFAULT_MAX_MS,
  emptySlotState,
  fmtDur,
  isLane,
  isPriority,
  type Lane,
  LANES,
  type Lease,
  type LeaseLane,
  MAX_LEASE_MS,
  oneLine,
  parseSimctlList,
  parseVmStat,
  pickPort,
  planSim,
  poolOf,
  type Reading,
  roundLoad,
  sameHolder,
  type Simulator,
  SLOT_NEEDS_MS,
  type SlotSettings,
  type SlotState,
  type SlotsView,
  sortedWaiters,
  type Waiter,
  WAITER_GONE_MS,
  waitLine,
  type Holder,
} from "../../shared/slots";
import { configDir } from "./config";
import { stateDir, writeAtomic } from "./fsutil";

const run = promisify(execFile);

/** How long the server holds a take before answering "still waiting", and the CLI asks again. */
export const POLL_MS = 20_000;
/** How often the machine is read, the dead are reaped and the line is looked at again. */
const TICK_MS = 5_000;
/** A simulator list older than this is read again before a simulator is lent. */
const SIMS_FRESH_MS = 3_000;
/** The longest a boot is waited for, as the script waited. */
const BOOT_MS = 5 * 60_000;
/** A booted simulator nobody has had for this long is shut down by the nightly sweep. */
const IDLE_SIM_MS = 60 * 60_000;
/**
 * The sweep runs once a day, at the first tick between these hours: at night
 * while nobody is building, or in the morning for a Mac that slept through it
 * — never in the afternoon of the day somebody first borrowed a simulator.
 */
const SWEEP_FROM_HOUR = 4;
const SWEEP_UNTIL_HOUR = 9;
/** A DerivedData folder written to in the last hour is a build in flight, even if its workspace has gone. */
const DERIVED_FRESH_MS = 60 * 60_000;

/** One simulator of a project's pool as the database keeps it. See `Store.simPool`. */
export interface SimRow {
  udid: string;
  project: string;
  name: string;
  runtime: string;
  state: string;
  bootedSince: number | null;
  fingerprint: string | null;
  leaseId: string | null;
  leaseWho: string | null;
  lastUsedAt: number | null;
  seenAt: number;
}

export interface SimPoolStore {
  simPool(): SimRow[];
  putSim(row: SimRow): void;
  dropSim(udid: string): void;
}

export interface SlotsDeps {
  /** Whether the kururu terminal is still there and has not exited. */
  agentAlive: (agentId: string) => boolean;
  /** What a lease taken without `--who` is called: the agent's card code, or its name. */
  whoOf: (agentId: string) => string | null;
  /** The view moved; the caller broadcasts it. */
  changed: (view: SlotsView) => void;
  /** Whether a window is open, which is the only reason to read memory while nothing is queued. */
  watched: () => boolean;
  store: SimPoolStore | null;
  now?: () => number;
  /** The load and memory, in place of the machine's: for tests. */
  reading?: () => Pick<Reading, "load1" | "freeMb" | "cores">;
}

export interface TakeRequest {
  kind: "take" | "sim";
  lane: Lane | null;
  project: string | null;
  who: string | null;
  why: string;
  maxMs: number;
  udid: string | null;
  root: string | null;
  holder: Holder;
  cliPid: number | null;
  waiter: string | null;
  noBoot: boolean;
}

export type TakeAnswer =
  | { state: "granted"; lease: Lease; fingerprint: string | null; settings: { jobs: number; polite: boolean; ccacheConfigPath: string | null } }
  | { state: "waiting"; waiter: string; place: number; line: string }
  | { state: "failed"; code: number; error: string; hint: string[] };

interface Pending {
  resolve: (answer: TakeAnswer) => void;
}

interface Seen {
  place: number;
  ahead: string[];
  holders: string[];
  reason: string;
}

export interface SweepReport {
  dry: boolean;
  shutdown: string[];
  unavailable: boolean;
  derivedData: string[];
  errors: string[];
}

/** Where the state lives: `slots.json`, its log beside it, and the command agents run. */
export function slotsPath(): string {
  return join(stateDir(), "slots.json");
}

/** The command a brief names: a two-line script that runs the bundled CLI on this server's own runtime. */
export function slotCommandPath(): string {
  return join(stateDir(), "bin", "slot");
}

/** The bundled CLI, beside the server as `report.mjs` is. */
function slotScript(): string {
  return fileURLToPath(new URL("./slot.mjs", import.meta.url));
}

/**
 * Write `slot` into the state directory, pointing at this build. A stable
 * path is the point: the agents a brief is for work in other projects, where
 * `bun run slot` means nothing, and the bundle's own path moves with every
 * app update. Rewritten on each start, so it follows the build that is
 * serving. A server run from source with nothing built has no bundle and
 * writes nothing; `bun run slot` still works from the checkout.
 */
export function writeSlotCommand(): string | null {
  const script = slotScript();
  if (!existsSync(script)) return null;
  const path = slotCommandPath();
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeAtomic(path, `#!/bin/sh\n# Written by kururu on each start; see docs/slots.md.\nELECTRON_RUN_AS_NODE=1 exec ${q(process.execPath)} ${q(script)} "$@"\n`, { mode: 0o755 });
    return path;
  } catch {
    return null;
  }
}

/**
 * The paragraph a card run in a mobile workspace starts with: the user's own
 * in `~/.config/kururu/slots-brief.md` when there is one — where anything
 * about their projects belongs, this repository being public — else
 * `DEFAULT_BRIEF`, with the command it names filled in.
 */
export function slotBrief(): string {
  let template = DEFAULT_BRIEF;
  try {
    const own = readFileSync(join(configDir(), "slots-brief.md"), "utf8").trim();
    if (own) template = own;
  } catch {
    // The default, then.
  }
  return briefFor(template, slotCommandPath());
}

function localDay(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export class Slots {
  private state: SlotState;
  settings: SlotSettings;
  private readonly now: () => number;
  private readonly pending = new Map<string, Pending>();
  private readonly seen = new Map<string, Seen>();
  /** Waiters whose simulator would not boot, and why: their next ask is told. */
  private readonly failed = new Map<string, string>();
  private reading: Reading = { load1: 0, cores: cpus().length || 1, freeMb: Math.floor(freemem() / 1048576), booted: null };
  private sims: Simulator[] | null = null;
  private simsAt = 0;
  private simsReading: Promise<void> | null = null;
  private listening = new Set<number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastView = "";
  private ticking = false;

  constructor(
    private readonly deps: SlotsDeps,
    private readonly paths = { state: slotsPath(), settings: join(configDir(), "slots.json"), log: join(stateDir(), "slots.log") },
  ) {
    this.now = deps.now ?? Date.now;
    if (deps.reading) this.reading = { ...this.reading, ...deps.reading() };
    this.settings = this.readSettings();
    this.state = this.readState();
    // A restart is not a waiter leaving: every one kept gets the full grace to reconnect.
    const at = this.now();
    for (const w of this.state.waiters) w.seen = at;
  }

  // -------------------------------------------------------------------------
  // Disk
  // -------------------------------------------------------------------------

  private readSettings(): SlotSettings {
    try {
      return adoptSlotSettings(JSON.parse(readFileSync(this.paths.settings, "utf8")));
    } catch {
      return adoptSlotSettings(null);
    }
  }

  private readState(): SlotState {
    try {
      return adoptSlotState(JSON.parse(readFileSync(this.paths.state, "utf8")));
    } catch {
      return emptySlotState();
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.paths.state), { recursive: true });
      writeAtomic(this.paths.state, `${JSON.stringify(this.state)}\n`);
    } catch (err) {
      console.error(`kururu: could not save the slot queue: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The record of every grant, release and reap: what to read to learn why an agent sat idle. */
  log(line: string): void {
    const d = new Date(this.now());
    const p2 = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
    try {
      appendFileSync(this.paths.log, `${stamp} ${oneLine(line)}\n`);
      if (statSync(this.paths.log).size > 1_000_000) {
        const lines = readFileSync(this.paths.log, "utf8").split("\n");
        writeAtomic(this.paths.log, lines.slice(-2000).join("\n"));
      }
    } catch {
      // A log that cannot be written is not a reason for a take to fail.
    }
  }

  // -------------------------------------------------------------------------
  // Timers
  // -------------------------------------------------------------------------

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const [, p] of this.pending) p.resolve({ state: "failed", code: 6, error: "the server is stopping; ask again", hint: [] });
    this.pending.clear();
  }

  /** Whether the queue has anything in it, or a pool to look after. */
  private busy(): boolean {
    return this.state.leases.length > 0 || this.state.waiters.length > 0;
  }

  /** Whether slots are a thing on this Mac at all: something queued, or a pool kept. What Kuru is told about them by. */
  inUse(): boolean {
    return this.busy() || (this.deps.store?.simPool().length ?? 0) > 0;
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.read();
      await this.reapPids();
      this.reap("tick");
      this.pump();
      await this.maybeSweep();
      this.publish();
    } catch (err) {
      console.error(`kururu: the slots tick failed: ${err instanceof Error ? err.stack : String(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  /** Load and memory, from the test file when there is one (`KURURU_SLOTS_TEST_READING`), else the machine. */
  private async read(): Promise<void> {
    if (this.deps.reading) {
      this.reading = { ...this.reading, ...this.deps.reading() };
      return;
    }
    const test = process.env.KURURU_SLOTS_TEST_READING;
    if (test) {
      try {
        const r = JSON.parse(readFileSync(test, "utf8")) as Record<string, unknown>;
        const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
        this.reading = { ...this.reading, load1: n(r.load1, 0), freeMb: n(r.freeMb, 99_999), cores: n(r.cores, this.reading.cores) };
        return;
      } catch {
        // Fall through to the machine.
      }
    }
    this.reading.load1 = loadavg()[0] ?? 0;
    this.reading.cores = cpus().length || 1;
    if (!this.busy() && !this.deps.watched()) return;
    if (process.platform === "darwin") {
      try {
        const { stdout } = await run("vm_stat", [], { timeout: 5000 });
        const mb = parseVmStat(stdout);
        if (mb !== null) this.reading.freeMb = mb;
        return;
      } catch {
        // `freemem` below.
      }
    }
    this.reading.freeMb = Math.floor(freemem() / 1048576);
  }

  // -------------------------------------------------------------------------
  // Holders
  // -------------------------------------------------------------------------

  private pidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  private holderAlive(holder: Holder): boolean {
    if (holder.agentId && !this.deps.agentAlive(holder.agentId)) return false;
    if (holder.pid !== null && !this.pidAlive(holder.pid)) return false;
    return true;
  }

  /**
   * A pid that is alive but started at another time is another process: the
   * holder died and its number was handed on. One `ps` for every pid held.
   */
  private async reapPids(): Promise<void> {
    const pids = new Set<number>();
    for (const l of this.state.leases) if (l.holder.pid !== null && l.holder.pstart) pids.add(l.holder.pid);
    if (pids.size === 0) return;
    let stdout = "";
    try {
      ({ stdout } = await run("ps", ["-o", "pid=,lstart=", "-p", [...pids].join(",")], { timeout: 5000 }));
    } catch (err) {
      // `ps` exits 1 when one of the pids has gone, and still prints the others.
      stdout = (err as { stdout?: string }).stdout ?? "";
    }
    const started = new Map<number, string>();
    for (const line of stdout.split("\n")) {
      const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
      if (m) started.set(Number(m[1]), m[2]!.replace(/\s+/g, " "));
    }
    let moved = false;
    for (const lease of [...this.state.leases]) {
      const { pid, pstart } = lease.holder;
      if (pid === null || !pstart) continue;
      const now = started.get(pid);
      if (now !== undefined && now !== pstart) {
        this.dropLease(lease, `reaped: its process (${pid}) ended and the pid was reused`);
        moved = true;
      }
    }
    if (moved) this.save();
  }

  /** The agents moved: a terminal that exited takes its leases and its places in line with it, at once. */
  onAgents(): void {
    if (!this.busy()) return;
    if (this.reap("agent")) {
      this.pump();
      this.publish();
    }
  }

  /** Leases and waiters whose holder has gone or whose time ran out, and priorities past. Whether anything went. */
  private reap(why: string): boolean {
    const now = this.now();
    let moved = false;
    for (const lease of [...this.state.leases]) {
      if (!this.holderAlive(lease.holder)) {
        this.dropLease(lease, `reaped: holder gone (${why})`);
        moved = true;
      } else if (lease.until < now) {
        this.dropLease(lease, "reaped: --max ran out");
        moved = true;
      }
    }
    for (const w of [...this.state.waiters]) {
      const cliGone = w.cliPid !== null && !this.pidAlive(w.cliPid);
      const silent = !this.pending.has(w.id) && now - w.seen > WAITER_GONE_MS;
      if (!this.holderAlive(w.holder) || cliGone || silent) {
        this.dropWaiter(w, cliGone ? "its CLI ended" : silent ? "not heard from" : "holder gone");
        moved = true;
      }
    }
    for (const [who, until] of Object.entries(this.state.priority)) {
      if (until <= now) {
        delete this.state.priority[who];
        moved = true;
      }
    }
    if (moved) this.save();
    return moved;
  }

  private dropLease(lease: Lease, why: string): void {
    this.state.leases = this.state.leases.filter((l) => l !== lease);
    if (lease.udid && (lease.lane === "sim" || lease.lane === "maestro")) this.noteSimUsed(lease.udid, null);
    this.log(`release ${lease.lane} who=${lease.who} lease=${lease.id} held=${fmtDur(this.now() - lease.since)} ${why}`);
  }

  private dropWaiter(w: Waiter, why: string): void {
    this.state.waiters = this.state.waiters.filter((x) => x !== w);
    this.seen.delete(w.id);
    this.failed.delete(w.id);
    this.pending.get(w.id)?.resolve({ state: "failed", code: 3, error: `your place in line was given up: ${why}`, hint: [] });
    this.pending.delete(w.id);
    this.log(`leave ${w.lane} who=${w.who} waited=${fmtDur(this.now() - w.since)} ${why}`);
  }

  // -------------------------------------------------------------------------
  // Simulators
  // -------------------------------------------------------------------------

  private simctl(): string[] {
    const own = process.env.KURURU_SIMCTL;
    return own ? [own] : ["xcrun", "simctl"];
  }

  private async simctlRun(args: string[], timeout = 30_000): Promise<string> {
    const [cmd, ...pre] = this.simctl();
    const { stdout } = await run(cmd!, [...pre, ...args], { timeout, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  }

  /** The simulators, and the ports something listens on, read again; the pool rows put right. One read at a time. */
  private refreshSims(): Promise<void> {
    this.simsReading ??= (async () => {
      try {
        this.sims = parseSimctlList(await this.simctlRun(["list", "devices", "available", "-j"]));
      } catch {
        this.sims = this.sims ?? [];
      }
      this.simsAt = this.now();
      this.reading.booted = bootedCount(this.sims);
      try {
        const { stdout } = await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fn"], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
        this.listening = new Set([...stdout.matchAll(/:(\d+)$/gm)].map((m) => Number(m[1])));
      } catch (err) {
        const out = (err as { stdout?: string }).stdout ?? "";
        this.listening = new Set([...out.matchAll(/:(\d+)$/gm)].map((m) => Number(m[1])));
      }
      this.syncPool();
    })().finally(() => {
      this.simsReading = null;
    });
    return this.simsReading;
  }

  /** Every project asked about, and every project the pool already keeps. */
  private projects(): Set<string> {
    const names = new Set<string>();
    for (const row of this.deps.store?.simPool() ?? []) names.add(row.project);
    for (const w of this.state.waiters) if (w.lane.startsWith("sim:")) names.add(w.lane.slice(4));
    for (const l of this.state.leases) if (l.project) names.add(l.project);
    return names;
  }

  /**
   * The pool rows brought up to what simctl said: each project's simulators
   * found by name, when each came up, and gone ones dropped. What the
   * database adds over a listing is what simctl cannot say — since when, the
   * fingerprint installed, who has it, when it was last used.
   */
  private syncPool(): void {
    const store = this.deps.store;
    if (!store || !this.sims) return;
    const now = this.now();
    const rows = new Map(store.simPool().map((r) => [r.udid, r]));
    const kept = new Set<string>();
    for (const project of this.projects()) {
      for (const sim of poolOf(this.sims, project, this.settings.simMatch)) {
        kept.add(sim.udid);
        const old = rows.get(sim.udid);
        const lease = this.state.leases.find((l) => l.udid === sim.udid && l.lane === "sim") ?? null;
        const up = sim.state === "Booted";
        store.putSim({
          udid: sim.udid,
          project,
          name: sim.name,
          runtime: sim.runtime,
          state: sim.state,
          bootedSince: up ? (old?.state === "Booted" && old.bootedSince ? old.bootedSince : now) : null,
          fingerprint: old?.fingerprint ?? null,
          leaseId: lease?.id ?? null,
          leaseWho: lease?.who ?? null,
          lastUsedAt: old?.lastUsedAt ?? null,
          seenAt: now,
        });
      }
    }
    for (const udid of rows.keys()) if (!kept.has(udid)) store.dropSim(udid);
  }

  private noteSimUsed(udid: string, lease: Lease | null): void {
    const store = this.deps.store;
    const row = store?.simPool().find((r) => r.udid === udid);
    if (!store || !row) return;
    store.putSim({ ...row, leaseId: lease?.id ?? null, leaseWho: lease?.who ?? null, lastUsedAt: this.now() });
  }

  /** `slot installed <fingerprint>`: which development build a simulator carries now. */
  installed(udid: string, fingerprint: string): string {
    const store = this.deps.store;
    const row = store?.simPool().find((r) => r.udid === udid);
    if (!store || !row) throw new Error(`simulator ${udid} is in no project's pool`);
    store.putSim({ ...row, fingerprint });
    this.log(`installed udid=${udid} fingerprint=${fingerprint}`);
    return `${row.name} now carries the build for fingerprint ${fingerprint}`;
  }

  private async boot(sim: Simulator, waiter: Waiter): Promise<void> {
    const now = this.now();
    const lease: Lease = {
      id: `boot.${++this.state.leaseSeq}`,
      lane: "boot",
      who: waiter.who,
      why: `boot ${sim.name} for ${waiter.why}`,
      holder: waiter.holder,
      since: now,
      until: now + DEFAULT_MAX_MS.boot,
      udid: sim.udid,
      port: null,
      project: waiter.lane.slice(4),
      name: sim.name,
      root: waiter.root,
    };
    this.state.leases.push(lease);
    this.save();
    this.log(`boot ${sim.udid} name=${sim.name} who=${waiter.who}`);
    this.publish();
    let ok = false;
    try {
      try {
        await this.simctlRun(["boot", sim.udid], 60_000);
      } catch {
        // "Unable to boot device in current state: Booted" is a boot that happened.
      }
      await this.simctlRun(["bootstatus", sim.udid, "-b"], BOOT_MS);
      ok = true;
    } catch {
      ok = false;
    }
    this.state.leases = this.state.leases.filter((l) => l.id !== lease.id);
    this.save();
    if (!ok) {
      this.log(`boot failed ${sim.udid} name=${sim.name}`);
      this.failed.set(waiter.id, `'${sim.name}' did not boot. Do not erase or delete it; tell the user.`);
    }
    await this.refreshSims();
    this.pump();
    this.publish();
  }

  // -------------------------------------------------------------------------
  // The line
  // -------------------------------------------------------------------------

  /**
   * Grant whatever can be granted, front of each line first. A waiter whose
   * CLI is between two asks is not granted but keeps its place — the lane
   * waits the milliseconds until it asks again rather than skipping it.
   */
  private pump(): void {
    const now = this.now();
    let moved = false;
    const lanes = new Set(this.state.waiters.map((w) => w.lane));
    let simsNeeded = false;
    for (const lane of lanes) {
      for (const w of sortedWaiters(this.state, lane, now)) {
        const fail = this.failed.get(w.id);
        if (fail) {
          const p = this.pending.get(w.id);
          if (p) {
            this.failed.delete(w.id);
            this.state.waiters = this.state.waiters.filter((x) => x !== w);
            this.pending.delete(w.id);
            p.resolve({ state: "failed", code: 5, error: fail, hint: [] });
            moved = true;
          }
          continue;
        }
        if (lane.startsWith("sim:")) {
          if (!this.sims || now - this.simsAt > SIMS_FRESH_MS) simsNeeded = true;
          if (!this.sims) continue;
          const plan = planSim(this.state, w, poolOf(this.sims, lane.slice(4), this.settings.simMatch), this.reading, this.settings, now);
          if (plan.kind === "none") {
            const p = this.pending.get(w.id);
            if (!p) continue;
            this.state.waiters = this.state.waiters.filter((x) => x !== w);
            this.pending.delete(w.id);
            const project = lane.slice(4);
            p.resolve({
              state: "failed",
              code: 4,
              error: `no simulator for '${project}'. The pool is one simulator per project, named for it.`,
              hint: [
                `create it once (this does not boot it): xcrun simctl create "${project}" "iPhone 17 Pro"`,
                `a second, for two agents testing at once, is named "${project} B".`,
              ],
            });
            moved = true;
          } else if (plan.kind === "lend") {
            this.seen.set(w.id, { place: 1, ahead: [], holders: [], reason: "" });
            if (!this.pending.has(w.id)) continue;
            this.grant(w, "sim", { udid: plan.sim.udid, name: plan.sim.name, port: pickPort(this.state, this.settings.metroBase, this.listening) });
            moved = true;
          } else if (plan.kind === "boot") {
            this.seen.set(w.id, { place: 1, ahead: [], holders: [], reason: `booting '${plan.sim.name}'` });
            void this.boot(plan.sim, w);
            moved = true;
          } else {
            this.seen.set(w.id, { place: plan.place, ahead: plan.ahead, holders: [], reason: plan.reason });
          }
          continue;
        }
        if (lane === "boot" && (!this.sims || now - this.simsAt > SIMS_FRESH_MS)) simsNeeded = true;
        const d = decide(this.state, w, this.reading, this.settings, now);
        this.seen.set(w.id, { place: d.place, ahead: d.ahead, holders: d.holders, reason: d.reason });
        if (d.ok && this.pending.has(w.id)) {
          this.grant(w, lane as Lane, {});
          moved = true;
        }
      }
    }
    if (moved) {
      this.save();
      this.publish();
    }
    if (simsNeeded && !this.simsReading) void this.refreshSims().then(() => this.pump());
  }

  private grant(w: Waiter, lane: LeaseLane, extra: { udid?: string; name?: string; port?: number }): void {
    const now = this.now();
    const lease: Lease = {
      id: `${lane}.${++this.state.leaseSeq}`,
      lane,
      who: w.who,
      why: w.why,
      holder: w.holder,
      since: now,
      until: now + w.maxMs,
      udid: extra.udid ?? w.udid,
      port: extra.port ?? null,
      project: lane === "sim" ? w.lane.slice(4) : null,
      name: extra.name ?? null,
      root: w.root,
    };
    this.state.waiters = this.state.waiters.filter((x) => x !== w);
    this.state.leases.push(lease);
    this.seen.delete(w.id);
    if (lease.udid && lane === "sim") this.noteSimUsed(lease.udid, lease);
    this.log(`grant ${lane} who=${w.who} why="${w.why}" lease=${lease.id} waited=${fmtDur(now - w.since)}${lease.udid ? ` udid=${lease.udid}` : ""}${lease.port ? ` port=${lease.port}` : ""}`);
    const fingerprint = lease.udid ? (this.deps.store?.simPool().find((r) => r.udid === lease.udid)?.fingerprint ?? null) : null;
    const p = this.pending.get(w.id);
    this.pending.delete(w.id);
    p?.resolve({
      state: "granted",
      lease,
      fingerprint,
      settings: { jobs: this.settings.jobs, polite: this.settings.polite, ccacheConfigPath: this.settings.ccacheConfigPath },
    });
  }

  /** A take or a sim, held until it is granted or `POLL_MS` passes. Throws on a request that does not make sense. */
  async take(req: TakeRequest, signal: AbortSignal): Promise<TakeAnswer> {
    if (!req.holder.agentId && req.holder.pid === null) throw new Error("a take needs a holder: run it from a kururu terminal, or pass --pid");
    if (!this.holderAlive(req.holder)) throw new Error(`the holder ${req.holder.agentId ?? req.holder.pid} is not running`);
    const who = req.who || (req.holder.agentId ? this.deps.whoOf(req.holder.agentId) : null);
    if (!who) throw new Error("--who <your name or card code> is required");
    if (!req.why) throw new Error("--why <what for> is required");
    const lane: Waiter["lane"] | null = req.kind === "sim" ? (req.project ? `sim:${req.project}` : null) : req.lane;
    if (!lane) throw new Error(req.kind === "sim" ? "sim <project>: name the project" : `take <lane>: one of ${LANES.join(" ")}`);
    if (req.kind === "sim" && req.project && !this.projects().has(req.project) && this.sims) {
      // A new project: read again, so a simulator created a moment ago is found.
      this.simsAt = 0;
    }
    this.reap("take");
    const now = this.now();
    let w = req.waiter ? this.state.waiters.find((x) => x.id === req.waiter) : undefined;
    if (w && w.lane !== lane) w = undefined;
    if (!w) {
      const seq = ++this.state.seq;
      w = {
        id: `w${seq}`,
        lane,
        who,
        why: req.why,
        holder: req.holder,
        cliPid: req.cliPid,
        since: now,
        seq,
        seen: now,
        udid: req.udid,
        root: req.root,
        maxMs: Math.min(MAX_LEASE_MS, req.maxMs > 0 ? req.maxMs : DEFAULT_MAX_MS[req.kind === "sim" ? "sim" : (lane as Lane)]),
        noBoot: req.noBoot,
      };
      this.state.waiters.push(w);
      this.save();
      this.log(`wait ${lane} who=${who} why="${req.why}" waiter=${w.id}`);
    } else {
      w.seen = now;
      w.cliPid = req.cliPid ?? w.cliPid;
    }
    // A waiter's first ask is answered at once, so its CLI says its place
    // when it joins the line rather than twenty seconds later; every ask
    // after it is held. A lane free now is granted inside `pump` either way.
    const holdMs = req.waiter ? POLL_MS : 0;
    const waiter = w;
    this.pending.get(waiter.id)?.resolve({ state: "waiting", waiter: waiter.id, place: 0, line: "asked again" });
    const answer = new Promise<TakeAnswer>((resolve) => this.pending.set(waiter.id, { resolve }));
    this.pump();
    this.publish();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), holdMs);
      signal.addEventListener("abort", () => resolve(null), { once: true });
    });
    const got = await Promise.race([answer, timeout]);
    if (timer) clearTimeout(timer);
    if (got) return got;
    if (this.pending.get(waiter.id)) this.pending.delete(waiter.id);
    waiter.seen = this.now();
    const s = this.seen.get(waiter.id) ?? { place: 1, ahead: [], holders: [], reason: "looking" };
    return { state: "waiting", waiter: waiter.id, place: s.place, line: waitLine(waiter.lane, s.place, s.ahead, s.holders, s.reason, this.now() - waiter.since) };
  }

  /**
   * End leases: one by id; else the caller's own — those whose holder is the
   * caller's agent or process — on one lane or all; or, with `anyHolder`,
   * one `who`'s from anywhere, which is for Kuru cleaning up after an agent.
   */
  release(req: { lease: string | null; lane: string | null; who: string | null; anyHolder: boolean; holder: Holder }): string[] {
    this.reap("release");
    const out: string[] = [];
    const drop = (l: Lease) => {
      this.dropLease(l, "released");
      out.push(`released ${l.lane} (${l.who}, held ${fmtDur(this.now() - l.since)})`);
    };
    if (req.lease) {
      const lease = this.state.leases.find((l) => l.id === req.lease);
      if (lease) drop(lease);
      else if (!isLane(req.lease) && req.lease !== "sim") throw new Error(`no lease or lane '${req.lease}' (see slot status)`);
      else req = { ...req, lane: req.lease };
    }
    if (!req.lease || out.length === 0) {
      if (req.anyHolder && !req.who) throw new Error("--any-holder needs --who <name>");
      for (const l of [...this.state.leases]) {
        if (req.lane && l.lane !== req.lane) continue;
        if (req.who && l.who !== req.who) continue;
        const mine = sameHolder(l.holder, req.holder);
        if (!req.anyHolder && !mine) continue;
        drop(l);
      }
    }
    if (out.length) {
      this.save();
      this.pump();
      this.publish();
    }
    return out;
  }

  /** The user is waiting on `who` — a `--who`, or `agent:<id>` — until `ms` from now; or, with 0, no longer. */
  prioritize(who: string, ms: number): string {
    if (ms <= 0) {
      delete this.state.priority[who];
      this.log(`unprioritize who=${who}`);
    } else {
      this.state.priority[who] = this.now() + ms;
      this.log(`prioritize who=${who} for=${fmtDur(ms)}`);
    }
    this.save();
    this.pump();
    this.publish();
    const until = new Date(this.now() + ms).toTimeString().slice(0, 5);
    return ms <= 0 ? `${who} waits its turn again` : `${who} goes to the front of every lane until ${until}`;
  }

  /** The default length of a priority, from the settings. */
  get priorityForMs(): number {
    return this.settings.priorityForMs;
  }

  // -------------------------------------------------------------------------
  // What is said about it
  // -------------------------------------------------------------------------

  view(): SlotsView {
    const now = this.now();
    const r = this.reading;
    const gate = (lane: Lane) => {
      const m = this.settings.load[lane];
      return m === null ? null : m * r.cores;
    };
    return {
      load1: roundLoad(r.load1),
      cores: r.cores,
      freeGb: roundLoad(r.freeMb / 1024),
      booted: r.booted,
      buildGate: gate("build"),
      maestroGate: gate("maestro"),
      minFreeGb: this.settings.minFreeGb,
      bootedMax: this.settings.bootedMax,
      leases: this.state.leases.map((l) => ({
        id: l.id,
        lane: l.lane,
        who: l.who,
        why: l.why,
        agentId: l.holder.agentId,
        since: l.since,
        until: l.until,
        udid: l.udid,
        port: l.port,
        name: l.name,
      })),
      waiting: [...this.state.waiters]
        .sort((a, b) => a.seq - b.seq)
        .map((w) => {
          const s = this.seen.get(w.id);
          return {
            id: w.id,
            lane: w.lane,
            who: w.who,
            why: w.why,
            agentId: w.holder.agentId,
            since: w.since,
            place: s?.place ?? 1,
            ahead: s?.ahead ?? [],
            reason: s?.reason ?? "",
            long: now - w.since >= SLOT_NEEDS_MS,
            priority: isPriority(this.state, w.who, w.holder.agentId, now),
          };
        }),
      priority: Object.entries(this.state.priority).map(([who, until]) => ({ who, until })),
    };
  }

  /** Say the view to the windows if it moved. */
  publish(): void {
    const view = this.view();
    const json = JSON.stringify(view);
    if (json === this.lastView) return;
    this.lastView = json;
    this.deps.changed(view);
  }

  /** `slot status`: the machine, every lease, every waiter in order, and the priorities. */
  statusText(): string {
    const now = this.now();
    const v = this.view();
    const lines = [
      `slots  load ${v.load1} (build ≤${v.buildGate ?? "-"} maestro ≤${v.maestroGate ?? "-"})  free ${v.freeGb} GB (floor ${v.minFreeGb})  booted ${v.booted ?? "?"}/${v.bootedMax}`,
      "",
    ];
    const pad = (s: string, n: number) => (s.length >= n ? `${s.slice(0, n - 1)} ` : s.padEnd(n));
    lines.push(`${pad("LANE", 9)}${pad("WHO", 15)}${pad("HELD", 10)}${pad("WHY", 35)}SIMULATOR / PORT`);
    const order: LeaseLane[] = [...LANES, "sim"];
    const leases = [...this.state.leases].sort((a, b) => order.indexOf(a.lane) - order.indexOf(b.lane) || a.since - b.since);
    for (const l of leases) {
      const sim = [l.name, l.udid?.slice(0, 8), l.port ? String(l.port) : null].filter(Boolean).join(" ");
      lines.push(`${pad(l.lane, 9)}${pad(l.who, 15)}${pad(`${fmtDur(now - l.since)}/${fmtDur(l.until - l.since)}`, 10)}${pad(l.why, 35)}${sim}`);
    }
    if (!leases.length) lines.push("(no leases)");
    lines.push("");
    if (v.waiting.length) {
      lines.push("waiting:");
      for (const w of v.waiting) {
        lines.push(`  ${pad(w.lane, 14)}${pad(w.who, 15)}${pad(fmtDur(now - w.since), 9)}${w.why}${w.priority ? "  [user waiting]" : ""}${w.reason ? `  — ${w.reason}` : ""}`);
      }
    } else lines.push("nobody waiting");
    for (const p of v.priority) lines.push(`priority: ${p.who} until ${new Date(p.until).toTimeString().slice(0, 5)}`);
    return lines.join("\n");
  }

  /** `who [<lane>]`: who holds it, one a line, or `free`. */
  whoText(lane: string | null): string {
    this.reap("who");
    const held = this.state.leases.filter((l) => !lane || l.lane === lane).map((l) => (lane ? l.who : `${l.who} (${l.lane})`));
    return held.length ? held.join("\n") : "free";
  }

  /**
   * What `kururu_status` says, named the way Kuru names agents, or null when
   * nothing is queued and nothing is held — Kuru is not told about an empty
   * queue on every call.
   */
  statusForKuru(nameOf: (agentId: string) => string): string | null {
    if (!this.busy()) return null;
    const now = this.now();
    const v = this.view();
    const who = (agentId: string | null, fallback: string) => (agentId ? `${nameOf(agentId)} (as ${fallback})` : fallback);
    const out = [`slots (the shared build and simulator queue; load ${v.load1} on ${v.cores} cores, ${v.freeGb} GB free):`];
    for (const l of v.leases) out.push(`  - ${who(l.agentId, l.who)} holds ${l.lane === "sim" ? `simulator ${l.name ?? l.udid}` : l.lane} for "${l.why}" · ${fmtDur(now - l.since)} of ${fmtDur(l.until - l.since)}`);
    for (const w of v.waiting) {
      out.push(
        `  - ${who(w.agentId, w.who)} waits for ${w.lane.startsWith("sim:") ? `a ${w.lane.slice(4)} simulator` : w.lane}, ${w.place === 1 ? "first" : `#${w.place}`} in line, ${fmtDur(now - w.since)} so far` +
          (w.reason ? ` — ${w.reason}` : "") +
          (w.priority ? " · the user is waiting on it" : ""),
      );
    }
    return out.join("\n");
  }

  // -------------------------------------------------------------------------
  // The nightly sweep
  // -------------------------------------------------------------------------

  private async maybeSweep(): Promise<void> {
    if (!this.settings.sweep) return;
    const now = this.now();
    const hour = new Date(now).getHours();
    if (hour < SWEEP_FROM_HOUR || hour >= SWEEP_UNTIL_HOUR) return;
    const today = localDay(now);
    if (this.state.sweptOn === today) return;
    if ((this.deps.store?.simPool().length ?? 0) === 0) return;
    this.state.sweptOn = today;
    this.save();
    const report = await this.sweep(false);
    this.log(`sweep shutdown=${report.shutdown.length} unavailable=${report.unavailable} derivedData=${report.derivedData.length} errors=${report.errors.length}`);
  }

  /**
   * Once a day, and on `slot sweep --yes`: shut down pool simulators nobody
   * has had for an hour, delete the simulators whose runtime is gone, and
   * remove DerivedData whose workspace is gone from the disk — a scratch copy
   * that was deleted leaves gigabytes there that nothing will build into
   * again. Never a simulator that is lent, never DerivedData written in the
   * last hour or belonging to a checkout a build lease names. `dry` says what
   * it would do and does none of it.
   */
  async sweep(dry: boolean): Promise<SweepReport> {
    const report: SweepReport = { dry, shutdown: [], unavailable: false, derivedData: [], errors: [] };
    const now = this.now();
    if ((this.deps.store?.simPool().length ?? 0) > 0) {
      await this.refreshSims();
      const busy = busySims(this.state);
      for (const row of this.deps.store?.simPool() ?? []) {
        if (row.state !== "Booted" || busy.has(row.udid)) continue;
        const last = row.lastUsedAt ?? row.bootedSince ?? now;
        if (now - last < IDLE_SIM_MS) continue;
        report.shutdown.push(`${row.name} (${row.udid})`);
        if (dry) continue;
        try {
          await this.simctlRun(["shutdown", row.udid], 60_000);
        } catch (err) {
          report.errors.push(`shutdown ${row.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      report.unavailable = true;
      if (!dry) {
        try {
          await this.simctlRun(["delete", "unavailable"], 120_000);
        } catch (err) {
          report.errors.push(`delete unavailable: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    const derived = this.settings.derivedData ?? join(homedir(), "Library", "Developer", "Xcode", "DerivedData");
    const roots = this.state.leases.map((l) => l.root).filter((r): r is string => !!r);
    let entries: string[] = [];
    try {
      entries = readdirSync(derived);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      const dir = join(derived, entry);
      const plist = join(dir, "info.plist");
      if (!existsSync(plist)) continue;
      let workspace: string;
      try {
        ({ stdout: workspace } = await run("plutil", ["-extract", "WorkspacePath", "raw", "-o", "-", plist], { timeout: 5000 }));
        workspace = workspace.trim();
      } catch {
        continue;
      }
      if (!workspace.startsWith("/") || existsSync(workspace)) continue;
      if (roots.some((root) => workspace.startsWith(root))) continue;
      try {
        if (now - statSync(dir).mtimeMs < DERIVED_FRESH_MS) continue;
      } catch {
        continue;
      }
      report.derivedData.push(`${entry} (for ${workspace})`);
      if (dry) continue;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        report.errors.push(`remove ${entry}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!dry) await this.refreshSims().catch(() => undefined);
    return report;
  }
}

/** The checks a take's body is put through: everything off the wire is a stranger's until it is. */
export function adoptTakeRequest(body: Record<string, unknown>): TakeRequest {
  const s = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? oneLine(v).slice(0, max) : null);
  const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 1 ? v : null);
  const holderRaw = (body.holder && typeof body.holder === "object" ? body.holder : {}) as Record<string, unknown>;
  const kind = body.kind === "sim" ? "sim" : "take";
  const lane = isLane(body.lane) ? body.lane : null;
  const project = s(body.project, 80);
  if (project && !/^[\w .+-]+$/.test(project)) throw new Error("a project is named with letters, digits, spaces and . + -");
  const maxMs = typeof body.maxMs === "number" && Number.isFinite(body.maxMs) && body.maxMs > 0 ? Math.min(MAX_LEASE_MS, body.maxMs) : 0;
  return {
    kind,
    lane,
    project,
    who: s(body.who, 60),
    why: s(body.why, 200) ?? "",
    maxMs,
    udid: s(body.udid, 60),
    root: typeof body.root === "string" && body.root.startsWith("/") ? body.root.slice(0, 1024) : null,
    holder: { agentId: s(holderRaw.agentId, 40), pid: int(holderRaw.pid), pstart: s(holderRaw.pstart, 60) },
    cliPid: int(body.cliPid),
    waiter: s(body.waiter, 40),
    noBoot: body.noBoot === true,
  };
}
