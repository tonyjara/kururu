/**
 * How much of the Claude allowance is spent, asked of the account that owns it.
 *
 * Everything else kururu knows about tokens it works out from a transcript.
 * `transcript.ts` reads both ends of a JSONL file and says how full one agent's
 * context window is, and that is exact because the number is written down: the
 * model states what the turn cost. The allowance is not like that. A plan limit
 * is not a token count — it weights models against each other, discounts cache
 * reads, and is stated nowhere on this machine. Summing the transcripts and
 * dividing by a guess produces a bar that is confidently wrong, and wrong in the
 * direction that matters, because the only time anybody reads it is the hour it
 * is about to run out.
 *
 * So this asks. `/api/oauth/usage` is what Claude Code's own `/usage` reads, and
 * it answers with percentages and real reset timestamps for the account this
 * machine is logged into — or, when profiles keep their own logins, the account
 * the profile on screen is logged into: `pollUsage` is told which directory to
 * read and reads nothing else. The cost of that decision is the one thing in kururu
 * that makes a network request on the user's behalf, with a credential kururu
 * did not mint — which is why the token is read at the moment of the fetch,
 * never held, never logged, and never put on the wire. What crosses to a client
 * is percentages and timestamps. `usage.ts` is the only file that has ever seen
 * the token, and it does not keep it either. The account's email does cross, so
 * that with two logins on one machine the bar can say whose allowance it is.
 *
 * It lives on the restartable side, beside `devservers.ts` and for the same
 * reason: it asks the world a question no pty can raise an event about, and
 * nothing in here touches a terminal. Editing it costs a reconnect and no
 * agents.
 *
 * **The endpoint is undocumented and therefore assumed to be temporary.** Every
 * field is read defensively and a shape that has moved on degrades to "no
 * reading" rather than to a wrong one — see `limitsFrom`, which is the whole of
 * that policy. If it disappears, the bar goes quiet; nothing else does.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AccountUsage, UsageLimit } from "../../shared/wire";

const ENDPOINT = "https://api.anthropic.com/api/oauth/usage";

/**
 * The beta header Claude Code sends with an OAuth credential. Sent because the
 * token is only accepted under it, not because we want the beta — a plain
 * bearer against this path is a 401, and a 401 here is indistinguishable from
 * being signed out, which would draw "sign in" at somebody who is signed in.
 */
const OAUTH_BETA = "oauth-2025-04-20";

/** Long enough to cross a slow tailnet, short enough not to stack up behind a poll. */
const TIMEOUT_MS = 10_000;

/**
 * Where Claude Code keeps the login on this machine.
 *
 * On macOS it is the keychain, under a service name with no suffix for the
 * default config directory and with the first eight hex digits of the
 * directory's SHA-256 for any other — which is how `CLAUDE_CONFIG_DIR` gives
 * one machine several logins. Everywhere else it is a file inside the config
 * directory. Both are read straight and neither is written: reading somebody's
 * credential is already the most invasive thing in kururu, and writing one would
 * be past the line.
 *
 * Derived rather than discovered, and that is a real risk — this reimplements
 * somebody else's private naming scheme and will break if they rename it. A
 * miss reads as signed out, which draws nothing, and that is the intended
 * failure: a machine with no readable login is not in an error state.
 */
const KEYCHAIN_SERVICE = "Claude Code-credentials";

/**
 * Where kururu made a config directory per Claude account in the version where
 * a profile *chose* one. Profiles have directories of their own again, under
 * `profiles/` and by a different rule (`logins.ts`), but those are asked about
 * by name — `pollUsage` is handed the one that matters — and never scanned.
 * These still are, because the logins inside them are still in use by hand,
 * through `CLAUDE_CONFIG_DIR`, and are where a second login is most likely to
 * be when nothing has named one.
 */
const IDENTITIES = join(homedir(), ".config", "kururu", "identities", "claude");

