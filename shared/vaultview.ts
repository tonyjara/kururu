/**
 * Settings → Vault: everything kururu can see and lend, by name, on one page.
 *
 * Kururu's vault is not a store, and that is why it needed a page. Phase 4
 * decided against 1Password and its kin (`shared/secrets.ts` has the
 * argument): a secret is kept where its program keeps it — a key in a `0600`
 * file of kururu's, an env file in its checkout, an ssh key under `~/.ssh`, a
 * gh token in the Keychain — and read at the moment it is needed. The cost of
 * that was that nothing could say what there was. The Nodes page shows one
 * node's switches, each key's own page shows its own field, and the question
 * "what is in our vault" had no answer short of opening seven pages and a
 * terminal. This is the census: kururu's own keys, each workspace's env
 * files, the ssh hosts and GitHub accounts, the other logins agents use, and
 * what is lent to which node.
 *
 * **Names, never values.** The server sends names, counts, places, times and
 * the hint a key's own page already draws — the last four, an account, a
 * bot's name — and nothing else, not even masked. And nothing is read to make
 * this page that kururu would not read anyway: a private key, a gh token, a
 * Codex or Vercel login are listed by their files being there, as `vault.ts`
 * lists them for lending; an env file is read for its names and dropped, as
 * the lend offer reads it for its count; a key's hint is the one its module
 * already holds. `server/test/vaultview.test.ts` builds the page over a
 * scratch home full of made-up secrets and fails if any of them comes out.
 *
 * Pure, in `shared/`, for the reason the rest of the vault is: the server
 * does the disk, and what a file is read as is text worth a test.
 */
import { parseDotenv } from "./databases";
import type { NodeStatus } from "./nodes";
import { grantText, kindOf, type GrantView, type SecretsView } from "./secrets";

// ---------------------------------------------------------------------------
// What the page is told
// ---------------------------------------------------------------------------

/** The Settings pages a key is set on. Named here because `shared/` cannot see the web's list; the page checks they are its own. */
export type VaultPage = "openrouter" | "channels" | "web" | "anthropic" | "agents" | "nodes";

/** One of kururu's own keys, or a file of kururu's that holds one. */
export interface VaultKey {
  /** The file in `~/.config/kururu`, or a kind id where one file holds several (`claude-token:machine`). */
  id: string;
  label: string;
  /** Whether there is a value there now. */
  set: boolean;
  /** The hint the page that keeps it already draws, or null where that page draws none. */
  hint: string | null;
  /** Where it lives, as `~/…`. */
  where: string;
  /** When its file last changed. */
  changed: number | null;
  /** The Settings page it is set on, or null for one set somewhere else. */
  page: VaultPage | null;
  /** The kind it is lent to a node as, or null for one that never leaves this node. */
  kind: string | null;
  /** Why it never leaves this node, in `NEVER_SHARED`'s words. */
  never: string | null;
  /** On a child: the node it is held from, which is where it is changed. */
  heldFrom: string | null;
}

/** An env file in a workspace's checkout: its names, never a value. */
export interface VaultEnvFile {
  /** Relative to the checkout. */
  file: string;
  /** The variables it sets, by name, in the file's order. */
  names: string[];
  changed: number | null;
  /** Why its names are not here: too big to be an env file, or not readable. */
  note: string | null;
}

export interface VaultWorkspace {
  id: string;
  name: string;
  profile: string;
  /** The checkout its env files are read from, as `~/…`. A workspace with no env file here has nothing to lend and is not listed. */
  checkout: string;
  env: VaultEnvFile[];
  /** The ssh hosts it looks like it uses, and why: the machine its shells are pinned to, a script that names one. */
  ssh: { alias: string; why: string }[];
  /** The account that owns its origin on github.com, and whether gh here is signed in as it. */
  github: { account: string; signedIn: boolean } | null;
}

/** A Host entry in this Mac's `~/.ssh/config`: the alias and its key file's name, never the key. */
export interface VaultSshHost {
  alias: string;
  /** The key file's name, or null when there is none to lend. */
  key: string | null;
  /** Why it cannot be lent, when it cannot. */
  note: string | null;
}

/** An account gh is signed in as on github.com. Its token is in the Keychain and is not read. */
export interface VaultGithub {
  account: string;
  active: boolean;
}

/**
 * A login an agent's CLI keeps for itself: Claude Code's, Codex's, Vercel's.
 * Listed by its being there; who it is only where the tool wrote that
 * somewhere other than the token's own file.
 */
export interface VaultLogin {
  tool: "claude" | "codex" | "vercel";
  /** `this Mac`, a profile's login, `vercel-storefront`. */
  name: string;
  /** Claude's account email, from its account record. Null for Codex and Vercel, whose only record of who is the token's own file. */
  account: string | null;
  /** Vercel's current team, out of its settings file. */
  team: string | null;
  signedIn: boolean;
  where: string;
  /** When it was signed in (Claude), or its login file last changed (Codex, Vercel). */
  changed: number | null;
  /** The profiles whose terminals use it. */
  profiles: string[];
  /** The kind it is lent to a node as, for a Codex login. */
  kind: string | null;
}

