/**
 * The usage ledger's two roads to another computer: a machine's logs read through
 * ssh, and what a node says it spent, kept on its parent.
 *
 * The scripts run here for real, under `sh` and under `dash` when there is one, in
 * a temp home standing in for the far side, because what can go wrong with them is
 * a shell's and a `grep`'s to get wrong. Hand-written records with the real field
 * names and made-up numbers; the word `LEDGERSECRET` is on everything no table may
 * keep.
 */
import { execFile, execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fitsRemoteDir, parseUsageChunk, parseUsageListing, usageListScript, usageReadScript, USAGE_PATTERNS, validUsageRel, type UsageLog } from "../../shared/machines";
import { qualify } from "../../shared/remote";
import { dayOf, matchRollouts, noFacts, type WaitingLaunch } from "../../shared/usage";
import { adoptKnownDays, adoptUsagePart, daysToSend } from "../../shared/usagepull";
import { entityOf, placeOf, sessionRows, type SessionFact, type UsageNames } from "../../shared/usagereport";
import { Launches } from "../src/usage/attribute";
import { CLAUDE_NEEDLES } from "../src/usage/claude";
import { CODEX_NEEDLES } from "../src/usage/codex";
import { exportUsage, NodeUsage, type PulledNode } from "../src/usage/remote";
import { Ledger } from "../src/usage/store";
import { sessionOfMachineFile, UsageReader, type MachineReads, type MachineSource } from "../src/usage/sweep";

const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ROLLOUT_ID = "33333333-3333-4333-8333-333333333333";
const SECRET = "LEDGERSECRET";
const AT = Date.parse("2026-10-30T15:07:00.000Z");
const SHELLS = ["/bin/sh", ...(existsSync("/bin/dash") ? ["/bin/dash"] : [])];

let dir: string;
let home: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kururu-remote-"));
  home = join(dir, "far");
  mkdirSync(home);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function assistant(session: string, id: string, at = AT, input = 10): string {
  return `${JSON.stringify({
    type: "assistant",
    sessionId: session,
    cwd: "/home/far/api",
    timestamp: new Date(at).toISOString(),
    message: { id, model: "claude-opus-5-5", content: [{ type: "text", text: SECRET }], usage: { input_tokens: input, output_tokens: 5, cache_read_input_tokens: 100 } },
  })}\n`;
}

/** A line of tool output, the kind that must not cross. */
function noise(): string {
  return `${JSON.stringify({ type: "user", message: { content: SECRET.repeat(50) } })}\n`;
}

