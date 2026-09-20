/**
 * Reading `.git/HEAD`, which is the only part of knowing a branch that can be
 * quietly wrong.
 *
 * The walk up the tree either finds a repository or does not, and that shows on
 * the row immediately. Misreading HEAD does not: a branch called
 * `feature/api/v2` reported as `v2` is a plausible-looking word in the right
 * place, and the row it is on is the one somebody is about to trust before
 * letting an agent commit.
 */
import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headAt, parseHead } from "../src/git";

describe("parseHead", () => {
  it("reads a branch", () => {
    expect(parseHead("ref: refs/heads/main\n")).toEqual({ branch: "main", detached: false });
  });

  /** Slashes are part of the name, not a path to take the last segment of. */
  it("keeps the whole name of a branch with slashes in it", () => {
    expect(parseHead("ref: refs/heads/feature/api/v2\n")).toEqual({
      branch: "feature/api/v2",
      detached: false,
    });
  });

  it("reads a detached HEAD as a short sha, and says it is detached", () => {
    expect(parseHead("9e2f1c0a4b6d8e0f2a4c6e8a0c2e4f6a8c0e2f4a\n")).toEqual({
      branch: "9e2f1c0",
      detached: true,
    });
  });

  /**
   * Null rather than a guess, on `parseConfig`'s reasoning: a HEAD this does not
   * understand — a ref outside `refs/heads`, or a file caught mid-write by a
   * checkout — should leave the row saying nothing rather than something wrong.
   */
  it("declines what it does not understand", () => {
    expect(parseHead("ref: refs/tags/v1.0.0")).toBeNull();
    expect(parseHead("9e2f1c0")).toBeNull();
    expect(parseHead("")).toBeNull();
    expect(parseHead("   \n")).toBeNull();
  });
});

describe("headAt", () => {
  it("finds the repository from a directory inside it", async () => {
    const root = await mkdtemp(join(tmpdir(), "kururu-git-"));
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/trunk\n");
    const deep = join(root, "apps", "web", "src");
    await mkdir(deep, { recursive: true });

    expect(await headAt(deep)).toEqual({ root, branch: "trunk", detached: false });
  });

  /**
   * A linked worktree, which is what `git worktree add` makes and a normal way
   * to have two branches open at once. Its `.git` is a *file* pointing
   * elsewhere, and the path in it may be relative to the file's own directory —
   * which is the half that silently returns nothing when it is forgotten.
   */
  it("follows a .git file to where the gitdir actually is", async () => {
    const base = await mkdtemp(join(tmpdir(), "kururu-git-"));
    const tree = join(base, "worktree");
    const real = join(base, "store", "worktrees", "wt1");
    await mkdir(tree, { recursive: true });
    await mkdir(real, { recursive: true });
    await writeFile(join(real, "HEAD"), "ref: refs/heads/side\n");
    await writeFile(join(tree, ".git"), `gitdir: ../store/worktrees/wt1\n`);

    expect(await headAt(tree)).toEqual({ root: tree, branch: "side", detached: false });
  });

  it("finds nothing where there is no repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "kururu-git-"));
    expect(await headAt(root)).toBeNull();
  });
});
