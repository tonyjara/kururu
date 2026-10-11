import { describe, expect, it } from "bun:test";

import { readScreen, ScreenWatch, type ScreenRead } from "../../shared/onscreen";

/**
 * Screens as `screenText` renders them, in the shapes Claude Code 2.1 and
 * Codex 0.146 draw: the footer and spinner from a recording of a real Claude
 * turn, the prompts from the words both binaries carry.
 */
const RULE = "─".repeat(80);

const CLAUDE_WORKING = [
  "⏺ Reading the file now.",
  "",
  "✽ Puttering… (11m 19s · ↓ 68.0k tokens)",
  "  ⎿  Tip: Use /btw to ask a quick side question without interrupting Claude's current work",
  "",
  RULE,
  "❯ ",
  RULE,
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for agents",
].join("\n");

const CLAUDE_SPINNER_ONLY = ["⏺ Bash(bun test)", "", "✻ Flowing… (33s · ↓ 1.9k tokens · thought for 12s)", "", RULE, "❯ ", RULE].join("\n");

const CLAUDE_DONE = [
  "⏺ Fixed the off-by-one, and the tests pass.",
  "",
  "✻ Sautéed for 57s · done 3:33 PM",
  "",
  RULE,
  "❯ ",
  RULE,
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
].join("\n");

const CLAUDE_PERMISSION = [
  "⏺ Bash(git push --force)",
  "",
  RULE,
  " Bash command",
  "",
  "   git push --force",
  "   Push to the remote",
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, and don't ask again for git push commands in /home/omarchy/code",
  "   3. No, and tell Claude what to do differently (esc)",
].join("\n");

const CLAUDE_QUESTION = [
  " ☐ Database",
  "",
  "Which database should the service use?",
  "",
  "❯ 1. Postgres",
  "     The one already on the VPS",
  "  2. SQLite",
  "     A file beside the service",
  "  3. Type something.",
  "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
].join("\n");

const CODEX_WORKING = ["• Working (12s • esc to interrupt)", "", "› Ask Codex to do anything", "", "  ? for shortcuts                         100% context left"].join("\n");

const CODEX_APPROVAL = [
  "  Would you like to run the following command?",
  "",
  "  $ cargo test",
  "",
  "› 1. Yes, proceed (y)",
  "  2. Yes, and don't ask again for this command (a)",
  "  3. No, and tell Codex what to do differently (esc)",
  "",
  "  Press enter to confirm or esc to cancel",
].join("\n");

const MISSING = [
  `omarchy@omarchy ~/code$ sh -c 'c=$1; m=$2; if [ -z "$p" ]; then echo; echo "kururu: $n is not installed on $m. There is no $c on the PATH here."; fi' kururu claude 'omarchy1' && claude`,
  "",
  "kururu: Claude Code is not installed on omarchy1. There is no claude on the PATH here.",
  "kururu: install it in this tab, then start it again from the + menu.",
  "omarchy@omarchy ~/code$ ",
].join("\n");

