/**
 * Antigravity's CLI, `agy`, as a fourth program: the pure half — the lines,
 * the session settings, the reading of what it says about itself, and its
 * quota as the usage bar draws one.
 *
 * Why a fourth: Antigravity sells the same Claude models on a quota of its
 * own, and on the day the Claude subscription's allowance is spent that
 * quota is still there. The sanctioned way to spend it is Antigravity's own
 * terminal agent, so kururu runs `agy` in a pty as it runs `claude`, and
 * never lends Antigravity's sign-in to anything else: no token is read, no
 * other program is made to look like Antigravity, and everything below goes
 * through doors `agy` documents.
 *
 * Which doors, since `agy` has none of Claude Code's per-launch ones:
 *
 * - **`--settings` is the per-launch door.** It takes settings.json keys for
 *   one session, never saved, so the user's own `settings.json` is never
 *   written. Through it kururu sets a *title command*, trusts Kuru's own
 *   folder, and allows Kuru its kururu tools (`mcp(kururu/*)`).
 * - **The title command is the reporter.** `agy` runs it on every change of
 *   its state with a JSON payload — the state, the conversation id, the
 *   context window and the plan's quota — and puts what it prints in the
 *   window title. Hooks would say more, but `agy` reads hooks only from
 *   `~/.gemini/config/hooks.json` or a project's `.agents/hooks.json`, and
 *   kururu writes into neither the user's config nor the user's projects.
 *   So an ordinary agent is reported on through the title alone: working on
 *   any busy state, done with its reply (read off the transcript `agy`
 *   keeps) when it goes back to idle, and its conversation id for resume.
 * - **Blocked is read off the screen.** The title says `tool_use` while a
 *   permission prompt waits, the same as while the tool runs, so the prompt
 *   itself is what `shared/onscreen.ts` recognises.
 * - **Kuru's folder is kururu's,** so Kuru gets the project doors there:
 *   `.agents/rules/` for its role, `.agents/mcp_config.json` for kururu's
 *   tools and `.agents/hooks.json` for the user's words and Kuru's reply,
 *   which the title cannot carry. See `server/src/agy.ts`.
 *
 * What it does not get: kururu's web tools for an ordinary agent (they would
 * need an MCP config in the user's project), compaction at kururu's point
 * (`agy` compacts on its own), and the usage ledger (it reads Claude's and
 * Codex's logs, not this one's).
 */
import { HARNESS_SERVER, HARNESS_TOOLS, MCP_TIMEOUT_MS } from "./harness";
import { WEB_SERVER, WEB_TIMEOUT_MS, WEB_TOOL_NAMES, webUrl } from "./web";
import type { AgentStatus, ContextUsage } from "./model";
import type { UsageLimit } from "./wire";
import { shq } from "./text";

/** How `agy` is installed, for the sentence that says it is missing. */
export const AGY_INSTALL = "curl -fsSL https://antigravity.google/cli/install.sh | bash";

/**
 * Where `agy` keeps a conversation's transcript, under the home directory:
 * one JSON line a step, the model's replies as `PLANNER_RESPONSE`. The CLI's
 * own folder first; the app's, which the title payload names, second.
 */
export function agyTranscriptPaths(home: string, conversation: string): string[] {
  if (!AGY_CONVERSATION.test(conversation)) return [];
  return ["antigravity-cli", "antigravity"].map((dir) => `${home}/.gemini/${dir}/brain/${conversation}/.system_generated/logs/transcript_full.jsonl`);
}

/**
 * Whether a terminal's command line is an `agy` kururu started on this Mac:
 * the launcher's line, after a card's setup line when there was one. What
 * the on-screen reader is pointed at (`server/src/onscreen.ts`); a remote
 * agent's line is `remoteShellOf`'s to recognise.
 */
export function isAgyLine(command: string | null | undefined): boolean {
  return typeof command === "string" && /(?:^|&&\s+)agy\s/.test(command);
}

/** What a conversation id is: a UUID, and only that, because it goes onto a command line and into a path. */
export const AGY_CONVERSATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The reply a turn ended on: the text of the last model step after the last
 * thing the user said, or null while there is none — a turn that only ran
 * tools, or one still being written.
 */
