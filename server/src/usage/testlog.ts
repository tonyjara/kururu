/**
 * The test runs, in the ledger: one row per run, written by whichever of two
 * witnesses spoke, and added to by the other.
 *
 * A run is seen twice. The hook sees it live (`server/src/testing.ts`): about
 * when the command starts and when it returns, with Claude Code's own measure
 * of how long it took. The transcript sees it for certain (`sweep.ts`): the
 * call and its result are lines the reader was reading anyway. Neither is
 * enough alone. A hook reaches only agents on this node whose launch carried
 * it, and it is a process started beside the tool, so the moment it reports
 * is late by however long it took to start. A transcript is read a second or
 * a few minutes after the fact, and the gap between its two timestamps has
 * any permission prompt in it. So both write the same row, keyed by session
 * and call id, and the merge below says who is believed for what: **the
 * transcript for the two instants, the hook's `duration_ms` for the length,
 * either for the outcome, and the first to arrive for what the command line
 * says.**
 *
 * In `usage.db` rather than a file of its own, because a run's tokens are a
 * sum over that file's `messages` and whose it was is that file's `sessions`
 * row; and because that file is in no copy and no backup, which is where a
 * command line belongs. It is the ledger's one column of words, and narrow:
 * the part of the line that is the run, redacted before it gets here
 * (`shared/testing.ts`). The output never arrives at all.
 *
 * **A run's tokens are summed twice**: when it ends, and again when its
 * session's next message has been read, which is the message that read the
 * result and the last one counted. See `ATTRIBUTION` in `shared/testreport.ts`.
 */
import type { TestCall, TestCounts, TestOutcome } from "../../../shared/testing";
import { outcomeOf } from "../../../shared/testing";
import type { TestRun, TestSpend } from "../../../shared/testreport";
import type { Ledger } from "./store";

export const TEST_RUNS = `
create table if not exists test_runs (
  session_id text not null, call_id text not null, program text not null,
  kind text not null, runner text not null, suite text not null, command text not null,
  focused integer not null, background integer not null, cwd text,
  started_at integer not null, start_by text not null,
  ended_at integer, duration_ms integer, timed_by text not null,
  exit_code integer, outcome text, passed integer, failed integer, skipped integer,
  spend_messages integer, spend_input integer, spend_cache_write integer, spend_cache_read integer,
  spend_output integer, spend_cost real, spend_final integer not null default 0,
  primary key (session_id, call_id)
) without rowid;
create index if not exists test_runs_at on test_runs(started_at);
create index if not exists test_runs_open on test_runs(spend_final, session_id);
`;

/** Who saw it: the hook, the transcript, or (for a machine's log, which has no results) the session's next message. */
export type TestWitness = "hook" | "log" | "next";

export type TestEvent =
  | { type: "start"; by: "hook" | "log"; sessionId: string; callId: string; program: string; call: TestCall; background: boolean; cwd: string | null; at: number }
  /** The call returned at once and the command runs on behind it. */
  | { type: "background"; sessionId: string; callId: string }
  | {
      type: "end";
      by: TestWitness;
      sessionId: string;
      callId: string;
      at: number;
      /** The run's own length when the witness measured it, rather than the gap between two timestamps. */
      durationMs: number | null;
      exit: number | null;
      stopped: boolean;
      counts: TestCounts | null;
      /** For an end with no start on record: a hook that outlived a restart says what the run was. */
      call?: TestCall;
      program?: string;
      cwd?: string | null;
    };

type Row = Record<string, unknown>;

/** A run that has started and not ended, as the reader needs it: what to look for in the rest of the file. */
export interface OpenRun {
  sessionId: string;
  callId: string;
  background: boolean;
  startedAt: number;
}

/**
 * When a run ended and how long it took, from what is on record and one more
 * witness. The instant is the transcript's whenever it has spoken, since a
 * hook's is the moment its report arrived; the length is Claude Code's own
 * when a hook brought it (`timed_by` is then `hook`), and the gap between the
 * two instants otherwise. A session's next message is believed only until
 * anybody else speaks.
 */
function timingOf(held: Row, event: { by: TestWitness; at: number; durationMs: number | null }): { endedAt: number; durationMs: number; timedBy: TestWitness } {
  const startedAt = held.started_at as number;
  const ended = (held.ended_at as number | null) ?? null;
  const by = held.timed_by as TestWitness;
  const measured = ended !== null && by === "hook" ? (held.duration_ms as number | null) : null;
  const span = (endedAt: number) => Math.max(0, endedAt - startedAt);
  if (event.by === "next") return ended === null ? { endedAt: event.at, durationMs: span(event.at), timedBy: "next" } : { endedAt: ended, durationMs: (held.duration_ms as number | null) ?? span(ended), timedBy: by };
  if (event.by === "log") {
    // The instant is this one's. The length stays the hook's if it brought one, and is a stated wall time (Codex) before it is a gap.
    if (measured !== null) return { endedAt: event.at, durationMs: measured, timedBy: "hook" };
    return { endedAt: event.at, durationMs: Math.max(0, event.durationMs ?? span(event.at)), timedBy: "log" };
  }
  const endedAt = ended !== null && by === "log" ? ended : event.at;
  if (event.durationMs !== null) return { endedAt, durationMs: Math.max(0, event.durationMs), timedBy: "hook" };
  return ended !== null && by === "log" ? { endedAt, durationMs: (held.duration_ms as number | null) ?? span(endedAt), timedBy: "log" } : { endedAt, durationMs: span(endedAt), timedBy: "hook" };
}

