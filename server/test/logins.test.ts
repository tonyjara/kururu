/**
 * The one place a login key becomes a path.
 *
 * Everything else about profiles keeping their own logins is an env var the
 * tools read and a directory the tools fill, neither of which a test can say
 * much about. What it can say is that the key is held to its shape before it is
 * joined to anything — a blob is read, not trusted, and `..` survives every rule
 * that is not this one — and that the directories land under the config root,
 * private, with the two variables pointing into them.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOGIN_KEY, isLoginKey, mintLoginKey } from "../../shared/model";
import { claudeDirFor, codexDirFor, loginDir, loginEnv, scanLogins } from "../src/logins";

let root: string;
let previous: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kururu-logins-"));
  previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = root;
});
afterEach(() => {
  if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previous;
  rmSync(root, { recursive: true, force: true });
});

const KEY = "0123456789ab";

describe("login keys", () => {
  it("mints keys of the shape it checks for, and different ones", () => {
    const a = mintLoginKey();
    const b = mintLoginKey();
    expect(a).toMatch(LOGIN_KEY);
    expect(isLoginKey(a)).toBe(true);
    expect(a).not.toBe(b);
  });

  it("refuses anything that could be a path, or is not a string", () => {
    for (const bad of ["..", "../..", "p1", "", "ABCDEF012345", "0123456789ab/", "0123456789abc", 12, null, undefined]) {
      expect(isLoginKey(bad)).toBe(false);
    }
  });
});

describe("loginDir", () => {
  it("puts a profile under the config root, by its key", () => {
    expect(loginDir(KEY)).toBe(join(root, "kururu", "profiles", KEY));
    expect(claudeDirFor(KEY)).toBe(join(root, "kururu", "profiles", KEY, "claude"));
    expect(codexDirFor(KEY)).toBe(join(root, "kururu", "profiles", KEY, "codex"));
  });

  it("throws rather than building a path from a key that is not one", () => {
    expect(() => loginDir("../../etc")).toThrow();
    expect(() => claudeDirFor("p1")).toThrow();
    expect(() => codexDirFor("")).toThrow();
  });
});

describe("loginEnv", () => {
  it("names the two directories the tools read, and makes them", () => {
    const env = loginEnv(KEY);
    expect(Object.keys(env).sort()).toEqual(["CLAUDE_CONFIG_DIR", "CODEX_HOME"]);
    expect(env.CLAUDE_CONFIG_DIR).toBe(claudeDirFor(KEY));
    expect(env.CODEX_HOME).toBe(codexDirFor(KEY));
    expect(existsSync(env.CLAUDE_CONFIG_DIR!)).toBe(true);
    expect(existsSync(env.CODEX_HOME!)).toBe(true);
  });

  it("makes the profile's directory and both inside it private to the user", () => {
    const env = loginEnv(KEY);
    expect(statSync(loginDir(KEY)).mode & 0o777).toBe(0o700);
    expect(statSync(env.CLAUDE_CONFIG_DIR!).mode & 0o777).toBe(0o700);
    expect(statSync(env.CODEX_HOME!).mode & 0o777).toBe(0o700);
  });

  it("is happy to be asked twice", () => {
    loginEnv(KEY);
    expect(() => loginEnv(KEY)).not.toThrow();
  });
});

describe("scanLogins", () => {
  it("is empty when nothing has been made", async () => {
    expect(await scanLogins()).toEqual([]);
  });

  it("lists each key directory with the account signed into it, and only those", async () => {
    loginEnv(KEY);
    writeFileSync(
      join(claudeDirFor(KEY), ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "a@example.com" } }),
    );
    const empty = "ba9876543210";
    loginEnv(empty);
    // A directory whose name is not a key is somebody else's and is left alone,
    // however much it looks like a login.
    mkdirSync(join(loginDir(KEY), "..", "not-a-key", "claude"), { recursive: true });
    writeFileSync(
      join(loginDir(KEY), "..", "not-a-key", "claude", ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "b@example.com" } }),
    );
    expect(await scanLogins()).toEqual([
      { key: KEY, email: "a@example.com" },
      { key: empty, email: null },
    ]);
  });

  it("reads a record that is not one as nobody", async () => {
    loginEnv(KEY);
    writeFileSync(join(claudeDirFor(KEY), ".claude.json"), "{not json");
    expect(await scanLogins()).toEqual([{ key: KEY, email: null }]);
  });
});
