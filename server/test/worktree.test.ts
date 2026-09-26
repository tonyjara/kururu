/**
 * A card's checkout: how it is named, where it goes, and what git is asked to
 * do — against a real repository in a temp directory, because `git worktree
 * add` is the operation and a test that fakes it would only test the fake. No
 * agent is started; the repository is three files and one commit.
 */
import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withProject } from "../src/projects";
import {
  commitAll,
  commitTyped,
  defaultBranch,
  ensureWorktree,
  fastForward,
  mainRoot,
  parseStatusHeader,
  repoStatus,
  retireWorktree,
  stashAll,
  worktreeChanges,
  worktreePresent,
  worktreeStatus,
} from "../src/worktree";
import {
  adoptProject,
  adoptProjects,
  DEFAULT_PROJECT,
  worktreeBranch,
  worktreeDir,
  worktreeName,
  worktreeSlug,
} from "../../shared/projects";

describe("naming", () => {
  it("makes a slug a branch and a directory can be called", () => {
    expect(worktreeSlug("Fix the login page!")).toBe("fix-the-login-page");
    expect(worktreeSlug("feature/api/v2 — again")).toBe("feature-api-v2-again");
    expect(worktreeSlug("Añadir emoji 🎉")).toBe("a-adir-emoji");
    expect(worktreeSlug("!!!")).toBe("card");
    expect(worktreeSlug("x".repeat(80)).length).toBe(40);
  });

  /** Two cards with one title are two branches, and the id's tail is what tells them apart. */
  it("tells two cards with the same title apart", () => {
    const a = worktreeName({ id: "c0123456789ab", title: "Fix tests" });
    const b = worktreeName({ id: "c0123456789cd", title: "Fix tests" });
    expect(a).toBe("fix-tests-89ab");
    expect(a).not.toBe(b);
    expect(worktreeBranch(a)).toBe("kururu/fix-tests-89ab");
  });

  it("puts the worktree beside the repository, and does not nest one inside another's container", () => {
    expect(worktreeDir("/Users/me/code/app", "fix-1234")).toBe("/Users/me/code/app.worktrees/fix-1234");
    expect(worktreeDir("/Users/me/code/app/", "fix-1234")).toBe("/Users/me/code/app.worktrees/fix-1234");
    expect(worktreeDir("/Users/me/code/app.worktrees/other-9999", "fix-1234")).toBe(
      "/Users/me/code/app.worktrees/fix-1234",
    );
  });
});

describe("settings", () => {
  it("reads whatever was on disk as settings, and refuses a key that is not a path", () => {
    expect(adoptProject(undefined)).toEqual(DEFAULT_PROJECT);
    expect(adoptProject({ worktrees: false, setup: "  bun install\n", dev: 7 })).toEqual({
      worktrees: false,
      setup: "bun install",
      dev: "",
    });
    const map = adoptProjects({ "/r/app": { dev: "bun run dev" }, "app": { dev: "x" }, "": {} });
    expect(Object.keys(map)).toEqual(["/r/app"]);
    expect(map["/r/app"]).toEqual({ worktrees: true, setup: "", dev: "bun run dev" });
  });

  it("writes no entry for a repository left at the defaults", () => {
    const one = withProject({}, "/r/app", { ...DEFAULT_PROJECT, setup: "bun install" });
    expect(one).toEqual({ "/r/app": { worktrees: true, setup: "bun install", dev: "" } });
    expect(withProject(one, "/r/app", DEFAULT_PROJECT)).toEqual({});
  });
});

/**
 * Who the test commits as. `retireWorktree` rebases, and a rebase that replays
 * a commit needs a committer; the server's `git` inherits its environment, so
 * this is set on the process rather than passed to it — a machine with no
 * identity configured would otherwise fail these and pass on the next desk.
 */
for (const [key, value] of Object.entries({
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
})) {
  process.env[key] ??= value;
}

/** Git in a directory, for the tests to arrange history the server then meets. */
function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
}

/** A repository with one commit on `main`, to cut worktrees from. */
async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kururu-wt-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      stdio: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
  git("init", "-q", "-b", "main");
  await writeFile(join(root, "a.txt"), "a\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "one");
  return root;
}

