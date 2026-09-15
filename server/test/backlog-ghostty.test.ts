/**
 * The seam `screen.test.ts` does not cover: the two emulators are not the same
 * emulator.
 *
 * The server builds a backlog by serializing a headless **xterm** with
 * `SerializeAddon`, and the pane that receives it parses with **Ghostty**,
 * compiled to WASM. Those are two independent implementations of the same
 * standard, joined by a stream of escape sequences, and nothing in the types
 * says they have to agree — the serializer emits whatever it emits, and the
 * parser is entitled to read it differently. Where they disagree, the pane shows
 * something the server does not have, permanently: an agent redraws
 * differentially and will never resend a row it believes is already correct.
 *
 * That is the failure the sizing rework already cost a week, arriving by a new
 * road, so it gets the same treatment — draw a real agent screen, serialize it,
 * rebuild it in the emulator that is actually going to receive it, and compare
 * the rows. It is also the test that will notice a `ghostty-web` upgrade
 * changing something, which is the practical reason to keep it: the library is
 * pre-1.0 and pinned against an upstream C API that says so out loud.
 *
 * No pty and no renderer are involved. The WASM module parses perfectly well
 * with no DOM — only its canvas needs one, and nothing here draws.
 */
import { describe, expect, it } from "bun:test";
import { Terminal } from "@xterm/headless";
import { Ghostty, GhosttyTerminal, init } from "ghostty-web";
import { Screen } from "../src/agents/screen";

/** The emulator inside a Screen, for comparing a rebuild against the original. */
function screenTerminal(screen: Screen): Terminal {
  return (screen as unknown as { term: Terminal }).term;
}

/** The rows a person would see, out of the server's copy. */
function serverGrid(screen: Screen): string[] {
  const term = screenTerminal(screen);
  const buffer = term.buffer.active;
  return Array.from({ length: term.rows }, (_, y) =>
    (buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? "").replace(/\s+$/, ""),
  );
}

/** The same rows, out of a Ghostty terminal that was handed the backlog. */
function clientGrid(term: GhosttyTerminal, rows: number): string[] {
  return Array.from({ length: rows }, (_, y) => {
    let line = "";
    for (const cell of term.getLine(y) ?? []) {
      // A zero codepoint is an empty cell rather than a character; the
      // continuation half of a wide glyph reports zero width and no codepoint.
      line += cell.codepoint === 0 ? " " : String.fromCodePoint(cell.codepoint);
    }
    return line.replace(/\s+$/, "");
  });
}

/**
 * Instantiated once for the file. It is the expensive part of this test and it
 * holds no per-terminal state, so sharing it costs nothing and re-doing it for
 * every case would be most of the runtime.
 */
const ghostty = await init().then(() => Ghostty.load());

function rebuild(backlog: string, cols: number, rows: number): GhosttyTerminal {
  const term = new GhosttyTerminal(
    (ghostty as unknown as { exports: never }).exports,
    (ghostty as unknown as { memory: WebAssembly.Memory }).memory,
    cols,
    rows,
  );
  term.write(backlog);
  return term;
}

/**
 * An agent TUI: a shell prompt carrying the cwd, coloured output too wide for a
 * narrow pane, and an input box drawn with absolute cursor positioning — the
 * part that lands in the wrong place when rows have shifted, and the part a
 * serializer has to get right for a parser to put back where it was.
 */
function drawSession(screen: Screen, cols: number, rows: number): Promise<string> {
  screen.write("\x1b[2J\x1b[H");
  screen.write("nytoair@mac ~/Desktop/Nyto/kururu % claude\r\n");
  screen.write(
    `\x1b[1;32m✳\x1b[0m reading files and \x1b[31msaying something\x1b[0m ${"that does not fit a narrow pane ".repeat(2)}\r\n`,
  );
  screen.write(
    `\x1b[${rows - 2};1H╭${"─".repeat(cols - 2)}╮` +
      `\x1b[${rows - 1};1H│ > ${" ".repeat(cols - 6)}│` +
      `\x1b[${rows};1H╰${"─".repeat(cols - 2)}╯`,
  );
  return screen.backlog();
}

describe("a backlog serialized by xterm and parsed by Ghostty", () => {
  it("rebuilds the server's screen row for row", async () => {
    const screen = new Screen();
    const cols = 100;
    const rows = 30;
    screen.resize(cols, rows);
    const backlog = await drawSession(screen, cols, rows);

    expect(clientGrid(rebuild(backlog, cols, rows), rows)).toEqual(serverGrid(screen));
  });

  it("agrees at the grid a narrow pane asks for, since that is what it is sized to", async () => {
    const screen = new Screen();
    await drawSession(screen, screen.cols, screen.rows);

    // What `sendBacklog` does: resize to the asking pane's grid, then serialize.
    const cols = 60;
    const rows = 20;
    screen.resize(cols, rows);
    const backlog = await screen.backlog();

    expect(clientGrid(rebuild(backlog, cols, rows), rows)).toEqual(serverGrid(screen));
  });

  it("carries the colours an agent draws its status with", async () => {
    const screen = new Screen();
    screen.resize(40, 6);
    screen.write("\x1b[2J\x1b[H\x1b[31;1mRED\x1b[0m plain");
    const backlog = await screen.backlog();

    const cells = rebuild(backlog, 40, 6).getLine(0) ?? [];
    const red = cells[0];
    const plain = cells[4];
    // Whatever the palette resolves 31 to, the two must not be the same colour —
    // a serializer that drops SGR loses exactly this and nothing else visible.
    expect(red).toBeDefined();
    expect(plain).toBeDefined();
    expect([red?.fg_r, red?.fg_g, red?.fg_b]).not.toEqual([plain?.fg_r, plain?.fg_g, plain?.fg_b]);
  });
});
