/**
 * Whether a theme can actually be read, rather than whether it is spelled right.
 *
 * `web/test/theme.test.ts` already holds the seam between the stylesheet and the
 * palettes: every token the CSS asks for is answered, every token a theme fills
 * in is asked for, and no hex is left behind. All of which a theme can pass
 * while being dark grey text on a dark grey ground. The check that was missing
 * is the one a person makes by looking — and, like every other bug in this
 * corner, it is invisible in Mocha and obvious only in the flavour nobody has
 * open. Catppuccin Latte shipped with its accent at 2.17:1 against raised
 * chrome and its on-accent text at 2.31:1 on the `blocked` badge, which is a
 * label nobody could read on the one theme where it mattered most.
 *
 * ## The maths is the easy half; knowing what sits on what is the hard one
 *
 * A contrast ratio is four lines of arithmetic out of WCAG 2. What it needs is a
 * *pair*, and kururu has no list of pairs — it has a stylesheet where 51 rules
 * name an ink and a ground together and 167 more name only an ink and inherit
 * the ground from whatever they are inside of. So the pair list is **extracted
 * from `styles.css`, never typed here**: a hand-kept list of pairs is a second
 * thing to keep in step with the stylesheet, and the whole reason that test file
 * exists is that things kept in step by hand drift silently. Extraction covers
 * the 51; the other 167 need a live window and are not this module's problem.
 *
 * What it does mean is that this check is only as wide as the stylesheet is
 * explicit. That is not a hole so much as a floor — every pair it does see is
 * one somebody wrote down, and a rename that would drop a pair from the sweep is
 * already caught by the orphan check next door.
 *
 * ## Why a role and not a blanket 4.5
 *
 * Because the blanket version is wrong often enough to be ignored, and a check
 * that gets ignored is worse than no check: it makes the next person believe the
 * palettes were audited. ANSI `black` is 1.8:1 against the background in every
 * dark theme in the list, and that is not a bug — it is what ANSI black *is*, in
 * the published palette, on purpose. `dimmer` is a token whose entire job is to
 * recede; holding it to the floor `text` gets would mean it is not dimmer than
 * `dim`, at which point one of the two tokens has no reason to exist.
 *
 * So every token says what it is for when it is used as *ink*, exhaustively —
 * the same forcing function `UiTokens` itself is: adding a token makes somebody
 * answer "and can this be read", rather than letting it default to whatever the
 * last one said. A ground answers `null`, and so does a token that is never text.
 *
 * ## Alpha is refused rather than guessed
 *
 * A ground carrying alpha composites over something this module cannot see —
 * `scrim` is over the whole window and `shadow` is over anything. Two colours
 * and a ratio is the entire model here, and extending it to "and whatever is
 * underneath" would mean modelling the stacking order, which is the live
 * window's job. So a pair with a translucent ground is *skipped*, and skipped
 * visibly, rather than being checked against a number that assumes black.
 */
import type { UiTokens } from "./theme";

/** Straight sRGB, plus the alpha that decides whether this can be a ground at all. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * The spellings a theme may be written in, which is fewer than CSS allows.
 *
 * Deliberately not a general CSS colour parser: a manifest is checked by
 * `cssValue` in `shared/styles.ts` before it ever reaches a window, the built-in
 * palettes are hex, and the two tokens that are not are `rgba()`. A `color-mix`
 * or an `oklch` would come back `null` here and be skipped rather than guessed
 * at, which is the right answer for a value this cannot resolve without a
 * browser.
 */
