import { describe, expect, test } from "bun:test";
import type { KuruItem, KuruReply, NoticeItem, YouItem } from "../../shared/kuru";
import { adoptKeys, adoptTagFilter, chipTags, keysOfNames, ownTags, passes, recentTags, splitReplyTags, tagBook, tagLines, tagProjects, type CardWords, type TagSpace, type TaggedLine } from "../../shared/kurutags";

const space = (key: string, name: string, cards: number[] = [], root: string | null = null, ids: string[] = []): TagSpace => ({ key, name, cards: new Set(cards), cardIds: new Set(ids), root });

const SPACES = [
  space("wkhol", "Holapy", [81], "/Users/me/Desktop/Nyto/holapy", ["c0123456789ab"]),
  space("wkpas", "Pasapy", [243], "/Users/me/Desktop/Nyto/pasapy"),
  space("wkkur", "Kururu", [], "/Users/me/Desktop/Nyto/kururu"),
  space("wkres", "Research"),
  space("wkvps", "VPS MV"),
  // Shares Pasapy's prefix: a code goes to whichever has the card.
  space("wkpast", "Pastel", [7]),
];
const book = tagBook(SPACES);

const you = (id: string, text: string, extra: Partial<YouItem> = {}): YouItem => ({ kind: "you", id, at: 0, text, via: "typed", ms: 0, state: "delivered", typedAt: null, note: null, outboxId: null, ...extra });
const reply = (id: string, text: string, extra: Partial<KuruReply> = {}): KuruReply => ({ kind: "kuru", id, at: 0, text, utterance: null, fate: null, aside: false, ...extra });
const notice = (id: string, extra: Partial<NoticeItem> = {}): NoticeItem => ({ kind: "notice", id, at: 0, from: "kururu", agent: null, what: "finished its turn", event: "done", text: "", ...extra });

describe("splitReplyTags", () => {
  test("takes the last line off", () => {
    expect(splitReplyTags("Done, the cart is fixed.\n\n[tags: Holapy, Pasapy]")).toEqual({ text: "Done, the cart is fixed.", names: ["Holapy", "Pasapy"], found: true });
  });
  test("tolerates a hash, quotes, the singular and trailing space", () => {
    expect(splitReplyTags("ok\n[tag: #Holapy, \"VPS MV\"]  \n").names).toEqual(["Holapy", "VPS MV"]);
  });
  test("an empty line is still taken off", () => {
    expect(splitReplyTags("ok\n[tags: ]")).toEqual({ text: "ok", names: [], found: true });
  });
  test("anywhere but the end it is words", () => {
    const text = "End a reply with [tags: Holapy] on its own line.\nThat is all.";
    expect(splitReplyTags(text)).toEqual({ text, names: [], found: false });
  });
  test("caps how many", () => {
    expect(splitReplyTags("x\n[tags: a, b, c, d, e, f, g, h]").names).toHaveLength(6);
  });
});

describe("keysOfNames", () => {
  test("by name, case and spacing aside, each once", () => {
    expect(keysOfNames(["holapy", "vps-mv", "Holapy", "Nope"], SPACES)).toEqual(["wkhol", "wkvps"]);
  });
});