/** One event, written. Inside a transaction of the caller's. */
export function applyTestEvent(ledger: Ledger, event: TestEvent): void {
  if (event.type === "start") {
    // The earlier of the two starts: the transcript's is when the call was made, the hook's when its report got here.
    ledger.stmt(
      `insert into test_runs (session_id, call_id, program, kind, runner, suite, command, focused, background, cwd, started_at, start_by, timed_by)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(session_id, call_id) do update set
         cwd = coalesce(test_runs.cwd, excluded.cwd),
         background = max(test_runs.background, excluded.background),
         started_at = min(test_runs.started_at, excluded.started_at),
         start_by = case when excluded.start_by = 'log' then 'log' else test_runs.start_by end`,
    ).run(event.sessionId, event.callId, event.program, event.call.kind, event.call.runner, event.call.suite, event.call.command, event.call.focused ? 1 : 0, event.background ? 1 : 0, event.cwd, event.at, event.by, event.by);
    return;
  }
  if (event.type === "background") {
    ledger.stmt("update test_runs set background = 1 where session_id = ? and call_id = ?").run(event.sessionId, event.callId);
    return;
  }
  let held = ledger.stmt("select * from test_runs where session_id = ? and call_id = ?").get(event.sessionId, event.callId) as Row | undefined;
  if (!held) {
    // A run whose start nobody wrote down: only an end that says what it was can make a row.
    if (!event.call) return;
    const started = event.at - (event.durationMs ?? 0);
    applyTestEvent(ledger, { type: "start", by: event.by === "next" ? "log" : event.by, sessionId: event.sessionId, callId: event.callId, program: event.program ?? "claude", call: event.call, background: false, cwd: event.cwd ?? null, at: started });
    held = ledger.stmt("select * from test_runs where session_id = ? and call_id = ?").get(event.sessionId, event.callId) as Row;
  }
  const timing = timingOf(held, event);
  // The outcome is whichever witness knew more: counts from either, an exit code from either.
  const exit = event.exit ?? (held.exit_code as number | null) ?? null;
  const counts: TestCounts | null = event.counts ?? (held.passed !== null || held.failed !== null ? { passed: held.passed as number | null, failed: held.failed as number | null, skipped: held.skipped as number | null } : null);
  const outcome: TestOutcome | null = outcomeOf(exit, counts, event.stopped || held.outcome === "stopped") ?? (held.outcome as TestOutcome | null) ?? null;
  ledger.stmt(
    `update test_runs set ended_at = ?, duration_ms = ?, timed_by = ?, exit_code = ?, outcome = ?, passed = ?, failed = ?, skipped = ?, runner = ?
     where session_id = ? and call_id = ?`,
  ).run(
    timing.endedAt,
    timing.durationMs,
    timing.timedBy,
    exit,
    outcome,
    counts?.passed ?? null,
    counts?.failed ?? null,
    counts?.skipped ?? null,
    // A package script's runner is named by the summary line it printed, when its own name did not say.
    held.runner === "script" && event.counts?.runner ? event.counts.runner : (held.runner as string),
    event.sessionId,
    event.callId,
  );
}

/** How long after it ended a run's tokens stop being looked at again: a session that said nothing more has nothing more to add. */
const SPEND_SETTLES_MS = 3600_000;

/**
 * Sum what each of these sessions' ended runs cost, for the runs not yet
 * final. Inside a transaction of the caller's. A run is final once the
 * session has a message after its end, or an hour has passed without one.
 */
export function settleTestSpend(ledger: Ledger, sessionIds: Iterable<string>, now = Date.now()): void {
  for (const sessionId of sessionIds) {
    const open = ledger.stmt("select call_id, started_at, ended_at from test_runs where spend_final = 0 and session_id = ? and ended_at is not null").all(sessionId) as Row[];
    for (const run of open) {
      const ended = run.ended_at as number;
      const next = (ledger.stmt("select min(at) as at from messages where session_id = ? and at > ?").get(sessionId, ended) as Row).at as number | null;
      const sum = ledger
        .stmt(
          `select count(*) as messages, coalesce(sum(input), 0) as input, coalesce(sum(cache_write_5m + cache_write_1h), 0) as cache_write,
                  coalesce(sum(cache_read), 0) as cache_read, coalesce(sum(output), 0) as output, coalesce(sum(cost_est), 0) as cost
           from messages where session_id = ? and at > ? and at <= ?`,
        )
        .get(sessionId, run.started_at as number, next ?? ended) as Row;
      ledger
        .stmt(
          `update test_runs set spend_messages = ?, spend_input = ?, spend_cache_write = ?, spend_cache_read = ?, spend_output = ?, spend_cost = ?, spend_final = ?
           where session_id = ? and call_id = ?`,
        )
        .run(sum.messages as number, sum.input as number, sum.cache_write as number, sum.cache_read as number, sum.output as number, sum.cost as number, next !== null || now - ended > SPEND_SETTLES_MS ? 1 : 0, sessionId, run.call_id as string);
    }
  }
}

