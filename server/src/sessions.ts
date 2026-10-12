/**
 * The CLIs' session files on this disk: finding the Codex rollout that is a
 * card's, and reading the end of any conversation kururu has an id for.
 *
 * `shared/sessions.ts` argues for reading them at all and holds the parsing;
 * this is the reading. Every read is bounded — a head of a rollout, a tail of
 * a transcript — because a long session's file runs to tens of megabytes and
 * this runs on the server's own loop. Nothing here writes, and nothing takes
 * a path from a client: a directory is the profile's own config directory or
 * the machine's, and a file name is a UUID `SESSION_ID` has passed.
 */
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { SESSION_ID } from "../../shared/board";
import { claudeProjectDir, codexRolloutHead, pickCodexRollout, type CodexRollout, type RunLooking } from "../../shared/sessions";

/** Enough of a rollout's head to reach its first user message, which sits under fifty kilobytes of instructions. */
const HEAD_BYTES = 512 * 1024;
/** Enough of a conversation's tail to hold its last turn whole, tool output and all, more often than not. */
export const TAIL_BYTES = 384 * 1024;
/** The most rollouts read per look, newest first: a day of Codex in one directory is not a reason to read a hundred heads. */
const HEADS_MAX = 40;

/** Bytes of a file from `start`, as text. Null when it cannot be read. */
async function readSpan(path: string, start: number | "tail", bytes: number): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, "r");
    const size = (await handle.stat()).size;
    const from = start === "tail" ? Math.max(0, size - bytes) : start;
    const length = Math.min(bytes, Math.max(0, size - from));
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, from);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** The end of a file, as text — what a last reply is read out of. */
export function readTail(path: string): Promise<string | null> {
  return readSpan(path, "tail", TAIL_BYTES);
}

/** `YYYY/MM/DD` for each local day from `since` to `until`, newest first, as Codex names its directories. */
function dayDirs(since: number, until: number): string[] {
  const out: string[] = [];
  const day = new Date(since);
  day.setHours(0, 0, 0, 0);
  for (let i = 0; i < 31 && day.getTime() <= until; i++) {
    const pad = (n: number) => String(n).padStart(2, "0");
    out.unshift(`${day.getFullYear()}/${pad(day.getMonth() + 1)}/${pad(day.getDate())}`);
    day.setDate(day.getDate() + 1);
  }
  return out;
}

/** The rollouts in `home` touched since `since`, newest first, each read down to its first user message. */
async function rolloutsSince(home: string, since: number, now: number): Promise<{ rollout: CodexRollout; path: string }[]> {
  const found: { path: string; mtime: number }[] = [];
  for (const day of dayDirs(since - 24 * 3600_000, now)) {
    const dir = join(home, "sessions", day);
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
      const info = await stat(join(dir, name)).catch(() => null);
      if (info && info.mtimeMs >= since - 60_000) found.push({ path: join(dir, name), mtime: info.mtimeMs });
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  const out: { rollout: CodexRollout; path: string }[] = [];
  for (const { path } of found.slice(0, HEADS_MAX)) {
    const head = await readSpan(path, 0, HEAD_BYTES);
    if (!head) continue;
    const lines = head.split("\n");
    const rollout = codexRolloutHead(lines[0] ?? "", lines.find((line) => line.includes('"type":"user_message"')) ?? null);
    if (rollout) out.push({ rollout, path });
  }
  return out;
}

/** The rollout in `home` that is this run's — see `pickCodexRollout` — and where it is. */
export async function findCodexRollout(home: string, run: RunLooking, taken: ReadonlySet<string>, now = Date.now()): Promise<{ id: string; path: string } | null> {
  const all = await rolloutsSince(home, run.startedAt, now);
  const picked = pickCodexRollout(
    all.map((a) => a.rollout),
    run,
    taken,
  );
  const hit = picked ? all.find((a) => a.rollout.id === picked.id) : undefined;
  return hit ? { id: hit.rollout.id, path: hit.path } : null;
}

/** Where a Codex conversation is on disk, by its id: its file name ends with it. */
export async function codexRolloutPath(home: string, id: string, since: number, now = Date.now()): Promise<string | null> {
  if (!SESSION_ID.test(id)) return null;
  for (const day of dayDirs(since - 24 * 3600_000, now)) {
    const dir = join(home, "sessions", day);
    const names = await readdir(dir).catch(() => [] as string[]);
    const name = names.find((n) => n.startsWith("rollout-") && n.endsWith(`-${id}.jsonl`));
    if (name) return join(dir, name);
  }
  return null;
}

/**
 * Where a Claude Code conversation is on disk, by its id: under the
 * directory Claude Code names after the cwd, or — for a path it shortened,
 * or a cwd kururu did not keep — under whichever project directory has it.
 * `hint` is the path the session's own hooks reported, believed first.
 */
export async function claudeTranscriptPath(configDir: string, id: string, cwd: string | null, hint: string | null): Promise<string | null> {
  if (!SESSION_ID.test(id)) return null;
  const file = `${id}.jsonl`;
  const exists = async (path: string) => (await stat(path).catch(() => null))?.isFile() === true;
  if (hint && hint.endsWith(`/${file}`) && (await exists(hint))) return hint;
  const projects = join(configDir, "projects");
  if (cwd) {
    const guess = join(projects, claudeProjectDir(cwd), file);
    if (await exists(guess)) return guess;
  }
  for (const dir of await readdir(projects).catch(() => [] as string[])) {
    const path = join(projects, dir, file);
    if (await exists(path)) return path;
  }
  return null;
}
