/**
 * The test runs in a log's lines: a call that is one, and the one line that
 * says how it went.
 *
 * The usage reader parses two kinds of line in a Claude transcript and
 * passes over the rest unread, since tool output is nine tenths of the bytes
 * and is the user's projects. A test run needs exactly one line more than
 * that. The call is in an assistant line, which is parsed already; its result
 * is a tool-output line, which is not. So a call that classifies as a test
 * (`shared/testing.ts`) puts its own id among the needles the rest of the
 * file is searched for (`sweep.ts`), and the result's line is the only extra
 * one that ever becomes a string. What is taken off it is a time, an exit
 * code and three counts; the output is read for the counts here and goes no
 * further.
 *
 * A needle is an id, and an id can be quoted: an agent that reads a
 * transcript prints one. So a line that holds a needle is believed only if
 * it is the right kind of record with the id in the right field.
 *
 * Codex's rollouts get the same treatment and less trust. Its tool calls
 * have changed shape twice (a `shell` function with an argv, then
 * `exec_command`, then a script that calls `tools.exec_command`), so the
 * command is looked for in each and a call none of them explains is simply
 * not a run.
 */
import { classifyCommand, exitCodeIn, parseTestCounts, wasRefused, type TestCall, type TestCounts } from "../../../shared/testing";

const ID = /^[\w.:-]{1,128}$/;
const MAX_CWD = 1024;

/** The runs being waited on, by call id: a set, or a map keyed by it. */
export interface WaitingIds {
  has(id: string): boolean;
}

/** A call in an assistant line that is a test run. */
export interface TestCallSeen {
  callId: string;
  call: TestCall;
  background: boolean;
}

/** The Bash calls of one assistant record that are test runs. Pure. */
export function claudeTestCalls(record: Record<string, any>): TestCallSeen[] {
  const content = record.message?.content;
  if (!Array.isArray(content)) return [];
  const out: TestCallSeen[] = [];
  for (const block of content) {
    if (!block || block.type !== "tool_use" || block.name !== "Bash") continue;
    if (typeof block.id !== "string" || !ID.test(block.id)) continue;
    const call = classifyCommand(block.input?.command);
    if (call) out.push({ callId: block.id, call, background: block.input?.run_in_background === true });
  }
  return out;
}

/** What a later line said about a run the reader is waiting on. */
export type TestLineSeen =
  /** The call returned at once: the command is running behind it, and its end is a notice. */
  | { kind: "background"; sessionId: string | null; callId: string }
  | { kind: "end"; sessionId: string | null; callId: string; at: number; durationMs: number | null; exit: number | null; stopped: boolean; counts: TestCounts | null };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part && typeof part.text === "string" ? part.text : "")).join("\n");
}

/** Exit codes that are a signal's: the run was stopped by somebody, and did not fail. */
const SIGNALLED = new Set([130, 137, 143]);

/**
 * The notice that a command in the background finished, as the end of a run
 * being waited on. `<task-notification>…<tool-use-id>toolu_…</tool-use-id>…
 * <status>completed</status><summary>Background command "…" completed (exit
 * code 0)</summary>`. The exit code is read off the end of the summary,
 * after the command it quotes, which may say anything.
 */
function taskNotice(text: string, at: number, sessionId: string | null, waiting: WaitingIds): TestLineSeen | null {
  if (!text.startsWith("<task-notification>")) return null;
  const callId = /<tool-use-id>([\w.:-]{1,128})<\/tool-use-id>/.exec(text)?.[1];
  if (!callId || !waiting.has(callId)) return null;
  const status = /<status>([a-z_-]{1,24})<\/status>/.exec(text)?.[1] ?? "";
  // No status is a notice along the way (a monitor's event), not an end.
  if (!status) return null;
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1] ?? "";
  const said = /exit code (\d{1,3})\)?\s*$/i.exec(summary);
  const exit = said ? Number(said[1]) : status === "completed" ? 0 : status === "failed" ? 1 : null;
  const stopped = status === "killed" || status === "stopped" || status === "cancelled" || (exit !== null && SIGNALLED.has(exit));
  return { kind: "end", sessionId, callId, at, durationMs: null, exit: stopped ? null : exit, stopped, counts: null };
}

/**
 * A record that ends, or backgrounds, a run being waited on: the call's
 * `tool_result` in a `user` record, or the notice that a command in the
 * background finished, which Claude Code has written as a `user` record of
 * plain text and, since, as a `queue-operation` at the moment it finished
 * (and an `attachment` when it was shown). Null for any other line the id
 * happens to be in. Pure.
 */