describe("ownTags", () => {
  test("card codes, by the board that has the card", () => {
    expect(ownTags(reply("t1", "HOL-81 and PAS-243 are done; PAS-7 too"), book)).toEqual(["wkhol", "wkpas", "wkpast"]);
  });
  test("a code no board has goes to the only workspace with that prefix, and nowhere when two share it", () => {
    expect(ownTags(reply("t1", "HOL-9999"), book)).toEqual(["wkhol"]);
    expect(ownTags(reply("t1", "PAS-9999"), book)).toEqual([]);
  });
  test("a card's reference, by its id", () => {
    expect(ownTags(you("t1", '[card ZZZ-1 "Fix" (w3/c0123456789ab)] look'), book)).toEqual(["wkhol"]);
  });
  test("names in any case, an everyday name only as spelt, several words as one", () => {
    expect(ownTags(you("t1", "is holapy up? and the vps mv box"), book)).toEqual(["wkhol", "wkvps"]);
    expect(ownTags(you("t1", "do some research on it"), book)).toEqual([]);
    expect(ownTags(you("t1", "put it in Research"), book)).toEqual(["wkres"]);
  });
  test("a name inside another word, or a folder in a path, is not it", () => {
    expect(ownTags(you("t1", "kururuish holapyx"), book)).toEqual([]);
    expect(ownTags(reply("t1", "backed up to `~/Documents/Kururu/backups/x/`"), book)).toEqual([]);
    expect(ownTags(reply("t1", "live on holapy.com"), book)).toEqual(["wkhol"]);
  });
  test("a mark's window title names the workspace", () => {
    expect(ownTags(you("t1", '[mark 1 circled in Google Chrome "WhatsApp · Holapy"] delete that'), book)).toEqual(["wkhol"]);
  });
  test("paths under a root, written whole or from home, and a reply's files", () => {
    expect(ownTags(reply("t1", "see /Users/me/Desktop/Nyto/pasapy/src/a.ts"), book)).toEqual(["wkpas"]);
    expect(ownTags(reply("t1", "see ~/Desktop/Nyto/holapy/docs/x.md"), book)).toEqual(["wkhol"]);
    expect(ownTags(reply("t1", "see docs/x.md", { files: [{ root: "/Users/me/Desktop/Nyto/kururu", path: "docs/x.md", line: null, text: "docs/x.md" }] }), book)).toEqual(["wkkur"]);
  });
  test("a reply's quoted opening is not the message's own words", () => {
    expect(ownTags(you("t5", '[reply to Kuru 18:42 "Holapy is up" (t4)] yes'), book)).toEqual([]);
  });
  test("a notice: its agent's workspace and card, not the reply it quotes", () => {
    expect(ownTags(notice("t1", { agent: { name: "cart", program: "claude", workspace: "Pasapy", card: "HOL-81" }, text: "I touched Kururu too" }), book)).toEqual(["wkpas", "wkhol"]);
    expect(ownTags(notice("t1", { what: "Holapy's deploy finished" }), book)).toEqual(["wkhol"]);
  });
});

describe("tagLines", () => {
  const lines = (items: KuruItem[]): TaggedLine[] => items.map((item) => ({ ...item, node: null }));

  test("Kuru's line wins over the rules, and the owner's corrections over both", () => {
    const tags = tagLines(lines([reply("t1", "Holapy is fine", { tags: { kuru: ["wkpas"] } }), reply("t2", "Holapy", { tags: { add: ["wkres"], drop: ["wkhol"] } })]), book);
    expect(tags.get("t1")).toEqual(["wkpas"]);
    expect(tags.get("t2")).toEqual(["wkres"]);
  });
  test("a message that names nothing takes the line it replies to, else Kuru's reply to it", () => {
    const tags = tagLines(
      lines([reply("t1", "Pasapy is up"), you("t2", "ok"), reply("t3", "Holapy next"), you("t4", '[reply to Kuru 18:42 "Pasapy is up" (t1)] great')]),
      book,
    );
    expect(tags.get("t2")).toEqual(["wkhol"]);
    expect(tags.get("t4")).toEqual(["wkpas"]);
  });
  test("a reply that names nothing takes the message it answers; nothing spreads further", () => {
    const tags = tagLines(lines([you("t1", "deploy holapy"), reply("t2", "Done."), notice("t3"), reply("t4", "Also done."), you("t5", "thanks"), reply("t6", "Sure.")]), book);
    expect(tags.get("t2")).toEqual(["wkhol"]);
    expect(tags.get("t4")).toEqual(["wkhol"]);
    expect(tags.get("t5")).toEqual([]);
    expect(tags.get("t6")).toEqual([]);
  });
  test("a key nobody has is dropped, and another node's lines have none", () => {
    const tags = tagLines([{ ...reply("t1", "x", { tags: { kuru: ["gone"], add: ["gone"] } }), node: null }, { ...reply("n/t1", "Holapy"), node: "omarchy" }], book);
    expect(tags.get("t1")).toEqual([]);
    expect(tags.has("n/t1")).toBe(false);
  });
});

