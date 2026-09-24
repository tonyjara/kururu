/**
 * Which branch each workspace is on.
 *
 * The sidebar names a workspace after the work, not after the repository, and
 * that is the right way round — but it leaves out the one fact that changes
 * under you without anything on screen moving. An agent that has been running
 * for twenty minutes is on whatever branch you were on when you started it, and
 * the cost of being wrong about that is the whole afternoon's diff landing
 * somewhere you did not mean. So the row says it.
 *
 * Read out of `.git/HEAD` rather than by running `git`. Three reasons and the
 * last is the one that decided it: a subprocess per workspace every few seconds
 * is a lot of forking for one line of text; `git` in a repo it does not like
 * takes an unbounded amount of time to say so; and `HEAD` is the file git itself
 * writes the answer into, so reading it cannot disagree with `git branch
 * --show-current` — it is the same byte.
 *
 * It is a poll for the reason everything else in `devservers.ts` is one: a
 * checkout in a terminal raises no event this process can hear. Cheap enough
 * that it does not matter — one small read per workspace, and the walk that
 * finds the repository is remembered.
 */
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, parse as parsePath } from "node:path";

/** A repository, and what is checked out in it. */
export interface GitHead {
  /** The working tree's root — the directory holding `.git`. */
  root: string;
  /** The branch, or a short sha when `detached`. */
  branch: string;
  /**
   * HEAD names a commit rather than a branch: a checkout of a tag or a sha, or
   * the middle of a rebase. Worth saying rather than hiding, because it is
   * exactly the state in which somebody commits work they then cannot find.
   */
  detached: boolean;
}

/**
 * What `.git/HEAD` says, as a branch or a short sha.
 *
 * Two shapes and nothing else: `ref: refs/heads/<name>` on a branch, and a bare
 * forty-character sha when HEAD is detached. The ref is *not* split on the last
 * slash — a branch called `feature/api/v2` is one name with slashes in it, and
 * taking the last segment is how a branch list ends up full of `v2`.
 */
export function parseHead(text: string): { branch: string; detached: boolean } | null {
  const line = text.trim();
  if (!line) return null;
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(line);
  if (ref) return { branch: ref[1]!.trim(), detached: false };
  if (/^[0-9a-f]{40}$/i.test(line)) return { branch: line.slice(0, 7), detached: true };
  // Anything else is a HEAD this does not understand — a ref outside
  // `refs/heads` or a file mid-write. Null rather than a guess, so the row says
  // nothing instead of saying something wrong.
  return null;
}

/**
 * Where `.git` actually points.
 *
 * It is usually a directory. It is a *file* in a linked worktree and in a
 * submodule, holding `gitdir: <path>` — and that path may be relative to the
 * directory the file is in, which is the part that is easy to get wrong and
 * silently returns nothing. A linked worktree is not a rare shape here either:
 * it is what `git worktree add` makes, and running an agent in one is a normal
 * way to work on two branches at once.
 */
async function gitDir(at: string): Promise<string | null> {
  const dot = join(at, ".git");
  let info;
  try {
    info = await stat(dot);
  } catch {
    return null;
  }
  if (info.isDirectory()) return dot;
  if (!info.isFile()) return null;
  try {
    const said = /^gitdir:\s*(.+)$/m.exec(await readFile(dot, "utf8"));
    if (!said) return null;
    const where = said[1]!.trim();
    return isAbsolute(where) ? where : join(at, where);
  } catch {
    return null;
  }
}

/**
 * The nearest repository at or above `dir`, and what it has checked out.
 *
 * Upwards, and stopping at the home directory: a dotfiles repo in `$HOME` would
 * put a branch on every workspace on the machine, which is not a fact about any
 * of them.
 */
export async function headAt(dir: string): Promise<GitHead | null> {
  const found = await repoAt(dir);
  if (!found) return null;
  return readHead(found);
}

/** Just the walk, so a caller that polls can remember it. */
export async function repoAt(dir: string): Promise<{ root: string; git: string } | null> {
  const home = process.env.HOME ?? "";
  const stop = parsePath(dir).root;
  let at = dir;
  for (;;) {
    if (!at || at === home) return null;
    const git = await gitDir(at);
    if (git) return { root: at, git };
    if (at === stop) return null;
    const up = dirname(at);
    if (up === at) return null;
    at = up;
  }
}

/** And just the read, which is the half that has to happen every time. */
export async function readHead(found: { root: string; git: string }): Promise<GitHead | null> {
  try {
    const parsed = parseHead(await readFile(join(found.git, "HEAD"), "utf8"));
    return parsed ? { root: found.root, ...parsed } : null;
  } catch {
    // A `.git` that has gone, or a HEAD being rewritten by a checkout in
    // progress. The next poll is four seconds away and will say.
    return null;
  }
}
