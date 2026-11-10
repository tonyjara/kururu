/**
 * Writing one variable of an env file the owner named, from the vault's
 * dialog, without the edit going anywhere it should not.
 *
 * The path is the caller's — Kuru's or an agent's — and the caller is a
 * model, so it is held to the `files.ts` rule: resolve, check, realpath,
 * check again, and refuse rather than clamp. Under the home folder only, and
 * never in the places where one line more is a different machine: `~/.ssh`,
 * `~/.gnupg`, `~/Library`, and kururu's own config and state. Not through a
 * symlink, since a link is a path that says one place and writes another.
 *
 * The file as it was is copied first, to kururu's state folder rather than
 * beside it, where a project's `.gitignore` may not cover a new name; the
 * newest five copies of each file are kept. Then the one variable is
 * replaced (`shared/envfile.ts`) and the file written `0600` beside itself
 * and renamed in, whatever its mode was, because it now holds a key.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setVariable } from "../../shared/envfile";
import { configDir } from "./config";
import { inside, stateDir, writeAtomic } from "./fsutil";

/** An env file is small; anything this size is not one. */
const ENV_MAX = 256 * 1024;
/** Copies kept per file. */
const BACKUPS_KEPT = 5;

export interface EnvWriteOptions {
  home?: string;
  /** Where the copies go. Default `<state>/vault/env-backups`. */
  backups?: string;
  now?: () => number;
}

/** `~/…` for a path under home, for a sentence the owner reads. */
export function tildePath(path: string, home: string = homedir()): string {
  return inside(home, path) ? `~${path.slice(home.length)}` : path;
}

/** The nearest folder that exists, at or above `dir`. */
function existingAncestor(dir: string): string {
  let at = dir;
  for (;;) {
    try {
      if (statSync(at).isDirectory()) return at;
    } catch {
      // Not there: up one.
    }
    const up = dirname(at);
    if (up === at) return at;
    at = up;
  }
}

/**
 * Where `file` (`~/…` or absolute) is, checked to be a place the dialog may
 * write. Throws a sentence for the owner.
 */
export function envPath(file: string, options: EnvWriteOptions = {}): string {
  const home = options.home ?? homedir();
  const realHome = realpathSync(home);
  const raw = file.startsWith("~/") ? join(home, file.slice(2)) : file;
  const full = resolve(raw);
  const forbidden = [join(home, ".ssh"), join(home, ".gnupg"), join(home, "Library"), configDir(), stateDir()];
  const realForbidden = forbidden.map((p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  });
  const refuse = (where: string) => forbidden.some((p) => inside(p, where)) || realForbidden.some((p) => inside(p, where));
  if (!inside(home, full) || full === home) throw new Error(`${file} is not a file under the home folder`);
  if (refuse(full)) throw new Error(`${tildePath(full, home)} is in a folder the vault never writes to (~/.ssh, ~/.gnupg, ~/Library, kururu's own)`);
  const ancestor = realpathSync(existingAncestor(dirname(full)));
  if (!inside(realHome, ancestor) || refuse(ancestor)) throw new Error(`${tildePath(full, home)} is not under the home folder once its links are followed`);
  let link = false;
  try {
    const info = lstatSync(full);
    link = info.isSymbolicLink();
    if (!link && !info.isFile()) throw new Error(`${tildePath(full, home)} is not a file`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (link) throw new Error(`${tildePath(full, home)} is a symlink; name the file it points to`);
  return full;
}

function keepBackup(path: string, text: string, dir: string, now: number): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tag = createHash("sha256").update(path).digest("hex").slice(0, 12);
  const name = `${tag}-${basename(path).replace(/[^A-Za-z0-9._-]/g, "_")}-${new Date(now).toISOString().replace(/[:.]/g, "-")}`;
  // Two fields of one dialog writing one file can land in the same
  // millisecond, and the second copy must not take the first's name: the
  // first is the file as it was before the dialog.
  let copy = join(dir, name);
  for (let n = 2; existsSync(copy); n += 1) copy = join(dir, `${name}-${n}`);
  writeAtomic(copy, text, { mode: 0o600 });
  const mine = readdirSync(dir)
    .filter((n) => n.startsWith(`${tag}-`) && !n.endsWith(".tmp"))
    .sort();
  for (const old of mine.slice(0, Math.max(0, mine.length - BACKUPS_KEPT))) rmSync(join(dir, old), { force: true });
  return copy;
}

/**
 * Set `variable` in `file` to `value`. Returns the file and the copy made of
 * it as it was, if it was there. Throws a sentence with no value in it.
 */
export function writeEnvVariable(file: string, variable: string, value: string, options: EnvWriteOptions = {}): { path: string; backup: string | null } {
  const path = envPath(file, options);
  let before = "";
  let existed = false;
  try {
    const info = statSync(path);
    if (info.size > ENV_MAX) throw new Error(`${tildePath(path, options.home)} is too big to be an env file`);
    before = readFileSync(path, "utf8");
    existed = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  // The edit first, so a file that is not an env file is refused before
  // anything is copied or made.
  const after = setVariable(before, variable, value);
  const backup = existed ? keepBackup(path, before, options.backups ?? join(stateDir(), "vault", "env-backups"), (options.now ?? Date.now)()) : null;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeAtomic(path, after, { mode: 0o600, suffix: ".kururu-tmp" });
  return { path, backup };
}
