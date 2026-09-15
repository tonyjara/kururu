/**
 * The three decisions the document picker makes about a list it was handed.
 * All pure, which is the reason they are not in the component.
 */
import { describe, expect, it } from "bun:test";
import { ago, matching, rows } from "../src/docs";

const docs = [
  { path: "README.md", mtime: 3 },
  { path: "docs/PLAN.md", mtime: 2 },
  { path: "docs/adr/0001-the-thing.md", mtime: 1 },
];

describe("rows", () => {
  it("splits a path into the name and where it lives", () => {
    expect(rows(docs)[1]).toMatchObject({ name: "PLAN.md", dir: "docs" });
  });

  it("leaves a file at the root with no directory rather than a dot", () => {
    expect(rows(docs)[0]).toMatchObject({ name: "README.md", dir: "" });
  });
});

describe("matching", () => {
  const all = rows(docs);

  it("matches on the directory as well as the name", () => {
    expect(matching(all, "adr").map((r) => r.name)).toEqual(["0001-the-thing.md"]);
  });

  it("takes every word, in any order — which a substring match could not", () => {
    expect(matching(all, "plan docs").map((r) => r.name)).toEqual(["PLAN.md"]);
    expect(matching(all, "docs plan").map((r) => r.name)).toEqual(["PLAN.md"]);
  });

  it("ignores case, and an empty query is not a filter", () => {
    expect(matching(all, "readme")).toHaveLength(1);
    expect(matching(all, "   ")).toHaveLength(3);
  });
});

describe("ago", () => {
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const now = 1_000 * day;

  it("floors rather than rounding, because the list is sorted by this", () => {
    expect(ago(now - 59 * minute, now)).toBe("59m");
    expect(ago(now - 23 * hour - 59 * minute, now)).toBe("23h");
  });

  it("says now for anything that has just happened", () => {
    expect(ago(now, now)).toBe("now");
    expect(ago(now - 80_000, now)).toBe("now");
  });

  it("climbs a unit at a time", () => {
    expect(ago(now - 2 * minute, now)).toBe("2m");
    expect(ago(now - 3 * hour, now)).toBe("3h");
    expect(ago(now - 3 * day, now)).toBe("3d");
    expect(ago(now - 30 * day, now)).toBe("4w");
    expect(ago(now - 800 * day, now)).toBe("2y");
  });

  it("never reads as being in the future, whatever a clock says", () => {
    expect(ago(now + hour, now)).toBe("now");
  });
});
