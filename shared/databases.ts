/**
 * Which databases a workspace has, and how one of them is spoken of on the wire.
 *
 * A project that has a database says so in its `.env` files — `DATABASE_URL=`
 * is as close to a convention as this corner of the ecosystem has — and that
 * line is the whole of what kururu reads to know that there is one. Nobody
 * registers a database with kururu, for the reason nobody registers a branch
 * with it: the fact is already written down in the project, and a second place
 * to write it would be a second place for it to be wrong.
 *
 * Postgres only, and said plainly rather than hidden behind a "driver"
 * interface with one implementation. Every URL in every project this was
 * written against is a Postgres one, and an abstraction built for a MySQL that
 * does not exist is the kind of thing that is wrong in a way nobody finds out
 * until it does.
 *
 * What crosses the wire is a *target* — host, port, database, user — and never
 * the URL, because the URL carries the password. A client is told enough to
 * tell two databases apart and to say where a query is going, and it names
 * one by an id the server minted; the server reads the file again at the
 * moment it connects. Nothing here holds a credential, and nothing in `shared/`
 * could keep one if it wanted to: this file has no disk and no network, which
 * is also what makes the parse the testable part.
 *
 * Two facts about real projects shaped the dedupe. The file name is not the
 * environment — a `.env.local` that points at production is a thing that
 * exists — so an entry is labelled by the file *and* by where it goes. And one
 * file often holds two URLs for one database, a pooled one and a direct one
 * (`DATABASE_URL_DIRECT`, Prisma's shape): the pooled host is sometimes a name
 * only the deployment's own network can resolve, so when both name the same
 * database the direct one is the entry and the pooled one is not.
 */

/** Where a URL points, with the password left out. */
export interface DbTarget {
  host: string;
  port: number;
  database: string;
  user: string;
  /** The URL asks for TLS (`sslmode=require` or stricter, or `ssl=true`). */
  ssl: boolean;
}

/**
 * One database of one workspace, as the sidebar and the viewer know it.
 *
 * `id` is minted by the server from the project root and the target, so it is
 * the same across polls and restarts and a viewer left open on it keeps its
 * place when the list is sent again. It carries nothing a client could use
 * without the server: naming it is a request, and the server decides what the
 * name means.
 */
export interface WorkspaceDatabase extends DbTarget {
  id: string;
  workspaceId: string;
  /**
   * The env files that name this target, relative to the project root, in
   * the order they were found. More than one when two files point at the same
   * place, which is said rather than drawn as two identical entries.
   */
  files: string[];
  /** The variable the URL was read from, in the first of `files`. */
  key: string;
}

/** What `discoverDatabases` found in one project, before the server gives it an id. */
export interface DiscoveredDatabase extends DbTarget {
  files: string[];
  key: string;
}

/**
 * A schema's tables, as the viewer's left column lists them. One request
 * answers the whole catalogue of a database rather than a request per schema,
 * because the whole thing is a few hundred rows at most and the viewer wants
 * it all at once to draw the column.
 */
export interface DbCatalog {
  /** The database this catalogue describes — the URL's, or the one chosen. */
  database: string;
  /**
   * Every other database on the same server this role may connect to. Empty
   * when the role may see only its own, which is the common shape for a
   * managed database and not an error.
   */
  databases: string[];
  schemas: DbSchema[];
}

export interface DbSchema {
  name: string;
  tables: DbTable[];
}

/** `r` table, `p` partitioned table, `v` view, `m` materialized view, `f` foreign table. */
export type DbRelKind = "r" | "p" | "v" | "m" | "f";

export interface DbTable {
  name: string;
  kind: DbRelKind;
  /**
   * The planner's estimate of the row count, which is what `pg_class` keeps
   * and is free to read. Exact counts are a sequential scan, which on the
   * table somebody opened the viewer to look at is the one query that would
   * not come back. Negative when the table has never been analysed, which the
   * viewer draws as nothing.
   */
  estimate: number;
}

export interface DbColumn {
  name: string;
  /** As `format_type` prints it: `character varying(255)`, `timestamp with time zone`. */
  type: string;
  nullable: boolean;
  /** Part of the primary key, which is also what a page of rows is ordered by. */
  pk: boolean;
}

/** A page of a table. */
export interface DbRows {
  columns: DbColumn[];
  /** Every cell as Postgres prints it, or null. See `DB_CELL_MAX`. */
  rows: (string | null)[][];
  offset: number;
  limit: number;
  /** A full page came back, so there may be another. */
  more: boolean;
}

