/**
 * What the new-tab button offers besides a terminal: a coding agent, started on
 * a particular model.
 *
 * The list is written out by hand, and that is the decision worth defending.
 * Neither CLI will say what models it has without either spending a request or
 * reading a cache that belongs to it — Codex keeps one in `~/.codex`, Claude Code
 * keeps none — and a menu that goes to the network before it can open is a
 * menu that is slow on the phone and empty on a plane. So the models live here,
 * and `.claude/skills/update-models` is what keeps them current: it reads what
 * the two CLIs know about and edits this file, which is a diff somebody can read
 * before it ships rather than a list that changes under them at runtime.
 *
 * Every CLI also gets a row with no model at all, which is the one that never
 * goes stale: it starts the agent on whatever its own config says, the same as
 * typing `claude` in a terminal would.
 *
 * The client sends a launcher's *id* and the server looks the command up here.
 * `new-tab` would take a command string from the wire, but a menu that builds
 * shell commands in the browser is one more place a string gets spliced into
 * `sh -c`, and the ids are what a phone can send without knowing anything.
 */

export const AGENT_CLIS = ["claude", "codex"] as const;
export type AgentCli = (typeof AGENT_CLIS)[number];

export const CLI_LABELS: Record<AgentCli, string> = {
  claude: "Claude",
  codex: "Codex",
};

/** The flag each CLI takes a model on. They agree on the long spelling. */
const MODEL_FLAG: Record<AgentCli, string> = {
  claude: "--model",
  codex: "--model",
};

/**
 * The flag that turns each CLI's permission prompts off — Claude Code's
 * `--dangerously-skip-permissions`, and the long spelling of Codex's `--yolo`,
 * which also drops its sandbox.
 *
 * The long spellings because they are the ones that say what they do, in the
 * settings row and in `ps`. Whether to pass one is the user's call per CLI; it
 * is off until they tick it, because an agent that asks before `rm` is the one
 * a first launch should get.
 */
export const BYPASS_FLAG: Record<AgentCli, string> = {
  claude: "--dangerously-skip-permissions",
  codex: "--dangerously-bypass-approvals-and-sandbox",
};

export interface Launcher {
  /** Stable across releases: it is what `launch.json` remembers as switched off. */
  id: string;
  cli: AgentCli;
  /** Passed to the CLI's model flag. Absent means the CLI's own default. */
  model?: string;
  /** What the menu calls it. */
  label: string;
}

/**
 * The catalogue. Newest first within a CLI, the no-model row at the head.
 *
 * Full model names rather than the `opus`/`sonnet` aliases on the Claude side:
 * an alias moves when a new model ships, and a row labelled "Opus 5.5" that has
 * quietly become something else is a label that lies. The no-model row is what
 * follows the aliases, and the skill is what adds the new name when there is
 * one.
 *
 * Model names go into a shell command, so they are checked against `MODEL_NAME`
 * by the tests — nothing from outside ever lands in this list at runtime.
 */
