/**
 * An automation: a name, a schedule, a task, and the rules for when a slot
 * runs, which the server's clock (`server/src/automations.ts`) and, later, a
 * machine's script both follow. See `docs/plans/automations.md`.
 *
 * **The definition is a Markdown file.** Flat `key: value` frontmatter and the
 * prompt or the command as its body, read by the short parser below so the
 * server takes no YAML dependency. The database keeps the text as approved
 * and runs that; a file is how an automation travels, and nothing a file says
 * switches one on. What is *not* in the file — where it runs, whether it is
 * on, its past runs — is a fact about an installation, so the same file in a
 * repository cloned on three hosts cannot fire three times.
 *
 * **When a slot runs** is one pure rule, `decide`: on time within two
 * minutes, once and late within the catch-up window, written `missed`
 * beyond it, `skipped` while the last run is still going, and never early.
 * Every one of those is a row in the history, so "why did it not run on
 * Monday" is answered on screen.
 *
 * **How a run ended** is read off the agent's last reply (`verdictOf`), which
 * it is asked to end with one `RESULT:` line. A reply without one is a
 * finding, on the principle that a doubt tells you.
 */
import { findLauncher } from "./launchers";
import { dailyOrSlower, parseSchedule, type Schedule } from "./schedule";
import { shq } from "./text";

export type AutomationTask = "agent" | "shell" | "card";
export type Tell = "never" | "failure" | "finding" | "always";
export type Permissions = "profile" | "ask" | "auto";

export const TELLS: readonly Tell[] = ["never", "failure", "finding", "always"];

/** A run's state. `running` and `asking` are live; the rest are how it ended, or why it never started. */
export type RunState = "running" | "asking" | "ok" | "finding" | "failed" | "skipped" | "missed" | "interrupted";

export const LIVE_STATES: readonly RunState[] = ["running", "asking"];

export function isLiveRun(state: RunState): boolean {
  return state === "running" || state === "asking";
}

/** An automation's definition, as the file says it. */
export interface AutomationDef {
  name: string;
  /**
   * What it is for, in a sentence or two of plain text: the purpose a name
   * cannot carry, for whoever finds it in the sidebar months later. One line
   * in the file, like every key. Null when it has none.
   */
  description: string | null;
  /** The schedule line as written; `parsed` is it read. */
  schedule: string;
  parsed: Schedule;
  run: AutomationTask;
  /** An id from `LAUNCHERS`. Null for a shell task. */
  launcher: string | null;
  /** A folder under the workspace's, relative, no `..`. Null for the workspace's own. */
  dir: string | null;
  /** Checks made before a run starts (`machine MV`, `login claude`, `command jq`). */
  needs: string[];
  timeoutMs: number;
  maxUsd: number;
  monthUsd: number | null;
  /** How late a missed slot may still start. Null for the default (`catchUpFor`). */
  catchUpMs: number | null;
  tell: Tell;
  permissions: Permissions;
  /** The prompt, or the command line, or a card's body. */
  body: string;
}

export const DEFAULT_TIMEOUT_MS = 60 * 60_000;
export const DEFAULT_MAX_USD = 5;
/** A slot found within this long is on time. */
export const ON_TIME_MS = 2 * 60_000;
/** At most this many automation runs at once in a profile; a third waits its turn. */
export const MAX_LIVE_RUNS = 2;
/** How long after its turn ends an automation's agent is ended, under the sleeper's checks. */
export const END_AFTER_MS = 2 * 60_000;
/** The most a definition may hold, whole. */
export const TEXT_MAX = 40_000;
export const NAME_MAX = 80;
/** A sentence or two; past this it is a prompt, and belongs in the body. */
export const DESCRIPTION_MAX = 400;

// ---------------------------------------------------------------------------
// Durations and the file
// ---------------------------------------------------------------------------

