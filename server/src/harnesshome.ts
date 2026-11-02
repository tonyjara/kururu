/**
 * The folder each profile's harness runs in, which is no project's.
 *
 * The harness used to start in the profile's active workspace, which meant
 * whichever project happened to be on screen the first time and then, through
 * `--resume`, that one for good. In one profile that was a client project: every
 * wake loaded its 13.6k-token AGENTS.md into a session that never codes it,
 * and its memory was filed beside that project's agents' and read by them.
 * A folder of its own fixes both, because Claude Code takes its instructions
 * and its memory from the directory it runs in and from nothing else.
 *
 * Under the data directory rather than the config one, for a reason that is
 * not about data: `~/.config` is often somebody's dotfiles repository, and a
 * session started inside a git repository is given that repository's status
 * in its system prompt. The data directory is kururu's and is never one.
 * By the profile's key, never its counter id or its name, which change.
 *
 * Writing the folder is all this does. Claude Code's own `.claude.json` —
 * where it records that a folder is trusted — is written by every running
 * session and holds the login, so kururu answers the trust dialog on the
 * screen instead (`Harness.trustHome`), the one time it is asked.
 */
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { HARNESS_AGENTS_MD, HARNESS_CLAUDE_MD, kuruMcpServers, kuruSettings, memoryIndexFor, memoryOrigin, projectDirName, withCompactSection } from "../../shared/harness";
import { isStoreKey } from "../../shared/store";
import { dataDir } from "./store";

/** How much of a transcript's head is read to learn whether it was a harness session: the title is written in its first records. */
const TITLE_HEAD = 64 * 1024;
const HARNESS_TITLE = '"customTitle":"harness"';

/** The harness's folder for a profile. Throws on a key that is not one, since it becomes a path. */
export function harnessHome(profileKey: string): string {
  if (!isStoreKey(profileKey) || !profileKey.startsWith("pk")) throw new Error("not a profile key");
  return join(dataDir(), "harness", profileKey);
}

/**
 * Make the folder ready to start in: there, with its two files, and with the
 * harness's memories carried over the first time from wherever its last
 * session ran. Files that exist are left alone — after the first start they
 * are the user's.
 */
export async function prepareHarnessHome(home: string, claudeDir: string, previousSession: string | null): Promise<void> {
  await mkdir(home, { recursive: true });
  for (const [name, text] of [
    ["AGENTS.md", HARNESS_AGENTS_MD],
    ["CLAUDE.md", HARNESS_CLAUDE_MD],
  ] as const) {
    await writeFile(join(home, name), text, { flag: "wx" }).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "EEXIST") throw err;
    });
  }
  // The one section kururu keeps in a file that is otherwise the user's, added
  // to a folder made before it existed — see `HARNESS_COMPACT_SECTION`.
  const agentsMd = join(home, "AGENTS.md");
  const was = await readFile(agentsMd, "utf8");
  const now = withCompactSection(was);
  if (now !== was) await writeFile(agentsMd, now);
  if (previousSession) await carryMemory(home, claudeDir, previousSession);
}

/**
 * The flags that keep Kuru to kururu's tools and the user's own: only the
 * MCP servers on its line (`--strict-mcp-config`), the login's user-scope
 * servers among them, and one `--settings` with the plugins and synced skills
 * off and kururu's hooks in it when the login lacks them. See `kuruSettings`
 * and `kuruMcpServers` for why each.
 *
 * Files rather than JSON on the line, because a user-scope server can carry
 * an API key in its `env`, and a command line is readable by every process on
 * the Mac; so 0600, in the state directory, which no backup copies. Rewritten
 * at every start, as the hooks' file is: the login's plugins and servers
 * change, and a stale server file is removed rather than left to be read.
 */
