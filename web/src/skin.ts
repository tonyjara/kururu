/**
 * The skin, as the stylesheet can see it.
 *
 * Deliberately the same three lines `web/src/theme.ts` is, and deliberately a
 * separate file: the two are applied together and mean nothing to each other,
 * so one module doing both would be a place where a change to how colour is
 * applied could break how shape is. The mechanism is identical because the
 * argument is identical — the tokens are the contract, a skin is a set of values
 * for them written onto the root element, and `styles.css` asks for
 * `var(--radius-md)` without knowing skins exist.
 *
 * ## The icons go through CSS too, and that is the interesting decision
 *
 * The obvious way to let a skin change a close button from `✕` to `X` is a React
 * component that reads the current skin out of the snapshot. It is rejected for
 * the reason `theme.ts` gives about colour: an icon is a property of the
 * document, not of a component. Routing it through React would mean every button
 * in the window subscribing to a context to learn one character, and a re-render
 * of the whole chrome every time somebody clicked a row in the skin picker.
 *
 * So an icon is a custom property holding a CSS string — `--icon-close: "X"` —
 * and `.icon-close::before { content: var(--icon-close) }` draws it. Changing
 * skin is then forty `setProperty` calls and no render at all, and an `<Icon>`
 * stays a `<span>` with a class on it that React never has to think about again.
 *
 * The quoting is the one sharp edge, and it is sharp because of where these will
 * eventually come from. `content` takes a *quoted* string, so the glyph has to
 * arrive wrapped — and a glyph containing a quote would close it early and leave
 * whatever follows being parsed as CSS. Today every glyph is one of ours and
 * that is theoretical; the moment skins arrive from the registry it is a
 * stranger's string landing in the root element of a window that is reachable
 * from the tailnet, which is the same sentence `set-workspace-color` and
 * `files.ts` are both built around. `cssString` below is that check, written now
 * rather than when it is load-bearing.
 *
 * ## The pictures go the same way, and so do the colours
 *
 * A part a skin painted is three more custom properties — `partVars` in
 * `shared/skin.ts` makes them, this writes them, and the stylesheet's *Parts*
 * block reads them. Nothing about a bezel is a component either: `.pane` asks
 * for `var(--p-pane-frame)` and gets a picture or `none`.
 *
 * The chrome colours a skin insists on are written *over* the theme's, and the
 * ordering is the only subtle thing in this file: `applyAppearance` calls
 * `applyTheme` first and then this, on every snapshot, so a skin that overrides
 * `--text` wins while it is on and the theme's `--text` comes back the moment a
 * skin without an override goes on — because the theme rewrites it every time
 * and this then has nothing to say. No memo of "what the theme said" is kept
 * anywhere, which is what makes that correct rather than lucky.
 *
 * ## Why nothing here re-measures a terminal
 *
 * A skin moves the line weight and the type ramp, so it genuinely does change
 * the box a pane's terminal sits in, and a changed box is a new proposed grid
 * and therefore a SIGWINCH into every agent watching. That is correct and
 * intended — it is the one way a skin differs from a theme, which must never
 * resize a pty.
 *
 * It needs no code. Every pooled emulator is already watched by a `ResizeObserver`
 * in `terminals.ts`, so a border that got a pixel thicker resizes the element and
 * the observer fires `measure()` for free, through the same 60ms settle a dragged
 * divider goes through and for the same reason. Adding an explicit sweep here
 * would be a second path to the same place, and the second path is the one that
 * rots. The same is true of the web font landing a moment after the first paint:
 * the metrics move, the boxes move, the observer notices.
 */
import { partVars, type Skin, type SkinTokens } from "../../shared/skin";
import { ICON_NAMES } from "../../shared/skin";
import type { UiTokens } from "../../shared/theme";
import { applyIcons } from "./icons";
import { cssName } from "./theme";

applyIcons();

/**
 * A glyph, as something `content` can safely be handed.
 *
 * Backslashes first, or escaping the quotes would then be escaped themselves and
 * the closing quote would be eaten. Newlines go because a raw one is invalid in
 * a CSS string and invalidates the whole declaration — which would not merely
 * drop the icon, it would drop it silently and leave a button that is a blank
 * space. Anything that survives is a literal character in a quoted string and
 * cannot be anything else.
 */
function cssString(glyph: string): string {
  const escaped = glyph.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]/g, "");
  return `"${escaped}"`;
}

/**
 * Written onto `<html>` rather than `<body>`, so the overlay layer and anything
 * else outside the app root reads the same values.
 */
