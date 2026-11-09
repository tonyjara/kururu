/**
 * An icon, which is a class name and nothing else.
 *
 * The drawing is not in here: it is a custom property on the root element,
 * written once by `web/src/icons.ts`, and drawn by a `::before` rule in
 * `styles.css` as a mask in the colour of whatever it sits in. This component
 * is the span those two meet on, so it holds no state and never re-renders.
 *
 * It exists as a component rather than as a bare `<span className="icon …">`
 * so that the name is typed: a name typed by hand into a class string is one
 * nothing checks against the drawings there are.
 *
 * Every one of these is `aria-hidden`, without exception and without a prop to
 * turn it off. An icon here is always inside a control that already says what it
 * does — `aria-label="Close tab"`, `title="Run dev server"` — so a screen reader
 * that also read the icon would say the thing twice.
 */
// For its effect as well as its type: importing it is what writes the drawings.
import "../icons";
import type { IconName } from "../icons";

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return <span className={`icon icon-${name}${className ? ` ${className}` : ""}`} aria-hidden="true" />;
}
