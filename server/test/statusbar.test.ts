/**
 * Settings → Bottom bar: which chips are drawn.
 *
 * What is kept is the list switched off, so the cases that matter are the two
 * a file meets across versions — a chip added later, which must be shown to a
 * file that has never heard of it, and a name this version does not know,
 * which must hide nothing — and the one a phone can send, which is anything.
 */
import { describe, expect, it } from "bun:test";
import { adoptBar, BAR_ITEMS, barShows, DEFAULT_BAR, withBarItem } from "../../shared/statusbar";
import { adoptAppearance, DEFAULT_APPEARANCE } from "../../shared/theme";

describe("the bar's switches", () => {
  it("shows everything by default", () => {
    for (const item of BAR_ITEMS) expect(barShows(DEFAULT_BAR, item.id)).toBe(true);
  });

  it("shows everything to a snapshot from a server that has no switches", () => {
    expect(barShows(undefined, "load")).toBe(true);
  });

  it("names every chip once", () => {
    const ids = BAR_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("hides only what was switched off", () => {
    const bar = withBarItem(DEFAULT_BAR, "load", false);
    expect(bar).toEqual({ hidden: ["load"] });
    expect(barShows(bar, "load")).toBe(false);
    expect(barShows(bar, "machines")).toBe(true);
    expect(barShows(bar, "agents")).toBe(true);
  });

  it("brings a chip back, and switching one twice is the same as once", () => {
    const off = withBarItem(withBarItem(DEFAULT_BAR, "codex", false), "codex", false);
    expect(off).toEqual({ hidden: ["codex"] });
    expect(withBarItem(off, "codex", true)).toEqual(DEFAULT_BAR);
  });

  it("keeps the hidden ones in bar order, whatever order they were pressed in", () => {
    const bar = withBarItem(withBarItem(withBarItem(DEFAULT_BAR, "agents", false), "claude", false), "load", false);
    expect(bar.hidden).toEqual(["claude", "load", "agents"]);
  });
});

describe("adoptBar", () => {
  it("treats a missing or malformed value as everything shown", () => {
    for (const raw of [undefined, null, 7, "load", [], {}, { hidden: "load" }, { hidden: null }]) {
      expect(adoptBar(raw)).toEqual(DEFAULT_BAR);
    }
  });

  it("drops names it does not know and anything that is not a name", () => {
    expect(adoptBar({ hidden: ["load", "credit", 3, null, { id: "agents" }, "load"] })).toEqual({ hidden: ["load"] });
  });
});

describe("the bar in appearance.json", () => {
  it("is read back as written", () => {
    const saved = { ...DEFAULT_APPEARANCE, bar: { hidden: ["load" as const] } };
    expect(adoptAppearance(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
  });

  it("is everything shown in a file from before it", () => {
    const { bar: _bar, ...older } = DEFAULT_APPEARANCE;
    expect(adoptAppearance(older).bar).toEqual(DEFAULT_BAR);
  });

  /** A file from before the one look names a theme and a skin; they are dropped and the rest is kept. */
  it("drops a theme and a skin an older file names, and keeps the bar", () => {
    const older = { ...DEFAULT_APPEARANCE, themeId: "dracula", skinId: "soft", bar: { hidden: ["load"] } };
    expect(adoptAppearance(older)).toEqual({ ...DEFAULT_APPEARANCE, bar: { hidden: ["load"] } });
  });
});