/** `90m`, `3d`, `12h`, `45s` as milliseconds, or null. */
export function parseDuration(text: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/.exec(text.trim().toLowerCase());
  if (!match) return null;
  const n = Number(match[1]);
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "s" | "m" | "h" | "d"];
  const ms = n * unit;
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : null;
}

/** A duration back as the file writes it, in the largest unit it divides into. */
export function durationText(ms: number): string {
  for (const [unit, size] of [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000]] as const) {
    if (ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${Math.round(ms / 1000)}s`;
}

/** A duration in words for a sentence: `40 s`, `90 min`, `3 h`, `2 days`. */
export function durationWords(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 120) return `${minutes} min`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(ms / 86_400_000)} days`;
}

/** The catch-up window a definition gets: its own, or half a day for daily-or-slower and none for faster. */
export function catchUpFor(def: AutomationDef): number {
  if (def.catchUpMs !== null) return def.catchUpMs;
  return dailyOrSlower(def.parsed) ? 12 * 3_600_000 : 0;
}

/**
 * A folder under the workspace's, as the file may name it: relative, plain
 * names separated by slashes, nothing that climbs. The server resolves it
 * and checks it is a directory under the workspace's folder again.
 */
export function validDir(dir: string): boolean {
  if (!dir || dir.length > 300 || dir.startsWith("/")) return false;
  return dir.split("/").every((part) => part !== "" && part !== "." && part !== ".." && /^[A-Za-z0-9._\-]+$/.test(part));
}

export type ParsedAutomation = { ok: true; def: AutomationDef } | { ok: false; error: string };

const KEYS = new Set(["name", "description", "schedule", "run", "launcher", "dir", "needs", "timeout", "max-usd", "month-usd", "catch-up", "tell", "permissions"]);

/**
 * The file, read. Refuses rather than guesses: an unknown key, a schedule
 * that does not parse, a launcher the catalogue does not have are each an
 * error in words, because a definition is standing permission to spend and
 * a typo should never run as something else.
 */
export function parseAutomation(text: string): ParsedAutomation {
  const fail = (error: string): ParsedAutomation => ({ ok: false, error });
  if (text.length > TEXT_MAX) return fail("the definition is too long");
  const normal = text.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normal);
  if (!match) return fail("a definition starts with --- and its keys, then --- and the prompt or command");
  const fields = new Map<string, string>();
  for (const line of match[1]!.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const at = line.indexOf(":");
    if (at < 0) return fail(`"${line.trim()}" is not a key: value line`);
    const key = line.slice(0, at).trim().toLowerCase();
    if (!KEYS.has(key)) return fail(`"${key}" is not a key a definition has`);
    if (fields.has(key)) return fail(`"${key}" is said twice`);
    fields.set(key, line.slice(at + 1).trim());
  }
  const body = match[2]!.trim();

  const name = fields.get("name") ?? "";
  if (!name) return fail("it needs a name");
  if (name.length > NAME_MAX) return fail(`a name is at most ${NAME_MAX} characters`);
  if (/[\u0000-\u001f]/.test(name)) return fail("a name is one line of plain text");

  const description = fields.get("description") || null;
  if (description !== null) {
    if (description.length > DESCRIPTION_MAX) return fail(`a description is at most ${DESCRIPTION_MAX} characters: a sentence or two`);
    if (/[\u0000-\u001f]/.test(description)) return fail("a description is one line of plain text");
  }

  const scheduleText = (fields.get("schedule") ?? "").replace(/\s+/g, " ");
  if (!scheduleText) return fail("it needs a schedule");
  const parsed = parseSchedule(scheduleText);
  if (!parsed.ok) return fail(`schedule: ${parsed.error}`);

  const run = (fields.get("run") ?? "agent").toLowerCase();
  if (run !== "agent" && run !== "shell" && run !== "card") return fail(`run is agent, shell or card, not "${run}"`);

  let launcher: string | null = fields.get("launcher") || null;
  if (run === "shell") {
    if (launcher) return fail("a shell task takes no launcher");
  } else {
    if (!launcher) return fail("an agent task names its launcher, like claude:claude-sonnet-5");
    if (!findLauncher(launcher)) return fail(`"${launcher}" is not one of kururu's launchers`);
  }
  if (run === "shell") launcher = null;

  const dir = fields.get("dir") || null;
  if (dir !== null && !validDir(dir)) return fail(`dir "${dir}" is not a folder under the workspace's (relative, no ..)`);

  const needs = (fields.get("needs") ?? "")
    .split(",")
    .map((need) => need.trim().replace(/\s+/g, " "))
    .filter(Boolean);
  for (const need of needs) {
    if (!/^(machine|login|command) [A-Za-z0-9._\-]+$/.test(need)) return fail(`need "${need}" is not machine <name>, login <cli> or command <name>`);
  }

  const timeoutText = fields.get("timeout");
  const timeoutMs = timeoutText ? parseDuration(timeoutText) : DEFAULT_TIMEOUT_MS;
  if (timeoutMs === null) return fail(`timeout "${timeoutText}" is not a duration, like 90m`);
  if (timeoutMs < 60_000 || timeoutMs > 24 * 3_600_000) return fail("a timeout is from a minute to a day");

  const money = (key: string): number | null | string => {
    const value = fields.get(key);
    if (value === undefined || value === "") return null;
    const n = Number(value.replace(/^\$/, ""));
    return Number.isFinite(n) && n > 0 && n <= 10_000 ? n : `${key} "${value}" is not an amount of dollars`;
  };
  const maxUsd = money("max-usd");
  if (typeof maxUsd === "string") return fail(maxUsd);
  const monthUsd = money("month-usd");
  if (typeof monthUsd === "string") return fail(monthUsd);

  const catchUpText = fields.get("catch-up");
  let catchUpMs: number | null = null;
  if (catchUpText) {
    catchUpMs = catchUpText.toLowerCase() === "none" ? 0 : parseDuration(catchUpText);
    if (catchUpMs === null) return fail(`catch-up "${catchUpText}" is not a duration, like 12h, or none`);
    if (catchUpMs > 30 * 86_400_000) return fail("a catch-up window is at most 30 days");
  }

  const tell = (fields.get("tell") ?? "finding").toLowerCase();
  if (!TELLS.includes(tell as Tell)) return fail(`tell is never, failure, finding or always, not "${tell}"`);
  const permissions = (fields.get("permissions") ?? "profile").toLowerCase();
  if (permissions !== "profile" && permissions !== "ask" && permissions !== "auto") return fail(`permissions is profile, ask or auto, not "${permissions}"`);

  if (!body) return fail(run === "shell" ? "a shell task needs its command, below the second ---" : "it needs its prompt, below the second ---");

  return {
    ok: true,
    def: {
      name,
      description,
      schedule: scheduleText,
      parsed: parsed.schedule,
      run,
      launcher,
      dir,
      needs,
      timeoutMs,
      maxUsd: maxUsd ?? DEFAULT_MAX_USD,
      monthUsd,
      catchUpMs,
      tell: tell as Tell,
      permissions: permissions as Permissions,
      body,
    },
  };
}

