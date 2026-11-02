/**
 * The ledger: one row per billed API message, in a SQLite file of its own.
 *
 * Beside `kururu.db` and not inside it, because the two want opposite things.
 * That file is the one nobody can rebuild, copied daily and mirrored to a
 * repository; this one is rebuildable for thirty days and grows twenty times
 * faster, and inside the other it would make every copy and every push carry
 * it. So the idioms are `store.ts`'s (`node:sqlite`, `pragma user_version`, a
 * list of migrations) and the rules are not. **A ledger that will not open is
 * a server that starts anyway**, without its ledger and saying so, because
 * nothing is lost by that but a chart: the logs are still there.
 *
 * It holds numbers, ids, model names and folders, and no column a transcript's
 * words could arrive in; `server/test/usageledger.test.ts` writes a transcript
 * full of a marked word through it and fails if the word comes out.
 *
 * **`daily` is what a page draws**, O(days × keys) however many messages are
 * behind it. It is kept in the transaction that wrote the batch, so the two
 * tables cannot be seen to disagree and a crash between them does not exist.
 * A message is added to its cell as it is written — its row read before and
 * after the upsert, the difference added — because rebuilding each day a
 * batch touched cost a busy day's thousands of messages every pass, every
 * few seconds, on the server's one thread (the 2026-11-02 review, §2.4). A
 * whole day is still rebuilt where adding cannot be right: a session that
 * changed attribution moves its old messages between keys with no new row,
 * and what a node said is replaced, never added to.
 * The empty string stands for "none" in its keys, since SQLite treats two
 * NULLs in a primary key as different and the conflict would never fire.
 *
 * **Everything a log said is written by `flush`, in one transaction, with the
 * offsets that produced it.** A crash replays from the last offset that was
 * written, and the primary key makes replaying harmless. What kururu says about
 * a session it started comes the other way, through `recordLaunch`, on the same
 * connection, and neither can run inside the other: both are synchronous.
 *
 * **What another node spent lives beside this and is only ever replaced.** A
 * node reads its own logs, and its parent keeps a rollup of what it says in the
 * `node_*` tables, by the node's id and never a qualified one. `session_days` and
 * `daily` are made from both, so a page cannot tell them apart and a rebuild
 * cannot lose them. A session one road has read, the other leaves alone: a machine
 * that is also a child would otherwise count twice. See `shared/usagepull.ts`.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { join } from "node:path";
import {
  attributionFor,
  dayBounds,
  dayOf,
  reportNames,
  sameRollupKeys,
  strongerAttribution,
  type Attribution,
  type AttributionFacts,
  type DailyExportRow,
  type LaunchRow,
  type LimitRow,
  type MessageRow,
  type SeenInLog,
  type TotalsRow,
  type UsageProgram,
  type WaitingLaunch,
} from "../../../shared/usage";
import type { PulledCell, PulledSession, UsagePart } from "../../../shared/usagepull";
import { splitDays, type LimitReading, type SessionFact, type UsageCell } from "../../../shared/usagereport";
import { dataDir } from "../store";

export function ledgerPath(): string {
  return join(dataDir(), "usage.db");
}

const SCHEMA = `
create table if not exists files (
  path text primary key, program text not null, login_dir text, inode integer not null,
  size integer not null, offset integer not null, mtime integer not null, session_id text, read_at integer not null
);
create table if not exists sessions (
  id text primary key, program text not null, profile_key text, login_dir text, cwd text, project_dir text,
  workspace_key text, card_id text, run_id integer, agent_id text, kind text not null, node text, machine text,
  started_at integer not null, last_at integer not null, parent_session text, version text,
  attributed_by text not null
);
create index if not exists sessions_workspace on sessions(workspace_key);
create index if not exists sessions_card on sessions(card_id);
create table if not exists messages (
  session_id text not null, message_id text not null, at integer not null, model text not null,
  requested_model text, effort text, input integer not null, cache_write_5m integer not null,
  cache_write_1h integer not null, cache_read integer not null, output integer not null, thinking integer not null,
  cost_est real, sidechain integer not null, source text not null,
  primary key (session_id, message_id)
) without rowid;
create index if not exists messages_at on messages(at);
create index if not exists messages_session on messages(session_id, at);
create table if not exists session_totals (
  session_id text not null, model text not null, input integer not null, output integer not null,
  thinking integer not null, cache_read integer not null, cache_write_5m integer not null,
  cache_write_1h integer not null, cost_program real, at integer not null,
  primary key (session_id, model)
) without rowid;
create table if not exists daily (
  day text not null, profile_key text not null, workspace_key text not null, card_id text not null,
  kind text not null, program text not null, model text not null, node text not null,
  messages integer not null, input integer not null, cache_write_5m integer not null, cache_write_1h integer not null,
  cache_read integer not null, output integer not null, thinking integer not null, cost_est real not null,
  unpriced integer not null,
  primary key (day, profile_key, workspace_key, card_id, kind, program, model, node)
) without rowid;
create table if not exists limits (
  at integer not null, account text, kind text not null, scope text, percent real, resets_at integer, source text not null
);
create index if not exists limits_at on limits(at);
create table if not exists skipped (
  path text not null, at_byte integer not null, why text not null, at integer not null,
  primary key (path, at_byte)
) without rowid;
`;

/**
 * A launch whose program has not said its session's id yet, which today means
 * Codex. On disk rather than in memory, because the server restarts on any save
 * and an agent does not, and a rollout can take its first prompt to appear.
 */
const WAITING = `
create table if not exists waiting (
  agent_id text not null, program text not null, profile_key text, workspace_key text, card_id text, kind text not null,
  node text, machine text, login_dir text, cwd text, at integer not null,
  primary key (agent_id, at)
) without rowid;
`;

/**
 * What the Usage page reads: `daily` again, but by session rather than by
 * attribution, since a page that names a folder or draws a session's row cannot
 * get either out of a table keyed by workspace. A few rows per session per day,
 * where the messages behind them are thousands, and with no attribution in it,
 * so a session that changes hands moves on the page without a row here changing.
 * `daily` stays as the shape phase 5's export and phase 6's pull want.
 */
const SESSION_DAYS = `
create table if not exists session_days (
  day text not null, session_id text not null, model text not null, messages integer not null,
  input integer not null, cache_write_5m integer not null, cache_write_1h integer not null, cache_read integer not null,
  output integer not null, thinking integer not null, cost_est real not null, unpriced integer not null,
  primary key (day, session_id, model)
) without rowid;
`;

/**
 * What other nodes have said, on the parent. Tables of their own rather than rows
 * in `messages`, since these are rollups and not messages, and rather than rows
 * in `sessions`, whose ids a launch here could also claim. `node_day` is that
 * node's own local day, known only as the unit that gets replaced; `at` is what
 * this node buckets by, in its own days. `node_days` holds what was last said for
 * each, which is the whole of what the next ask has to know.
 */
