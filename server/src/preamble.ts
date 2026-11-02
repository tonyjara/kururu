/**
 * What this process does before any of kururu's own modules has run.
 *
 * It was the head of `index.ts`, and it ran first because a module's body runs
 * after everything it imports. Once that file was cut into modules, their
 * bodies — the settings read off disk, the made-files sidecar loaded, the
 * sweeps' timers — would have run *ahead* of these lines, and a throw in any
 * of them would have left no line with a time on it. So this is a module of
 * its own, imported second in `index.ts`, straight after `connectbudget`, and
 * every module that does something at load comes after it.
 */
import { recordCrashes, watchSupervisor } from "./lifecycle";
import { nameProcess } from "./proctitle";

// First, so that anything below which throws leaves a line with a time on it
// rather than only a stack in somebody's scrollback. See `lifecycle.ts`.
recordCrashes();
watchSupervisor();

export const PORT = Number(process.env.KURURU_PORT ?? 7717);

// Named for `ps` and Activity Monitor, where the window, the runner, this and
// the host were otherwise four of the same "Kururu" — and only where naming it
// cannot give it a Dock tile, which `proctitle.ts` explains.
nameProcess(`Kururu server :${PORT}`);

/**
 * The exit code that means "start me again", as opposed to the ones that mean
 * anything else. A restart has to be distinguishable from a crash or a clean
 * stop, or a supervisor either resurrects a server that was asked to go away or
 * declines to bring back one that asked to come back. 75 is sysexits' TEMPFAIL,
 * which is as close as a standard list gets to the sentiment.
 */
export const RESTART_EXIT_CODE = 75;
