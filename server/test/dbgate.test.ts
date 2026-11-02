/**
 * The database viewer's one safety: every transaction is `BEGIN READ ONLY`
 * unless the viewer's switch said otherwise, and it is Postgres that refuses
 * the write.
 *
 * `databases.test.ts` covers the pure half in `shared/`. This drives
 * `server/src/databases.ts` itself against a stand-in for `pg`, which records
 * every statement and refuses a write inside a read-only transaction with
 * Postgres's own sentence — so what is held here is what kururu sends, in what
 * order, and that a refusal comes back as the person's answer rather than as
 * a committed row. The URL is read from a real env file in a scratch
 * directory, because "read at the moment of connecting, and checked against
 * what the client was told" is the other half of the gate.
 *
 * `mock.module` replaces `pg` for the whole test process; nothing else in the
 * suite imports it, and this file imports `databases.ts` only after the
 * replacement is in place.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

class DatabaseError extends Error {
  detail?: string;
  hint?: string;
}

interface Statement {
  text: string;
  /** The transaction it ran in, as BEGIN opened it; null outside one. */
  mode: "READ ONLY" | "READ WRITE" | null;
}

const log: Statement[] = [];
const configs: { connectionString?: string }[] = [];
let released = 0;
/** The next plain statement fails with this, as a syntax error would. */
let failNext: string | null = null;

const WRITES = /^\s*(insert|update|delete|drop|create|alter|truncate)\b/i;

class FakeClient {
  private mode: Statement["mode"] = null;
  async query(arg: string | { text: string }) {
    const text = typeof arg === "string" ? arg : arg.text;
    const begin = /^BEGIN (READ ONLY|READ WRITE)$/.exec(text);
    if (begin) this.mode = begin[1] as Statement["mode"];
    log.push({ text, mode: this.mode });
    if (text === "COMMIT" || text === "ROLLBACK") this.mode = null;
    if (/^DECLARE /.test(text) && WRITES.test(text.replace(/^DECLARE kururu_read NO SCROLL CURSOR FOR /, ""))) {
      throw new DatabaseError("syntax error at or near \"INSERT\"");
    }
    if (failNext && !/^(BEGIN|SET|SAVEPOINT|ROLLBACK|COMMIT|DECLARE|FETCH|CLOSE)/.test(text)) {
      const message = failNext;
      failNext = null;
      throw new DatabaseError(message);
    }
    if (WRITES.test(text) && this.mode === "READ ONLY") {
      const err = new DatabaseError(`cannot execute ${text.trim().split(/\s+/)[0]!.toUpperCase()} in a read-only transaction`);
      throw err;
    }
    if (/^FETCH /.test(text)) return { rows: [["1"]], fields: [{ name: "n", dataTypeID: 23 }], rowCount: 1, command: "FETCH" };
    if (WRITES.test(text)) return { rows: [], fields: [], rowCount: 1, command: text.trim().split(/\s+/)[0]!.toUpperCase() };
    return { rows: [], fields: [], rowCount: null, command: "SET" };
  }
  release() {
    released++;
  }
}

class FakePool {
  private connectHooks: ((client: FakeClient) => void)[] = [];
  constructor(config: { connectionString?: string }) {
    configs.push(config);
  }
  on(event: string, hook: (client: FakeClient) => void) {
    if (event === "connect") this.connectHooks.push(hook);
    return this;
  }
  async connect() {
    const client = new FakeClient();
    for (const hook of this.connectHooks) hook(client);
    return client;
  }
  async end() {}
}

mock.module("pg", () => {
  const pg = { Pool: FakePool, DatabaseError };
  return { default: pg, ...pg };
});

const db = await import("../src/databases");

const URL = "postgres://app:s3cret@db.example:5432/shop";
let dir = "";
let id = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kururu-dbgate-"));
  writeFileSync(join(dir, ".env"), `DATABASE_URL=${URL}\n`);
  const found = await db.scanDatabases([{ workspaceId: "w1", project: dir, roots: [dir] }]);
  expect(found).toHaveLength(1);
  id = found[0]!.id;
});

afterAll(async () => {
  await db.closeDatabasePools();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  log.length = 0;
  released = 0;
  failNext = null;
});

/** The statements of the request, without the session default the pool sets on connect. */
const sent = () => log.filter((s) => !s.text.startsWith("SET default_transaction_read_only")).map((s) => s.text);

