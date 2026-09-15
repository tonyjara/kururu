/**
 * What it takes to open a terminal as somebody in particular, who that turns out
 * to be, and which accounts there are to choose from in the first place.
 *
 * A profile's identity is three paths (`shared/model.ts`), and every one of them
 * is an environment variable the tool itself reads. Which means the whole of
 * "this profile is my work account" is an env overlay applied at spawn: there is
 * no logging in and out, no global state being toggled under the other
 * terminals, and nothing to undo if kururu is not running. Two profiles with two
 * `CLAUDE_CONFIG_DIR`s are two accounts signed in at the same time, and a
 * `GH_CONFIG_DIR` only names which of the accounts already in gh's keyring is
 * the active one — so an account added in one place is usable from every other.
 *
 * The overlay is the whole mechanism and it is four lines. Everything else here
 * exists because a path is a terrible thing to ask somebody to type. The tools
 * already know which accounts exist, so the job is to ask them: `whoIs` answers
 * "who is this directory", `knownAccounts` answers "what is there to pick", and
 * `ensureGhConfig` writes the five lines of YAML that make a choice real. What a
 * person is choosing between is accounts; directories are how that is stored,
 * and only the custom box in Settings ever shows one.
 *
 * Asking is not free of consequence, and it is worth knowing which way: `claude
 * auth status` creates the config directory it is pointed at if it is not there
 * yet. That is the directory the person just named, it is where their login is
 * about to go, and refusing to describe a path until something else has created
 * it would leave a new profile blank for no reason anybody could see. `gh` and
 * `git` are asked read-only.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProfileIdentity } from "../../shared/model";
import type { GhAccount, IdentityWho, KnownAccounts, KnownGhAccount } from "../../shared/wire";
import { configPath } from "./config";

/**
 * `~` as a person types it, turned into a directory as a process needs it.
 *
 * The expansion is here rather than in `shared/` because a home directory is a
 * fact about this machine and `shared/` is imported by a browser. Which is also
 * why the stored path keeps the tilde: it stays readable in Settings, and it
 * stays correct if the server is ever the one that moved.
 */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/**
 * The environment a terminal in this profile is spawned with, or nothing at all
 * when the profile has not claimed anybody — an empty overlay and no overlay are
 * the same thing, and returning nothing keeps the common case off the wire.
 *
 * Only absolute paths get this far (`adoptIdentity`), and they are expanded
 * here: an env var is read by a process with its own idea of what `~` means,
 * which for a non-interactive `zsh -c` is frequently nothing at all.
 */
export function identityEnv(identity: ProfileIdentity): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  if (identity.claudeConfigDir) env.CLAUDE_CONFIG_DIR = expandHome(identity.claudeConfigDir);
  if (identity.ghConfigDir) env.GH_CONFIG_DIR = expandHome(identity.ghConfigDir);
  if (identity.gitConfigGlobal) env.GIT_CONFIG_GLOBAL = expandHome(identity.gitConfigGlobal);
  return Object.keys(env).length ? env : undefined;
}

// ---------------------------------------------------------------------------
// Where kururu keeps the directories it makes
// ---------------------------------------------------------------------------

/**
 * Under config rather than state, on `config.ts`'s reasoning taken one step
 * further than the keymap needed it. A state directory wiped between versions is
 * an inconvenience; this one holds logins, and a wipe would be three OAuth flows.
 */
export function identitiesDir(): string {
  return configPath("identities");
}

/**
 * A profile name as a directory name. Not an id: this is a path somebody will
 * `cd` into to see what is in it, and `p3` tells them nothing. It does not
 * follow a rename — the path is stored on the profile and keeps working, and
 * moving a directory somebody's login lives in because they retitled a tab strip
 * would be a much worse surprise than a stale name.
 */
export function slug(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  // Leading and trailing dots go with the dashes, and that is not tidiness: a
  // profile called ".." survives every other rule in here as the two characters
  // that mean "the directory above", and the path it would build is one a client
  // chose by typing a name. Trimmed again after the cut, because the cut can
  // leave one behind.
  const trimmed = trimEdges(trimEdges(cleaned).slice(0, 40));
  return trimmed || "profile";
}

function trimEdges(value: string): string {
  return value.replace(/^[-.]+|[-.]+$/g, "");
}

/** A name that is a name, never a path — `files.ts`'s argument, one directory on. */
function isName(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && value !== "." && value !== "..";
}

/**
 * Where a profile's Claude login lives.
 *
 * Per profile rather than per account, because a Claude config directory has no
 * name until somebody has logged into it — the account *is* the directory, and
 * there is nothing to key it by beforehand. Two profiles pointed at one of these
 * are deliberately one account.
 */
export function claudeDirFor(profileName: string): string {
  return join(identitiesDir(), "claude", slug(profileName));
}

