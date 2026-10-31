/**
 * Reading Claude Code's transcripts for what they say was billed, and nothing
 * else they say.
 *
 * A sibling of `transcript.ts` rather than a use of it: that one reads the two
 * ends of one file for how full a window is now, and this reads every billed
 * message once. They look at the same fields, so a disagreement between the
 * context ring and the ledger is a parser bug here or there.
 *
 * **Two kinds of line, and every other line is never parsed.** Tool output and
 * the request blobs are ninety-odd percent of the bytes and hold the content
 * of the user's projects. `tail.ts` searches a chunk for the two needles below
 * before anything becomes a string, so those lines cost a read and no more,
 * and what comes out of a parse here is a set of numbers, ids and a model
 * name, with no field a sentence could travel in. `skipped` says why a line was
 * refused in a word chosen here, never in anything off the line.
 *
 * **The format is Claude Code's private business** and has moved before, so
 * every field is checked rather than trusted. A record that does not add up is
 * counted, not guessed at, and the page shows the count. `cost-state` in
 * particular is undocumented: it goes to `session_totals` as what Claude Code
 * says, and is the cross-check on the estimate rather than the source of a row.
 * It is also where a session's unrecorded spending shows: the Haiku calls
 * Claude Code makes for itself, and web searches, are in its dollars and have
 * no assistant record, so the two figures can honestly differ.
 */
import { readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isLoginKey } from "../../../shared/model";
import { costOf } from "../../../shared/prices";
import { countOf, splitCacheWrite, type MessageRow, type TotalsRow, type UsageSource } from "../../../shared/usage";
import { configPath } from "../config";

/** A record is one of these two when it is anything to us. Compact, because that is how Claude Code writes them. */
export const CLAUDE_NEEDLES = ['"type":"assistant"', '"type":"cost-state"'] as const;

/** Ids and names reach the database and a query's text, so they are held to their shape. */
const ID = /^[\w.:-]{1,128}$/;
const MODEL = /^[\w.:<>\[\]-]{1,96}$/;
const WORD = /^[\w.:-]{1,48}$/;
const MAX_CWD = 1024;

/** What a line amounted to. `cwd` and `version` are all a message says about its session. */
export type ParsedLine =
  | { kind: "message"; row: MessageRow; cwd: string | null; version: string | null }
  | { kind: "totals"; rows: TotalsRow[] }
  | { kind: "skip"; why: string }
  | { kind: "other" };

function word(value: unknown): string | null {
  return typeof value === "string" && WORD.test(value) ? value : null;
}

/**
 * One line that held a needle, as a row or a reason. Pure; the fixtures in
 * `server/test/fixtures/usage/` are hand-written with the real field names.
 * `other` is a line that merely mentions the needle, like a tool result quoting
 * a transcript inside an object.
 */
export function parseClaudeLine(line: string, source: UsageSource): ParsedLine {
  let record: Record<string, any>;
  try {
    record = JSON.parse(line);
  } catch {
    return { kind: "skip", why: "not JSON" };
  }
  if (!record || typeof record !== "object") return { kind: "other" };
  if (record.type === "assistant") return assistant(record, source);
  // A subagent's file could only be repeating its parent, and a running total
  // read out of order is worse than none.
  if (record.type === "cost-state") return source === "transcript" ? costState(record) : { kind: "other" };
  return { kind: "other" };
}

function assistant(record: Record<string, any>, source: UsageSource): ParsedLine {
  const message = record.message;
  const usage = message?.usage;
  // An assistant record with no usage billed nothing and is not a message.
  if (!usage || typeof usage !== "object") return { kind: "other" };
  const sessionId = record.sessionId;
  if (typeof sessionId !== "string" || !ID.test(sessionId)) return { kind: "skip", why: "no session id" };
  const messageId = typeof message.id === "string" ? message.id : record.requestId;
  if (typeof messageId !== "string" || !ID.test(messageId)) return { kind: "skip", why: "no message id" };
  const at = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
  if (!Number.isFinite(at)) return { kind: "skip", why: "no timestamp" };
  const input = countOf(usage.input_tokens);
  const written = countOf(usage.cache_creation_input_tokens);
  const stated5m = countOf(usage.cache_creation?.ephemeral_5m_input_tokens);
  const stated1h = countOf(usage.cache_creation?.ephemeral_1h_input_tokens);
  const read = countOf(usage.cache_read_input_tokens);
  const output = countOf(usage.output_tokens);
  const thinking = countOf(usage.output_tokens_details?.thinking_tokens);
  if (input === null || written === null || stated5m === null || stated1h === null || read === null || output === null || thinking === null) {
    return { kind: "skip", why: "a count that is not a number" };
  }
  const model = typeof message.model === "string" && MODEL.test(message.model) ? message.model : "";
  const { write5m, write1h } = splitCacheWrite(written, stated5m, stated1h);
  const tokens = { input, write5m, write1h, read, output };
  return {
    kind: "message",
    row: {
      sessionId,
      messageId,
      at,
      model,
      requestedModel: typeof record.requestedModel === "string" && MODEL.test(record.requestedModel) ? record.requestedModel : null,
      effort: word(record.effort),
      ...tokens,
      thinking,
      costEst: costOf(model, at, tokens, { fast: usage.speed === "fast", usOnly: usage.inference_geo === "us" }),
      sidechain: record.isSidechain === true || source === "subagent",
      source,
    },
    cwd: typeof record.cwd === "string" && record.cwd.length <= MAX_CWD ? record.cwd : null,
    version: word(record.version),
  };
}

