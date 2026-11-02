/**
 * `Backup`, the one class that pushes the user's data off the machine with
 * git, run against a bare repository in a scratch directory.
 *
 * What it has to keep is in CLAUDE.md: what goes is an allow-list and a
 * secret never does; nothing is ever forced; a push the remote refuses stops
 * and says so, with the commit kept to try again. Those are the cases here.
 * `store.test.ts` covers what the mirror holds, file by file; this covers the
 * repository around it.
 *
 * Every directory the server would read comes from the environment, so the
 * three are pointed at the scratch directory for each test and put back
 * after — this process is shared with every other test file.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage } from "../../shared/wire";
import { Backup } from "../src/backup";
import { configDir } from "../src/config";
import { Store } from "../src/store";

/** Who these commits are by, so a machine with no git identity gets the same answer. */
const IDENTITY = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

const ENV = ["KURURU_DATA_DIR", "KURURU_STATE_DIR", "XDG_CONFIG_HOME", ...Object.keys(IDENTITY)];
const was: Record<string, string | undefined> = {};
let dir = "";
let remote = "";
let store: Store | null = null;
let backup: Backup | null = null;
const told: ServerMessage[] = [];

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, ...IDENTITY } }).toString().trim();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kururu-backup-"));
  for (const name of ENV) was[name] = process.env[name];
  process.env.KURURU_DATA_DIR = join(dir, "data");
  process.env.KURURU_STATE_DIR = join(dir, "state");
  process.env.XDG_CONFIG_HOME = join(dir, "config");
  Object.assign(process.env, IDENTITY);
  mkdirSync(configDir(), { recursive: true });
  remote = join(dir, "remote.git");
  sh(dir, "init", "-q", "--bare", "-b", "main", remote);
  told.length = 0;
  store = Store.open();
  backup = new Backup({
    store,
    broadcast: (msg) => told.push(msg),
    configDir,
    stateDir: () => process.env.KURURU_STATE_DIR!,
    dataDir: () => process.env.KURURU_DATA_DIR!,
  });
});

afterEach(() => {
  backup?.close();
  store?.close();
  backup = null;
  store = null;
  for (const [name, value] of Object.entries(was)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

const on = (url = remote) => backup!.set({ url, enabled: true, intervalMin: 60 });
const pushed = (path: string) => sh(remote, "ls-tree", "-r", "--name-only", "main").split("\n").includes(path);
const commits = (where: string, ref = "main") => Number(sh(where, "rev-list", "--count", ref));

describe("Backup", () => {
  it("does nothing, and says why, with no repository set", async () => {
    const status = await backup!.run();
    expect(status.error).toBe("No repository is set.");
    expect(status.lastCommit).toBeNull();
  });

  it("takes a repository only once it answers", async () => {
    await expect(on(join(dir, "nowhere.git"))).rejects.toThrow("The repository did not answer");
    expect(backup!.status().settings.enabled).toBe(false);
    await expect(on("not a url")).rejects.toThrow("That is not a git URL");
    const status = await on();
    expect(status.settings).toMatchObject({ url: remote, enabled: true });
    expect(told.some((msg) => msg.type === "backup")).toBe(true);
  });

  it("commits the mirror and pushes it to main", async () => {
    await on();
    const status = await backup!.run();
    expect(status.error).toBeNull();
    expect(status.lastCommit).not.toBeNull();
    expect(status.lastPushAt).not.toBeNull();
    expect(status.unpushed).toBe(0);
    expect(pushed("README.md")).toBe(true);
    expect(pushed("config/backup.json")).toBe(true);
  });

  it("never pushes a secret, whatever is in the config folder", async () => {
    const secrets = ["access.json", "openrouter.json", "telegram.json", "firecrawl.json", "web-selfhosted.json", "node.json", "nodes.json"];
    for (const name of secrets) writeFileSync(join(configDir(), name), JSON.stringify({ key: "sk-never-leaves" }));
    writeFileSync(join(configDir(), "keys.json"), "{}");
    await on();
    expect((await backup!.run()).error).toBeNull();
    expect(pushed("config/keys.json")).toBe(true);
    for (const name of secrets) expect(pushed(`config/${name}`)).toBe(false);
    // `git grep` exits 1 when it finds nothing, which is the answer wanted.
    expect(() => sh(remote, "grep", "-q", "sk-never-leaves", "main")).toThrow();
  });

  it("makes no commit when nothing changed", async () => {
    await on();
    await backup!.run();
    const before = commits(remote);
    expect((await backup!.run()).error).toBeNull();
    expect(commits(remote)).toBe(before);
  });

  it("is one run at a time: a second ask gets the same run", async () => {
    await on();
    const first = backup!.run();
    expect(backup!.run()).toBe(first);
    await first;
  });

  it("stops and says so when the remote has history this Mac has not — nothing forced", async () => {
    await on();
    await backup!.run();
    // Another machine backing up to the same repository.
    const other = join(dir, "other");
    sh(dir, "clone", "-q", remote, other);
    writeFileSync(join(other, "theirs.txt"), "another machine\n");
    sh(other, "add", "-A");
    sh(other, "commit", "-q", "-m", "theirs");
    sh(other, "push", "-q", "origin", "main");
    const theirs = sh(remote, "rev-parse", "main");

    writeFileSync(join(configDir(), "keys.json"), JSON.stringify({ changed: true }));
    const status = await backup!.run();
    expect(status.error).toContain("nothing was forced");
    expect(status.unpushed).toBeGreaterThanOrEqual(1);
    // The remote is as the other machine left it, and the commit is kept here.
    expect(sh(remote, "rev-parse", "main")).toBe(theirs);
    expect(commits(backup!.dir(), "HEAD")).toBe(2);
  });

  it("re-points origin when the repository changes", async () => {
    await on();
    await backup!.run();
    const second = join(dir, "second.git");
    sh(dir, "init", "-q", "--bare", "-b", "main", second);
    await on(second);
    expect((await backup!.run()).error).toBeNull();
    expect(sh(backup!.dir(), "remote", "get-url", "origin")).toBe(second);
  });
});
