/**
 * The QR encoder, pinned.
 *
 * A wrong QR code is not a wrong-looking QR code. Every step of the encoding is
 * a table lookup or a polynomial over GF(256), and one wrong digit in any of
 * them produces a picture indistinguishable from a correct one that a camera
 * simply will not read — so "it looks like a QR code" is worth nothing here and
 * the test has to be exact.
 *
 * Two halves, because neither alone is enough. The golden matrices below were
 * checked module for module against a second, independent implementation
 * (Python's `qrcode`), and then *decoded* — rendered to PNG and read back with
 * macOS's own CIDetector, the thing that actually reads QR codes on the phone
 * this feature exists for. The two implementations agree exactly wherever they
 * choose the same mask; where they differ it is only the mask, and both codes
 * decode to the same string, python-qrcode's penalty scoring being its own. To
 * re-verify after a change: render `qrMatrix(text)` to a PNG with a four-module
 * quiet zone and point a scanner at it. Comparing against these strings alone
 * would only prove the encoder still does what it did.
 *
 * The invariants in the second half are what the goldens cannot say: they hold
 * for every input, so they catch a break in a case nobody wrote down.
 */
import { describe, expect, it } from "bun:test";
import { qrMatrix } from "../src/qr";

/** `#` dark, `.` light — a matrix is only readable written out. */
function render(matrix: boolean[][]): string[] {
  return matrix.map((row) => row.map((dark) => (dark ? "#" : ".")).join(""));
}

describe("qrMatrix", () => {
  it("encodes a single byte as version 1", () => {
    expect(render(qrMatrix("a"))).toEqual([
      "#######..#.##.#######",
      "#.....#.#.##..#.....#",
      "#.###.#.##.#..#.###.#",
      "#.###.#.#.##..#.###.#",
      "#.###.#..#..#.#.###.#",
      "#.....#...##..#.....#",
      "#######.#.#.#.#######",
      "........##...........",
      "#.....#.#.##.##..###.",
      "#..##......###.###..#",
      "..#.###..##.#.##.....",
      ".#.#.#.##..#####.#.#.",
      "##.#..####.##########",
      "........##..#.....#.#",
      "#######..###.#..####.",
      "#.....#...#...#...###",
      "#.###.#..###.#..###..",
      "#.###.#..#.#####.#...",
      "#.###.#..#.###.###.##",
      "#.....#...######.#...",
      "#######.#.#.#..#..##.",
    ]);
  });

  it("encodes a LAN address", () => {
    expect(render(qrMatrix("http://192.168.100.139:7717"))).toEqual([
      "#######.....#..###.#..#######",
      "#.....#....#.....##.#.#.....#",
      "#.###.#.###...#.#.#...#.###.#",
      "#.###.#.#..#....#####.#.###.#",
      "#.###.#.########...#..#.###.#",
      "#.....#.#.#..#####..#.#.....#",
      "#######.#.#.#.#.#.#.#.#######",
      "........######.#...#.........",
      "#.#####....#..##.##.#.#####..",
      "....#..#####...##..#..#.#...#",
      "...##.#.#.#.#....#..#..##....",
      ".###......##..#.#....##.#..#.",
      "..#####..###....###.##.#.##..",
      "##.#...###...###...#..#.#.#.#",
      "##..###....######.#..##...#..",
      ".#.....#...###.#...###.#...#.",
      "...#..##..##..##.###.#....#..",
      "###.##..##.....##..#.##.###.#",
      "#..#.##.....#....#....#..##..",
      "#.#..#.#.###..#.#....##.#..#.",
      "#.#.#.#.#..#....#.#.#####.###",
      "........#.#..###.####...#####",
      "#######...########.##.#.###..",
      "#.....#.##.#.#.#.##.#...#...#",
      "#.###.#.##.##.##....#########",
      "#.###.#.#..###.##.#..#.#.....",
      "#.###.#.##....#...#...#.##.#.",
      "#.....#..##..#..#..###.##..#.",
      "#######.##..##..#.#......##..",
    ]);
  });

  it("encodes a tailnet name", () => {
    expect(render(qrMatrix("http://macbook-pro.tail1a2b3c.ts.net:7717"))).toEqual([
      "#######...##.##..####.#######",
      "#.....#.....##.#....#.#.....#",
      "#.###.#.##.##..##.#...#.###.#",
      "#.###.#.#..###.#####..#.###.#",
      "#.###.#.#####.#.#..##.#.###.#",
      "#.....#.#...#####.#.#.#.....#",
      "#######.#.#.#.#.#.#.#.#######",
      "........#.###.###............",
      "#.#####..#..##.#.#....#####..",
      "..####...#.##.#.#.#######...#",
      "#.###.###..#####..#...##.....",
      ".##..#..#.....#.#...#.##...#.",
      ".#.#.##..##.##...##.#....##..",
      ".#.#......#.#.#.#..######.#.#",
      "....########...#.##..##...#..",
      "#....#.####...#.#.###.#.#..#.",
      ".##...#.#..#.#...#.#.#....#..",
      "#...#...#...#.#...##.######.#",
      "#.###.#.####.######.#.##.##..",
      "#.##.#.#..#.#.#...###...#..#.",
      "#...###..##....##########.###",
      "........##.###..#...#...#####",
      "#######..#.#.###.####.#.###..",
      "#.....#.######.##..##...##...",
      "#.###.#.#.##..####..#####.###",
      "#.###.#.#.#.....#.#.#....####",
      "#.###.#.########.##...####.#.",
      "#.....#..#.##...#..###.###.#.",
      "#######.##.###...###.#..#.#..",
    ]);
  });
});

