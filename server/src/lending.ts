/**
 * What a terminal is started with, and what this node lends another.
 *
 * Two questions with one answer underneath: whose logins a pty opens with —
 * the machine's, or the profile's own when the switch is on and the host can
 * apply them — and which of those, with a project's secrets, a workspace
 * takes with it to a child (`secrets.ts`, `seal.ts`). The vault's census,
 * which names what could be lent and never shows a value, is built here from
 * the same reads.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { Workspace } from "../../shared/model";
import { folderSentence, type MoveCheck } from "../../shared/move";
import { adoptLendAsk, asksAnything, type Lendable, type SecretsView } from "../../shared/secrets";
import type { Actor } from "../../shared/store";
import type { VaultView } from "../../shared/vaultview";
import { loopbackTokenRequired, tokenEnv } from "./access";
import { configDir } from "./config";
import { channels, hostInfo, hostProtocol, launch, logins, mover, nodes, provide, pushSnapshot, secrets, workspaces } from "./context";
import { web } from "./sweeps";
import { focusedDirs, repoFor } from "./repostatus";
import { claudeDirFor, codexDirFor, lentClaudeEnv, lentGhEnv, loginEnv, scanLogins } from "./logins";
import { findMachine } from "./machines";
import { openRouterSnapshot } from "./openrouter";
import { accountEmail, claudeSignedInAt } from "./usage";
import { vaultView } from "./vaultview";

/**
 * Whether terminals open with their profile's own logins right now.
 *
 * The setting and the host, together. The switch is the person's; the host is
 * what applies the `env` that makes it real, and an old one would drop that
 * field on the floor and open the terminal as the machine's own account with
 * nothing to say so — the one failure this feature must not have. So with the
 * switch on and the host behind, everything that reads this behaves as though
 * the switch were off, and the Profiles page says why.
 */
export function loginsActive(): boolean {
  return launch.loginsPerProfile && hostInfo.env;
}

/**
 * The environment a terminal opened in the active profile gets on top of the
 * server's own: the profile's login directories, or nothing at all. Absent
 * rather than empty, which keeps the common case off the wire.
 */
export function spawnEnv(): Record<string, string> | undefined {
  return spawnEnvFor(workspaces.active.id);
}

/**
 * The same, for a terminal opened in a profile that need not be the one on
 * screen — the harness's case. And `KURURU_TOKEN` beside the logins, while
 * loopback wants the token (`tokenInPtys`).
 */
export function spawnEnvFor(profileId: string): Record<string, string> | undefined {
  const profile = workspaces.profile(profileId);
  const login = loginsActive() && profile ? loginEnv(profile.loginKey) : undefined;
  const token = tokenInPtys() ? tokenEnv() : undefined;
  // A Claude login the parent lent this node, on a child whose user has no
  // browser anywhere, and a GitHub login it lent so agents can clone and
  // push: both need the host's `env` too, so protocol 2.
  const lent = hostProtocol >= 2 ? lentClaudeEnv() : undefined;
  const gh = hostProtocol >= 2 ? lentGhEnv() : undefined;
  return login || token || lent || gh ? { ...login, ...token, ...lent, ...gh } : undefined;
}

/**
 * Whether the ptys this server opens carry `KURURU_TOKEN`: loopback wants the
 * token (`access.ts`), and the host takes an `env`, which is protocol 2. The
 * MCP configs name the variable only then, since a config asking for one that
 * is not set is a server Claude Code will not start.
 */
export function tokenInPtys(): boolean {
  return loopbackTokenRequired() && hostProtocol >= 2;
}

