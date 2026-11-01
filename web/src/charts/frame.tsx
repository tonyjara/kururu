/**
 * What every chart on a page stands in: its title, a way to read it as a table,
 * a legend and one tooltip.
 *
 * The table is not a courtesy. It is what makes it legal for a colour to fall
 * short somewhere, and for a tooltip to carry a value a bar has no room for: no
 * figure is reachable only by a pointer and good eyes. So a chart cannot be drawn
 * here without saying what its table is.
 *
 * One tooltip per frame, positioned off the pointer inside the frame and held
 * clear of its edges, because this is inside a scrolling dialog where anything
 * that escapes is cut off. It shows on focus as it does on hover, and a tap shows
 * it on a phone, where nothing hovers. Series names can be somebody's card title,
 * and they are only ever text children here, so React escapes them.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { SeriesInk } from "../../../shared/usagereport";
import { Group } from "../settings/ui";

/** The CSS colour a series wears. Text never does: see the marks beside it. */
export function inkOf(ink: SeriesInk): string {
  if (ink === "kuru") return "var(--chart-kuru)";
  if (ink === "rest") return "var(--chart-rest)";
  return `var(--chart-${ink + 1})`;
}

export interface TipContent {
  title: string;
  rows: { ink?: string; value: string; label: string }[];
}

interface TipApi {
  /** Spread on anything that has a tooltip. */
  on(content: () => TipContent): {
    onPointerEnter: (event: React.PointerEvent) => void;
    onPointerMove: (event: React.PointerEvent) => void;
    onPointerLeave: (event: React.PointerEvent) => void;
    onPointerDown: (event: React.PointerEvent) => void;
    onFocus: (event: React.FocusEvent) => void;
    onBlur: () => void;
  };
}

const TipContext = createContext<TipApi | null>(null);

export function useTip(): TipApi {
  const api = useContext(TipContext);
  if (!api) throw new Error("a chart's mark outside a ChartFrame");
  return api;
}

export function ChartFrame({
  title,
  lead,
  foot,
  table,
  children,
}: {
  title: string;
  lead?: ReactNode;
  foot?: ReactNode;
  /** The same figures with nothing to aim at. */
  table: () => ReactNode;
  children: ReactNode;
}) {
  const [tabular, setTabular] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<(TipContent & { x: number; y: number; flipX: boolean; flipY: boolean }) | null>(null);

  const place = useCallback((content: TipContent, clientX: number, clientY: number) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect) return;
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    setTip({ ...content, x, y, flipX: x > rect.width / 2, flipY: y < 96 });
  }, []);

  const api = useMemo<TipApi>(
    () => ({
      on: (content) => ({
        onPointerEnter: (event) => place(content(), event.clientX, event.clientY),
        onPointerMove: (event) => place(content(), event.clientX, event.clientY),
        onPointerDown: (event) => place(content(), event.clientX, event.clientY),
        // A finger's lift is not leaving: the reading it asked for should stay until the next tap.
        onPointerLeave: (event) => {
          if (event.pointerType === "mouse") setTip(null);
        },
        onFocus: (event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          place(content(), rect.left + rect.width / 2, rect.top + rect.height / 2);
        },
        onBlur: () => setTip(null),
      }),
    }),
    [place],
  );

  return (
    <Group
      className="ch-frame"
      title={
        <span className="ch-head">
          <span>{title}</span>
          <button type="button" className="ch-toggle" aria-pressed={tabular} onClick={() => setTabular(!tabular)}>
            {tabular ? "Chart" : "Table"}
          </button>
        </span>
      }
      lead={lead}
      foot={foot}
    >
      <div className="ch-body" ref={box}>
        {tabular ? (
          <div className="ch-tablewrap">{table()}</div>
        ) : (
          <TipContext.Provider value={api}>{children}</TipContext.Provider>
        )}
        {tip && !tabular && (
          <div className={`ch-tip${tip.flipX ? " ch-tip-left" : ""}${tip.flipY ? " ch-tip-below" : ""}`} style={{ left: tip.x, top: tip.y }} role="status">
            <div className="ch-tip-title">{tip.title}</div>
            {tip.rows.map((row, i) => (
              <div key={i} className="ch-tip-row">
                {row.ink && <span className="ch-tip-key" style={{ background: row.ink }} />}
                <span className="ch-tip-value">{row.value}</span>
                <span className="ch-tip-label">{row.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Group>
  );
}

/** Names and swatches, always there for two or more series, in the order the marks are in. */
export function Legend({ items }: { items: readonly { key: string; label: string; ink: string; note?: string; line?: boolean }[] }) {
  return (
    <ul className="ch-legend">
      {items.map((item) => (
        <li key={item.key} className="ch-legend-item" title={item.label}>
          <span className={item.line ? "ch-key-line" : "ch-key"} style={{ background: item.ink }} />
          <span className="ch-legend-name">{item.label}</span>
          {item.note && <span className="ch-legend-note">{item.note}</span>}
        </li>
      ))}
    </ul>
  );
}

/** The twin every chart has. Numbers line up, so they alone get tabular figures. */
export function DataTable({ head, rows, numericFrom = 1 }: { head: readonly string[]; rows: readonly (readonly ReactNode[])[]; numericFrom?: number }) {
  return (
    <table className="ch-table">
      <thead>
        <tr>
          {head.map((cell, i) => (
            <th key={i} scope="col" className={i >= numericFrom ? "ch-num" : undefined}>
              {cell}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, r) => (
          <tr key={r}>
            {row.map((cell, i) => (
              <td key={i} className={i >= numericFrom ? "ch-num" : undefined}>
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