export function applySkin(skin: Skin): void {
  const root = document.documentElement;
  for (const [token, value] of Object.entries(skin.tokens) as [keyof SkinTokens, string][]) {
    root.style.setProperty(cssName(token), value);
  }
  for (const name of ICON_NAMES) {
    root.style.setProperty(`--icon-${name}`, cssString(skin.icons[name]));
  }
  for (const [token, value] of Object.entries(skin.colors ?? {}) as [keyof UiTokens, string][]) {
    root.style.setProperty(cssName(token), value);
  }
  for (const [name, value] of Object.entries(partVars(skin.parts))) {
    root.style.setProperty(name, value);
  }
  /**
   * The icon strip, and which way it is drawn. The URL comes from the server
   * and is kururu's own origin, like a font's; the mode is an attribute for the
   * reason `data-glyphs` is — CSS can match a word on the root and cannot
   * branch on a property's value.
   */
  root.style.setProperty("--icon-sheet", skin.iconSheet ? `url(${JSON.stringify(skin.iconSheet.src)})` : "none");
  if (skin.iconSheet) {
    if (root.dataset.iconSheet !== skin.iconSheet.mode) root.dataset.iconSheet = skin.iconSheet.mode;
  } else if ("iconSheet" in root.dataset) {
    delete root.dataset.iconSheet;
  }
  /**
   * Which icons this skin wants as text. One attribute holding a list rather
   * than a property per icon, because CSS cannot branch on a custom property's
   * value but can match a word in an attribute — `[data-glyphs~="close"]` — and
   * that is the whole switch between a drawing and a character.
   */
  const glyphs = (skin.glyphs ?? []).join(" ");
  if (root.dataset.glyphs !== glyphs) root.dataset.glyphs = glyphs;
  /**
   * Named on the element for the same reason `data-theme` is: it is the one
   * hook a skin's own stylesheet has to scope itself with, so that installing
   * two never means two sets of rules fighting over one window.
   */
  root.dataset.skin = skin.id;
  applyFonts(skin);
  applyStylesheet(skin);
}

/**
 * The `@font-face` rules for a skin that brought its own faces.
 *
 * Written here rather than in `styles.css`, and the reason is that the
 * stylesheet cannot know them: a rule in that file could only ever name a font
 * that shipped with kururu, and these arrive from `../kururu-styles` and are
 * served out of the user's own config directory. So the one `<style>` element
 * below is rewritten when the skin changes, and `src` is always a URL the
 * *server* produced — a manifest may not contain one, which is the whole reason
 * an installed style is a copy on this machine rather than a link to somebody
 * else's host.
 *
 * `font-display: block` in every case and not `swap`, and this is not a
 * preference. The chrome's face decides the size of every label in the window,
 * so a face swapping in late reflows every pane — and a reflow in kururu is a
 * new proposed grid, which means a SIGWINCH into every agent that is running.
 * A blank label for a moment is enormously cheaper than that.
 *
 * Rewritten only when the text actually changes, because assigning `textContent`
 * re-parses the block and a re-parsed `@font-face` is a font the browser may
 * decide to fetch again — and `applySkin` is called on every snapshot.
 */
function applyFonts(skin: Skin): void {
  const rules = (skin.fonts ?? [])
    .map(
      (font) =>
        `@font-face { font-family: ${JSON.stringify(font.family)}; src: url(${JSON.stringify(font.src)});` +
        ` font-weight: ${font.weight}; font-style: ${font.style}; font-display: block; }`,
    )
    .join("\n");
  const el = element("style", "kururu-skin-fonts") as HTMLStyleElement;
  if (el.textContent !== rules) el.textContent = rules;
}

/**
 * A stylesheet a skin brought, for what the tokens genuinely cannot express.
 *
 * A `<link>` rather than the text inlined, so the browser caches it and so that
 * a skin's CSS never travels in a snapshot. It is scoped by `[data-skin="<id>"]`
 * at the source and the registry's CI refuses one that is not, which is what
 * stops two installed skins from ever fighting over one window — and is why
 * leaving the old link in place while the new one loads would be wrong: the
 * rules are inert the moment `data-skin` moves, so swapping the `href` is the
 * whole of the change.
 */
function applyStylesheet(skin: Skin): void {
  const el = element("link", "kururu-skin-css") as HTMLLinkElement;
  const href = skin.stylesheet ?? "";
  if (el.rel !== "stylesheet") el.rel = "stylesheet";
  if (el.getAttribute("href") !== href) {
    if (href) el.setAttribute("href", href);
    else el.removeAttribute("href");
  }
}

/** The one element with this id, made if it is not there yet. */
function element(tag: string, id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found) return found;
  const made = document.createElement(tag);
  made.id = id;
  document.head.appendChild(made);
  return made;
}
