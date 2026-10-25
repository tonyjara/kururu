/**
 * The disk half of Settings → Vault: what kururu can see and lend, by name.
 *
 * `shared/vaultview.ts` has the argument for the page and its one rule —
 * names, never values. This file keeps that rule by touching nothing the
 * rest of kururu does not already touch, the same way. A key's hint is
 * handed in by the module that keeps it, which holds one already for its own
 * page; here a file is only stat-ed. A private key, a gh token, a Codex login
 * and a Vercel login are listed by their files being there, through the
 * readers `vault.ts` lists them with for lending. An env file is read through
 * `readEnvSource`, the one the lend offer counts variables with, and only its
 * names are kept. Vercel's `config.json` is read for its team, and its
 * `auth.json` never.
 *
 * Built on request, when the page opens, and never broadcast: an env file's
 * names are a page's to ask for, not every client's to be sent on every
 * change.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tilde } from "../../shared/move";
import { kindOf, NEVER_SHARED, webKind, type SecretsView } from "../../shared/secrets";
import { envNames, isVercelDir, NEVER_LABELS, vercelTeam, type VaultEnvFile, type VaultKey, type VaultLogin, type VaultView, type VaultWorkspace } from "../../shared/vaultview";
import { findEnvFiles, ghAccountsHere, hostsMentioned, readEnvSource, remoteOwnerOf, sshHosts } from "./vault";

/** The hints kururu's own keys' pages already hold, off their modules: nothing here reads a key to make one. */
export interface VaultHints {
  openrouter: string | null;
  telegram: string | null;
  anthropic: string | null;
  /** The web providers that keep a key, with the hint their page draws for it. */
  web: { id: string; label: string; hint: string | null }[];
}

export interface VaultDeps {
  home: string;
  /** `~/.config/kururu`, or wherever `KURURU_CONFIG_DIR` puts it. */
  configDir: string;
  role: VaultView["role"];
  hints: VaultHints;
  secrets: SecretsView;
  /** Every profile's workspaces, with the checkout the server found for each and the ssh host its shells are pinned to. */
  workspaces: { id: string; name: string; profile: string; root: string | null; pinned: string | null }[];
  /** Claude Code's logins: the machine's (`dir` null) and each profile's, with who and since when, as `usage.ts` reads them. */
  claude: { name: string; dir: string | null; profiles: string[]; account: string | null; signedAt: number | null }[];
  /** Codex's homes, by the login they are lent as. */
  codex: { name: string; home: string; login: string; profiles: string[] }[];
}

