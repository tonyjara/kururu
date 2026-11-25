/**
 * Test runs, end to end without an agent: a transcript's lines through the
 * ledger's reader into `test_runs`, a hook's report into the same row, what a
 * chip is told, and what the report adds up to.
 *
 * Hand-written records with Claude Code's and Codex's field names, as
 * `usageledger.test.ts` has them, and the same marked word on everything a
 * ledger must not keep: here it is in a command's environment, in a flag and
 * all through a test's output.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noFacts } from "../../shared/usage";
import { buildTestingReport, cardTestLines, slowAgainst, testingText, type TestingNames, type TestRun } from "../../shared/testreport";
import { hookSettings, runsReporter, testEndCommand, testReportOf, TEST_WORDS } from "../src/hooks";
import { Testing } from "../src/testing";
import { Ledger } from "../src/usage/store";
import { UsageReader } from "../src/usage/sweep";
import { claudeTestCalls, claudeTestResult, codexTestLine } from "../src/usage/testlines";
import { openTestRuns, recordTestEvent, testRunsBetween, testRunsOfCard } from "../src/usage/testlog";

const SESSION = "33333333-3333-4333-8333-333333333333";
const SECRET = "LEDGERSECRET";
const noPause = { pause: async () => {} };

let dir: string;
let root: string;
let ledger: Ledger;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kururu-testruns-"));
  root = join(dir, "claude");
  mkdirSync(join(root, "projects", "-p"), { recursive: true });
  ledger = Ledger.open(join(dir, "usage.db"));
});
afterEach(() => {
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

function assistant(id: string, at: string, content: unknown[] = [], tokens = { read: 1000, output: 10 }): string {
  return `${JSON.stringify({
    isSidechain: false,
    message: { model: "claude-opus-5-5", id, role: "assistant", content, usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: tokens.read, output_tokens: tokens.output } },
    type: "assistant",
    uuid: id,
    timestamp: at,
    cwd: "/home/someone/project",
    sessionId: SESSION,
    version: "2.1.332",
  })}\n`;
}
const bash = (id: string, command: string, extra: Record<string, unknown> = {}) => ({ type: "tool_use", id, name: "Bash", input: { command, ...extra } });

function result(callId: string, at: string, stdout: string, extra: { error?: string; background?: string } = {}): string {
  return `${JSON.stringify({
    type: "user",
    timestamp: at,
    sessionId: SESSION,
    message: { role: "user", content: [{ tool_use_id: callId, type: "tool_result", content: extra.error ?? (extra.background ? `Command running in background with ID: ${extra.background}` : stdout), is_error: extra.error !== undefined }] },
    toolUseResult: extra.error !== undefined ? `Error: ${extra.error}` : { stdout: extra.background ? "" : stdout, stderr: "", interrupted: false, isImage: false, ...(extra.background ? { backgroundTaskId: extra.background } : {}) },
  })}\n`;
}

function reader(onTests?: (events: readonly unknown[]) => void, machine = false): UsageReader {
  return new UsageReader({
    ledger,
    facts: () => noFacts(),
    roots: async () => (machine ? [] : [{ dir: root, loginKey: null }]),
    codexRoots: async () => [],
    opencodeHome: () => join(dir, "no-opencode"),
    tail: noPause,
    onTests,
  });
}
async function sweep(each = reader()): Promise<UsageReader> {
  each.sweepSoon();
  await each.settled();
  return each;
}
const path = () => join(root, "projects", "-p", `${SESSION}.jsonl`);
const runs = () => testRunsBetween(ledger, 0, Number.MAX_SAFE_INTEGER);

describe("a transcript's test runs", () => {
  it("writes a run with its time, result, counts and tokens, and none of its words", async () => {
    writeFileSync(
      path(),
      assistant("m1", "2026-11-25T15:00:00.000Z", [bash("toolu_1", `cd /repo && API_KEY=${SECRET} pnpm chat:e2e --token ${SECRET} 2>&1 | tail -5`)]) +
        // Another tool's output, which is not asked for and is never parsed: it is not even JSON.
        `{"type":"user","message":{"content":[{"tool_use_id":"toolu_other","content":"${SECRET} pnpm test\n` +
        result("toolu_1", "2026-11-25T15:02:10.000Z", `${SECRET}\n Test Files  1 failed | 2 passed (3)\n      Tests  1 failed | 4 passed (5)\n`) +
        assistant("m2", "2026-11-25T15:02:15.000Z", [{ type: "text", text: SECRET }], { read: 5000, output: 40 }) +
        assistant("m3", "2026-11-25T15:03:00.000Z"),
    );
    await sweep();
    const [run] = runs();
    expect(runs()).toHaveLength(1);
    expect(run).toMatchObject({
      sessionId: SESSION,
      callId: "toolu_1",
      program: "claude",
      kind: "e2e",
      runner: "vitest",
      suite: "pnpm chat:e2e",
      command: "API_KEY=… pnpm chat:e2e --token …",
      cwd: "/home/someone/project",
      durationMs: 130_000,
      timedBy: "log",
      exit: 0,
      outcome: "fail",
      passed: 4,
      failed: 1,
      skipped: 0,
    });
    // The message that read the result and no other: not the one that asked, not the one after.
    expect(run!.spend).toMatchObject({ messages: 1, cacheRead: 5000, output: 40 });
    // The unasked-for line was passed over, not parsed and refused.
    expect(ledger.counts().skipped).toBe(0);
    ledger.close();
    for (const file of ["usage.db", "usage.db-wal"]) {
      const bytes = readFileSync(join(dir, file));
      expect(bytes.includes(SECRET)).toBe(false);
    }
    ledger = Ledger.open(join(dir, "usage.db"));
  });

  it("finds the result after a restart, from the run it left open", async () => {
    writeFileSync(path(), assistant("m1", "2026-11-25T15:00:00.000Z", [bash("toolu_1", "bun test")]));
    await sweep();
    expect(runs()[0]).toMatchObject({ endedAt: null, outcome: null });
    expect(openTestRuns(ledger, 0)).toHaveLength(1);
    appendFileSync(path(), result("toolu_1", "2026-11-25T15:00:32.000Z", " 3273 pass\n 0 fail\n"));
    const seen: unknown[] = [];
    // A new reader, as after a restart: what it waits for comes from the ledger.
    await sweep(reader((events) => seen.push(...events)));
    expect(runs()[0]).toMatchObject({ durationMs: 32_000, outcome: "pass", passed: 3273, failed: 0, runner: "bun" });
    expect(seen).toHaveLength(1);
    expect(openTestRuns(ledger, 0)).toHaveLength(0);
  });

  it("ends a failed run with its exit code, and a refused one as stopped", async () => {
    writeFileSync(
      path(),
      assistant("m1", "2026-11-25T15:00:00.000Z", [bash("toolu_1", "bun run typecheck"), bash("toolu_2", "pnpm lint")]) +
        result("toolu_1", "2026-11-25T15:00:20.000Z", "", { error: "Exit code 2\nsrc/a.ts(1,2): error TS2322: no\nsrc/b.ts(3,4): error TS1005: no" }) +
        result("toolu_2", "2026-11-25T15:00:21.000Z", "", { error: "The user doesn't want to proceed with this tool use." }),
    );
    await sweep();
    const [types, lint] = runs().sort((a, b) => a.callId.localeCompare(b.callId));
    expect(types).toMatchObject({ kind: "typecheck", exit: 2, outcome: "fail", failed: 2, passed: null });
    expect(lint).toMatchObject({ kind: "lint", exit: null, outcome: "stopped" });
  });

  it("follows a run into the background to the notice that it finished", async () => {
    writeFileSync(
      path(),
      assistant("m1", "2026-11-25T15:00:00.000Z", [bash("toolu_1", "pnpm e2e", { run_in_background: true })]) +
        result("toolu_1", "2026-11-25T15:00:00.100Z", "", { background: "b123" }) +
        assistant("m2", "2026-11-25T15:01:00.000Z"),
    );
    await sweep();
    expect(runs()[0]).toMatchObject({ background: true, endedAt: null });
    appendFileSync(
      path(),
      `${JSON.stringify({ type: "user", timestamp: "2026-11-25T15:06:00.000Z", sessionId: SESSION, message: { role: "user", content: `<task-notification>\n<task-id>b123</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>\n<summary>Background command "pnpm e2e" completed (exit code 0)</summary>` } })}\n` +
        assistant("m3", "2026-11-25T15:06:05.000Z"),
    );
    await sweep();
    expect(runs()[0]).toMatchObject({ background: true, durationMs: 360_000, exit: 0, outcome: "pass" });
    // Everything the session billed while it ran, and the message after it.
    expect(runs()[0]!.spend?.messages).toBe(2);
  });

  it("does not take a quoted id in another session for a result", () => {
    const record = JSON.parse(result("toolu_1", "2026-11-25T15:00:00.000Z", "x"));
    expect(claudeTestResult(record, new Set(["toolu_1"]))).toMatchObject({ kind: "end", callId: "toolu_1" });
    expect(claudeTestResult(record, new Set(["toolu_2"]))).toBeNull();
    expect(claudeTestResult({ ...record, type: "assistant" }, new Set(["toolu_1"]))).toBeNull();
    expect(claudeTestCalls({ message: { content: [bash("toolu_9", "git commit -m 'run the tests'"), { type: "tool_use", id: "toolu_8", name: "Read", input: { command: "bun test" } }] } })).toEqual([]);
  });
});

describe("a hook and a transcript on one run", () => {
  const call = { kind: "unit" as const, runner: "bun", suite: "bun test", command: "bun test", focused: false };
  it("keeps the hook's length, the transcript's instants and the transcript's counts", async () => {
    const at = Date.parse("2026-11-25T15:00:03.000Z");
    recordTestEvent(ledger, { type: "start", by: "hook", sessionId: SESSION, callId: "toolu_1", program: "claude", call, background: false, cwd: "/repo", at });
    recordTestEvent(ledger, { type: "end", by: "hook", sessionId: SESSION, callId: "toolu_1", at: at + 30_500, durationMs: 30_000, exit: 0, stopped: false, counts: null });
    writeFileSync(path(), assistant("m1", "2026-11-25T15:00:00.000Z", [bash("toolu_1", "bun test")]) + result("toolu_1", "2026-11-25T15:00:40.000Z", " 10 pass\n 1 fail\n"));
    await sweep();
    expect(runs()).toHaveLength(1);
    expect(runs()[0]).toMatchObject({ startedAt: Date.parse("2026-11-25T15:00:00.000Z"), endedAt: Date.parse("2026-11-25T15:00:40.000Z"), durationMs: 30_000, timedBy: "hook", passed: 10, failed: 1, outcome: "fail", cwd: "/repo" });
  });

  it("times a run by the transcript when the hook only said it started", async () => {
    // An agent started before the end hook existed: the start arrives late, as a hook's does, and no end comes.
    recordTestEvent(ledger, { type: "start", by: "hook", sessionId: SESSION, callId: "toolu_1", program: "claude", call, background: false, cwd: "/repo", at: Date.parse("2026-11-25T15:00:00.700Z") });
    writeFileSync(path(), assistant("m1", "2026-11-25T15:00:00.000Z", [bash("toolu_1", "bun test")]) + result("toolu_1", "2026-11-25T15:00:40.000Z", " 10 pass\n 0 fail\n"));
    await sweep();
    expect(runs()[0]).toMatchObject({ startedAt: Date.parse("2026-11-25T15:00:00.000Z"), durationMs: 40_000, timedBy: "log", outcome: "pass" });
  });

  it("makes a row from an end whose start nobody wrote down", () => {
    recordTestEvent(ledger, { type: "end", by: "hook", sessionId: SESSION, callId: "toolu_7", at: 100_000, durationMs: 40_000, exit: 1, stopped: false, counts: null, call, program: "claude" });
    expect(runs()[0]).toMatchObject({ startedAt: 60_000, endedAt: 100_000, durationMs: 40_000, outcome: "fail" });
  });
});

describe("the hooks", () => {
  const payload = (event: string, command: string, extra: Record<string, unknown> = {}) => ({ hook_event_name: event, tool_name: "Bash", session_id: SESSION, tool_use_id: "toolu_1", tool_input: { command }, ...extra });

  it("say a test is starting, and how it ended", () => {
    expect(testReportOf(payload("PreToolUse", "pnpm chat:e2e"))).toMatchObject({ phase: "start", session: SESSION, callId: "toolu_1", call: { kind: "e2e", suite: "pnpm chat:e2e" }, background: false });
    expect(testReportOf(payload("PostToolUse", "bun test", { duration_ms: 1234, tool_response: { stdout: ` 5 pass\n 0 fail\n${SECRET}`, stderr: "" } }))).toEqual({
      phase: "end",
      session: SESSION,
      callId: "toolu_1",
      call: { kind: "unit", runner: "bun", suite: "bun test", command: "bun test", focused: false },
      durationMs: 1234,
      exit: 0,
      stopped: false,
      counts: { passed: 5, failed: 0, skipped: 0, runner: "bun" },
    });
    expect(testReportOf(payload("PostToolUseFailure", "bun test", { error: "Exit code 1\n 4 pass\n 1 fail" }))).toMatchObject({ phase: "end", exit: 1, counts: { failed: 1 } });
    expect(testReportOf(payload("PostToolUse", "pnpm e2e", { tool_response: { stdout: "", backgroundTaskId: "b1" } }))).toMatchObject({ phase: "start", background: true });
  });

  it("say nothing for a call that is not a run", () => {
    expect(testReportOf(payload("PreToolUse", "git status"))).toBeNull();
    expect(testReportOf({ ...payload("PreToolUse", "bun test"), tool_name: "Read" })).toBeNull();
    expect(testReportOf(payload("Stop", "bun test"))).toBeNull();
    expect(testReportOf({ ...payload("PreToolUse", "bun test"), tool_use_id: undefined })).toBeNull();
    expect(testReportOf(null)).toBeNull();
  });

  it("run after a Bash call only, behind a shell that looks first", () => {
    const settings = hookSettings("/bin/node", "/x/report.mjs") as { hooks: Record<string, { matcher?: string; hooks: { command: string; async: boolean }[] }[]> };
    for (const event of ["PostToolUse", "PostToolUseFailure"]) {
      expect(settings.hooks[event]![0]!.matcher).toBe("Bash");
      expect(settings.hooks[event]![0]!.hooks[0]!.async).toBe(true);
      expect(settings.hooks[event]![0]!.hooks[0]!.command).toStartWith("p=$(cat); c=${p%%\\\"tool_response\\\"*}");
    }
    expect(Object.keys(settings.hooks)).toHaveLength(7);
    // A directory that reports the rest itself is given only these two.
    const only = hookSettings("/bin/node", "/x/report.mjs", "tests") as typeof settings;
    expect(Object.keys(only.hooks).sort()).toEqual(["PostToolUse", "PostToolUseFailure"]);
    expect(runsReporter(only, "/x/report.mjs", ["PostToolUse"])).toBe(true);
    expect(runsReporter({ hooks: { Stop: [{ hooks: [{ command: "bun report-cli.ts done" }] }] } }, "/x/report.mjs", ["PostToolUse", "PostToolUseFailure"])).toBe(false);
    expect(testEndCommand("node x")).toContain("*playwright*");
  });

  it("filter on words the classifier's own runs have in them", () => {
    const commands = ["bun test", "pnpm chat:e2e", "npx vitest run", "tsc --noEmit", "npx eslint .", "next build", "xcodebuild -scheme App test", "maestro test flows/", "pytest -q", "go vet ./...", "cargo clippy", "make", "./gradlew assembleDebug", "node scripts/check-contract.mjs", "biome check ."];
    for (const command of commands) expect(TEST_WORDS.some((word) => command.includes(word))).toBe(true);
  });
});

describe("what is testing now", () => {
  function testing(now: { at: number }, loose = false) {
    const changed = { n: 0 };
    const live = new Testing();
    live.bind({ ledger: () => ledger, placeOf: () => ({ workspace: "Shop", loose }), cwdOf: () => "/repo", changed: () => void changed.n++, log: () => {}, now: () => now.at });
    return { live, changed };
  }
  const start = (callId: string, command = "pnpm chat:e2e", background = false) => ({ phase: "start", session: SESSION, callId, call: testReportOf({ hook_event_name: "PreToolUse", tool_name: "Bash", session_id: SESSION, tool_use_id: callId, tool_input: { command } })!.call, background });

  it("is a chip from the start hook to the end hook, and a row in the ledger", () => {
    const now = { at: 1_000_000 };
    const { live, changed } = testing(now, true);
    expect(live.hook("a1", start("toolu_1"))).toBe(true);
    expect(live.of("a1")).toEqual({ suite: "pnpm chat:e2e", kind: "e2e", since: 1_000_000, loose: true });
    expect(live.rows(() => "claude in shop")).toMatchObject([{ agentId: "a1", agent: "claude in shop", project: "Shop" }]);
    now.at += 130_000;
    expect(live.hook("a1", { ...start("toolu_1"), phase: "end", durationMs: 129_000, exit: 0, counts: { passed: 12, failed: 0, skipped: 0 } })).toBe(true);
    expect(live.of("a1")).toBeNull();
    expect(changed.n).toBe(2);
    expect(runs()[0]).toMatchObject({ suite: "pnpm chat:e2e", durationMs: 129_000, timedBy: "hook", outcome: "pass", passed: 12, cwd: "/repo" });
    expect(live.hook("a1", { phase: "start" })).toBe(false);
  });

  it("ends when the reader sees the result, or the turn ends, and a background run outlives the turn", () => {
    const now = { at: 1_000_000 };
    const { live } = testing(now);
    live.hook("a1", start("toolu_1", "bun test"));
    live.hook("a2", start("toolu_2", "bun test"));
    live.hook("a2", start("toolu_3", "pnpm e2e", true));
    expect(live.of("a2")?.more).toBe(1);
    live.sawTests([{ type: "end", by: "log", sessionId: SESSION, callId: "toolu_1", at: 1, durationMs: null, exit: 0, stopped: false, counts: null }]);
    expect(live.of("a1")).toBeNull();
    live.turnEnded("a2");
    expect(live.of("a2")).toMatchObject({ suite: "pnpm e2e" });
    now.at += 7 * 3600_000;
    expect(live.of("a2")).toBeNull();
  });
});

describe("the report", () => {
  const names: TestingNames = { workspace: (key) => (key === "wk1" ? "Shop" : key === "wk2" ? "Landing" : null), card: (id) => `card ${id}`, loose: (key) => key === "wk2", folder: (path) => path.replace("/home/someone", "~") };
  const day = Date.parse("2026-11-25T12:00:00");
  let n = 0;
  const run = (over: Partial<TestRun>): TestRun => ({
    sessionId: SESSION, callId: `c${n++}`, program: "claude", kind: "unit", runner: "vitest", suite: "vitest", command: "vitest", focused: false, background: false, cwd: "/home/someone/shop",
    startedAt: day, endedAt: day + 60_000, durationMs: 60_000, timedBy: "hook", exit: 0, outcome: "pass", passed: 10, failed: 0, skipped: 0,
    spend: { messages: 1, input: 10, cacheWrite: 100, cacheRead: 10_000, output: 50, cost: 0.02 }, workspaceKey: "wk1", cardId: null, agentId: null, machine: null, ...over,
  });

  it("adds up by project and suite, and flags what is worth a look", () => {
    const earlier = [1, 2, 3].map((d) => run({ startedAt: day - d * 86_400_000 * 10, endedAt: null }));
    const before = [3, 2, 1].map((d) => run({ startedAt: day - d * 3600_000 }));
    const report = buildTestingReport({
      range: "today",
      now: day + 3600_000,
      runs: [
        ...earlier,
        ...before,
        run({ durationMs: 200_000, outcome: "fail", failed: 2 }),
        run({ suite: "pnpm e2e", kind: "e2e", workspaceKey: "wk2", durationMs: 10_000 }),
        run({ suite: "tsc", kind: "typecheck", workspaceKey: "wk2", durationMs: 5_000, passed: null }),
        ...[0, 1, 2, 3, 4].map(() => run({ suite: "bun test", cardId: "c1", durationMs: 1000 })),
        run({ workspaceKey: null, suite: "pytest", durationMs: 7000 }),
      ],
      live: [],
      names,
      since: day - 86_400_000,
    });
    expect(report.totals).toMatchObject({ runs: 12, failed: 1, projects: 3 });
    expect(report.projects.map((row) => row.name)).toEqual(["Shop", "Landing", "~/shop"]);
    const shop = report.projects[0]!;
    expect(shop.suites.map((suite) => [suite.suite, suite.runs, suite.failed, suite.medianMs, suite.slow])).toEqual([["vitest", 4, 1, 60_000, true], ["bun test", 5, 0, 1000, false]]);
    expect(report.flags.map((flag) => flag.flag)).toEqual(["loose", "slow", "reruns"]);
    expect(report.flags[0]).toMatchObject({ project: "Landing", suite: "pnpm e2e", runs: 1 });
    expect(report.flags[1]).toMatchObject({ suite: "vitest", ms: 200_000, usualMs: 60_000 });
    expect(report.flags[2]).toMatchObject({ suite: "bun test", runs: 5, card: "card c1" });
    expect(report.slowest[0]).toMatchObject({ suite: "vitest", project: "Shop" });
    expect(report.recent[0]).toMatchObject({ suite: "pytest", project: "~/shop" });
    const text = testingText(report);
    expect(text).toContain("Nothing is testing right now.");
    expect(text).toContain("Today: 12 runs");
    expect(text).toContain("Landing (no test suite)");
    expect(text).toContain("vitest in Shop took 3m20s; it usually takes 1m00s.");
    expect(testingText(report, { project: "landing" })).not.toContain("Shop:");
    expect(testingText(report, { project: "nowhere" })).toContain('No run recorded for "nowhere"');
  });

  it("calls a run slow only against enough like it", () => {
    const usual = [run({}), run({}), run({})];
    expect(slowAgainst(run({ durationMs: 200_000 }), usual)).toBe(60_000);
    expect(slowAgainst(run({ durationMs: 200_000 }), usual.slice(1))).toBeNull();
    expect(slowAgainst(run({ durationMs: 80_000 }), usual)).toBeNull();
    // Twice a two-second suite is not news.
    expect(slowAgainst(run({ durationMs: 5000 }), [run({ durationMs: 2000 }), run({ durationMs: 2000 }), run({ durationMs: 2000 })])).toBeNull();
  });

  it("reads a card's runs back for its history", () => {
    ledger.recordLaunch({ sessionId: SESSION, program: "claude", profileKey: "p", workspaceKey: "wk1", cardId: "card9", runId: null, agentId: "a1", kind: "agent", node: null, machine: null, loginDir: null, cwd: "/repo", at: day } as never);
    recordTestEvent(ledger, { type: "start", by: "hook", sessionId: SESSION, callId: "t1", program: "claude", call: { kind: "unit", runner: "bun", suite: "bun test", command: "bun test", focused: false }, background: false, cwd: null, at: day });
    recordTestEvent(ledger, { type: "end", by: "hook", sessionId: SESSION, callId: "t1", at: day + 32_000, durationMs: 32_000, exit: 0, stopped: false, counts: { passed: 3273, failed: 0, skipped: 0 } });
    const found = testRunsOfCard(ledger, "card9");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ workspaceKey: "wk1", cardId: "card9", agentId: "a1" });
    expect(cardTestLines(found)[0]).toStartWith("bun test (unit): pass in 32s, 3273 passed");
  });
});

describe("Codex's rollouts", () => {
  const waiting = new Set<string>();
  it("reads a command out of each shape a tool call has had", () => {
    const at = "2026-11-25T15:00:00.000Z";
    expect(codexTestLine({ timestamp: at, type: "response_item", payload: { type: "custom_tool_call", call_id: "call_1", name: "exec", input: 'const r = await tools.exec_command({cmd:"pnpm test:e2e", yield_time_ms: 1000}); text(r)' } }, waiting)).toMatchObject({ kind: "start", callId: "call_1", call: { kind: "e2e", suite: "pnpm test:e2e" } });
    expect(codexTestLine({ timestamp: at, type: "response_item", payload: { type: "function_call", call_id: "call_2", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "cargo test"] }) } }, waiting)).toMatchObject({ kind: "start", call: { kind: "unit", suite: "cargo test" } });
    expect(codexTestLine({ timestamp: at, type: "response_item", payload: { type: "function_call", call_id: "call_3", name: "exec_command", arguments: JSON.stringify({ cmd: "ls -la" }) } }, waiting)).toBeNull();
    expect(codexTestLine({ timestamp: at, type: "response_item", payload: { type: "message", role: "assistant" } }, waiting)).toBeNull();
  });
  it("ends a run it was waiting on with the output's own wall time", () => {
    const output = { timestamp: "2026-11-25T15:00:09.000Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call_1", output: [{ type: "input_text", text: "Script completed\nWall time 7.5 seconds\nOutput:\n" }, { type: "input_text", text: " Tests  2 passed (2)\n" }] } };
    expect(codexTestLine(output, new Set())).toBeNull();
    expect(codexTestLine(output, new Set(["call_1"]))).toMatchObject({ kind: "end", callId: "call_1", durationMs: 7500, counts: { passed: 2, failed: 0 } });
    const older = { timestamp: "2026-11-25T15:00:09.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "call_2", output: JSON.stringify({ output: "test result: FAILED. 3 passed; 1 failed; 0 ignored", metadata: { exit_code: 101, duration_seconds: 2.25 } }) } };
    expect(codexTestLine(older, new Set(["call_2"]))).toMatchObject({ kind: "end", durationMs: 2250, exit: 101, counts: { passed: 3, failed: 1 } });
  });
});
