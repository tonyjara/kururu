/**
 * "Reference in Kuru", the row every card's menu carries: what it says, and
 * that pressing it opens Kuru's drawer with the card's reference waiting for
 * the composer — once, however often the drawer is opened afterwards, and
 * without scrolling a drawer that was already open and being read.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { splitCardRefs, type CardRef } from "../../shared/kuru";
import { closeKuru, insertInKuru, kuruDrawerNow, openKuru, referItem, takeKuruWords } from "../src/kuru";

const ref: CardRef = { code: "ACM-16", title: "Design the checkout page for the phone", place: "w8", cardId: "c3f9a1e07b2d4" };

afterEach(() => {
  const { words } = kuruDrawerNow();
  if (words) takeKuruWords(words.n);
  closeKuru();
});

describe("referItem", () => {
  it("is one row, ruled off from the moves above it, and says what it does", () => {
    const item = referItem(ref);
    expect(item.label).toBe("Reference in Kuru");
    expect(item.sep).toBe(true);
    expect(item.danger).toBeUndefined();
    expect(item.disabled).toBeUndefined();
  });

  it("opens the drawer with the card's reference waiting, unsent", () => {
    expect(kuruDrawerNow().open).toBe(false);
    referItem(ref).run();
    const now = kuruDrawerNow();
    expect(now.open).toBe(true);
    expect(now.focus).toBeNull();
    expect(now.words?.text).toBe('[card ACM-16 "Design the checkout page for…" (w8/c3f9a1e07b2d4)]');
    // What waits is what the drawer reads back as that card.
    expect(splitCardRefs(now.words!.text)).toEqual([{ ref: { ...ref, title: "Design the checkout page for…" } }]);
  });

  it("gets a sheet over the drawer out of the way, after the words are in", () => {
    let wordsWereIn = false;
    referItem(ref, () => {
      wordsWereIn = kuruDrawerNow().words !== null;
    }).run();
    expect(wordsWereIn).toBe(true);
  });
});

describe("insertInKuru", () => {
  it("is taken once: a drawer closed and opened again does not put the words in twice", () => {
    insertInKuru("[card A]");
    const { n } = kuruDrawerNow().words!;
    takeKuruWords(n);
    expect(kuruDrawerNow().words).toBeNull();
    closeKuru();
    openKuru();
    expect(kuruDrawerNow().words).toBeNull();
  });

  it("waits out a drawer closed before the composer took it", () => {
    insertInKuru("[card A]");
    closeKuru();
    expect(kuruDrawerNow().words?.text).toBe("[card A]");
    openKuru();
    expect(kuruDrawerNow().words?.text).toBe("[card A]");
  });

  it("counts each one, so the same card twice is two insertions and a stale take is ignored", () => {
    insertInKuru("[card A]");
    const first = kuruDrawerNow().words!.n;
    insertInKuru("[card A]");
    const second = kuruDrawerNow().words!.n;
    expect(second).not.toBe(first);
    takeKuruWords(first);
    expect(kuruDrawerNow().words?.n).toBe(second);
  });

  it("leaves an open drawer's list where it was being read", () => {
    openKuru("u1");
    const before = kuruDrawerNow();
    insertInKuru("[card A]");
    const after = kuruDrawerNow();
    expect(after.asked).toBe(before.asked);
    expect(after.focus).toBe("u1");
  });

  it("opens a closed drawer at the newest", () => {
    const before = kuruDrawerNow().asked;
    insertInKuru("[card A]");
    expect(kuruDrawerNow().open).toBe(true);
    expect(kuruDrawerNow().asked).toBe(before + 1);
    expect(kuruDrawerNow().focus).toBeNull();
  });
});
