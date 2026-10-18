/**
 * The project's own secrets, as the parent lends them: a workspace's env
 * files, an ssh Host entry and its key, a GitHub login. What each one is on
 * the disk it is read from and the disk it lands on, as text.
 *
 * Phase 4 lent kururu's own keys, which are kururu's files on both ends.
 * Moving a workspace to a child (phase 6) left behind what the project
 * itself needs to run there — its `.env.local`, the key its deploy script
 * ssh-es with, a login that can push — and the dialog said "copy what it
 * needs by hand". Each of these is a file some other program owns, so the
 * rules are about not breaking that program's file:
 *
 * - **An env file lands in the matching checkout**, the folder the move
 *   already checked is a repository on the node, at the same relative path,
 *   at `0600`. Never over a file of the node's own that says something
 *   else: that is the Codex rule, for the same reason.
 * - **An ssh Host entry lands beside the node's own config, never in it.**
 *   `~/.ssh/kururu/<alias>.conf`, its key and its known hosts next to it,
 *   and one `Include` line at the top of `~/.ssh/config`, which is the only
 *   change to a file of the user's and goes again with the last entry. Only
 *   the directives that mean the same on any machine travel: `UseKeychain`
 *   is a fatal "Bad configuration option" on Linux, an `IdentityAgent` is a
 *   socket on the Mac, and a `ProxyCommand` is a program on the Mac.
 * - **A GitHub login lands in a directory of kururu's**, as the `hosts.yml`
 *   gh reads and a credential file git reads, and kururu's terminals are
 *   pointed at them by path (`GH_CONFIG_DIR`, a credential helper in
 *   `GIT_CONFIG_*`) — so the node's own `gh auth login`, if it has one, is
 *   never written over, and the token is never in an environment.
 *
 * Pure, for `shared/secrets.ts`'s reason: the server reads and writes, and
 * every decision about what a line means is text worth a test.
 */
import { isEnvFile, parseDotenv } from "./databases";

// ---------------------------------------------------------------------------
// Env files
// ---------------------------------------------------------------------------

/** Largest env file lent. Past this it is not an env file, it is data. */
export const ENV_TEXT_MAX = 64 * 1024;

/** How deep under the checkout an env file is looked for: `.env`, `apps/web/.env`. */
export const ENV_DEPTH = 2;

/** Folders never looked in for env files: other people's code, build output, history. */
export const ENV_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".nuxt", ".svelte-kit", ".turbo", ".vercel", ".output", "vendor", "target", "coverage", ".venv", "venv", "__pycache__"]);

/**
 * A path to an env file relative to the checkout, as it may come off the
 * wire: at most `ENV_DEPTH` folders, each a plain name, and an env file at
 * the end that `isEnvFile` would read — so never `.env.example`, never a
 * `..`, never anything outside the checkout.
 */
export function envPathOk(file: unknown): file is string {
  if (typeof file !== "string" || file.length > 200) return false;
  const parts = file.split("/");
  if (parts.length > ENV_DEPTH + 1) return false;
  const name = parts.pop()!;
  if (!isEnvFile(name)) return false;
  return parts.every((part) => /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/.test(part) && !ENV_SKIP_DIRS.has(part));
}

/** How many variables an env file sets: the hint's count, never a name or a value. */
export function envVariables(text: string): number {
  return parseDotenv(text).size;
}