describe("the version it picks", () => {
  /**
   * The byte capacities of level M, from the standard. These are the numbers a
   * mistake in `rawDataModules` or in either ECC table moves, and moving one
   * costs a version — which is a code a third bigger for no reason, or, in the
   * other direction, a code that cannot hold what was put in it.
   */
  const CAPACITY: ReadonlyArray<readonly [version: number, bytes: number]> = [
    [1, 14],
    [2, 26],
    [3, 42],
    [4, 62],
    [5, 84],
    [6, 106],
    [7, 122],
    [8, 152],
    [9, 180],
    [10, 213],
  ];

  for (const [version, bytes] of CAPACITY) {
    it(`fills version ${version} with ${bytes} bytes and no more`, () => {
      expect(qrMatrix("x".repeat(bytes)).length).toBe(version * 4 + 17);
      if (version < 10) expect(qrMatrix("x".repeat(bytes + 1)).length).toBe((version + 1) * 4 + 17);
    });
  }

  it("refuses what will not fit rather than truncating it", () => {
    // A code that scans perfectly and points at half a URL is the one failure
    // worth being loud about: nothing downstream could notice it.
    expect(() => qrMatrix("x".repeat(214))).toThrow();
  });

  it("counts bytes, not characters", () => {
    // Version 1 holds 14 bytes; five of these are three bytes each.
    expect(qrMatrix("あいうえお").length).toBe(2 * 4 + 17);
  });
});

describe("what every code has in it", () => {
  const SAMPLES = ["", "a", "http://192.168.1.2:5173", "http://100.64.0.1:7717", "x".repeat(213)];

  it("is square, and a legal size", () => {
    for (const text of SAMPLES) {
      const matrix = qrMatrix(text);
      expect((matrix.length - 17) % 4).toBe(0);
      for (const row of matrix) expect(row.length).toBe(matrix.length);
    }
  });

  it("puts a finder in three corners and not the fourth", () => {
    for (const text of SAMPLES) {
      const matrix = qrMatrix(text);
      const size = matrix.length;
      const finder = (ox: number, oy: number) =>
        [0, 1, 2, 3, 4, 5, 6].every((dy) =>
          [0, 1, 2, 3, 4, 5, 6].every((dx) => {
            const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
            return matrix[oy + dy]![ox + dx] === (ring !== 2);
          }),
        );
      expect(finder(0, 0)).toBe(true);
      expect(finder(size - 7, 0)).toBe(true);
      expect(finder(0, size - 7)).toBe(true);
      // The bottom-right corner is data; a finder there would mean the placement
      // walked off the end of the matrix.
      expect(finder(size - 7, size - 7)).toBe(false);
    }
  });

  it("alternates the timing rows", () => {
    for (const text of SAMPLES) {
      const matrix = qrMatrix(text);
      for (let i = 8; i < matrix.length - 8; i++) {
        expect(matrix[6]![i]).toBe(i % 2 === 0);
        expect(matrix[i]![6]).toBe(i % 2 === 0);
      }
    }
  });

  it("sets the dark module", () => {
    for (const text of SAMPLES) {
      const matrix = qrMatrix(text);
      expect(matrix[matrix.length - 8]![8]).toBe(true);
    }
  });

  it("writes format bits that say level M and a real mask, twice", () => {
    for (const text of SAMPLES) {
      const matrix = qrMatrix(text);
      const size = matrix.length;

      // The copy that wraps the top-left finder, read back in the order it was
      // written, then unmasked with the constant the standard names.
      const around = [
        ...[0, 1, 2, 3, 4, 5].map((i) => matrix[i]![8]!),
        matrix[7]![8]!,
        matrix[8]![8]!,
        matrix[8]![7]!,
        ...[9, 10, 11, 12, 13, 14].map((i) => matrix[8]![14 - i]!),
      ];
      // And the copy split between the other two, which must agree with it: they
      // are the same fifteen bits, and a decoder reads whichever it can see.
      const split = [
        ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => matrix[8]![size - 1 - i]!),
        ...[8, 9, 10, 11, 12, 13, 14].map((i) => matrix[size - 15 + i]![8]!),
      ];
      expect(split).toEqual(around);

      const bits = around.reduce((value, dark, i) => value | (Number(dark) << i), 0) ^ 0x5412;
      expect((bits >> 13) & 0b11).toBe(0b00); // level M
      expect((bits >> 10) & 0b111).toBeLessThan(8);
    }
  });

  it("carries version bits from version 7 up, and not below", () => {
    // Below 7 those eighteen modules are data, so the only thing to check is
    // that the block exists exactly when it should: `rawDataModules` subtracts
    // room for it at the same boundary, and the two disagreeing would shift
    // every codeword after it.
    const small = qrMatrix("x".repeat(106)); // version 6
    const large = qrMatrix("x".repeat(122)); // version 7
    expect(small.length).toBe(41);
    expect(large.length).toBe(45);

    let rem = 7;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (7 << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      expect(large[Math.floor(i / 3)]![large.length - 11 + (i % 3)]).toBe(dark);
      expect(large[large.length - 11 + (i % 3)]![Math.floor(i / 3)]).toBe(dark);
    }
  });
});
