/**
 * A workspace's databases, drawn over the window: the ones its env files
 * name, their schemas and tables, a page of rows, and a box to type a query.
 *
 * It exists because the question "what is actually in that table right now"
 * comes up a dozen times an afternoon spent watching agents, and the answer
 * used to be a terminal, a `psql` and a password pasted from a file — on a
 * phone, none of those. A sheet beside the terminals that already knows where
 * the database is, because the project wrote it down, is the whole idea; see
 * `shared/databases.ts` for how it is found and `server/src/databases.ts` for
 * how it is asked.
 *
 * An overlay rather than a pane, for the profile board's reason: it belongs to
 * the workspace and not to any arrangement of its panes, and it is the same
 * sheet from the phone as from the desktop. It may become a pane type one day,
 * beside the preview; it is not one today.
 *
 * Three columns of narrowing: connections, then schemas and tables, then a
 * page of rows or a query's result. Everything is read-only until the switch
 * in the query tab says otherwise, and the switch is armed with one click and
 * turned on with a second, the way stopping a dev server is: a production
 * database is on the far end of some of these, and a `DELETE` typed where a
 * `SELECT` was meant should cost two gestures. It goes back off after every
 * run, so the next query starts safe whatever the last one did.
 *
 * **What was seen is kept, and shown again while it is checked.** The first
 * version fetched afresh on every click, which made moving between two
 * databases a blank column and a spinner each way — correct, and exactly what
 * no database client does. They all keep the catalogue for the session and
 * the last grid they drew, and only *replace* it when a fresh one lands. So
 * every catalogue and every page of rows this sheet has fetched is kept, out
 * here where closing the sheet does not lose it, and coming back to one shows
 * it at once with a refresh already on its way: stale, then current, with no
 * blank in between. What is *not* re-run is a query somebody typed. A write
 * must never run twice because a tab was clicked, and the read that was slow
 * enough to be the reason for all this caching is just as likely to be one of
 * those; a result stays on screen until Run is pressed again.
 */
import { useEffect, useRef, useState } from "react";
import {
  DB_PAGE,
  DB_ROW_CAP,
  type DbCatalog,
  type DbColumn,
  type DbResult,
  type DbResultColumn,
  type DbRows,
  type DbTable,
  type WorkspaceDatabase,
} from "../../../shared/databases";
import * as api from "../session";
import { useKururu } from "../session";
import { Icon } from "./Icon";

/** The right-hand side: a table's rows, or the query box. */
type View = { kind: "table"; schema: string; table: string } | { kind: "query" };

/**
 * What the sheet remembers between openings, all keyed so that coming back to
 * a connection finds it as it was left: which connection per workspace, which
 * database per connection, which view and which schemas were open per
 * database, and the query box's text and last result per database.
 */
const lastConnection = new Map<string, string>();
const lastDatabase = new Map<string, string | undefined>();
const lastView = new Map<string, View>();
const openSchemas = new Map<string, Set<string>>();
const drafts = new Map<string, string>();
const lastResult = new Map<string, { sql: string; result: DbResult | null; error: string | null }>();

/** Something fetched, and when. */
interface Cached<T> {
  value: T;
  at: number;
}

/**
 * Every catalogue and every page of rows fetched so far. Bounded, because a
 * long afternoon of paging through a wide table is a lot of rows to keep for
 * a sheet that is closed: the oldest entries go first.
 */
const catalogs = new Map<string, Cached<DbCatalog>>();
const pages = new Map<string, Cached<DbRows>>();
const CACHE_MAX = 64;

