/**
 * The checkout a card gets to itself, and the one place kururu runs `git`.
 *
 * `git.ts` reads `HEAD` off the disk on purpose and says why: a poll every four
 * seconds is no place for a subprocess that can take an unbounded time to say
 * no. This is the other case. A worktree is made once, on a click, and there is
 * no file to write that makes one — `git worktree add` is the operation, it
 * touches `.git/worktrees/`, the index and the disk, and reimplementing it
 * would be a second git that disagrees with the first. So it is a subprocess,
 * with a timeout, and its stderr is the error the card shows.
 *
 * What it never does is force anything. `add` refuses a branch that is checked
 * out elsewhere and a directory that is not empty; those refusals are the
 * point, and they are handed back rather than argued with. Taking one down is
 * the same rule read backwards: `git worktree remove` without `--force` and
 * `git branch -d` without the capital, because git already knows when there is
 * work in there that has not gone anywhere, and kururu's job is to say so, not
 * to overrule it.
 *
 * Why a worktree and not a clone: the branch has to end up in *this*
 * repository, where the person is going to merge it, and a clone puts it in
 * another one with a remote in between. A worktree shares the object store, so
 * making one costs a checkout and nothing else, and the branch it makes is
 * already where `git merge` will look for it.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CardWorktree } from "../../shared/board";
import { worktreeBranch, worktreeDir, worktreeName, type WorktreeStatus } from "../../shared/projects";
import { readHead, repoAt } from "./git";

/**
 * A checkout of a large repository is seconds; thirty is a git that is hanging
 * on a prompt or a lock, and the card should say so rather than spin.
 */
const GIT_TIMEOUT_MS = 30_000;

/**
 * Run git and get stdout, or the first line of what it said on stderr as the
 * error. `GIT_TERMINAL_PROMPT=0` because there is no terminal: a git that wants
 * a credential would otherwise sit there until the timeout and then report the
 * timeout, which is the wrong thing to show.
 */
export function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const said = String(stderr).split("\n").find((line) => line.trim()) ?? err.message;
        reject(new Error(`git: ${said.replace(/^fatal:\s*/, "")}`));
      },
    );
  });
}

/**
 * Whether a recorded worktree is still one: its directory holds the `.git`
 * file `worktree add` writes. A directory somebody emptied by hand, or a
 * repository that was moved, reads as gone, and the card makes a new one.
 */
export function worktreePresent(path: string): boolean {
  return existsSync(join(path, ".git"));
}

/**
 * The main working tree of the repository `root` is in — `root` itself for an
 * ordinary checkout, and the checkout it was linked from when `root` is a
 * worktree. Asked of git rather than read off the `gitdir:` file, because the
 * common dir is exactly the question and git answers it in one line; `repoAt`
 * stays the cheap read it is for the poll. A `.git` at the top level of what
 * git names is the ordinary shape; anything else is left as it was found.
 */
export async function mainRoot(root: string): Promise<string> {
  try {
    const common = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], root)).trim();
    if (!common.endsWith("/.git")) return root;
    const main = dirname(common);
    // Git answers with the real path; `root` is spelt however the terminal's
    // cwd was. When they are one directory, keep the spelling the settings
    // are keyed under rather than a second one for the same place.
    return realpathSync(main) === realpathSync(root) ? root : main;
  } catch {
    return root;
  }
}

/**
 * A worktree for this card, made if it is not there.
 *
 * `fresh` is whether it was made just now, which is what decides whether the
 * project's setup line runs: a second agent on a card whose checkout is still
 * standing should not sit through `bun install` again.
 *
 * The branch is cut from whatever the main tree has checked out at the moment
 * the robot is pressed — the thing the sidebar's branch line was showing — and
 * that is recorded as `base`, because it is where the work goes back to. A
 * branch by this name that already exists is checked out rather than made
 * again: that is a card whose worktree directory went but whose branch did
 * not, and its commits are on that branch.
 */
export async function ensureWorktree(root: string, card: { id: string; title: string }): Promise<{ worktree: CardWorktree; fresh: boolean }> {
  const name = worktreeName(card);
  const branch = worktreeBranch(name);
  const path = worktreeDir(root, name);
  const repo = await repoAt(root);
  if (!repo) throw new Error(`${root} is not in a git repository`);
  const head = await readHead(repo);
  const base = head?.branch ?? "HEAD";

  if (worktreePresent(path)) return { worktree: { root, path, branch, base }, fresh: false };

  /*
   * A worktree whose directory was deleted by hand is still registered, and
   * `add` at the same path says so and stops. Pruning first is what git itself
   * suggests in that message, and it removes nothing that has a directory.
   */
  await git(["worktree", "prune"], root).catch(() => undefined);
  mkdirSync(dirname(path), { recursive: true });

  const exists = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], root).then(
    () => true,
    () => false,
  );
  if (exists) await git(["worktree", "add", path, branch], root);
  else await git(["worktree", "add", "-b", branch, path, base], root);
  return { worktree: { root, path, branch, base }, fresh: true };
}

/**
 * What a worktree holds that git would refuse to throw away — modified
 * tracked files, or untracked ones — by path. It is the question `worktree
 * remove` asks before it says no, asked ahead of it so that nothing is ended
 * on account of a removal that was never going to happen. Ignored files are
 * not in the answer, which is what lets a worktree with a `node_modules` in it
 * go. The paths and not a boolean, because "has uncommitted changes" was the
 * whole message once, and a person reading it could not tell an agent that
 * did the work and forgot to commit from one that touched nothing but a lock
 * file.
 */
