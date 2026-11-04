import { describe, expect, test } from "bun:test";
import { escapePath } from "../src/drop";
import { chipAt, chipsIn, fileName, filesStillIn, piecesOf, plainChips, quoteHint, unescapePath } from "../../shared/chips";
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

/**
 * A sent message read back into the chips the box drew (`SentWords` in the
 * drawer) and into their short words (`plainChips`), held to the messages
 * that really reached Kuru — the text itself is never changed.
 */
describe("a sent message", () => {
  const REPLY_QUOTE = '[reply to Kuru 20:39 "Yes, Omarchy is updated: the box pulled 1e7f437 and its server restarted, and …" (t6339)] [quote "The old Pasapy post — the one with the wrong price — is still up. Should I delete it, or do you want to do it?"] I deleted this';
  const CARD = '[card JAJ-53 "Check whether…" (w34/c5e803f7ca1c7)] brand was taken';

  test("a quote of a line of the chat is one chip from that line, with the line it answers", () => {
    const [chip, ...rest] = chipsIn(REPLY_QUOTE);
    expect(rest).toEqual([]);
    expect(chip).toMatchObject({ kind: "quote", from: 0, source: "Kuru 20:39", label: "The old Pasapy post —…", answers: { who: "Kuru", when: "20:39", id: "t6339" } });
    expect(chip!.answers!.quote).toStartWith("Yes, Omarchy is updated");
    expect(chip!.full).toContain("Should I delete it, or do you want to do it?");
    expect(REPLY_QUOTE.slice(chip!.to)).toBe(" I deleted this");
  });

  test("a quote of a line from another day, and one with no id (from Telegram), are chips too", () => {
    const [a] = chipsIn('[reply to me Oct 24 18:42 "deploy staging" (t9)] [quote "staging"] and prod');
    expect(a).toMatchObject({ source: "me Oct 24 18:42", label: "staging", answers: { who: "me", when: "Oct 24 18:42", id: "t9" } });
    const [b] = chipsIn('[reply to Kuru 18:42 "Want me to retry?"] [quote "retry"] yes');
    expect(b!.answers).toMatchObject({ id: null, quote: "Want me to retry?" });
  });

  test("a card's reference is its chip with the card it names, the door onto it", () => {
    const [chip] = chipsIn(CARD);
    expect(chip).toMatchObject({ kind: "card", source: "JAJ-53", label: "Check whether…", card: { code: "JAJ-53", title: "Check whether…", place: "w34", cardId: "c5e803f7ca1c7" } });
    expect(chip!.answers).toBeUndefined();
    const [remote] = chipsIn('[card OM-2 "Fix it" (omarchy:w3/c0123456789ab)] see');
    expect(remote!.card!.place).toBe("omarchy:w3");
  });

  test("a quote of a card, of its body and of its title, carries the card", () => {
    const body = quoteReference(REF, { part: "body", text: "the gap under the box", comment: "still there" });
    const title = quoteReference(REF, { part: "title", text: "Test the new Platypost build", comment: "" });
    expect(chipsIn(body)[0]).toMatchObject({ kind: "quote", source: "MV-69", label: "the gap under the box", card: { cardId: "c4f0d4bbf152d" } });
    expect(chipsIn(title)[0]).toMatchObject({ kind: "quote", label: "title: Test the new Platypost build", card: { code: "MV-69" } });
  });

  test("several quotes in one message are each their own chip, in order, with the words between kept", () => {
    const reply = replyReference({ who: "Kuru", when: "18:42", quote: "Two things went wrong", id: "t1" });
    const text = [
      quoteReference(REF, { part: "body", text: "the gap under the box", comment: "fix this" }),
      quoteReference(reply, { part: "body", text: "the build broke", comment: "and this" }),
      '[quote "a lone one"] last',
    ].join("\n");
    const pieces = piecesOf(text);
    const chips = pieces.flatMap((piece) => ("chip" in piece ? [piece.chip] : []));
    expect(chips.map((chip) => [chip.kind, chip.source, chip.label])).toEqual([
      ["quote", "MV-69", "the gap under the box"],
      ["quote", "Kuru 18:42", "the build broke"],
      ["quote", "", "a lone one"],
    ]);
    expect(pieces.map((piece) => ("text" in piece ? piece.text : text.slice(piece.chip.from, piece.chip.to))).join("")).toBe(text);
    expect(plainChips(text)).toBe('“the gap under the box” (MV-69) fix this\n“the build broke” (Kuru 18:42) and this\n“a lone one” last');
  });

  test("a quote holding … and ' — what cutQuoted leaves of a cut and a \" — is read whole", () => {
    const reply = replyReference({ who: "Kuru", when: "9:05", quote: 'He said "go" and it\'s done, then a long tail that runs past the reference\'s cut at eighty characters', id: "t7" });
    expect(reply).toContain("…");
    const text = `${reply} [quote "it's the 'go' … that one"] ok`;
    const [chip] = chipsIn(text);
    expect(chip).toMatchObject({ kind: "quote", from: 0, label: "it's the 'go' … that…", answers: { who: "Kuru", when: "9:05" } });
    expect(chip!.answers!.quote).toEndWith("…");
    expect(chip!.full).toContain("it's the 'go' … that one");
    expect(text.slice(chip!.to)).toBe(" ok");
  });

  test("plainChips spells each chip as its short words and leaves the rest alone", () => {
    expect(plainChips(CARD)).toBe('JAJ-53 "Check whether…" brand was taken');
    expect(plainChips(REPLY_QUOTE)).toBe("“The old Pasapy post —…” (Kuru 20:39) I deleted this");
    expect(plainChips('[file docs/plan.md:40 (kururu) under "Open"] [quote "the preview pane"] next')).toBe("“the preview pane” (plan.md) next");
    expect(plainChips("no chips [here] at all")).toBe("no chips [here] at all");
  });
});