export interface VaultView {
  role: "parent" | "child" | "alone";
  keys: VaultKey[];
  workspaces: VaultWorkspace[];
  ssh: VaultSshHost[];
  github: VaultGithub[];
  logins: VaultLogin[];
  at: number;
}

/**
 * What the page calls the files `NEVER_SHARED` lists. A file added there and
 * not here is still listed, by its file name, which is the point of reading
 * that list rather than keeping a second one.
 */
export const NEVER_LABELS: Readonly<Record<string, string>> = {
  "access.json": "Share token",
  "node.json": "This node's keys",
  "nodes.json": "The roster",
  "grants.json": "What each node was lent",
  "secrets-held.json": "What this node holds",
  "anthropic.json": "Anthropic Admin key",
};

// ---------------------------------------------------------------------------
// What a file is read as
// ---------------------------------------------------------------------------

/** Most names one env file lists. Past this it is not configuration, it is data. */
export const ENV_NAMES_MAX = 200;

/** The variables an env file sets, by name, in its order — `parseDotenv`'s keys, the values dropped with the map. */
export function envNames(text: string): string[] {
  return [...parseDotenv(text).keys()].slice(0, ENV_NAMES_MAX);
}

/**
 * The team a Vercel CLI config directory is on, out of its `config.json`:
 * the current team's slug, which the CLI caches beside its id, or the id
 * when it has not. Never `auth.json`, which is the token.
 */
export function vercelTeam(config: unknown): string | null {
  const r = config && typeof config === "object" ? (config as Record<string, unknown>) : null;
  const id = typeof r?.currentTeam === "string" && r.currentTeam.length <= 100 ? r.currentTeam : null;
  if (!id) return null;
  const cached = r?.cachedTeamSlugs && typeof r.cachedTeamSlugs === "object" ? (r.cachedTeamSlugs as Record<string, unknown>)[id] : null;
  const slug = cached && typeof cached === "object" ? (cached as { slug?: unknown }).slug : null;
  return typeof slug === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(slug) ? slug : id;
}

/** The Vercel CLI config directories under `~/.config` that are somebody's login: `vercel-storefront`, by the convention of one per account. */
export function isVercelDir(name: string): boolean {
  return /^vercel-[A-Za-z0-9_.-]{1,60}$/.test(name);
}

// ---------------------------------------------------------------------------
// What is lent, as the page lists it
// ---------------------------------------------------------------------------

/** One kind lent to one node, or on its way back. */
export interface LentRow {
  node: { id: string; name: string };
  kind: string;
  /** What it is: the catalogue's label, or an env file and its workspace. */
  label: string;
  /** How it stands, in `grantText`'s words. */
  text: string;
  /** When the node said it holds the version it has. */
  since: number | null;
  /** Switched on, so there is something to take back. */
  on: boolean;
  bad: boolean;
}

/**
 * Every grant that is on, or is still in a node's hands, node by node in
 * the roster's order: the Nodes page's switches, with the ones that are off
 * and held by nobody left out. Labels from the catalogue, so an env file
 * reads as its file and workspace rather than its hash.
 */
export function lentRows(secrets: Pick<SecretsView, "catalogue" | "grants">, nodes: readonly Pick<NodeStatus, "id" | "name">[]): LentRow[] {
  const labels = new Map(secrets.catalogue.map((entry) => [entry.kind, entry.project ? `${entry.project.file} of ${entry.project.workspace || entry.project.from}` : entry.label] as const));
  const rows: LentRow[] = [];
  for (const node of nodes) {
    for (const grant of secrets.grants[node.id] ?? []) {
      if (!lentNow(grant)) continue;
      rows.push({
        node: { id: node.id, name: node.name },
        kind: grant.kind,
        label: labels.get(grant.kind) ?? kindOf(grant.kind)?.label ?? grant.kind,
        text: grantText(grant, node.name),
        since: grant.heldSince,
        on: grant.on,
        bad: grant.state === "failed",
      });
    }
  }
  return rows;
}

/** On, or off and not let go of yet. A grant switched off that the node has acknowledged is history, and the Nodes page keeps that. */
function lentNow(grant: GrantView): boolean {
  return grant.on || grant.state === "forgetting" || grant.state === "waiting";
}

/** The nodes a kind is switched on for, by name, for a key's line. */
export function lentTo(kind: string, secrets: Pick<SecretsView, "grants">, nodes: readonly Pick<NodeStatus, "id" | "name">[]): string[] {
  return nodes.filter((node) => secrets.grants[node.id]?.some((grant) => grant.kind === kind && grant.on)).map((node) => node.name);
}

/**
 * The nodes an env file of a checkout is switched on for. Its kind is a hash
 * of the node, the checkout and the file, so it is found by the lend the
 * catalogue carries rather than worked out.
 */
export function envLentTo(checkout: string, file: string, secrets: Pick<SecretsView, "catalogue" | "grants">, nodes: readonly Pick<NodeStatus, "id" | "name">[]): string[] {
  const kinds = secrets.catalogue.filter((entry) => entry.project?.from === checkout && entry.project.file === file).map((entry) => entry.kind);
  return [...new Set(kinds.flatMap((kind) => lentTo(kind, secrets, nodes)))];
}
