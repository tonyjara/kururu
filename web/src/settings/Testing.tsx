/**
 * Settings → System → Testing: every test, typecheck, lint and build run the
 * agents make, the way Usage shows their tokens.
 *
 * Asked for by somebody who wanted to "tell if our tests are too slow or too
 * long", so the page is arranged around time: what is running this second,
 * where the range's minutes went by project and by suite, which suites are the
 * slow ones, and the runs themselves at the bottom for when a number needs a
 * face. Tokens ride beside the time everywhere, with the one sentence that
 * says how a run's are counted, because a figure whose rule is not on the page
 * is a figure nobody can use.
 *
 * Nothing here is measured by the page or kept by it. Runs are recorded by the
 * usage ledger's reader and the agents' hooks, at no cost in tokens
 * (`server/src/testing.ts`), and all the arithmetic is the server's
 * (`shared/testreport.ts`). Fetched while the page is open and never
 * otherwise, as Usage is, and more often than Usage because a run that is
 * going on is the thing most likely to be watched; the list of what is running
 * now counts up in the page between answers.
 */
import { useEffect, useRef, useState } from "react";
import { KIND_LABEL, shortDuration, TEST_KINDS } from "../../../shared/testing";
import { flagLine, RANGE_LABEL, TEST_RETENTION_DAYS, TESTING_RANGES, type ProjectRow, type RecentRun, type TestingRange, type TestingReport } from "../../../shared/testreport";
import { RankedBars } from "../charts/bars";
import { compact, dollars, percent } from "../charts/format";
import { ChartFrame, DataTable, inkOf } from "../charts/frame";
import { TestChip } from "../components/TestChip";
import { Banner, Details, Empty, errorText, Group, Mono, P, Readout, Segments, Tile, Tiles, when } from "./ui";

/** Often enough that a run which ended is seen to have, seldom enough to be nothing on the server's loop. */
const EVERY_MS = 20_000;

