/**
 * How a terminal's mouse reports are *written*, kept because the backlog cannot
 * say it.
 *
 * A program that wants the mouse turns on two independent things: a tracking
 * mode, which decides *when* a report is sent (`?1000` click, `?1002` drag,
 * `?1003` any motion), and an encoding, which decides what the report *looks
 * like* (`?1006` SGR, `?1016` SGR-pixels, and the 1978 default if neither).
 * `@xterm/addon-serialize` restores the first group and not the second — it has
 * no line for `?1006` — so a reconstructed screen comes back with the mouse
 * still on and its encoding silently reset to the legacy one.
 *
 * That combination is worse than either mode alone, because the legacy encoding
 * is not a variant spelling: it is `ESC [ M` followed by three *raw bytes*,
 * each a coordinate plus 32. A program that asked for SGR does not expect them,
 * and a stray byte in a terminal is a keystroke. Neovim, whose leader key is
 * space, receives exactly `0x20` as the first byte of every plain left-click —
 * so a click in the wrong corner of the pane runs whatever the user bound to
 * `<leader>` plus two letters. That is the bug this exists to stop, and it was
 * found as `<leader>dc` starting a debug session on the dashboard.
 *
 * So the server watches the encoding go by on the way out and says it again
 * after the backlog. Only the program that set it knows what it wants, and only
 * this link is in a position to repeat it: an agent has no idea a client went
 * away and came back, and the ones that repaint their modes on every draw —
 * Claude Code is one — are the reason this looked intermittent rather than
 * broken.
 *
 * Kept in order rather than as a set: the last encoding enabled is the one in
 * force, so replaying them in the order they arrived reproduces the emulator's
 * state exactly, including the case where a program moved from one to another.
 */

/** DECSET numbers that choose an encoding. Anything else is somebody's tracking mode. */
const ENCODINGS = new Set([1005, 1006, 1015, 1016]);

/** `ESC [ ? <params> h|l`. The `$p` of a DECRQM cannot match, which is the point of the anchor. */
const DEC_PRIVATE = /\x1b\[\?([\d;]{1,64})([hl])/g;

/**
 * How much of the previous chunk to re-scan. Output arrives in whatever sizes
 * the pty felt like, so a mode can be cut in half by a chunk boundary — and a
 * mode set once, at startup, is exactly the one that must not be missed. Longer
 * than any DECSET worth writing; re-matching what was already matched costs
 * nothing, because setting the same encoding twice is setting it once.
 */
const CARRY = 72;

export class MouseEncoding {
  private order: number[] = [];
  private carry = "";

  /** Watch a chunk of output go past. */
  read(data: string): void {
    const window = this.carry + data;
    DEC_PRIVATE.lastIndex = 0;
    for (let m = DEC_PRIVATE.exec(window); m; m = DEC_PRIVATE.exec(window)) {
      const [, params = "", action] = m;
      const on = action === "h";
      for (const param of params.split(";")) {
        const mode = Number(param);
        if (!ENCODINGS.has(mode)) continue;
        // Off, or on again later than before: either way it leaves its old place.
        const at = this.order.indexOf(mode);
        if (at !== -1) this.order.splice(at, 1);
        if (on) this.order.push(mode);
      }
    }
    this.carry = window.slice(-CARRY);
  }

  /**
   * What to append to a backlog so the emulator rebuilding it encodes the mouse
   * the way the program asked. Empty for the overwhelming majority of terminals,
   * which never touch the mouse at all.
   */
  suffix(): string {
    return this.order.map((mode) => `\x1b[?${mode}h`).join("");
  }
}
