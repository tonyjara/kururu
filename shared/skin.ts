/**
 * What kururu is *shaped* like — and, since the studio, what it is *made of*.
 *
 * `theme.ts` already made this argument once and won it — a flat record of named
 * tokens, picked by id, written onto the root element by one loop, with a
 * stylesheet that asks for `var(--bg)` and has no idea themes exist. This module
 * is that argument a second time about a different axis, and the axis is the
 * point: a theme answers *what colour*, a skin answers *what shape*. Radius,
 * line weight, the type ramp, whether text is antialiased, which glyph a close
 * button is — and now, which **picture** each part of the window is drawn with.
 *
 * ## The change of mind, and why it is one
 *
 * The first version of this file refused pictures. Its argument was that a
 * nine-slice PNG carries its own colours, so a pane framed with one stops
 * following the theme, and skin and theme would be secretly non-orthogonal. That
 * argument was correct and it produced skins nobody wanted: a radius, a border
 * weight and a scanline over the whole window are the difference between three
 * flavours of the same chrome, and a scanline *over the terminals* is a skin
 * whose most visible effect is making the work harder to read. The skins people
 * actually remember — Winamp's, a thousand of them — were bitmaps: a titlebar,
 * a set of buttons, a frame, each drawn by somebody who meant it, with no theme
 * underneath and no ambition to compose with one.
 *
 * So a skin may now bring pictures, and the orthogonality became a *default*
 * rather than a law. A skin that paints nothing still follows every theme
 * exactly as before. A skin that paints a bezel has chosen its own colours for
 * that bezel, and it is allowed to say so: `colors` lets it override the
 * chrome's tokens so its text reads against its own art. What it may never
 * touch is the **terminal's** palette, which stays the theme's — the terminal is
 * the work, the skin is the frame around it, and a pack is how you ship the two
 * together. That is the line, and it is a better line than the old one because
 * it is drawn where the user's attention is rather than where the code was tidy.
 *
 * ## Parts
 *
 * A skin paints **parts**: the regions of the chrome, named by what they are
 * rather than by class name, each taking one picture and a way of applying it.
 * `PARTS` below is the list — the sidebar, the well the panes sit in, a pane and
 * its focused state, the tab strip, a tab and its selected state, the small
 * icon buttons, the filled buttons, the selected sidebar row, the status bar,
 * and dialogs. Winamp had `main.bmp`, `titlebar.bmp`, `cbuttons.bmp`; this is
 * that, named for a multiplexer.
 *
 * A part is painted one of three ways. **`nine`** is a nine-slice: the picture's
 * edges become the frame and its middle fills the inside, which is a bezel, a
 * bevelled button, a HUD bar. **`tile`** repeats the picture as a texture over
 * the theme's ground — with alpha, it *tints* the theme rather than replacing
 * it, which is the composable answer for anybody who wants grain without
 * choosing a colour. **`stretch`** fits it to the box, for a backdrop. Every
 * mode takes an integer `scale`, because pixel art is drawn at one size and
 * shown at another and a non-integer scale is what turns a crisp bezel into a
 * blurry one.
 *
 * `partVars` turns those into CSS custom properties — three per part — and the
 * stylesheet asks for them the way it asks for every other token. A part nobody
 * painted compiles to `none`, so a skin with no pictures costs exactly what it
 * cost before. A *state* part (`pane-on`, `tab-on`) left unpainted compiles to
 * `var(--p-pane-…)` rather than to `none`, so a skin that drew one bezel gets it
 * on the focused pane too rather than losing it there.
 *
 * ## Why the frame is a border-image and not a pseudo-element
 *
 * `border-image` on the element itself, with the border width set to the slice,
 * because that makes the frame *take room*: content sits inside it and the
 * terminal's box shrinks to fit, which is what the user asked for in as many
 * words — a Game Boy bezel is supposed to eat into the screen. A pseudo-element
 * painted over the edge would keep the layout and cover the first row of text,
 * and a pane whose first row is under a picture is a pane whose agent cannot be
 * read. The cost is a SIGWINCH per pane when a skin with a bezel goes on, which
 * is the same cost a heavier border already had and is the one way a skin has
 * always differed from a theme.
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
 *
 * ## The overlay is still here, and it is no longer the point
 *
 * `overlay` paints over the entire window, terminals included, and it survives
 * because a faint scanline is a thing some people genuinely want. It is `none`
 * in every skin that ships and the studio labels it as the one control that
 * sits on top of somebody's work. What replaced it as the way a skin expresses
 * itself is everything above.
 */

