/**
 * A terminal, with nobody looking at it.
 *
 * The browser runs a real emulator now, so this one is no longer here to render
 * anything — the bytes go straight down the socket and xterm.js draws them. What
 * it is here for is the gap: a terminal you open ten minutes after the agent
 * started has missed everything it said, and a pty cannot be asked to say it
 * again.
 *
 * So every pty gets a headless emulator that has been fed all of it, and opening
 * a terminal hands the client a *reconstruction* of that state rather than a
 * replay of the raw stream. The difference matters. Raw bytes trimmed to a
 * budget get cut mid-escape-sequence, and a cut sequence does not render as
 * slightly-wrong output — it swallows whatever follows it until something
 * resynchronises. Serializing the emulator's buffer instead produces sequences
 * that are whole by construction, and it handles the alternate screen, which a
 * ring buffer of bytes cannot.
 *
 * The cost is that every pty is parsed whether or not anyone is watching, where
 * before only watched ones were. That is the price of instant history, and it is
 * a parse, not a render: there is no renderer, no DOM and no WebGL in here.
 */
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/headless";
import { decscusr, osc12, type ProgramCursor, scanCursor } from "../../../shared/cursor";
import { cleanTitle } from "../../../shared/model";

/**
 * The grid a pty is born with, before any client has said how big its pane is.
 * It is a starting guess and nothing more — the first terminal to open on it
 * resizes both this emulator and the pty underneath. Wide enough that an agent
 * which draws itself immediately does not do it inside 80 columns.
 */
const COLS = Number(process.env.KURURU_COLS) || 120;
const ROWS = Number(process.env.KURURU_ROWS) || 40;

export const screenSize = { cols: COLS, rows: ROWS };

/**
 * How much history a terminal keeps, and therefore how much a newly-opened one
 * is given. Large enough to scroll back through a build, small enough that a
 * dozen idle agents are not worth thinking about.
 */
const SCROLLBACK = 5000;
/** How much of that scrollback is actually sent. Opening a pane should be instant. */
const BACKLOG_LINES = 1500;

export class Screen {
  private term: Terminal;
  private serializer: SerializeAddon;
  /**
   * xterm parses on its own schedule, so a write is not in the buffer the moment
   * it returns. Serializing without waiting for the queue to drain silently
   * loses the newest output — which is the output somebody just opened a pane to
   * see.
   */
  private pending = 0;
  private drained: (() => void)[] = [];

  /**
   * What the program in this pty last called itself, cleaned. Kept here rather
   * than in the host because the title arrives the same way everything else
   * does — as an escape sequence in the stream — and this is the only thing in
   * kururu that parses one. The host would otherwise have to sniff for OSC 2
   * beside an emulator that is already doing it properly.
   */
  private titleText = "";

  /**
   * Called when that answer *changes*. Not on every OSC 2: an agent repaints its
   * title constantly and almost all of those repeats are the spinner frame that
   * `cleanTitle` takes off, so comparing here is what keeps a working agent from
   * putting a snapshot on every socket ten times a second.
   */
  onTitle: (title: string) => void = () => {};

  /**
   * The cursor the program in this pty has asked for: its shape and its colour,
   * each null until something asks.
   *
   * Read off the stream on the way past rather than out of the emulator, and
   * `shared/cursor.ts` makes that case at length. The short version is that the
   * client reads the same bytes with the same function, so the screen it is
   * handed and the output it is fed can never disagree about the cursor — which
   * is the only reason this is written down at all.
   */
  private cursor: { shape: ProgramCursor | null; color: string | null } = {
    shape: null,
    color: null,
  };
  private cursorCarry = "";

  constructor() {
    this.term = new Terminal({
      cols: COLS,
      rows: ROWS,
      allowProposedApi: true,
      scrollback: SCROLLBACK,
    });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
    this.term.onTitleChange((raw) => {
      const title = cleanTitle(raw);
      if (title === this.titleText) return;
      this.titleText = title;
      this.onTitle(title);
    });
  }