/** The last part of a folder. */
function lastPart(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

/** "storefront/.env.local · 14 variables": which file, in which checkout, and its size in the only unit that is not a secret. */
export function envHint(folder: string, file: string, text: string): string {
  const n = envVariables(text);
  return `${lastPart(folder)}/${file} · ${n} variable${n === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// ssh
// ---------------------------------------------------------------------------

/** A Host alias a kind can be named by: what people type after `ssh`, and what fits a file name. */
export const SSH_ALIAS = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,47}$/;

/** Largest private key lent. An RSA 16384 is about 12 KB. */
export const SSH_KEY_MAX = 16 * 1024;

/** One `Host` block of an ssh config: the names on its line, and its directives in order. */
export interface SshBlock {
  names: string[];
  lines: { key: string; value: string }[];
}

function unquote(value: string): string {
  const v = value.trim();
  return v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;
}

/**
 * The `Host` blocks of an ssh config. A `Match` block ends the one before it
 * and is not read: what it matches depends on the machine it is evaluated
 * on. Lines before the first `Host` are defaults for every host and are the
 * Mac's, not an entry's. `Include` is not followed.
 */
export function parseSshConfig(text: string): SshBlock[] {
  const blocks: SshBlock[] = [];
  let current: SshBlock | null = null;
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    const value = m[2]!.trim();
    const lower = key.toLowerCase();
    if (lower === "host") {
      current = { names: value.split(/\s+/).map(unquote).filter(Boolean), lines: [] };
      blocks.push(current);
    } else if (lower === "match") {
      current = null;
    } else if (current && lower !== "include") {
      current.lines.push({ key, value });
    }
  }
  return blocks;
}

/** The names on a Host line that name one host: no `*`, `?` or `!`. */
export function plainNames(names: readonly string[]): string[] {
  return names.filter((name) => SSH_ALIAS.test(name));
}

/** Every block that can be lent, by the first name on its line. A block of only patterns is `Host *` and its kin, and is the Mac's defaults. */
export function lendableBlocks(blocks: readonly SshBlock[]): Map<string, SshBlock> {
  const out = new Map<string, SshBlock>();
  for (const block of blocks) {
    const names = plainNames(block.names);
    if (names.length && !out.has(names[0]!)) out.set(names[0]!, { ...block, names });
  }
  return out;
}

/** The first value of a directive, case-insensitively, unquoted. */
export function directive(block: SshBlock, key: string): string | null {
  const line = block.lines.find((l) => l.key.toLowerCase() === key.toLowerCase());
  return line ? unquote(line.value) : null;
}

/**
 * The directives that mean the same on any machine, and so travel. Lower
 * case, as ssh compares them. What is not here stays on the Mac and the
 * entry's file says which: paths (`IdentityFile`, `UserKnownHostsFile`,
 * `ControlPath`, `CertificateFile`), sockets (`IdentityAgent`), the
 * Keychain (`UseKeychain`, which Linux's ssh refuses to start with), and
 * commands this Mac runs (`ProxyCommand`, `LocalCommand`).
 */
const SSH_TRAVELS = new Set([
  "hostname",
  "user",
  "port",
  "proxyjump",
  "hostkeyalias",
  "serveraliveinterval",
  "serveralivecountmax",
  "connecttimeout",
  "connectionattempts",
  "tcpkeepalive",
  "compression",
  "requesttty",
  "setenv",
  "sendenv",
  "localforward",
  "remoteforward",
  "dynamicforward",
  "stricthostkeychecking",
  "loglevel",
  "preferredauthentications",
  "pubkeyauthentication",
  "passwordauthentication",
  "hostkeyalgorithms",
  "pubkeyacceptedalgorithms",
  "pubkeyacceptedkeytypes",
  "kexalgorithms",
  "ciphers",
  "macs",
  "addressfamily",
]);

/** A directive's line as it is written on the node: one line, no newline smuggled in. */
function cleanLine(key: string, value: string): string | null {
  if (/[\r\n\0]/.test(key + value) || !/^[A-Za-z]+$/.test(key) || value.length > 512) return null;
  return `${key} ${value}`;
}

/** What of a block travels, as lines, and the names of what does not. */
export function travelling(block: SshBlock): { lines: string[]; left: string[] } {
  const lines: string[] = [];
  const left = new Set<string>();
  for (const { key, value } of block.lines) {
    const lower = key.toLowerCase();
    const line = SSH_TRAVELS.has(lower) ? cleanLine(key, value) : null;
    if (line) lines.push(line);
    else if (lower !== "identityfile" && lower !== "identitiesonly" && lower !== "userknownhostsfile") left.add(key);
  }
  return { lines, left: [...left] };
}

/** The key a block uses: its first `IdentityFile`, `~` expanded. Null when it names none, which leaves ssh's defaults. */
export function identityFile(block: SshBlock, home: string): string | null {
  const file = directive(block, "IdentityFile");
  if (!file || file.toLowerCase() === "none") return null;
  if (file === "~") return home;
  if (file.startsWith("~/")) return `${home}/${file.slice(2)}`;
  return file.startsWith("/") ? file : `${home}/.ssh/${file}`;
}

/** The keys ssh tries when a block names none, in its order. */
export const DEFAULT_KEYS = ["id_ed25519", "id_ecdsa", "id_rsa"];

/**
 * The names a host's key is filed under in `known_hosts`: its
 * `HostKeyAlias`, else its `HostName`, else the alias — bracketed with the
 * port when it is not 22, which is how ssh writes them.
 */
export function knownHostNames(block: SshBlock, alias: string): string[] {
  const name = directive(block, "HostKeyAlias") ?? directive(block, "HostName") ?? alias;
  const port = directive(block, "Port");
  return port && port !== "22" ? [`[${name}]:${port}`] : [name];
}

/**
 * The lines of a `known_hosts` that are about these names, plain or
 * hashed. A hashed line is `|1|salt|hash`, the hash an HMAC-SHA1 of the name
 * keyed with the salt — which `hashed` computes, since this file has no
 * crypto. Public keys of hosts, not secrets; they travel so that an agent's
 * first `ssh` there is not a question it cannot answer.
 */
export function matchKnownHosts(text: string, names: readonly string[], hashed: (salt: string, name: string) => string): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("@revoked")) continue;
    const fields = line.split(/\s+/);
    const hosts = (line.startsWith("@") ? fields[1] : fields[0]) ?? "";
    const hit = hosts.split(",").some((host) => {
      const h = /^\|1\|([^|]+)\|([^|]+)$/.exec(host);
      if (h) return names.some((name) => hashed(h[1]!, name) === h[2]);
      return names.includes(host);
    });
    if (hit && out.length < 50 && line.length <= 4096) out.push(line);
  }
  return out;
}

function bytesOf(b64: string): Uint8Array | null {
  try {
    const text = atob(b64.replace(/\s+/g, ""));
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** A length-prefixed string out of an OpenSSH key's body, and where the next one starts. */
function sshString(bytes: Uint8Array, at: number): { value: Uint8Array; next: number } | null {
  if (at + 4 > bytes.length) return null;
  const n = ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
  if (at + 4 + n > bytes.length) return null;
  return { value: bytes.subarray(at + 4, at + 4 + n), next: at + 4 + n };
}

const ascii = (bytes: Uint8Array) => String.fromCharCode(...bytes);

/**
 * What a private key file is: whether it is one at all, whether it has a
 * passphrase (which an agent on the node cannot type), and its type. Read
 * from the header and, for OpenSSH's own format, the unencrypted preamble —
 * never the key material.
 */
export function privateKeyInfo(text: string): { ok: boolean; encrypted: boolean; type: string | null } {
  const none = { ok: false, encrypted: false, type: null };
  if (text.length > SSH_KEY_MAX) return none;
  const m = /-----BEGIN ((?:OPENSSH|RSA|EC|DSA|ENCRYPTED) )?PRIVATE KEY-----\r?\n([\s\S]*?)-----END \1?PRIVATE KEY-----/.exec(text);
  if (!m) return none;
  const kind = (m[1] ?? "").trim();
  if (kind === "ENCRYPTED") return { ok: true, encrypted: true, type: null };
  if (kind !== "OPENSSH") {
    return { ok: true, encrypted: /Proc-Type:\s*4,ENCRYPTED/.test(m[2]!), type: kind ? kind.toLowerCase() : null };
  }
  const bytes = bytesOf(m[2]!);
  const magic = "openssh-key-v1\0";
  if (!bytes || ascii(bytes.subarray(0, magic.length)) !== magic) return none;
  const cipher = sshString(bytes, magic.length);
  const kdf = cipher && sshString(bytes, cipher.next);
  const options = kdf && sshString(bytes, kdf.next);
  if (!cipher || !options) return none;
  const pub = sshString(bytes, options.next + 4);
  const type = pub ? sshString(pub.value, 0) : null;
  const name = type ? ascii(type.value) : null;
  return { ok: true, encrypted: ascii(cipher.value) !== "none", type: name ? name.replace(/^ssh-/, "").replace(/^ecdsa-sha2-/, "ecdsa ") : null };
}

/** An ssh Host entry with its key, as it travels. */
export interface SshValue {
  alias: string;
  /** Every plain name on the Host line. */
  names: string[];
  /** The directives that travel, one per line. */
  lines: string[];
  /** The directives that did not, by name, for the entry's own comment. */
  left: string[];
  /** The private key, as its file holds it. */
  key: string;
  pub: string | null;
  knownHosts: string[];
  /** The key's file name on the parent, for the hint. */
  keyName: string;
}

/** An ssh value off the wire, every field held to what `travelling` makes. */
export function checkSshValue(value: unknown): value is SshValue {
  const v = value as Partial<SshValue> | null;
  if (!v || typeof v !== "object") return false;
  if (typeof v.alias !== "string" || !SSH_ALIAS.test(v.alias)) return false;
  if (!Array.isArray(v.names) || !v.names.length || v.names.length > 8 || !v.names.every((n) => typeof n === "string" && SSH_ALIAS.test(n)) || v.names[0] !== v.alias) return false;
  const lineOk = (l: unknown) => typeof l === "string" && l.length <= 600 && !/[\r\n\0]/.test(l);
  if (!Array.isArray(v.lines) || v.lines.length > 64 || !v.lines.every((l) => lineOk(l) && SSH_TRAVELS.has(String(l).split(" ")[0]!.toLowerCase()))) return false;
  if (!Array.isArray(v.left) || v.left.length > 64 || !v.left.every((k) => typeof k === "string" && /^[A-Za-z]{1,40}$/.test(k))) return false;
  if (typeof v.key !== "string" || !privateKeyInfo(v.key).ok) return false;
  if (v.pub !== null && (typeof v.pub !== "string" || v.pub.length > 16 * 1024 || !/^[a-z0-9@.-]+ [A-Za-z0-9+/=]+( [^\r\n]*)?\s*$/.test(v.pub))) return false;
  if (!Array.isArray(v.knownHosts) || v.knownHosts.length > 50 || !v.knownHosts.every(lineOk)) return false;
  return typeof v.keyName === "string" && /^[A-Za-z0-9._@-]{1,100}$/.test(v.keyName);
}

/** "vps · key vps_key (ed25519)". */
export function sshHint(alias: string, keyName: string, key: string | null): string {
  const info = key ? privateKeyInfo(key) : null;
  const what = info?.type ? ` (${info.type}${info.encrypted ? ", has a passphrase" : ""})` : info?.encrypted ? " (has a passphrase)" : "";
  return `${alias} · key ${keyName}${what}`;
}

/** The folder under `~/.ssh` that lent entries live in, and the line that brings them in. */
export const SSH_LENT_DIR = "kururu";
export const SSH_INCLUDE = "Include ~/.ssh/kururu/*.conf";
const SSH_INCLUDE_NOTE = "# kururu: Host entries lent by the parent node. Its Settings → Nodes takes them back.";

/**
 * The entry as a node writes it, `~/.ssh/kururu/<alias>.conf`: the Host line,
 * what travelled, and the key and known hosts beside it. `IdentitiesOnly`,
 * so the node's own keys are not offered first and counted against the
 * server's attempts.
 */
export function sshConf(value: SshValue, from: string): string {
  const lines = [
    `# Lent by ${from}, which keeps the original. Taken back from its Settings → Nodes; edits here are written over by the next push.`,
    ...(value.left.length ? [`# Left on ${from}, as only meaning something there: ${value.left.join(", ")}`] : []),
    `Host ${value.names.join(" ")}`,
    ...value.lines.map((line) => `  ${line}`),
    `  IdentityFile ~/.ssh/${SSH_LENT_DIR}/${value.alias}`,
    "  IdentitiesOnly yes",
    `  UserKnownHostsFile ~/.ssh/known_hosts ~/.ssh/${SSH_LENT_DIR}/${value.alias}.known_hosts`,
  ];
  return `${lines.join("\n")}\n`;
}

