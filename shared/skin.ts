/**
 * What kururu is *shaped* like: the half of its look that is not colour.
 *
 * `theme.ts` already made this argument once and won it — a flat record of named
 * tokens, picked by id, written onto the root element by one loop, with a
 * stylesheet that asks for `var(--bg)` and has no idea themes exist. This module
 * is that argument a second time about a different axis, and the axis is the
 * point: a theme answers *what colour*, a skin answers *what shape*. Radius,
 * line weight, the type ramp, whether text is antialiased, which glyph a close
 * button is, whether there are scanlines over the whole window.
 *
 * They are kept apart because they are genuinely orthogonal, and the test of it
 * is that both crossings are things somebody would want: an eight-bit chrome in
 * Catppuccin Mocha, and today's rounded chrome in an NES palette. A single
 * "look" holding both would make one of those a fork of the other. So
 * `appearance.json` grows a `skinId` beside `themeId`, neither knows about the
 * other, and the stylesheet reads both out of the same `:root`.
 *
 * **A skin is stored as an id, never as a copy of its values**, for exactly the
 * reason `theme.ts` and `keys.ts` both give: a saved record would freeze
 * kururu's tokens at the version the user first opened Settings in, and a token
 * added later would be unset forever for everybody who had ever chosen. Which is
 * also why `BASE` below is a complete answer rather than a partial one, and why
 * every other skin is written as a *difference* from it — `skin()` merges. A
 * skin that predates a token gets the base's answer for it and stays drawable,
 * which is the property that makes a registry of other people's skins survive
 * kururu growing.
 *
 * ## Why the frame is a shadow recipe and not a picture
 *
 * The obvious way to give a pane a chunky eight-bit border is `border-image`
 * with a nine-slice PNG, and it is what Winamp actually did. It is rejected here
 * for one reason: a picture carries its own colours, so a pane framed with one
 * stops following the theme — pick Latte and the frame stays dark. That would
 * make skin and theme secretly non-orthogonal, which is the whole thing this
 * split exists to avoid. So `frame` is a **box-shadow recipe written in terms of
 * theme tokens**, which composes with `--line` and `--chrome` and therefore
 * restyles when the palette does. A skin that genuinely wants a picture can ship
 * one in its own stylesheet; it is then knowingly choosing to leave the palette
 * behind, rather than doing it by accident.
 *
 * ## Why the type ramp is six tokens and not sixty-two
 *
 * There were sixty-two hardcoded `font-size` declarations in `styles.css` across
 * seven distinct values. They are now six tokens, because the thing a skin needs
 * is a *lever on the whole ramp* rather than per-element control: a pixel face
 * has an eight-pixel em and is unreadable at the size a humanist sans is
 * comfortable at, so every size in the window has to come down together or none
 * of them should. Six is the number of steps the design actually had; naming
 * more would be inventing distinctions the stylesheet never drew.
 */

/**
 * The icons the chrome draws, by the job they do rather than by what they look
 * like. `close` and not `cross`, because a skin is allowed to draw it as a
 * pixel-art `X` and the name has to survive that.
 *
 * A skin writes only the ones it means to change, and `null` in what it writes
 * says "keep the base's" — which is not the same as leaving the name out, and
 * the difference is worth the null: leaving it out is silence, writing null is a
 * skin that has *considered* this icon and decided the default was right. The
 * eight-bit skin's `restart` is exactly that case, and its comment is the
 * reasoning. After the merge every name has a glyph, so nothing downstream has
 * to carry a fallback.
 */
export type IconName = "close" | "run" | "restart" | "caret" | "add" | "edit" | "external";

export type IconSet = Record<IconName, string>;

export const ICON_NAMES: readonly IconName[] = ["close", "run", "restart", "caret", "add", "edit", "external"];

/**
 * The shape tokens, as `styles.css` asks for them.
 *
 * These are `var(--…)` names camel-cased, and `applySkin` in `web/src/skin.ts`
 * does the same one mechanical translation `applyTheme` does — the same
 * function, in fact, imported rather than written twice, because two copies of
 * "camelCase to kebab-case" is two places for the spelling of a token to drift.
 *
 * Every value is a CSS value as a string rather than a number with a unit
 * implied. A radius of `0` and a radius of `0px` are the same thing and a
 * `borderStyle` of `solid` is not a number at all, so a record that was
 * sometimes numeric would need a unit table beside it — which is a second place
 * to be wrong about what a token means.
 */
