/**
 * Ranked horizontal bars and the segmented bar: the two charts that are only
 * widths.
 *
 * Boxes rather than the SVG the columns' lines need, because a bar's name wraps,
 * ellipsises and moves above its bar on a phone by itself, which in SVG would be
 * text measured by hand; and because a box takes its corners from the skin's
 * radius tokens, so a skin with no curves has none here either.
 */
import { compact, dollars, percent } from "./format";
import { inkOf, Legend, useTip } from "./frame";

export interface RankedBar {
  key: string;
  label: string;
  value: number;
  share: number;
  ink: string;
  sub?: string;
  rows: { value: string; label: string }[];
}

/** One hue, largest first, each bar's share at its end. Lengths against the largest, so the longest bar always fills the row. */
export function RankedBars({ bars }: { bars: readonly RankedBar[] }) {
  const tip = useTip();
  const largest = bars.reduce((n, bar) => Math.max(n, bar.value), 0);
  return (
    <ul className="ch-ranked">
      {bars.map((bar) => (
        <li
          key={bar.key}
          className="ch-rank"
          tabIndex={0}
          aria-label={`${bar.label}: ${compact(bar.value)} tokens, ${percent(bar.share)}`}
          {...tip.on(() => ({ title: bar.label, rows: bar.rows }))}
        >
          <span className="ch-rank-name" title={bar.label}>
            <span className="ch-rank-label">{bar.label}</span>
            {bar.sub && <span className="ch-rank-sub">{bar.sub}</span>}
          </span>
          <span className="ch-rank-track">
            <span className="ch-rank-bar" style={{ width: `${largest ? (bar.value / largest) * 100 : 0}%`, background: bar.ink }} />
          </span>
          <span className="ch-rank-tokens">{compact(bar.value)}</span>
          <span className="ch-rank-share">{percent(bar.share)}</span>
        </li>
      ))}
    </ul>
  );
}

export interface SegmentPart {
  key: string;
  label: string;
  /** Series slot, from the table in `shared/chartcolor.ts`. */
  slot: number;
  amount: number;
  cost: number;
}

/** A share under this has no room for its own number on a phone. The table has it. */
const LABEL_MIN_SHARE = 0.12;

function Whole({ name, parts, value, say }: { name: string; parts: readonly SegmentPart[]; value: (part: SegmentPart) => number; say: (part: SegmentPart) => string }) {
  const tip = useTip();
  const whole = parts.reduce((n, part) => n + value(part), 0);
  return (
    <div className="ch-segrow">
      <span className="ch-seg-name">{name}</span>
      <div className="ch-segbar" role="img" aria-label={`${name}: ${parts.map((part) => `${part.label} ${percent(whole ? value(part) / whole : 0)}`).join(", ")}`}>
        {parts.map((part) => {
          const share = whole ? value(part) / whole : 0;
          if (share <= 0) return null;
          return (
            <span
              key={part.key}
              className="ch-segpart"
              tabIndex={0}
              style={{ flexGrow: share, background: inkOf(part.slot), color: `var(--chart-${part.slot + 1}-ink)` }}
              {...tip.on(() => ({
                title: part.label,
                rows: [
                  { ink: inkOf(part.slot), value: percent(share), label: name.toLowerCase() },
                  { value: say(part), label: "in all" },
                ],
              }))}
            >
              {share >= LABEL_MIN_SHARE ? percent(share) : ""}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/**
 * One whole split two ways, tokens above dollars. The plan drew tokens alone, and
 * on the real week that is a single block with three slivers beside it, 98 % cache
 * read, which says nothing. The dollars under it are what explain why: the same
 * block is under half of them.
 */
export function KindBars({ parts }: { parts: readonly SegmentPart[] }) {
  return (
    <div className="ch-segs">
      <Whole name="Tokens" parts={parts} value={(part) => part.amount} say={(part) => compact(part.amount)} />
      <Whole name="Estimate" parts={parts} value={(part) => part.cost} say={(part) => dollars(part.cost)} />
      <Legend items={parts.map((part) => ({ key: part.key, label: part.label, ink: inkOf(part.slot) }))} />
    </div>
  );
}
