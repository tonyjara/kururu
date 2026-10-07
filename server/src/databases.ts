/**
 * The databases a workspace's env files name, and asking one of them things.
 *
 * `shared/databases.ts` argues for reading `DATABASE_URL` out of the project
 * rather than asking anybody to register a database; this is the half that
 * reads the files, holds the connections, and runs what the viewer asks. Three
 * rules shape it, and the first is the one the others serve.
 *
 * **The URL is read at the moment of connecting and never held.** The scan
 * remembers *where* a URL is — which file, which variable — and what it
 * pointed at when it was read, and a client is told the where and the what.
 * When a client asks to connect, the file is read again, the variable is
 * parsed again, and the URL goes into the driver and nowhere else. It is the
 * rule `usage.ts` keeps with a Claude credential, for the same reason: a
 * secret that is never in a module variable cannot end up in a log line, a
 * snapshot or a crash report by somebody's later edit.
 *
 * **Every transaction is read-only unless the viewer said otherwise, and it is
 * Postgres that enforces it.** A query runs inside `BEGIN READ ONLY`, and
 * Postgres refuses an `INSERT`, an `UPDATE` or a `DROP` inside one with a
 * sentence that says why. No regex here decides whether a query writes,
 * because every such regex is wrong about something — a `WITH ... DELETE`, a
 * function that writes, a `SELECT ... INTO`. The viewer's writes switch sends
 * `BEGIN READ WRITE` instead, and that is the whole difference. A statement
 * timeout is set beside it, `LOCAL` to the transaction so a pooler in
 * transaction mode cannot lose it.
 *
 * **A result is bounded before it is read.** A `SELECT *` typed at a table of
 * ten million rows must not become ten million rows in this process's memory
 * before the cap is applied: a query that looks like a read is declared as a
 * cursor and fetched one page past the cap, and anything else runs plainly
 * with the timeout as its bound. The row cap, the cell cap and the timeout are
 * all in `shared/databases.ts`, beside the types that carry them.
 *
 * On the restartable side, beside `vps.ts` and `usage.ts`, for their reason:
 * nothing here has anything to do with a pty, and editing it costs a reconnect
 * and no agents. A pool that was open when the server restarted is a TCP
 * connection the server closes on its way out; the viewer opens another.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";

import pg from "pg";

import {
  clipCell,
  databaseId,
  DB_QUERY_TIMEOUT_MS,
  DB_ROW_CAP,
  discoverDatabases,
  isEnvFile,
  looksLikeSelect,
  parseDotenv,
  parsePostgresUrl,
  quoteIdent,
  sortEnvFiles,
  trimSql,
  typeName,
  withDatabase,
  type DbCatalog,
  type DbColumn,
  type DbRelKind,
  type DbResult,
  type DbRows,
  type DbSchema,
  type DbTarget,
  type WorkspaceDatabase,
} from "../../shared/databases";

/** A workspace and the directories its env files are looked for in. */
export interface DatabaseScanInput {
  workspaceId: string;
  /** The project root — what the file labels are relative to, and what the id is minted from. */
  project: string;
  /** Every root a terminal of the workspace is in, the project among them. */
  roots: string[];
}

/** Where an entry's URL lives, which is all the server keeps of it. */
interface Source {
  project: string;
  /** The env file, absolute. */
  path: string;
  /** Its label in the viewer — relative to the project. */
  file: string;
  /** The variable holding the URL. */
  key: string;
  /** What it pointed at when it was last read, which a connect checks it still does. */
  target: DbTarget;
}

/** Largest env file worth reading. One past this is not an env file. */
const ENV_FILE_MAX = 1 << 20;

/**
 * How long a pool nobody has used is kept, and how often that is checked. A
 * viewer that was closed and reopened within a couple of minutes gets the
 * connection it had; one that was closed for the afternoon costs the database
 * nothing in the meantime.
 */
const POOL_IDLE_MS = 2 * 60_000;
const POOL_SWEEP_MS = 60_000;

/** Connections per pool. A viewer asks one thing at a time; two is the catalogue behind a slow query. */
const POOL_MAX = 2;

/** How long to wait for a server before saying it is not there. */
const CONNECT_TIMEOUT_MS = 10_000;

/** What `pg_stat_activity` on the far side will call us. */
const APPLICATION_NAME = "kururu";

const sources = new Map<string, Source>();

/** Env files already read, by path, so a poll that finds nothing changed reads nothing. */
const fileCache = new Map<string, { mtimeMs: number; size: number; text: string }>();

