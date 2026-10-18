/**
 * Where kururu's own callers on this machine find the token they present: the
 * pty's `KURURU_TOKEN` first, then the server's `access.json`. The file is one
 * this test writes, under a config directory of its own.
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
  it("takes the one the server handed the pty", () => {
    expect(localToken({ KURURU_TOKEN: "from-the-env", XDG_CONFIG_HOME: config })).toBe("from-the-env");
  });

  it("reads the server's file otherwise", () => {
    expect(localToken({ XDG_CONFIG_HOME: config })).toBe("from-the-file-0123456789");
  });

  it("is null with neither, which is a server that never started here", () => {
    expect(localToken({ XDG_CONFIG_HOME: empty })).toBeNull();
  });
});

describe("tokenHeaders", () => {
  it("is a bearer header, or nothing at all", () => {
    expect(tokenHeaders({ KURURU_TOKEN: "t" })).toEqual({ authorization: "Bearer t" });
    expect(tokenHeaders({ XDG_CONFIG_HOME: empty })).toEqual({});
  });
});