function remember<T>(cache: Map<string, Cached<T>>, key: string, value: T): void {
  cache.delete(key);
  cache.set(key, { value, at: Date.now() });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Stale while revalidating, for one key at a time.
 *
 * On a key the cache has, `data` is the cached value from the first render
 * and `refreshing` is true until the fetch lands and replaces it; on one it
 * does not, `data` is null and `loading` is true. A failed refresh keeps the
 * stale data and reports the error beside it, since what was true a minute
 * ago is still the best picture of a database that just stopped answering.
 * A reply for a key that is no longer the one showing is dropped: a slow
 * production server must not overwrite a quick local one picked after it.
 */
function useStale<T>(key: string | null, cache: Map<string, Cached<T>>, fetcher: () => Promise<T>) {
  const [state, setState] = useState<{ key: string | null; data: T | null; error: string | null; busy: boolean }>(() => ({
    key,
    data: key ? (cache.get(key)?.value ?? null) : null,
    error: null,
    busy: key !== null,
  }));
  const [tick, setTick] = useState(0);
  // The render that first sees a new key must not show the old key's data
  // for a frame, so the state the effect below will set is derived here too.
  const shown = state.key === key ? state : { key, data: key ? (cache.get(key)?.value ?? null) : null, error: null, busy: key !== null };
  useEffect(() => {
    if (!key) return;
    let live = true;
    setState({ key, data: cache.get(key)?.value ?? null, error: null, busy: true });
    fetcher()
      .then((value) => {
        if (!live) return;
        remember(cache, key, value);
        setState({ key, data: value, error: null, busy: false });
      })
      .catch((err: Error) => {
        if (!live) return;
        setState((was) => ({ key, data: was.key === key ? was.data : (cache.get(key)?.value ?? null), error: err.message, busy: false }));
      });
    return () => {
      live = false;
    };
    // The fetcher closes over nothing the key does not already name.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);
  return {
    data: shown.data,
    error: shown.error,
    loading: shown.busy && shown.data === null,
    refreshing: shown.busy && shown.data !== null,
    reload: () => setTick((n) => n + 1),
  };
}

function connKey(dbId: string, database: string | undefined): string {
  return `${dbId}\0${database ?? ""}`;
}

export function Databases({
  workspaceId,
  workspaceName,
  onClose,
}: {
  workspaceId: string;
  workspaceName: string;
  onClose: () => void;
}) {
  const { databases: all } = useKururu();
  const databases = all.filter((db) => db.workspaceId === workspaceId);

  const remembered = lastConnection.get(workspaceId);
  const [dbId, setDbId] = useState<string | null>(
    remembered && databases.some((db) => db.id === remembered) ? remembered : (databases[0]?.id ?? null),
  );
  /** Another database on the same server, or undefined for the URL's own. */
  const [database, setDatabase] = useState<string | undefined>(dbId ? lastDatabase.get(dbId) : undefined);
  const key = dbId ? connKey(dbId, database) : null;
  const [view, setView] = useState<View>((key ? lastView.get(key) : undefined) ?? { kind: "query" });
  const entry = databases.find((db) => db.id === dbId) ?? null;
  /** On a phone the left column is a sheet of its own, and this is whether it is showing. */
  const [navOpen, setNavOpen] = useState(view.kind === "query");

  const {
    data: catalog,
    error: catalogError,
    loading: loadingCatalog,
    refreshing: refreshingCatalog,
  } = useStale(key, catalogs, () => api.dbCatalog(dbId!, database));

  // Which schemas are open, per database: `public` to start with, and every
  // schema when there are few. Kept in a module map so the fold survives a
  // closing, and held in state only so that a change redraws.
  const [, redraw] = useState(0);
  const open = key && catalog ? openSchemas.get(key) ?? seedOpen(key, catalog) : null;

  // The entry the list no longer has — its line was deleted, or the
  // workspace moved — falls back to the first, and the sheet closes when
  // there is none left to show.
  useEffect(() => {
    if (databases.length === 0) {
      onClose();
      return;
    }
    if (!databases.some((db) => db.id === dbId)) {
      setDbId(databases[0]!.id);
      setDatabase(undefined);
    }
  }, [databases, dbId, onClose]);

  useEffect(() => {
    if (!dbId || !key) return;
    lastConnection.set(workspaceId, dbId);
    lastDatabase.set(dbId, database);
    lastView.set(key, view);
  }, [workspaceId, dbId, database, key, view]);

  const pick = (id: string) => {
    if (id === dbId) return;
    const db = lastDatabase.get(id);
    setDbId(id);
    setDatabase(db);
    setView(lastView.get(connKey(id, db)) ?? { kind: "query" });
  };

  const pickDatabase = (name: string) => {
    if (!dbId) return;
    const next = name === entry?.database ? undefined : name;
    setDatabase(next);
    setView(lastView.get(connKey(dbId, next)) ?? { kind: "query" });
  };

  const openTable = (schema: string, table: string) => {
    setView({ kind: "table", schema, table });
    setNavOpen(false);
  };

  return (
    <div className="scrim db-scrim" onPointerDown={onClose}>
      <div
        className={`db ${navOpen ? "db-nav-open" : ""}`}
        role="dialog"
        aria-modal
        aria-label={`${workspaceName}: databases`}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="db-head">
          <button
            className="db-nav-toggle"
            onClick={() => setNavOpen((was) => !was)}
            aria-label={navOpen ? "Hide tables" : "Show tables"}
            title={navOpen ? "Hide tables" : "Show tables"}
          >
            <Icon name="database" />
          </button>
          <h2 className="dialog-title">{workspaceName}</h2>
          {entry && (
            <span className="db-where" title={`${entry.key} in ${entry.files.join(", ")}`}>
              {entry.user ? `${entry.user}@` : ""}
              {entry.host}
              {entry.port !== 5432 ? `:${entry.port}` : ""}/{catalog?.database ?? database ?? entry.database}
              {entry.ssl ? " · tls" : ""}
            </span>
          )}
          <span className="db-seg board-seg" role="tablist" aria-label="View">
            <button
              role="tab"
              aria-selected={view.kind === "query"}
              className={`board-seg-btn ${view.kind === "query" ? "board-seg-btn-on" : ""}`}
              onClick={() => setView({ kind: "query" })}
            >
              Query
            </button>
            {view.kind === "table" && (
              <button role="tab" aria-selected className="board-seg-btn board-seg-btn-on" title={`${view.schema}.${view.table}`}>
                {view.table}
              </button>
            )}
          </span>
          <button className="sidebar-close" onClick={onClose} aria-label="Close" title="Close">
            <Icon name="close" />
          </button>
        </header>

        <div className="db-body">
          <nav className="db-nav" aria-label="Databases and tables">
            <ul className="db-conns">
              {databases.map((db) => (
                <li key={db.id}>
                  <button
                    className={`db-conn ${db.id === dbId ? "db-conn-on" : ""}`}
                    onClick={() => pick(db.id)}
                    title={`${db.key} in ${db.files.join(", ")}\n${db.host}:${db.port}/${db.database}`}
                  >
                    <span className="db-conn-file">{db.files.join(", ")}</span>
                    <span className="db-conn-target">
                      {db.host}/{db.database}
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            {catalog && catalog.databases.length > 1 && entry && (
              <label className="db-dbpick">
                <span className="db-dbpick-label">Database</span>
                <select
                  className="set-select db-dbselect"
                  value={catalog.database}
                  onChange={(event) => pickDatabase(event.target.value)}
                  title={`Other databases on ${entry.host} this role may open. ${entry.database} is the URL's own.`}
                >
                  {catalog.databases.map((name) => (
                    <option key={name} value={name}>
                      {name === entry.database ? `${name} ·` : name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {loadingCatalog && <p className="db-note">Connecting…</p>}
            {refreshingCatalog && <p className="db-note db-note-busy">Refreshing…</p>}
            {catalogError && <pre className="db-error">{catalogError}</pre>}
            {catalog && key && (
              <ul className="db-schemas">
                {catalog.schemas.map((schema) => {
                  const shut = !open?.has(schema.name);
                  return (
                    <li key={schema.name} className="db-schema">
                      <button
                        className="db-schema-head"
                        onClick={() => {
                          const set = openSchemas.get(key) ?? seedOpen(key, catalog);
                          if (set.has(schema.name)) set.delete(schema.name);
                          else set.add(schema.name);
                          redraw((n) => n + 1);
                        }}
                        aria-expanded={!shut}
                      >
                        <Icon name="caret" className={shut ? "drawer-caret-shut" : ""} />
                        <span className="db-schema-name">{schema.name}</span>
                        <span className="db-schema-count">{schema.tables.length}</span>
                      </button>
                      {!shut && (
                        <ul className="db-tables">
                          {schema.tables.length === 0 && <li className="db-note">No tables</li>}
                          {schema.tables.map((table) => (
                            <li key={table.name}>
                              <button
                                className={`db-table ${
                                  view.kind === "table" && view.schema === schema.name && view.table === table.name ? "db-table-on" : ""
                                }`}
                                onClick={() => openTable(schema.name, table.name)}
                                title={`${schema.name}.${table.name}${kindLabel(table) ? ` · ${kindLabel(table)}` : ""}`}
                              >
                                <span className="db-table-name">{table.name}</span>
                                {kindLabel(table) && <span className="db-table-kind">{kindLabel(table)}</span>}
                                <span className="db-table-est">{estimateLabel(table.estimate)}</span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </nav>

          <section className="db-main">
            {!entry || !key ? null : view.kind === "table" ? (
              <TableView key={`${key}\0${view.schema}.${view.table}`} dbId={entry.id} database={database} schema={view.schema} table={view.table} />
            ) : (
              <QueryView key={key} dbId={entry.id} database={database} ssl={entry.ssl} />
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

/** The schemas a database starts with open, remembered from then on. */
function seedOpen(key: string, catalog: DbCatalog): Set<string> {
  const set = new Set(catalog.schemas.length <= 3 ? catalog.schemas.map((s) => s.name) : ["public"]);
  openSchemas.set(key, set);
  return set;
}

/** `view` or `matview` or `foreign`; nothing for a table, which is what most of them are. */
function kindLabel(table: DbTable): string {
  switch (table.kind) {
    case "v":
      return "view";
    case "m":
      return "matview";
    case "f":
      return "foreign";
    case "p":
      return "partitioned";
    default:
      return "";
  }
}

/** The planner's estimate, short: `~1.2k`. Nothing for a table never analysed. */
function estimateLabel(estimate: number): string {
  if (!Number.isFinite(estimate) || estimate < 0) return "";
  if (estimate < 1000) return `${Math.round(estimate)}`;
  if (estimate < 1_000_000) return `~${(estimate / 1000).toFixed(estimate < 10_000 ? 1 : 0)}k`;
  return `~${(estimate / 1_000_000).toFixed(1)}M`;
}

// ---------------------------------------------------------------------------
// A table, a page at a time
// ---------------------------------------------------------------------------

/** Which page of a table was being looked at, so coming back lands on it. */
const lastOffset = new Map<string, number>();

function TableView({ dbId, database, schema, table }: { dbId: string; database: string | undefined; schema: string; table: string }) {
  const tableKey = `${connKey(dbId, database)}\0${schema}.${table}`;
  const [offset, setOffsetState] = useState(() => lastOffset.get(tableKey) ?? 0);
  const setOffset = (next: number) => {
    lastOffset.set(tableKey, next);
    setOffsetState(next);
  };
  const {
    data: page,
    error,
    loading,
    refreshing,
    reload,
  } = useStale(`${tableKey}\0${offset}`, pages, () => api.dbRows(dbId, database, schema, table, offset, DB_PAGE));

  const from = page ? page.offset + 1 : 0;
  const to = page ? page.offset + page.rows.length : 0;

  return (
    <>
      <div className="db-bar">
        <span className="db-bar-name" title={`${schema}.${table}`}>
          <span className="db-bar-schema">{schema}.</span>
          {table}
        </span>
        <span className="db-bar-fill" />
        {page && (
          <span className={`db-bar-range ${refreshing ? "db-bar-busy" : ""}`} role="status">
            {refreshing
              ? "Refreshing…"
              : page.rows.length === 0
                ? page.offset === 0
                  ? "Empty"
                  : "No more rows"
                : `${from}–${to}${page.more ? " of more" : ""}`}
          </span>
        )}
        <button className="mini" disabled={loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - DB_PAGE))} title="Previous page" aria-label="Previous page">
          ‹
        </button>
        <button className="mini" disabled={loading || !page?.more} onClick={() => setOffset(offset + DB_PAGE)} title="Next page" aria-label="Next page">
          ›
        </button>
        <button className={`mini ${refreshing ? "db-busy" : ""}`} disabled={loading || refreshing} onClick={reload} title="Reload" aria-label="Reload">
          <Icon name="restart" />
        </button>
      </div>
      {error && <pre className="db-error">{error}</pre>}
      {page && <Grid columns={page.columns} rows={page.rows} first={page.offset + 1} />}
      {loading && <p className="db-note">Loading…</p>}
    </>
  );
}

// ---------------------------------------------------------------------------
// The query box
// ---------------------------------------------------------------------------

function QueryView({ dbId, database, ssl }: { dbId: string; database: string | undefined; ssl: boolean }) {
  const key = connKey(dbId, database);
  const [sql, setSqlState] = useState(() => drafts.get(key) ?? "");
  const setSql = (next: string) => {
    drafts.set(key, next);
    setSqlState(next);
  };
  /** Off, armed by one click, or on — see the header. */
  const [writes, setWrites] = useState<"off" | "armed" | "on">("off");
  const [running, setRunning] = useState(false);
  // The last run's outcome, back from where the sheet keeps it: a result on
  // screen when the sheet was closed is on screen when it opens. Never re-run
  // by itself — see the header.
  const [last, setLastState] = useState(() => lastResult.get(key) ?? null);
  const setLast = (next: { sql: string; result: DbResult | null; error: string | null }) => {
    lastResult.set(key, next);
    setLastState(next);
  };
  const box = useRef<HTMLTextAreaElement>(null);

  // Armed and then left alone goes back to off: a click meant for something
  // else a minute later must not be the second click.
  useEffect(() => {
    if (writes !== "armed") return;
    const timer = setTimeout(() => setWrites("off"), 5000);
    return () => clearTimeout(timer);
  }, [writes]);

  const run = () => {
    if (running || !sql.trim()) return;
    setRunning(true);
    const asked = sql;
    api
      .dbQuery(dbId, database, asked, writes === "on")
      .then((got) => setLast({ sql: asked, result: got, error: null }))
      .catch((err: Error) => setLast({ sql: asked, result: last?.result ?? null, error: err.message }))
      .finally(() => {
        setRunning(false);
        setWrites("off");
      });
  };

  const result = last?.result ?? null;
  const summary = result && resultSummary(result);
  /** The result on screen is from a different query than the box holds. */
  const stale = last !== null && last.sql !== sql;

  return (
    <>
      <textarea
        ref={box}
        className="db-sql"
        value={sql}
        onChange={(event) => setSql(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            run();
          }
        }}
        placeholder="select * from … limit 50"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        rows={5}
      />
      <div className="db-bar">
        <button className={`button db-run ${writes === "on" ? "button-danger" : ""}`} disabled={running || !sql.trim()} onClick={run} title="Run (⌘↩)">
          {running ? "Running…" : writes === "on" ? "Run with writes" : "Run"}
        </button>
        <button
          className={`db-writes db-writes-${writes}`}
          onClick={() => setWrites(writes === "off" ? "armed" : writes === "armed" ? "on" : "off")}
          title={
            writes === "on"
              ? "Writes are on for the next run. Click to go back to read-only."
              : writes === "armed"
                ? "Click again to allow writes for one run"
                : "Every query runs in a read-only transaction. Click twice to allow writes for one run."
          }
          aria-pressed={writes === "on"}
        >
          {writes === "on" ? "Writes on" : writes === "armed" ? "Allow writes?" : "Read-only"}
        </button>
        <span className="db-bar-fill" />
        {summary && (
          <span className={`db-bar-range ${stale ? "db-bar-busy" : ""}`} role="status" title={stale ? `From an earlier run:\n${last!.sql}` : undefined}>
            {stale ? `Earlier run · ${summary}` : summary}
          </span>
        )}
        {ssl && <span className="db-bar-tls" title="The URL asks for TLS">tls</span>}
      </div>
      {last?.error && <pre className="db-error">{last.error}</pre>}
      {result && result.columns.length > 0 && <Grid columns={result.columns} rows={result.rows} first={1} />}
    </>
  );
}

/** "12 rows in 8 ms", or what the command said when it returned none. */
function resultSummary(result: DbResult): string {
  const time = `${result.ms} ms`;
  if (result.columns.length > 0) {
    const n = result.truncated ? `first ${DB_ROW_CAP} of more` : `${result.rows.length} row${result.rows.length === 1 ? "" : "s"}`;
    return `${n} · ${time}`;
  }
  if (result.rowCount !== null && result.command) return `${result.command}: ${result.rowCount} row${result.rowCount === 1 ? "" : "s"} · ${time}`;
  return `${result.command ?? "Done"} · ${time}`;
}

// ---------------------------------------------------------------------------
// The grid both halves draw
// ---------------------------------------------------------------------------

function Grid({ columns, rows, first }: { columns: (DbColumn | DbResultColumn)[]; rows: (string | null)[][]; first: number }) {
  return (
    <div className="db-grid-wrap">
      <table className="db-grid">
        <thead>
          <tr>
            <th className="db-grid-n" />
            {columns.map((column, i) => (
              <th key={i} title={column.type ? `${column.name}: ${column.type}` : column.name}>
                <span className="db-grid-col">
                  {column.name}
                  {"pk" in column && column.pk && <span className="db-grid-pk" title="Primary key">⚿</span>}
                </span>
                {column.type && <span className="db-grid-type">{column.type}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>
              <td className="db-grid-n">{first + r}</td>
              {row.map((cell, c) => (
                <td key={c} className={cell === null ? "db-grid-null" : ""} title={cell === null ? "NULL" : cell.length > 40 ? cell : undefined}>
                  {cell === null ? "null" : cell === "" ? <span className="db-grid-empty">empty</span> : cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="db-note">No rows</p>}
    </div>
  );
}