describe("ensureWorktree", () => {
  const card = { id: "c0123456789ab", title: "Fix the tests" };

  it("makes a worktree beside the repository on a branch cut from HEAD, and finds it again", async () => {
    const root = await repo();
    try {
      const made = await ensureWorktree(root, card);
      expect(made.fresh).toBe(true);
      expect(made.worktree).toEqual({
        root,
        path: join(`${root}.worktrees`, "fix-the-tests-89ab"),
        branch: "kururu/fix-the-tests-89ab",
        base: "main",
      });
      expect(worktreePresent(made.worktree.path)).toBe(true);
      expect(existsSync(join(made.worktree.path, "a.txt"))).toBe(true);
      const head = execFileSync("git", ["-C", made.worktree.path, "branch", "--show-current"]).toString().trim();
      expect(head).toBe("kururu/fix-the-tests-89ab");

      // A second agent on the same card: the same checkout, and no setup.
      const again = await ensureWorktree(root, card);
      expect(again.fresh).toBe(false);
      expect(again.worktree.path).toBe(made.worktree.path);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(`${root}.worktrees`, { recursive: true, force: true });
    }
  });

  /**
   * The directory went but the branch did not — somebody `rm -rf`'d it, or the
   * container was tidied. The commits are on the branch, so it is checked out
   * again rather than a second branch made beside it, and the registration git
   * still holds for the missing directory is pruned rather than fought.
   */
  it("checks a surviving branch out again when its directory is gone", async () => {
    const root = await repo();
    try {
      const made = await ensureWorktree(root, card);
      await rm(made.worktree.path, { recursive: true, force: true });
      const back = await ensureWorktree(root, card);
      expect(back.fresh).toBe(true);
      expect(back.worktree.branch).toBe(made.worktree.branch);
      expect(worktreePresent(back.worktree.path)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(`${root}.worktrees`, { recursive: true, force: true });
    }
  });

  /** Pressed from inside a card's worktree, the next card is cut from the main tree, not from that card. */
  it("resolves a worktree back to the repository it was linked from", async () => {
    const root = await repo();
    try {
      const made = await ensureWorktree(root, card);
      // Git spells the main tree as a real path (`/private/var/…` on macOS for
      // a temp directory); the repository itself keeps the spelling it was asked about.
      expect(realpathSync(await mainRoot(made.worktree.path))).toBe(realpathSync(root));
      expect(await mainRoot(root)).toBe(root);
      const main = await mainRoot(made.worktree.path);
      const second = await ensureWorktree(main, { id: "c0000000000ff", title: "Next" });
      expect(second.worktree.base).toBe("main");
      expect(second.worktree.path).toBe(join(`${main}.worktrees`, "next-00ff"));
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(`${root}.worktrees`, { recursive: true, force: true });
    }
  });

  it("refuses rather than guesses outside a repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kururu-wt-none-"));
    try {
      await expect(ensureWorktree(dir, card)).rejects.toThrow(/not in a git repository/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("retireWorktree", () => {
  const card = { id: "c0123456789ab", title: "Fix the tests" };
  const commitIn = async (dir: string, file: string, text: string, message: string) => {
    await writeFile(join(dir, file), text);
    sh(dir, "add", file);
    sh(dir, "commit", "-q", "-m", message);
  };
  const cleanup = async (root: string) => {
    await rm(root, { recursive: true, force: true });
    await rm(`${root}.worktrees`, { recursive: true, force: true });
  };

  it("fast-forwards the base to the card's commits, removes the worktree and deletes the branch", async () => {
    const root = await repo();
    try {
      const { worktree } = await ensureWorktree(root, card);
      await commitIn(worktree.path, "b.txt", "b\n", "card work");
      await commitIn(worktree.path, "c.txt", "c\n", "more card work");

      expect(await retireWorktree(worktree)).toEqual({ commits: 2 });
      expect(sh(root, "log", "--format=%s", "main")).toBe("more card work\ncard work\none");
      expect(existsSync(join(root, "c.txt"))).toBe(true);
      expect(worktreePresent(worktree.path)).toBe(false);
      expect(sh(root, "branch", "--list", worktree.branch)).toBe("");
      expect(sh(root, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "))).toHaveLength(1);
    } finally {
      await cleanup(root);
    }
  });

  /**
   * The base moved while the card was worked on — somebody merged another card
   * first. The card's branch is rebased onto it in the worktree, and the merge
   * is still a fast-forward: no merge commit, ever.
   */
  it("rebases onto a base that moved on, so the merge is still a fast-forward", async () => {
    const root = await repo();
    try {
      const { worktree } = await ensureWorktree(root, card);
      await commitIn(worktree.path, "b.txt", "b\n", "card work");
      await commitIn(root, "d.txt", "d\n", "meanwhile on main");

      expect(await retireWorktree(worktree)).toEqual({ commits: 1 });
      expect(sh(root, "log", "--format=%s", "main")).toBe("card work\nmeanwhile on main\none");
      // One parent each: a fast-forward of a rebased branch, not a merge.
      expect(sh(root, "rev-list", "--merges", "--count", "main")).toBe("0");
      expect(worktreePresent(worktree.path)).toBe(false);
    } finally {
      await cleanup(root);
    }
  });

  it("refuses a worktree with uncommitted changes and leaves it standing", async () => {
    const root = await repo();
    try {
      const { worktree } = await ensureWorktree(root, card);
      await commitIn(worktree.path, "b.txt", "b\n", "card work");
      await writeFile(join(worktree.path, "a.txt"), "edited but not committed\n");
      expect(await worktreeChanges(worktree.path)).toEqual(["a.txt"]);

      await expect(retireWorktree(worktree)).rejects.toThrow("uncommitted changes in a.txt");
      expect(worktreePresent(worktree.path)).toBe(true);
      expect(sh(root, "log", "--format=%s", "main")).toBe("one");
      expect(sh(root, "branch", "--list", worktree.branch)).not.toBe("");
    } finally {
      await cleanup(root);
    }
  });

  /**
   * An untracked file is what `git worktree remove` refuses too — a `.env`
   * somebody copied in is work as far as git is concerned, and as far as the
   * person who copied it is.
   */
  it("counts an untracked file as uncommitted", async () => {
    const root = await repo();
    try {
      const { worktree } = await ensureWorktree(root, card);
      await writeFile(join(worktree.path, ".env"), "SECRET=1\n");
      await expect(retireWorktree(worktree)).rejects.toThrow("uncommitted changes in .env");
      expect(worktreePresent(worktree.path)).toBe(true);
    } finally {
      await cleanup(root);
    }
  });

  it("aborts a rebase that conflicts and reports it, with the worktree as it was", async () => {
    const root = await repo();
    try {
      const { worktree } = await ensureWorktree(root, card);
      await commitIn(worktree.path, "a.txt", "card's version\n", "card work");
      await commitIn(root, "a.txt", "main's version\n", "meanwhile on main");

      await expect(retireWorktree(worktree)).rejects.toThrow("does not rebase onto main cleanly");
      expect(worktreePresent(worktree.path)).toBe(true);
      // Not mid-rebase: the branch is checked out and its commit is intact.
      expect(sh(worktree.path, "branch", "--show-current")).toBe(worktree.branch);
      expect(sh(worktree.path, "log", "--format=%s")).toBe("card work\none");
      expect(sh(root, "log", "--format=%s", "main")).toBe("meanwhile on main\none");
    } finally {
      await cleanup(root);
    }
  });

  /** A card that ran and did nothing: nothing to merge, and the worktree still goes. */
  it("removes a worktree with no commits on it", async () => {
    const root = await repo();
    try {
      const { worktree } = await ensureWorktree(root, card);
      expect(await retireWorktree(worktree)).toEqual({ commits: 0 });
      expect(worktreePresent(worktree.path)).toBe(false);
      expect(sh(root, "branch", "--list", worktree.branch)).toBe("");
    } finally {
      await cleanup(root);
    }
  });

  /**
   * The main tree is off on some other branch when the sweep runs. The base
   * still moves — by a fetch of the repository into itself — and the checkout
   * on disk is not touched, because it was never on the base to begin with.
   */
  it("moves the base when the main tree has another branch checked out", async () => {
    const root = await repo();
    try {
      const { worktree } = await ensureWorktree(root, card);
      await commitIn(worktree.path, "b.txt", "b\n", "card work");
      sh(root, "checkout", "-q", "-b", "elsewhere");

      expect(await retireWorktree(worktree)).toEqual({ commits: 1 });
      expect(sh(root, "log", "--format=%s", "main")).toBe("card work\none");
      expect(sh(root, "branch", "--show-current")).toBe("elsewhere");
      expect(existsSync(join(root, "b.txt"))).toBe(false);
      expect(worktreePresent(worktree.path)).toBe(false);
    } finally {
      await cleanup(root);
    }
  });

  /** The directory went by hand; the branch and its commits did not. */
  it("merges a branch whose directory is already gone, and prunes the registration", async () => {
    const root = await repo();
    try {
      const { worktree } = await ensureWorktree(root, card);
      await commitIn(worktree.path, "b.txt", "b\n", "card work");
      await rm(worktree.path, { recursive: true, force: true });

      expect(await retireWorktree(worktree)).toEqual({ commits: 1 });
      expect(sh(root, "log", "--format=%s", "main")).toBe("card work\none");
      expect(sh(root, "branch", "--list", worktree.branch)).toBe("");
      expect(sh(root, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "))).toHaveLength(1);
    } finally {
      await cleanup(root);
    }
  });
});

describe("the card's git", () => {
  const card = { id: "c0123456789ab", title: "Fix the tests" };
  const cleanup = async (root: string) => {
    await rm(root, { recursive: true, force: true });
    await rm(`${root}.worktrees`, { recursive: true, force: true });
  };

  it("reports changes, ahead and behind, and knows a directory that has gone", async () => {
    const root = await repo();
    try {
      const { worktree } = await ensureWorktree(root, card);
      expect(await worktreeStatus(worktree)).toEqual({ present: true, changes: [], ahead: 0, behind: 0 });

      await writeFile(join(worktree.path, "b.txt"), "b\n");
      await writeFile(join(worktree.path, "a.txt"), "changed\n");
      expect((await worktreeStatus(worktree)).changes.sort()).toEqual(["a.txt", "b.txt"]);

      await commitAll(worktree.path, "card work", "");
      await writeFile(join(root, "d.txt"), "d\n");
      sh(root, "add", "d.txt");
      sh(root, "commit", "-q", "-m", "meanwhile");
      expect(await worktreeStatus(worktree)).toEqual({ present: true, changes: [], ahead: 1, behind: 1 });

      await rm(worktree.path, { recursive: true, force: true });
      expect(await worktreeStatus(worktree)).toEqual({ present: false, changes: [], ahead: 1, behind: 1 });
    } finally {
      await cleanup(root);
    }
  });

  it("commits everything with the card as the message, new files included", async () => {
    const root = await repo();
    try {
      const { worktree } = await ensureWorktree(root, card);
      await expect(commitAll(worktree.path, "x", "")).rejects.toThrow("nothing to commit");

      await writeFile(join(worktree.path, "new.txt"), "new\n");
      await writeFile(join(worktree.path, "a.txt"), "changed\n");
      expect((await commitAll(worktree.path, "Fix the tests", "The body\n\nof the card")).sort()).toEqual(["a.txt", "new.txt"]);
      expect(await worktreeChanges(worktree.path)).toEqual([]);
      expect(sh(worktree.path, "log", "-1", "--format=%s")).toBe("Fix the tests");
      expect(sh(worktree.path, "log", "-1", "--format=%b")).toBe("The body\n\nof the card");
      expect(sh(worktree.path, "show", "--stat", "--format=", "HEAD")).toContain("new.txt");
    } finally {
      await cleanup(root);
    }
  });

  /**
   * "Discard" that is not one: the work goes into the stash under the card's
   * name, and it is still there — from the main tree, since the stash is the
   * repository's — after the worktree has been merged and removed.
   */
  it("sets changes aside in the stash, where they outlive the worktree", async () => {
    const root = await repo();
    try {
      const { worktree } = await ensureWorktree(root, card);
      await expect(stashAll(worktree.path, "Fix the tests")).rejects.toThrow("nothing to set aside");

      await writeFile(join(worktree.path, "a.txt"), "changed\n");
      await writeFile(join(worktree.path, ".env"), "SECRET=1\n");
      expect((await stashAll(worktree.path, "Fix the tests")).sort()).toEqual([".env", "a.txt"]);
      expect(await worktreeChanges(worktree.path)).toEqual([]);
      expect(existsSync(join(worktree.path, ".env"))).toBe(false);

      expect(await retireWorktree(worktree)).toEqual({ commits: 0 });
      expect(sh(root, "stash", "list")).toContain("kururu: Fix the tests");
    } finally {
      await cleanup(root);
    }
  });
});

describe("the workspace's git", () => {
  it("reads the upstream and the counts off the status header", () => {
    expect(parseStatusHeader("## main")).toEqual({ upstream: null, ahead: 0, behind: 0 });
    expect(parseStatusHeader("## main...origin/main")).toEqual({ upstream: "origin/main", ahead: 0, behind: 0 });
    expect(parseStatusHeader("## feature/x...origin/feature/x [ahead 2, behind 3]")).toEqual({
      upstream: "origin/feature/x",
      ahead: 2,
      behind: 3,
    });
    expect(parseStatusHeader("## main...origin/main [behind 1]")).toEqual({ upstream: "origin/main", ahead: 0, behind: 1 });
    expect(parseStatusHeader("## main...origin/main [gone]")).toEqual({ upstream: null, ahead: 0, behind: 0 });
    expect(parseStatusHeader("## HEAD (no branch)")).toEqual({ upstream: null, ahead: 0, behind: 0 });
    expect(parseStatusHeader("## No commits yet on main")).toEqual({ upstream: null, ahead: 0, behind: 0 });
  });

  it("counts changes, commits a typed message, and fast-forwards main without leaving the branch", async () => {
    const root = await repo();
    try {
      expect(await defaultBranch(root)).toBe("main");
      sh(root, "checkout", "-q", "-b", "topic");
      expect(await repoStatus(root)).toEqual({ changes: 0, upstream: null, ahead: 0, behind: 0 });

      await writeFile(join(root, "a.txt"), "changed\n");
      await writeFile(join(root, "b.txt"), "b\n");
      expect((await repoStatus(root)).changes).toBe(2);

      await expect(commitTyped(root, "  \n")).rejects.toThrow("needs a message");
      await commitTyped(root, "Subject line\n\nAnd a body");
      expect(sh(root, "log", "-1", "--format=%s")).toBe("Subject line");
      expect(sh(root, "log", "-1", "--format=%b")).toBe("And a body");
      expect((await repoStatus(root)).changes).toBe(0);

      expect(await fastForward(root, "topic", "main")).toEqual({ commits: 1 });
      expect(sh(root, "rev-parse", "main")).toBe(sh(root, "rev-parse", "topic"));
      expect(sh(root, "branch", "--show-current")).toBe("topic");
      await expect(fastForward(root, "main", "main")).rejects.toThrow("nothing to merge");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to merge into a main that has moved on, and leaves it where it was", async () => {
    const root = await repo();
    try {
      sh(root, "checkout", "-q", "-b", "topic");
      await writeFile(join(root, "t.txt"), "t\n");
      sh(root, "add", "t.txt");
      sh(root, "commit", "-q", "-m", "topic");
      sh(root, "checkout", "-q", "main");
      await writeFile(join(root, "m.txt"), "m\n");
      sh(root, "add", "m.txt");
      sh(root, "commit", "-q", "-m", "meanwhile");
      const before = sh(root, "rev-parse", "main");
      sh(root, "checkout", "-q", "topic");
      await expect(fastForward(root, "topic", "main")).rejects.toThrow("rebase topic onto main first");
      expect(sh(root, "rev-parse", "main")).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
