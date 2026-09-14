/**
 * Where the things a person *chose* are kept, and how they are written.
 *
 * Two settings files now — the mascot and the keyboard — and this exists so
 * there is one answer to where they go and one way of putting them there.
 * Duplicating either would be a rule spelt twice, which is how two files end up
 * in two directories after somebody fixes one of them.
 *
 * XDG's config directory rather than the state one `persist.ts` uses, and the
 * distinction is the whole point: `~/.local/state/kururu` holds the arrangement,
 * which kururu wants back and would rebuild for you; `~/.config/kururu` holds
 * decisions, which it would never invent and must not lose. A state directory
 * wiped between versions is an inconvenience; a config one wiped is somebody's
 * keyboard gone.
 *
 * Both halves are forgiving on purpose. A file that is missing, unreadable or
 * not JSON reads as "nothing saved", because the caller has a default for
 * exactly that case and a settings file is never the reason to fail to start. A
 * write that fails is not worth failing anything over either: the setting is
 * live in this session, and the next start is the one that forgets it.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Read per call rather than captured, so a test can move it with `XDG_CONFIG_HOME`. */
export function configDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "kururu");
}

export function configPath(name: string): string {
  return join(configDir(), name);
}

/** Whatever is in there, or null. The caller adopts it; nothing here inspects it. */
export function readConfigFile(name: string): unknown {
  try {
    return JSON.parse(readFileSync(configPath(name), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Written through a temporary file and renamed, for the same reason `persist.ts`
 * is: the alternative to an atomic write is a truncated JSON file where the
 * settings used to be, and the moment that matters is a crash mid-save.
 */
export function writeConfigFile(name: string, value: unknown): void {
  const path = configPath(name);
  try {
    mkdirSync(configDir(), { recursive: true });
    const temp = `${path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(temp, path);
  } catch {
    // Settings that could not be saved are still settings for now.
  }
}
