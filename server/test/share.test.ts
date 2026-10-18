/**
 * `bun run share`: which address the phone is given, and the code drawn in
 * the terminal. The addresses are neutral ones, never a real machine's.
 */
import { describe, expect, it } from "bun:test";
import { qrLines, shareUrl, type ReachAnswer } from "../src/share-cli";
import { qrMatrix } from "../../web/src/qr";

const base: ReachAnswer = { port: 7717, lan: ["192.168.1.20"], tailscale: "100.101.102.103", shared: true, wanted: true, token: "t0k/en", restartable: true };

describe("shareUrl", () => {
  it("is nothing for a server on this machine only", () => {
    expect(shareUrl({ ...base, shared: false })).toBeNull();
  });

  it("is the one address a child listens on, with the token", () => {
    expect(shareUrl({ ...base, listening: ["100.64.0.9", "127.0.0.1"] })).toBe("http://100.64.0.9:7717/?k=t0k%2Fen");
  });

  it("is the tailnet, then the LAN, for a server on every address", () => {
    expect(shareUrl({ ...base, listening: ["0.0.0.0"] })).toBe("http://100.101.102.103:7717/?k=t0k%2Fen");
    expect(shareUrl({ ...base, tailscale: null, listening: ["0.0.0.0"] })).toBe("http://192.168.1.20:7717/?k=t0k%2Fen");
  });

  it("is nothing when there is no address anybody else could reach", () => {
    expect(shareUrl({ ...base, tailscale: null, lan: [], listening: ["0.0.0.0"] })).toBeNull();
  });
});

describe("qrLines", () => {
  const matrix = qrMatrix("http://100.101.102.103:7717/?k=abcdefghijklmnopqrstuvwxyz012345");
  const lines = qrLines(matrix);

  it("puts two modules in a line, with the quiet zone on every side", () => {
    expect(lines).toHaveLength(Math.ceil((matrix.length + 8) / 2));
  });

  it("names both colours in every cell, so no theme can invert it", () => {
    const cells = lines[0]!.match(/\x1b\[(30|97);(40|107)m▀/g) ?? [];
    expect(cells).toHaveLength(matrix.length + 8);
  });

  it("draws the quiet zone light and a finder pattern's corner dark", () => {
    expect(lines[0]!.startsWith("\x1b[97;107m▀")).toBe(true);
    // Row 4 is the code's first row; its fifth cell is the top-left finder's corner.
    const cells = lines[2]!.match(/\x1b\[(\d+);(\d+)m▀/g)!;
    expect(cells[4]).toBe("\x1b[30;40m▀");
  });
});