export interface SkinTokens {
  /** A tag, a kbd, a swatch — the small stuff. */
  radiusXs: string;
  /** Inputs, list rows. */
  radiusSm: string;
  /** Buttons, tabs, menu items. The one most of the window uses. */
  radiusMd: string;
  /** Buttons and rows that want a touch more than a tab. */
  radiusLg: string;
  /** Panes, dialogs, menus — the things with a frame around them. */
  radiusXl: string;
  /** Status dots and anything else that is meant to be a circle. */
  radiusRound: string;

  /** The hairline: pane borders, rules, input outlines. */
  border: string;
  /** A border that is making a point — a focus ring, a drag target. */
  borderThick: string;
  /**
   * `solid` for every skin that exists, and a token anyway. A pixel skin that
   * wants `double` for its frames should not have to ship a stylesheet to get
   * it, and the cost of asking is one line.
   */
  borderStyle: string;

  /**
   * The chrome's typeface, as a complete `font-family` value.
   *
   * Complete rather than a face to prepend, which is the opposite of what
   * `TerminalAppearance.fontFamily` does, and the difference is whose decision
   * it is. That one is a user naming a font they like and saying nothing about
   * the Nerd Font faces underneath it, so it prepends. This one is a skin
   * declaring what the window is set in — a pixel skin that merely prepended
   * would get a pixel face for latin and a humanist sans for everything it does
   * not cover, which is two fonts in one label.
   */
  ui: string;
  fsXs: string;
  fsSm: string;
  fsBase: string;
  fsMd: string;
  fsLg: string;
  fsXl: string;
  uiLineHeight: string;
  uiLetterSpacing: string;
  /**
   * `-webkit-font-smoothing`. `antialiased` everywhere except a pixel skin,
   * where the whole point is that a glyph is either on or off and a grey edge
   * pixel is the thing that gives it away as a simulation.
   */
  uiSmoothing: string;

  /**
   * An extra `box-shadow` on a pane, over and above its border. `none` for a
   * skin that wants a plain line; an inset for one that wants a frame with
   * depth in it. Written in theme tokens — see the header.
   */
  frame: string;
  /** The same, for the pane that has the keyboard. */
  frameOn: string;
  /** A dialog, lifted off the window. */
  elevDialog: string;
  /** A menu, lifted off what it is covering. Lower than a dialog, deliberately. */
  elevMenu: string;

  /**
   * `image-rendering` for sprites — the mascot, and whatever art a skin brings.
   *
   * `pixelated` in every skin as it stands, because every mascot that ships is
   * pixel art and smoothing it is simply wrong. It is a token rather than a
   * fixed rule so that a skin built around smooth vector art can turn it off
   * without a stylesheet, which is the same licence `borderStyle` gets.
   */
  imageRendering: string;

  /**
   * A background painted over the entire window by one absolutely-positioned,
   * pointer-events-none layer — scanlines, a CRT vignette, a paper grain.
   * `none` for every skin that does not want one, and the layer is not rendered
   * at all in that case rather than being rendered transparent.
   *
   * It sits *above* the panes, which means above the terminal canvases, and
   * that is the only way it could work: the emulator paints into a canvas CSS
   * cannot reach, so an effect underneath it would be invisible exactly where
   * the window is most interesting.
   */
  overlay: string;
  /** How much of the overlay is really there. A separate token so it is tunable without rewriting the gradient. */
  overlayOpacity: string;
}

export interface Skin {
  id: string;
  name: string;
  /** One line, shown in Settings under the name. What kind of window this is. */
  description: string;
  tokens: SkinTokens;
  icons: IconSet;
}

// ---------------------------------------------------------------------------
// The base
// ---------------------------------------------------------------------------

/**
 * The window kururu had before it had a choice, so that picking it changes
 * nothing.
 *
 * Every value here was already in `styles.css` — this is that file's geometry,
 * gathered, exactly the way the `KURURU` theme is its colours gathered. It is
 * also the floor every other skin is merged onto, which is what lets a skin be
 * written as the handful of things it actually changes.
 */