/** One place a login might be: its keychain service, its file, and its account record. */
interface Login {
  service: string;
  credentials: string;
  account: string;
}

/**
 * Every login this machine might hold. The default, whatever `CLAUDE_CONFIG_DIR`
 * the server itself was started under, and each directory under `IDENTITIES`.
 *
 * Not every keychain item named `Claude Code-credentials-*`: the suffix is a
 * hash, and a login that cannot be traced back to its directory has no account
 * record beside it to say whose it is.
 */
async function logins(): Promise<Login[]> {
  const home = homedir();
  const found: Login[] = [
    {
      service: KEYCHAIN_SERVICE,
      credentials: join(home, ".claude", ".credentials.json"),
      account: join(home, ".claude.json"),
    },
  ];
  const dirs = new Set<string>();
  if (process.env.CLAUDE_CONFIG_DIR) dirs.add(process.env.CLAUDE_CONFIG_DIR);
  const entries = await readdir(IDENTITIES, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) if (entry.isDirectory()) dirs.add(join(IDENTITIES, entry.name));
  for (const dir of dirs) found.push(loginFor(dir));
  return found;
}

/**
 * The login a Claude config directory other than the default holds: its
 * keychain service under the scheme described above, its file, and its account
 * record. The path is hashed exactly as given — no trailing slash, no realpath
 * — because that is what Claude Code hashes, and the two have to agree to the
 * byte.
 */
function loginFor(dir: string): Login {
  return {
    service: `${KEYCHAIN_SERVICE}-${createHash("sha256").update(dir).digest("hex").slice(0, 8)}`,
    credentials: join(dir, ".credentials.json"),
    account: join(dir, ".claude.json"),
  };
}

/**
 * When a login was signed in, in milliseconds, or null if it is not there.
 *
 * The keychain's creation date, because `/login` makes the item and a token
 * refresh only modifies it — so this is "signed in", where the modification date
 * would be "last used by any agent", and with two accounts both in use that
 * moves back and forth every few minutes. `security` without `-w` prints the
 * item's attributes and not its secret. Off macOS the file's birth time stands in
 * for the same thing, falling back to its mtime where the filesystem keeps none.
 */
async function signedInAt(login: Login): Promise<number | null> {
  if (process.platform === "darwin") {
    const attrs = await run("security", ["find-generic-password", "-s", login.service]);
    const match = attrs?.match(/"cdat"<timedate>=0x[0-9A-F]+\s+"(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z/);
    if (!match) return null;
    const [, y, mo, d, h, mi, sec] = match.map(Number) as number[];
    return Date.UTC(y!, mo! - 1, d!, h!, mi!, sec!);
  }
  const info = await stat(login.credentials).catch(() => null);
  if (!info) return null;
  return info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs;
}

/**
 * The most recently signed-in login. "The one I logged into last" is the only
 * rule that needs no settings screen and matches what somebody just did: they
 * ran `/login` somewhere and expect the bar to follow.
 */
async function currentLogin(): Promise<Login | null> {
  let best: Login | null = null;
  let bestAt = -Infinity;
  for (const login of await logins()) {
    const at = await signedInAt(login);
    if (at !== null && at > bestAt) {
      best = login;
      bestAt = at;
    }
  }
  return best;
}

/**
 * The access token for a login, or null.
 *
 * Null covers every way there might not be one — no keychain entry, a file that
 * is not there, a shape that has changed — and they are deliberately not told
 * apart. Every one of them means the same thing to the caller and to the
 * sidebar: there is nothing to draw and nothing is wrong.
 *
 * Expiry is *not* checked here even though `expiresAt` sits right beside the
 * token, and that is deliberate. Refreshing would mean writing to the credential
 * store Claude Code owns, which is the one thing that could log somebody out of
 * a running agent to draw a bar. An expired token 401s, the reading goes stale,
 * and the next time Claude Code itself runs it refreshes and the bar comes back.
 */
async function token(login: Login): Promise<string | null> {
  if (process.platform === "darwin") return oauthToken(await keychain(login.service));
  return oauthToken(await readFile(login.credentials, "utf8").catch(() => null));
}

/**
 * The email Claude Code recorded for a login. Not a secret — it is what
 * `/status` prints — but it is read from the account record and nowhere else,
 * so a login whose record has gone reads as nobody rather than as a guess.
 */
async function email(login: Login): Promise<string | null> {
  return accountEmail(login.account);
}

/**
 * The email in a Claude account record — `.claude.json` in a config directory
 * — or null. Exported for the login list on the Profiles page, which labels
 * each directory by who is in it and has no other way to know. Kept here rather
 * than beside the directories because this is the file that knows the record's
 * shape, and the shape is somebody else's.
 */
export async function accountEmail(record: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(record, "utf8")) as {
      oauthAccount?: { emailAddress?: unknown };
    };
    return text(parsed.oauthAccount?.emailAddress);
  } catch {
    return null;
  }
}

