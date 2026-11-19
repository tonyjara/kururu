/**
 * The symbolic link a folder kururu was told about goes through, asked of the
 * disk — the server's half of `shared/pathlinks.ts`, which says why a root's
 * spelling and the kernel's can differ and why the comparison, not the
 * spelling, is what changes.
 *
 * Kept per folder for a while, because the branch walk asks about every root
 * of every workspace every few seconds and the answer changes only when
 * somebody moves a link. A folder that cannot be read is no link: a root that
 * has gone has nothing to compare against.
 */
import { lstat, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { type PathLink, uniqueLinks } from "../../shared/pathlinks";

const seen = new Map<string, { at: number; link: Promise<PathLink | null> }>();
const SEEN_MS = 60_000;
const SEEN_MAX = 512;

/**
 * The deepest folder at or above `path` that is a symbolic link, with where it
 * leads — so that what is under the link is followed the way the disk would,
 * and nothing beside the link is. Null when nothing on the way is a link.
 *
 * The deepest because anything above it is already resolved in its target:
 * `realpath` of the link answers for every link on the way, and below it
 * nothing is a link, so following it once gives the path the kernel reports.
 */
export function linkOf(path: string): Promise<PathLink | null> {
  const had = seen.get(path);
  if (had && Date.now() - had.at < SEEN_MS) return had.link;
  if (seen.size >= SEEN_MAX) seen.clear();
  const link = find(path);
  seen.set(path, { at: Date.now(), link });
  return link;
}

async function find(path: string): Promise<PathLink | null> {
  if (!path.startsWith("/")) return null;
  for (let at = path.replace(/\/+$/, "") || "/"; ; at = dirname(at)) {
    if (at === "/") return null;
    try {
      if ((await lstat(at)).isSymbolicLink()) return { from: at, to: await realpath(at) };
    } catch {
      return null;
    }
  }
}

/** The links a handful of folders go through, each once. */
export async function linksOf(paths: readonly string[]): Promise<PathLink[]> {
  const found = await Promise.all([...new Set(paths)].map(linkOf));
  return uniqueLinks(found.filter((link): link is PathLink => link !== null));
}
