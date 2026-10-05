/**
 * The tree's edits reach the user's disk from a tailnet-reachable socket, so the
 * refusals matter more than the successes: out of the project, over something
 * that exists, into itself, and at `.git`. Trash is tested only for what it
 * refuses — a test that succeeded at it would fill the Trash of whoever ran it.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkName, copyName, parseFileOp, runFileOp } from "../src/fileops";
import { allowRoot, listDirs } from "../src/files";

const tmp = join(realpathSync("/tmp"), `kururu-fileops-test-${process.pid}`);
const project = join(tmp, "project");
const root = project;

beforeEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(join(project, "src", "deep"), { recursive: true });
  mkdirSync(join(project, "docs"), { recursive: true });
  mkdirSync(join(project, ".git"), { recursive: true });
  writeFileSync(join(project, "src", "app.ts"), "app\n");
  writeFileSync(join(project, "docs", "app.ts"), "other\n");
  writeFileSync(join(tmp, "secret.txt"), "not yours\n");
  symlinkSync(join(tmp, "secret.txt"), join(project, "escape.txt"));
  allowRoot(project);
});

describe("checkName", () => {
  it("takes one component and trims it", () => {
    expect(checkName("  notes.md ")).toEqual({ name: "notes.md" });
  });
  it("refuses anything that would leave the folder", () => {
    for (const bad of ["", "  ", ".", "..", "a/b", "../x", "a\\b", "a\0b", ".git"]) {
      expect("error" in checkName(bad)).toBe(true);
    }
  });
});

describe("copyName", () => {
  it("follows Finder, keeping the extension last", () => {
    const taken = new Set(["app.ts", "app copy.ts"]);
    expect(copyName("app.ts", (n) => taken.has(n))).toBe("app copy 2.ts");
    expect(copyName("fresh.ts", (n) => taken.has(n))).toBe("fresh.ts");
  });
  it("treats a dotfile's dot as its name", () => {
    expect(copyName(".env", (n) => n === ".env")).toBe(".env copy");
  });
});

describe("parseFileOp", () => {
  it("wants every field as a string", () => {
    expect(parseFileOp({ op: "rename", root, path: "a", name: "b" })).not.toBeNull();
    expect(parseFileOp({ op: "rename", root, path: "a" })).toBeNull();
    expect(parseFileOp({ op: "rename", root, path: 1, name: "b" })).toBeNull();
    expect(parseFileOp({ op: "rm", root, path: "a" })).toBeNull();
    expect(parseFileOp(null)).toBeNull();
  });
});

describe("runFileOp", () => {
  it("creates, and never over something", async () => {
    expect(await runFileOp({ op: "mkdir", root, dir: "src", name: "new" })).toEqual({ ok: true, path: "src/new" });
    expect(await runFileOp({ op: "touch", root, dir: "", name: "a.md" })).toEqual({ ok: true, path: "a.md" });
    expect((await runFileOp({ op: "touch", root, dir: "src", name: "app.ts" })).ok).toBe(false);
    expect(readFileSync(join(project, "src", "app.ts"), "utf8")).toBe("app\n");
  });

  it("renames within the folder, and not out of it", async () => {
    expect(await runFileOp({ op: "rename", root, path: "src/app.ts", name: "main.ts" })).toEqual({
      ok: true,
      path: "src/main.ts",
    });
    expect((await runFileOp({ op: "rename", root, path: "src/main.ts", name: "../../out.ts" })).ok).toBe(false);
    expect(existsSync(join(tmp, "out.ts"))).toBe(false);
  });

  it("moves, refusing a taken name and a folder into itself", async () => {
    expect((await runFileOp({ op: "move", root, path: "src/app.ts", dir: "docs" })).ok).toBe(false);
    expect(readFileSync(join(project, "docs", "app.ts"), "utf8")).toBe("other\n");
    expect((await runFileOp({ op: "move", root, path: "src", dir: "src/deep" })).ok).toBe(false);
    expect(await runFileOp({ op: "move", root, path: "docs/app.ts", dir: "" })).toEqual({ ok: true, path: "app.ts" });
  });

  it("copies beside the original under a new name", async () => {
    expect(await runFileOp({ op: "copy", root, path: "src/app.ts", dir: "src" })).toEqual({
      ok: true,
      path: "src/app copy.ts",
    });
    expect(await runFileOp({ op: "copy", root, path: "src", dir: "docs" })).toEqual({ ok: true, path: "docs/src" });
    expect(readFileSync(join(project, "docs", "src", "app.ts"), "utf8")).toBe("app\n");
    expect((await runFileOp({ op: "copy", root, path: "src", dir: "src/deep" })).ok).toBe(false);
  });

  it("refuses the root, .git, traversal, and a symlink out", async () => {
    for (const op of [
      { op: "trash", root, path: "" },
      { op: "trash", root, path: ".git" },
      { op: "trash", root, path: "../secret.txt" },
      { op: "trash", root, path: "escape.txt" },
      { op: "move", root, path: "src/app.ts", dir: ".git" },
      { op: "move", root, path: "src/app.ts", dir: ".." },
      { op: "mkdir", root: tmp, dir: "", name: "x" },
    ] as const) {
      expect((await runFileOp(op)).ok).toBe(false);
    }
    expect(existsSync(join(tmp, "secret.txt"))).toBe(true);
    expect(existsSync(join(project, ".git"))).toBe(true);
  });
});

describe("listDirs", () => {
  it("lists folders shallowest first, without .git", () => {
    const dirs = listDirs(root);
    expect(dirs).toContain("src/deep");
    expect(dirs).not.toContain(".git");
    expect(dirs.indexOf("src")).toBeLessThan(dirs.indexOf("src/deep"));
  });
});

describe("reveal", () => {
  it("parses, and refuses a path outside the project without opening anything", async () => {
    expect(parseFileOp({ op: "reveal", root, path: "src/app.ts" })).toEqual({ op: "reveal", root, path: "src/app.ts" });
    expect(await runFileOp({ op: "reveal", root, path: "../secret.txt" })).toEqual({ ok: false, error: "path is outside the project" });
    expect((await runFileOp({ op: "reveal", root, path: "escape.txt" })).ok).toBe(false);
  });
});