describe("the READ ONLY gate", () => {
  it("never tells a client the URL, and hands the driver the file's own", async () => {
    const found = await db.scanDatabases([{ workspaceId: "w1", project: dir, roots: [dir] }]);
    expect(JSON.stringify(found)).not.toContain("s3cret");
    await db.dbQuery(id, undefined, "select 1", false);
    expect(configs.at(-1)?.connectionString).toBe(URL);
  });

  it("makes read-only the session's default on every new connection", async () => {
    await db.closeDatabasePools();
    await db.dbQuery(id, undefined, "select 1", false);
    expect(log[0]?.text).toBe("SET default_transaction_read_only = on");
  });

  it("runs a read in BEGIN READ ONLY, with a local timeout, and rolls it back", async () => {
    const result = await db.dbQuery(id, undefined, "select 1 as n", false);
    const statements = sent();
    expect(statements[0]).toBe("BEGIN READ ONLY");
    expect(statements[1]).toMatch(/^SET LOCAL statement_timeout = \d+$/);
    expect(statements).toContain("DECLARE kururu_read NO SCROLL CURSOR FOR select 1 as n");
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
    expect(result.rows).toEqual([["1"]]);
    expect(released).toBe(1);
  });

  it("lets Postgres refuse a write, and says its sentence", async () => {
    await expect(db.dbQuery(id, undefined, "insert into orders values (1)", false)).rejects.toThrow(
      "cannot execute INSERT in a read-only transaction",
    );
    const statements = sent();
    expect(statements[0]).toBe("BEGIN READ ONLY");
    // The write reached Postgres inside the read-only transaction — no regex
    // here judged it first — and nothing was committed after the refusal.
    expect(log.find((s) => s.text.startsWith("insert"))?.mode).toBe("READ ONLY");
    expect(statements).not.toContain("COMMIT");
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(released).toBe(1);
  });

  it("refuses a write however it is dressed, because the transaction does the deciding", async () => {
    for (const sql of ["  DELETE FROM orders", "drop table orders", "update orders set paid = true"]) {
      log.length = 0;
      await expect(db.dbQuery(id, undefined, sql, false)).rejects.toThrow("in a read-only transaction");
      expect(sent()[0]).toBe("BEGIN READ ONLY");
      expect(sent()).not.toContain("COMMIT");
    }
  });

  it("sends READ WRITE and commits only when the viewer's switch says so", async () => {
    const result = await db.dbQuery(id, undefined, "insert into orders values (1)", true);
    const statements = sent();
    expect(statements[0]).toBe("BEGIN READ WRITE");
    expect(statements.at(-1)).toBe("COMMIT");
    expect(result.command).toBe("INSERT");
    expect(result.rowCount).toBe(1);
  });

  it("rolls back a write that failed, even with the switch on", async () => {
    failNext = "relation \"orderz\" does not exist";
    await expect(db.dbQuery(id, undefined, "insert into orderz values (1)", true)).rejects.toThrow("does not exist");
    expect(sent()).not.toContain("COMMIT");
    expect(sent().at(-1)).toBe("ROLLBACK");
    expect(released).toBe(1);
  });

  it("reads the catalogue and a table's rows read-only too", async () => {
    await db.dbCatalog(id, undefined);
    expect(sent()[0]).toBe("BEGIN READ ONLY");
    expect(sent().at(-1)).toBe("ROLLBACK");
    log.length = 0;
    await db.dbRows(id, undefined, "public", "orders", 0, 50);
    expect(sent()[0]).toBe("BEGIN READ ONLY");
    expect(sent().at(-1)).toBe("ROLLBACK");
  });

  it("refuses to connect once the file points somewhere else than the client was told", async () => {
    await db.closeDatabasePools();
    writeFileSync(join(dir, ".env"), "DATABASE_URL=postgres://app:s3cret@elsewhere.example:5432/shop\n");
    try {
      await expect(db.dbQuery(id, undefined, "select 1", false)).rejects.toThrow("has changed since the list was made");
      expect(log).toHaveLength(0);
    } finally {
      writeFileSync(join(dir, ".env"), `DATABASE_URL=${URL}\n`);
    }
  });

  it("knows nothing of an id the scan did not find", async () => {
    await expect(db.dbQuery("not-an-id", undefined, "select 1", false)).rejects.toThrow("no longer in the workspace's env files");
  });
});
