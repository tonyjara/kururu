/**
 * The database: boards, conversations and the voice's lists, in one SQLite
 * file that nothing rebuilds and nothing overwrites whole.
 *
 * Cards used to ride in `session.json` with the layout, and that file's rules
 * lost them. It is state: ignored whole on a version mismatch, written
 * last-writer-wins by whichever server was up, and carrying a board through
 * a process that had never seen one meant the board came back as that
 * process understood it. A board is content somebody typed, the most
 * valuable thing on the machine, and it wants the opposite rules: every
 * change written as it happens, nothing ever deleted but marked, and a
 * history that says what moved and who moved it.
 *
 * `node:sqlite`, because the server runs on Node — the app's own Electron as
 * node, 24 at the time of writing — and the module is built into it: no
 * native build, no `.node` beside the bundle, FTS5 for the search already
 * compiled in. The API is five calls and a wrapper this size is the whole
 * exposure to it changing.
 *
 * **Where.** XDG's data directory, `~/.local/share/kururu`, and not the state
 * one `persist.ts` uses or the config one `config.ts` does. `config.ts`
 * draws the line between them — state is rebuildable, config is decisions —
 * and this is a third thing: it grows, nobody hand-edits it, and it cannot
 * be made again. `KURURU_DATA_DIR` moves it for an isolated instance.
 *
 * **Keys.** Every row that belongs to a profile or a workspace hangs off its
 * `key`, never its id — see `shared/store.ts`. A workspace whose key the
 * file lost (a fresh `session.json`) is matched back to its board by name,
 * when exactly one unclaimed board of that name is waiting; boards nothing
 * claims are kept, never dropped.
 *
 * **The only storage.** A first start makes the file, and there is no other
 * place a board is kept: the layout file carries keys and never boards.
 *
 * **Write-through, and refuse rather than diverge.** `workspaces.ts` hands
 * every board change here before it changes memory, in one transaction per
 * verb, and a write the disk refuses is a verb refused: memory never holds
 * what the file does not. Reads for the window still come off the snapshot;
 * the database is read at start, for the search, and for the history.
 *
 * **One way in from the file.** `attach` adopts any card a layout file or
 * blob carries that this database has never seen, with an `imported` event,
 * and nothing a file says ever moves or deletes a card that is here. So a
 * build from before the database, run against the same files, cannot lose
 * a card typed into it — and the next start here takes it in.
 */
import { backup, DatabaseSync, type StatementSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Profile, Workspace } from "../../shared/model";
import { adoptBoard, adoptProfileBoard, emptyBoard, type Board, type BoardLane, type Card, type CardRun } from "../../shared/board";
import { adoptMade } from "../../shared/made";
import { promptCarries, type StoredMissed, type StoredOutboxEntry, type VoiceLang } from "../../shared/voice";
import {
  diffBoards,
  EXPORT_VERSION,
  pairTransfers,
  sameRun,
  stripPastedContent,
  viaOf,
  type Actor,
  type BoardExport,
  type CardEvent,
  type CardExport,
  type CardHit,
  type Conversation,
  type ConversationKind,
  type DataExport,
  type EventKind,
  type NewEvent,
  type SearchHit,
  type SearchScope,
  type Turn,
  type TurnHit,
  type TurnRole,
  type TurnVia,
  ftsQuery,
  mintProfileKey,
  mintWorkspaceKey,
} from "../../shared/store";

// ---------------------------------------------------------------------------
// Where
// ---------------------------------------------------------------------------

/** Read per call rather than captured, so a test can move it. */
export function dataDir(): string {
  return process.env.KURURU_DATA_DIR || join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "kururu");
}

