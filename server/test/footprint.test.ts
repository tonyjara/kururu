import { describe, expect, it } from "bun:test";
import { childIndex, classify, hostPidOf, parseFootTable, readTree } from "../src/footprint";
import { agentKinds, tally, type FootprintTerminal } from "../../shared/footprint";

const PS = [
  "  100     1  50000 /Applications/kururu.app/Contents/MacOS/kururu ptyhostd.mjs",
  "  200   100   2000 -zsh",
  "  201   200 300000 node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js --settings {\"x\":\"claude\"}",
  "  202   201  10000 node /Users/me/.claude/hooks/claude-hook.js",
  "  300   100   2000 -zsh",
  "  301   300  40000 nvim README.md",
  "  302   301  60000 nvim --embed README.md",
  "  400   100   2000 -zsh",
  "  401   400  30000 bun run dev",
  "  402   401  90000 bun --hot vite",
  "  500   100   2000 -zsh",
].join("\n");

const table = parseFootTable(PS);
const kids = childIndex(table);

describe("parseFootTable", () => {
  it("reads kilobytes as bytes and keeps argv", () => {
    expect(table.get(201)?.rss).toBe(300000 * 1024);
    expect(table.get(301)?.args).toBe("nvim README.md");
  });
});

describe("classify", () => {
  it("knows an agent behind an interpreter, an editor, and a dev server", () => {
    expect(classify("node /x/claude-code/cli.js")).toEqual({ kind: "agent", name: "claude" });
    expect(classify("/opt/homebrew/bin/nvim foo")).toEqual({ kind: "editor" });
    expect(classify("bun run dev")?.kind).toBe("dev");
    expect(classify("-zsh")).toBeNull();
  });
});

describe("readTree", () => {
  it("adds up everything and counts an agent once, not its hooks", () => {
    const tree = readTree(200, table, kids)!;
    expect(tree.processes).toBe(3);
    expect(tree.rss).toBe((2000 + 300000 + 10000) * 1024);
    expect(tree.agents).toEqual(["claude"]);
  });

  it("counts nvim once though it forks an embedded nvim", () => {
    expect(readTree(300, table, kids)!.editors).toBe(1);
  });

  it("counts a dev server once though the script runs a second bun", () => {
    expect(readTree(400, table, kids)!.devServers).toHaveLength(1);
  });

  it("says nothing about a pty whose process is gone", () => {
    expect(readTree(999, table, kids)).toBeNull();
  });
});

describe("hostPidOf", () => {
  it("is the parent the ptys share, when its argv names the host", () => {
    expect(hostPidOf([200, 300, 400], table)).toBe(100);
  });
  it("is nobody when that parent is not kururu", () => {
    const orphaned = parseFootTable("  1 0 100 /sbin/launchd\n  9 1 100 -zsh");
    expect(hostPidOf([9], orphaned)).toBeNull();
  });
});

describe("tally", () => {
  const t = (over: Partial<FootprintTerminal>): FootprintTerminal => ({
    agentId: "a", label: "", summary: null, kind: "shell", status: "idle", exited: false, cwd: "/",
    rss: 0, processes: 1, agents: [], editors: 0, devServers: [], ...over,
  });
  it("calls a live terminal with nothing in it a shell, and an exited one nothing", () => {
    const sum = tally([t({ rss: 10 }), t({ agents: ["claude"], rss: 5 }), t({ exited: true, rss: null })]);
    expect(sum).toEqual({ rss: 15, terminals: 3, agents: 1, editors: 0, devServers: 0, shells: 1 });
  });
  it("groups agents by program, most first", () => {
    expect(agentKinds([t({ agents: ["codex"] }), t({ agents: ["claude"] }), t({ agents: ["claude"] })])).toEqual([
      ["claude", 2],
      ["codex", 1],
    ]);
  });
});
