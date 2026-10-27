/**
 * Backups: what is precious, what is secret, and the settings between them.
 *
 * A Mac dies, or is wiped, or is replaced, and `~/.config/kururu` and the
 * database are the two things on it nobody can make again. So every few
 * minutes, when something changed, the server writes a mirror of them as
 * text into a git repository of its own and pushes it to a private one the
 * user gave it (`server/src/backup.ts`). This file is the pure half: the
 * settings as a file and off the wire, the status a window draws, and the
 * one list that decides what leaves the machine.
 *
 * **An allow-list, not a deny-list.** The config directory holds a share
 * token, an OpenRouter key, a Telegram bot token, a Firecrawl key, the leftovers of a removed
 * accounts feature with ssh keys in them, every profile's Claude login, and
 * on a node the secrets it lends or was lent (`shared/secrets.ts`). A deny-list that
 * missed the next secret file would ship it; an allow-list that misses the
 * next harmless one ships nothing, which is the mistake to make. So the
 * files that go are named here by name, and anything not named stays.
 *
 * Secrets are left out rather than encrypted, on purpose: an encrypted blob
 * on GitHub is a ciphertext to attack for ever behind a passphrase that is
 * one more thing to lose, and restoring them by hand is one `/login` per
 * profile, one paste of a key and one of a bot token.
 */

export interface BackupSettings {
  /** The remote: an ssh or https git URL, or an absolute path for a repository on this disk. Null until given. */
  url: string | null;
  enabled: boolean;
  /** Minutes between looks. A look that finds nothing changed does nothing. */
  intervalMin: number;
}

export const BACKUP_DEFAULTS: BackupSettings = { url: null, enabled: false, intervalMin: 5 };
export const BACKUP_INTERVAL_MIN = 1;
export const BACKUP_INTERVAL_MAX = 24 * 60;

/**
 * A remote git can be given on a command line: `git@host:path`, `ssh://`,
 * `https://`, or an absolute path. Nothing with a space, a quote or a
 * newline, and nothing that starts with a dash, which git would read as an
 * option.
 */
