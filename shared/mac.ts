/**
 * What this Mac is using now, in the words a person would use for it: how
 * much of its processors, how much of its memory, and what is behind both.
 *
 * Here because the bar used to say "load 146 on 12 cores" and nobody could
 * read it (the owner, 2026-11-19: "What does load 146 on 12 cores even
 * mean?"). A load average is a count of things running or waiting for a core,
 * and it has no ceiling, so a figure of it says nothing until it is divided by
 * the cores, and even then it says how long the line is, not how busy the
 * machine is. The share of the cores in use is the number people already have
 * a feel for, so that is the headline, and the load is kept as a sentence
 * under it (`loadWords`): the line is the part that explains why a build is
 * slow while the processors read 100% either way.
 *
 * Memory is what is *in use* against what there is, split the way Activity
 * Monitor splits it, with the pressure macOS itself reports. "Free" was the
 * wrong figure to lead with: a Mac with 7 GB free and 20 GB pushed out to
 * swap read as comfortable.
 *
 * Who is using it is read off the process table the server already holds
 * (`server/src/proctable.ts`), so naming them costs no second `ps`. A process
 * belongs to the kururu terminal it is under, else to the simulator it is
 * under, else to its app; that order is what turns "swift-frontend ×8" into
 * "HOL-145's build".
 *
 * Everything here is pure. The reads are `server/src/mac.ts`'s.
 */

export type Pressure = "normal" | "warn" | "critical";

/** Megabytes throughout: the figures are drawn in GB to one decimal, and a byte count is noise on the wire. */
export interface MacMemory {
  totalMb: number;
  /** Apps, wired and compressed together: what Activity Monitor calls Memory Used. */
  usedMb: number;
  appMb: number;
  /** What the system itself holds and cannot page out. */
  wiredMb: number;
  /** What the compressor's store occupies, which is memory spent on holding other memory. */
  compressedMb: number;
  /** The file cache and what is purgeable: in use, and given back the moment something asks. */
  cachedMb: number;
  /** What has been pushed out to disk. */
  swapMb: number;
  /** As macOS says it, or null where nothing says (Linux, or a sysctl that would not answer). */
  pressure: Pressure | null;
}

export type ConsumerKind = "agent" | "sim" | "app";

/** One thing using the Mac: a kururu terminal and all under it, a simulator and all in it, or an app. */
export interface MacConsumer {
  /** `agent:<id>`, `sim:<udid>` or `app:<name>`, steady across readings so a row keeps its place in the list. */
  key: string;
  kind: ConsumerKind;
  name: string;
  /** A terminal's workspace. */
  where: string | null;
  /** The heaviest programs inside a terminal or a simulator: `swift-frontend ×8, xcodebuild`. */
  what: string | null;
  /** Its share of every core, 0–100, so the rows add up to the headline. */
  cpu: number;
  memMb: number;
  processes: number;
  agentId: string | null;
}

export interface MacView {
  cores: number;
  /** The share of every core in use over the last beat, 0–100. */
  cpu: number;
  /** That share over the last few minutes, oldest first, a beat apart. */
  history: number[];
  load1: number;
  memory: MacMemory | null;
  /** Simulators booted, counted off the process table: a `launchd_sim` each. */
  sims: number;
  /** The heaviest by processor and the heaviest by memory, together; the window sorts. */
  top: MacConsumer[];
}

/** How many readings the sparkline keeps: three minutes at the process sweep's beat. */
export const MAC_HISTORY = 60;
/** How many consumers are sent for each of the two orders. */
export const MAC_TOP = 6;

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

/** The processors' clocks summed over every core, as `os.cpus()` counts them. */
export interface CpuClock {
  idle: number;
  total: number;
}

/** The share of every core that was not idle between two readings, 0–100, or null when no time passed. */
export function cpuShare(before: CpuClock, after: CpuClock): number | null {
  const total = after.total - before.total;
  const idle = after.idle - before.idle;
  if (!Number.isFinite(total) || !Number.isFinite(idle) || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((1 - idle / total) * 100)));
}

