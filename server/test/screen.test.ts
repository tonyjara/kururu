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

/** The emulator inside a Screen, for comparing a rebuild against the original. */
function screenTerminal(screen: Screen): Terminal {
  return (screen as unknown as { term: Terminal }).term;
}