/** A column of a query's result, which has a type but no catalogue to look it up in. */
export interface DbResultColumn {
  name: string;
  /** The type's name when the OID is one `typeName` knows, else empty. */
  type: string;
}

/** What one run of the query box came to. */
export interface DbResult {
  columns: DbResultColumn[];
  rows: (string | null)[][];
  /**
   * What the command tag said: rows a `SELECT` returned, or rows an `UPDATE`
   * touched. Null when Postgres said nothing countable.
   */
  rowCount: number | null;
  /** The command tag's verb — `SELECT`, `UPDATE`, `CREATE TABLE`. */
  command: string | null;
  /** The result had more rows than `DB_ROW_CAP`, and these are the first of them. */
  truncated: boolean;
  /** Wall time on the server, from sending the query to the last row. */
  ms: number;
}

/**
 * The most rows one request carries. A viewer is for looking, and five
 * hundred rows is more than anybody reads; past it a result is a download, and
 * the thing to do is add a `WHERE`. The cap is applied on the server, and the
 * result says when it was.
 */
export const DB_ROW_CAP = 500;

/** Rows per page of a table. */
export const DB_PAGE = 100;

/**
 * The longest a cell crosses the wire as. A `jsonb` column of documents or a
 * `text` column holding a page of HTML would otherwise make one row the size
 * of the rest of the result put together. Cut with a marker, so a cell that
 * was cut cannot be mistaken for one that ends there.
 */
export const DB_CELL_MAX = 4000;

/**
 * How long one statement may run before Postgres cancels it. Generous for a
 * query somebody typed, and short enough that a `SELECT *` on the wrong table
 * does not hold a connection on a production database for the afternoon.
 */
export const DB_QUERY_TIMEOUT_MS = 15_000;

/** The longest query the box will send. A page of SQL, not a migration file. */
export const DB_SQL_MAX = 100_000;

/** The default Postgres port, for a URL that names none. */
const PG_PORT = 5432;

/**
 * Whether a file name is an env file worth reading.
 *
 * `.env`, `.env.local`, `.env.prod`, `.env.production.local` — the dotenv
 * family, which is `.env` and any dotted suffixes. Three kinds of name are
 * refused by their segments, each because a real project had one and it would
 * have become an entry: `example`, `sample` and `template` hold placeholders
 * that parse as perfectly good URLs to a host that does not exist; and `bak`,
 * `backup`, `old` and `orig` are last week's file, which is at best the same
 * target twice and at worst a database that has since moved.
 */
export function isEnvFile(name: string): boolean {
  if (!/^\.env(\.[A-Za-z0-9_-]+)*$/.test(name)) return false;
  const segments = name.split(".").slice(2);
  return !segments.some((segment) => /^(example|sample|template|bak|backup|old|orig)\b/i.test(segment));
}

/**
 * A dotenv file as a map.
 *
 * The grammar is dotenv's, because the project reads its own files with
 * dotenv or with a runtime that copied it, and the one thing a parser here
 * must never do is read a value the application would read differently. So:
 * an optional `export`, a key, `=`, and a value that is single-quoted,
 * double-quoted, back-quoted or bare. A bare value ends at the first `#`,
 * which is what dotenv does and is worth knowing about a password with a `#`
 * in it. A double-quoted value expands `\n`; a single-quoted one is literal; a
 * quoted value may run over several lines. The last assignment to a key wins.
 */
export function parseDotenv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const head = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s*(.*)$/.exec(line);
    if (!head) continue;
    const key = head[1]!;
    let rest = head[2]!;
    const quote = rest[0];
    if (quote === '"' || quote === "'" || quote === "`") {
      // Gather lines until the closing quote, which may be some way down.
      let body = rest.slice(1);
      let closed = closingQuote(body, quote);
      while (closed < 0 && i + 1 < lines.length) {
        i++;
        body += "\n" + lines[i];
        closed = closingQuote(body, quote);
      }
      if (closed < 0) {
        // Never closed: dotenv would take the rest of the line as a bare
        // value, quote and all. Match it rather than drop the key.
        out.set(key, rest.split("#")[0]!.trim());
        continue;
      }
      let value = body.slice(0, closed);
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
      value = value.replace(new RegExp(`\\\\${quote}`, "g"), quote);
      out.set(key, value);
      continue;
    }
    rest = rest.split("#")[0]!.trim();
    out.set(key, rest);
  }
  return out;
}

