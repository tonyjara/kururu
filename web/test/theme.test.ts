/**
 * That the stylesheet, the themes and the skins are talking about the same
 * tokens.
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
 *
 * Skins are held to the same two checks, by the same seam and for a sharper
 * reason. A colour that falls back is a colour in the right general family; a
 * *radius* that falls back is 6px in a skin whose entire premise is that there
 * are no curves, and it is 6px only on the one rule that was renamed, so what
 * you get is a window that is almost eight-bit with one rounded corner in it.
 * That reads as a rendering glitch rather than as a missing token, which is
 * exactly the kind of bug that gets lived with rather than reported.
 *
 * And then a third question, at the foot of the file, which the two above can
 * both answer yes to while the window is unreadable: every token is spelled
 * right, every rule is asking for one, and the label is dark grey on dark grey.
 * `shared/contrast.ts` is the arithmetic and the argument; what is down there is
 * the sweep — every pair the stylesheet states, against every theme, against a
 * recorded list of what is already under its floor. It found three in Latte.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_THEME_ID, THEMES, themeFor, type UiTokens } from "../../shared/theme";
import { DEFAULT_SKIN_ID, ICON_NAMES, partVars, SKINS, skinFor } from "../../shared/skin";
import { auditPairs, describeFinding, type Pair } from "../../shared/contrast";

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
 *
 * `--ui` is in here rather than being simply excluded, and is now answered by a
 * *skin* instead: the chrome's typeface turned out to be exactly a question of
 * shape rather than of colour, which is the split `shared/skin.ts` is about.
 * `--mono` stays nobody's, on the reasoning written beside it in the stylesheet.
 */
const NOT_THEME = new Set([
  // An icon's drawing, and the two names a rule hands it on by. Written by
  // `web/src/icons.ts` once at load and by no theme or skin: a skin may swap an
  // icon for a glyph, which is `--icon-<name>`, but it never gets to supply the
  // vector — that would be a stranger's SVG in a data URI on the root element.
  ...ICON_NAMES.map((name) => `--icon-${name}-svg`),
  "--icon-svg",
  "--icon-glyph",
  // Which cell of an icon strip this icon is, set per class in the stylesheet
  // in `ICON_NAMES` order, and how many cells there are. Constants of the
  // stylesheet, like `--bar-h`; a skin brings the strip and never the count.
  "--icon-i",
  "--icon-n",
  "--ui",
  "--mono",
  "--status-size",
  "--cell",
  "--tag",
  "--ring",
  // How wide the sidebar has been dragged. A view state this browser holds and
  // `App.tsx` writes onto the root element — a length, not a colour and not a
  // shape, and nothing a theme or a skin has any business having an opinion on.
  "--sidebar-w",
  // How much of the window an on-screen keyboard has taken, written onto the
  // root by `useKeyboardInset`. A length the browser reports, like `--sidebar-w`
  // and for the same reason: not a colour, not a shape, nobody's to theme.
  "--keyboard",
  // The height of the window's bottom edge, which the status bar and the
  // sidebar's foot both have to be. A constant the stylesheet declares for
  // itself: it exists so those two cannot drift apart, and there is nothing in
  // it for a theme to have an opinion about or for a skin to disagree with.
  "--bar-h",
  // How far the reader's type has been zoomed on this device, written onto the
  // root by `web/src/zoom.ts`. A *multiplier* rather than a size, which is what
  // keeps it out of both lists: it is applied to `--fs-lg`, so the skin still
  // owns the step and this only says how many times it. Per browser, on the
  // reasoning `--sidebar-w` sets out.
  "--reader-zoom",
  // The tab strip's ground, which is a colour and still nobody's to fill in: it
  // is *derived* from `--chrome` and `--bg` rather than picked, so it follows a
  // palette that has never heard of it. A theme answering for it directly would
  // be a theme that could put the strip anywhere in the window's tonal range,
  // including on the wrong side of the two surfaces it is meant to sit between.
  "--strip",
]);

/**
 * What a skin fills in: its tokens, one per icon it may override, the three
 * per part it may paint, and the icon strip.
 */