/** Where a profile's Claude keeps its config, and so its transcripts: its own directory, or the machine's. */
export function claudeDirOf(profileId: string): string {
  const profile = workspaces.profile(profileId);
  if (loginsActive() && profile) return claudeDirFor(profile.loginKey);
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/**
 * The checkout a workspace's env files are read from: the repository its
 * folders are in, the focused one first, as the branch walk finds it. Found
 * by the server, as every root is, and never a path a client sent; null for
 * a workspace in no repository. Not `state.projects`, whose root is the
 * workspace's first folder even when that is no repository — a new
 * workspace's shell at home, whose env files would be every project's.
 */
async function checkoutOf(workspace: Workspace): Promise<string | null> {
  for (const dir of focusedDirs(workspace)) {
    const repo = await repoFor(dir);
    if (repo) return repo.root;
  }
  return null;
}

function workspaceIn(profileId: string, workspaceId: string): Workspace {
  const workspace = workspaces.profile(profileId)?.workspaces.find((w) => w.id === workspaceId);
  if (!workspace) throw new Error("That workspace is gone.");
  return workspace;
}

/**
 * What a workspace could lend a node — its env files, the ssh entries and
 * GitHub logins this Mac has, the ones it seems to need first — with the
 * node's word on the folder its env files would go to. Hints only.
 */
export async function lendOffer(profileId: string, workspaceId: string, nodeId: string, folder: string | null): Promise<Lendable> {
  const workspace = workspaceIn(profileId, workspaceId);
  const name = nodes.nameOf(nodeId);
  if (!name) throw new Error("That node is not in the roster.");
  const root = await checkoutOf(workspace);
  let check: MoveCheck | null = null;
  let checkError: string | null = null;
  try {
    check = await mover.folderCheck(profileId, workspaceId, nodeId, folder, root);
  } catch (err) {
    checkError = err instanceof Error ? err.message : String(err);
  }
  const pinned = workspace.machine ? (findMachine(workspace.machine.machineId)?.host ?? null) : null;
  return secrets.offer({ node: { id: nodeId, name }, workspace: { id: workspace.id, name: workspace.name }, root, pinned, check, checkError });
}

/**
 * Lend a node what was asked of a workspace's. The folder its env files go
 * to is asked of the node again now, whatever a client said it checked:
 * it is where the node will write, and the node is the one who knows.
 */
export async function lendSecrets(profileId: string, workspaceId: string, nodeId: string, folder: string | null, raw: unknown): Promise<{ view: SecretsView; lent: string[]; to: string | null }> {
  const ask = adoptLendAsk(raw);
  if (!asksAnything(ask)) throw new Error("Nothing was named to lend.");
  const workspace = workspaceIn(profileId, workspaceId);
  const root = await checkoutOf(workspace);
  let to: string | null = null;
  if (ask.env.length) {
    const check = await mover.folderCheck(profileId, workspaceId, nodeId, folder, root);
    if (check.problem) throw new Error(folderSentence(check.problem, nodes.nameOf(nodeId) ?? "the node", check.shown));
    to = check.folder;
  }
  return { ...secrets.lendProject(nodeId, { root, to, workspace: workspace.name }, ask), to };
}

/**
 * Settings → Vault: everything this kururu can see and lend, by name. The
 * hints are the ones each key's own module holds for its own page; every
 * profile's workspaces are walked for their env files' names; the logins are
 * the ones a profile's terminals are sent to. Asked for by the page when it
 * opens, never broadcast.
 */
export async function vaultFor(): Promise<VaultView> {
  const home = homedir();
  const profiles = workspaces.all();
  const perProfile = loginsActive();
  const names = (key: string | null) => profiles.filter((p) => (key === null ? !perProfile : p.loginKey === key)).map((p) => p.name);
  const keys = perProfile ? [...new Set(profiles.map((p) => p.loginKey))] : [];

  const machineDir = process.env.CLAUDE_CONFIG_DIR || null;
  const claude = [
    {
      name: "this Mac",
      dir: machineDir,
      profiles: names(null),
      account: await accountEmail(machineDir ? join(machineDir, ".claude.json") : join(home, ".claude.json")),
      signedAt: await claudeSignedInAt(machineDir),
    },
  ];
  for (const key of keys) {
    const dir = claudeDirFor(key);
    claude.push({ name: `login ${key}`, dir, profiles: names(key), account: await accountEmail(join(dir, ".claude.json")), signedAt: await claudeSignedInAt(dir) });
  }
  const codex = [
    { name: "this Mac", home: process.env.CODEX_HOME || join(home, ".codex"), login: "machine", profiles: names(null) },
    ...keys.map((key) => ({ name: `login ${key}`, home: codexDirFor(key), login: key, profiles: names(key) })),
  ];

  const found = [];
  for (const profile of profiles) {
    for (const workspace of profile.workspaces) {
      const pinned = workspace.machine ? (findMachine(workspace.machine.machineId)?.host ?? null) : null;
      found.push({ id: workspace.id, name: workspace.name, profile: profile.name, root: await checkoutOf(workspace), pinned });
    }
  }

  const telegram = channels.status().telegram;
  return vaultView({
    home,
    configDir: configDir(),
    role: nodes.role(),
    hints: {
      openrouter: openRouterSnapshot()?.hint ?? null,
      telegram: telegram.hint && telegram.bot ? `@${telegram.bot.username} ${telegram.hint}` : telegram.hint,
      web: web
        .status()
        .providers.filter((p) => p.fields.some((f) => f.kind === "secret"))
        .map((p) => ({ id: p.id, label: p.label, hint: p.fields.flatMap((f) => (f.kind === "secret" && f.held ? [f.held] : [])).join(" · ") || null })),
    },
    secrets: secrets.view(),
    workspaces: found,
    claude,
    codex,
  });
}

/**
 * Move a workspace, and lend the node what the dialog ticked once it is
 * there: into the folder the move was made to, which the node has just
 * judged. The checkout here is found first, while the workspace still is.
 * A move that is refused or fails lends nothing; a lend that fails after a
 * move that worked is said beside it, since the move is done.
 */
export async function moveAndLend(profileId: string, workspaceId: string, nodeId: string, folder: string, raw: unknown, actor: Actor) {
  const ask = adoptLendAsk(raw ?? {});
  const root = asksAnything(ask) ? await checkoutOf(workspaceIn(profileId, workspaceId)) : null;
  const moved = await mover.move(profileId, workspaceId, nodeId, folder, actor);
  if (!asksAnything(ask)) return { ...moved, lent: [] as string[], lendError: null };
  try {
    const { lent } = secrets.lendProject(nodeId, { root, to: moved.done.folder, workspace: moved.done.name }, ask);
    return { ...moved, lent, lendError: null };
  } catch (err) {
    return { ...moved, lent: [] as string[], lendError: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Which login "Lend this login" lends, for a profile: its own directory
 * while profiles keep their own logins, else the machine's — and whose
 * account it is, as Claude Code recorded it there.
 */
export async function lendingLogin(profileId: unknown): Promise<{ login: string; account: string | null }> {
  const profile = typeof profileId === "string" ? workspaces.profile(profileId) : undefined;
  if (!profile) throw new Error("That profile is gone.");
  if (loginsActive()) return { login: profile.loginKey, account: await accountEmail(join(claudeDirFor(profile.loginKey), ".claude.json")) };
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return { login: "machine", account: await accountEmail(dir ? join(dir, ".claude.json") : join(homedir(), ".claude.json")) };
}

/** The same for Codex, whose rollouts are where a card's Codex conversation is found (`sleep.ts`). */
export function codexHomeOf(profileId: string): string {
  const profile = workspaces.profile(profileId);
  if (loginsActive() && profile) return codexDirFor(profile.loginKey);
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

export async function refreshLogins(): Promise<void> {
  const found = new Map((await scanLogins()).map((login) => [login.key, login] as const));
  for (const profile of workspaces.all()) {
    if (!found.has(profile.loginKey)) found.set(profile.loginKey, { key: profile.loginKey, email: null });
  }
  const held = new Set(workspaces.all().map((p) => p.loginKey));
  // A directory nobody uses and nobody signed into is an empty folder, and
  // listing it would offer a choice that means nothing.
  const next = [...found.values()]
    .filter((login) => login.email !== null || held.has(login.key))
    .sort((a, b) => a.key.localeCompare(b.key));
  if (JSON.stringify(next) === JSON.stringify(logins)) return;
  provide("logins", next);
  pushSnapshot();
}
