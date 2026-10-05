/**
 * Changing the project's shape from the file tree: new, rename, move, copy,
 * and into the Trash.
 *
 * `files.ts` never writes, and still does not — this module is the one place
 * that does, for the same reason `worktree.ts` is the one place that runs git:
 * a surface that alters the user's disk from a tailnet-reachable socket should
 * be one file you can read in a sitting. It changes where files *are*, never
 * what is in them. Code is still written by an agent or in nvim; this is the
 * tidying you would otherwise leave a terminal to do by hand.
 *
 * Three rules, all of them refusals rather than repairs:
 *
 * - **Every path goes through `resolveInRoot`**, and a destination — which does
 *   not exist yet, so cannot be realpath'd — is a directory that does, plus a
 *   name that is one path component. A name with a slash in it is refused
 *   rather than split, because "rename to ../../x" is a move out of the project
 *   wearing a rename's clothes.
 * - **Nothing is overwritten.** A name that is taken is an error the tree shows,
 *   not a file that silently stops existing. Node's `rename` will clobber, so
 *   the check comes first; the window between check and rename is a race with
 *   something else creating that exact name in that exact instant, and losing it
 *   costs one file an agent wrote in the same millisecond — accepted, and said
 *   here rather than hidden.
 * - **Delete is the Trash, never `rm`.** The tree is one mis-tap from a phone
 *   away, and the only delete worth offering there is one Finder can put back.
 *   Where there is no trash to hand to, the answer is no.
 *
 * `.git` is off limits in both directions. The tree never shows it, so a
 * request naming it did not come from a click, and a trashed `.git` is the one
 * mistake in here the Trash does not fully undo — the worktrees pointing at it
 * would be left dangling while it sat there.
 */
import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { resolveInRoot } from "./files";

export type FileOp =
  | { op: "mkdir"; root: string; dir: string; name: string }
  | { op: "touch"; root: string; dir: string; name: string }
  | { op: "rename"; root: string; path: string; name: string }
  | { op: "move"; root: string; path: string; dir: string }
  | { op: "copy"; root: string; path: string; dir: string }
  | { op: "trash"; root: string; path: string }
  | { op: "reveal"; root: string; path: string };

/** What happened, as a path relative to the root — the row the tree should land on. */
export type FileOpResult = { ok: true; path?: string } | { ok: false; error: string };

/** A trash takes a moment on a slow disk; a copy of a large tree takes longer. */
const TRASH_TIMEOUT_MS = 30_000;

/**
 * Parse an op off the wire. Everything is a string or the request is refused:
 * the shapes are few enough to check by hand, and a check that is written out is
 * one a reader can see is complete.
 */
export function parseFileOp(body: unknown): FileOp | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const str = (key: string) => (typeof b[key] === "string" ? (b[key] as string) : null);
  const root = str("root");
  if (root === null) return null;
  switch (b.op) {
    case "mkdir":
    case "touch": {
      const dir = str("dir");
      const name = str("name");
      return dir === null || name === null ? null : { op: b.op, root, dir, name };
    }
    case "rename": {
      const path = str("path");
      const name = str("name");
      return path === null || name === null ? null : { op: "rename", root, path, name };
    }
    case "move":
    case "copy": {
      const path = str("path");
      const dir = str("dir");
      return path === null || dir === null ? null : { op: b.op, root, path, dir };
    }
    case "trash":
    case "reveal": {
      const path = str("path");
      return path === null ? null : { op: b.op, root, path };
    }
    default:
      return null;
  }
}

/**
 * One path component, or the reason it is not. Trimmed, because a trailing
 * space typed on a phone keyboard is never a name anybody meant.
 */
export function checkName(raw: string): { name: string } | { error: string } {
  const name = raw.trim();
  if (!name) return { error: "a name cannot be empty" };
  if (name === "." || name === "..") return { error: `"${name}" is not a name` };
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return { error: "a name cannot contain a slash" };
  if (Buffer.byteLength(name) > 255) return { error: "that name is too long" };
  if (name === ".git") return { error: ".git is left alone" };
  return { name };
}

