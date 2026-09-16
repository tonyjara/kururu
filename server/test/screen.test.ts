/**
 * The one property a backlog has to have: a pane that writes it ends up with
 * the same grid the server serialized.
 *
 * This is the bug the sizing rework exists for, and it is worth a test because
 * nothing about it is visible from the types. A backlog is the server's emulator
 * serialized, and a serialized screen is laid out at a particular width — write
 * it into a grid of any other one and every row longer than the target wraps,
 * the rows below slide down, and the top of the screen scrolls away. The client
 * and the server then disagree about where everything is, permanently, because
 * an agent redraws differentially and will never resend a row it believes is
 * already correct. That disagreement was the borked text on a workspace switch
 * and the cwd sitting inside an agent's input box.
 *
 * So: serialize, reconstruct, compare the two buffers cell for cell. No pty is
 * involved — `Screen` is a headless emulator and this is the same kind of test
 * as the pane tree's.
 */
import { describe, expect, it } from "bun:test";
import { Terminal } from "@xterm/headless";
import { scanCursor } from "../../shared/cursor";
import { Screen } from "../src/agents/screen";

/** What a terminal holds, as the rows a person would see. */
function grid(term: Terminal): string[] {
  const buffer = term.buffer.active;
  const rows: string[] = [];
  for (let y = 0; y < term.rows; y++) {
    rows.push(buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? "");
  }
  return rows;
}

const write = (term: Terminal, data: string) =>
  new Promise<void>((resolve) => term.write(data, resolve));

/**
 * An agent TUI: a shell prompt carrying the cwd, some output too wide to fit a
 * narrower pane, and an input box drawn with absolute cursor positioning — which
 * is the part that lands in the wrong place when the rows have shifted.
 */
async function drawSession(screen: Screen, cols: number, rows: number): Promise<void> {
  screen.write("\x1b[2J\x1b[H");
  screen.write("nytoair@mac ~/Desktop/Nyto/kururu % claude\r\n");
  screen.write(`${"reading files and saying something that does not fit a narrow pane ".repeat(2)}\r\n`);
  screen.write(
    `\x1b[${rows - 2};1H╭${"─".repeat(cols - 2)}╮` +
      `\x1b[${rows - 1};1H│ > ${" ".repeat(cols - 6)}│` +
      `\x1b[${rows};1H╰${"─".repeat(cols - 2)}╯`,
  );
  await screen.backlog();
}

/** The client half: a fresh emulator, sized and filled the way Terminal.tsx does. */
async function rebuild(backlog: string, cols: number, rows: number): Promise<Terminal> {
  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 5000 });
  await write(term, backlog);
  return term;
}

describe("backlog", () => {
  it("rebuilds a pane exactly when the screen was sized to it first", async () => {
    const screen = new Screen();
    await drawSession(screen, screen.cols, screen.rows);

    // What `sendBacklog` does: the asking pane's grid, then serialize.
    const cols = 100;
    const rows = 30;
    screen.resize(cols, rows);
    const backlog = await screen.backlog();

    const client = await rebuild(backlog, cols, rows);
    expect(grid(client)).toEqual(grid(screenTerminal(screen)));
  });

  it("wraps and loses the top when the grids disagree, which is the bug", async () => {
    const screen = new Screen();
    await drawSession(screen, screen.cols, screen.rows);

    // The old order: serialize at whatever the screen happened to be, and let
    // the pane's real size arrive afterwards on the resize debounce.
    const backlog = await screen.backlog();
    const client = await rebuild(backlog, 100, 30);

    screen.resize(100, 30);
    expect(grid(client)).not.toEqual(grid(screenTerminal(screen)));
  });

  it("reflows an exited agent's frozen screen, since it is the only record left", async () => {
    const screen = new Screen();
    await drawSession(screen, screen.cols, screen.rows);
    screen.resize(80, 24);
    expect(screen.cols).toBe(80);
    expect(screen.rows).toBe(24);

    const backlog = await screen.backlog();
    const client = await rebuild(backlog, 80, 24);
    expect(grid(client)).toEqual(grid(screenTerminal(screen)));
  });
});

/**
 * The cursor an agent has hidden, which a serialized screen does not carry.
 *
 * A pane applies a backlog by resetting its emulator and writing it, and a reset
 * puts every mode back to its default — including a visible cursor. The screen
 * restores where the cursor *is* and says nothing about whether it should be
 * drawn, so an agent that hides the real cursor and paints its own block in an
 * input box handed every newly-opened pane a blinking cursor in its top-left
 * corner, parked where the hidden one happened to be sitting. It stayed there
 * for good: the sequence is sent once at startup and never again.
 */
describe("a cursor the program has hidden", () => {
  /** What a fresh emulator says about the cursor after a backlog is written in. */
  const hidden = (term: Terminal) =>
    (term as unknown as { _core: { coreService: { isCursorHidden: boolean } } })._core.coreService
      .isCursorHidden;

  it("survives the rebuild, because a reset would otherwise show it again", async () => {
    const screen = new Screen();
    await drawSession(screen, screen.cols, screen.rows);
    // DECTCEM off and the cursor parked at home: an Ink TUI mid-turn.
    screen.write("\x1b[?25l\x1b[H");

    const backlog = await screen.backlog();
    const client = await rebuild(backlog, screen.cols, screen.rows);

    expect(hidden(client)).toBe(true);
  });

  it("leaves a shell's cursor alone, which is the other half of it", async () => {
    const screen = new Screen();
    screen.write("nytoair@mac ~ % ");

    const backlog = await screen.backlog();
    const client = await rebuild(backlog, screen.cols, screen.rows);

    expect(hidden(client)).toBe(false);
  });
});