describe("the filter", () => {
  test("recent tags, newest first", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(recentTags(items, new Map([["a", ["x", "y"]], ["b", ["y"]], ["c", ["z"]]]))).toEqual(["z", "y", "x"]);
  });
  test("any picked workspace, and any picked node", () => {
    const none = { spaces: [], nodes: [] };
    expect(passes(none, [], "mac", true)).toBe(true);
    expect(passes({ spaces: ["a", "b"], nodes: [] }, ["b"], "mac", false)).toBe(true);
    expect(passes({ spaces: ["a"], nodes: [] }, ["b"], "mac", false)).toBe(false);
    expect(passes({ spaces: [], nodes: ["omarchy"] }, ["b"], "mac", false)).toBe(false);
    expect(passes({ spaces: ["b"], nodes: ["mac"] }, ["b"], "mac", false)).toBe(true);
    expect(passes({ spaces: ["b"], nodes: [] }, [], "mac", true)).toBe(false);
  });
  test("read back from a device or the wire, kept to its shape", () => {
    expect(adoptTagFilter({ spaces: ["wk1", 3], nodes: "mac" })).toEqual({ spaces: ["wk1"], nodes: [] });
    expect(adoptTagFilter(null)).toEqual({ spaces: [], nodes: [] });
    expect(adoptKeys(["wk1", "bad key", 4, "wk_2"])).toEqual(["wk1", "wk_2"]);
  });
});

