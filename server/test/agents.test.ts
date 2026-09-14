/**
 * Agent detection and report parsing — the two pure halves of the agent host.
 *
 * Neither one touches a pty. `matchAgentCommand` is string work over a `ps`
 * line, and `parseReport` is validation of an untrusted body, so both are worth
 * pinning down here rather than discovering through a wrong tab label.
 */
import { describe, expect, it } from "bun:test";
import {
  DEFAULT_AGENT_COMMANDS as NAMES,
  childIndex,
  findAgentUnder,
  matchAgentCommand,
  parseProcTable,
} from "../src/agents/procs";
import { parseReport } from "../src/agents/report";

describe("matchAgentCommand", () => {
  it("matches an agent invoked by name", () => {
    expect(matchAgentCommand("claude", NAMES)).toBe("claude");
    expect(matchAgentCommand("/opt/homebrew/bin/claude --resume", NAMES)).toBe("claude");
  });

  it("looks past an interpreter to the script it was handed", () => {
    expect(
      matchAgentCommand("node /Users/x/.nvm/versions/node/v22/lib/node_modules/@anthropic-ai/claude-code/cli.js", NAMES),
    ).toBe("claude");
  });

  it("does not let a path argument name the agent", () => {
    // The single most important negative: editing a file about an agent is not
    // running one.
    expect(matchAgentCommand("vim /Users/x/claude/notes.md", NAMES)).toBeNull();
    expect(matchAgentCommand("less ~/codex.log", NAMES)).toBeNull();
  });

  it("is not fooled by a flag value", () => {
    expect(matchAgentCommand("some-tool --config claude", NAMES)).toBeNull();
  });

  it("says nothing about a plain shell", () => {
    expect(matchAgentCommand("-zsh", NAMES)).toBeNull();
    expect(matchAgentCommand("/bin/zsh -l", NAMES)).toBeNull();
  });
});

describe("findAgentUnder", () => {
  const table = parseProcTable(
    [
      "  100   1 Ss   /bin/zsh -l",
      "  101 100 S+   node /x/@anthropic-ai/claude-code/cli.js",
      "  102 101 S    /bin/sh -c claude-hook stop",
      "  200   1 Ss   /bin/zsh -l",
    ].join("\n"),
  );

  it("finds the agent running under a shell", () => {
    const found = findAgentUnder(100, table, childIndex(table), NAMES);
    expect(found?.kind).toBe("claude");
    expect(found?.pid).toBe(101);
  });

  it("prefers the agent over its own hook subprocess", () => {
    // Both match; the shallower one is the process being talked to, and the
    // deeper one is something it spawned.
    const found = findAgentUnder(100, table, childIndex(table), NAMES);
    expect(found?.depth).toBe(1);
  });

  it("reports nothing for a shell with no agent in it", () => {
    expect(findAgentUnder(200, table, childIndex(table), NAMES)).toBeNull();
  });
});

describe("parseReport", () => {
  it("takes a status", () => {
    expect(parseReport({ status: "blocked" })?.report.status).toBe("blocked");
  });

  it("takes context usage", () => {
    expect(parseReport({ context: { used: 40, window: 200 } })?.report.context).toEqual({
      used: 40,
      window: 200,
    });
  });

  it("refuses a status that is not one of the four", () => {
    expect(parseReport({ status: "thinking" })).toBeNull();
  });

  it("drops a context window of zero rather than dividing by it", () => {
    // The ring divides by `window`; a zero would render NaN into an SVG
    // attribute, which fails silently and looks like a styling bug.
    const parsed = parseReport({ status: "idle", context: { used: 1, window: 0 } });
    expect(parsed?.report.context).toBeUndefined();
  });

  it("refuses a body with nothing usable in it", () => {
    expect(parseReport({})).toBeNull();
    expect(parseReport({ message: "hello" })).toBeNull();
    expect(parseReport(null)).toBeNull();
    expect(parseReport("blocked")).toBeNull();
  });

  it("picks up the agent id under either spelling", () => {
    expect(parseReport({ status: "done", agent: "a3" })?.agentId).toBe("a3");
    expect(parseReport({ status: "done", agentId: "a4" })?.agentId).toBe("a4");
    expect(parseReport({ status: "done" })?.agentId).toBeNull();
  });
});
