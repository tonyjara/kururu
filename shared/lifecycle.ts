/**
 * The shape of `lifecycle.log`, which is the record of why the server came and
 * went.
 *
 * A reconnect screen says that the socket closed and nothing else, and at
 * least five different things close it: a save under `bun run dev`, `prefix+B`,
 * the Share toggle, a crash, and a build that failed and left nothing to start.
 * Until this file existed the only place any of them was said was the terminal
 * `run.mjs` was started from, which scrolls, belongs to one machine, and
 * forgets everything the moment somebody starts the runner again in it. That
 * is precisely the moment the question gets asked.
 *
 * Three different processes write to it, which is the reason it is a format and
 * not a function. The server knows why *it* is stopping (a window asked, the
 * socket has to rebind, an exception). Only its supervisor knows what it saw
 * from outside (which file was saved, which signal killed it, that the build
 * failed), and the supervisor is `server/run.mjs` in a checkout and
 * `desktop/main.js` in the app — plain JavaScript that cannot import this file.
 * Those two write the same line by hand and say so where they do.
 *
 * One JSON object per line rather than prose, because `bun run status`, the
 * About page and a person with `tail` all read it, and only one of them can
 * read a sentence without help. The sentence is there anyway, in `why`, so the
 * other two never have to compose one.
 */

/** Who wrote a line: the dev runner, the desktop app's supervisor, or the server itself. */
export type LifeWriter = "runner" | "app" | "server";

/**
 * What kind of line it is.
 *
 * `crash` and `down` are kept apart because they are opposite instructions. A
 * crash is a bug to go and read. `down` is a build that failed, which a save
 * will mend on its own. `orphaned` is its own word because it is the
 * quiet one: a server whose supervisor has gone away keeps on serving, and
 * nothing about it looks wrong until a save fails to restart it.
 */
export type LifeWhat = "start" | "restart" | "stop" | "crash" | "down" | "orphaned" | "host";

const WRITERS: readonly LifeWriter[] = ["runner", "app", "server"];
const WHATS: readonly LifeWhat[] = ["start", "restart", "stop", "crash", "down", "orphaned", "host"];

export interface LifeEvent {
  /** ISO 8601, UTC. A reader turns it into local time; the file never does. */
  at: string;
  by: LifeWriter;
  /** The writer's pid. */
  pid: number;
  what: LifeWhat;
  /** One sentence, written by whoever knew. Readers print it as it is. */
  why: string;
  /** The server a supervisor's line is about, which is not the supervisor's own pid. */
  server?: number;
  /** The saved file behind a restart, relative to the checkout. */
  file?: string;
  code?: number | null;
  signal?: string | null;
  /** The error's own line, for a crash or a failed build. */
  error?: string;
  stack?: string;
  version?: string;
}

/** The file, in the state directory beside `session.json` and the host's socket. */
export const LIFECYCLE_FILE = "lifecycle.log";

/**
 * How big it gets before it is moved aside to `lifecycle.log.1`. One older
 * generation is kept and that is all. A watch restart is about 200 bytes, so
 * this is a week or two of an ordinary day's saves, and a crash's stack is a
 * few kilobytes and does not change that sum much.
 */
export const LIFECYCLE_MAX_BYTES = 256 * 1024;

/** What `/api/lifecycle` answers: this server's own story, then the file's last lines. */
export interface LifecycleReport {
  startedAt: string;
  /** What the supervisor said when it started this server, or null if nothing did. */
  because: string | null;
  /** Something will start this server again if it asks: a supervisor, and still alive. */
  supervised: boolean;
  /** It had a supervisor and lost it, which is a different thing from never having had one. */
  orphaned: boolean;
  /** Oldest first, as the file has them. */
  events: LifeEvent[];
  file: string;
}

/**
 * Read lines back, keeping the ones that are whole.
 *
 * Tolerant on purpose. The file is appended to by three processes, and moving
 * it aside can race a writer, so a line torn in half is a thing that happens.
 * It is also a file a person may edit. A record with one bad line in it
 * is still a record, so the bad line is dropped and the rest are kept.
 */
export function parseLifecycle(text: string): LifeEvent[] {
  const events: LifeEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const event = adoptEvent(raw);
    if (event) events.push(event);
  }
  return events;
}

function adoptEvent(raw: unknown): LifeEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.at !== "string" || !Number.isFinite(Date.parse(r.at))) return null;
  if (!WRITERS.includes(r.by as LifeWriter) || !WHATS.includes(r.what as LifeWhat)) return null;
  if (typeof r.pid !== "number" || !Number.isFinite(r.pid) || typeof r.why !== "string") return null;
  const event: LifeEvent = { at: r.at, by: r.by as LifeWriter, pid: r.pid, what: r.what as LifeWhat, why: r.why };
  if (typeof r.server === "number" && Number.isFinite(r.server)) event.server = r.server;
  if (typeof r.file === "string") event.file = r.file;
  if ((typeof r.code === "number" && Number.isFinite(r.code)) || r.code === null) event.code = r.code;
  if (typeof r.signal === "string" || r.signal === null) event.signal = r.signal;
  if (typeof r.error === "string") event.error = r.error;
  if (typeof r.stack === "string") event.stack = r.stack;
  if (typeof r.version === "string") event.version = r.version;
  return event;
}
