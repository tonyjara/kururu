/**
 * Folding a line of Kuru's drawer: which name a fold is kept under, so it
 * outlives the id a line changes on its way, what a folded line shows, when
 * "Fold long messages" starts one folded, and that what `localStorage`
 * hands back — which anybody could have edited — is read as pairs or not
 * at all.
 */
import { describe, expect, it } from "bun:test";
import type { KuruReply, NodeKuruItem, NoticeItem, YouItem } from "../../shared/kuru";
import { FOLDS_MAX, LONG_ROWS, firstLine, foldKeys, foldText, isFolded, isLong, parseFolds, serializeFolds, withFold, withFolds } from "../src/kurufold";

function you(over: Partial<YouItem> = {}, node: string | null = null): NodeKuruItem {
  return { kind: "you", id: "t12", at: 1, text: "yes", via: "typed", ms: 0, state: "delivered", typedAt: 1, note: null, outboxId: null, ...over, node };
}

function kuru(over: Partial<KuruReply> = {}, node: string | null = null): NodeKuruItem {
  return { kind: "kuru", id: "t13", at: 2, text: "Done.", utterance: null, fate: null, aside: false, ...over, node };
}

const notice: NodeKuruItem = { kind: "notice", id: "t14", at: 3, from: "kururu", agent: null, what: "finished its turn", event: "done", text: "…", node: null } satisfies NoticeItem & { node: null };

describe("foldText", () => {
  it("is a message's words or a reply's", () => {
    expect(foldText(you())).toBe("yes");
    expect(foldText(kuru())).toBe("Done.");
  });

  it("is nothing for a clip not yet in words, a notice, or a session's mark", () => {
    expect(foldText(you({ text: null }))).toBeNull();
    expect(foldText(notice)).toBeNull();
    expect(foldText({ kind: "session", id: "s1", at: 0, launcher: null })).toBeNull();
  });
});

describe("foldKeys", () => {
  it("keeps a message waiting for Kuru by its outbox id, and the turn it becomes by its own with the outbox's behind it", () => {
    expect(foldKeys(you({ id: "v9", outboxId: "v9", state: "queued" }))).toEqual(["v9"]);
    expect(foldKeys(you({ id: "t12", outboxId: "v9" }))).toEqual(["t12", "v9"]);
  });

  it("keeps a turn whose outbox entry is gone by the turn's id, which is what it was written under", () => {
    expect(foldKeys(you({ id: "t12", outboxId: null }))).toEqual(["t12"]);
  });

  it("keeps a spoken reply by its utterance, the same before and after it is a turn", () => {
    expect(foldKeys(kuru({ id: "mu7", utterance: "u7" }))).toEqual(["mu7"]);
    expect(foldKeys(kuru({ id: "t13", utterance: "u7" }))).toEqual(["mu7"]);
    expect(foldKeys(kuru({ id: "t13", utterance: null }))).toEqual(["t13"]);
  });

  it("keeps another node's lines under its node id, so two nodes' t12 are two lines", () => {
    expect(foldKeys(you({ id: "n1/t12" }, "omarchy"))).toEqual(["n1/t12"]);
    expect(foldKeys(kuru({ id: "n1/t13", utterance: "u7" }, "omarchy"))).toEqual(["n1/mu7"]);
    expect(foldKeys(kuru({ id: "n1/t13" }, "omarchy"))).not.toEqual(foldKeys(kuru({ id: "t13" })));
  });
});

describe("isFolded and withFold", () => {
  it("is the default until a choice is written", () => {
    expect(isFolded(new Map(), ["t12"], false)).toBe(false);
    expect(isFolded(new Map(), ["t12"], true)).toBe(true);
  });

  it("writes a fold, and takes it off again when opened, since open is the default", () => {
    const folded = withFold(new Map(), ["t12"], true, false);
    expect([...folded]).toEqual([["t12", true]]);
    expect(isFolded(folded, ["t12"], false)).toBe(true);
    const opened = withFold(folded, ["t12"], false, false);
    expect(opened.size).toBe(0);
  });

  it("writes an opening down when the line would be folded by default — a long one with the switch on", () => {
    const opened = withFold(new Map(), ["t12"], false, true);
    expect([...opened]).toEqual([["t12", false]]);
    expect(isFolded(opened, ["t12"], true)).toBe(false);
  });

  it("finds a fold made while the message waited, under its outbox id, once it is a turn", () => {
    const folds = withFold(new Map(), foldKeys(you({ id: "v9", outboxId: "v9", state: "queued" })), true, false);
    expect(isFolded(folds, foldKeys(you({ id: "t12", outboxId: "v9" })), false)).toBe(true);
  });

  it("takes the other names off when it writes the first, so an old outbox id cannot outvote the turn", () => {
    const folds = withFold(new Map([["v9", true]]), ["t12", "v9"], false, false);
    expect(folds.size).toBe(0);
    expect(isFolded(folds, ["t12", "v9"], false)).toBe(false);
  });

  it("moves a choice made again to the newest end, so the trim keeps it", () => {
    const folds = withFold(new Map([["t1", true], ["t2", true]]), ["t1"], true, false);
    expect([...folds.keys()]).toEqual(["t2", "t1"]);
  });

  it("keeps the newest FOLDS_MAX and lets the oldest go", () => {
    let folds: Map<string, boolean> = new Map();
    for (let i = 0; i < FOLDS_MAX + 5; i++) folds = withFold(folds, [`t${i}`], true, false);
    expect(folds.size).toBe(FOLDS_MAX);
    expect(folds.has("t0")).toBe(false);
    expect(folds.has(`t${FOLDS_MAX + 4}`)).toBe(true);
  });
});

