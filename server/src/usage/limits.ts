/**
 * The one bridge Claude's live allowance reading still needs into the ledger.
 *
 * Codex's history is free: every `rate_limits` object rides on the same
 * `token_count` event the rollout tailer already reads for its tokens, so
 * `codexLimitSnapshots` and `flush` keep it in `limits` on the sweep's own
 * beat (`usage/codex.ts`). Nothing on this disk ever wrote down a Claude
 * plan's percentage anywhere else, so `usage.ts`'s poll is the only source,
 * and this is its only reader: called each time `pollAccountUsage` asks
 * again, it writes one row per window the account answered with, and
 * nothing when the reading is the one it already wrote.
 *
 * "The one it already wrote" is decided by `at`, not by the numbers: `usage.ts`
 * leaves `at` exactly where it was on a failed poll and on the short-circuit
 * while a `Retry-After` is being waited out, so an unmoved `at` is the signal
 * that nothing new came back to add to the history, and a repeated percentage
 * at a new `at` is still a sighting worth keeping — the point of `LimitRow`
 * is the history, not the latest value.
 */
import type { LimitRow } from "../../../shared/usage";
import type { AccountUsage } from "../../../shared/wire";
import type { Ledger } from "./store";

let lastAt: number | null = null;

/** Reset between tests; the live module otherwise keeps this for the process's life, like `usage.ts`'s own `reading`. */
export function resetClaudeLimitHistory(): void {
  lastAt = null;
}

/**
 * Write Claude's reading into the ledger, if it is a new one. `account` is
 * the login it belongs to — a profile's key when profiles keep their own
 * logins, the same as Codex's rows carry, or null for the machine's own.
 */
export function recordClaudeLimits(ledger: Ledger | null | undefined, usage: AccountUsage | null, account: string | null): void {
  if (!ledger || !usage || usage.signedOut || usage.stale || usage.limits.length === 0 || usage.at === lastAt) return;
  lastAt = usage.at;
  const rows: LimitRow[] = usage.limits.map((limit) => ({
    at: usage.at,
    account,
    kind: limit.kind,
    scope: limit.scope,
    percent: limit.percent,
    resetsAt: resetsAtMs(limit.resetsAt),
    source: "claude",
  }));
  ledger.recordLimits(rows);
}

/** An ISO timestamp off the wire, as epoch ms or null — never NaN, which would lose every comparison it is in. */
function resetsAtMs(value: string | null): number | null {
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}