const BASE_TOKENS: SkinTokens = {
  /**
   * Tighter than kururu shipped at — 2/3/5/6/8 became 2/2/3/4/5 — and the
   * reason is what the radius is *for* on a window made almost entirely of
   * rectangles. A corner's job here is to say "this is a surface with an edge",
   * and past about four pixels it stops saying that and starts being a style of
   * its own: an 8px pane on a 6px gutter reads as a card floating in an
   * application, which is the opposite of a multiplexer whose whole premise is
   * that the grid *is* the interface. The tab strip was where it showed worst,
   * because a 5px radius on a row 20px tall is a quarter of its height and the
   * tab stops looking like a tab.
   *
   * It is deliberately not zero. Zero is the 8-bit skin's answer and it is a
   * *statement* — hard edges are what that chrome is about. The base is meant to
   * be the window you stop noticing, and a hairline corner is how a surface
   * admits it has an edge without drawing attention to the fact.
   */
  radiusXs: "2px",
  radiusSm: "2px",
  radiusMd: "3px",
  radiusLg: "4px",
  radiusXl: "5px",
  radiusRound: "50%",

  border: "1px",
  borderThick: "2px",
  borderStyle: "solid",

  ui: `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`,
  fsXs: "9px",
  fsSm: "10px",
  fsBase: "11px",
  fsMd: "12px",
  fsLg: "13px",
  fsXl: "15px",
  uiLineHeight: "1.4",
  uiLetterSpacing: "normal",
  uiSmoothing: "antialiased",

  frame: "none",
  frameOn: "none",
  elevDialog: "0 16px 48px var(--shadow)",
  elevMenu: "0 12px 32px var(--shadow)",

  imageRendering: "pixelated",

  overlay: "none",
  overlayOpacity: "1",
};

/** Kururu's own, and the floor every skin's icons are merged onto. */
export const BASE_ICONS: IconSet = {
  close: "✕",
  run: "▸",
  restart: "↻",
  caret: "▾",
  add: "+",
  edit: "✎",
  /** Leaves kururu — a dev server opened in the browser's own tab. */
  external: "↗",
};

/**
 * A skin, as the difference from the base.
 *
 * Partial rather than complete for the reason in the header: a skin written out
 * in full is a skin that silently keeps the base's answer to a token from the
 * version it was written in, and an eight-bit chrome that quietly reverted one
 * radius to 8px two releases later is a bug nobody would find. Writing only what
 * you mean to change also makes a skin readable as an argument — the NES one
 * below is thirty lines and every one of them is a decision.
 */
function skin(
  id: string,
  name: string,
  description: string,
  tokens: Partial<SkinTokens>,
  icons: Partial<Record<IconName, string | null>> = {},
): Skin {
  const merged = { ...BASE_ICONS };
  for (const name of ICON_NAMES) {
    const glyph = icons[name];
    if (typeof glyph === "string") merged[name] = glyph;
  }
  return {
    id,
    name,
    description,
    tokens: { ...BASE_TOKENS, ...tokens },
    icons: merged,
  };
}

const SOFT = skin("soft", "Soft", "Rounded corners and hairlines. What kururu has always looked like.", {});

// ---------------------------------------------------------------------------
// 8-bit
// ---------------------------------------------------------------------------

