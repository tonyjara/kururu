/**
 * Hex as the ears, the pure half: its discovery file and status read, the
 * vocabulary file made whole, the sync planned so that running it twice does
 * nothing the second time, and Hex's words put on yap's clock for the pen.
 * No Hex runs here.
 */
import { describe, expect, test } from "bun:test";
import { retimeWords, type TimedText } from "../../shared/ink";
import { TERM_MAX, adoptVocabulary, hexEntries, parseVocabulary, vocabularyPlan, type VocabularyEntry } from "../../shared/vocabulary";
import { hexModel, parseDiscovery } from "../src/hex";

describe("parseDiscovery", () => {
  test("a port, a token and a pid", () => {
    expect(parseDiscovery('{"port":59723,"token":"hex_abcdef0123","apiVersion":"2","pid":54550}')).toEqual({ port: 59723, token: "hex_abcdef0123", pid: 54550 });
  });
  test("anything off is no Hex", () => {
    expect(parseDiscovery("not json")).toBeNull();
    expect(parseDiscovery('{"port":0,"token":"hex_abcdef0123","pid":1}')).toBeNull();
    expect(parseDiscovery('{"port":70000,"token":"hex_abcdef0123","pid":1}')).toBeNull();
    expect(parseDiscovery('{"port":5000,"token":"short","pid":1}')).toBeNull();
    expect(parseDiscovery('{"port":5000,"token":"hex_abc def 0123","pid":1}')).toBeNull();
    expect(parseDiscovery('{"port":5000,"token":"hex_abcdef0123","pid":1.5}')).toBeNull();
  });
});

describe("hexModel", () => {
  test("the selected model, installed or not", () => {
    expect(hexModel({ model: { id: "parakeet_v3", name: "Parakeet v3", language: "es", installed: true } })).toEqual({ id: "parakeet_v3", name: "Parakeet v3", language: "es", installed: true });
    expect(hexModel({ model: { id: "parakeet_v3", installed: false } })).toEqual({ id: "parakeet_v3", name: "parakeet_v3", language: "en", installed: false });
  });
  test("an id that could not go in a URL is none", () => {
    expect(hexModel({ model: { id: "a/../b", installed: true } })).toBeNull();
    expect(hexModel({})).toBeNull();
  });
});

const e = (term: string, ...sounds_like: string[]): VocabularyEntry => ({ term, sounds_like });

describe("adoptVocabulary", () => {
  test("each term once in any case, spellings once and never the term", () => {
    const got = adoptVocabulary({
      terms: [
        { term: " Pasapy ", sounds_like: ["Pasapi", "pasapi", "Pasapy", "", 3] },
        { term: "pasapy", sounds_like: ["later"] },
        "Kuru",
        { term: "" },
        { sounds_like: ["orphan"] },
      ],
    });
    expect(got.terms).toEqual([e("Pasapy", "Pasapi"), e("Kuru")]);
  });
  test("a term is cut to Hex's length", () => {
    expect(adoptVocabulary({ terms: ["x".repeat(100)] }).terms[0]!.term.length).toBe(TERM_MAX);
  });
  test("phrases need both halves", () => {
    expect(adoptVocabulary({ terms: [], phrases: [{ heard: "Beerness", meant: "viernes" }, { heard: "x" }] }).phrases).toEqual([{ heard: "Beerness", meant: "viernes" }]);
  });
});

describe("parseVocabulary", () => {
  test("a file that will not read is an error, never an empty list", () => {
    expect(parseVocabulary('{"terms": [')).toHaveProperty("error");
    expect(parseVocabulary('{"words": []}')).toHaveProperty("error");
    expect(parseVocabulary('{"terms": []}')).toEqual({ terms: [], phrases: [] });
  });
});

describe("hexEntries", () => {
  test("Hex's list reply, with and without spellings", () => {
    expect(hexEntries({ status: "vocabulary", entries: [{ term: "OpenCode", sounds_like: ["open code"] }, { term: "Rune" }, { nope: 1 }] })).toEqual([e("OpenCode", "open code"), e("Rune")]);
    expect(hexEntries({ status: "error" })).toEqual([]);
  });
});