const pools = new Map<string, { pool: pg.Pool; used: number }>();

let sweeper: ReturnType<typeof setInterval> | null = null;

/**
 * Every database every given workspace's env files name.
 *
 * Called from the branch poll with the roots that walk found, so this never
 * learns a directory from a client. Cheap by design: a `readdir` per root, a
 * `stat` per env file, and a read only when the file has changed since it was
 * last read. The registry of sources is replaced wholesale, which is what makes
 * an entry whose line was deleted stop answering.
 */
export async function scanDatabases(inputs: DatabaseScanInput[]): Promise<WorkspaceDatabase[]> {
  const found: WorkspaceDatabase[] = [];
  const next = new Map<string, Source>();
  const seenPaths = new Set<string>();
  for (const input of inputs) {
    const files: { file: string; text: string; path: string }[] = [];
    for (const root of input.roots) {
      let names: string[];
      try {
        names = await readdir(root);
      } catch {
        continue;
      }
      for (const name of sortEnvFiles(names.filter(isEnvFile))) {
        const path = join(root, name);
        const text = await readEnvFile(path);
        if (text === null) continue;
        seenPaths.add(path);
        files.push({ file: relative(input.project, path) || name, text, path });
      }
    }
    for (const entry of discoverDatabases(files)) {
      const id = databaseId(input.project, entry);
      const first = files.find((f) => f.file === entry.files[0]);
      if (!first) continue;
      found.push({ ...entry, id, workspaceId: input.workspaceId });
      if (!next.has(id)) {
        next.set(id, {
          project: input.project,
          path: first.path,
          file: first.file,
          key: entry.key,
          target: { host: entry.host, port: entry.port, database: entry.database, user: entry.user, ssl: entry.ssl },
        });
      }
    }
  }
  sources.clear();
  for (const [id, source] of next) sources.set(id, source);
  // A file that has gone is not worth remembering the contents of.
  for (const path of fileCache.keys()) if (!seenPaths.has(path)) fileCache.delete(path);
  return found;
}

async function readEnvFile(path: string): Promise<string | null> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return null;
  }
  if (!info.isFile() || info.size > ENV_FILE_MAX) return null;
  const held = fileCache.get(path);
  if (held && held.mtimeMs === info.mtimeMs && held.size === info.size) return held.text;
  try {
    const text = await readFile(path, "utf8");
    fileCache.set(path, { mtimeMs: info.mtimeMs, size: info.size, text });
    return text;
  } catch {
    return null;
  }
}

/**
 * The URL behind an id, read now. The file is read again rather than the
 * cache consulted, because this is the moment the secret is wanted and the
 * one place it is allowed to be; and what it says is checked against what the
 * client was told, so an id can never be made to mean a different server than
 * the one on the row.
 */
async function urlFor(id: string, database: string | undefined): Promise<{ url: string; source: Source }> {
  const source = sources.get(id);
  if (!source) throw new Error("That database is no longer in the workspace's env files.");
  let text: string;
  try {
    text = await readFile(source.path, "utf8");
  } catch {
    throw new Error(`Could not read ${source.file}.`);
  }
  const value = parseDotenv(text).get(source.key);
  const target = value === undefined ? null : parsePostgresUrl(value);
  if (!value || !target) throw new Error(`${source.key} is no longer a Postgres URL in ${source.file}.`);
  const was = source.target;
  if (target.host !== was.host || target.port !== was.port || target.database !== was.database || target.user !== was.user) {
    throw new Error(`${source.key} in ${source.file} has changed since the list was made — it will refresh in a moment.`);
  }
  return { url: database ? withDatabase(value, database) : value, source };
}

function poolKey(id: string, database: string | undefined): string {
  return `${id}\0${database ?? ""}`;
}

async function poolFor(id: string, database: string | undefined): Promise<pg.Pool> {
  const key = poolKey(id, database);
  const held = pools.get(key);
  if (held) {
    held.used = Date.now();
    return held.pool;
  }
  const { url } = await urlFor(id, database);
  const pool = new pg.Pool({
    connectionString: url,
    max: POOL_MAX,
    idleTimeoutMillis: POOL_IDLE_MS,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    application_name: APPLICATION_NAME,
    // Every cell as Postgres printed it. The driver would otherwise turn a
    // timestamp into a Date, a bigint into a string, a `numeric` into a
    // string and `json` into an object — four shapes for a viewer whose job
    // is to show what is there. Text is what is there.
    types: { getTypeParser: () => (value: string) => value },
  });
  // An idle connection the server closed under us is an event, and an
  // unhandled one ends the process. The next query finds out on its own.
  pool.on("error", () => {});
  // Read-only as the session's default too, under the explicit transaction
  // every request opens. Belt beside braces: a query that typed its own
  // `COMMIT` and carried on is in a fresh transaction, and this is what that
  // one is.
  pool.on("connect", (client) => {
    client.query("SET default_transaction_read_only = on").catch(() => {});
  });
  pools.set(key, { pool, used: Date.now() });
  if (!sweeper) {
    sweeper = setInterval(sweepPools, POOL_SWEEP_MS);
    sweeper.unref();
  }
  return pool;
}