export function dbPath(): string {
  return join(dataDir(), "kururu.db");
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Stepped by `MIGRATIONS`; `pragma user_version` holds it. */
const SCHEMA_VERSION = 4;

const SCHEMA = `
create table if not exists profiles (
  key text primary key, name text not null, login_key text,
  created_at integer not null, gone_at integer
);
create table if not exists workspaces (
  key text primary key, profile_key text not null references profiles(key),
  name text not null, created_at integer not null, gone_at integer
);
create table if not exists boards (
  id text primary key, profile_key text not null references profiles(key),
  workspace_key text references workspaces(key),
  next integer not null default 1, created_at integer not null,
  unique (profile_key, workspace_key)
);
create table if not exists lanes (
  board_id text not null references boards(id), id text not null, name text not null,
  color text, collapsed integer not null default 0, position integer not null,
  primary key (board_id, id)
);
create table if not exists cards (
  id text primary key, board_id text not null references boards(id),
  number integer not null, title text not null, body text not null default '',
  column_id text not null, position integer not null, isolate integer not null default 0,
  date_start text, date_end text,
  wt_root text, wt_path text, wt_branch text, wt_base text,
  dev_port integer, dev_agent_id text,
  created_at integer not null, updated_at integer not null, deleted_at integer
);
create index if not exists cards_board on cards(board_id, deleted_at);
create table if not exists card_runs (
  id integer primary key, card_id text not null references cards(id),
  launcher text not null, label text not null, state text not null,
  started_at integer not null, ended_at integer, session_id text, cwd text, agent_id text
);
create index if not exists card_runs_card on card_runs(card_id, started_at);
create table if not exists card_events (
  id integer primary key, at integer not null,
  card_id text not null references cards(id), board_id text not null references boards(id),
  actor text not null, kind text not null, from_column text, to_column text, detail text
);
create index if not exists card_events_card on card_events(card_id, at);
create table if not exists conversations (
  id text primary key, profile_key text not null, kind text not null,
  launcher text, cwd text, started_at integer not null
);
create table if not exists turns (
  id integer primary key, conversation_id text not null references conversations(id),
  at integer not null, role text not null, via text not null,
  text text not null, lang text, voice_id text
);
create index if not exists turns_conversation on turns(conversation_id, at);
create table if not exists voice_messages (
  id text primary key, profile_key text not null, at integer not null, ms integer not null,
  state text not null, text text, lang text, typed_at integer, note text,
  n integer not null, attempts integer not null, typings integer not null, transcript text
);
create table if not exists missed_replies (
  id text primary key, profile_key text not null, text text not null, lang text not null,
  at integer not null, pending integer not null, settled_at integer
);
create table if not exists meta (key text primary key, value text not null);
create virtual table if not exists cards_fts using fts5(
  title, body, content='cards', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
);
create trigger if not exists cards_ai after insert on cards begin
  insert into cards_fts(rowid, title, body) values (new.rowid, new.title, new.body);
end;
create trigger if not exists cards_ad after delete on cards begin
  insert into cards_fts(cards_fts, rowid, title, body) values ('delete', old.rowid, old.title, old.body);
end;
create trigger if not exists cards_au after update of title, body on cards begin
  insert into cards_fts(cards_fts, rowid, title, body) values ('delete', old.rowid, old.title, old.body);
  insert into cards_fts(rowid, title, body) values (new.rowid, new.title, new.body);
end;
create virtual table if not exists turns_fts using fts5(
  text, content='turns', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
create trigger if not exists turns_ai after insert on turns begin
  insert into turns_fts(rowid, text) values (new.id, new.text);
end;
create trigger if not exists turns_ad after delete on turns begin
  insert into turns_fts(turns_fts, rowid, text) values ('delete', old.id, old.text);
end;
`;

/**
 * The links to what a card's agent made (`Card.made`), as JSON: one or two
 * `{root, path, line}`, read back through `adoptMade`. A column rather than a
 * table because nothing ever asks for them except with their card, and never
 * in the export, for the reason the dev server is not: they point at files on
 * this disk, which a restored Mac does not have.
 *
 * Added only if it is not there, so the step can run twice: a database put
 * back a version by hand (`pragma user_version = 2`, for a build from before
 * it) and then opened by this one again still opens.
 */
function MADE_COLUMN(db: DatabaseSync): void {
  const columns = db.prepare("pragma table_info(cards)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "made")) db.exec("alter table cards add column made text");
}

/**
 * How wide a board's columns were dragged to (`Board.widths`), as JSON. A
 * column on `boards` rather than a row on `lanes`, because it is true of a
 * board that has no lanes at all — a workspace's — and `lanes` has no row
 * for one of those. Added the way `MADE_COLUMN` is, so the step can run twice.
 */
function WIDTHS_COLUMN(db: DatabaseSync): void {
  const columns = db.prepare("pragma table_info(boards)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "widths")) db.exec("alter table boards add column widths text");
}

/** Each entry takes the database from its index's version to the next. The first makes it. */
const MIGRATIONS: readonly (string | ((db: DatabaseSync) => void))[] = [SCHEMA, unwrapPastedTurns, MADE_COLUMN, WIDTHS_COLUMN];

/**
 * Every turn of yours already on disk, reporting what Claude Code's own
 * `UserPromptSubmit` hook wrapped a paste in before the prompt hook learned
 * to ask for it unwrapped — see `stripPastedContent`. `via` is recomputed
 * alongside the text it was read off, since a wrapped prompt never started
 * with the voice's prefix and so was misread as typed. `turns_fts` is an
 * external-content table with no update trigger — turns are written once and
 * never changed outside this migration — so the delete-then-insert the
 * ordinary triggers do on either side of a real change is done by hand here.
 */
function unwrapPastedTurns(db: DatabaseSync): void {
  const rows = db.prepare("select id, text from turns where role = 'you'").all() as { id: number; text: string }[];
  const deleteFts = db.prepare("insert into turns_fts(turns_fts, rowid, text) values ('delete', ?, ?)");
  const update = db.prepare("update turns set text = ?, via = ? where id = ?");
  const insertFts = db.prepare("insert into turns_fts(rowid, text) values (?, ?)");
  for (const row of rows) {
    const text = stripPastedContent(row.text);
    if (text === row.text) continue;
    deleteFts.run(row.id, row.text);
    update.run(text, viaOf(text), row.id);
    insertFts.run(row.id, text);
  }
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

interface CardRow {
  id: string;
  board_id: string;
  number: number;
  title: string;
  body: string;
  column_id: string;
  position: number;
  isolate: number;
  date_start: string | null;
  date_end: string | null;
  wt_root: string | null;
  wt_path: string | null;
  wt_branch: string | null;
  wt_base: string | null;
  dev_port: number | null;
  dev_agent_id: string | null;
  made: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

interface RunRow {
  id: number;
  card_id: string;
  launcher: string;
  label: string;
  state: CardRun["state"];
  started_at: number;
  ended_at: number | null;
  session_id: string | null;
  cwd: string | null;
  agent_id: string | null;
}

function cardOf(row: CardRow, run: CardRun | null): Card {
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    body: row.body,
    column: row.column_id,
    createdAt: row.created_at,
    run,
    isolate: row.isolate === 1,
    worktree: row.wt_root && row.wt_path && row.wt_branch && row.wt_base ? { root: row.wt_root, path: row.wt_path, branch: row.wt_branch, base: row.wt_base } : null,
    dev: row.dev_port ? { agentId: row.dev_agent_id, port: row.dev_port } : null,
    dates: row.date_start && row.date_end ? { start: row.date_start, end: row.date_end } : null,
    ...madeOf(row.made),
  };
}

/** The column back as `Card.made`: absent rather than empty, so a card nothing was made from reads as it always did. */
function madeOf(json: string | null): Pick<Card, "made"> {
  if (!json) return {};
  try {
    const made = adoptMade(JSON.parse(json));
    return made.length ? { made } : {};
  } catch {
    return {};
  }
}

function madeColumn(card: Card): string | null {
  return card.made?.length ? JSON.stringify(card.made) : null;
}

/** `boards.widths` back as `Board.widths`: absent rather than empty, like `made`. */
function widthsOf(json: string | null): Pick<Board, "widths"> {
  if (!json) return {};
  try {
    const widths = JSON.parse(json) as unknown;
    return widths && typeof widths === "object" ? { widths: widths as Record<string, number> } : {};
  } catch {
    return {};
  }
}

function widthsColumn(board: Board): string | null {
  return board.widths && Object.keys(board.widths).length ? JSON.stringify(board.widths) : null;
}

function runOf(row: RunRow): CardRun {
  return {
    agentId: row.agent_id,
    launcher: row.launcher,
    label: row.label,
    state: row.state,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    sessionId: row.session_id,
    cwd: row.cwd,
  };
}

function mintBoardId(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return `b${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** One board's change, as `workspaces.ts` hands it over. `before` is null for a board being made. */
export interface BoardChange {
  profileKey: string;
  /** Null for the profile's own board. */
  workspaceKey: string | null;
  before: Board | null;
  after: Board;
}

export interface ImportCounts {
  profiles: number;
  workspaces: number;
  boards: number;
  cards: number;
  turns: number;
  outbox: number;
  missed: number;
}

export interface DeletedCard {
  id: string;
  number: number;
  title: string;
  column: string;
  deletedAt: number;
  workspaceKey: string | null;
  workspaceName: string | null;
}

export interface NewTurn {
  conversationId: string;
  profileKey: string;
  kind: ConversationKind;
  launcher: string | null;
  cwd: string | null;
  role: TurnRole;
  text: string;
  lang?: VoiceLang | null;
  at: number;
  /**
   * How it was said, when the caller knows better than the text does: a
   * `say` line is `kururu`. Otherwise read off the text for your turns and
   * `typed` for Kuru's.
   */
  via?: TurnVia;
  /**
   * For Kuru's turns, the utterance the reply was said as, so the drawer can
   * put each reply's fate beside it — the missed list is keyed by it. For
   * yours it is found rather than given: the outbox message whose words the
   * prompt carries.
   */
  voiceId?: string | null;
}

/** How close two reports of the same words must be to be one turn reported twice — hooks installed in two places. */
const TURN_DEDUPE_MS = 15_000;
/** How much of a turn a search hit carries back. */
const HIT_TEXT_MAX = 2_000;
/** Daily copies kept beside the database. */
const COPIES_KEPT = 7;

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export class Store {
  private readonly db: DatabaseSync;
  /** Bumped by every write, so the backup can tell a quiet five minutes from a busy one. */
  changes = 0;
  private readonly statements = new Map<string, StatementSync>();

  private constructor(
    readonly path: string,
    db: DatabaseSync,
  ) {
    this.db = db;
  }

  /**
   * Open, making the directory and the schema as needed. Throws when the
   * file is there and cannot be opened: the caller must not run on without
   * it, since that would be the layout file's rules all over again.
   */
  static open(path = dbPath()): Store {
    const dir = join(path, "..");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fresh = !existsSync(path);
    const db = new DatabaseSync(path, { timeout: 5_000, enableForeignKeyConstraints: false });
    if (fresh) {
      try {
        chmodSync(path, 0o600);
      } catch {
        // The directory is already private.
      }
    }
    db.exec("pragma journal_mode = wal");
    const store = new Store(path, db);
    store.migrate();
    return store;
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
    if (version > SCHEMA_VERSION) throw new Error(`the database is version ${version}, newer than this build knows (${SCHEMA_VERSION})`);
    for (let v = version; v < SCHEMA_VERSION; v++) {
      this.tx(() => {
        const step = MIGRATIONS[v]!;
        if (typeof step === "string") this.db.exec(step);
        else step(this.db);
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
      this.changes++;
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
  // The file
  // -------------------------------------------------------------------------

  /** How big the file is, for the About page. */
  bytes(): number {
    try {
      return statSync(this.path).size + (existsSync(`${this.path}-wal`) ? statSync(`${this.path}-wal`).size : 0);
    } catch {
      return 0;
    }
  }

  // -------------------------------------------------------------------------
  // Identities and start-up
  // -------------------------------------------------------------------------

  /**
   * Make the live profiles and the database agree, at start.
   *
   * Every profile and workspace is written down by key and name. One whose
   * key the database does not know is given the key of the one unclaimed
   * row of the same name, if there is exactly one — a layout file written
   * fresh after the database existed would otherwise orphan every board —
   * and is a new row otherwise. Rows nothing claims are marked gone and
   * kept. Then the boards are read in, replacing whatever the file or the
   * blob carried, after any card in those that the database has never seen
   * is adopted. Runs and dev servers naming a terminal the host does not
   * have are read as ended, the way `persist.ts` reads a run with no process.
   */
  attach(profiles: Profile[], live: ReadonlySet<string>, at = Date.now()): { profiles: Profile[]; adopted: number; recovered: number } {
    let adopted = 0;
    let recovered = 0;
    const out = this.tx(() => {
      const held = new Set(profiles.map((p) => p.key));
      const result: Profile[] = [];
      for (const given of profiles) {
        let profile = given;
        if (!this.has("profiles", profile.key)) {
          const found = this.unclaimedProfile(profile.name, profile.loginKey, held);
          if (found) {
            profile = { ...profile, key: found };
            held.add(found);
            recovered++;
          }
        }
        this.touchProfile(profile.key, profile.name, profile.loginKey, at);
        const wsHeld = new Set(profile.workspaces.map((w) => w.key));
        const workspaces: Workspace[] = [];
        for (const givenWs of profile.workspaces) {
          let workspace = givenWs;
          if (!this.has("workspaces", workspace.key)) {
            const found = this.unclaimedWorkspace(profile.key, workspace.name, wsHeld);
            if (found) {
              workspace = { ...workspace, key: found };
              wsHeld.add(found);
              recovered++;
            }
          }
          this.touchWorkspace(workspace.key, profile.key, workspace.name, at);
          adopted += this.adoptStray(profile.key, workspace.key, workspace.board, at);
          workspaces.push({ ...workspace, board: this.loadBoardWithin(profile.key, workspace.key, live, at) });
        }
        this.stmt("update workspaces set gone_at = ? where profile_key = ? and gone_at is null and key not in (select value from json_each(?))").run(
          at,
          profile.key,
          JSON.stringify([...wsHeld]),
        );
        adopted += this.adoptStray(profile.key, null, profile.board, at);
        const board = this.loadBoardWithin(profile.key, null, live, at) ?? adoptProfileBoard(null);
        result.push({ ...profile, workspaces, board: adoptProfileBoard(board) });
      }
      this.stmt("update profiles set gone_at = ? where gone_at is null and key not in (select value from json_each(?))").run(at, JSON.stringify([...held]));
      return result;
    });
    return { profiles: out, adopted, recovered };
  }

  private has(table: "profiles" | "workspaces", key: string): boolean {
    return this.stmt(`select 1 as x from ${table} where key = ?`).get(key) !== undefined;
  }

  private unclaimedProfile(name: string, loginKey: string, held: ReadonlySet<string>): string | null {
    const rows = this.stmt("select key, login_key from profiles where name = ? order by gone_at is null desc, created_at").all(name) as Row[];
    const free = rows.filter((row) => !held.has(row.key as string));
    const byLogin = free.filter((row) => row.login_key === loginKey);
    const pick = byLogin.length === 1 ? byLogin : free;
    return pick.length === 1 ? (pick[0]!.key as string) : null;
  }

  private unclaimedWorkspace(profileKey: string, name: string, held: ReadonlySet<string>): string | null {
    const rows = this.stmt("select key from workspaces where profile_key = ? and name = ? order by gone_at is null desc, created_at").all(profileKey, name) as Row[];
    const free = rows.filter((row) => !held.has(row.key as string));
    return free.length === 1 ? (free[0]!.key as string) : null;
  }

  private touchProfile(key: string, name: string, loginKey: string | null, at: number): void {
    this.stmt(
      "insert into profiles(key, name, login_key, created_at, gone_at) values (?, ?, ?, ?, null) on conflict(key) do update set name = excluded.name, login_key = coalesce(excluded.login_key, profiles.login_key), gone_at = null",
    ).run(key, name, loginKey, at);
  }

  private touchWorkspace(key: string, profileKey: string, name: string, at: number): void {
    this.stmt(
      "insert into workspaces(key, profile_key, name, created_at, gone_at) values (?, ?, ?, ?, null) on conflict(key) do update set name = excluded.name, profile_key = excluded.profile_key, gone_at = null",
    ).run(key, profileKey, name, at);
  }

  /**
   * The one road from a file into the database: any card a board from the
   * file or the blob carries that no row names is written, on the board it
   * was on, as `imported`. A board the file has and the database has not is
   * made for it. Nothing here moves or deletes a card that is already here.
   */
  private adoptStray(profileKey: string, workspaceKey: string | null, board: Board | null, at: number): number {
    if (!board || board.cards.length === 0) return 0;
    const boardId = this.ensureBoard(profileKey, workspaceKey, board, at);
    let count = 0;
    for (const [position, card] of board.cards.entries()) {
      if (this.stmt("select 1 as x from cards where id = ?").get(card.id) !== undefined) continue;
      this.insertCard(boardId, card, position, at, at);
      this.event(boardId, { at, cardId: card.id, actor: "import", kind: "imported", fromColumn: null, toColumn: card.column, detail: { title: card.title } });
      count++;
    }
    if (count) this.stmt("update boards set next = max(next, ?) where id = ?").run(board.next, boardId);
    return count;
  }

  // -------------------------------------------------------------------------
  // Boards
  // -------------------------------------------------------------------------

  private boardId(profileKey: string, workspaceKey: string | null): string | null {
    const row = this.stmt("select id from boards where profile_key = ? and workspace_key is ?").get(profileKey, workspaceKey) as Row | undefined;
    return typeof row?.id === "string" ? row.id : null;
  }

  private ensureBoard(profileKey: string, workspaceKey: string | null, board: Board, at: number): string {
    const existing = this.boardId(profileKey, workspaceKey);
    if (existing) return existing;
    const id = mintBoardId();
    this.stmt("insert into boards(id, profile_key, workspace_key, next, created_at, widths) values (?, ?, ?, ?, ?, ?)").run(
      id,
      profileKey,
      workspaceKey,
      board.next,
      at,
      widthsColumn(board),
    );
    this.writeLanes(id, board.columns ?? null);
    return id;
  }

  private writeLanes(boardId: string, lanes: BoardLane[] | null): void {
    this.stmt("delete from lanes where board_id = ?").run(boardId);
    if (!lanes) return;
    const insert = this.stmt("insert into lanes(board_id, id, name, color, collapsed, position) values (?, ?, ?, ?, ?, ?)");
    for (const [position, lane] of lanes.entries()) insert.run(boardId, lane.id, lane.name, lane.color, lane.collapsed ? 1 : 0, position);
  }

  /** The board of a profile or a workspace, as the model holds it, or null when there has never been one. */
  loadBoard(profileKey: string, workspaceKey: string | null): Board | null {
    return this.loadBoardWithin(profileKey, workspaceKey, null, Date.now());
  }

  private loadBoardWithin(profileKey: string, workspaceKey: string | null, live: ReadonlySet<string> | null, at: number): Board | null {
    const boardRow = this.stmt("select id, next, widths from boards where profile_key = ? and workspace_key is ?").get(profileKey, workspaceKey) as Row | undefined;
    if (!boardRow) return null;
    const boardId = boardRow.id as string;
    const laneRows = this.stmt("select id, name, color, collapsed from lanes where board_id = ? order by position").all(boardId) as Row[];
    const columns: BoardLane[] | undefined = laneRows.length
      ? laneRows.map((row) => ({
          id: row.id as string,
          name: row.name as string,
          color: (row.color as BoardLane["color"]) ?? null,
          ...(row.collapsed === 1 ? { collapsed: true as const } : {}),
        }))
      : undefined;
    const rows = this.stmt("select * from cards where board_id = ? and deleted_at is null order by position, created_at").all(boardId) as unknown as CardRow[];
    const cards: Card[] = [];
    for (const row of rows) {
      let run = this.latestRun(row.id);
      if (run && live && run.agentId !== null && !live.has(run.agentId)) {
        // The terminal is gone: `adoptRun`'s rule, written back so the row says it too.
        const state: CardRun["state"] = run.state === "finished" || run.state === "asleep" ? run.state : "ended";
        this.stmt("update card_runs set agent_id = null, state = ?, ended_at = coalesce(ended_at, ?) where card_id = ? and started_at = ?").run(state, at, row.id, run.startedAt);
        run = { ...run, agentId: null, state, endedAt: run.endedAt ?? at };
      }
      const card = cardOf(row, run);
      if (card.dev && live && (card.dev.agentId === null || !live.has(card.dev.agentId))) {
        this.stmt("update cards set dev_port = null, dev_agent_id = null where id = ?").run(row.id);
        card.dev = null;
      }
      cards.push(card);
    }
    const raw: Board = { cards, next: Number(boardRow.next) || 1, ...(columns ? { columns } : {}), ...widthsOf(boardRow.widths as string | null) };
    return workspaceKey === null ? adoptProfileBoard(raw) : (adoptBoard(raw) ?? emptyBoard());
  }

  private latestRun(cardId: string): CardRun | null {
    const row = this.stmt("select * from card_runs where card_id = ? order by started_at desc, id desc limit 1").get(cardId) as unknown as RunRow | undefined;
    return row ? runOf(row) : null;
  }

  /**
   * Write one profile's board changes, in one transaction, with the history
   * they amount to. A card that left one board and arrived on another in the
   * same change keeps its row and is `sent`. Throws when the disk refuses,
   * and the caller then keeps the board it had.
   */
  saveBoards(changes: readonly BoardChange[], actor: Actor, at = Date.now()): void {
    if (changes.length === 0) return;
    this.tx(() => this.writeBoards(changes, actor, at));
  }

  /**
   * One profile becoming another, in one transaction: its name, its
   * workspaces' names, workspaces that went (marked, kept) or arrived, and
   * every board whose object is not the one it was — `shared/board.ts`
   * hands back the same object when nothing changed, which is what makes a
   * reference comparison exact here. Null on either side is a profile made
   * or deleted. This is what `workspaces.ts` calls before it changes memory.
   */
  syncProfile(before: Profile | null, after: Profile | null, actor: Actor, at = Date.now()): void {
    if (before === after) return;
    this.tx(() => {
      if (!after) {
        if (!before) return;
        this.stmt("update workspaces set gone_at = ? where profile_key = ? and gone_at is null").run(at, before.key);
        this.stmt("update profiles set gone_at = ? where key = ? and gone_at is null").run(at, before.key);
        return;
      }
      if (!before || before.name !== after.name || before.loginKey !== after.loginKey) this.touchProfile(after.key, after.name, after.loginKey, at);
      const was = new Map((before?.workspaces ?? []).map((w) => [w.key, w] as const));
      const changes: BoardChange[] = [];
      if (!before || before.board !== after.board) changes.push({ profileKey: after.key, workspaceKey: null, before: before?.board ?? null, after: after.board });
      for (const workspace of after.workspaces) {
        const old = was.get(workspace.key);
        if (!old || old.name !== workspace.name) this.touchWorkspace(workspace.key, after.key, workspace.name, at);
        if (workspace.board && old?.board !== workspace.board) {
          changes.push({ profileKey: after.key, workspaceKey: workspace.key, before: old?.board ?? null, after: workspace.board });
        }
        was.delete(workspace.key);
      }
      for (const gone of was.keys()) this.stmt("update workspaces set gone_at = ? where key = ? and gone_at is null").run(at, gone);
      this.writeBoards(changes, actor, at);
    });
  }

  private writeBoards(changes: readonly BoardChange[], actor: Actor, at: number): void {
    {
      const diffs = changes.map((change) => ({
        change,
        boardId: this.ensureBoard(change.profileKey, change.workspaceKey, change.after, at),
        diff: diffBoards(change.before, change.after, at, actor),
      }));
      const sent = new Map(pairTransfers(diffs.map((d) => ({ boardId: d.boardId, diff: d.diff }))).map((s) => [s.cardId, s] as const));
      for (const { change, boardId, diff } of diffs) {
        this.stmt("update boards set next = ? where id = ?").run(change.after.next, boardId);
        if (change.after.columns !== change.before?.columns) this.writeLanes(boardId, change.after.columns ?? null);
        if (change.after.widths !== change.before?.widths) this.stmt("update boards set widths = ? where id = ?").run(widthsColumn(change.after), boardId);
        const positions = new Map(change.after.cards.map((card, i) => [card.id, i] as const));
        for (const card of diff.added) {
          const transfer = sent.get(card.id);
          if (transfer && transfer.to === boardId) {
            this.stmt("update cards set board_id = ?, number = ?, column_id = ?, position = ?, deleted_at = null, updated_at = ? where id = ?").run(
              boardId,
              card.number,
              card.column,
              positions.get(card.id) ?? 0,
              at,
              card.id,
            );
            this.event(boardId, { at, cardId: card.id, actor, kind: "sent", fromColumn: null, toColumn: card.column, detail: { from: transfer.from, to: transfer.to } });
            continue;
          }
          this.insertCard(boardId, card, positions.get(card.id) ?? 0, card.createdAt || at, at);
        }
        for (const { before, after } of diff.changed) {
          this.updateCard(boardId, after, positions.get(after.id) ?? 0, at);
          this.writeRun(after, before.run, at);
        }
        for (const card of diff.removed) {
          if (sent.has(card.id)) continue;
          this.stmt("update cards set deleted_at = ?, updated_at = ? where id = ? and board_id = ?").run(at, at, card.id, boardId);
        }
        // Positions move under a drag that changed nothing else; cheap to keep true.
        const place = this.stmt("update cards set position = ? where id = ? and board_id = ? and position <> ?");
        for (const [id, position] of positions) place.run(position, id, boardId, position);
        for (const event of diff.events) {
          if (sent.has(event.cardId) && (event.kind === "created" || event.kind === "deleted")) continue;
          this.event(boardId, event);
        }
      }
    }
  }

  private insertCard(boardId: string, card: Card, position: number, createdAt: number, at: number): void {
    this.stmt(
      `insert into cards(id, board_id, number, title, body, column_id, position, isolate, date_start, date_end,
         wt_root, wt_path, wt_branch, wt_base, dev_port, dev_agent_id, made, created_at, updated_at, deleted_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null)
       on conflict(id) do update set board_id = excluded.board_id, number = excluded.number, title = excluded.title, body = excluded.body,
         column_id = excluded.column_id, position = excluded.position, isolate = excluded.isolate, date_start = excluded.date_start,
         date_end = excluded.date_end, wt_root = excluded.wt_root, wt_path = excluded.wt_path, wt_branch = excluded.wt_branch,
         wt_base = excluded.wt_base, dev_port = excluded.dev_port, dev_agent_id = excluded.dev_agent_id, made = excluded.made,
         updated_at = excluded.updated_at, deleted_at = null`,
    ).run(
      card.id,
      boardId,
      card.number,
      card.title,
      card.body,
      card.column,
      position,
      card.isolate ? 1 : 0,
      card.dates?.start ?? null,
      card.dates?.end ?? null,
      card.worktree?.root ?? null,
      card.worktree?.path ?? null,
      card.worktree?.branch ?? null,
      card.worktree?.base ?? null,
      card.dev?.port ?? null,
      card.dev?.agentId ?? null,
      madeColumn(card),
      createdAt,
      at,
    );
    this.writeRun(card, null, at);
  }

  private updateCard(boardId: string, card: Card, position: number, at: number): void {
    this.stmt(
      `update cards set number = ?, title = ?, body = ?, column_id = ?, position = ?, isolate = ?, date_start = ?, date_end = ?,
         wt_root = ?, wt_path = ?, wt_branch = ?, wt_base = ?, dev_port = ?, dev_agent_id = ?, made = ?, updated_at = ?
       where id = ? and board_id = ?`,
    ).run(
      card.number,
      card.title,
      card.body,
      card.column,
      position,
      card.isolate ? 1 : 0,
      card.dates?.start ?? null,
      card.dates?.end ?? null,
      card.worktree?.root ?? null,
      card.worktree?.path ?? null,
      card.worktree?.branch ?? null,
      card.worktree?.base ?? null,
      card.dev?.port ?? null,
      card.dev?.agentId ?? null,
      madeColumn(card),
      at,
      card.id,
      boardId,
    );
  }

  /** A run that began is a new row; one that moved on updates its row, found by its start. */
  private writeRun(card: Card, before: CardRun | null, _at: number): void {
    const run = card.run;
    if (!run) return;
    if (!sameRun(before, run) || !this.stmt("select 1 as x from card_runs where card_id = ? and started_at = ?").get(card.id, run.startedAt)) {
      this.stmt("insert into card_runs(card_id, launcher, label, state, started_at, ended_at, session_id, cwd, agent_id) values (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        card.id,
        run.launcher,
        run.label,
        run.state,
        run.startedAt,
        run.endedAt,
        run.sessionId,
        run.cwd,
        run.agentId,
      );
      return;
    }
    this.stmt("update card_runs set state = ?, ended_at = ?, session_id = coalesce(?, session_id), cwd = coalesce(?, cwd), agent_id = ? where card_id = ? and started_at = ?").run(
      run.state,
      run.endedAt,
      run.sessionId,
      run.cwd,
      run.agentId,
      card.id,
      run.startedAt,
    );
  }

  private event(boardId: string, event: NewEvent): void {
    this.stmt("insert into card_events(at, card_id, board_id, actor, kind, from_column, to_column, detail) values (?, ?, ?, ?, ?, ?, ?, ?)").run(
      event.at,
      event.cardId,
      boardId,
      event.actor,
      event.kind,
      event.fromColumn,
      event.toColumn,
      event.detail ? JSON.stringify(event.detail) : null,
    );
  }

  /** A card's history, oldest first. */
  cardHistory(cardId: string): CardEvent[] {
    const rows = this.stmt("select * from card_events where card_id = ? order by at, id").all(cardId) as Row[];
    return rows.map((row) => ({
      id: row.id as number,
      at: row.at as number,
      cardId: row.card_id as string,
      boardId: row.board_id as string,
      actor: row.actor as Actor,
      kind: row.kind as EventKind,
      fromColumn: (row.from_column as string | null) ?? null,
      toColumn: (row.to_column as string | null) ?? null,
      detail: typeof row.detail === "string" ? (JSON.parse(row.detail) as Record<string, unknown>) : null,
    }));
  }

  /** Where a card is, deleted or not: its board's owner, and the card. */
  findCard(cardId: string): { profileKey: string; workspaceKey: string | null; card: Card; deleted: boolean } | null {
    const row = this.stmt("select c.*, b.profile_key, b.workspace_key from cards c join boards b on b.id = c.board_id where c.id = ?").get(cardId) as
      | (CardRow & { profile_key: string; workspace_key: string | null })
      | undefined;
    if (!row) return null;
    return { profileKey: row.profile_key, workspaceKey: row.workspace_key, card: cardOf(row, this.latestRun(row.id)), deleted: row.deleted_at !== null };
  }

  /** The deleted cards of a profile, newest deletion first. */
  deletedCards(profileKey: string): DeletedCard[] {
    const rows = this.stmt(
      "select c.id, c.number, c.title, c.column_id, c.deleted_at, b.workspace_key, w.name as workspace_name from cards c join boards b on b.id = c.board_id left join workspaces w on w.key = b.workspace_key where b.profile_key = ? and c.deleted_at is not null order by c.deleted_at desc limit 200",
    ).all(profileKey) as Row[];
    return rows.map((row) => ({
      id: row.id as string,
      number: row.number as number,
      title: row.title as string,
      column: row.column_id as string,
      deletedAt: row.deleted_at as number,
      workspaceKey: (row.workspace_key as string | null) ?? null,
      workspaceName: (row.workspace_name as string | null) ?? null,
    }));
  }

  /**
   * Put a deleted card back, at the foot of its board's order and in the
   * column it left. The caller reloads the board into memory; the row is
   * the truth and memory follows it here, the one direction a restore can go.
   */
  restoreCard(cardId: string, actor: Actor, at = Date.now()): { profileKey: string; workspaceKey: string | null } | null {
    return this.tx(() => {
      const row = this.stmt("select c.board_id, c.column_id, b.profile_key, b.workspace_key from cards c join boards b on b.id = c.board_id where c.id = ? and c.deleted_at is not null").get(cardId) as Row | undefined;
      if (!row) return null;
      const boardId = row.board_id as string;
      const last = this.stmt("select coalesce(max(position), -1) as p from cards where board_id = ? and deleted_at is null").get(boardId) as Row;
      this.stmt("update cards set deleted_at = null, position = ?, updated_at = ? where id = ?").run((last.p as number) + 1, at, cardId);
      this.event(boardId, { at, cardId, actor, kind: "restored", fromColumn: null, toColumn: row.column_id as string, detail: null });
      return { profileKey: row.profile_key as string, workspaceKey: (row.workspace_key as string | null) ?? null };
    });
  }

  // -------------------------------------------------------------------------
  // Conversations
  // -------------------------------------------------------------------------

  /**
   * One turn of a conversation, or null for a repeat: the same words from
   * the same side within a few seconds are one turn reported twice. A turn
   * of yours is linked to the outbox message it delivered, found by the
   * words, which is also how the outbox itself knows a message arrived —
   * whether the message was spoken or typed in the drawer, since both go
   * through the outbox and the drawer draws the two as one item. A turn of
   * Kuru's is linked to the utterance it was said as, which the caller has.
   *
   * A paste wrapper around the whole prompt — see `stripPastedContent` — is
   * stripped before any of that: a wrapped voice turn does not start with the
   * voice's prefix, so `via` would misread it as typed, and the wrapper would
   * otherwise sit in the drawer, the search index and the backup's text
   * export forever, since nothing downstream unwraps it.
   */
  recordTurn(turn: NewTurn): number | null {
    return this.tx(() => {
      this.stmt(
        "insert into conversations(id, profile_key, kind, launcher, cwd, started_at) values (?, ?, ?, ?, ?, ?) on conflict(id) do update set launcher = coalesce(conversations.launcher, excluded.launcher), cwd = coalesce(conversations.cwd, excluded.cwd)",
      ).run(turn.conversationId, turn.profileKey, turn.kind, turn.launcher, turn.cwd, turn.at);
      const text = stripPastedContent(turn.text);
      const last = this.stmt("select role, text, at from turns where conversation_id = ? order by at desc, id desc limit 1").get(turn.conversationId) as Row | undefined;
      if (last && last.role === turn.role && last.text === text && Math.abs((last.at as number) - turn.at) < TURN_DEDUPE_MS) return null;
      const via: TurnVia = turn.via ?? (turn.role === "you" ? viaOf(text) : "typed");
      let voiceId: string | null = turn.voiceId ?? null;
      let lang: VoiceLang | null = turn.lang ?? null;
      if (turn.role === "you" && turn.voiceId === undefined) {
        const candidates = this.stmt("select id, text, lang from voice_messages where profile_key = ? and text is not null and state in ('queued', 'delivered') order by n desc limit 20").all(
          turn.profileKey,
        ) as Row[];
        const hit = candidates.find((row) => promptCarries(text, row.text as string));
        if (hit) {
          voiceId = hit.id as string;
          lang = (hit.lang as VoiceLang | null) ?? lang;
        }
      }
      const inserted = this.stmt("insert into turns(conversation_id, at, role, via, text, lang, voice_id) values (?, ?, ?, ?, ?, ?, ?) returning id").get(
        turn.conversationId,
        turn.at,
        turn.role,
        via,
        text,
        lang,
        voiceId,
      ) as Row;
      return inserted.id as number;
    });
  }

  /** The last turns of a conversation, oldest first. */
  turns(conversationId: string, limit = 50): Turn[] {
    const rows = this.stmt("select * from turns where conversation_id = ? order by at desc, id desc limit ?").all(conversationId, limit) as Row[];
    return rows.reverse().map(turnOf);
  }

  /**
   * A profile's conversation with its harness across every session it has
   * had, oldest first: the newest `limit` turns before `before`, and whether
   * there are more before those. One query over every harness conversation
   * rather than one per session, because the drawer is a timeline and a
   * fresh session is a mark on it, not a different list.
   */
  harnessTurns(profileKey: string, before: number | null, limit: number): { turns: Turn[]; more: boolean } {
    const rows = this.stmt(
      `select t.* from turns t join conversations v on v.id = t.conversation_id
       where v.profile_key = ? and v.kind = 'harness' and (? is null or t.at < ?)
       order by t.at desc, t.id desc limit ?`,
    ).all(profileKey, before, before, limit + 1) as Row[];
    const more = rows.length > limit;
    return { turns: rows.slice(0, limit).reverse().map(turnOf), more };
  }

  conversations(profileKey: string | null, kind: ConversationKind | null): Conversation[] {
    const rows = this.stmt("select * from conversations where (? is null or profile_key = ?) and (? is null or kind = ?) order by started_at").all(profileKey, profileKey, kind, kind) as Row[];
    return rows.map(conversationOf);
  }

  // -------------------------------------------------------------------------
  // The voice's lists
  // -------------------------------------------------------------------------

  loadOutbox(): StoredOutboxEntry[] {
    const rows = this.stmt("select * from voice_messages order by n").all() as Row[];
    return rows.map((row) => ({
      id: row.id as string,
      profileKey: row.profile_key as string,
      at: row.at as number,
      ms: row.ms as number,
      state: row.state as StoredOutboxEntry["state"],
      text: (row.text as string | null) ?? null,
      lang: (row.lang as VoiceLang | null) ?? null,
      typedAt: (row.typed_at as number | null) ?? null,
      note: (row.note as string | null) ?? null,
      n: row.n as number,
      attempts: row.attempts as number,
      typings: row.typings as number,
      transcript: (row.transcript as string | null) ?? null,
    }));
  }

  /** Every entry written as it is. Rows are never dropped here: a delivered message is a turn's provenance. */
  saveOutbox(entries: readonly StoredOutboxEntry[]): void {
    this.tx(() => {
      const upsert = this.stmt(
        `insert into voice_messages(id, profile_key, at, ms, state, text, lang, typed_at, note, n, attempts, typings, transcript)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(id) do update set state = excluded.state, text = excluded.text, lang = excluded.lang, typed_at = excluded.typed_at,
           note = excluded.note, attempts = excluded.attempts, typings = excluded.typings, transcript = excluded.transcript`,
      );
      for (const e of entries) upsert.run(e.id, e.profileKey, e.at, e.ms, e.state, e.text, e.lang, e.typedAt, e.note, e.n, e.attempts, e.typings, e.transcript);
    });
  }

  /** Discard takes a failed message off the list for good, audio and row. */
  removeVoice(id: string): void {
    this.tx(() => this.stmt("delete from voice_messages where id = ?").run(id));
  }

  loadMissed(): StoredMissed[] {
    const rows = this.stmt("select * from missed_replies where settled_at is null order by at").all() as Row[];
    return rows.map((row) => ({
      id: row.id as string,
      profileKey: row.profile_key as string,
      text: row.text as string,
      lang: row.lang as VoiceLang,
      at: row.at as number,
      pending: row.pending === 1,
    }));
  }

  /** The list as the voice holds it; a reply that left it was heard or cleared, and its row says when. */
  saveMissed(list: readonly StoredMissed[], at = Date.now()): void {
    this.tx(() => {
      const upsert = this.stmt(
        "insert into missed_replies(id, profile_key, text, lang, at, pending, settled_at) values (?, ?, ?, ?, ?, ?, null) on conflict(id) do update set pending = excluded.pending, settled_at = null",
      );
      for (const m of list) upsert.run(m.id, m.profileKey, m.text, m.lang, m.at, m.pending ? 1 : 0);
      this.stmt("update missed_replies set settled_at = ? where settled_at is null and id not in (select value from json_each(?))").run(at, JSON.stringify(list.map((m) => m.id)));
    });
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  /**
   * Full text over cards and turns. Cards first, then turns, each ranked by
   * FTS5's own measure within its kind — the two scales are not comparable,
   * and a list that interleaved them would be ordered by nothing.
   */
  search(query: string, scope: SearchScope = "all", profileKey: string | null = null, limit = 20): SearchHit[] {
    const match = ftsQuery(query);
    if (!match) return [];
    const cap = Math.max(1, Math.min(50, Math.floor(limit)));
    const hits: SearchHit[] = [];
    if (scope !== "turns") {
      const rows = this.stmt(
        `select c.id, c.board_id, b.profile_key, b.workspace_key, p.name as profile_name, w.name as workspace_name,
           c.number, c.title, c.column_id, c.deleted_at, c.updated_at,
           snippet(cards_fts, -1, '[', ']', '…', 12) as snip,
           (select max(e.at) from card_events e where e.card_id = c.id and e.kind = 'moved') as moved_at
         from cards_fts join cards c on c.rowid = cards_fts.rowid
           join boards b on b.id = c.board_id join profiles p on p.key = b.profile_key
           left join workspaces w on w.key = b.workspace_key
         where cards_fts match ? and (? is null or b.profile_key = ?)
         order by bm25(cards_fts), c.updated_at desc limit ?`,
      ).all(match, profileKey, profileKey, cap) as Row[];
      for (const row of rows) {
        const hit: CardHit = {
          kind: "card",
          id: row.id as string,
          boardId: row.board_id as string,
          profileKey: row.profile_key as string,
          workspaceKey: (row.workspace_key as string | null) ?? null,
          workspaceName: (row.workspace_name as string | null) ?? null,
          profileName: row.profile_name as string,
          number: row.number as number,
          title: row.title as string,
          column: row.column_id as string,
          snippet: row.snip as string,
          deleted: row.deleted_at !== null,
          movedAt: (row.moved_at as number | null) ?? null,
          updatedAt: row.updated_at as number,
        };
        hits.push(hit);
      }
    }
    if (scope !== "cards") {
      const rows = this.stmt(
        `select t.id, t.conversation_id, t.at, t.role, t.via, t.text, v.profile_key, v.kind,
           snippet(turns_fts, 0, '[', ']', '…', 16) as snip
         from turns_fts join turns t on t.id = turns_fts.rowid join conversations v on v.id = t.conversation_id
         where turns_fts match ? and (? is null or v.profile_key = ?)
         order by bm25(turns_fts), t.at desc limit ?`,
      ).all(match, profileKey, profileKey, cap) as Row[];
      for (const row of rows) {
        const hit: TurnHit = {
          kind: "turn",
          id: row.id as number,
          conversationId: row.conversation_id as string,
          conversationKind: row.kind as ConversationKind,
          profileKey: row.profile_key as string,
          role: row.role as TurnRole,
          via: row.via as TurnVia,
          at: row.at as number,
          snippet: row.snip as string,
          text: (row.text as string).slice(0, HIT_TEXT_MAX),
        };
        hits.push(hit);
      }
    }
    return hits;
  }

  // -------------------------------------------------------------------------
  // Export and import
  // -------------------------------------------------------------------------

  /**
   * Everything the database can be rebuilt from, as the mirror writes it.
   * Agents' conversations stay behind unless asked: an agent's reply can
   * quote a file that holds a secret, and the mirror leaves the machine.
   */
  exportAll(options: { agents?: boolean } = {}): DataExport {
    const boards: BoardExport[] = [];
    const boardRows = this.stmt(
      "select b.*, p.name as profile_name, p.login_key, w.name as workspace_name from boards b join profiles p on p.key = b.profile_key left join workspaces w on w.key = b.workspace_key order by p.name, w.name",
    ).all() as Row[];
    for (const row of boardRows) {
      const boardId = row.id as string;
      const lanes = this.stmt("select id, name, color, collapsed from lanes where board_id = ? order by position").all(boardId) as Row[];
      const cardRows = this.stmt("select * from cards where board_id = ? order by number").all(boardId) as unknown as CardRow[];
      const cards: CardExport[] = cardRows.map((card) => ({
        id: card.id,
        number: card.number,
        title: card.title,
        body: card.body,
        column: card.column_id,
        position: card.position,
        isolate: card.isolate === 1,
        dates: card.date_start && card.date_end ? { start: card.date_start, end: card.date_end } : null,
        worktree: card.wt_root && card.wt_path && card.wt_branch && card.wt_base ? { root: card.wt_root, path: card.wt_path, branch: card.wt_branch, base: card.wt_base } : null,
        createdAt: card.created_at,
        updatedAt: card.updated_at,
        deletedAt: card.deleted_at,
        runs: (this.stmt("select * from card_runs where card_id = ? order by started_at, id").all(card.id) as unknown as RunRow[]).map((run) => ({
          launcher: run.launcher,
          label: run.label,
          state: run.state,
          startedAt: run.started_at,
          endedAt: run.ended_at,
          sessionId: run.session_id,
          cwd: run.cwd,
        })),
        events: this.cardHistory(card.id).map(({ at, actor, kind, fromColumn, toColumn, detail }) => ({ at, actor, kind, fromColumn, toColumn, detail })),
      }));
      boards.push({
        version: EXPORT_VERSION,
        profile: { key: row.profile_key as string, name: row.profile_name as string, loginKey: (row.login_key as string | null) ?? null },
        workspace: row.workspace_key ? { key: row.workspace_key as string, name: (row.workspace_name as string | null) ?? "" } : null,
        board: {
          id: boardId,
          next: row.next as number,
          columns: lanes.length ? lanes.map((lane) => ({ id: lane.id as string, name: lane.name as string, color: (lane.color as BoardLane["color"]) ?? null, ...(lane.collapsed === 1 ? { collapsed: true as const } : {}) })) : null,
          createdAt: row.created_at as number,
        },
        cards,
      });
    }
    const conversations: DataExport["conversations"] = [];
    const convRows = this.stmt(
      "select v.*, p.name as profile_name from conversations v join profiles p on p.key = v.profile_key where (? = 1 or v.kind = 'harness') order by v.started_at",
    ).all(options.agents ? 1 : 0) as Row[];
    for (const row of convRows) {
      const turns = (this.stmt("select * from turns where conversation_id = ? order by at, id").all(row.id as string) as Row[]).map(turnOf);
      conversations.push({
        header: { version: EXPORT_VERSION, ...conversationOf(row), profileName: row.profile_name as string },
        turns: turns.map(({ id: _id, conversationId: _c, ...rest }) => rest),
      });
    }
    return { boards, conversations };
  }

  /**
   * The mirror read back, for `bun run restore`. Every row as it was
   * written, events and runs and deleted cards included; a row already here
   * is left alone, so running it twice adds nothing twice.
   */
  importExport(data: DataExport, at = Date.now()): ImportCounts {
    const counts: ImportCounts = { profiles: 0, workspaces: 0, boards: 0, cards: 0, turns: 0, outbox: 0, missed: 0 };
    this.tx(() => {
      for (const file of data.boards) {
        if (!this.has("profiles", file.profile.key)) {
          this.stmt("insert into profiles(key, name, login_key, created_at, gone_at) values (?, ?, ?, ?, null)").run(file.profile.key, file.profile.name, file.profile.loginKey, at);
          counts.profiles++;
        }
        if (file.workspace && !this.has("workspaces", file.workspace.key)) {
          this.stmt("insert into workspaces(key, profile_key, name, created_at, gone_at) values (?, ?, ?, ?, null)").run(file.workspace.key, file.profile.key, file.workspace.name, at);
          counts.workspaces++;
        }
        const workspaceKey = file.workspace?.key ?? null;
        let boardId = this.boardId(file.profile.key, workspaceKey);
        if (!boardId) {
          boardId = file.board.id;
          this.stmt("insert or ignore into boards(id, profile_key, workspace_key, next, created_at) values (?, ?, ?, ?, ?)").run(boardId, file.profile.key, workspaceKey, file.board.next, file.board.createdAt);
          this.writeLanes(boardId, file.board.columns);
          counts.boards++;
        }
        for (const card of file.cards) {
          if (this.stmt("select 1 as x from cards where id = ?").get(card.id) !== undefined) continue;
          this.stmt(
            `insert into cards(id, board_id, number, title, body, column_id, position, isolate, date_start, date_end, wt_root, wt_path, wt_branch, wt_base, dev_port, dev_agent_id, created_at, updated_at, deleted_at)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, ?, ?, ?)`,
          ).run(
            card.id,
            boardId,
            card.number,
            card.title,
            card.body,
            card.column,
            card.position,
            card.isolate ? 1 : 0,
            card.dates?.start ?? null,
            card.dates?.end ?? null,
            card.worktree?.root ?? null,
            card.worktree?.path ?? null,
            card.worktree?.branch ?? null,
            card.worktree?.base ?? null,
            card.createdAt,
            card.updatedAt,
            card.deletedAt,
          );
          for (const run of card.runs) {
            this.stmt("insert into card_runs(card_id, launcher, label, state, started_at, ended_at, session_id, cwd, agent_id) values (?, ?, ?, ?, ?, ?, ?, ?, null)").run(
              card.id,
              run.launcher,
              run.label,
              run.state,
              run.startedAt,
              run.endedAt,
              run.sessionId,
              run.cwd,
            );
          }
          for (const event of card.events) this.event(boardId, { ...event, cardId: card.id });
          counts.cards++;
        }
      }
      for (const { header, turns } of data.conversations) {
        this.stmt("insert or ignore into conversations(id, profile_key, kind, launcher, cwd, started_at) values (?, ?, ?, ?, ?, ?)").run(
          header.id,
          header.profileKey,
          header.kind,
          header.launcher,
          header.cwd,
          header.startedAt,
        );
        for (const turn of turns) {
          const dup = this.stmt("select 1 as x from turns where conversation_id = ? and at = ? and role = ? and text = ?").get(header.id, turn.at, turn.role, turn.text);
          if (dup) continue;
          this.stmt("insert into turns(conversation_id, at, role, via, text, lang, voice_id) values (?, ?, ?, ?, ?, ?, ?)").run(header.id, turn.at, turn.role, turn.via, turn.text, turn.lang, turn.voiceId);
          counts.turns++;
        }
      }
    });
    return counts;
  }

  // -------------------------------------------------------------------------
  // For the backup
  // -------------------------------------------------------------------------

  /** Where the history stands, to count what a backup carries next time. */
  marks(): { events: number; turns: number } {
    const e = this.stmt("select coalesce(max(id), 0) as n from card_events").get() as Row;
    const t = this.stmt("select coalesce(max(id), 0) as n from turns").get() as Row;
    return { events: e.n as number, turns: t.n as number };
  }

  changesSince(mark: { events: number; turns: number }): { cards: number; turns: number } {
    const e = this.stmt("select count(distinct card_id) as n from card_events where id > ?").get(mark.events) as Row;
    const t = this.stmt("select count(*) as n from turns where id > ? and conversation_id in (select id from conversations where kind = 'harness')").get(mark.turns) as Row;
    return { cards: e.n as number, turns: t.n as number };
  }

  /**
   * A copy of the whole file, made with SQLite's own online backup so a
   * write mid-copy cannot leave it torn. One per day beside the database,
   * the newest `COPIES_KEPT` kept: the mirror in git is the real backup,
   * and this is for the day the mirror is what went wrong.
   */
  async copyDaily(at = Date.now()): Promise<string | null> {
    const dir = join(dataDir(), "db-copies");
    const day = new Date(at).toISOString().slice(0, 10);
    const target = join(dir, `kururu-${day}.db`);
    if (existsSync(target)) return null;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    await backup(this.db, target);
    const old = readdirSync(dir)
      .filter((name) => /^kururu-\d{4}-\d{2}-\d{2}\.db$/.test(name))
      .sort()
      .slice(0, -COPIES_KEPT);
    for (const name of old) rmSync(join(dir, name), { force: true });
    return target;
  }
}

function turnOf(row: Row): Turn {
  return {
    id: row.id as number,
    conversationId: row.conversation_id as string,
    at: row.at as number,
    role: row.role as TurnRole,
    via: row.via as TurnVia,
    text: row.text as string,
    lang: (row.lang as VoiceLang | null) ?? null,
    voiceId: (row.voice_id as string | null) ?? null,
  };
}

function conversationOf(row: Row): Conversation {
  return {
    id: row.id as string,
    profileKey: row.profile_key as string,
    kind: row.kind as ConversationKind,
    launcher: (row.launcher as string | null) ?? null,
    cwd: (row.cwd as string | null) ?? null,
    startedAt: row.started_at as number,
  };
}

export { mintProfileKey, mintWorkspaceKey };
