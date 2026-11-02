/**
 * Why a timer's callback is never handed a bare `void poll()`.
 *
 * The server asks the machine a dozen questions on a clock — dev servers,
 * branches, editors, memory, the usage bar, the machines, the outbox, the
 * remote screens — and each was written as `setInterval(() => void poll())`.
 * That is safe exactly as long as every helper under `poll` resolves rather
 * than rejects, which is a property nobody checks and the next edit can take
 * away: a broadcast that throws, a SQLite write on a full disk. A rejected
 * promise nobody awaits is an unhandled rejection, Node ends the process over
 * it, and `lifecycle.ts` can only write down afterwards that the server died —
 * every window reconnecting over a question about memory.
 *
 * So one wrapper catches both a throw and a rejection, and says so on stderr,
 * which the runner keeps as `server.log`. It says so once per kind of failure
 * rather than every tick: a sweep that fails every two seconds would otherwise
 * bury everything else in the log, and the first line is the one with the
 * stack. The same message is said again only after `REPEAT_MS`, with how many
 * times it failed in between, and a sweep that comes back says that too, so
 * the log does not leave a failure standing that has gone.
 *
 * Rejected: making each poll catch for itself. Most already do, and that is
 * the trouble — the guarantee is spread over a dozen functions and holds only
 * while all of them remember it. The loop is the one place it can be kept.
 */

/** How long a failure that keeps happening goes before it is said again. */
export const REPEAT_MS = 10 * 60_000;

export type SweepLog = (line: string) => void;

interface SweepOptions {
  log?: SweepLog;
  now?: () => number;
}

const toStderr: SweepLog = (line) => console.error(line);

function describe(err: unknown): { key: string; text: string } {
  if (err instanceof Error) return { key: err.message, text: err.stack ?? err.message };
  const text = String(err);
  return { key: text, text };
}

/**
 * `run`, made safe to hand to `setInterval` or to call bare: it never throws and
 * never returns a promise that rejects. The returned function returns the
 * sweep's own promise (settled, never rejected) so a caller or a test can wait
 * for one pass.
 */
export function sweep(name: string, run: () => unknown, options: SweepOptions = {}): () => Promise<void> {
  const log = options.log ?? toStderr;
  const now = options.now ?? Date.now;
  let failing: { key: string; at: number; since: number } | null = null;

  const failed = (err: unknown): void => {
    const { key, text } = describe(err);
    const at = now();
    if (failing && failing.key === key && at - failing.at < REPEAT_MS) {
      failing.since += 1;
      return;
    }
    const again = failing && failing.key === key ? ` (again; ${failing.since} more time${failing.since === 1 ? "" : "s"} since it was last said)` : "";
    log(`kururu: the ${name} sweep failed${again}: ${text}`);
    failing = { key, at, since: 0 };
  };

  const succeeded = (): void => {
    if (!failing) return;
    log(`kururu: the ${name} sweep works again`);
    failing = null;
  };

  return () => {
    let result: unknown;
    try {
      result = run();
    } catch (err) {
      failed(err);
      return Promise.resolve();
    }
    if (result instanceof Promise) return result.then(succeeded, failed);
    succeeded();
    return Promise.resolve();
  };
}
