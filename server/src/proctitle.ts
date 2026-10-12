/**
 * Naming a process without putting it in the Dock.
 *
 * On macOS `process.title` is more than the name `ps` prints. libuv also checks
 * the process in with LaunchServices, as an application, under the bundle its
 * binary belongs to and with the title as its display name. That bundle's
 * Info.plist then decides what kind of application it is. For plain node there
 * is no bundle and the entry is `BackgroundOnly`, which nobody sees. For
 * Kururu.app's own binary, run as node, the plist is a GUI app's, and the
 * process becomes a `Foreground` one: a Dock tile with the blank executable
 * icon, a place in ⌘-Tab and in Force Quit, for a process with no window to
 * show. The runner and the server had a tile each on 2026-10-12, and clicking
 * one only brought the window forward. The next pty host would have had one
 * too, and a Dock tile on the host is the thing `hostlaunch.ts` exists to
 * prevent, because quitting that tile is a force quit of every agent.
 *
 * Electron's helper is the way out. `Contents/Frameworks/Kururu Helper.app` is
 * an `LSUIElement` bundle, and a titled process on it checks in as a UI element:
 * named in Activity Monitor and absent from the Dock, ⌘-Tab and Force Quit. It
 * is the same Electron, so `ELECTRON_RUN_AS_NODE` works on it as it does on the
 * main binary, and it is signed with the same entitlements. A child of the
 * window is still the window's responsibility as far as macOS's privacy
 * settings go, so a helper the window starts reads `~/Desktop` under the grant
 * the window already has. So everything the app runs as node runs on the
 * helper (`desktop/runner.js`, and `run.mjs` for a runner an older app
 * started), and everything those start inherits it through `process.execPath`.
 *
 * A process that finds itself on a main binary anyway stays unnamed, because
 * no name is worth a tile. That is the host's case, and it is on purpose: the
 * host is a launchd job, so it is its *own* responsible process, and it runs on
 * the clone's main binary because that is the identity whose privacy grants
 * every agent has. The helper is a different binary that macOS has never been
 * asked about, and a host on it would block in `open()` under `~/Desktop`
 * until somebody answered a prompt. `ps` still shows it by its command line,
 * which has `ptyhostd.mjs` in it, and that is all `kill-ptyhosts`, the runner
 * and `lifecycle.ts` look for.
 *
 * `server/run.mjs` and `desktop/runner.js` are plain JavaScript and keep their
 * copies of `helperOf` in step by hand.
 */
import { basename, join } from "node:path";

/**
 * The outermost `.app` an executable belongs to, as its main binary or as a
 * helper's, or null. Outermost, so that the server running on
 * `Kururu.app/Contents/Frameworks/Kururu Helper.app` still names Kururu.app,
 * which is the bundle `hostlaunch.ts` clones for the host.
 */
export function bundleOf(exe: string): string | null {
  const found = /^(.+?\.app)\/Contents\/(?:MacOS\/[^/]+|Frameworks\/[^/]+\.app\/Contents\/MacOS\/[^/]+)$/.exec(exe);
  return found ? found[1]! : null;
}

/** Whether `exe` is the main binary of a top-level `.app`: the case where a title is a Dock tile. */
export function isAppBinary(exe: string): boolean {
  const bundle = bundleOf(exe);
  return bundle !== null && exe === join(bundle, "Contents", "MacOS", basename(exe));
}

/**
 * The helper beside an app's main binary, where Electron puts it and by the
 * name Electron gives it — `Kururu` has `Kururu Helper`, the dev shell's
 * `Electron` has `Electron Helper` — or null when `exe` is not a main binary.
 * Whether it exists is the caller's to check.
 */
export function helperOf(exe: string): string | null {
  if (!isAppBinary(exe)) return null;
  const name = `${basename(exe)} Helper`;
  return join(bundleOf(exe)!, "Contents", "Frameworks", `${name}.app`, "Contents", "MacOS", name);
}

/** `process.title = title`, unless on macOS that would give this process a Dock tile. */
export function nameProcess(title: string): void {
  if (process.platform === "darwin" && isAppBinary(process.execPath)) return;
  process.title = title;
}
