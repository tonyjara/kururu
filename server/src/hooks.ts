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
 * new-tab menu's Claude rows carry it when a profile login is in force, and only
 * then — with the machine's own directory the hand-installed hooks are already
 * there, and a second copy would report every event twice.
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
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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

/** Single-quoted for `sh`, which is what runs a hook's command. */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The settings layered over a Claude Code launch. Pure, for the test. */
export function hookSettings(runtime: string, script: string): object {
  const base = `ELECTRON_RUN_AS_NODE=1 ${quote(runtime)} ${quote(script)}`;
  const hooks: Record<string, unknown> = {};
  for (const [event, status] of EVENTS) {
    const command = `${status ? `${base} ${status}` : base} >/dev/null 2>&1 || true`;
    hooks[event] = [{ hooks: [{ type: "command", async: true, command }] }];
  }
  return { hooks };
}

/**
 * The `--settings` file for a Claude launch, written now, or null when there is
 * no script to point it at — a server run from source without a build, which
 * gets an agent without a ring rather than a hook that fails on every turn.
 */
export function hookSettingsFile(): string | null {
  const script = reportScript();
  if (!existsSync(script)) return null;
  const dir = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "kururu");
  const path = join(dir, "claude-hooks.json");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(hookSettings(process.execPath, script), null, 2)}\n`, "utf8");
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
export function runsReporter(settings: unknown, script: string): boolean {
  const hooks = (settings as { hooks?: unknown } | null)?.hooks;
  if (!hooks || typeof hooks !== "object") return false;
  return Object.values(hooks).some(
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
 * Nothing as well when the directory Claude is about to read already runs the
 * reporter. A settings file that will not parse counts as not running it: the
 * cost of that guess is a doubled report, and the cost of the other is no ring.
 */
export function hookSettingsFlag(claudeDir: string): string {
  try {
    const own: unknown = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    if (runsReporter(own, reportScript())) return "";
  } catch {
    // No settings yet, which is how every profile starts.
  }
  const file = hookSettingsFile();
  return file ? ` --settings ${quote(file)}` : "";
}
