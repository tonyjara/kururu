/**
 * What the recorded test runs add up to: the Testing page's one object, the
 * flags, and the few lines Kuru is given when it asks.
 *
 * The rows are `usage.db`'s `test_runs` (`server/src/usage/testlog.ts`),
 * joined to the session each ran in, and everything here is arithmetic over
 * them, pure so that a test can hold it without a database. It is worked out
 * when somebody asks and at no other time: nothing is rolled up as runs
 * arrive, because a few hundred rows a day for half a year is a table a
 * question can read whole in a millisecond.
 *
 * **The flags are opinions and are kept out of the record.** Whether a run was
 * slow depends on the runs before it, whether a project is "loose" on a
 * switch somebody can flip, whether five reruns is many on the card; a flag
 * written into a row would be yesterday's opinion. They are also never
 * announced. A notice to Kuru is a turn, and this exists to count what
 * testing costs, not to add to it.
 */
import { dayOf } from "./usage";
import { chipName, isSuiteKind, KIND_LABEL, shortDuration, type LiveTest, type TestKind, type TestOutcome } from "./testing";

export const TESTING_RANGES = ["today", "week", "month"] as const;
export type TestingRange = (typeof TESTING_RANGES)[number];

export function isTestingRange(value: unknown): value is TestingRange {
  return typeof value === "string" && (TESTING_RANGES as readonly string[]).includes(value);
}

export const RANGE_LABEL: Record<TestingRange, string> = { today: "Today", week: "7 days", month: "30 days" };
const RANGE_DAYS: Record<TestingRange, number> = { today: 1, week: 7, month: 30 };

/** How long a run is kept. Rows are a few hundred bytes; half a year is a few megabytes. */
export const TEST_RETENTION_DAYS = 180;
/** How far back earlier runs are read for what a suite's usual time is. */
export const BASELINE_DAYS = 30;
/** A suite run this many times in one card is asked about. */
export const RERUN_FLAG = 5;
/** Slow is twice the usual and at least this much over it, so a 2 s suite taking 5 s is not news. */
const SLOW_FACTOR = 2;
const SLOW_OVER_MS = 30_000;
const SLOW_NEEDS = 3;
const BASELINE_RUNS = 20;

/** What a run's session billed around it. See `ATTRIBUTION`. */
export interface TestSpend {
  messages: number;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  cost: number;
}

/** The rule, in the words the page and the tool both say it in. */
export const ATTRIBUTION =
  "Tokens are what the agent's session billed after a run started, through its first message after the run ended: the message that read the result. Most of it is the conversation read back from cache, which is what a test's round trip costs. A run in the background also counts what else the agent did meanwhile.";

/** One row of `test_runs` with what its session's row says about whose it was. */
export interface TestRun {
  sessionId: string;
  callId: string;
  program: string;
  kind: TestKind;
  runner: string;
  suite: string;
  command: string;
  focused: boolean;
  background: boolean;
  cwd: string | null;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  /** Where the times came from: the hook's own measure, the transcript's two timestamps, or the session's next message. */
  timedBy: "hook" | "log" | "next";
  exit: number | null;
  outcome: TestOutcome | null;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  spend: TestSpend | null;
  workspaceKey: string | null;
  cardId: string | null;
  agentId: string | null;
  machine: string | null;
}

export interface TestingNames {
  workspace(key: string): string | null;
  /** A card as it is named on a page: its code and title. */
  card(id: string): string | null;
  /** Whether the workspace is marked as having no test suite. See `Workspace.loose`. */
  loose(key: string): boolean;
  folder(path: string): string;
}

export interface SuiteRow {
  suite: string;
  kind: TestKind;
  runner: string;
  runs: number;
  /** Runs that ended and did not pass. */
  failed: number;
  /** Of the runs that ended. */
  medianMs: number | null;
  totalMs: number;
  /** Tests in the latest run that said how many. */
  tests: number | null;
  tokens: number;
  cost: number;
  /** The latest whole run was slow against the ones before it. */
  slow: boolean;
}

