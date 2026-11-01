/**
 * How a number is said on a chart. Its own module because the page says each of
 * these dozens of times, and a tile that says 5.2B over a table that says 5,190M
 * reads as two different answers.
 */

/** 1,284 · 12.9k · 238M · 5.19B. Three figures is what anybody reads of a number this size. */
export function compact(n: number): string {
  if (!Number.isFinite(n)) return "–";
  const abs = Math.abs(n);
  const short = (value: number, unit: string) => `${value >= 100 ? Math.round(value).toLocaleString("en-US") : value >= 10 ? value.toFixed(1).replace(/\.0$/, "") : value.toFixed(2).replace(/\.?0+$/, "")}${unit}`;
  if (abs < 10_000) return Math.round(n).toLocaleString("en-US");
  if (abs < 1e6) return short(n / 1e3, "k");
  if (abs < 1e9) return short(n / 1e6, "M");
  return short(n / 1e9, "B");
}

/** Dollars, to the cent only where the cents are most of it. */
export function dollars(n: number): string {
  if (!Number.isFinite(n)) return "–";
  if (n === 0) return "$0";
  if (n < 0.01) return "<$0.01";
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

/** A share of 0–1, to one place; a sliver stays a sliver rather than rounding to nothing. */
export function percent(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return "0%";
  if (share < 0.001) return "<0.1%";
  return `${(share * 100).toFixed(share >= 0.1 ? 0 : 1)}%`;
}

/** A change against the period before, or null when there is nothing to set it against. */
export function changeOf(now: number, before: number): string | null {
  if (!Number.isFinite(now) || !Number.isFinite(before) || before <= 0) return null;
  const change = (now - before) / before;
  if (Math.abs(change) < 0.005) return "about the same";
  return `${change > 0 ? "+" : "−"}${Math.abs(change) >= 10 ? `${Math.round(Math.abs(change))}×` : `${Math.round(Math.abs(change) * 100)}%`}`;
}

/**
 * A round number at or above `max`, and the ticks up to it: an axis reads in
 * ones, twos and fives, and an axis ending at 1,321M is a question.
 */
export function niceScale(max: number, ticks = 4): { top: number; values: number[] } {
  if (!Number.isFinite(max) || max <= 0) return { top: 1, values: [0, 1] };
  const rough = max / ticks;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((candidate) => candidate >= rough) ?? 10 * power;
  const top = Math.ceil(max / step) * step;
  const values: number[] = [];
  for (let value = 0; value <= top + step / 2; value += step) values.push(value);
  return { top, values };
}