/** Does any component of this relative path name `.git`? */
function touchesGit(rel: string): boolean {
  return rel.split(/[\\/]/).includes(".git");
}

/**
 * The name a copy takes when the obvious one is taken: `app copy.ts`, then
 * `app copy 2.ts` — Finder's convention, because it is the one the person
 * using this already reads without thinking. The extension stays at the end so
 * the copy still opens in whatever the original did.
 */
export function copyName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name;
  // A dotfile's leading dot is its name, not an extension: `.env` → `.env copy`.
  const ext = name.startsWith(".") && name.indexOf(".", 1) < 0 ? "" : extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let n = 1; ; n++) {
    const candidate = `${stem} copy${n === 1 ? "" : ` ${n}`}${ext}`;
    if (!taken(candidate)) return candidate;
  }
}

/** Is `full` at or below `base`? */
function inside(base: string, full: string): boolean {
  return full === base || full.startsWith(base + sep);
}

/** Does anything — file, directory, dangling symlink — already sit at this path? */
function occupied(full: string): boolean {
  try {
    lstatSync(full);
    return true;
  } catch {
    return false;
  }
}

/** The project's own realpath, for turning an absolute path back into a relative one. */
function baseOf(root: string): string | null {
  return resolveInRoot(root, "");
}

/** An existing entry that is not the root itself — the thing an op acts on. */
function source(root: string, rel: string): string | { error: string } {
  if (!rel || touchesGit(rel)) return { error: "that cannot be changed from here" };
  const full = resolveInRoot(root, rel);
  if (!full) return { error: "path is outside the project" };
  return full;
}

/** An existing directory inside the project — where something is about to go. */
function destination(root: string, rel: string): string | { error: string } {
  if (touchesGit(rel)) return { error: "that cannot be changed from here" };
  const full = resolveInRoot(root, rel);
  if (!full) return { error: "path is outside the project" };
  try {
    if (!statSync(full).isDirectory()) return { error: "that is not a folder" };
  } catch {
    return { error: "that folder is gone" };
  }
  return full;
}

function rel(base: string, full: string): string {
  return relative(base, full).split(sep).join("/");
}

