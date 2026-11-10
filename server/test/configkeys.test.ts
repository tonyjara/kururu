/**
 * Kururu's config keys kept in the Keychain behind `readConfigFile` and
 * `writeConfigFile`, against a throwaway keychain in a scratch folder —
 * never the owner's login keychain — and a scratch config folder. Every key
 * here is made up in the shape of a real one, and is compared, never printed.
 *
 * The sealer and `KURURU_CONFIG_DIR` are put back after, since bun runs every
 * test file in one process.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfigFile, readConfigFileRaw, removeConfigFile, sealConfigSecrets, writeConfigFile } from "../src/config";
import { keychainSealer, MARKER, moveConfigSecrets, sealableFiles, secretPaths, unsealConfigSecrets } from "../src/configkeys";

const mac = process.platform === "darwin";
const OPENROUTER = `sk-or-v1-${"f".repeat(64)}`;
const TELEGRAM = "123456789:AAFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE_x";
const CLAUDE_A = `sk-ant-oat01-${"A".repeat(80)}`;
const CLAUDE_B = `sk-ant-oat01-${"B".repeat(80)}`;

describe("which fields are keys", () => {
  it("names the stored credentials and nothing else", () => {
    expect(secretPaths("openrouter.json")).toEqual(["managementKey"]);
    expect(secretPaths("web-firecrawl-self.json")).toContain("apiKey");
    expect(secretPaths("access.json")).toEqual([]);
    expect(secretPaths("node.json")).toEqual([]);
    expect(sealableFiles(["access.json", "telegram.json", "keys.json", "claude-lend.json", "web-x.json", "web-x.json.tmp"])).toEqual(["telegram.json", "claude-lend.json", "web-x.json"]);
  });
});

describe.if(mac)("keys kept in the Keychain", () => {
  const dir = mkdtempSync(join(tmpdir(), "kururu-configkeys-"));
  const keychain = join(dir, "test.keychain-db");
  const config = join(dir, "config");
  const before = process.env.KURURU_CONFIG_DIR;
  const file = (name: string) => readFileSync(join(config, name), "utf8");
  const has = (account: string) => {
    try {
      execFileSync("/usr/bin/security", ["find-generic-password", "-s", "kururu-config", "-a", account, keychain], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };

  beforeAll(() => {
    execFileSync("/usr/bin/security", ["create-keychain", "-p", "kururu-test", keychain]);
    execFileSync("/usr/bin/security", ["unlock-keychain", "-p", "kururu-test", keychain]);
    process.env.KURURU_CONFIG_DIR = config;
    sealConfigSecrets(keychainSealer(keychain));
  });
  afterAll(() => {
    sealConfigSecrets(null);
    if (before === undefined) delete process.env.KURURU_CONFIG_DIR;
    else process.env.KURURU_CONFIG_DIR = before;
    try {
      execFileSync("/usr/bin/security", ["delete-keychain", keychain], { stdio: "ignore" });
    } catch {
      // Gone with the folder.
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a marker where the key was, reads the key back, and leaves the settings in the file", () => {
    writeConfigFile("telegram.json", { token: TELEGRAM, bot: { username: "fakebot" }, enabled: true }, 0o600);
    expect(file("telegram.json")).not.toContain("AAFAKE");
    expect(file("telegram.json")).toContain(MARKER);
    expect(file("telegram.json")).toContain("fakebot");
    expect(statSync(join(config, "telegram.json")).mode & 0o777).toBe(0o600);
    expect((readConfigFile("telegram.json") as { token: string }).token === TELEGRAM).toBe(true);
  });

  it("keeps each lending token apart, and removes the one a login no longer has", () => {
    writeConfigFile("claude-lend.json", { tokens: { machine: { token: CLAUDE_A, account: "a@x" }, "0123456789ab": { token: CLAUDE_B, account: "b@x" } } }, 0o600);
    expect(file("claude-lend.json")).not.toContain("sk-ant");
    const read = readConfigFile("claude-lend.json") as { tokens: Record<string, { token: string }> };
    expect(read.tokens.machine!.token === CLAUDE_A && read.tokens["0123456789ab"]!.token === CLAUDE_B).toBe(true);
    // The second login's token is dropped from the file: its item goes too.
    writeConfigFile("claude-lend.json", { tokens: { machine: read.tokens.machine } }, 0o600);
    expect(has("claude-lend.json:tokens.machine.token")).toBe(true);
    expect(has("claude-lend.json:tokens.0123456789ab.token")).toBe(false);
  });

  it("forgets a file's items when the file is removed", () => {
    writeConfigFile("openrouter.json", { managementKey: OPENROUTER }, 0o600);
    removeConfigFile("openrouter.json");
    expect(readConfigFile("openrouter.json")).toBeNull();
    expect(has("openrouter.json:managementKey")).toBe(false);
  });

  it("moves a key left in the clear at start, and puts every key back with to-files", () => {
    // A file from before: written with the sealer off.
    sealConfigSecrets(null);
    writeConfigFile("openrouter.json", { managementKey: OPENROUTER }, 0o600);
    sealConfigSecrets(keychainSealer(keychain));
    const lines: string[] = [];
    const moved = moveConfigSecrets({
      files: () => ["openrouter.json", "telegram.json"],
      readRaw: readConfigFileRaw,
      read: readConfigFile,
      write: (name, value) => writeConfigFile(name, value, 0o600),
      restore: () => {
        throw new Error("nothing should be restored");
      },
      log: (line) => lines.push(line),
    });
    expect(moved).toEqual({ moved: ["openrouter.json"], kept: [] });
    expect(file("openrouter.json")).not.toContain("sk-or");
    expect(lines.join("\n")).not.toContain("sk-or");
    const back = unsealConfigSecrets({
      files: () => ["openrouter.json", "telegram.json", "claude-lend.json"],
      readRaw: readConfigFileRaw,
      sealer: keychainSealer(keychain),
      writePlain: (name, value) => writeFileSync(join(config, name), JSON.stringify(value), { mode: 0o600 }),
      restore: () => {},
      log: () => {},
    });
    expect(back.sort()).toEqual(["claude-lend.json", "openrouter.json", "telegram.json"]);
    expect((JSON.parse(file("openrouter.json")) as { managementKey: string }).managementKey === OPENROUTER).toBe(true);
    expect(file("telegram.json")).not.toContain(MARKER);
  });

  it("puts a file back as it was when the Keychain does not keep its key", () => {
    sealConfigSecrets(null);
    writeConfigFile("firecrawl.json", { apiKey: "fc-FAKE0123456789abcdef", settings: { daily: 5 } }, 0o600);
    const original = file("firecrawl.json");
    // A sealer whose keychain is not there: every write refused.
    sealConfigSecrets(keychainSealer(join(dir, "missing.keychain-db")));
    const restored: string[] = [];
    const moved = moveConfigSecrets({
      files: () => ["firecrawl.json"],
      readRaw: readConfigFileRaw,
      read: readConfigFile,
      write: (name, value) => writeConfigFile(name, value, 0o600),
      restore: (name, raw) => {
        restored.push(name);
        writeFileSync(join(config, name), `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
      },
      log: () => {},
    });
    sealConfigSecrets(keychainSealer(keychain));
    // The write fell back to the clear, which reads back the same: nothing is lost either way.
    expect(moved.moved).toEqual([]);
    expect(moved.kept).toEqual(["firecrawl.json"]);
    expect(file("firecrawl.json")).toBe(original);
  });
});
