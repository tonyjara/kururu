import { describe, expect, test } from "bun:test";
import { HELD_FOR_MS, HeldQuotes, STORED_FOR_MS, storedQuote } from "../src/notequote";

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

/** A quote left in localStorage for a window that was not there to hear it on the channel. */
describe("storedQuote", () => {
  const quote = { part: "body" as const, text: "the gap under the box", comment: "" };
  const raw = (at: number, q: unknown = quote) => JSON.stringify({ at, quote: q });

  test("a fresh quote is read back", () => {
    expect(storedQuote(raw(1000), 1500)).toEqual(quote);
  });

  test("an old one, one from the future, or one that is not a quote is none", () => {
    expect(storedQuote(raw(0), STORED_FOR_MS + 1)).toBeNull();
    expect(storedQuote(raw(100_000), 0)).toBeNull();
    expect(storedQuote(raw(0, { part: "nope", text: "x" }), 0)).toBeNull();
    expect(storedQuote(raw(Number.NaN), 0)).toBeNull();
    expect(storedQuote("{not json", 0)).toBeNull();
    expect(storedQuote(null, 0)).toBeNull();
  });
});
