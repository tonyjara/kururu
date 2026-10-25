/**
 * The Anthropic API credit on the bottom bar, beside OpenRouter's: a gray
 * mark, what is left with an "≈" in front of it, and — on a hover, a tap on
 * a phone — where the figure comes from.
 *
 * The OpenRouter chip's drawing, for its reasons: words rather than a ring,
 * the figure coloured by how many days it lasts (`balanceSeverity`, over the
 * ledger `creditLedger` makes), whole dollars on a phone. What differs is
 * the "≈", and it is the point: Anthropic says no balance to any API, so
 * this is the balance somebody read off the Console less what has been spent
 * since (`shared/anthropiccredit.ts`), and a figure drawn exactly like a
 * read one would be believed like one.
 *
 * Drawn once anything is set, and also before — a mark and "set up" — when
 * OpenRouter has seen BYOK spend, since then there is credit to count and
 * one step counts it. Nothing at all otherwise.
 */
import {
  creditLedger,
  creditLeft,
  SOURCE_NAMES,
  type AnthropicCreditStatus,
  type CreditReading,
} from "../../../shared/anthropiccredit";
import { balanceSeverity, formatDollars, formatDollarsShort, formatRunway, runway } from "../../../shared/openrouter";
import { useKururu } from "../session";
import { BarChip } from "./BarChip";

export function AnthropicCreditChip({ onSettings }: { onSettings: () => void }) {
  const { credit } = useKururu();
  if (!credit || !(credit.anchor || credit.adminHint || credit.byokSeen)) return null;
  const left = creditLeft(credit);
  const ledger = creditLedger(credit);
  const severity = ledger ? balanceSeverity(ledger) : "normal";
  const label =
    left !== null
      ? `Claude API — about ${formatDollars(left)} left (an estimate)`
      : credit.anchor
        ? "Claude API — cannot count"
        : "Claude API — not set up";

  return (
    <BarChip
      label={label}
      className="sb-openrouter"
      chip={
        <>
          <span className="sb-usage-mark" aria-hidden="true">
            <AnthropicMark />
          </span>
          {left !== null ? (
            <span className={`or-balance ${credit.stale ? "or-stale" : ""}`} data-severity={severity}>
              <span className="or-full">≈{formatDollars(left)}</span>
              <span className="or-short">≈{formatDollarsShort(left)}</span>
            </span>
          ) : (
            <span className="or-pending">{credit.anchor ? (credit.error ? "—" : "…") : "set up"}</span>
          )}
          {credit.error && <span className="usage-stale">·</span>}
        </>
      }
    >
      {(close) => (
        <>
          <span className="usage-pop-head">
            <span className="sb-usage-mark" aria-hidden="true">
              <AnthropicMark />
            </span>
            Claude API credit
            {credit.error && (
              <span className="usage-stale" title={credit.error}>
                ·
              </span>
            )}
          </span>
          {credit.anchor && credit.reading ? (
            <Estimate credit={credit} reading={credit.reading} />
          ) : (
            <span className="usage-pop-empty">
              {credit.anchor
                ? (credit.error ?? "Reading what has been spent…")
                : "Anthropic tells no program the balance, so kururu counts down from the one you read off the Console. Give it in Settings."}
            </span>
          )}
          {credit.reading && credit.error && <span className="usage-pop-foot">{credit.error} The figure is the last one counted.</span>}
          {credit.note && <span className="usage-pop-foot">{credit.note}</span>}
          {credit.adminHint && (
            <span className="usage-pop-foot" title="The Admin key reading the cost report">
              {credit.adminHint}
            </span>
          )}
          <span className="usage-pop-foot machines-foot">
            <button
              className="kuru-head-btn"
              onClick={() => {
                close();
                onSettings();
              }}
            >
              Settings → Claude API
            </button>
          </span>
        </>
      )}
    </BarChip>
  );
}

/** The estimate opened: what is left, from what and since when, how long it lasts, and the three windows. */
function Estimate({ credit, reading }: { credit: AnthropicCreditStatus; reading: CreditReading }) {
  const ledger = creditLedger(credit)!;
  const left = creditLeft(credit)!;
  const pace = runway(ledger);
  const since = new Date(credit.anchor!.at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const spend = reading.spend;
  return (
    <ul className={`usage-list ${credit.stale ? "or-stale" : ""}`}>
      <li className="usage-item">
        <span className="usage-head">
          <span className="or-balance" data-severity={balanceSeverity(ledger)}>
            ≈{formatDollars(left)} left
          </span>
          <span className="usage-used">
            of {formatDollars(credit.anchor!.balance)} on {since}
          </span>
        </span>
        <span className="usage-reset">
          {formatDollars(reading.spent)} spent since, by {SOURCE_NAMES[reading.source]}
        </span>
        {pace && (
          <span className="usage-reset">
            {formatRunway(pace.days)} at {formatDollars(pace.perDay)} a day, this {pace.basis}'s pace
          </span>
        )}
      </li>
      {spend &&
        (
          [
            ["Today", spend.day],
            ["This week", spend.week],
            ["This month", spend.month],
          ] as const
        ).map(([name, amount]) => (
          <li key={name} className="usage-item">
            <span className="usage-head">
              <span className="usage-name">{name}</span>
              <span className="usage-used">{formatDollars(amount)}</span>
            </span>
          </li>
        ))}
      <li className="usage-item">
        <span className="usage-reset">
          {reading.source === "cost-report"
            ? "An estimate: the cost report runs about five minutes behind, and leaves out Priority Tier."
            : "An estimate: only what goes through OpenRouter, and every BYOK provider on it together."}
        </span>
      </li>
    </ul>
  );
}

/**
 * Anthropic's mark, the A and the slash: whose credit it is, drawn here for
 * `OpenRouterMark`'s reason. Not Claude's starburst, which the allowances
 * beside it wear for the subscription — this is the other bill.
 */
function AnthropicMark() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M17.304 3.541h-3.672l6.696 16.918H24Zm-10.608 0L0 20.459h3.744l1.37-3.553h7.005l1.369 3.553h3.744L10.536 3.541Zm-.371 10.223 2.291-5.945 2.292 5.945Z" />
    </svg>
  );
}