/** Where the first unescaped `quote` is in `body`, or -1. */
function closingQuote(body: string, quote: string): number {
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\") {
      i++;
      continue;
    }
    if (body[i] === quote) return i;
  }
  return -1;
}

/** Whether a value is a Postgres URL at all. The scheme and nothing else. */
export function isPostgresUrl(value: string): boolean {
  return /^postgres(ql)?:\/\//i.test(value.trim());
}

/**
 * Where a Postgres URL points.
 *
 * Read with the platform's URL parser, which handles a `postgresql:` scheme
 * as it handles any scheme it does not know: authority, path and query all
 * come apart correctly, and a percent-encoded password does not confuse it.
 * Two shapes it does not read, and both come back null rather than wrong: the
 * libpq multi-host form `host1,host2`, and anything that is not a URL. A
 * socket URL (`postgres:///db?host=/var/run/postgresql`) has no authority,
 * and the host is taken from the query where libpq takes it from.
 */
export function parsePostgresUrl(value: string): DbTarget | null {
  const text = value.trim();
  if (!isPostgresUrl(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const params = url.searchParams;
  const user = safeDecode(url.username);
  let host = url.hostname;
  if (!host) host = params.get("host") ?? "localhost";
  const port = url.port ? Number(url.port) : PG_PORT;
  if (!Number.isFinite(port) || port <= 0) return null;
  // A path of `/` or nothing: libpq connects to the database named after the
  // user, and so does the viewer, by sending no name at all. Saying the user's
  // name here is what it will be called.
  const database = safeDecode(url.pathname.replace(/^\//, "")) || user;
  const sslmode = (params.get("sslmode") ?? "").toLowerCase();
  const ssl =
    ["require", "verify-ca", "verify-full"].includes(sslmode) ||
    ["true", "1", "on"].includes((params.get("ssl") ?? "").toLowerCase());
  return { host, port, database, user, ssl };
}

function safeDecode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/**
 * The same URL pointed at another database on the same server. For the
 * viewer's database list: everything about the connection stays — host, role,
 * password, `sslmode` — and only the path changes. The platform parser keeps
 * the credentials as they were written, encoded or not, so the result is one
 * libpq reads the same way.
 */
export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url.trim());
  parsed.pathname = "/" + encodeURIComponent(database);
  return parsed.toString();
}

/**
 * A name quoted as an identifier, which is the one piece of SQL built from
 * text here. A schema or table name arrives from the catalogue and goes back
 * into `SELECT * FROM`; doubled quotes are how Postgres spells a quote inside
 * one, and there is no other character an identifier can smuggle out of its
 * quotes.
 */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Every database a project's env files name, one entry per place.
 *
 * `files` arrive in the order they should be labelled — `.env` before
 * `.env.local` before `.env.prod` is what `sortEnvFiles` gives — and an entry
 * is listed where it was first seen. Within one file, two keys that name the
 * same database for the same role are one entry, and the direct one wins: see
 * the header for the pooled-host problem. Across files, two keys that name
 * exactly the same place are one entry that says both files.
 */
export function discoverDatabases(files: { file: string; text: string }[]): DiscoveredDatabase[] {
  const found: DiscoveredDatabase[] = [];
  const byTarget = new Map<string, DiscoveredDatabase>();
  for (const { file, text } of files) {
    const vars = parseDotenv(text);
    // Every Postgres URL in the file, keyed by variable, in file order.
    const urls: { key: string; target: DbTarget }[] = [];
    for (const [key, value] of vars) {
      const target = parsePostgresUrl(value);
      if (target) urls.push({ key, target });
    }
    // One per exact place within the file: `DATABASE_URL` and `POSTGRES_URL`
    // copied from each other are not two databases.
    const inFile = new Map<string, { key: string; target: DbTarget }>();
    for (const entry of urls) {
      const key = targetKey(entry.target);
      if (!inFile.has(key)) inFile.set(key, entry);
    }
    // Then one per database-and-role: the direct URL if there is one.
    const byDatabase = new Map<string, { key: string; target: DbTarget }>();
    for (const entry of inFile.values()) {
      const key = `${entry.target.database}\0${entry.target.user}`;
      const held = byDatabase.get(key);
      if (!held || (isDirectKey(entry.key) && !isDirectKey(held.key))) byDatabase.set(key, entry);
    }
    for (const entry of byDatabase.values()) {
      const key = targetKey(entry.target);
      const held = byTarget.get(key);
      if (held) {
        held.files.push(file);
        continue;
      }
      const made: DiscoveredDatabase = { ...entry.target, files: [file], key: entry.key };
      byTarget.set(key, made);
      found.push(made);
    }
  }
  return found;
}

/** Prisma's `DATABASE_URL_DIRECT`, Supabase's `DIRECT_URL`, and anything that says so. */
function isDirectKey(key: string): boolean {
  return /DIRECT/i.test(key);
}

function targetKey(t: DbTarget): string {
  return `${t.host}\0${t.port}\0${t.database}\0${t.user}`;
}

/**
 * Env files in the order they should be read and labelled: `.env` first,
 * then the rest alphabetically, which puts `.env.local` before `.env.prod`
 * and keeps a list stable between polls.
 */
export function sortEnvFiles(names: string[]): string[] {
  return [...names].sort((a, b) => (a === ".env" ? -1 : b === ".env" ? 1 : a.localeCompare(b)));
}

/**
 * An id for a target in a project, stable across polls and restarts.
 *
 * Two rounds of FNV-1a over the root and the target: an identity, not a
 * secret, and the name a client sends back to say which database it means.
 * The root is in it so that two projects reading the same database are two
 * entries, each on its own workspace's row.
 */
export function databaseId(root: string, t: DbTarget): string {
  const text = `${root}\0${targetKey(t)}`;
  return fnv(text, 0x811c9dc5).toString(16).padStart(8, "0") + fnv(text, 0x01000193).toString(16).padStart(8, "0");
}

function fnv(text: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * The name of a type by its OID, for a query result's header. A result's
 * columns come with OIDs and no catalogue, and these are the ones that cover
 * nearly every column anybody has; an OID not here is drawn as nothing rather
 * than looked up, which would be a second round trip for a label.
 */
export function typeName(oid: number): string {
  return TYPE_NAMES.get(oid) ?? "";
}

const TYPE_NAMES = new Map<number, string>([
  [16, "bool"],
  [17, "bytea"],
  [18, "char"],
  [19, "name"],
  [20, "int8"],
  [21, "int2"],
  [23, "int4"],
  [25, "text"],
  [26, "oid"],
  [114, "json"],
  [142, "xml"],
  [600, "point"],
  [700, "float4"],
  [701, "float8"],
  [790, "money"],
  [869, "inet"],
  [1042, "bpchar"],
  [1043, "varchar"],
  [1082, "date"],
  [1083, "time"],
  [1114, "timestamp"],
  [1184, "timestamptz"],
  [1186, "interval"],
  [1266, "timetz"],
  [1700, "numeric"],
  [2950, "uuid"],
  [3802, "jsonb"],
  [1000, "bool[]"],
  [1007, "int4[]"],
  [1016, "int8[]"],
  [1009, "text[]"],
  [1015, "varchar[]"],
  [2951, "uuid[]"],
  [3807, "jsonb[]"],
]);

/**
 * A cell as it crosses the wire: what Postgres printed, cut at `DB_CELL_MAX`
 * with a marker. Null stays null, because the viewer draws it differently from
 * an empty string and the difference is the point.
 */
export function clipCell(value: string | null): string | null {
  if (value === null) return null;
  if (value.length <= DB_CELL_MAX) return value;
  return value.slice(0, DB_CELL_MAX) + "…";
}

/**
 * Whether a query is one a cursor can be declared over, which is how the
 * server bounds a result it did not write. A heuristic and only that: the
 * read-only transaction is what keeps a query from writing, and this only
 * decides whether to bound the read through a cursor or run it plainly and
 * cap the rows after. Wrong in the permissive direction it costs memory on
 * one big result; wrong in the strict direction it costs nothing, because a
 * `DECLARE` that fails is rolled back and the query run plainly.
 */
export function looksLikeSelect(sql: string): boolean {
  const body = sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
  if (!/^(select|with|table|values)\b/i.test(body)) return false;
  // One statement only: a `;` anywhere but the end would put the second
  // statement after the cursor rather than inside it.
  return !/;[\s\S]*\S/.test(body);
}

/** The query as the server runs it: trimmed, and without a trailing semicolon a cursor cannot wrap. */
export function trimSql(sql: string): string {
  return sql.trim().replace(/;+\s*$/, "");
}
