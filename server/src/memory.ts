/**
 * How much memory a terminal is holding.
 *
 * An agent is usually the largest process on a machine that is also running a
 * dev server, an editor and a browser, and once three agents are up at once the
 * question stops being "is it working" and becomes "which of these is the one
 * costing me the laptop". Kururu already knows the pid on the end of every pty,
 * so the answer is one `ps` away — and the sidebar row is where somebody is
 * already looking when they ask it.
 *
 * The figure is the resident set of *everything under the pty*, added up: the
 * shell, the agent, and whatever the agent has forked this second. Two things
 * follow from that and both are worth stating rather than discovering. Shared
 * pages are counted once per process that maps them, so a sum over a tree is an
 * over-estimate — an agent that has four `git`s out briefly reads a few
 * megabytes fatter than it is. And resident means resident: a process the
 * kernel has compressed or swapped out shrinks here while costing exactly what
 * it cost before, which is not a rounding error but the whole reason three
 * ghosttown daemons once read as under 100 MB apiece while holding 25 GB
 * between them and starving the machine. This number finds the process that is
 * big right now. It cannot find the one that got big an hour ago.
 *
 * It reads its own `ps` rather than sharing the dev scan's next door, for two
 * reasons that point the same way. The column it wants is a number where that
 * scan's line is a kilobyte of argv, so the narrow read is a twentieth of the
 * output; and they are not the same question — this asks about every terminal,
 * while `devRoots` deliberately withholds the ones with an agent in them, which
 * are exactly the rows this gets drawn on.
 *
 * Server-side like `activity` and `lastAgent`, and for the reason both of those
 * are: it is learnt from the process table rather than from a pty, so the half
 * of kururu that cannot be restarted never has to hear about it, and improving
 * it costs nobody a running agent. A restart forgets it and the next poll, five
 * seconds later, fills it back in.
 */
import { execFile } from "node:child_process";

/** One process, as much of it as adding up memory needs. */
export interface ProcMem {
  pid: number;
  ppid: number;
  /** Resident set in bytes. `ps` prints kilobytes on both macOS and Linux. */
  rss: number;
}

export type MemTable = Map<number, ProcMem>;

/** `ps -eo pid=,ppid=,rss=` into pid → {ppid, rss}. */
export function parseProcMem(out: string): MemTable {
  const byPid: MemTable = new Map();
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    byPid.set(pid, { pid, ppid: Number(m[2]) || 0, rss: Number(m[3]) * 1024 });
  }
  return byPid;
}

/** ppid → children, built once per scan and shared by every terminal's walk. */
export function childIndex(table: MemTable): Map<number, ProcMem[]> {
  const index = new Map<number, ProcMem[]>();
  for (const proc of table.values()) {
    const siblings = index.get(proc.ppid);
    if (siblings) siblings.push(proc);
    else index.set(proc.ppid, [proc]);
  }
  return index;
}

/** Backstop so a fork bomb in a pty cannot make the poll expensive. */
const MAX_VISITED = 4000;

/**
 * Everything under a pty, added up, or null if the pty's own process is not in
 * the table — which is what a terminal that exited between the snapshot and the
 * `ps` looks like, and is a different answer from zero.
 *
 * Unlike the walks in `procs.ts` and `devservers.ts` there is no depth cap.
 * Those are looking for *one* process and stop at the shallowest match, so a cap
 * only bounds the search; this is adding all of them up, and a build running
 * under a dev server running under a shell is memory the terminal is holding
 * however deep it sits. What is kept is the visit cap and the seen set — the
 * second guards against a table that describes a cycle, which a straight read of
 * `ps` should not contain but a pid recycled mid-read can fake.
 */
export function memoryUnder(
  rootPid: number,
  table: MemTable,
  children: Map<number, ProcMem[]>,
): number | null {
  const root = table.get(rootPid);
  if (!root) return null;
  const seen = new Set<number>();
  let total = 0;
  let frontier: ProcMem[] = [root];
  while (frontier.length > 0 && seen.size < MAX_VISITED) {
    const next: ProcMem[] = [];
    for (const proc of frontier) {
      if (seen.has(proc.pid)) continue;
      seen.add(proc.pid);
      total += proc.rss;
      const kids = children.get(proc.pid);
      if (kids) next.push(...kids);
    }
    frontier = next;
  }
  return total;
}

/**
 * One pass over every terminal: `roots` maps agent id → the pid its pty is
 * running. Terminals whose process has gone are absent rather than zero.
 */
export function measureMemory(
  roots: Iterable<[string, number]>,
  table: MemTable,
): Map<string, number> {
  const out = new Map<string, number>();
  if (table.size === 0) return out;
  const children = childIndex(table);
  for (const [agentId, pid] of roots) {
    const held = memoryUnder(pid, table, children);
    if (held !== null) out.set(agentId, coarsen(held));
  }
  return out;
}

const MB = 1024 * 1024;

/**
 * The figure as it will be read, and therefore the only change worth sending.
 *
 * Memory never holds still. A working agent moves by megabytes between polls and
 * every `git` it forks is a blip, so a map keyed on the exact byte count would
 * broadcast a snapshot to every client every five seconds for the rest of the
 * session, to redraw digits nobody could see change. Rounding here rather than
 * in the browser is what makes "has it changed" answerable on the side that
 * decides whether to send — two figures is what the sidebar draws (`390 MB`,
 * `1.4 GB`), so anything finer than this genuinely is not a change.
 */
export function coarsen(bytes: number): number {
  if (bytes <= 0) return 0;
  const step = bytes >= 1024 * MB ? 100 * MB : bytes >= 100 * MB ? 10 * MB : MB;
  return Math.round(bytes / step) * step;
}

/**
 * `ps -eo pid=,ppid=,rss=` over a busy machine is about 25 KB, which is nowhere
 * near execFile's default ceiling — but the ceiling kills the child rather than
 * truncating, and a scan that silently found nothing is the worst shape a poll
 * can fail in. The dev scan says the same thing about a much bigger read.
 */
const MAX_BUFFER = 8 * 1024 * 1024;

/** The whole table. Empty when ps fails — a failed poll is not an error. */
export function readProcMem(): Promise<MemTable> {
  return new Promise((resolve) => {
    execFile("ps", ["-eo", "pid=,ppid=,rss="], { maxBuffer: MAX_BUFFER }, (err, stdout) => {
      resolve(err && !stdout ? new Map() : parseProcMem(stdout));
    });
  });
}

/** What each of those terminals is holding, in bytes, rounded to what is drawn. */
export async function scanMemory(
  roots: Iterable<[string, number]> = [],
): Promise<Map<string, number>> {
  return measureMemory(roots, await readProcMem());
}
