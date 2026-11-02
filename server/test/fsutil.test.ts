import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inside, stateDir, writeAtomic } from "../src/fsutil";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "kururu-fsutil-"));
}

describe("writeAtomic", () => {
  it("replaces the file whole and leaves no temp behind", () => {
    const dir = scratch();
    try {
      const path = join(dir, "x.json");
      writeFileSync(path, "old");
      writeAtomic(path, "new");
      expect(readFileSync(path, "utf8")).toBe("new");
      expect(readdirSync(dir)).toEqual(["x.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sets a secret's mode even over a temp a crash left behind, which writeFile's own option would not", () => {
    const dir = scratch();
    try {
      const path = join(dir, "secret.json");
      writeFileSync(`${path}.tmp`, "left over", { mode: 0o644 });
      writeAtomic(path, "token", { mode: 0o600 });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(existsSync(`${path}.tmp`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names its temp as asked, for a directory that is somebody else's", () => {
    const dir = scratch();
    try {
      const path = join(dir, "auth.json");
      writeFileSync(`${path}.kururu-tmp`, "left over");
      writeAtomic(path, "{}", { mode: 0o600, suffix: ".kururu-tmp" });
      expect(readdirSync(dir)).toEqual(["auth.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws, so each caller decides what a failed save means", () => {
    expect(() => writeAtomic(join(tmpdir(), "no-such-dir-kururu", "x"), "x")).toThrow();
  });

  /**
   * Every write-then-rename in the server goes through `writeAtomic`, so the
   * rule about a secret's mode is in one place. A rename of something other
   * than a temp — a log rotated, a file moved by the file tree — is not this.
   * `hostsock.ts` and the rest of the pty host are left as they are.
   */
  it("is the only temp-and-rename in the server", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : [];
      });
    const handRolled = walk(join(import.meta.dir, "..", "src"))
      .filter((path) => !path.endsWith("fsutil.ts"))
      .filter((path) => /renameSync\(\s*(temp\b|`\$\{[^}]+\}\.(tmp|kururu-tmp)`)/.test(readFileSync(path, "utf8")));
    expect(handRolled).toEqual([]);
  });
});

describe("stateDir", () => {
  it("is KURURU_STATE_DIR when set, as an isolated instance sets it", () => {
    const was = process.env.KURURU_STATE_DIR;
    try {
      process.env.KURURU_STATE_DIR = "/tmp/k2";
      expect(stateDir()).toBe("/tmp/k2");
    } finally {
      if (was === undefined) delete process.env.KURURU_STATE_DIR;
      else process.env.KURURU_STATE_DIR = was;
    }
  });
});

describe("inside", () => {
  it("takes the root itself and what is under it, and not a sibling that shares a prefix", () => {
    expect(inside("/a/b", "/a/b")).toBe(true);
    expect(inside("/a/b", "/a/b/c")).toBe(true);
    expect(inside("/a/b", "/a/bc")).toBe(false);
    expect(inside("/a/b", "/a")).toBe(false);
  });
});
