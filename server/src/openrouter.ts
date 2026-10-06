/**
 * The OpenRouter account in the sidebar: the key that reads it, and the reading.
 *
 * `shared/openrouter.ts` argues for a management key; this is the half that
 * holds one, and holding one is most of what there is to get right.
 *
 * **Where it lives.** `~/.config/kururu/openrouter.json`, mode 0600 — owner
 * only, the way `~/.ssh` keeps a private key. The keychain was the other
 * candidate, and is where `usage.ts` reads Claude's login from, but putting a
 * secret *into* it from a daemon means handing it to `security` on an argv
 * that `ps` can read, and a config file moves with `XDG_CONFIG_HOME` so an
 * isolated instance gets its own and never sees the real one.
 *
 * **How long it is held.** It is read off the disk at the moment of each fetch
 * and dropped with the fetch, for `usage.ts`'s reason: a secret that is never
 * in a module variable cannot end up in a snapshot, a log line or a crash
 * report by somebody's later edit. What the module does keep is `hint`.
 *
 * **What it is used for.** Two GETs: `/credits` for the balance and `/keys` for
 * the spend. A management key can also make and delete keys, and nothing in
 * here ever sends anything but a GET — which is the promise the Settings page
 * makes, and the reason `ask` takes a path and not a method.
 *
 * On the restartable side, beside `usage.ts` and `vps.ts`, for theirs: a
 * question with no event behind it, and nothing to do with a pty. Editing it
 * costs a reconnect and no agents.
 */
import {
  creditsFrom,
  keyHint,
  keyPageFrom,
  sumSpend,
  validOpenRouterKey,
  type OpenRouterReading,
  type OpenRouterSpend,
  type OpenRouterStatus,
} from "../../shared/openrouter";
import { readConfigFile, removeConfigFile, writeConfigFile } from "./config";

const FILE = "openrouter.json";
const API = "https://openrouter.ai/api/v1";

/** `usage.ts`'s figure, for its reason: long enough for a slow tailnet, short enough not to stack up behind a poll. */
const TIMEOUT_MS = 10_000;

/**
 * More pages of `/keys` than anybody has. The page size is not documented, so
 * the list is walked until a page comes back empty — and this is what stops
 * that walk if the API ever answers every offset with the same page.
 */
const MAX_KEY_PAGES = 20;

/** Where the management keys are made, for the sentences that tell somebody to go and make one. */
const KEYS_PAGE = "openrouter.ai/settings/management-keys";

/** The key on disk, or null. Read per call and never cached — see the module comment. */
function storedKey(): string | null {
  const raw = readConfigFile(FILE) as { managementKey?: unknown } | null;
  const key = raw?.managementKey;
  return validOpenRouterKey(key) ? key : null;
}

let hint: string | null = (() => {
  const key = storedKey();
  return key && keyHint(key);
})();

let known: Omit<OpenRouterStatus, "hint"> = { reading: null, stale: false, error: null };

/**
 * Bumped whenever the key changes hands, so a poll that set off with the old
 * key cannot land its answer under the new one's hint — one account's balance
 * drawn as another's is the thing this section must never do.
 */
let generation = 0;
let inflight = false;

/** What the clients should be holding: null when no key has been given. */
export function openRouterSnapshot(): OpenRouterStatus | null {
  return hint ? { hint, ...known } : null;
}

type Asked = { ok: true; body: unknown } | { ok: false; status: number | null; error: string };

/** One GET. Never anything else — see the module comment. */
async function ask(key: string, path: string): Promise<Asked> {
  try {
    const res = await fetch(`${API}${path}`, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, status: res.status, error: refusal(res.status) };
    return { ok: true, body: await res.json() };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return { ok: false, status: null, error: timedOut ? "OpenRouter did not answer in time." : "Could not reach OpenRouter." };
  }
}

/** A status as the sentence the sidebar and the Settings page print. */
function refusal(status: number): string {
  if (status === 401) return "OpenRouter does not recognise this key.";
  if (status === 403) return `This is not a management key. Make one at ${KEYS_PAGE}.`;
  if (status === 429) return "OpenRouter is rate-limiting these requests.";
  return `OpenRouter answered ${status}.`;
}