/** The names among these that the node's own config already has a Host line for. Its own entry is never shadowed by a lent one. */
export function ownHostClash(configText: string, names: readonly string[]): string[] {
  const own = new Set(parseSshConfig(configText).flatMap((block) => block.names));
  return names.filter((name) => own.has(name));
}

/** The node's `~/.ssh/config` with the lent entries brought in: the line at the top, where ssh reads first. */
export function withInclude(configText: string): string {
  if (configText.split("\n").some((line) => line.trim() === SSH_INCLUDE)) return configText;
  return `${SSH_INCLUDE_NOTE}\n${SSH_INCLUDE}\n${configText ? `\n${configText}` : ""}`;
}

/** The same with them gone, and the file as it was before. */
export function withoutInclude(configText: string): string {
  const lines = configText.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === SSH_INCLUDE || line === SSH_INCLUDE_NOTE) {
      // And the blank line `withInclude` put after it.
      if (line === SSH_INCLUDE && lines[i + 1] === "") i++;
      continue;
    }
    out.push(lines[i]!);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

/** A GitHub login: what github.com allows a username to be. */
export const GH_ACCOUNT = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** A token gh holds: an OAuth token from `gh auth login`, or a personal access token. */
export function validGhToken(token: unknown): token is string {
  return typeof token === "string" && /^(gh[opsu]_[A-Za-z0-9]{20,251}|github_pat_[A-Za-z0-9_]{20,251})$/.test(token);
}