export function parseColor(value: string): Rgba | null {
  const v = value.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(v);
  if (hex) {
    const h = hex[1]!;
    // `#abc` and `#abcd` are each digit doubled; `#aabbcc` and `#aabbccdd` are not.
    const wide = h.length <= 4 ? h.replace(/./g, (c) => c + c) : h;
    if (wide.length !== 6 && wide.length !== 8) return null;
    const n = (i: number) => parseInt(wide.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: wide.length === 8 ? n(6) / 255 : 1 };
  }
  const fn = /^rgba?\(([^)]*)\)$/i.exec(v);
  if (fn) {
    const parts = fn[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
    const [r, g, b, a] = parts;
    if (![r, g, b].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
    return { r: r!, g: g!, b: b!, a: a === undefined ? 1 : Number.isFinite(a) ? a : 1 };
  }
  return null;
}

/** WCAG 2's relative luminance, which is the sRGB transfer curve and the 709 weights. */
export function relativeLuminance({ r, g, b }: Rgba): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * The ratio, 1 to 21, order-independent.
 *
 * Returns `null` rather than a number when either colour cannot be parsed, so a
 * value this module does not understand is reported as unchecked instead of
 * passing quietly — a `0` or a `21` from an unparsed colour is the one failure
 * mode that would make the sweep say the opposite of the truth.
 */
export function contrastRatio(ink: string, ground: string): number | null {
  const a = parseColor(ink);
  const b = parseColor(ground);
  if (!a || !b) return null;
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * What every token is held to when it is drawn *as text*, or `null` if it never
 * is. Exhaustive over `UiTokens` on purpose — see the header.
 *
 * Two floors, and they are WCAG AA's two: 4.5 for text somebody reads, 3 for a
 * mark whose shape or position already carries the meaning. Kururu's chrome is
 * 11px throughout, so the large-text allowance never applies and 3 is a
 * deliberate relaxation rather than the standard's own.
 */
export const INK_FLOOR: Record<keyof UiTokens, number | null> = {
  // The five grounds. A floor here would be asking what a background reads
  // against, which is a question about whatever is on top of it.
  bg: null,
  chrome: null,
  chromeHigh: null,
  // `line` is both, and is checked as a ground: two rules put `text` and
  // `danger` on it. As ink it is a rule, and a rule is not read.
  line: null,
  lineHigh: null,

  text: 4.5,
  textStrong: 4.5,
  // The statusbar's own colour, and every secondary label. Recessive by
  // design and still text: a statusbar nobody can read is a statusbar that is
  // not there, which is the whole of what it costs.
  dim: 4.5,
  // The one relaxation with a token-level argument behind it. `dimmer` exists
  // to sit a step below `dim` — a caption inside a preview tile, the word under
  // a swatch — and holding it to `dim`'s floor would collapse the two into one
  // token with two names.
  dimmer: 3,
  // Read as text on raised chrome (a focused control's label), so it is held to
  // the reading floor even though it is more often a fill.
  accent: 4.5,
  // Its whole job is to be legible on a bright fill, and it is the one token
  // that lands on three different fills — `accent`, `blocked` and `done`. If
  // anything in here is 4.5, this is.
  onAccent: 4.5,

  // The four states and the fifth. A dot's colour, and the colour a row's name
  // takes while it is in that state, so 3 rather than 4.5 — the badge beside it
  // says which state this is, and `exited` is *meant* to be nearly gone.
  idle: 3,
  working: 3,
  blocked: 3,
  done: 3,
  exited: 3,

  // A destructive label is text, and the one label in the window where being
  // sure what it says matters most.
  danger: 4.5,
  // A fill, like `accent`.
  dangerBg: null,
  onDanger: 4.5,

  // Both carry alpha and neither is ever ink. They are here to be answered
  // rather than forgotten.
  scrim: null,
  shadow: null,
};

export interface Pair {
  ink: keyof UiTokens;
  ground: keyof UiTokens;
}

export interface Finding {
  ink: keyof UiTokens;
  ground: keyof UiTokens;
  /** The ratio, or `null` when a colour could not be parsed. */
  ratio: number | null;
  /** What this ink is held to. */
  floor: number;
  /** Why this pair produced no verdict, when it produced none. */
  skipped?: "translucent-ground" | "unparsed";
}

/**
 * Every pair that comes out below its ink's floor, plus every pair that could
 * not be judged, which is reported rather than dropped.
 *
 * Pairs whose ink has no floor are not a finding and not a skip: a rule putting
 * `line` on `chrome` is a border, and the caller asked about text.
 */
export function auditPairs(ui: UiTokens, pairs: readonly Pair[]): Finding[] {
  const out: Finding[] = [];
  for (const { ink, ground } of pairs) {
    const floor = INK_FLOOR[ink];
    if (floor === null) continue;
    const under = parseColor(ui[ground]);
    if (!under) {
      out.push({ ink, ground, ratio: null, floor, skipped: "unparsed" });
      continue;
    }
    if (under.a < 1) {
      out.push({ ink, ground, ratio: null, floor, skipped: "translucent-ground" });
      continue;
    }
    const ratio = contrastRatio(ui[ink], ui[ground]);
    if (ratio === null) {
      out.push({ ink, ground, ratio: null, floor, skipped: "unparsed" });
      continue;
    }
    if (ratio < floor) out.push({ ink, ground, ratio, floor });
  }
  return out;
}

/** `text on chrome-high 3.2 (wants 4.5)` — one line, for a test's failure message. */
export function describeFinding(f: Finding): string {
  const name = (t: keyof UiTokens) => t.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  const where = `${name(f.ink)} on ${name(f.ground)}`;
  if (f.skipped) return `${where} — not checked (${f.skipped})`;
  return `${where} ${f.ratio!.toFixed(2)} (wants ${f.floor})`;
}