export function agyLastReply(transcript: string): string | null {
  const lines = transcript.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let step: { type?: unknown; content?: unknown };
    try {
      step = JSON.parse(line);
    } catch {
      // A tail's first line is cut; any other is a write in progress.
      continue;
    }
    if (step.type === "USER_INPUT") return null;
    if (step.type === "PLANNER_RESPONSE" && typeof step.content === "string" && step.content.trim()) return step.content.trim();
  }
  return null;
}

/**
 * A state the title payload names, as a status: idle as idle, start-up as
 * nothing, and every other — `thinking`, `working`, `tool_use`, and whatever
 * a later version adds — as working, since a state that is not idle is the
 * agent doing something.
 */
export function agyStatusOf(state: unknown): "working" | "idle" | null {
  if (typeof state !== "string" || !state) return null;
  if (state === "idle") return "idle";
  if (state === "initializing" || state === "authenticating") return null;
  return "working";
}

/**
 * What one title call means, given the state the last call left: `working`
 * on the way into a turn, `done` on the way out of one, `wake` the first time
 * an agent that has done nothing yet is idle — which is how a Kuru just
 * started says it can be typed to — and null for the rest, since the title
 * is run on every redraw of the state and says the same thing many times.
 */
export function agyTransition(previous: string | null, next: unknown): "working" | "done" | "wake" | null {
  const now = agyStatusOf(next);
  const was = previous === null ? null : agyStatusOf(previous);
  if (now === "working") return was === "working" ? null : "working";
  if (now === "idle") {
    if (was === "working") return "done";
    return previous === null || was === null ? "wake" : null;
  }
  return null;
}

/** How full the context is, off the title payload: the input of the last request against the window. */
export function agyContext(payload: unknown): ContextUsage | null {
  const window = (payload as { context_window?: Record<string, unknown> } | null)?.context_window;
  if (!window || typeof window !== "object") return null;
  const size = window.context_window_size;
  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) return null;
  const current = window.current_usage as Record<string, unknown> | null | undefined;
  const n = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
  const used = current && typeof current === "object" ? n(current.input_tokens) + n(current.cache_read_input_tokens) + n(current.cache_creation_input_tokens) : 0;
  if (used > 0) return { used, window: size };
  const percent = n(window.used_percentage);
  return percent > 0 ? { used: Math.round((percent / 100) * size), window: size } : null;
}

/** The quota as kururu keeps it on disk: what the payload said, minus the email beside it. */
export interface AgyQuota {
  /** When the reporter wrote it, in ms. */
  at: number;
  /** `Google AI Ultra`, as `plan_tier` says, or null. */
  plan: string | null;
  /** The windows, as the payload names them: `3p-5h`, `gemini-weekly`… */
  windows: Record<string, { remaining: number; resetsAt: string | null }>;
}

/** The quota out of a title payload, or null when it carries none. Nothing else is kept — not the email, not the folder. */
export function agyQuotaOf(payload: unknown, at: number): AgyQuota | null {
  const raw = (payload as { quota?: unknown } | null)?.quota;
  if (!raw || typeof raw !== "object") return null;
  const windows: AgyQuota["windows"] = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-z0-9]+-[a-z0-9]+$/i.test(name) || !value || typeof value !== "object") continue;
    const { remaining_fraction: remaining, reset_time: reset } = value as Record<string, unknown>;
    if (typeof remaining !== "number" || !Number.isFinite(remaining)) continue;
    windows[name] = { remaining: Math.max(0, Math.min(1, remaining)), resetsAt: typeof reset === "string" && Number.isFinite(Date.parse(reset)) ? reset : null };
  }
  if (!Object.keys(windows).length) return null;
  const tier = (payload as { plan_tier?: unknown }).plan_tier;
  return { at, plan: typeof tier === "string" && tier.length <= 60 ? tier : null, windows };
}

/** What each quota group is called on the bar: `3p` is every model that is not Google's, which today is Claude's and GPT-OSS. */
const GROUPS: Record<string, string> = { "3p": "Claude/GPT", gemini: "Gemini" };

