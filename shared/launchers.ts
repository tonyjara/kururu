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

import { SESSION_ID } from "./board";

export const AGENT_CLIS = ["claude", "codex", "opencode", "agy"] as const;
export type AgentCli = (typeof AGENT_CLIS)[number];

export const CLI_LABELS: Record<AgentCli, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  agy: "Antigravity",
};

/** The flag each CLI takes a model on. They agree on the long spelling. */
const MODEL_FLAG: Record<AgentCli, string> = {
  claude: "--model",
  codex: "--model",
  opencode: "--model",
  agy: "--model",
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
  opencode: "--auto",
  agy: "--dangerously-skip-permissions",
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
  { id: "claude:claude-fable-5-2", cli: "claude", model: "claude-fable-5-2", label: "Claude Fable 5.2" },
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

  // Antigravity's CLI names a model and its effort in one id, as `agy models`
  // lists them. One row a model at its top effort, and Opus at medium too, the
  // cheaper of the two Claude rows a quota is spent on; the low efforts are
  // left to the CLI's own `/model`.
  { id: "agy", cli: "agy", label: "Antigravity" },
  { id: "agy:claude-opus-5-5-high", cli: "agy", model: "claude-opus-5-5-high", label: "Antigravity Claude Opus 5.5 (High)" },
  { id: "agy:claude-opus-5-5-medium", cli: "agy", model: "claude-opus-5-5-medium", label: "Antigravity Claude Opus 5.5 (Medium)" },
  { id: "agy:claude-sonnet-5-5-high", cli: "agy", model: "claude-sonnet-5-5-high", label: "Antigravity Claude Sonnet 5.5 (High)" },
  { id: "agy:gemini-4-argon-high", cli: "agy", model: "gemini-4-argon-high", label: "Antigravity Gemini 4 Argon (High)" },
  { id: "agy:gemini-3.8-flash-high", cli: "agy", model: "gemini-3.8-flash-high", label: "Antigravity Gemini 3.8 Flash (High)" },
  { id: "agy:gpt-oss-120b-medium", cli: "agy", model: "gpt-oss-120b-medium", label: "Antigravity GPT-OSS 120B" },
];

/** The OpenCode row is derived from Settings rather than kept in the static model catalogue. */
export function opencodeLauncher(settings: LaunchSettings): Launcher {
  return { id: `opencode:${settings.opencodeModel}`, cli: "opencode", model: settings.opencodeModel, label: `OpenCode ${settings.opencodeModel}` };
}

/**
 * The Antigravity row the program switch puts agents on: the catalogue's row
 * for `agyModel`, which `adoptAgyModel` has already held to the catalogue.
 */
export function agyLauncher(settings: LaunchSettings): Launcher {
  const id = `agy:${settings.agyModel}`;
  return LAUNCHERS.find((launcher) => launcher.id === id) ?? { id, cli: "agy", model: settings.agyModel, label: `Antigravity ${settings.agyModel}` };
}

/** The models the Antigravity rows name, which are what `agyModel` may be. */
export const AGY_MODELS: readonly string[] = LAUNCHERS.filter((launcher) => launcher.cli === "agy" && launcher.model).map((launcher) => launcher.model!);

/** What `agyModel` starts as: Claude Opus 5.5 at high effort, Claude Code's harness model, so switching programs does not also switch brains. */
export const AGY_DEFAULT_MODEL = "claude-opus-5-5-high";

/** A model as `agyModel` keeps it — one of the catalogue's — or null. */
export function adoptAgyModel(value: unknown): string | null {
  return typeof value === "string" && AGY_MODELS.includes(value) ? value : null;
}

/**
 * Whether a card whose last run was on `was` starts fresh on the switch's
 * program rather than resuming, because the switch has moved away from what
 * it ran on and no program can read another's conversation.
 *
 * Only the programs the switch moves between take part, and only the way the
 * switch moves them: OpenCode and Antigravity take over Claude's agents, and
 * Antigravity OpenCode's, but an Antigravity or Codex row somebody chose by
 * name from the + menu is theirs to keep. Claude's position takes back only
 * OpenCode, whose rows its menu does not show.
 */
export function switchedFrom(settings: LaunchSettings, was: AgentCli | null | undefined): boolean {
  // The switch's positions are CLIs' names too: Claude Code's is `claude`.
  return switchedFromCli(settings.harnessCli, was);
}

