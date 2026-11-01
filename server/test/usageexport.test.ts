/**
 * The ledger's one export: `daily`, grouped by month, through
 * `usage/export.ts`, and the pure functions in `shared/usage.ts` it is built
 * from. Against a temp ledger and hand-written rows, never a real one.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dailyExportLine, monthOf, parseDailyExportLine, type DailyExportRow } from "../../shared/usage";
import { importUsageMirror, usageMirrorFiles } from "../src/usage/export";
import { Ledger } from "../src/usage/store";

function row(over: Partial<DailyExportRow> = {}): DailyExportRow {
  return {
    day: "2026-10-15",
    profileKey: "pk1",
    workspaceKey: "wk1",
    cardId: "",
    kind: "agent",
    program: "claude",
    model: "claude-opus-5-5",
    node: "",
    messages: 3,
    input: 10,
    write5m: 1,
    write1h: 2,
    read: 1000,
    output: 40,
    thinking: 5,
    costEst: 0.5,
    unpriced: 0,
    ...over,
  };
}

describe("monthOf", () => {
  it("is the calendar month a day falls in", () => {
    expect(monthOf("2026-10-15")).toBe("2026-10");
    expect(monthOf("2026-01-01")).toBe("2026-01");
  });
});

describe("dailyExportLine and parseDailyExportLine", () => {
  it("round-trips a row", () => {
    const r = row();
    expect(parseDailyExportLine(dailyExportLine(r))).toEqual(r);
  });

  it("drops a line that is not JSON", () => {
    expect(parseDailyExportLine("not json")).toBeNull();
  });

  it("drops a line missing a field", () => {
    const { day: _day, ...rest } = row();
    expect(parseDailyExportLine(JSON.stringify(rest))).toBeNull();
  });

  it("drops a number that is not finite, never clamping it", () => {
    expect(parseDailyExportLine(JSON.stringify({ ...row(), messages: Number.NaN }))).toBeNull();
    expect(parseDailyExportLine(JSON.stringify({ ...row(), input: "12" }))).toBeNull();
  });
});

describe("usageMirrorFiles and importUsageMirror", () => {
  let dbDir: string;
  let mirrorDir: string;
  let ledger: Ledger;
  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), "kururu-usageexport-db-"));
    mirrorDir = mkdtempSync(join(tmpdir(), "kururu-usageexport-mirror-"));
    ledger = Ledger.open(join(dbDir, "usage.db"));
  });
  afterEach(() => {
    ledger.close();
    rmSync(dbDir, { recursive: true, force: true });
    rmSync(mirrorDir, { recursive: true, force: true });
  });

  it("writes one file a month, off `daily`", () => {
    ledger.importDaily([row({ day: "2026-10-15" }), row({ day: "2026-10-16" }), row({ day: "2026-11-01" })]);
    const files = usageMirrorFiles(ledger);
    expect([...files.keys()].sort()).toEqual([join("usage", "2026-10.jsonl"), join("usage", "2026-11.jsonl")]);
    const october = files.get(join("usage", "2026-10.jsonl"))!;
    expect(october.trim().split("\n").length).toBe(2);
    expect(october.endsWith("\n")).toBe(true);
  });

  it("writes nothing for an empty ledger", () => {
    expect(usageMirrorFiles(ledger).size).toBe(0);
  });

  it("round-trips through a mirror directory: imported rows come back the same", () => {
    ledger.importDaily([row({ day: "2026-10-15" }), row({ day: "2026-10-16", model: "claude-sonnet-5-5" })]);
    for (const [rel, content] of usageMirrorFiles(ledger)) {
      const path = join(mirrorDir, rel);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, content);
    }
    const second = Ledger.open(join(dbDir, "second.db"));
    try {
      const result = importUsageMirror(mirrorDir, second);
      expect(result).toEqual({ imported: 2, skipped: 0 });
      expect(second.dailyExport()).toEqual(ledger.dailyExport());
    } finally {
      second.close();
    }
  });

  it("counts, not fails on, a line that will not parse", () => {
    mkdirSync(join(mirrorDir, "usage"), { recursive: true });
    writeFileSync(join(mirrorDir, "usage", "2026-10.jsonl"), `${dailyExportLine(row())}\nnot json\n`);
    const result = importUsageMirror(mirrorDir, ledger);
    expect(result).toEqual({ imported: 1, skipped: 1 });
  });

  it("upserts, so a restore run twice is the same table, not a doubling", () => {
    ledger.importDaily([row()]);
    ledger.importDaily([row({ messages: 9 })]);
    const all = ledger.dailyExport();
    expect(all.length).toBe(1);
    expect(all[0]!.messages).toBe(9);
  });

  it("reads nothing from a mirror with no `usage/` folder", () => {
    expect(importUsageMirror(mirrorDir, ledger)).toEqual({ imported: 0, skipped: 0 });
  });
});
