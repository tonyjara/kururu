/**
 * The Usage page's one question to the ledger: what did this range spend, and on
 * whom. The arithmetic is in `shared/usagereport.ts`; this is the half that has a
 * database and a disk, and it is thin on purpose so that everything a test wants
 * to hold can be held without either.
 *
 * Synchronous, because `node:sqlite` is, and that is the budget this is written
 * against: it runs on the event loop every terminal's output goes through, so
 * the cost has to stay a few milliseconds however large the ledger gets. That is
 * what `session_days` is for. Only the two ends of a span, a single day drawn by
 * the hour and one strip per session on screen ever touch `messages`.
 *
 * `cleanupPeriodDays` is read here, one number out of a settings file, and never
 * written. It is the user's decision how long Claude Code keeps a transcript;
 * the ledger keeps the numbers either way, and the page says what the setting is
 * so that the decision can be made by looking.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dayBounds, dayOf, type LedgerStatus } from "../../../shared/usage";
import {
  buildReport,
  contextStrip,
  rangeBounds,
  type ContextStrip,
  type RetentionRow,
  type UsageDimension,
  type UsageNames,
  type UsageRange,
  type UsageReport,
} from "../../../shared/usagereport";
import type { Ledger } from "./store";

/** Claude Code's default when nothing says otherwise, from its settings reference, read 2026-10-31. */
export const CLEANUP_DEFAULT_DAYS = 30;

/** How many sessions the context strip draws. Small multiples past this are a wall. */
const CONTEXT_STRIPS = 8;

export interface ReportDeps {
  names: UsageNames;
  /** When the account's week next resets, from the latest reading, if anybody has read it. */
  weekResetsAt: number | null;
  weekOwner: UsageReport["weekOwner"];
  retention: RetentionRow[];
  status: LedgerStatus;
}

/** The transcript retention a login's settings file states, or Claude Code's default. A number or nothing, and nothing else out of the file. */
export function readRetention(claudeDir: string, who: string): RetentionRow {
  try {
    const stated = (JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8")) as { cleanupPeriodDays?: unknown }).cleanupPeriodDays;
    if (typeof stated === "number" && Number.isFinite(stated) && stated > 0) return { who, days: stated, stated: true };
  } catch {
    // No file, or one that does not parse: Claude Code then uses its default too.
  }
  return { who, days: CLEANUP_DEFAULT_DAYS, stated: false };
}

export function usageReport(ledger: Ledger, range: UsageRange, by: UsageDimension, now: number, deps: ReportDeps): UsageReport {
  const bounds = rangeBounds(range, now, deps.weekResetsAt);
  const cells = ledger.usageCells(bounds.from, bounds.to);
  // A range that is one day is drawn by the hour; `bucketsFor` makes the same test.
  const oneDay = bounds.from > 0 && dayOf(bounds.from) === dayOf(bounds.to - 1);
  const facts = ledger.usageFacts();
  const report = buildReport({
    by,
    range: bounds,
    at: now,
    cells,
    fineCells: oneDay ? ledger.usageQuarters(bounds.from, bounds.to) : undefined,
    previousCells: bounds.previous ? ledger.usageCells(bounds.previous.from, bounds.previous.to) : null,
    facts,
    says: ledger.usageSays(),
    allTime: ledger.usageAllTime(),
    names: deps.names,
    limits: ledger.usageLimits(Math.max(bounds.from, deps.status.oldestDay ? dayBounds(deps.status.oldestDay).start : 0), bounds.to),
    oldestDay: deps.status.oldestDay,
    retention: deps.retention,
    foot: {
      oldestDay: deps.status.oldestDay,
      skipped: deps.status.skipped,
      unpriced: deps.status.unpriced,
      reading: deps.status.reading,
      sweptAt: deps.status.sweptAt,
      error: deps.status.error,
    },
  });
  const context: ContextStrip[] = [];
  for (const row of report.sessions) {
    if (context.length >= CONTEXT_STRIPS) break;
    if (facts.get(row.id)?.kind === "harness") continue;
    const values = ledger.usageContext(row.id);
    // One message is a dot, and says nothing about a climb.
    if (values.length < 2) continue;
    context.push({ sessionId: row.id, label: row.label, workspace: row.workspace, ...contextStrip(values) });
  }
  return { ...report, context, weekOwner: deps.weekOwner };
}
