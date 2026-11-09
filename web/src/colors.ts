/**
 * What a board column's colour looks like — the palette workspaces wore until
 * they stopped, and which is still named after them (see `WORKSPACE_COLORS`).
 *
 * The server stores a name and the web decides what it means, which is the same
 * split `labels.ts` makes for the same reason: the thing that has to be agreed
 * between two processes is the smallest thing that can be, and everything about
 * how it is *drawn* stays on the side that draws. A repaint can restyle the
 * whole palette; nobody's saved session has to be rewritten for it.
 *
 * The values are `--ws-<name>` in the stylesheet's `:root`, chosen against
 * the chrome rather than against each other: they sit on `--chrome` at a few
 * pixels wide, so they are pitched brighter than the text and flatter than an
 * accent. A tag is therefore a `var()` and follows the cascade.
 */
import type { WorkspaceColor } from "../../shared/model";
import { WORKSPACE_COLORS } from "../../shared/model";

/** Every tag colour, for the picker that shows all eight at once. */
export function colorValues(): Record<WorkspaceColor, string> {
  const out = {} as Record<WorkspaceColor, string>;
  for (const name of WORKSPACE_COLORS) out[name] = `var(--ws-${name})`;
  return out;
}

/** The CSS value for a tag, or null for an untagged column. */
export function colorValue(color: WorkspaceColor | null | undefined): string | null {
  return color ? `var(--ws-${color})` : null;
}
