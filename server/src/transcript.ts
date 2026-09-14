/**
 * How full a Claude Code agent's context window is, read from the transcript it
 * writes as it goes.
 *
 * Ported from ghosttown's `src/core/transcript.ts`, for the same reason
 * `status.ts` and `procs.ts` were: the number is already right there, and two
 * spellings of "how full is it" would disagree about the one case that matters —
 * a session whose model changed halfway through. The parsing is verbatim. Only
 * the file reading is new, because `Bun.file().slice()` has no Node equivalent
 * that is also a one-liner.
 *
 * Claude Code hands every hook a `transcript_path` on stdin, so the report we
 * already accept at `POST /api/report` can carry this for free; see
 * `report-cli.ts`, which is the thing a hook actually runs. The file is JSONL,
 * one record per line, and the two numbers we need sit at opposite ends of it:
 * the model announces itself a few records in, the token counts are on the last
 * assistant line. So we read both ends and nothing in between — transcripts run
 * to megabytes, and a hook must never be the reason a turn feels slow.
 *
 * It lives in `server/src/` rather than next to `report.ts` in `agents/`, which
 * is where it belongs by subject matter, because `agents/` is the pty host's and
 * everything in there costs the user their agents to edit. Nothing here touches
 * a pty: it reads a file somebody else wrote. Putting it in the host's half
 * would have bought a restart for every tweak to a regex.
 */
import { open, stat } from "node:fs/promises";

import type { ContextUsage } from "../../shared/model";

/** Every current model, unless its id says otherwise. */
export const STANDARD_WINDOW = 200_000;
/** What a `[1m]` on the model id buys. */
export const LONG_WINDOW = 1_000_000;

/**
 * Enough of the end to hold the last assistant record, which carries the whole
 * reply and can be large, plus room to land mid-record and still find it.
 */
const TAIL_BYTES = 256 * 1024;
/** Enough of the start to hold the model attachment, which lands ~3KB in. */
const HEAD_BYTES = 64 * 1024;

/**
 * The window a model id means. Only the `[1m]` suffix moves it: the plain ids
 * are all 200k, and a model we have never heard of is likelier to be one of
 * those than a long-window one — guessing high would quietly report an agent as
 * having five times the room it has.
 */
export function windowFor(modelId: string): number {
  return /\[1m\]/i.test(modelId) ? LONG_WINDOW : STANDARD_WINDOW;
}

/** `claude-opus-5[1m]` and `claude-opus-5` are the same model, differently sized. */
function baseModel(id: string): string {
  return id.replace(/\[[^\]]*\]/g, "").trim();
}

function tokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The last thing the main thread sent, and what it cost.
 *
 * Backwards, because the answer is at the end and every line before it is work
 * we would throw away. Sidechains are skipped: a subagent's turn is recorded in
 * the same file but runs in a window of its own, and counting it would make the
 * sidebar say an agent had filled up when what filled up has already exited.
 *
 * Lines that will not parse are skipped rather than fatal — the first one in a
 * tail read is a fragment by definition, and a transcript being appended to as
 * we read can end in a half-written one.
 */
function lastMainUsage(tail: string): { used: number; model: string } | null {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.startsWith("{")) continue;
    let rec: Record<string, any>;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type !== "assistant" || rec.isSidechain) continue;
    const usage = rec.message?.usage;
    if (!usage || typeof usage !== "object") continue;
    // The prompt, both caches and the reply: the reply is in because it is part
    // of what the *next* request sends, which is the number worth watching.
    const used =
      tokens(usage.input_tokens) +
      tokens(usage.cache_creation_input_tokens) +
      tokens(usage.cache_read_input_tokens) +
      tokens(usage.output_tokens);
    if (used <= 0) continue; // an errored turn bills nothing and proves nothing
    const model = typeof rec.message?.model === "string" ? rec.message.model : "";
    return { used, model };
  }
  return null;
}

/** The last model id announced in this stretch of transcript, if any. */
function lastModelId(text: string): string | null {
  const ids = [...text.matchAll(/"modelId"\s*:\s*"([^"]+)"/g)];
  return ids.length > 0 ? ids[ids.length - 1]![1]! : null;
}

/**
 * Both ends of the transcript, reconciled.
 *
 * The assistant line says *which* model replied, but under its plain name — a
 * 1M session records `claude-opus-5` there just as a 200k one does. Only the
 * model attachment carries the `[1m]`, and it is written once, near the top.
 * So the id is only allowed to set the window when it is an id for the model
 * that actually replied; if the session has since switched models, the plain
 * name wins and we size it as standard. Wrong by being conservative, rather
 * than by claiming a window the agent does not have.
 */
export function contextFrom(head: string, tail: string): ContextUsage | null {
  const usage = lastMainUsage(tail);
  if (!usage) return null;
  const announced = lastModelId(tail) ?? lastModelId(head);
  const matches = announced && usage.model && baseModel(announced) === baseModel(usage.model);
  return { used: usage.used, window: windowFor(matches ? announced! : usage.model) };
}

/**
 * Read a transcript's two ends and say how full its window is, or null for
 * anything we cannot answer from — no such file, a session that has not had a
 * reply yet, a format that has moved on. Null is a blank column in the sidebar,
 * never a wrong number.
 */
export async function readContext(path: string): Promise<ContextUsage | null> {
  let file;
  try {
    const size = (await stat(path)).size;
    if (!size) return null;
    file = await open(path, "r");
    const tail = await slice(file, Math.max(0, size - TAIL_BYTES), size);
    // A file that fits in one read is its own head: skip the second one.
    const head = size <= TAIL_BYTES ? tail : await slice(file, 0, HEAD_BYTES);
    return contextFrom(head, tail);
  } catch {
    return null;
  } finally {
    await file?.close().catch(() => {});
  }
}

/**
 * One range of a file as text. Decoded whole rather than streamed, because both
 * ranges are bounded above and a partial multi-byte character at the seam is
 * harmless here: it can only corrupt the fragment line, which the parser was
 * already going to throw away.
 */
async function slice(file: Awaited<ReturnType<typeof open>>, from: number, to: number): Promise<string> {
  const length = Math.max(0, to - from);
  if (length === 0) return "";
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await file.read(buffer, 0, length, from);
  return buffer.subarray(0, bytesRead).toString("utf8");
}

/** `19%` — how much of the window is gone, which is the way round people ask. */
export function contextPercent(ctx: ContextUsage): number {
  if (ctx.window <= 0) return 0;
  return Math.min(100, Math.round((ctx.used / ctx.window) * 100));
}
