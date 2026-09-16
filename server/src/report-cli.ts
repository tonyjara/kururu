/**
 * What a Claude Code hook runs to tell kururu what its agent is doing.
 *
 * Two things the pty cannot be watched for arrive this way. `blocked` is one:
 * no amount of staring at a byte stream distinguishes "waiting for you to
 * approve something" from "thinking hard", so the agent has to say it. Context
 * usage is the other — it is a number the agent knows and the terminal never
 * carries. See `agents/report.ts` for the endpoint that takes them, and
 * `transcript.ts` for where the number is read from.
 *
 * The part worth understanding is how it knows *which* agent it is, because
 * nothing is passed in to say so. Kururu spawns every pty with `KURURU_AGENT_ID`
 * in its environment (`agents/host.ts`), a hook is a child of the agent, and a
 * child inherits the environment — so the answer is already sitting in
 * `process.env` by the time this runs, exactly and with no guessing. That is why
 * this is a hook rather than something the server works out for itself: the
 * server can see that an agent is running in some directory, but two agents in
 * one project would be indistinguishable to it, and a context percentage
 * attributed to the wrong agent is worse than no percentage at all.
 *
 * Deliberately silent and deliberately exit-zero, always. It runs on every turn
 * of every session, including sessions that have nothing to do with kururu — a
 * plain terminal, another multiplexer, CI. In all of those `KURURU_AGENT_ID` is
 * simply absent and this does nothing. A hook that printed a warning there, or
 * failed, would be a hook nobody leaves installed.
 *
 * Usage, from `~/.claude/settings.json`:
 *
 *     bun /path/to/kururu/server/src/report-cli.ts working
 *
 * The status is optional; with none, it reports only the context reading, which
 * is what a `PostToolUse` or `SessionStart` hook wants — and `SessionStart` is
 * the one that makes `/clear` empty the ring the moment it happens.
 */
import { isAgentStatus } from "../../shared/model";
import { STANDARD_WINDOW, readContext } from "./transcript";

/** A turn must never wait on us. Long enough for a local socket, and no longer. */
const TIMEOUT_MS = 1500;
/** Enough for any hook payload; a transcript path is the only field we read. */
const MAX_STDIN = 1024 * 1024;

/**
 * The hook payload, if there is one. Claude Code writes JSON to stdin; anything
 * else running this has a tty there instead, and would otherwise hang waiting
 * for a payload that is never coming.
 */
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
    const text = Buffer.concat(chunks).toString("utf8").trim();
    if (!text) return null;
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * One line about what this agent is doing, if the hook we are standing in knows.
 *
 * Two events carry something worth printing and the rest carry nothing, which is
 * the right shape rather than a gap. `UserPromptSubmit` has the prompt — the
 * actual instruction, in the words it was given in, which is the truest answer
 * to "what is it doing" that exists anywhere. `Notification` has the reason it
 * stopped to ask, which is what you want on screen at exactly the moment the
 * dot turns amber.
 *
 * `PreToolUse` deliberately says nothing even though it could say "running
 * Bash". A line that changes several times a second is not a line anybody reads,
 * and it would overwrite the prompt — the one thing on the row worth keeping —
 * with whichever tool happened to be last. Sending no message leaves the
 * previous one standing, which is why that hook is still worth running: it
 * carries the status and the context reading without disturbing the text.
 */
function activityFrom(payload: Record<string, unknown> | null): string | undefined {
  for (const key of ["prompt", "message"]) {
    const value = payload?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

async function main(): Promise<void> {
  const agent = process.env.KURURU_AGENT_ID;
  // Not running inside kururu. The overwhelmingly common case, and not an error.
  if (!agent) return;

  const asked = process.argv[2];
  const status = asked && isAgentStatus(asked) ? asked : undefined;

  const payload = await readPayload();
  const path = typeof payload?.transcript_path === "string" ? payload.transcript_path : "";
  /**
   * `SessionStart` is the one event where no file is still an answer. After
   * `/clear` the hook can run before Claude Code has written the new transcript,
   * and reading nothing would leave the ring on the conversation that was just
   * cleared. A session that is starting has used nothing, whatever the disk says.
   */
  const starting = payload?.hook_event_name === "SessionStart" && payload.source !== "resume";
  const context = (path ? await readContext(path) : null) ?? (starting ? { used: 0, window: STANDARD_WINDOW } : null);
  const message = activityFrom(payload);

  // Nothing to say. The endpoint would answer 400, which is correct of it and
  // pointless to provoke.
  if (!status && !context && !message) return;

  const port = process.env.KURURU_PORT ?? "7717";
  try {
    await fetch(`http://127.0.0.1:${port}/api/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent, status, context: context ?? undefined, message }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // The server is restarting, or down. The agent is not, and its turn is not
    // ours to interrupt over a status dot.
  }
}

// Never non-zero: a hook that fails is a hook that gets uninstalled.
void main().then(
  () => process.exit(0),
  () => process.exit(0),
);
