/**
 * Reading the project a surface is sitting in, for the sidebar and the code
 * view.
 *
 * Kururu is reachable from the tailnet, so "read a file" is the one request
 * here that could hand over something it should not. Every path is resolved
 * and then checked to be inside a root the server chose — the cwd of a dev
 * server or of a ghosttown surface — and a path that escapes is refused rather
 * than clamped, because a clamped traversal is a bug that looks like it worked.
 *
 * The walk is deliberately shallow and bounded, like ghosttown's markdown
 * finder: this answers a tap on a phone, not an index.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

/** Directories never worth showing: build output, dependencies, caches. */
const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "out", "target", "vendor", "coverage",
  "venv", "__pycache__", "Pods", "DerivedData", ".git", ".next", ".turbo",
]);

/** Past this a "file" is not something to read on a phone. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Entries per directory. A generated folder with 50k files is not a listing. */
const MAX_ENTRIES = 500;

export interface DirEntry {
  name: string;
  /** Path relative to the root, with forward slashes. */
  path: string;
  dir: boolean;
  size?: number;
}

/**
 * Roots the server is willing to read under. Populated from the places it
 * already knows about — dev server cwds, surface cwds — never from the client,
 * which is what stops a crafted root from turning this into a file server for
 * the whole disk.
 */
const roots = new Set<string>();

/**
 * Roots are stored as realpaths, and every incoming root is realpath'd before
 * it is checked against them. On macOS `/tmp` is a symlink to `/private/tmp`,
 * so a root learned from lsof and the same root typed by a client are two
 * different strings for one directory — comparing them literally rejects the
 * legitimate request and teaches nothing about the illegitimate one.
 */
export function allowRoot(dir: string | undefined): void {
  if (!dir) return;
  try {
    const real = realpathSync(dir);
    if (statSync(real).isDirectory()) roots.add(real);
  } catch {
    // gone since we were told about it
  }
}

export function allowedRoots(): string[] {
  return [...roots].sort();
}

/** Is `full` at or below `base`? The `sep` matters: without it "/a/bc" passes as inside "/a/b". */
function inside(base: string, full: string): boolean {
  return full === base || full.startsWith(base + sep);
}

/**
 * Resolve `rel` under `root`, or null if it lands outside.
 *
 * Checked twice, and the second check is the one that matters: `resolve`
 * flattens `..` lexically, which catches the obvious traversal, but a symlink
 * inside the project pointing at ~/.ssh is a path that looks local and is not.
 * So the resolved path is realpath'd and tested again — what the filesystem
 * says it is, not what the string says.
 */
export function resolveInRoot(root: string, rel: string): string | null {
  let base: string;
  try {
    base = realpathSync(resolve(root));
  } catch {
    return null;
  }
  if (!roots.has(base)) return null;

  const full = resolve(base, rel);
  if (!inside(base, full)) return null;

  try {
    if (!inside(base, realpathSync(full))) return null;
  } catch {
    return null; // does not exist, or we may not look
  }
  return full;
}

export function listDir(root: string, rel: string): DirEntry[] {
  const full = resolveInRoot(root, rel);
  if (!full) throw new Error("path is outside the project");
  const entries: DirEntry[] = [];
  for (const dirent of readdirSync(full, { withFileTypes: true })) {
    if (entries.length >= MAX_ENTRIES) break;
    const name = dirent.name;
    const dir = dirent.isDirectory();
    if (dir && SKIP_DIRS.has(name)) continue;
    if (name.startsWith(".") && name !== ".claude" && name !== ".github") continue;
    const path = rel ? `${rel}/${name}` : name;
    let size: number | undefined;
    if (!dir) {
      try {
        size = statSync(resolve(full, name)).size;
      } catch {
        continue; // a broken symlink is not a file
      }
    }
    entries.push({ name, path, dir, size });
  }
  // Directories first, then alphabetical — the order a file tree is read in.
  return entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
}

export interface FileContent {
  path: string;
  text: string;
  truncated: boolean;
}

export function readFile(root: string, rel: string): FileContent {
  const full = resolveInRoot(root, rel);
  if (!full) throw new Error("path is outside the project");
  const size = statSync(full).size;
  if (size > MAX_FILE_BYTES) {
    return { path: rel, text: `(${(size / 1024 / 1024).toFixed(1)} MB — too large to show)`, truncated: true };
  }
  return { path: rel, text: readFileSync(full, "utf8"), truncated: false };
}