/**
 * A load average said as what it is. Under the cores it is how many of them
 * have work; over them it is how many times more work there is than can run,
 * which is the figure that explains a wait.
 */
export function loadWords(load1: number, cores: number): string {
  const n = Math.max(1, cores);
  const ratio = load1 / n;
  if (ratio <= 1) {
    const busy = Math.max(0, Math.round(load1));
    return busy === 0 ? `nothing is waiting for a core` : `work for about ${busy} of its ${n} cores, and nothing waiting`;
  }
  if (ratio < 1.5) return `a little more work than its ${n} cores can run at once`;
  return `about ${ratio < 10 ? Math.round(ratio * 10) / 10 : Math.round(ratio)}× more work than its ${n} cores can run at once`;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

const MB = 1024 * 1024;

/** A figure as ps and sysctl may print it under a locale with a decimal comma. */
function num(text: string): number {
  return Number(text.replace(",", "."));
}

/**
 * `vm_stat` into Activity Monitor's figures. Apps are the anonymous pages less
 * the purgeable ones, the cache is the file-backed pages and the purgeable
 * ones, and what is left over is free. Null when the text is not `vm_stat`'s.
 */
export function parseVmMemory(text: string, totalBytes: number): Omit<MacMemory, "swapMb" | "pressure"> | null {
  if (!/^Pages free:/m.test(text) || !(totalBytes > 0)) return null;
  const size = /page size of (\d+) bytes/.exec(text);
  const page = size ? Number(size[1]) : 16384;
  const mb = (label: string): number => {
    const m = new RegExp(`^${label}:\\s+(\\d+)`, "m").exec(text);
    return m ? (Number(m[1]) * page) / MB : 0;
  };
  const totalMb = totalBytes / MB;
  const purgeable = mb("Pages purgeable");
  const appMb = Math.max(0, mb("Anonymous pages") - purgeable);
  const wiredMb = mb("Pages wired down");
  const compressedMb = mb("Pages occupied by compressor");
  const usedMb = Math.min(totalMb, appMb + wiredMb + compressedMb);
  const cachedMb = Math.max(0, Math.min(totalMb - usedMb, mb("File-backed pages") + purgeable));
  return { totalMb: Math.round(totalMb), usedMb: Math.round(usedMb), appMb: Math.round(appMb), wiredMb: Math.round(wiredMb), compressedMb: Math.round(compressedMb), cachedMb: Math.round(cachedMb) };
}

/** `sysctl -n vm.swapusage` — `total = 2048.00M  used = 1024.50M  free = …` — into the megabytes used. */
export function parseSwapUsed(text: string): number | null {
  const m = /used\s*=\s*([\d.,]+)\s*([KMG])/.exec(text);
  if (!m) return null;
  const n = num(m[1]!);
  if (!Number.isFinite(n)) return null;
  return Math.round(m[2] === "G" ? n * 1024 : m[2] === "K" ? n / 1024 : n);
}

/** `kern.memorystatus_vm_pressure_level`: 1 is normal, 2 a warning, 4 critical. */
export function parsePressure(text: string): Pressure | null {
  const level = Number(text.trim());
  return level === 1 ? "normal" : level === 2 ? "warn" : level === 4 ? "critical" : null;
}

/**
 * `/proc/meminfo`, for a kururu on Linux. Its kernel does not split memory the
 * way a Mac's does, so everything not available and not cache is apps.
 */
export function parseMeminfo(text: string): MacMemory | null {
  const kb = (label: string): number | null => {
    const m = new RegExp(`^${label}:\\s+(\\d+) kB`, "m").exec(text);
    return m ? Number(m[1]) : null;
  };
  const total = kb("MemTotal");
  const available = kb("MemAvailable");
  if (total === null || available === null) return null;
  const cached = Math.min(available, (kb("Cached") ?? 0) + (kb("Buffers") ?? 0));
  const used = Math.max(0, total - available);
  const swap = Math.max(0, (kb("SwapTotal") ?? 0) - (kb("SwapFree") ?? 0));
  const mb = (n: number) => Math.round(n / 1024);
  return { totalMb: mb(total), usedMb: mb(used), appMb: mb(used), wiredMb: 0, compressedMb: 0, cachedMb: mb(cached), swapMb: mb(swap), pressure: null };
}

/** Megabytes as gigabytes: one decimal under ten, whole above, as the bar's other figures are. */
export function gb(mb: number): string {
  const n = mb / 1024;
  return n < 10 ? String(Math.round(n * 10) / 10) : String(Math.round(n));
}

/** A consumer's memory: `310 MB`, `2.3 GB`. */
export function memWords(mb: number): string {
  return mb < 1000 ? `${Math.round(mb)} MB` : `${gb(mb)} GB`;
}

// ---------------------------------------------------------------------------
// Who is using it
// ---------------------------------------------------------------------------

/** One process, as much of it as the grouping reads. The server's `ProcRow` is one. */
export interface ProcUse {
  pid: number;
  ppid: number;
  /** Resident set in bytes. */
  rss: number;
  /** As `ps` says it: a share of one core, so 146 is a core and a half. */
  cpu: number;
  args: string;
}

/** A kururu terminal: the pid on the end of its pty, and what a person calls it. */
export interface MacRoot {
  pid: number;
  agentId: string;
  name: string;
  workspace: string | null;
}

/**
 * The program a command line runs, by the name of its file. A path may hold
 * spaces — a simulator's runtime is under `iOS 18.5.simruntime` — so it is cut
 * where its arguments start (a flag, or another absolute path) rather than at
 * the first space, and an app's executable is called by its bundle, since
 * `Google` is no name for a Chrome helper.
 */
export function toolName(args: string): string {
  let head = args.trim();
  if (head.startsWith("/")) {
    const cut = head.search(/ (?:-|\/)/);
    if (cut > 0) head = head.slice(0, cut);
    const bundle = /\/([^/]+)\.app\/Contents\/MacOS\//.exec(head);
    if (bundle) return bundle[1]!;
    head = head.slice(head.lastIndexOf("/") + 1);
  }
  const word = head.split(/\s+/, 1)[0] ?? "";
  // `-zsh` is a login shell, `sshd:` is sshd renaming itself after the session.
  return word.slice(word.lastIndexOf("/") + 1).replace(/^-|:$/g, "") || "other";
}

/** What a process outside every terminal and simulator is filed under: its app, outermost bundle first, else its program. */
export function appName(args: string): string {
  const bundle = /\/([^/]+)\.app\//.exec(args);
  return bundle ? bundle[1]! : toolName(args);
}

/** The simulator a `launchd_sim` is the root of, by the device folder on its command line. */
export function simUdid(args: string): string | null {
  if (!/(^|\/)launchd_sim(\s|$)/.test(args)) return null;
  return /\/Devices\/([0-9A-Fa-f-]{36})\//.exec(args)?.[1]?.toUpperCase() ?? null;
}

/** Ancestry is shallow; this bounds a walk through a table that changed while it was read. */
const MAX_ANCESTRY = 64;

interface Tally {
  key: string;
  kind: ConsumerKind;
  name: string;
  where: string | null;
  agentId: string | null;
  cpu: number;
  rss: number;
  processes: number;
  tools: Map<string, { cpu: number; rss: number; n: number }>;
}

/** The heaviest two programs in a group, by processor when anything is running and by memory when nothing is. */
function whatOf(tools: Tally["tools"]): string | null {
  const byCpu = [...tools].some(([, t]) => t.cpu >= 1);
  const ranked = [...tools].sort((a, b) => (byCpu ? b[1].cpu - a[1].cpu : b[1].rss - a[1].rss) || a[0].localeCompare(b[0]));
  const said = ranked.slice(0, 2).map(([name, t]) => (t.n > 1 ? `${name} ×${t.n}` : name));
  return said.length ? said.join(", ") : null;
}

/**
 * Every process filed under whoever it belongs to, and the heaviest of them.
 *
 * A process is a terminal's when a pty's pid is among its ancestors, a
 * simulator's when a `launchd_sim` is, and its app's otherwise — the nearest
 * of the first two wins, so a simulator an agent booted is still a simulator.
 * Kururu's own server and pty host (`self`) are filed as Kururu, with the
 * window's processes, which their bundle already names.
 *
 * What comes back is the heaviest `top` by processor and the heaviest `top` by
 * memory, once each: the window offers both orders and a list of the first
 * alone would have nothing to show for the second.
 */
export function groupConsumers(
  procs: Iterable<ProcUse>,
  roots: readonly MacRoot[],
  opts: { cores: number; self?: ReadonlySet<number>; simName?: (udid: string) => string | null; top?: number },
): { top: MacConsumer[]; sims: number } {
  const table = new Map<number, ProcUse>();
  for (const proc of procs) table.set(proc.pid, proc);
  const rootOf = new Map(roots.map((root) => [root.pid, root] as const));
  const tallies = new Map<string, Tally>();
  const owner = new Map<number, Tally | null>();
  let sims = 0;

  const tallyFor = (key: string, make: () => Omit<Tally, "key" | "cpu" | "rss" | "processes" | "tools">): Tally => {
    let tally = tallies.get(key);
    if (!tally) {
      tally = { key, ...make(), cpu: 0, rss: 0, processes: 0, tools: new Map() };
      tallies.set(key, tally);
    }
    return tally;
  };
  /** What a process is the root of, if it is one. */
  const headOf = (proc: ProcUse): Tally | null => {
    const root = rootOf.get(proc.pid);
    if (root) return tallyFor(`agent:${root.agentId}`, () => ({ kind: "agent", name: root.name, where: root.workspace, agentId: root.agentId }));
    const udid = simUdid(proc.args);
    if (udid) return tallyFor(`sim:${udid}`, () => ({ kind: "sim", name: opts.simName?.(udid) ?? "Simulator", where: null, agentId: null }));
    return null;
  };
  const ownerOf = (proc: ProcUse): Tally | null => {
    const chain: number[] = [];
    let found: Tally | null = null;
    for (let at: ProcUse | undefined = proc, depth = 0; at && at.pid > 1 && depth < MAX_ANCESTRY; at = table.get(at.ppid), depth++) {
      const known = owner.get(at.pid);
      if (known !== undefined) {
        found = known;
        break;
      }
      chain.push(at.pid);
      const head = headOf(at);
      if (head) {
        found = head;
        break;
      }
    }
    for (const pid of chain) owner.set(pid, found);
    return found;
  };

  for (const proc of table.values()) {
    if (simUdid(proc.args)) sims++;
    const held = ownerOf(proc);
    const tally =
      held ??
      (opts.self?.has(proc.pid)
        ? tallyFor("app:Kururu", () => ({ kind: "app", name: "Kururu", where: null, agentId: null }))
        : tallyFor(`app:${appName(proc.args)}`, () => ({ kind: "app", name: appName(proc.args), where: null, agentId: null })));
    const cpu = Number.isFinite(proc.cpu) ? proc.cpu : 0;
    tally.cpu += cpu;
    tally.rss += proc.rss;
    tally.processes++;
    if (tally.kind !== "app") {
      const name = toolName(proc.args);
      const tool = tally.tools.get(name) ?? { cpu: 0, rss: 0, n: 0 };
      tool.cpu += cpu;
      tool.rss += proc.rss;
      tool.n++;
      tally.tools.set(name, tool);
    }
  }

  const n = opts.top ?? MAC_TOP;
  const all = [...tallies.values()];
  const byCpu = [...all].sort((a, b) => b.cpu - a.cpu || a.key.localeCompare(b.key)).slice(0, n);
  const byMem = [...all].sort((a, b) => b.rss - a.rss || a.key.localeCompare(b.key)).slice(0, n);
  const cores = Math.max(1, opts.cores);
  const top = [...new Set([...byCpu, ...byMem])].map(
    (t): MacConsumer => ({
      key: t.key,
      kind: t.kind,
      name: t.name,
      where: t.where,
      what: t.kind === "app" ? null : whatOf(t.tools),
      cpu: Math.round((t.cpu / cores) * 10) / 10,
      memMb: Math.round(t.rss / MB),
      processes: t.processes,
      agentId: t.agentId,
    }),
  );
  return { top, sims };
}

/** The consumers in one of the window's two orders. */
export function sortConsumers(top: readonly MacConsumer[], by: "cpu" | "mem"): MacConsumer[] {
  return [...top].sort((a, b) => (by === "cpu" ? b.cpu - a.cpu || b.memMb - a.memMb : b.memMb - a.memMb || b.cpu - a.cpu) || a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------
// What to say about it
// ---------------------------------------------------------------------------

export type MacSeverity = "normal" | "warning" | "critical";

export interface MacMood {
  /** The colour: the worst of the slot queue's two gates and the memory pressure. */
  severity: MacSeverity;
  /** The processors' part of it and the memory's, so each figure on the chip wears its own. */
  cpu: MacSeverity;
  mem: MacSeverity;
  /** One or two words: `Calm`, `Busy`, `Overloaded`, `Memory is tight`. */
  word: string;
  /** A sentence or two saying it, and what is behind it when something is. */
  line: string;
}

/** The one or two consumers worth naming for a strain, as a sentence names them, or nothing when none stands out. */
function behind(mac: MacView, by: "cpu" | "mem"): string {
  const worth = (c: MacConsumer) => (by === "cpu" ? c.cpu >= 8 : c.memMb >= 2048);
  const named = sortConsumers(mac.top, by).filter(worth).slice(0, 2);
  const [first, second] = named;
  if (!first) return "";
  const sim = (c: MacConsumer) => c.kind === "sim" && c.name !== "Simulator";
  const one = (c: MacConsumer) => (c.kind !== "sim" ? c.name : sim(c) ? `the ${c.name} simulator` : "a simulator");
  if (!second) return one(first);
  return sim(first) && sim(second) ? `the ${first.name} and ${second.name} simulators` : `${one(first)} and ${one(second)}`;
}

/**
 * What the slot queue admits by, as its view says it. Read here by shape
 * rather than imported, so the queue's module does not come with this one.
 */
export interface QueueGates {
  load1: number;
  freeGb: number;
  minFreeGb: number;
  buildGate: number | null;
  maestroGate: number | null;
}

/**
 * How the Mac is, in the bar's colour and a sentence.
 *
 * The colour keeps the meaning it had while the chip drew the load: amber is
 * builds waiting at the slot queue's gate and red is tests waiting too — the
 * same comparisons as `loadSeverity` in `shared/slots.ts`, and a test holds
 * the two together — so a colour here is never a second opinion about when
 * the Mac is too busy. Memory pressure is added to it, since macOS's own word
 * for "tight" is one no gate was reading.
 *
 * The load is a minute's average, and the sentence says so: a Mac that has
 * just finished a build reads 20% of its cores with a load still twice over
 * them, and "overloaded" would be a lie about the present. That state is
 * "Settling", and the queue goes on waiting through it.
 */
export function macMood(mac: MacView, gates: QueueGates): MacMood {
  const loadLevel = gates.maestroGate !== null && gates.load1 > gates.maestroGate ? 2 : gates.buildGate !== null && gates.load1 > gates.buildGate ? 1 : 0;
  const floorLevel = gates.freeGb < gates.minFreeGb / 2 ? 2 : gates.freeGb < gates.minFreeGb ? 1 : 0;
  const pressure = mac.memory?.pressure ?? null;
  const pressureLevel = pressure === "critical" ? 2 : pressure === "warn" ? 1 : 0;
  const memLevel = Math.max(floorLevel, pressureLevel);
  const said = ["normal", "warning", "critical"] as const;

  const flatOut = mac.cpu >= 85;
  const cpuWord = loadLevel > 0 ? (flatOut ? (loadLevel === 2 ? "Overloaded" : "Very busy") : "Settling") : flatOut ? "Busy" : mac.cpu >= 40 ? "Working" : "Calm";
  const memWord = pressure === "critical" ? "Out of memory" : pressure === "warn" ? "Memory is tight" : floorLevel > 0 ? "Memory is low" : null;
  const word = !memWord ? cpuWord : loadLevel > 0 || flatOut ? `${cpuWord}, ${memWord.toLowerCase()}` : memWord;

  const sentences: string[] = [];
  const now = `${mac.cpu}% of its ${mac.cores} cores are in use`;
  const byCpu = flatOut ? behind(mac, "cpu") : "";
  const mostly = (who: string) => (who ? ` Mostly ${who}.` : "");
  if (loadLevel > 0) {
    const waits = loadLevel === 2 ? "builds and tests are waiting for it to ease" : "new builds are waiting for it to ease";
    const minute = `over the last minute there was ${loadWords(gates.load1, mac.cores)}, so ${waits}.`;
    sentences.push(flatOut ? `O${minute.slice(1)}${mostly(byCpu)}` : `${now} now, but ${minute}`);
  } else if (flatOut) {
    sentences.push(`Every core is in use.${mostly(byCpu)}`);
  } else {
    sentences.push(`${now}.`);
  }
  if (mac.memory && memWord) {
    // The figures are drawn under this line; what it adds is the swap, which is the part that slows a Mac down.
    const lead = memWord === "Out of memory" ? "Memory has run out" : memWord;
    const detail = mac.memory.swapMb >= 1024 ? `, with ${gb(mac.memory.swapMb)} GB pushed out to disk` : `: ${gb(mac.memory.usedMb)} of ${gb(mac.memory.totalMb)} GB in use`;
    const waits = floorLevel > 0 ? " Builds and simulators are waiting for more of it." : "";
    const byMem = behind(mac, "mem");
    sentences.push(`${lead}${detail}.${waits}${byMem === byCpu ? "" : mostly(byMem)}`);
  }
  return { severity: said[Math.max(loadLevel, memLevel)]!, cpu: said[loadLevel]!, mem: said[memLevel]!, word, line: sentences.join(" ") };
}

/**
 * The Mac in one line, for Kuru and for `slot status`, which used to be told
 * "load 146 on 12 cores" and passed it on word for word.
 */
export function macLine(mac: MacView): string {
  const load = mac.load1 < 10 ? Math.round(mac.load1 * 10) / 10 : Math.round(mac.load1);
  const parts = [`CPU ${mac.cpu}% of ${mac.cores} cores in use now`, `load ${load} over the last minute, which is ${loadWords(mac.load1, mac.cores)}`];
  if (mac.memory) {
    const m = mac.memory;
    const pressure = m.pressure === "warn" ? ", tight" : m.pressure === "critical" ? ", run out" : "";
    parts.push(`memory ${gb(m.usedMb)} of ${gb(m.totalMb)} GB in use${pressure}${m.swapMb >= 1024 ? `, ${gb(m.swapMb)} GB swapped` : ""}`);
  }
  if (mac.sims > 0) parts.push(`${mac.sims} simulator${mac.sims === 1 ? "" : "s"} booted`);
  return parts.join("; ");
}
