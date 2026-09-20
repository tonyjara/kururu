/**
 * Turning one account limit into the three strings a sidebar row draws.
 *
 * Its own module for the reason `preview.ts` is one: the component that draws
 * this is four lines of JSX and everything interesting about it is the wording,
 * which is pure, and which is therefore the half worth a test. The arithmetic
 * that decides whether "resets in 1h 60m" can ever be printed does not need a
 * window to be wrong in.
 *
 * Everything here reads a limit the *server* has already validated — `usage.ts`
 * on the server drops anything whose percent is not a finite number, so nothing
 * in here has to defend against NaN arriving as a width. What it does defend
 * against is a timestamp, because `resetsAt` is a string off the wire that
 * nobody has parsed until it gets here.
 */
import type { UsageLimit } from "../../shared/wire";

/**
 * What to call one limit in the width a sidebar has.
 *
 * The known kinds are matched by name and anything else falls through to its own
 * `kind`, tidied. That fallthrough is the point rather than politeness: the
 * account decides what limits it has and has added one before, so an unknown
 * kind should appear under a slightly ugly label rather than not appear. A limit
 * that went undrawn would, by the nature of new limits, be the one about to bite.
 */
export function limitLabel(limit: UsageLimit): string {
  const base =
    limit.kind === "session"
      ? "Session"
      : limit.kind === "weekly_all" || limit.kind === "weekly_scoped"
        ? "Week"
        : limit.kind.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  return limit.scope ? `${base} · ${limit.scope}` : base;
}

/** Both numbers and the exact reset, for the reader who wants the real figure. */
export function limitTitle(limit: UsageLimit): string {
  const left = Math.round(100 - limit.percent);
  const used = `${Math.round(limit.percent)}% used, ${left}% left`;
  if (!limit.resetsAt) return used;
  const when = new Date(limit.resetsAt);
  return Number.isNaN(when.getTime()) ? used : `${used}\nResets ${when.toLocaleString()}`;
}

/** How old the numbers on screen are, for the title on the staleness mark. */
export function staleTitle(at: number, now = Date.now()): string {
  const mins = Math.max(1, Math.round((now - at) / 60_000));
  return `Could not reach the account. These numbers are ${mins}m old.`;
}

/**
 * "resets in 2h 14m", "resets in 3d", "resets now".
 *
 * Coarse on purpose and coarser the further out it is. Seconds on a five-hour
 * window would be precision about a figure that arrived up to a minute ago, and
 * a weekly limit resolved to the minute invites reading it as exact when the
 * reading behind it is not.
 *
 * A reset in the past reads as "now" rather than as a negative. The window has
 * turned over and the next poll will say so; a bar printing "-3m" for the fifty
 * seconds in between is the kind of detail that makes a reader distrust the
 * numbers beside it.
 *
 * An unparseable timestamp returns the empty string, which the component draws
 * as no line at all. There is no honest guess at a reset time, and a wrong one
 * here is worse than a missing one — it is the half of this feature people would
 * actually plan their afternoon around.
 */
export function resetIn(iso: string, now = Date.now()): string {
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return "";
  const ms = at - now;
  if (ms <= 0) return "resets now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `resets in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const rest = mins % 60;
    return rest ? `resets in ${hours}h ${rest}m` : `resets in ${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest ? `resets in ${days}d ${rest}h` : `resets in ${days}d`;
}