/** One event from outside a reader's pass, which is a hook's: written and summed in a transaction of its own. */
export function recordTestEvent(ledger: Ledger, event: TestEvent): void {
  ledger.tx(() => {
    applyTestEvent(ledger, event);
    if (event.type === "end") settleTestSpend(ledger, [event.sessionId]);
  });
}

/** Runs with no end on record, newer than `since`: what the reader still has to find results for after a restart. */
export function openTestRuns(ledger: Ledger, since: number): OpenRun[] {
  const rows = ledger.stmt("select session_id, call_id, background, started_at from test_runs where ended_at is null and started_at > ?").all(since) as Row[];
  return rows.map((row) => ({ sessionId: row.session_id as string, callId: row.call_id as string, background: row.background === 1, startedAt: row.started_at as number }));
}

const RUN_COLUMNS = `r.*, s.workspace_key as s_workspace, s.card_id as s_card, s.agent_id as s_agent, s.machine as s_machine, s.cwd as s_cwd`;

function runOf(row: Row): TestRun {
  const spend: TestSpend | null =
    row.spend_messages === null || row.spend_messages === undefined
      ? null
      : {
          messages: row.spend_messages as number,
          input: row.spend_input as number,
          cacheWrite: row.spend_cache_write as number,
          cacheRead: row.spend_cache_read as number,
          output: row.spend_output as number,
          cost: row.spend_cost as number,
        };
  return {
    sessionId: row.session_id as string,
    callId: row.call_id as string,
    program: row.program as string,
    kind: row.kind as TestRun["kind"],
    runner: row.runner as string,
    suite: row.suite as string,
    command: row.command as string,
    focused: row.focused === 1,
    background: row.background === 1,
    cwd: (row.cwd as string | null) ?? (row.s_cwd as string | null) ?? null,
    startedAt: row.started_at as number,
    endedAt: (row.ended_at as number | null) ?? null,
    durationMs: (row.duration_ms as number | null) ?? null,
    timedBy: row.timed_by as TestRun["timedBy"],
    exit: (row.exit_code as number | null) ?? null,
    outcome: (row.outcome as TestOutcome | null) ?? null,
    passed: (row.passed as number | null) ?? null,
    failed: (row.failed as number | null) ?? null,
    skipped: (row.skipped as number | null) ?? null,
    spend,
    workspaceKey: (row.s_workspace as string | null) ?? null,
    cardId: (row.s_card as string | null) ?? null,
    agentId: (row.s_agent as string | null) ?? null,
    machine: (row.s_machine as string | null) ?? null,
  };
}

/** Every run that started in a span, oldest first, with whose it was. */
export function testRunsBetween(ledger: Ledger, from: number, to: number): TestRun[] {
  const rows = ledger.stmt(`select ${RUN_COLUMNS} from test_runs r left join sessions s on s.id = r.session_id where r.started_at >= ? and r.started_at < ? order by r.started_at`).all(from, to) as Row[];
  return rows.map(runOf);
}

/** A card's runs, oldest first, across every session it has had. */
export function testRunsOfCard(ledger: Ledger, cardId: string, limit = 200): TestRun[] {
  const rows = ledger
    .stmt(`select ${RUN_COLUMNS} from test_runs r join sessions s on s.id = r.session_id where s.card_id = ? order by r.started_at desc limit ?`)
    .all(cardId, limit) as Row[];
  return rows.map(runOf).reverse();
}

/** When the oldest run on record started, or null for none. */
export function oldestTestRun(ledger: Ledger): number | null {
  return ((ledger.stmt("select min(started_at) as at from test_runs").get() as Row).at as number | null) ?? null;
}

/**
 * Let go of runs older than the retention, and stop waiting on ones that
 * will never be summed again. Called from the reader's sweep, every few
 * minutes; an indexed delete of nothing, almost every time.
 */
export function pruneTestRuns(ledger: Ledger, before: number, now = Date.now()): void {
  ledger.tx(() => {
    ledger.stmt("delete from test_runs where started_at < ?").run(before);
    const stale = ledger.stmt("select distinct session_id from test_runs where spend_final = 0 and ended_at is not null and ended_at < ?").all(now - SPEND_SETTLES_MS) as Row[];
    settleTestSpend(ledger, stale.map((row) => row.session_id as string), now);
  });
}
