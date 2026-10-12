/**
 * When a card's agent has sat idle long enough to be ended, and the two
 * readings in that which take judgement: whether a reply asked you something,
 * and whether there is half a message in its prompt.
 *
 * It exists for the battery. An agent between turns is a node process, its
 * MCP servers, and whatever Claude Code keeps polling, and a card in Review
 * can sit like that all afternoon with nobody reading it. Ending it costs
 * nothing that matters, because a card's run keeps its conversation's id —
 * Claude's from the start, Codex's once it has been read off the rollout — and
 * running the card again is `--resume` with it. The work is on disk and is
 * never touched; only the process goes.
 *
 * So the question is never "is it safe to end" but "is anybody using it", and
 * every answer that is not a plain no keeps it awake. Idle means all of:
 *
 * - the card's run has finished a turn and the terminal says so (`done`, or
 *   `idle` after it), never `working` and never `blocked`;
 * - nothing is on its screen asking — a permission prompt, a question, a
 *   turn still running (`readScreen`, the reading remote agents' status
 *   comes from), which is what catches Codex's approvals, since it has no
 *   hooks to report them;
 * - kururu is not holding a message to type into it;
 * - nobody has half-typed a message into its prompt (`draftAfter`);
 * - its last reply did not end by asking something (`asksYou`);
 * - no command it started is still running under it — a background build is
 *   work, and ending the agent would end it — and the CLI itself still is: a
 *   card's terminal whose agent exited is a shell, and never ended;
 * - and all of that for the whole stretch: the clock starts again on every
 *   status edge, every keystroke, and at every server start, since a server
 *   cannot vouch for a stretch it was not running for.
 *
 * Pure, for the tests; `server/src/sleep.ts` gathers the facts and acts.
 */
import type { AgentStatus } from "./model";
import type { RunState } from "./board";
import type { ScreenPhase } from "./onscreen";

/** How often the agents are looked over. A minute's slack on ten is nobody's battery. */
export const SLEEP_TICK_MS = 30_000;

/** What the cheap half needs: everything kururu already holds in memory. */
export interface IdleFacts {
  run: RunState;
  status: AgentStatus;
  /** The latest of: the turn's end, the last status edge, the last keystroke, the server's start. */
  quietSince: number;
  /** kururu has a message waiting to be typed into it. */
  holding: boolean;
  /** Characters typed into its prompt and not sent — see `draftAfter`. */
  draft: number;
}

/**
 * Why a card's agent is not idle, from what is in memory — or null when it
 * has been idle for `afterMs` and the slower readings are worth taking. The
 * order is the order of cost to whoever reads the reason, cheapest to explain
 * first.
 */
export function notIdle(facts: IdleFacts, now: number, afterMs: number): string | null {
  if (facts.status === "working" || facts.run === "working" || facts.run === "starting") return "working";
  if (facts.status === "blocked" || facts.run === "blocked") return "waiting on you: a prompt";
  if (facts.run !== "finished") return `its run is ${facts.run}`;
  if (facts.holding) return "waiting on you: a message is waiting to be typed into it";
  if (facts.draft > 0) return "waiting on you: something is typed into its prompt and not sent";
  const quiet = now - facts.quietSince;
  if (quiet < afterMs) return `idle ${minutes(quiet)} of ${minutes(afterMs)}`;
  return null;
}

/** What the slow half reads, each one only for an agent the cheap half has let through. */
export interface DeepFacts {
  /** Its screen, as `readScreen` reads it; null when it could not be read. */
  screen: ScreenPhase | null;
  /**
   * Its conversation: found (and with it the last reply, or null for none),
   * or not found — which keeps it awake, since a run whose conversation
   * cannot be found is one `--resume` cannot bring back.
   */
  conversation: { reply: string | null } | null;
  /** A command it started is still running under it. Null where that cannot be seen — an agent on a machine. */
  busy: boolean | null;
  /**
   * Its CLI is still running in the terminal. False is a card's agent that
   * has exited back to a shell prompt — a shell now, and somebody's to use.
   * Null where that cannot be seen.
   */
  agent: boolean | null;
}

/** Why it stays awake after all, or null for "end it". */
export function stillWanted(facts: DeepFacts): string | null {
  if (facts.screen === null) return "its screen could not be read";
  if (facts.screen === "working") return "working, by its screen";
  if (facts.screen === "asking" || facts.screen === "missing") return "waiting on you: a question on its screen";
  if (facts.agent === false) return "its agent has exited, and what is left is a shell";
  if (facts.busy) return "a command it started is still running";
  if (!facts.conversation) return "its conversation could not be found, so it could not be resumed";
  if (facts.conversation.reply !== null && asksYou(facts.conversation.reply)) return "waiting on you: its last reply asked something";
  return null;
}

function minutes(ms: number): string {
  return `${Math.max(0, Math.floor(ms / 60_000))} min`;
}

/**
 * Whether a reply ends by asking the person something.
 *
 * A sentence ending in a question mark in its last paragraph — or, when that
 * paragraph is a list, in the one over it, because an agent asking you to
 * choose puts the question above the choices: "Which do you want?" then
 * "1. … 2. …". Code is taken out first; a `?` in a regex or a URL's query is
 * not a question, and neither is a heading the reply answers under itself —
 * "**Does it need a rebuild?** No, …". Only the end, because a question
 * earlier in a summary —
 * "Why did it fail? The cache key …" — has been answered by the time the
 * reply stops. A rhetorical one in the last paragraph still counts, and that
 * is the cheap way to be wrong: an agent left awake costs some battery, one
 * ended with a question nobody saw costs the question.
 *
 * Which means "Want me to commit this?" counts, and agents end with that
 * often. It is asked, it is unanswered, and the person said that counts.
 */
