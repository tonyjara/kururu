/**
 * The reads behind the bar's "This Mac" chip: how much of the processors and
 * the memory is in use, and who has them (`shared/mac.ts` says why the chip
 * stopped drawing the load).
 *
 * It must not be one of the things it reports, so it reads as little as the
 * answer allows. The processors' share is the difference between two
 * `os.cpus()` readings, which is a call into this process and no fork at all.
 * Who is using them comes off the process table the sweep already read for
 * the dev servers and the memory column (`proctable.ts`, one more column on
 * the same `ps`), so naming the heaviest costs a walk of a map. Memory is the
 * one thing forked for: `vm_stat`, which the slot queue was already running on
 * its own timer and now borrows from here (`freeMb`), and one `sysctl` for the
 * swap and the pressure. And none of it but the first is read while no window
 * is open — the sweep slows to its idle beat and this skips the forks.
 *
 * Not `top`, not `powermetrics`, not a sampler of its own: each of those is a
 * process that costs more than everything above together, and the second
 * wants root.
 *
 * A simulator's name is read from its `device.plist`, once, rather than asked
 * of `xcrun simctl`: `slots.ts` says why a bare `xcrun` is never run for
 * somebody who has not asked about a simulator, and a booted one is already
 * in the process table as its `launchd_sim`.
 *
 * Server code, and nothing here is the pty host's: editing it costs a
 * reconnect.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { cpus, freemem, homedir, loadavg, totalmem } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type CpuClock,
  cpuShare,
  groupConsumers,
  MAC_HISTORY,
  type MacMemory,
  type MacRoot,
  type MacView,
  parseMeminfo,
  parsePressure,
  parseSwapUsed,
  parseVmMemory,
  type ProcUse,
} from "../../shared/mac";
import { parseVmStat, roundLoad } from "../../shared/slots";

const run = promisify(execFile);

/** A reading older than this is not lent to the slot queue, which then takes its own. */
const FRESH_MS = 8_000;
/** A gap this long between two readings is the idle beat: the sparkline starts again rather than draw it as one step. */
const GAP_MS = 12_000;

export interface MacDeps {
  /** Every live kururu terminal, by the pid on its pty. */
  roots: () => MacRoot[];
  /** Kururu's own processes that no bundle names: this server and the pty host. */
  self: (procs: ReadonlyMap<number, ProcUse>) => ReadonlySet<number>;
  /** Whether a window is open, which is the only reason to fork or to say anything. */
  watched: () => boolean;
  changed: (view: MacView) => void;
  now?: () => number;
  /** The memory, in place of the machine's: for tests, which fork nothing. */
  memory?: () => MacMemory | null;
}

function clock(): CpuClock {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

const simNames = new Map<string, string | null>();

/**
 * What a simulator is called, from the device folder CoreSimulator keeps for
 * it. The file is XML on every Xcode this has met; one that is not, or is not
 * there, is "Simulator". Kept for the life of the server: a device is renamed
 * about never.
 */
export function simDeviceName(udid: string, home = homedir()): string | null {
  if (!/^[0-9A-F-]{36}$/.test(udid)) return null;
  const had = simNames.get(udid);
  if (had !== undefined) return had;
  let name: string | null = null;
  try {
    const text = readFileSync(join(home, "Library/Developer/CoreSimulator/Devices", udid, "device.plist"), "utf8");
    name = /<key>name<\/key>\s*<string>([^<]{1,80})<\/string>/.exec(text)?.[1]?.trim() || null;
  } catch {
    // Unnamed.
  }
  simNames.set(udid, name);
  return name;
}

export class MacMeter {
  private readonly now: () => number;
  private last: { clock: CpuClock; at: number } | null = null;
  private history: number[] = [];
  private memory: MacMemory | null = null;
  private free: { mb: number; at: number } | null = null;
  private latest: MacView | null = null;
  private readingMemory = false;

  constructor(private readonly deps: MacDeps) {
    this.now = deps.now ?? Date.now;
    // Read now, so the first sweep has something to take a difference from and does not say 0%.
    this.last = { clock: clock(), at: this.now() };
  }

  /** The last reading, for a window that has just connected; null until there is one. */
  view(): MacView | null {
    return this.latest;
  }

  /**
   * The memory that can be handed out without swapping, as the slot queue
   * gates by it (`parseVmStat`), when this has read `vm_stat` within the last
   * beat or two. Null otherwise, and the queue reads its own.
   */
  freeMb(): number | null {
    return this.free && this.now() - this.free.at <= FRESH_MS ? this.free.mb : null;
  }

  /** One reading, off the table the process sweep has just read. */
  async see(procs: ReadonlyMap<number, ProcUse>): Promise<void> {
    const at = this.now();
    const next = clock();
    const share = this.last ? cpuShare(this.last.clock, next) : null;
    if (this.last && at - this.last.at > GAP_MS) this.history = [];
    this.last = { clock: next, at };
    if (share !== null) this.history = [...this.history, share].slice(-MAC_HISTORY);
    if (!this.deps.watched()) return;
    // The first reading waits for the memory, so a window is never shown the
    // Mac without it; after that the forks run beside the sweep and this beat
    // draws the last one's answer, since a `vm_stat` that hangs must not hold
    // up the dev-server scan that shares this timer.
    if (this.memory === null) await this.readMemory(at);
    else if (!this.readingMemory) {
      this.readingMemory = true;
      void this.readMemory(at)
        .catch(() => {})
        .finally(() => {
          this.readingMemory = false;
        });
    }
    const cores = cpus().length || 1;
    const { top, sims } = groupConsumers(procs.values(), this.deps.roots(), { cores, self: this.deps.self(procs), simName: simDeviceName });
    this.latest = {
      cores,
      cpu: share ?? this.latest?.cpu ?? 0,
      history: this.history,
      load1: roundLoad(loadavg()[0] ?? 0),
      memory: this.memory,
      sims,
      top,
    };
    this.deps.changed(this.latest);
  }

  private async readMemory(at: number): Promise<void> {
    if (this.deps.memory) {
      this.memory = this.deps.memory();
      return;
    }
    if (process.platform === "darwin") {
      const [vm, sys] = await Promise.all([
        run("vm_stat", [], { timeout: 5000 }).then((r) => r.stdout, () => ""),
        run("sysctl", ["-n", "vm.swapusage", "kern.memorystatus_vm_pressure_level"], { timeout: 5000 }).then((r) => r.stdout, () => ""),
      ]);
      const free = parseVmStat(vm);
      if (free !== null) this.free = { mb: free, at };
      const parsed = parseVmMemory(vm, totalmem());
      if (!parsed) return;
      const [swapLine = "", pressureLine = ""] = sys.split("\n");
      this.memory = { ...parsed, swapMb: parseSwapUsed(swapLine) ?? this.memory?.swapMb ?? 0, pressure: parsePressure(pressureLine) };
      return;
    }
    try {
      this.memory = parseMeminfo(readFileSync("/proc/meminfo", "utf8")) ?? this.memory;
    } catch {
      const totalMb = Math.round(totalmem() / 1048576);
      const usedMb = Math.max(0, totalMb - Math.round(freemem() / 1048576));
      this.memory = { totalMb, usedMb, appMb: usedMb, wiredMb: 0, compressedMb: 0, cachedMb: 0, swapMb: 0, pressure: null };
    }
  }
}