/** What the form edits: the definition's fields, written back as the file by `automationText`. */
export type AutomationFields = Omit<AutomationDef, "parsed">;

/**
 * The file a definition is. Keys in one order and defaults left out, so the
 * text the database keeps for an automation is the same whether it came from
 * the form or from a file.
 */
export function automationText(def: AutomationFields): string {
  const lines = [`name: ${def.name}`];
  if (def.description) lines.push(`description: ${def.description}`);
  lines.push(`schedule: ${def.schedule}`, `run: ${def.run}`);
  if (def.launcher) lines.push(`launcher: ${def.launcher}`);
  if (def.dir) lines.push(`dir: ${def.dir}`);
  if (def.needs.length) lines.push(`needs: ${def.needs.join(", ")}`);
  if (def.timeoutMs !== DEFAULT_TIMEOUT_MS) lines.push(`timeout: ${durationText(def.timeoutMs)}`);
  if (def.maxUsd !== DEFAULT_MAX_USD) lines.push(`max-usd: ${def.maxUsd}`);
  if (def.monthUsd !== null) lines.push(`month-usd: ${def.monthUsd}`);
  if (def.catchUpMs !== null) lines.push(`catch-up: ${def.catchUpMs === 0 ? "none" : durationText(def.catchUpMs)}`);
  if (def.tell !== "finding") lines.push(`tell: ${def.tell}`);
  if (def.permissions !== "profile") lines.push(`permissions: ${def.permissions}`);
  return `---\n${lines.join("\n")}\n---\n${def.body.trim()}\n`;
}

