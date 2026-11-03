import { describe, expect, test } from "bun:test";
import { escapePath } from "../src/drop";
import { chipAt, chipsIn, fileName, filesStillIn, piecesOf, quoteHint, unescapePath } from "../src/chips";
import { cardReference, quoteReference } from "../../shared/kuru";
import { replyReference } from "../../shared/reply";

const REF = cardReference({ code: "MV-69", title: "Test the new Platypost build on your iPhone", place: "profile", cardId: "c4f0d4bbf152d" });

/** What Kuru's box draws as chips, held to the formats that write them. */
describe("chipsIn", () => {
  test("a card's reference is a card chip with its code and title", () => {
    const draft = `${REF} look at this`;
    const [chip] = chipsIn(draft);
    expect(chip).toMatchObject({ kind: "card", from: 0, to: REF.length, source: "MV-69", label: "Test the new Platypost build on…" });
  });

  test("a quote takes its card's reference into one chip, and two quotes of one card read differently", () => {
    const a = quoteReference(REF, { part: "body", text: "the gap under the box is too big now", comment: "still" });
    const b = quoteReference(REF, { part: "body", text: "Settings tab: cards overflow to the right", comment: "same" });
    const draft = `${a}\n${b}`;
    const chips = chipsIn(draft);
    expect(chips.map((c) => c.kind)).toEqual(["quote", "quote"]);
    expect(chips[0]!.source).toBe("MV-69");
    expect(chips[0]!.label).not.toBe(chips[1]!.label);
    expect(draft.slice(chips[0]!.from, chips[0]!.to)).toBe(a.slice(0, a.length - " still".length));
    expect(chips[0]!.full).toContain("the gap under the box is too big now");
  });

  test("a quote of a card's title says so", () => {
    const draft = quoteReference(REF, { part: "title", text: "Test the new", comment: "" });
    expect(chipsIn(draft)[0]!.label).toBe("title: Test the new");
  });

  test("a quote of a line in the conversation is from that line", () => {
    const reply = replyReference({ who: "Kuru", when: "18:42", quote: "Want me to tell it to go ahead?", id: "t1234" });
    const draft = `${quoteReference(reply, { part: "body", text: "go ahead", comment: "yes" })}`;
    expect(chipsIn(draft)[0]).toMatchObject({ kind: "quote", source: "Kuru 18:42", label: "go ahead" });
  });

  test("a reply reference alone, and anything nearly a reference, stays words", () => {
    const reply = replyReference({ who: "Kuru", when: "18:42", quote: "Want me to?", id: "t1" });
    expect(chipsIn(`${reply} yes`)).toEqual([]);
    expect(chipsIn('[card MV-69 "x" (profile/notanid)]')).toEqual([]);
    expect(chipsIn("[card MV-69 broken")).toEqual([]);
  });

  test("a path is a file only when the box put it there, and a picture by its extension", () => {
    const pic = escapePath("/Users/me/Downloads/IMG 8584.PNG");
    const doc = escapePath("/tmp/notes.md");
    const draft = `${pic} and ${doc} and /typed/path.png`;
    const chips = chipsIn(draft, [pic, doc]);
    expect(chips.map((c) => [c.kind, c.label])).toEqual([
      ["image", "IMG 8584.PNG"],
      ["file", "notes.md"],
    ]);
    expect(chips[0]!.full).toBe("/Users/me/Downloads/IMG 8584.PNG");
  });

  test("a remembered path inside a longer word is not a file", () => {
    expect(chipsIn("/tmp/a.png2", ["/tmp/a.png"])).toEqual([]);
  });
});

describe("piecesOf", () => {
  test("the words around the chips are kept exactly, and joined they are the draft", () => {
    const draft = `fix ${REF} please\n${quoteReference(REF, { part: "body", text: "x y", comment: "z" })}`;
    const pieces = piecesOf(draft);
    const back = pieces.map((p) => ("text" in p ? p.text : draft.slice(p.chip.from, p.chip.to))).join("");
    expect(back).toBe(draft);
    expect(pieces[0]).toEqual({ text: "fix " });
  });
});

describe("chipAt", () => {
  test("a Backspace just after a chip takes all of it, and a Delete just before", () => {
    const draft = `${REF} hi`;
    expect(chipAt(draft, [], REF.length, true)?.to).toBe(REF.length);
    expect(chipAt(draft, [], 0, false)?.from).toBe(0);
    expect(chipAt(draft, [], REF.length + 1, true)).toBeNull();
  });
});

describe("helpers", () => {
  test("a quote's hint is its opening words", () => {
    expect(quoteHint("the gap under the box is too big now")).toBe("the gap under the box…");
    expect(quoteHint("short one")).toBe("short one");
    expect(quoteHint("Supercalifragilisticexpialidocious-and-then-some words")).toMatch(/…$/);
  });

  test("paths", () => {
    expect(unescapePath("/a/My\\ File\\(1\\).png")).toBe("/a/My File(1).png");
    expect(fileName("/a/b/c.txt")).toBe("c.txt");
    expect(filesStillIn("x /a.png y", ["/a.png", "/b.png", ""])).toEqual(["/a.png"]);
  });
});
