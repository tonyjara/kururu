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
 * machine is logged into. The cost of that decision is the one thing in kururu
 * that makes a network request on the user's behalf, with a credential kururu
 * did not mint — which is why the token is read at the moment of the fetch,
 * never held, never logged, and never put on the wire. What crosses to a client
 * is percentages and timestamps. `usage.ts` is the only file that has ever seen
 * the token, and it does not keep it either.
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
import { readFile } from "node:fs/promises";
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
 * On macOS it is the keychain, under a service name with no suffix. Everywhere
 * else it is a file beside the config directory. Both are read straight and
 * neither is written: reading somebody's credential is already the most
 * invasive thing in kururu, and writing one would be past the line.
 *
 * Derived rather than discovered, and that is a real risk — this reimplements
 * somebody else's private naming scheme and will break if they rename it. A
 * miss reads as signed out, which draws nothing, and that is the intended
 * failure: a machine with no readable login is not in an error state.
 */
const KEYCHAIN_SERVICE = "Claude Code-credentials";

/**
 * The access token for this machine's login, or null.
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
async function token(): Promise<string | null> {
  if (process.platform === "darwin") return oauthToken(await keychain(KEYCHAIN_SERVICE));
  // Everywhere else Claude Code writes the credential beside its config.
  const path = join(homedir(), ".claude", ".credentials.json");
  return oauthToken(await readFile(path, "utf8").catch(() => null));
}

/** One keychain item's password, or null. Never logged: it *is* the secret. */
function keychain(service: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "security",
      ["find-generic-password", "-s", service, "-w"],
      { timeout: 5000, maxBuffer: 1 << 20 },
      (err, stdout) => resolve(err ? null : stdout.trim() || null),
    );
  });
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
  | { ok: true; limits: UsageLimit[] }
  | { ok: false; signedOut: true }
  | { ok: false; signedOut: false };

/**
 * Ask the account. Any failure that is not an explicit 401 keeps the previous
 * reading alive — a poll that lands while the laptop's wifi is off is not
 * evidence about anybody's allowance.
 */
async function fetchUsage(): Promise<Reading> {
  const bearer = await token();
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
    return { ok: true, limits: limitsFrom(await res.json()) };
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
 * Refresh the reading, and say whether anything moved.
 *
 * One account, so one request. The poll is still the only thing in `index.ts`
 * that asks somebody else's API rather than this machine, which is why it does
 * not run while nothing is connected.
 */
export async function pollUsage(): Promise<boolean> {
  const fresh = await fetchUsage();
  let next: AccountUsage;
  if (fresh.ok) {
    next = { limits: fresh.limits, at: Date.now(), stale: false, signedOut: false };
  } else if (fresh.signedOut) {
    next = { limits: [], at: Date.now(), stale: false, signedOut: true };
  } else if (reading) {
    // Keep the numbers, admit their age. `at` is not touched: it is when the
    // reading was taken, and a failed poll did not take one.
    next = { ...reading, stale: true };
  } else {
    // Nothing was ever known and this attempt failed. Say nothing at all rather
    // than draw an empty bar, which would read as "all spent".
    return false;
  }
  const moved = !same(reading, next);
  reading = next;
  return moved;
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
  if (a.stale !== b.stale || a.signedOut !== b.signedOut) return false;
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
