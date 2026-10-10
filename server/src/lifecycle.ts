/**
 * Why this server is running, and the written record of why the last one is not.
 *
 * The server is restarted constantly and on purpose, and a restart and a crash
 * look the same from a window: the socket closes and the reconnect screen goes
 * up. The difference used to live only in whatever terminal `run.mjs` was
 * printing to, and that terminal is usually the one somebody has just typed
 * `bun run dev` into again, which is the moment the old answer scrolls away.
 * So the reasons are appended to `lifecycle.log` (see `shared/lifecycle.ts` for
 * the line) the moment they are known, by whoever knows them.
 *
 * This file is the server's half: its own start, every way it stops, the two
 * ways it can crash without a chance to say so in the ordinary way, and the
 * pty host as seen from here. That last one is deliberately not the host's own
 * doing. `ptyhost.log` has no timestamps and changing the host to add them
 * means restarting it, which ends every agent. The server notices the host
 * starting and the host going, and it can date both. What the host printed on
 * the way out is read back from its log and attached.
 *
 * It also answers the one question about the supervisor that turned out to
 * matter: is it still there? A server whose runner has died keeps serving and
 * looks entirely healthy. But it no longer restarts on a save, and asking it to
 * restart ends it with nothing to bring it back. `supervised()` is checked at
 * the moment of asking rather than trusted from the environment, because the
 * environment says what was true when the process started.
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  LIFECYCLE_FILE,
  LIFECYCLE_MAX_BYTES,
  parseLifecycle,
  type LifeEvent,
  type LifeWhat,
  type LifecycleReport,
} from "../../shared/lifecycle";

/** How many lines the About page is sent. Enough to see the last restart and what came before it. */
const REPORT_EVENTS = 12;
/** How often to look for the supervisor. Losing it is not urgent, only easy to miss. */
const SUPERVISOR_CHECK_MS = 5_000;
/** How much of `ptyhost.log` to read: its own lines are short and few, and a stack fits. */
const HOST_LOG_TAIL = 16 * 1024;

/** Beside `session.json`, by the rule `persist.ts` uses, so an isolated instance keeps its own record. */
function stateDir(): string {
  return process.env.KURURU_STATE_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "kururu");
}

export function lifecyclePath(): string {
  return join(stateDir(), LIFECYCLE_FILE);
}

const startedAt = new Date().toISOString();
/** What the supervisor said when it started this process: `server/src/harness.ts was saved`, and so on. */
const because = process.env.KURURU_STARTED_BECAUSE?.trim() || null;
/**
 * The supervisor, as the parent this process was born with. When a parent
 * dies its children are handed to pid 1, so a different `ppid` later is
 * exactly "the supervisor is gone".
 */
const supervisor = process.env.KURURU_SUPERVISED === "1" ? process.ppid : null;

/** Whether asking to be restarted would get this process restarted rather than merely ended. */
export function supervised(): boolean {
  return supervisor !== null && process.ppid === supervisor;
}

/** Set once something has said why this process is ending, so the exit hook does not say it again. */
let accounted = false;

/**
 * Append one line. Synchronous on purpose: two of the callers are a process
 * on its way out, and a write that is still queued when it exits is lost.
 *
 * Moving the file aside can race the supervisor writing to it. The worst case
 * is the older generation being replaced by a newer, shorter one, which costs
 * history and never a current line.
 */
export function record(what: LifeWhat, why: string, extra: Partial<LifeEvent> = {}): void {
  if (what === "stop" || what === "crash") accounted = true;
  const event: LifeEvent = { at: new Date().toISOString(), by: "server", pid: process.pid, what, why, ...extra };
  try {
    const file = lifecyclePath();
    mkdirSync(stateDir(), { recursive: true });
    if (existsSync(file) && statSync(file).size > LIFECYCLE_MAX_BYTES) renameSync(file, `${file}.1`);
    appendFileSync(file, `${JSON.stringify(event)}\n`);
  } catch {
    // A record that cannot be written is not a reason to stop serving.
  }
}

/** This server's start, which is when it is actually listening rather than when it was spawned. */
export function recordStart(port: number, version: string): void {
  const how =
    supervisor === null
      ? "and nothing is supervising it"
      : because
        ? `because ${because}`
        : "under a supervisor that did not say why";
  record("start", `listening on :${port} (v${version}), ${how}`, { version });
}

/**
 * The two ways this process dies without saying so itself.
 *
 * `uncaughtExceptionMonitor` rather than `uncaughtException`, because the
 * monitor watches without handling. The process still dies exactly as it
 * did, with Node's own stack on stderr, and the record is only a copy of that
 * stack with a time on it. An unhandled rejection arrives here too, with its
 * own origin, because Node's default is to throw it.
 *
 * The exit hook is for every other way out, so that a `process.exit` nobody
 * thought to annotate still leaves a line rather than a gap.
 */
export function recordCrashes(): void {
  process.on("uncaughtExceptionMonitor", (err: unknown, origin) => {
    const error = err instanceof Error ? err : new Error(String(err));
    const kind = origin === "unhandledRejection" ? "an unhandled rejection" : "an uncaught exception";
    record("crash", `${kind}: ${error.message}`, { error: `${error.name}: ${error.message}`, stack: error.stack ?? "" });
  });
  process.on("exit", (code) => {
    if (!accounted) record("stop", `exited with code ${code}, and nothing said why`, { code });
  });
}

