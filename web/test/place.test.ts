/**
 * Where the voice pill is kept.
 *
 * Two promises, both invisible until they are broken: a pill dragged past an
 * edge stays in the window, and a place read back out of `localStorage` — a
 * string anybody can edit, written by whatever version wrote it — is either a
 * place inside the window or none at all, never a pill drawn off-screen with
 * nothing left to take hold of.
 */
import { describe, expect, it } from "bun:test";
import { adoptPlace, placeAt } from "../src/place";

describe("placeAt", () => {
  it("is a share of the room the pill has to move in", () => {
    // A 1000×800 window and a 200×40 pill leave 800×760 to move in.
    expect(placeAt(0, 0, 200, 40, 1000, 800)).toEqual({ x: 0, y: 0 });
    expect(placeAt(800, 760, 200, 40, 1000, 800)).toEqual({ x: 1, y: 1 });
    expect(placeAt(400, 380, 200, 40, 1000, 800)).toEqual({ x: 0.5, y: 0.5 });
  });

  it("holds a pill dragged past an edge against it", () => {
    expect(placeAt(-300, -50, 200, 40, 1000, 800)).toEqual({ x: 0, y: 0 });
    expect(placeAt(5000, 5000, 200, 40, 1000, 800)).toEqual({ x: 1, y: 1 });
  });

  it("puts a pill with no room to move in the middle of that axis", () => {
    expect(placeAt(0, 100, 1000, 40, 1000, 800)).toEqual({ x: 0.5, y: 100 / 760 });
    expect(placeAt(0, 0, 1200, 900, 1000, 800)).toEqual({ x: 0.5, y: 0.5 });
  });

  it("does not let a NaN through as a place", () => {
    expect(placeAt(Number.NaN, 0, 200, 40, 1000, 800)).toEqual({ x: 0.5, y: 0 });
    expect(placeAt(0, 0, 200, 40, Number.NaN, 800)).toEqual({ x: 0.5, y: 0 });
  });
});

describe("adoptPlace", () => {
  it("reads back what was written", () => {
    expect(adoptPlace(JSON.stringify({ x: 0.25, y: 0.9 }))).toEqual({ x: 0.25, y: 0.9 });
  });

  it("is no place for nothing, or for anything that is not two numbers", () => {
    for (const raw of [null, "", "{", "null", "3", "[]", '{"x":0.5}', '{"x":"0.5","y":0.5}', '{"x":1e999,"y":0}']) {
      expect(adoptPlace(raw)).toBeNull();
    }
  });

  it("clamps a number outside the window back to the edge it was nearest", () => {
    expect(adoptPlace(JSON.stringify({ x: -2, y: 7 }))).toEqual({ x: 0, y: 1 });
  });
});
