import { describe, expect, test } from "bun:test";
import { HELD_FOR_MS, HeldQuotes } from "../src/notequote";

/** A note window's quote, held by the window for the "Reference in Kuru" that follows it. */
describe("HeldQuotes", () => {
  const quote = { part: "body" as const, text: "the pay button", comment: "make it green" };

  test("a quote is taken once, by its own card", () => {
    const held = new HeldQuotes();
    held.hold("c1", quote, 0);
    expect(held.take("c2", 10)).toBeNull();
    expect(held.take("c1", 10)).toEqual(quote);
    expect(held.take("c1", 20)).toBeNull();
  });

  test("an old quote is never handed to a later plain reference", () => {
    const held = new HeldQuotes();
    held.hold("c1", quote, 0);
    expect(held.take("c1", HELD_FOR_MS + 1)).toBeNull();
  });

  test("the latest quote for a card is the one taken", () => {
    const held = new HeldQuotes();
    held.hold("c1", quote, 0);
    held.hold("c1", { ...quote, comment: "no, red" }, 5);
    expect(held.take("c1", 10)?.comment).toBe("no, red");
  });
});
