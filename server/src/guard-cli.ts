/**
 * What the guard hook runs: Claude Code's and Codex's `PreToolUse` on
 * `Bash`, for every agent kururu starts. It reads the call off stdin and,
 * when `guardRefusal` says the command aims a destructive verb at a system
 * path, exits 2 with the reason on stderr, which both programs take as "do
 * not run this, and tell the model why". See `shared/rmguard.ts` for what
 * is refused and the night it was written for.
 *
 * Anything else exits 0 and says nothing, a payload it cannot read
 * included: the guard is for one kind of accident, and a hook that failed
 * on what it did not understand would stop agents' ordinary work.
 *
 * Run through `~/.local/state/kururu/bin/rmguard` (`guardbin.ts`), whose
 * shell looks for a destructive word first, so most calls never start this.
 */
import { commandOfPayload, guardRefusal } from "../../shared/rmguard";

async function main(): Promise<number> {
  if (process.stdin.isTTY) return 0;
  let raw = "";
  for await (const chunk of process.stdin) raw += String(chunk);
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return 0;
  }
  const command = commandOfPayload(payload);
  if (!command) return 0;
  const why = guardRefusal(command, process.env);
  if (!why) return 0;
  process.stderr.write(`${why}\n`);
  return 2;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0),
);