/**
 * Where a *github account* lives, which is keyed the other way round: gh knows
 * the login before any directory exists, so the directory can be named after the
 * account and shared by every profile that picks it. Which is what makes picking
 * one idempotent — kururu either finds the directory or writes it, and never has
 * to edit one it did not write.
 */
export function ghDirFor(host: string, login: string): string {
  const name = host === "github.com" ? login : `${host}--${login}`;
  return join(identitiesDir(), "gh", name);
}

/**
 * The five lines that make a config directory mean one github account.
 *
 * Hand-written rather than through a YAML library, and the shape is gh's own:
 * a host block, the accounts it knows, and which of them is active. No token
 * goes in it — gh keeps those in the login keyring, which is exactly why this
 * works at all: the file names an account, the keyring answers for it, and
 * nothing kururu writes is a secret.
 *
 * It refuses to touch a directory that already has a `hosts.yml`, on the same
 * reasoning as the mascot import: gh rewrites that file itself every time
 * somebody logs in or out inside one of these terminals, and a file kururu
 * regenerated would throw away whatever gh had just recorded there.
 */
export function ensureGhConfig(host: string, login: string, gitProtocol?: string): string {
  if (!isName(host) || !isName(login)) throw new Error("not an account name");
  const dir = ghDirFor(host, login);
  const file = join(dir, "hosts.yml");
  if (existsSync(file)) return dir;
  mkdirSync(dir, { recursive: true });
  const protocol = gitProtocol === "ssh" ? "ssh" : "https";
  writeFileSync(
    file,
    `${host}:\n    git_protocol: ${protocol}\n    users:\n        ${login}:\n    user: ${login}\n`,
    { mode: 0o600 },
  );
  return dir;
}

/** Make a Claude directory exist so that logging in has somewhere to land. */
export function ensureClaudeDir(profileName: string): string {
  const dir = claudeDirFor(profileName);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * A path as one shell word.
 *
 * Single quotes, because inside them a shell interprets nothing at all — and the
 * one character that cannot appear in them is closed, escaped and reopened. A
 * path that reached a profile has already been refused unless it is absolute,
 * but "absolute" says nothing about spaces or quotes, and the one caller is
 * about to type this at a live shell.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `~/…` back out of an absolute path, so what is stored reads like what was typed. */
export function tildify(path: string): string {
  const home = homedir();
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

// ---------------------------------------------------------------------------
// Asking the tools
// ---------------------------------------------------------------------------

/**
 * Cached per directory rather than per profile, because the directory is what
 * the answer actually depends on: two profiles pointed at one of them are one
 * account and should not be two lookups. Short enough that logging in inside a
 * terminal shows up in Settings without a reload, long enough that a re-render
 * does not spawn six processes.
 */
const TTL = 15_000;
const cache = new Map<string, { at: number; value: Promise<unknown> }>();

function memo<T>(key: string, make: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value as Promise<T>;
  const value = make();
  cache.set(key, { at: Date.now(), value });
  // A failed lookup must not stand as the answer for fifteen seconds: the usual
  // reason one fails is a half-typed path, and what happens next is the rest of
  // it being typed.
  void value.catch(() => cache.delete(key));
  return value;
}

/**
 * Run a CLI and hand back its stdout, or nothing.
 *
 * Nothing covers every way this goes wrong and deliberately does not
 * distinguish them: a tool that is not installed, a tool that is installed and
 * angry, and a tool that hung all mean the same thing on the page, which is that
 * kururu cannot say who this is. A login shell, so these resolve the way they do
 * in a terminal — `claude` is frequently a version-manager shim and is not on a
 * daemon's PATH.
 */
function run(command: string, overlay: Record<string, string>): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      process.env.SHELL || "/bin/zsh",
      ["-l", "-c", command],
      { env: { ...process.env, ...overlay }, timeout: 8000, maxBuffer: 1 << 20 },
      (err, stdout) => resolve(err && !stdout ? null : stdout),
    );
  });
}

