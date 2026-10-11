/**
 * Backups: the mirror into a git repository of kururu's own, pushed to a
 * private one the user gave it. The one other file that runs `git`, and
 * only ever on this repository — see `gitcmd.ts`.
 *
 * Every `intervalMin` minutes, if anything changed: write the mirror
 * (`export.ts`), stage it, commit if the stage is not empty, push. A push
 * that fails keeps the commit and tries again next time, and the page says
 * why it failed. Nothing is ever forced and no history is rewritten: a push
 * the remote refuses as not a fast-forward means another machine has been
 * writing the same repository, and which copy wins is the user's call, so
 * the run stops and says so.
 *
 * "Changed" is three cheap looks: the store's own counter of writes, the
 * mtimes and sizes of the config files and folders that go, and those of
 * the memory folders, which Claude Code writes and the server cannot hear.
 * A quiet interval costs a few stats and no git.
 *
 * The remote is checked when it is set — `ls-remote`, in batch mode, no
 * prompt — and the settings are not taken until it answers, because a
 * switch turned on against a repository nobody can push to would fail
 * quietly every five minutes, which is the one way a backup can be worse
 * than none.
 */
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  adoptBackupSettings,
  BACKUP_INTERVAL_MIN,
  commitSubject,
  CONFIG_DIRS,
  CONFIG_FILES,
  validRepoUrl,
  type BackupSettings,
  type BackupStatus,
} from "../../shared/backup";
import { isLoginKey } from "../../shared/model";
import type { ServerMessage } from "../../shared/wire";
import { readConfigFile, writeConfigFile } from "./config";
import { writeMirror } from "./export";
import { git } from "./gitcmd";
import type { Store } from "./store";

const FILE = "backup.json";
/** A push over a slow link; past this it is a push that is not going to happen. */
const PUSH_TIMEOUT_MS = 90_000;
/** The first look after a start: soon, since a restart under `bun run dev` is every save and the interval would never come. */
const FIRST_LOOK_MS = 60_000;

export interface BackupDeps {
  store: Store;
  broadcast: (msg: ServerMessage) => void;
  configDir: () => string;
  stateDir: () => string;
  dataDir: () => string;
}

export class Backup {
  private settings: BackupSettings;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<BackupStatus> | null = null;
  private lastRunAt: number | null = null;
  private lastCommit: string | null = null;
  private lastCommitAt: number | null = null;
  private lastPushAt: number | null = null;
  private error: string | null = null;
  private unpushed = 0;
  /** What the last run saw, to tell whether anything changed since. */
  private seen: { changes: number; files: string } | null = null;
  private marks: { events: number; turns: number };

  constructor(private readonly deps: BackupDeps) {
    this.settings = adoptBackupSettings(readConfigFile(FILE));
    this.marks = deps.store.marks();
    this.schedule();
  }

  /** Where the mirror and its `.git` live. */
  dir(): string {
    return join(this.deps.dataDir(), "backup");
  }

  status(): BackupStatus {
    return {
      settings: this.settings,
      dir: this.dir(),
      running: this.running !== null,
      pending: this.dirty(),
      lastRunAt: this.lastRunAt,
      lastCommit: this.lastCommit,
      lastCommitAt: this.lastCommitAt,
      lastPushAt: this.lastPushAt,
      error: this.error,
      unpushed: this.unpushed,
    };
  }

  message(): ServerMessage {
    return { type: "backup", backup: this.status() };
  }

  private tell(): void {
    this.deps.broadcast(this.message());
  }

  /**
   * Take settings from a client. A new or newly enabled remote is asked to
   * answer first; one that does not is the reply's error and nothing
   * changes.
   */
  async set(value: { url: unknown; enabled: unknown; intervalMin: unknown }): Promise<BackupStatus> {
    const next = adoptBackupSettings(value);
    if (value.url !== null && value.url !== "" && !validRepoUrl(value.url)) throw new Error("That is not a git URL: use git@github.com:you/repo.git, https://…, or an absolute path.");
    if (next.url && (next.url !== this.settings.url || (next.enabled && !this.settings.enabled))) {
      await git(["ls-remote", "--heads", next.url], this.deps.dataDir(), { batch: true }).catch((err: Error) => {
        throw new Error(`The repository did not answer: ${err.message.replace(/^git: /, "")}`);
      });
    }
    this.settings = next;
    writeConfigFile(FILE, this.settings);
    this.error = null;
    this.schedule();
    this.tell();
    return this.status();
  }

