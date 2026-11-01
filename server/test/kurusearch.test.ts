/**
 * The drawer's search: what counts as a match, what gets lit, and that it is
 * the whole history that is looked through and not the window. The two ways it
 * could quietly go wrong are the ones held here hardest: matching so loosely
 * that every line is a result, and handing the renderer anything but the text
 * it came in with.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KURU_RECENT, cardReference, type KuruItem, type NoticeItem } from "../../shared/kuru";
import { KURU_SEARCH_MAX, foldWords, itemWords, matchItem, parseKuruQuery, pickHits, splitHits, withinEdits, type KuruQuery } from "../../shared/kurusearch";
import { replyReference, withReply } from "../../shared/reply";
import { Kuru } from "../src/kuru";
import { Store } from "../src/store";

function q(words: string): KuruQuery {
  const query = parseKuruQuery(words);
  if (!query) throw new Error("no query");
  return query;
}

function kuru(text: string, id = "t1", at = 1): KuruItem {
  return { kind: "kuru", id, at, text, utterance: null, fate: null, aside: false };
}

function you(text: string | null, id = "t1", at = 1): KuruItem {
  return { kind: "you", id, at, text, via: "typed", ms: 0, state: "delivered", typedAt: null, note: null, outboxId: null };
}

/** The words a query lights in a text, as they are written there. */
function lit(words: string, text: string): string[] {
  return splitHits(q(words), text)
    .filter((part) => part.hit)
    .map((part) => part.text);
}

describe("parseKuruQuery", () => {
  test("nothing to look for is no query, which is the full chat", () => {
    expect(parseKuruQuery("")).toBeNull();
    expect(parseKuruQuery("   \n ")).toBeNull();
  });
  test("folds, splits on spaces, and drops a word said twice", () => {
    expect(q("  Déploy  deploy TRK-45 ").terms.map((term) => term.text)).toEqual(["deploy", "trk-45"]);
    expect(q("  Déploy ").raw).toBe("Déploy");
  });
  test("a pasted page is not eight hundred passes over the history", () => {
    expect(q(Array.from({ length: 500 }, (_, i) => `w${i}`).join(" ")).terms.length).toBeLessThanOrEqual(8);
  });
});

describe("withinEdits", () => {
  test("a swap of neighbours is one edit, as a typo is", () => {
    expect(withinEdits("delpoy", "deploy", 1)).toBe(true);
    expect(withinEdits("abcd", "badc", 1)).toBe(false);
    expect(withinEdits("abcd", "badc", 2)).toBe(true);
  });
  test("insert, delete, replace; and no further", () => {
    expect(withinEdits("worktree", "worktrees", 1)).toBe(true);
    expect(withinEdits("worktree", "wrktree", 1)).toBe(true);
    expect(withinEdits("worktree", "workfree", 1)).toBe(true);
    expect(withinEdits("worktree", "woodfree", 1)).toBe(false);
    expect(withinEdits("short", "muchlongerword", 2)).toBe(false);
  });
  test("a word longer than its rows is refused, not read past them", () => {
    expect(withinEdits("x".repeat(500), "x".repeat(500), 2)).toBe(false);
  });
});

describe("matchItem", () => {
  test("every word, in any order, each anywhere in the line", () => {
    const line = kuru("The rollout on Omarchy finished after the migration");
    expect(matchItem(q("migration omarchy"), line)).toBe("exact");
    expect(matchItem(q("migration tuesday"), line)).toBeNull();
  });
  test("part of a word is exact, and case and accents do not count", () => {
    expect(matchItem(q("MIGRAT"), kuru("the migration"))).toBe("exact");
    expect(matchItem(q("cafe"), kuru("Un Café"))).toBe("exact");
    expect(matchItem(q("café"), kuru("the cafe"))).toBe("exact");
  });
  test("a typo finds it, and says it was only close", () => {
    expect(matchItem(q("delpoy"), kuru("we deploy on Friday"))).toBe("near");
    expect(matchItem(q("migartion"), kuru("the migration"))).toBe("near");
    expect(matchItem(q("delpoy"), kuru("the deployment went out"))).toBe("near");
    expect(matchItem(q("delpoy"), kuru("she deploys"))).toBe("near");
  });
  test("a line with an exact word and a typo is close, not exact", () => {
    expect(matchItem(q("friday delpoy"), kuru("we deploy on Friday"))).toBe("near");
  });
  test("short words and numbers take no typos, or every line would match", () => {
    expect(matchItem(q("cat"), kuru("the car sat"))).toBeNull();
    expect(matchItem(q("8080"), kuru("port 8081"))).toBeNull();
    expect(matchItem(q("kur-45"), kuru("see KUR-46"))).toBeNull();
    expect(matchItem(q("kur-45"), kuru("see KUR-45"))).toBe("exact");
    expect(matchItem(q("kur-45"), kuru("kur has 45 cards"))).toBeNull();
  });
  test("a short word's first letter has to agree: rest is not test", () => {
    expect(matchItem(q("test"), kuru("get some rest"))).toBeNull();
    expect(matchItem(q("test"), kuru("a tent"))).toBe("near");
  });
  test("two letters match at the start of a word only", () => {
    expect(matchItem(q("at"), kuru("the cat sat"))).toBeNull();
    expect(matchItem(q("at"), kuru("look at it"))).toBe("exact");
  });
  test("letters that merely occur in order are no match: this is not a subsequence search", () => {
    expect(matchItem(q("deploy"), kuru("do everything people love, you know"))).toBeNull();
  });
  test("a word with punctuation is found by its parts when not as written", () => {
    expect(matchItem(q("foo-bar"), kuru("the foo bar baz"))).toBe("near");
    expect(matchItem(q("foo-bar"), kuru("the foo-bar baz"))).toBe("exact");
  });
});