export function claudeTestResult(record: Record<string, any>, waiting: WaitingIds): TestLineSeen | null {
  const at = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
  if (!Number.isFinite(at)) return null;
  const sessionId = typeof record.sessionId === "string" && ID.test(record.sessionId) ? record.sessionId : null;
  if (record.type === "queue-operation") return record.operation === "enqueue" && typeof record.content === "string" ? taskNotice(record.content, at, sessionId, waiting) : null;
  if (record.type === "attachment") return record.attachment?.type === "queued_command" && typeof record.attachment.prompt === "string" ? taskNotice(record.attachment.prompt, at, sessionId, waiting) : null;
  if (record.type !== "user") return null;
  const content = record.message?.content;

  if (typeof content === "string") return taskNotice(content, at, sessionId, waiting);

  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (!block || block.type !== "tool_result" || typeof block.tool_use_id !== "string" || !waiting.has(block.tool_use_id)) continue;
    const callId: string = block.tool_use_id;
    const result = record.toolUseResult;
    const said = textOf(block.content);
    if (result && typeof result === "object" && typeof result.backgroundTaskId === "string") return { kind: "background", sessionId, callId };
    if (block.is_error === true) {
      const refused = wasRefused(said);
      const exit = exitCodeIn(said);
      // An error with no exit code is a timeout or a crash of the tool, which is a failed run all the same.
      return { kind: "end", sessionId, callId, at, durationMs: null, exit: refused ? null : (exit ?? 1), stopped: refused, counts: refused ? null : parseTestCounts(said) };
    }
    const output = result && typeof result === "object" ? `${typeof result.stdout === "string" ? result.stdout : ""}\n${typeof result.stderr === "string" ? result.stderr : ""}` : said;
    return { kind: "end", sessionId, callId, at, durationMs: null, exit: 0, stopped: result?.interrupted === true, counts: parseTestCounts(output.trim() ? output : said) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

/** The lines of a rollout that are a tool being called. The comma keeps the `_output` records, which are most of the bytes, out. */
export const CODEX_CALL_NEEDLES = ['"type":"custom_tool_call",', '"type":"function_call",', '"type":"local_shell_call",'] as const;

function unquote(literal: string): string | null {
  if (literal.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(literal);
      return typeof parsed === "string" ? parsed : null;
    } catch {
      return null;
    }
  }
  return literal.slice(1, -1).replace(/\\(.)/g, "$1");
}

/** The shell command a Codex tool call runs, whichever of its shapes it is in, or null. */
function codexCommand(payload: Record<string, any>): string | null {
  if (payload.type === "local_shell_call") {
    const argv = payload.action?.command;
    return Array.isArray(argv) && argv.every((word) => typeof word === "string") ? argvLine(argv) : null;
  }
  if (payload.type === "function_call") {
    let args: Record<string, any>;
    try {
      args = JSON.parse(typeof payload.arguments === "string" ? payload.arguments : "");
    } catch {
      return null;
    }
    const said = args?.cmd ?? args?.command;
    if (typeof said === "string") return said;
    return Array.isArray(said) && said.every((word) => typeof word === "string") ? argvLine(said) : null;
  }
  if (payload.type === "custom_tool_call" && typeof payload.input === "string") {
    // A script: every `exec_command({ cmd: "…" })` in it is a command it runs.
    const found: string[] = [];
    for (const match of payload.input.slice(0, 16_384).matchAll(/exec_command\(\s*\{\s*(?:"cmd"|cmd)\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g)) {
      const command = unquote(match[1]!);
      if (command) found.push(command);
    }
    return found.length ? found.join("\n") : null;
  }
  return null;
}

/** `["bash", "-lc", "pnpm test"]` is the line inside it; any other argv is itself. */
function argvLine(argv: readonly string[]): string {
  if (argv.length === 3 && /(?:^|\/)(?:bash|sh|zsh)$/.test(argv[0]!) && /^-[a-z]*c$/.test(argv[1]!)) return argv[2]!;
  return argv.map((word) => (/[\s"'$&|;<>()]/.test(word) ? `'${word.replace(/'/g, "'\\''")}'` : word)).join(" ");
}

export type CodexTestLine =
  | { kind: "start"; callId: string; call: TestCall; at: number }
  | { kind: "end"; callId: string; at: number; durationMs: number | null; exit: number | null; counts: TestCounts | null }
  | null;

/**
 * One rollout record, as the start of a test run, the end of one being
 * waited on, or nothing. Pure.
 *
 * An output states its own wall time, which is the run's length without the
 * model's thinking in it, so it is taken over the gap between two lines.
 */
export function codexTestLine(record: Record<string, any>, waiting: WaitingIds): CodexTestLine {
  const payload = record.payload;
  if (record.type !== "response_item" || !payload || typeof payload !== "object") return null;
  const at = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
  const callId = payload.call_id;
  if (!Number.isFinite(at) || typeof callId !== "string" || !ID.test(callId)) return null;
  const type = typeof payload.type === "string" ? payload.type : "";
  if (type.endsWith("_output")) {
    if (!waiting.has(callId)) return null;
    let text = textOf(payload.output);
    let exit: number | null = null;
    let seconds: number | null = null;
    if (text.startsWith("{")) {
      // The older shape: `{"output": "…", "metadata": {"exit_code": 0, "duration_seconds": 1.2}}`.
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed?.output === "string") text = parsed.output;
        if (typeof parsed?.metadata?.exit_code === "number") exit = parsed.metadata.exit_code;
        if (typeof parsed?.metadata?.duration_seconds === "number") seconds = parsed.metadata.duration_seconds;
      } catch {
        // Output that merely opens with a brace.
      }
    }
    const head = text.slice(0, 2048);
    seconds ??= numberIn(/Wall time:? ([\d.]+) seconds/.exec(head)?.[1]);
    exit ??= numberIn(/(?:Exit code:?|exited with code|Process exited with code) (\d{1,3})\b/i.exec(head)?.[1]);
    return { kind: "end", callId, at, durationMs: seconds !== null && Number.isFinite(seconds) ? Math.round(seconds * 1000) : null, exit: exit !== null && Number.isInteger(exit) && exit >= 0 && exit <= 255 ? exit : null, counts: parseTestCounts(text) };
  }
  const command = codexCommand(payload);
  const call = command === null ? null : classifyCommand(command);
  return call ? { kind: "start", callId, call, at } : null;
}

function numberIn(text: string | undefined): number | null {
  if (text === undefined) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** A folder off a record, held to a sane length: it is a column, not a line of a transcript. */
export function cwdIn(value: unknown): string | null {
  return typeof value === "string" && value.length <= MAX_CWD ? value : null;
}