/**
 * Every key's running totals, summed, or null when this key may not list them.
 * A 403 here is not a failure: an inference key that `/credits` answered gets
 * a balance and no breakdown, rather than nothing. Anything else that goes
 * wrong is, because a breakdown missing half its pages is a wrong one.
 */
async function spendOf(key: string): Promise<{ ok: true; spend: OpenRouterSpend | null } | { ok: false; error: string }> {
  const rows: OpenRouterSpend[] = [];
  for (let page = 0; page < MAX_KEY_PAGES; page++) {
    // Disabled keys too: one turned off this afternoon still spent this morning.
    const asked = await ask(key, `/keys?include_disabled=true&offset=${rows.length}`);
    if (!asked.ok) return asked.status === 403 ? { ok: true, spend: null } : { ok: false, error: asked.error };
    const found = keyPageFrom(asked.body);
    if (!found) return { ok: false, error: "OpenRouter's key list was not in a shape kururu knows." };
    if (found.length === 0) break;
    rows.push(...found);
  }
  return { ok: true, spend: sumSpend(rows) };
}

/** The balance and the spend, both or a sentence saying why not. */
async function read(key: string): Promise<{ ok: true; reading: OpenRouterReading } | { ok: false; error: string }> {
  const [asked, spent] = await Promise.all([ask(key, "/credits"), spendOf(key)]);
  if (!asked.ok) return asked;
  const credits = creditsFrom(asked.body);
  if (!credits) return { ok: false, error: "OpenRouter's balance was not in a shape kururu knows." };
  if (!spent.ok) return spent;
  return { ok: true, reading: { at: Date.now(), ...credits, spend: spent.spend } };
}

/**
 * Refresh the reading, and say whether anything worth a broadcast moved. A
 * failed poll keeps the last balance and marks it stale, as the VPS rows do.
 */
export async function pollOpenRouter(): Promise<boolean> {
  const key = storedKey();
  if (!key || inflight) return false;
  inflight = true;
  const started = generation;
  try {
    const result = await read(key);
    if (generation !== started) return false;
    const before = known;
    known = result.ok
      ? { reading: result.reading, stale: false, error: null }
      : { reading: known.reading, stale: Boolean(known.reading), error: result.error };
    return !same(before, known);
  } finally {
    inflight = false;
  }
}

/**
 * Take a key from Settings: try it, and keep it only if OpenRouter answers. A
 * key that is wrong is refused with the reason rather than saved to fail on
 * every poll, and the reading it was tried with is the first one drawn. Throws
 * the sentence the page prints.
 */
export async function setOpenRouterKey(raw: unknown): Promise<OpenRouterStatus> {
  const key = typeof raw === "string" ? raw.trim() : raw;
  if (!validOpenRouterKey(key)) throw new Error("That does not look like an OpenRouter key.");
  const result = await read(key);
  if (!result.ok) throw new Error(result.error);
  writeConfigFile(FILE, { managementKey: key }, 0o600);
  if (storedKey() !== key) throw new Error("Could not save the key to ~/.config/kururu/openrouter.json.");
  generation++;
  hint = keyHint(key);
  known = { reading: result.reading, stale: false, error: null };
  return openRouterSnapshot()!;
}

/** Forget the key: off the disk, and the section out of the sidebar. */
export function clearOpenRouterKey(): void {
  removeConfigFile(FILE);
  generation++;
  hint = null;
  known = { reading: null, stale: false, error: null };
}

/**
 * Whether two states draw the same. `at` is left out, as `usage.ts` leaves it
 * out: it moves every poll, and comparing it would broadcast an unchanged
 * balance to every client once a minute.
 */
function same(a: typeof known, b: typeof known): boolean {
  if (a.stale !== b.stale || a.error !== b.error) return false;
  const x = a.reading;
  const y = b.reading;
  if (!x || !y) return x === y;
  return (
    x.credits === y.credits &&
    x.used === y.used &&
    x.spend?.day === y.spend?.day &&
    x.spend?.week === y.spend?.week &&
    x.spend?.month === y.spend?.month
  );
}
