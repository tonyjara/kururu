/**
 * The theme table and what it does with a config it does not like.
 *
 * Two things are worth a test here and neither is a colour. The first is that
 * every theme answers for every token: `UiTokens` makes that a type error at
 * home, but a theme is also the thing somebody adds in a hurry, and a `""` left
 * in a field typechecks perfectly and paints nothing. The second is the adopter,
 * which is the only code in kururu that sees a font size before it becomes a
 * grid a pty is resized to — `adoptAppearance` is what stands between a number
 * typed into a box on a phone and a SIGWINCH into every agent on the machine.
 *
 * The first is also, incidentally, the light-theme test. Latte was shipped
 * partly to find the tokens that had been hardcoded to a near-black on the
 * assumption that there would only ever be dark ones, and a token it left blank
 * is exactly that bug coming back.
 */
import { describe, expect, it } from "bun:test";
import {
  adoptAppearance,
  DEFAULT_APPEARANCE,
  DEFAULT_THEME_ID,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  themeFor,
  THEMES,
} from "../../shared/theme";

describe("the themes", () => {
  it("ships Catppuccin Mocha as the default", () => {
    expect(themeFor(DEFAULT_THEME_ID).id).toBe("catppuccin-mocha");
    expect(DEFAULT_APPEARANCE.themeId).toBe("catppuccin-mocha");
  });

  it("has no two themes sharing an id", () => {
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
  });

  /**
   * Every value, not merely every key. A token left at `""` satisfies the type
   * and leaves whatever the `:root` fallback said on screen, which reads as the
   * theme half-applying rather than as a field nobody filled in.
   */
  it("answers for every token in every theme, in something that is a colour", () => {
    const colour = /^(#[0-9a-f]{6}|rgba?\()/i;
    for (const theme of THEMES) {
      const tokens = { ...theme.ui, ...theme.terminal, ...theme.workspace };
      for (const [name, value] of Object.entries(tokens)) {
        expect(`${theme.id}.${name} = ${value}`).toBe(
          `${theme.id}.${name} = ${colour.test(value) ? value : "NOT A COLOUR"}`,
        );
      }
    }
  });

  /**
   * `colors.ts` has said since it was written that the first two tags are the
   * accent and the done colour exactly, so that tagging a workspace never
   * introduces a colour the window did not already have. It was true by
   * coincidence of one hand-written palette; with five it needs saying.
   */
  it("keeps the first two workspace tags identical to the accent and the done mark", () => {
    for (const theme of THEMES) {
      expect([theme.id, theme.workspace.green, theme.workspace.blue]).toEqual([
        theme.id,
        theme.ui.accent,
        theme.ui.done,
      ]);
    }
  });

  it("gives the pane ground and the terminal background the same value, so a pane is one surface", () => {
    for (const theme of THEMES) {
      expect([theme.id, theme.ui.bg]).toEqual([theme.id, theme.terminal.background]);
    }
  });

  /** A downgrade — a config naming a flavour this version does not have — draws the default. */
  it("falls back rather than refusing an id it does not know", () => {
    expect(themeFor("catppuccin-espresso").id).toBe(DEFAULT_THEME_ID);
    expect(themeFor(null).id).toBe(DEFAULT_THEME_ID);
    expect(themeFor(undefined).id).toBe(DEFAULT_THEME_ID);
  });
});

describe("adoptAppearance", () => {
  it("reads back what it wrote", () => {
    expect(adoptAppearance(DEFAULT_APPEARANCE)).toEqual(DEFAULT_APPEARANCE);
  });

  it("treats a missing, unreadable or empty config as nothing saved", () => {
    expect(adoptAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(adoptAppearance({})).toEqual(DEFAULT_APPEARANCE);
    expect(adoptAppearance("catppuccin-mocha")).toEqual(DEFAULT_APPEARANCE);
  });

  /**
   * The one that matters. A font size decides the cell, the cell decides the
   * grid a pane proposes, and the smallest proposal is what every pty watching
   * gets resized to — so a `0` here is not a bad setting, it is a proposal of
   * some enormous number of columns and a SIGWINCH into everybody's work.
   */
  it("clamps a font size rather than believing it", () => {
    expect(adoptAppearance({ terminal: { fontSize: 0 } }).terminal.fontSize).toBe(MIN_FONT_SIZE);
    expect(adoptAppearance({ terminal: { fontSize: -40 } }).terminal.fontSize).toBe(MIN_FONT_SIZE);
    expect(adoptAppearance({ terminal: { fontSize: 9999 } }).terminal.fontSize).toBe(MAX_FONT_SIZE);
    expect(adoptAppearance({ terminal: { fontSize: 13.6 } }).terminal.fontSize).toBe(14);
    expect(adoptAppearance({ terminal: { fontSize: Number.NaN } }).terminal.fontSize).toBe(
      DEFAULT_APPEARANCE.terminal.fontSize,
    );
    expect(adoptAppearance({ terminal: { fontSize: "14" } }).terminal.fontSize).toBe(
      DEFAULT_APPEARANCE.terminal.fontSize,
    );
  });

  /** A number bends to the nearest legal value; a name has no nearest and falls back. */
  it("falls back on a cursor style that is not one", () => {
    expect(adoptAppearance({ terminal: { cursorStyle: "bar" } }).terminal.cursorStyle).toBe("bar");
    expect(adoptAppearance({ terminal: { cursorStyle: "beam" } }).terminal.cursorStyle).toBe("block");
    expect(adoptAppearance({ terminal: { cursorStyle: 3 } }).terminal.cursorStyle).toBe("block");
  });

  /**
   * The font name is the one free string in the whole of Settings and it ends up
   * in a CSS `font-family` declaration — on an app that is reachable from the
   * tailnet. `;` and `}` are what could close that declaration and open a rule
   * of somebody else's choosing; the quotes are what could end the quoting the
   * name is wrapped in on the way out.
   */
  it("strips what could break out of the declaration a font name lands in", () => {
    const hostile = adoptAppearance({
      terminal: { fontFamily: 'Menlo"; } body { display: none } .x {' },
    }).terminal.fontFamily;
    expect(hostile).not.toContain(";");
    expect(hostile).not.toContain("}");
    expect(hostile).not.toContain('"');
    expect(hostile).not.toContain("'");
  });

  it("keeps an ordinary font name intact", () => {
    expect(adoptAppearance({ terminal: { fontFamily: "  Berkeley Mono  " } }).terminal.fontFamily).toBe(
      "Berkeley Mono",
    );
    expect(adoptAppearance({ terminal: { fontFamily: 42 } }).terminal.fontFamily).toBe("");
  });

  it("refuses a theme id it does not know, on the way in from a file or a client", () => {
    expect(adoptAppearance({ themeId: "../../etc/passwd" }).themeId).toBe(DEFAULT_THEME_ID);
    expect(adoptAppearance({ themeId: "catppuccin-latte" }).themeId).toBe("catppuccin-latte");
  });
});
