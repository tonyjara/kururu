/**
 * Reading Codex's rollouts for what they say was billed, and for how full the
 * account's allowance windows were at the moment.
 *
 * A rollout carries no session id of its own on every line the way a Claude
 * transcript does: it is in the file's name, `rollout-<time>-<id>.jsonl`, once,
 * so that is where this reads it from, never from a line. Each turn opens with
 * a `turn_context` naming the model; every API call inside that turn then
 * writes an `event_msg` of type `token_count`, and the needles below are
 * exactly those two so that everything else — the instructions, the tool
 * output, the reasoning text — costs a read and nothing more.
 *
 * **One call's tokens, not a running total's arithmetic.** `info.total_token_usage`
 * is the session's cumulative figure, and the plan this reader follows argued
 * for taking its difference between calls; but `info.last_token_usage` is
 * already that difference, written by Codex itself on every event checked
 * against `total_token_usage` on this Mac's own logs, and taking it directly
 * means nothing has to be remembered across a restart to get the next call
 * right. A rollout without it is a format this file has not met, and its
 * events are skipped and counted rather than diffed against a total this
 * reader would otherwise have to keep somewhere durable.
 *
 * `payload.rate_limits` rides on the same event, for free: `codexLimitSnapshots`
 * turns it into the window readings `sweep.ts` adds to the ledger's `limits`
 * table, kept as a history rather than filtered to what is still current, which
 * is `codexusage.ts`'s job for the live bar.
 */
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isLoginKey } from "../../../shared/model";
import { costOf } from "../../../shared/prices";
import { countOf, type LimitRow, type MessageRow } from "../../../shared/usage";
import { configPath } from "../config";

export const CODEX_NEEDLES = ['"type":"turn_context"', '"type":"token_count"'] as const;

const ID = /^[\w.:-]{1,128}$/;
const MODEL = /^[\w.:<>\[\]-]{1,96}$/;
const WORD = /^[\w.:-]{1,48}$/;
const MAX_CWD = 1024;
const ROLLOUT_NAME = /^rollout-[\d-]+T[\d-]+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

function word(value: unknown): string | null {
  return typeof value === "string" && WORD.test(value) ? value : null;
}

/** What is known about the turn a `token_count` event falls inside, carried line to line by the caller. */
export interface CodexTurn {
  model: string | null;
  effort: string | null;
  cwd: string | null;
}

export function noCodexTurn(): CodexTurn {
  return { model: null, effort: null, cwd: null };
}

/** A line's worth, once the caller has filled in the session and message ids it does not carry itself. */
export type ParsedCodexLine =
  | { kind: "turn"; turn: CodexTurn }
  | { kind: "message"; row: Omit<MessageRow, "sessionId" | "messageId">; limits: { raw: unknown; at: number } | null }
  | { kind: "skip"; why: string }
  | { kind: "other" };

/** Pure: a `turn_context` or `token_count` line, or neither. The fixtures in `server/test/fixtures/usage/` are hand-written. */
export function parseCodexLine(line: string, turn: CodexTurn): ParsedCodexLine {
  let record: Record<string, any>;
  try {
    record = JSON.parse(line);
  } catch {
    return { kind: "skip", why: "not JSON" };
  }
  if (!record || typeof record !== "object") return { kind: "other" };
  if (record.type === "turn_context") return turnContext(record);
  if (record.type === "event_msg" && record.payload?.type === "token_count") return tokenCount(record, turn);
  return { kind: "other" };
}

function turnContext(record: Record<string, any>): ParsedCodexLine {
  const payload = record.payload;
  if (!payload || typeof payload !== "object") return { kind: "other" };
  const model = typeof payload.model === "string" && MODEL.test(payload.model) ? payload.model : null;
  const cwd = typeof payload.cwd === "string" && payload.cwd.length <= MAX_CWD ? payload.cwd : null;
  return { kind: "turn", turn: { model, cwd, effort: word(payload.collaboration_mode?.settings?.reasoning_effort) } };
}