export interface ProjectRow {
  key: string;
  name: string;
  loose: boolean;
  runs: number;
  failed: number;
  totalMs: number;
  tokens: number;
  cost: number;
  suites: SuiteRow[];
}

export interface TestDay {
  day: string;
  runs: number;
  failed: number;
  ms: number;
  byKind: Partial<Record<TestKind, number>>;
}

export type TestFlag =
  | { flag: "loose"; project: string; suite: string; runs: number; ms: number }
  /** The latest slow run of a suite, and how many of its runs in the range were slow. */
  | { flag: "slow"; project: string; suite: string; ms: number; usualMs: number; at: number; runs: number }
  | { flag: "reruns"; project: string; suite: string; runs: number; card: string };

export interface RecentRun {
  id: string;
  at: number;
  project: string;
  suite: string;
  kind: TestKind;
  command: string;
  durationMs: number | null;
  outcome: TestOutcome | null;
  running: boolean;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  tokens: number | null;
  cost: number | null;
  card: string | null;
  where: string | null;
  timedBy: TestRun["timedBy"];
  flags: ("loose" | "slow")[];
}

export interface LiveRow extends LiveTest {
  agentId: string;
  agent: string;
  project: string | null;
}

export interface TestingReport {
  range: TestingRange;
  from: number;
  to: number;
  at: number;
  live: LiveRow[];
  totals: { runs: number; failed: number; ms: number; tokens: number; cost: number; projects: number };
  projects: ProjectRow[];
  slowest: (SuiteRow & { project: string })[];
  days: TestDay[];
  flags: TestFlag[];
  recent: RecentRun[];
  /** The oldest run on record, so a page can say how far back it knows. */
  since: number | null;
  attribution: string;
}

export function rangeStart(range: TestingRange, now: number): number {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  midnight.setDate(midnight.getDate() - (RANGE_DAYS[range] - 1));
  return midnight.getTime();
}

function tokensOf(spend: TestSpend | null): number {
  return spend ? spend.input + spend.cacheWrite + spend.cacheRead + spend.output : 0;
}

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** What a run is filed under: its workspace, or the folder it ran in when no workspace claims its session. */
function projectOf(run: TestRun, names: TestingNames): { key: string; name: string } {
  if (run.workspaceKey) return { key: run.workspaceKey, name: names.workspace(run.workspaceKey) ?? "A workspace that is gone" };
  if (run.cwd) return { key: `dir:${run.cwd}`, name: names.folder(run.cwd) };
  return { key: "", name: "Nowhere kururu knows" };
}

/**
 * Whether a run was slow: against the passing runs of the same suite in the
 * same project before it, whole runs against whole and narrowed against
 * narrowed. Returns the usual time when it was, and null otherwise. Pure.
 */
export function slowAgainst(run: TestRun, earlier: readonly TestRun[]): number | null {
  if (run.durationMs === null || run.outcome === "stopped") return null;
  const usual = median(earlier.slice(-BASELINE_RUNS).map((each) => each.durationMs!));
  if (usual === null || earlier.length < SLOW_NEEDS) return null;
  return run.durationMs > usual * SLOW_FACTOR && run.durationMs - usual >= SLOW_OVER_MS ? usual : null;
}

export interface TestingInput {
  range: TestingRange;
  now: number;
  /** Every run from `BASELINE_DAYS` before the range to now, oldest first. */
  runs: readonly TestRun[];
  live: readonly LiveRow[];
  names: TestingNames;
  since: number | null;
}

const RECENT = 40;
const SLOWEST = 8;

