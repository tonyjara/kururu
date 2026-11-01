/**
 * Keeping the ledger up with the logs: nudged by the hook, swept slowly
 * otherwise, and in no hurry at all the first time.
 *
 * Every turn of every Claude agent kururu started already posts `/api/report`
 * with its transcript's path, so that report is the nudge to tail one file from
 * its offset. The sweep catches what has no hook: a `claude` typed into a shell,
 * a session that ended, a file pruned. A `readdir` and a `stat` of about a
 * thousand files, every few minutes, off the thread pool.
 *
 * The first sweep after a fresh ledger is the backfill, and it is the same code,
 * since a file with no offset is simply a file with everything left to read. The
 * order is what makes it safe to be slow: the machine's `~/.claude` first, which
 * the next `claude` started there would prune all at once, then newest-first so
 * that this week's picture appears within seconds. A restart mid-way carries on
 * from the offsets, which were written in the same transactions as their rows.
 *
 * **Zero model tokens, by construction.** Nothing here types into a pty, calls a
 * tool or tells Kuru anything. A tool's description would sit in the cached
 * prefix of every turn, and the user has not asked Kuru about spending.
 *
 * Attribution is read from the database through a function the server lends,
 * and only `store.ts` touches that file; the other direction, nothing, ever.
 * Transcripts are opened read-only and nothing is ever written beside them.
 */
import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { basename, dirname, join, normalize } from "node:path";
import { HARNESS_TITLE, HARNESS_TITLE_HEAD, noFacts, type AttributionFacts, type LedgerStatus, type UsageSource } from "../../../shared/usage";
import { CLAUDE_NEEDLES, claudeRoots, parseClaudeLine, placeOf, type ClaudeRoot } from "./claude";
import { Ledger, LedgerBatch, ledgerPath, type FileRow } from "./store";
import { halfDuty, tailFile, type TailOptions } from "./tail";

const NEEDLES = CLAUDE_NEEDLES.map((needle) => Buffer.from(needle));
const TITLE = Buffer.from(HARNESS_TITLE);

/** How often the logs are walked when nothing has asked. */
export const SWEEP_MS = 5 * 60_000;
/** Long enough for a window to come up and the server's own start-up reads to finish. */
export const START_DELAY_MS = 5_000;
/** How long a burst of reports from one turn is waited out. */
const NUDGE_MS = 1_500;
/** A transaction's worth, whose flush is a few milliseconds. */
const FLUSH_ROWS = 1_000;
const FLUSH_MS = 500;
/** How long the database's facts are believed before being read again. */
const FACTS_MS = 30_000;
/** Reports name a file each; a storm of them is one pass over a set no larger than this. */
const MAX_NUDGED = 256;

export interface ReaderDeps {
  ledger: Ledger;
  /** What kururu's database knows about sessions, read fresh. May throw; the old facts stand. */
  facts: () => AttributionFacts;
  roots?: () => Promise<ClaudeRoot[]>;
  sweepMs?: number;
  tail?: TailOptions;
  log?: (line: string) => void;
}

interface Listed {
  path: string;
  root: ClaudeRoot;
  size: number;
  mtime: number;
  inode: number;
}

export class UsageReader {
  /** Lent to `attribute.ts`, which writes launches into the same file on the same connection. */
  readonly ledger: Ledger;
  private batch = new LedgerBatch();
  private factsHeld: AttributionFacts = noFacts();
  private factsAt = 0;
  private lastFlush = Date.now();
  private readonly nudged = new Set<string>();
  private sweepOwed = false;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private reading: LedgerStatus["reading"] = null;
  private sweptAt: number | null = null;
  private firstPass: LedgerStatus["firstPass"] = null;
  private error: string | null = null;
  private countsAt = 0;
  private countsHeld: ReturnType<Ledger["counts"]> | null = null;

  constructor(private readonly deps: ReaderDeps) {
    this.ledger = deps.ledger;
  }

