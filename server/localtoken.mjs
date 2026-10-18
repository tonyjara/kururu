/**
 * The token kururu's own callers on this machine present to its server.
 *
 * On the Mac nothing on loopback is asked for one, and this is a header the
 * gate ignores. A child asks loopback too (`server/src/access.ts` says why),
 * and then every program of kururu's that talks to the server from the box —
 * the hooks, `status`, `reload-window`, the backup and restore CLIs — has to
 * have it, or it is refused like a stranger. Found in one place for all of
 * them, in plain JavaScript beside the two tools that run unbuilt, as
 * `sockowner.mjs` is.
 *
 * `access.json` first, where the server keeps it, because it is the current
 * one: a token rotated while an agent runs leaves the agent's environment
 * holding the old. Then `KURURU_TOKEN`, which is how the server hands it to
 * the ptys it opens, for a process that cannot see the config directory. The
 * directory is `config.ts`'s rule, spelt again because this file cannot
 * import that one.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The token, or null when there is none to present — a server that has never started here. */
export function localToken(env = process.env) {
  try {
    const dir = env.KURURU_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "kururu");
    const saved = JSON.parse(readFileSync(join(dir, "access.json"), "utf8"));
    if (typeof saved?.token === "string" && saved.token.length >= 16) return saved.token;
  } catch {
    // None here; the environment is the other place.
  }
  return env.KURURU_TOKEN || null;
}

/** `{ authorization }` to spread into a request's headers, or nothing. */
export function tokenHeaders(env = process.env) {
  const token = localToken(env);
  return token ? { authorization: `Bearer ${token}` } : {};
}