describe("what a line searches by is what it draws", () => {
  test("a card reference by its code and title, never its ids", () => {
    const line = you(`see ${cardReference({ code: "ACM-16", title: "Checkout", place: "w8", cardId: "c3f9a1e07b2d4" })}`);
    expect(matchItem(q("acm-16 checkout"), line)).toBe("exact");
    expect(matchItem(q("c3f9a1e07b2d4"), line)).toBeNull();
    expect(matchItem(q("w8"), line)).toBeNull();
  });
  test("a reply by its words and not by the line it quotes", () => {
    const reference = replyReference({ who: "Kuru", when: "18:42", quote: "the migration", id: "t9" });
    const line = you(withReply("yes do it", reference, null));
    expect(matchItem(q("yes"), line)).toBe("exact");
    expect(matchItem(q("migration"), line)).toBeNull();
  });
  test("a notice by its line and by the message behind the tap", () => {
    const notice: NoticeItem = { kind: "notice", id: "t3", at: 1, from: "kururu", agent: { name: "Fastermenu", program: "claude", workspace: "Tracker", card: null }, what: "finished its turn", event: "done", text: "the build is green" };
    for (const words of ["kururu", "fastermenu", "tracker", "finished", "green"]) expect(matchItem(q(words), notice)).toBe("exact");
  });
  test("a clip not yet in words and a session's mark have nothing to find", () => {
    expect(itemWords(you(null))).toEqual([]);
    expect(matchItem(q("new"), { kind: "session", id: "s1", at: 1, launcher: "new conversation" })).toBeNull();
  });
});

describe("splitHits", () => {
  test("joined back up, the pieces are the text that came in, to the character", () => {
    for (const text of ["<img src=x onerror=alert(1)> deploy", "`deploy` **deploy** [a](javascript:x)", "Déploy Ünï déploy ﬁ ß 🐸 deploy", ""]) {
      expect(splitHits(q("deploy"), text).map((part) => part.text).join("")).toBe(text);
    }
  });
  test("a tag in a message comes back as a string among strings", () => {
    const parts = splitHits(q("onerror"), `<img src=x onerror="alert(1)">`);
    expect(parts).toEqual([
      { text: "<img src=x ", hit: null },
      { text: "onerror", hit: "exact" },
      { text: `="alert(1)">`, hit: null },
    ]);
  });
  test("lights the words as they are written, across accents and length changes", () => {
    expect(lit("cafe", "Un CAFÉ noir")).toEqual(["CAFÉ"]);
    expect(lit("noir", "🐸 Un Café noir")).toEqual(["noir"]);
    // Composed and decomposed spellings of the same word both come back whole.
    expect(lit("cafe", "un café noir")).toEqual(["café"]);
  });
  test("every occurrence, and each word", () => {
    expect(lit("deploy friday", "Deploy on Friday, deploy again")).toEqual(["Deploy", "Friday", "deploy"]);
  });
  test("a typo lights the whole word, and says it was close", () => {
    expect(splitHits(q("delpoy"), "the deployment")).toEqual([
      { text: "the ", hit: null },
      { text: "deployment", hit: "near" },
    ]);
  });
  test("ranges that overlap do not draw twice", () => {
    expect(lit("deplo deploy", "deployment")).toEqual(["deploy"]);
    expect(splitHits(q("deplo deploy"), "deployment").map((part) => part.text).join("")).toBe("deployment");
  });
  test("nothing found is the text, whole", () => {
    expect(splitHits(q("zebra"), "the migration")).toEqual([{ text: "the migration", hit: null }]);
  });
});