/** The page's object. Pure. */
export function buildTestingReport(input: TestingInput): TestingReport {
  const { range, now, names } = input;
  const from = rangeStart(range, now);
  const projects = new Map<string, ProjectRow & { bySuite: Map<string, { row: SuiteRow; durations: number[]; lastAt: number }> }>();
  const days = new Map<string, TestDay>();
  const flags: TestFlag[] = [];
  const recent: RecentRun[] = [];
  /** Passing runs seen so far, by project, suite and whether narrowed: what "usual" is measured from. */
  const baseline = new Map<string, TestRun[]>();
  const byCard = new Map<string, { project: string; suite: string; runs: number; card: string }>();
  const looseBy = new Map<string, { project: string; suite: string; runs: number; ms: number }>();
  const slowBy = new Map<string, { project: string; suite: string; ms: number; usualMs: number; at: number; runs: number }>();
  const slowSuites = new Map<string, boolean>();
  const totals = { runs: 0, failed: 0, ms: 0, tokens: 0, cost: 0, projects: 0 };

  for (const run of input.runs) {
    const project = projectOf(run, names);
    const group = `${project.key}\0${run.suite}\0${run.focused ? 1 : 0}`;
    const before = baseline.get(group) ?? [];
    const usual = run.endedAt === null ? null : slowAgainst(run, before);
    if (run.outcome === "pass" && run.durationMs !== null) baseline.set(group, [...before, run]);
    if (run.startedAt < from) continue;

    const loose = run.workspaceKey !== null && isSuiteKind(run.kind) && names.loose(run.workspaceKey);
    const ms = run.durationMs ?? 0;
    const tokens = tokensOf(run.spend);
    const cost = run.spend?.cost ?? 0;
    const failed = run.outcome === "fail" ? 1 : 0;
    totals.runs++;
    totals.failed += failed;
    totals.ms += ms;
    totals.tokens += tokens;
    totals.cost += cost;

    let row = projects.get(project.key);
    if (!row) {
      row = { key: project.key, name: project.name, loose: run.workspaceKey !== null && names.loose(run.workspaceKey), runs: 0, failed: 0, totalMs: 0, tokens: 0, cost: 0, suites: [], bySuite: new Map() };
      projects.set(project.key, row);
    }
    row.runs++;
    row.failed += failed;
    row.totalMs += ms;
    row.tokens += tokens;
    row.cost += cost;
    let suite = row.bySuite.get(run.suite);
    if (!suite) {
      suite = { row: { suite: run.suite, kind: run.kind, runner: run.runner, runs: 0, failed: 0, medianMs: null, totalMs: 0, tests: null, tokens: 0, cost: 0, slow: false }, durations: [], lastAt: 0 };
      row.bySuite.set(run.suite, suite);
    }
    suite.row.runs++;
    suite.row.failed += failed;
    suite.row.totalMs += ms;
    suite.row.tokens += tokens;
    suite.row.cost += cost;
    if (run.durationMs !== null && run.outcome !== "stopped") suite.durations.push(run.durationMs);
    if (run.passed !== null && run.startedAt >= suite.lastAt) suite.row.tests = run.passed + (run.failed ?? 0) + (run.skipped ?? 0);
    suite.lastAt = Math.max(suite.lastAt, run.startedAt);
    if (!run.focused) slowSuites.set(`${project.key}\0${run.suite}`, usual !== null);

    const day = dayOf(run.startedAt);
    let cell = days.get(day);
    if (!cell) days.set(day, (cell = { day, runs: 0, failed: 0, ms: 0, byKind: {} }));
    cell.runs++;
    cell.failed += failed;
    cell.ms += ms;
    cell.byKind[run.kind] = (cell.byKind[run.kind] ?? 0) + ms;

    // One line a suite, for its latest slow run: a suite that was slow nine times is one thing to look at.
    if (usual !== null) slowBy.set(`${project.key}\0${run.suite}`, { project: project.name, suite: run.suite, ms: run.durationMs!, usualMs: usual, at: run.startedAt, runs: (slowBy.get(`${project.key}\0${run.suite}`)?.runs ?? 0) + 1 });
    if (loose) {
      const held = looseBy.get(`${project.key}\0${run.suite}`) ?? { project: project.name, suite: run.suite, runs: 0, ms: 0 };
      held.runs++;
      held.ms += ms;
      looseBy.set(`${project.key}\0${run.suite}`, held);
    }
    if (run.cardId) {
      const key = `${run.cardId}\0${run.suite}`;
      const held = byCard.get(key) ?? { project: project.name, suite: run.suite, runs: 0, card: names.card(run.cardId) ?? "a card that is gone" };
      held.runs++;
      byCard.set(key, held);
    }
    recent.push({
      id: `${run.sessionId}/${run.callId}`,
      at: run.startedAt,
      project: project.name,
      suite: run.suite,
      kind: run.kind,
      command: run.command,
      durationMs: run.durationMs,
      outcome: run.outcome,
      running: run.endedAt === null,
      passed: run.passed,
      failed: run.failed,
      skipped: run.skipped,
      tokens: run.spend ? tokens : null,
      cost: run.spend ? cost : null,
      card: run.cardId ? names.card(run.cardId) : null,
      where: run.machine,
      timedBy: run.timedBy,
      flags: [...(loose ? (["loose"] as const) : []), ...(usual !== null ? (["slow"] as const) : [])],
    });
  }

  const rows: ProjectRow[] = [];
  const slowest: (SuiteRow & { project: string })[] = [];
  for (const { bySuite, ...row } of projects.values()) {
    for (const [name, suite] of bySuite) {
      suite.row.medianMs = median(suite.durations);
      suite.row.slow = slowSuites.get(`${row.key}\0${name}`) === true;
      row.suites.push(suite.row);
      if (suite.row.medianMs !== null) slowest.push({ ...suite.row, project: row.name });
    }
    row.suites.sort((a, b) => b.totalMs - a.totalMs);
    rows.push(row);
  }
  rows.sort((a, b) => b.totalMs - a.totalMs);
  totals.projects = rows.length;
  slowest.sort((a, b) => b.medianMs! - a.medianMs!);
  for (const held of looseBy.values()) flags.push({ flag: "loose", ...held });
  for (const held of slowBy.values()) flags.push({ flag: "slow", ...held });
  for (const held of byCard.values()) if (held.runs >= RERUN_FLAG) flags.push({ flag: "reruns", ...held });
  const order = { loose: 0, slow: 1, reruns: 2 } as const;
  flags.sort((a, b) => order[a.flag] - order[b.flag]);

  return {
    range,
    from,
    to: now,
    at: now,
    live: [...input.live],
    totals,
    projects: rows,
    slowest: slowest.slice(0, SLOWEST),
    days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    flags,
    recent: recent.reverse().slice(0, RECENT),
    since: input.since,
    attribution: ATTRIBUTION,
  };
}

