/**
 * What an agent on another machine is doing, read off its screen.
 *
 * On this Mac an agent's status comes from two places: Claude Code's hooks,
 * which post to `/api/report` and are believed outright, and the host's guess
 * from the timing of its bytes (`agents/status.ts`), which is what a CLI
 * without hooks gets. An agent on a machine has neither worth having. Its
 * hooks would post to a port on the machine where nothing listens — getting
 * them back is a tunnel over the ssh, the later step `docs/machines.md`
 * describes — and its bytes are tmux redrawing a pane, where a status-bar
 * clock is output and a turn finishing is a spinner that stops.
 *
 * What it does have is a screen, and both CLIs put their state on it in
 * words. A turn in progress says "esc to interrupt" under the input (Claude
 * Code's footer, Codex's "Working" line), and Claude's spinner counts the
 * seconds above it. A permission prompt asks "Do you want to …?" or "Would
 * you like to …?" over a numbered list with the selection mark on a row of it;
 * Claude's question tool asks in its own words over the same list, with
 * "Enter to select" under it. A finished turn says none of these. So the
 * screen is read here and turned into the reports a hook would have made, and
 * `server/src/onscreen.ts` is what reads the screens and posts them.
 *
 * It is a heuristic and is written as one. It looks only at the bottom rows,
 * where both CLIs draw their state, only for words they have drawn for a year,
 * and what it cannot place is `quiet`, which changes nothing by itself. It is
 * worse than hooks in known ways — a prompt it does not recognise is not
 * `blocked`, a turn ends a poll or two after it did, and nothing says what the
 * agent was asked — and the tab says so rather than pretending otherwise.
 *
 * Pure, for the tests: no terminal and no timer in here.
 */
import type { AgentStatus } from "./model";

/**
 * What a screen shows. `missing` is kururu's own words rather than the CLI's
 * — the check saying it is not installed or not signed in (`AGENT_CHECK`), or
 * `LOOP_SCRIPT` saying it gave up reconnecting — read the same way because
 * both mean the same thing to whoever is deciding whether to sleep the card:
 * nothing is happening here until a person does something.
 */
export type ScreenPhase = "working" | "asking" | "quiet" | "missing";

export interface ScreenRead {
  phase: ScreenPhase;
  /** The question being asked, or what is missing, for the sidebar's second line. Null for the rest. */
  detail: string | null;
}

/**
 * How many rows up from the last that says anything to look. Claude's input
 * box and footer, a prompt with a long command in it, and Codex's approval
 * with its diff summary all fit; the scrollback above them is old turns,
 * which are where an earlier "Do you want to" would be found and wrongly
 * believed.
 *
 * Counted in rows with something on them, never rows of the screen. A fresh
 * agent draws at the *top* of a tall pane, with blank rows and tmux's status
 * line under it, and a window measured from the screen's bottom edge looks at
 * the blank rows and misses the agent — which is what the first version of
 * this did.
 */
const BOTTOM = 30;

/**
 * The same, for a turn in progress: Claude's spinner, its tip, the input
 * between its rules and the footer under them, or Codex's status line over
 * its composer — and tmux's status line below all of them.
 */
const FOOTER = 12;