// ---------------------------------------------------------------------------
// When a slot runs
// ---------------------------------------------------------------------------

export interface DueFacts {
  /** The most recent slot at or before now. */
  slot: number;
  now: number;
  catchUpMs: number;
  /** How many earlier slots went by unrun on the way to this one. */
  passed: number;
  /** A run of this automation is still going. */
  running: boolean;
  /** The profile already has `MAX_LIVE_RUNS` going. */
  full: boolean;
}

export type Decision =
  | { act: "early" }
  | { act: "wait" }
  | { act: "run"; why: "schedule" | "catch-up"; words: string | null }
  | { act: "missed"; words: string }
  | { act: "skipped"; words: string };

function passedWords(passed: number): string {
  return passed > 0 ? ` ${passed} earlier ${passed === 1 ? "slot" : "slots"} went by unrun.` : "";
}

/**
 * What to do with a slot that has come round. Missed first, since a slot
 * past its window could not run whatever else is true; then skipped while
 * the last run is going, because runs never stack; then a wait while the
 * profile is full, which writes nothing and asks again on the next tick.
 */
export function decide(facts: DueFacts): Decision {
  const late = facts.now - facts.slot;
  if (late < 0) return { act: "early" };
  const onTime = late <= ON_TIME_MS;
  if (!onTime && late > facts.catchUpMs) {
    return {
      act: "missed",
      words: `found ${durationWords(late)} late, past its ${facts.catchUpMs ? `${durationWords(facts.catchUpMs)} ` : ""}catch-up window: the Mac was asleep or kururu was not running.${passedWords(facts.passed)}`,
    };
  }
  if (facts.running) return { act: "skipped", words: `the last run is still going.${passedWords(facts.passed)}` };
  if (facts.full) return { act: "wait" };
  if (onTime) return { act: "run", why: "schedule", words: facts.passed ? passedWords(facts.passed).trim() : null };
  return { act: "run", why: "catch-up", words: `late by ${durationWords(late)}: the Mac was asleep or kururu was not running.${passedWords(facts.passed)}` };
}

// ---------------------------------------------------------------------------
// A run's words
// ---------------------------------------------------------------------------

/**
 * The prompt an agent run is given: the file's body, then a few lines saying
 * it is unattended and how to end. The body first, so a slash command
 * (`/crawl-maintenance`) is still the first thing typed, as a card's is. The
 * tag is the run's own mark, which the server finds again in the terminal's
 * command line after a restart.
 */
export function runPrompt(def: Pick<AutomationDef, "name" | "body">, tag: string): string {
  return `${def.body.trim()}

(This is an unattended run of the automation "${def.name}", started by kururu on its schedule [${tag}]. Nobody is watching: do not ask questions or wait for an answer. If you cannot go on, stop and say why. End your last message with exactly one line, the last line: \`RESULT: ok\` when there is nothing to report, \`RESULT: finding: <one sentence>\` when there is something the owner should know, or \`RESULT: failed: <one sentence>\` when it could not be done.)`;
}

export interface Verdict {
  state: "ok" | "finding" | "failed";
  words: string | null;
}