describe("withFolds", () => {
  it("folds every line given, and opens them all again to nothing written", () => {
    const lines = [
      { keys: ["t1"], byDefault: false },
      { keys: ["t2", "v2"], byDefault: false },
      { keys: ["mu3"], byDefault: true },
    ];
    const folded = withFolds(new Map(), lines, true);
    expect([...folded]).toEqual([
      ["t1", true],
      ["t2", true],
    ]);
    for (const line of lines) expect(isFolded(folded, line.keys, line.byDefault)).toBe(true);
    const opened = withFolds(folded, lines, false);
    expect([...opened]).toEqual([["mu3", false]]);
    for (const line of lines) expect(isFolded(opened, line.keys, line.byDefault)).toBe(false);
  });

  it("leaves the lines it was not given as they were", () => {
    const folds = withFolds(new Map([["t9", true]]), [{ keys: ["t1"], byDefault: false }], true);
    expect(folds.get("t9")).toBe(true);
  });
});

describe("firstLine", () => {
  it("is the first line that is not blank, and says when more follows", () => {
    expect(firstLine("\n\n  Six agents are working.\nAuth is blocked.")).toEqual({ line: "Six agents are working.", more: true });
    expect(firstLine("Done.")).toEqual({ line: "Done.", more: false });
    expect(firstLine("Done.\n\n   \n")).toEqual({ line: "Done.", more: false });
  });

  it("is nothing for words that are all blank", () => {
    expect(firstLine(" \n \n")).toEqual({ line: "", more: false });
  });
});

describe("isLong", () => {
  it("counts lines", () => {
    expect(isLong(Array.from({ length: LONG_ROWS }, (_, i) => `line ${i}`).join("\n"))).toBe(false);
    expect(isLong(Array.from({ length: LONG_ROWS + 1 }, (_, i) => `line ${i}`).join("\n"))).toBe(true);
  });

  it("counts one long paragraph as the rows it wraps to", () => {
    expect(isLong("word ".repeat(100))).toBe(false);
    expect(isLong("word ".repeat(400))).toBe(true);
  });

  it("is not a short answer", () => {
    expect(isLong("Done.")).toBe(false);
    expect(isLong("")).toBe(false);
  });
});

describe("parseFolds", () => {
  it("reads back what serializeFolds wrote, in order", () => {
    const folds = new Map([
      ["t2", true],
      ["123", true],
      ["mu4", false],
    ]);
    expect([...parseFolds(serializeFolds(folds))]).toEqual([...folds]);
  });

  it("is empty for nothing, for what is not JSON, and for what is not a list", () => {
    expect(parseFolds(null).size).toBe(0);
    expect(parseFolds("{oops").size).toBe(0);
    expect(parseFolds('{"t1":true}').size).toBe(0);
  });

  it("drops a pair that is not a name and a boolean, and keeps the rest", () => {
    const folds = parseFolds(JSON.stringify([["t1", true], ["t2", "yes"], [3, true], ["", true], ["t3"], "t4", ["t5", false, 1], ["t6", false]]));
    expect([...folds]).toEqual([
      ["t1", true],
      ["t6", false],
    ]);
  });

  it("keeps the last word on a name written twice, and the newest FOLDS_MAX", () => {
    expect([...parseFolds(JSON.stringify([["t1", true], ["t1", false]]))]).toEqual([["t1", false]]);
    const many = Array.from({ length: FOLDS_MAX + 3 }, (_, i) => [`t${i}`, true]);
    const folds = parseFolds(JSON.stringify(many));
    expect(folds.size).toBe(FOLDS_MAX);
    expect(folds.has("t2")).toBe(false);
    expect(folds.has("t3")).toBe(true);
  });
});
