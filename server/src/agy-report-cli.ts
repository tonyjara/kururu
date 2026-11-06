/**
 * What Antigravity's `agy` runs to tell kururu what its agent is doing —
 * `report-cli.ts` for a program with no hooks kururu may hand it.
 *
 * Two doors, one script. As a **title command** (`title agent|kuru <launch>`)
 * it is run by `agy` on every change of state with the state, the
 * conversation, the context and the quota on stdin, and prints the window
 * title, which is all `agy` wants of it. As a **hook** (`hook <Event>`) it is
 * run from Kuru's own folder, which is kururu's to put hooks in, for the two
 * things the title cannot carry: the user's words as a turn starts and the
 * reply as it ends. `shared/agy.ts` argues for both and holds the reading.
 *
 * The title is run many times a state — every redraw of the status line —
 * so what the last call saw is kept in a file under kururu's state folder,
 * named by the launch's nonce rather than the agent's id: ids are handed out
 * again after a host restart, and a new agent must not inherit an old one's
 * `working` and report a `done` it never had.
 *
 * Silent and exit-zero, always, for `report-cli.ts`'s reason; and it prints
 * the title before it does anything slow, so `agy` is never waiting on a
 * socket for its window title.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  AGY_CONVERSATION,
  agyContext,
  agyLastReply,
  agyQuotaOf,
  agyReport,
  agyStatusOf,
  agyTranscriptPaths,
  agyTransition,
  type AgyQuota,
} from "../../shared/agy";
import { tokenHeaders } from "../localtoken.mjs";
import { stateDir } from "./fsutil";

/** A state change must never wait on us. Long enough for a local socket, and no longer. */
const TIMEOUT_MS = 1500;
const MAX_STDIN = 1024 * 1024;
const REPLY_MAX = 20_000;
/** A launch's state file older than this is from an agent long gone. */
const STALE_MS = 3 * 24 * 3600_000;
/** How often the quota file is rewritten when nothing in it moved. */
const QUOTA_REFRESH_MS = 60_000;
/** A reply looked for this many times, this far apart, on the turn's end: the transcript can trail the screen. */
const REPLY_TRIES = 4;
const REPLY_GAP_MS = 250;
/** Enough of a transcript's end to hold its last turn whole. */
const TAIL_BYTES = 384 * 1024;

/** What the title shows. Not empty, which hands the name back to the terminal; not the state, which would make the tab's name flicker. */
const TITLE = "Antigravity";

