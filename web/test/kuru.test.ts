/**
 * "Reference in Kuru", the row every card's menu carries: what it says, and
 * that pressing it opens Kuru's drawer with the card's reference waiting for
 * the composer — once, however often the drawer is opened afterwards, and
 * without scrolling a drawer that was already open and being read.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { addCard, emptyBoard, emptyProfileBoard } from "../../shared/board";
import { splitCardRefs, type CardRef } from "../../shared/kuru";
import type { Profile, Workspace } from "../../shared/model";
import { closeKuru, insertInKuru, kuruDrawerNow, openKuru, referCardIn, referItem, takeKuruWords } from "../src/kuru";

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

describe("referCardIn", () => {
  // A note has the card's id and nothing else: the words must be the ones its menu on the board writes.
  const mine = addCard(emptyProfileBoard(), { title: 'Pick the "launch" date' }, "c0123456789ab");
  const theirs = addCard(emptyBoard(), { title: "Fix the login" }, "c0123456789ac");
  const workspace = (id: string, name: string) => ({ id, key: `wk${id}`, name, board: theirs, mascotId: null }) as unknown as Workspace;
  const profile = { key: "pk1", name: "Nyto", board: mine, workspaces: [workspace("w3", "Acme"), workspace("n:n0a1b2c3d4e5f:w9", "Shop")] } as unknown as Profile;
  const names = (node: string) => (node === "n0a1b2c3d4e5f" ? "omarchy" : null);

  it("writes a profile card's reference as its menu does", () => {
    referItem({ code: "NYT-1", title: 'Pick the "launch" date', place: "profile", cardId: "c0123456789ab" }).run();
    const fromMenu = kuruDrawerNow().words!;
    takeKuruWords(fromMenu.n);
    closeKuru();
    expect(referCardIn(profile, "c0123456789ab", names)).toBe(true);
    expect(kuruDrawerNow().open).toBe(true);
    expect(kuruDrawerNow().words?.text).toBe(fromMenu.text);
    expect(fromMenu.text).toBe(`[card NYT-1 "Pick the 'launch' date" (profile/c0123456789ab)]`);
  });

  it("writes a workspace card's with the workspace it is on now", () => {
    expect(referCardIn(profile, "c0123456789ac", names)).toBe(true);
    const text = kuruDrawerNow().words!.text;
    expect(text).toBe('[card ACM-1 "Fix the login" (w3/c0123456789ac)]');
    expect(splitCardRefs(text)).toEqual([{ ref: { code: "ACM-1", title: "Fix the login", place: "w3", cardId: "c0123456789ac" } }]);
  });

  it("names another node's workspace by the node, as the board does", () => {
    const only = { ...profile, workspaces: [workspace("n:n0a1b2c3d4e5f:w9", "Shop")] } as Profile;
    expect(referCardIn(only, "c0123456789ac", names)).toBe(true);
    expect(kuruDrawerNow().words?.text).toBe('[card SHO-1 "Fix the login" (omarchy:w9/c0123456789ac)]');
  });

  it("puts nothing in for a card that is not in the profile", () => {
    expect(referCardIn(profile, "c999999999999", names)).toBe(false);
    expect(kuruDrawerNow().open).toBe(false);
    expect(kuruDrawerNow().words).toBeNull();
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