function tokenCount(record: Record<string, any>, turn: CodexTurn): ParsedCodexLine {
  const at = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
  if (!Number.isFinite(at)) return { kind: "skip", why: "no timestamp" };
  const usage = record.payload?.info?.last_token_usage;
  if (!usage || typeof usage !== "object") return { kind: "skip", why: "no last_token_usage" };
  const whole = countOf(usage.input_tokens);
  const cached = countOf(usage.cached_input_tokens);
  const written = countOf(usage.cache_write_input_tokens);
  const output = countOf(usage.output_tokens);
  const reasoning = countOf(usage.reasoning_output_tokens);
  if (whole === null || cached === null || written === null || output === null || reasoning === null) {
    return { kind: "skip", why: "a count that is not a number" };
  }
  if (cached > whole) return { kind: "skip", why: "cached tokens exceed input tokens" };
  const model = turn.model ?? "";
  const tokens = { input: whole - cached, write5m: written, write1h: 0, read: cached, output };
  const row: Omit<MessageRow, "sessionId" | "messageId"> = {
    at,
    model,
    requestedModel: null,
    effort: turn.effort,
    ...tokens,
    thinking: reasoning,
    costEst: costOf(model, at, tokens),
    sidechain: false,
    source: "rollout",
  };
  const rateLimits = record.payload?.rate_limits;
  return { kind: "message", row, limits: rateLimits && typeof rateLimits === "object" ? { raw: rateLimits, at } : null };
}

/**
 * One `rate_limits` object as every window it names, kept whatever its reset
 * says: a live bar drops an expired window, but a history is the point here,
 * and `account` is the login this rollout ran under, for the day a child's and
 * the Mac's own Codex allowances are both on the page.
 */
export function codexLimitSnapshots(rateLimits: unknown, at: number, account: string | null): LimitRow[] {
  if (!rateLimits || typeof rateLimits !== "object") return [];
  const out: LimitRow[] = [];
  for (const slot of ["primary", "secondary"] as const) {
    const window = (rateLimits as Record<string, unknown>)[slot];
    if (!window || typeof window !== "object") continue;
    const { used_percent: used, window_minutes: minutes, resets_at: resets } = window as Record<string, unknown>;
    if (typeof used !== "number" || !Number.isFinite(used)) continue;
    const resetsAt = typeof resets === "number" && Number.isFinite(resets) ? resets * 1000 : null;
    out.push({ at, account, kind: windowKind(typeof minutes === "number" && Number.isFinite(minutes) ? minutes : null), scope: null, percent: Math.max(0, Math.min(100, used)), resetsAt, source: "codex" });
  }
  return out;
}

/** The same naming `codexusage.ts` draws the live bar with, kept in step with it on purpose. */
function windowKind(minutes: number | null): string {
  if (minutes === 300) return "session";
  if (minutes === 10_080) return "weekly_all";
  if (minutes === null || minutes <= 0) return "window";
  return minutes % 1440 === 0 ? `${minutes / 1440}d` : `${Math.round(minutes / 60)}h`;
}

// ---------------------------------------------------------------------------
// Where they are
// ---------------------------------------------------------------------------

export interface CodexRoot {
  dir: string;
  loginKey: string | null;
}

/** Every `CODEX_HOME` the sweep reads: the machine's, then each profile's. Codex keeps no `identities/` of its own. */
export async function codexRoots(): Promise<CodexRoot[]> {
  const roots: CodexRoot[] = [{ dir: process.env.CODEX_HOME || join(homedir(), ".codex"), loginKey: null }];
  const profiles = configPath("profiles");
  for (const entry of (await readdir(profiles, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
    if (isLoginKey(entry.name)) roots.push({ dir: join(profiles, entry.name, "codex"), loginKey: entry.name });
  }
  return roots;
}

/**
 * The rollout a path names, read off its filename rather than its content —
 * Codex writes the id once, in `session_meta`, and the filename says the same
 * thing without opening the file. Null for anything that is not a rollout
 * directly under a root's `sessions/`.
 */
export function placeOfCodex(path: string, root: CodexRoot): { sessionId: string } | null {
  const prefix = `${join(root.dir, "sessions")}/`;
  if (!path.startsWith(prefix)) return null;
  const id = ROLLOUT_NAME.exec(path.slice(path.lastIndexOf("/") + 1))?.[1];
  return id && ID.test(id) ? { sessionId: id } : null;
}
