/**
 * The mascot is the one asset a user is invited to replace and the one selection
 * they are invited to make, so this pins the three things that would otherwise
 * rot unnoticed: that the sheets which ship are really there, that a name is
 * checked against the list rather than pasted into a path, and that a selection
 * survives a round trip through the disk with whatever it named gone.
 *
 * `ASSETS` is resolved once at import, so these run against the real
 * `assets/spritesheets` rather than a fixture — which is the point of the first
 * group. Everything a test does need to move lives behind an environment
 * variable read per call.
 */
import { describe, expect, it, afterAll, beforeAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MASCOT, adoptMascot } from "../../shared/model";
import {
  CUSTOM,
  customSheetPath,
  hasCustomSheet,
  readConfig,
  sheetFile,
  sheetImage,
  sheets,
  writeConfig,
} from "../src/mascot";

const tmp = join(realpathSync("/tmp"), `kururu-mascot-test-${process.pid}`);
const replacement = join(tmp, "mine.png");

/** Eight bytes is all it takes to be recognisably a PNG. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

beforeAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.KURURU_MASCOT;
  delete process.env.XDG_CONFIG_HOME;
});

describe("the sheets that ship", () => {
  it("are there, and the default names one of them", () => {
    expect(sheets()).toContain(DEFAULT_MASCOT.sheet);
  });

  it("are PNGs, since nothing else in here would notice if one rotted", () => {
    for (const name of sheets()) {
      expect(sheetImage(name)?.subarray(0, 8)).toEqual(PNG_MAGIC);
    }
  });

  it("do not include the guide, which is a key to the others and not a mascot", () => {
    expect(sheets()).not.toContain("guide");
    expect(sheetFile("guide")).toBeNull();
  });
});

describe("a sheet name", () => {
  it("is refused when it is a path rather than a name", () => {
    expect(sheetFile("../../../etc/passwd")).toBeNull();
    expect(sheetFile("green/../guide")).toBeNull();
    expect(sheetFile("/etc/passwd")).toBeNull();
  });

  it("is refused when it names nothing, rather than resolving to a missing file", () => {
    expect(sheetFile("nosuchsheet")).toBeNull();
    expect(sheetImage("nosuchsheet")).toBeNull();
  });
});

describe("a replacement", () => {
  it("is looked for under the config directory, not the state one", () => {
    delete process.env.KURURU_MASCOT;
    process.env.XDG_CONFIG_HOME = tmp;
    expect(customSheetPath()).toBe(join(tmp, "kururu", "mascot.png"));
    delete process.env.XDG_CONFIG_HOME;
  });

  it("is offered only once it is there, and handed over exactly as it was left", () => {
    process.env.KURURU_MASCOT = join(tmp, "nothing-here.png");
    expect(hasCustomSheet()).toBe(false);
    expect(sheetImage(CUSTOM)).toBeNull();

    const mine = Buffer.concat([PNG_MAGIC, Buffer.from("not really a png")]);
    writeFileSync(replacement, mine);
    process.env.KURURU_MASCOT = replacement;
    expect(hasCustomSheet()).toBe(true);
    expect(sheetImage(CUSTOM)).toEqual(mine);
  });

  it("is refused above a megabyte, since it ships to a phone on every load", () => {
    writeFileSync(replacement, Buffer.alloc(1024 * 1024 + 1));
    process.env.KURURU_MASCOT = replacement;
    expect(sheetImage(CUSTOM)).toBeNull();
  });
});

describe("the selection", () => {
  it("survives being written and read back", () => {
    process.env.XDG_CONFIG_HOME = tmp;
    const chosen = { ...DEFAULT_MASCOT, row: 2, col: 3, count: 6, cycle: 900 };
    writeConfig(chosen);
    expect(readConfig()).toEqual(chosen);
    delete process.env.XDG_CONFIG_HOME;
  });

  it("keeps the frames somebody chose when the sheet they were on is gone", () => {
    process.env.XDG_CONFIG_HOME = tmp;
    writeConfig({ ...DEFAULT_MASCOT, sheet: "deleted", row: 2, col: 3, count: 6 });
    const back = readConfig();
    expect(back.sheet).toBe(DEFAULT_MASCOT.sheet);
    expect([back.row, back.col, back.count]).toEqual([2, 3, 6]);
    delete process.env.XDG_CONFIG_HOME;
  });

  it("is the default when there is no file at all", () => {
    process.env.XDG_CONFIG_HOME = join(tmp, "empty");
    expect(readConfig()).toEqual(DEFAULT_MASCOT);
    delete process.env.XDG_CONFIG_HOME;
  });
});

describe("adopting one", () => {
  it("clamps a slider dragged too far rather than refusing it", () => {
    const wide = adoptMascot({ ...DEFAULT_MASCOT, count: 999, cycle: 1, row: -4 });
    expect(wide.count).toBe(64);
    expect(wide.cycle).toBe(80);
    expect(wide.row).toBe(0);
  });

  it("refuses a sheet that is a path, since there is no nearest legal name", () => {
    expect(adoptMascot({ ...DEFAULT_MASCOT, sheet: "../secrets" }).sheet).toBe(DEFAULT_MASCOT.sheet);
  });

  it("keeps the trim inside the cell, whatever the cell became", () => {
    const tight = adoptMascot({ ...DEFAULT_MASCOT, frame: 8 });
    expect(tight.trim.size).toBeLessThanOrEqual(8);
    expect(tight.trim.x + tight.trim.size).toBeLessThanOrEqual(8);
    expect(tight.trim.y + tight.trim.size).toBeLessThanOrEqual(8);
  });

  it("fills in a field a previous version of kururu never wrote", () => {
    expect(adoptMascot({ sheet: "green" }).motion).toBe(DEFAULT_MASCOT.motion);
    expect(adoptMascot(null)).toEqual(DEFAULT_MASCOT);
  });
});