function changedAt(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function readJson(path: string, max: number): unknown {
  try {
    if (statSync(path).size > max) return null;
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** Kururu's own keys: the ones it lends, then the files that never leave this node. */
function keys(deps: VaultDeps): VaultKey[] {
  const { configDir, home, secrets } = deps;
  const where = (file: string) => tilde(join(configDir, file), home);
  const changed = (file: string) => changedAt(join(configDir, file));
  const heldFrom = (kind: string) => (secrets.heldFrom && secrets.held.some((h) => h.kind === kind) ? secrets.heldFrom : null);
  const never = (file: string) => NEVER_SHARED.find((n) => n.file === file)?.why ?? null;
  const lent = (kind: string, label: string, hint: string | null, page: VaultKey["page"]): VaultKey => {
    const file = (kindOf(kind)?.source as { file?: string } | undefined)?.file ?? kind;
    return { id: file, label, set: hint !== null, hint, where: where(file), changed: changed(file), page, kind, never: never(file), heldFrom: heldFrom(kind) };
  };

  const out: VaultKey[] = [
    lent("openrouter", "OpenRouter management key", deps.hints.openrouter, "openrouter"),
    lent("telegram", "Telegram bot token", deps.hints.telegram, "channels"),
    ...deps.hints.web.map((p) => lent(webKind(p.id), `${p.label} key`, p.hint, "web")),
    { id: "anthropic.json", label: "Anthropic Admin key", set: deps.hints.anthropic !== null, hint: deps.hints.anthropic, where: where("anthropic.json"), changed: changed("anthropic.json"), page: "anthropic", kind: null, never: never("anthropic.json"), heldFrom: null },
  ];

  // One file, a token per Mac login; a row per token, or one saying there is none.
  const lends = deps.role === "child" ? [] : secrets.lends;
  for (const lend of lends) {
    const kind = `claude-token:${lend.login}`;
    out.push({
      id: kind,
      label: lend.login === "machine" ? "Claude token for this Mac's login" : `Claude token for login ${lend.login}`,
      set: true,
      hint: `${lend.hint}${lend.account ? ` · ${lend.account}` : ""}`,
      where: where("claude-lend.json"),
      changed: lend.at || changed("claude-lend.json"),
      page: "agents",
      kind,
      never: null,
      heldFrom: null,
    });
  }
  if (!lends.length && deps.role !== "child") {
    out.push({ id: "claude-lend.json", label: "Claude token for lending", set: false, hint: null, where: where("claude-lend.json"), changed: null, page: "agents", kind: "claude-token:machine", never: null, heldFrom: null });
  }

  // On a child, a lent Claude token lands in a file of its own, which no page here sets.
  const token = secrets.held.find((h) => kindOf(h.kind)?.family === "claude-token");
  if (deps.role === "child" && token) {
    out.push({ id: "claude-token.json", label: "Claude login, as a token", set: true, hint: token.hint, where: where("claude-token.json"), changed: token.updated, page: null, kind: token.kind, never: null, heldFrom: secrets.heldFrom });
  }

  for (const { file, why } of NEVER_SHARED) {
    if (out.some((key) => key.id === file)) continue;
    const at = changed(file);
    // A record nobody has made yet is not a key that is missing.
    if (at === null) continue;
    out.push({ id: file, label: NEVER_LABELS[file] ?? file, set: true, hint: null, where: where(file), changed: at, page: file === "access.json" ? null : "nodes", kind: null, never: why, heldFrom: null });
  }
  return out;
}

/**
 * Each workspace's env files by name, and the ssh host and GitHub account it
 * looks like it needs. A checkout two workspaces share is walked once. Only
 * a workspace with an env file to lend is listed: one in no checkout here,
 * or in one with none, would be a row about nothing, and its hosts and
 * accounts are in their own sections already.
 */
function workspaces(deps: VaultDeps): VaultWorkspace[] {
  const { home } = deps;
  const hosts = sshHosts(home);
  const aliases = hosts.map((h) => h.alias);
  const accounts = ghAccountsHere(home).map((a) => a.account.toLowerCase());
  const byRoot = new Map<string, { env: VaultEnvFile[]; mentioned: Map<string, string>; owner: string | null }>();
  const walk = (root: string) => {
    let found = byRoot.get(root);
    if (found) return found;
    const env = findEnvFiles(root).map((file): VaultEnvFile => {
      // Read as the lend offer reads it, and only its names kept.
      const value = readEnvSource({ node: "", from: root, file, to: root, workspace: "" });
      return { file, names: value ? envNames(value.text) : [], changed: changedAt(join(root, file)), note: value ? null : "too big to be an env file, or not readable" };
    });
    found = { env, mentioned: hostsMentioned(root, aliases), owner: remoteOwnerOf(root) };
    byRoot.set(root, found);
    return found;
  };
  return deps.workspaces.flatMap((w) => {
    if (!w.root) return [];
    const found = walk(w.root);
    if (!found.env.length) return [];
    const ssh: { alias: string; why: string }[] = [];
    if (w.pinned && aliases.includes(w.pinned)) ssh.push({ alias: w.pinned, why: "its shells are pinned to it" });
    for (const [alias, file] of found.mentioned) if (alias !== w.pinned) ssh.push({ alias, why: `${file} names it` });
    const owner = found.owner;
    return [
      {
        id: w.id,
        name: w.name,
        profile: w.profile,
        checkout: tilde(w.root, home),
        env: found.env,
        ssh,
        github: owner ? { account: owner, signedIn: accounts.includes(owner.toLowerCase()) } : null,
      },
    ];
  });
}

/**
 * The logins agents' CLIs keep for themselves. Claude's who and since when
 * come from `usage.ts` (its account record and the Keychain item's
 * attributes, never the item); Codex's and Vercel's are a stat of the login
 * file, which is the token and is not opened.
 */
function logins(deps: VaultDeps): VaultLogin[] {
  const { home } = deps;
  const out: VaultLogin[] = deps.claude.map((c) => ({
    tool: "claude",
    name: c.name,
    account: c.account,
    team: null,
    signedIn: c.signedAt !== null,
    where: tilde(c.dir ?? join(home, ".claude"), home),
    changed: c.signedAt,
    profiles: c.profiles,
    kind: null,
  }));
  for (const c of deps.codex) {
    const at = changedAt(join(c.home, "auth.json"));
    out.push({ tool: "codex", name: c.name, account: null, team: null, signedIn: at !== null, where: tilde(c.home, home), changed: at, profiles: c.profiles, kind: `codex-auth:${c.login}` });
  }
  const vercel: { name: string; dir: string }[] = [];
  // The CLI's own global directory, which is where a plain `vercel login` goes, on either system.
  for (const dir of [join(home, "Library", "Application Support", "com.vercel.cli"), join(home, ".local", "share", "com.vercel.cli")]) {
    if (changedAt(dir) !== null) vercel.push({ name: "vercel", dir });
  }
  // And one per account by the `--global-config ~/.config/vercel-<name>` convention.
  try {
    for (const entry of readdirSync(join(home, ".config"), { withFileTypes: true })) {
      if (entry.isDirectory() && isVercelDir(entry.name)) vercel.push({ name: entry.name, dir: join(home, ".config", entry.name) });
    }
  } catch {
    // No ~/.config.
  }
  for (const v of vercel.sort((a, b) => a.name.localeCompare(b.name))) {
    const at = changedAt(join(v.dir, "auth.json"));
    out.push({ tool: "vercel", name: v.name, account: null, team: vercelTeam(readJson(join(v.dir, "config.json"), 64 * 1024)), signedIn: at !== null, where: tilde(v.dir, home), changed: at, profiles: [], kind: null });
  }
  return out;
}

/** The whole page, read now. */
export function vaultView(deps: VaultDeps): VaultView {
  return {
    role: deps.role,
    keys: keys(deps),
    workspaces: workspaces(deps),
    ssh: sshHosts(deps.home).map((h) => ({ alias: h.alias, key: h.keyPath ? h.keyPath.split("/").pop()! : null, note: h.note })),
    github: ghAccountsHere(deps.home),
    logins: logins(deps),
    at: Date.now(),
  };
}
