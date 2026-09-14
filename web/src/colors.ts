/**
 * What a workspace colour looks like.
 *
 * The server stores a name and the web decides what it means, which is the same
 * split `labels.ts` makes for the same reason: the thing that has to be agreed
 * between two processes is the smallest thing that can be, and everything about
 * how it is *drawn* stays on the side that draws. A repaint can restyle the
 * whole palette; nobody's saved session has to be rewritten for it.
 *
 * Chosen against the chrome rather than against each other. These sit on
 * `--chrome` at a few pixels wide — a rule down the side of a row, a dot under a
 * number — so they are pitched brighter than the text and flatter than an
 * accent: bright enough to read at four pixels, dull enough that eight of them
 * in a list is not a toy. The first two are `--accent` and `--done` exactly, so
 * a tagged workspace never introduces a green or a blue the window did not
 * already have.
 */
import type { WorkspaceColor } from "../../shared/model";

export const COLOR_VALUES: Record<WorkspaceColor, string> = {
  green: "#7fd6a2",
  blue: "#7aa6da",
  amber: "#e3c46a",
  coral: "#e08f7a",
  violet: "#b49ae0",
  cyan: "#74c7c4",
  rose: "#dd8fae",
  lime: "#b5cf7a",
};

/** The CSS value for a tag, or null for an untagged workspace. */
export function colorValue(color: WorkspaceColor | null | undefined): string | null {
  return color ? COLOR_VALUES[color] : null;
}
