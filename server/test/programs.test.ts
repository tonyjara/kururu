/**
 * A pty host started before `agy` was one of its names reads an Antigravity
 * pane as a shell, and a shell is not in the sidebar. The server fills the name
 * in from its own reading of the process table; what is worth pinning is that
 * it fills only the blanks, never overrules the host, lets go of a program that
 * has exited, and hands back the same list when there is nothing to do.
 */
import { describe, expect, it } from "bun:test";
import type { AgentSnapshot } from "../../shared/model";
import { fillPrograms, ProgramCover, programsUnder } from "../src/programs";
import { parseProcRows } from "../src/proctable";

function snap(id: string, pid: number, agent: string | null, extra: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    id,
    kind: "agent",
    title: null,
    status: "working",
    agent,
    unread: false,
    cwd: "/tmp",
    pid,
    command: "agy",
    createdAt: 0,
    contextUsage: null,
    titleOverride: null,
    exited: false,
    exitCode: null,
    ...extra,
  } as AgentSnapshot;
}

/** `ps -eo pid=,ppid=,rss=,args=`: two login shells, agy under one, claude under the other, a plain shell. */
const PS = `
  100     1  2048 /bin/zsh -l -c agy --model claude-opus-5-5-high --prompt-interactive hello
  101   100 90000 /Users/me/.local/bin/agy --model claude-opus-5-5-high --prompt-interactive hello
  200     1  2048 /bin/zsh -l -c claude
  201   200 90000 claude --dangerously-skip-permissions
  300     1  2048 /bin/zsh -l
`;

describe("programsUnder", () => {
  const rows = parseProcRows(PS);

  it("names agy under a pane the host left blank", () => {
    const found = programsUnder([snap("a1", 100, null), snap("a3", 300, null)], rows);
    expect([...found]).toEqual([["a1", "agy"]]);
  });

  it("does not read the panes the host already named, or exited ones", () => {
    const found = programsUnder([snap("a1", 100, null, { exited: true }), snap("a2", 200, "claude")], rows);
    expect(found.size).toBe(0);
  });

  it("finds nothing with the host's old list of names", () => {
    const old = ["claude", "codex", "gemini", "opencode"];
    expect(programsUnder([snap("a1", 100, null)], rows, old).size).toBe(0);
  });
});

describe("fillPrograms", () => {
  it("fills a blank, and leaves the host's own answer alone", () => {
    const agents = [snap("a1", 100, null), snap("a2", 200, "claude")];
    const out = fillPrograms(agents, new Map([["a1", "agy"], ["a2", "agy"]]));
    expect(out.map((agent) => agent.agent)).toEqual(["agy", "claude"]);
    expect(out[1]).toBe(agents[1]!);
    expect(agents[0]!.agent).toBeNull(); // a copy, never edited in place
  });

  it("hands back the same array when there is nothing to fill", () => {
    const agents = [snap("a2", 200, "claude")];
    expect(fillPrograms(agents, new Map())).toBe(agents);
    expect(fillPrograms(agents, new Map([["a2", "agy"]]))).toBe(agents);
  });
});

describe("ProgramCover", () => {
  it("fills across host pushes and lets go when the program is gone", () => {
    const cover = new ProgramCover();
    const pushed = [snap("a1", 100, null)];
    let shown = cover.apply(pushed);
    expect(shown).toBe(pushed);

    expect(cover.update(new Map([["a1", "agy"]]))).toBe(true);
    shown = cover.apply(shown);
    expect(shown[0]!.agent).toBe("agy");
    expect(cover.hostList()).toBe(pushed);
    // The same reading again is no change, and no broadcast.
    expect(cover.update(new Map([["a1", "agy"]]))).toBe(false);

    // The host pushes a fresh list: it is filled too.
    const next = [snap("a1", 100, null, { status: "done" })];
    shown = cover.apply(next);
    expect(shown[0]).toMatchObject({ agent: "agy", status: "done" });

    // agy exited: the next reading finds nothing, and the fill comes off.
    expect(cover.update(new Map())).toBe(true);
    shown = cover.apply(shown);
    expect(shown).toBe(next);
    expect(shown[0]!.agent).toBeNull();
  });
});
