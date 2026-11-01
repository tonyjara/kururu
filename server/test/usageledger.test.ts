/**
 * The usage ledger: what a billed message is, that a file is followed without
 * ever being read twice into a sum, whose a session was, and that no word of a
 * transcript gets out.
 *
 * Against a temp directory and hand-written records with the real field names
 * and made-up numbers, in `fixtures/usage/`. Never a copy of a real transcript,
 * which holds whatever the user's projects hold. The word `LEDGERSECRET` is on
 * everything in the fixtures that a ledger must not keep.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { baseModelId, costOf, priceOf } from "../../shared/prices";
import { attributionFor, countOf, dayBounds, dayOf, harnessProfileOf, matchRollouts, noFacts, reportNames, ROLLOUT_LATE_MS, splitCacheWrite, strongerAttribution, type Attribution, type AttributionFacts, type LaunchRow, type WaitingLaunch } from "../../shared/usage";
import { Launches } from "../src/usage/attribute";
import { parseClaudeLine, placeOf } from "../src/usage/claude";
import { Ledger, LedgerBatch, type FileRow } from "../src/usage/store";
import { UsageReader } from "../src/usage/sweep";
import { resume, scanLines, tailFile, type TailSink } from "../src/usage/tail";
import { Store } from "../src/store";

const FIXTURES = join(import.meta.dir, "fixtures", "usage");
const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const SECRET = "LEDGERSECRET";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kururu-ledger-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function assistantLine(session: string, id: string, at: string, overrides: { model?: string; input?: unknown; read?: number } = {}): string {
  return `${JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    message: { model: overrides.model ?? "claude-opus-5-5", id, role: "assistant", content: [], usage: { input_tokens: overrides.input ?? 1, cache_creation_input_tokens: 0, cache_read_input_tokens: overrides.read ?? 100, output_tokens: 2 } },
    type: "assistant",
    uuid: id,
    timestamp: at,
    cwd: "/home/someone/project",
    sessionId: session,
    version: "2.1.311",
  })}\n`;
}

const noPause = { pause: async () => {} };

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

describe("prices", () => {
  const at = Date.parse("2026-10-20T00:00:00Z");

  it("names a model without its window or its date", () => {
    expect(baseModelId("claude-opus-5[1m]")).toBe("claude-opus-5");
    expect(baseModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
  });

  it("prices each kind of token at its own rate", () => {
    // 1 M of each at Opus 5.5: 4 + 5 + 8 + 0.20 + 20.
    const million = { input: 1e6, write5m: 1e6, write1h: 1e6, read: 1e6, output: 1e6 };
    expect(costOf("claude-opus-5-5", at, million)).toBeCloseTo(37.2, 6);
    // Sonnet 5.5's read is half Sonnet 5's, which is a thing a guess would miss.
    expect(costOf("claude-sonnet-5-5", at, { ...million, input: 0, write5m: 0, write1h: 0, output: 0 })).toBeCloseTo(0.1, 6);
    expect(costOf("claude-sonnet-5", at, { ...million, input: 0, write5m: 0, write1h: 0, output: 0 })).toBeCloseTo(0.2, 6);
  });

  it("gives Haiku 5.5's long prompt the higher prices, cache included, on its own request only", () => {
    const short = { input: 1000, write5m: 0, write1h: 0, read: 99_000, output: 1000 };
    const long = { input: 1000, write5m: 0, write1h: 0, read: 99_001, output: 1000 };
    expect(costOf("claude-haiku-5-5", at, short)).toBeCloseTo((1000 * 0.1 + 99_000 * 0.01 + 1000 * 0.5) / 1e6, 10);
    expect(costOf("claude-haiku-5-5", at, long)).toBeCloseTo((1000 * 0.5 + 99_001 * 0.05 + 1000 * 2.5) / 1e6, 10);
  });

  it("says nothing about a model it has not heard of, and nothing billed costs nothing", () => {
    const tokens = { input: 5, write5m: 0, write1h: 0, read: 0, output: 5 };
    expect(costOf("claude-opus-9", at, tokens)).toBeNull();
    expect(priceOf("claude-opus-9", at)).toBeNull();
    expect(costOf("<synthetic>", at, { input: 0, write5m: 0, write1h: 0, read: 0, output: 0 })).toBe(0);
  });

  it("charges fast mode only on the models that have it, and US-only inference on all", () => {
    const tokens = { input: 1e6, write5m: 0, write1h: 0, read: 0, output: 0 };
    expect(costOf("claude-opus-5-5", at, tokens, { fast: true })).toBeCloseTo(8, 6);
    expect(costOf("claude-sonnet-5", at, tokens, { fast: true })).toBeCloseTo(2, 6);
    expect(costOf("claude-sonnet-5", at, tokens, { usOnly: true })).toBeCloseTo(2.2, 6);
  });
});

// ---------------------------------------------------------------------------
// The pure half
// ---------------------------------------------------------------------------

describe("numbers and days", () => {
  it("counts absence as zero and refuses anything that is not a count", () => {
    expect(countOf(undefined)).toBe(0);
    expect(countOf(null)).toBe(0);
    expect(countOf(7)).toBe(7);
    expect(countOf(Number.NaN)).toBeNull();
    expect(countOf(Number.POSITIVE_INFINITY)).toBeNull();
    expect(countOf(-1)).toBeNull();
    expect(countOf("7")).toBeNull();
  });

  it("reads a cache write with no split as the five-minute kind and keeps the total", () => {
    expect(splitCacheWrite(100, 0, 0)).toEqual({ write5m: 100, write1h: 0 });
    expect(splitCacheWrite(100, 0, 100)).toEqual({ write5m: 0, write1h: 100 });
    expect(splitCacheWrite(100, 10, 40)).toEqual({ write5m: 60, write1h: 40 });
    expect(splitCacheWrite(100, 80, 40)).toEqual({ write5m: 80, write1h: 40 });
  });

  it("gives a day through the calendar, so every moment lands in exactly one", () => {
    const { start, end } = dayBounds("2026-10-20");
    expect(dayOf(start)).toBe("2026-10-20");
    expect(dayOf(end - 1)).toBe("2026-10-20");
    expect(dayOf(end)).toBe("2026-10-21");
    expect(dayBounds("2026-10-21").start).toBe(end);
    // Across the end of a month.
    expect(dayOf(dayBounds("2026-10-31").end)).toBe("2026-11-01");
  });

  it("knows a harness's folder however the data directory is spelt", () => {
    expect(harnessProfileOf("-Users-x--local-share-kururu-harness-pk8e5c585ab108")).toBe("pk8e5c585ab108");
    expect(harnessProfileOf("-tmp-k2-data-harness-pk8e5c585ab108")).toBe("pk8e5c585ab108");
    expect(harnessProfileOf("-Users-x-Desktop-harness")).toBeNull();
    expect(harnessProfileOf("-Users-x-harness-pk8e5c585ab108-sub")).toBeNull();
  });
});

describe("parsing a line", () => {
  const lines = readFileSync(join(FIXTURES, "session.jsonl"), "utf8").trim().split("\n");
  const line = (uuid: string) => lines.find((each) => each.includes(`"uuid":"${uuid}"`))!;

  it("reads a billed message's numbers and nothing else", () => {
    const parsed = parseClaudeLine(line("a1"), "transcript");
    if (parsed.kind !== "message") throw new Error(parsed.kind);
    expect(parsed.row).toMatchObject({ sessionId: SESSION, messageId: "msg_a", model: "claude-opus-5-5", input: 10, write5m: 0, write1h: 1000, read: 200000, output: 50, thinking: 20, effort: "xhigh", sidechain: false });
    expect(JSON.stringify(parsed)).not.toContain(SECRET);
  });

  it("does not take a quoted record for a billed one", () => {
    expect(parseClaudeLine(line("u2"), "transcript").kind).toBe("other");
  });

  it("refuses a count that is not one, in its own word and not the line's", () => {
    const parsed = parseClaudeLine(line("a6"), "transcript");
    expect(parsed.kind).toBe("skip");
    expect(JSON.stringify(parsed)).not.toContain(SECRET);
    expect(parseClaudeLine('{"type":"assistant"', "transcript")).toEqual({ kind: "skip", why: "not JSON" });
  });

  it("keeps a cwd only when it is a cwd, and a timestamp only when it is a time", () => {
    expect(parseClaudeLine(assistantLine(SESSION, "m", "yesterday"), "transcript")).toEqual({ kind: "skip", why: "no timestamp" });
    const bad = JSON.parse(assistantLine(SESSION, "m", "2026-10-20T00:00:00Z"));
    bad.sessionId = "a session; drop table";
    expect(parseClaudeLine(JSON.stringify(bad), "transcript")).toEqual({ kind: "skip", why: "no session id" });
  });

  it("marks a subagent's turn whatever its record says", () => {
    const parsed = parseClaudeLine(assistantLine(SESSION, "m", "2026-10-20T00:00:00Z"), "subagent");
    expect(parsed.kind === "message" && parsed.row.sidechain).toBe(true);
  });

  it("takes Claude Code's running total as what it says, split included, and only from the transcript", () => {
    const cost = lines.find((each) => each.startsWith('{"type":"cost-state"'))!;
    const parsed = parseClaudeLine(cost, "transcript");
    if (parsed.kind !== "totals") throw new Error(parsed.kind);
    expect(parsed.rows).toEqual([{ sessionId: SESSION, model: "claude-opus-5-5", input: 15, output: 100, thinking: 20, read: 401000, write5m: 100, write1h: 1000, costProgram: 0.09, at: 1792500061000 }]);
    expect(parseClaudeLine(cost, "subagent").kind).toBe("other");
  });
});

describe("whose a session was", () => {
  const facts: AttributionFacts = {
    runs: new Map([[SESSION, { sessionId: SESSION, runId: 4, cardId: "c1", agentId: "a9", profileKey: "pk000000000001", workspaceKey: "wk000000000001" }]]),
    conversations: new Map([
      [SESSION, { sessionId: SESSION, kind: "agent", profileKey: "pk000000000001" }],
      [OTHER, { sessionId: OTHER, kind: "harness", profileKey: "pk000000000002" }],
    ]),
    profileOfLogin: new Map([["aaaaaaaaaaaa", "pk000000000003"]]),
  };
  const seen = { projectDir: "-home-someone-project", titled: false, loginKey: null };

  it("takes a card's run first, then anything that says harness, then the conversation, then the folder", () => {
    expect(attributionFor(SESSION, seen, facts)).toMatchObject({ kind: "card", cardId: "c1", workspaceKey: "wk000000000001", attributedBy: "card_runs" });
    expect(attributionFor(OTHER, seen, facts)).toMatchObject({ kind: "harness", profileKey: "pk000000000002", attributedBy: "conversations" });
    expect(attributionFor("nobody", { ...seen, projectDir: "-x-harness-pk000000000004" }, facts)).toMatchObject({ kind: "harness", profileKey: "pk000000000004", attributedBy: "folder" });
    expect(attributionFor("nobody", { ...seen, titled: true, loginKey: "aaaaaaaaaaaa" }, facts)).toMatchObject({ kind: "harness", profileKey: "pk000000000003", attributedBy: "folder" });
    expect(attributionFor("nobody", { ...seen, loginKey: "aaaaaaaaaaaa" }, facts)).toEqual({ profileKey: "pk000000000003", workspaceKey: null, cardId: null, runId: null, agentId: null, kind: "agent", attributedBy: "folder" });
    expect(attributionFor("nobody", seen, noFacts())).toMatchObject({ profileKey: null, kind: "agent", attributedBy: "folder" });
  });

  it("never lets a reading that knows less replace one that knows more", () => {
    const harness: Attribution = { profileKey: "pk000000000001", workspaceKey: null, cardId: null, runId: null, agentId: null, kind: "harness", attributedBy: "folder" };
    const plain: Attribution = { ...harness, kind: "agent", profileKey: null };
    const card: Attribution = { ...plain, kind: "card", cardId: "c", attributedBy: "card_runs" };
    expect(strongerAttribution(harness, plain)).toBe(harness);
    expect(strongerAttribution(card, plain)).toBe(card);
    expect(strongerAttribution(plain, card)).toBe(card);
    expect(strongerAttribution({ ...plain, profileKey: "pk000000000001" }, plain).profileKey).toBe("pk000000000001");
  });
});

describe("where a file sits", () => {
  const root = { dir: "/r/claude", loginKey: null };

  it("takes a transcript or a subagent's under projects/, and nothing else", () => {
    expect(placeOf("/r/claude/projects/-a/s.jsonl", root)).toEqual({ projectDir: "-a", source: "transcript" });
    expect(placeOf("/r/claude/projects/-a/s/subagents/agent-1.jsonl", root)).toEqual({ projectDir: "-a", source: "subagent" });
    expect(placeOf("/r/claude/history.jsonl", root)).toBeNull();
    expect(placeOf("/r/claude/projects/s.jsonl", root)).toBeNull();
    expect(placeOf("/r/claude/projects/-a/../../secret.jsonl", root)).toBeNull();
    expect(placeOf("/elsewhere/projects/-a/s.jsonl", root)).toBeNull();
    expect(placeOf("/r/claude/projects/-a/s.txt", root)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Following a file
// ---------------------------------------------------------------------------

describe("scanning a chunk", () => {
  const needles = [Buffer.from("NEEDLE"), Buffer.from("OTHER")];
  const lines = (text: string) => {
    const buffer = Buffer.from(text);
    const out: string[] = [];
    scanLines(buffer, buffer.lastIndexOf(10) + 1, needles, (start, stop) => out.push(buffer.toString("utf8", start, stop)));
    return out;
  };

  it("finds each line holding either needle once, in order", () => {
    expect(lines("a\nNEEDLE 1\nb\nOTHER 2\nNEEDLE OTHER NEEDLE 3\nc\n")).toEqual(["NEEDLE 1", "OTHER 2", "NEEDLE OTHER NEEDLE 3"]);
  });

  it("handles a first line, a last line and no line at all", () => {
    expect(lines("NEEDLE\n")).toEqual(["NEEDLE"]);
    expect(lines("x\nx\nx\n")).toEqual([]);
    expect(lines("\n\nNEEDLE\n\n")).toEqual(["NEEDLE"]);
  });

  it("leaves a needle in the unfinished line alone", () => {
    expect(lines("NEEDLE 1\nNEEDLE half")).toEqual(["NEEDLE 1"]);
  });
});

describe("following a file", () => {
  function recording(known: FileRow | null = null) {
    const lines: string[] = [];
    const skips: string[] = [];
    let offset = known?.offset ?? 0;
    let fresh = false;
    const sink: TailSink = {
      begin: (info) => {
        fresh = info.fresh;
        offset = info.offset;
        return true;
      },
      line: (text) => lines.push(text),
      skip: (_at, why) => skips.push(why),
      advanced: (to) => {
        offset = to;
      },
    };
    return { sink, lines, skips, offset: () => offset, fresh: () => fresh };
  }
  const needles = [Buffer.from("WANT")];

  it("stops at the newline before a half-written line and reads it whole next time", async () => {
    const path = join(dir, "f.jsonl");
    writeFileSync(path, "WANT 1\nWANT hal");
    const first = recording();
    await tailFile(path, null, needles, first.sink, noPause);
    expect(first.lines).toEqual(["WANT 1"]);
    expect(first.offset()).toBe(7);
    appendFileSync(path, "f written\nWANT 3\n");
    const second = recording();
    await tailFile(path, { inode: (await import("node:fs")).statSync(path).ino, offset: first.offset() }, needles, second.sink, noPause);
    expect(second.lines).toEqual(["WANT half written", "WANT 3"]);
  });

  it("goes across chunks, and grows for a line longer than one", async () => {
    const path = join(dir, "f.jsonl");
    const long = `WANT ${"x".repeat(5000)}`;
    writeFileSync(path, `${"skip me\n".repeat(200)}${long}\nWANT end\n`);
    const each = recording();
    await tailFile(path, null, needles, each.sink, { ...noPause, chunk: 256 });
    expect(each.lines).toEqual([long, "WANT end"]);
    expect(each.skips).toEqual([]);
  });

  it("gives up on a line longer than it will hold, says so in its own words, and carries on", async () => {
    const path = join(dir, "f.jsonl");
    writeFileSync(path, `WANT 1\nWANT ${"x".repeat(5000)}\nWANT 2\n`);
    const each = recording();
    await tailFile(path, null, needles, each.sink, { ...noPause, chunk: 256, maxLine: 1024 });
    expect(each.lines).toEqual(["WANT 1", "WANT 2"]);
    expect(each.skips).toEqual(["a line too long to read"]);
  });

  it("starts over on a new inode or a shorter file, and carries on otherwise", () => {
    expect(resume({ inode: 1, offset: 10 }, 1, 20)).toEqual({ inode: 1, offset: 10, fresh: false });
    expect(resume({ inode: 1, offset: 10 }, 2, 20)).toEqual({ inode: 2, offset: 0, fresh: true });
    expect(resume({ inode: 1, offset: 10 }, 1, 5)).toEqual({ inode: 1, offset: 0, fresh: true });
    expect(resume(null, 1, 5)).toEqual({ inode: 1, offset: 0, fresh: true });
  });

  it("says a file that is not there is gone, and finishes one deleted under it", async () => {
    expect(await tailFile(join(dir, "none.jsonl"), null, needles, recording().sink, noPause)).toBe("gone");
    const path = join(dir, "f.jsonl");
    writeFileSync(path, "WANT 1\nWANT 2\n");
    const each = recording();
    const result = await tailFile(path, null, needles, each.sink, {
      chunk: 7,
      pause: async () => {
        if (existsSync(path)) rmSync(path);
      },
    });
    expect(result).toBe("read");
    expect(each.lines).toEqual(["WANT 1", "WANT 2"]);
  });
});

// ---------------------------------------------------------------------------
// The reader, against a temp directory and a real file
// ---------------------------------------------------------------------------

describe("the reader", () => {
  let root: string;
  let projects: string;
  let ledger: Ledger;
  let facts: AttributionFacts;

  function reader(extra: { loginKey?: string | null } = {}): UsageReader {
    return new UsageReader({
      ledger,
      facts: () => facts,
      roots: async () => [{ dir: root, loginKey: extra.loginKey ?? null }],
      tail: noPause,
    });
  }
  async function sweep(each = reader()): Promise<UsageReader> {
    each.sweepSoon();
    await each.settled();
    return each;
  }
  function all(sql: string, ...args: (string | number)[]): Record<string, any>[] {
    const db = new DatabaseSync(ledger.path, { readOnly: true });
    try {
      return db.prepare(sql).all(...args) as Record<string, any>[];
    } finally {
      db.close();
    }
  }
  function transcript(project: string, session: string): string {
    const path = join(projects, project, `${session}.jsonl`);
    mkdirSync(join(projects, project), { recursive: true });
    return path;
  }
  function placeFixtures(): void {
    copyFileSync(join(FIXTURES, "session.jsonl"), transcript("-home-someone-project", SESSION));
    const sub = join(projects, "-home-someone-project", SESSION, "subagents");
    mkdirSync(sub, { recursive: true });
    copyFileSync(join(FIXTURES, "subagent.jsonl"), join(sub, "agent-1.jsonl"));
  }

  beforeEach(() => {
    root = join(dir, "claude");
    projects = join(root, "projects");
    mkdirSync(projects, { recursive: true });
    ledger = Ledger.open(join(dir, "data", "usage.db"));
    facts = noFacts();
  });
  afterEach(() => {
    ledger.close();
  });

  it("collapses a stream into one message with the last sighting's counts and the first's time", async () => {
    placeFixtures();
    await sweep();
    const rows = all("select * from messages where message_id = 'msg_a'");
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ session_id: SESSION, output: 70, input: 10, cache_write_1h: 1000, cache_read: 200000, at: Date.parse("2026-10-20T15:00:05.000Z"), sidechain: 0, source: "transcript", effort: "xhigh" });
    expect(all("select message_id from messages order by message_id").map((row) => row.message_id)).toEqual(["msg_a", "msg_b", "msg_c", "msg_sub"]);
  });

  it("keeps a subagent's turn apart and under its parent's session, whichever file comes first", async () => {
    placeFixtures();
    await sweep();
    expect(all("select source, sidechain, session_id from messages where message_id = 'msg_sub'")).toEqual([{ source: "subagent", sidechain: 1, session_id: SESSION }]);
    // The parent's copy of a subagent's last turn, read after it, leaves it the subagent's.
    appendFileSync(transcript("-home-someone-project", SESSION), readFileSync(join(FIXTURES, "subagent.jsonl")));
    await sweep();
    expect(all("select source, sidechain from messages where message_id = 'msg_sub'")).toEqual([{ source: "subagent", sidechain: 1 }]);
    expect(all("select count(*) as n from sessions")).toEqual([{ n: 1 }]);
  });

  it("counts a line it refuses, once, and does not stop", async () => {
    placeFixtures();
    await sweep();
    expect(all("select why from skipped")).toEqual([{ why: "a count that is not a number" }]);
    const again = await sweep();
    expect(again.status().skipped).toBe(1);
  });

  it("does not add anything up twice, across a restart, a re-read or a new inode", async () => {
    placeFixtures();
    await sweep();
    const before = all("select * from daily");
    expect(before.reduce((sum, row) => sum + row.messages, 0)).toBe(4);
    // Nothing moved.
    await sweep(reader());
    expect(all("select * from daily")).toEqual(before);
    // The same bytes under a new inode are read from zero and change nothing.
    const path = transcript("-home-someone-project", SESSION);
    renameSync(path, `${path}.moved`);
    copyFileSync(`${path}.moved`, path);
    rmSync(`${path}.moved`);
    await sweep(reader());
    expect(all("select * from daily")).toEqual(before);
  });

  it("reads on from its offset and keeps the day's rollup equal to its messages", async () => {
    const path = transcript("-p", SESSION);
    writeFileSync(path, assistantLine(SESSION, "m1", "2026-10-20T15:00:00Z"));
    await sweep();
    const size = readFileSync(path).length;
    expect(all("select offset from files")).toEqual([{ offset: size }]);
    appendFileSync(path, assistantLine(SESSION, "m2", "2026-10-20T15:05:00Z", { read: 500 }));
    appendFileSync(path, assistantLine(SESSION, "m3", "2026-10-21T15:05:00Z", { read: 900 }));
    appendFileSync(path, '{"partial":"not yet');
    await sweep();
    const byDay = all("select day, sum(messages) as messages, sum(cache_read) as read from daily group by day order by day");
    expect(byDay).toEqual([
      { day: dayOf(Date.parse("2026-10-20T15:00:00Z")), messages: 2, read: 600 },
      { day: dayOf(Date.parse("2026-10-21T15:05:00Z")), messages: 1, read: 900 },
    ]);
    expect((all("select offset from files")[0]!.offset as number) < readFileSync(path).length).toBe(true);
    const sums = all("select count(*) as messages, sum(cache_read) as read, sum(input) as input, sum(cost_est) as cost from messages")[0]!;
    const rolled = all("select sum(messages) as messages, sum(cache_read) as read, sum(input) as input, sum(cost_est) as cost from daily")[0]!;
    expect(rolled.messages).toBe(sums.messages);
    expect(rolled.read).toBe(sums.read);
    expect(rolled.cost).toBeCloseTo(sums.cost, 10);
  });

  it("finishes a long file after dying part way through it, having already written some", async () => {
    const path = transcript("-p", SESSION);
    const total = 1500;
    let text = "";
    for (let i = 0; i < total; i++) text += assistantLine(SESSION, `m${i}`, "2026-10-20T15:00:00Z");
    writeFileSync(path, text);
    let pauses = 0;
    const dying = new UsageReader({
      ledger,
      facts: () => facts,
      roots: async () => [{ dir: root, loginKey: null }],
      tail: {
        chunk: 32 * 1024,
        pause: async () => {
          // Past the flush a thousand rows bring, and short of the end.
          if (++pauses === 14) throw new Error("the server went away");
        },
      },
    });
    await sweep(dying);
    expect(dying.status().error).toBe("the server went away");
    const written = all("select count(*) as n from messages")[0]!.n as number;
    expect(written).toBeGreaterThan(0);
    expect(written).toBeLessThan(total);
    // What was written is whole: the rollup agrees, and the offset is short of the size.
    expect(all("select sum(messages) as n from daily")).toEqual([{ n: written }]);
    await sweep(reader());
    expect(all("select count(*) as n from messages")).toEqual([{ n: total }]);
    expect(all("select sum(messages) as n from daily")).toEqual([{ n: total }]);
    expect(all("select offset, size from files")).toEqual([{ offset: text.length, size: text.length }]);
  });

  it("does not read a half-written last line again until the file has grown", async () => {
    const path = transcript("-p", SESSION);
    writeFileSync(path, `${assistantLine(SESSION, "m1", "2026-10-20T15:00:00Z")}{"half":`);
    await sweep();
    const row = all("select offset, size, read_at from files")[0]!;
    expect(row.offset).toBeLessThan(row.size);
    expect(ledger.file(path)!.size).toBe(readFileSync(path).length);
    appendFileSync(path, `"line"}\n${assistantLine(SESSION, "m2", "2026-10-20T15:01:00Z")}`);
    await sweep();
    expect(all("select count(*) as n from messages")).toEqual([{ n: 2 }]);
    expect(all("select offset, size from files")).toEqual([{ offset: readFileSync(path).length, size: readFileSync(path).length }]);
  });

  it("keeps the messages of a transcript that was pruned, and lets its offset go", async () => {
    placeFixtures();
    await sweep();
    rmSync(join(projects, "-home-someone-project"), { recursive: true });
    await sweep();
    expect(all("select count(*) as n from files")).toEqual([{ n: 0 }]);
    expect(all("select count(*) as n from messages")).toEqual([{ n: 4 }]);
    expect(all("select sum(messages) as n from daily")).toEqual([{ n: 4 }]);
  });

  it("takes a directory that is not there as nothing known, not as everything gone", async () => {
    placeFixtures();
    await sweep();
    const moved = `${root}.away`;
    renameSync(root, moved);
    await sweep();
    expect(all("select count(*) as n from files")).toEqual([{ n: 2 }]);
    renameSync(moved, root);
  });

  it("follows a nudge to the transcript and its subagents, and refuses any other path", async () => {
    placeFixtures();
    const each = reader();
    const outside = join(dir, "outside.jsonl");
    writeFileSync(outside, assistantLine(OTHER, "stolen", "2026-10-20T00:00:00Z"));
    const link = join(projects, "-home-someone-project", "link.jsonl");
    symlinkSync(outside, link);
    for (const bad of [outside, link, join(projects, "-home-someone-project", "..", "..", "..", "outside.jsonl"), "relative.jsonl", 7, null, undefined]) each.nudge(bad);
    each.nudge(transcript("-home-someone-project", SESSION));
    (each as unknown as { pump(): void }).pump();
    await each.settled();
    expect(all("select message_id from messages order by message_id").map((row) => row.message_id)).toEqual(["msg_a", "msg_b", "msg_c", "msg_sub"]);
  });

  it("never follows a link while sweeping", async () => {
    const outside = join(dir, "outside.jsonl");
    writeFileSync(outside, assistantLine(OTHER, "stolen", "2026-10-20T00:00:00Z"));
    mkdirSync(join(projects, "-p"), { recursive: true });
    symlinkSync(outside, join(projects, "-p", "link.jsonl"));
    await sweep();
    expect(all("select count(*) as n from messages")).toEqual([{ n: 0 }]);
  });

  it("names a harness by its folder and by its title, and keeps the title across a later file", async () => {
    writeFileSync(transcript("-x-harness-pk000000000009", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), assistantLine("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "h1", "2026-10-20T00:00:00Z"));
    const titled = transcript("-a-project", SESSION);
    writeFileSync(titled, `{"type":"custom-title","customTitle":"harness","sessionId":"${SESSION}"}\n${assistantLine(SESSION, "t1", "2026-10-20T00:00:00Z")}`);
    await sweep();
    appendFileSync(titled, assistantLine(SESSION, "t2", "2026-10-20T00:01:00Z"));
    await sweep();
    expect(all("select id, kind, profile_key, attributed_by from sessions order by id")).toEqual([
      { id: SESSION, kind: "harness", profile_key: null, attributed_by: "folder" },
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", kind: "harness", profile_key: "pk000000000009", attributed_by: "folder" },
    ]);
  });

  it("moves a session's days when the database comes to know it, with no new line in the file", async () => {
    placeFixtures();
    await sweep();
    expect(all("select distinct kind, card_id, workspace_key from daily")).toEqual([{ kind: "agent", card_id: "", workspace_key: "" }]);
    expect(all("select attributed_by from sessions")).toEqual([{ attributed_by: "folder" }]);
    facts = { ...noFacts(), runs: new Map([[SESSION, { sessionId: SESSION, runId: 3, cardId: "card1", agentId: null, profileKey: "pk000000000001", workspaceKey: "wk000000000001" }]]) };
    await sweep();
    expect(all("select distinct kind, card_id, workspace_key, profile_key from daily")).toEqual([{ kind: "card", card_id: "card1", workspace_key: "wk000000000001", profile_key: "pk000000000001" }]);
    expect(all("select sum(messages) as n from daily")).toEqual([{ n: 4 }]);
    expect(all("select attributed_by, run_id from sessions")).toEqual([{ attributed_by: "card_runs", run_id: 3 }]);
  });

  it("prices a model it knows, leaves one it does not without dollars, and says how many", async () => {
    const path = transcript("-p", SESSION);
    writeFileSync(path, assistantLine(SESSION, "known", "2026-10-20T00:00:00Z") + assistantLine(SESSION, "unknown", "2026-10-20T00:01:00Z", { model: "claude-opus-9" }));
    const each = await sweep();
    expect(all("select message_id, cost_est is null as none from messages order by message_id")).toEqual([
      { message_id: "known", none: 0 },
      { message_id: "unknown", none: 1 },
    ]);
    expect(each.status().unpriced).toBe(1);
    expect(all("select model, unpriced from daily order by model")).toEqual([
      { model: "claude-opus-5-5", unpriced: 0 },
      { model: "claude-opus-9", unpriced: 1 },
    ]);
  });

  it("keeps what the program says beside the estimate, last word winning", async () => {
    placeFixtures();
    await sweep();
    expect(all("select model, cost_program, cache_write_1h, at from session_totals")).toEqual([{ model: "claude-opus-5-5", cost_program: 0.09, cache_write_1h: 1000, at: 1792500061000 }]);
    const later = JSON.parse(readFileSync(join(FIXTURES, "session.jsonl"), "utf8").trim().split("\n").at(-1)!);
    later.modelUsage["claude-opus-5-5"].costUSD = 0.5;
    appendFileSync(transcript("-home-someone-project", SESSION), `${JSON.stringify(later)}\n`);
    await sweep();
    expect(all("select cost_program from session_totals")).toEqual([{ cost_program: 0.5 }]);
  });

  it("says where it stands", async () => {
    placeFixtures();
    const each = await sweep();
    expect(each.status()).toMatchObject({ messages: 4, sessions: 1, files: 2, skipped: 1, unpriced: 0, reading: null, error: null, oldestDay: dayOf(Date.parse("2026-10-20T15:00:05Z")) });
    expect(each.status().firstPass?.files).toBe(2);
    expect(each.status().sweptAt).not.toBeNull();
  });

  it("keeps no word of a transcript", async () => {
    placeFixtures();
    await sweep();
    const tables = all("select name from sqlite_master where type = 'table'").map((row) => row.name as string);
    expect(tables).toEqual(expect.arrayContaining(["files", "sessions", "messages", "session_totals", "daily", "limits", "skipped"]));
    for (const table of tables) expect(JSON.stringify(all(`select * from ${table}`))).not.toContain(SECRET);
    ledger.close();
    for (const name of ["usage.db", "usage.db-wal"]) {
      const path = join(dir, "data", name);
      if (existsSync(path)) expect(readFileSync(path).includes(SECRET)).toBe(false);
    }
    ledger = Ledger.open(join(dir, "data", "usage.db"));
  });

  it("carries on from a write that failed, with its offsets where they were", async () => {
    placeFixtures();
    const each = reader();
    const real = ledger.flush.bind(ledger);
    let failures = 1;
    ledger.flush = (batch: LedgerBatch, known: AttributionFacts) => {
      if (failures-- > 0) throw new Error("database is locked");
      real(batch, known);
    };
    await sweep(each);
    expect(each.status().error).toBe("database is locked");
    expect(all("select count(*) as n from messages")).toEqual([{ n: 0 }]);
    await sweep(each);
    expect(each.status().error).toBeNull();
    expect(all("select count(*) as n from messages")).toEqual([{ n: 4 }]);
  });
});

describe("the ledger's file", () => {
  it("is private, and refuses a newer build's rather than misreading it", () => {
    const path = join(dir, "usage.db");
    Ledger.open(path).close();
    expect((require("node:fs").statSync(path).mode & 0o777).toString(8)).toBe("600");
    const db = new DatabaseSync(path);
    db.exec("pragma user_version = 99");
    db.close();
    expect(() => Ledger.open(path)).toThrow("newer than this build");
  });
});

describe("what the database knows", () => {
  it("names a card's session by its current board, and a login only when one profile holds it", () => {
    const store = Store.open(join(dir, "kururu.db"));
    const db = new DatabaseSync(join(dir, "kururu.db"));
    db.exec(`
      insert into profiles(key, name, login_key, created_at) values ('pk000000000001', 'A', 'aaaaaaaaaaaa', 1), ('pk000000000002', 'B', 'bbbbbbbbbbbb', 1), ('pk000000000003', 'C', 'bbbbbbbbbbbb', 1);
      insert into workspaces(key, profile_key, name, created_at) values ('wk000000000001', 'pk000000000001', 'W', 1);
      insert into boards(id, profile_key, workspace_key, created_at) values ('b1', 'pk000000000001', 'wk000000000001', 1), ('b2', 'pk000000000001', null, 1);
      insert into cards(id, board_id, number, title, column_id, position, created_at, updated_at) values ('c1', 'b1', 1, 'T', 'todo', 0, 1, 1), ('c2', 'b2', 1, 'T', 'todo', 0, 1, 1);
      insert into card_runs(card_id, launcher, label, state, started_at, session_id, agent_id) values ('c1', 'claude', 'L', 'done', 1, 's1', null), ('c2', 'claude', 'L', 'done', 2, 's2', 'a7'), ('c1', 'claude', 'L', 'done', 3, 's2', null), ('c1', 'claude', 'L', 'done', 4, null, null);
      insert into conversations(id, profile_key, kind, started_at) values ('s3', 'pk000000000002', 'harness', 1);
    `);
    db.close();
    const facts = store.usageAttribution();
    store.close();
    expect(facts.runs.get("s1")).toMatchObject({ cardId: "c1", workspaceKey: "wk000000000001", profileKey: "pk000000000001" });
    // The later run of a session wins.
    expect(facts.runs.get("s2")).toMatchObject({ cardId: "c1" });
    expect(facts.runs.size).toBe(2);
    expect(facts.conversations.get("s3")).toEqual({ sessionId: "s3", kind: "harness", profileKey: "pk000000000002" });
    expect(facts.profileOfLogin.get("aaaaaaaaaaaa")).toBe("pk000000000001");
    expect(facts.profileOfLogin.has("bbbbbbbbbbbb")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Launches
// ---------------------------------------------------------------------------

describe("whose a session is, from its launch", () => {
  const PROJECT = "-home-someone-project";
  const launch = (over: Partial<LaunchRow> = {}): LaunchRow & { sessionId: string } => ({
    agentId: "a1",
    sessionId: SESSION,
    program: "claude",
    profileKey: "pk000000000001",
    workspaceKey: "wk000000000001",
    cardId: null,
    kind: "agent",
    node: "mac",
    machine: null,
    loginDir: "/login",
    cwd: "/home/someone/project",
    at: Date.parse("2026-10-20T11:00:00Z"),
    ...over,
    sessionId: over.sessionId ?? SESSION,
  });

  let ledger: Ledger;
  const db = () => new DatabaseSync(join(dir, "usage.db"), { readOnly: true });
  const rows = (sql: string): Record<string, any>[] => {
    const read = db();
    try {
      return read.prepare(sql).all() as Record<string, any>[];
    } finally {
      read.close();
    }
  };
  /** A pass of the reader over one message, as a log with only a folder to go on would give it. */
  const sighting = (id: string, at: string, facts: AttributionFacts = noFacts()) => {
    const batch = new LedgerBatch();
    const when = Date.parse(at);
    batch.addMessage({ sessionId: SESSION, messageId: id, at: when, model: "claude-opus-5-5", requestedModel: null, effort: null, input: 1, write5m: 0, write1h: 0, read: 10, output: 2, thinking: 0, costEst: 0.01, sidechain: false, source: "transcript" });
    batch.addSession({ id: SESSION, program: "claude", loginDir: "/login/real", cwd: "/home/someone/project", version: "2.1.311", firstAt: when, lastAt: when, parentSession: null, seen: { projectDir: PROJECT, titled: false, loginKey: null } });
    ledger.flush(batch, facts);
  };

  beforeEach(() => {
    ledger = Ledger.open(join(dir, "usage.db"));
  });
  afterEach(() => {
    ledger.close();
  });

  it("writes the row before there is a word in any log, and the log only adds to it", () => {
    ledger.recordLaunch(launch({ cardId: "card1", kind: "card" }));
    expect(rows("select attributed_by, kind, workspace_key, card_id, node, agent_id, last_at from sessions")).toEqual([
      { attributed_by: "spawn", kind: "card", workspace_key: "wk000000000001", card_id: "card1", node: "mac", agent_id: "a1", last_at: launch().at },
    ]);
    sighting("m1", "2026-10-20T11:00:05Z");
    const [row] = rows("select * from sessions");
    expect(row).toMatchObject({ attributed_by: "spawn", card_id: "card1", started_at: launch().at, last_at: Date.parse("2026-10-20T11:00:05Z"), version: "2.1.311", project_dir: PROJECT, login_dir: "/login/real" });
    expect(rows("select workspace_key, card_id, kind, node, messages from daily")).toEqual([{ workspace_key: "wk000000000001", card_id: "card1", kind: "card", node: "mac", messages: 1 }]);
  });

  it("moves what a folder already claimed when the launch is heard second", () => {
    sighting("m1", "2026-10-20T11:00:05Z");
    expect(rows("select workspace_key, kind, node from daily")).toEqual([{ workspace_key: "", kind: "agent", node: "" }]);
    ledger.recordLaunch(launch());
    expect(rows("select workspace_key, kind, node, messages from daily")).toEqual([{ workspace_key: "wk000000000001", kind: "agent", node: "mac", messages: 1 }]);
    expect(rows("select attributed_by from sessions")).toEqual([{ attributed_by: "spawn" }]);
  });

  it("keeps a card picked back up as the one row it was, on its newest terminal and run", () => {
    ledger.recordLaunch(launch({ cardId: "card1", kind: "card" }));
    sighting("m1", "2026-10-20T11:00:05Z");
    const later = Date.parse("2026-10-20T15:00:00Z");
    ledger.recordLaunch(launch({ cardId: "card1", kind: "card", agentId: "a9", at: later }));
    const facts: AttributionFacts = { ...noFacts(), runs: new Map([[SESSION, { sessionId: SESSION, runId: 7, cardId: "card1", agentId: null, profileKey: "pk000000000001", workspaceKey: "wk000000000001" }]]) };
    expect(ledger.reattribute(facts)).toBe(1);
    expect(rows("select id, agent_id, run_id, attributed_by, started_at from sessions")).toEqual([{ id: SESSION, agent_id: "a9", run_id: 7, attributed_by: "spawn", started_at: launch().at }]);
    expect(ledger.reattribute(facts)).toBe(0);
    ledger.recordLaunch(launch({ cardId: "card1", kind: "card", agentId: "a10", at: later + 1 }));
    expect(rows("select run_id from sessions")).toEqual([{ run_id: 7 }]);
  });

  it("does not let the database's word about a run move a launch", () => {
    ledger.recordLaunch(launch({ cardId: "card1", kind: "card" }));
    // The card has since been sent to another workspace. The tokens were spent where it was.
    const facts: AttributionFacts = { ...noFacts(), runs: new Map([[SESSION, { sessionId: SESSION, runId: 7, cardId: "card1", agentId: null, profileKey: "pk000000000001", workspaceKey: "wk000000000002" }]]) };
    ledger.reattribute(facts);
    expect(rows("select workspace_key, run_id from sessions")).toEqual([{ workspace_key: "wk000000000001", run_id: 7 }]);
  });

  it("takes a hook's word only for a session nothing better has named", () => {
    const by = (attributedBy: Attribution["attributedBy"]): Attribution => ({ profileKey: null, workspaceKey: null, cardId: null, runId: null, agentId: null, kind: "agent", attributedBy });
    expect(reportNames(null)).toBe(true);
    expect(reportNames(by("folder"))).toBe(true);
    expect(reportNames(by("card_runs"))).toBe(true);
    expect(reportNames(by("report"))).toBe(false);
    expect(reportNames(by("spawn"))).toBe(false);

    sighting("m1", "2026-10-20T11:00:05Z");
    expect(ledger.recordReport(launch({ agentId: "a4" }))).toBe(true);
    expect(rows("select attributed_by, agent_id from sessions")).toEqual([{ attributed_by: "report", agent_id: "a4" }]);
    expect(rows("select workspace_key from daily")).toEqual([{ workspace_key: "wk000000000001" }]);
    // Resumed by hand in another workspace's shell: it began where it began.
    expect(ledger.recordReport(launch({ agentId: "a5", workspaceKey: "wk000000000002" }))).toBe(false);
    ledger.recordLaunch(launch({ agentId: "a6" }));
    expect(ledger.recordReport(launch({ agentId: "a7", workspaceKey: "wk000000000002" }))).toBe(false);
    expect(rows("select attributed_by, agent_id, workspace_key from sessions")).toEqual([{ attributed_by: "spawn", agent_id: "a6", workspace_key: "wk000000000001" }]);
  });

  const waiting = (over: Partial<WaitingLaunch> = {}): WaitingLaunch => ({ ...launch({ program: "codex", loginDir: join(dir, "codex"), cwd: dir }), sessionId: null, agentId: "a1", ...over });

  it("keeps a launch with no id on disk, for a server that restarts before the id is known", () => {
    ledger.addWaiting(waiting());
    ledger.close();
    ledger = Ledger.open(join(dir, "usage.db"));
    expect(ledger.waiting().map((each) => each.agentId)).toEqual(["a1"]);
    expect(ledger.settleWaiting("a2", OTHER)).toBe(false);
    expect(ledger.settleWaiting("a1", OTHER)).toBe(true);
    expect(ledger.waiting()).toEqual([]);
    expect(rows("select id, program, attributed_by, started_at from sessions")).toEqual([{ id: OTHER, program: "codex", attributed_by: "spawn", started_at: waiting().at }]);
    expect(ledger.settleWaiting("a1", OTHER)).toBe(false);
  });

  it("gives a reused terminal id to its newest launch, and forgets one a week old", () => {
    const at = waiting().at;
    ledger.addWaiting(waiting({ at: at - 1000, workspaceKey: "wk000000000009" }));
    ledger.addWaiting(waiting({ at }));
    expect(ledger.settleWaiting("a1", OTHER)).toBe(true);
    expect(rows("select workspace_key from sessions")).toEqual([{ workspace_key: "wk000000000001" }]);
    ledger.dropWaitingBefore(at);
    expect(ledger.waiting()).toEqual([]);
  });

  it("matches a rollout to a launch by folder and time, and nothing else", () => {
    const at = waiting().at;
    const here = (agentId: string, over: Partial<WaitingLaunch> = {}) => waiting({ agentId, ...over });
    const rollout = (id: string, delta: number, cwd: string | null = dir) => ({ id, cwd, at: at + delta });
    const ids = (found: ReturnType<typeof matchRollouts>) => found.map((each) => `${each.launch.agentId}=${each.sessionId}`);

    expect(ids(matchRollouts([here("a1")], [rollout("r", 8_000)], new Set()))).toEqual(["a1=r"]);
    expect(ids(matchRollouts([here("a1")], [rollout("other folder", 8_000, "/elsewhere")], new Set()))).toEqual([]);
    expect(ids(matchRollouts([here("a1")], [rollout("no folder", 8_000, null)], new Set()))).toEqual([]);
    expect(ids(matchRollouts([here("a1")], [rollout("too old", -60_000)], new Set()))).toEqual([]);
    expect(ids(matchRollouts([here("a1")], [rollout("too late", ROLLOUT_LATE_MS + 1)], new Set()))).toEqual([]);
    expect(ids(matchRollouts([here("a1")], [rollout("a card's", 8_000)], new Set(["a card's"])))).toEqual([]);
    // Two tabs in one folder: one rollout each, the earliest to the earliest.
    expect(ids(matchRollouts([here("a2", { at: at + 2000 }), here("a1")], [rollout("r2", 9_000), rollout("r1", 8_000)], new Set()))).toEqual(["a1=r1", "a2=r2"]);
  });

  describe("the book", () => {
    let logged: string[];
    let book: Launches;
    beforeEach(() => {
      logged = [];
      book = new Launches({ ledger, cardSessions: () => new Set(), log: (line) => logged.push(line) });
    });

    it("never lets a launch that cannot be written reach the road that started the agent", () => {
      ledger.close();
      expect(() => book.spawned(launch())).not.toThrow();
      expect(() => book.learned("a1", OTHER)).not.toThrow();
      expect(() => book.reported(OTHER, () => launch())).not.toThrow();
      expect(logged.length).toBe(3);
      ledger = Ledger.open(join(dir, "usage.db"));
    });

    it("waits only for a program whose id can be found, and refuses an id that is not one", () => {
      book.spawned({ ...launch({ program: "codex" }), sessionId: null });
      book.spawned({ ...launch({ program: "opencode", agentId: "a2" }), sessionId: null });
      book.spawned({ ...launch({ agentId: "a3" }), sessionId: "not an id; drop table sessions" });
      expect(ledger.waiting().map((each) => each.agentId)).toEqual(["a1"]);
      expect(rows("select count(*) as n from sessions")).toEqual([{ n: 0 }]);
    });

    it("asks who a hook's terminal is once per session, and ignores what is not an id", () => {
      let asked = 0;
      const who = () => {
        asked++;
        return launch();
      };
      book.reported(SESSION, who);
      book.reported(SESSION, who);
      book.reported(undefined, who);
      book.reported(42, who);
      book.reported("not an id; really", who);
      expect(asked).toBe(1);
      expect(rows("select attributed_by from sessions")).toEqual([{ attributed_by: "report" }]);
    });

    it("finds a menu's Codex tab by folder and time, and takes nothing of the rollout but its id", async () => {
      const at = Date.now();
      const stamp = new Date(at + 8_000);
      const pad = (n: number) => String(n).padStart(2, "0");
      const day = join(dir, "codex", "sessions", String(stamp.getFullYear()), pad(stamp.getMonth() + 1), pad(stamp.getDate()));
      mkdirSync(day, { recursive: true });
      const write = (id: string, cwd: string) =>
        writeFileSync(
          join(day, `rollout-x-${id}.jsonl`),
          `${JSON.stringify({ timestamp: stamp.toISOString(), type: "session_meta", payload: { id, timestamp: stamp.toISOString(), cwd, instructions: SECRET } })}\n${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: SECRET } })}\n`,
        );
      // Through a link, as `/tmp` is on a Mac: Codex records where the link goes.
      const real = realpathSync(dir);
      const link = join(dir, "link");
      symlinkSync(real, link);
      write(SESSION, real);
      write(OTHER, "/elsewhere");
      book.spawned({ ...waiting({ cwd: link, at }) });
      book.spawned({ ...waiting({ agentId: "a2", cwd: real, at, cardId: "card1", kind: "card" }) });
      book.spawned({ ...waiting({ agentId: "a3", cwd: real, at, machine: "box" }) });

      expect(await book.lookForWaiting(at + 20_000)).toBe(1);
      expect(rows("select id, program, agent_id, attributed_by from sessions")).toEqual([{ id: SESSION, program: "codex", agent_id: "a1", attributed_by: "spawn" }]);
      // The card waits for its own words, and the machine for the remote reader.
      expect(ledger.waiting().map((each) => each.agentId)).toEqual(["a2", "a3"]);
      // Nothing left to claim it twice, and the second look is quiet.
      expect(await book.lookForWaiting(at + 30_000)).toBe(0);
      ledger.close();
      for (const name of ["usage.db", "usage.db-wal"]) {
        const raw = join(dir, name);
        if (existsSync(raw)) expect(readFileSync(raw).includes(SECRET)).toBe(false);
      }
      ledger = Ledger.open(join(dir, "usage.db"));
    });
  });
});
