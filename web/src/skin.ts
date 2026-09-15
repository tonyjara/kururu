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
import { skinFor, type IconName, type Skin, type SkinTokens } from "../../shared/skin";
import { ICON_NAMES } from "../../shared/skin";
import { cssName } from "./theme";

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
  /**
   * Named on the element for the same reason `data-theme` is: it is the one
   * hook a skin's own stylesheet has to scope itself with, so that installing
   * two never means two sets of rules fighting over one window.
   */
  root.dataset.skin = skin.id;
}

/** The glyph for a name, for the rare caller that needs it as a string rather than as a rule. */
export function iconGlyph(skinId: string | null | undefined, name: IconName): string {
  return skinFor(skinId).icons[name];
}