async function readPayload(): Promise<Record<string, unknown> | null> {
  if (process.stdin.isTTY) return null;
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
      size += (chunk as Buffer).length;
      if (size > MAX_STDIN) break;
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function dir(): string {
  return join(stateDir(), "agy");
}

/** A launch's nonce, as `server/src/agy.ts` mints it; anything else names no file. */
function launchFile(launch: string | undefined): string | null {
  return launch && /^[0-9a-f]{16}$/.test(launch) ? join(dir(), `${launch}.json`) : null;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Written whole and renamed into place, so a reader never sees half of one. */
function writeJson(path: string, value: unknown): void {
  try {
    mkdirSync(dir(), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), "utf8");
    renameSync(tmp, path);
  } catch {}
}

/** The launch files of agents long gone, cleared on a launch's first word. */
function prune(now: number): void {
  try {
    for (const name of readdirSync(dir())) {
      const path = join(dir(), name);
      if (now - statSync(path).mtimeMs > STALE_MS) unlinkSync(path);
    }
  } catch {}
}

/**
 * The quota beside the server's other state, for `agyusage.ts` to read: the
 * windows and the plan, never the email the payload also carries. Rewritten
 * when a figure moved, or once a minute, so its time says how fresh it is.
 */
function keepQuota(payload: Record<string, unknown>, now: number): void {
  const quota = agyQuotaOf(payload, now);
  if (!quota) return;
  const path = join(stateDir(), "agy-quota.json");
  const was = readJson(path) as Partial<AgyQuota> | null;
  const same = was && JSON.stringify(was.windows) === JSON.stringify(quota.windows) && was.plan === quota.plan;
  if (same && typeof was.at === "number" && now - was.at < QUOTA_REFRESH_MS) return;
  writeJson(path, quota);
}

function tail(path: string): string | null {
  try {
    const text = readFileSync(path);
    return text.subarray(Math.max(0, text.length - TAIL_BYTES)).toString("utf8");
  } catch {
    return null;
  }
}

/** The reply a turn ended on, looked for a few times, since the transcript may land after the state does. */
async function replyOf(paths: string[]): Promise<string | null> {
  for (let i = 0; i < REPLY_TRIES; i++) {
    for (const path of paths) {
      const text = tail(path);
      const reply = text === null ? null : agyLastReply(text);
      if (reply) return reply.slice(0, REPLY_MAX);
    }
    await new Promise((resolve) => setTimeout(resolve, REPLY_GAP_MS));
  }
  return null;
}

async function post(body: Record<string, unknown> | null): Promise<void> {
  if (!body) return;
  const port = process.env.KURURU_PORT ?? "7717";
  try {
    await fetch(`http://127.0.0.1:${port}/api/report`, {
      method: "POST",
      headers: { "content-type": "application/json", ...tokenHeaders() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // The server is restarting, or down. The agent is not.
  }
}

function conversationOf(value: unknown): string | null {
  return typeof value === "string" && AGY_CONVERSATION.test(value) ? value : null;
}

/** A title call: the title first, then what changed, if anything did. */
async function title(agent: string, mode: string | undefined, launch: string | undefined, payload: Record<string, unknown> | null): Promise<void> {
  process.stdout.write(`${TITLE}\n`);
  if (!payload) return;
  const now = Date.now();
  keepQuota(payload, now);
  const file = launchFile(launch);
  if (!file) return;
  const kept = readJson(file);
  const previous = typeof kept?.state === "string" ? kept.state : null;
  const state = typeof payload.agent_state === "string" ? payload.agent_state : null;
  if (state && agyStatusOf(state) !== null && state !== previous) writeJson(file, { state });
  const change = agyTransition(previous, state);
  if (previous === null && change === "wake") prune(now);
  const conversation = conversationOf(payload.conversation_id) ?? conversationOf(payload.session_id);
  const context = agyContext(payload);
  // Kuru's turns are its hooks' to report; the title says only that it is up.
  if (mode === "kuru") {
    if (change === "wake") await post(agyReport({ agent, status: "idle", conversation, context }));
    return;
  }
  if (change === null) return;
  const reply = change === "done" && conversation ? await replyOf(agyTranscriptPaths(homedir(), conversation)) : null;
  await post(agyReport({ agent, status: change === "wake" ? "idle" : change, conversation, context, reply }));
}

/**
 * A hook in Kuru's folder. `PreInvocation` is run before every model call,
 * several to a turn; only the first of a turn (`invocationNum` 0) is the
 * user's words arriving. `Stop` with `fullyIdle` is the turn over.
 */
async function hook(agent: string, event: string | undefined, payload: Record<string, unknown> | null): Promise<void> {
  const conversation = conversationOf(payload?.conversationId);
  if (event === "PreInvocation") {
    process.stdout.write("{}\n");
    if (payload?.invocationNum !== 0) return;
    const words = typeof payload.lastUserInput === "string" ? payload.lastUserInput.trim() : "";
    await post(agyReport({ agent, status: "working", conversation, context: null, message: words || null }));
    return;
  }
  if (event === "Stop") {
    // Any decision but "continue" lets the stop stand.
    process.stdout.write(`{"decision":"stop"}\n`);
    if (payload?.fullyIdle === false) return;
    const named = typeof payload?.transcriptPath === "string" && payload.transcriptPath.startsWith("/") ? [payload.transcriptPath] : [];
    const reply = await replyOf([...named, ...(conversation ? agyTranscriptPaths(homedir(), conversation) : [])]);
    await post(agyReport({ agent, status: "done", conversation, context: null, reply }));
    return;
  }
  process.stdout.write("{}\n");
}

async function main(): Promise<void> {
  const [door, arg, launch] = process.argv.slice(2);
  const payload = await readPayload();
  const agent = process.env.KURURU_AGENT_ID;
  if (door === "title") {
    // Outside kururu the title is all there is to give.
    if (!agent) return void process.stdout.write(`${TITLE}\n`);
    return title(agent, arg, launch, payload);
  }
  if (door === "hook") {
    if (!agent) return void process.stdout.write(arg === "Stop" ? `{"decision":"stop"}\n` : "{}\n");
    return hook(agent, arg, payload);
  }
}

void main().then(
  () => process.exit(0),
  () => process.exit(0),
);