export function asksYou(reply: string): boolean {
  const text = reply
    .replace(/```[\s\S]*?(?:```|$)/g, "\n\n")
    .replace(/`[^`\n]*`/g, "code")
    // A heading is the reply asking itself, and the answer is under it:
    // "## Why?" and a line that opens "**Does it need a rebuild?** No — …".
    .replace(/^#{1,6}\s.*$/gm, "")
    .replace(/^(\s*(?:[-*•+]\s+)?)\*\*[^*\n]+\?\*\*(?=\s*\S)/gm, "$1");
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const last = paragraphs.at(-1);
  if (!last) return false;
  const tail = isList(last) ? paragraphs.slice(-2) : [last];
  return tail.some((p) => QUESTION.test(p));
}

/** Every line a bullet or a numbered item: choices, not a sentence. */
function isList(paragraph: string): boolean {
  return paragraph.split("\n").every((line) => /^\s*(?:[-*•+]|\d+[.)])\s/.test(line));
}

/** A question mark that ends a sentence: before whitespace or the end, past any closing quote, bracket or emphasis. */
const QUESTION = /[?？]["'”’)\]*_]*(?=\s|$)/;

/**
 * How many characters are sitting in an agent's prompt, unsent, after the
 * person typed `data` into its terminal — the count before plus what this
 * adds, less what it deletes, and nothing after Enter, ^C or ^U.
 *
 * A count rather than a flag so that typing a letter and deleting it is not
 * a draft. It errs high and never low: ^W, the arrows and a cursor moved
 * back are not followed, so a prompt cleared by hand can look like it still
 * holds something, and the agent stays awake until its next turn. The other
 * error would end an agent holding a sentence somebody walked away from
 * half-way through, which `--resume` does not bring back.
 *
 * Escape sequences are not text: an arrow, a focus report, a mouse report
 * and a terminal's answer to a query all arrive on the same road as typing.
 * A bracketed paste is text, all of it — a pasted newline is not Enter. Alt
 * with a key is ESC and the key, and Alt-Enter is a new line in the prompt,
 * so it counts; a new turn starting clears the count too, which the server
 * does on the status edge.
 */
export function draftAfter(count: number, data: string): number {
  let n = Number.isFinite(count) && count > 0 ? count : 0;
  let i = 0;
  while (i < data.length) {
    const ch = data[i]!;
    if (ch === "\x1b") {
      if (data.startsWith("\x1b[200~", i)) {
        const end = data.indexOf("\x1b[201~", i + 6);
        n += [...(end < 0 ? data.slice(i + 6) : data.slice(i + 6, end))].length;
        i = end < 0 ? data.length : end + 6;
        continue;
      }
      i = skipEscape(data, i, () => n++);
      continue;
    }
    const code = ch.charCodeAt(0);
    if (ch === "\r" || ch === "\x03" || ch === "\x15") n = 0;
    else if (ch === "\x7f" || ch === "\b") n = Math.max(0, n - 1);
    else if (ch === "\n" || ch === "\t") n++;
    else if (code >= 0x20) {
      // A character outside the BMP is two code units and one character.
      if (code >= 0xd800 && code <= 0xdbff) i++;
      n++;
    }
    i++;
  }
  return n;
}

/**
 * The index just past the escape sequence at `i`. CSI runs to its final byte
 * (an X10 mouse report carries three raw bytes after it); OSC, DCS and the
 * like to BEL or ST; SS3 is one more byte; anything else is Alt and a key,
 * which is text only when the key is Enter.
 */
function skipEscape(data: string, i: number, newline: () => void): number {
  const next = data[i + 1];
  if (next === undefined) return i + 1;
  if (next === "[") {
    let j = i + 2;
    while (j < data.length && !/[\x40-\x7e]/.test(data[j]!)) j++;
    if (data[j] === "M" && j === i + 2) return Math.min(data.length, j + 4);
    return j + 1;
  }
  if (next === "]" || next === "P" || next === "_" || next === "^") {
    for (let j = i + 2; j < data.length; j++) {
      if (data[j] === "\x07") return j + 1;
      if (data[j] === "\x1b" && data[j + 1] === "\\") return j + 2;
    }
    return data.length;
  }
  if (next === "O") return i + 3;
  if (next === "\r") newline();
  return i + 2;
}

/**
 * Whether any process under an agent is a shell running a command — how both
 * CLIs run their tools. Claude Code's Bash tool is `zsh -c source <snapshot>
 * && eval '…'`, foreground and background alike; Codex's is `zsh -lc '…'`.
 * The pty's own root is left out by the caller: a card whose setup line runs
 * ahead of the agent is `sh -c '<setup> && claude …'`, and that shell is the
 * agent's frame, not a command it started.
 *
 * An MCP server started through a shell reads as a command, and keeps its
 * agent awake. That is the side to be wrong on.
 */
export function commandRunning(descendants: readonly string[]): boolean {
  return descendants.some((args) => SHELL_COMMAND.test(args));
}

const SHELL_COMMAND = /^(?:\S*\/)?-?(?:sh|bash|zsh|fish|dash|ksh)\s+(?:-[A-Za-z]*c[A-Za-z]*)\s/;
