/**
 * The arithmetic under the readability check, and the two ways it is allowed to
 * decline to answer.
 *
 * `web/test/theme.test.ts` holds the interesting half — every pair the
 * stylesheet states, against every theme, ratcheted. What is here is what that
 * half rests on, and the reason it is worth its own file is that a contrast
 * check which is quietly *wrong* is worse than none at all: it reports a palette
 * as audited. The two failure shapes that would do it are a colour parsed to the
 * wrong numbers, and a colour not parsed at all coming back as a number anyway —
 * an unparsed value read as black is 21:1 against white and 1:1 against black,
 * so it passes or fails loudly and in neither case tells you it did not know.
 * Hence `null` all the way through rather than a default.
 */
import { describe, expect, it } from "bun:test";
import {
  auditPairs,
  contrastRatio,
  describeFinding,
  INK_FLOOR,
  parseColor,
  relativeLuminance,
  type Pair,
} from "../../shared/contrast";
import { themeFor } from "../../shared/theme";
import type { UiTokens } from "../../shared/theme";

describe("parseColor", () => {
  it("reads the spellings a theme is written in", () => {
    expect(parseColor("#1e1e2e")).toEqual({ r: 30, g: 30, b: 46, a: 1 });
    // Short hex is each digit doubled, not each digit zero-padded: `#abc` is
    // `#aabbcc`, and reading it as `#0a0b0c` would be a near-black that looks
    // plausible in every ratio it appears in.
    expect(parseColor("#abc")).toEqual({ r: 170, g: 187, b: 204, a: 1 });
    expect(parseColor("#abcd")).toEqual({ r: 170, g: 187, b: 204, a: 221 / 255 });
    expect(parseColor("#11111bff")).toEqual({ r: 17, g: 17, b: 27, a: 1 });
    expect(parseColor("rgba(0, 0, 0, 0.5)")).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
    expect(parseColor("rgb(255 128 0)")).toEqual({ r: 255, g: 128, b: 0, a: 1 });
  });

  it("refuses what it cannot resolve rather than guessing", () => {
    // A value that needs a browser to know what it is. The whole point of the
    // null is that `color-mix` must not come back as black.
    expect(parseColor("color-mix(in srgb, var(--chrome), var(--bg))")).toBeNull();
    expect(parseColor("oklch(0.7 0.1 200)")).toBeNull();
    expect(parseColor("rebeccapurple")).toBeNull();
    expect(parseColor("#12345")).toBeNull();
    expect(parseColor("")).toBeNull();
  });
});

describe("contrastRatio", () => {
  it("spans 1 to 21 and does not care which way round", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#1e1e2e", "#1e1e2e")).toBeCloseTo(1, 5);
  });

  /**
   * Mocha's body text on Mocha's ground, pinned to a number worked out
   * independently of this code. It is here as a check on the *curve*: the sRGB
   * transfer function is what separates this from a plain linear ramp, and a
   * linear luminance gets a dark theme appreciably wrong in the flattering
   * direction — #cdd6f4 on #1e1e2e comes out around 6.6:1 instead of 11.3:1,
   * which is a palette that would pass a check it should not.
   */
  it("uses the sRGB curve, not a linear ramp", () => {
    const ui = themeFor("catppuccin-mocha").ui;
    expect(contrastRatio(ui.text, ui.bg)).toBeCloseTo(11.34, 2);
  });

  it("is null when either side is unreadable, never a number", () => {
    expect(contrastRatio("chartreuse", "#000000")).toBeNull();
    expect(contrastRatio("#000000", "var(--bg)")).toBeNull();
  });

  it("uses the low branch of the transfer curve below the knee", () => {
    // 0.03928 * 255 ≈ 10, so #0a is on the linear side of the curve.
    expect(relativeLuminance({ r: 10, g: 10, b: 10, a: 1 })).toBeCloseTo(10 / 255 / 12.92, 6);
  });
});

describe("INK_FLOOR", () => {
  /**
   * The record is typed `Record<keyof UiTokens, …>`, so TypeScript already
   * refuses a missing or invented key. This is the runtime half of that, and it
   * is here for the case the type is ever loosened — a token added to `UiTokens`
   * with no answer in here would silently be a token nobody decided about.
   */
  it("answers for every token a theme fills in, and invents none", () => {
    const tokens = Object.keys(themeFor(null).ui).sort();
    expect(Object.keys(INK_FLOOR).sort()).toEqual(tokens);
  });

  it("holds the four tokens that exist to be read to the reading floor", () => {
    expect(INK_FLOOR.text).toBe(4.5);
    expect(INK_FLOOR.textStrong).toBe(4.5);
    expect(INK_FLOOR.onAccent).toBe(4.5);
    expect(INK_FLOOR.onDanger).toBe(4.5);
  });

  it("holds nothing that is only ever a ground", () => {
    for (const token of ["bg", "chrome", "chromeHigh", "dangerBg", "scrim", "shadow"] as const) {
      expect(INK_FLOOR[token]).toBeNull();
    }
  });
});

describe("auditPairs", () => {
  const ui = (over: Partial<UiTokens>): UiTokens => ({ ...themeFor(null).ui, ...over });

  it("reports a pair under its ink's floor and nothing else", () => {
    const pairs: Pair[] = [
      { ink: "text", ground: "bg" },
      { ink: "dim", ground: "chrome" },
    ];
    const found = auditPairs(ui({ dim: "#1f1f30" }), pairs);
    expect(found.map(describeFinding)).toEqual(["dim on chrome 1.08 (wants 4.5)"]);
  });

  /**
   * A pair whose ink is a ground or a rule is not a finding *and not a skip*:
   * `line` on `chrome` is a border, and nobody reads a border. Counting it as
   * unchecked would put it in the same list as the cases below, which are the
   * ones somebody has to go and look at.
   */
  it("passes over a pair whose ink is never text", () => {
    expect(auditPairs(ui({}), [{ ink: "line", ground: "chrome" }])).toEqual([]);
  });

  /**
   * The two declines. Both come back *in the list* rather than being dropped,
   * because a pair that left the sweep silently is how a theme ends up looking
   * audited when a third of it was never looked at.
   */
  it("declines a translucent ground instead of compositing it over a guess", () => {
    const found = auditPairs(ui({}), [{ ink: "text", ground: "scrim" }]);
    expect(found).toHaveLength(1);
    expect(found[0]!.skipped).toBe("translucent-ground");
    expect(describeFinding(found[0]!)).toBe("text on scrim — not checked (translucent-ground)");
  });

  it("declines a colour it cannot read, on either side", () => {
    expect(auditPairs(ui({ bg: "color-mix(in srgb, red, blue)" }), [{ ink: "text", ground: "bg" }])[0]?.skipped).toBe(
      "unparsed",
    );
    expect(auditPairs(ui({ text: "canvastext" }), [{ ink: "text", ground: "bg" }])[0]?.skipped).toBe("unparsed");
  });

  it("names the tokens the way the stylesheet does", () => {
    const found = auditPairs(ui({ onAccent: "#a6e3a2" }), [{ ink: "onAccent", ground: "accent" }]);
    expect(describeFinding(found[0]!)).toStartWith("on-accent on accent ");
  });
});
