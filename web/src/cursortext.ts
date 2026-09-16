/**
 * The character underneath a block cursor, which is otherwise not there at all.
 *
 * ghostty-web's `renderCursor` is one `fillRect` in the cursor's colour, drawn
 * after the line beneath it and over the top of the glyph that was in it. So a
 * block cursor in kururu did not sit *on* a character, it replaced one: an nvim
 * in normal mode over `hello` drew `ello` with a coloured rectangle where the
 * `h` had been. Nothing about that is subtle once it is pointed out, and it is
 * easy not to point out, because the missing letter is exactly the one you are
 * looking at and your eye supplies it.
 *
 * No terminal does this. Ghostty proper draws the cell again over the block in
 * its `cursor-text` colour — the background by default — so the character reads
 * through the cursor, which is also what makes a block cursor usable in a
 * *visual* selection, where what is under it is the thing being selected. And
 * it is the whole point of an editor colouring its cursor per mode: a colour
 * you cannot see a letter through is a colour you cannot read a word through.
 *
 * So the same trick `boxdraw.ts` uses: the library draws it wrong, kururu draws
 * it afterwards. That file wraps `fillText` on the 2D context; this one wraps
 * `renderCursor` on the renderer, because there is no other moment between the
 * block being filled and the frame being handed over. Two things follow from
 * leaning on a private method, and both are cheap: a version that renames it
 * silently stops redrawing the glyph — which looks exactly like the bug this
 * fixes, so check this file first — and a version that starts drawing the text
 * itself would draw it twice in the same place, which is invisible.
 *
 * Only the block is covered, and only because only the block covers anything. A
 * bar or an underline sits at the edge of the cell where the glyph already is,
 * and the unfocused style — the one `terminals.ts` uses to draw no cursor at
 * all — must draw no character either, which is why the style is asked for
 * rather than assumed.
 */
import { CellFlags, type GhosttyCell, type IRenderable } from "ghostty-web";

/**
 * What this needs of a renderer, which is rather more than it admits to: two of
 * these four are private in the published types, so the call site casts. That
 * is the honest shape of the dependency rather than a way around it.
 */
export interface CursorRenderer {
  getCanvas(): HTMLCanvasElement;
  getMetrics(): { width: number; height: number; baseline: number };
  renderCursor(x: number, y: number): void;
  currentBuffer?: IRenderable | null;
}

/** What the pane knows and the renderer does not: whose block this is. */
interface CursorText {
  /** The style actually in force, since `terminals.ts` owns that decision. */
  style(): string;
  /** The colour to draw the character in — the theme's `cursorAccent`. */
  color(): string;
  /** The face the emulator is set in, which is the one the line was drawn in. */
  font(): { size: number; family: string };
}

/** Patched renderers, so that a second borrow of a pooled emulator is a no-op. */
const patched = new WeakSet<object>();

export function installCursorText(renderer: CursorRenderer, pane: CursorText): void {
  if (patched.has(renderer)) return;
  patched.add(renderer);

  const original = renderer.renderCursor.bind(renderer);
  renderer.renderCursor = (x: number, y: number): void => {
    original(x, y);
    if (pane.style() !== "block") return;

    const cell = renderer.currentBuffer?.getLine(y)?.[x];
    if (!cell || cell.width === 0) return;
    if (cell.flags & CellFlags.INVISIBLE) return;
    const text = glyph(renderer.currentBuffer, cell, x, y);
    if (!text) return;

    const ctx = renderer.getCanvas().getContext("2d");
    if (!ctx) return;
    const metrics = renderer.getMetrics();
    const { size, family } = pane.font();
    // The same font string `renderCellText` builds, so that a bold or italic
    // run does not change weight for the one cell the cursor is on.
    let style = "";
    if (cell.flags & CellFlags.ITALIC) style += "italic ";
    if (cell.flags & CellFlags.BOLD) style += "bold ";
    ctx.font = `${style}${size}px ${family}`;
    ctx.fillStyle = pane.color();
    ctx.fillText(text, x * metrics.width, y * metrics.height + metrics.baseline);
  };
}

/**
 * What is in the cell, as a string.
 *
 * A grapheme is several codepoints and only the buffer can put them back
 * together, which is the same ladder `renderCellText` climbs. A space is
 * nothing to draw rather than a space to draw: the block is already the right
 * shape and painting over it costs a `fillText` per frame for no pixels.
 */
function glyph(
  buffer: IRenderable | null | undefined,
  cell: GhosttyCell,
  x: number,
  y: number,
): string {
  if (cell.grapheme_len > 0 && buffer?.getGraphemeString) return buffer.getGraphemeString(y, x);
  if (!cell.codepoint || cell.codepoint === 32) return "";
  return String.fromCodePoint(cell.codepoint);
}
