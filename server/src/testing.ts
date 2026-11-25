/**
 * What is testing right now, and the answer to anybody who asks what testing
 * has cost.
 *
 * The record of a test run is the ledger's (`usage/testlog.ts`), read off the
 * transcripts. This is the part a transcript cannot be: live. The hook that
 * runs before every tool call says a test is starting, in the report it was
 * sending anyway (`report-cli.ts`), and that is the chip on the agent's row
 * and card for as long as the run takes. So this holds a small map in memory,
 * agent by agent, and nothing else of its own.
 *
 * **A chip ends four ways, because the first is not always installed.** The
 * end hook says so, at once, for an agent whose launch carried it. Failing
 * that the ledger's reader says so when it reads the result, a second or two
 * after the agent's next tool call. Failing that the agent's turn ends, which
 * no run in the foreground outlives. And a run nobody has heard from in six
 * hours is not drawn. None of them is a timer: each is something that was
 * already happening.
 *
 * **Nothing here spends a token or tells anybody anything.** No pty is typed
 * into and Kuru is not told that a run started, failed or was slow; Kuru
 * hears about testing when it calls the tool, in a few lines. A restart
 * forgets the chips, which is right: what was running a server ago is the
 * claim least worth keeping, and the row in the ledger is still there.
 *
 * The hook's times are also the better ones, so its start and end are written
 * into the same row the reader writes, and win there. See `testlog.ts`.
 */
import { adoptTestReport, isSuiteKind, type LiveTest } from "../../shared/testing";
import { BASELINE_DAYS, buildTestingReport, cardTestLines, rangeStart, testingText, type LiveRow, type TestingNames, type TestingRange, type TestingReport } from "../../shared/testreport";
import type { Ledger } from "./usage/store";
import { oldestTestRun, recordTestEvent, testRunsBetween, testRunsOfCard, type TestEvent } from "./usage/testlog";

/** A run nobody has ended in this long is not still running: its agent was closed, or its hook never came. */
const STALE_MS = 6 * 3600_000;

interface Live {
  sessionId: string;
  suite: string;
  kind: LiveTest["kind"];
  since: number;
  background: boolean;
  loose: boolean;
}

export interface TestingDeps {
  ledger: () => Ledger | null;
  /** The workspace an agent's terminal is in, and whether it is marked as having no test suite. */
  placeOf: (agentId: string) => { workspace: string; loose: boolean } | null;
  cwdOf: (agentId: string) => string | null;
  /** An agent's chip appeared or went. */
  changed: () => void;
  log: (line: string) => void;
  now?: () => number;
}

export class Testing {
  private readonly live = new Map<string, Map<string, Live>>();
  private deps: TestingDeps | null = null;

  /** Given what it needs once the server has it: this is built before the ledger is opened. */
  bind(deps: TestingDeps): void {
    this.deps = deps;
  }

  private now(): number {
    return this.deps?.now?.() ?? Date.now();
  }

  /**
   * A hook's `test` field, off `/api/report`. True when it was one. The agent
   * is the terminal the hook ran in, which the endpoint has already checked
   * is one of ours.
   */
  hook(agentId: string, raw: unknown): boolean {
    const report = adoptTestReport(raw);
    if (!report) return false;
    const at = this.now();
    const runs = this.live.get(agentId);
    if (report.phase === "start") {
      const held = runs?.get(report.callId);
      if (held) {
        // The call came back at once: the command runs on behind it.
        if (report.background && !held.background) {
          held.background = true;
          this.write({ type: "background", sessionId: report.session, callId: report.callId });
        }
        return true;
      }
      const loose = isSuiteKind(report.call.kind) && this.deps?.placeOf(agentId)?.loose === true;
      const map = runs ?? new Map<string, Live>();
      map.set(report.callId, { sessionId: report.session, suite: report.call.suite, kind: report.call.kind, since: at, background: report.background === true, loose });
      this.live.set(agentId, map);
      this.write({ type: "start", by: "hook", sessionId: report.session, callId: report.callId, program: "claude", call: report.call, background: report.background === true, cwd: this.deps?.cwdOf(agentId) ?? null, at });
      this.deps?.changed();
      return true;
    }
    this.write({
      type: "end",
      by: "hook",
      sessionId: report.session,
      callId: report.callId,
      at,
      durationMs: report.durationMs ?? null,
      exit: report.exit ?? null,
      stopped: report.stopped === true,
      counts: report.counts ?? null,
      call: report.call,
      program: "claude",
      cwd: this.deps?.cwdOf(agentId) ?? null,
    });
    this.drop(agentId, report.callId);
    return true;
  }

