/**
 * Kururu is reachable from the tailnet, so path handling is the one place here
 * where a bug hands over something it should not. Both refusals are tested:
 * the lexical `..`, and the symlink that looks local and is not.
 */
import { describe, expect, it, beforeAll } from "bun:test";
import { mkdirSync, symlinkSync, utimesSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { allowedRoots, allowRoot, findDocs, listDir, readFile, resolveInRoot } from "../src/files";

const tmp = join(realpathSync("/tmp"), `kururu-files-test-${process.pid}`);
const project = join(tmp, "project");

beforeAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src", "app.ts"), "export const hello = 1;\n");
  writeFileSync(join(tmp, "secret.txt"), "not yours\n");
  mkdirSync(join(project, "docs", "adr"), { recursive: true });
  mkdirSync(join(project, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(project, "README.md"), "# hello\n");
  writeFileSync(join(project, "docs", "PLAN.md"), "# plan\n");
  writeFileSync(join(project, "docs", "adr", "0001.md"), "# adr\n");
  writeFileSync(join(project, "node_modules", "pkg", "README.md"), "# not yours\n");
  writeFileSync(join(project, "src", "notes.txt"), "not a document\n");
  // Newest last, so the ordering under test is not the order they were written.
  utimesSync(join(project, "docs", "PLAN.md"), new Date(), new Date(Date.now() + 10_000));
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
    // The whole ordering rather than the first name, so that adding a fixture
    // directory to this project cannot make a passing test pass for a new
    // reason — which is exactly what the document fixtures nearly did.
    const kinds = listDir(project, "").map((e) => e.dir);
    expect(kinds.lastIndexOf(true)).toBeLessThan(kinds.indexOf(false));
  });

  it("reads a file inside the project", () => {
    expect(readFile(project, "src/app.ts").text).toBe("export const hello = 1;\n");
  });

  it("throws rather than clamping an escaping path", () => {
    expect(() => readFile(project, "escape.txt")).toThrow("outside the project");
  });
});

/**
 * The picker's list. It is a search and not a listing, so what is worth holding
 * is the three things it leaves out: everything that is not a document, the
 * directories nobody reads, and the symlink `resolveInRoot` would refuse anyway.
 */
describe("findDocs", () => {
  it("finds documents at every depth and nothing that is not one", () => {
    const paths = findDocs(project).map((doc) => doc.path);
    expect(paths.sort()).toEqual(["README.md", "docs/PLAN.md", "docs/adr/0001.md"]);
  });

  it("skips the directories a listing skips", () => {
    expect(findDocs(project).some((doc) => doc.path.startsWith("node_modules"))).toBe(false);
  });

  it("puts the most recently written first, which is the whole order", () => {
    expect(findDocs(project)[0]?.path).toBe("docs/PLAN.md");
  });

  it("refuses a root it was never told about", () => {
    expect(() => findDocs(tmp)).toThrow("outside the project");
  });
});