// ---------------------------------------------------------------------------
// In words
// ---------------------------------------------------------------------------

export function tokenWord(tokens: number): string {
  if (tokens >= 1e9) return `${(tokens / 1e9).toFixed(1)}B`;
  if (tokens >= 1e6) return `${(tokens / 1e6).toFixed(1)}M`;
  if (tokens >= 1e3) return `${Math.round(tokens / 1e3)}k`;
  return String(tokens);
}

export function flagLine(flag: TestFlag): string {
  switch (flag.flag) {
    case "loose":
      return `${flag.project} is marked as having no test suite, and ${flag.suite} ran there ${flag.runs === 1 ? "once" : `${flag.runs} times`} (${shortDuration(flag.ms)}).`;
    case "slow":
      return `${flag.suite} in ${flag.project} took ${shortDuration(flag.ms)}; it usually takes ${shortDuration(flag.usualMs)}.${flag.runs > 1 ? ` Slow ${flag.runs} times in this span.` : ""}`;
    case "reruns":
      return `${flag.suite} ran ${flag.runs} times in ${flag.card} (${flag.project}).`;
  }
}

export function liveLine(row: LiveRow, now: number): string {
  return `${row.agent}${row.project ? ` in ${row.project}` : ""}: ${chipName(row.suite)} (${KIND_LABEL[row.kind].toLowerCase()}), ${shortDuration(now - row.since)} so far${row.loose ? ", in a project marked as having no test suite" : ""}`;
}