describe("vocabularyPlan", () => {
  test("the same list is nothing to do", () => {
    const list = [e("Pasapy", "Pasapi"), e("Kuru")];
    expect(vocabularyPlan(list, list)).toEqual({ remove: [], add: [] });
  });
  test("an empty Hex gets the whole file, in order", () => {
    expect(vocabularyPlan([], [e("A"), e("B")])).toEqual({ remove: [], add: [e("A"), e("B")] });
  });
  test("a term moved to the top redoes everything from the top", () => {
    expect(vocabularyPlan([e("A"), e("B"), e("C")], [e("C"), e("A"), e("B")])).toEqual({ remove: ["A", "B", "C"], add: [e("C"), e("A"), e("B")] });
  });
  test("an appended term is only that term", () => {
    expect(vocabularyPlan([e("A"), e("B")], [e("A"), e("B"), e("C")])).toEqual({ remove: [], add: [e("C")] });
  });
  test("a spelling taken away comes back without it, and what follows is redone", () => {
    expect(vocabularyPlan([e("A", "a1", "a2"), e("B")], [e("A", "a1"), e("B")])).toEqual({ remove: ["A", "B"], add: [e("A", "a1"), e("B")] });
  });
  test("a term taken out of the file leaves Hex", () => {
    expect(vocabularyPlan([e("A"), e("B"), e("C")], [e("A"), e("C")])).toEqual({ remove: ["B", "C"], add: [e("C")] });
  });
  test("applying the plan and planning again is nothing", () => {
    const have = [e("A"), e("B", "b"), e("C")];
    const want = [e("B", "b"), e("D"), e("A")];
    const plan = vocabularyPlan(have, want);
    const after = [...have.filter((x) => !plan.remove.includes(x.term)), ...plan.add];
    expect(vocabularyPlan(after, want)).toEqual({ remove: [], add: [] });
  });
});

describe("retimeWords", () => {
  // yap's "Mándale a Pasapi el viernes", one word every 400 ms from 200 ms.
  const guideText = "Mándale a Pasapi el viernes";
  const guide: TimedText = { text: guideText, words: [] };
  let from = 0;
  for (const [i, w] of guideText.split(" ").entries()) {
    guide.words.push({ text: w, start: 200 + i * 400, end: 200 + i * 400 + 350, from, to: from + w.length });
    from += w.length + 1;
  }

  test("Hex's words, each findable in the text", () => {
    const got = retimeWords("Mándale a  Pasapy el viernes.", guide, 3000);
    expect(got.text).toBe("Mándale a Pasapy el viernes.");
    expect(got.words.map((w) => got.text.slice(w.from, w.to))).toEqual(["Mándale", "a", "Pasapy", "el", "viernes."]);
  });

  test("on the guide's clock: the same word lands near the same time", () => {
    const got = retimeWords("Mándale a Pasapy el viernes.", guide, 3000);
    const at = (word: string) => got.words.find((w) => w.text.startsWith(word))!.start;
    expect(at("Mándale")).toBe(200);
    expect(Math.abs(at("Pasapy") - 1000)).toBeLessThan(150);
    expect(Math.abs(at("viernes") - 1800)).toBeLessThan(150);
    for (let i = 1; i < got.words.length; i++) expect(got.words[i]!.start).toBeGreaterThanOrEqual(got.words[i - 1]!.start);
    expect(got.words[got.words.length - 1]!.end).toBe(2150);
  });

  test("with no guide, spread over the clip", () => {
    const got = retimeWords("one two three four", null, 4000);
    expect(got.words[0]!.start).toBe(0);
    expect(got.words[got.words.length - 1]!.end).toBe(4000);
    expect(got.words[2]!.start).toBeGreaterThan(1500);
  });

  test("nothing said is no words", () => {
    expect(retimeWords("  ", guide, 1000)).toEqual({ text: "", words: [] });
  });
});
