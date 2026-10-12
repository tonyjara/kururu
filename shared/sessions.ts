/**
 * What the two CLIs write down about a conversation, read back: which Codex
 * rollout is a card's, and what an agent last said.
 *
 * A card's run keeps the id of its conversation so that ending the agent —
 * by hand, or by `server/src/sleep.ts` for sitting idle — loses nothing that
 * `--resume` cannot bring back. Claude Code takes the id kururu chooses
 * (`--session-id`). Codex does not take one: it mints a UUID, writes it into
 * the first line of a rollout under `$CODEX_HOME/sessions/YYYY/MM/DD/`, and
 * says it to nobody until it exits. So kururu reads the rollouts written since
 * the run started and picks the one that is the card's — started after it, in
 * its directory, and opened with the card's own words as its first message,
 * which no other conversation is. Anything less certain than that is no
 * answer: resuming the wrong conversation is worse than the picker.
 *
 * The other half is the last reply, which `sleep.ts` asks of every agent
 * before ending it (did it end by asking something?). A Claude transcript
 * writes each block of an assistant message as a line of its own; a Codex
 * rollout ends each turn with a `task_complete` that carries the reply whole.
 * Both are read from the tail, since that is where the newest turn is and a
 * transcript runs to megabytes.
 *
 * Pure: the files are read by `server/src/sessions.ts` here and by
 * `server/src/machines.ts` over ssh on a machine, and both hand the text in.
 */

/** A rollout as its head says: whose it is, where it started, and the first thing it was asked. */
export interface CodexRollout {
  id: string;
  cwd: string | null;
  /** When the session started, ms since the epoch. */
  at: number;
  /** The first user message, or null when the head had none in it. */
  prompt: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A rollout's first line and its first `user_message` line, either of which
 * may have been cut short — the first line is twenty kilobytes of
 * instructions, and a remote read keeps only its start. So the fields are
 * found by pattern rather than by parsing the line, and they all come before
 * the instructions do.
 */
export function codexRolloutHead(first: string, userLine: string | null): CodexRollout | null {
  if (!first.includes('"type":"session_meta"')) return null;
  const id = /"payload":\{[^{}]*?"id":"([0-9a-f-]{36})"/.exec(first)?.[1];
  if (!id || !UUID.test(id)) return null;
  const stamp = /"payload":\{[^{}]*?"timestamp":"([^"]+)"/.exec(first)?.[1];
  const at = stamp ? Date.parse(stamp) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  const cwd = jsonString(/"payload":\{[^{}]*?"cwd":"((?:[^"\\]|\\.)*)"/.exec(first)?.[1]);
  const prompt = userLine ? jsonString(/"type":"user_message","message":"((?:[^"\\]|\\.)*)/.exec(userLine)?.[1]) : null;
  return { id, cwd, at, prompt };
}

/** A JSON string's body, decoded — and one cut off mid-escape trimmed back to where it still reads. */
function jsonString(body: string | undefined): string | null {
  if (body === undefined) return null;
  for (let cut = 0; cut < 6 && cut <= body.length; cut++) {
    try {
      return JSON.parse(`"${body.slice(0, body.length - cut)}"`) as string;
    } catch {
      // A truncated `é` or a lone backslash at the end: take a character off.
    }
  }
  return null;
}

/** What the run that is looking for its rollout knows about itself. */
export interface RunLooking {
  startedAt: number;
  /** Where it started on this disk; null on a machine, where the pin's folder is all kururu has. */
  cwd: string | null;
  /** The card's prompt, as `cardPrompt` made it. */
  prompt: string;
}

/**
 * How far before the run's start a rollout may say it began. The two clocks
 * are the same clock on this Mac; a machine's may be a few seconds out.
 */
const CLOCK_SLACK_MS = 60_000;

/**
 * The rollout that is this run's, or null. Started no earlier than the run
 * (a setup line can hold the agent back by minutes, so there is no later
 * bound), in its directory when it has one, with the card's words as its
 * first message, and not already a card's. The earliest of what is left, so
 * that a second run of the same card in the same place finds its own.
 */