const SKIN_TOKENS = new Set([
  ...Object.keys(SKINS[0]!.tokens).map(cssName),
  ...ICON_NAMES.map((name) => `--icon-${name}`),
  ...Object.keys(partVars(SKINS[0]!.parts)),
  "--icon-sheet",
]);

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
    const orphans = [...asked].filter(
      (name) => !answered.has(name) && !SKIN_TOKENS.has(name) && !NOT_THEME.has(name),
    );
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
   * The same two checks a theme gets, for the other axis. The second one is
   * what would have caught `--ui` moving from the theme's side to the skin's
   * with nothing declaring it in between.
   */
  it("has a skin token behind every shape the stylesheet asks for, and a rule for every one a skin fills in", () => {
    const unused = [...SKIN_TOKENS].filter((name) => !asked.has(name));
    expect(unused).toEqual([]);
  });

  it("declares a default for every skin token in :root", () => {
    const root = rootBlock();
    expect([...SKIN_TOKENS].filter((name) => !root.has(name))).toEqual([]);
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
   * And that those defaults are the *default skin*, exactly as the theme check
   * above does and for a slightly worse failure: a `:root` a version behind on
   * shape is a first paint at the old border weight, which reflows every pane
   * the moment the snapshot lands — and a reflow is a new proposed grid, so the
   * drift costs every agent in the window a SIGWINCH rather than a wrong colour.
   *
   * The icons are compared through the quoting `web/src/skin.ts` applies, since
   * a `content` value is a *quoted* string and the token is the bare glyph.
   */
  it("holds exactly the default skin in :root", () => {
    const declared = rootBlock();
    const skin = skinFor(DEFAULT_SKIN_ID);
    for (const [token, value] of Object.entries(skin.tokens)) {
      const name = cssName(token);
      expect(`${name}: ${declared.get(name)}`).toBe(`${name}: ${value}`);
    }
    for (const name of ICON_NAMES) {
      expect(`--icon-${name}: ${declared.get(`--icon-${name}`)}`).toBe(
        `--icon-${name}: "${skin.icons[name]}"`,
      );
    }
    /**
     * And the parts, which is the check that matters most here: a `:root`
     * default of `none` where `partVars` says `var(--p-pane-frame)` is a
     * focused pane that loses its bezel for the frame before the snapshot
     * lands and gets it back after, which is a flash of the wrong frame on
     * every reload.
     */
    for (const [name, value] of Object.entries(partVars(skin.parts))) {
      expect(`${name}: ${declared.get(name)}`).toBe(`${name}: ${value}`);
    }
    expect(declared.get("--icon-sheet")).toBe("none");
  });

  /**
   * The strip is cut by a count the stylesheet states and the skin format
   * defines, and the two are held together by nothing but this. An icon added
   * to `ICON_NAMES` without this moving puts every cell one place off.
   */
  it("cuts an icon strip into exactly as many cells as there are icons, in their order", () => {
    expect(rootBlock().get("--icon-n")).toBe(String(ICON_NAMES.length));
    for (const [i, name] of ICON_NAMES.entries()) {
      expect(css).toContain(`.icon-${name} { --icon-svg: var(--icon-${name}-svg); --icon-glyph: var(--icon-${name}); --icon-i: ${i}; }`);
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

// ---------------------------------------------------------------------------
// And that a theme can be read
// ---------------------------------------------------------------------------

/**
 * Every pair of tokens the stylesheet draws on top of each other, as it states
 * them.
 *
 * A rule that names both a `color` and a `background` has written down a pair,
 * and that is the only place in kururu where a pair is written down at all: the
 * other 167 rules that name a colour inherit their ground from whatever they sit
 * inside, which needs the cascade and therefore a live window. So this sees
 * about a third of the window, and every pair it does see is exact.
 *
 * Extracted rather than listed here for the reason the whole file exists — a
 * hand-kept list of pairs is one more thing kept in step with the stylesheet by
 * hand, and this file is the evidence that those drift. A token renamed out of
 * existence silently drops its pairs from the sweep, which would be a hole if
 * the orphan check above did not already fail on exactly that.
 */
function statedPairs(): Pair[] {
  const byCss = new Map(
    Object.keys(THEMES[0]!.ui).map((t) => [cssName(t), t as keyof UiTokens]),
  );
  const pairs: Pair[] = [];
  const seen = new Set<string>();
  for (const [, , body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    // Anchored the way the stray-hex check is: this stylesheet writes short
    // rules on one line, so a declaration is found after a `{` or a `;` as
    // readily as at the start of one.
    const ink = /(?:^|[;{\s])color:\s*var\((--[a-z0-9-]+)\)/.exec(body!);
    const ground = /background(?:-color)?:\s*var\((--[a-z0-9-]+)\)/.exec(body!);
    if (!ink || !ground) continue;
    const a = byCss.get(ink[1]!);
    const b = byCss.get(ground[1]!);
    // A skin token or `--strip` on either side: not a colour any theme answers
    // for, so not a pair a theme can be judged on.
    if (!a || !b) continue;
    const key = `${a}|${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ ink: a, ground: b });
  }
  return pairs;
}

/**
 * The pairs that are under their floor today, per theme, with the ratio each one
 * had when it was written down.
 *
 * **This is a record of the shipped state, not an approval of it.** Every line
 * is a place where a label is harder to read than it should be, and Latte owning
 * ten of them is the finding rather than the noise — a light theme built by
 * inverting a dark one is exactly where "on a bright fill" stops meaning what it
 * meant, which is why `onAccent` is 2.31:1 on its `blocked` badge.
 *
 * The recorded number is what makes this a ratchet rather than a blanket. A pair
 * that slips *further* under fails, so a palette cannot degrade under cover of
 * its own exemption; and a pair that climbs back over its floor fails as a stale
 * line, so fixing one forces it out of here rather than leaving a note about a
 * bug that no longer exists.
 */
const CONTRAST_KNOWN: Record<string, Record<string, number>> = {
  "catppuccin-mocha": {
    "danger on line": 3.94,
  },
  "catppuccin-macchiato": {
    "danger on line": 3.36,
  },
  "catppuccin-frappe": {
    "danger on chrome-high": 3.57,
    "danger on line": 2.7,
    "dim on chrome-high": 4.26,
    "dimmer on bg": 2.87,
  },
  "catppuccin-latte": {
    "danger on chrome-high": 3.52,
    "on-accent on accent": 2.96,
    "danger on line": 2.99,
    "text on line": 4.39,
    "dim on chrome": 4.06,
    "on-accent on blocked": 2.31,
    "on-accent on done": 4.34,
    "dim on chrome-high": 3.2,
    "dim on bg": 4.37,
    "dimmer on bg": 2.3,
  },
  kururu: {
    "dim on chrome-high": 4.34,
    "dimmer on bg": 2.88,
  },
};

describe("whether a theme can be read", () => {
  const pairs = statedPairs();

  /**
   * That there are pairs at all. If the extraction above ever stops matching —
   * a formatter that puts every declaration on its own line differently, a
   * rewrite of the stylesheet — every theme below would pass with nothing
   * checked, which is the one way this whole block could fail silently.
   */
  it("finds the pairs the stylesheet states", () => {
    expect(pairs.length).toBeGreaterThan(12);
    expect(pairs).toContainEqual({ ink: "onAccent", ground: "accent" });
    expect(pairs).toContainEqual({ ink: "text", ground: "bg" });
  });

  /**
   * A translucent ground cannot be judged against two colours and a ratio, and
   * this asserts none of the stated pairs has one — so the skip path stays a
   * safeguard rather than a quiet way for a pair to leave the sweep.
   */
  it("judges every pair it found", () => {
    for (const theme of THEMES) {
      const skipped = auditPairs(theme.ui, pairs).filter((f) => f.skipped);
      expect(skipped.map((f) => `${theme.id}: ${describeFinding(f)}`)).toEqual([]);
    }
  });

  for (const theme of THEMES) {
    it(`has nothing newly unreadable in ${theme.id}`, () => {
      const known = CONTRAST_KNOWN[theme.id] ?? {};
      const found = new Map(
        auditPairs(theme.ui, pairs).map((f) => [describeFinding(f).split(" ").slice(0, 3).join(" "), f]),
      );

      // Something under its floor that nobody wrote down, or that has slid
      // further under than the number beside it. A hundredth of slack, because
      // the recorded numbers are rounded to two places.
      const news: string[] = [];
      for (const [where, f] of found) {
        const was = known[where];
        if (was === undefined) news.push(`${describeFinding(f)} — new`);
        else if (f.ratio! < was - 0.005) news.push(`${describeFinding(f)} — was ${was}`);
      }
      expect(news).toEqual([]);

      // And a line here for a pair that now passes: the fix landed and the note
      // about it did not.
      const stale = Object.keys(known).filter((where) => !found.has(where));
      expect(stale.map((where) => `${where} — fixed, drop it from CONTRAST_KNOWN`)).toEqual([]);
    });
  }
});
