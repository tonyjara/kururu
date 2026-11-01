/**
 * OpenCode's half of the usage ledger: its `message.data` blob, wherever it
 * comes from, and the one-time read of the files it kept before 1.2.0.
 *
 * Against a temp directory and the hand-written fixture in
 * `fixtures/usage/opencode-message.json`, with the real field names and
 * made-up numbers — never a copy of a real message, which holds whatever the
 * user asked for.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { opencodeLegacyFiles, parseOpencodeMessage } from "../src/usage/opencode";
import { Ledger } from "../src/usage/store";
import { UsageReader } from "../src/usage/sweep";
import { noFacts, type AttributionFacts } from "../../shared/usage";

const FIXTURE = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "usage", "opencode-message.json"), "utf8"));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kururu-opencode-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("parsing a message blob", () => {
  it("reads tokens and prices an Anthropic model off the same table Claude Code is", () => {
    const parsed = parseOpencodeMessage(FIXTURE, FIXTURE.sessionID, FIXTURE.id);
    if (parsed.kind !== "message") throw new Error(parsed.kind);
    expect(parsed.row).toMatchObject({ sessionId: FIXTURE.sessionID, messageId: "msg_a", model: "claude-opus-5-5", input: 103, write5m: 10, write1h: 0, read: 16000, output: 25, thinking: 32, sidechain: false, source: "opencode" });
    expect(parsed.row.at).toBe(1792500005000);
    expect(parsed.row.costEst).toBeGreaterThan(0);
    expect(parsed.cwd).toBe("/home/someone/project");
  });

  it("takes the string a database column hands back the same as an object", () => {
    const parsed = parseOpencodeMessage(JSON.stringify(FIXTURE), FIXTURE.sessionID, FIXTURE.id);
    expect(parsed.kind).toBe("message");
  });

  it("leaves a model this table has not priced unpriced, never guessed", () => {
    const parsed = parseOpencodeMessage({ ...FIXTURE, modelID: "kimi-k2.5", providerID: "moonshotai" }, FIXTURE.sessionID, FIXTURE.id);
    if (parsed.kind !== "message") throw new Error(parsed.kind);
    expect(parsed.row.costEst).toBeNull();
  });

  it("is not a row when nothing billed, and not an error either", () => {
    const aborted = { ...FIXTURE, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } };
    expect(parseOpencodeMessage(aborted, FIXTURE.sessionID, FIXTURE.id).kind).toBe("other");
  });

  it("is not a row when it is not an assistant's turn", () => {
    expect(parseOpencodeMessage({ ...FIXTURE, role: "user" }, FIXTURE.sessionID, FIXTURE.id).kind).toBe("other");
  });

  it("refuses a count that is not one, and an id that looks like an attack", () => {
    expect(parseOpencodeMessage({ ...FIXTURE, tokens: { ...FIXTURE.tokens, input: "a lot" } }, FIXTURE.sessionID, FIXTURE.id)).toEqual({ kind: "skip", why: "a count that is not a number" });
    expect(parseOpencodeMessage(FIXTURE, "ses_x; drop table", FIXTURE.id).kind).toBe("skip");
  });

  it("skips what will not parse as JSON", () => {
    expect(parseOpencodeMessage("{not json", FIXTURE.sessionID, FIXTURE.id)).toEqual({ kind: "skip", why: "not JSON" });
  });
});

describe("listing the legacy files", () => {
  it("finds one message to a file under each session's folder", async () => {
    const base = join(dir, "storage", "message");
    mkdirSync(join(base, "ses_a"), { recursive: true });
    mkdirSync(join(base, "ses_b"), { recursive: true });
    writeFileSync(join(base, "ses_a", "msg_1.json"), "{}");
    writeFileSync(join(base, "ses_a", "msg_2.json"), "{}");
    writeFileSync(join(base, "ses_b", "msg_3.json"), "{}");
    writeFileSync(join(base, "ses_b", "not-a-message.txt"), "x");
    const found = (await opencodeLegacyFiles(base)).sort((a, b) => a.path.localeCompare(b.path));
    expect(found).toEqual([
      { path: join(base, "ses_a", "msg_1.json"), sessionId: "ses_a", messageId: "msg_1" },
      { path: join(base, "ses_a", "msg_2.json"), sessionId: "ses_a", messageId: "msg_2" },
      { path: join(base, "ses_b", "msg_3.json"), sessionId: "ses_b", messageId: "msg_3" },
    ]);
  });

  it("says nothing is there rather than erroring on a directory that does not exist", async () => {
    expect(await opencodeLegacyFiles(join(dir, "nowhere"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The reader, against a temp database and a temp directory
// ---------------------------------------------------------------------------

describe("the reader on an OpenCode home", () => {
  let home: string;
  let ledger: Ledger;
  let facts: AttributionFacts;

  function reader(): UsageReader {
    return new UsageReader({
      ledger,
      facts: () => facts,
      roots: async () => [],
      codexRoots: async () => [],
      opencodeHome: () => home,
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
  function openDb(): DatabaseSync {
    const db = new DatabaseSync(join(home, "opencode.db"));
    db.exec("create table message (id text primary key, session_id text not null, time_created integer not null, time_updated integer not null, data text not null)");
    return db;
  }
  function insert(db: DatabaseSync, id: string, sessionId: string, timeUpdated: number, data: Record<string, unknown>): void {
    db.prepare("insert into message(id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)").run(id, sessionId, timeUpdated, timeUpdated, JSON.stringify(data));
  }

  beforeEach(() => {
    home = join(dir, "opencode");
    mkdirSync(home, { recursive: true });
    ledger = Ledger.open(join(dir, "data", "usage.db"));
    facts = noFacts();
  });
  afterEach(() => {
    ledger.close();
  });

  it("reads a message off the database and attributes it by its folder", async () => {
    const db = openDb();
    insert(db, "msg_a", FIXTURE.sessionID, 10, FIXTURE);
    db.close();
    const each = reader();
    each.sweepSoon();
    await each.settled();
    expect(all("select session_id, model, input, cache_read, output from messages")).toEqual([{ session_id: FIXTURE.sessionID, model: "claude-opus-5-5", input: 103, cache_read: 16000, output: 25 }]);
    expect(all("select program, kind, attributed_by from sessions")).toEqual([{ program: "opencode", kind: "agent", attributed_by: "folder" }]);
  });

  it("reads only what is new since the last watermark, across a restart", async () => {
    const db = openDb();
    insert(db, "msg_a", FIXTURE.sessionID, 10, FIXTURE);
    db.close();
    await (async () => {
      const each = reader();
      each.sweepSoon();
      await each.settled();
    })();

    const db2 = new DatabaseSync(join(home, "opencode.db"));
    insert(db2, "msg_b", FIXTURE.sessionID, 20, { ...FIXTURE, id: "msg_b", cost: 0.1, tokens: { ...FIXTURE.tokens, input: 7 } });
    db2.close();
    const second = reader();
    second.sweepSoon();
    await second.settled();
    expect(all("select count(*) as n from messages")).toEqual([{ n: 2 }]);
    expect(all("select input from messages order by at")[1]).toEqual({ input: 7 });
  });

  it("knows Kuru's own folder on OpenCode the same way it knows Claude Code's", async () => {
    const db = openDb();
    const cwd = "/x/.local/share/kururu/harness/pk8e5c585ab108";
    insert(db, "msg_a", FIXTURE.sessionID, 10, { ...FIXTURE, path: { cwd, root: cwd } });
    db.close();
    const each = reader();
    each.sweepSoon();
    await each.settled();
    expect(all("select kind, profile_key, attributed_by from sessions")).toEqual([{ kind: "harness", profile_key: "pk8e5c585ab108", attributed_by: "folder" }]);
  });

  it("backfills the legacy files once, and never scans the directory again", async () => {
    const legacy = join(home, "storage", "message", "ses_old");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "msg_old.json"), JSON.stringify({ ...FIXTURE, id: "msg_old", sessionID: "ses_old" }));
    const each = reader();
    each.sweepSoon();
    await each.settled();
    expect(all("select message_id from messages")).toEqual([{ message_id: "msg_old" }]);

    // A file that shows up later under the same directory is not read: the backfill is once, ever.
    writeFileSync(join(legacy, "msg_new.json"), JSON.stringify({ ...FIXTURE, id: "msg_new", sessionID: "ses_old" }));
    const again = reader();
    again.sweepSoon();
    await again.settled();
    expect(all("select message_id from messages order by message_id")).toEqual([{ message_id: "msg_old" }]);
  });

  it("keeps no word of a message, only its numbers", async () => {
    const db = openDb();
    insert(db, "msg_a", FIXTURE.sessionID, 10, { ...FIXTURE, note: "OPENCODESECRET should never reach a table" });
    db.close();
    const each = reader();
    each.sweepSoon();
    await each.settled();
    for (const table of ["messages", "sessions", "files"]) {
      expect(JSON.stringify(all(`select * from ${table}`))).not.toContain("OPENCODESECRET");
    }
  });
});
