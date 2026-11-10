/**
 * The interface's face and size: what `appearance.json` and a client's
 * message are made into, and the number the stylesheet is handed.
 *
 * The size is the one that matters. It scales every length of type and every
 * icon in the window, so a value nothing checked would be a sidebar set in
 * type too small to read or a strip of tabs taller than its pane.
 */
import { describe, expect, it } from "bun:test";
import {
  adoptAppearance,
  DEFAULT_APPEARANCE,
  DEFAULT_UI_FONT_SIZE,
  interfaceOf,
  interfaceScale,
  MAX_UI_FONT_SIZE,
  MIN_UI_FONT_SIZE,
} from "../../shared/theme";

describe("the interface's type in appearance.json", () => {
  it("is the system's face at 13px until somebody says otherwise", () => {
    expect(DEFAULT_APPEARANCE.ui).toEqual({ fontFamily: "", fontSize: 13 });
    expect(DEFAULT_UI_FONT_SIZE).toBe(13);
  });

  it("is read back as written", () => {
    const saved = { ...DEFAULT_APPEARANCE, ui: { fontFamily: "Avenir Next", fontSize: 15 } };
    expect(adoptAppearance(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
  });

  it("is the default in a file from before it, with the rest kept", () => {
    const { ui: _ui, ...older } = { ...DEFAULT_APPEARANCE, terminal: { ...DEFAULT_APPEARANCE.terminal, fontSize: 14 } };
    const adopted = adoptAppearance(older);
    expect(adopted.ui).toEqual(DEFAULT_APPEARANCE.ui);
    expect(adopted.terminal.fontSize).toBe(14);
  });

  it("holds a size to the range a layout survives", () => {
    const sized = (fontSize: unknown) => adoptAppearance({ ui: { fontSize } }).ui.fontSize;
    expect(sized(4)).toBe(MIN_UI_FONT_SIZE);
    expect(sized(400)).toBe(MAX_UI_FONT_SIZE);
    expect(sized(14.4)).toBe(14);
    expect(sized(MIN_UI_FONT_SIZE)).toBe(MIN_UI_FONT_SIZE);
    expect(sized(MAX_UI_FONT_SIZE)).toBe(MAX_UI_FONT_SIZE);
  });

  /** NaN loses every comparison it is in, so a clamp alone would let it through. */
  it("reads a size that is not a number as the default", () => {
    for (const fontSize of [Number.NaN, Number.POSITIVE_INFINITY, "15", null, undefined, {}])
      expect(adoptAppearance({ ui: { fontSize } }).ui.fontSize).toBe(DEFAULT_UI_FONT_SIZE);
  });

  /** The name ends up in a `font-family` on the root. */
  it("strips what could end a declaration from a face's name", () => {
    expect(adoptAppearance({ ui: { fontFamily: `Inter"; } body { display: none` } }).ui.fontFamily).toBe("Inter  body { display: none");
    expect(adoptAppearance({ ui: { fontFamily: "  IBM Plex Sans  " } }).ui.fontFamily).toBe("IBM Plex Sans");
    expect(adoptAppearance({ ui: { fontFamily: 12 } }).ui.fontFamily).toBe("");
    expect(adoptAppearance({ ui: { fontFamily: "x".repeat(500) } }).ui.fontFamily.length).toBe(120);
  });

  it("leaves the terminal and the bar alone when only the interface changes", () => {
    const before = adoptAppearance({ terminal: { fontFamily: "Berkeley Mono", fontSize: 14, cursorStyle: "bar", cursorBlink: false }, bar: { hidden: ["load"] } });
    const after = adoptAppearance({ ...before, ui: { fontFamily: "Inter", fontSize: 16 } });
    expect(after.terminal).toEqual(before.terminal);
    expect(after.bar).toEqual(before.bar);
    expect(after.ui).toEqual({ fontFamily: "Inter", fontSize: 16 });
  });
});

describe("the interface's type on a page", () => {
  it("is the default for a snapshot from a server that has none", () => {
    expect(interfaceOf({ terminal: DEFAULT_APPEARANCE.terminal })).toEqual(DEFAULT_APPEARANCE.ui);
    expect(interfaceOf(null)).toEqual(DEFAULT_APPEARANCE.ui);
    expect(interfaceOf(undefined)).toEqual(DEFAULT_APPEARANCE.ui);
  });

  it("is a scale of one at the size the stylesheet was written at", () => {
    expect(interfaceScale(DEFAULT_APPEARANCE.ui)).toBe(1);
  });

  it("scales by the size over the default, to a thousandth", () => {
    expect(interfaceScale({ fontFamily: "", fontSize: 16 })).toBe(1.231);
    expect(interfaceScale({ fontFamily: "", fontSize: 11 })).toBe(0.846);
    expect(interfaceScale({ fontFamily: "", fontSize: 18 })).toBe(1.385);
  });

  /** A size that reached a page unadopted still cannot leave the range. */
  it("never scales past the range, whatever it is handed", () => {
    expect(interfaceScale({ fontFamily: "", fontSize: 900 })).toBe(interfaceScale({ fontFamily: "", fontSize: MAX_UI_FONT_SIZE }));
    expect(interfaceScale({ fontFamily: "", fontSize: Number.NaN })).toBe(1);
  });
});