  /** The program's own name for itself, or "" if it has never said. */
  get title(): string {
    return this.titleText;
  }

  write(data: string): void {
    const scan = scanCursor(data, this.cursorCarry);
    this.cursorCarry = scan.carry;
    if (scan.shape !== undefined) this.cursor.shape = scan.shape;
    if (scan.color !== undefined) this.cursor.color = scan.color;
    this.pending++;
    this.term.write(data, () => {
      if (--this.pending > 0) return;
      const waiting = this.drained;
      this.drained = [];
      for (const resolve of waiting) resolve();
    });
  }

  /**
   * Follow the pane. The emulator has to be the same shape as the pty or the
   * history it hands out was laid out for a width that is no longer on screen.
   */
  resize(cols: number, rows: number): void {
    if (cols === this.term.cols && rows === this.term.rows) return;
    this.term.resize(cols, rows);
  }

  get cols(): number {
    return this.term.cols;
  }

  get rows(): number {
    return this.term.rows;
  }

  /**
   * Whether the program in here has asked for the cursor to be hidden.
   *
   * Reached for through `_core` because it is on none of the roads a backlog
   * would otherwise travel: xterm's public API does not expose it, and the
   * serializer's `_serializeModes` restores eight modes — application cursor
   * keys, bracketed paste, insert, origin, wraparound, focus reporting and
   * mouse tracking — of which DECTCEM is not one. That is not a new kind of
   * reach, either: the serializer itself goes through `_core` for the current
   * attributes it ends every screen with.
   */
  private get cursorHidden(): boolean {
    const internals = this.term as unknown as {
      _core?: { coreService?: { isCursorHidden?: boolean } };
    };
    return internals._core?.coreService?.isCursorHidden === true;
  }

  /**
   * Everything said so far, as the escape sequences that rebuild it — plus the
   * two pieces of state a serialized screen does not carry.
   *
   * A backlog is applied by resetting the client's emulator and writing this,
   * and ghostty-web's `reset()` does not clear a terminal so much as build a new
   * one: the WASM terminal is freed and replaced, so every mode goes back to its
   * default and the cursor comes back **visible**. Nothing in the serialized
   * screen then says otherwise, because DECTCEM is not one of the modes the
   * serializer restores. The pty's own cursor position is restored, though — and
   * for an agent drawing its own block cursor in an input box, the real one is
   * hidden and parked at home. So the pane came up with a blinking block in its
   * top-left corner, sitting on nothing, and it stayed there forever: an Ink TUI
   * hides the cursor once at startup and never mentions it again, so there was
   * no later byte that would have put it right.
   *
   * It was only ever visible in the *focused* pane, which is what made it look
   * like a focus bug rather than a backlog one — the unfocused panes were
   * drawing no cursor at all by then, for the unrelated reason in
   * `web/src/terminals.ts`.
   *
   * The cursor's *shape and colour* are the same hole with a quieter symptom,
   * and they are here for the same reason. An editor says that insert mode is a
   * grey bar by sending DECSCUSR and OSC 12 once, when the mode changes; a pane
   * opened after that has missed both and would draw the block from Settings
   * over an nvim sitting in insert, until the next keystroke that changed mode
   * put it right. So they go on the end as the sequences a program would have
   * sent, and `shared/cursor.ts` is the one thing that interprets them.
   */
  async backlog(): Promise<string> {
    if (this.pending > 0) await new Promise<void>((resolve) => this.drained.push(resolve));
    const screen = this.serializer.serialize({ scrollback: BACKLOG_LINES });
    const { shape, color } = this.cursor;
    return (
      screen +
      (shape ? decscusr(shape) : "") +
      (color ? osc12(color) : "") +
      (this.cursorHidden ? "\x1b[?25l" : "")
    );
  }

  dispose(): void {
    this.serializer.dispose();
    this.term.dispose();
  }
}
