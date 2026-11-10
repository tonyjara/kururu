/**
 * The vault's store against a real keychain — a throwaway one in a scratch
 * folder, made and deleted here, never the owner's login keychain — and the
 * file store a node with no Keychain uses.
 *
 * Only on a Mac, where `/usr/bin/security` is. Every value is made up; the
 * test compares them and never prints one.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileStore, keychainStore } from "../src/keychain";

const mac = process.platform === "darwin";
const dir = mkdtempSync(join(tmpdir(), "kururu-keychain-"));
const keychain = join(dir, "test.keychain-db");

const VALUES: Record<string, string> = {
  plain: "pk_test_FAKE0123456789",
  quotes: `sk "FAKE" 'x' $y \\z`,
  accent: "contraseña-FAKE",
  pem: `-----BEGIN FAKE KEY-----\n${"QUJD".repeat(1500)}\n-----END FAKE KEY-----\n`,
};

describe.if(mac)("the Keychain store", () => {
  beforeAll(() => {
    execFileSync("/usr/bin/security", ["create-keychain", "-p", "kururu-test", keychain]);
    execFileSync("/usr/bin/security", ["unlock-keychain", "-p", "kururu-test", keychain]);
  });
  afterAll(() => {
    try {
      execFileSync("/usr/bin/security", ["delete-keychain", keychain], { stdio: "ignore" });
    } catch {
      // Gone with the folder.
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const store = keychainStore("kururu-vault-test", keychain);

  it("keeps and gives back every kind of value, long ones in pieces", async () => {
    for (const [name, value] of Object.entries(VALUES)) {
      await store.put(`t/${name}`, value);
      expect((await store.get(`t/${name}`)) === value).toBe(true);
    }
    expect(await store.has("t/pem")).toBe(true);
    expect(await store.get("t/none")).toBeNull();
  });

  it("replaces a long value with a short one without leaving the old tail", async () => {
    await store.put("t/shrink", VALUES.pem!);
    await store.put("t/shrink", VALUES.plain!);
    expect((await store.get("t/shrink")) === VALUES.plain).toBe(true);
    await store.put("t/shrink", VALUES.pem!);
    await store.remove("t/shrink");
    expect(await store.has("t/shrink")).toBe(false);
    expect(await store.has("t/shrink#1")).toBe(false);
  });

  it("puts nothing on a command line", () => {
    // What `security` was run with is in the source; the value goes on stdin.
    const source = readFileSync(join(import.meta.dir, "..", "src", "keychain.ts"), "utf8");
    expect(source).not.toMatch(/"-w",\s*value|"-X",\s*/);
  });
});

describe("the file store", () => {
  it("keeps a value 0600 under a 0700 folder", async () => {
    const root = mkdtempSync(join(tmpdir(), "kururu-filestore-"));
    try {
      const store = fileStore(join(root, "vault"));
      await store.put("deck/sudo", VALUES.accent!);
      expect((await store.get("deck/sudo")) === VALUES.accent).toBe(true);
      expect(statSync(join(root, "vault", "deck", "sudo")).mode & 0o777).toBe(0o600);
      expect(statSync(join(root, "vault")).mode & 0o777).toBe(0o700);
      await store.remove("deck/sudo");
      expect(await store.get("deck/sudo")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
