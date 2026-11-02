/**
 * The file-system helpers the server had written a dozen times over: the
 * atomic write, where kururu's state lives, and whether a path is inside
 * another.
 *
 * Each copy was nearly the same and the differences were the bugs — a temp
 * named `.tmp` here and `.kururu-tmp` there, a mode passed as `writeFile`'s
 * option where it does not apply to a leftover temp, a prefix check without
 * its `/`. One of each, so a rule is decided once. `hostsock.ts` keeps its
 * own state directory, being part of the pty host.
 */
import { chmodSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

/**
 * Written beside itself and renamed in, so that a reader never sees half a
 * file and a crash mid-save leaves the old one whole.
 *
 * `mode`, for a file that holds a secret, is set on the temporary file before
 * the rename, so there is no moment at which the real path exists with the
 * umask's permissions — and by `chmod` rather than `writeFileSync`'s own
 * option, which only applies when the file is created, and so would not apply
 * to a temp a crash left behind. `suffix` is the temp's: `.kururu-tmp` in a
 * directory that is somebody else's (`~/.codex`, `~/.ssh`), so a leftover
 * says whose it is.
 *
 * Throws. Each caller decides what a failed save means, and they differ: a
 * setting is logged and kept for now, a voice clip must not be answered as
 * kept.
 */
export function writeAtomic(path: string, data: string | Uint8Array, options: { mode?: number; suffix?: string } = {}): void {
  const temp = `${path}${options.suffix ?? ".tmp"}`;
  if (options.mode === undefined) writeFileSync(temp, data);
  else {
    writeFileSync(temp, data, { mode: options.mode });
    chmodSync(temp, options.mode);
  }
  renameSync(temp, path);
}

/**
 * Where kururu keeps its state — the host's socket and log, the lifecycle
 * log, caches a restart may lose: `KURURU_STATE_DIR` when set, which is what
 * an isolated instance moves, else under `XDG_STATE_HOME`.
 */
export function stateDir(): string {
  return process.env.KURURU_STATE_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "kururu");
}

/** Whether `full` is `base` or under it: a prefix check with its separator, so `/a/bc` is not inside `/a/b`. */
export function inside(base: string, full: string): boolean {
  return full === base || full.startsWith(base + sep);
}
