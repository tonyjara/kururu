import { describe, expect, test } from "bun:test";
import { sameJson } from "../src/same";

describe("sameJson", () => {
  test("a value parsed twice is the same value", () => {
    const text = JSON.stringify({
      id: "c1",
      title: "Fix the flicker",
      run: { agentId: "a12", state: "working", endedAt: null },
      dates: { start: "2026-10-11", end: "2026-10-12" },
      tags: ["one", "two"],
    });
    expect(sameJson(JSON.parse(text), JSON.parse(text))).toBe(true);
  });

  test("a change anywhere inside is a change", () => {
    const card = () => ({ id: "c1", run: { agentId: "a12", state: "working" }, tags: ["one"] });
    expect(sameJson(card(), { ...card(), run: { agentId: "a12", state: "finished" } })).toBe(false);
    expect(sameJson(card(), { ...card(), tags: ["one", "two"] })).toBe(false);
    expect(sameJson(card(), { ...card(), tags: ["two"] })).toBe(false);
  });

  test("a field gained or lost is a change, even one that is null", () => {
    expect(sameJson({ a: 1 }, { a: 1, b: null })).toBe(false);
    expect(sameJson({ a: 1, b: null }, { a: 1 })).toBe(false);
    expect(sameJson({ a: 1, b: null }, { a: 1, c: null })).toBe(false);
  });

  test("null, an empty object and an empty list are three things", () => {
    expect(sameJson(null, {})).toBe(false);
    expect(sameJson({}, [])).toBe(false);
    expect(sameJson([], {})).toBe(false);
    expect(sameJson(null, undefined)).toBe(false);
    expect(sameJson(0, false)).toBe(false);
  });

  /** Props carry callbacks, and an old one kept would act on an old board. */
  test("a function is only ever the same function", () => {
    const run = () => {};
    expect(sameJson({ run }, { run })).toBe(true);
    expect(sameJson({ run }, { run: () => {} })).toBe(false);
  });
});
