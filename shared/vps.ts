/**
 * What a VPS is to kururu, and how one sample of it is read.
 *
 * A machine somebody rents to hold their databases is a thing they want to
 * glance at from the same sidebar that shows what their agents are spending —
 * is the CPU pinned, is the RAM full, is the disk filling.
 * The question was how to get the numbers, and the answer chosen is the one
 * that asks the VPS for nothing: kururu runs `ssh` with the user's own
 * `~/.ssh/config`, and one fixed script reads `/proc` and `df`.
 *
 * The alternatives were each worse in a way that mattered. An agent on the box
 * (node_exporter, Netdata, Beszel) is a daemon to install, update and firewall,
 * and a port to open on a machine whose whole security story is that almost
 * none are. Dokploy's own monitoring endpoint is the same port problem plus a
 * token kururu would have to hold. SSH is already open, already key-only, and
 * already the thing the user uses to reach the box — so the only new trust is
 * that the kururu server may run *one script it wrote itself* there. What that
 * script is lives in `server/src/vps.ts`, and no part of it ever comes from a
 * client: a client names a host and nothing else. `panel` is a link back to the
 * Dokploy dashboard for whatever the numbers say needs doing.
 *
 * Three figures and no more — CPU, memory, disk. A first version also read
 * load, uptime, swap and `docker stats`, and was trimmed to what gets looked
 * at; `docker stats` alone was two seconds of work on the box every poll.
 *
 * Pure, and in `shared/` rather than beside the ssh call, because the parse is
 * the part worth testing and the wire types are the part both halves import.
 */

/** One machine as the user entered it. Kept in `~/.config/kururu/vps.json`. */
export interface VpsEntry {
  id: string;
  /** What the sidebar calls it. */
  name: string;
  /**
   * What `ssh` is handed: an alias from `~/.ssh/config`, or `user@host`.
   * Checked by `validHost` everywhere it is read, because it lands in an argv.
   */
  host: string;
  /** The Dokploy (or any) dashboard, http(s) only, for the name to link to. */
  panel: string | null;
}

export interface VpsUsed {
  used: number;
  total: number;
}

/** One sample. Every figure is optional: a box with a `df` in another shape is still a box. */
export interface VpsReading {
  /** When it was taken. */
  at: number;
  /** Busy share of all cores over the second the script spent sleeping, 0–100. */
  cpu: number | null;
  /** Bytes, `used` meaning total minus *available* — page cache is not pressure. */
  mem: VpsUsed | null;
  /** The root filesystem, in bytes. */
  disk: VpsUsed | null;
}

/**
 * A machine and what is known about it, which is what crosses the wire.
 *
 * `stale` and `error` together, rather than dropping the reading on a failed
 * poll, for the usage bar's reason: numbers from a minute ago are still the best
 * known, and the one thing the row must not do is look current when it is not.
 */
export interface VpsStatus extends VpsEntry {
  reading: VpsReading | null;
  stale: boolean;
  /** Why the last attempt failed, in ssh's words, or null if it did not. */
  error: string | null;
}

/**
 * An ssh destination that cannot be read as an option.
 *
 * The one thing a client puts into a command line kururu runs, so the whole
 * grammar is spelt out rather than escaped: letters, digits, dot, dash and
 * underscore, one optional `user@`, and never a leading dash — `-oProxyCommand=…`
 * is a host name only to a parser that did not look.
 */
