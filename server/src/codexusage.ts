/**
 * How much of the Codex allowance is spent, read off what Codex wrote down.
 *
 * The Claude bar asks Anthropic (`usage.ts`), with the machine's own login,
 * because nothing on the disk states a plan limit. Codex is different: every
 * turn's `token_count` event in a session's rollout carries `rate_limits` —
 * the percentage of each window spent and the moment it resets — so the
 * answer is already on this Mac, in a file Codex wrote for its own resume.
 * Reading it costs no credential and no request, which is the whole reason it
 * is done this way rather than by asking OpenAI the question `/status` asks:
 * `usage.ts` is the one file in kururu that has seen a token for the purpose
 * of drawing a bar, and a second one would have to earn its place.
 *
 * The price is freshness. The figures are as of the last Codex turn on this
 * machine — a session on the web or another computer spends the same
 * allowance and this never hears of it — so the reading carries the time
 * Codex wrote it, and a window whose reset has come and gone since is dropped
 * rather than drawn at a percentage that stopped being true at the reset.
 *
 * "Signed in" is `auth.json` being there in the Codex home the terminals use —
 * the profile's when profiles keep their own logins (`logins.ts`), otherwise
 * `CODEX_HOME` or `~/.codex`. It is stat'ed, never read: whether it exists is
 * the only thing this module wants to know about it.
 *
 * On the restartable side with `usage.ts`, for its reason: a question no pty
 * raises an event about. Editing it costs a reconnect and no agents.
 */
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { CodexUsage, UsageLimit } from "../../shared/wire";

/** How much of a rollout's end is read for the last token count. A turn writes a few KB. */
const TAIL_BYTES = 256 * 1024;

/** How many of the newest rollouts are looked through before giving up. */
const MAX_FILES = 8;

/** The Codex home the terminals use when nothing names another. */
export function defaultCodexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

/**
 * The windows in one `rate_limits` object, as the bar's limits.
 *
 * `primary` and `secondary` are the two clocks — today a five-hour window and
 * a week, but named by their length rather than their slot, because the slots
 * have held different windows on different plans. A window missing its
 * percentage is dropped (`usage.ts`'s `limitsFrom` argues why there is no
 * honest default), and so is one whose reset is behind `now`.
 *
 * Severity is ours, because Codex states none: amber from three quarters and
 * red from nine tenths, the points where the window starts to decide what you
 * can still start.
 */
export function codexLimitsFrom(rateLimits: unknown, now: number): UsageLimit[] {
  if (!rateLimits || typeof rateLimits !== "object") return [];
  const limits: UsageLimit[] = [];
  for (const slot of ["primary", "secondary"] as const) {
    const window = (rateLimits as Record<string, unknown>)[slot];
    if (!window || typeof window !== "object") continue;
    const { used_percent: used, window_minutes: minutes, resets_at: resets } = window as Record<string, unknown>;
    if (typeof used !== "number" || !Number.isFinite(used)) continue;
    const resetsMs = typeof resets === "number" && Number.isFinite(resets) ? resets * 1000 : null;
    if (resetsMs !== null && resetsMs <= now) continue;
    const percent = Math.max(0, Math.min(100, used));
    const kind = windowKind(typeof minutes === "number" && Number.isFinite(minutes) ? minutes : null);
    limits.push({
      kind,
      group: kind,
      percent,
      severity: percent >= 90 ? "critical" : percent >= 75 ? "warning" : "normal",
      resetsAt: resetsMs === null ? null : new Date(resetsMs).toISOString(),
      scope: null,
    });
  }
  return limits;
}

/**
 * A window's length as the kind the Claude bar already has words for — the
 * five-hour window is a session and the week is a week — and anything else as
 * its length, which `limitLabel` capitalises into a label.
 */
function windowKind(minutes: number | null): string {
  if (minutes === 300) return "session";
  if (minutes === 10_080) return "weekly_all";
  if (minutes === null || minutes <= 0) return "window";
  return minutes % 1440 === 0 ? `${minutes / 1440}d` : `${Math.round(minutes / 60)}h`;
}

/**
 * The last `rate_limits` in a run of rollout lines, with when it was written
 * and the plan beside it. Read from the end, because the last turn is the one
 * that counts and a long session is thousands of lines before it.
 */
export function lastRateLimits(text: string): { rateLimits: Record<string, unknown>; at: number | null; plan: string | null } | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"rate_limits"')) continue;
    let event: { timestamp?: unknown; payload?: { rate_limits?: unknown } };
    try {
      event = JSON.parse(line);
    } catch {
      // The first line of a tail is cut mid-way; any other that will not parse
      // is a write in progress. Neither is the answer.
      continue;
    }
    const rateLimits = event.payload?.rate_limits;
    if (!rateLimits || typeof rateLimits !== "object") continue;
    const at = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : NaN;
    const plan = (rateLimits as { plan_type?: unknown }).plan_type;
    return {
      rateLimits: rateLimits as Record<string, unknown>,
      at: Number.isFinite(at) ? at : null,
      plan: typeof plan === "string" && plan ? plan : null,
    };
  }
  return null;
}

/**
 * The newest rollouts, newest first. `sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`
 * sorts by time at every level, so this walks down the newest branch rather
 * than listing every session ever kept.
 */
async function newestRollouts(home: string): Promise<string[]> {
  const found: string[] = [];
  const names = async (dir: string) =>
    (await readdir(dir).catch(() => [] as string[])).sort().reverse();
  const root = join(home, "sessions");
  for (const year of await names(root)) {
    for (const month of await names(join(root, year))) {
      for (const day of await names(join(root, year, month))) {
        const dir = join(root, year, month, day);
        for (const file of await names(dir)) {
          if (!file.startsWith("rollout-") || !file.endsWith(".jsonl")) continue;
          found.push(join(dir, file));
          if (found.length >= MAX_FILES) return found;
        }
      }
    }
  }
  return found;
}

/** The last `TAIL_BYTES` of a file, as text. */
async function tail(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

/** The reading for one Codex home: null when it is not signed in. */
export async function readCodexUsage(home: string, now = Date.now()): Promise<CodexUsage | null> {
  const signedIn = await stat(join(home, "auth.json")).then(
    () => true,
    () => false,
  );
  if (!signedIn) return null;
  for (const path of await newestRollouts(home)) {
    const found = lastRateLimits(await tail(path).catch(() => ""));
    if (found) return { limits: codexLimitsFrom(found.rateLimits, now), at: found.at, plan: found.plan };
  }
  return { limits: [], at: null, plan: null };
}

let reading: CodexUsage | null = null;

/** Refresh the reading for `home` (the profile's Codex home, or null for the default) and say whether it moved. */
export async function pollCodexUsage(home: string | null): Promise<boolean> {
  const next = await readCodexUsage(home ?? defaultCodexHome()).catch(() => reading);
  const moved = JSON.stringify(next) !== JSON.stringify(reading);
  reading = next;
  return moved;
}

/** What the clients should be holding. */
export function codexUsageSnapshot(): CodexUsage | null {
  return reading;
}
