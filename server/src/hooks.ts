/**
 * The hooks kururu hands a Claude Code it starts, for the case where the
 * person's own `~/.claude/settings.json` is not the one being read.
 *
 * `report-cli.ts` is how an agent says it is blocked and how full its context
 * is, and it has always been installed by hand, in `~/.claude/settings.json`.
 * That stopped reaching anything the day profiles got logins of their own:
 * `CLAUDE_CONFIG_DIR` moves the *whole* config directory, settings included, and
 * a profile's directory starts empty on purpose (`logins.ts` says why). So an
 * agent opened in a profile ran with no hooks, and the sidebar lost its context
 * ring and its amber dot without anything saying so.
 *
 * Writing the hooks into the profile's `settings.json` would fix it and is the
 * thing `logins.ts` promises not to do — kururu does not decide what goes in a
 * login directory. Claude Code's `--settings` is the other door: a file layered
 * over whichever directory it is using, for one launch, touching nothing. So the
 * new-tab menu's Claude rows carry it whenever the directory in use does not
 * already run the reporter — a profile's own, and the machine's on a box where
 * nobody installed them by hand, which is every child kururu. Where the
 * hand-installed hooks are already there it steps aside, since a second copy
 * would report every event twice.
 *
 * What it does not reach is a `claude` typed into a shell, which kururu never
 * sees being launched. That still wants the hooks in the profile's own settings,
 * by hand, as it always did for `~/.claude` — and a profile that has them is the
 * machine's case over again, so the flag steps aside for it rather than report
 * every event twice. `runsReporter` is how it tells.
 *
 * The script is `report.mjs`, bundled beside `server.mjs` by `desktop/build.mjs`,
 * and run by whatever is running the server: `node` from a checkout, the app's
 * own Electron binary once packaged — which is why `ELECTRON_RUN_AS_NODE` is on
 * the line, and why neither `bun` nor the checkout has to exist on a machine that
 * only has the app. Rewritten at every launch rather than once, because the
 * path in it moves when the server does and the write is a few hundred bytes.
 *
 * **Test runs ride on these, and add one hook of their own.** `PreToolUse`
 * already hands the reporter every tool call, so a Bash call that is a test
 * run is said to be starting in the report that was going anyway
 * (`testReportOf`). Its end is `PostToolUse` and `PostToolUseFailure` on Bash
 * alone, which nothing ran on before, so that one is written to cost as
 * little as a hook can: a shell `case` over the call for a test-looking
 * word, and only a match starts the reporter (`testEndCommand`). Those two
 * events are layered onto a directory that runs the hand-installed reporter
 * as well, since no hand-installed set has them; the other five still step
 * aside there. See `shared/testing.ts`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { shq } from "../../shared/text";
import { classifyCommand, exitCodeIn, parseTestCounts, wasRefused, type TestHookReport } from "../../shared/testing";
import { stateDir } from "./fsutil";

/** Claude Code's event, and the status `report-cli.ts` is told for it. */
const EVENTS: [event: string, status: string | null][] = [
  // No status: the context reading only, and the one that empties the ring on `/clear`.
  ["SessionStart", null],
  ["UserPromptSubmit", "working"],
  ["PreToolUse", "working"],
  ["Stop", "done"],
  // Only when it is a question; `asksNothing` drops the rest in the reporter.
  ["Notification", "blocked"],
];

/**
 * The notifications that are Claude Code asking somebody something.
 *
 * `Notification` is not one event but more than a dozen, told apart by the
 * payload's `notification_type`, and `blocked` was being reported for all of them. The
 * one that showed is `idle_prompt` — "Claude is waiting for your input", sent
 * about a minute after a turn ends with nothing more to do — which turned
 * every finished agent into a blocked one a minute later, a second card and a
 * second line in the harness's feed for a turn it had already been told
 * about. The others that are not questions are just as wrong as `blocked`: a
 * login that worked, an elicitation that closed, computer use starting, a
 * `PushNotification` Claude sent on purpose.
 *
 * So the questions are listed rather than the rest, because `blocked` is the
 * one status that asks a person to go and look, and a type added in a later
 * version should have to earn it. A dialog that names no type of its own —
 * plan mode, a question from `AskUserQuestion` — is sent as
 * `permission_prompt` (read out of 2.1.294), so it is on the list already.
 */
const ASKING: ReadonlySet<string> = new Set([
  "permission_prompt",
  "worker_permission_prompt",
  "elicitation_dialog",
  "elicitation_url_dialog",
  "agent_needs_input",
]);