/** A command's stdout, or null. */
function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 5000, maxBuffer: 1 << 20 }, (err, stdout) =>
      resolve(err ? null : stdout.trim() || null),
    );
  });
}

/** One keychain item's password, or null. Never logged: it *is* the secret. */
function keychain(service: string): Promise<string | null> {
  return run("security", ["find-generic-password", "-s", service, "-w"]);
}

/** `claudeAiOauth.accessToken` out of the credential blob, if it is in there. */
function oauthToken(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown } };
    const token = parsed.claudeAiOauth?.accessToken;
    return typeof token === "string" && token ? token : null;
  } catch {
    return null;
  }
}

/**
 * A number off somebody else's wire, held to the rule every other number off a
 * wire is held to in here: finite or nothing. A clamp is not a check — NaN loses
 * every comparison it is in, so `Math.min(100, NaN)` is NaN and a bar drawn at
 * `NaN%` is a bar of width zero that reads as "you have used none of it".
 */
function percent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

/** A string, or null — never the empty string, which draws as a gap. */
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * The `limits` array, turned into ours.
 *
 * The response also carries a dozen top-level keys — `five_hour`, `seven_day`,
 * and then a run of codenames that are null on every account seen so far. Those
 * are somebody's feature flags and reading them would be reading their roadmap;
 * `limits` is the same information stated once, self-describing, with the kind
 * and the scope written down. So this reads that and ignores the rest.
 *
 * An entry missing a percent is dropped rather than defaulted, because there is
 * no honest default: zero says "you have spent nothing" and a hundred says the
 * opposite, and both are assertions about somebody's account made up by a parser.
 * A dropped entry draws no bar, which is the only thing here that is true.
 */
export function limitsFrom(body: unknown): UsageLimit[] {
  const raw = (body as { limits?: unknown })?.limits;
  if (!Array.isArray(raw)) return [];
  const limits: UsageLimit[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const pct = percent(row.percent);
    if (pct === null) continue;
    const kind = text(row.kind);
    if (!kind) continue;
    const scope = (row.scope as { model?: { display_name?: unknown } } | null)?.model?.display_name;
    limits.push({
      kind,
      group: text(row.group) ?? kind,
      percent: pct,
      severity: text(row.severity) ?? "normal",
      resetsAt: text(row.resets_at),
      scope: text(scope),
    });
  }
  return limits;
}

/** What one fetch can come back as. `error` keeps whatever was known before. */
type Reading =
  | { ok: true; limits: UsageLimit[]; email: string | null }
  | { ok: false; signedOut: true }
  | { ok: false; signedOut: false };

/**
 * Ask the account. Any failure that is not an explicit 401 keeps the previous
 * reading alive — a poll that lands while the laptop's wifi is off is not
 * evidence about anybody's allowance.
 */
