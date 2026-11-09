/**
 * The colours a chart may wear, and the arithmetic that says they can be told
 * apart.
 *
 * A chart is the one thing in the window whose colours have to be distinguished
 * from each other rather than merely read against a ground, and the board's
 * palette, which the plan for the usage page reached for first, cannot do that.
 * It was chosen for a chip a few pixels wide: on a dark surface its colours sit
 * at OKLCH lightness 0.71 to 0.92 where a chart's want 0.48 to 0.67, a third of
 * them read as grey at the chroma floor, and its worst neighbours are 1.5 apart
 * under protanopia where 8 is the target. Reordering does not rescue that. So
 * the series here are a table, one column per appearance, stepped for the
 * surface rather than flipped.
 *
 * **Kuru is the exception, and it is why any of this is computed.**
 * Kuru wears the accent everywhere else in the window, so a chart that
 * dressed it in anything else would be saying something false about who that
 * is. The accent itself is too light for the same reason the board's colours
 * are, so `kuruInk` keeps its hue and moves its lightness into the band.
 *
 * The checks at the foot are the ones the data-viz method calls computable, at
 * its thresholds, using its simulation of colour blindness (Machado, Oliveira
 * and Fernandes 2009, severity 1.0, to which those thresholds are calibrated).
 * They live here rather than in the test so that `web/test/usage-palette.test.ts`
 * is about which pairs are asked, not about OKLab.
 */
/** Which way round the surface is, which is what the table below is keyed by. */
export type ThemeAppearance = "dark" | "light";

export type Rgb = readonly [number, number, number];

/** Where a chart's colours must sit, in OKLCH lightness, for none to shout over the others. */
export const LIGHTNESS_BAND: Record<ThemeAppearance, readonly [number, number]> = { light: [0.43, 0.77], dark: [0.48, 0.67] };
/** Below this a hue reads as grey and stops doing the work of telling series apart. */
export const CHROMA_FLOOR = 0.1;
/** Worst pair under simulated protanopia or deuteranopia, target and floor. Between them is legal only with a second channel, which every chart here has. */
export const CVD_TARGET = 8;
export const CVD_FLOOR = 6;
/** Worst pair under ordinary vision. Secondary encoding does not excuse this one. */
export const NORMAL_FLOOR = 15;
export const CONTRAST_MARK = 3;

/**
 * How many series a chart may stack before the rest are Other. Fixed order, and
 * a filter that drops one never repaints the others: see `seriesSlots` in
 * `shared/usagereport.ts`.
 */
export const SERIES_SLOTS = 6;

/**
 * The series, in the order that keeps every neighbour in a stack furthest apart,
 * with Kuru's green at the foot and the quiet colour on top: blue, yellow,
 * magenta, violet, aqua, orange. Found by enumerating orderings of the method's
 * validated hues against the surfaces a chart sits on, not by
 * eye; the worst neighbours come out at 9.2 under colour blindness and 19.3 under
 * ordinary vision. Red had to go to get there: beside orange it is 7 apart
 * however it is stepped, and nothing on a page about spending should be red for
 * being fourth.
 */
export const SERIES: Record<ThemeAppearance, readonly string[]> = {
  light: ["#2a78d6", "#eda100", "#e87ba4", "#6250d6", "#1baf7a", "#eb6834"],
  dark: ["#3987e5", "#c98500", "#d55181", "#9085e9", "#199e70", "#d95926"],
};

/**
 * The two inks a label inside a fill may wear. By lightness rather than WCAG's
 * ratio, which picks near-black on a mid blue that nobody finds easier to read;
 * this line gives white on all but light yellow, the same answer APCA gives on
 * all twelve fills here and the method's own palette states.
 */
const INK_LIGHT = "#ffffff";
const INK_DARK = "#0b0b0b";
const INK_TURNS_AT = 0.74;

function channel(hex: string, at: number): number {
  return parseInt(hex.slice(at, at + 2), 16) / 255;
}

function toLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function fromLinear(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

/** `#rrggbb` as linear light, or null for anything else, since CSS allows a colour to be spelled many ways. */
export function linearOf(hex: string): Rgb | null {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return null;
  return [toLinear(channel(hex, 1)), toLinear(channel(hex, 3)), toLinear(channel(hex, 5))];
}

function oklabOfLinear([r, g, b]: Rgb): Rgb {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

function linearOfOklab([L, a, b]: Rgb): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

function hexOfLinear(rgb: Rgb): string {
  return `#${rgb.map((c) => Math.round(Math.min(1, Math.max(0, fromLinear(Math.max(0, c)))) * 255).toString(16).padStart(2, "0")).join("")}`;
}

/** OKLCH lightness and chroma, the two numbers the band and the floor are written in. */
export function lightnessChroma(hex: string): { lightness: number; chroma: number } | null {
  const rgb = linearOf(hex);
  if (!rgb) return null;
  const [L, a, b] = oklabOfLinear(rgb);
  return { lightness: L, chroma: Math.hypot(a, b) };
}

/**
 * The accent as a chart can wear it: its hue, moved the least distance that
 * puts it in the band and over the floor, with the chroma brought back down
 * only as far as the screen can show. A colour already there comes back as it
 * was written. Null for one this cannot read, which the caller answers with the
 * first series colour rather than a guess at what was meant.
 */
export function kuruInk(accent: string, appearance: ThemeAppearance): string | null {
  const rgb = linearOf(accent);
  if (!rgb) return null;
  const [L, a, b] = oklabOfLinear(rgb);
  const [low, high] = LIGHTNESS_BAND[appearance];
  const chroma = Math.hypot(a, b);
  if (L >= low && L <= high && chroma >= CHROMA_FLOOR) return accent.toLowerCase();
  // A hair inside the edges, so that rounding to a byte cannot land it back outside.
  const lightness = Math.min(high - 0.005, Math.max(low + 0.005, L));
  const hue = Math.atan2(b, a);
  let held = Math.max(chroma, CHROMA_FLOOR + 0.005);
  for (;;) {
    const out = linearOfOklab([lightness, held * Math.cos(hue), held * Math.sin(hue)]);
    if (out.every((c) => c >= -0.0005 && c <= 1.0005) || held <= CHROMA_FLOOR) return hexOfLinear(out);
    held -= 0.002;
  }
}

/**
 * The quiet colour: everything that is not the point of a chart, the agents
 * beside Kuru and Other on top of a stack. `dim` where that will do, as it does
 * on the palette kururu has, since it is already the palette's word for
 * receding. Where Kuru's ink lands too near `dim` to be told from it, this steps
 * towards `dimmer`, which recedes further, until the two can be told apart by
 * anybody, and takes the first such step so that it stays as visible as it can.
 */
export function restInk(ui: { dim: string; dimmer: string }, kuru: string): string {
  const from = linearOf(ui.dim);
  const to = linearOf(ui.dimmer);
  if (!from || !to) return ui.dim;
  const apart = (hex: string) => deltaE(kuru, hex) >= NORMAL_FLOOR && Math.min(deltaE(kuru, hex, "protan"), deltaE(kuru, hex, "deutan")) >= CVD_TARGET;
  for (let step = 0; step <= 10; step++) {
    const t = step / 10;
    const hex = hexOfLinear([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t]);
    if (apart(hex)) return hex;
  }
  return ui.dimmer;
}

/** Every colour a chart uses, as the custom properties the stylesheet's `:root` holds. `web/test/usage-palette.test.ts` holds the two together. */
export function chartTokens(theme: { appearance: ThemeAppearance; ui: { accent: string; dim: string; dimmer: string } }): Record<string, string> {
  const series = SERIES[theme.appearance];
  const kuru = kuruInk(theme.ui.accent, theme.appearance) ?? series[0]!;
  const tokens: Record<string, string> = { "--chart-kuru": kuru, "--chart-rest": restInk(theme.ui, kuru) };
  series.forEach((colour, slot) => {
    tokens[`--chart-${slot + 1}`] = colour;
    tokens[`--chart-${slot + 1}-ink`] = (lightnessChroma(colour)?.lightness ?? 0) > INK_TURNS_AT ? INK_DARK : INK_LIGHT;
  });
  return tokens;
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

const MACHADO: Record<"protan" | "deutan", readonly Rgb[]> = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
};

function simulate([r, g, b]: Rgb, kind: "protan" | "deutan"): Rgb {
  const clamp = (c: number) => Math.min(1, Math.max(0, c));
  const m = MACHADO[kind];
  return [0, 1, 2].map((row) => clamp(m[row]![0] * r + m[row]![1] * g + m[row]![2] * b)) as unknown as Rgb;
}

/** Euclidean distance in OKLab ×100, under ordinary vision or a simulated one. */
export function deltaE(a: string, b: string, kind?: "protan" | "deutan"): number {
  const one = linearOf(a);
  const two = linearOf(b);
  if (!one || !two) return 0;
  const x = oklabOfLinear(kind ? simulate(one, kind) : one);
  const y = oklabOfLinear(kind ? simulate(two, kind) : two);
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

/** WCAG 2's ratio, which is what the method's mark contrast is written in. */
export function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const rgb = linearOf(hex);
    return rgb ? 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] : 0;
  };
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

export interface PaletteReport {
  /** Colours outside the appearance's band. Hard. */
  offBand: string[];
  /** Colours under the chroma floor. Hard. */
  grey: string[];
  /** The worst neighbours under simulated colour blindness. Under the floor is hard; between floor and target wants a second channel. */
  worstCvd: number;
  /** The worst neighbours under ordinary vision. Hard. */
  worstNormal: number;
  /** Colours under 3:1 against the surface: legal only with labels or a table, which every chart here has. */
  lowContrast: string[];
  /** Whether nothing above is a hard failure. */
  ok: boolean;
}

/** The six computable checks that a list of neighbouring series can fail, for one appearance on one surface. */
export function checkPalette(palette: readonly string[], appearance: ThemeAppearance, surface: string): PaletteReport {
  const [low, high] = LIGHTNESS_BAND[appearance];
  const read = palette.map((hex) => ({ hex, ...(lightnessChroma(hex) ?? { lightness: 0, chroma: 0 }) }));
  const offBand = read.filter((c) => c.lightness < low || c.lightness > high).map((c) => c.hex);
  const grey = read.filter((c) => c.chroma < CHROMA_FLOOR).map((c) => c.hex);
  let worstCvd = Infinity;
  let worstNormal = Infinity;
  for (let i = 0; i + 1 < palette.length; i++) {
    const [a, b] = [palette[i]!, palette[i + 1]!];
    worstCvd = Math.min(worstCvd, deltaE(a, b, "protan"), deltaE(a, b, "deutan"));
    worstNormal = Math.min(worstNormal, deltaE(a, b));
  }
  const lowContrast = palette.filter((hex) => contrast(hex, surface) < CONTRAST_MARK);
  return { offBand, grey, worstCvd, worstNormal, lowContrast, ok: !offBand.length && !grey.length && worstCvd >= CVD_FLOOR && worstNormal >= NORMAL_FLOOR };
}
