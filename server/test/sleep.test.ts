/**
 * Putting an idle card's agent to sleep: the rule for idle, the two readings
 * that take judgement, and the files a conversation is found in.
 *
 * Every case here that keeps an agent awake is one where ending it would cost
 * somebody something — a question unanswered, a sentence half-typed, a build
 * running — so the tests lean on those, and on the board saying "asleep"
 * rather than "ended" whichever order the kill and the exit arrive in.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addCard, adoptBoard, canResume, emptyBoard, noteRun, runLive, setRunSession, sleepRun, startRun, type Board } from "../../shared/board";
import {
  claudeLastReply,
  claudeProjectDir,
  codexLastReply,
  codexRolloutHead,
  parseRolloutListing,
  pickCodexRollout,
  ROLLOUT_MARK,
  type CodexRollout,
} from "../../shared/sessions";
import { asksYou, commandRunning, draftAfter, notIdle, stillWanted, type IdleFacts } from "../../shared/sleep";
import { claudeTranscriptPath, codexRolloutPath, findCodexRollout } from "../src/sessions";
import { Workspaces } from "../src/workspaces";

const MIN = 60_000;

describe("notIdle", () => {
  const facts = (over: Partial<IdleFacts> = {}): IdleFacts => ({
    run: "finished",
    status: "done",
    quietSince: 0,
    holding: false,
    draft: 0,
    ...over,
  });

  it("lets through a finished turn that has been quiet past the setting", () => {
    expect(notIdle(facts(), 10 * MIN, 10 * MIN)).toBeNull();
    // A keystroke after the turn ended leaves the terminal `idle` and the run `finished`.
    expect(notIdle(facts({ status: "idle" }), 10 * MIN, 10 * MIN)).toBeNull();
  });

  it("counts the quiet from the latest thing that happened", () => {
    expect(notIdle(facts({ quietSince: 4 * MIN }), 10 * MIN, 10 * MIN)).toBe("idle 6 min of 10 min");
  });

  it("never ends a turn in progress, a prompt, or a run that never finished one", () => {
    expect(notIdle(facts({ status: "working" }), 99 * MIN, MIN)).toBe("working");
    expect(notIdle(facts({ run: "starting", status: "idle" }), 99 * MIN, MIN)).toBe("working");
    expect(notIdle(facts({ status: "blocked" }), 99 * MIN, MIN)).toMatch(/waiting on you/);
    expect(notIdle(facts({ run: "blocked", status: "idle" }), 99 * MIN, MIN)).toMatch(/waiting on you/);
    expect(notIdle(facts({ run: "ended" }), 99 * MIN, MIN)).toMatch(/ended/);
  });

  it("waits on a message kururu is holding for it, and on a draft in its prompt", () => {
    expect(notIdle(facts({ holding: true }), 99 * MIN, MIN)).toMatch(/message is waiting/);
    expect(notIdle(facts({ draft: 3 }), 99 * MIN, MIN)).toMatch(/typed into its prompt/);
  });
});

describe("stillWanted", () => {
  const ok = { screen: "quiet" as const, conversation: { reply: "Done. The tests pass." }, busy: false, agent: true };

  it("ends a quiet one whose conversation is there and asked nothing", () => {
    expect(stillWanted(ok)).toBeNull();
    expect(stillWanted({ ...ok, busy: null, agent: null })).toBeNull();
    expect(stillWanted({ ...ok, conversation: { reply: null } })).toBeNull();
  });

  it("keeps awake what its screen, its processes or its last reply say is still wanted", () => {
    expect(stillWanted({ ...ok, screen: "asking" })).toMatch(/question on its screen/);
    expect(stillWanted({ ...ok, screen: "working" })).toMatch(/working/);
    expect(stillWanted({ ...ok, screen: null })).toMatch(/could not be read/);
    expect(stillWanted({ ...ok, busy: true })).toMatch(/still running/);
    expect(stillWanted({ ...ok, agent: false })).toMatch(/what is left is a shell/);
    expect(stillWanted({ ...ok, conversation: { reply: "Should I merge it?" } })).toMatch(/asked something/);
  });

  it("never ends one whose conversation cannot be found, since there would be nothing to resume", () => {
    expect(stillWanted({ ...ok, conversation: null })).toMatch(/could not be found/);
  });
});

describe("asksYou", () => {
  it("hears a question at the end", () => {
    expect(asksYou("I fixed the flaky test.\n\nWant me to commit it?")).toBe(true);
    expect(asksYou("Done. Should I also update the docs?")).toBe(true);
    expect(asksYou("¿Lo subo a main?")).toBe(true);
    expect(asksYou('Which name do you prefer — "Sleep" or "Nap"?')).toBe(true);
    expect(asksYou("**Ready to merge?**")).toBe(true);
  });

  it("hears the question over a list of choices", () => {
    expect(asksYou("Two ways to do it. Which do you want?\n\n1. A cron\n2. A watcher")).toBe(true);
  });

  it("hears one in the last paragraph even with a sentence after it", () => {
    expect(asksYou("Done.\n\nShould I merge it? I can rebase first if you prefer.")).toBe(true);
  });

  it("does not hear one that was answered, or one far up the reply", () => {
    expect(asksYou("Why did it fail? The cache key ignored the locale.\n\nFixed and tested.")).toBe(false);
    expect(asksYou("Should I use a map?\n\nI did.\n\nIt works.\n\nAll tests pass.")).toBe(false);
    expect(asksYou("Which file?\n\nThe one in src. Fixed it.")).toBe(false);
  });

  it("does not hear a heading the reply answers under itself", () => {
    expect(asksYou("Done.\n\n**Does it need a rebuild?** No build step — these are plain files.")).toBe(false);
    expect(asksYou("- **Restart needed?** Only the server.")).toBe(false);
    expect(asksYou("Done.\n\n## What next?")).toBe(false);
    // A bold question with nothing after it is asking.
    expect(asksYou("Done.\n\n**Merge it?**")).toBe(true);
  });

  it("does not take code, a URL or a regex for a question", () => {
    expect(asksYou("Changed the pattern to `^a?b$` and the link to https://x.dev/?q=1")).toBe(false);
    expect(asksYou("Done:\n\n```ts\nconst x = a ? b : c?.d;\n```")).toBe(false);
    expect(asksYou("The tests pass.")).toBe(false);
    expect(asksYou("")).toBe(false);
  });
});

describe("draftAfter", () => {
  it("counts what is typed, takes off what is deleted, and empties on Enter, ^C and ^U", () => {
    expect(draftAfter(0, "fix it")).toBe(6);
    expect(draftAfter(6, "\x7f\x7f")).toBe(4);
    expect(draftAfter(4, "\r")).toBe(0);
    expect(draftAfter(4, "\x03")).toBe(0);
    expect(draftAfter(4, "\x15")).toBe(0);
    expect(draftAfter(0, "\x7f")).toBe(0);
    expect(draftAfter(0, "yes\r")).toBe(0);
    expect(draftAfter(0, "one\rtwo")).toBe(3);
  });

  it("does not count escape sequences as text", () => {
    expect(draftAfter(0, "\x1b[A\x1b[B\x1bOP")).toBe(0);
    expect(draftAfter(0, "\x1b[<0;10;5M\x1b[<0;10;5m")).toBe(0);
    // An X10 mouse report: three raw bytes after `ESC [ M`.
    expect(draftAfter(0, "\x1b[M !!")).toBe(0);
    expect(draftAfter(0, "\x1b[I\x1b[O")).toBe(0);
    expect(draftAfter(0, "\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\")).toBe(0);
    expect(draftAfter(0, "\x1b]10;rgb:ffff/ffff/ffff\x07")).toBe(0);
    expect(draftAfter(0, "\x1b")).toBe(0);
  });

  it("counts a paste as text whole, newlines and all, and Alt-Enter as a new line", () => {
    expect(draftAfter(0, "\x1b[200~line one\rline two\x1b[201~")).toBe(17);
    expect(draftAfter(2, "\x1b\r")).toBe(3);
  });

  it("counts a character, not a code unit", () => {
    expect(draftAfter(0, "🐸é")).toBe(2);
  });

  it("never comes back below zero or as NaN", () => {
    expect(draftAfter(Number.NaN, "a")).toBe(1);
    expect(draftAfter(-5, "a")).toBe(1);
  });
});

describe("commandRunning", () => {
  it("sees a tool command under either CLI", () => {
    expect(commandRunning(["/bin/zsh -c source /Users/x/.claude/shell-snapshots/snapshot-zsh-1.sh && eval 'npm test'"])).toBe(true);
    expect(commandRunning(["/bin/zsh -lc 'cargo build'"])).toBe(true);
    expect(commandRunning(["bash -c sleep 100"])).toBe(true);
  });

  it("does not see an MCP server, caffeinate, or a login shell", () => {
    expect(commandRunning(["/usr/bin/node /x/mcp/dist/index.js", "caffeinate -i -t 300", "-zsh", "/bin/zsh -l"])).toBe(false);
    expect(commandRunning([])).toBe(false);
  });
});

describe("a run put to sleep", () => {
  const id = "0b6c2f1e-8d7a-4c3b-9e2f-1a2b3c4d5e6f";
  const ran = (): Board =>
    noteRun(
      startRun(addCard(emptyBoard(), { title: "flaky test" }, "c0", 0), "c0", { agentId: "a1", launcher: "claude", label: "Claude", startedAt: 1, sessionId: id }),
      "a1",
      "done",
      false,
      2,
    );

  it("says asleep, keeps its conversation and its column, and is not live", () => {
    const board = sleepRun(ran(), "c0", 5);
    const card = board.cards[0]!;
    expect(card.column).toBe("review");
    expect(card.run).toMatchObject({ state: "asleep", agentId: null, sessionId: id, endedAt: 5 });
    expect(runLive(card.run)).toBe(false);
    expect(canResume(card.run, false)).toBe(true);
  });

  it("stays asleep when the exit arrives after, and through a cold start", () => {
    const board = sleepRun(ran(), "c0", 5);
    expect(noteRun(board, "a1", "", true, 6)).toBe(board);
    const back = adoptBoard(JSON.parse(JSON.stringify(board)));
    expect(back?.cards[0]?.run?.state).toBe("asleep");
  });

  it("takes a Codex id once, onto the run still in that terminal", () => {
    const codex = startRun(addCard(emptyBoard(), { title: "t" }, "c0", 0), "c0", { agentId: "a2", launcher: "codex", label: "Codex", startedAt: 1 });
    const codexId = "019faf87-0908-7651-848d-3b993fa540d3";
    const learned = setRunSession(codex, "c0", "a2", codexId);
    expect(learned.cards[0]?.run?.sessionId).toBe(codexId);
    expect(setRunSession(learned, "c0", "a2", "019faf87-0908-7651-848d-000000000000")).toBe(learned);
    expect(setRunSession(codex, "c0", "a9", codexId)).toBe(codex);
    expect(setRunSession(codex, "c0", "a2", "not a uuid")).toBe(codex);
  });
});

// ---------------------------------------------------------------------------
// The files
// ---------------------------------------------------------------------------

const CODEX_ID = "019faf87-0908-7651-848d-3b993fa540d3";

/** A rollout's head as Codex 0.146 writes it, instructions and all. */
function rolloutLines(id: string, cwd: string, at: string, prompt: string): string[] {
  return [
    JSON.stringify({
      timestamp: at,
      type: "session_meta",
      payload: { session_id: id, id, timestamp: at, cwd, originator: "codex-tui", cli_version: "0.146.0", base_instructions: { text: "You are Codex. ".repeat(2000) } },
    }),
    JSON.stringify({ timestamp: at, type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }),
    JSON.stringify({ timestamp: at, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>" }] } }),
    JSON.stringify({ timestamp: at, type: "event_msg", payload: { type: "user_message", message: prompt, images: [] } }),
    JSON.stringify({ timestamp: at, type: "event_msg", payload: { type: "agent_message", message: "Looking." } }),
    JSON.stringify({ timestamp: at, type: "event_msg", payload: { type: "task_complete", turn_id: "t1", last_agent_message: "Fixed it. Shall I open a PR?" } }),
  ];
}

describe("codex rollouts", () => {
  const prompt = "Fix the flaky test\n\nIt fails on CI only, in the sharded run.";

  it("reads a head, and one cut short as a machine sends it", () => {
    const lines = rolloutLines(CODEX_ID, "/repo/a", "2026-10-11T12:00:00.000Z", prompt);
    const userLine = lines.find((l) => l.includes('"user_message"'))!;
    expect(codexRolloutHead(lines[0]!, userLine)).toEqual({ id: CODEX_ID, cwd: "/repo/a", at: Date.parse("2026-10-11T12:00:00.000Z"), prompt });
    const cut = codexRolloutHead(lines[0]!.slice(0, 3000), userLine.slice(0, 120));
    expect(cut?.id).toBe(CODEX_ID);
    expect(cut?.prompt?.length).toBeGreaterThan(0);
    expect(prompt.startsWith(cut!.prompt!)).toBe(true);
    expect(codexRolloutHead('{"type":"event_msg"}', null)).toBeNull();
  });

  it("picks the card's own: after it started, in its directory, opened with its words, not taken", () => {
    const at = (iso: string) => Date.parse(iso);
    const r = (id: string, cwd: string, iso: string, words: string): CodexRollout => ({ id, cwd, at: at(iso), prompt: words });
    const mine = r(CODEX_ID, "/repo/a", "2026-10-11T12:00:05Z", prompt);
    const rollouts = [
      r("019faf87-0000-7651-848d-000000000001", "/repo/a", "2026-10-11T11:00:00Z", prompt), // an earlier run of the same card
      r("019faf87-0000-7651-848d-000000000002", "/repo/b", "2026-10-11T12:00:06Z", prompt), // somewhere else
      r("019faf87-0000-7651-848d-000000000003", "/repo/a", "2026-10-11T12:00:07Z", "something else entirely"),
      mine,
    ];
    const run = { startedAt: at("2026-10-11T12:00:00Z"), cwd: "/repo/a", prompt };
    expect(pickCodexRollout(rollouts, run, new Set())?.id).toBe(CODEX_ID);
    expect(pickCodexRollout(rollouts, run, new Set([CODEX_ID]))).toBeNull();
    // On a machine the directory is not known, and the words and the time decide.
    expect(pickCodexRollout(rollouts, { ...run, cwd: null }, new Set())?.id).toBe(CODEX_ID);
    expect(pickCodexRollout(rollouts, { ...run, prompt: "   " }, new Set())).toBeNull();
  });

  it("reads a machine's listing back", () => {
    const lines = rolloutLines(CODEX_ID, "/home/u/api", "2026-10-11T12:00:00.000Z", prompt);
    const listing = `${ROLLOUT_MARK}\n${lines[0]!.slice(0, 3000)}\n${lines[3]!.slice(0, 6000)}\n${ROLLOUT_MARK}\ngarbage\n`;
    const read = parseRolloutListing(listing);
    expect(read).toHaveLength(1);
    expect(read[0]).toMatchObject({ id: CODEX_ID, cwd: "/home/u/api", prompt });
  });

  it("reads the last reply off the tail", () => {
    const tail = rolloutLines(CODEX_ID, "/r", "2026-10-11T12:00:00.000Z", prompt).join("\n");
    expect(codexLastReply(tail.slice(400))).toBe("Fixed it. Shall I open a PR?");
    const noComplete = rolloutLines(CODEX_ID, "/r", "2026-10-11T12:00:00.000Z", prompt).slice(0, 5).join("\n");
    expect(codexLastReply(noComplete)).toBe("Looking.");
  });

  it("finds a run's rollout on disk, and finds it again by id", async () => {
    const home = mkdtempSync(join(tmpdir(), "kururu-codex-"));
    const started = Date.now() - 5 * MIN;
    const day = new Date(started);
    const dir = join(home, "sessions", String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"));
    mkdirSync(dir, { recursive: true });
    const iso = new Date(started + 3000).toISOString();
    const file = join(dir, `rollout-2026-10-11T12-00-03-${CODEX_ID}.jsonl`);
    writeFileSync(file, rolloutLines(CODEX_ID, "/repo/a", iso, prompt).join("\n") + "\n");
    const other = join(dir, "rollout-2026-10-11T12-00-04-019faf87-0000-7651-848d-000000000009.jsonl");
    writeFileSync(other, rolloutLines("019faf87-0000-7651-848d-000000000009", "/repo/a", iso, "a different card").join("\n") + "\n");
    // One from yesterday that has not been touched since is not even opened.
    const old = join(dir, "rollout-old-019faf87-0000-7651-848d-000000000008.jsonl");
    writeFileSync(old, rolloutLines("019faf87-0000-7651-848d-000000000008", "/repo/a", iso, prompt).join("\n") + "\n");
    utimesSync(old, new Date(started - 3 * 3600_000), new Date(started - 3 * 3600_000));

    const found = await findCodexRollout(home, { startedAt: started, cwd: "/repo/a", prompt }, new Set());
    expect(found).toEqual({ id: CODEX_ID, path: file });
    expect(await codexRolloutPath(home, CODEX_ID, started)).toBe(file);
    expect(await codexRolloutPath(home, "../../etc/passwd", started)).toBeNull();
  });
});

describe("claude transcripts", () => {
  const line = (entry: unknown) => JSON.stringify(entry);
  const tail = [
    '{"type":"assistant","message":{"id":"m0","content":[{"type":"text","text":"cut off at the fr', // a tail read cuts the first line
    line({ type: "user", message: { role: "user", content: "fix it" } }),
    line({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Looking." }] } }),
    line({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", name: "Bash" }] } }),
    line({ type: "user", message: { role: "user", content: [{ type: "tool_result" }] } }),
    line({ type: "assistant", message: { id: "m2", content: [{ type: "thinking", thinking: "…" }] } }),
    line({ type: "assistant", message: { id: "m2", content: [{ type: "text", text: "Fixed." }] } }),
    line({ type: "assistant", message: { id: "m2", content: [{ type: "text", text: "Want me to commit?" }] } }),
    line({ type: "system", subtype: "stop_hook_summary" }),
  ].join("\n");

  it("reads every text block of the last message, and nothing before it", () => {
    expect(claudeLastReply(tail)).toBe("Fixed.\n\nWant me to commit?");
    expect(claudeLastReply("")).toBeNull();
  });

  it("names a project directory the way Claude Code does", () => {
    expect(claudeProjectDir("/Users/me/Desktop/Nyto/kururu.worktrees/fix-1")).toBe("-Users-me-Desktop-Nyto-kururu-worktrees-fix-1");
  });

  it("finds a transcript by id, under its directory or any other", async () => {
    const config = mkdtempSync(join(tmpdir(), "kururu-claude-"));
    const id = "0b6c2f1e-8d7a-4c3b-9e2f-1a2b3c4d5e6f";
    const guessed = join(config, "projects", claudeProjectDir("/repo/a"));
    mkdirSync(guessed, { recursive: true });
    writeFileSync(join(guessed, `${id}.jsonl`), tail);
    expect(await claudeTranscriptPath(config, id, "/repo/a", null)).toBe(join(guessed, `${id}.jsonl`));
    // A cwd that was not kept, or a directory Claude Code shortened: found by looking.
    expect(await claudeTranscriptPath(config, id, null, null)).toBe(join(guessed, `${id}.jsonl`));
    expect(await claudeTranscriptPath(config, "0b6c2f1e-8d7a-4c3b-9e2f-000000000000", "/repo/a", null)).toBeNull();
    expect(await claudeTranscriptPath(config, "../x", "/repo/a", null)).toBeNull();
  });
});

describe("Workspaces and a card's run", () => {
  it("lists only cards with a terminal, learns a Codex id, and puts a run to sleep once", () => {
    const w = new Workspaces();
    const profileId = w.active.id;
    const workspaceId = w.activeWorkspace.id;
    w.ensureBoardIn(profileId, workspaceId);
    w.editBoardIn(profileId, workspaceId, (b) =>
      startRun(addCard(addCard(b, { title: "run" }, "c0", 0), { title: "idle" }, "c1", 0), "c0", { agentId: "a1", launcher: "codex", label: "Codex", startedAt: 1 }),
    );
    expect(w.cardRuns().map((at) => at.card.id)).toEqual(["c0"]);
    w.noteRunSession("a1", CODEX_ID);
    expect(w.cardSessions().has(CODEX_ID)).toBe(true);
    w.noteRun("a1", "done", false);
    expect(w.sleepRunOf("a1")).toBe(true);
    expect(w.findCardIn(profileId, workspaceId, "c0")?.card.run).toMatchObject({ state: "asleep", agentId: null, sessionId: CODEX_ID });
    expect(w.cardRuns()).toEqual([]);
    expect(w.sleepRunOf("a1")).toBe(false);
  });
});
