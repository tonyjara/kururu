/**
 * Roots spelt through a symbolic link, on a real disk: the owner's bpay
 * workspace has its root at `pylink`, a link to `bpay`, and every path the
 * kernel reports is under `bpay` (2026-11-19). `shared/pathlinks.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { followLinks, within, withinLinked } from "../../shared/pathlinks";
import { linkOf, linksOf } from "../src/pathlinks";

let base = "";

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "kururu-pathlinks-"));
  mkdirSync(join(base, "bpay", "dashboard"), { recursive: true });
  mkdirSync(join(base, "bpayments"), { recursive: true });
  mkdirSync(join(base, "real", "code", "app"), { recursive: true });
  mkdirSync(join(base, "real", "code", "app.worktrees", "card"), { recursive: true });
  symlinkSync("bpay", join(base, "pylink"));
  symlinkSync(join(base, "real", "code"), join(base, "code"));
});

afterAll(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

describe("linkOf", () => {
  test("a workspace root that is itself a link", async () => {
    const link = await linkOf(join(base, "pylink"));
    expect(link).toEqual({ from: join(base, "pylink"), to: realpathSync(join(base, "bpay")) });
    // Followed, the root and what is under it are what the kernel would say.
    expect(followLinks(join(base, "pylink", "dashboard"), [link!])).toBe(realpathSync(join(base, "bpay", "dashboard")));
    // And the dev server's folder, as the kernel says it, is under the root.
    expect(withinLinked(realpathSync(join(base, "bpay", "dashboard")), join(base, "pylink"), [link!])).toBe(true);
    expect(within(realpathSync(join(base, "bpay", "dashboard")), join(base, "pylink"))).toBe(false);
  });

  test("a folder beside the link is not taken along", async () => {
    const link = await linkOf(join(base, "pylink"));
    expect(withinLinked(realpathSync(join(base, "bpayments")), join(base, "pylink"), [link!])).toBe(false);
    expect(followLinks(join(base, "pylink.worktrees", "x"), [link!])).toBe(join(base, "pylink.worktrees", "x"));
  });

  test("a root under a linked folder: the link is the folder, so a worktree beside the root follows too", async () => {
    const link = await linkOf(join(base, "code", "app"));
    expect(link).toEqual({ from: join(base, "code"), to: realpathSync(join(base, "real", "code")) });
    const worktree = join(base, "code", "app.worktrees", "card");
    expect(followLinks(worktree, [link!])).toBe(realpathSync(worktree));
  });

  test("whatever the links on the way, following the deepest gives the disk's path", async () => {
    // The scratch folder itself may be under one (macOS's /var is /private/var).
    const plain = join(base, "bpayments");
    const link = await linkOf(plain);
    expect(link === null ? plain : followLinks(plain, [link])).toBe(realpathSync(plain));
  });

  test("a folder that is not there is no link", async () => {
    expect(await linkOf(join(base, "pylink", "gone", "deeper"))).toBeNull();
    expect(await linkOf("relative/path")).toBeNull();
  });

  test("linksOf says each link once", async () => {
    const links = await linksOf([join(base, "pylink"), join(base, "pylink", "dashboard"), join(base, "pylink")]);
    expect(links).toEqual([{ from: join(base, "pylink"), to: realpathSync(join(base, "bpay")) }]);
  });
});
