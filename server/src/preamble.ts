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
 *
 * The facts about the process that the rest read are here for the same
 * reason: its port, the exit code that asks for a restart, where its web app
 * is, and the extra roots it was started with.
 */
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { allowRoot } from "./files";
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

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * Where the built web app is. The Electron app passes this explicitly, because
 * once this file is bundled it no longer sits where the source did; running it
 * straight from the repo falls back to the source layout.
 */
export const WEB_DIST = process.env.KURURU_WEB_DIST || join(HERE, "../../web/dist");
/**
 * Where the web app is built *from*, which is where the window's vite runs —
 * the one listener on the machine besides this process that is kururu, and so
 * never a dev server (see `Self` in `devservers.ts`). From the source layout
 * and not from `WEB_DIST`, because a packaged app's built copy has no source
 * beside it and no vite either, and there this is null. Real, because the
 * kernel's answer for a cwd always is.
 */
export const WEB_SOURCE = (() => {
  try {
    return realpathSync(join(HERE, "../../web"));
  } catch {
    return null;
  }
})();

/**
 * Extra directories the file browser may read, colon-separated. Agent cwds and
 * dev server cwds are added automatically; this is for a project with nothing
 * running in it yet. Set at launch by the person running the server, never by a
 * client.
 */
for (const dir of (process.env.KURURU_ROOTS ?? "").split(":")) allowRoot(dir.trim() || undefined);