describe("projects inside a workspace", () => {
  const LANDINGS_ROOT = "/Users/me/Desktop/Nyto/shared_landings";
  const projects = tagProjects("wksl", {
    found: [
      { dir: "apps/agualomas", title: "O&D Lomas", pkg: "agualomas", domain: "agualomas.com" },
      { dir: "apps/parqueguasu", title: "Parque Guasu", pkg: "parqueguasu", domain: "parqueguasu.org" },
      { dir: "apps/tonyjara", title: "tonyjara", pkg: "tonyjara", domain: "tonyjara.com" },
      { dir: "apps/yetapa", title: "Yetapa Tours", pkg: "yetapa", domain: "yetapatours.com" },
    ],
    edits: [
      { slug: "yetapa", name: "Yetapá" },
      { slug: "parqueguasu", name: "Parque Guasú", aliases: ["Guasu"] },
      { slug: "agualomas", name: "Agua Lomas", aliases: ["AguaLomas"] },
      { slug: "tonyjara", aliases: ["Tony Jara"] },
    ],
  });
  const cards: CardWords[] = [
    { id: "csha37", number: 37, title: "Research: getting Yetapá on GetYourGuide", body: "" },
    { id: "csha40", number: 40, title: "Platypost strategy", body: "Load the social plan for yetapa into Platypost." },
    { id: "csha41", number: 41, title: "Shared footer", body: "Next to Yetapa, Parque Guasu and tonyjara." },
  ];
  const landings: TagSpace = { ...space("wksl", "Shared Landings", [37, 40, 41], LANDINGS_ROOT, ["csha37", "csha40", "csha41"]), projects, cardWords: cards };
  const spaces = [...SPACES, landings];
  const pbook = tagBook(spaces, { name: "MV", cards: [{ id: "cmv94", number: 94, title: "Yetapa", body: "" }] });
  const tags = (item: KuruItem) => ownTags(item, pbook);

  test("a name with or without its accent, any case, and a possessive", () => {
    expect(tags(you("t1", "can you send me yetapas logo?"))).toEqual(["wksl/yetapa"]);
    expect(tags(reply("t1", "I sent the bird with \"Yetapá Tours\" under it."))).toEqual(["wksl/yetapa"]);
    expect(tags(reply("t1", "Parque Guasu and AguaLomas are live, and the guasú form too"))).toEqual(["wksl/agualomas", "wksl/parqueguasu"]);
    expect(tags(reply("t1", "Agua Lomas and tony jara"))).toEqual(["wksl/agualomas", "wksl/tonyjara"]);
  });
  test("its domain names it, and so does a path under its folder, from the root or written relative", () => {
    expect(tags(reply("t1", "treat the live yetapatours.com as the truth"))).toEqual(["wksl/yetapa"]);
    expect(tags(reply("t1", `see ${LANDINGS_ROOT}/apps/parqueguasu/src/app/page.tsx`))).toEqual(["wksl/parqueguasu", "wksl"]);
    expect(tags(reply("t1", "it is in `apps/tonyjara/src/app` now"))).toEqual(["wksl/tonyjara"]);
    expect(tags(reply("t1", "~/Desktop/Nyto/shared_landings/apps/yetapa/public/logo.png"))).toEqual(["wksl/yetapa", "wksl"]);
    // Another repository's apps/ folder is not this one's.
    expect(tags(reply("t1", "~/Desktop/Nyto/platypost/apps/yetapa"))).toEqual([]);
  });
  test("a reply's file under a project's folder", () => {
    expect(tags(reply("t1", "done", { files: [{ root: LANDINGS_ROOT, path: "apps/yetapa/README.md", line: null, text: "", exists: true } as never] }))).toEqual(["wksl", "wksl/yetapa"]);
  });
  test("a card whose title names it, else whose body does, by code or reference; and the profile's own cards", () => {
    expect(tags(you("t1", "how is SHA-37 going?"))).toEqual(["wksl", "wksl/yetapa"]);
    expect(tags(you("t1", "and SHA-40?"))).toEqual(["wksl", "wksl/yetapa"]);
    expect(tags(you("t1", "SHA-41"))).toEqual(["wksl", "wksl/parqueguasu", "wksl/tonyjara", "wksl/yetapa"]);
    expect(tags(you("t1", '[card SHA-40 "Platypost strategy" (w9/csha40)] ok'))).toContain("wksl/yetapa");
    expect(tags(you("t1", "MV-94 is done?"))).toEqual(["wksl/yetapa"]);
  });
  test("a notice: its agent's name says which project of its workspace", () => {
    expect(tags(notice("t1", { agent: { name: "Research: getting Yetapá on GetYourGuide", program: "claude", workspace: "Shared Landings", card: null } }))).toEqual(["wksl", "wksl/yetapa"]);
    expect(tags(notice("t1", { agent: { name: "Fix the build", program: "claude", workspace: "Shared Landings", card: "SHA-37" } }))).toEqual(["wksl", "wksl/yetapa"]);
  });
  test("Kuru's line: Workspace/Project, a project alone, and a workspace alone refined by the words", () => {
    expect(keysOfNames(["Shared Landings/Yetapá", "guasu", "Agua Lomas", "Nope/Yetapa"], spaces)).toEqual(["wksl/yetapa", "wksl/parqueguasu", "wksl/agualomas"]);
    const twin: TagSpace = { ...space("wkx", "Other"), projects: [{ key: "wkx/yetapa", name: "Yetapa", names: ["Yetapa"], dir: null }] };
    expect(keysOfNames(["Yetapa"], [...spaces, twin])).toEqual([]);
    expect(keysOfNames(["Other/Yetapa"], [...spaces, twin])).toEqual(["wkx/yetapa"]);
    const lines = tagLines([reply("t1", "The Yetapá logo is in iCloud.", { tags: { kuru: ["wksl"] } }), reply("t2", "Done.", { tags: { kuru: ["wksl/parqueguasu"] } })], pbook);
    expect(lines.get("t1")).toEqual(["wksl", "wksl/yetapa"]);
    expect(lines.get("t2")).toEqual(["wksl/parqueguasu"]);
  });
  test("a project's tag counts for its workspace in the filter, and its chip stands for both", () => {
    expect(passes({ spaces: ["wksl"], nodes: [] }, ["wksl/yetapa"], "mac", false)).toBe(true);
    expect(passes({ spaces: ["wksl/yetapa"], nodes: [] }, ["wksl"], "mac", false)).toBe(false);
    expect(passes({ spaces: ["wksl/yetapa"], nodes: [] }, ["wksl/parqueguasu"], "mac", false)).toBe(false);
    expect(chipTags(["wksl", "wksl/yetapa", "wkhol"])).toEqual(["wksl/yetapa", "wkhol"]);
    expect(adoptKeys(["wksl/yetapa", "wksl/a/b", "wk sl"])).toEqual(["wksl/yetapa"]);
  });
  test("a hidden project is no tag", () => {
    const quiet = tagProjects("wkpl", { found: [{ dir: "apps/web", title: null, pkg: null, domain: null }, { dir: "apps/server", title: null, pkg: null, domain: null }], edits: [] });
    expect(quiet).toEqual([]);
  });
});