import type { UiTokens } from "./theme";

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
 *
 * A name outlives the button that drew it. Nothing in the chrome draws
 * `split-right` or `split-down` any more — the corner they sat in is one menu
 * now, and a menu row is a label — and they keep their places here regardless,
 * because this list is also the order and the length of an icon *sheet*.
 * Removing one would shift every cell of every sheet in the registry by one, in
 * every skin already installed, with no symptom beyond the wrong picture on the
 * wrong button. That is a cost worth paying only to make room, and there is no
 * shortage of room.
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
  | "panes"
  | "hide"
  | "database"
  | "stop"
  | "play";

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
  // Last, and new names go on the end for the reason the header gives: this
  // list is also the order and the length of an icon sheet, so appending costs
  // a skin that ships one a cell and inserting would cost it every cell after
  // the insertion.
  "panes",
  "hide",
  /** A workspace's local Supabase, up or down. */
  "database",
  /** Ending a dev server, as against the ↻ beside it that brings one back. */
  "stop",
  /**
   * A sound, played to hear it. Not `run`, which is a dev server and is drawn
   * as one: a bolt on the button that previews a notification noise would be a
   * button about electricity, and a triangle on the one that starts a server
   * would be the media player this pair spent a version being mistaken for.
   */
  "play",
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

  /**
   * The gap between panes, and between the panes and the edge of the well. It
   * was a fixed 3px, which is right for a chrome made of hairlines and wrong
   * for one made of bezels: a nine-slice frame twelve pixels thick wants air
   * around it, or two adjacent panes read as one slab with a seam.
   */
  gutter: string;
  /**
   * The ring the focused pane wears, as a complete `outline` value. It is an
   * accent hairline in the base and `none` in a skin that draws its own focused
   * bezel — a picture already saying "this one" does not want a line drawn over
   * it saying it again.
   */
  outlineOn: string;
  /**
   * The pointer, as a complete `cursor` value: `auto`, or a picture and its
   * hotspot. Winamp did this and it is the detail that makes a skin feel like a
   * place rather than a colour scheme. A skin's cursor file is served like any
   * other asset, so the value is `url("/api/styles/asset?…") 2 2, auto`.
   */
  cursor: string;
  /** The same, over anything you can press. */
  cursorPointer: string;
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
   * The pictures, by the part they paint. Empty for a skin made of tokens
   * alone, which is every skin that existed before the studio and is still a
   * perfectly good kind of skin. See the header, and `PARTS`.
   */
  parts: Partial<Record<PartName, PartPaint>>;
  /**
   * Chrome colours this skin insists on, over whatever the theme says. Absent
   * for a skin that follows the theme, which is the default and the reason
   * this is optional rather than a complete record: a skin that has drawn its
   * bezels in gunmetal needs its labels to read against gunmetal whatever
   * palette is on, and this is where it says so. Never a terminal colour — the
   * type does not have them, and the terminal stays the theme's.
   */
  colors?: Partial<UiTokens>;
  /**
   * Every icon at once, as one picture: a strip of `ICON_NAMES.length` square
   * cells in that order. `mask` draws each cell in the button's own text colour
   * so it follows hover and the theme; `image` draws the pixels as they are,
   * for a skin whose icons have colours of their own. Glyphs a skin also names
   * win over the strip for that icon, since a glyph is a per-icon decision and
   * the strip is a blanket one.
   */
  iconSheet?: IconSheet;
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
// Parts
// ---------------------------------------------------------------------------

/**
 * The regions of the chrome a skin may paint. Named by what they are to the
 * person looking at the window, never by class: `pane` and not `.pane`, so the
 * stylesheet can be reorganised under a skin without the skin noticing.
 *
 * Two of them are *states* of another — the focused pane and the selected tab —
 * and `stateOf` says so, which is what `partVars` uses to hand an unpainted
 * state its parent's picture rather than nothing.
 */
export type PartName =
  | "sidebar"
  | "panel"
  | "well"
  | "pane"
  | "pane-on"
  | "tabstrip"
  | "tab"
  | "tab-on"
  | "tool"
  | "button"
  | "row-on"
  | "statusbar"
  | "dialog";