/**
 * The quota as the bar's limits: spent, not remaining, because every other
 * measure on the bar fills (`Usage.tsx` says why). A five-hour window is a
 * session and a week a week, scoped to the group, so the rings read
 * "Session · Claude/GPT". A window whose reset has passed is dropped, as
 * Codex's are. Severity is ours, at Codex's points, since Antigravity's
 * warning threshold is drawn in its statusline and not said in the payload.
 */
export function agyLimitsFrom(quota: AgyQuota | null, now: number): UsageLimit[] {
  if (!quota) return [];
  const limits: UsageLimit[] = [];
  const order = (name: string) => (name.startsWith("3p") ? 0 : 1) * 10 + (name.endsWith("weekly") ? 1 : 0);
  for (const name of Object.keys(quota.windows).sort((a, b) => order(a) - order(b) || a.localeCompare(b))) {
    const window = quota.windows[name]!;
    if (window.resetsAt && Date.parse(window.resetsAt) <= now) continue;
    const [group = name, clock = ""] = name.split("-");
    const kind = clock === "5h" ? "session" : clock === "weekly" ? "weekly_all" : clock;
    const percent = Math.round((1 - window.remaining) * 1000) / 10;
    limits.push({
      kind,
      group: kind,
      percent,
      severity: percent >= 90 ? "critical" : percent >= 75 ? "warning" : "normal",
      resetsAt: window.resetsAt,
      scope: GROUPS[group] ?? group,
    });
  }
  return limits;
}

/** A quota file as it came off the disk, or null when it is not one. */
export function adoptAgyQuota(raw: unknown): AgyQuota | null {
  if (!raw || typeof raw !== "object") return null;
  const { at, plan, windows } = raw as Record<string, unknown>;
  if (typeof at !== "number" || !Number.isFinite(at) || !windows || typeof windows !== "object") return null;
  const kept: AgyQuota["windows"] = {};
  for (const [name, value] of Object.entries(windows as Record<string, unknown>)) {
    const { remaining, resetsAt } = (value ?? {}) as Record<string, unknown>;
    if (typeof remaining !== "number" || !Number.isFinite(remaining)) continue;
    kept[name] = { remaining: Math.max(0, Math.min(1, remaining)), resetsAt: typeof resetsAt === "string" ? resetsAt : null };
  }
  return { at, plan: typeof plan === "string" ? plan : null, windows: kept };
}

/**
 * The settings `--settings` hands one launch: the title command, and for
 * Kuru the folder trusted and its tools allowed. Never written into the
 * user's `settings.json` — `agy` says a `--settings` value is never saved.
 */
export function agySessionSettings(args: { title: string; trusted?: string[]; allowMcp?: string[] }): Record<string, unknown> {
  return {
    title: { type: "command", command: args.title },
    ...(args.trusted?.length ? { trustedWorkspaces: args.trusted } : {}),
    ...(args.allowMcp?.length ? { permissions: { allow: args.allowMcp.map((server) => `mcp(${server}/*)`) } } : {}),
  };
}

/**
 * The title command: kururu's reporter, run by whatever runs the server —
 * the checkout's `node` or the app's own binary, as `hooks.ts` runs the
 * Claude hooks — with the mode and the launch's nonce on the end, the nonce
 * naming the file the reporter keeps its last state in. `kuru` mode reports only the
 * wake and the quota, because Kuru's hooks report its turns and two
 * reporters would read every reply aloud twice.
 */
export function agyTitleCommand(runtime: string, script: string, mode: "agent" | "kuru", launch: string): string {
  if (!/^[0-9a-f]{16}$/.test(launch)) throw new Error("not a launch nonce");
  return `ELECTRON_RUN_AS_NODE=1 ${shq(runtime)} ${shq(script)} title ${mode} ${launch}`;
}

/** The same reporter as a hook, for Kuru's folder: the event it is run for on the end. */
export function agyHookCommand(runtime: string, script: string, event: string): string {
  return `ELECTRON_RUN_AS_NODE=1 ${shq(runtime)} ${shq(script)} hook ${event}`;
}

/**
 * Kuru's `.agents/hooks.json`: the user's words when a turn starts
 * (`PreInvocation`, whose first invocation of a turn carries them as
 * `lastUserInput`), and the reply when it ends (`Stop`). Each answers `{}`
 * or lets the stop stand, and never holds a turn up for long.
 */
