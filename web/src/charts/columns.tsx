/**
 * Stacked columns by day, and under them on the same days the limit's line.
 *
 * Two charts and not a second axis: tokens and a percentage have nothing to do
 * with each other's scale, and lining them up on one plot would draw a
 * correlation nobody measured. Anthropic does not publish how tokens weigh
 * against a limit. Sharing the days is enough for the eye to find that the
 * Thursday the limit jumped is the tall one above it.
 *
 * The gap between segments is the segment's own top border in the surface's
 * colour rather than a margin: a margin would push the stack taller than the axis
 * says, by more the more series it has. A sliver smaller than that border would be
 * nothing but the gap, stacked under the marks and lifting them off the baseline,
 * so it is not drawn at all; it is still in the tooltip and the table.
 */
import type { LimitSeries, StackSeries, UsageBucket } from "../../../shared/usagereport";
import { compact, niceScale } from "./format";
import { inkOf, Legend, useTip } from "./frame";

/** Of the axis, about what the gap and one visible pixel come to. */
const SLIVER = 0.02;

function everyNth(count: number, narrow: boolean): number {
  return Math.max(1, Math.ceil(count / (narrow ? 6 : 12)));
}

function XAxis({ buckets, narrow }: { buckets: readonly UsageBucket[]; narrow: boolean }) {
  const nth = everyNth(buckets.length, narrow);
  return (
    <div className="ch-x" aria-hidden="true">
      <span className="ch-gutter" />
      <div className="ch-x-labels">
        {buckets.map((bucket, i) => (
          <span key={bucket.from} className="ch-x-label">
            {i % nth === 0 ? bucket.label : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

export function StackedColumns({ buckets, series, narrow }: { buckets: readonly UsageBucket[]; series: readonly StackSeries[]; narrow: boolean }) {
  const tip = useTip();
  const heights = buckets.map((_, i) => series.reduce((n, s) => n + (s.values[i] ?? 0), 0));
  const peak = Math.max(0, ...heights);
  const peakAt = heights.indexOf(peak);
  const { top, values } = niceScale(peak);
  const whole = series.reduce((n, s) => n + s.total, 0);
  return (
    <div className="ch-chart">
      {series.length > 1 && <Legend items={series.map((s) => ({ key: s.key, label: s.label, ink: inkOf(s.ink), note: whole ? `${((s.total / whole) * 100).toFixed(s.total / whole >= 0.1 ? 0 : 1)}%` : undefined }))} />}
      <div className="ch-plotrow">
        <div className="ch-y ch-gutter" aria-hidden="true">
          {values.map((value) => (
            <span key={value} className="ch-y-tick" style={{ bottom: `${(value / top) * 100}%` }}>
              {compact(value)}
            </span>
          ))}
        </div>
        <div className="ch-plot">
          {values.map((value) => (
            <span key={value} className="ch-grid" style={{ bottom: `${(value / top) * 100}%` }} />
          ))}
          <div className="ch-slots">
            {buckets.map((bucket, i) => (
              <div
                key={bucket.from}
                className="ch-slot"
                tabIndex={0}
                role="img"
                aria-label={`${bucket.long}: ${compact(heights[i] ?? 0)} tokens`}
                {...tip.on(() => ({
                  title: `${bucket.long} · ${compact(heights[i] ?? 0)}`,
                  rows: series
                    .filter((s) => (s.values[i] ?? 0) > 0)
                    .slice()
                    .reverse()
                    .map((s) => ({ ink: inkOf(s.ink), value: compact(s.values[i] ?? 0), label: s.label })),
                }))}
              >
                <div className="ch-col" style={{ height: `${((heights[i] ?? 0) / top) * 100}%` }}>
                  {i === peakAt && peak > 0 && <span className="ch-peak">{compact(peak)}</span>}
                  {series.map((s) =>
                    (s.values[i] ?? 0) / top >= SLIVER ? <span key={s.key} className="ch-seg" style={{ height: `${((s.values[i] ?? 0) / (heights[i] || 1)) * 100}%`, background: inkOf(s.ink) }} /> : null,
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <XAxis buckets={buckets} narrow={narrow} />
    </div>
  );
}

/**
 * The limit, as read. Gaps where nothing was read rather than a line through
 * them, since a limit between two readings may have reset. A lone reading has no
 * line to be on, so every reading that starts or ends a run gets a dot, and the
 * legend says the latest.
 */
export function LimitLines({ buckets, series, narrow }: { buckets: readonly UsageBucket[]; series: readonly LimitSeries[]; narrow: boolean }) {
  const tip = useTip();
  const n = buckets.length;
  const inks = series.map((_, i) => `var(--chart-${(i % 6) + 1})`);
  const runsOf = (values: readonly (number | null)[]) => {
    const runs: { at: number; value: number }[][] = [];
    let run: { at: number; value: number }[] = [];
    values.forEach((value, at) => {
      if (value === null) {
        if (run.length) runs.push(run);
        run = [];
      } else run.push({ at, value });
    });
    if (run.length) runs.push(run);
    return runs;
  };
  return (
    <div className="ch-chart ch-limit">
      <Legend items={series.map((s, i) => ({ key: s.key, label: s.label, ink: inks[i]!, note: s.last === null ? undefined : `${Math.round(s.last)}% now`, line: true }))} />
      <div className="ch-plotrow">
        <div className="ch-y ch-gutter" aria-hidden="true">
          {[0, 50, 100].map((value) => (
            <span key={value} className="ch-y-tick" style={{ bottom: `${value}%` }}>
              {value}%
            </span>
          ))}
        </div>
        <div className="ch-plot">
          {[0, 50, 100].map((value) => (
            <span key={value} className="ch-grid" style={{ bottom: `${value}%` }} />
          ))}
          <svg className="ch-lines" viewBox={`0 0 ${n} 100`} preserveAspectRatio="none" aria-hidden="true">
            {series.map((s, i) =>
              runsOf(s.values).map((run, r) =>
                run.length > 1 ? (
                  <polyline key={`${s.key}:${r}`} points={run.map((point) => `${point.at + 0.5},${100 - point.value}`).join(" ")} fill="none" stroke={inks[i]} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                ) : null,
              ),
            )}
          </svg>
          {series.map((s, i) =>
            runsOf(s.values).flatMap((run) => [run[0]!, run[run.length - 1]!].filter((point, at, both) => both.indexOf(point) === at)).map((point) => (
              <span key={`${s.key}:${point.at}`} className="ch-dot" style={{ left: `${((point.at + 0.5) / n) * 100}%`, bottom: `${point.value}%`, background: inks[i] }} />
            )),
          )}
          <div className="ch-slots">
            {buckets.map((bucket, i) => (
              <div
                key={bucket.from}
                className="ch-slot ch-slot-line"
                tabIndex={0}
                role="img"
                aria-label={`${bucket.long}: ${series.map((s) => `${s.label} ${s.values[i] === null ? "not read" : `${Math.round(s.values[i]!)}%`}`).join(", ")}`}
                {...tip.on(() => ({
                  title: bucket.long,
                  rows: series.map((s, at) => ({ ink: inks[at], value: s.values[i] === null ? "not read" : `${Math.round(s.values[i]!)}%`, label: s.label })),
                }))}
              />
            ))}
          </div>
        </div>
      </div>
      <XAxis buckets={buckets} narrow={narrow} />
    </div>
  );
}
