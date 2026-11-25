/**
 * The credits and the art they are for: every sheet in `assets/mascots` has a
 * credit naming the same author, source and licence, every credit a licence
 * owes says so in `CREDITS.md` too, and every sheet is what its manifest says —
 * a whole number of square cells, with every clip on it and the trim the whole
 * cell. The last is the one that would show: a clip off the sheet's edge draws
 * nothing, and a trim smaller than the cell is how a sprite loses the top of
 * its head. These sheets were laid out so the cell *is* the sprite's box across
 * every frame, which is what makes the whole cell the right trim.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CREDITS, LICENCES } from "../src/credits";

const ROOT = join(import.meta.dir, "../..");
const MASCOTS = join(ROOT, "assets/mascots");

interface Clip {
  row: number;
  col: number;
  count: number;
  cycle: number;
}

interface Manifest {
  id: string;
  name: string;
  author: string;
  licence: string;
  source: string;
  credit?: string;
  frame: number;
  trim: { x: number; y: number; size: number };
  working: Clip;
  idle: Clip | null;
}

const ids = readdirSync(MASCOTS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

function manifest(id: string): Manifest {
  return JSON.parse(readFileSync(join(MASCOTS, id, "mascot.json"), "utf8")) as Manifest;
}

/** A PNG's width and height, off its IHDR, which is always the first chunk. */
function pngSize(id: string): { width: number; height: number } {
  const bytes = readFileSync(join(MASCOTS, id, "sheet.png"));
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("mascot credits", () => {
  it("has art to check", () => {
    expect(ids.length).toBeGreaterThan(0);
  });

  for (const id of ids) {
    it(`${id} is credited as its manifest says`, () => {
      const m = manifest(id);
      const credit = CREDITS.find((c) => c.source === m.source);
      expect(credit).toBeDefined();
      expect(credit!.author).toBe(m.author);
      expect(credit!.licence).toBe(m.licence);
      expect(credit!.mascots).toContain(m.name);
      if (m.credit) expect(credit!.line).toBe(m.credit);
      expect(readFileSync(join(MASCOTS, id, "LICENCE.txt"), "utf8")).toContain(m.source);
    });

    it(`${id}'s clips and trim are on its sheet`, () => {
      const m = manifest(id);
      const { width, height } = pngSize(id);
      expect(width % m.frame).toBe(0);
      expect(height % m.frame).toBe(0);
      for (const clip of [m.working, m.idle]) {
        if (!clip) continue;
        expect((clip.col + clip.count) * m.frame).toBeLessThanOrEqual(width);
        expect((clip.row + 1) * m.frame).toBeLessThanOrEqual(height);
      }
      expect(m.trim).toEqual({ x: 0, y: 0, size: m.frame });
    });
  }

  it("knows every licence it names", () => {
    for (const credit of CREDITS) expect(LICENCES[credit.licence]).toBeDefined();
  });

  it("says every credit a licence owes in CREDITS.md as well", () => {
    const file = readFileSync(join(ROOT, "CREDITS.md"), "utf8");
    for (const credit of CREDITS) {
      expect(file).toContain(credit.source);
      if (credit.line) expect(file).toContain(credit.line);
      if (credit.words) expect(file).toContain(credit.words);
    }
  });
});
