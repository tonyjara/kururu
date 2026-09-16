/**
 * What a workspace colour looks like.
 *
 * The server stores a name and the web decides what it means, which is the same
 * split `labels.ts` makes for the same reason: the thing that has to be agreed
 * between two processes is the smallest thing that can be, and everything about
 * how it is *drawn* stays on the side that draws. A repaint can restyle the
 * whole palette; nobody's saved session has to be rewritten for it.
 *
 * It used to hold eight hexes, chosen against the chrome rather than against
 * each other — these sit on `--chrome` at a few pixels wide, so they are pitched
 * brighter than the text and flatter than an accent. That argument is exactly
 * why they could not stay here once there was more than one chrome to be chosen
 * against: a palette picked to sit on `#141817` is not the palette that sits on
 * Latte. So the eight live in the theme now and this module is the lookup, which
 * leaves the split above untouched — the server still stores a name, and what a
 * name means is still entirely the web's business.
 *
 * The theme is read through the DOM rather than held, and that is deliberate.
 * `applyTheme` has already written every token onto the root element, so the
 * document is the one place that cannot be out of date with what is on screen —
 * a copy kept here would be a second answer to "which theme is on", and the
 * moment it disagreed the tags would be from the theme before last.
 *
 * Which is why this is now a `var()` and not a lookup at all. It used to find
 * the theme again from `data-theme` and read its `workspace` block, and that
 * broke the day a theme could be *installed*: the id on the element then names
 * something `shared/theme.ts` has never heard of, `themeFor` falls back, and the
 * tags come out in eight plausible colours from the default palette — wrong, and
 * wrong in the way nobody reports. `applyTheme` writes the eight onto the root
 * instead, so a tag follows the cascade and there is nothing left here that
 * could disagree with what is on screen.
 */
import type { WorkspaceColor } from "../../shared/model";
import { WORKSPACE_COLORS } from "../../shared/model";

/** Every tag colour, for the picker that shows all eight at once. */
export function colorValues(): Record<WorkspaceColor, string> {
  const out = {} as Record<WorkspaceColor, string>;
  for (const name of WORKSPACE_COLORS) out[name] = `var(--ws-${name})`;
  return out;
}

/** The CSS value for a tag, or null for an untagged workspace. */
export function colorValue(color: WorkspaceColor | null | undefined): string | null {
  return color ? `var(--ws-${color})` : null;
}