async function fetchUsage(claudeDir: string | null): Promise<Reading> {
  const login = claudeDir ? loginFor(claudeDir) : await currentLogin();
  const bearer = login && (await token(login));
  if (!bearer) return { ok: false, signedOut: true };
  try {
    const res = await fetch(ENDPOINT, {
      headers: {
        authorization: `Bearer ${bearer}`,
        "anthropic-beta": OAUTH_BETA,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // 401 is the one failure that means something specific: the credential was
    // read and refused. Every other status is the network or their side having a
    // bad minute, and says nothing about the account.
    if (res.status === 401 || res.status === 403) return { ok: false, signedOut: true };
    if (!res.ok) return { ok: false, signedOut: false };
    return { ok: true, limits: limitsFrom(await res.json()), email: await email(login) };
  } catch {
    return { ok: false, signedOut: false };
  }
}

/**
 * The last good reading, so a failed poll can leave one standing. Null until a
 * fetch has come back with something — which is not the same as a reading that
 * says signed out, and the sidebar draws neither.
 */
let reading: AccountUsage | null = null;

/**
 * Which directory the standing reading is of — a profile's, or null for the
 * machine's own. A reading is only ever kept up across a failed poll for the
 * account it was taken from: asked about a different one, the poll forgets
 * before it fetches, because one profile's numbers under another's name is the
 * one thing the bar must never draw.
 */
let scope: string | null = null;

/**
 * Refresh the reading, and say whether anything moved.
 *
 * `claudeDir` is which login to ask: a profile's Claude config directory when
 * profiles keep their own logins — the one the terminals in it are signed in
 * as — or null for the machine's own, which is the last one signed into. One
 * account, so one request. The poll is still the only thing in `index.ts` that
 * asks somebody else's API rather than this machine, which is why it does not
 * run while nothing is connected.
 */
export async function pollUsage(claudeDir: string | null = null): Promise<boolean> {
  // A change of scope is itself news: the bar on screen is the other account's.
  const switched = claudeDir !== scope;
  if (switched) {
    scope = claudeDir;
    reading = null;
  }
  const fresh = await fetchUsage(claudeDir);
  // Switched again while this one was in flight. Its answer is about a
  // directory nobody is looking at now, and the poll that switched is coming.
  if (scope !== claudeDir) return false;
  let next: AccountUsage;
  if (fresh.ok) {
    next = { limits: fresh.limits, at: Date.now(), stale: false, signedOut: false, email: fresh.email };
  } else if (fresh.signedOut) {
    next = { limits: [], at: Date.now(), stale: false, signedOut: true, email: null };
  } else if (reading) {
    // Keep the numbers, admit their age. `at` is not touched: it is when the
    // reading was taken, and a failed poll did not take one.
    next = { ...reading, stale: true };
  } else {
    // Nothing was ever known and this attempt failed. Say nothing at all rather
    // than draw an empty bar, which would read as "all spent" — unless the
    // scope just changed, in which case "nothing" is exactly what the clients
    // must be told, because what they are drawing is the previous account.
    return switched;
  }
  const moved = !same(reading, next);
  reading = next;
  return moved || switched;
}

/** What the clients should be holding, or null if nothing has ever been read. */
export function usageSnapshot(): AccountUsage | null {
  return reading;
}

/**
 * Whether a reading is worth a broadcast. `at` is excluded on purpose — it moves
 * every single poll, and comparing it would push an identical set of percentages
 * to every client once a minute forever.
 */
function same(a: AccountUsage | null, b: AccountUsage): boolean {
  if (!a) return false;
  if (a.stale !== b.stale || a.signedOut !== b.signedOut || a.email !== b.email) return false;
  if (a.limits.length !== b.limits.length) return false;
  return a.limits.every((limit, i) => {
    const other = b.limits[i]!;
    return (
      limit.kind === other.kind &&
      limit.percent === other.percent &&
      limit.severity === other.severity &&
      limit.resetsAt === other.resetsAt &&
      limit.scope === other.scope
    );
  });
}