/**
 * Notice the supervisor going, once, and write it down. Nothing is done about
 * it beyond that and `supervised()` turning false. A server with no supervisor
 * is still the one the window is drawing, and ending it to make a point would
 * be the window's loss.
 */
export function watchSupervisor(): void {
  if (supervisor === null) return;
  const timer = setInterval(() => {
    if (process.ppid === supervisor) return;
    clearInterval(timer);
    record(
      "orphaned",
      `its supervisor (pid ${supervisor}) has gone, so a save will not restart it and prefix+B is refused rather than ending it`,
    );
    console.error("kururu: the process supervising this server has gone — restart `bun run dev` to get the watcher back");
  }, SUPERVISOR_CHECK_MS);
  timer.unref();
}

/** The cheap half of the report, with no file read: `/api/health` is asked often. */
export function lifeNow(): Omit<LifecycleReport, "events" | "file"> {
  return { startedAt, because, supervised: supervised(), orphaned: supervisor !== null && !supervised(), supervisor };
}

/**
 * Who is holding the host's socket, or null.
 *
 * For the one thing this server does to the host on purpose: asking it to
 * stop so a new one can be started (`/api/host/restart`). Found by the
 * socket and never by name, on `kill-hosts.mjs`'s argument, and the command
 * line is a guard rather than the search: something else holding a file of
 * that name is not a process to signal.
 */
export function socketHolder(path: string): number | null {
  if (!existsSync(path)) return null;
  try {
    const first = execFileSync("lsof", ["-t", path], { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] })
      .trim()
      .split("\n")[0];
    const pid = Number(first);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const command = execFileSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000 });
    return command.includes("ptyhost") ? pid : null;
  } catch {
    return null;
  }
}

/** The last lines of the record, the older generation first so a fresh file still has a past. */
export function recentLife(count: number): LifeEvent[] {
  const file = lifecyclePath();
  let text = "";
  for (const path of [`${file}.1`, file]) {
    try {
      text += `${readFileSync(path, "utf8")}\n`;
    } catch {
      // Not written yet, or never moved aside.
    }
  }
  return parseLifecycle(text).slice(-count);
}

export function lifecycleReport(): LifecycleReport {
  const home = homedir();
  const file = lifecyclePath();
  return { ...lifeNow(), events: recentLife(REPORT_EVENTS), file: file.startsWith(home) ? `~${file.slice(home.length)}` : file };
}

// ---------------------------------------------------------------------------
// The pty host, from outside
// ---------------------------------------------------------------------------

/** The end of a file, or nothing. For a log, which is only ever read from the bottom. */
export function readTail(path: string, bytes = HOST_LOG_TAIL): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** The line a host prints once it is listening, which is the only landmark its log has. Kept in step with `ptyhostd.ts`. */
const HOST_LISTENING = "kururu pty host  ";

export interface HostEnding {
  /** A predicate, for the caller's own subject: "crashed: …", "was stopped by SIGTERM …". */
  how: string;
  error?: string;
  stack?: string;
}

/**
 * How the last host ended, read from what it printed after it came up, or
 * null when the log has no host in it to ask about.
 *
 * A host stopped by a signal says so in a line of its own. A host that crashed
 * has Node's stack on its stderr, which is this same file. A host that said
 * nothing was killed by something that does not ask, SIGKILL or the
 * machine going down. The duplicate a racing server spawns says it is
 * redundant and leaves, and that is not news about the real one.
 */
export function hostEnding(log: string): HostEnding | null {
  const lines = log.split("\n");
  let listening = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.startsWith(HOST_LISTENING)) {
      listening = i;
      break;
    }
  }
  if (listening === -1) return null;
  const said = lines
    .slice(listening + 1)
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.includes("one is already listening"));

  for (const line of said) {
    const stopped = /^kururu pty host: (\S+) — stopping (\d+) agent/.exec(line);
    if (stopped) return { how: `was stopped by ${stopped[1]} with ${stopped[2]} agent(s) running` };
  }
  const error = said.find((line) => /^([A-Z]\w*)?(Error|Exception)\b|^libc\+\+abi:|^FATAL ERROR/.test(line));
  const stack = said.length ? { stack: said.slice(-40).join("\n") } : {};
  if (error) return { how: `crashed: ${error}`, error, ...stack };
  return { how: "ended without a word, which is SIGKILL or the machine going down", ...stack };
}

/**
 * Whether anything is holding the host's socket, or null when that cannot be
 * found out.
 *
 * Asked when the link drops, to tell two very different events apart. The host
 * takes one server at a time and drops the older when a second connects, so a
 * live host behind a dropped link means another server arrived, and the agents
 * are fine. Connecting to find out is not an option: that *is* a second server
 * arriving, and the host would drop whichever server was left.
 */
export function socketHeld(path: string): boolean | null {
  if (!existsSync(path)) return false;
  try {
    const holders = execFileSync("lsof", ["-t", path], { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] });
    return holders.trim().length > 0;
  } catch (err) {
    // lsof exits 1 when nothing holds the file. Absent or timed out, it has not answered.
    return (err as { status?: number }).status === 1 ? false : null;
  }
}