  /** The reader wrote these down. An end it saw is an end for the chip too. */
  sawTests(events: readonly TestEvent[]): void {
    for (const event of events) {
      if (event.type !== "end") continue;
      for (const [agentId, runs] of this.live) if (runs.has(event.callId)) this.drop(agentId, event.callId);
    }
  }

  /** An agent's turn ended, and with it every run it was waiting on. One in the background carries on. */
  turnEnded(agentId: string): void {
    const runs = this.live.get(agentId);
    if (!runs) return;
    let any = false;
    for (const [callId, run] of runs) {
      if (run.background) continue;
      runs.delete(callId);
      any = true;
    }
    if (!runs.size) this.live.delete(agentId);
    if (any) this.deps?.changed();
  }

  /** A terminal is gone. */
  forget(agentId: string): void {
    if (this.live.delete(agentId)) this.deps?.changed();
  }

  private drop(agentId: string, callId: string): void {
    const runs = this.live.get(agentId);
    if (!runs?.delete(callId)) return;
    if (!runs.size) this.live.delete(agentId);
    this.deps?.changed();
  }

  private write(event: TestEvent): void {
    const ledger = this.deps?.ledger();
    if (!ledger) return;
    try {
      recordTestEvent(ledger, event);
    } catch (err) {
      // A busy or full ledger: the chip is still drawn, and the reader will write the run from the transcript.
      this.deps?.log(`kururu: a test run could not be written down: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** What an agent's row draws: its longest-running test, and how many more it has going. */
  of(agentId: string): LiveTest | null {
    const runs = this.live.get(agentId);
    if (!runs) return null;
    const now = this.now();
    let first: Live | null = null;
    let count = 0;
    for (const [callId, run] of runs) {
      if (now - run.since > STALE_MS) {
        runs.delete(callId);
        continue;
      }
      count++;
      if (!first || run.since < first.since) first = run;
    }
    if (!runs.size) this.live.delete(agentId);
    if (!first) return null;
    return { suite: first.suite, kind: first.kind, since: first.since, ...(first.loose ? { loose: true } : {}), ...(count > 1 ? { more: count - 1 } : {}) };
  }

  /** Every agent with a run going, named. */
  rows(nameOf: (agentId: string) => string | null): LiveRow[] {
    const out: LiveRow[] = [];
    for (const agentId of [...this.live.keys()]) {
      const run = this.of(agentId);
      const agent = nameOf(agentId);
      if (!run || agent === null) continue;
      out.push({ ...run, agentId, agent, project: this.deps?.placeOf(agentId)?.workspace ?? null });
    }
    return out.sort((a, b) => a.since - b.since);
  }

  /** The Testing page's object, or null without a ledger. */
  report(range: TestingRange, names: TestingNames, nameOf: (agentId: string) => string | null): TestingReport | null {
    const ledger = this.deps?.ledger();
    if (!ledger) return null;
    const now = this.now();
    return buildTestingReport({
      range,
      now,
      runs: testRunsBetween(ledger, rangeStart(range, now) - BASELINE_DAYS * 86_400_000, now + 1),
      live: this.rows(nameOf),
      names,
      since: oldestTestRun(ledger),
    });
  }

  /** The same, as the lines Kuru is given. */
  text(range: TestingRange, names: TestingNames, nameOf: (agentId: string) => string | null, project: string | null): string {
    const report = this.report(range, names, nameOf);
    if (!report) return "The usage ledger did not open, so no test run is being recorded. Why is in the server's log.";
    return testingText(report, { project });
  }

  /** A card's runs, for its history. */
  cardLines(cardId: string): { at: number; text: string }[] {
    const ledger = this.deps?.ledger();
    if (!ledger) return [];
    try {
      const runs = testRunsOfCard(ledger, cardId);
      const lines = cardTestLines(runs);
      return runs.map((run, i) => ({ at: run.startedAt, text: lines[i]! }));
    } catch {
      return [];
    }
  }
}