/** The first JSON object in some output, for tools that also say other things. */
function firstObject(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  const at = text.indexOf("{");
  if (at === -1) return null;
  try {
    const value: unknown = JSON.parse(text.slice(at));
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

/** An overlay naming one variable, or none at all for "as the machine has it". */
function only(name: string, dir: string | null): Record<string, string> {
  return dir ? { [name]: expandHome(dir) } : {};
}

export function claudeIn(dir: string | null): Promise<IdentityWho["claude"]> {
  return memo(`claude:${dir ?? ""}`, async () => {
    const out = firstObject(await run("claude auth status", only("CLAUDE_CONFIG_DIR", dir)));
    if (!out) return null;
    return {
      loggedIn: out.loggedIn === true,
      email: str(out.email),
      org: str(out.orgName),
      plan: str(out.subscriptionType),
    };
  });
}

/**
 * Every account in a gh config directory, not just the active one.
 *
 * `--json` because the human-readable form is a paragraph with a tick in it, and
 * because with it gh exits zero on an account whose token has gone bad — a state
 * worth drawing rather than one worth losing to an exit code. The whole list
 * rather than `--active`, because the default directory is also the registry:
 * it is where `gh auth login` puts an account, and therefore where the answer to
 * "what is there to pick" comes from.
 */
export function ghIn(dir: string | null): Promise<GhAccount[] | null> {
  return memo(`gh:${dir ?? ""}`, async () => {
    const out = firstObject(await run("gh auth status --json hosts", only("GH_CONFIG_DIR", dir)));
    const hosts = out?.hosts;
    if (!hosts || typeof hosts !== "object") return null;
    const accounts: GhAccount[] = [];
    for (const [host, list] of Object.entries(hosts as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      for (const raw of list) {
        const entry = raw as Record<string, unknown>;
        const login = str(entry.login);
        if (!login) continue;
        accounts.push({
          host: str(entry.host) ?? host,
          login,
          state: str(entry.state),
          gitProtocol: str(entry.gitProtocol),
          active: entry.active === true,
        });
      }
    }
    return accounts;
  });
}

/**
 * Asked with `--global` rather than from inside a repository, because that is
 * the question this page is about: a repo that sets its own `user.email`
 * overrides all of this, and reporting the answer from whatever directory the
 * server happens to be in would describe kururu's checkout rather than the
 * profile.
 */
export function gitIn(file: string | null): Promise<IdentityWho["git"]> {
  return memo(`git:${file ?? ""}`, async () => {
    const out = await run(
      "git config --global --get-regexp '^user\\.(name|email)$'",
      only("GIT_CONFIG_GLOBAL", file),
    );
    if (out === null) return null;
    const read = (key: string): string | null => {
      const line = out.split("\n").find((l) => l.startsWith(`${key} `));
      return line ? line.slice(key.length + 1).trim() || null : null;
    };
    return { name: read("user.name"), email: read("user.email") };
  });
}

/** Who a profile's terminals would open as. Three lookups, each cached alone. */
export async function describeIdentity(identity: ProfileIdentity): Promise<IdentityWho> {
  const [claude, gh, git] = await Promise.all([
    claudeIn(identity.claudeConfigDir),
    ghIn(identity.ghConfigDir),
    gitIn(identity.gitConfigGlobal),
  ]);
  return { claude, gh: gh?.find((a) => a.active) ?? gh?.[0] ?? null, git };
}

// ---------------------------------------------------------------------------
// What there is to pick
// ---------------------------------------------------------------------------

/** The Claude directories worth asking about: the default, and the ones we made. */
function claudeCandidates(inUse: Array<string | null>): Array<string | null> {
  const made: string[] = [];
  const root = join(identitiesDir(), "claude");
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) made.push(tildify(join(root, entry.name)));
    }
  } catch {
    // No directory yet, which is every machine until the first sign-in.
  }
  return [null, ...new Set([...made, ...inUse.filter((dir): dir is string => Boolean(dir))])];
}

/**
 * Everything there is to choose between, for the two dropdowns.
 *
 * The gh list is a union across the config directories in play rather than the
 * default one alone, because `gh auth login` run inside a profile's terminal
 * registers the account *there* — the token is in the shared keyring either way,
 * but the name of it is only written in the directory it was added from. A union
 * is what makes an account added in one profile pickable from another.
 *
 * Bounded, because each entry is a process: the same directory twice is one
 * lookup, and beyond a couple of dozen profiles somebody has a different problem.
 */
export async function knownAccounts(identities: ProfileIdentity[]): Promise<KnownAccounts> {
  const claudeDirs = claudeCandidates(identities.map((i) => i.claudeConfigDir)).slice(0, 24);
  const ghDirs = [null, ...new Set(identities.map((i) => i.ghConfigDir).filter(Boolean))].slice(0, 24);

  const [claudeAnswers, ghAnswers] = await Promise.all([
    Promise.all(claudeDirs.map(async (dir) => ({ dir, who: await claudeIn(dir) }))),
    Promise.all(ghDirs.map((dir) => ghIn(dir as string | null))),
  ]);

  const gh: KnownGhAccount[] = [];
  for (const answer of ghAnswers) {
    for (const account of answer ?? []) {
      if (!gh.some((seen) => seen.host === account.host && seen.login === account.login)) {
        // `active` is a fact about the directory it was read in, not about the
        // account, so it is dropped on the way into a list that spans several.
        // The directory is the one `use-gh-account` would write, named here so a
        // client can tell which option is selected without being told.
        gh.push({ ...account, active: false, dir: tildify(ghDirFor(account.host, account.login)) });
      }
    }
  }
  gh.sort((a, b) => a.login.localeCompare(b.login));

  return {
    claude: claudeAnswers
      .filter(({ who }) => who?.loggedIn)
      .map(({ dir, who }) => ({ dir, email: who?.email ?? null, org: who?.org ?? null })),
    gh,
  };
}