function costState(record: Record<string, any>): ParsedLine {
  const sessionId = record.sessionId;
  if (typeof sessionId !== "string" || !ID.test(sessionId)) return { kind: "skip", why: "no session id" };
  const start = record.startTime;
  const lasted = record.totalDuration;
  // It has no time of its own, and this is when it was written.
  const at = typeof start === "number" && Number.isFinite(start) ? start + (typeof lasted === "number" && Number.isFinite(lasted) ? lasted : 0) : 0;
  const usage = record.modelUsage;
  if (!usage || typeof usage !== "object") return { kind: "other" };
  const rows: TotalsRow[] = [];
  for (const [model, each] of Object.entries(usage as Record<string, any>)) {
    if (!MODEL.test(model) || !each || typeof each !== "object") return { kind: "skip", why: "a cost record that does not add up" };
    const input = countOf(each.inputTokens);
    const output = countOf(each.outputTokens);
    const thinking = countOf(each.thinkingTokens);
    const read = countOf(each.cacheReadInputTokens);
    const written = countOf(each.cacheCreationInputTokens);
    const stated5m = countOf(each.cacheCreationEphemeral5mInputTokens);
    const stated1h = countOf(each.cacheCreationEphemeral1hInputTokens);
    if (input === null || output === null || thinking === null || read === null || written === null || stated5m === null || stated1h === null) {
      return { kind: "skip", why: "a cost record that does not add up" };
    }
    const cost = typeof each.costUSD === "number" && Number.isFinite(each.costUSD) && each.costUSD >= 0 ? each.costUSD : null;
    rows.push({ sessionId, model, input, output, thinking, read, ...splitCacheWrite(written, stated5m, stated1h), costProgram: cost, at });
  }
  return { kind: "totals", rows };
}

// ---------------------------------------------------------------------------
// Where they are
// ---------------------------------------------------------------------------

/** A Claude Code config directory, and whose login it is when kururu made it. */
export interface ClaudeRoot {
  dir: string;
  loginKey: string | null;
}

/**
 * Every config directory whose transcripts are read, in the order they are
 * read: the machine's first, because nothing has started there for weeks and
 * the next `claude` to start will sweep everything older than thirty days at
 * once; then the logins kept by hand under `identities/`, which `usage.ts`
 * reads too; then each profile's. Nothing is scanned that the server would not
 * already open for the usage bar.
 *
 * `CLAUDE_CONFIG_DIR` is on the list, and by its real path against the others,
 * because a server started from one of kururu's own terminals inherits a
 * profile's.
 */
export async function claudeRoots(): Promise<ClaudeRoot[]> {
  const roots: ClaudeRoot[] = [{ dir: join(homedir(), ".claude"), loginKey: null }];
  if (process.env.CLAUDE_CONFIG_DIR) roots.push({ dir: process.env.CLAUDE_CONFIG_DIR, loginKey: null });
  const identities = configPath(join("identities", "claude"));
  for (const entry of await readdir(identities, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) roots.push({ dir: join(identities, entry.name), loginKey: null });
  }
  const profiles = configPath("profiles");
  for (const entry of (await readdir(profiles, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
    if (isLoginKey(entry.name)) roots.push({ dir: join(profiles, entry.name, "claude"), loginKey: entry.name });
  }
  const held = new Map<string, ClaudeRoot>();
  for (const root of roots) {
    const real = await realpath(root.dir).catch(() => null);
    if (!real) continue;
    const before = held.get(real);
    // The same directory reached twice is a profile's whenever one of the two says so.
    if (!before || (!before.loginKey && root.loginKey)) held.set(real, before ? { ...root, dir: before.dir } : root);
  }
  return [...held.values()];
}

/**
 * Where a file sits under a root, read off its path: its project directory,
 * and whether it is a subagent's. Null for anything that is not a transcript
 * under `projects/`, which is the check a nudge's path has to pass.
 */
export function placeOf(path: string, root: ClaudeRoot): { projectDir: string; source: UsageSource } | null {
  const prefix = `${join(root.dir, "projects")}/`;
  if (!path.startsWith(prefix) || !path.endsWith(".jsonl")) return null;
  const parts = path.slice(prefix.length).split("/");
  if (parts.length < 2 || parts.some((part) => part === "" || part === "." || part === "..")) return null;
  return { projectDir: parts[0]!, source: parts.slice(1).includes("subagents") ? "subagent" : "transcript" };
}
