/**
 * Where kururu's own callers on this machine find the token they present: the
 * server's `access.json` first, since a rotated token leaves a pty's
 * `KURURU_TOKEN` stale, then the environment. The file is one this test
 * writes, under a config directory of its own.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localToken, tokenHeaders } from "../localtoken.mjs";

const config = mkdtempSync(join(tmpdir(), "kururu-localtoken-"));
mkdirSync(join(config, "kururu"));
writeFileSync(join(config, "kururu", "access.json"), JSON.stringify({ share: false, token: "from-the-file-0123456789" }));
const empty = mkdtempSync(join(tmpdir(), "kururu-localtoken-none-"));

describe("localToken", () => {
  it("reads the server's file, which is the current one, over a pty's that may be stale", () => {
    expect(localToken({ KURURU_TOKEN: "rotated-away", XDG_CONFIG_HOME: config })).toBe("from-the-file-0123456789");
  });

  it("finds the file by KURURU_CONFIG_DIR, which is the directory itself", () => {
    expect(localToken({ KURURU_CONFIG_DIR: join(config, "kururu") })).toBe("from-the-file-0123456789");
  });

  it("takes the one the server handed the pty when there is no file to read", () => {
    expect(localToken({ KURURU_TOKEN: "from-the-env", XDG_CONFIG_HOME: empty })).toBe("from-the-env");
  });

  it("is null with neither, which is a server that never started here", () => {
    expect(localToken({ XDG_CONFIG_HOME: empty })).toBeNull();
  });
});

describe("tokenHeaders", () => {
  it("is a bearer header, or nothing at all", () => {
    expect(tokenHeaders({ KURURU_TOKEN: "t", XDG_CONFIG_HOME: empty })).toEqual({ authorization: "Bearer t" });
    expect(tokenHeaders({ XDG_CONFIG_HOME: empty })).toEqual({});
  });
});