  /** Begin: a first sweep after a moment, and one every few minutes after that. */
  start(delayMs = START_DELAY_MS): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.sweepSoon();
    }, delayMs);
    this.timer.unref?.();
    this.interval = setInterval(() => this.sweepSoon(), this.deps.sweepMs ?? SWEEP_MS);
    this.interval.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.interval) clearInterval(this.interval);
  }

  sweepSoon(): void {
    this.sweepOwed = true;
    this.pump();
  }

  /**
   * A hook said this transcript moved. Only held here; `settle` checks it against
   * the roots before anything is opened, since the path came over a socket.
   */
  nudge(path: unknown): void {
    if (typeof path !== "string" || this.stopped || !path.startsWith("/") || !path.endsWith(".jsonl")) return;
    if (this.nudged.size >= MAX_NUDGED) return;
    this.nudged.add(path);
    if (this.timer || this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, NUDGE_MS);
    this.timer.unref?.();
  }

  /** Whatever is under way, finished. For tests, and for a pass somebody is waiting on. */
  async settled(): Promise<void> {
    while (this.running) await this.running;
  }

  status(): LedgerStatus {
    if (!this.countsHeld || Date.now() - this.countsAt > 2_000) {
      try {
        this.countsHeld = this.ledger.counts();
        this.countsAt = Date.now();
      } catch (err) {
        this.error = String(err);
      }
    }
    const counts = this.countsHeld ?? { messages: 0, sessions: 0, files: 0, bytes: 0, oldestDay: null, newestDay: null, skipped: 0, unpriced: 0 };
    return { ...counts, reading: this.reading, sweptAt: this.sweptAt, firstPass: this.firstPass, error: this.error };
  }

  private pump(): void {
    if (this.running || this.stopped) return;
    this.running = this.work()
      .catch((err) => {
        // A busy database or a full disk: nothing read so far is written, the
        // offsets are where they were, and the next pass reads it again.
        this.batch = new LedgerBatch();
        this.reading = null;
        this.error = err instanceof Error ? err.message : String(err);
        this.deps.log?.(`kururu: the usage ledger stopped a pass: ${this.error}`);
      })
      .finally(() => {
        this.running = null;
        // A nudge that landed as the loop was ending found it still running and left this to it.
        if (this.nudged.size || this.sweepOwed) this.pump();
      });
  }

  private async work(): Promise<void> {
    while ((this.sweepOwed || this.nudged.size) && !this.stopped) {
      if (this.sweepOwed) {
        this.sweepOwed = false;
        await this.sweep();
      } else {
        await this.serveNudges();
        this.flush();
      }
      this.error = null;
    }
  }

  private facts(): AttributionFacts {
    if (Date.now() - this.factsAt > FACTS_MS) {
      this.factsAt = Date.now();
      try {
        this.factsHeld = this.deps.facts();
      } catch (err) {
        // Attribution is the part that can be put right later; `reattribute` does.
        this.deps.log?.(`kururu: the usage ledger could not read attribution: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return this.factsHeld;
  }

  private flush(): void {
    this.ledger.flush(this.batch, this.facts());
    this.batch = new LedgerBatch();
    this.lastFlush = Date.now();
    this.countsAt = 0;
  }

  private flushIfDue(): void {
    if (this.batch.size >= FLUSH_ROWS || Date.now() - this.lastFlush > FLUSH_MS) this.flush();
  }

  private async sweep(): Promise<void> {
    const began = Date.now();
    const roots = await (this.deps.roots ?? claudeRoots)();
    const listed: Listed[] = [];
    const missing: string[] = [];
    for (const root of roots) {
      const projects = join(root.dir, "projects");
      const files = await walk(projects, root);
      if (files === null) continue;
      // Newest first within a root, and the roots in the order they were given.
      files.sort((a, b) => b.mtime - a.mtime);
      listed.push(...files);
      const present = new Set(files.map((file) => file.path));
      for (const path of this.ledger.filesUnder(projects)) if (!present.has(path)) missing.push(path);
    }
    // Forgetting an offset takes no message with it. What the file said is what the ledger is for.
    this.ledger.forget(missing);

    const work: Listed[] = [];
    let totalBytes = 0;
    for (const file of listed) {
      const known = this.ledger.file(file.path);
      if (known && known.inode === file.inode && known.size === file.size) continue;
      work.push(file);
      totalBytes += file.size - (known && known.inode === file.inode ? Math.min(known.offset, file.size) : 0);
    }
    const progress = { doneBytes: 0, totalBytes, files: work.length };
    if (work.length) this.reading = progress;
    for (const file of work) {
      if (this.stopped) break;
      await this.tail(file.path, file.root, (read) => {
        progress.doneBytes += read;
      });
      this.flushIfDue();
      // Today keeps up while the past is read.
      if (this.nudged.size) await this.serveNudges();
    }
    this.flush();
    this.reading = null;
    this.factsAt = 0;
    this.ledger.reattribute(this.facts());
    this.countsAt = 0;
    this.sweptAt = Date.now();
    if (!this.firstPass && !this.stopped) {
      this.firstPass = { ms: Date.now() - began, bytes: progress.doneBytes, files: work.length };
      if (work.length) {
        this.deps.log?.(`kururu: the usage ledger read ${work.length} file(s), ${Math.round(progress.doneBytes / 1e6)} MB, in ${((Date.now() - began) / 1000).toFixed(1)} s`);
      }
    }
  }

  /** What the hooks named, each only if it is a transcript under a root, and the subagents' files beside it. */
  private async serveNudges(): Promise<void> {
    const paths = [...this.nudged];
    this.nudged.clear();
    if (!paths.length) return;
    const roots = await (this.deps.roots ?? claudeRoots)();
    for (const path of paths) {
      if (normalize(path) !== path) continue;
      const root = roots.find((each) => placeOf(path, each));
      if (!root) continue;
      // `lstat`: a link under `projects/` is not a transcript, wherever it points.
      const info = await lstat(path).catch(() => null);
      if (!info?.isFile()) continue;
      await this.tail(path, root);
      const sessionDir = join(dirname(path), basename(path, ".jsonl"));
      for (const file of (await walk(sessionDir, root)) ?? []) await this.tail(file.path, root);
      this.flushIfDue();
    }
  }

  private async tail(path: string, root: ClaudeRoot, onRead?: (bytes: number) => void): Promise<void> {
    const place = placeOf(path, root);
    if (!place) return;
    const known = this.batch.files.get(path) ?? this.ledger.file(path);
    let titled = false;
    let row = null as FileRow | null;
    let finalSize = 0;
    const result = await tailFile(
      path,
      known,
      NEEDLES,
      {
        begin: (info) => {
          finalSize = info.size;
          row = {
            path,
            program: "claude",
            loginDir: root.dir,
            inode: info.inode,
            // `size` says how far a finished read got, and is what makes a file
            // "unchanged" to the next sweep. Until this read finishes it is the
            // offset: a flush mid-file followed by a restart must leave the rest
            // still owed, and a full size beside a partial offset said it was not.
            size: info.offset,
            offset: info.offset,
            mtime: Math.trunc(info.mtime),
            sessionId: known?.sessionId ?? null,
          };
          if (known && known.inode === info.inode && known.size === info.size && !info.fresh) return false;
          this.batch.files.set(path, row);
          return true;
        },
        head: (bytes) => {
          titled = bytes.subarray(0, HARNESS_TITLE_HEAD).includes(TITLE);
        },
        line: (text, at) => this.line(text, at, path, root, place, titled, row),
        skip: (at, why) => this.batch.skipped.push({ path, atByte: at, why }),
        advanced: (offset, read) => {
          row!.offset = offset;
          row!.size = offset;
          onRead?.(read);
          // Mid-file too: a long transcript is not one transaction.
          if (this.batch.size >= FLUSH_ROWS) this.flush();
          this.batch.files.set(path, row!);
        },
      },
      this.deps.tail ?? { pause: halfDuty },
    );
    if (result === "gone") {
      this.batch.files.delete(path);
      if (known) this.ledger.forget([path]);
    } else if (result === "read" && row) {
      // All read but any half-written last line, which waits for the file to grow.
      row.size = Math.max(finalSize, row.offset);
      this.batch.files.set(path, row);
    }
  }

  private line(text: string, at: number, path: string, root: ClaudeRoot, place: { projectDir: string; source: UsageSource }, titled: boolean, row: FileRow | null): void {
    const parsed = parseClaudeLine(text, place.source);
    if (parsed.kind === "skip") {
      this.batch.skipped.push({ path, atByte: at, why: parsed.why });
      return;
    }
    if (parsed.kind === "totals") {
      for (const each of parsed.rows) this.batch.addTotals(each);
      return;
    }
    if (parsed.kind !== "message") return;
    const message = parsed.row;
    if (row && !row.sessionId) row.sessionId = message.sessionId;
    this.batch.addMessage(message);
    // The file's folder under its session is its parent, in the rare case a subagent's records name a session of their own.
    const parent = place.source === "subagent" ? parentOfSubagent(path, place.projectDir) : null;
    this.batch.addSession({
      id: message.sessionId,
      program: "claude",
      loginDir: root.dir,
      cwd: parsed.cwd,
      version: parsed.version,
      firstAt: message.at,
      lastAt: message.at,
      parentSession: parent && parent !== message.sessionId ? parent : null,
      seen: { projectDir: place.projectDir, titled, loginKey: root.loginKey },
    });
  }
}

function parentOfSubagent(path: string, projectDir: string): string | null {
  const parts = path.split("/");
  const at = parts.lastIndexOf(projectDir);
  return at === -1 ? null : (parts[at + 1] ?? null);
}

/**
 * Every transcript under a directory, or null when the directory is not there
 * to walk, which must not read as every file having gone. Links are not
 * followed, and a directory that vanishes mid-walk is simply not listed.
 */
async function walk(dir: string, root: ClaudeRoot): Promise<Listed[] | null> {
  const top = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!top) return null;
  const out: Listed[] = [];
  const visit = async (at: string, entries: Dirent[]): Promise<void> => {
    for (const entry of entries) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        await visit(path, await readdir(path, { withFileTypes: true }).catch(() => []));
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const info = await lstat(path).catch(() => null);
        if (info?.isFile()) out.push({ path, root, size: info.size, mtime: info.mtimeMs, inode: info.ino });
      }
    }
  };
  await visit(dir, top);
  return out;
}

/**
 * The ledger and its reader, or null when the file will not open. The server
 * carries on either way, and a ledger that will not open says why in the log;
 * `/api/health` has nothing to say about a ledger that is not there.
 */
export function openUsageReader(facts: () => AttributionFacts, log: (line: string) => void): UsageReader | null {
  try {
    return new UsageReader({ ledger: Ledger.open(), facts, log });
  } catch (err) {
    log(`kururu: the usage ledger at ${ledgerPath()} could not be opened, so nothing is being recorded: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
