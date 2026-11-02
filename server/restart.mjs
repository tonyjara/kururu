/**
 * Whether the runner starts a server again after it crashed, and when.
 *
 * It used to be never: a crash was left down on purpose, because a supervisor
 * that resurrects a server which cannot start — a port taken, a bad build, an
 * edit half saved — is a loop that fills a terminal with one error forever,
 * and the error is the useful part. That is still the answer for a server that
 * dies young. It is the wrong one for a server that ran for an hour and hit a
 * rare bug at three in the morning while a phone was the only client: the
 * installed app's runner exited with it, and kururu stayed down until somebody
 * was at the Mac to notice. So a server that had been up longer than
 * `RESTART_AFTER_UP_MS` is started again, after a wait that grows with each
 * crash inside `CRASH_WINDOW_MS`: one that keeps dying after a minute or two
 * is restarted at most once a minute rather than in a tight loop.
 *
 * Not a crash, and so never restarted: exit 0, which is a server choosing to
 * stop (stepping aside for a newer one), and the signals somebody sends to
 * stop a process on purpose. Exit 75 is a restart asked for and never reaches
 * here.
 *
 * Its own file so a test can import it — `run.mjs` runs as soon as it is
 * loaded — and loaded by `run.mjs` with a fallback, so that a runner whose
 * copy of this is missing still starts and simply behaves as it used to.
 */

/** Up this long, a crash is a bug met in the field rather than a server that cannot start. */
export const RESTART_AFTER_UP_MS = 60_000;

/** How long before each start again, by how many crashes there have been inside the window, this one included. */
export const RESTART_BACKOFF_MS = [1_000, 5_000, 15_000, 30_000, 60_000];

/** How far back crashes count towards the wait. */
export const CRASH_WINDOW_MS = 10 * 60_000;

/** The signals a person or a supervisor sends to stop a process, which a crash is not. */
const STOPPED_ON_PURPOSE = new Set(["SIGTERM", "SIGINT", "SIGHUP"]);

/**
 * How long to wait before starting the server again, or null to leave it down.
 *
 * @param {{ upMs: number, code: number | null, signal: string | null, crashes: readonly number[], now: number }} exit
 *   `crashes` are the times of the crashes before this one, oldest first.
 * @returns {number | null}
 */
export function restartDelay({ upMs, code, signal, crashes, now }) {
  if (signal ? STOPPED_ON_PURPOSE.has(signal) : code === 0) return null;
  if (!Number.isFinite(upMs) || upMs < RESTART_AFTER_UP_MS) return null;
  const recent = crashes.filter((at) => now - at < CRASH_WINDOW_MS).length;
  const step = Math.min(recent, RESTART_BACKOFF_MS.length - 1);
  return RESTART_BACKOFF_MS[step] ?? null;
}
