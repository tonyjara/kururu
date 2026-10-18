/**
 * The disk half of lending a project's secrets: reading a workspace's env
 * files, an ssh Host entry and its key, and a gh login on the parent, and
 * putting each where its program looks for it on a child — and taking it
 * away again without touching anything that was the child's own.
 *
 * `shared/vault.ts` has the argument and every rule about what a line means;
 * `secrets.ts` decides when anything is read or written. This file is the
 * part that touches files other programs own, so each function here does
 * one thing to one of them and checks it did: an env file goes only into a
 * checkout under home, never over a file of the node's own that says
 * something else, never through a link; an ssh entry is a file of kururu's
 * beside `~/.ssh/config` and one `Include` line in it; a GitHub login is a
 * directory of kururu's that terminals are pointed at.
 *
 * On the parent everything is read at the moment it is needed and dropped,
 * as every key in kururu is, and a private key or a token is read only
 * once it has been switched on for a node: until then an entry is listed by
 * its being there. A gh token is in the Keychain on a Mac, so it is asked of
 * `gh auth token`, the one program this runs, with a timeout.
 */
import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { isEnvFile } from "../../shared/databases";
import type { EnvLend, EnvValue } from "../../shared/secrets";
import {
  DEFAULT_KEYS,
  ENV_DEPTH,
  ENV_SKIP_DIRS,
  ENV_TEXT_MAX,
  ghAccounts,
  ghHostsYml,
  ghTokenInFile,
  gitCredentials,
  identityFile,
  knownHostNames,
  lendableBlocks,
  matchKnownHosts,
  MENTION_DIRS,
  mentionedHosts,
  mentionsHostsFile,
  ownHostClash,
  parseSshConfig,
  privateKeyInfo,
  remoteOwner,
  SSH_KEY_MAX,
  SSH_LENT_DIR,
  sshConf,
  travelling,
  validGhToken,
  withInclude,
  withoutInclude,
  type GhValue,
  type SshBlock,
  type SshValue,
} from "../../shared/vault";
import { judgeFolder } from "./move";

/** How long `gh auth token` may take before the token is taken to be unreadable. */
const GH_TIMEOUT_MS = 10_000;
/** Where Homebrew puts gh, for a server whose PATH was not a shell's. */
const GH_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

function readText(path: string, max: number): string | null {
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size > max) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** A file's mtime and size, or nothing: enough to notice a save. */
export function stampOf(path: string): string {
  try {
    const info = statSync(path);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return "";
  }
}