/** The same, by the CLI the switch's position runs — what the board knows, from the rows it was sent. */
export function switchedFromCli(mode: AgentCli, was: string | null | undefined): boolean {
  if (!was) return false;
  if (mode === "claude") return was === "opencode";
  if (mode === "opencode") return was === "claude";
  return was === "claude" || was === "opencode";
}

/** What a model name may be made of. Anything else would need quoting. */
export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function findLauncher(id: string): Launcher | undefined {
  if (id.startsWith("opencode:")) {
    const model = adoptOpencodeModel(id.slice("opencode:".length));
    return model ? { id, cli: "opencode", model, label: `OpenCode ${model}` } : undefined;
  }
  return LAUNCHERS.find((launcher) => launcher.id === id);
}

/**
 * Resolve a request through the global program switch. Claude choices become
 * the configured OpenCode model, or the configured Antigravity one; an
 * Antigravity or Codex row asked for by name is kept on every position.
 */
export function launcherFor(id: string | undefined, settings: LaunchSettings): Launcher | undefined {
  const asked = findLauncher(id || "claude");
  if (settings.harnessCli === "opencode" && (!asked || asked.cli === "claude" || asked.cli === "opencode")) return opencodeLauncher(settings);
  if (settings.harnessCli === "agy" && (!asked || asked.cli === "claude" || asked.cli === "opencode")) return agyLauncher(settings);
  if (settings.harnessCli === "claude" && asked?.cli === "opencode") return findLauncher("claude");
  return asked;
}

/**
 * The line the login shell runs. The bypass flag is decided here, at launch, and
 * not recorded on the tab: changing the setting affects the next agent, never one
 * that is already running.
 */
export function launcherCommand(launcher: Launcher, settings?: LaunchSettings): string {
  if (launcher.cli === "opencode") {
    const model = launcher.model ?? settings?.opencodeModel ?? OPENCODE_DEFAULT_MODEL;
    const config = JSON.stringify({ agents: { build: { model } } });
    return `OPENCODE_CONFIG_CONTENT='${config}' opencode${settings?.bypassClis.includes("opencode") ? " --auto" : ""}`;
  }
  const parts: string[] = [launcher.cli];
  if (launcher.model) parts.push(MODEL_FLAG[launcher.cli], launcher.model);
  if (settings?.bypassClis.includes(launcher.cli)) parts.push(BYPASS_FLAG[launcher.cli]);
  return parts.join(" ");
}

/**
 * The line that picks a card's conversation back up, on the launcher it was
 * started with.
 *
 * Claude Code is handed the id kururu gave the session at launch (`--session-id`,
 * see `CardRun.sessionId`), so it goes straight back to the right one. Codex
 * keeps its own ids and never says them; once kururu has found one on disk
 * (`server/src/sessions.ts`) Codex is handed it the same way, and until then
 * it gets its picker — filtered to the directory, which on a card's worktree
 * is nearly always the one conversation, and `--all` when that directory has
 * gone and the filter would show nothing. The id is only ever one `SESSION_ID`
 * has passed, and is checked again here because this is a line for `sh -c`.
 * Codex's goes last, after the flags, where its positional argument belongs.
 */