/**
 * The idle reminder's words, for a Claude Code that sends no type. Every
 * notification was `blocked` before the types existed, and of the two there
 * were then, this is the one that was never a question.
 */
const IDLE_MESSAGE = "Claude is waiting for your input";

/**
 * Whether a hook payload is a `Notification` that asks nobody anything — in
 * which case it reports no status and no words, so the dot stays `done` and
 * the prompt stays on the row. Any other event is not this function's to judge.
 * Pure, for the test.
 */
export function asksNothing(payload: Record<string, unknown> | null): boolean {
  if (payload?.hook_event_name !== "Notification") return false;
  const type = payload.notification_type;
  if (typeof type === "string") return !ASKING.has(type);
  return payload.message === IDLE_MESSAGE;
}


/** The two events a Bash call ends on: one when it exits zero, the other when it does not. */
const TEST_END_EVENTS = ["PostToolUse", "PostToolUseFailure"] as const;

/**
 * Words one of which is in nearly every command line `classifyCommand` calls
 * a run. A filter and not the rule: a run it misses still ends, when the
 * ledger's reader sees its result, and `server/test/hooks.test.ts` holds it
 * against the classifier's own examples so the two do not drift far.
 */
export const TEST_WORDS = [
  "test", "spec", "e2e", "tsc", "lint", "check", "build", "jest", "playwright", "cypress", "maestro", "detox", "verify", "validate", "smoke", "contract",
  "mocha", "clippy", "vet", "pyright", "mypy", "biome", "prettier", "ruff", "coverage", "unit", "compile", "bundle", "make", "mvn", "gradle", "expo", "integration", "types",
] as const;

/**
 * The end hook's command: the reporter, started only for a call that could
 * be a test run.
 *
 * It runs after every Bash call of every agent, and a reporter is a node
 * process: 31 ms of CPU measured here on 2026-11-25, against 5 for a shell
 * that looks and leaves. So the shell looks first. It reads the payload, cuts
 * it at the tool's output (which is most of it, and where any word at all
 * turns up) so that only the call itself is searched, and starts the
 * reporter on a match. A payload with its keys in another order is searched
 * whole rather than cut wrong.
 */
export function testEndCommand(base: string): string {
  const words = TEST_WORDS.map((word) => `*${word}*`).join("|");
  return `p=$(cat); c=\${p%%\\"tool_response\\"*}; c=\${c%%\\"error\\":*}; case "$c" in *tool_input*) ;; *) c=$p;; esac; case "$c" in ${words}) printf '%s' "$p" | ${base} >/dev/null 2>&1;; esac; true`;
}

/** The settings layered over a Claude Code launch. Pure, for the test. `only` keeps it to the test run's end, for a directory that reports the rest itself. */
export function hookSettings(runtime: string, script: string, only?: "tests"): object {
  const base = `ELECTRON_RUN_AS_NODE=1 ${shq(runtime)} ${shq(script)}`;
  const hooks: Record<string, unknown> = {};
  for (const [event, status] of only ? [] : EVENTS) {
    const command = `${status ? `${base} ${status}` : base} >/dev/null 2>&1 || true`;
    hooks[event] = [{ hooks: [{ type: "command", async: true, command }] }];
  }
  for (const event of TEST_END_EVENTS) hooks[event] = [{ matcher: "Bash", hooks: [{ type: "command", async: true, command: testEndCommand(base) }] }];
  return { hooks };
}

/**
 * A hook payload, as the test run it starts or ends: null for any call that
 * is not one, which is nearly all of them. Pure, for the test.
 *
 * The output is read here, in the hook's own process, for its three counts,
 * and is not sent: what crosses to the server is a redacted command line and
 * numbers. A call that came back with a background task's id has not ended,
 * so it is said to be starting again, in the background.
 */
