/**
 * The OpenRouter account on the bottom bar: a gray mark, the balance in
 * dollars, and — on a hover, a tap on a phone — what it is going at.
 *
 * It was a section of the sidebar until 2026-10-18, after the allowances and
 * the machines had gone to the bar, and it followed them for their reason: a
 * balance is a glance on the way past, and the bar is where the window keeps
 * those. The sidebar had kept it on the argument that it is a figure rather
 * than a gauge and that a phone's bar had no room for a fourth chip; the
 * first is true and is why the chip is words, and the second is answered by
 * drawing less on a phone rather than nothing (`formatDollarsShort`, below).
 *
 * Words rather than a ring, which is the departure from the chips beside it,
 * and it is because a balance has no whole to be a share of. `credits` is
 * every dollar ever bought, so spent-over-bought is a ring that creeps toward
 * full for the life of the account and says nothing about this week. The
 * balance, coloured by how many days it lasts at the pace it is going, says
 * the thing — `balanceSeverity` has those days. The mark stays gray, as the
 * allowances' do: it names the account, and the figure carries the colour.
 *
 * On a phone the figure is whole dollars, `$12` or `$1.2k`, so the chip
 * stays narrower than the workspace's name it shares the bar with; the cents
 * are in the popover. Both figures are in the markup and the stylesheet
 * shows one, as `Usage.tsx` does with its rings, so there is one notion of
 * narrow and it is the stylesheet's.
 *
 * Drawn only once a key has been given in Settings, as the section was.
 */
import type { OpenRouterReading } from "../../../shared/openrouter";
import {
  balanceOf,
  balanceSeverity,
  formatDollars,
  formatDollarsShort,
  formatRunway,
  runway,
} from "../../../shared/openrouter";
import { useKururu } from "../session";
import { BarChip } from "./BarChip";

export function OpenRouterChip({ onSettings }: { onSettings: () => void }) {
  const { openrouter } = useKururu();
  if (!openrouter) return null;
  const { reading, stale, error } = openrouter;
  const severity = reading ? balanceSeverity(reading) : "normal";
  const label = reading
    ? `OpenRouter — ${formatDollars(balanceOf(reading))} left`
    : error
      ? `OpenRouter — unreachable`
      : "OpenRouter";

  return (
    <BarChip
      label={label}
      className="sb-openrouter"
      chip={
        <>
          <span className="sb-usage-mark" aria-hidden="true">
            <OpenRouterMark />
          </span>
          {reading ? (
            <span className={`or-balance ${stale ? "or-stale" : ""}`} data-severity={severity}>
              <span className="or-full">{formatDollars(balanceOf(reading))}</span>
              <span className="or-short">{formatDollarsShort(balanceOf(reading))}</span>
            </span>
          ) : (
            <span className="or-pending">{error ? "—" : "…"}</span>
          )}
          {error && <span className="usage-stale">·</span>}
        </>
      }
    >
      {(close) => (
        <>
          <span className="usage-pop-head">
            <span className="sb-usage-mark" aria-hidden="true">
              <OpenRouterMark />
            </span>
            OpenRouter
            {error && (
              <span className="usage-stale" title={reading ? `${error}\nThe balance is the last one read.` : error}>
                ·
              </span>
            )}
          </span>
          {reading ? (
            <Balance reading={reading} stale={stale} />
          ) : (
            <span className="usage-pop-empty">{error ?? "Reading the balance…"}</span>
          )}
          {reading && error && <span className="usage-pop-foot">{error} The balance is the last one read.</span>}
          <span className="usage-pop-foot" title="The management key reading this account">
            {openrouter.hint}
          </span>
          <span className="usage-pop-foot machines-foot">
            <button
              className="kuru-head-btn"
              onClick={() => {
                close();
                onSettings();
              }}
            >
              Settings → OpenRouter
            </button>
          </span>
        </>
      )}
    </BarChip>
  );
}

/**
 * What the sidebar drew opened: the balance and how long it lasts, then what
 * every key on the account spent today, this week and this month.
 */
function Balance({ reading, stale }: { reading: OpenRouterReading; stale: boolean }) {
  const pace = runway(reading);
  const spend = reading.spend;
  return (
    <ul className={`usage-list ${stale ? "or-stale" : ""}`}>
      <li className="usage-item">
        <span className="usage-head">
          <span className="or-balance" data-severity={balanceSeverity(reading)}>
            {formatDollars(balanceOf(reading))} left
          </span>
          <span className="usage-used">of {formatDollars(reading.credits)} bought</span>
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
    </ul>
  );
}

/**
 * OpenRouter's mark, the two arrows leaving one line: whose balance it is,
 * drawn here rather than taken from the skin's icon set on `SidebarIcon`'s
 * reasoning — a product's mark is the same drawing in any chrome.
 */
function OpenRouterMark() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M16.778 1.844v1.919q-.569-.026-1.138-.032-.708-.008-1.415.037c-1.93.126-4.023.728-6.149 2.237-2.911 2.066-2.731 1.95-4.14 2.75-.396.223-1.342.574-2.185.798-.841.225-1.753.333-1.751.333v4.229s.768.108 1.61.333c.842.224 1.789.575 2.185.799 1.41.798 1.228.683 4.14 2.75 2.126 1.509 4.22 2.11 6.148 2.236.88.058 1.716.041 2.555.005v1.918l7.222-4.168-7.222-4.17v2.176c-.86.038-1.611.065-2.278.021-1.364-.09-2.417-.357-3.979-1.465-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 1.56-1.109 2.614-1.377 3.978-1.466.667-.044 1.418-.017 2.278.02v2.176L24 6.014Z" />
    </svg>
  );
}