/**
 * How a run ended, read off its last reply. The last `RESULT:` line wins,
 * wherever it is, with markdown's backticks and emphasis taken off. No line
 * at all is a finding: a run that did not say it was fine is one somebody
 * should look at.
 */
export function verdictOf(reply: string | null): Verdict {
  if (!reply) return { state: "finding", words: "it ended without a reply kururu could read" };
  const lines = reply.split("\n").map((line) => line.trim().replace(/^[`*_>\-\s]+|[`*_\s]+$/g, ""));
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = /^RESULT:\s*(ok|finding|failed)\b\s*:?\s*(.*)$/i.exec(lines[i]!);
    if (!match) continue;
    const state = match[1]!.toLowerCase() as Verdict["state"];
    const words = match[2]!.trim().slice(0, 500) || null;
    return { state, words };
  }
  return { state: "finding", words: "it ended without a RESULT line" };
}

/**
 * A shell run's end, as printed after its command: `<tag> <status>`. Read
 * off the screen through the host's own `text`, because the host says that
 * a terminal exited and not with what status, and adding that would be a
 * change to the host.
 */
export function shellLine(command: string, tag: string): string {
  return `sh -c ${shq(command)}; printf '\\n%s %s\\n' ${shq(tag)} "$?"`;
}

/** The status and the lines before it, or null when the marker is not on the screen. */
export function shellEnd(screen: string, tag: string, keep = 40): { status: number; output: string } | null {
  const lines = screen.split("\n").map((line) => line.replace(/\s+$/, ""));
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = new RegExp(`^${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} (\\d+)$`).exec(lines[i]!);
    if (!match) continue;
    const before = lines.slice(0, i);
    while (before.length && !before.at(-1)) before.pop();
    return { status: Number(match[1]), output: before.slice(-keep).join("\n") };
  }
  return null;
}

// ---------------------------------------------------------------------------
// What a client is sent
// ---------------------------------------------------------------------------

export interface RunView {
  id: number;
  /** The slot's id: its time for a scheduled one, `now:<time>` for Run now. */
  slot: string;
  slotAt: number;
  why: "schedule" | "catch-up" | "now";
  startedAt: number | null;
  endedAt: number | null;
  state: RunState;
  words: string | null;
  /** A shell run's last lines. */
  output: string | null;
  agentId: string | null;
  sessionId: string | null;
  launcher: string | null;
}

/** One automation, as the sidebar and the sheet draw it. */
export interface AutomationView {
  key: string;
  name: string;
  /** What it is for, from the definition. Null when it has none, or the text no longer parses. */
  description: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  /** The node it lives on. Always this one until automations can move. */
  home: string;
  enabled: boolean;
  whyOff: string | null;
  /** The approved definition, whole. */
  text: string;
  /** Null when the stored text no longer parses — a launcher retired since, say. */
  error: string | null;
  schedule: string;
  words: string;
  zone: string | null;
  anchor: string;
  run: AutomationTask;
  next: number | null;
  /** The live run, if one is going. */
  live: RunView | null;
  /** The last run that ended, or was skipped or missed. */
  last: RunView | null;
  /** Whether this server's clock is running: off in an isolated instance. */
  clock: boolean;
}

/** The sidebar's one fact about it: the dot. */
export type AutomationDot = "quiet" | "running" | "asking" | "finding" | "failed" | "paused" | "broken";

export function dotOf(view: Pick<AutomationView, "enabled" | "error" | "live" | "last">): AutomationDot {
  if (view.error) return "broken";
  if (view.live) return view.live.state === "asking" ? "asking" : "running";
  if (!view.enabled) return "paused";
  const last = view.last?.state;
  if (last === "failed" || last === "missed" || last === "skipped" || last === "interrupted") return "failed";
  if (last === "finding") return "finding";
  return "quiet";
}

/** A tag minted for each run, which its terminal's command line carries. */
export function runTag(runId: number, nonce: string): string {
  return `kururu-run-${runId}-${nonce}`;
}