export function testReportOf(payload: Record<string, unknown> | null): TestHookReport | null {
  if (!payload || payload.tool_name !== "Bash") return null;
  const event = payload.hook_event_name;
  if (event !== "PreToolUse" && event !== "PostToolUse" && event !== "PostToolUseFailure") return null;
  const session = payload.session_id;
  const callId = payload.tool_use_id;
  if (typeof session !== "string" || typeof callId !== "string") return null;
  const input = payload.tool_input as Record<string, unknown> | null | undefined;
  const call = classifyCommand(input?.command);
  if (!call) return null;
  const background = input?.run_in_background === true;
  if (event === "PreToolUse") return { phase: "start", session, callId, call, background };
  const duration = payload.duration_ms;
  const durationMs = typeof duration === "number" && Number.isFinite(duration) ? duration : null;
  if (event === "PostToolUse") {
    const response = payload.tool_response;
    const said = response && typeof response === "object" ? (response as Record<string, unknown>) : null;
    if (typeof said?.backgroundTaskId === "string") return { phase: "start", session, callId, call, background: true };
    const output = said ? `${typeof said.stdout === "string" ? said.stdout : ""}\n${typeof said.stderr === "string" ? said.stderr : ""}` : typeof response === "string" ? response : "";
    return { phase: "end", session, callId, call, durationMs, exit: 0, stopped: said?.interrupted === true, counts: parseTestCounts(output) };
  }
  const error = typeof payload.error === "string" ? payload.error : "";
  const refused = payload.is_interrupt === true || wasRefused(error);
  return { phase: "end", session, callId, call, durationMs, exit: refused ? null : (exitCodeIn(error) ?? 1), stopped: refused, counts: refused ? null : parseTestCounts(error) };
}

/**
 * The `--settings` file for a Claude launch, written now, or null when there is
 * no script to point it at — a server run from source without a build, which
 * gets an agent without a ring rather than a hook that fails on every turn.
 */
export function hookSettingsFile(only?: "tests"): string | null {
  const script = reportScript();
  if (!existsSync(script)) return null;
  const dir = stateDir();
  const path = join(dir, only ? "claude-hooks-tests.json" : "claude-hooks.json");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(hookSettings(process.execPath, script, only), null, 2)}\n`, "utf8");
    return path;
  } catch {
    return null;
  }
}

/** Where the bundled reporter is, whether or not it has been built. */
function reportScript(): string {
  return fileURLToPath(new URL("./report.mjs", import.meta.url));
}

/**
 * Whether a Claude settings object already runs kururu's reporter on some event.
 * Pure, for the test.
 *
 * Known by `report-cli` — what the README has people install from a checkout —
 * or by this server's own bundled script, and by nothing looser. The two ways
 * of being wrong are not the same size: a miss hands the launch a second copy
 * and every event is reported twice, while a false match takes the flag away
 * from an agent that had no other hooks, and that is the missing ring this
 * module exists to prevent. So a hook merely named `report.mjs` is not ours.
 */
export function runsReporter(settings: unknown, script: string, events?: readonly string[]): boolean {
  const hooks = (settings as { hooks?: unknown } | null)?.hooks;
  if (!hooks || typeof hooks !== "object") return false;
  // On any event, or on one of these.
  return Object.entries(hooks).filter(([event]) => !events || events.includes(event)).map(([, groups]) => groups).some(
    (groups) =>
      Array.isArray(groups) &&
      groups.some((group) => {
        const list = (group as { hooks?: unknown } | null)?.hooks;
        return (
          Array.isArray(list) &&
          list.some((hook) => {
            const command = (hook as { command?: unknown } | null)?.command;
            return typeof command === "string" && (command.includes("report-cli") || command.includes(script));
          })
        );
      }),
  );
}

/**
 * ` --settings '<file>'`, or nothing. Appended to a launcher's command line.
 *
 * When the directory Claude is about to read already runs the reporter, only
 * the test run's end is layered on, which no hand-installed set has (and
 * nothing at all if that directory has it too). A settings file that will
 * not parse counts as not running it: the cost of that guess is a doubled
 * report, and the cost of the other is no ring.
 */
export function hookSettingsFlag(claudeDir: string): string {
  const own = ownSettings(claudeDir);
  const script = reportScript();
  if (own !== null && runsReporter(own, script) && runsReporter(own, script, TEST_END_EVENTS)) return "";
  const file = hookSettingsFile(own !== null && runsReporter(own, script) ? "tests" : undefined);
  return file ? ` --settings ${shq(file)}` : "";
}

/**
 * The same decision as the settings themselves, for a launch that writes one
 * `--settings` file of its own and has to put the hooks in it — Kuru's
 * (`kuruLaunchFlags`), since a second `--settings` on a line replaces the
 * first. Null when the directory runs the reporter already, or there is no
 * script to point at.
 */
export function hookSettingsFor(claudeDir: string): object | null {
  if (runsOwnReporter(claudeDir)) return null;
  const script = reportScript();
  return existsSync(script) ? hookSettings(process.execPath, script) : null;
}

function runsOwnReporter(claudeDir: string): boolean {
  return runsReporter(ownSettings(claudeDir), reportScript());
}

/** The directory's own settings, or null: none yet, which is how every profile starts, or a file that does not parse. */
function ownSettings(claudeDir: string): unknown {
  try {
    return JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8")) as unknown;
  } catch {
    return null;
  }
}
