/**
 * The ledger's one export: `daily`, as text, one file a month, through the
 * backup's allow-list.
 *
 * Decision 9 of the plan: the raw `usage.db` stays off the backup — it is a
 * binary growing by megabytes a week, and thirty days of it is rebuildable
 * from the logs anyway — but the rollup it keeps is small, text, and the one
 * thing here that is not rebuildable once the logs that fed it are pruned.
 * So `daily` leaves the machine the way boards and conversations do, through
 * `server/src/export.ts`'s `mirrorFiles`, grouped by month so a year is
 * twelve files rather than one growing blob or three hundred tiny ones.
 *
 * Numbers, keys and folder names only, the same promise every other row in
 * `daily` already keeps — nothing here reads `messages` or `sessions`, which
 * is where a title or an agent's label could still be reached from.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dailyExportLine, monthOf, parseDailyExportLine, type DailyExportRow } from "../../../shared/usage";
import { walk } from "../export";
import type { Ledger } from "./store";

/** Where the mirror keeps it, one file a month. */
const DIR = "usage";

/** Every `usage/<month>.jsonl` the mirror should hold right now, off the ledger's `daily`. */
export function usageMirrorFiles(ledger: Ledger): Map<string, string> {
  const byMonth = new Map<string, string[]>();
  for (const row of ledger.dailyExport()) {
    const month = monthOf(row.day);
    const lines = byMonth.get(month);
    if (lines) lines.push(dailyExportLine(row));
    else byMonth.set(month, [dailyExportLine(row)]);
  }
  const files = new Map<string, string>();
  for (const [month, lines] of byMonth) files.set(join(DIR, `${month}.jsonl`), `${lines.join("\n")}\n`);
  return files;
}

/**
 * The mirror's `usage/` files, read back into `daily`. A line that will not
 * parse is counted and left out, the way `readMirror` leaves out a board or a
 * conversation that will not — one bad line must not cost the rest of a year.
 */
export function importUsageMirror(dir: string, ledger: Ledger): { imported: number; skipped: number } {
  let imported = 0;
  let skipped = 0;
  for (const file of walk(join(dir, DIR))) {
    if (!file.endsWith(".jsonl")) continue;
    const lines = readFileSync(join(dir, DIR, file), "utf8")
      .split("\n")
      .filter((line) => line.trim());
    const rows: DailyExportRow[] = [];
    for (const line of lines) {
      const row = parseDailyExportLine(line);
      if (row) rows.push(row);
      else skipped++;
    }
    imported += ledger.importDaily(rows);
  }
  return { imported, skipped };
}