const WORKING = /\besc to interrupt\b/i;
/** Claude Code's spinner: a glyph, a word ending in an ellipsis, then the clock — `✻ Puttering… (11m 19s · ↓ 68.0k tokens)`. */
const SPINNER = /^\s*[·✢✳✶✻✽*]\s+\S[^…]{0,40}…\s+\(\d/;
const QUESTION = /\b(?:Do you want to|Would you like to)\b[^?]{0,200}\?/;
/** The highlighted row of a list: Claude's `❯ 1.`, Codex's `› 1.`. An input line with "1." typed into it has no question with it. */
const CHOICE = /^\s*[❯›]\s*\d+\.\s+\S/;
/** Under Claude's question tool, which asks in the question's own words. */
const SELECT_HINT = /\bEnter to select\b/i;
/** What `AGENT_CHECK` prints, expanded — the typed line above it holds the same words with `$n` in them, and must not match. */
const MISSING = /^kururu: ((?:Claude Code|Codex) is not (?:installed|logged in) on .+?)\.(?:\s|$)/;
/** What `LOOP_SCRIPT` prints once ssh has failed three times running, waiting on Enter rather than retrying. */
const UNREACHABLE = /^kururu: (.+? has not answered in \d+ tries running)\.(?:\s|$)/;
/** Box edges a question may be drawn inside, taken off its ends. */
const FRAME = /^[\s│┃|╭╮╰╯─]+|[\s│┃|╭╮╰╯─]+$/g;

/** Read one screen, top to bottom, as `screenText` renders it. */
export function readScreen(text: string): ScreenRead {
  const lines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .slice(-BOTTOM);

  const asking = askingIn(lines);
  if (asking) return asking;
  // The footer and the spinner are the last few rows, and only those: a reply
  // above them that quotes "esc to interrupt" — an agent working on this file
  // would — is not a turn in progress.
  if (lines.slice(-FOOTER).some((line) => WORKING.test(line) || SPINNER.test(line))) return { phase: "working", detail: null };
  // The check's words, or the loop's giving-up line, then a shell prompt — and
  // tmux's status line — so only the last few rows: an agent started by hand
  // after the CLI was installed draws below them, and a reconnect that got
  // back in types over the line that said it hadn't.
  for (const line of lines.slice(-5)) {
    const trimmed = line.trim();
    const missing = MISSING.exec(trimmed) ?? UNREACHABLE.exec(trimmed);
    if (missing) return { phase: "missing", detail: missing[1]! };
  }
  return { phase: "quiet", detail: null };
}

/**
 * A choice with its mark on, and either a question above it or the question
 * tool's hint below. Both CLIs draw the question first and the list after,
 * Codex with the command between them, so the question is looked for up to a
 * dozen rows above the marked row — rows that say something, as everywhere
 * here.
 */
function askingIn(lines: string[]): ScreenRead | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!CHOICE.test(lines[i]!)) continue;
    for (let j = i - 1; j >= Math.max(0, i - 12); j--) {
      const question = QUESTION.exec(lines[j]!);
      if (question) return { phase: "asking", detail: question[0].replace(FRAME, "") };
    }
    const hinted = lines.slice(i + 1, i + 10).some((line) => SELECT_HINT.test(line));
    if (hinted) {
      // The tool's question is its own sentence; the nearest line above the
      // list that ends in a question mark is it, more often than not.
      for (let j = i - 1; j >= Math.max(0, i - 12); j--) {
        const line = lines[j]!.replace(FRAME, "");
        if (line.endsWith("?")) return { phase: "asking", detail: line.slice(0, 200) };
      }
      return { phase: "asking", detail: null };
    }
    return null;
  }
  return null;
}

/** Quiet readings in a row before a turn is called finished. A redraw caught half-way is one reading, not two. */
const QUIET_READS = 2;

/**
 * One agent's readings, turned into the status reports a hook would have
 * sent — on the edges, as a hook does, so a screen that holds still reports
 * nothing.
 *
 * Working and asking are reported on the first reading that shows them: a
 * spinner or a marked choice is never drawn by accident. A turn's end waits
 * for `QUIET_READS`, and is `done` only out of `working`; a prompt that went
 * away without a turn starting is `idle`, because the person who answered it
 * is the one who would be told.
 *
 * The first reading is told the host's status, because a server restart
 * starts a new watch on an agent the host has been keeping all along. A
 * `done` there is the last watch's word, and a quiet screen is no reason to
 * take it back. Anything else is reported, so that the host's own guess from
 * the bytes is switched off — one report does that for good — before it can
 * call tmux's redraws a turn.
 */
export class ScreenWatch {
  private phase: ScreenPhase | null = null;
  private quiet = 0;

  see(read: ScreenRead, current: AgentStatus): AgentStatus | null {
    const was = this.phase;
    if (read.phase !== "quiet") this.quiet = 0;
    switch (read.phase) {
      case "working":
        this.phase = "working";
        return was === "working" ? null : "working";
      case "asking":
      case "missing":
        this.phase = read.phase;
        if (was === read.phase) return null;
        return was === null && current === "blocked" ? null : "blocked";
      case "quiet":
        if (was === null) {
          this.phase = "quiet";
          return current === "done" ? null : "idle";
        }
        if (was === "quiet") return null;
        if (++this.quiet < QUIET_READS) return null;
        this.phase = "quiet";
        this.quiet = 0;
        return was === "working" ? "done" : "idle";
    }
  }
}
