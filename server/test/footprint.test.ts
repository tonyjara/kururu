import { describe, expect, it } from "bun:test";
import { appName, childIndex, classify, findNvims, hostPidOf, parseFootTable, readTree } from "../src/footprint";
import { agentKinds, tally, type FootprintTerminal } from "../../shared/footprint";

/** `ps -eo pid=,ppid=,rss=,lstart=,args=` as macOS prints it under LC_ALL=C. */
const ps = (rows: Array<[number, number, number, string]>) =>
  rows.map(([pid, ppid, rss, args]) => `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${String(rss).padStart(6)} Fri Oct  9 15:11:56 2026     ${args}`).join("\n");

const PS = ps([
  [100, 1, 50000, "/Applications/kururu.app/Contents/MacOS/kururu ptyhostd.mjs"],
  [200, 100, 2000, "-zsh"],
  [201, 200, 300000, 'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js --settings {"x":"claude"}'],
  [202, 201, 10000, "node /Users/me/.claude/hooks/claude-hook.js"],
  [300, 100, 2000, "-zsh"],
  [301, 300, 40000, "nvim README.md"],
  [302, 301, 60000, "nvim --embed README.md"],
  [400, 100, 2000, "-zsh"],
  [401, 400, 30000, "bun run dev"],
  [402, 401, 90000, "bun --hot vite"],
  [500, 100, 2000, "-zsh"],
]);

const table = parseFootTable(PS);
const kids = childIndex(table);

describe("parseFootTable", () => {
  it("reads kilobytes as bytes and keeps argv", () => {
    expect(table.get(201)?.rss).toBe(300000 * 1024);
    expect(table.get(301)?.args).toBe("nvim README.md");
  });
  it("keeps when each process started, so a recycled pid is a different process", () => {
    expect(table.get(301)?.start).toBe("Fri Oct 9 15:11:56 2026");
    const later = parseFootTable("  301   300  40000 Sat Oct 10 09:00:01 2026     nvim README.md");
    expect(later.get(301)?.start).not.toBe(table.get(301)?.start);
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

describe("findNvims", () => {
  const MACHINE = ps([
    // kururu: a pty host and three of its terminals.
    [100, 1, 50000, "/Applications/kururu.app/Contents/MacOS/kururu ptyhostd.mjs"],
    [300, 100, 2000, "-zsh"],
    [301, 300, 40000, "nvim README.md"],
    [302, 301, 60000, "nvim --embed README.md"],
    [303, 302, 90000, "node /x/tailwindcss-language-server --stdio"],
    [304, 302, 30000, "nvim --headless -c Lazy! sync"],
    [600, 100, 2000, "/bin/zsh -l -c claude"],
    [601, 600, 300000, "node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js"],
    [602, 601, 30000, "nvim /tmp/claude-prompt.md"],
    // kururu's server asking an editor something.
    [700, 1, 80000, "node /Applications/kururu.app/Contents/Resources/server.mjs"],
    [701, 700, 9000, "nvim --server /tmp/nvim.me/x/nvim.302.0 --remote-expr 1"],
    // Ghostty, and VS Code's extension drawing an embedded editor.
    [800, 1, 120000, "/Applications/Ghostty.app/Contents/MacOS/ghostty"],
    [801, 800, 3000, "/usr/bin/login -flp me /bin/zsh"],
    [802, 801, 2000, "-zsh"],
    [803, 802, 35000, "/opt/homebrew/bin/nvim notes.md"],
    [900, 1, 150000, "/Applications/Visual Studio Code.app/Contents/MacOS/Electron"],
    [901, 900, 90000, "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)"],
    [902, 901, 50000, "nvim --embed"],
    // One whose terminal went away.
    [950, 1, 20000, "nvim todo.txt"],
  ]);
  const machine = parseFootTable(MACHINE);
  const found = findNvims(machine, childIndex(machine), new Set([300, 600]));
  const byPid = new Map(found.map((nvim) => [nvim.pid, nvim]));

  it("finds each editor once, at the top of its chain, and not kururu's own client", () => {
    expect(found.map((nvim) => nvim.pid).sort((a, b) => a - b)).toEqual([301, 602, 803, 902, 950]);
  });

  it("adds up the whole tree — the embedded core, its language servers, a plugin's headless nvim", () => {
    const tab = byPid.get(301)!;
    expect(tab.pids.sort()).toEqual([301, 302, 303, 304]);
    expect(tab.rss).toBe((40000 + 60000 + 90000 + 30000) * 1024);
  });

  it("knows a kururu terminal, and an agent's editor inside one", () => {
    expect(byPid.get(301)).toMatchObject({ ptyRoot: 300, underAgent: false, app: null });
    expect(byPid.get(602)).toMatchObject({ ptyRoot: 600, underAgent: true });
  });

  it("names the app an editor outside kururu runs under, and none for an orphan", () => {
    expect(byPid.get(803)).toMatchObject({ ptyRoot: null, app: "Ghostty" });
    expect(byPid.get(902)?.app).toBe("Visual Studio Code");
    expect(byPid.get(950)?.app).toBeNull();
  });

  it("puts the heaviest first", () => {
    expect(found[0]?.pid).toBe(301);
  });
});

describe("appName", () => {
  it("is the outermost app bundle, else the program", () => {
    expect(appName("/Applications/iTerm.app/Contents/MacOS/iTerm2")).toBe("iTerm");
    expect(appName("tmux new -s work")).toBe("tmux");
    expect(appName("sshd: me@ttys003")).toBe("sshd");
    expect(appName("node /x/desktop/dist/ptyhostd.mjs")).toBe("another kururu");
  });
});