export interface PartInfo {
  /** What the studio calls it. */
  label: string;
  /** What it covers, as a phrase that completes "this paints…". */
  covers: string;
  /** A line of advice for whoever is drawing it. */
  hint: string;
  /** The part this is a state of, if it is one. */
  stateOf?: PartName;
  /**
   * Whether the element already draws a hairline border the frame replaces.
   * Decides what an unpainted part's border width compiles to: `0px` for most,
   * `var(--border)` for the ones that had a line before skins could paint.
   */
  hairline?: boolean;
}

export const PARTS: Record<PartName, PartInfo> = {
  sidebar: {
    label: "Sidebar",
    covers: "the column of profiles, workspaces and agents",
    hint: "Usually a tile. A texture with transparency tints the theme's chrome instead of replacing it.",
  },
  panel: {
    label: "Sidebar panels",
    covers: "the three boxes in the sidebar: the workspaces, the agents, the dev servers",
    hint: "A quiet nine-slice or a flat tile. Headings and rows are drawn over it, and on a busy sidebar it is what keeps them readable.",
  },
  well: {
    label: "Behind the panes",
    covers: "the ground the panes float on, seen in the gutters around them",
    hint: "Widen the gutter to show more of it. A stretched backdrop makes the panes windows onto it.",
  },
  pane: {
    label: "Pane",
    covers: "the frame around every terminal and reader",
    hint: "A nine-slice bezel. The slice is the frame's thickness in the picture's own pixels; the middle sits behind the terminal and is never seen.",
  },
  "pane-on": {
    label: "Focused pane",
    covers: "the same frame, on the pane the keyboard is going to",
    hint: "Leave it empty to reuse the pane's picture. Paint it to light the bezel up.",
    stateOf: "pane",
  },
  tabstrip: {
    label: "Tab strip",
    covers: "the bar along the top of a pane that the tabs sit in",
    hint: "A short nine-slice or a tile. It is the pane's title bar, and the thing you drag a pane by.",
  },
  tab: {
    label: "Tab",
    covers: "one tab at rest, and the + that opens a new one",
    hint: "A small nine-slice. Keep the slices thin — a tab is twenty pixels tall.",
  },
  "tab-on": {
    label: "Selected tab",
    covers: "the tab whose terminal is showing",
    hint: "Leave it empty to reuse the tab's picture.",
    stateOf: "tab",
  },
  tool: {
    label: "Small buttons",
    covers: "the icon buttons: split, close, run, the cog, the close on a tab",
    hint: "A tiny nine-slice, or nothing. These are the most numerous thing in the window.",
  },
  button: {
    label: "Buttons",
    covers: "the filled buttons in dialogs — Done, Create, Delete",
    hint: "A bevelled nine-slice is the classic. The label is drawn over the middle.",
  },
  "row-on": {
    label: "Selected row",
    covers: "the workspace and the agent you are on, in the sidebar",
    hint: "A nine-slice bar. The row's text is drawn over it, so keep the middle quiet.",
  },
  statusbar: {
    label: "Status bar",
    covers: "the bar along the bottom of the window",
    hint: "The HUD. A nine-slice with thin top and bottom slices tiles along the width.",
  },
  dialog: {
    label: "Dialogs and menus",
    covers: "every popup: Settings, a prompt, a right-click menu",
    hint: "A nine-slice frame. This replaces the hairline border a dialog has by default.",
    hairline: true,
  },
};

export const PART_NAMES = Object.keys(PARTS) as PartName[];

export function isPartName(value: unknown): value is PartName {
  return typeof value === "string" && value in PARTS;
}

/** How a picture is applied to a part. See the header. */
export type PaintMode = "nine" | "tile" | "stretch";
export const PAINT_MODES: readonly PaintMode[] = ["nine", "tile", "stretch"];

/**
 * How a nine-slice fills its edges and middle. `stretch` pulls the slice to
 * fit, `repeat` tiles it and cuts the last one, `round` tiles it and squeezes
 * so it does not. CSS's `border-image-repeat`, minus `space`, which nobody has
 * ever wanted on a bezel.
 */
export type PaintRepeat = "stretch" | "repeat" | "round";
export const PAINT_REPEATS: readonly PaintRepeat[] = ["stretch", "repeat", "round"];