/**
 * The shape a program asked its cursor to be, which a serialized screen does
 * not carry either.
 *
 * An editor sends DECSCUSR once, at the moment the mode changes. A pane opened
 * after that has missed it, so without this the cursor in Settings is drawn
 * over an nvim sitting in insert mode — and it stays wrong until the next
 * keystroke that happens to change mode, which for somebody reading a file is
 * a while. The client reads the sequence out of the stream (`shared/cursor.ts`,
 * and `web/src/terminals.ts` for what it does with it), so the backlog only has
 * to put it back where the client is already looking.
 */
describe("the cursor shape a program asked for", () => {
  it("rides the backlog, so a pane opened late draws the one nvim asked for", async () => {
    const screen = new Screen();
    screen.write("nytoair@mac ~/Desktop/Nyto/kururu % nvim\r\n");
    // Insert mode under the default guicursor: a steady bar.
    screen.write("\x1b[6 q");

    expect(scanCursor(await screen.backlog()).shape).toEqual({ style: "bar", blink: false });
  });

  it("keeps the blink the program asked for, which is the other half of it", async () => {
    const screen = new Screen();
    screen.write("\x1b[3 q");
    expect(scanCursor(await screen.backlog()).shape).toEqual({ style: "underline", blink: true });
  });

  it("says nothing once the program has handed the decision back", async () => {
    const screen = new Screen();
    screen.write("\x1b[6 q");
    // What nvim sends on the way out: the terminal's own cursor, not a shape.
    screen.write("\x1b[0 q");

    expect(scanCursor(await screen.backlog()).shape).toBeUndefined();
  });

  it("says nothing about a shell, which has never had an opinion", async () => {
    const screen = new Screen();
    screen.write("nytoair@mac ~ % ");
    expect(scanCursor(await screen.backlog()).shape).toBeUndefined();
  });

  it("carries the colour beside it, since a mode change sends both", async () => {
    const screen = new Screen();
    // What nvim sends entering insert under the stock guicursor.
    screen.write("\x1b[6 q\x1b]12;#787878\x07");

    const scan = scanCursor(await screen.backlog());
    expect(scan.shape).toEqual({ style: "bar", blink: false });
    expect(scan.color).toBe("#787878");
  });

  it("stops carrying the colour once the program has reset it", async () => {
    const screen = new Screen();
    screen.write("\x1b]12;#9745be\x07");
    screen.write("\x1b]112\x07");
    expect(scanCursor(await screen.backlog()).color).toBeUndefined();
  });

  it("sees a sequence the pty cut in half, since the reads are its own", async () => {
    const screen = new Screen();
    // A pty hands over whatever the read returned, and the boundary is nobody's
    // decision. The emulator resynchronises on its own; the scan beside it has
    // to be told to.
    screen.write("\x1b[6 q\x1b]12;#78");
    screen.write("7878\x07");
    expect(scanCursor(await screen.backlog()).color).toBe("#787878");
  });

  it("does not disturb the screen it is appended to", async () => {
    const screen = new Screen();
    await drawSession(screen, screen.cols, screen.rows);
    screen.write("\x1b[6 q");

    const backlog = await screen.backlog();
    const client = await rebuild(backlog, screen.cols, screen.rows);
    expect(grid(client)).toEqual(grid(screenTerminal(screen)));
  });
});

/**
 * The title an agent sets, and the two things the emulator has to do with it.
 *
 * Reading it at all is the feature — a tab strip of four claudes is unreadable
 * until each one is called after the work it is doing. The filtering is what
 * makes it affordable: claude leads its title with a status glyph and spins a
 * braille frame there while it works, so the raw sequence arrives many times a
 * second saying the same words, and every one of those would otherwise be a
 * snapshot on every open socket.
 */
describe("a title a program sets", () => {
  /** OSC 2, the sequence a shell or an agent names its window with. */
  const osc2 = (title: string) => `\x1b]2;${title}\x07`;

  /** Screen parses on its own schedule; backlog() is what waits for the queue. */
  const settle = (screen: Screen) => screen.backlog();

  it("arrives with the agent's own status glyph taken off", async () => {
    const screen = new Screen();
    screen.write(osc2("✳ Merge pane-drag changes"));
    await settle(screen);
    expect(screen.title).toBe("Merge pane-drag changes");
  });

  it("says nothing when only the spinner frame moved", async () => {
    const screen = new Screen();
    const seen: string[] = [];
    screen.onTitle = (title) => seen.push(title);

    screen.write(osc2("✳ Test backlog replay sequence"));
    for (const frame of ["⠋", "⠙", "⠹", "⠸"]) {
      screen.write(osc2(`${frame} Test backlog replay sequence`));
    }
    await settle(screen);

    expect(seen).toEqual(["Test backlog replay sequence"]);
  });

  it("reports the new words when the work actually changes", async () => {
    const screen = new Screen();
    const seen: string[] = [];
    screen.onTitle = (title) => seen.push(title);

    screen.write(osc2("✳ First turn"));
    screen.write(osc2("⠋ First turn"));
    screen.write(osc2("✳ Second turn"));
    await settle(screen);

    expect(seen).toEqual(["First turn", "Second turn"]);
  });

  it("keeps a shell's plain title, which has no glyph to lose", async () => {
    const screen = new Screen();
    screen.write(osc2("~/Desktop/Nyto/kururu"));
    await settle(screen);
    expect(screen.title).toBe("~/Desktop/Nyto/kururu");
  });
});

/** The emulator inside a Screen, for comparing a rebuild against the original. */
function screenTerminal(screen: Screen): Terminal {
  return (screen as unknown as { term: Terminal }).term;
}
