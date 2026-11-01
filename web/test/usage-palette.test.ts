/**
 * That a chart's colours can be told apart, on every theme kururu ships, in both
 * appearances, before anybody has to look.
 *
 * The first describe holds the arithmetic to the data-viz method's own published
 * figures for its reference palette, so that a slip in the OKLab or the colour
 * blindness matrices cannot make every check below pass quietly. The rest ask the
 * pairs a stack can really put side by side: Kuru at its foot, the slots in their
 * fixed order, the quiet colour on top.
 */
import { describe, expect, it } from "bun:test";
import { checkPalette, chartTokens, restInk, contrast, CONTRAST_MARK, CVD_FLOOR, CVD_TARGET, deltaE, kuruInk, lightnessChroma, LIGHTNESS_BAND, NORMAL_FLOOR, SERIES, SERIES_SLOTS } from "../../shared/chartcolor";
import { THEMES } from "../../shared/theme";

describe("the arithmetic", () => {
  const LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
  const DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];

  it("reproduces the figures the method publishes for its reference palette", () => {
    const light = checkPalette(LIGHT, "light", "#fcfcfb");
    expect(light.worstCvd).toBeCloseTo(9.1, 1);
    expect(light.worstNormal).toBeCloseTo(19.6, 1);
    const dark = checkPalette(DARK, "dark", "#1a1a19");
    expect(dark.worstCvd).toBeCloseTo(8.4, 1);
    expect(dark.worstNormal).toBeCloseTo(19.3, 1);
  });

  it("fails what it should", () => {
    const pale = checkPalette(["#f5e0dc", "#f2cdcd"], "dark", "#1e1e2e");
    expect(pale.ok).toBe(false);
    expect(pale.offBand.length).toBe(2);
    expect(pale.grey.length).toBe(2);
    expect(deltaE("#ffffff", "#ffffff")).toBe(0);
    expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 5);
  });
});

for (const theme of THEMES) {
  describe(theme.id, () => {
    const appearance = theme.appearance;
    const kuru = kuruInk(theme.ui.accent, appearance)!;
    const series = SERIES[appearance];

    for (const [name, surface] of [
      ["chrome, which a chart's card is", theme.ui.chrome],
      ["bg, which the page is", theme.ui.bg],
    ] as const) {
      it(`Kuru and the slots pass in order on ${name}`, () => {
        const report = checkPalette([kuru, ...series], appearance, surface);
        expect(report.offBand).toEqual([]);
        expect(report.grey).toEqual([]);
        expect(report.worstCvd).toBeGreaterThanOrEqual(CVD_TARGET);
        expect(report.worstNormal).toBeGreaterThanOrEqual(NORMAL_FLOOR);
        expect(report.ok).toBe(true);
      });
    }

    it("has a real second channel wherever a mark is under 3:1", () => {
      // A warn, not a failure: every chart has a legend, a 2px gap and a table.
      // Dark themes have no such mark at all, and the list for Latte is pinned so
      // that a change of palette is a decision.
      const low = [kuru, ...series].filter((colour) => contrast(colour, theme.ui.chrome) < CONTRAST_MARK);
      if (appearance === "dark") expect(low).toEqual([]);
      else expect(low.length).toBeLessThanOrEqual(5);
    });

    it("keeps the accent's hue for Kuru, inside the band", () => {
      const read = lightnessChroma(kuru)!;
      const [low, high] = LIGHTNESS_BAND[appearance];
      expect(read.lightness).toBeGreaterThanOrEqual(low);
      expect(read.lightness).toBeLessThanOrEqual(high);
      const hue = (hex: string) => {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return { greenest: g >= r && g >= b };
      };
      // Every built-in accent is a green, and a chart must not make it something else.
      expect(hue(kuru).greenest).toBe(hue(theme.ui.accent).greenest);
    });

    it("sets the quiet colour apart from Kuru, and from the slot it can sit on", () => {
      const rest = restInk(theme.ui, kuru);
      expect(deltaE(kuru, rest)).toBeGreaterThanOrEqual(NORMAL_FLOOR);
      expect(Math.min(deltaE(kuru, rest, "protan"), deltaE(kuru, rest, "deutan"))).toBeGreaterThanOrEqual(CVD_TARGET);
      const top = series[series.length - 1]!;
      expect(deltaE(top, rest)).toBeGreaterThanOrEqual(NORMAL_FLOOR);
      expect(Math.min(deltaE(top, rest, "protan"), deltaE(top, rest, "deutan"))).toBeGreaterThanOrEqual(CVD_FLOOR);
    });

    it("can see the quiet colour on its surface and writes every token", () => {
      const tokens = chartTokens(theme);
      expect(contrast(tokens["--chart-rest"]!, theme.ui.chrome)).toBeGreaterThanOrEqual(CONTRAST_MARK);
      expect(tokens["--chart-kuru"]).toBe(kuru);
      for (let slot = 1; slot <= SERIES_SLOTS; slot++) {
        expect(tokens[`--chart-${slot}`]).toBe(series[slot - 1]!);
        expect(["#ffffff", "#0b0b0b"]).toContain(tokens[`--chart-${slot}-ink`]!);
      }
    });
  });
}

describe("the ink inside a block", () => {
  it("is white but on light yellow", () => {
    const ink = (appearance: "dark" | "light") => chartTokens({ appearance, ui: { accent: "#40a02b", dim: "#6c6f85", dimmer: "#9ca0b0" } });
    expect(ink("light")["--chart-2-ink"]).toBe("#0b0b0b");
    for (const slot of [1, 3, 4, 5, 6]) expect(ink("light")[`--chart-${slot}-ink`]).toBe("#ffffff");
    for (let slot = 1; slot <= SERIES_SLOTS; slot++) expect(ink("dark")[`--chart-${slot}-ink`]).toBe("#ffffff");
  });
});

describe("an accent that is not a chart's to read", () => {
  it("falls back to the first series rather than guessing", () => {
    expect(kuruInk("rgb(1, 2, 3)", "dark")).toBeNull();
    const tokens = chartTokens({ appearance: "dark", ui: { accent: "oklch(0.7 0.1 150)", dim: "#7c857f", dimmer: "#565e59" } });
    expect(tokens["--chart-kuru"]).toBe(SERIES.dark[0]!);
  });

  it("leaves one already in the band exactly as written", () => {
    expect(kuruInk("#40A02B", "light")).toBe("#40a02b");
  });
});