const NODES = `
create table if not exists node_cells (
  node text not null, node_day text not null, session_id text not null, model text not null, at integer not null,
  messages integer not null, input integer not null, cache_write_5m integer not null, cache_write_1h integer not null,
  cache_read integer not null, output integer not null, thinking integer not null, cost_est real not null, unpriced integer not null,
  primary key (node, session_id, model, at)
) without rowid;
create index if not exists node_cells_at on node_cells(at);
create index if not exists node_cells_day on node_cells(node, node_day);
create table if not exists node_sessions (
  node text not null, id text not null, program text not null, kind text not null, profile_key text, workspace_key text,
  card_id text, machine text, cwd text, attributed_by text not null, started_at integer not null, last_at integer not null, says real,
  primary key (node, id)
) without rowid;
create index if not exists node_sessions_id on node_sessions(id);
create table if not exists node_days (node text not null, day text not null, sig text not null, primary key (node, day)) without rowid;
create table if not exists node_names (node text not null, kind text not null, key text not null, label text not null, primary key (node, kind, key)) without rowid;
create table if not exists node_pulls (node text primary key, name text not null, at integer) without rowid;
`;

/** Each entry takes the file from its index's version to the next. The first makes it. */
const MIGRATIONS: readonly string[] = [SCHEMA, WAITING, SESSION_DAYS, NODES];

/** A format that moved would otherwise write a row per line forever; the count stops being useful long before this. */
const MAX_SKIPPED = 10_000;

/** One cell's numbers read back: `messages`' sums and `session_days`' columns, under one set of names. */
const CELL_READ = `count(*) as messages, sum(input) as input, sum(cache_write_5m) as cache_write_5m, sum(cache_write_1h) as cache_write_1h,
         sum(cache_read) as cache_read, sum(output) as output, sum(thinking) as thinking, coalesce(sum(cost_est), 0) as cost_est, sum(cost_est is null) as unpriced`;
const QUARTER_MS = 900_000;
/** `node_cells`' sums under those same names: a cell there has already counted its messages. */
const NODE_CELL_READ = `sum(messages) as messages, sum(input) as input, sum(cache_write_5m) as cache_write_5m, sum(cache_write_1h) as cache_write_1h,
         sum(cache_read) as cache_read, sum(output) as output, sum(thinking) as thinking, sum(cost_est) as cost_est, sum(unpriced) as unpriced`;

export interface FileRow {
  path: string;
  program: UsageProgram;
  loginDir: string | null;
  inode: number;
  size: number;
  offset: number;
  mtime: number;
  sessionId: string | null;
}

/** A session as a log showed it: what `sessions` keeps from the record and what attribution needs. */
export interface SessionSighting {
  id: string;
  program: UsageProgram;
  loginDir: string | null;
  cwd: string | null;
  version: string | null;
  firstAt: number;
  lastAt: number;
  parentSession: string | null;
  seen: SeenInLog;
  /** The machine it was read from, over ssh; absent for this disk. */
  machine?: string | null;
}

/** What one pass of the reader has read and not yet written. Held only until the next flush. */
export class LedgerBatch {
  readonly messages = new Map<string, MessageRow>();
  readonly sessions = new Map<string, SessionSighting>();
  readonly totals = new Map<string, TotalsRow>();
  readonly limits = new Map<string, LimitRow>();
  readonly files = new Map<string, FileRow>();
  readonly skipped: { path: string; atByte: number; why: string }[] = [];

  /** The streamed copies of a message collapse here first: last sighting's counts, first sighting's time. */
  addMessage(row: MessageRow): void {
    const key = `${row.sessionId}\0${row.messageId}`;
    const held = this.messages.get(key);
    this.messages.set(key, held ? { ...row, at: Math.min(held.at, row.at), sidechain: held.sidechain || row.sidechain } : row);
  }

  addSession(sighting: SessionSighting): void {
    const held = this.sessions.get(sighting.id);
    if (!held) {
      this.sessions.set(sighting.id, sighting);
      return;
    }
    held.lastAt = Math.max(held.lastAt, sighting.lastAt);
    if (sighting.firstAt < held.firstAt) {
      held.firstAt = sighting.firstAt;
      held.cwd = sighting.cwd ?? held.cwd;
    } else {
      held.cwd ??= sighting.cwd;
    }
    held.version = sighting.version ?? held.version;
    held.machine ??= sighting.machine;
    held.seen = { ...held.seen, titled: held.seen.titled || sighting.seen.titled };
  }

  addTotals(row: TotalsRow): void {
    this.totals.set(`${row.sessionId}\0${row.model}`, row);
  }

  /** One sighting of a window's percentage. Keyed by its moment, so re-reading the same line within a pass is free rather than doubled. */
  addLimit(row: LimitRow): void {
    this.limits.set(`${row.source}\0${row.account}\0${row.kind}\0${row.at}`, row);
  }

  get size(): number {
    return this.messages.size + this.sessions.size + this.totals.size + this.limits.size + this.files.size + this.skipped.length;
  }
}

type Row = Record<string, unknown>;

/** The rollups' number columns, in the order `MessageCell.sums` holds them. */
const SUM_COLUMNS = ["messages", "input", "cache_write_5m", "cache_write_1h", "cache_read", "output", "thinking", "cost_est", "unpriced"] as const;

interface MessageCell {
  day: string;
  sessionId: string;
  model: string;
  /** `daily`'s keys but the day and the model — profile, workspace, card, kind, program, node — or null for a session `sessions` has no row for. */
  keys: string[] | null;
  sums: number[];
}

/** What one batch moved, by `daily` cell and by `session_days` cell, before it is added in. */
class CellMoves {
  readonly daily = new Map<string, { day: string; keys: string[]; model: string; sums: number[] }>();
  readonly sessions = new Map<string, { day: string; sessionId: string; model: string; sums: number[] }>();

  add(cell: MessageCell, sign: 1 | -1): void {
    if (cell.keys) {
      const key = JSON.stringify([cell.day, cell.model, ...cell.keys]);
      let held = this.daily.get(key);
      if (!held) this.daily.set(key, (held = { day: cell.day, keys: cell.keys, model: cell.model, sums: SUM_COLUMNS.map(() => 0) }));
      for (let i = 0; i < held.sums.length; i++) held.sums[i]! += sign * cell.sums[i]!;
    }
    const key = JSON.stringify([cell.day, cell.sessionId, cell.model]);
    let held = this.sessions.get(key);
    if (!held) this.sessions.set(key, (held = { day: cell.day, sessionId: cell.sessionId, model: cell.model, sums: SUM_COLUMNS.map(() => 0) }));
    for (let i = 0; i < held.sums.length; i++) held.sums[i]! += sign * cell.sums[i]!;
  }
}

export class Ledger {
  private readonly statements = new Map<string, StatementSync>();

  private constructor(
    readonly path: string,
    private readonly db: DatabaseSync,
  ) {}