function sweepPools(): void {
  const now = Date.now();
  for (const [key, held] of pools) {
    if (now - held.used < POOL_IDLE_MS) continue;
    pools.delete(key);
    void held.pool.end().catch(() => {});
  }
  if (pools.size === 0 && sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
}

/** Every connection, closed: when the last client leaves, and when the server goes. */
export async function closeDatabasePools(): Promise<void> {
  const open = [...pools.values()];
  pools.clear();
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
  await Promise.all(open.map((held) => held.pool.end().catch(() => {})));
}

/**
 * One transaction, with the policy applied. `READ ONLY` unless told otherwise,
 * and a `LOCAL` statement timeout — local so it lives and dies with the
 * transaction, which is the one scope a pooler in transaction mode is obliged
 * to keep whole. Rolled back when nothing was meant to be kept, which for a
 * read-only transaction is the same as committing and says so more plainly.
 */
async function transaction<T>(
  pool: pg.Pool,
  writes: boolean,
  run: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch (err) {
    throw new Error(`Could not connect: ${messageOf(err)}`);
  }
  try {
    await client.query(writes ? "BEGIN READ WRITE" : "BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${DB_QUERY_TIMEOUT_MS}`);
    const result = await run(client);
    await client.query(writes ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw new Error(messageOf(err));
  } finally {
    client.release();
  }
}

/**
 * What went wrong, in Postgres's words where it has any. A `DatabaseError`
 * carries a detail and a hint beside the message, and a hint is usually the
 * fix — "Perhaps you meant to reference the column ..." — so both travel.
 */
function messageOf(err: unknown): string {
  if (err instanceof pg.DatabaseError) {
    const parts = [err.message];
    if (err.detail) parts.push(err.detail);
    if (err.hint) parts.push(`Hint: ${err.hint}`);
    return parts.join("\n");
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Schemas the viewer should not list: Postgres's own, and the ones it makes per session. */
const CATALOG_SQL = `
  SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind, c.reltuples::float8 AS estimate
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
    AND n.nspname NOT LIKE 'pg\\_temp\\_%'
    AND n.nspname NOT LIKE 'pg\\_toast\\_temp\\_%'
  ORDER BY (n.nspname <> 'public'), n.nspname, c.relname`;

const SCHEMAS_SQL = `
  SELECT nspname AS name
  FROM pg_namespace
  WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
    AND nspname NOT LIKE 'pg\\_temp\\_%'
    AND nspname NOT LIKE 'pg\\_toast\\_temp\\_%'
  ORDER BY (nspname <> 'public'), nspname`;

const DATABASES_SQL = `
  SELECT datname AS name
  FROM pg_database
  WHERE NOT datistemplate AND datallowconn AND has_database_privilege(datname, 'CONNECT')
  ORDER BY datname`;

const COLUMNS_SQL = `
  SELECT a.attname AS name,
         format_type(a.atttypid, a.atttypmod) AS type,
         a.attnotnull AS notnull,
         EXISTS (
           SELECT 1 FROM pg_index i
           WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY (i.indkey)
         ) AS pk
  FROM pg_attribute a
  WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
  ORDER BY a.attnum`;

/**
 * The whole catalogue of one database: its schemas, their tables with the
 * planner's row estimates, and the other databases this role could open.
 * `database` is one of those, or undefined for the URL's own.
 */
export async function dbCatalog(id: string, database: string | undefined): Promise<DbCatalog> {
  const pool = await poolFor(id, database);
  return transaction(pool, false, async (client) => {
    const current = await client.query<{ name: string }>("SELECT current_database() AS name");
    const schemas = await client.query<{ name: string }>(SCHEMAS_SQL);
    const tables = await client.query<{ schema: string; name: string; kind: string; estimate: string }>(CATALOG_SQL);
    const databases = await client.query<{ name: string }>(DATABASES_SQL);
    const bySchema = new Map<string, DbSchema>();
    for (const row of schemas.rows) bySchema.set(row.name, { name: row.name, tables: [] });
    for (const row of tables.rows) {
      const schema = bySchema.get(row.schema) ?? { name: row.schema, tables: [] };
      if (!bySchema.has(row.schema)) bySchema.set(row.schema, schema);
      schema.tables.push({ name: row.name, kind: row.kind as DbRelKind, estimate: Number(row.estimate) });
    }
    return {
      database: current.rows[0]?.name ?? "",
      databases: databases.rows.map((row) => row.name),
      schemas: [...bySchema.values()],
    };
  });
}

/**
 * A page of a table, ordered by its primary key when it has one so that two
 * pages are two different pages. A table without one is read in whatever
 * order the heap gives, which is the honest answer and the one `psql` gives.
 */
export async function dbRows(
  id: string,
  database: string | undefined,
  schema: string,
  table: string,
  offset: number,
  limit: number,
): Promise<DbRows> {
  const pool = await poolFor(id, database);
  const rel = `${quoteIdent(schema)}.${quoteIdent(table)}`;
  const take = Math.min(Math.max(1, Math.floor(limit)), DB_ROW_CAP);
  const skip = Math.max(0, Math.floor(offset));
  return transaction(pool, false, async (client) => {
    const cols = await client.query<{ name: string; type: string; notnull: string; pk: string }>(COLUMNS_SQL, [rel]);
    const columns: DbColumn[] = cols.rows.map((row) => ({
      name: row.name,
      type: row.type,
      nullable: row.notnull !== "t",
      pk: row.pk === "t",
    }));
    const order = columns.filter((c) => c.pk).map((c) => quoteIdent(c.name));
    const sql = `SELECT * FROM ${rel}${order.length ? ` ORDER BY ${order.join(", ")}` : ""} LIMIT $1 OFFSET $2`;
    const page = await client.query({ text: sql, values: [take + 1, skip], rowMode: "array" });
    const rows = (page.rows as (string | null)[][]).slice(0, take).map((row) => row.map(clipCell));
    return { columns, rows, offset: skip, limit: take, more: page.rows.length > take };
  });
}

/**
 * What somebody typed, run as they typed it.
 *
 * A read goes through a cursor so the cap is applied before the rows cross
 * the socket from Postgres; see the header. The `DECLARE` is tried under a
 * savepoint, because a statement that failed aborts the transaction, and a
 * query that was not a `SELECT` after all — or was one with a typo — is then
 * run plainly, where the typo gets to be reported as itself.
 */
export async function dbQuery(id: string, database: string | undefined, sql: string, writes: boolean): Promise<DbResult> {
  const pool = await poolFor(id, database);
  const text = trimSql(sql);
  if (!text) throw new Error("Nothing to run.");
  const started = performance.now();
  return transaction(pool, writes, async (client) => {
    let result: pg.QueryArrayResult | null = null;
    let viaCursor = false;
    if (looksLikeSelect(text)) {
      await client.query("SAVEPOINT kururu_read");
      try {
        await client.query(`DECLARE kururu_read NO SCROLL CURSOR FOR ${text}`);
        result = await client.query({ text: `FETCH ${DB_ROW_CAP + 1} FROM kururu_read`, rowMode: "array" });
        await client.query("CLOSE kururu_read");
        viaCursor = true;
      } catch {
        await client.query("ROLLBACK TO SAVEPOINT kururu_read");
        result = null;
      }
    }
    if (!result) {
      const plain: unknown = await client.query({ text, rowMode: "array" });
      // The simple protocol answers a string of statements with a result each.
      // The one shown is the last that returned columns, else the last.
      const results = (Array.isArray(plain) ? plain : [plain]) as pg.QueryArrayResult[];
      result = results.reduce((pick, each) => (each.fields.length > 0 ? each : pick), results[results.length - 1]!);
    }
    const ms = Math.round(performance.now() - started);
    const all = result.rows as (string | null)[][];
    const truncated = all.length > DB_ROW_CAP;
    const rows = all.slice(0, DB_ROW_CAP).map((row) => row.map(clipCell));
    return {
      columns: result.fields.map((f) => ({ name: f.name, type: typeName(f.dataTypeID) })),
      rows,
      rowCount: viaCursor ? rows.length : typeof result.rowCount === "number" ? result.rowCount : null,
      command: viaCursor ? "SELECT" : result.command || null,
      truncated,
      ms,
    };
  });
}