export function pickCodexRollout(rollouts: readonly CodexRollout[], run: RunLooking, taken: ReadonlySet<string>): CodexRollout | null {
  const want = words(run.prompt);
  if (!want) return null;
  const fits = rollouts.filter(
    (r) =>
      !taken.has(r.id) &&
      r.at >= run.startedAt - CLOCK_SLACK_MS &&
      (run.cwd === null || r.cwd === run.cwd) &&
      r.prompt !== null &&
      sameWords(words(r.prompt), want),
  );
  return fits.sort((a, b) => a.at - b.at)[0] ?? null;
}

/** Whitespace folded, so a prompt that went through a shell and a TUI still reads as itself. */
function words(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The same words, as far as both go: a read over ssh keeps only the start of
 * a long first message. Long enough to be the card's own, never shorter than
 * the prompt when the prompt is short.
 */
function sameWords(got: string, want: string): boolean {
  const n = Math.min(got.length, want.length, 2000);
  if (n < Math.min(want.length, 200)) return false;
  return got.slice(0, n) === want.slice(0, n);
}

/** The marker the remote listing puts before each rollout's two lines. See `CODEX_ROLLOUTS_SCRIPT`. */
export const ROLLOUT_MARK = "<<<kururu-rollout";

/** The listing a machine sends back, as rollouts. Blocks that do not read are dropped. */
export function parseRolloutListing(text: string): CodexRollout[] {
  const out: CodexRollout[] = [];
  for (const block of text.split(ROLLOUT_MARK).slice(1)) {
    const lines = block.split("\n").filter((line) => line.trim());
    const head = lines[0] ? codexRolloutHead(lines[0], lines[1] ?? null) : null;
    if (head) out.push(head);
  }
  return out;
}

/**
 * The last thing a Claude Code transcript's assistant said: every text block
 * of its last message that had one, in order. Tool calls, thinking and the
 * lines Claude Code writes about itself are passed over; the first line of a
 * tail read is usually cut and is passed over too.
 */
export function claudeLastReply(tail: string): string | null {
  const lines = tail.split("\n");
  let messageId: string | null = null;
  const texts: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = parseLine(lines[i]!);
    if (!entry || entry.type !== "assistant") {
      if (messageId !== null && entry?.type === "user") break;
      continue;
    }
    const message = entry.message as { id?: unknown; content?: unknown } | undefined;
    const id = typeof message?.id === "string" ? message.id : null;
    if (messageId !== null && id !== messageId) break;
    const blocks = Array.isArray(message?.content) ? (message.content as { type?: unknown; text?: unknown }[]) : [];
    const said = blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text as string);
    if (!said.length) continue;
    messageId ??= id ?? "";
    texts.unshift(...said);
    if (id === null) break;
  }
  return texts.length ? texts.join("\n\n").trim() : null;
}

/** The last reply in a Codex rollout's tail: the newest `task_complete`'s, else its newest `agent_message`. */
export function codexLastReply(tail: string): string | null {
  const lines = tail.split("\n");
  let fallback: string | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = parseLine(lines[i]!);
    if (!entry || entry.type !== "event_msg") continue;
    const payload = entry.payload as { type?: unknown; last_agent_message?: unknown; message?: unknown } | undefined;
    if (payload?.type === "task_complete" && typeof payload.last_agent_message === "string") return payload.last_agent_message.trim();
    if (payload?.type === "agent_message" && typeof payload.message === "string" && fallback === null) fallback = payload.message.trim();
  }
  return fallback;
}

function parseLine(line: string): Record<string, unknown> | null {
  if (!line.startsWith("{")) return null;
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Where Claude Code files a session started in `cwd`: every character that is
 * not a letter or a digit made a dash. Only a first guess — a long path is
 * shortened with a hash in newer versions — so the caller looks everywhere
 * else when the file is not there.
 */
export function claudeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}
