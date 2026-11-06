/**
 * Antigravity's `agy`, the half that touches the disk: the reporter's
 * place, each launch's session settings, Kuru's folder made ready, and the
 * quota the reporter leaves behind, read for the usage bar. The argument for
 * a fourth program, and which of `agy`'s doors stands in for which of Claude
 * Code's, is `shared/agy.ts`.
 *
 * On the restartable side, like `opencode.ts`: nothing here is the host's,
 * so editing it costs a reconnect and no agents.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  adoptAgyQuota,
  agyKuruHooks,
  agyKuruMcp,
  agyLimitsFrom,
  agyRoleRule,
  agySessionSettings,
  agyTitleCommand,
} from "../../shared/agy";
import { HARNESS_SERVER } from "../../shared/harness";
import { WEB_SERVER } from "../../shared/web";
import type { CodexUsage } from "../../shared/wire";
import { shq } from "../../shared/text";
import { stateDir } from "./fsutil";

/** Where the bundled reporter is, beside `server.mjs`, whether or not it has been built. */
function reportScript(): string {
  return fileURLToPath(new URL("./agyreport.mjs", import.meta.url));
}

/** A launch's own name for the reporter's state file. See `agy-report-cli.ts`. */
function mintLaunch(): string {
  return randomBytes(8).toString("hex");
}

/**
 * ` --settings '<json>'` for an ordinary agent's line, or nothing on a server
 * run from source without a build — which gets an agent whose status is the
 * host's guess and its screen's, rather than a title command that fails on
 * every change of state. Settings for this launch only; `agy` never saves them.
 */
export function agyAgentFlags(): string {
  const script = reportScript();
  if (!existsSync(script)) return "";
  const settings = agySessionSettings({ title: agyTitleCommand(process.execPath, script, "agent", mintLaunch()) });
  return ` --settings ${shq(JSON.stringify(settings))}`;
}

/** What `prepareAgyHome` needs: where kururu is, and who is asking. */
export interface AgyHomeArgs {
  port: number;
  profileId: string;
  /** The id Kuru's MCP address names it by — `selfFor` matches it. */
  session: string;
  /** The server's token, when it wants one on loopback; written into the 0600 config, never onto a line. */
  token: string | null;
  web: boolean;
}

/** A file only its owner reads: the MCP config can hold the token. */
function writePrivate(path: string, text: string): void {
  writeFileSync(path, text, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * Kuru's folder made ready for `agy`, and the session settings for its line:
 * the role as an always-on rule, kururu's tools in the folder's MCP config,
 * and the hooks that carry the user's words and Kuru's reply — all under
 * `.agents/`, all kururu's, rewritten on every start since the role names the
 * workspaces and the config the port. The folder is trusted and its kururu
 * tools allowed for this launch only, through the settings, so neither the
 * user's `settings.json` nor a dialog on Kuru's screen is involved.
 *
 * Throws when there is no built reporter: a Kuru that could not say it was
 * up would be a voice message waiting thirty seconds on a tab that started.
 */
export function prepareAgyHome(home: string, args: AgyHomeArgs, role: string): Record<string, unknown> {
  const script = reportScript();
  if (!existsSync(script)) throw new Error("Kuru on Antigravity needs kururu's built reporter (agyreport.mjs); run bun run build.");
  const dir = join(home, ".agents");
  mkdirSync(join(dir, "rules"), { recursive: true });
  writeFileSync(join(dir, "rules", "kururu-role.md"), agyRoleRule(role), "utf8");
  writePrivate(join(dir, "mcp_config.json"), `${JSON.stringify(agyKuruMcp({ port: args.port, profileId: args.profileId, session: args.session, token: args.token, web: args.web }), null, 2)}\n`);
  writeFileSync(join(dir, "hooks.json"), `${JSON.stringify(agyKuruHooks(process.execPath, script), null, 2)}\n`, "utf8");
  return agySessionSettings({
    title: agyTitleCommand(process.execPath, script, "kuru", mintLaunch()),
    trusted: [home],
    allowMcp: args.web ? [HARNESS_SERVER, WEB_SERVER] : [HARNESS_SERVER],
  });
}

/** Where the reporter leaves the quota. */
function quotaFile(): string {
  return join(stateDir(), "agy-quota.json");
}

/**
 * The Antigravity allowance, as the reporter last wrote it down: null until
 * an `agy` has run under kururu on this Mac, which draws no chip. The same
 * shape as Codex's, because it is the same kind of reading — what the program
 * last said, as of when it said it — and the bar draws both alike.
 */
export function readAgyUsage(now = Date.now()): CodexUsage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(quotaFile(), "utf8"));
  } catch {
    return null;
  }
  const quota = adoptAgyQuota(raw);
  if (!quota) return null;
  return { limits: agyLimitsFrom(quota, now), at: quota.at, plan: quota.plan };
}

let reading: CodexUsage | null = null;

/** Refresh the reading and say whether it moved. A file read, so it costs nothing to ask often. */
export function pollAgyUsage(): boolean {
  const next = readAgyUsage();
  const moved = JSON.stringify(next) !== JSON.stringify(reading);
  reading = next;
  return moved;
}

/** What the clients should be holding. */
export function agyUsageSnapshot(): CodexUsage | null {
  return reading;
}
