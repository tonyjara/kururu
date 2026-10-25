/**
 * The Anthropic API credit on the bottom bar: the balance somebody read off
 * the Console, an Admin key if they gave one, and the estimate between them.
 *
 * `shared/anthropiccredit.ts` argues for the estimate; this is the half that
 * keeps the anchor and the key, and asks.
 *
 * **Where they live.** `~/.config/kururu/anthropic.json`, mode 0600, on
 * `openrouter.ts`'s terms and for its reasons: read off the disk at the
 * moment of each fetch and dropped with it, `hint` the only thing about the
 * key a module variable holds. The balance sits beside the key rather than in
 * a file of its own, which costs it the backup — a figure re-read off the
 * Console in a second, against a second file to keep in step.
 *
 * **What the key is used for.** An Admin key cannot run a model, but it can
 * invite and remove members and make and delete every API key the
 * organisation has, so it is the most powerful thing kururu stores beside
 * the OpenRouter one. Nothing here sends anything but a GET to the cost
 * report, and it never leaves this node: a child has no use for the Mac's
 * organisation, so it is not a kind that can be lent (`NEVER_SHARED`).
 *
 * **How often.** Every five minutes while a window is open, where OpenRouter
 * is asked every minute: the report lands about five minutes behind the calls
 * anyway, Anthropic asks for no more than a request a minute sustained, and a
 * month's buckets can be two pages. The BYOK source needs no poll of its own;
 * it rides on OpenRouter's, which is why `creditSnapshot` takes OpenRouter's
 * status rather than reading it.
 *
 * Restartable side, beside `openrouter.ts`. Editing it costs a reconnect and
 * no agents.
 */
import {
  adminKeyHint,
  anchorFrom,
  anchorSources,
  chooseSource,
  costPageFrom,
  costStart,
  costWindows,
  spentByByok,
  spentByCost,
  utcDay,
  validAdminKey,
  validBalance,
  type AnthropicCreditStatus,
  type CostDay,
  type CreditAnchor,
  type CreditReading,
} from "../../shared/anthropiccredit";
import type { OpenRouterStatus } from "../../shared/openrouter";
import { readConfigFile, removeConfigFile, writeConfigFile } from "./config";

const FILE = "anthropic.json";
const API = "https://api.anthropic.com/v1/organizations/cost_report";

/** `openrouter.ts`'s figure, for its reason. */
const TIMEOUT_MS = 10_000;

/** A year of 31-day pages. An anchor older than that is a balance nobody has looked at, and the page says to set it again. */
const MAX_PAGES = 12;

/** Where Admin keys are made, for the sentences that send somebody to make one. */
const KEYS_PAGE = "platform.claude.com/settings/admin-keys";

interface Stored {
  adminKey: string | null;
  anchor: CreditAnchor | null;
}

/** What is on the disk, read per call and never cached — see the module comment. */
function stored(): Stored {
  const raw = readConfigFile(FILE) as { adminKey?: unknown; anchor?: unknown } | null;
  return { adminKey: validAdminKey(raw?.adminKey) ? raw.adminKey : null, anchor: anchorFrom(raw?.anchor) };
}

/** Back to the disk, or off it when there is nothing left to keep. */
function store(next: Stored): void {
  if (!next.adminKey && !next.anchor) return removeConfigFile(FILE);
  const value: Record<string, unknown> = {};
  if (next.adminKey) value.adminKey = next.adminKey;
  if (next.anchor) value.anchor = next.anchor;
  writeConfigFile(FILE, value, 0o600);
}

let hint: string | null = (() => {
  const key = stored().adminKey;
  return key && adminKeyHint(key);
})();

/** The cost report's days since `costStart`, as last read, and how that went. */
let known: { days: CostDay[] | null; at: number; stale: boolean; error: string | null } = { days: null, at: 0, stale: false, error: null };

