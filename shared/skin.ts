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
 * skin that has *considered* this icon and decided the default was right. A
 * pixel chrome that finds no ASCII character reading as "restart" writes `null`
 * there, and the null is the sentence. After the merge every name has a glyph,
 * so nothing downstream has to carry a fallback.
 *
 * The glyph is only half of an icon now, and the lesser half. Kururu draws its
 * own set as vectors (`web/src/icons.ts`), because a character's weight and size
 * are the font's to decide — `✕` in one face is a hairline and in another is a
 * blot, and none of them are big enough for a thumb. So the glyphs below are
 * what a skin *replaces* the vector with, and what the registry's preview prints
 * where it has no vector to draw. A skin that writes one has asked for text; a
 * skin that does not gets the drawing.
 */
export type IconName =
  | "close"
  | "run"
  | "restart"
  | "caret"
  | "add"
  | "edit"
  | "external"
  | "split-right"
  | "split-down"
  | "settings"
  | "share"
  | "follow"
  | "pin"
  | "panes";

export type IconSet = Record<IconName, string>;

export const ICON_NAMES: readonly IconName[] = [
  "close",
  "run",
  "restart",
  "caret",
  "add",
  "edit",
  "external",
  "split-right",
  "split-down",
  "settings",
  "share",
  "follow",
  "pin",
  "panes",
];

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

/**
 * A face a skin brings with it, already pointed at somewhere kururu serves.
 *
 * `src` is a URL and it is filled in by the *server*, because the server is the
 * only thing that knows where an installed style's files ended up — and because
 * it is the one place that can guarantee the answer is kururu's own origin. A
 * manifest never contains a URL; it names a file in its own directory, and a
 * manifest that names `https://…` is refused at install. That rule is not
 * decoration: a window that fetches a face from somebody else's host tells that
 * host when its owner is working, and this is a window people leave open all day.
 */
export interface SkinFont {
  family: string;
  /** Served by kururu. Relative, so it works from the phone as well as the desktop. */
  src: string;
  /** A CSS weight, or a range for a variable face: `"400"`, `"400 700"`. */
  weight: string;
  style: string;
}

export interface Skin {
  id: string;
  name: string;
  /** One line, shown in Settings under the name. What kind of window this is. */
  description: string;
  tokens: SkinTokens;
  icons: IconSet;
  /**
   * The icons this skin drew as text on purpose, which the window then draws as
   * text instead of as kururu's vector. Recorded rather than worked out by
   * comparing against `BASE_ICONS`, because a pixel skin writing `+` for `add` —
   * the base's own glyph — has still asked for a `+` in its own face beside its
   * other ASCII, and a comparison would hand it one smooth vector among them.
   * Absent is none.
   */
  glyphs?: readonly IconName[];
  /**
   * The faces this skin brought, if it came from the registry. Absent on every
   * built-in, which name faces the machine already has.
   */
  fonts?: readonly SkinFont[];
  /**
   * A stylesheet this skin brought, as a URL kururu serves — for the things the
   * token set genuinely cannot express. Scoped by `[data-skin="<id>"]` at the
   * source and checked for it at install, so that two installed skins can never
   * fight over one window. Absent on every built-in, and on every registry skin
   * that did not need one, which is all of them so far and is the intended
   * result rather than a coincidence: the token surface was widened until they
   * did not.
   */
  stylesheet?: string;
}

/**
 * Whether a string is an id.
 *
 * Here rather than in `theme.ts` or `styles.ts` because both axes have ids and
 * this is the leaf module both of them already import — an id rule spelled twice
 * is an id rule that will eventually disagree with itself about a dash.
 *
 * The same shape `isSheetName` uses, and for the same reasons: an id becomes a
 * directory under `~/.config/kururu`, a segment in an asset URL, and a key in a
 * saved decision, and it arrives from a manifest somebody on the internet wrote.
 */
export function isStyleId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
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
   * It is deliberately not zero. Zero is a *statement* — it is what a skin
   * says when hard edges are the whole point of it, and the registry has skins
   * that say it. The base is meant to be the window you stop noticing, and a
   * hairline corner is how a surface admits it has an edge without drawing
   * attention to the fact.
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
  "split-right": "◫",
  "split-down": "⊟",
  settings: "⚙",
  /** Getting kururu onto a phone, which is a code to scan. */
  share: "▦",
  /** A reader following the editor, as opposed to pinned to one file. */
  follow: "⇄",
  pin: "⊙",
  /** Which of several panes this is, on a screen too narrow to tile them. */
  panes: "▥",
};

/**
 * A skin, as the difference from the base.
 *
 * Partial rather than complete for the reason in the header: a skin written out
 * in full is a skin that silently keeps the base's answer to a token from the
 * version it was written in, and an eight-bit chrome that quietly reverted one
 * radius to 8px two releases later is a bug nobody would find. Writing only what
 * you mean to change also makes a skin readable as an argument — the ones in
 * `../kururu-styles` are a dozen lines each and every one of them is a
 * decision.
 */
function skin(
  id: string,
  name: string,
  description: string,
  tokens: Partial<SkinTokens>,
  icons: Partial<Record<IconName, string | null>> = {},
): Skin {
  const merged = { ...BASE_ICONS };
  const glyphs: IconName[] = [];
  for (const name of ICON_NAMES) {
    const glyph = icons[name];
    if (typeof glyph !== "string") continue;
    merged[name] = glyph;
    glyphs.push(name);
  }
  return {
    id,
    name,
    description,
    tokens: { ...BASE_TOKENS, ...tokens },
    icons: merged,
    glyphs,
  };
}

const SOFT = skin("soft", "Soft", "Rounded corners and hairlines. What kururu has always looked like.", {});

// ---------------------------------------------------------------------------

/** Every skin, in the order Settings lists them. The default first. */
export const SKINS: readonly Skin[] = [SOFT];

export const DEFAULT_SKIN_ID = "soft";

/**
 * Every skin there is *here*, plus whatever has been installed.
 *
 * Installed first, so that a registry skin sharing an id with a built-in wins.
 * That ordering is deliberate and it is the forgiving answer: the collision can
 * only happen when kururu later ships a skin under a name somebody already
 * installed, and having the window quietly change shape under them would be
 * worse than having their choice keep working.
 */
export function allSkins(extra: readonly Skin[] = []): readonly Skin[] {
  return extra.length === 0 ? SKINS : [...extra, ...SKINS];
}

/**
 * The skin for an id, falling back rather than refusing — `themeFor`'s call,
 * for `themeFor`'s reason. An id naming nothing is what a downgrade looks like,
 * or a registry skin that has been uninstalled, and the right answer to both is
 * a window with a shape rather than a window with none.
 *
 * `extra` is what this server has installed. Every caller that has a snapshot
 * passes it; the two that do not — a first paint before one has arrived, and
 * `colors.ts` reading the id back off the root element — get the built-ins,
 * which is correct for them and is the same answer they got before the registry
 * existed.
 */
export function skinFor(id: string | null | undefined, extra: readonly Skin[] = []): Skin {
  const all = allSkins(extra);
  return all.find((s) => s.id === id) ?? all.find((s) => s.id === DEFAULT_SKIN_ID) ?? all[0]!;
}
