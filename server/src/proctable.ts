/**
 * One read of the machine's process table, for every question this server
 * asks of it.
 *
 * Two polls used to ask separately: the dev-server scan ran `ps -eo
 * pid,ppid,args` every three seconds and the memory poll `ps -eo pid,ppid,rss`
 * every five, each a fork and a walk of every process on the Mac, together
 * with the scan's `lsof` about four or five per cent of a core whatever the
 * agents were doing. The columns are one `ps` apart, so they are one `ps`:
 * `args` last, because it is the one column with spaces in it.
 *
 * `pcpu` rides along for the bar's "This Mac" chip (`mac.ts`), which names
 * whoever is using the processors off this same read rather than fork a `ps`
 * or a `top` of its own to find out.
 *
 * The pty host reads the table too (`agents/procs.ts`), every two seconds, for which program each
 * pty is running. That one stays: it is host code, a change there costs every
 * agent, and the host cannot borrow a reading from a server it outlives.
 */
import { execFile } from "node:child_process";

export interface ProcRow {
  pid: number;
  ppid: number;
  /** Resident set in bytes. `ps` prints kilobytes on both macOS and Linux. */
  rss: number;
  /** The processor it is using, as `ps` says it: a share of one core, so 146 is a core and a half. */
  cpu: number;
  /** argv joined, as ps prints it. */
  args: string;
}

export type ProcRows = ReadonlyMap<number, ProcRow>;

/**
 * `ps -eo pid=,ppid=,rss=,pcpu=,args=` into pid → row. A line that does not
 * parse is skipped, as a process that exited mid-read is. The share is read
 * with a comma too: `ps` prints it in the locale's decimals.
 */
export function parseProcRows(out: string): Map<number, ProcRow> {
  const byPid = new Map<number, ProcRow>();
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+(?:[.,]\d+)?)(?:\s(.*))?$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    byPid.set(pid, { pid, ppid: Number(m[2]) || 0, rss: Number(m[3]) * 1024, cpu: Number(m[4]!.replace(",", ".")) || 0, args: (m[5] ?? "").trim() });
  }
  return byPid;
}

/**
 * `ps` with `args` over a busy machine runs to a few hundred KB, so the 1 MB
 * default ceiling is not the headroom it looks like: overflowing it kills the
 * child and the poll silently finds nothing.
 */
const MAX_BUFFER = 8 * 1024 * 1024;

/** The whole table. Empty when ps fails — a failed poll is not an error, and the next is seconds away. */
export function readProcRows(): Promise<ProcRows> {
  return new Promise((resolve) => {
    execFile("ps", ["-eo", "pid=,ppid=,rss=,pcpu=,args="], { maxBuffer: MAX_BUFFER }, (err, stdout) => {
      resolve(err && !stdout ? new Map() : parseProcRows(stdout));
    });
  });
}