/** A GitHub login as it travels. Only github.com: an Enterprise host is a different road and nobody here has one. */
export interface GhValue {
  account: string;
  token: string;
}

export function checkGhValue(value: unknown): value is GhValue {
  const v = value as Partial<GhValue> | null;
  return !!v && typeof v === "object" && typeof v.account === "string" && GH_ACCOUNT.test(v.account) && validGhToken(v.token) && Object.keys(v).length === 2;
}

export function ghHint(value: GhValue): string {
  return `${value.account} · …${value.token.slice(-4)}`;
}

interface YamlLine {
  indent: number;
  key: string;
  value: string;
}

function yamlLines(text: string): YamlLine[] {
  const out: YamlLine[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const m = /^( *)([^\s:#][^:]*):\s*(.*?)\s*$/.exec(raw);
    if (m) out.push({ indent: m[1]!.length, key: m[2]!.trim().replace(/^["']|["']$/g, ""), value: m[3]!.replace(/^["']|["']$/g, "") });
  }
  return out;
}

/**
 * The accounts gh is signed in as on github.com, out of its `hosts.yml`:
 * the `users` map gh 2.40 brought, the active one marked. The tokens are in
 * the Keychain on a Mac and are not here; a file that has one inline (gh's
 * "insecure storage") gives it as `token`, which `ghTokenInFile` reads.
 */
export function ghAccounts(hostsYml: string): { account: string; active: boolean }[] {
  return ghEntries(hostsYml).map(({ account, active }) => ({ account, active }));
}

function ghEntries(hostsYml: string): { account: string; active: boolean; token: string | null }[] {
  const lines = yamlLines(hostsYml);
  const start = lines.findIndex((l) => l.indent === 0 && l.key === "github.com");
  if (start < 0) return [];
  const block: YamlLine[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.indent === 0) break;
    block.push(line);
  }
  const top = Math.min(...block.map((l) => l.indent));
  const active = block.find((l) => l.indent === top && l.key === "user")?.value ?? null;
  const usersAt = block.findIndex((l) => l.indent === top && l.key === "users");
  const out: { account: string; active: boolean; token: string | null }[] = [];
  if (usersAt >= 0) {
    const users = block.slice(usersAt + 1);
    const level = users[0]?.indent ?? 0;
    if (level > top) {
      let current: { account: string; active: boolean; token: string | null } | null = null;
      for (const line of users) {
        if (line.indent <= top) break;
        if (line.indent === level) {
          current = GH_ACCOUNT.test(line.key) ? { account: line.key, active: line.key === active, token: null } : null;
          if (current) out.push(current);
        } else if (current && line.key === "oauth_token" && validGhToken(line.value)) current.token = line.value;
      }
    }
  }
  if (!out.length && active && GH_ACCOUNT.test(active)) {
    // A file from before gh's multi-account shape: one login, at the top.
    const token = block.find((l) => l.indent === top && l.key === "oauth_token")?.value ?? null;
    out.push({ account: active, active: true, token: validGhToken(token) ? token : null });
  }
  return out;
}

/** An account's token when gh keeps it in the file rather than the Keychain. */
export function ghTokenInFile(hostsYml: string, account: string): string | null {
  return ghEntries(hostsYml).find((e) => e.account === account)?.token ?? null;
}

/** The `hosts.yml` a node writes for gh in the directory `GH_CONFIG_DIR` points at: the one login, active. */
export function ghHostsYml(value: GhValue): string {
  return [
    "github.com:",
    "    users:",
    `        ${value.account}:`,
    `            oauth_token: ${value.token}`,
    "    git_protocol: https",
    `    oauth_token: ${value.token}`,
    `    user: ${value.account}`,
    "",
  ].join("\n");
}

/** The line git's `store` helper reads: the account and its token for github.com over https. */
export function gitCredentials(value: GhValue): string {
  return `https://${value.account}:${value.token}@github.com\n`;
}

/**
 * The environment that points a terminal at a lent GitHub login: gh at its
 * directory, and git at its credential file for github.com only — first
 * clearing the helpers git collected from the node's own config for that
 * host, which an empty value does, so the lent login is the one used there
 * the way a lent Claude token outranks a `/login`. Paths, never the token.
 * `count` is how many `GIT_CONFIG_*` pairs the environment already has.
 */
export function ghEnv(dir: string, count: number): Record<string, string> | null {
  if (dir.includes("'") || /[\r\n\0]/.test(dir)) return null;
  const key = "credential.https://github.com.helper";
  return {
    GH_CONFIG_DIR: dir,
    GIT_CONFIG_COUNT: String(count + 2),
    [`GIT_CONFIG_KEY_${count}`]: key,
    [`GIT_CONFIG_VALUE_${count}`]: "",
    [`GIT_CONFIG_KEY_${count + 1}`]: key,
    [`GIT_CONFIG_VALUE_${count + 1}`]: `store --file='${dir}/git-credentials'`,
  };
}

// ---------------------------------------------------------------------------
// What a project needs, guessed
// ---------------------------------------------------------------------------

/** The owner of a checkout's `origin` on github.com, out of its `.git/config`: whose login can push it. */
export function remoteOwner(gitConfig: string): string | null {
  let inOrigin = false;
  for (const raw of gitConfig.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    const section = /^\[(.+)\]$/.exec(line);
    if (section) {
      inOrigin = /^remote\s+"origin"$/.test(section[1]!.trim());
      continue;
    }
    const url = inOrigin && /^url\s*=\s*(.+)$/.exec(line);
    if (!url) continue;
    const m = /github\.com[:/]([A-Za-z0-9-]+)\//.exec(url[1]!);
    return m && GH_ACCOUNT.test(m[1]!) ? m[1]! : null;
  }
  return null;
}

/**
 * The Host aliases a project's scripts and notes name, word for word: a
 * deploy script's `ssh vps`, an `rsync … vps:`. Guesses, offered as such;
 * an alias of three letters or fewer is too likely a word to count.
 */
export function mentionedHosts(text: string, aliases: readonly string[]): string[] {
  return aliases.filter((alias) => {
    if (alias.length < 4) return false;
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^A-Za-z0-9._-])${escaped}($|[^A-Za-z0-9_-])`, "m").test(text);
  });
}

/** Files a project's ssh hosts are looked for in: scripts, deploy configs and notes, by name. Never an env file. */
export function mentionsHostsFile(name: string): boolean {
  if (name.startsWith(".env")) return false;
  return /^(package\.json|Makefile|makefile|justfile|Justfile|Procfile|Dockerfile|.*\.(sh|bash|zsh|md|toml|ya?ml|mjs|js|ts|py|rb))$/.test(name);
}

/** The folders under a checkout those files are looked for in, besides its top. */
export const MENTION_DIRS = ["ops", "scripts", "script", "deploy", "bin", "infra", ".github"];