export async function kuruLaunchFlags(claudeDir: string, profileKey: string, hooks: object | null, own: readonly string[]): Promise<string> {
  const dir = join(process.env.KURURU_STATE_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "kururu"), "kuru");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const settingsFile = join(dir, `${profileKey}-settings.json`);
  const serversFile = join(dir, `${profileKey}-mcp.json`);
  const settings = kuruSettings({ userSettings: await readJson(join(claudeDir, "settings.json")), synced: await syncedSkills(claudeDir), hooks });
  await writePrivate(settingsFile, settings);
  const flags = ["--strict-mcp-config", "--settings", shQuote(settingsFile)];
  const servers = kuruMcpServers(await readJson(claudeJsonOf(claudeDir)), own);
  if (servers) {
    await writePrivate(serversFile, servers);
    flags.push("--mcp-config", shQuote(serversFile));
  } else {
    await rm(serversFile, { force: true });
  }
  return ` ${flags.join(" ")}`;
}

/**
 * Where a login keeps its user-scope MCP servers: `.claude.json` inside the
 * config directory when `CLAUDE_CONFIG_DIR` moved it — every profile's own
 * login — and beside the home directory's `.claude` when it did not.
 */
function claudeJsonOf(claudeDir: string): string {
  const inside = join(claudeDir, ".claude.json");
  return existsSync(inside) || claudeDir !== join(homedir(), ".claude") ? inside : join(homedir(), ".claude.json");
}

/** The skills claude.ai syncs into a login, by name: one folder each under `skills/synced/<account>/`. Nothing when there are none or the layout is not that. */
async function syncedSkills(claudeDir: string): Promise<string[]> {
  const root = join(claudeDir, "skills", "synced");
  const names = new Set<string>();
  for (const account of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!account.isDirectory()) continue;
    for (const skill of await readdir(join(root, account.name), { withFileTypes: true }).catch(() => [])) {
      if (skill.isDirectory() && !skill.name.startsWith(".")) names.add(skill.name);
    }
  }
  return [...names].sort();
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

async function writePrivate(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  // The mode on the write applies to a new file only.
  await chmod(path, 0o600);
}

/** Single-quoted for the `sh -c` a terminal's command runs under. */
function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The memories the harness wrote while it ran somewhere else, copied into the
 * memory of its own folder — once, when that memory does not exist yet.
 *
 * Copied and never moved: the folder it ran in was a project's, and the
 * project's agents may have come to rely on what the harness left there.
 * And only the harness's: that folder's memory was shared with every agent
 * that ever ran in the project, and a migration that carried the project's
 * Drizzle gotchas into the harness would undo half the point. A memory is the
 * harness's when the session its frontmatter names was one — a transcript in
 * that folder titled as the harness is (`--name harness`).
 */
async function carryMemory(home: string, claudeDir: string, previousSession: string): Promise<void> {
  const projects = join(claudeDir, "projects");
  const target = join(projects, projectDirName(home), "memory");
  if (existsSync(target)) return;
  const names = await readdir(projects).catch(() => [] as string[]);
  const from = names.find((name) => existsSync(join(projects, name, `${previousSession}.jsonl`)));
  if (!from || from === projectDirName(home)) return;
  const source = join(projects, from, "memory");
  const files = (await readdir(source).catch(() => [] as string[])).filter((name) => name.endsWith(".md") && name !== "MEMORY.md");
  const sessions = new Map<string, boolean>();
  const kept = new Set<string>();
  for (const name of files) {
    const origin = memoryOrigin(await readFile(join(source, name), "utf8"));
    if (!origin) continue;
    if (!sessions.has(origin)) sessions.set(origin, await wasHarness(join(projects, from, `${origin}.jsonl`)));
    if (sessions.get(origin)) kept.add(name);
  }
  if (!kept.size) return;
  await mkdir(target, { recursive: true });
  for (const name of kept) await copyFile(join(source, name), join(target, name));
  const index = await readFile(join(source, "MEMORY.md"), "utf8").catch(() => "");
  await writeFile(join(target, "MEMORY.md"), memoryIndexFor(index, kept));
  console.log(`kururu: carried ${kept.size} of the harness's memories over from ${from}`);
}

async function wasHarness(transcript: string): Promise<boolean> {
  const file = await open(transcript, "r").catch(() => null);
  if (!file) return false;
  try {
    const buffer = Buffer.alloc(TITLE_HEAD);
    const { bytesRead } = await file.read(buffer, 0, TITLE_HEAD, 0);
    return buffer.subarray(0, bytesRead).toString("utf8").includes(HARNESS_TITLE);
  } finally {
    await file.close();
  }
}