describe("foldWords", () => {
  test("plain ASCII needs no map", () => {
    expect(foldWords("Hello")).toEqual({ text: "hello", map: null });
  });
  test("maps each folded unit to where it came from", () => {
    const folded = foldWords("Éa🐸b");
    expect(folded.text).toBe("ea🐸b");
    expect(folded.map).toEqual([0, 1, 2, 2, 4, 5]);
  });
});

describe("pickHits", () => {
  const found = Array.from({ length: 10 }, (_, i) => ({ item: kuru(`line ${i}`, `t${i}`, i), tier: (i % 2 ? "exact" : "near") as "exact" | "near" }));
  test("under the cap, everything, in the order it was said", () => {
    expect(pickHits(found).map((item) => item.id)).toEqual(found.map((hit) => hit.item.id));
  });
  test("over it, exact before close and newest first decide who stays, and time still decides where", () => {
    expect(pickHits(found, 3).map((item) => item.id)).toEqual(["t5", "t7", "t9"]);
    expect(pickHits(found, 7).map((item) => item.id)).toEqual(["t1", "t3", "t5", "t6", "t7", "t8", "t9"]);
  });
});

describe("Kuru.search and Kuru.around, on a real store", () => {
  let dir: string;
  let store: Store;
  let conversation: Kuru;
  const KEY = "pk1";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kurusearch-"));
    store = Store.open(join(dir, "kururu.db"));
    conversation = new Kuru({ store, profiles: () => [{ id: "p1", key: KEY }], outbox: () => [], missed: () => [], broadcast: () => {} });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function say(n: number, text: string) {
    store.recordTurn({ profileKey: KEY, kind: "harness", conversationId: "s1", at: n, role: n % 2 ? "kuru" : "you", via: "typed", text, voiceId: null, launcher: null, cwd: null });
  }

  test("finds a line far older than the window the socket carries", async () => {
    say(2, "the old migration plan");
    for (let n = 3; n < 3 + KURU_RECENT * 3; n++) say(n, `filler ${n}`);
    expect(conversation.items(KEY).some((item) => item.kind !== "session" && itemWords(item).join().includes("migration"))).toBe(false);
    const answer = await conversation.search(KEY, "migartion");
    expect(answer.items.map((item) => item.at)).toEqual([2]);
    expect(answer).toMatchObject({ total: 1, exact: 0, raw: "migartion" });
  });

  test("searches the line as drawn: a notice is not a message of yours, and a wrapper is nobody's", async () => {
    say(2, `<system-reminder>the secret word</system-reminder>hello`);
    say(4, "[kururu] claude in Tracker (id a1) finished its turn. All green.");
    expect((await conversation.search(KEY, "secret")).total).toBe(0);
    const answer = await conversation.search(KEY, "green");
    expect(answer.items.map((item) => item.kind)).toEqual(["notice"]);
  });

  test("keeps time order, and a count past the cap", async () => {
    for (let n = 2; n < 2 + KURU_SEARCH_MAX + 20; n += 1) say(n, `deploy ${n}`);
    const answer = await conversation.search(KEY, "deploy");
    expect(answer.total).toBe(KURU_SEARCH_MAX + 20);
    expect(answer.items.length).toBe(KURU_SEARCH_MAX);
    const ats = answer.items.map((item) => item.at);
    expect(ats).toEqual([...ats].sort((a, b) => a - b));
    expect(ats.at(-1)).toBe(2 + KURU_SEARCH_MAX + 19);
  });

  test("a window that went away stops the scan", async () => {
    for (let n = 2; n < 500; n++) say(n, `deploy ${n}`);
    expect((await conversation.search(KEY, "deploy", () => true)).items).toEqual([]);
  });

  test("no words, no scan", async () => {
    expect(await conversation.search(KEY, "   ")).toEqual({ raw: "", items: [], total: 0, exact: 0 });
  });

  test("another profile's lines are not this one's", async () => {
    store.recordTurn({ profileKey: "pk2", kind: "harness", conversationId: "s2", at: 2, role: "you", via: "typed", text: "the migration", voiceId: null, launcher: null, cwd: null });
    expect((await conversation.search(KEY, "migration")).total).toBe(0);
  });

  test("around a moment, either way, and whether there is more", () => {
    for (let n = 2; n < 300; n++) say(n, `line ${n}`);
    const page = conversation.around(KEY, 150, 5, 5);
    expect(page.items.map((item) => item.at)).toEqual([146, 147, 148, 149, 150, 151, 152, 153, 154, 155]);
    expect(page).toMatchObject({ older: true, newer: true });
    const on = conversation.around(KEY, 155, 0, 3);
    expect(on.items.map((item) => item.at)).toEqual([156, 157, 158]);
    expect(on.newer).toBe(true);
    const end = conversation.around(KEY, 296, 0, 60);
    expect(end.items.map((item) => item.at)).toEqual([297, 298, 299]);
    expect(end.newer).toBe(false);
  });
});