export function resumeCommand(
  launcher: Launcher,
  settings: LaunchSettings | undefined,
  sessionId: string | null,
  anyDirectory: boolean,
): string | null {
  const flags = launcherCommand(launcher, settings).split(" ").slice(1);
  if (launcher.cli === "agy") {
    // Antigravity resumes by the id it reported (`--conversation`), and has
    // no picker to fall back on: `--continue` takes the newest conversation in
    // the directory, which in a shared checkout may be somebody else's.
    if (!sessionId || !SESSION_ID.test(sessionId)) return null;
    return ["agy", ...flags, "--conversation", sessionId].join(" ");
  }
  if (launcher.cli === "claude") {
    if (!sessionId || !SESSION_ID.test(sessionId)) return null;
    return ["claude", ...flags, "--resume", sessionId].join(" ");
  }
  if (sessionId && SESSION_ID.test(sessionId)) return ["codex", "resume", ...flags, sessionId].join(" ");
  return ["codex", "resume", ...(anyDirectory ? ["--all"] : []), ...flags].join(" ");
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
function promptArgument(command: string, prompt: string, flag?: string): string {
  let clean = prompt.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  if (clean.startsWith("-")) clean = ` ${clean}`;
  return `${command}${flag ? ` ${flag}` : ""} '${clean.replaceAll("'", `'\\''`)}'`;
}

/** Claude and Codex accept their opening request as a positional argument. */
export function withPrompt(command: string, prompt: string): string {
  return promptArgument(command, prompt);
}

/** OpenCode's only positional argument is a directory; its opening request is `--prompt`. */
export function withOpencodePrompt(command: string, prompt: string): string {
  return promptArgument(command, prompt, "--prompt");
}

/**
 * Antigravity's opening request is `--prompt-interactive`: it starts the
 * session on it and stays, where `--prompt` would print one reply and exit.
 */
export function withAgyPrompt(command: string, prompt: string): string {
  return promptArgument(command, prompt, "--prompt-interactive");
}

/** A launcher's line with the card's words on it, by whichever door that CLI takes them. */
export function withPromptFor(cli: AgentCli, command: string, prompt: string): string {
  if (cli === "opencode") return withOpencodePrompt(command, prompt);
  if (cli === "agy") return withAgyPrompt(command, prompt);
  return withPrompt(command, prompt);
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
  /**
   * End a card's agent once it has sat idle for `sleepMinutes` — its turn
   * over, nothing on its screen asking, nothing waiting to be typed into it,
   * nobody typing — and let running the card again pick the same conversation
   * back up. Agents are what drain a laptop's battery, and an agent whose
   * card is waiting in Review is one nobody is using. On by default, because
   * nothing is lost: the work is on disk and the conversation is on the card.
   * Only a card's agent, never one opened in a tab, never the harness — see
   * `server/src/sleep.ts`. Here rather than in a file of its own because it
   * is a rule about how agents run, and it rides the same page.
   */
  sleepIdle: boolean;
  sleepMinutes: number;
  /**
   * Which program Kuru runs on. Claude Code is billed to the Claude
   * subscription; OpenCode is billed to whatever OpenCode is signed in to —
   * an Anthropic API key, as a rule — which is what keeps Kuru answering on
   * the day the subscription's allowance runs out. One switch for every
   * profile, because what it answers is which account has credit left, and
   * that is a fact about the machine. It changes the next start only: a
   * running Kuru is a process, and Settings offers to restart it. See
   * `server/src/opencode.ts`.
   */
  harnessCli: HarnessCli;
  /**
   * The model OpenCode runs Kuru on, as OpenCode spells one:
   * `provider/model`, with an optional `#variant` for the effort. Claude
   * Code's harness has its model on its command line (`harnessRunFlags`);
   * OpenCode takes it from the config kururu writes into Kuru's folder.
   */
  opencodeModel: string;
  /**
   * The model Antigravity's CLI runs Kuru and the switched agents on, as
   * `agy models` names one: the model and its effort in one id. One of the
   * catalogue's Antigravity rows, since those are the ids known to exist.
   */
  agyModel: string;
}

/** The programs Kuru and, through the same switch, its default agents may run on. */
export const HARNESS_CLIS = ["claude", "opencode", "agy"] as const;
export type HarnessCli = (typeof HARNESS_CLIS)[number];

export const HARNESS_CLI_LABELS: Record<HarnessCli, string> = {
  claude: "Claude Code",
  opencode: "OpenCode",
  agy: "Antigravity",
};

/**
 * The model OpenCode's Kuru starts on: Claude Code's harness model
 * (`HARNESS_MODEL`) at its effort, in OpenCode's spelling, so switching
 * programs does not also switch brains.
 */
export const OPENCODE_DEFAULT_MODEL = "anthropic/claude-opus-5-5#high";

/**
 * What an OpenCode model may be written as: a provider, a slash, a model id
 * that may itself hold slashes (`openrouter/anthropic/claude-opus-5-5`), and
 * an optional `#variant`. It goes into a JSON file and never a shell, but it
 * is held to a grammar anyway, because a field somebody typed into is a
 * field that will one day hold a paragraph.
 */
export const OPENCODE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]*(#[A-Za-z0-9._-]+)?$/;
const OPENCODE_MODEL_MAX = 120;

/** A model somebody typed, as `opencodeModel` keeps it, or null when it is not one. */
export function adoptOpencodeModel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const model = value.trim();
  return model.length <= OPENCODE_MODEL_MAX && OPENCODE_MODEL.test(model) ? model : null;
}

