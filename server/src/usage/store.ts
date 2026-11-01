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
 * behind it. It is rebuilt for each day a batch touched, in the transaction
 * that wrote the batch, so the two tables cannot be seen to disagree and a
 * crash between them does not exist. Whole days rather than the touched keys
 * because a day is a few thousand rows and a few milliseconds, and because a
 * session that changes attribution moves between keys without any new row.
 * The empty string stands for "none" in its keys, since SQLite treats two
 * NULLs in a primary key as different and the conflict would never fire.
 *
 * **Everything a log said is written by `flush`, in one transaction, with the
 * offsets that produced it.** A crash replays from the last offset that was
 * written, and the primary key makes replaying harmless. What kururu says about
 * a session it started comes the other way, through `recordLaunch`, on the same
 * connection, and neither can run inside the other: both are synchronous.
 */
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
  type LaunchRow,
  type LimitRow,
  type MessageRow,
  type SeenInLog,
  type TotalsRow,
  type UsageProgram,
  type WaitingLaunch,
} from "../../../shared/usage";
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

/** Each entry takes the file from its index's version to the next. The first makes it. */
const MIGRATIONS: readonly string[] = [SCHEMA, WAITING];

/** A format that moved would otherwise write a row per line forever; the count stops being useful long before this. */
const MAX_SKIPPED = 10_000;

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
      const days = new Set<string>();
      for (const session of batch.sessions.values()) this.writeSession(session, facts, days);
      for (const row of batch.messages.values()) {
        days.add(dayOf(row.at));
        this.writeMessage(row);
      }
      for (const row of batch.totals.values()) this.writeTotals(row);
      for (const row of batch.limits.values()) this.writeLimit(row);
      for (const file of batch.files.values()) this.writeFile(file, at);
      this.writeSkipped(batch.skipped, at);
      for (const day of days) this.rollup(day);
    });
  }

  private writeSession(session: SessionSighting, facts: AttributionFacts, days: Set<string>): void {
    const read = attributionFor(session.id, session.seen, facts);
    const held = this.attributionOf(session.id);
    const attribution = held ? strongerAttribution(held, read) : read;
    if (held && !sameRollupKeys(held, attribution)) this.addDaysOf(session.id, days);
    this.stmt(
      `insert into sessions(id, program, profile_key, login_dir, cwd, project_dir, workspace_key, card_id, run_id, agent_id, kind,
         started_at, last_at, parent_session, version, attributed_by)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(id) do update set
         profile_key = excluded.profile_key, workspace_key = excluded.workspace_key, card_id = excluded.card_id,
         run_id = excluded.run_id, agent_id = excluded.agent_id, kind = excluded.kind, attributed_by = excluded.attributed_by,
         login_dir = coalesce(excluded.login_dir, sessions.login_dir), project_dir = coalesce(sessions.project_dir, excluded.project_dir),
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
      session.firstAt,
      session.lastAt,
      session.parentSession,
      session.version,
      attribution.attributedBy,
    );
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
  // Reading
  // -------------------------------------------------------------------------

  /** The counts `bun run status` prints. Off `daily` where it can, which is a few thousand rows however many messages. */
  counts(): { messages: number; sessions: number; files: number; oldestDay: string | null; newestDay: string | null; skipped: number; unpriced: number; bytes: number } {
    const daily = this.stmt("select coalesce(sum(messages), 0) as messages, coalesce(sum(unpriced), 0) as unpriced, min(day) as oldest, max(day) as newest from daily").get() as Row;
    const sessions = (this.stmt("select count(*) as n from sessions").get() as Row).n as number;
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