/**
 * The first skin that is actually a skin, and the one the token surface was
 * designed against.
 *
 * It is here rather than in the styles registry on purpose, and the reason is
 * the same one that puts a reference implementation in the repo it is a
 * reference for: the only way to find out whether the token surface is wide
 * enough is to try to build something with it that is genuinely not the default,
 * and it is far cheaper to discover a missing token while the skin is in the
 * same tree. What this one found, in order, was the type ramp (a pixel face
 * cannot live at the sans-serif's sizes), the smoothing token (without it the
 * glyphs have grey edges and the illusion collapses), and the frame recipe (a
 * single border is not an eight-bit frame; the depth is the second line).
 *
 * The parts that are *not* a rounding-down of the default are worth naming.
 * Radii are zero because a curve is the single strongest tell that you are
 * looking at a modern compositor — a 2px radius reads as "nearly pixel art",
 * which is worse than either end. Lines are 2px because a one-pixel border on a
 * retina display is a half-pixel line, and a half-pixel line in a skin whose
 * premise is that pixels are visible is a contradiction. The line height is
 * generous because an eight-pixel em with no descender room is a wall.
 *
 * The font is Press Start 2P, which ships in `web/public/fonts` under the SIL
 * Open Font License, subset to latin. Its em is exactly eight pixels, so sizes
 * that are multiples of eight are pixel-exact and everything else is very
 * slightly soft — which is why the ramp below is flatter than the base's. There
 * is less type hierarchy in an eight-bit window than a modern one, and that is
 * honest rather than a limitation.
 */
const EIGHT_BIT = skin(
  "8bit",
  "8-bit",
  "Hard edges, an eight-pixel em and a scanline. Press Start 2P.",
  {
    radiusXs: "0",
    radiusSm: "0",
    radiusMd: "0",
    radiusLg: "0",
    radiusXl: "0",
    // The one exception, and it is not an inconsistency: a status dot that is a
    // square is not a dot, it is a pixel, and it stops being distinguishable
    // from the squares around it. A circle here is what keeps the one glanceable
    // thing in the sidebar glanceable.
    radiusRound: "50%",

    border: "2px",
    borderThick: "3px",

    ui: `"Press Start 2P", "Courier New", monospace`,
    fsXs: "6px",
    fsSm: "7px",
    fsBase: "8px",
    fsMd: "8px",
    fsLg: "10px",
    fsXl: "12px",
    uiLineHeight: "1.8",
    uiLetterSpacing: "0",
    uiSmoothing: "none",

    // Two lines with the chrome between them: the outer border is the pane's
    // own, this is the inset that gives it thickness. The classic NES dialog
    // box is a frame you can see the inside edge of.
    frame: "inset 0 0 0 2px var(--chrome)",
    frameOn: "inset 0 0 0 2px var(--chrome-high)",
    // A hard offset block rather than a blur, because a soft shadow is a
    // lighting model and an eight-bit window does not have one.
    elevDialog: "6px 6px 0 var(--shadow)",
    elevMenu: "4px 4px 0 var(--shadow)",

    overlay: "repeating-linear-gradient(to bottom, rgba(0,0,0,0.22) 0 1px, transparent 1px 3px)",
    overlayOpacity: "0.55",
  },
  {
    // ASCII, because Press Start 2P is a latin subset and does not contain ✕ or
    // ▸ — a glyph it lacks falls through to Courier and arrives in the wrong
    // font, which is far more noticeable on four buttons than a slightly blunt
    // shape is. `X` and `>` are also simply what an eight-bit interface used.
    close: "X",
    run: ">",
    caret: "v",
    // Left alone deliberately, and the honest gap in this skin: no ASCII
    // character reads as "restart" or as "rename", so these two keep ↻ and ✎ and
    // render them in the fallback face. It is the clearest argument there is for
    // icons being sprite cells rather than glyphs — a drawn 8×8 arrow has no
    // such problem — which is the next step and not this one.
    restart: null,
    edit: null,
    /**
     * Also the base's. The arrow is already a single glyph at any size and the
     * pixel alternatives are all two characters wide, which would make the dev
     * row the one place in this skin where an icon changes a row's height.
     */
    external: null,
  },
);

// ---------------------------------------------------------------------------

/** Every skin, in the order Settings lists them. The default first. */
export const SKINS: readonly Skin[] = [SOFT, EIGHT_BIT];

export const DEFAULT_SKIN_ID = "soft";

/**
 * The skin for an id, falling back rather than refusing — `themeFor`'s call,
 * for `themeFor`'s reason. An id naming nothing is what a downgrade looks like,
 * or a registry skin that has been uninstalled, and the right answer to both is
 * a window with a shape rather than a window with none.
 */
export function skinFor(id: string | null | undefined): Skin {
  return SKINS.find((s) => s.id === id) ?? SKINS.find((s) => s.id === DEFAULT_SKIN_ID) ?? SKINS[0]!;
}