function claudeFile(rel: string, content: string): string {
  const path = join(home, ".claude", "projects", rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function run(script: string, shell = "/bin/sh"): string {
  return execFileSync(shell, ["-c", script], { env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8", maxBuffer: 80 * 1024 * 1024 });
}

/** The far side, reached by running each script where ssh would, without the ssh. Async so that a read leaves the loop, as the real one does. */
function reads(shell = "/bin/sh", calls: string[] = []): MachineReads {
  const sh = (script: string | null): Promise<{ ok: true; text: string } | { ok: false; error: string }> =>
    new Promise((resolve) => {
      execFile(shell, ["-c", script ?? "exit 1"], { env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8", maxBuffer: 80 * 1024 * 1024 }, (err, stdout) => resolve(err ? { ok: false, error: String(err) } : { ok: true, text: stdout }));
    });
  return {
    list: () => sh(usageListScript()),
    chunk: (_host, log, rel, offset, length) => {
      calls.push(`${rel}@${offset}`);
      return sh(usageReadScript(log, rel, offset, length));
    },
  };
}

const MACHINE: MachineSource = { id: "ab12cd34", name: "box", host: "box" };

function reader(ledger: Ledger, machineReads: MachineReads = reads()): UsageReader {
  return new UsageReader({
    ledger,
    facts: noFacts,
    roots: async () => [],
    codexRoots: async () => [],
    opencodeHome: () => join(dir, "no-opencode"),
    machines: () => [MACHINE],
    machineReads,
    tail: { pause: async () => {} },
  });
}

async function sweep(each: UsageReader): Promise<void> {
  each.sweepSoon();
  await each.settled();
}

function open(name = "usage.db"): Ledger {
  return Ledger.open(join(dir, name));
}

describe("the two scripts", () => {
  it("hold nothing a remote script may not", () => {
    for (const log of ["claude", "codex"] as const) {
      for (const script of [usageListScript(), usageReadScript(log, "a/b.jsonl", 3, 10)!]) expect(script).not.toMatch(/['\\]/);
    }
  });

  it("match every line the parsers want, which is why the patterns may stay plain", () => {
    const cases: [UsageLog, readonly string[]][] = [
      ["claude", CLAUDE_NEEDLES],
      ["codex", CODEX_NEEDLES],
    ];
    for (const [log, needles] of cases) for (const needle of needles) expect(new RegExp(USAGE_PATTERNS[log]).test(needle)).toBe(true);
  });

  it("refuse a path a shell would give a meaning to, and take a real one", () => {
    expect(validUsageRel(`-home-far-api/${SESSION}.jsonl`)).toBe(true);
    expect(validUsageRel(`-home-far-api/${SESSION}/subagents/agent-a1.jsonl`)).toBe(true);
    expect(validUsageRel(`2026/10/30/rollout-2026-10-30T10-00-00-${ROLLOUT_ID}.jsonl`)).toBe(true);
    for (const bad of ["../x.jsonl", "a/../x.jsonl", "./x.jsonl", ".hidden/x.jsonl", "a b.jsonl", "a;b.jsonl", "$(x).jsonl", "a`b.jsonl", "a'b.jsonl", "/etc/x.jsonl", "x.txt", 1, null]) {
      expect(validUsageRel(bad)).toBe(false);
    }
    expect(usageReadScript("claude", "a;rm.jsonl", 0, 10)).toBeNull();
    expect(usageReadScript("claude", "a.jsonl", -1, 10)).toBeNull();
    expect(usageReadScript("claude", "a.jsonl", Number.NaN, 10)).toBeNull();
    expect(usageReadScript("claude", "a.jsonl", 0, 0)).toBeNull();
  });

  it("list what is there under each program, and pass over what is not a log", () => {
    claudeFile(`-home-far-api/${SESSION}.jsonl`, "12345\n");
    claudeFile("-home-far-api/notes.txt", "no");
    const codex = join(home, ".codex", "sessions", "2026", "10", "30");
    mkdirSync(codex, { recursive: true });
    writeFileSync(join(codex, `rollout-2026-10-30T10-00-00-${ROLLOUT_ID}.jsonl`), "abc\n");
    for (const shell of SHELLS) {
      const listed = parseUsageListing(run(usageListScript(), shell))!;
      expect(listed.map((file) => [file.log, file.size])).toEqual([
        ["claude", 6],
        ["codex", 4],
      ]);
    }
  });

  it("list nothing on a machine with neither, and that is not a failure", () => {
    expect(parseUsageListing(run(usageListScript()))).toEqual([]);
  });

  it("do not take a stranger's answer for a listing, or a name it made up", () => {
    expect(parseUsageListing("Welcome to the box\n")).toBeNull();
    const listed = parseUsageListing(run(usageListScript()) + "   12 ./a;rm -rf.jsonl\n   12 ./a;b.jsonl\n   12 total\n   9e9 ./a.jsonl\n");
    expect(listed).toEqual([]);
  });

  it("read only whole lines, and only the ones wanted, with each one's place in the file", () => {
    const first = assistant(SESSION, "m1");
    const second = assistant(SESSION, "m2");
    claudeFile(`p/${SESSION}.jsonl`, first + noise() + second + '{"type":"assistant","half');
    for (const shell of SHELLS) {
      const chunk = parseUsageChunk(run(usageReadScript("claude", `p/${SESSION}.jsonl`, 0, 1_000_000)!, shell));
      if (chunk === null || chunk === "gone") throw new Error("no chunk");
      const whole = first.length + noise().length + second.length;
      expect(chunk.whole).toBe(whole);
      expect(chunk.lines.map((line) => line.at)).toEqual([0, first.length + noise().length]);
      expect(chunk.lines.some((line) => line.text.includes(SECRET.repeat(2)))).toBe(false);
    }
  });

  it("say from an offset where each line is in the read, which a Codex row's id depends on", () => {
    const first = assistant(SESSION, "m1");
    const second = assistant(SESSION, "m2");
    claudeFile(`p/${SESSION}.jsonl`, first + second);
    const chunk = parseUsageChunk(run(usageReadScript("claude", `p/${SESSION}.jsonl`, first.length, 1_000_000)!));
    if (chunk === null || chunk === "gone") throw new Error("no chunk");
    expect(chunk.lines).toHaveLength(1);
    expect(chunk.lines[0]!.at).toBe(0);
    expect(chunk.whole).toBe(second.length);
  });

  it("stop at the last whole line when a read ends inside one", () => {
    const first = assistant(SESSION, "m1");
    const second = assistant(SESSION, "m2");
    claudeFile(`p/${SESSION}.jsonl`, first + second);
    const chunk = parseUsageChunk(run(usageReadScript("claude", `p/${SESSION}.jsonl`, 0, first.length + 5)!));
    if (chunk === null || chunk === "gone") throw new Error("no chunk");
    expect(chunk.whole).toBe(first.length);
    expect(chunk.lines).toHaveLength(1);
  });

  it("say a file is gone, and do not read an answer that is neither", () => {
    expect(parseUsageChunk(run(usageReadScript("claude", `p/${SESSION}.jsonl`, 0, 100)!))).toBe("gone");
    expect(parseUsageChunk("a banner\n")).toBeNull();
    expect(parseUsageChunk("<<<kururu-usage-read 10 5 9\n")).toBeNull();
  });

  it("say so when the far side's grep cannot look, rather than having found nothing", () => {
    claudeFile(`p/${SESSION}.jsonl`, assistant(SESSION, "m1"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "grep"), "#!/bin/sh\nexit 2\n", { mode: 0o755 });
    const text = execFileSync("/bin/sh", ["-c", usageReadScript("claude", `p/${SESSION}.jsonl`, 0, 1_000_000)!], { env: { PATH: `${bin}:${process.env.PATH}`, HOME: home }, encoding: "utf8" });
    expect(parseUsageChunk(text)).toBeNull();
  });

  it("find a session off a log's path", () => {
    expect(sessionOfMachineFile({ log: "claude", rel: `p/${SESSION}.jsonl` })).toBe(SESSION);
    expect(sessionOfMachineFile({ log: "claude", rel: `p/${SESSION}/subagents/agent-a1.jsonl` })).toBe(SESSION);
    expect(sessionOfMachineFile({ log: "codex", rel: `2026/10/30/rollout-2026-10-30T10-00-00-${ROLLOUT_ID}.jsonl` })).toBe(ROLLOUT_ID);
    expect(sessionOfMachineFile({ log: "codex", rel: "2026/10/30/other.jsonl" })).toBeNull();
    expect(sessionOfMachineFile({ log: "claude", rel: "loose.jsonl" })).toBeNull();
  });
});

describe("reading a machine", () => {
  it("reads a log once, picks it up from where it stopped, and marks the machine", async () => {
    const ledger = open();
    const calls: string[] = [];
    const each = reader(ledger, reads("/bin/sh", calls));
    const path = claudeFile(`-home-far-api/${SESSION}.jsonl`, assistant(SESSION, "m1") + noise());
    await sweep(each);
    const firstOffset = readFileSync(path).length;
    appendFileSync(path, assistant(SESSION, "m2", AT + 1000));
    await sweep(each);
    await sweep(each);
    expect(calls).toEqual([`-home-far-api/${SESSION}.jsonl@0`, `-home-far-api/${SESSION}.jsonl@${firstOffset}`]);
    const facts = ledger.usageFacts();
    expect(facts.get(SESSION)?.machine).toBe("box");
    expect(facts.get(SESSION)?.node).toBeUndefined();
    expect(ledger.usageContext(SESSION)).toEqual([110, 110]);
    each.stop();
    ledger.close();
  });

  it("gives the same rows as one read, however it was cut, and a half-written line waits", async () => {
    const ledger = open();
    const each = reader(ledger);
    const line = assistant(SESSION, "m2", AT + 1000);
    const path = claudeFile(`p/${SESSION}.jsonl`, assistant(SESSION, "m1") + line.slice(0, 20));
    await sweep(each);
    expect(ledger.usageContext(SESSION)).toHaveLength(1);
    appendFileSync(path, line.slice(20));
    await sweep(each);
    expect(ledger.usageContext(SESSION)).toHaveLength(2);
    each.stop();
    ledger.close();
  });

  it("ends with the same rows whether it read in one go or died part way, however small the reads", async () => {
    // Cut the way a restart cuts a long read: this is the comparison that found phase 1's size bug.
    let lines = "";
    for (let i = 0; i < 60; i++) lines += assistant(SESSION, `m${i}`, AT + i * 60_000, i + 1) + noise();
    claudeFile(`p/${SESSION}.jsonl`, lines);
    const rows = (ledger: Ledger) => ledger.usageCells(AT - 86_400_000, AT + 86_400_000).sort((a, b) => a.at - b.at).map((cell) => [cell.sessionId, cell.messages, cell.input, cell.read, cell.output]);
    const small = (ledger: Ledger, machineReads: MachineReads) => new UsageReader({ ledger, facts: noFacts, roots: async () => [], codexRoots: async () => [], opencodeHome: () => join(dir, "no-opencode"), machines: () => [MACHINE], machineReads, machineChunk: 4_000, tail: { pause: async () => {} } });

    const whole = open("whole.db");
    const one = small(whole, reads());
    await sweep(one);
    one.stop();

    const cut = open("cut.db");
    let calls = 0;
    const real = reads();
    const dying: MachineReads = { list: real.list, chunk: (...args) => (++calls === 4 ? Promise.resolve({ ok: false, error: "the link dropped" }) : real.chunk(...args)) };
    const first = small(cut, dying);
    await sweep(first);
    first.stop();
    const partway = cut.file(`machine/${MACHINE.id}/claude/p/${SESSION}.jsonl`)!;
    expect(partway.offset).toBeGreaterThan(0);
    expect(partway.size).toBe(partway.offset);
    const second = small(cut, reads());
    await sweep(second);
    second.stop();

    expect(rows(cut)).toEqual(rows(whole));
    expect(rows(whole).reduce((n, row) => n + (row[1] as number), 0)).toBe(60);
    expect(cut.file(`machine/${MACHINE.id}/claude/p/${SESSION}.jsonl`)!.offset).toBe(lines.length);
    whole.close();
    cut.close();
  });

  it("crosses a line longer than a read, and everything after it", async () => {
    const ledger = open();
    const each = new UsageReader({ ledger, facts: noFacts, roots: async () => [], codexRoots: async () => [], opencodeHome: () => join(dir, "no-opencode"), machines: () => [MACHINE], machineReads: reads(), machineChunk: 4_000, tail: { pause: async () => {} } });
    claudeFile(`p/${SESSION}.jsonl`, assistant(SESSION, "m1") + `${JSON.stringify({ type: "user", big: "x".repeat(50_000) })}\n` + assistant(SESSION, "m2", AT + 1000));
    await sweep(each);
    expect(ledger.usageContext(SESSION)).toHaveLength(2);
    each.stop();
    ledger.close();
  });

  it("reads a log again from the start when it came back shorter", async () => {
    const ledger = open();
    const calls: string[] = [];
    const each = reader(ledger, reads("/bin/sh", calls));
    const path = claudeFile(`p/${SESSION}.jsonl`, assistant(SESSION, "m1") + assistant(SESSION, "m2", AT + 1000));
    await sweep(each);
    truncateSync(path, assistant(SESSION, "m1").length);
    await sweep(each);
    expect(calls.at(-1)).toBe(`p/${SESSION}.jsonl@0`);
    each.stop();
    ledger.close();
  });

  it("keeps Codex's rows the same ids however often it is read, and its model across a cut", async () => {
    const ledger = open();
    const each = reader(ledger);
    const name = `rollout-2026-10-30T10-00-00-${ROLLOUT_ID}.jsonl`;
    const path = join(home, ".codex", "sessions", "2026", "10", "30", name);
    mkdirSync(dirname(path), { recursive: true });
    const turn = `${JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.5", cwd: "/home/far/api" } })}\n`;
    const count = (at: number) => `${JSON.stringify({ type: "event_msg", timestamp: new Date(at).toISOString(), payload: { type: "token_count", info: { last_token_usage: { input_tokens: 50, cached_input_tokens: 40, output_tokens: 5 } }, rate_limits: { secondary: { used_percent: 12, window_minutes: 10080 } } } })}\n`;
    writeFileSync(path, turn + count(AT));
    await sweep(each);
    appendFileSync(path, count(AT + 1000));
    await sweep(each);
    const cells = ledger.usageCells(AT - 60_000, AT + 60_000);
    expect(cells.map((cell) => cell.model)).toEqual(["gpt-5.5"]);
    expect(cells[0]!.messages).toBe(2);
    expect(ledger.usageFacts().get(ROLLOUT_ID)?.machine).toBe("box");
    // Another login's allowance, kept apart from this Mac's by the machine's name.
    expect(ledger.usageLimits(AT - 60_000, AT + 60_000).map((limit) => limit.scope)).toEqual(["box", "box"]);
    each.stop();
    ledger.close();
  });

  it("says why a machine could not be read, keeps its offsets, and costs the next machine nothing", async () => {
    const ledger = open();
    let up = true;
    const real = reads();
    const flaky: MachineReads = { list: async (host) => (up ? real.list(host) : { ok: false, error: "ssh: connect to host box port 22: Connection refused" }), chunk: real.chunk };
    const each = reader(ledger, flaky);
    const path = claudeFile(`p/${SESSION}.jsonl`, assistant(SESSION, "m1"));
    await sweep(each);
    const at = each.machineSources()[0]!.at;
    expect(at).not.toBeNull();
    up = false;
    await sweep(each);
    expect(each.machineSources()[0]).toEqual({ name: "box", kind: "machine", at, error: "ssh: connect to host box port 22: Connection refused" });
    // A failure is not every file having gone.
    expect(ledger.file(`machine/${MACHINE.id}/claude/p/${SESSION}.jsonl`)?.offset).toBe(readFileSync(path).length);
    up = true;
    await sweep(each);
    expect(each.machineSources()[0]!.error).toBeNull();
    each.stop();
    ledger.close();
  });

  it("does not take a stranger's answer for every file having gone", async () => {
    const ledger = open();
    const real = reads();
    let banner = false;
    const each = reader(ledger, { list: async (host) => (banner ? { ok: true, text: "Welcome\n" } : real.list(host)), chunk: real.chunk });
    claudeFile(`p/${SESSION}.jsonl`, assistant(SESSION, "m1"));
    await sweep(each);
    banner = true;
    await sweep(each);
    expect(ledger.file(`machine/${MACHINE.id}/claude/p/${SESSION}.jsonl`)).not.toBeNull();
    expect(each.machineSources()[0]!.error).toContain("list of logs");
    each.stop();
    ledger.close();
  });

  it("keeps no word of what crossed", async () => {
    const path = join(dir, "usage.db");
    const ledger = open();
    const each = reader(ledger);
    claudeFile(`p/${SESSION}.jsonl`, assistant(SESSION, "m1") + noise());
    await sweep(each);
    each.stop();
    ledger.close();
    for (const file of [path, `${path}-wal`]) if (existsSync(file)) expect(readFileSync(file).includes(SECRET)).toBe(false);
  });

  it("finds a Codex tab's rollout there, by a pin that only the far side can expand", async () => {
    const ledger = open();
    const launch = { agentId: "a1", sessionId: null, program: "codex" as const, profileKey: "pk1", workspaceKey: "wk1", cardId: null, kind: "agent" as const, node: "mac", machine: "box", loginDir: null, cwd: "~/api", at: AT };
    const book = new Launches({
      ledger,
      cardSessions: () => new Set(),
      log: () => {},
      // That machine's clock is thirty seconds behind this one's.
      rolloutsOn: async () => [{ id: ROLLOUT_ID, cwd: "/home/far/api", at: AT - 30_000 }],
    });
    book.spawned(launch);
    expect(await book.lookForWaiting(AT + 60_000)).toBe(1);
    expect(ledger.waiting()).toEqual([]);
    expect(ledger.usageFacts().get(ROLLOUT_ID)).toMatchObject({ workspaceKey: "wk1", machine: "box", attributedBy: "spawn" });
    ledger.close();
  });

  it("reads a pin's folder the way the far side would", () => {
    expect(fitsRemoteDir("~/api", "/home/far/api")).toBe(true);
    expect(fitsRemoteDir("~/api", "/home/far/other")).toBe(false);
    expect(fitsRemoteDir("/srv/api", "/srv/api")).toBe(true);
    expect(fitsRemoteDir("~", "/home/far")).toBe(true);
    expect(fitsRemoteDir("~", "/home/far/api")).toBe(false);
    const waiting: WaitingLaunch = { agentId: "a", sessionId: null, program: "codex", profileKey: null, workspaceKey: null, cardId: null, kind: "agent", node: null, machine: "box", loginDir: null, cwd: "/x", at: AT };
    const early = [{ id: "r", cwd: "/x", at: AT - 30_000 }];
    expect(matchRollouts([waiting], early, new Set())).toEqual([]);
    expect(matchRollouts([waiting], early, new Set(), 60_000)).toHaveLength(1);
  });
});

/** A child's ledger, a parent's, and one ask between them, through JSON as the link has it. */
function pair(prefix = "") {
  const child = open(`${prefix}child.db`);
  const parent = open(`${prefix}parent.db`);
  const names = { workspace: (key: string) => `name of ${key}`, card: (id: string) => `title of ${id}` };
  const ask = async (_id: string, known: Record<string, string>) => JSON.parse(JSON.stringify(exportUsage(child, known, names)));
  const nodes: PulledNode[] = [{ id: "n0123456789ab", name: "box", up: true, answers: true }];
  return { child, parent, usage: new NodeUsage({ ledger: parent, nodes: () => nodes, ask, log: () => {}, gapMs: 0 }), nodes };
}

const LAUNCH = { agentId: "a9", program: "claude" as const, profileKey: "pk1", workspaceKey: "wk1", cardId: "card1", kind: "card" as const, node: "box", machine: null, loginDir: null, cwd: "/home/box/api", at: AT };

/** A child reads a transcript the way its own reader does. */
async function childRead(child: Ledger, root: string, session: string, lines: string): Promise<void> {
  const path = join(root, "projects", "-home-box-api", `${session}.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, lines);
  const each = new UsageReader({ ledger: child, facts: noFacts, roots: async () => [{ dir: root, loginKey: null }], codexRoots: async () => [], opencodeHome: () => join(root, "none"), tail: { pause: async () => {} } });
  await sweep(each);
  each.stop();
}

describe("what a node said", () => {
  it("reaches the parent's page as the same tokens, under the node's name and the node's words", async () => {
    const { child, parent, usage } = pair();
    child.recordLaunch({ ...LAUNCH, sessionId: SESSION });
    await childRead(child, join(dir, "c"), SESSION, assistant(SESSION, "m1") + assistant(SESSION, "m2", AT + 1000));
    await usage.pullAll();
    const day = dayOf(AT);
    const cells = parent.usageCells(new Date(`${day}T00:00:00`).getTime(), new Date(`${day}T00:00:00`).getTime() + 86_400_000);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ sessionId: SESSION, messages: 2, input: 20, read: 200, output: 10 });
    const fact = parent.usageFacts().get(SESSION)!;
    expect(fact).toMatchObject({ node: "box", workspaceKey: "wk1", cardId: "card1", agentId: null, kind: "card" });
    expect(parent.nodeName("workspaces", "wk1")).toBe("name of wk1");
    expect(parent.nodeName("cards", "card1")).toBe("title of card1");
    usage.stop();
    child.close();
    parent.close();
  });

  it("answers a range cut inside a day, which is every 'today' and every limit week", async () => {
    const { child, parent, usage } = pair();
    await childRead(child, join(dir, "c"), SESSION, assistant(SESSION, "m1") + assistant(SESSION, "m2", AT + 3_600_000));
    await usage.pullAll();
    const quarter = (at: number) => Math.floor(at / 900_000) * 900_000;
    // From the second message's quarter to a little after it: the first is not in it.
    const edge = parent.usageCells(quarter(AT + 3_600_000), AT + 3_600_000 + 60_000);
    expect(edge.reduce((n, cell) => n + cell.messages, 0)).toBe(1);
    const fine = parent.usageQuarters(quarter(AT), AT + 3_600_000 + 60_000);
    expect(fine.map((cell) => cell.at).sort()).toEqual([quarter(AT), quarter(AT + 3_600_000)]);
    usage.stop();
    child.close();
    parent.close();
  });

  it("asks only for what moved: a second pull carries nothing, and a new message one day", async () => {
    const { child, parent, usage, nodes } = pair();
    await childRead(child, join(dir, "c"), SESSION, assistant(SESSION, "m1"));
    await usage.pullAll();
    const known = parent.nodeDaysKnown(nodes[0]!.id);
    expect(Object.keys(known)).toEqual([dayOf(AT)]);
    expect(exportUsage(child, known, { workspace: () => null, card: () => null }).days).toEqual([]);
    await childRead(child, join(dir, "c"), SESSION, assistant(SESSION, "m2", AT + 1000));
    expect(exportUsage(child, known, { workspace: () => null, card: () => null }).days.map((day) => day.day)).toEqual([dayOf(AT)]);
    await usage.pullAll();
    expect(parent.usageFacts().get(SESSION)).toBeDefined();
    const start = new Date(`${dayOf(AT)}T00:00:00`).getTime();
    // Replaced, not added to.
    expect(parent.usageCells(start, start + 86_400_000)[0]!.messages).toBe(2);
    usage.stop();
    child.close();
    parent.close();
  });

  it("moves a session on the page when the node comes to know whose it was", async () => {
    const { child, parent, usage } = pair();
    await childRead(child, join(dir, "c"), SESSION, assistant(SESSION, "m1"));
    await usage.pullAll();
    expect(parent.usageFacts().get(SESSION)?.attributedBy).toBe("folder");
    child.recordLaunch({ ...LAUNCH, sessionId: SESSION });
    await usage.pullAll();
    expect(parent.usageFacts().get(SESSION)).toMatchObject({ attributedBy: "spawn", workspaceKey: "wk1" });
    usage.stop();
    child.close();
    parent.close();
  });

  it("survives the parent rebuilding a day of its own", async () => {
    const { child, parent, usage } = pair();
    await childRead(child, join(dir, "c"), SESSION, assistant(SESSION, "m1"));
    await usage.pullAll();
    await childRead(parent, join(dir, "p"), OTHER, assistant(OTHER, "m9"));
    const start = new Date(`${dayOf(AT)}T00:00:00`).getTime();
    expect(new Set(parent.usageCells(start, start + 86_400_000).map((cell) => cell.sessionId))).toEqual(new Set([SESSION, OTHER]));
    usage.stop();
    child.close();
    parent.close();
  });

  it("does not take a day's cells away because a younger ledger has none for it", async () => {
    const { child, parent, usage, nodes } = pair();
    await childRead(child, join(dir, "c"), SESSION, assistant(SESSION, "m1"));
    await usage.pullAll();
    parent.applyNodeUsage(nodes[0]!.id, "box", { days: [{ day: dayOf(AT), sig: "feedface", cells: [] }], sessions: [], names: { workspaces: {}, cards: {} }, more: false });
    const start = new Date(`${dayOf(AT)}T00:00:00`).getTime();
    expect(parent.usageCells(start, start + 86_400_000)[0]!.messages).toBe(1);
    usage.stop();
    child.close();
    parent.close();
  });

  it("counts a machine that is also a child once, whichever road reached it first", async () => {
    // The node first: then the ssh road leaves that log alone.
    const first = pair();
    await childRead(first.child, join(dir, "c1"), SESSION, assistant(SESSION, "m1"));
    await first.usage.pullAll();
    claudeFile(`p/${SESSION}.jsonl`, assistant(SESSION, "m1"));
    const calls: string[] = [];
    const each = reader(first.parent, reads("/bin/sh", calls));
    await sweep(each);
    expect(calls).toEqual([]);
    each.stop();
    const start = new Date(`${dayOf(AT)}T00:00:00`).getTime();
    expect(first.parent.usageCells(start, start + 86_400_000)[0]!.messages).toBe(1);
    first.usage.stop();
    first.child.close();
    first.parent.close();

    // The machine first: then what the node says of it is not kept.
    const second = pair("second-");
    const again = reader(second.parent);
    await sweep(again);
    again.stop();
    await childRead(second.child, join(dir, "c2"), SESSION, assistant(SESSION, "m1"));
    await second.usage.pullAll();
    const cells = second.parent.usageCells(start, start + 86_400_000);
    expect(cells.reduce((n, cell) => n + cell.messages, 0)).toBe(1);
    second.usage.stop();
    second.child.close();
    second.parent.close();
  });

  it("keeps a node's numbers while it is away, and says so", async () => {
    const { child, parent, usage, nodes } = pair();
    await childRead(child, join(dir, "c"), SESSION, assistant(SESSION, "m1"));
    await usage.pullAll();
    const at = usage.sources()[0]!.at;
    expect(usage.sources()[0]).toEqual({ name: "box", kind: "node", at, error: null });
    nodes[0]!.up = false;
    await usage.pullAll();
    expect(usage.sources()[0]).toEqual({ name: "box", kind: "node", at, error: "away" });
    nodes[0]!.up = true;
    nodes[0]!.answers = false;
    expect(usage.sources()[0]!.error).toContain("update");
    nodes.pop();
    expect(usage.sources()[0]).toEqual({ name: "box", kind: "node", at, error: "no longer a member" });
    usage.stop();
    child.close();
    parent.close();
  });

  it("says what went wrong with a node and carries on with the next", async () => {
    const parent = open("parent.db");
    const asked: string[] = [];
    const usage = new NodeUsage({
      ledger: parent,
      nodes: () => [
        { id: "n1", name: "one", up: true, answers: true },
        { id: "n2", name: "two", up: true, answers: true },
      ],
      ask: async (id) => {
        asked.push(id);
        if (id === "n1") throw new Error("the link dropped");
        return { days: [], sessions: [], names: {}, more: false };
      },
      log: () => {},
    });
    await usage.pullAll();
    expect(asked).toEqual(["n1", "n2"]);
    expect(usage.sources().map((source) => source.error)).toEqual(["the link dropped", null]);
    usage.stop();
    parent.close();
  });

  it("crosses a long history in parts", async () => {
    const { child, parent, usage, nodes } = pair();
    const lines = [0, 1, 2].map((days) => assistant(SESSION, `m${days}`, AT - days * 86_400_000)).join("");
    await childRead(child, join(dir, "c"), SESSION, lines);
    const answers: boolean[] = [];
    const small = new NodeUsage({
      ledger: parent,
      nodes: () => nodes,
      ask: async (_id, known) => {
        const current = child.usageDaySigns();
        const { days, more } = daysToSend(current, new Map(Object.entries(known)), () => 1, 1);
        answers.push(more);
        const part = exportUsage(child, Object.fromEntries(current.filter((each) => !days.some((day) => day.day === each.day)).map((each) => [each.day, each.sig])), { workspace: () => null, card: () => null });
        return { ...part, more };
      },
      log: () => {},
      gapMs: 0,
    });
    await small.pullAll();
    expect(answers).toEqual([true, true, false]);
    expect(Object.keys(parent.nodeDaysKnown(nodes[0]!.id))).toHaveLength(3);
    small.stop();
    usage.stop();
    child.close();
    parent.close();
  });

  it("sends the newest days first, each whole, and always at least one", () => {
    const current = [
      { day: "2026-10-01", sig: "aaaaaaaa" },
      { day: "2026-10-02", sig: "bbbbbbbb" },
      { day: "2026-10-03", sig: "cccccccc" },
    ];
    const known = new Map([["2026-10-02", "bbbbbbbb"]]);
    expect(daysToSend(current, known, () => 1)).toEqual({ days: [current[2]!, current[0]!], more: false });
    expect(daysToSend(current, new Map(), () => 10, 15)).toEqual({ days: [current[2]!], more: true });
    expect(daysToSend(current, new Map(), () => 99, 1).days).toEqual([current[2]!]);
  });

  it("takes only what is sound off the wire", () => {
    const good = { sessionId: SESSION, model: "claude-opus-5-5", at: AT, messages: 1, input: 1, write5m: 0, write1h: 0, read: 0, output: 1, thinking: 0, cost: 0.1, unpriced: 0 };
    const session = { id: SESSION, program: "claude", kind: "agent", profileKey: null, workspaceKey: "wk1", cardId: null, machine: null, cwd: "/x", attributedBy: "folder", startedAt: AT, lastAt: AT, says: null };
    const part = adoptUsagePart({
      days: [
        {
          day: "2026-10-30",
          sig: "abcdef0123456789",
          cells: [
            good,
            { ...good, input: Number.NaN },
            { ...good, input: "1" },
            { ...good, input: -1 },
            { ...good, messages: undefined },
            { ...good, at: Number.POSITIVE_INFINITY },
            { ...good, model: "a b" },
            { ...good, sessionId: "not; an id" },
            { ...good, sessionId: OTHER },
          ],
        },
        { day: "../etc", sig: "abcdef01", cells: [] },
        { day: "2026-10-31", sig: "NOT HEX", cells: [] },
      ],
      sessions: [session, { ...session, id: "bad id" }, { ...session, id: OTHER, program: "emacs" }],
      names: { workspaces: { wk1: "x".repeat(500), "bad key": "no" }, cards: "nope" },
      more: "yes",
    })!;
    expect(part.days).toHaveLength(1);
    expect(part.days[0]!.cells).toEqual([good]);
    expect(part.sessions.map((row) => row.id)).toEqual([SESSION]);
    expect(part.names.workspaces.wk1).toHaveLength(200);
    expect(part.names.cards).toEqual({});
    expect(part.more).toBe(false);
    expect(adoptUsagePart(null)).toBeNull();
    expect(adoptUsagePart({ days: "x", sessions: [] })).toBeNull();
    expect([...adoptKnownDays({ "2026-10-30": "abcdef01", nope: "abcdef01", "2026-10-31": 3 }).keys()]).toEqual(["2026-10-30"]);
    expect(adoptKnownDays("x").size).toBe(0);
  });

  it("never writes a qualified id", async () => {
    const qualified = qualify("n0123456789ab", "wk1");
    const session = { id: SESSION, program: "claude", kind: "agent", profileKey: null, workspaceKey: qualified, cardId: null, machine: null, cwd: null, attributedBy: "folder", startedAt: AT, lastAt: AT, says: null };
    expect(adoptUsagePart({ days: [], sessions: [session], names: {} })!.sessions).toEqual([]);
    expect(adoptUsagePart({ days: [], sessions: [{ ...session, workspaceKey: null, id: qualify("n0123456789ab", SESSION) }], names: {} })!.sessions).toEqual([]);
    expect(adoptUsagePart({ days: [], sessions: [{ ...session, workspaceKey: null, cwd: `/x/${qualified}` }], names: {} })!.sessions[0]!.cwd).toBeNull();
    expect(adoptUsagePart({ days: [], sessions: [], names: { workspaces: { wk1: qualified } } })!.names.workspaces).toEqual({});

    const { child, parent, usage } = pair();
    child.recordLaunch({ ...LAUNCH, sessionId: SESSION });
    await childRead(child, join(dir, "c"), SESSION, assistant(SESSION, "m1"));
    await usage.pullAll();
    usage.stop();
    child.close();
    parent.close();
    for (const name of ["parent.db", "parent.db-wal"]) if (existsSync(join(dir, name))) expect(readFileSync(join(dir, name)).includes("n:n0123456789ab:")).toBe(false);
  });

  it("carries no word of a transcript, in the answer or the parent's file", async () => {
    const { child, parent, usage } = pair();
    await childRead(child, join(dir, "c"), SESSION, assistant(SESSION, "m1") + noise());
    const answer = JSON.stringify(exportUsage(child, {}, { workspace: () => null, card: () => null }));
    expect(answer).not.toContain(SECRET);
    await usage.pullAll();
    usage.stop();
    child.close();
    parent.close();
    for (const name of ["parent.db", "parent.db-wal"]) if (existsSync(join(dir, name))) expect(readFileSync(join(dir, name)).includes(SECRET)).toBe(false);
  });

  it("does not pass another node's rows on", async () => {
    const { child, parent, usage } = pair();
    await childRead(child, join(dir, "c"), SESSION, assistant(SESSION, "m1"));
    await usage.pullAll();
    const answer = exportUsage(parent, {}, { workspace: () => null, card: () => null });
    expect(answer.days.flatMap((day) => day.cells)).toEqual([]);
    usage.stop();
    child.close();
    parent.close();
  });
});

describe("the page's words for it", () => {
  const names: UsageNames = { workspace: (key) => `ws ${key}`, card: (id) => `card ${id}`, liveAgent: () => null, openableCard: () => null, folder: (path) => path.replace("/home/me", "~"), here: "This Mac" };
  function fact(over: Partial<SessionFact> = {}): SessionFact {
    return { id: "s", program: "claude", kind: "agent", workspaceKey: null, cardId: null, cwd: "/home/me/x", attributedBy: "folder", agentId: null, startedAt: AT, lastAt: AT, ...over };
  }

  it("names where a session ran", () => {
    expect(placeOf(fact())).toBeNull();
    expect(placeOf(fact({ machine: "vps" }))).toBe("vps");
    expect(placeOf(fact({ node: "box" }))).toBe("box");
    expect(placeOf(fact({ node: "box", machine: "far" }))).toBe("far, through box");
  });

  it("splits by computer, Kuru on the computer it ran on", () => {
    const by = (over: Partial<SessionFact>) => entityOf("computer", { model: "m" }, fact(over), names);
    expect(by({}).label).toBe("This Mac");
    expect(by({ machine: "vps" }).label).toBe("vps");
    expect(by({ node: "box", kind: "harness" })).toEqual({ key: "at:box", label: "box" });
    expect(by({}).key).not.toBe(by({ machine: "vps" }).key);
  });

  it("keeps the same folder on two computers apart, and does not call another's home this one's", () => {
    const by = (over: Partial<SessionFact>) => entityOf("workspace", { model: "m" }, fact(over), names);
    expect(by({}).label).toBe("~/x");
    expect(by({ node: "box" }).label).toBe("/home/me/x · box");
    expect(by({ node: "box" }).key).not.toBe(by({ machine: "vps" }).key);
    expect(by({ node: "box", workspaceKey: "wk" }).label).toBe("ws wk · box");
    expect(by({ node: "box", kind: "harness" }).kuru).toBe(true);
  });

  it("says it in the table", () => {
    const cell = { at: AT, sessionId: "s", model: "m", messages: 1, input: 1, write5m: 0, write1h: 0, read: 0, output: 0, thinking: 0, cost: 0, unpriced: 0 };
    const { rows } = sessionRows([cell], new Map([["s", fact({ node: "box" })]]), new Map(), names);
    expect(rows[0]!.place).toBe("box");
    expect(rows[0]!.workspace).toBe("/home/me/x");
    expect(rows[0]!.agentId).toBeNull();
  });
});
