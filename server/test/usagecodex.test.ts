/**
 * Codex's half of the usage ledger: a rollout's `turn_context` and
 * `token_count` lines, and the `rate_limits` riding beside them.
 *
 * Against a temp directory and the hand-written fixture in
 * `fixtures/usage/codex-rollout.jsonl`, with the real field names and
 * made-up numbers — never a copy of a real rollout, which holds whatever the
 * user asked Codex to do.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { codexLimitSnapshots, noCodexTurn, parseCodexLine, placeOfCodex, type CodexTurn } from "../src/usage/codex";
import { Ledger } from "../src/usage/store";
import { UsageReader } from "../src/usage/sweep";
import { noFacts, type AttributionFacts } from "../../shared/usage";

const FIXTURE = readFileSync(join(import.meta.dir, "fixtures", "usage", "codex-rollout.jsonl"), "utf8");
const SESSION = "01a18f17-43fc-7243-b286-f2b79e219c31";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kururu-codex-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("parsing a rollout line", () => {
  const lines = FIXTURE.trim().split("\n");
  const turnLine = lines[1]!;
  const firstToken = lines[2]!;
  const secondToken = lines[3]!;
  const noLast = lines[4]!;
  const broken = lines[5]!;
  const turn: CodexTurn = { model: "gpt-5.6-sol", effort: "medium", cwd: "/home/someone/project" };

  it("reads a turn's model, effort and cwd off turn_context", () => {
    const parsed = parseCodexLine(turnLine, noCodexTurn());
    expect(parsed).toEqual({ kind: "turn", turn: { model: "gpt-5.6-sol", effort: "medium", cwd: "/home/someone/project" } });
  });

  it("takes last_token_usage as the message, splitting cached out of input", () => {
    const parsed = parseCodexLine(firstToken, turn);
    if (parsed.kind !== "message") throw new Error(parsed.kind);
    expect(parsed.row).toMatchObject({ model: "gpt-5.6-sol", effort: "medium", input: 1000, read: 200, write5m: 0, write1h: 0, output: 50, thinking: 10, sidechain: false, source: "rollout" });
    expect(parsed.limits).not.toBeNull();
  });

  it("takes a second call's own delta, not the running total", () => {
    const parsed = parseCodexLine(secondToken, turn);
    if (parsed.kind !== "message") throw new Error(parsed.kind);
    expect(parsed.row).toMatchObject({ input: 1400, read: 800, output: 30, thinking: 5 });
  });

  it("skips a token_count with no last_token_usage, in its own word", () => {
    expect(parseCodexLine(noLast, turn)).toEqual({ kind: "skip", why: "no last_token_usage" });
  });

  it("skips what will not parse, and nothing else", () => {
    expect(parseCodexLine(broken, turn).kind).toBe("skip");
  });

  it("gives a model to a message only once a turn has said one", () => {
    const parsed = parseCodexLine(firstToken, noCodexTurn());
    if (parsed.kind !== "message") throw new Error(parsed.kind);
    expect(parsed.row.model).toBe("");
    expect(parsed.row.costEst).toBeNull();
  });
});

describe("rate limit snapshots", () => {
  it("keeps every window a reading named, whatever its reset says", () => {
    const at = Date.parse("2026-10-20T15:00:05Z");
    const rows = codexLimitSnapshots({ primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1 }, secondary: { used_percent: 3, window_minutes: 10_080, resets_at: 2 } }, at, "machine");
    expect(rows).toEqual([
      { at, account: "machine", kind: "session", scope: null, percent: 12.5, resetsAt: 1000, source: "codex" },
      { at, account: "machine", kind: "weekly_all", scope: null, percent: 3, resetsAt: 2000, source: "codex" },
    ]);
  });

  it("says nothing about a shape it was not given", () => {
    expect(codexLimitSnapshots(null, 0, null)).toEqual([]);
    expect(codexLimitSnapshots({}, 0, null)).toEqual([]);
  });
});

describe("where a rollout sits", () => {
  const root = { dir: "/r/codex", loginKey: null };

  it("reads the session id off the filename, never the content", () => {
    expect(placeOfCodex(`/r/codex/sessions/2026/10/20/rollout-2026-10-20T15-00-00-${SESSION}.jsonl`, root)).toEqual({ sessionId: SESSION });
    expect(placeOfCodex("/r/codex/sessions/2026/10/20/not-a-rollout.jsonl", root)).toBeNull();
    expect(placeOfCodex(`/elsewhere/sessions/2026/10/20/rollout-2026-10-20T15-00-00-${SESSION}.jsonl`, root)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The reader, against a temp directory
// ---------------------------------------------------------------------------

describe("the reader on a Codex home", () => {
  let home: string;
  let ledger: Ledger;
  let facts: AttributionFacts;

  function reader(): UsageReader {
    return new UsageReader({
      ledger,
      facts: () => facts,
      roots: async () => [],
      codexRoots: async () => [{ dir: home, loginKey: null }],
      // Never this machine's real OpenCode, which these tests are not about.
      opencodeHome: () => join(dir, "no-opencode"),
      tail: { pause: async () => {} },
    });
  }
  function all(sql: string): Record<string, any>[] {
    const db = new DatabaseSync(ledger.path, { readOnly: true });
    try {
      return db.prepare(sql).all() as Record<string, any>[];
    } finally {
      db.close();
    }
  }
  function rollout(day: string, id: string): string {
    const path = join(home, "sessions", ...day.split("-"), `rollout-${day}T15-00-00-${id}.jsonl`);
    mkdirSync(join(home, "sessions", ...day.split("-")), { recursive: true });
    return path;
  }

  beforeEach(() => {
    home = join(dir, "codex");
    ledger = Ledger.open(join(dir, "data", "usage.db"));
    facts = noFacts();
  });
  afterEach(() => {
    ledger.close();
  });

  it("turns two calls into two message rows, under the rollout's own session id", async () => {
    writeFileSync(rollout("2026-10-20", SESSION), FIXTURE);
    const each = reader();
    each.sweepSoon();
    await each.settled();

    const rows = all("select session_id, model, input, cache_read, output, thinking, cost_est from messages order by at");
    expect(rows).toEqual([
      { session_id: SESSION, model: "gpt-5.6-sol", input: 1000, cache_read: 200, output: 50, thinking: 10, cost_est: null },
      { session_id: SESSION, model: "gpt-5.6-sol", input: 1400, cache_read: 800, output: 30, thinking: 5, cost_est: null },
    ]);
    // An OpenAI model is not in the price table: tokens only, unpriced rather than guessed.
    expect(each.status().unpriced).toBe(2);
    expect(all("select program, kind, attributed_by from sessions")).toEqual([{ program: "codex", kind: "agent", attributed_by: "folder" }]);
  });

  it("keeps the rate_limits riding on the same events", async () => {
    writeFileSync(rollout("2026-10-20", SESSION), FIXTURE);
    const each = reader();
    each.sweepSoon();
    await each.settled();
    expect(all("select kind, percent, source from limits order by at, kind")).toEqual([
      { kind: "session", percent: 12.5, source: "codex" },
      { kind: "weekly_all", percent: 3, source: "codex" },
      { kind: "session", percent: 20, source: "codex" },
      { kind: "weekly_all", percent: 4, source: "codex" },
    ]);
  });

  it("counts a line it will not read, same as the other programs", async () => {
    writeFileSync(rollout("2026-10-20", SESSION), FIXTURE);
    const each = reader();
    each.sweepSoon();
    await each.settled();
    expect(each.status().skipped).toBe(2);
  });

  it("forgets a rollout's offset once it is gone, and keeps what it already read", async () => {
    const path = rollout("2026-10-20", SESSION);
    writeFileSync(path, FIXTURE);
    const each = reader();
    each.sweepSoon();
    await each.settled();
    // The day's folder goes, but `sessions/` itself is still there to walk —
    // the directory is known to be empty, not merely unreachable.
    rmSync(join(home, "sessions", "2026"), { recursive: true });
    each.sweepSoon();
    await each.settled();
    expect(all("select count(*) as n from files where program = 'codex'")).toEqual([{ n: 0 }]);
    expect(all("select count(*) as n from messages")).toEqual([{ n: 2 }]);
  });
});
