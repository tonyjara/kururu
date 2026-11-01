/**
 * Reading what OpenCode wrote about a message: its tokens, and whose turn
 * it was. The estimate is ours, from the same price table every program is
 * read against — OpenCode's own figure, from models.dev's list, is a
 * different scale and nothing here keeps it.
 *
 * Unlike Claude Code and Codex there is no log to tail: since 1.2.0 OpenCode
 * keeps its sessions in one SQLite database, `message.data` a JSON blob per
 * row with the same shape the older `storage/message/<session>/<id>.json`
 * files held one message to a file. So `parseOpencodeMessage` takes that blob
 * however it arrived — a column already parsed by `node:sqlite`, or a file
 * `sweep.ts` read and parsed itself — and the two sources meet here as one
 * function. The database is opened read-only; nothing kururu does ever writes
 * beside OpenCode's own writer.
 *
 * Kururu mints the `ses_…` id OpenCode's session carries when it started Kuru
 * or an agent on it, so those sessions are attributed exactly; a session a
 * person started by hand is folder-only, the same as an unrecorded `claude`.
 */
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { costOf } from "../../../shared/prices";
import { countOf, type MessageRow } from "../../../shared/usage";

const ID = /^[\w.:-]{1,128}$/;
const MODEL = /^[\w.:<>\[\]-]{1,96}$/;
const MAX_CWD = 1024;

/** Where OpenCode keeps its one database and its (now legacy) per-message files, on this machine. There is no per-profile copy to choose between. */
export function opencodeHome(): string {
  return process.env.XDG_DATA_HOME ? join(process.env.XDG_DATA_HOME, "opencode") : join(homedir(), ".local", "share", "opencode");
}

export function opencodeDbPath(home = opencodeHome()): string {
  return join(home, "opencode.db");
}

export function opencodeLegacyDir(home = opencodeHome()): string {
  return join(home, "storage", "message");
}

export type ParsedOpencode =
  | { kind: "message"; row: MessageRow; cwd: string | null }
  | { kind: "skip"; why: string }
  | { kind: "other" };

/**
 * One message's `data` blob, with the session and message id the caller
 * already has (a database row's own columns, or a legacy file's path). `at`
 * is read off the blob's own `time`, not off the database's `time_updated`,
 * because a message can be updated — the usage filled in once the call
 * finishes — well after it was created, and the moment it billed is the one
 * its own record states.
 */
export function parseOpencodeMessage(dataRaw: unknown, sessionId: string, messageId: string): ParsedOpencode {
  if (!ID.test(sessionId) || !ID.test(messageId)) return { kind: "skip", why: "not an id" };
  let data: Record<string, any>;
  if (typeof dataRaw === "string") {
    try {
      data = JSON.parse(dataRaw);
    } catch {
      return { kind: "skip", why: "not JSON" };
    }
  } else if (dataRaw && typeof dataRaw === "object") {
    data = dataRaw as Record<string, any>;
  } else {
    return { kind: "skip", why: "not an object" };
  }
  if (data.role !== "assistant") return { kind: "other" };
  const tokens = data.tokens;
  if (!tokens || typeof tokens !== "object") return { kind: "other" };
  const input = countOf(tokens.input);
  const output = countOf(tokens.output);
  const reasoning = countOf(tokens.reasoning);
  const read = countOf(tokens.cache?.read);
  const write = countOf(tokens.cache?.write);
  if (input === null || output === null || reasoning === null || read === null || write === null) {
    return { kind: "skip", why: "a count that is not a number" };
  }
  // An aborted message with nothing billed is not a row — there is nothing here to count, and nothing wrong with the line either.
  if (input + output + reasoning + read + write === 0) return { kind: "other" };
  const at = typeof data.time?.completed === "number" ? data.time.completed : typeof data.time?.created === "number" ? data.time.created : NaN;
  if (!Number.isFinite(at)) return { kind: "skip", why: "no timestamp" };
  const model = typeof data.modelID === "string" && MODEL.test(data.modelID) ? data.modelID : "";
  const tokensForCost = { input, write5m: write, write1h: 0, read, output };
  const row: MessageRow = {
    sessionId,
    messageId,
    at,
    model,
    requestedModel: null,
    effort: null,
    ...tokensForCost,
    thinking: reasoning,
    // The same table every program is priced from: an OpenCode session on an
    // Anthropic model is priced exactly as a Claude Code one would be. A model
    // this table does not have — any other provider's — is unpriced, never
    // OpenCode's own figure from models.dev's list, which is a different
    // scale and not this column's business.
    costEst: costOf(model, at, tokensForCost),
    sidechain: false,
    source: "opencode",
  };
  return { kind: "message", row, cwd: typeof data.path?.cwd === "string" && data.path.cwd.length <= MAX_CWD ? data.path.cwd : null };
}

/** One message to a file, `storage/message/<session id>/<message id>.json`: everywhere the db has not taken over yet. */
export interface LegacyFile {
  path: string;
  sessionId: string;
  messageId: string;
}

/** Every legacy message file under `opencodeLegacyDir()`, for the one backfill pass that reads them. */
export async function opencodeLegacyFiles(dir: string): Promise<LegacyFile[]> {
  const out: LegacyFile[] = [];
  for (const session of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!session.isDirectory()) continue;
    for (const file of await readdir(join(dir, session.name), { withFileTypes: true }).catch(() => [])) {
      if (file.isFile() && file.name.endsWith(".json")) out.push({ path: join(dir, session.name, file.name), sessionId: session.name, messageId: file.name.slice(0, -".json".length) });
    }
  }
  return out;
}
