/**
 * Kuru's folder and Kuru's line, against real files in a temporary directory:
 * the compaction section added to a folder made before it, and the flags that
 * keep Kuru to kururu's servers and the user's own, written where no command
 * line shows them.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HARNESS_COMPACT_HEADING } from "../../shared/harness";
import { kuruLaunchFlags, prepareHarnessHome } from "../src/harnesshome";

const root = mkdtempSync(join(tmpdir(), "kururu-harnesshome-"));
const state = join(root, "state");
// Set for the length of this file only: test files share one process.
let before: string | undefined;
beforeAll(() => {
  before = process.env.KURURU_STATE_DIR;
  process.env.KURURU_STATE_DIR = state;
});
afterAll(() => {
  if (before === undefined) delete process.env.KURURU_STATE_DIR;
  else process.env.KURURU_STATE_DIR = before;
  rmSync(root, { recursive: true, force: true });
});

describe("Kuru's folder", () => {
  it("gets the compaction section once, in a folder made before it, and keeps the user's words", async () => {
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "AGENTS.md"), "# Kuru's folder\n\n- Mine, edited.\n");
    await prepareHarnessHome(home, join(root, "claude"), null);
    const once = readFileSync(join(home, "AGENTS.md"), "utf8");
    expect(once).toStartWith("# Kuru's folder\n\n- Mine, edited.\n\n");
    expect(once).toContain(HARNESS_COMPACT_HEADING);
    await prepareHarnessHome(home, join(root, "claude"), null);
    expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe(once);
  });
});

describe("Kuru's line", () => {
  it("is strict, with the plugins and synced skills off in one settings file and the user's servers in another, both private", async () => {
    const claude = join(root, "login");
    mkdirSync(join(claude, "skills", "synced", "acct", "docs"), { recursive: true });
    writeFileSync(join(claude, "skills", "synced", "acct", "manifest.json"), "{}");
    writeFileSync(join(claude, "settings.json"), JSON.stringify({ enabledPlugins: { "big@market": true } }));
    writeFileSync(join(claude, ".claude.json"), JSON.stringify({ mcpServers: { mine: { type: "stdio", command: "node", env: { KEY: "s3cret" } } } }));
    const flags = await kuruLaunchFlags(claude, "pk1", { hooks: { Stop: [] } }, ["kururu", "kururu_web"]);
    const settingsFile = join(state, "kuru", "pk1-settings.json");
    const serversFile = join(state, "kuru", "pk1-mcp.json");
    expect(flags).toBe(` --strict-mcp-config --settings '${settingsFile}' --mcp-config '${serversFile}'`);
    expect(flags).not.toContain("s3cret");
    expect(JSON.parse(readFileSync(settingsFile, "utf8"))).toEqual({
      hooks: { Stop: [] },
      enabledPlugins: { "big@market": false },
      skillOverrides: { "anthropic-skills:docs": "off", docs: "off" },
    });
    expect(JSON.parse(readFileSync(serversFile, "utf8")).mcpServers.mine.command).toBe("node");
    expect(statSync(serversFile).mode & 0o777).toBe(0o600);
    expect(statSync(settingsFile).mode & 0o777).toBe(0o600);

    // The server gone from the login: its file goes too, and the line says nothing of it.
    writeFileSync(join(claude, ".claude.json"), JSON.stringify({ mcpServers: {} }));
    const again = await kuruLaunchFlags(claude, "pk1", null, ["kururu", "kururu_web"]);
    expect(again).toBe(` --strict-mcp-config --settings '${settingsFile}'`);
    expect(existsSync(serversFile)).toBe(false);
  });
});
