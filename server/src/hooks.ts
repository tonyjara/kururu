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
 * by hand, as it always did for `~/.claude`.
 *
 * The script is `report.mjs`, bundled beside `server.mjs` by `desktop/build.mjs`,
 * and run by whatever is running the server: `node` from a checkout, the app's
 * own Electron binary once packaged — which is why `ELECTRON_RUN_AS_NODE` is on
 * the line, and why neither `bun` nor the checkout has to exist on a machine that
 * only has the app. Rewritten at every launch rather than once, because the
 * path in it moves when the server does and the write is a few hundred bytes.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
  ["Notification", "blocked"],
];

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
  const script = fileURLToPath(new URL("./report.mjs", import.meta.url));
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

/** ` --settings '<file>'`, or nothing. Appended to a launcher's command line. */
export function hookSettingsFlag(): string {
  const file = hookSettingsFile();
  return file ? ` --settings ${quote(file)}` : "";
}