  /**
   * Open, making the file and the schema as needed. Throws when it cannot, or
   * when it is from a newer build, whose rows this one might misread: the
   * caller carries on without a ledger and leaves the file for that build.
   */
  static open(path = ledgerPath()): Ledger {
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    const fresh = !existsSync(path);
    // A second server on one data directory is the only other writer there can
    // be, and a reader that waits on it would hold the event loop.
    const db = new DatabaseSync(path, { timeout: 250 });
    if (fresh) {
      try {
        chmodSync(path, 0o600);
      } catch {
        // The directory is already private.
      }
    }
    db.exec("pragma journal_mode = wal");
    // A row lost to a power cut is read again from its offset, so a commit is not worth an fsync.
    db.exec("pragma synchronous = normal");
    // 16 MB rather than the default 2: the rebuilds that remain, the Usage
    // page's reads and a reattribution walk `messages_at`, which the default
    // thrashed on a busy day (the 2026-11-02 review, §2.4). A cap, not an
    // allocation — pages are cached as they are read.
    db.exec("pragma cache_size = -16384");
    const ledger = new Ledger(path, db);
    ledger.migrate();
    return ledger;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // Closed already.
    }
  }

  private migrate(): void {
    const version = Number((this.db.prepare("pragma user_version").get() as Row).user_version ?? 0);
    if (version > MIGRATIONS.length) throw new Error(`usage.db is version ${version}, newer than this build knows (${MIGRATIONS.length})`);
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[v]!);
        // A new rollup is empty and the messages it rolls up are already here.
        if (MIGRATIONS[v] === SESSION_DAYS) {
          // Which it reads alongside what the nodes said, whose tables are the next step.
          this.db.exec(NODES);
          for (const row of this.db.prepare("select distinct day from daily").all() as Row[]) this.rollupSessions(row.day as string);
        }
        this.db.exec(`pragma user_version = ${v + 1}`);
      });
    }
  }

  private stmt(sql: string): StatementSync {
    let prepared = this.statements.get(sql);
    if (!prepared) {
      prepared = this.db.prepare(sql);
      this.statements.set(sql, prepared);
    }
    return prepared;
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("begin immediate");
    try {
      const out = fn();
      this.db.exec("commit");
      return out;
    } catch (err) {
      try {
        this.db.exec("rollback");
      } catch {
        // Already rolled back.
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Offsets
  // -------------------------------------------------------------------------

  file(path: string): FileRow | null {
    const row = this.stmt("select * from files where path = ?").get(path) as Row | undefined;
    if (!row) return null;
    return {
      path,
      program: row.program as UsageProgram,
      loginDir: (row.login_dir as string | null) ?? null,
      inode: row.inode as number,
      size: row.size as number,
      offset: row.offset as number,
      mtime: row.mtime as number,
      sessionId: (row.session_id as string | null) ?? null,
    };
  }

  /** Every file the ledger holds an offset for under a directory, so that one no longer there can be let go of. */
  filesUnder(dir: string): string[] {
    const rows = this.stmt("select path from files where path >= ? and path < ?").all(`${dir}/`, `${dir}0`) as Row[];
    return rows.map((row) => row.path as string);
  }

  /** A file is gone: its offset goes with it, and its messages stay. Those are the point. */
  forget(paths: readonly string[]): void {
    if (!paths.length) return;
    this.tx(() => {
      for (const path of paths) this.stmt("delete from files where path = ?").run(path);
    });
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  /** Everything a batch read, its offsets and the days it touched, as one transaction. */
  flush(batch: LedgerBatch, facts: AttributionFacts, at = Date.now()): void {
    if (!batch.size) return;
    this.tx(() => {
      // The days rebuilt whole, and the sessions whose messages go to them.
      const days = new Set<string>();
      const rekeyed = new Set<string>();
      for (const session of batch.sessions.values()) if (this.writeSession(session, facts, days)) rekeyed.add(session.id);
      const moved = new CellMoves();
      for (const row of batch.messages.values()) {
        const before = this.cellOf(row.sessionId, row.messageId);
        this.writeMessage(row);
        if (rekeyed.has(row.sessionId)) {
          days.add(dayOf(row.at));
          if (before) days.add(before.day);
          continue;
        }
        if (before) moved.add(before, -1);
        moved.add(this.cellOf(row.sessionId, row.messageId)!, 1);
      }
      for (const row of batch.totals.values()) this.writeTotals(row);
      for (const row of batch.limits.values()) this.writeLimit(row);
      for (const file of batch.files.values()) this.writeFile(file, at);
      this.writeSkipped(batch.skipped, at);
      for (const day of days) this.rollup(day);
      this.addMoves(moved, days);
    });
  }

  /**
   * One message as the rollups count it: the day and keys of its cells, and
   * its numbers. The session's keys are null when it has no row in
   * `sessions`, which `daily` does not count and `session_days` does.
   */
  private cellOf(sessionId: string, messageId: string): MessageCell | null {
    const row = this.stmt(
      `select m.at, m.model, m.input, m.cache_write_5m, m.cache_write_1h, m.cache_read, m.output, m.thinking, m.cost_est,
         s.id is not null as known, coalesce(s.profile_key, '') as profile_key, coalesce(s.workspace_key, '') as workspace_key,
         coalesce(s.card_id, '') as card_id, s.kind, s.program, coalesce(s.node, '') as node
       from messages m left join sessions s on s.id = m.session_id
       where m.session_id = ? and m.message_id = ?`,
    ).get(sessionId, messageId) as Row | undefined;
    if (!row) return null;
    const cost = row.cost_est as number | null;
    return {
      day: dayOf(row.at as number),
      sessionId,
      model: row.model as string,
      keys: row.known ? [row.profile_key, row.workspace_key, row.card_id, row.kind, row.program, row.node].map(String) : null,
      sums: [
        1,
        row.input as number,
        row.cache_write_5m as number,
        row.cache_write_1h as number,
        row.cache_read as number,
        row.output as number,
        row.thinking as number,
        cost ?? 0,
        cost === null ? 1 : 0,
      ],
    };
  }

  /**
   * What a batch added, into `daily` and `session_days`, except on the days
   * rebuilt whole, which already have it. A cell left with no messages goes,
   * as a rebuild would not have made it.
   */
  private addMoves(moved: CellMoves, rebuilt: ReadonlySet<string>): void {
    const sets = SUM_COLUMNS.map((c) => `${c} = %t.${c} + excluded.${c}`).join(", ");
    const values = SUM_COLUMNS.map(() => "?").join(", ");
    for (const { day, keys, model, sums } of moved.daily.values()) {
      if (rebuilt.has(day) || sums.every((n) => n === 0)) continue;
      const pk = [day, ...keys.slice(0, 3), keys[3]!, keys[4]!, model, keys[5]!];
      this.stmt(
        `insert into daily(day, profile_key, workspace_key, card_id, kind, program, model, node, ${SUM_COLUMNS.join(", ")})
         values (?, ?, ?, ?, ?, ?, ?, ?, ${values})
         on conflict(day, profile_key, workspace_key, card_id, kind, program, model, node) do update set ${sets.replaceAll("%t", "daily")}`,
      ).run(...pk, ...sums);
      this.stmt(
        `delete from daily where day = ? and profile_key = ? and workspace_key = ? and card_id = ? and kind = ? and program = ? and model = ? and node = ?
           and messages <= 0`,
      ).run(...pk);
    }
    for (const { day, sessionId, model, sums } of moved.sessions.values()) {
      if (rebuilt.has(day) || sums.every((n) => n === 0)) continue;
      this.stmt(
        `insert into session_days(day, session_id, model, ${SUM_COLUMNS.join(", ")}) values (?, ?, ?, ${values})
         on conflict(day, session_id, model) do update set ${sets.replaceAll("%t", "session_days")}`,
      ).run(day, sessionId, model, ...sums);
      this.stmt("delete from session_days where day = ? and session_id = ? and model = ? and messages <= 0").run(day, sessionId, model);
    }
  }

  /** Writes the session's row, and says whether its messages are counted under other keys now — or under none before — which only a rebuild can move. */
  private writeSession(session: SessionSighting, facts: AttributionFacts, days: Set<string>): boolean {
    const read = attributionFor(session.id, session.seen, facts);
    const held = this.attributionOf(session.id);
    const attribution = held ? strongerAttribution(held, read) : read;
    const rekeyed = !held || !sameRollupKeys(held, attribution);
    if (rekeyed) this.addDaysOf(session.id, days);
    this.stmt(
      `insert into sessions(id, program, profile_key, login_dir, cwd, project_dir, workspace_key, card_id, run_id, agent_id, kind,
         machine, started_at, last_at, parent_session, version, attributed_by)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(id) do update set
         profile_key = excluded.profile_key, workspace_key = excluded.workspace_key, card_id = excluded.card_id,
         run_id = excluded.run_id, agent_id = excluded.agent_id, kind = excluded.kind, attributed_by = excluded.attributed_by,
         login_dir = coalesce(excluded.login_dir, sessions.login_dir), project_dir = coalesce(sessions.project_dir, excluded.project_dir),
         machine = coalesce(sessions.machine, excluded.machine),
         cwd = case when excluded.started_at < sessions.started_at then coalesce(excluded.cwd, sessions.cwd) else coalesce(sessions.cwd, excluded.cwd) end,
         started_at = min(sessions.started_at, excluded.started_at),
         last_at = max(sessions.last_at, excluded.last_at),
         parent_session = coalesce(sessions.parent_session, excluded.parent_session),
         version = coalesce(excluded.version, sessions.version)`,
    ).run(
      session.id,
      session.program,
      attribution.profileKey,
      session.loginDir,
      session.cwd,
      session.seen.projectDir,
      attribution.workspaceKey,
      attribution.cardId,
      attribution.runId,
      attribution.agentId,
      attribution.kind,
      session.machine ?? null,
      session.firstAt,
      session.lastAt,
      session.parentSession,
      session.version,
      attribution.attributedBy,
    );
    return rekeyed;
  }

  private attributionOf(id: string): Attribution | null {
    const row = this.stmt("select profile_key, workspace_key, card_id, run_id, agent_id, kind, attributed_by from sessions where id = ?").get(id) as Row | undefined;
    return row ? attributionFromRow(row) : null;
  }

  private addDaysOf(sessionId: string, days: Set<string>): void {
    // By the session's span rather than its every message: a day touched by mistake only costs a rebuild.
    const row = this.stmt("select min(at) as first, max(at) as last from messages where session_id = ?").get(sessionId) as Row | undefined;
    const first = row?.first as number | null | undefined;
    const last = row?.last as number | null | undefined;
    if (first === null || first === undefined || last === null || last === undefined) return;
    for (let day = dayOf(first); ; day = dayOf(dayBounds(day).end)) {
      days.add(day);
      if (day >= dayOf(last)) break;
    }
  }

  /**
   * Last sighting's counts, because a stream's copies could grow, and first
   * sighting's time, because that is the moment it was asked for. `sidechain`
   * and `source` stick once seen: a subagent's last turn is also copied into
   * its parent's file, and must stay the subagent's whichever is read first.
   */
  private writeMessage(row: MessageRow): void {
    this.stmt(
      `insert into messages(session_id, message_id, at, model, requested_model, effort, input, cache_write_5m, cache_write_1h,
         cache_read, output, thinking, cost_est, sidechain, source)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(session_id, message_id) do update set
         at = min(messages.at, excluded.at), model = excluded.model,
         requested_model = coalesce(excluded.requested_model, messages.requested_model),
         effort = coalesce(excluded.effort, messages.effort),
         input = excluded.input, cache_write_5m = excluded.cache_write_5m, cache_write_1h = excluded.cache_write_1h,
         cache_read = excluded.cache_read, output = excluded.output, thinking = excluded.thinking, cost_est = excluded.cost_est,
         sidechain = max(messages.sidechain, excluded.sidechain),
         source = case when messages.source = 'subagent' then messages.source else excluded.source end`,
    ).run(
      row.sessionId,
      row.messageId,
      row.at,
      row.model,
      row.requestedModel,
      row.effort,
      row.input,
      row.write5m,
      row.write1h,
      row.read,
      row.output,
      row.thinking,
      row.costEst,
      row.sidechain ? 1 : 0,
      row.source,
    );
  }

  private writeTotals(row: TotalsRow): void {
    this.stmt(
      `insert into session_totals(session_id, model, input, output, thinking, cache_read, cache_write_5m, cache_write_1h, cost_program, at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(session_id, model) do update set
         input = excluded.input, output = excluded.output, thinking = excluded.thinking, cache_read = excluded.cache_read,
         cache_write_5m = excluded.cache_write_5m, cache_write_1h = excluded.cache_write_1h,
         cost_program = excluded.cost_program, at = excluded.at`,
    ).run(row.sessionId, row.model, row.input, row.output, row.thinking, row.read, row.write5m, row.write1h, row.costProgram, row.at);
  }

  private writeLimit(row: LimitRow): void {
    this.stmt("insert into limits(at, account, kind, scope, percent, resets_at, source) values (?, ?, ?, ?, ?, ?, ?)").run(
      row.at,
      row.account,
      row.kind,
      row.scope,
      row.percent,
      row.resetsAt,
      row.source,
    );
  }

  private writeFile(file: FileRow, at: number): void {
    this.stmt(
      `insert into files(path, program, login_dir, inode, size, offset, mtime, session_id, read_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(path) do update set
         inode = excluded.inode, size = excluded.size, offset = excluded.offset, mtime = excluded.mtime,
         session_id = coalesce(excluded.session_id, files.session_id), read_at = excluded.read_at`,
    ).run(file.path, file.program, file.loginDir, file.inode, file.size, file.offset, file.mtime, file.sessionId, at);
  }

  private writeSkipped(skipped: readonly { path: string; atByte: number; why: string }[], at: number): void {
    if (!skipped.length) return;
    let room = MAX_SKIPPED - Number((this.stmt("select count(*) as n from skipped").get() as Row).n);
    for (const each of skipped) {
      if (room-- <= 0) return;
      this.stmt("insert or ignore into skipped(path, at_byte, why, at) values (?, ?, ?, ?)").run(each.path, each.atByte, each.why, at);
    }
  }

  /** A local day's rows of `daily`, made again from its messages. */
  private rollup(day: string): void {
    const { start, end } = dayBounds(day);
    this.stmt("delete from daily where day = ?").run(day);
    this.stmt(
      `insert into daily(day, profile_key, workspace_key, card_id, kind, program, model, node, messages, input, cache_write_5m,
         cache_write_1h, cache_read, output, thinking, cost_est, unpriced)
       select ?, coalesce(s.profile_key, ''), coalesce(s.workspace_key, ''), coalesce(s.card_id, ''), s.kind, s.program, m.model,
         coalesce(s.node, ''), count(*), sum(m.input), sum(m.cache_write_5m), sum(m.cache_write_1h), sum(m.cache_read), sum(m.output),
         sum(m.thinking), coalesce(sum(m.cost_est), 0), sum(m.cost_est is null)
       from messages m join sessions s on s.id = m.session_id
       where m.at >= ? and m.at < ?
       group by 2, 3, 4, 5, 6, 7, 8`,
    ).run(day, start, end);
    // What the nodes said, under each node's name. Never the same key as above, which is this node's own.
    this.stmt(
      `insert into daily(day, profile_key, workspace_key, card_id, kind, program, model, node, messages, input, cache_write_5m,
         cache_write_1h, cache_read, output, thinking, cost_est, unpriced)
       select ?, coalesce(s.profile_key, ''), coalesce(s.workspace_key, ''), coalesce(s.card_id, ''), s.kind, s.program, c.model,
         coalesce(p.name, c.node), sum(c.messages), sum(c.input), sum(c.cache_write_5m), sum(c.cache_write_1h), sum(c.cache_read), sum(c.output),
         sum(c.thinking), sum(c.cost_est), sum(c.unpriced)
       from node_cells c join node_sessions s on s.node = c.node and s.id = c.session_id left join node_pulls p on p.node = c.node
       where c.at >= ? and c.at < ?
       group by 2, 3, 4, 5, 6, 7, 8`,
    ).run(day, start, end);
    this.rollupSessions(day);
  }

  /** A local day's rows of `session_days`, made again from its messages. */
  private rollupSessions(day: string): void {
    const { start, end } = dayBounds(day);
    this.stmt("delete from session_days where day = ?").run(day);
    this.stmt(
      `insert into session_days(day, session_id, model, messages, input, cache_write_5m, cache_write_1h, cache_read, output, thinking, cost_est, unpriced)
       select ?, session_id, model, sum(messages), sum(input), sum(cache_write_5m), sum(cache_write_1h), sum(cache_read), sum(output), sum(thinking), sum(cost_est), sum(unpriced)
       from (
         select session_id, model, ${CELL_READ}
         from messages where at >= ? and at < ? group by session_id, model
         union all
         select session_id, model, messages, input, cache_write_5m, cache_write_1h, cache_read, output, thinking, cost_est, unpriced
         from node_cells where at >= ? and at < ?
       )
       group by session_id, model`,
    ).run(day, start, end, start, end);
  }

  /**
   * Read what the database has come to know again, for sessions already here:
   * a card's run can name a session after the reader has seen it, and a
   * transcript that has stopped growing would otherwise keep the folder's word
   * for good. Only the facts are read again and never a file, so this cannot
   * lose what a title or a folder said, and only an upgrade is a change.
   */
  reattribute(facts: AttributionFacts): number {
    const rows = this.stmt("select id, project_dir, profile_key, workspace_key, card_id, run_id, agent_id, kind, attributed_by from sessions").all() as Row[];
    const changes: { id: string; held: Attribution; next: Attribution }[] = [];
    for (const row of rows) {
      const held = attributionFromRow(row);
      const read = attributionFor(row.id as string, { projectDir: (row.project_dir as string | null) ?? "", titled: false, loginKey: null }, facts);
      const next = strongerAttribution(held, read);
      if (next !== held && !sameAttribution(held, next)) changes.push({ id: row.id as string, held, next });
    }
    if (!changes.length) return 0;
    this.tx(() => {
      const days = new Set<string>();
      for (const { id, held, next } of changes) {
        if (!sameRollupKeys(held, next)) this.addDaysOf(id, days);
        this.stmt("update sessions set profile_key = ?, workspace_key = ?, card_id = ?, run_id = ?, agent_id = ?, kind = ?, attributed_by = ? where id = ?").run(
          next.profileKey,
          next.workspaceKey,
          next.cardId,
          next.runId,
          next.agentId,
          next.kind,
          next.attributedBy,
          id,
        );
      }
      for (const day of days) this.rollup(day);
    });
    return changes.length;
  }

  // -------------------------------------------------------------------------
  // Launches
  // -------------------------------------------------------------------------

  /**
   * An agent kururu started, or a resume of one: its session's row, by id, so
   * a card picked back up is the one row it always was. Whatever a log already
   * said gives way, with the days it had reached moved to match. `last_at` is
   * left alone, since it means the last message and starting is not one.
   */
  recordLaunch(launch: LaunchRow & { sessionId: string }): void {
    this.tx(() => this.writeLaunch(launch, "spawn"));
  }

  /** A hook said this terminal is running this session. Writes only when nothing better has named it. */
  recordReport(launch: LaunchRow & { sessionId: string }): boolean {
    return this.tx(() => {
      if (!reportNames(this.attributionOf(launch.sessionId))) return false;
      this.writeLaunch(launch, "report");
      return true;
    });
  }

  private writeLaunch(launch: LaunchRow & { sessionId: string }, by: "spawn" | "report"): void {
    const held = this.stmt("select profile_key, workspace_key, card_id, run_id, agent_id, kind, attributed_by, node from sessions where id = ?").get(launch.sessionId) as Row | undefined;
    const next: Attribution = {
      profileKey: launch.profileKey,
      workspaceKey: launch.workspaceKey,
      cardId: launch.cardId,
      // The run is the database's to number; see `strongerAttribution`.
      runId: held && held.card_id === launch.cardId ? ((held.run_id as number | null) ?? null) : null,
      agentId: launch.agentId,
      kind: launch.kind,
      attributedBy: by,
    };
    const days = new Set<string>();
    if (held && (!sameRollupKeys(attributionFromRow(held), next) || held.node !== launch.node)) this.addDaysOf(launch.sessionId, days);
    this.upsertLaunch(launch, next);
    for (const day of days) this.rollup(day);
  }

  private upsertLaunch(launch: LaunchRow & { sessionId: string }, next: Attribution): void {
    this.stmt(
      `insert into sessions(id, program, profile_key, login_dir, cwd, workspace_key, card_id, run_id, agent_id, kind, node, machine,
         started_at, last_at, attributed_by)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(id) do update set
         profile_key = excluded.profile_key, workspace_key = excluded.workspace_key, card_id = excluded.card_id, run_id = excluded.run_id,
         agent_id = excluded.agent_id, kind = excluded.kind, attributed_by = excluded.attributed_by, node = excluded.node, machine = excluded.machine,
         login_dir = coalesce(sessions.login_dir, excluded.login_dir), cwd = coalesce(sessions.cwd, excluded.cwd),
         started_at = min(sessions.started_at, excluded.started_at)`,
    ).run(
      launch.sessionId,
      launch.program,
      next.profileKey,
      launch.loginDir,
      launch.cwd,
      next.workspaceKey,
      next.cardId,
      next.runId,
      next.agentId,
      next.kind,
      launch.node,
      launch.machine,
      launch.at,
      launch.at,
      next.attributedBy,
    );
  }

  /** A launch with no id yet, in a table of its own because a row in `sessions` needs the key it does not have. */
  addWaiting(launch: WaitingLaunch): void {
    this.stmt(
      `insert or replace into waiting(agent_id, program, profile_key, workspace_key, card_id, kind, node, machine, login_dir, cwd, at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(launch.agentId, launch.program, launch.profileKey, launch.workspaceKey, launch.cardId, launch.kind, launch.node, launch.machine, launch.loginDir, launch.cwd, launch.at);
  }

  /** The launches still waiting, oldest first. A handful at most, read once a minute. */
  waiting(): WaitingLaunch[] {
    const rows = this.stmt("select * from waiting order by at").all() as Row[];
    return rows.map((row) => ({
      agentId: row.agent_id as string,
      sessionId: null,
      program: row.program as UsageProgram,
      profileKey: (row.profile_key as string | null) ?? null,
      workspaceKey: (row.workspace_key as string | null) ?? null,
      cardId: (row.card_id as string | null) ?? null,
      kind: row.kind as WaitingLaunch["kind"],
      node: (row.node as string | null) ?? null,
      machine: (row.machine as string | null) ?? null,
      loginDir: (row.login_dir as string | null) ?? null,
      cwd: (row.cwd as string | null) ?? null,
      at: row.at as number,
    }));
  }

  /** A terminal's program said its id: the newest launch waiting on that terminal gets its row. False when none was. */
  settleWaiting(agentId: string, sessionId: string): boolean {
    return this.tx(() => {
      const row = this.waiting().filter((each) => each.agentId === agentId).at(-1);
      if (!row) return false;
      this.writeLaunch({ ...row, sessionId }, "spawn");
      this.stmt("delete from waiting where agent_id = ? and at = ?").run(row.agentId, row.at);
      return true;
    });
  }

  /** A launch nothing has claimed in a week had no session to find: a tab opened and never spoken to. */
  dropWaitingBefore(at: number): void {
    this.stmt("delete from waiting where at < ?").run(at);
  }

  /** Which of these sessions a launch has already named, so that a folder and a time cannot claim one twice. */
  launched(ids: readonly string[]): Set<string> {
    const out = new Set<string>();
    for (const id of ids) {
      const row = this.stmt("select attributed_by from sessions where id = ?").get(id) as Row | undefined;
      if (row?.attributed_by === "spawn") out.add(id);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Limits
  // -------------------------------------------------------------------------

  /**
   * One or more sightings of an allowance window, written outside the sweep's
   * batch: `usage.ts`'s own poll is the only source for Claude's reading, on a
   * beat of its own, and nothing else here ever sees it. Codex's history
   * arrives the other way, riding on the rollout tailer's messages
   * (`codexLimitSnapshots`, written by `flush`), because every `rate_limits`
   * object is already beside the tokens that reader reads; this is the one
   * bridge the live bar's numbers still need. No rollup to keep in step —
   * `limits` is not part of `daily` — so a plain transaction is enough.
   */
  recordLimits(rows: readonly LimitRow[]): void {
    if (!rows.length) return;
    this.tx(() => {
      for (const row of rows) this.writeLimit(row);
    });
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /**
   * What was billed in a span, a cell per session per model per slice: whole
   * days off the rollup, however many messages are behind them, and the two ends
   * that do not fall on midnight off the messages, which are at most two days'
   * worth. What the page asks for most, so what must not grow with the ledger.
   */
  usageCells(from: number, to: number): UsageCell[] {
    const { firstDay, lastDay, edges } = splitDays(from, to);
    const out: UsageCell[] = [];
    if (firstDay && lastDay) {
      const starts = new Map<string, number>();
      for (const row of this.stmt("select * from session_days where day >= ? and day <= ?").all(firstDay, lastDay) as Row[]) {
        const day = row.day as string;
        let at = starts.get(day);
        if (at === undefined) {
          at = dayBounds(day).start;
          starts.set(day, at);
        }
        out.push(cellOf(row, at));
      }
    }
    for (const edge of edges) {
      for (const row of this.stmt(`select session_id, model, ${CELL_READ} from messages where at >= ? and at < ? group by session_id, model`).all(edge.from, edge.to) as Row[]) {
        out.push(cellOf(row, edge.from));
      }
      // A node's rows are quarter hours, and a slice is cut on one to within fifteen minutes.
      for (const row of this.stmt(`select session_id, model, ${NODE_CELL_READ} from node_cells where at >= ? and at < ? group by session_id, model`).all(edge.from, edge.to) as Row[]) {
        out.push(cellOf(row, edge.from));
      }
    }
    return out;
  }

  /** A span by the quarter hour, off the messages, for a single day drawn by the hour. Quarters because every zone there is falls on one. */
  usageQuarters(from: number, to: number): UsageCell[] {
    const rows = this.stmt(`select session_id, model, at / ${QUARTER_MS} * ${QUARTER_MS} as quarter, ${CELL_READ} from messages where at >= ? and at < ? group by session_id, model, quarter`).all(from, to) as Row[];
    const nodes = this.stmt(`select session_id, model, at as quarter, ${NODE_CELL_READ} from node_cells where at >= ? and at < ? group by session_id, model, at`).all(from, to) as Row[];
    return [...rows, ...nodes].map((row) => cellOf(row, Math.max(from, row.quarter as number)));
  }

  /** Everything ever, by session and model: who has spent the most is what decides who keeps which colour. */
  usageAllTime(): UsageCell[] {
    const rows = this.stmt(
      `select session_id, model, sum(messages) as messages, sum(input) as input, sum(cache_write_5m) as cache_write_5m, sum(cache_write_1h) as cache_write_1h,
         sum(cache_read) as cache_read, sum(output) as output, sum(thinking) as thinking, sum(cost_est) as cost_est, sum(unpriced) as unpriced
       from session_days group by session_id, model`,
    ).all() as Row[];
    return rows.map((row) => cellOf(row, 0));
  }

  /** Every session the ledger has heard of, to look up by an id a cell named. A launch's row has no messages yet, so this is never a count. */
  usageFacts(): Map<string, SessionFact> {
    const out = new Map<string, SessionFact>();
    // A node's first, so that a launch's own row wins where this node started the session.
    for (const row of this.stmt(
      `select s.id, s.program, s.kind, s.workspace_key, s.card_id, s.cwd, s.attributed_by, s.machine, s.started_at, s.last_at, coalesce(p.name, s.node) as node_name
       from node_sessions s left join node_pulls p on p.node = s.node`,
    ).all() as Row[]) {
      out.set(row.id as string, {
        id: row.id as string,
        program: row.program as UsageProgram,
        kind: row.kind as SessionFact["kind"],
        workspaceKey: (row.workspace_key as string | null) ?? null,
        cardId: (row.card_id as string | null) ?? null,
        cwd: (row.cwd as string | null) ?? null,
        attributedBy: row.attributed_by as SessionFact["attributedBy"],
        agentId: null,
        startedAt: row.started_at as number,
        lastAt: row.last_at as number,
        node: row.node_name as string,
        machine: (row.machine as string | null) ?? null,
      });
    }
    for (const row of this.stmt("select id, program, kind, workspace_key, card_id, cwd, attributed_by, agent_id, machine, started_at, last_at from sessions").all() as Row[]) {
      out.set(row.id as string, {
        id: row.id as string,
        program: row.program as UsageProgram,
        kind: row.kind as SessionFact["kind"],
        workspaceKey: (row.workspace_key as string | null) ?? null,
        cardId: (row.card_id as string | null) ?? null,
        cwd: (row.cwd as string | null) ?? null,
        attributedBy: row.attributed_by as SessionFact["attributedBy"],
        agentId: (row.agent_id as string | null) ?? null,
        startedAt: row.started_at as number,
        lastAt: row.last_at as number,
        machine: (row.machine as string | null) ?? null,
      });
    }
    return out;
  }

  /** What the programs themselves say each session spent, in dollars, where they say. */
  usageSays(): Map<string, number> {
    const out = new Map<string, number>();
    for (const row of this.stmt("select id, says from node_sessions where says is not null").all() as Row[]) out.set(row.id as string, row.says as number);
    for (const row of this.stmt("select session_id, sum(cost_program) as says from session_totals where cost_program is not null group by session_id").all() as Row[]) {
      out.set(row.session_id as string, row.says as number);
    }
    return out;
  }

  /**
   * How much context a session carried on each of its messages, in order. A
   * subagent's messages are its own conversation, so they are left out rather
   * than drawn as sawteeth through the parent's.
   */
  usageContext(sessionId: string): number[] {
    const rows = this.stmt("select input + cache_read + cache_write_5m + cache_write_1h as context from messages where session_id = ? and sidechain = 0 order by at").all(sessionId) as Row[];
    return rows.map((row) => row.context as number);
  }

  usageLimits(from: number, to: number): LimitReading[] {
    const rows = this.stmt("select at, kind, scope, percent, source from limits where at >= ? and at < ? and percent is not null order by at").all(from, to) as Row[];
    return rows.map((row) => ({ at: row.at as number, kind: row.kind as string, scope: (row.scope as string | null) ?? null, percent: row.percent as number, source: row.source as string }));
  }

  // -------------------------------------------------------------------------
  // What another node said
  // -------------------------------------------------------------------------

  /** Each of this node's days as a signature of its row of `daily`: what moves when a day has anything new to say, whoever's it became. */
  usageDaySigns(): { day: string; sig: string }[] {
    const out: { day: string; sig: string }[] = [];
    let day: string | null = null;
    let hash = createHash("sha1");
    const finish = () => {
      if (day !== null) out.push({ day, sig: hash.digest("hex").slice(0, 16) });
    };
    for (const row of this.stmt(
      `select day, profile_key, workspace_key, card_id, kind, program, model, messages, input, cache_write_5m, cache_write_1h, cache_read, output, thinking
       from daily order by day, profile_key, workspace_key, card_id, kind, program, model, node`,
    ).all() as Row[]) {
      if (row.day !== day) {
        finish();
        day = row.day as string;
        hash = createHash("sha1");
      }
      hash.update(`${row.profile_key}|${row.workspace_key}|${row.card_id}|${row.kind}|${row.program}|${row.model}|${row.messages}|${row.input}|${row.cache_write_5m}|${row.cache_write_1h}|${row.cache_read}|${row.output}|${row.thinking}\n`);
    }
    finish();
    return out;
  }

  /** How many rows a day of `session_days` holds: near enough to its quarter-hour cells, for sizing an answer before it is made. */
  usageDayWeight(day: string): number {
    return (this.stmt("select count(*) as n from session_days where day = ?").get(day) as Row).n as number;
  }

  /** One of this node's days as the quarter hours a parent keeps. Only this node's own messages: a parent's pulled rows are never passed on. */
  usageDayCells(day: string): PulledCell[] {
    const { start, end } = dayBounds(day);
    const rows = this.stmt(`select session_id, model, at / ${QUARTER_MS} * ${QUARTER_MS} as quarter, ${CELL_READ} from messages where at >= ? and at < ? group by session_id, model, quarter`).all(start, end) as Row[];
    return rows.map((row) => ({
      sessionId: row.session_id as string,
      model: row.model as string,
      at: row.quarter as number,
      messages: row.messages as number,
      input: row.input as number,
      write5m: row.cache_write_5m as number,
      write1h: row.cache_write_1h as number,
      read: row.cache_read as number,
      output: row.output as number,
      thinking: row.thinking as number,
      cost: row.cost_est as number,
      unpriced: row.unpriced as number,
    }));
  }

  /** These sessions as a parent keeps them: no terminal's id, which means nothing there. */
  usageSessionsToSend(ids: Iterable<string>): PulledSession[] {
    const out: PulledSession[] = [];
    for (const id of ids) {
      const row = this.stmt(
        `select s.*, (select sum(cost_program) from session_totals t where t.session_id = s.id) as says from sessions s where s.id = ?`,
      ).get(id) as Row | undefined;
      if (!row) continue;
      out.push({
        id,
        program: row.program as UsageProgram,
        kind: row.kind as PulledSession["kind"],
        profileKey: (row.profile_key as string | null) ?? null,
        workspaceKey: (row.workspace_key as string | null) ?? null,
        cardId: (row.card_id as string | null) ?? null,
        machine: (row.machine as string | null) ?? null,
        cwd: (row.cwd as string | null) ?? null,
        attributedBy: row.attributed_by as PulledSession["attributedBy"],
        startedAt: row.started_at as number,
        lastAt: row.last_at as number,
        says: (row.says as number | null) ?? null,
      });
    }
    return out;
  }

  /** What was last said for each of a node's days, which is what the next ask tells it. */
  nodeDaysKnown(node: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const row of this.stmt("select day, sig from node_days where node = ?").all(node) as Row[]) out[row.day as string] = row.sig as string;
    return out;
  }

  /**
   * One answer from a node, all of it or none. Each day it sent replaces what
   * was held for that day, and the days of this node's that either the old cells
   * or the new ones fall on are rolled up again. A session whose messages this
   * node read for itself stays what it read, so that a machine which is also a
   * child is counted once, by whichever road reached it first.
   */
  applyNodeUsage(node: string, name: string, part: UsagePart, at = Date.now()): void {
    this.tx(() => {
      const days = new Set<string>();
      const ownRead = new Map<string, boolean>();
      const isOwn = (id: string) => {
        let held = ownRead.get(id);
        if (held === undefined) {
          held = this.stmt("select 1 as one from messages where session_id = ? limit 1").get(id) !== undefined;
          ownRead.set(id, held);
        }
        return held;
      };
      // The name first, since `rollup` reads it.
      this.stmt("insert into node_pulls(node, name, at) values (?, ?, ?) on conflict(node) do update set name = excluded.name, at = excluded.at").run(node, name, at);
      for (const each of part.sessions) {
        this.stmt(
          `insert into node_sessions(node, id, program, kind, profile_key, workspace_key, card_id, machine, cwd, attributed_by, started_at, last_at, says)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict(node, id) do update set
             program = excluded.program, kind = excluded.kind, profile_key = excluded.profile_key, workspace_key = excluded.workspace_key,
             card_id = excluded.card_id, machine = excluded.machine, cwd = excluded.cwd, attributed_by = excluded.attributed_by,
             started_at = excluded.started_at, last_at = excluded.last_at, says = excluded.says`,
        ).run(node, each.id, each.program, each.kind, each.profileKey, each.workspaceKey, each.cardId, each.machine, each.cwd, each.attributedBy, each.startedAt, each.lastAt, each.says);
      }
      for (const day of part.days) {
        const was = this.stmt("select min(at) as first, max(at) as last from node_cells where node = ? and node_day = ?").get(node, day.day) as Row;
        for (const moment of [was.first, was.last]) if (typeof moment === "number") days.add(dayOf(moment));
        // A day it has no cells for is one its ledger no longer holds, a restored one perhaps, and that is not the day having cost nothing.
        if (day.cells.length) this.stmt("delete from node_cells where node = ? and node_day = ?").run(node, day.day);
        for (const cell of day.cells) {
          if (isOwn(cell.sessionId)) continue;
          days.add(dayOf(cell.at));
          this.stmt(
            `insert into node_cells(node, node_day, session_id, model, at, messages, input, cache_write_5m, cache_write_1h, cache_read, output, thinking, cost_est, unpriced)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             on conflict(node, session_id, model, at) do update set
               node_day = excluded.node_day, messages = excluded.messages, input = excluded.input, cache_write_5m = excluded.cache_write_5m,
               cache_write_1h = excluded.cache_write_1h, cache_read = excluded.cache_read, output = excluded.output, thinking = excluded.thinking,
               cost_est = excluded.cost_est, unpriced = excluded.unpriced`,
          ).run(node, day.day, cell.sessionId, cell.model, cell.at, cell.messages, cell.input, cell.write5m, cell.write1h, cell.read, cell.output, cell.thinking, cell.cost, cell.unpriced);
        }
        this.stmt("insert into node_days(node, day, sig) values (?, ?, ?) on conflict(node, day) do update set sig = excluded.sig").run(node, day.day, day.sig);
      }
      for (const kind of ["workspaces", "cards"] as const) {
        for (const [key, label] of Object.entries(part.names[kind])) {
          this.stmt("insert into node_names(node, kind, key, label) values (?, ?, ?, ?) on conflict(node, kind, key) do update set label = excluded.label").run(node, kind, key, label);
        }
      }
      for (const day of days) this.rollup(day);
    });
  }

  /** When each node was last heard from, kept across a restart: a node that has gone quiet is exactly the one this is asked about. */
  nodePulls(): { node: string; name: string; at: number | null }[] {
    return (this.stmt("select node, name, at from node_pulls order by name").all() as Row[]).map((row) => ({ node: row.node as string, name: row.name as string, at: (row.at as number | null) ?? null }));
  }

  /** What a node calls a workspace or a card, for one this node has never heard of. */
  nodeName(kind: "workspaces" | "cards", key: string): string | null {
    const row = this.stmt("select label from node_names where kind = ? and key = ? limit 1").get(kind, key) as Row | undefined;
    return (row?.label as string | undefined) ?? null;
  }

  /** Every session a node has told this one about, so that the ssh road can leave them alone. */
  nodeSessionIds(): Set<string> {
    return new Set((this.stmt("select distinct session_id from node_cells").all() as Row[]).map((row) => row.session_id as string));
  }

  /** Which machines kururu has started an agent on, by the name it wrote at launch. */
  machinesLaunchedOn(): Set<string> {
    const out = new Set<string>();
    for (const row of this.stmt("select distinct machine from sessions where machine is not null union select distinct machine from waiting where machine is not null").all() as Row[]) out.add(row.machine as string);
    return out;
  }

  /** The model a session was last on: all a rollout read from part way through a turn has to go on, its `turn_context` being behind the offset. */
  lastModelOf(sessionId: string): string | null {
    const row = this.stmt("select model from messages where session_id = ? and model <> '' order by at desc limit 1").get(sessionId) as Row | undefined;
    return (row?.model as string | undefined) ?? null;
  }

  // -------------------------------------------------------------------------
  // Backup export
  // -------------------------------------------------------------------------

  /**
   * Every row of `daily`, for `usage/export.ts` to write out one file a
   * month. Decision 9: the rollup leaves the machine and the message rows
   * never do, so this reads the one table that is already numbers, keys and
   * folder names and nothing a transcript wrote.
   */
  dailyExport(): DailyExportRow[] {
    const rows = this.stmt(
      `select day, profile_key, workspace_key, card_id, kind, program, model, node, messages, input, cache_write_5m,
         cache_write_1h, cache_read, output, thinking, cost_est, unpriced from daily
       order by day, profile_key, workspace_key, card_id, kind, program, model, node`,
    ).all() as Row[];
    return rows.map((row) => ({
      day: row.day as string,
      profileKey: row.profile_key as string,
      workspaceKey: row.workspace_key as string,
      cardId: row.card_id as string,
      kind: row.kind as string,
      program: row.program as string,
      model: row.model as string,
      node: row.node as string,
      messages: row.messages as number,
      input: row.input as number,
      write5m: row.cache_write_5m as number,
      write1h: row.cache_write_1h as number,
      read: row.cache_read as number,
      output: row.output as number,
      thinking: row.thinking as number,
      costEst: row.cost_est as number,
      unpriced: row.unpriced as number,
    }));
  }

  /**
   * A restore's `daily` rows, back in. Upserted on the table's own key rather
   * than appended, so reading the same month's file twice is the same table,
   * never two of each row — a restore the user runs again is not a doubling.
   */
  importDaily(rows: readonly DailyExportRow[]): number {
    if (!rows.length) return 0;
    return this.tx(() => {
      const stmt = this.stmt(
        `insert into daily(day, profile_key, workspace_key, card_id, kind, program, model, node, messages, input, cache_write_5m,
           cache_write_1h, cache_read, output, thinking, cost_est, unpriced)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(day, profile_key, workspace_key, card_id, kind, program, model, node) do update set
           messages = excluded.messages, input = excluded.input, cache_write_5m = excluded.cache_write_5m,
           cache_write_1h = excluded.cache_write_1h, cache_read = excluded.cache_read, output = excluded.output,
           thinking = excluded.thinking, cost_est = excluded.cost_est, unpriced = excluded.unpriced`,
      );
      for (const row of rows) {
        stmt.run(
          row.day,
          row.profileKey,
          row.workspaceKey,
          row.cardId,
          row.kind,
          row.program,
          row.model,
          row.node,
          row.messages,
          row.input,
          row.write5m,
          row.write1h,
          row.read,
          row.output,
          row.thinking,
          row.costEst,
          row.unpriced,
        );
      }
      return rows.length;
    });
  }

  /** The counts `bun run status` prints. Off `daily` where it can, which is a few thousand rows however many messages. */
  counts(): { messages: number; sessions: number; files: number; oldestDay: string | null; newestDay: string | null; skipped: number; unpriced: number; bytes: number } {
    const daily = this.stmt("select coalesce(sum(messages), 0) as messages, coalesce(sum(unpriced), 0) as unpriced, min(day) as oldest, max(day) as newest from daily").get() as Row;
    const sessions = (this.stmt("select (select count(*) from sessions) + (select count(*) from node_sessions) as n").get() as Row).n as number;
    const files = (this.stmt("select count(*) as n from files").get() as Row).n as number;
    const skipped = (this.stmt("select count(*) as n from skipped").get() as Row).n as number;
    let bytes = 0;
    for (const path of [this.path, `${this.path}-wal`]) {
      try {
        bytes += statSync(path).size;
      } catch {
        // No write-ahead log just now.
      }
    }
    return {
      messages: daily.messages as number,
      unpriced: daily.unpriced as number,
      oldestDay: (daily.oldest as string | null) ?? null,
      newestDay: (daily.newest as string | null) ?? null,
      sessions,
      files,
      skipped,
      bytes,
    };
  }
}

function cellOf(row: Row, at: number): UsageCell {
  return {
    at,
    sessionId: row.session_id as string,
    model: row.model as string,
    messages: row.messages as number,
    input: row.input as number,
    write5m: row.cache_write_5m as number,
    write1h: row.cache_write_1h as number,
    read: row.cache_read as number,
    output: row.output as number,
    thinking: row.thinking as number,
    cost: row.cost_est as number,
    unpriced: row.unpriced as number,
  };
}

function attributionFromRow(row: Row): Attribution {
  return {
    profileKey: (row.profile_key as string | null) ?? null,
    workspaceKey: (row.workspace_key as string | null) ?? null,
    cardId: (row.card_id as string | null) ?? null,
    runId: (row.run_id as number | null) ?? null,
    agentId: (row.agent_id as string | null) ?? null,
    kind: row.kind as Attribution["kind"],
    attributedBy: row.attributed_by as Attribution["attributedBy"],
  };
}

function sameAttribution(a: Attribution, b: Attribution): boolean {
  return sameRollupKeys(a, b) && a.runId === b.runId && a.agentId === b.agentId && a.attributedBy === b.attributedBy;
}