export async function worktreeChanges(path: string): Promise<string[]> {
  return (await git(["status", "--porcelain"], path))
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => line.slice(3).trim());
}

/**
 * The refusal for a worktree with work in it: which files, and what to do
 * about it, because the person seeing this has just been told nothing was
 * merged and the next question is always "what is in there".
 */
export function uncommittedError(files: string[]): Error {
  const shown = files.slice(0, 4).join(", ");
  const more = files.length > 4 ? ` and ${files.length - 4} more` : "";
  return new Error(
    `has uncommitted changes in ${shown}${more} — commit them in the worktree, or ask its agent to, and merge again`,
  );
}

/**
 * Take a card's worktree down, with its work merged back first.
 *
 * Four steps, and the order is the argument. Rebase the branch onto its base
 * *in the worktree*, so that the merge can be a fast-forward — a merge commit
 * would put a knot in a history the person never asked for, and a rebase that
 * does not go through is aborted and reported, never left half done. Then the
 * fast-forward, from the main tree: `merge --ff-only` when that tree is on the
 * base, else a fetch of the repository into itself, which moves the ref and
 * nothing on disk and refuses, as `merge` does, anything that is not a
 * fast-forward. Then `worktree remove`, then `branch -d` — the one that only
 * goes once the branch is reachable from something, which the merge just made
 * true. Anything git says no to on the way comes back as the error, with the
 * worktree standing exactly as it was.
 *
 * A worktree whose directory has gone is merged and unregistered without the
 * rebase, since there is nowhere to rebase in; a branch that has gone too
 * leaves nothing to do but the pruning.
 */
export async function retireWorktree(worktree: CardWorktree): Promise<{ commits: number }> {
  const { root, path, branch, base } = worktree;
  const standing = worktreePresent(path);
  const exists = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], root).then(
    () => true,
    () => false,
  );
  if (!exists && !standing) {
    await git(["worktree", "prune"], root).catch(() => undefined);
    return { commits: 0 };
  }
  if (base === "HEAD") throw new Error("was cut from a detached HEAD, so there is no branch to merge into");

  if (standing) {
    const changes = await worktreeChanges(path);
    if (changes.length) throw uncommittedError(changes);
    try {
      await git(["rebase", base], path);
    } catch (err) {
      await git(["rebase", "--abort"], path).catch(() => undefined);
      throw new Error(`does not rebase onto ${base} cleanly: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const commits = Number.parseInt(await git(["rev-list", "--count", `${base}..${branch}`], root), 10) || 0;
  const repo = await repoAt(root);
  const head = repo ? await readHead(repo) : null;
  if (head && !head.detached && head.branch === base) {
    await git(["merge", "--ff-only", branch], root);
  } else {
    await git(["fetch", ".", `${branch}:${base}`], root);
    /*
     * `branch -d` asks whether the branch is merged into HEAD, and HEAD is
     * whatever the main tree happens to be on — not the base it was just
     * merged into. Its other notion of merged is "into its upstream", so the
     * upstream is pointed at the base and the same forceless `-d` answers the
     * right question. The setting goes with the branch when it is deleted.
     */
    await git(["branch", `--set-upstream-to=${base}`, branch], root);
  }

  if (standing) await git(["worktree", "remove", path], root);
  else await git(["worktree", "prune"], root).catch(() => undefined);
  await git(["branch", "-d", branch], root);
  return { commits };
}

/**
 * Where a card's worktree stands, for its menu: what is uncommitted, and how
 * the branch sits against its base. `rev-list --left-right --count` answers
 * both directions in one line, and answers it for a worktree whose directory
 * has gone too, since the branch is the repository's — which is why the count
 * is asked of the main tree and the changes of the worktree.
 */
export async function worktreeStatus(worktree: CardWorktree): Promise<WorktreeStatus> {
  const { root, path, branch, base } = worktree;
  const present = worktreePresent(path);
  const changes = present ? await worktreeChanges(path) : [];
  const counts = await git(["rev-list", "--left-right", "--count", `${base}...${branch}`], root).catch(() => "0\t0");
  const [behind = 0, ahead = 0] = counts.trim().split(/\s+/).map((n) => Number.parseInt(n, 10) || 0);
  return { present, changes, ahead, behind };
}

/**
 * Commit everything in a worktree, with the card as the message: its title
 * as the subject and its body, if it has one, under it. `add -A` and not
 * `commit -a`, because an agent's work is as often a new file as an edited
 * one, and a commit that left the new files behind would be a merge that did
 * too. Whose commit it is comes from the person's own git config, the same as
 * a commit they typed — kururu sets no identity.
 */
export async function commitAll(path: string, subject: string, body: string): Promise<string[]> {
  const changes = await worktreeChanges(path);
  if (!changes.length) throw new Error("nothing to commit");
  await git(["add", "-A"], path);
  await git(body ? ["commit", "-q", "-m", subject, "-m", body] : ["commit", "-q", "-m", subject], path);
  return changes;
}

/**
 * Set a worktree's uncommitted work aside with `git stash`, untracked files
 * included. This is the card's "discard", and it is a stash rather than a
 * `checkout -- .` because the rule of this file is that kururu never throws
 * work away: the stash is in the repository, named after the card, and
 * `git stash list` finds it after the worktree itself has been removed.
 */
export async function stashAll(path: string, label: string): Promise<string[]> {
  const changes = await worktreeChanges(path);
  if (!changes.length) throw new Error("nothing to set aside");
  await git(["stash", "push", "-q", "-u", "-m", `kururu: ${label}`], path);
  return changes;
}