export function validHost(host: unknown): host is string {
  return (
    typeof host === "string" &&
    host.length <= 253 &&
    /^(?:[A-Za-z0-9_][A-Za-z0-9._-]*@)?[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(host)
  );
}

/** An http(s) URL, normalised, or null. Anything else — `javascript:` first — is refused. */
export function validPanel(panel: unknown): string | null {
  if (typeof panel !== "string" || !panel.trim()) return null;
  try {
    const url = new URL(panel.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** A name worth drawing: trimmed, bounded, and the host when there is none. */
export function vpsName(name: unknown, host: string): string {
  const trimmed = typeof name === "string" ? name.trim().slice(0, 40) : "";
  return trimmed || host;
}

/**
 * The saved list, adopted rather than trusted — it is a file a person can edit,
 * and it becomes an argv. An entry that fails is dropped rather than repaired,
 * and a duplicate id keeps the first.
 */
export function adoptVpsList(raw: unknown): VpsEntry[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: VpsEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { id, name, host, panel } = item as Record<string, unknown>;
    if (typeof id !== "string" || !id || seen.has(id) || !validHost(host)) continue;
    seen.add(id);
    out.push({ id, name: vpsName(name, host), host, panel: validPanel(panel) });
  }
  return out;
}

/**
 * What the collecting script prints between sections. A line of its own, which
 * nothing in `/proc` or `df` can produce.
 */
export const VPS_SEP = "@@kururu@@";

/**
 * Read one run of the script: the sections, in the order it prints them.
 *
 *   0 `/proc/stat`'s cpu line   1 meminfo (two lines)   2 `df -kP /`'s row
 *   3 the cpu line again
 *
 * The cpu line is read twice, a second apart, because a CPU percentage is a
 * rate and one sample of a counter is not one. Reading it across the script
 * rather than across two polls means the first reading after a start already
 * has a figure, and a missed poll never turns into a figure averaged over a
 * minute.
 */
export function parseVpsSample(text: string, at: number): VpsReading {
  const parts = text.split(`${VPS_SEP}\n`).map((part) => part.trim());
  const section = (i: number) => parts[i] ?? "";
  return {
    at,
    cpu: cpuBetween(section(0), section(3)),
    mem: memoryFrom(section(1)),
    disk: diskFrom(section(2)),
  };
}

/**
 * `cpu  user nice system idle iowait irq softirq steal guest guest_nice`.
 * Busy is everything but idle and iowait over the first eight — guest time is
 * already inside user, and counting it twice is how a box reads 110%.
 */
function cpuBetween(a: string, b: string): number | null {
  const fields = (line: string) => {
    const nums = line.split(/\s+/).slice(1, 9).map(Number);
    return nums.length === 8 && nums.every(Number.isFinite) ? nums : null;
  };
  const x = fields(a);
  const y = fields(b);
  if (!x || !y) return null;
  const total = (n: number[]) => n.reduce((s, v) => s + v, 0);
  const idle = (n: number[]) => n[3]! + n[4]!;
  const dt = total(y) - total(x);
  if (dt <= 0) return null;
  const busy = dt - (idle(y) - idle(x));
  return Math.min(100, Math.max(0, (busy / dt) * 100));
}

function memoryFrom(text: string): VpsUsed | null {
  const kb = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = /^(\w+):\s+(\d+)\s*kB/.exec(line.trim());
    if (match) kb.set(match[1]!, Number(match[2]) * 1024);
  }
  const total = kb.get("MemTotal");
  const available = kb.get("MemAvailable");
  if (total === undefined || available === undefined || total <= 0) return null;
  return { used: Math.max(0, total - available), total };
}

/**
 * `df -kP /`: filesystem, 1024-blocks, used, available, capacity, mount. The
 * total is used plus available rather than the block count, because the blocks
 * reserved for root are in neither and `df`'s own percentage leaves them out
 * too — a bar that disagreed with `df` by five percent would be distrusted.
 */
function diskFrom(line: string): VpsUsed | null {
  const cols = line.split(/\s+/);
  const used = Number(cols[2]);
  const avail = Number(cols[3]);
  if (!Number.isFinite(used) || !Number.isFinite(avail) || used + avail <= 0) return null;
  return { used: used * 1024, total: (used + avail) * 1024 };
}

/**
 * Green, amber, red for a share of something finite.
 *
 * The usage bar refuses to pick thresholds because the account states its own.
 * A VPS states nothing, so these are kururu's, and they are the ordinary ones: a
 * quarter left is worth a look, a tenth left is worth acting on.
 */
export function vpsSeverity(percent: number): "normal" | "warning" | "critical" {
  return percent >= 90 ? "critical" : percent >= 75 ? "warning" : "normal";
}

/** `8131476 * 1024` → `7.8G`. Binary units, one decimal under ten, because that is what `free -h` prints. */
export function formatBytes(n: number): string {
  const units = ["B", "K", "M", "G", "T"];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  const digits = value < 10 && i > 0 ? 1 : 0;
  return `${value.toFixed(digits)}${units[i]}`;
}
