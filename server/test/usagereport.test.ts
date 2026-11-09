/**
 * The Usage page's numbers: what counts as a session, where a limit week starts,
 * who keeps which colour, and that the rollup and the messages tell one story.
 *
 * Against hand-made cells and a temp ledger. No transcript is involved at all,
 * since by the time a report is made everything a log said has been reduced to
 * numbers and `usageledger.test.ts` holds that part.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dayBounds, dayOf, noFacts } from "../../shared/usage";
import {
  bucketIndex,
  bucketsFor,
  buildStack,
  contextStrip,
  CONTEXT_POINTS,
  entityOf,
  isUsageDimension,
  isUsageRange,
  kindsOf,
  limitSeries,
  modelName,
  programSays,
  rangeBounds,
  rankRows,
  RANKED_TOP,
  seriesSlots,
  sessionRows,
  splitDays,
  TABLE_ROWS,
  totalsOf,
  WEEK_MS,
  type SessionFact,
  type UsageCell,
  type UsageNames,
} from "../../shared/usagereport";
import { CLEANUP_DEFAULT_DAYS, readRetention, usageReport } from "../src/usage/report";
import { Ledger, LedgerBatch } from "../src/usage/store";

const AT = new Date(2026, 9, 28, 15, 30).getTime();

function cell(sessionId: string, read: number, over: Partial<UsageCell> = {}): UsageCell {
  return { at: AT, sessionId, model: "claude-opus-5-5", messages: 1, input: 0, write5m: 0, write1h: 0, read, output: 0, thinking: 0, cost: read / 1000, unpriced: 0, ...over };
}

function fact(id: string, over: Partial<SessionFact> = {}): SessionFact {
  return { id, program: "claude", kind: "agent", workspaceKey: null, cardId: null, cwd: `/home/me/${id}`, attributedBy: "folder", agentId: null, startedAt: AT, lastAt: AT, ...over };
}

const names: UsageNames = {
  workspace: (key) => (key === "gone" ? null : `ws ${key}`),
  card: (id) => (id === "gone" ? null : `card ${id}`),
  liveAgent: () => null,
  openableCard: () => null,
  folder: (path) => path.replace("/home/me", "~"),
};

function facts(...list: SessionFact[]): Map<string, SessionFact> {
  return new Map(list.map((f) => [f.id, f]));
}

describe("the wire", () => {
  it("takes only the words it knows", () => {
    expect(isUsageRange("week")).toBe(true);
    expect(isUsageRange("forever")).toBe(false);
    expect(isUsageRange(null)).toBe(false);
    expect(isUsageDimension("model")).toBe(true);
    expect(isUsageDimension("__proto__")).toBe(false);
  });
});

describe("ranges", () => {
  it("cuts a limit week at the account's instant and compares it with as much of the last", () => {
    const resets = AT + 2 * 86_400_000 + 3_600_000;
    const week = rangeBounds("week", AT, resets);
    expect(week.from).toBe(resets - WEEK_MS);
    expect(week.guessed).toBe(false);
    expect(week.previous).toEqual({ from: week.from - WEEK_MS, to: AT - WEEK_MS });
  });

  it("says when it had to guess at the week, and refuses a reset that makes no sense", () => {
    for (const nonsense of [null, NaN, AT - 1, AT + WEEK_MS + 1]) {
      const week = rangeBounds("week", AT, nonsense);
      expect(week.guessed).toBe(true);
      expect(week.from).toBe(rangeBounds("7d", AT, null).from);
    }
  });

  it("compares today with yesterday up to this minute, not with all of yesterday", () => {
    const today = rangeBounds("today", AT, null);
    expect(today.from).toBe(dayBounds(dayOf(AT)).start);
    expect(today.previous!.to).toBe(AT - 86_400_000);
    expect(today.previous!.from).toBe(today.from - 86_400_000);
  });

  it("has nothing before All", () => {
    expect(rangeBounds("all", AT, null).previous).toBeNull();
  });

  it("makes seven and thirty days of the calendar, today included", () => {
    expect(dayOf(rangeBounds("7d", AT, null).from)).toBe("2026-10-22");
    expect(dayOf(rangeBounds("30d", AT, null).from)).toBe("2026-09-29");
  });
});

describe("splitDays", () => {
  const day = dayBounds("2026-10-28");
  it("keeps a span inside one day all edge", () => {
    expect(splitDays(day.start + 5, day.start + 10)).toEqual({ firstDay: null, lastDay: null, edges: [{ from: day.start + 5, to: day.start + 10 }] });
  });
  it("has no slices for a span on midnights", () => {
    const end = dayBounds("2026-10-30").start;
    expect(splitDays(day.start, end)).toEqual({ firstDay: "2026-10-28", lastDay: "2026-10-29", edges: [] });
  });
  it("cuts both ends of a limit week", () => {
    const from = day.start + 3_600_000;
    const to = dayBounds("2026-10-31").start + 60_000;
    expect(splitDays(from, to)).toEqual({
      firstDay: "2026-10-29",
      lastDay: "2026-10-30",
      edges: [
        { from, to: day.end },
        { from: dayBounds("2026-10-31").start, to },
      ],
    });
  });
  it("handles two neighbouring partial days and nothing at all", () => {
    const parts = splitDays(day.start + 1, day.end + 1);
    expect(parts.firstDay).toBeNull();
    expect(parts.edges.length).toBe(2);
    expect(splitDays(5, 5).edges).toEqual([]);
  });
});

describe("buckets", () => {
  it("draws a day by the hour up to now, and a week by the day", () => {
    const today = bucketsFor(dayBounds(dayOf(AT)).start, AT, null);
    expect(today.length).toBe(16);
    expect(bucketIndex(today, AT)).toBe(15);
    expect(bucketsFor(rangeBounds("7d", AT, null).from, AT, null).length).toBe(7);
    expect(bucketsFor(rangeBounds("30d", AT, null).from, AT, null).length).toBe(30);
  });

  it("clamps All to the first day read, and says months for a year", () => {
    const all = bucketsFor(0, AT, new Date(2025, 7, 10).getTime());
    expect(all.length).toBe(15);
    expect(all[0]!.label).toBe("Aug");
    const months = bucketsFor(0, AT, new Date(2026, 5, 1).getTime());
    expect(months.every((b, i) => i === 0 || b.from === months[i - 1]!.to)).toBe(true);
  });

  it("does not draw months since 1970 for an empty ledger", () => {
    expect(bucketsFor(0, AT, null).length).toBeLessThanOrEqual(24);
  });

  it("finds nothing outside the buckets", () => {
    const week = bucketsFor(rangeBounds("7d", AT, null).from, AT, null);
    expect(bucketIndex(week, week[0]!.from - 1)).toBe(-1);
    expect(bucketIndex(week, week[6]!.to)).toBe(-1);
  });
});

describe("counting", () => {
  it("counts a session by its cells, so a launch's row with no message is not one", () => {
    const known = facts(fact("spoke"), fact("launched-only"));
    const totals = totalsOf([cell("spoke", 10), cell("spoke", 5, { model: "claude-fable-5-1" })], (id) => known.get(id)?.kind ?? null);
    expect(totals.sessions).toBe(1);
    expect(totals.messages).toBe(2);
    expect(totals.tokens).toBe(15);
  });

  it("gives Kuru's share from its kind", () => {
    const known = facts(fact("k", { kind: "harness" }), fact("a"));
    const totals = totalsOf([cell("k", 25), cell("a", 75)], (id) => known.get(id)?.kind ?? null);
    expect(totals.kuruTokens).toBe(25);
    expect(totals.kuruCost).toBeCloseTo(0.025);
  });
});

describe("whose a cell is", () => {
  it("names a workspace, a removed one, and a folder, which says it is only that", () => {
    const by = (f: SessionFact) => entityOf("workspace", { model: "m" }, f, names);
    expect(by(fact("a", { workspaceKey: "wk1" })).label).toBe("ws wk1");
    expect(by(fact("a", { workspaceKey: "gone" })).label).toBe("A workspace since removed");
    const folder = by(fact("a", { cwd: "/home/me/project" }));
    expect(folder.label).toBe("~/project");
    expect(folder.folderOnly).toBe(true);
    expect(by(fact("a", { cwd: null })).label).toBe("Unknown folder");
  });

  it("keeps Kuru a row of its own except where that would falsify the row", () => {
    const kuru = fact("k", { kind: "harness", cardId: "c", workspaceKey: "wk1" });
    for (const by of ["workspace", "card", "agent", "kuru"] as const) expect(entityOf(by, { model: "m" }, kuru, names).kuru).toBe(true);
    expect(entityOf("model", { model: "claude-opus-5-5" }, kuru, names).label).toBe("Opus 5.5");
    expect(entityOf("program", { model: "m" }, kuru, names).label).toBe("Claude Code");
  });

  it("says agents, cards and the lack of one", () => {
    expect(entityOf("kuru", { model: "m" }, fact("a"), names).label).toBe("Agents");
    expect(entityOf("card", { model: "m" }, fact("a"), names).label).toBe("Not on a card");
    expect(entityOf("card", { model: "m" }, fact("a", { cardId: "c1" }), names).label).toBe("card c1");
    expect(entityOf("card", { model: "m" }, fact("a", { cardId: "gone" }), names).label).toBe("A card since removed");
    expect(entityOf("agent", { model: "m" }, fact("a", { cardId: "c1" }), names).label).toBe("card c1");
    expect(entityOf("agent", { model: "m" }, fact("project"), names).label).toBe("project, Oct 28");
    expect(entityOf("agent", { model: "m" }, fact("home", { cwd: "/home/me" }), names).label).toBe("~, Oct 28");
  });

  it("says a model as a person does, and leaves other companies' alone", () => {
    expect(modelName("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelName("claude-fable-5-1")).toBe("Fable 5.1");
    expect(modelName("claude-fable-5-2")).toBe("Fable 5.2");
    expect(modelName("claude-sonnet-4-20250514")).toBe("Sonnet 4");
    expect(modelName("claude-opus-4-8[1m]")).toBe("Opus 4.8");
    expect(modelName("gpt-5.5")).toBe("gpt-5.5");
    expect(modelName("<synthetic>")).toBe("<synthetic>");
  });
});

describe("ranked", () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ entity: { key: `w${i}`, label: `w${i}` }, tokens: 1000 - i * 10, cost: 1, messages: 1 }));

  it("keeps the top eight, then Other, and shares add up", () => {
    const rows = rankRows(many);
    expect(rows.length).toBe(RANKED_TOP + 1);
    expect(rows[rows.length - 1]!.key).toBe("other");
    expect(rows[rows.length - 1]!.others).toBe(4);
    expect(rows.reduce((n, row) => n + row.share, 0)).toBeCloseTo(1);
    expect(rows.reduce((n, row) => n + row.tokens, 0)).toBe(many.reduce((n, sum) => n + sum.tokens, 0));
  });

  it("never lets Kuru into Other, however small", () => {
    const rows = rankRows([...many, { entity: { key: "kuru", label: "Kuru", kuru: true }, tokens: 1, cost: 0, messages: 1 }]);
    const kuru = rows.find((row) => row.kuru);
    expect(kuru?.tokens).toBe(1);
    expect(rows.length).toBe(RANKED_TOP + 2);
    expect(rows[rows.length - 1]!.key).toBe("other");
  });

  it("puts a large Kuru where its tokens say", () => {
    const rows = rankRows([...many, { entity: { key: "kuru", label: "Kuru", kuru: true }, tokens: 5000, cost: 0, messages: 1 }]);
    expect(rows[0]!.kuru).toBe(true);
  });
});

describe("colour follows the entity", () => {
  const allTime = ["a", "b", "c", "d", "e", "f", "g", "h"];

  it("does not repaint a survivor when the range drops somebody", () => {
    const wide = seriesSlots(["a", "b", "c"], allTime);
    const narrow = seriesSlots(["c", "a"], allTime);
    expect(narrow.get("a")).toBe(wide.get("a")!);
    expect(narrow.get("c")).toBe(wide.get("c")!);
  });

  it("lends a newcomer a free slot and never one in use", () => {
    const slots = seriesSlots(["a", "g", "h", "new"], allTime);
    const taken = [...slots.values()];
    expect(new Set(taken).size).toBe(4);
    expect(slots.get("a")).toBe(0);
    for (const slot of taken) expect(slot).toBeLessThan(6);
  });

  it("gives the same set the same colours in any order", () => {
    expect(seriesSlots(["h", "g", "new"], allTime)).toEqual(seriesSlots(["new", "h", "g"], allTime));
  });
});

describe("the stack", () => {
  const buckets = bucketsFor(rangeBounds("7d", AT, null).from, AT, null);

  it("puts Kuru at the foot and Other on top, and loses no token", () => {
    const list = ["a", "b", "c", "d", "e", "f", "g"].map((id) => fact(id, { workspaceKey: id }));
    const known = facts(fact("k", { kind: "harness" }), ...list);
    const cells = [cell("k", 5), ...list.map((f, i) => cell(f.id, 100 - i))];
    const stack = buildStack(cells, known, "workspace", names, buckets, list.map((f) => f.workspaceKey!));
    expect(stack[0]!.ink).toBe("kuru");
    expect(stack[stack.length - 1]!.key).toBe("other");
    expect(stack.length).toBe(8);
    expect(stack.reduce((n, s) => n + s.total, 0)).toBe(cells.reduce((n, c) => n + c.read, 0));
    const inBucket = stack.reduce((n, s) => n + s.values[bucketIndex(buckets, AT)]!, 0);
    expect(inBucket).toBe(stack.reduce((n, s) => n + s.total, 0));
  });

  it("is two series for Kuru against the agents", () => {
    const known = facts(fact("k", { kind: "harness" }), fact("a"), fact("b"));
    const stack = buildStack([cell("k", 1), cell("a", 2), cell("b", 3)], known, "kuru", names, buckets, []);
    expect(stack.map((s) => [s.label, s.ink, s.total])).toEqual([
      ["Kuru", "kuru", 1],
      ["Agents", "rest", 5],
    ]);
  });
});

describe("kinds", () => {
  it("splits tokens and each cell's own estimate, and sums back to the estimate", () => {
    const cells = [cell("a", 1_000_000, { write1h: 100_000, output: 10_000, input: 1000, thinking: 500, cost: 2.5 }), cell("a", 0, { model: "gpt-5.5", input: 777, cost: 0, unpriced: 1 })];
    const { rows, thinking } = kindsOf(cells);
    const read = rows.find((row) => row.kind === "read")!;
    expect(read.tokens).toBe(1_000_000);
    expect(thinking).toBe(500);
    expect(rows.reduce((n, row) => n + row.cost, 0)).toBeCloseTo(2.5);
    expect(rows.reduce((n, row) => n + row.share, 0)).toBeCloseTo(1);
    expect(rows.find((row) => row.kind === "input")!.tokens).toBe(1777);
    // Opus 5.5: reads are 98 % of these tokens and a good deal less of the money.
    expect(read.costShare).toBeLessThan(read.share);
  });

  it("is zero, not NaN, on nothing", () => {
    const { rows } = kindsOf([]);
    for (const row of rows) {
      expect(row.share).toBe(0);
      expect(row.costShare).toBe(0);
    }
  });
});

describe("context strips", () => {
  it("keeps a peak through the down-sampling", () => {
    const values = Array.from({ length: 5000 }, (_, i) => (i === 3333 ? 848_000 : 100_000 + i));
    const strip = contextStrip(values);
    expect(strip.points.length).toBe(CONTEXT_POINTS);
    expect(Math.max(...strip.points.map((point) => point.context))).toBe(848_000);
    expect(strip.points.find((point) => point.context === 848_000)!.message).toBe(3334);
    expect(strip.peak).toBe(848_000);
    expect(strip.messages).toBe(5000);
  });

  it("says where it passed 200k, and when it never did", () => {
    expect(contextStrip([1, 300_000, 2]).over200At).toBe(2);
    expect(contextStrip([1, 2]).over200At).toBeNull();
    expect(contextStrip([1, 2]).points.length).toBe(2);
  });
});

describe("limits", () => {
  const buckets = bucketsFor(rangeBounds("7d", AT, null).from, AT, null);
  const today = bucketIndex(buckets, AT);

  it("keeps the high of a bucket through a reset, and gaps where nothing was read", () => {
    const [week] = limitSeries(
      [
        { at: AT - 100, kind: "weekly_all", scope: null, percent: 80, source: "codex" },
        { at: AT, kind: "weekly_all", scope: null, percent: 3, source: "codex" },
      ],
      buckets,
    );
    expect(week!.values[today]).toBe(80);
    expect(week!.values[today - 1]).toBeNull();
    expect(week!.last).toBe(3);
    expect(week!.label).toBe("Codex week");
  });

  it("draws the weeks and not the five-hour comb, and never a NaN", () => {
    const series = limitSeries(
      [
        { at: AT, kind: "session", scope: null, percent: 50, source: "codex" },
        { at: AT, kind: "weekly_all", scope: null, percent: NaN, source: "codex" },
        { at: AT, kind: "weekly_scoped", scope: "Fable", percent: 12, source: "claude" },
      ],
      buckets,
    );
    expect(series.map((s) => s.label)).toEqual(["Claude week · Fable"]);
  });
});

describe("the table", () => {
  it("adds a session's models up and names the largest", () => {
    const known = facts(fact("a", { cardId: "c1" }));
    const { rows } = sessionRows([cell("a", 10), cell("a", 90, { model: "claude-fable-5-1" })], known, new Map([["a", 12.5]]), names);
    expect(rows[0]!.tokens).toBe(100);
    expect(rows[0]!.model).toBe("Fable 5.1");
    expect(rows[0]!.moreModels).toBe(1);
    expect(rows[0]!.says).toBe(12.5);
    expect(rows[0]!.attribution).toBe("card");
    expect(rows[0]!.label).toBe("card c1");
  });

  it("is capped and says by how many", () => {
    const list = Array.from({ length: TABLE_ROWS + 7 }, (_, i) => fact(`s${i}`));
    const { rows, more } = sessionRows(list.map((f, i) => cell(f.id, i + 1)), facts(...list), new Map(), names);
    expect(rows.length).toBe(TABLE_ROWS);
    expect(more).toBe(7);
    expect(rows[0]!.tokens).toBe(TABLE_ROWS + 7);
  });

  it("offers only what is really there to go to", () => {
    const known = facts(fact("a", { cardId: "c1", agentId: "a9" }));
    const live: UsageNames = { ...names, liveAgent: (f) => (f.agentId ? { id: f.agentId, label: "x" } : null), openableCard: () => ({ workspaceId: "w4" }) };
    expect(sessionRows([cell("a", 1)], known, new Map(), names).rows[0]).toMatchObject({ agentId: null, card: null });
    expect(sessionRows([cell("a", 1)], known, new Map(), live).rows[0]).toMatchObject({ agentId: "a9", card: { id: "c1", workspaceId: "w4" } });
  });

  it("sets the program's figure beside the estimate only for sessions wholly in range", () => {
    const known = facts(fact("in", { startedAt: 100, lastAt: 200 }), fact("spills", { startedAt: 50, lastAt: 200 }), fact("cdx", { program: "codex", startedAt: 100, lastAt: 200 }));
    const says = programSays(
      [
        { id: "in", cost: 10, says: 11 },
        { id: "spills", cost: 5, says: 50 },
        { id: "cdx", cost: 1, says: 9 },
      ],
      known,
      100,
      300,
    );
    expect(says).toEqual({ sessions: 1, estimate: 10, says: 11 });
    expect(programSays([{ id: "spills", cost: 5, says: 50 }], known, 100, 300)).toBeNull();
  });
});

describe("with a real ledger", () => {
  let dir: string;
  let ledger: Ledger;
  const day = dayBounds(dayOf(AT));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kururu-report-"));
    ledger = Ledger.open(join(dir, "usage.db"));
  });
  afterEach(() => {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function bill(session: string, id: string, at: number, read = 100, sidechain = false): void {
    const batch = new LedgerBatch();
    batch.addMessage({ sessionId: session, messageId: id, at, model: "claude-opus-5-5", requestedModel: null, effort: null, input: 1, write5m: 2, write1h: 3, read, output: 4, thinking: 1, costEst: 0.5, sidechain, source: sidechain ? "subagent" : "transcript" });
    batch.addSession({ id: session, program: "claude", loginDir: "/l", cwd: `/home/me/${session}`, version: null, firstAt: at, lastAt: at, parentSession: null, seen: { projectDir: "-home-me", titled: false, loginKey: null } });
    ledger.flush(batch, noFacts());
  }

  const deps = (now: number) => ({
    names,
    weekResetsAt: null,
    weekOwner: null,
    retention: [],
    status: { ...ledger.counts(), reading: null, sweptAt: null, firstPass: null, error: null },
  });

  it("answers a span on midnights and a span across them the same as the messages do", () => {
    bill("s1", "m1", day.start + 1000);
    bill("s1", "m2", day.start + 2 * 3_600_000);
    bill("s1", "m3", day.end + 3_600_000);
    bill("s2", "m4", day.end + 2 * 3_600_000);
    const sum = (cells: UsageCell[]) => cells.reduce((n, c) => n + c.messages, 0);
    expect(sum(ledger.usageCells(day.start, day.end))).toBe(2);
    expect(sum(ledger.usageCells(day.start + 3_600_000, day.end + 90 * 60_000))).toBe(2);
    expect(sum(ledger.usageCells(0, day.end + 86_400_000))).toBe(4);
    expect(sum(ledger.usageQuarters(day.start, day.end))).toBe(2);
    expect(sum(ledger.usageAllTime())).toBe(4);
  });

  it("does not count a launch that has not billed anything", () => {
    bill("spoke", "m1", AT);
    ledger.recordLaunch({ agentId: "a1", sessionId: "silent", program: "claude", profileKey: "pk", workspaceKey: "wk", cardId: null, kind: "agent", node: null, machine: null, loginDir: null, cwd: "/x", at: AT });
    expect(ledger.usageFacts().has("silent")).toBe(true);
    const report = usageReport(ledger, "7d", "workspace", AT + 1000, deps(AT));
    expect(report.totals.sessions).toBe(1);
    expect(report.sessions.map((row) => row.id)).toEqual(["spoke"]);
  });

  it("keeps a subagent out of its parent's context and in its parent's totals", () => {
    bill("s", "m1", AT, 1000);
    bill("s", "m2", AT + 1, 999_999, true);
    bill("s", "m3", AT + 2, 2000);
    expect(ledger.usageContext("s")).toEqual([1006, 2006]);
    const report = usageReport(ledger, "7d", "agent", AT + 1000, deps(AT));
    expect(report.totals.messages).toBe(3);
    expect(report.context[0]!.peak).toBe(2006);
  });

  it("draws one day by the hour with the same tokens as the tiles", () => {
    bill("s", "m1", day.start + 3_600_000);
    bill("s", "m2", day.start + 5 * 3_600_000);
    const report = usageReport(ledger, "today", "kuru", day.start + 6 * 3_600_000, deps(AT));
    expect(report.buckets.length).toBe(6);
    expect(report.stack[0]!.values[1]).toBeGreaterThan(0);
    expect(report.stack[0]!.values[5]).toBeGreaterThan(0);
    expect(report.stack[0]!.total).toBe(report.totals.tokens);
  });

  it("follows a session that changes hands, with no rollup to rebuild", () => {
    bill("s", "m1", AT);
    ledger.recordLaunch({ agentId: "a1", sessionId: "s", program: "claude", profileKey: "pk", workspaceKey: "wk1", cardId: null, kind: "agent", node: null, machine: null, loginDir: null, cwd: "/x", at: AT });
    const report = usageReport(ledger, "7d", "workspace", AT + 1000, deps(AT));
    expect(report.ranked[0]!.label).toBe("ws wk1");
  });

  it("moves an older ledger on, its rollup filled from the messages it already has", () => {
    bill("s", "m1", AT);
    bill("s", "m2", day.start + 1);
    ledger.close();
    const raw = new DatabaseSync(join(dir, "usage.db"));
    raw.exec("drop table session_days; pragma user_version = 2;");
    raw.close();
    ledger = Ledger.open(join(dir, "usage.db"));
    expect(ledger.usageCells(day.start, day.end).reduce((n, c) => n + c.messages, 0)).toBe(2);
  });
});

describe("retention", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kururu-retention-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the number when it is stated and the default when it is not", () => {
    expect(readRetention(dir, "x")).toEqual({ who: "x", days: CLEANUP_DEFAULT_DAYS, stated: false });
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ cleanupPeriodDays: 90 }));
    expect(readRetention(dir, "x")).toEqual({ who: "x", days: 90, stated: true });
  });

  it("takes only that key, and no nonsense for it", () => {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ cleanupPeriodDays: 90, env: { SECRET: "RETENTIONSECRET" } }));
    expect(JSON.stringify(readRetention(dir, "x"))).not.toContain("RETENTIONSECRET");
    for (const bad of ['{"cleanupPeriodDays":"90"}', '{"cleanupPeriodDays":0}', '{"cleanupPeriodDays":-5}', "not json"]) {
      writeFileSync(join(dir, "settings.json"), bad);
      expect(readRetention(dir, "x").stated).toBe(false);
    }
  });
});
