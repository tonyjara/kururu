/**
 * Kururu is reachable from the tailnet, so path handling is the one place here
 * where a bug hands over something it should not. Both refusals are tested:
 * the lexical `..`, and the symlink that looks local and is not.
 */
import { describe, expect, it, beforeAll } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { allowedRoots, allowRoot, listDir, readFile, resolveInRoot } from "../src/files";

const tmp = join(realpathSync("/tmp"), `kururu-files-test-${process.pid}`);
const project = join(tmp, "project");

beforeAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src", "app.ts"), "export const hello = 1;\n");
  writeFileSync(join(tmp, "secret.txt"), "not yours\n");
  symlinkSync(join(tmp, "secret.txt"), join(project, "escape.txt"));
  allowRoot(project);
});

describe("roots", () => {
  it("only trusts directories it was told about", () => {
    expect(allowedRoots()).toContain(realpathSync(project));
    expect(resolveInRoot(tmp, "secret.txt")).toBeNull();
  });
});

describe("resolveInRoot", () => {
  it("resolves a path inside the project", () => {
    expect(resolveInRoot(project, "src/app.ts")).toBe(join(realpathSync(project), "src/app.ts"));
  });

  it("refuses a lexical traversal", () => {
    expect(resolveInRoot(project, "../secret.txt")).toBeNull();
    expect(resolveInRoot(project, "../../../etc/passwd")).toBeNull();
  });

  it("refuses a symlink that points out of the project", () => {
    expect(resolveInRoot(project, "escape.txt")).toBeNull();
  });
});

describe("listDir / readFile", () => {
  it("lists directories before files", () => {
    const names = listDir(project, "").map((e) => e.name);
    expect(names[0]).toBe("src");
  });

  it("reads a file inside the project", () => {
    expect(readFile(project, "src/app.ts").text).toBe("export const hello = 1;\n");
  });

  it("throws rather than clamping an escaping path", () => {
    expect(() => readFile(project, "escape.txt")).toThrow("outside the project");
  });
});