  private schedule(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.settings.enabled) return;
    const every = Math.max(BACKUP_INTERVAL_MIN, this.settings.intervalMin) * 60_000;
    this.timer = setInterval(() => void this.tick(), every);
    this.timer.unref();
    setTimeout(() => void this.tick(), FIRST_LOOK_MS).unref();
  }

  private async tick(): Promise<void> {
    if (!this.settings.enabled || !this.dirty()) return;
    await this.run().catch(() => undefined);
  }

  /** Whether anything that goes into the mirror has changed since the last run. */
  private dirty(): boolean {
    if (!this.seen) return true;
    return this.seen.changes !== this.deps.store.changes || this.seen.files !== this.fingerprint();
  }

  /**
   * The config files, the two directories, the memory folders and the
   * arrangement, as mtimes and sizes: enough to notice a save, cheap enough
   * to do every interval.
   */
  private fingerprint(): string {
    const parts: string[] = [];
    const stamp = (path: string): void => {
      try {
        const info = statSync(path);
        parts.push(`${path}:${info.mtimeMs}:${info.size}`);
      } catch {
        // Not there is a state too.
      }
    };
    const config = this.deps.configDir();
    for (const name of CONFIG_FILES) stamp(join(config, name));
    for (const name of CONFIG_DIRS) stampTree(join(config, name), stamp);
    const profiles = join(config, "profiles");
    for (const key of listDir(profiles).filter(isLoginKey)) {
      stamp(join(profiles, key, "claude", "settings.json"));
      const projects = join(profiles, key, "claude", "projects");
      for (const project of listDir(projects)) stampTree(join(projects, project, "memory"), stamp);
    }
    stamp(join(this.deps.stateDir(), "session.json"));
    return parts.join("\n");
  }

  /** Back up now, changed or not. One at a time: a second ask while one runs gets the same run. */
  run(): Promise<BackupStatus> {
    if (this.running) return this.running;
    this.running = this.once().finally(() => {
      this.running = null;
      this.tell();
    });
    this.tell();
    return this.running;
  }

  private async once(): Promise<BackupStatus> {
    const at = Date.now();
    this.lastRunAt = at;
    try {
      if (!this.settings.url) throw new Error("No repository is set.");
      const dir = this.dir();
      await this.prepare(dir, this.settings.url);
      const changes = this.deps.store.changesSince(this.marks);
      const written = writeMirror(dir, { store: this.deps.store, configDir: this.deps.configDir(), stateDir: this.deps.stateDir() });
      await git(["add", "-A"], dir);
      const staged = (await git(["status", "--porcelain"], dir)).trim();
      if (staged) {
        const subject = commitSubject(at, { cards: changes.cards, turns: changes.turns, files: written.changed });
        await git([...(await this.identity(dir)), "commit", "-q", "-m", subject], dir);
        this.lastCommit = subject;
        this.lastCommitAt = at;
        this.marks = this.deps.store.marks();
      }
      this.seen = { changes: this.deps.store.changes, files: this.fingerprint() };
      await this.push(dir);
      this.error = null;
      void this.deps.store.copyDaily(at).catch(() => undefined);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    }
    return this.status();
  }

  /** A repository under `dir` with `origin` at `url`, made or re-pointed. */
  private async prepare(dir: string, url: string): Promise<void> {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!existsSync(join(dir, ".git"))) {
      await git(["init", "-q", "-b", "main"], dir);
    }
    const remotes = (await git(["remote"], dir)).split("\n").map((line) => line.trim());
    if (!remotes.includes("origin")) await git(["remote", "add", "origin", url], dir);
    else if ((await git(["remote", "get-url", "origin"], dir)).trim() !== url) await git(["remote", "set-url", "origin", url], dir);
  }

  /** The user's own git identity when they have one; kururu's when the commit would otherwise be refused. */
  private async identity(dir: string): Promise<string[]> {
    const email = await git(["config", "--get", "user.email"], dir).catch(() => "");
    return email.trim() ? [] : ["-c", "user.name=kururu", "-c", "user.email=kururu@localhost"];
  }

  /**
   * Push what is committed. Not a fast-forward is a stop, not a force: the
   * remote has history this machine has not, and merging two machines'
   * backups is not a thing to do unasked.
   */
  private async push(dir: string): Promise<void> {
    const head = (await git(["rev-parse", "--verify", "-q", "HEAD"], dir).catch(() => "")).trim();
    if (!head) {
      this.unpushed = 0;
      return;
    }
    try {
      await git(["push", "-q", "origin", "HEAD:main"], dir, { batch: true, timeout: PUSH_TIMEOUT_MS });
      this.lastPushAt = Date.now();
      this.unpushed = 0;
    } catch (err) {
      const said = err instanceof Error ? err.message : String(err);
      this.unpushed = await this.countUnpushed(dir);
      if (/rejected|non-fast-forward|fetch first/i.test(said)) {
        throw new Error(`The repository has commits this Mac does not; nothing was forced. Another machine may be backing up to it. ${said}`);
      }
      throw new Error(`The push failed and will be tried again: ${said}`);
    }
  }

  private async countUnpushed(dir: string): Promise<number> {
    const count = await git(["rev-list", "--count", "origin/main..HEAD"], dir).catch(() => "");
    const n = Number(count.trim());
    return Number.isFinite(n) && n > 0 ? n : 1;
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function stampTree(root: string, stamp: (path: string) => void): void {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(root, name);
    stamp(path);
    try {
      if (statSync(path).isDirectory()) stampTree(path, stamp);
    } catch {
      // Gone between the readdir and the stat.
    }
  }
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