function dayWord(day: string): string {
  return new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function result(run: RecentRun): string {
  if (run.running) return "running";
  if (run.outcome === "pass") return "passed";
  if (run.outcome === "fail") return "failed";
  if (run.outcome === "stopped") return "stopped";
  return "no result seen";
}

function tests(run: RecentRun): string {
  if (run.passed === null) return run.failed ? `${run.failed} errors` : "–";
  const parts = [`${run.passed} passed`];
  if (run.failed) parts.push(`${run.failed} failed`);
  if (run.skipped) parts.push(`${run.skipped} skipped`);
  return parts.join(", ");
}

export function TestingPage({ narrow }: { narrow: boolean }) {
  const [range, setRange] = useState<TestingRange>("week");
  const [report, setReport] = useState<TestingReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const latest = useRef(0);

  useEffect(() => {
    const ask = async () => {
      const asked = ++latest.current;
      setBusy(true);
      try {
        const response = await fetch(`/api/testing/report?range=${range}`);
        const body = (await response.json()) as TestingReport & { error?: string };
        if (asked !== latest.current) return;
        if (!response.ok) throw new Error(body.error ?? `${response.status} ${response.statusText}`);
        setReport(body);
        setError(null);
      } catch (err) {
        if (asked === latest.current) setError(errorText(err));
      } finally {
        if (asked === latest.current) setBusy(false);
      }
    };
    void ask();
    const timer = setInterval(() => void ask(), EVERY_MS);
    return () => {
      clearInterval(timer);
      latest.current++;
    };
  }, [range]);

  const filters = (
    <div className="ch-filters">
      {narrow ? (
        <select className="st-select" value={range} aria-label="Range" onChange={(event) => setRange(event.target.value as TestingRange)}>
          {TESTING_RANGES.map((id) => (
            <option key={id} value={id}>
              {RANGE_LABEL[id]}
            </option>
          ))}
        </select>
      ) : (
        <Segments label="Range" value={range} options={TESTING_RANGES.map((id) => [id, RANGE_LABEL[id]] as const)} onChange={setRange} />
      )}
    </div>
  );

  if (!report) {
    return (
      <>
        {error && <Banner tone="bad">{error}</Banner>}
        {filters}
        {!error && <Empty>Reading the ledger…</Empty>}
      </>
    );
  }
  return (
    <>
      {error && <Banner tone="bad">{error}</Banner>}
      {filters}
      <div className={`ch-page${busy ? " ch-page-busy" : ""}`}>
        <Report report={report} />
      </div>
    </>
  );
}

/** The page under its filter, for a report already in hand. */
export function Report({ report }: { report: TestingReport }) {
  const { totals } = report;
  const longest = report.projects.reduce((n, row) => Math.max(n, row.totalMs), 0);
  return (
    <>
      <Group title="Running now" foot="From each agent's own hooks, so only Claude agents on this computer are listed here. A run by Codex or on another machine is recorded once it has finished.">
        {report.live.length === 0 && <Empty>Nothing is testing right now.</Empty>}
        {report.live.map((row) => (
          <Readout key={row.agentId} label={row.agent} hint={row.project ?? undefined} tone={row.loose ? "warn" : undefined} value={<TestChip testing={row} />} />
        ))}
      </Group>

      {totals.runs === 0 ? (
        <Group>
          <Empty>
            {report.since === null
              ? "No run has been recorded yet. Recording began with this build: the next test, typecheck, lint or build an agent runs will be here."
              : `No run in ${RANGE_LABEL[report.range].toLowerCase()}.`}
          </Empty>
        </Group>
      ) : (
        <>
          <Tiles>
            <Tile value={totals.runs.toLocaleString("en-US")} label="Runs" under={`${totals.projects} project${totals.projects === 1 ? "" : "s"}`} />
            <Tile value={shortDuration(totals.ms)} label="Time running" />
            <Tile value={percent(totals.failed / totals.runs)} label="Failed" under={`${totals.failed} of ${totals.runs}`} />
            <Tile value={compact(totals.tokens)} label="Tokens around runs" under={`${dollars(totals.cost)} at list price`} />
          </Tiles>
          <p className="st-foot ch-span">{report.attribution} Dollars are an estimate at API list prices; you pay a subscription.</p>

          {report.flags.length > 0 && (
            <Group title="Worth a look" foot="Worked out when this page is opened, from the runs before each one. Nobody is told: a notice would cost the tokens this page counts.">
              {report.flags.map((flag, i) => (
                <Readout
                  key={i}
                  label={flag.flag === "loose" ? "No test suite here" : flag.flag === "slow" ? "Slower than usual" : "Run again and again"}
                  hint={flagLine(flag)}
                  tone="warn"
                  value={flag.flag === "slow" ? shortDuration(flag.ms) : `${flag.runs}×`}
                />
              ))}
            </Group>
          )}

          <ChartFrame
            title="Where the time went"
            lead="By project, in time spent running. A project is a workspace, or the folder a run was made in when no workspace claims its session."
            table={() => (
              <DataTable
                head={["Project", "Runs", "Failed", "Time", "Tokens", "Estimate"]}
                rows={report.projects.map((row) => [row.name + (row.loose ? " (no test suite)" : ""), row.runs.toLocaleString("en-US"), String(row.failed), shortDuration(row.totalMs), compact(row.tokens), dollars(row.cost)])}
              />
            )}
          >
            <RankedBars
              bars={report.projects.map((row) => ({
                key: row.key,
                label: row.name,
                value: row.totalMs,
                share: longest && totals.ms ? row.totalMs / totals.ms : 0,
                ink: inkOf("rest"),
                sub: row.loose ? "no test suite" : undefined,
                rows: [
                  { value: shortDuration(row.totalMs), label: "running" },
                  { value: row.runs.toLocaleString("en-US"), label: row.failed ? `runs, ${row.failed} failed` : "runs" },
                  { value: compact(row.tokens), label: "tokens" },
                ],
              }))}
            />
          </ChartFrame>

          {report.projects.map((row) => (
            <Suites key={row.key} row={row} />
          ))}

          {report.slowest.length > 0 && (
            <ChartFrame
              title="The slowest suites"
              lead="By the median of their runs in this range, so one bad run does not put a suite here."
              table={() => (
                <DataTable
                  head={["Suite", "Project", "Median", "Runs", "Failed"]}
                  numericFrom={2}
                  rows={report.slowest.map((suite) => [suite.suite, suite.project, shortDuration(suite.medianMs ?? 0), String(suite.runs), String(suite.failed)])}
                />
              )}
            >
              <RankedBars
                bars={report.slowest.map((suite) => ({
                  key: `${suite.project}/${suite.suite}`,
                  label: suite.suite,
                  value: suite.medianMs ?? 0,
                  share: 0,
                  ink: inkOf(TEST_KINDS.indexOf(suite.kind) % 6),
                  sub: `${suite.project} · ${KIND_LABEL[suite.kind].toLowerCase()}`,
                  rows: [
                    { value: shortDuration(suite.medianMs ?? 0), label: "median" },
                    { value: String(suite.runs), label: suite.failed ? `runs, ${suite.failed} failed` : "runs" },
                    { value: shortDuration(suite.totalMs), label: "in all" },
                  ],
                }))}
              />
            </ChartFrame>
          )}

          {report.days.length > 1 && (
            <Group title="By day">
              <div className="ch-tablewrap">
              <DataTable
                head={["Day", "Runs", "Failed", "Time", ...TEST_KINDS.filter((kind) => report.days.some((day) => day.byKind[kind])).map((kind) => KIND_LABEL[kind])]}
                rows={report.days.map((day) => [
                  dayWord(day.day),
                  String(day.runs),
                  String(day.failed),
                  shortDuration(day.ms),
                  ...TEST_KINDS.filter((kind) => report.days.some((each) => each.byKind[kind])).map((kind) => (day.byKind[kind] ? shortDuration(day.byKind[kind]!) : "–")),
                ])}
              />
              </div>
            </Group>
          )}

          <Group title="The runs" foot={`The latest ${report.recent.length}. A command is kept as the part that is the run, with anything shaped like a secret taken out; its output is never kept.`}>
            <div className="ch-tablewrap">
            <DataTable
              head={["When", "Suite", "Project", "Took", "Result", "Tests", "Tokens"]}
              numericFrom={3}
              rows={report.recent.map((run) => [
                when(run.at),
                <span key="s" title={`${run.command}${run.card ? `\nCard: ${run.card}` : ""}${run.where ? `\nOn ${run.where}` : ""}${run.timedBy === "next" ? "\nTimed to the agent's next message: its log has no results in it." : ""}`}>
                  <Mono>{run.suite}</Mono>
                  {run.flags.includes("slow") ? " · slow" : ""}
                  {run.flags.includes("loose") ? " · no suite here" : ""}
                </span>,
                run.project,
                run.durationMs === null ? "–" : shortDuration(run.durationMs),
                result(run),
                tests(run),
                run.tokens === null ? "–" : compact(run.tokens),
              ])}
            />
            </div>
          </Group>
        </>
      )}

      <Details summary="What is recorded, and what is only best effort">
        <P>
          A run is a Bash call whose command is a test runner, a typechecker, a linter, a build, or a package script named for one. Kururu reads it off the transcript the agent's program already writes, and off the hook that already runs before each tool call, so recording it costs no token and asks nothing of the agent. Marking a workspace as having no test suite is in Settings → Workspaces.
        </P>
        <P>
          Claude agents on this computer are timed by Claude Code itself and show a chip while they run. Codex runs are read from its log after the fact, with no chip. An agent on another machine is read over ssh without its tool results, so its run ends at the agent's next message and has no counts. Another node records its own runs and they are not shown here yet.
        </P>
      </Details>

      <p className="st-foot ch-span">
        {report.since ? `Recording since ${when(report.since)}. ` : ""}Runs are kept {TEST_RETENTION_DAYS} days, on this computer only: they are in no backup.
      </p>
    </>
  );
}

function Suites({ row }: { row: ProjectRow }) {
  return (
    <Details summary={`${row.name}: ${row.suites.length} suite${row.suites.length === 1 ? "" : "s"}, ${row.runs} run${row.runs === 1 ? "" : "s"}, ${shortDuration(row.totalMs)}${row.loose ? " · marked as having no test suite" : ""}`}>
      <div className="ch-tablewrap">
      <DataTable
        head={["Suite", "Kind", "Runs", "Failed", "Median", "In all", "Tests", "Tokens", "Est."]}
        numericFrom={2}
        rows={row.suites.map((suite) => [
          <span key="s">
            <Mono>{suite.suite}</Mono>
            {suite.slow ? " · slower than usual" : ""}
          </span>,
          KIND_LABEL[suite.kind],
          String(suite.runs),
          String(suite.failed),
          suite.medianMs === null ? "–" : shortDuration(suite.medianMs),
          shortDuration(suite.totalMs),
          suite.tests === null ? "–" : suite.tests.toLocaleString("en-US"),
          compact(suite.tokens),
          dollars(suite.cost),
        ])}
      />
      </div>
    </Details>
  );
}