export function agyKuruHooks(runtime: string, script: string): Record<string, unknown> {
  const hook = (event: string) => [{ type: "command", command: agyHookCommand(runtime, script, event), timeout: 10 }];
  return { kururu: { PreInvocation: hook("PreInvocation"), Stop: hook("Stop") } };
}

/**
 * Kuru's `.agents/mcp_config.json`: kururu's verbs, the same endpoint and
 * query Claude Code is given, and the web tools beside them when a provider
 * is on. Every tool is eager, which `agy` registers as
 * `mcp_<server>_<tool>` rather than behind its lazy `call_mcp_tool`, so the
 * role can name them and a turn is not spent reading a schema first.
 *
 * A token is written only when this server wants one on loopback, and then
 * as itself: `agy` documents no substitution in this file. The folder is
 * kururu's and the file is written 0600 (`server/src/agy.ts`).
 */
export function agyKuruMcp(args: { port: number; profileId: string; session: string; token: string | null; web: boolean }): Record<string, unknown> {
  const auth = args.token ? { authorization: `Bearer ${args.token}` } : {};
  const eager = (names: readonly string[]) => Object.fromEntries(names.map((name) => [name, { eager: true }]));
  const servers: Record<string, unknown> = {
    [HARNESS_SERVER]: {
      serverUrl: `http://127.0.0.1:${args.port}/mcp?profile=${encodeURIComponent(args.profileId)}&session=${encodeURIComponent(args.session)}`,
      timeoutSeconds: Math.round(MCP_TIMEOUT_MS / 1000),
      tools: eager(HARNESS_TOOLS.map((tool) => tool.name)),
      ...(args.token ? { headers: auth } : {}),
    },
  };
  if (args.web) {
    servers[WEB_SERVER] = {
      serverUrl: webUrl(args.port),
      timeoutSeconds: Math.round(WEB_TIMEOUT_MS / 1000),
      tools: eager(WEB_TOOL_NAMES),
      // No agent header: the file is written before Kuru's terminal has an
      // id, and the endpoint takes a call without one as nobody's in particular.
      ...(args.token ? { headers: auth } : {}),
    };
  }
  return { mcpServers: servers };
}

/** The role as an always-on rule: the frontmatter `agy` reads, then the words. */
export function agyRoleRule(role: string): string {
  return `---\ntrigger: always_on\ndescription: Kuru, kururu's harness\n---\n${role}\n`;
}

/**
 * The line that starts Kuru on `agy`: the model, the session settings, the
 * conversation to resume when there is one, and the bypass when Claude
 * Code's harness would have had it — the same switch, so the two programs
 * run Kuru on the same leash. The settings go inline, as JSON in one quoted
 * word: they hold a path and a command and nothing secret, and a file per
 * launch would be one more thing to clear away.
 */
export function agyKuruCommand(args: { model: string; settings: Record<string, unknown>; conversation: string | null; bypass: boolean }): string {
  if (args.conversation !== null && !AGY_CONVERSATION.test(args.conversation)) throw new Error("not an agy conversation id");
  return [
    "agy",
    "--model",
    shq(args.model),
    "--settings",
    shq(JSON.stringify(args.settings)),
    ...(args.conversation ? ["--conversation", args.conversation] : []),
    ...(args.bypass ? ["--dangerously-skip-permissions"] : []),
  ].join(" ");
}

/** What a hook's or a title's report to `/api/report` carries, as the reporter builds it. Pure, for the test. */
export function agyReport(args: {
  agent: string;
  status: AgentStatus | null;
  conversation: string | null;
  context: ContextUsage | null;
  message?: string | null;
  reply?: string | null;
}): Record<string, unknown> | null {
  if (!args.status && !args.context) return null;
  return {
    agent: args.agent,
    program: "agy",
    ...(args.status ? { status: args.status } : {}),
    ...(args.conversation && AGY_CONVERSATION.test(args.conversation) ? { session: args.conversation } : {}),
    ...(args.context ? { context: args.context } : {}),
    ...(args.message ? { message: args.message } : {}),
    ...(args.reply ? { reply: args.reply } : {}),
  };
}
