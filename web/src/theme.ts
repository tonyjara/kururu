/**
 * The theme, as the stylesheet can see it.
 *
 * `styles.css` asks for `var(--bg)` in two hundred places and has no idea a
 * theme exists, which is the arrangement worth keeping: the tokens are the
 * contract, and a theme is a set of values for them written onto the root
 * element. So this module is one loop and a `setProperty`, and the whole of
 * theming on the CSS side is that the `:root` block in the stylesheet stopped
 * being the only place those values could come from.
 *
 * The `:root` block still exists and still holds a complete palette. It is not
 * dead: it is what is on screen for the frame or two between the page painting
 * and the first snapshot arriving, and it is what keeps the stylesheet readable
 * on its own rather than as half of something. It holds Mocha, because that is
 * the default and a first paint in some other theme's colours would be a flash
 * of the wrong app.
 *
 * Nothing here is reactive and nothing here is React. A theme is a property of
 * the document, not of a component: putting it in the tree would mean every
 * consumer subscribing to a context to learn a colour that CSS is already
 * cascading to it for free, and a re-render of the entire window every time
 * somebody dragged a font-size slider.
 */
import { applyTerminalAppearance } from "./terminals";
import { applySkin } from "./skin";
import type { Appearance, Theme, UiTokens, WorkspaceColorName } from "../../shared/theme";
import { themeFor } from "../../shared/theme";
import { skinFor } from "../../shared/skin";
import { EMPTY_LIBRARY, type StyleLibrary } from "../../shared/styles";

/**
 * `chromeHigh` → `--chrome-high`. The one mechanical translation in here, and it
 * is a function rather than a second list of names beside the first: a list
 * would be a place for the two spellings of a token to disagree, and the
 * disagreement would be a colour that silently falls back to whatever the
 * `:root` block happens to say.
 *
 * Exported because `skin.ts` does the identical translation for the identical
 * reason, and two copies of it is precisely the disagreement this paragraph is
 * about — one file gaining a rule about digits, or acronyms, or a leading
 * capital, and the other not.
 */
export function cssName(token: string): string {
  return `--${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/** Applied to `<html>` rather than `<body>`, so `color-scheme` is inherited by everything including the scrollbars. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  for (const [token, value] of Object.entries(theme.ui) as [keyof UiTokens, string][]) {
    root.style.setProperty(cssName(token), value);
  }
  /**
   * The one thing that is not a token, because it is not a colour: it tells the
   * engine which way round this theme is, and that is what makes a native
   * scrollbar, a text selection and a form control the app never styled come out
   * right. Without it a light theme keeps a dark scrollbar and reads as broken
   * in exactly the places kururu does not paint.
   */
  root.style.colorScheme = theme.appearance;
  root.dataset.theme = theme.id;
  /**
   * The eight workspace tags, as properties rather than as a lookup.
   *
   * `colors.ts` used to answer for these by reading `data-theme` back off this
   * element and finding the theme again, which was right while every theme was
   * in `shared/theme.ts` and became wrong the moment one could be installed: the
   * id on the element then names a theme that module has never heard of, and the
   * lookup quietly returns the *default* palette — eight plausible colours from
   * the wrong theme, which is exactly the class of bug the whole token system
   * exists to remove.
   *
   * Writing them here keeps `colors.ts`'s own argument intact and makes it
   * stronger: the document is still the single answer to "which theme is on",
   * and now a tag is `var(--ws-green)` and follows it through the cascade with
   * nothing to look up at all.
   */
  for (const [name, value] of Object.entries(theme.workspace) as [WorkspaceColorName, string][]) {
    root.style.setProperty(`--ws-${name}`, value);
  }
}

/**
 * The whole of it — the chrome, and the emulators — from one snapshot field.
 *
 * Called on every snapshot rather than only when something changed, because the
 * cost is forty `setProperty` calls against a style object that is already those
 * values, and the alternative is a memo of the last appearance kept in a module
 * that would then have two ideas of what is on screen. `applyTerminalAppearance`
 * does keep one, but for a reason that is about the pty rather than about
 * bookkeeping: it has to know whether the *font* moved, since only that is worth
 * proposing a new grid over.
 */
export function applyAppearance(appearance: Appearance, styles: StyleLibrary = EMPTY_LIBRARY): void {
  const theme = themeFor(appearance.themeId, styles.themes);
  applyTheme(theme);
  /**
   * Before the emulators rather than after, and it matters by exactly one
   * frame: a skin moves the chrome's line weight and type ramp, so applying it
   * resizes every pane box, and doing that first means the `ResizeObserver`
   * measurement that follows is taken against the boxes the window is about to
   * actually have. The other order measures the old box and corrects a frame
   * later, which is a SIGWINCH nobody needed.
   */
  applySkin(skinFor(appearance.skinId, styles.skins));
  applyTerminalAppearance(theme.terminal, appearance.terminal);
}