export async function runFileOp(op: FileOp): Promise<FileOpResult> {
  const base = baseOf(op.root);
  if (!base) return { ok: false, error: "path is outside the project" };
  try {
    switch (op.op) {
      case "mkdir":
      case "touch": {
        const dir = destination(op.root, op.dir);
        if (typeof dir !== "string") return { ok: false, ...dir };
        const checked = checkName(op.name);
        if ("error" in checked) return { ok: false, ...checked };
        const target = join(dir, checked.name);
        if (occupied(target)) return { ok: false, error: `${checked.name} already exists` };
        // `wx` is the no-clobber the rename path cannot have: the create itself
        // fails if the name appeared since the check above.
        if (op.op === "mkdir") mkdirSync(target);
        else writeFileSync(target, "", { flag: "wx" });
        return { ok: true, path: rel(base, target) };
      }
      case "rename": {
        const from = source(op.root, op.path);
        if (typeof from !== "string") return { ok: false, ...from };
        const checked = checkName(op.name);
        if ("error" in checked) return { ok: false, ...checked };
        const target = join(dirname(from), checked.name);
        if (target === from) return { ok: true, path: op.path };
        // A case-only rename on a case-insensitive disk finds its own source at
        // the "taken" name, and is exactly the rename somebody fixing
        // `readme.md` wants — so the same inode is not a collision.
        if (occupied(target) && !sameEntry(from, target)) return { ok: false, error: `${checked.name} already exists` };
        renameSync(from, target);
        return { ok: true, path: rel(base, target) };
      }
      case "move":
      case "copy": {
        const from = source(op.root, op.path);
        if (typeof from !== "string") return { ok: false, ...from };
        const dir = destination(op.root, op.dir);
        if (typeof dir !== "string") return { ok: false, ...dir };
        // Into itself is the one move that would lose the thing being moved, and
        // a copy into itself never finishes. Compared as realpaths so a symlinked
        // folder cannot smuggle the loop past a string check.
        if (lstatSync(from).isDirectory() && inside(realpathSync(from), realpathSync(dir))) {
          return { ok: false, error: "a folder cannot go inside itself" };
        }
        const name = basename(from);
        if (op.op === "move") {
          if (dirname(from) === dir) return { ok: true, path: op.path };
          const target = join(dir, name);
          if (occupied(target)) return { ok: false, error: `${name} already exists there` };
          renameSync(from, target);
          return { ok: true, path: rel(base, target) };
        }
        // A copy never fails on a taken name — pasting into the folder you
        // copied from is what "duplicate" is, and it should just work.
        const target = join(dir, copyName(name, (candidate) => occupied(join(dir, candidate))));
        // Async, because this is the one op whose size the person did not choose
        // by typing: a folder with a build in it is many thousands of files, and
        // the server relaying every terminal should not stop while it copies.
        // Symlinks are copied as links rather than followed, so a link inside the
        // project to somewhere outside it does not become a copy of somewhere
        // outside it.
        await cp(from, target, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
        return { ok: true, path: rel(base, target) };
      }
      case "trash": {
        const from = source(op.root, op.path);
        if (typeof from !== "string") return { ok: false, ...from };
        await moveToTrash(from);
        return { ok: true };
      }
      case "reveal": {
        // The one op that changes nothing, so the root itself is allowed and
        // `.git` is not refused — only "inside the project" still holds.
        const full = resolveInRoot(op.root, op.path);
        if (!full) return { ok: false, error: "path is outside the project" };
        await reveal(full);
        return { ok: true, path: op.path };
      }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function sameEntry(a: string, b: string): boolean {
  try {
    const x = lstatSync(a);
    const y = lstatSync(b);
    return x.ino === y.ino && x.dev === y.dev;
  } catch {
    return false;
  }
}

/**
 * Show a path in the machine's file manager: Finder with the row selected on
 * macOS, and elsewhere the folder it sits in, since `xdg-open` has no notion of
 * selecting anything. It opens on the machine the server runs on, which is why
 * the tree offers it only in the desktop window — from a phone it would be a
 * Finder window appearing on a desk nobody is sitting at.
 */
function reveal(full: string): Promise<void> {
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin" ? ["/usr/bin/open", ["-R", full]] : ["xdg-open", [dirname(full)]];
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: TRASH_TIMEOUT_MS }, (err, _stdout, stderr) => {
      if (!err) return resolve();
      reject(new Error(String(stderr).trim() || err.message));
    });
  });
}

/**
 * Hand a path to the platform's Trash, or refuse.
 *
 * macOS 15 ships `/usr/bin/trash`, which is Finder's own move — Put Back works
 * and nothing asks for a permission. Before that there is Finder over Apple
 * Events, which asks once for leave to automate Finder and is otherwise the
 * same move. The path goes in as an argument to the script rather than into its
 * text, so a file named with a quote in it is a file and not a program. Elsewhere,
 * `gio trash` is the freedesktop trash GNOME and most file managers read.
 *
 * Moving into `~/.Trash` by hand was the obvious alternative and is the wrong
 * one: it is a protected folder a process without Full Disk Access cannot
 * write, and a file put there that way has no way back to where it came from.
 */
function moveToTrash(full: string): Promise<void> {
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin"
      ? existsSync("/usr/bin/trash")
        ? ["/usr/bin/trash", [full]]
        : [
            "/usr/bin/osascript",
            ["-e", 'on run argv\ntell application "Finder" to delete (POSIX file (item 1 of argv) as alias)\nend run', full],
          ]
      : ["gio", ["trash", "--", full]];
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: TRASH_TIMEOUT_MS }, (err, _stdout, stderr) => {
      if (!err) return resolve();
      const said = String(stderr).trim();
      const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
      reject(new Error(said || (missing ? "there is no Trash to move this to" : err.message)));
    });
  });
}