export interface PartPaint {
  /**
   * The picture. A URL kururu serves once adopted — see `adoptSkinManifest`,
   * which is the only thing that makes one of these from a manifest — and a
   * file name in the manifest itself, because a manifest may never contain a
   * URL.
   */
  image: string;
  mode: PaintMode;
  /** Top, right, bottom, left, in the picture's own pixels. Only a nine reads it. */
  slice: [number, number, number, number];
  /** Picture pixels to screen pixels. A whole number, or pixel art blurs. */
  scale: number;
  repeat: PaintRepeat;
  /**
   * The picture's own width and height, measured by the server off the file.
   * A tile has to know it to be drawn at `scale`; a nine and a stretch do not
   * and it is absent for them.
   */
  size?: [number, number];
}

export interface IconSheet {
  /** Served by kururu, like a font's `src`. */
  src: string;
  mode: "mask" | "image";
}

/** The CSS names a part compiles to: `--p-pane-frame`, `--p-pane-w`, `--p-pane-bg`. */
export function partVarNames(name: PartName): { frame: string; w: string; bg: string } {
  return { frame: `--p-${name}-frame`, w: `--p-${name}-w`, bg: `--p-${name}-bg` };
}

/**
 * Every part, as the three custom properties the stylesheet asks for.
 *
 * `frame` is a complete `border-image` value and `w` the `border-width` that
 * goes with it — separate because `border-image` cannot set the border's own
 * width, and it is the width that makes the frame take room. `bg` is one
 * background *layer*, so a rule can write `background: var(--p-well-bg),
 * var(--chrome)` and get the texture over the theme's ground, or `none` over it
 * when there is no texture, which is the same declaration either way.
 *
 * Pure, and the same function on both sides: the client writes what this
 * returns onto the root, and `web/test/theme.test.ts` checks that the `:root`
 * block in the stylesheet says exactly what this returns for the default skin.
 */
export function partVars(parts: Skin["parts"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of PART_NAMES) {
    const { frame, w, bg } = partVarNames(name);
    const info = PARTS[name];
    const paint = parts[name];
    const restWidth = info.hairline ? "var(--border)" : "0px";
    if (!paint) {
      if (info.stateOf) {
        const parent = partVarNames(info.stateOf);
        out[frame] = `var(${parent.frame})`;
        out[w] = `var(${parent.w})`;
        out[bg] = `var(${parent.bg})`;
      } else {
        out[frame] = "none";
        out[w] = restWidth;
        out[bg] = "none";
      }
      continue;
    }
    const url = `url(${JSON.stringify(paint.image)})`;
    if (paint.mode === "nine") {
      const [t, r, b, l] = paint.slice;
      const width = `${t * paint.scale}px ${r * paint.scale}px ${b * paint.scale}px ${l * paint.scale}px`;
      out[frame] = `${url} ${t} ${r} ${b} ${l} fill / ${width} / 0 ${paint.repeat}`;
      out[w] = width;
      out[bg] = "none";
      continue;
    }
    out[frame] = "none";
    out[w] = restWidth;
    if (paint.mode === "stretch") {
      out[bg] = `${url} 0 0 / 100% 100% no-repeat`;
    } else {
      const size = paint.size ? `${paint.size[0] * paint.scale}px ${paint.size[1] * paint.scale}px` : "auto";
      out[bg] = `${url} 0 0 / ${size} repeat`;
    }
  }
  return out;
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

  gutter: "3px",
  outlineOn: "var(--border) var(--border-style) color-mix(in srgb, var(--accent) 30%, transparent)",
  cursor: "auto",
  cursorPointer: "pointer",
};

/** Kururu's own, and the floor every skin's icons are merged onto. */
export const BASE_ICONS: IconSet = {
  close: "✕",
  /** Starting a dev server. A bolt rather than a triangle: see `play`. */
  run: "↯",
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
  /** An agent put away in the sidebar's list, which is not an agent ended. */
  hide: "⊘",
  /** The local database behind a workspace. A cylinder is what everybody draws. */
  database: "▤",
  /** The end of a dev server. A square, which is what stopping looks like. */
  stop: "■",
  /** Hearing a sound before installing it, and the only player kururu has. */
  play: "▸",
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
    parts: {},
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