/** What `sleepMinutes` may be: a minute at the least, a day at the most. */
export const SLEEP_MINUTES_MIN = 1;
export const SLEEP_MINUTES_MAX = 1440;

export const DEFAULT_LAUNCH: LaunchSettings = {
  offClis: [],
  offLaunchers: [],
  bypassClis: [],
  loginsPerProfile: false,
  sleepIdle: true,
  sleepMinutes: 10,
  harnessCli: "claude",
  opencodeModel: OPENCODE_DEFAULT_MODEL,
  agyModel: AGY_DEFAULT_MODEL,
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
    // Absent is on: a `launch.json` written before this existed gets the default.
    sleepIdle: obj.sleepIdle !== false,
    sleepMinutes: sleepMinutes(obj.sleepMinutes),
    // Claude unless OpenCode was chosen: a file from before the choice, or a
    // word this version does not know, keeps Kuru where it always was.
    harnessCli: obj.harnessCli === "opencode" || obj.harnessCli === "agy" ? obj.harnessCli : "claude",
    opencodeModel: adoptOpencodeModel(obj.opencodeModel) ?? OPENCODE_DEFAULT_MODEL,
    agyModel: adoptAgyModel(obj.agyModel) ?? AGY_DEFAULT_MODEL,
  };
}

/**
 * A number somebody typed into a box, as whole minutes in range — or the
 * default, for anything that is not a number at all. `Number.isFinite` before
 * the clamp, because NaN loses every comparison it is in.
 */
function sleepMinutes(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_LAUNCH.sleepMinutes;
  return Math.min(SLEEP_MINUTES_MAX, Math.max(SLEEP_MINUTES_MIN, Math.round(value)));
}

/** What the new-tab menu shows, in catalogue order. */
export function visibleLaunchers(settings: LaunchSettings): Launcher[] {
  if (settings.harnessCli === "opencode") return [opencodeLauncher(settings)];
  if (settings.harnessCli === "agy") {
    // The switch's own row first, which is what a card is run on by default,
    // then the other Antigravity rows still switched on.
    const first = agyLauncher(settings);
    return [first, ...LAUNCHERS.filter((launcher) => launcher.cli === "agy" && launcher.id !== first.id && !settings.offLaunchers.includes(launcher.id))];
  }
  return LAUNCHERS.filter(
    (launcher) => !settings.offClis.includes(launcher.cli) && !settings.offLaunchers.includes(launcher.id),
  );
}

/** More rows than the catalogue will ever have; a bound on what another node may hand over. */
export const LAUNCHERS_MAX = 64;
const LABEL_MAX = 60;

/**
 * Another node's launchers, as its summary carries them: the rows its own
 * `+` menu shows, from its own catalogue. A remote pane offers these rather
 * than this node's, because the agent runs there and the id goes back there
 * — a model this version knows and the box's does not would be a tab that
 * says so after the fact. Anything that is not a row of the right shape is
 * dropped, and a model name is held to `MODEL_NAME` though it is only ever
 * drawn here: the box looks the id up in its own catalogue, never this one.
 */
export function adoptLaunchers(raw: unknown): Launcher[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Launcher[] = [];
  const seen = new Set<string>();
  for (const row of raw.slice(0, LAUNCHERS_MAX)) {
    if (!row || typeof row !== "object") continue;
    const { id, cli, model, label } = row as Record<string, unknown>;
    if (typeof id !== "string" || !id || id.length > 120 || seen.has(id)) continue;
    if (typeof cli !== "string" || !(AGENT_CLIS as readonly string[]).includes(cli)) continue;
    if (typeof label !== "string" || !label.trim()) continue;
    if (model !== undefined && (typeof model !== "string" || (cli === "opencode" ? !adoptOpencodeModel(model) : !MODEL_NAME.test(model)))) continue;
    seen.add(id);
    out.push({ id, cli: cli as AgentCli, label: label.slice(0, LABEL_MAX), ...(typeof model === "string" ? { model } : {}) });
  }
  return out;
}