const inside = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/** Write a file `0600` beside itself and rename it in, so a reader never sees half of it. */
function writePrivate(path: string, text: string): void {
  const temp = `${path}.kururu-tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

// ---------------------------------------------------------------------------
// Env files
// ---------------------------------------------------------------------------

/** The kind an env file is lent to a node as: the same for that node, checkout and file every time. */
export function envKind(node: string, from: string, file: string): string {
  return `env:${createHash("sha256").update(`kururu-env-v1\n${node}\n${from}\n${file}`).digest("hex").slice(0, 12)}`;
}

/**
 * The env files in a checkout, relative to it: `.env`, `.env.local`,
 * `apps/web/.env`, down to `ENV_DEPTH` folders, never into dependencies or
 * build output, never a link. `isEnvFile` leaves out `.env.example` and last
 * week's backups. Names only: nothing is read.
 */
export function findEnvFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= 64) return;
      if (entry.isFile() && isEnvFile(entry.name)) found.push(relative(root, join(dir, entry.name)));
      else if (entry.isDirectory() && depth < ENV_DEPTH && !ENV_SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) walk(join(dir, entry.name), depth + 1);
    }
  };
  walk(root, 0);
  return found.sort((a, b) => a.split("/").length - b.split("/").length || (a.endsWith("/.env") || a === ".env" ? -1 : 0) - (b.endsWith("/.env") || b === ".env" ? -1 : 0) || a.localeCompare(b));
}

/** Where an env lend is read: inside its checkout once links are followed, a file, small. Null for anything else. */
function envSourcePath(lend: EnvLend): string | null {
  const path = join(lend.from, lend.file);
  try {
    if (!inside(realpathSync(path), realpathSync(lend.from))) return null;
  } catch {
    return null;
  }
  return path;
}

/** An env lend's file as it travels, read now. */
export function readEnvSource(lend: EnvLend): EnvValue | null {
  const path = envSourcePath(lend);
  const text = path ? readText(path, ENV_TEXT_MAX) : null;
  return text === null ? null : { folder: lend.to, file: lend.file, text, workspace: lend.workspace };
}

export function envStamp(lend: EnvLend): string {
  return `${stampOf(join(lend.from, lend.file))}|${lend.to}`;
}

/**
 * An env file written on a child: into a checkout under home that is a
 * repository, at the same relative path, `0600`. Never through a link,
 * never into a folder the checkout does not have, and never over a file
 * that was the node's own and says something else — the same bytes are
 * taken as already lent. `placed` is what this node put there before,
 * which is removed when the lend moved to another folder. Returns the path.
 */
export function placeEnv(value: EnvValue, home: string, ours: (path: string) => boolean, placed: string | undefined): string {
  const { path: folder, problem } = judgeFolder(value.folder, home);
  if (problem) {
    const why = {
      relative: "is not a whole path",
      outside: "is outside home",
      missing: "is not here: clone the project there first",
      "not-dir": "is a file, not a folder",
      "not-repo": "is not a git checkout",
    }[problem];
    throw new Error(`${value.folder} ${why}`);
  }
  const path = join(folder, value.file);
  const parent = dirname(path);
  let realParent: string;
  try {
    realParent = realpathSync(parent);
  } catch {
    throw new Error(`the checkout has no ${relative(folder, parent)} folder`);
  }
  if (!inside(realParent, realpathSync(folder))) throw new Error(`${relative(folder, parent)} leads out of the checkout`);
  const target = join(realParent, value.file.split("/").pop()!);
  let info: ReturnType<typeof lstatSync> | null = null;
  try {
    info = lstatSync(target);
  } catch {
    // Not there yet, which is the usual case.
  }
  if (info && (info.isSymbolicLink() || !info.isFile())) throw new Error(`${value.file} in ${folder} is a link or a folder; this node leaves it alone`);
  if (info && !ours(target) && readText(target, ENV_TEXT_MAX + 1) !== value.text) {
    throw new Error(`this node has a ${value.file} of its own in ${folder} that says something else; move it aside there first, or leave it unlent`);
  }
  writePrivate(target, value.text);
  if (readText(target, ENV_TEXT_MAX) !== value.text) throw new Error(`could not write ${value.file} in ${folder}`);
  if (placed && placed !== target) rmSync(placed, { force: true });
  return target;
}

// ---------------------------------------------------------------------------
// ssh, on the parent
// ---------------------------------------------------------------------------

/** One lendable Host entry on this Mac, read without its key. */
export interface SshHost {
  alias: string;
  block: SshBlock;
  /** The key file it uses, or null when there is none to lend. */
  keyPath: string | null;
  /** Why it cannot be lent, when it cannot. */
  note: string | null;
}

let hostsCache: { stamp: string; home: string; hosts: SshHost[] } | null = null;

function keyFor(block: SshBlock, home: string): { keyPath: string | null; note: string | null } {
  const named = identityFile(block, home);
  const tries = named ? [named] : DEFAULT_KEYS.map((name) => join(home, ".ssh", name));
  for (const path of tries) {
    const file = path.endsWith(".pub") ? path.slice(0, -4) : path;
    if (existsSync(file)) return { keyPath: file, note: null };
  }
  const agent = block.lines.some((l) => l.key.toLowerCase() === "identityagent");
  return { keyPath: null, note: agent ? "its key is in an agent (IdentityAgent), not a file, so there is nothing to copy" : named ? `its key file ${named.replace(home, "~")} is not there` : "it names no key, and ~/.ssh has none of ssh's defaults" };
}

/** Every Host entry of `~/.ssh/config` that names one host, with the key it would lend. Read again only when the file changes. */
export function sshHosts(home: string): SshHost[] {
  const config = join(home, ".ssh", "config");
  const stamp = stampOf(config);
  if (hostsCache && hostsCache.stamp === stamp && hostsCache.home === home && stamp) return hostsCache.hosts;
  const text = readText(config, 1 << 20) ?? "";
  const hosts = [...lendableBlocks(parseSshConfig(text))].map(([alias, block]) => ({ alias, block, ...keyFor(block, home) }));
  hostsCache = { stamp, home, hosts };
  return hosts;
}

function hashHost(salt: string, name: string): string {
  return createHmac("sha1", Buffer.from(salt, "base64")).update(name).digest("base64");
}

/** A Host entry with its key and its known hosts, read now: what an ssh kind sends. */
export function readSshSource(home: string, alias: string): SshValue | null {
  const host = sshHosts(home).find((h) => h.alias === alias);
  if (!host?.keyPath) return null;
  const key = readText(host.keyPath, SSH_KEY_MAX);
  if (!key || !privateKeyInfo(key).ok) return null;
  const pub = readText(`${host.keyPath}.pub`, 16 * 1024);
  const known = readText(join(home, ".ssh", "known_hosts"), 4 << 20) ?? "";
  const { lines, left } = travelling(host.block);
  return {
    alias,
    names: host.block.names,
    lines,
    left,
    key,
    pub: pub && /^[a-z0-9@.-]+ [A-Za-z0-9+/=]+/.test(pub) ? pub : null,
    knownHosts: matchKnownHosts(known, knownHostNames(host.block, alias), hashHost),
    keyName: host.keyPath.split("/").pop()!,
  };
}

/** What moves when an ssh kind should be read again: the config, the key and the known hosts. */
export function sshStamp(home: string, alias: string): string {
  const host = sshHosts(home).find((h) => h.alias === alias);
  return [stampOf(join(home, ".ssh", "config")), host?.keyPath ? stampOf(host.keyPath) : "", stampOf(join(home, ".ssh", "known_hosts"))].join("|");
}

// ---------------------------------------------------------------------------
// ssh, on a child
// ---------------------------------------------------------------------------

function sshDir(home: string): string {
  return join(home, ".ssh");
}

function lentDir(home: string): string {
  return join(sshDir(home), SSH_LENT_DIR);
}

/** `~/.ssh/config` rewritten in place — through a link if it is one, since a dotfiles checkout owns where it lives. */
function rewriteConfig(home: string, change: (text: string) => string): void {
  const path = join(sshDir(home), "config");
  const before = readText(path, 1 << 20) ?? "";
  const after = change(before);
  if (after === before) return;
  let link = false;
  try {
    link = lstatSync(path).isSymbolicLink();
  } catch {
    // None yet: made 0600, as ssh wants it.
  }
  if (link) writeFileSync(path, after);
  else if (!after.trim()) rmSync(path, { force: true });
  else {
    const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
    const temp = `${path}.kururu-tmp`;
    writeFileSync(temp, after, { mode });
    chmodSync(temp, mode);
    renameSync(temp, path);
  }
}

/**
 * An ssh entry written on a child: `~/.ssh/kururu/<alias>` with its key,
 * `.pub` and `.known_hosts` beside it, `<alias>.conf` for the Host block, and
 * the `Include` line at the top of `~/.ssh/config`. Refused when the node's
 * own config has a Host line by one of its names: that entry is the node's,
 * and a lent one read first would quietly take its place. Returns the path
 * of the entry's file.
 */
export function placeSsh(value: SshValue, home: string, from: string): string {
  const own = readText(join(sshDir(home), "config"), 1 << 20) ?? "";
  const clash = ownHostClash(own, value.names);
  if (clash.length) throw new Error(`this node has its own Host ${clash.join(", ")} in ~/.ssh/config; take it out there first, or leave it unlent`);
  mkdirSync(sshDir(home), { recursive: true, mode: 0o700 });
  mkdirSync(lentDir(home), { recursive: true, mode: 0o700 });
  chmodSync(lentDir(home), 0o700);
  const base = join(lentDir(home), value.alias);
  writePrivate(base, value.key.endsWith("\n") ? value.key : `${value.key}\n`);
  if (value.pub) writePrivate(`${base}.pub`, value.pub.endsWith("\n") ? value.pub : `${value.pub}\n`);
  else rmSync(`${base}.pub`, { force: true });
  writePrivate(`${base}.known_hosts`, value.knownHosts.length ? `${value.knownHosts.join("\n")}\n` : "");
  writePrivate(`${base}.conf`, sshConf(value, from));
  rewriteConfig(home, withInclude);
  if (!(readText(join(sshDir(home), "config"), 1 << 20) ?? "").includes("Include ~/.ssh/kururu/")) throw new Error("could not add the Include line to ~/.ssh/config");
  return `${base}.conf`;
}

/** An ssh entry gone from a child, and the `Include` line with the last of them. */
export function removeSsh(home: string, alias: string): void {
  const base = join(lentDir(home), alias);
  for (const suffix of ["", ".pub", ".known_hosts", ".conf"]) rmSync(`${base}${suffix}`, { force: true });
  let left: string[] = [];
  try {
    left = readdirSync(lentDir(home)).filter((name) => name.endsWith(".conf"));
  } catch {
    // The folder is gone already.
  }
  if (left.length) return;
  rewriteConfig(home, withoutInclude);
  try {
    if (!readdirSync(lentDir(home)).length) rmSync(lentDir(home), { recursive: true, force: true });
  } catch {
    // Gone.
  }
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

/** gh's `hosts.yml` on this machine: where `GH_CONFIG_DIR` says, else `~/.config/gh`. */
export function ghHostsPath(home: string): string {
  const dir = process.env.GH_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "gh");
  return join(dir, "hosts.yml");
}

let accountsCache: { path: string; stamp: string; accounts: { account: string; active: boolean }[] } | null = null;

/** The accounts gh is signed in as on github.com here. Names only; read again only when the file changes. */
export function ghAccountsHere(home: string): { account: string; active: boolean }[] {
  const path = ghHostsPath(home);
  const stamp = stampOf(path);
  if (accountsCache && accountsCache.path === path && accountsCache.stamp === stamp && stamp) return accountsCache.accounts;
  const accounts = ghAccounts(readText(path, 1 << 20) ?? "");
  accountsCache = { path, stamp, accounts };
  return accounts;
}

function ghBinary(): string | null {
  for (const dir of [...(process.env.PATH ?? "").split(":"), ...GH_DIRS]) {
    if (dir && existsSync(join(dir, "gh"))) return join(dir, "gh");
  }
  return null;
}

/**
 * An account's token, read now: out of `hosts.yml` when gh keeps it there,
 * else from `gh auth token`, which reads the Keychain. Never logged; what
 * gh says on failure is not repeated either, in case it ever quotes one.
 */
export function ghToken(home: string, account: string): string | null {
  const inFile = ghTokenInFile(readText(ghHostsPath(home), 1 << 20) ?? "", account);
  if (inFile) return inFile;
  const gh = ghBinary();
  if (!gh) return null;
  const done = spawnSync(gh, ["auth", "token", "--hostname", "github.com", "--user", account], { encoding: "utf8", timeout: GH_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] });
  const token = done.status === 0 ? done.stdout.trim() : "";
  return validGhToken(token) ? token : null;
}

/** The gh directory a lent login lands in on a child, which kururu's terminals are pointed at. */
export function ghLentDir(configDir: string): string {
  return join(configDir, "gh");
}

/** A GitHub login written on a child: gh's `hosts.yml` and git's credential file, `0600` in a `0700` directory of kururu's. */
export function placeGh(value: GhValue, configDir: string): string {
  const dir = ghLentDir(configDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writePrivate(join(dir, "hosts.yml"), ghHostsYml(value));
  writePrivate(join(dir, "git-credentials"), gitCredentials(value));
  if (readText(join(dir, "hosts.yml"), 4096) !== ghHostsYml(value)) throw new Error("could not write the gh login");
  return dir;
}

/** The whole directory: gh may have written its own `config.yml` beside the login, and it goes with it. */
export function removeGh(configDir: string): void {
  rmSync(ghLentDir(configDir), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// What a project needs, guessed
// ---------------------------------------------------------------------------

/** A checkout's `.git/config`, through a worktree's `.git` file to the repository's own. */
function gitConfigText(root: string): string {
  const dotGit = join(root, ".git");
  try {
    if (statSync(dotGit).isDirectory()) return readText(join(dotGit, "config"), 1 << 20) ?? "";
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
    if (!pointer) return "";
    const gitDir = pointer.startsWith("/") ? pointer : join(root, pointer);
    const common = readText(join(gitDir, "commondir"), 4096)?.trim();
    return readText(join(common ? (common.startsWith("/") ? common : join(gitDir, common)) : gitDir, "config"), 1 << 20) ?? "";
  } catch {
    return "";
  }
}

/** Whose GitHub account owns the checkout's `origin`, if it is on github.com. */
export function remoteOwnerOf(root: string): string | null {
  return remoteOwner(gitConfigText(root));
}

/**
 * The Host aliases a checkout's scripts and notes name, each with the file
 * that named it first. The top of the checkout and its usual script folders,
 * a few hundred small files at most, never an env file.
 */
export function hostsMentioned(root: string, aliases: readonly string[]): Map<string, string> {
  const found = new Map<string, string>();
  let budget = 300;
  const look = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (budget <= 0 || found.size === aliases.length) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth > 0 && depth < 3 && !ENV_SKIP_DIRS.has(entry.name)) look(path, depth + 1);
      if (!entry.isFile() || !mentionsHostsFile(entry.name)) continue;
      budget--;
      const text = readText(path, 128 * 1024);
      if (!text) continue;
      for (const alias of mentionedHosts(text, aliases.filter((a) => !found.has(a)))) found.set(alias, relative(root, path));
    }
  };
  look(root, 0);
  for (const name of MENTION_DIRS) look(join(root, name), 1);
  return found;
}
