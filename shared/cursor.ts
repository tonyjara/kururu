/**
 * The cursor a program asks for, and the two directions that answer travels.
 *
 * Two sequences, and a mode change sends both. `CSI Ps SP q` — DECSCUSR — is
 * the shape: vim, nvim, fish and anything else with an opinion about modes says
 * that insert is a bar and normal is a block. `OSC 12` is the colour, and
 * `OSC 112` puts it back. Under the stock `guicursor` an nvim was observed
 * sending `CSI 2 SP q` with `OSC 12;#f4dbd6` for normal, `6` with `#787878` for
 * insert and `#9745be` for visual, then `CSI 0 SP q` and `OSC 112` on the way
 * out — so the pair is how an editor draws its modes, and honouring one without
 * the other gets the shape right and the colour wrong.
 *
 * Every real terminal answers both, and what is in Settings is only the
 * *default* they fall back to: `CSI 0 SP q` and `OSC 112` are how a program
 * hands the decision back. So a cursor that is always the configured one is not
 * a simplification, it is a terminal that does not implement the sequences.
 *
 * Kururu has to read it off the byte stream itself, which is worth justifying
 * because nothing else in the client parses a sequence. ghostty-web does parse
 * this one properly — Ghostty's VT keeps a style beside the cursor's position,
 * and the wasm's render state even packs a byte for it — but the bridge does
 * not hand it back: `getCursor()` returns `style: "block"` with a `// TODO`
 * beside it, and there is no `ghostty_render_state_get_cursor_style` to call
 * instead. The renderer draws whatever `setCursorStyle` was last told, which is
 * kururu's setting and nothing else. This is therefore the one piece of
 * terminal state the emulator will not answer for, and `mouse.ts` next door is
 * the shape of the answer when it will: the protocol here, the policy at the
 * call site.
 *
 * The other direction exists for the reason `screen.ts` appends `\x1b[?25l`: a
 * serialized screen carries neither of them. The serializer restores eight
 * modes and these are not modes at all — so a pane opened ten minutes into an
 * nvim session would come up wearing the user's block while the editor sat in
 * insert, and would keep it until the next mode change. The server writes them
 * back onto the end of the backlog as the sequences a program would have sent.
 *
 * Which is why the *server* scans with this too, rather than asking its xterm
 * what it parsed. It could: DECSCUSR lands in `decPrivateModes` and OSC 12
 * fires an event, both of them behind an underscore. But then one side of
 * kururu would learn the cursor from xterm and the other from this file, over
 * the same bytes, and the whole point of a backlog is that the two agree. One
 * parser over one stream cannot disagree with itself.
 */
import type { CursorStyle } from "./theme";

/** What the program asked for, as against what the user chose. */
export interface ProgramCursor {
  style: CursorStyle;
  blink: boolean;
}

/**
 * The parameters, in the order the spec numbers them: the shape in pairs, and
 * blinking odd, steady even.
 *
 * `0` is deliberately not in here, because it is not a shape. It means "go back
 * to whatever the terminal was configured with", which is a null rather than a
 * value — and it is the one parameter that has to be got right, since it is
 * what a program sends when it stops having an opinion.
 */
const SHAPES: readonly CursorStyle[] = ["block", "block", "underline", "underline", "bar", "bar"];

/**
 * Both sequences in one pass, so that their order in the stream is their order
 * here — a mode change sends the shape and the colour together, and reading
 * them separately would be two answers about one moment.
 *
 * DECSCUSR is `CSI Ps SP q`: no other sequence puts a space before its final
 * byte, and the parameter class cannot run past a terminated one, so the match
 * is exact rather than a guess about the bytes around it. The two OSCs end at
 * either terminator, BEL or ST, because programs use both.
 */
const SEQUENCES =
  /\x1b\[([0-9;]*) q|\x1b\]12;([^\x07\x1b]{0,64})(?:\x07|\x1b\\)|\x1b\]112(?:;[^\x07\x1b]{0,64})?(?:\x07|\x1b\\)/g;

/**
 * The most of one that can be left hanging at the end of a chunk: an escape on
 * its own, a CSI with its parameter and space, or an OSC that has not reached
 * its terminator. Bounded at both ends — the window below and the class here —
 * so the carry between chunks can never grow into a buffer of its own.
 *
 * It cannot match a *complete* sequence, which is what stops one being reported
 * twice: every terminator is excluded from the class that would have to cross
 * it to reach the end of the string.
 */
const PARTIAL = /\x1b(?:\[[0-9;]{0,4} ?|\][0-9]{0,3}(?:;[^\x07\x1b]{0,48})?)?$/;
const PARTIAL_MAX = 56;

/** What one DECSCUSR parameter means. See `SHAPES` for why 0 is a null. */
function shapeFrom(params: string): ProgramCursor | null | undefined {
  /**
   * An empty parameter list is 1, a blinking block, which is what the spec
   * calls the default. Ghostty reads it as 0 instead and nothing sends it
   * either way; the spec is the tie-breaker.
   */
  const first = params.split(";")[0] ?? "";
  const param = first === "" ? 1 : Number(first);
  if (param === 0) return null;
  const style = SHAPES[param - 1];
  // Anything past 6 is not a shape this or any other terminal knows. The
  // nearest-legal-value argument is for numbers somebody dragged too far and
  // this is a name, so it falls through untouched rather than bending — and
  // untouched here means the cursor it already had, not the one in Settings.
  if (!style) return undefined;
  return { style, blink: param % 2 === 1 };
}

