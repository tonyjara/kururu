/**
 * The rollups kept as messages are written: after any run of batches —
 * new messages, re-sightings with new counts or a new model, a message seen
 * earlier than it was, a session changing whose it is — `daily` and
 * `session_days` are what rebuilding every day from `messages` makes.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noFacts, type AttributionFacts, type MessageRow } from "../../shared/usage";
import { Ledger, LedgerBatch } from "../src/usage/store";

let dir: string;
let ledger: Ledger;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kururu-rollup-"));
  ledger = Ledger.open(join(dir, "usage.db"));
});
afterEach(() => {
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

type Db = { prepare(sql: string): { all(...args: unknown[]): unknown[] } };
const db = () => (ledger as unknown as { db: Db }).db;
const rows = (table: string) =>
  (db().prepare(`select * from ${table}`).all() as Record<string, unknown>[])
    .map((row) => ({ ...row, cost_est: Math.round((row.cost_est as number) * 1e9) / 1e9 }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

/** Both rollups as incrementing left them, and as a rebuild of every day makes them. */
function againstRebuild(): { kept: unknown; rebuilt: unknown } {
  const kept = { daily: rows("daily"), sessions: rows("session_days") };
  const days = (db().prepare("select distinct day from daily union select distinct day from session_days").all() as { day: string }[]).map((r) => r.day);
  const rollup = (ledger as unknown as { rollup(day: string): void }).rollup.bind(ledger);
  for (const day of days) rollup(day);
  return { kept, rebuilt: { daily: rows("daily"), sessions: rows("session_days") } };
}

const DAY = new Date(2026, 9, 14, 12).getTime();
const H = 3_600_000;

function message(sessionId: string, messageId: string, at: number, over: Partial<MessageRow> = {}): MessageRow {
  return { sessionId, messageId, at, model: "claude-opus-5-5", requestedModel: null, effort: null, input: 3, write5m: 10, write1h: 0, read: 1000, output: 50, thinking: 0, costEst: 0.02, sidechain: false, source: "main", ...over };
}

function sighting(id: string, at: number, projectDir = "/home/someone/project") {
  return { id, program: "claude" as const, loginDir: null, cwd: projectDir, version: null, firstAt: at, lastAt: at, parentSession: null, seen: { projectDir, titled: false, loginKey: null } };
}

function flush(messages: MessageRow[], sessions: ReturnType<typeof sighting>[] = [], facts: AttributionFacts = noFacts()): void {
  const batch = new LedgerBatch();
  for (const s of sessions) batch.addSession(s);
  for (const m of messages) batch.addMessage(m);
  ledger.flush(batch, facts);
}

describe("the rollups, kept as messages are written", () => {
  it("equal a rebuild after new messages, re-sightings and a message seen earlier", () => {
    flush([message("s1", "m1", DAY), message("s1", "m2", DAY + H)], [sighting("s1", DAY)]);
    flush([message("s1", "m3", DAY + 2 * H)]);
    // New counts for one already written, and a new model for another.
    flush([message("s1", "m1", DAY, { output: 400, costEst: 0.5 }), message("s1", "m2", DAY + H, { model: "claude-sonnet-5-5", costEst: null })]);
    // Seen again earlier, on the day before: it moves days.
    flush([message("s1", "m3", DAY - 20 * H)]);
    // The same again, numbers and all: nothing moves.
    flush([message("s1", "m3", DAY - 20 * H)]);
    const { kept, rebuilt } = againstRebuild();
    expect(kept).toEqual(rebuilt);
    expect((db().prepare("select sum(messages) as n from daily").all() as { n: number }[])[0]!.n).toBe(3);
  });

  it("equal a rebuild when a session comes to be a card's, and when one arrives after its messages", () => {
    flush([message("s1", "m1", DAY), message("s2", "x1", DAY)], [sighting("s1", DAY)]);
    expect(againstRebuild().kept).toEqual(againstRebuild().rebuilt);
    const facts: AttributionFacts = { ...noFacts(), runs: new Map([["s1", { sessionId: "s1", runId: 1, cardId: "card1", agentId: null, profileKey: "pk1", workspaceKey: "wk1" }]]) };
    flush([message("s1", "m2", DAY + H)], [sighting("s1", DAY)], facts);
    flush([message("s2", "x2", DAY + H)], [sighting("s2", DAY)]);
    const { kept, rebuilt } = againstRebuild();
    expect(kept).toEqual(rebuilt);
    expect(db().prepare("select distinct card_id from daily order by 1").all()).toEqual([{ card_id: "" }, { card_id: "card1" }]);
  });

  it("equal a rebuild over a run of random batches", () => {
    let seed = 7;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n);
    const models = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
    for (let round = 0; round < 40; round++) {
      const batch: MessageRow[] = [];
      for (let i = 0; i < 6; i++) {
        const session = `s${rand(4)}`;
        batch.push(message(session, `m${rand(30)}`, DAY + (rand(60) - 30) * H, { model: models[rand(3)]!, output: rand(500), costEst: rand(5) === 0 ? null : rand(100) / 100 }));
      }
      flush(batch, rand(3) === 0 ? [sighting(`s${rand(4)}`, DAY)] : []);
    }
    const { kept, rebuilt } = againstRebuild();
    expect(kept).toEqual(rebuilt);
  });
});