export const LAUNCHERS: readonly Launcher[] = [
  { id: "claude", cli: "claude", label: "Claude" },
  { id: "claude:claude-fable-5-1", cli: "claude", model: "claude-fable-5-1", label: "Claude Fable 5.1" },
  { id: "claude:claude-opus-5-5", cli: "claude", model: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude:claude-sonnet-5", cli: "claude", model: "claude-sonnet-5", label: "Claude Sonnet 5" },
  {
    id: "claude:claude-haiku-4-5-20251001",
    cli: "claude",
    model: "claude-haiku-4-5-20251001",
    label: "Claude Haiku 4.5",
  },

  { id: "codex", cli: "codex", label: "Codex" },
  { id: "codex:gpt-5.6-sol", cli: "codex", model: "gpt-5.6-sol", label: "Codex GPT-5.6-Sol" },
  { id: "codex:gpt-5.6-terra", cli: "codex", model: "gpt-5.6-terra", label: "Codex GPT-5.6-Terra" },
  { id: "codex:gpt-5.6-luna", cli: "codex", model: "gpt-5.6-luna", label: "Codex GPT-5.6-Luna" },
  { id: "codex:gpt-5.5", cli: "codex", model: "gpt-5.5", label: "Codex GPT-5.5" },
  { id: "codex:gpt-5.4", cli: "codex", model: "gpt-5.4", label: "Codex GPT-5.4" },
  { id: "codex:gpt-5.4-mini", cli: "codex", model: "gpt-5.4-mini", label: "Codex GPT-5.4-Mini" },
];

/** What a model name may be made of. Anything else would need quoting. */
export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function findLauncher(id: string): Launcher | undefined {
  return LAUNCHERS.find((launcher) => launcher.id === id);
}

/**
 * The line the login shell runs. The bypass flag is decided here, at launch, and
 * not recorded on the tab: changing the setting affects the next agent, never one
 * that is already running.
 */
export function launcherCommand(launcher: Launcher, settings?: LaunchSettings): string {
  const parts: string[] = [launcher.cli];
  if (launcher.model) parts.push(MODEL_FLAG[launcher.cli], launcher.model);
  if (settings?.bypassClis.includes(launcher.cli)) parts.push(BYPASS_FLAG[launcher.cli]);
  return parts.join(" ");
}

/**
 * A launcher's command with a prompt on the end — how a card becomes an agent.
 *
 * Both CLIs take a first message as a positional argument and start an
 * interactive session on it, which is what a card wants: the agent begins
 * work at once and stays in its terminal to be answered, rather than printing
 * one reply and exiting the way `-p` would.
 *
 * This is the one place a string somebody typed reaches `sh -c`, so it is
 * single-quoted whole, with each `'` closed, escaped and reopened — the
 * spelling sh, bash, zsh and fish all read the same way. Control characters
 * other than newline and tab are dropped: a card is text, and a stray escape
 * sequence has no business in a process's argv. A prompt that starts with a
 * dash is given a leading space so neither CLI reads it as a flag.
 */
export function withPrompt(command: string, prompt: string): string {
  let clean = prompt.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  if (clean.startsWith("-")) clean = ` ${clean}`;
  return `${command} '${clean.replaceAll("'", `'\\''`)}'`;
}

/**
 * Which rows the menu leaves out.
 *
 * Recorded as what is *off*, not what is on, so that a model the skill adds next
 * month appears without anybody having to go and tick it — the list growing is
 * the point of keeping it current. A whole CLI can be switched off in one go,
 * which is what somebody who has never installed Codex wants, and it keeps the
 * models underneath it as they were for the day it comes back on.
 */
export interface LaunchSettings {
  offClis: AgentCli[];
  offLaunchers: string[];
  /** CLIs started with their permission prompts off. See `BYPASS_FLAG`. */
  bypassClis: AgentCli[];
  /**
   * Each profile keeps its own Claude and Codex logins.
   *
   * On, every terminal a profile opens is started with `CLAUDE_CONFIG_DIR` and
   * `CODEX_HOME` pointing into that profile's own directory, so a `/login` run
   * inside it signs in that profile and nothing else, and the profile stays
   * signed in as whoever was logged into there last. Off, terminals open with
   * the machine's own logins, as they always did. In here rather than on a
   * profile because it is a rule about how terminals *start*, and because it
   * is one switch: which directory is decided by `Profile.loginKey`, and there
   * is nothing per profile to configure — which is the point of it.
   */
  loginsPerProfile: boolean;
}

export const DEFAULT_LAUNCH: LaunchSettings = {
  offClis: [],
  offLaunchers: [],
  bypassClis: [],
  loginsPerProfile: false,
};

/**
 * Whatever came off disk or the wire, as settings.
 *
 * Unknown ids are kept rather than dropped. An id the catalogue no longer has is
 * harmless — nothing matches it — and dropping it would mean a model removed in
 * one version and restored in the next comes back switched on against somebody's
 * wishes.
 */
export function adoptLaunch(raw: unknown): LaunchSettings {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === "string"))] : [];
  const clis = (value: unknown): AgentCli[] =>
    strings(value).filter((cli): cli is AgentCli => (AGENT_CLIS as readonly string[]).includes(cli));
  return {
    offClis: clis(obj.offClis),
    offLaunchers: strings(obj.offLaunchers).slice(0, 256),
    bypassClis: clis(obj.bypassClis),
    loginsPerProfile: obj.loginsPerProfile === true,
  };
}

/** What the new-tab menu shows, in catalogue order. */
export function visibleLaunchers(settings: LaunchSettings): Launcher[] {
  return LAUNCHERS.filter(
    (launcher) => !settings.offClis.includes(launcher.cli) && !settings.offLaunchers.includes(launcher.id),
  );
}
