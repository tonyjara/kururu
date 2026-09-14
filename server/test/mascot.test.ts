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
import { existsSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MASCOT, adoptMascot, adoptMascots, isSheetName, slugSheetName } from "../../shared/model";
import {
  adoptLegacySheet,
  builtinSheets,
  freshMascotId,
  importSheet,
  importedSheets,
  readMascots,
  removeSheet,
  sheetFile,
  sheetImage,
  sheets,
  sheetsDir,
  writeMascots,
} from "../src/mascot";

const tmp = join(realpathSync("/tmp"), `kururu-mascot-test-${process.pid}`);

/** The smallest thing that passes for a PNG: the magic, and something after it. */
const png = (extra = "a sheet") => Buffer.concat([PNG_MAGIC, Buffer.from(extra)]);

/** Eight bytes is all it takes to be recognisably a PNG. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

beforeAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.XDG_CONFIG_HOME;
});

/** Every test that touches the user's side of things gets an empty one. */
function ownConfig(name: string): string {
  const dir = join(tmp, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  process.env.XDG_CONFIG_HOME = dir;
  return dir;
}

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

describe("importing a sheet", () => {
  it("lands in the sheets directory and is offered from then on", () => {
    ownConfig("import");
    expect(importSheet("mine", png())).toEqual({ ok: true, name: "mine" });
    expect(importedSheets()).toEqual(["mine"]);
    expect(sheets()).toContain("mine");
    expect(sheetImage("mine")).toEqual(png());
  });

  /**
   * This endpoint writes a file to the user's config directory on behalf of a
   * client, and kururu is reachable from the tailnet — so the name has to be a
   * name, the bytes have to be what they claim, and neither is a formality.
   */
  it("refuses a name that is a path rather than a name", () => {
    ownConfig("hostile");
    for (const name of ["../escape", "green/../x", "/etc/passwd", "", "Mine"]) {
      expect(importSheet(name, png()).ok).toBe(false);
    }
    expect(importedSheets()).toEqual([]);
  });

  it("refuses bytes that are not a PNG, rather than saving them to fail later", () => {
    ownConfig("notpng");
    const answer = importSheet("mine", Buffer.from("GIF89a and then some"));
    expect(answer).toEqual({ ok: false, error: "that file is not a PNG" });
    expect(importedSheets()).toEqual([]);
  });

  it("refuses a screenshot, since a sheet ships to a phone on every load", () => {
    ownConfig("huge");
    const big = Buffer.concat([PNG_MAGIC, Buffer.alloc(1024 * 1024)]);
    expect(importSheet("mine", big).ok).toBe(false);
  });

  it("refuses to shadow a name that is already taken, rather than overwriting it", () => {
    ownConfig("collide");
    importSheet("mine", png("first"));
    expect(importSheet("mine", png("second")).ok).toBe(false);
    expect(importSheet(DEFAULT_MASCOT.sheet, png()).ok).toBe(false);
    // The one that was there is still the one that is there.
    expect(sheetImage("mine")).toEqual(png("first"));
  });

  it("is removable again, but only what was imported", () => {
    ownConfig("remove");
    importSheet("mine", png());
    expect(removeSheet("mine")).toBe(true);
    expect(importedSheets()).toEqual([]);
    // What ships is not the user's to delete from in here.
    expect(removeSheet(DEFAULT_MASCOT.sheet)).toBe(false);
    expect(builtinSheets()).toContain(DEFAULT_MASCOT.sheet);
  });

  /**
   * The single slot an older kururu had. Moving it means the file somebody put
   * there keeps working instead of being stranded beside the directory that
   * replaced it.
   */
  it("adopts the one-slot sheet an older kururu supported", () => {
    const dir = ownConfig("legacy");
    mkdirSync(join(dir, "kururu"), { recursive: true });
    writeFileSync(join(dir, "kururu", "mascot.png"), png("old"));
    adoptLegacySheet();
    expect(importedSheets()).toEqual(["mascot"]);
    expect(sheetImage("mascot")).toEqual(png("old"));
    expect(existsSync(join(dir, "kururu", "mascot.png"))).toBe(false);
  });

  it("is where the dialog says it is", () => {
    const dir = ownConfig("where");
    expect(sheetsDir()).toBe(join(dir, "kururu", "sheets"));
  });
});

describe("the name a file gets", () => {
  it("is the filename, made into one", () => {
    expect(slugSheetName("Frog Jump (2).png")).toBe("frog-jump-2");
    expect(slugSheetName("my_sheet-v2.PNG")).toBe("my-sheet-v2");
  });

  it("is something rather than nothing, since a filename is a poor thing to refuse over", () => {
    expect(slugSheetName("___.png")).toBe("sheet");
    expect(slugSheetName(".png")).toBe("sheet");
  });

  it("is always a legal sheet name, which is the whole point of it", () => {
    for (const name of ["../../etc/passwd.png", "A".repeat(200) + ".png", "🐸.png", "Green.PNG"]) {
      expect(isSheetName(slugSheetName(name))).toBe(true);
    }
  });
});

describe("the selections", () => {
  const one = (extra: Record<string, unknown> = {}) => ({
    id: "m1",
    name: "Frog",
    ...DEFAULT_MASCOT,
    ...extra,
  });

  it("survive being written and read back", () => {
    process.env.XDG_CONFIG_HOME = tmp;
    const kept = {
      default: "m2",
      list: [
        one(),
        one({ id: "m2", name: "Swim", working: { row: 2, col: 3, count: 6, cycle: 900 } }),
      ],
    };
    writeMascots(kept);
    expect(readMascots()).toEqual(kept);
    delete process.env.XDG_CONFIG_HOME;
  });

  it("keep the frames somebody chose when the sheet they were on is gone", () => {
    process.env.XDG_CONFIG_HOME = tmp;
    writeMascots({
      default: "m1",
      list: [one({ sheet: "deleted", working: { row: 2, col: 3, count: 6, cycle: 720 } })],
    });
    const back = readMascots().list[0]!;
    expect(back.sheet).toBe(DEFAULT_MASCOT.sheet);
    expect([back.working.row, back.working.col, back.working.count]).toEqual([2, 3, 6]);
    delete process.env.XDG_CONFIG_HOME;
  });

  it("are the default frog when there is no file at all", () => {
    process.env.XDG_CONFIG_HOME = join(tmp, "empty");
    const back = readMascots();
    expect(back.list).toHaveLength(1);
    expect(back.list[0]).toMatchObject(DEFAULT_MASCOT);
    expect(back.default).toBe(back.list[0]!.id);
    delete process.env.XDG_CONFIG_HOME;
  });

  /**
   * The one migration this feature has. A file written by the version of kururu
   * that had a single mascot is a bare config with no list in it, and the
   * selection in it is somebody's — dropping it for the default frog would be
   * losing a setting to a refactor.
   */
  it("adopt a file from the version that could only hold one", () => {
    process.env.XDG_CONFIG_HOME = tmp;
    const path = join(tmp, "kururu", "mascot.json");
    // The shape that version wrote: one config, its clip at the top level.
    writeFileSync(
      path,
      JSON.stringify({ sheet: "green", frame: 32, row: 3, col: 5, count: 2, cycle: 640 }),
    );
    const back = readMascots();
    expect(back.list).toHaveLength(1);
    const kept = back.list[0]!;
    expect(kept.working).toEqual({ row: 3, col: 5, count: 2, cycle: 640 });
    // No idle animation is invented for it: nothing here knows what is on that
    // sheet, and the cells beside a selection are not necessarily an animation.
    expect(kept.idle).toBeNull();
    expect(back.default).toBe(kept.id);
    delete process.env.XDG_CONFIG_HOME;
  });

  it("never end up empty, whatever the file said", () => {
    expect(adoptMascots({ default: "gone", list: [] }).list).toHaveLength(1);
    expect(adoptMascots(null).list).toHaveLength(1);
    expect(adoptMascots({ list: "not a list" }).list).toHaveLength(1);
  });

  it("point at something drawable even when the default names nothing", () => {
    const set = adoptMascots({ default: "nope", list: [one({ id: "a" }), one({ id: "b" })] });
    expect(set.default).toBe("a");
  });

  /** What the field was called when one mascot served the whole window. */
  it("read the default out of a file that still calls it `active`", () => {
    const set = adoptMascots({ active: "b", list: [one({ id: "a" }), one({ id: "b" })] });
    expect(set.default).toBe("b");
  });

  it("do not let two of them share an id, since renaming one would hit both", () => {
    const set = adoptMascots({ default: "a", list: [one({ id: "a" }), one({ id: "a" })] });
    expect(new Set(set.list.map((m) => m.id)).size).toBe(set.list.length);
  });

  /**
   * Ids outlive the process that made them, so a counter reset by a restart
   * would hand out one the file is already using.
   */
  it("mint an id nothing in the list is using", () => {
    expect(freshMascotId([])).toBe("m1");
    expect(freshMascotId([one(), one({ id: "m2" })])).toBe("m3");
    expect(freshMascotId([one({ id: "m2" })])).toBe("m1");
  });
});

describe("adopting one", () => {
  it("clamps a slider dragged too far rather than refusing it", () => {
    const wide = adoptMascot({
      ...DEFAULT_MASCOT,
      working: { row: -4, col: 0, count: 999, cycle: 1 },
    });
    expect(wide.working.count).toBe(64);
    expect(wide.working.cycle).toBe(80);
    expect(wide.working.row).toBe(0);
  });

  it("keeps the two animations apart, since only one of them is optional", () => {
    const both = adoptMascot({
      ...DEFAULT_MASCOT,
      working: { row: 1, col: 7, count: 4, cycle: 700 },
      idle: { row: 1, col: 0, count: 3, cycle: 1900 },
    });
    expect(both.working.cycle).toBe(700);
    expect(both.idle?.cycle).toBe(1900);
    // Null is a choice, not a missing field: it is the dot, and it survives.
    expect(adoptMascot({ ...DEFAULT_MASCOT, idle: null }).idle).toBeNull();
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