/**
 * What an `OSC 12` colour says, as something a canvas can be filled with.
 *
 * Normalised rather than passed through, and that is the whole of why this
 * function exists. The string arrives from a program in a pty and ends up as a
 * `fillStyle`, where an unparseable value is not an error — the canvas ignores
 * the assignment and goes on painting in whatever colour it was last given. So
 * a colour kururu cannot read has to be *refused* here, where refusing means
 * keeping the one the cursor already had, rather than handed on to be silently
 * dropped somewhere it looks like a bug.
 *
 * Hex and `rgb:` are what programs actually send — nvim sends `#rrggbb`. An X11
 * colour name is legal and is ignored rather than guessed at: the set is not
 * quite CSS's (X11 `green` is not CSS `green`), and a name is the one kind of
 * value with no nearest legal answer. A `?` is a *query* asking the terminal to
 * report its cursor colour back up the pty, which kururu has nowhere to answer
 * from, and it is refused here for free by not being a colour.
 */
function colorFrom(spec: string): string | undefined {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{12})$/i.exec(spec.trim());
  if (hex) {
    const digits = hex[1] ?? "";
    // Three widths, one meaning: #rgb doubles each digit, #rrrrggggbbbb is the
    // X11 form and keeps the high byte of each channel.
    const step = digits.length / 3;
    const channel = (index: number) => {
      const part = digits.slice(index * step, index * step + step);
      return (step === 1 ? part + part : part.slice(0, 2)).toLowerCase();
    };
    return `#${channel(0)}${channel(1)}${channel(2)}`;
  }
  const rgb = /^rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})$/i.exec(spec.trim());
  if (!rgb) return undefined;
  // Each channel is scaled from however many digits it was written with, which
  // is what makes `rgb:f/f/f` white rather than nearly black.
  const scale = (part: string) => {
    const value = Number.parseInt(part, 16);
    const max = 16 ** part.length - 1;
    return Math.round((value / max) * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${scale(rgb[1] ?? "")}${scale(rgb[2] ?? "")}${scale(rgb[3] ?? "")}`;
}

/** What the sequences asked for, and what may be the start of the next one. */
export interface CursorScan {
  /**
   * The last shape this chunk asked for — `null` where it asked for the user's
   * cursor back — or absent where the chunk said nothing about it, which is
   * nearly every chunk and means "carry on with what you had".
   */
  shape?: ProgramCursor | null;
  /** The same, for the colour: a `#rrggbb`, `null` for `OSC 112`, or absent. */
  color?: string | null;
  /**
   * A trailing fragment that could be the front of one, to be handed back on
   * the next call. A pty's writes are cut wherever the read happened to end, so
   * a five-byte sequence can arrive as two — and unlike a cut sequence written
   * into an emulator, which resynchronises, a cut sequence *scanned* is simply
   * never seen: neither half matches, and the cursor keeps a shape the program
   * has moved on from.
   */
  carry: string;
}

/**
 * Read the cursor out of a chunk of a terminal's output.
 *
 * Every byte a pane receives goes through here, so the cheap test comes first.
 * DECSCUSR is the only sequence with a space before its final byte, and the two
 * OSCs are the only ones that begin `ESC ] 1` and matter here, so a chunk with
 * neither in it cannot contain one — two `indexOf`s over a string the regex
 * engine would otherwise have to walk. Build output is thousands of writes a
 * second and none of them are this.
 */
export function scanCursor(chunk: string, carry = ""): CursorScan {
  const data = carry ? carry + chunk : chunk;
  const tail = data.length > PARTIAL_MAX ? data.slice(-PARTIAL_MAX) : data;
  const scan: CursorScan = { carry: PARTIAL.exec(tail)?.[0] ?? "" };
  if (data.indexOf(" q") < 0 && data.indexOf("\x1b]1") < 0) return scan;
  SEQUENCES.lastIndex = 0;
  for (let match = SEQUENCES.exec(data); match; match = SEQUENCES.exec(data)) {
    const [, params, spec] = match;
    if (params !== undefined) {
      const shape = shapeFrom(params);
      if (shape !== undefined) scan.shape = shape;
    } else if (spec !== undefined) {
      const color = colorFrom(spec);
      if (color !== undefined) scan.color = color;
    } else {
      // OSC 112, the only one of the three that can say nothing but "default".
      scan.color = null;
    }
  }
  return scan;
}

/**
 * The sequences that ask for this cursor, which is what a backlog carries.
 *
 * Written rather than remembered as a parameter, so that the one thing that
 * interprets these is the one that interprets them — the server holds a shape
 * and a colour because that is what it read off the same stream, and this turns
 * them back into the bytes the client is already reading.
 */
export function decscusr(cursor: ProgramCursor): string {
  const shape = SHAPES.indexOf(cursor.style);
  // Two parameters per shape, the blinking one first: block is 1 and 2,
  // underline 3 and 4, bar 5 and 6.
  const param = shape < 0 ? 0 : shape + (cursor.blink ? 1 : 2);
  return `\x1b[${param} q`;
}

/** The colour, likewise. BEL rather than ST, which is what nvim sends. */
export function osc12(color: string): string {
  return `\x1b]12;${color}\x07`;
}
