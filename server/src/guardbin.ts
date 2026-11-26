/**
 * `rmguard`, the guard hook's command, written where every launch can name
 * it by one path: `~/.local/state/kururu/bin/rmguard`, beside `slot` and
 * `vault`, pointing at the bundled `guard.mjs` and run on this server's
 * own runtime. Rewritten on each start, so it follows the build that is
 * serving; a server run from source with nothing built writes nothing, and
 * its agents start without the guard rather than with a hook that fails.
 *
 * One stable path rather than the runtime and script on the hook's line,
 * as the reporter has, because Codex asks the owner to trust a hook and
 * remembers the trust by a hash of its definition: a line that moved with
 * the app would be a new hook, and a new question, every time it did.
 *
 * The script's first job is to leave. It runs before every shell command
 * of every agent, and a node process costs tens of milliseconds where a
 * shell `case` costs a few; so the shell looks at the call (from
 * `tool_input` on, past the session's own fields, where `permission_mode`
 * alone holds an `rm`) for any word a refusal needs, and only then starts
 * the guard. A refusal is exit 2, which the pipeline hands back.
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stateDir, writeAtomic } from "./fsutil";

/** Words one of which is in every command `guardRefusal` refuses. */
export const GUARD_WORDS = ["rm", "mv", "cp", "chmod", "chown", "chgrp", "mkfs", "newfs", "dd", "truncate", "tee", "find", "rsync", "shred", "unlink", "wipefs", ">"] as const;

export function guardCommandPath(): string {
  return join(stateDir(), "bin", "rmguard");
}

function guardScript(): string {
  return fileURLToPath(new URL("./guard.mjs", import.meta.url));
}

/** The script's text. Pure, for the test. */
export function guardCommandText(runtime: string, script: string): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const words = GUARD_WORDS.map((w) => `*${w === ">" ? "'>'" : w}*`).join("|");
  return [
    "#!/bin/sh",
    "# Written by kururu on each start: the guard on agents' shell commands. See docs/invariants.md#the-guard.",
    'p=$(cat)',
    'c=${p#*\\"tool_input\\"}',
    `case "$c" in ${words}) ;; *) exit 0;; esac`,
    `printf '%s' "$p" | ELECTRON_RUN_AS_NODE=1 ${q(runtime)} ${q(script)}`,
    "",
  ].join("\n");
}

export function writeGuardCommand(): string | null {
  const script = guardScript();
  if (!existsSync(script)) return null;
  try {
    mkdirSync(dirname(guardCommandPath()), { recursive: true });
    writeAtomic(guardCommandPath(), guardCommandText(process.execPath, script), { mode: 0o755 });
    return guardCommandPath();
  } catch {
    return null;
  }
}

/** The command a hook names, or null while there is none to name. */
export function guardCommand(): string | null {
  return existsSync(guardScript()) && existsSync(guardCommandPath()) ? guardCommandPath() : null;
}
