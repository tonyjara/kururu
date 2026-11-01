/**
 * Small multiples of how much context each of the range's biggest sessions
 * carried, message by message.
 *
 * The chart an optimisation pass reads: nearly every token is the conversation
 * being sent again, so the height of this line is what each further message
 * costs. All on one scale, because the point of drawing eight of them is to see
 * which climbed further, and a scale per strip would make every one of them reach
 * the top. The hairline is 200 k, where Kuru's own compaction point holds it and
 * the agents' are not held at all.
 *
 * One hue: these are eight of the same thing, not eight series.
 */
import { CONTEXT_MARK, type ContextStrip } from "../../../shared/usagereport";
import { compact, niceScale } from "./format";
import { useTip } from "./frame";

const INK = "var(--chart-1)";

function Strip({ strip, top }: { strip: ContextStrip; top: number }) {
  const tip = useTip();
  const n = strip.points.length;
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * 100 : 50);
  const y = (context: number) => 100 - (context / top) * 100;
  const line = strip.points.map((point, i) => `${x(i)},${y(point.context)}`).join(" ");
  const last = strip.points[n - 1];
  return (
    <figure className="ch-strip">
      <figcaption className="ch-strip-head">
        <span className="ch-strip-name" title={strip.label}>
          {strip.label}
        </span>
        <span className="ch-strip-sub">
          {strip.workspace} · peak {compact(strip.peak)}
        </span>
      </figcaption>
      <div
        className="ch-strip-plot"
        tabIndex={0}
        role="img"
        aria-label={`${strip.label}: ${strip.messages} messages, peak ${compact(strip.peak)}, last ${compact(strip.last)}`}
        {...tip.on(() => ({
          title: strip.label,
          rows: [
            { value: compact(strip.peak), label: "peak" },
            { value: compact(strip.median), label: "median" },
            { value: compact(strip.last), label: "last message" },
            { value: strip.over200At === null ? "never" : `message ${strip.over200At.toLocaleString("en-US")}`, label: "passed 200k" },
            { value: strip.messages.toLocaleString("en-US"), label: "messages" },
          ],
        }))}
      >
        <span className="ch-grid ch-strip-mark" style={{ bottom: `${(CONTEXT_MARK / top) * 100}%` }} />
        <svg className="ch-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <polygon points={`0,100 ${line} 100,100`} fill={INK} fillOpacity="0.1" />
          <polyline points={line} fill="none" stroke={INK} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </svg>
        {last && <span className="ch-dot" style={{ left: `${x(n - 1)}%`, bottom: `${100 - y(last.context)}%`, background: INK }} />}
      </div>
    </figure>
  );
}

export function ContextStrips({ strips }: { strips: readonly ContextStrip[] }) {
  const { top } = niceScale(Math.max(CONTEXT_MARK, ...strips.map((strip) => strip.peak)));
  return (
    <div className="ch-strips">
      {strips.map((strip) => (
        <Strip key={strip.sessionId} strip={strip} top={top} />
      ))}
    </div>
  );
}
