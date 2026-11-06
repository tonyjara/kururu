/**
 * The marking script's pure pieces, which the page runs as they are here: a
 * pin anchored to its element's box and found again on a box that moved, and
 * the selectors ranked by how long they survive. And that what main evaluates
 * in the page parses, since a syntax error there is a Mark button that does
 * nothing and says nothing.
 */
import { describe, expect, it } from "bun:test";
import { BINDING, MARK_SOURCE, WORLD, looksGenerated, pinFraction, pinPoint, rankSelectors } from "../markscript.js";

describe("the pin's anchor", () => {
  const box = { x: 100, y: 200, width: 80, height: 40 };

  it("goes from a point to a fraction of the box and back", () => {
    const f = pinFraction(box, 160, 210);
    expect(f).toEqual({ fx: 0.75, fy: 0.25 });
    expect(pinPoint(box, f.fx, f.fy)).toEqual({ x: 160, y: 210 });
  });

  it("follows the box when it moves or grows", () => {
    const f = pinFraction(box, 160, 210);
    expect(pinPoint({ x: 0, y: 0, width: 160, height: 80 }, f.fx, f.fy)).toEqual({ x: 120, y: 20 });
  });

  it("keeps a point outside the box on its edge, and a flat box at its middle", () => {
    expect(pinFraction(box, 0, 999)).toEqual({ fx: 0, fy: 1 });
    expect(pinFraction({ x: 0, y: 0, width: 0, height: 10 }, 5, 5)).toEqual({ fx: 0.5, fy: 0.5 });
    expect(pinFraction(box, Number.NaN, 210).fx).toBe(0.5);
    expect(pinPoint(box, Number.NaN, 2)).toEqual({ x: 140, y: 240 });
  });
});

describe("rankSelectors", () => {
  it("puts unique ones first, then by how long each kind survives", () => {
    const ranked = rankSelectors([
      { kind: "path", value: "html > body > div:nth-of-type(2) > button", unique: true },
      { kind: "class", value: "button.btn", unique: false },
      { kind: "role", value: 'role=button[name="Pay"]', unique: true },
      { kind: "testid", value: '[data-testid="pay"]', unique: true },
      { kind: "id", value: "#pay", unique: false },
    ]);
    expect(ranked.map((s) => s.kind)).toEqual(["testid", "role", "path", "id", "class"]);
  });

  it("drops repeats and empties, and keeps the first few", () => {
    const ranked = rankSelectors(
      [
        { kind: "id", value: "#a", unique: true },
        { kind: "attr", value: "#a", unique: true },
        { kind: "attr", value: "", unique: true },
        { kind: "class", value: ".b", unique: true },
        { kind: "path", value: "c", unique: true },
      ],
      2,
    );
    expect(ranked).toEqual([
      { kind: "id", value: "#a", unique: true },
      { kind: "class", value: ".b", unique: true },
    ]);
  });
});

describe("looksGenerated", () => {
  it("tells a hand-written class from a build's", () => {
    for (const name of ["btn", "checkout-total", "nav__item", "PayButton"]) expect(looksGenerated(name)).toBe(false);
    for (const name of ["css-1x2y3z", "sc-bdVaJa", ":r1:", "radix-123", "_a8f3k2", "item-20241106", ""]) expect(looksGenerated(name)).toBe(true);
  });
});

describe("the source main evaluates", () => {
  it("parses, and names the world and the binding", () => {
    expect(() => new Function(MARK_SOURCE)).not.toThrow();
    expect(MARK_SOURCE).toContain(JSON.stringify(BINDING));
    expect(WORLD).toBe("kururu-marks");
  });

  it("holds no Electron and no comment field", () => {
    expect(MARK_SOURCE).not.toMatch(/require\(|electron|ipcRenderer/);
    expect(MARK_SOURCE).not.toMatch(/comment/i);
  });
});