describe("readScreen", () => {
  it("sees a turn in progress by Claude's footer, or by its spinner alone", () => {
    expect(readScreen(CLAUDE_WORKING).phase).toBe("working");
    expect(readScreen(CLAUDE_SPINNER_ONLY).phase).toBe("working");
  });

  it("finds a fresh agent at the top of a tall pane, over blank rows and tmux's status line", () => {
    const tall = [CLAUDE_WORKING, ...Array(31).fill(""), '[kururu-api-1:bash*            "✳ Fix the parser" 16:03 10-Oct-26'].join("\n");
    expect(readScreen(tall).phase).toBe("working");
    const missing = [MISSING, ...Array(31).fill(""), "[kururu-api-1:bash*            16:03 10-Oct-26"].join("\n");
    expect(readScreen(missing).phase).toBe("missing");
  });

  it("sees a finished turn as quiet: the clock has stopped and the footer lost its interrupt", () => {
    expect(readScreen(CLAUDE_DONE)).toEqual({ phase: "quiet", detail: null });
  });

  it("reads Claude's permission prompt and its question", () => {
    expect(readScreen(CLAUDE_PERMISSION)).toEqual({ phase: "asking", detail: "Do you want to proceed?" });
  });

  it("reads Claude's question tool by the hint under its list", () => {
    expect(readScreen(CLAUDE_QUESTION)).toEqual({ phase: "asking", detail: "Which database should the service use?" });
  });

  it("reads Codex working and Codex asking", () => {
    expect(readScreen(CODEX_WORKING).phase).toBe("working");
    expect(readScreen(CODEX_APPROVAL)).toEqual({ phase: "asking", detail: "Would you like to run the following command?" });
  });

  it("finds kururu's own check under the line that typed it, and not in it", () => {
    expect(readScreen(MISSING)).toEqual({ phase: "missing", detail: "Claude Code is not installed on omarchy1" });
    // The typed line alone — the check has not printed yet — is nothing.
    expect(readScreen(MISSING.split("\n")[0]!).phase).toBe("quiet");
    expect(readScreen("kururu: Codex is not logged in on db.example.com.\nkururu: Run codex login here, then start it again from the + menu.\n$ ").detail).toBe(
      "Codex is not logged in on db.example.com",
    );
  });

  it("does not take the check's words for news once an agent is drawing below them", () => {
    expect(readScreen(`${MISSING}\nclaude\n${CLAUDE_DONE}`).phase).toBe("quiet");
  });

  it("does not believe a reply that quotes the footer, above the footer", () => {
    const quoted = ["Claude's footer says esc to interrupt while it works.", ...Array(14).fill("more of the reply"), CLAUDE_DONE].join("\n");
    expect(readScreen(quoted).phase).toBe("quiet");
  });

  it("does not take a numbered input line for a prompt", () => {
    expect(readScreen([RULE, "❯ 1. make it faster", RULE, "  ? for shortcuts"].join("\n")).phase).toBe("quiet");
  });

  it("looks only at the bottom of the screen for a prompt", () => {
    const old = [CLAUDE_PERMISSION, ...Array(40).fill("⏺ later output"), CLAUDE_DONE].join("\n");
    expect(readScreen(old).phase).toBe("quiet");
  });
});

describe("ScreenWatch", () => {
  const read = (phase: ScreenRead["phase"]): ScreenRead => ({ phase, detail: null });

  it("reports a turn: working at once, done after two quiet readings, then nothing", () => {
    const watch = new ScreenWatch();
    expect(watch.see(read("quiet"), "idle")).toBe("idle");
    expect(watch.see(read("working"), "idle")).toBe("working");
    expect(watch.see(read("working"), "working")).toBeNull();
    expect(watch.see(read("quiet"), "working")).toBeNull();
    expect(watch.see(read("quiet"), "working")).toBe("done");
    expect(watch.see(read("quiet"), "done")).toBeNull();
  });

  it("does not end a turn on one quiet reading between two busy ones", () => {
    const watch = new ScreenWatch();
    watch.see(read("working"), "idle");
    expect(watch.see(read("quiet"), "working")).toBeNull();
    expect(watch.see(read("working"), "working")).toBeNull();
    expect(watch.see(read("quiet"), "working")).toBeNull();
  });

  it("reports a prompt as blocked, and its going as idle rather than done", () => {
    const watch = new ScreenWatch();
    watch.see(read("working"), "idle");
    expect(watch.see(read("asking"), "working")).toBe("blocked");
    expect(watch.see(read("asking"), "blocked")).toBeNull();
    expect(watch.see(read("working"), "idle")).toBe("working");
    expect(watch.see(read("asking"), "working")).toBe("blocked");
    watch.see(read("quiet"), "idle");
    expect(watch.see(read("quiet"), "idle")).toBe("idle");
  });

  it("reports a missing CLI as blocked", () => {
    expect(new ScreenWatch().see(read("missing"), "idle")).toBe("blocked");
  });

  it("leaves what the host holds alone on a first reading after a restart", () => {
    // A server restart begins a new watch; `done` was the last watch's word.
    expect(new ScreenWatch().see(read("quiet"), "done")).toBeNull();
    expect(new ScreenWatch().see(read("asking"), "blocked")).toBeNull();
    // A guess from the bytes is taken back, and the guessing switched off.
    expect(new ScreenWatch().see(read("quiet"), "working")).toBe("idle");
    expect(new ScreenWatch().see(read("working"), "working")).toBe("working");
  });
});
