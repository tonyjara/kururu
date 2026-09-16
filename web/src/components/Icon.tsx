/**
 * An icon, which is a class name and nothing else.
 *
 * The glyph is not in here and deliberately cannot be: it is a custom property
 * on the root element, written by `web/src/skin.ts`, and drawn by a `::before`
 * rule in `styles.css`. This component's entire job is to be the span those two
 * meet on — which is why it holds no state, reads no context and has no reason
 * ever to re-render. Changing skin moves a property and every icon in the window
 * follows in the same frame, with React not involved at all. The argument for
 * doing it that way, rather than the obvious way of reading the skin out of the
 * snapshot, is in the header of `skin.ts`.
 *
 * It exists as a component rather than as a bare `<span className="icon …">` at
 * each site for one reason: `ICON_NAMES` in `shared/skin.ts` is what a skin is
 * allowed to override, and a name typed by hand into a class string is a name
 * nothing checks against that list. Going through a typed `name` makes the set
 * of overridable icons the same set in both halves, and a skin that tries to
 * restyle an icon nobody draws becomes a type error rather than a line with no
 * effect.
 *
 * Every one of these is `aria-hidden`, without exception and without a prop to
 * turn it off. An icon here is always inside a control that already says what it
 * does — `aria-label="Close tab"`, `title="Run dev server"` — so a screen reader
 * that also read the glyph would say the thing twice, and it would say it as
 * whatever character the current skin happens to use. "Close tab, X" is worse
 * than "Close tab", and under a skin that draws it as `x` it is worse again.
 */
import type { IconName } from "../../../shared/skin";

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return <span className={`icon icon-${name}${className ? ` ${className}` : ""}`} aria-hidden="true" />;
}