export function validRepoUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.length < 3 || url.length > 512) return false;
  if (/[\s'"`\\]/.test(url) || url.startsWith("-")) return false;
  return /^(https?:\/\/|ssh:\/\/|git@[^:]+:|\/)/.test(url);
}

export function adoptBackupSettings(value: unknown): BackupSettings {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const url = validRepoUrl(raw.url) ? raw.url : null;
  const interval = typeof raw.intervalMin === "number" && Number.isFinite(raw.intervalMin) ? Math.round(raw.intervalMin) : BACKUP_DEFAULTS.intervalMin;
  return {
    url,
    // Without a remote there is nowhere to go, so the switch reads as off.
    enabled: raw.enabled === true && url !== null,
    intervalMin: Math.min(BACKUP_INTERVAL_MAX, Math.max(BACKUP_INTERVAL_MIN, interval)),
  };
}

/** What a window is told, on connect and whenever a backup runs or the settings change. Never the repository's credentials: git holds those. */
export interface BackupStatus {
  settings: BackupSettings;
  /** Where the mirror and its `.git` are. */
  dir: string;
  running: boolean;
  /** Something has changed since the last backup. */
  pending: boolean;
  lastRunAt: number | null;
  /** The last commit made, as its summary line, and when. */
  lastCommit: string | null;
  lastCommitAt: number | null;
  lastPushAt: number | null;
  /** Why the last run failed, in a sentence, or null. A failed push keeps the commit and tries again next time. */
  error: string | null;
  /** How many commits are made and not yet pushed. */
  unpushed: number;
}

/** The files of `~/.config/kururu` that go, by name. */
export const CONFIG_FILES: readonly string[] = [
  "appearance.json",
  "keys.json",
  "notify.json",
  "launch.json",
  "mascot.json",
  "projects.json",
  "servers.json",
  "vps.json",
  "voice.json",
  "desktop.json",
  "backup.json",
  "web.json",
];

/** The directories of `~/.config/kururu` that go whole: installed and studio styles, and mascot sheets. */
export const CONFIG_DIRS: readonly string[] = ["styles", "sheets"];

/** What stays, said on the page so nobody has to take it on trust. */
export const EXCLUDED: readonly { what: string; why: string }[] = [
  { what: "access.json", why: "the share token" },
  { what: "openrouter.json", why: "the OpenRouter management key" },
  { what: "anthropic.json", why: "the Anthropic Admin key, with the API credit balance you set beside it" },
  { what: "telegram.json", why: "the Telegram bot token, with the channel's switch and allowed accounts beside it" },
  { what: "firecrawl.json", why: "the cloud Firecrawl API key, with its daily budget beside it" },
  { what: "web-*.json", why: "the web providers' keys and addresses: the self-hosted Firecrawl's, and any added later" },
  { what: "node.json", why: "this node's private keys, and on the parent the key that signs the roster" },
  { what: "nodes.json", why: "the roster, and on the parent each child's share token" },
  { what: "child.json", why: "a child's own answers to its setup wizard: this machine's, not a decision to carry to another" },
  { what: "grants.json", why: "which node was lent which secret: node ids that mean nothing once a node is paired anew" },
  { what: "secrets-held.json", why: "on a child, what it holds from the parent, by hint" },
  { what: "claude-lend.json", why: "Claude tokens made with claude setup-token to lend to nodes" },
  { what: "claude-token.json", why: "on a child, the Claude token its parent lent it" },
  { what: "gh/", why: "on a child, the GitHub login its parent lent it, as gh's hosts.yml and git's credential file" },
  { what: "identities/", why: "ssh keys and gh tokens left by the removed accounts feature" },
  { what: "profiles/*/claude/.claude.json", why: "the Claude login and MCP configs" },
  { what: "profiles/*/claude/history.jsonl", why: "Claude Code's own prompt history, which may hold pasted secrets" },
  { what: "profiles/*/claude/projects/*/*.jsonl", why: "transcripts: a gigabyte, and Claude Code's" },
  { what: "the database file", why: "git keeps a whole copy per change; the text export rebuilds it" },
  { what: "agents' replies", why: "in the database and searchable, but an agent's reply can quote a file that holds a secret" },
  { what: "drops/", why: "the pictures and files pasted or sent from a phone into Kuru's box: a screenshot holds whatever was on the screen" },
  { what: "telegram/", why: "the pictures sent from the Telegram chat, and copies of those on their way to it" },
];

/** The keys of a profile's Claude `settings.json` that are not copied: where a key would be put. */
export const SETTINGS_DROP: readonly string[] = ["env"];

/** The subject line of a backup commit, from what changed. */
export function commitSubject(at: number, changes: { cards: number; turns: number; files: number }): string {
  const parts: string[] = [];
  if (changes.cards) parts.push(`${changes.cards} card ${changes.cards === 1 ? "change" : "changes"}`);
  if (changes.turns) parts.push(`${changes.turns} ${changes.turns === 1 ? "turn" : "turns"}`);
  if (changes.files) parts.push(`${changes.files} ${changes.files === 1 ? "file" : "files"}`);
  const when = new Date(at).toISOString().slice(0, 16).replace("T", " ");
  return `kururu backup ${when}${parts.length ? `: ${parts.join(", ")}` : ""}`;
}

/** The README the mirror carries, so a stranger to kururu, or you in a year, knows what the repository is. */
export const BACKUP_README = `# kururu backup

Written by kururu every few minutes, when something changed. Not a place to edit.

- \`config/\` — \`~/.config/kururu\` minus its secrets: the share token, the
  OpenRouter key, the Telegram bot token, the web providers' keys, logins, the
  Claude tokens made for lending, which node holds which secret, and the old
  \`identities/\` folder are never here.
- \`boards/<profile>/<workspace>.json\` — every board: columns, cards, each
  card's runs and its history of moves. Deleted cards are kept, marked.
- \`conversations/<profile>/<session>.jsonl\` — the harness conversation: your
  typed and spoken prompts and Kuru's replies, one turn per line.
- \`memory/<login>/<project>/\` — the harness's memory folders.
- \`profiles/<login>/settings.json\` — each profile's Claude settings, with
  its \`env\` block dropped.
- \`state/session.json\` — the arrangement of panes.
- \`nodes/<name>/\` — each child kururu's own mirror, the same tree as this
  one, pulled over its link whenever its boards changed while this Mac was
  awake. A node's keys, the roster and the secrets it was lent are never
  here, on either side.

To put it all back on a new Mac: clone kururu, then

    bun run restore <this repository's URL>

and onto a fresh child, on that box: \`bun run restore <URL> --node <name>\`.

Then \`/login\` in each profile, paste the OpenRouter key, the Anthropic Admin key
and balance (Settings → Claude API) and the web providers' keys (Settings → Web) in Settings, set
Telegram up again in Settings → Channels if you used it, and approve Input
Monitoring for the talk key. A child restored this way is paired again, and
then ticked again in the Mac's Settings → Nodes → Secrets for whatever it
was lent.
`;