/** `openrouter.ts`'s guard: a poll that set off with the old key never lands under the new one's hint. */
let generation = 0;
let inflight = false;

type Asked = { ok: true; days: CostDay[] } | { ok: false; error: string };

/** The cost report from `from`'s day to today, every page. Only ever a GET. */
async function askCost(key: string, from: string, now = Date.now()): Promise<Asked> {
  // `ending_at` is "buckets that end before": the day after tomorrow, so today's bucket — ending at midnight — is in.
  const today = new Date(now);
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 2)).toISOString();
  const days: CostDay[] = [];
  let page: string | null = null;
  for (let n = 0; n < MAX_PAGES; n++) {
    const query = new URLSearchParams({ starting_at: `${from}T00:00:00Z`, ending_at: end, bucket_width: "1d", limit: "31" });
    if (page) query.set("page", page);
    let res: Response;
    try {
      res = await fetch(`${API}?${query}`, {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", accept: "application/json", "user-agent": "kururu" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      return { ok: false, error: timedOut ? "Anthropic did not answer in time." : "Could not reach Anthropic." };
    }
    if (!res.ok) return { ok: false, error: refusal(res.status) };
    const parsed = costPageFrom(await res.json().catch(() => null));
    if (!parsed) return { ok: false, error: "Anthropic's cost report was not in a shape kururu knows." };
    days.push(...parsed.days);
    if (!parsed.next) return { ok: true, days };
    page = parsed.next;
  }
  return { ok: false, error: "The balance was set over a year ago; set it again from the Console." };
}

/** A status as the sentence the bar and the page print. */
function refusal(status: number): string {
  if (status === 401) return "Anthropic does not recognise this key.";
  if (status === 403) return `This key may not read the cost report. It needs an Admin key, made at ${KEYS_PAGE}.`;
  if (status === 404) return "Anthropic has no cost report for this key's organisation.";
  if (status === 429) return "Anthropic is rate-limiting these requests.";
  return `Anthropic answered ${status}.`;
}

/**
 * What the windows should be holding. Never null — the chip decides from
 * `byokSeen` and the rest whether there is anything to draw — and worked out
 * afresh each time from the anchor, the cost report's last days and
 * OpenRouter's last reading, so neither poll has to know about the other.
 */
export function creditSnapshot(openrouter: OpenRouterStatus | null, now = Date.now()): AnthropicCreditStatus {
  const { anchor } = stored();
  const byok = openrouter?.reading?.byok ?? null;
  const base = {
    adminHint: hint,
    anchor: anchor && { balance: anchor.balance, at: anchor.at, sources: anchorSources(anchor) },
    byokSeen: (byok?.total ?? 0) > 0,
  };
  if (!anchor) return { ...base, reading: null, stale: false, error: hint ? known.error : null, note: null };

  const source = chooseSource(anchor, { admin: Boolean(hint), byok: byok !== null });
  const note = hint && !anchor.cost ? "Set the balance again to count from Anthropic's cost report, which sees every call." : null;
  if (source === "cost-report" && anchor.cost) {
    const reading: CreditReading | null = known.days && {
      at: known.at,
      source,
      spent: spentByCost({ ...anchor, cost: anchor.cost }, known.days),
      spend: costWindows(known.days, now),
    };
    return { ...base, reading, stale: known.stale, error: known.error, note };
  }
  if (source === "openrouter-byok" && byok && anchor.byok !== null && openrouter?.reading) {
    const reading: CreditReading = {
      at: openrouter.reading.at,
      source,
      spent: spentByByok({ ...anchor, byok: anchor.byok }, byok.total),
      spend: { day: byok.day, week: byok.week, month: byok.month },
    };
    return { ...base, reading, stale: openrouter.stale, error: openrouter.error, note };
  }
  const error = anchor.cost
    ? "The balance was counted from the cost report, and there is no Admin key now. Give one, or set the balance again."
    : "The balance was counted from OpenRouter, which is not saying now. Check Settings → OpenRouter, or set the balance again.";
  return { ...base, reading: null, stale: false, error, note };
}

/**
 * Read the cost report again, and say whether anything worth a broadcast
 * moved. A failed read keeps the last days and marks them stale.
 */
export async function pollCredit(now = Date.now()): Promise<boolean> {
  const { adminKey, anchor } = stored();
  if (!adminKey || inflight) return false;
  inflight = true;
  const started = generation;
  try {
    const result = await askCost(adminKey, costStart(anchor?.cost?.day ?? null, now), now);
    if (generation !== started) return false;
    const before = known;
    known = result.ok
      ? { days: result.days, at: Date.now(), stale: false, error: null }
      : { days: known.days, at: known.at, stale: Boolean(known.days), error: result.error };
    return before.stale !== known.stale || before.error !== known.error || JSON.stringify(before.days) !== JSON.stringify(known.days);
  } finally {
    inflight = false;
  }
}

/**
 * Take a balance from Settings, and the baselines it is counted from: today's
 * cost so far when there is an Admin key, the BYOK total when OpenRouter is
 * saying. A balance with neither is refused rather than kept, because it
 * would sit on the bar never moving, which is a lie told in a calm colour.
 * Throws the sentence the page prints.
 */
export async function setCreditBalance(raw: unknown, openrouter: OpenRouterStatus | null): Promise<void> {
  if (!validBalance(raw)) throw new Error("A balance is a number of dollars, like 187.42.");
  const now = Date.now();
  const { adminKey } = stored();
  let cost: CreditAnchor["cost"] = null;
  if (adminKey) {
    const day = utcDay(now);
    const asked = await askCost(adminKey, day, now);
    if (!asked.ok) throw new Error(asked.error);
    cost = { day, before: asked.days.reduce((sum, d) => (d.day === day ? sum + d.dollars : sum), 0) };
  }
  // A stale reading's total is an old one, and a baseline from it would count spend from before the balance was read.
  const byok = openrouter?.reading && !openrouter.stale ? (openrouter.reading.byok?.total ?? null) : null;
  if (!cost && byok === null) {
    throw new Error("There is nothing to count spending with yet: give an Admin key below, or an OpenRouter management key in Settings → OpenRouter.");
  }
  const anchor: CreditAnchor = { balance: Math.round(raw * 100) / 100, at: now, cost, byok };
  store({ adminKey: stored().adminKey, anchor });
  if (stored().anchor?.at !== now) throw new Error(`Could not save the balance to ~/.config/kururu/${FILE}.`);
}

/** Forget the balance, and keep the key. */
export function clearCreditBalance(): void {
  store({ adminKey: stored().adminKey, anchor: null });
}

/**
 * Take an Admin key: try it on this month's cost report, and keep it only if
 * Anthropic answers, for `openrouter.ts`'s reason. Throws the sentence the
 * page prints.
 */
export async function setAdminKey(raw: unknown): Promise<void> {
  const key = typeof raw === "string" ? raw.trim() : raw;
  if (!validAdminKey(key)) throw new Error("That does not look like an Anthropic key.");
  const now = Date.now();
  const { anchor } = stored();
  const asked = await askCost(key, costStart(anchor?.cost?.day ?? null, now), now);
  if (!asked.ok) throw new Error(asked.error);
  store({ adminKey: key, anchor });
  if (stored().adminKey !== key) throw new Error(`Could not save the key to ~/.config/kururu/${FILE}.`);
  generation++;
  hint = adminKeyHint(key);
  known = { days: asked.days, at: now, stale: false, error: null };
}

/** Forget the key, and keep the balance — which falls back to OpenRouter if it can. */
export function clearAdminKey(): void {
  store({ adminKey: null, anchor: stored().anchor });
  generation++;
  hint = null;
  known = { days: null, at: 0, stale: false, error: null };
}