function suiteLine(suite: SuiteRow): string {
  const parts = [`${suite.runs} run${suite.runs === 1 ? "" : "s"}`];
  if (suite.medianMs !== null) parts.push(`median ${shortDuration(suite.medianMs)}`);
  if (suite.tests !== null) parts.push(`${suite.tests} tests`);
  if (suite.failed) parts.push(`${suite.failed} failed`);
  if (suite.tokens) parts.push(`${tokenWord(suite.tokens)} tokens`);
  if (suite.slow) parts.push("slower than usual");
  return `  ${suite.suite} (${KIND_LABEL[suite.kind].toLowerCase()}): ${parts.join(", ")}`;
}

/**
 * The report as the few lines Kuru is handed: what is testing now, the
 * range's totals, each project's heaviest suites and the flags. Short on
 * purpose, since every line is a line of Kuru's context. Pure.
 */
export function testingText(report: TestingReport, options: { project?: string | null; projects?: number; suites?: number } = {}): string {
  const lines: string[] = [];
  lines.push(report.live.length ? `Testing now:\n${report.live.map((row) => `  ${liveLine(row, report.at)}`).join("\n")}` : "Nothing is testing right now.");
  const wanted = options.project?.toLowerCase();
  const rows = wanted ? report.projects.filter((row) => row.name.toLowerCase().includes(wanted)) : report.projects;
  if (wanted && !rows.length) {
    lines.push(`No run recorded for "${options.project}" in ${RANGE_LABEL[report.range].toLowerCase()}. Projects with runs: ${report.projects.map((row) => row.name).join(", ") || "none"}.`);
    return lines.join("\n");
  }
  if (!report.totals.runs) {
    lines.push(`No run recorded in ${RANGE_LABEL[report.range].toLowerCase()}${report.since === null ? ": recording began with this build and nothing has run since" : ""}.`);
    return lines.join("\n");
  }
  const t = wanted ? rows.reduce((sum, row) => ({ runs: sum.runs + row.runs, failed: sum.failed + row.failed, ms: sum.ms + row.totalMs, tokens: sum.tokens + row.tokens, cost: sum.cost + row.cost }), { runs: 0, failed: 0, ms: 0, tokens: 0, cost: 0 }) : report.totals;
  lines.push(
    `${RANGE_LABEL[report.range]}: ${t.runs} run${t.runs === 1 ? "" : "s"}, ${shortDuration(t.ms)} in all, ${t.failed} failed, ${tokenWord(t.tokens)} tokens (about $${t.cost.toFixed(2)}).`,
  );
  for (const row of rows.slice(0, options.projects ?? 6)) {
    lines.push(`${row.name}${row.loose ? " (no test suite)" : ""}: ${row.runs} run${row.runs === 1 ? "" : "s"}, ${shortDuration(row.totalMs)}`);
    for (const suite of row.suites.slice(0, options.suites ?? 5)) lines.push(suiteLine(suite));
    if (row.suites.length > (options.suites ?? 5)) lines.push(`  and ${row.suites.length - (options.suites ?? 5)} more`);
  }
  if (rows.length > (options.projects ?? 6)) lines.push(`and ${rows.length - (options.projects ?? 6)} more projects`);
  const flags = wanted ? report.flags.filter((flag) => flag.project.toLowerCase().includes(wanted)) : report.flags;
  if (flags.length) lines.push(`Worth a look:\n${flags.slice(0, 8).map((flag) => `  ${flagLine(flag)}`).join("\n")}`);
  lines.push("Tokens: billed by the session after a run started through its first message after it ended.");
  return lines.join("\n");
}

/** A card's runs, for its history: one line each, oldest first. */
export function cardTestLines(runs: readonly TestRun[]): string[] {
  return runs.map((run) => {
    const counts = run.passed !== null ? `, ${run.passed} passed${run.failed ? `, ${run.failed} failed` : ""}` : run.failed ? `, ${run.failed} errors` : "";
    const how = run.endedAt === null ? "still running" : `${run.outcome ?? "ended"}${run.durationMs !== null ? ` in ${shortDuration(run.durationMs)}` : ""}`;
    return `${run.suite} (${KIND_LABEL[run.kind].toLowerCase()}): ${how}${counts}${run.spend ? `, ${tokenWord(tokensOf(run.spend))} tokens` : ""}`;
  });
}
