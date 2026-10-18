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
 * `KURURU_TOKEN` first, which is how the server hands it to the agents it
 * starts, and so to every hook and command they run; then `access.json`,
 * where the server keeps it, for a command typed in a terminal of somebody's
 * own. The directory is `config.ts`'s rule, spelt again because this file
 * cannot import that one.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The token, or null when there is none to present — a server that has never started here. */
export function localToken(env = process.env) {
  if (env.KURURU_TOKEN) return env.KURURU_TOKEN;
  try {
    const dir = env.KURURU_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "kururu");
    const file = join(dir, "access.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    return typeof saved?.token === "string" && saved.token.length >= 16 ? saved.token : null;
  } catch {
    return null;
  }
}

/** `{ authorization }` to spread into a request's headers, or nothing. */
export function tokenHeaders(env = process.env) {
  const token = localToken(env);
  return token ? { authorization: `Bearer ${token}` } : {};
}
