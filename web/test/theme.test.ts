/**
 * That the stylesheet and the themes are talking about the same tokens.
 *
 * This is the seam the whole theming design rests on and it is held together by
 * a string: `styles.css` asks for `var(--chrome-high)` and `web/src/theme.ts`
 * writes `--chrome-high` by camel-case-splitting a key called `chromeHigh`.
 * Nothing in TypeScript connects those two, so renaming a token on either side
 * typechecks perfectly and shows up as one colour in the window quietly falling
 * back to whatever the `:root` block happened to say — which is a *plausible*
 * colour, from the default theme, in the right general family. That is the worst
 * kind of bug to find by looking: it is invisible in Mocha, which is the default,
 * and obvious only in Latte, which is the one nobody is using.
 *
 * So both directions are checked. A token the CSS asks for that no theme
 * answers is a rule stuck on the fallback; a token every theme answers that no
 * rule asks for is dead weight that the next person will keep filling in for
 * five themes. Neither is catastrophic on its own, which is exactly why neither
 * gets noticed.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_THEME_ID, THEMES, themeFor } from "../../shared/theme";

const css = readFileSync(join(import.meta.dir, "../src/styles.css"), "utf8");

/**
 * The same camel-to-kebab step `web/src/theme.ts` does. Duplicated rather than
 * imported because importing it means importing the module, which reaches for
 * `document` and the terminal pool; this is four characters of regex and the
 * test's whole job is to notice if the two ever disagree about the answer.
 */
function cssName(token: string): string {
  return `--${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/**
 * Tokens the stylesheet legitimately uses that no theme sets.
 *
 * Two kinds, and both are deliberate. The fonts are not a colour and not part of
 * a palette — a theme that could change the UI typeface would be a theme that
 * could make the window unreadable. The rest are set per element by the
 * component that draws them: a cell size being dragged in the mascot picker, a
 * status badge that is 16px in a row and 64px in a preview, a workspace tag, and
 * the accent a single theme card wears while it is being offered.
 */
const NOT_THEME = new Set(["--ui", "--mono", "--status-size", "--cell", "--tag", "--ring"]);

const asked = new Set(Array.from(css.matchAll(/var\((--[a-z0-9-]+)/g), (m) => m[1]!));

/** The `:root` declarations, as name → value. */
function rootBlock(): Map<string, string> {
  const start = css.indexOf(":root {");
  const root = css.slice(start, css.indexOf("}", start));
  return new Map(
    Array.from(root.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm), (m) => [m[1]!, m[2]!.trim()]),
  );
}
const answered = new Set(Object.keys(THEMES[0]!.ui).map(cssName));

describe("the stylesheet and the themes", () => {
  it("has a theme token behind every colour the stylesheet asks for", () => {
    const orphans = [...asked].filter((name) => !answered.has(name) && !NOT_THEME.has(name));
    expect(orphans).toEqual([]);
  });

  it("has a rule for every token the themes fill in", () => {
    const unused = [...answered].filter((name) => !asked.has(name));
    expect(unused).toEqual([]);
  });

  /**
   * The `:root` block is what is on screen between this stylesheet painting and
   * the first snapshot arriving, so a token missing a default is a flash of
   * nothing in the frame before the theme lands — and, on a window that never
   * reaches a server, permanently.
   */
  it("declares a default for every token in :root", () => {
    expect([...answered].filter((name) => !rootBlock().has(name))).toEqual([]);
  });

  /**
   * And that those defaults are the *default theme*, value for value.
   *
   * The `:root` block is hand-written and `THEMES` is not, so the two can drift
   * in the one direction nobody would look: a theme tweaked in `shared/theme.ts`
   * leaves the stylesheet a version behind, and what that buys is a first paint
   * in last week's Mocha before the snapshot lands and corrects it. A flash of
   * almost-the-right-colour is not something anybody reports, and not something
   * anybody finds by looking either.
   */
  it("holds exactly the default theme in :root, so the first paint is not a flash of the wrong one", () => {
    const declared = rootBlock();
    const want = themeFor(DEFAULT_THEME_ID).ui;
    for (const [token, value] of Object.entries(want)) {
      const name = cssName(token);
      expect(`${name}: ${declared.get(name)}`).toBe(`${name}: ${value}`);
    }
  });

  /**
   * A hex left behind is a rule that stays one colour while the window changes
   * around it, which is the bug this whole sweep existed to remove. The QR code
   * is the one exception and says so where it is written: a dark-themed QR with
   * a dark quiet zone is one a scanner cannot find the edges of.
   */
  it("has no colour left hardcoded outside :root, except the QR code's quiet zone", () => {
    const body = css.slice(css.indexOf("* {"));
    /**
     * Every declaration, wherever it sits. Deliberately not anchored to the
     * start of a line: this stylesheet writes short rules on one line
     * (`.md em { color: var(--text); }`), and a check that only read
     * line-leading declarations would pass while missing exactly those — which
     * it did, on the first version of this test.
     */
    const strays = Array.from(body.matchAll(/(?:^|[{;])\s*([a-z-]+)\s*:\s*([^;}]+)/gm))
      .filter(([, prop]) => /color|background|shadow|border|fill|stroke/.test(prop!))
      .map(([, , value]) => value!.trim())
      .filter((value) => /#[0-9a-f]{3,8}\b|rgba?\(|\bhsla?\(/i.test(value))
      // The QR code's quiet zone, which says where it is written why it is not a
      // token: a dark-themed code with a dark border is one a scanner cannot
      // find the edges of.
      .filter((value) => value !== "#fff");
    expect(strays).toEqual([]);
  });
});
