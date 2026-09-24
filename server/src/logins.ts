/**
 * Where a profile's logins live, and the two variables that send a terminal
 * there.
 *
 * Profiles carried accounts once — a Claude config directory *chosen* per
 * profile, beside a gh directory, a gitconfig and an ssh key — and the choosing
 * is what went wrong: a path typed into a box, a dropdown asking the tools what
 * was signed in where, and at the end of it a login that landed in a directory
 * nobody expected. This is what was left when the choosing was taken out. A
 * profile has a directory of its own, named by a key it was born with, and
 * Claude Code and Codex are pointed into it with the one variable each of them
 * reads for exactly this. Whoever you log in as inside that profile is who the
 * profile is from then on, and the sidebar's usage bar says whose allowance it
 * is drawing.
 *
 * What a profile *can* do is point at one of the other directories — the login
 * a second profile made, so that two drawers of workspaces are the same
 * account. That is choosing again, and it is allowed because of what is being
 * chosen from: `scanLogins` lists the directories kururu itself made, labelled
 * by the account record the tool wrote into each, and the picker offers those
 * and nothing else. No path is typed, and a key that names no such directory
 * is refused where it arrives. The failure the old design had — a terminal
 * opened as somebody you did not expect — needs a place for the unexpected to
 * come from, and a list read off the disk has none.
 *
 * Under config rather than state, on `config.ts`'s reasoning taken one step
 * further than a keymap needs it: a state directory wiped between versions is
 * an inconvenience, and this one holds logins, so a wipe would be an OAuth flow
 * per profile per tool. Nothing in here is ever deleted for the same reason.
 * Deleting a profile leaves its directory where it is, and removing a login is
 * a thing a person does on purpose, with `rm`.
 *
 * The directories start empty, and that is a decision rather than an omission.
 * A Claude config directory is not just a credential: it is settings, plugins,
 * hooks, skills and memory, and which of those a second account should share
 * with the first is not a question kururu can answer. Seeding a copy would
 * carry hooks and plugin state into a directory that has none of the plugins;
 * linking would share until the first tool that writes through a rename
 * quietly stopped it sharing. So a profile starts as a fresh install of both
 * tools — the same thing `CLAUDE_CONFIG_DIR=… claude` does by hand — and
 * `~/.claude` and `~/.codex` are never read, written or pointed at.
 *
 * The key is checked here as well as where it is minted, because this is the
 * one place it becomes a path. `files.ts`'s rule: refuse, never clamp.
 */
import { mkdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { isLoginKey, type LoginSummary } from "../../shared/model";
import { configPath } from "./config";
import { accountEmail } from "./usage";

/** The directory a profile's logins live in. Throws on a key that is not one. */
export function loginDir(loginKey: string): string {
  if (!isLoginKey(loginKey)) throw new Error("not a login key");
  return join(configPath("profiles"), loginKey);
}

/** The profile's `CLAUDE_CONFIG_DIR` — also where `usage.ts` reads its allowance from. */
export function claudeDirFor(loginKey: string): string {
  return join(loginDir(loginKey), "claude");
}

/** The profile's `CODEX_HOME`. */
export function codexDirFor(loginKey: string): string {
  return join(loginDir(loginKey), "codex");
}

/**
 * The environment a terminal in this profile is spawned with, on top of the
 * server's own — and the directories it names, made if they are not there yet.
 *
 * Made here, at spawn, rather than when the profile is: a profile made while
 * the setting was off should not have left an empty directory behind, and a
 * `mkdir` of something that exists costs a stat. Private to the user, because
 * one of the two tools keeps its token in a file in there. Claude Code would
 * create its own directory when pointed at a missing one; Codex is not relied
 * on to, and the two are made the same way so that neither is a special case.
 */
export function loginEnv(loginKey: string): Record<string, string> {
  const claude = claudeDirFor(loginKey);
  const codex = codexDirFor(loginKey);
  // The profile's own directory first and on its own, because it is the one
  // whose mode matters and a `recursive` mkdir is not owed a mode on the
  // directories it makes along the way.
  mkdirSync(loginDir(loginKey), { recursive: true, mode: 0o700 });
  mkdirSync(claude, { mode: 0o700, recursive: true });
  mkdirSync(codex, { mode: 0o700, recursive: true });
  return { CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex };
}

/**
 * Every login on the disk that a profile could be pointed at: each directory
 * under `profiles/` whose name is a key, with the email Claude Code recorded
 * in it or null for one nobody has signed into yet.
 *
 * Read from the disk each time rather than remembered, because the thing that
 * changes it is `/login` typed into a terminal, which raises no event this
 * process can hear. A handful of stats and small reads once a minute is what
 * that costs. Directories whose names are not keys are somebody else's and are
 * left alone; the caller decides which of the empty ones are worth listing,
 * since only it knows which keys the profiles are holding.
 */
export async function scanLogins(): Promise<LoginSummary[]> {
  const entries = await readdir(configPath("profiles"), { withFileTypes: true }).catch(() => []);
  const keys = entries
    .filter((entry) => entry.isDirectory() && isLoginKey(entry.name))
    .map((entry) => entry.name)
    .sort();
  return Promise.all(
    keys.map(async (key) => ({ key, email: await accountEmail(join(claudeDirFor(key), ".claude.json")) })),
  );
}
