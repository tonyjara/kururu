/**
 * Kurus as peers, the pure half: the marks another node's words are typed
 * behind, the `@node` address, who hears a reply, what of a conversation
 * crosses a link, and the one drawer the conversations merge into.
 *
 * What is worth pinning is that a mark can never be mistaken for one of the
 * marks that came before it — a node called `voice` must not make its
 * Kuru's words speech — that an address is only an address where a person
 * meant one, that a notice's quoted reply never leaves its node, and that a
 * message sent from here to another Kuru is drawn once, by whichever copy
 * has that Kuru's word for it.
 */
import { describe, expect, it } from "bun:test";
import { peerMark, peerReplySpoken, peerWords, readPeerMark, spokenHere } from "../../shared/channels";
import { agentName } from "../../shared/harness";
import {
  addressOf,
  mergeConversation,
  mergeNodes,
  peerItems,
  plainWords,
  promptPeer,
  readPrompt,
  type KuruItem,
  type KuruReply,
  type NoticeItem,
  type PeerKuru,
  type YouItem,
} from "../../shared/kuru";
import { asBoard, asKuruTurns, asReplied, asSay, asSayState, nodesText, parseLinkMessage, PEER_TALK, type NodeStatus, type PeerMessage } from "../../shared/nodes";
import { viaOf, type Turn } from "../../shared/store";

describe("the marks", () => {
  it("says who and where, and reads back", () => {
    expect(peerMark("mac", "user")).toBe("[user@mac]");
    expect(peerMark("omarchy", "kuru")).toBe("[kuru@omarchy]");
    expect(readPeerMark("[kuru@omarchy] start the build")).toEqual({ node: "omarchy", who: "kuru", rest: "start the build" });
    expect(readPeerMark("[user@box-2] [voice] hola")).toEqual({ node: "box-2", who: "user", rest: "[voice] hola" });
  });

  it("is never one of the marks before it, whatever a node is called", () => {
    for (const text of ["[voice] hi", "[telegram] hi", "[kururu] x finished", "[mac] hi", "[someone@mac] hi"]) expect(readPeerMark(text)).toBeNull();
    // A node named voice is still a node.
    expect(viaOf(peerWords("voice", "kuru", "hello"))).toBe("typed");
    expect(readPrompt(peerWords("telegram", "kuru", "hello"))?.kind).toBe("notice");
  });

  it("lets the user's slash command through bare, and never a Kuru's", () => {
    expect(peerWords("mac", "user", "/compact")).toBe("/compact");
    expect(peerWords("mac", "kuru", "/clear")).toBe("[kuru@mac] /clear");
  });

  it("keeps the voice's word under the node's", () => {
    const words = peerWords("mac", "user", "[voice] start an agent");
    expect(viaOf(words)).toBe("voice");
    expect(plainWords(words)).toBe("start an agent");
    expect(promptPeer(words)).toEqual({ node: "mac", who: "user" });
    expect(promptPeer(`<pasted_content id="x">${words}</pasted_content>`)).toEqual({ node: "mac", who: "user" });
    expect(promptPeer("[voice] here")).toBeNull();
  });
});

describe("who hears a reply", () => {
  const origin = (here: boolean, channels: "telegram"[] = [], peers: string[] = []) => ({ here, channels, peers });

  it("here: anything from here, or nothing at all; not a turn that answered only another node", () => {
    expect(spokenHere(origin(true), false)).toBe(true);
    expect(spokenHere(origin(false), false)).toBe(true);
    expect(spokenHere(origin(false, [], ["kuru@omarchy"]), false)).toBe(false);
    expect(spokenHere(origin(false, [], ["user@omarchy"]), false)).toBe(false);
    expect(spokenHere(origin(true, [], ["kuru@omarchy"]), false)).toBe(true);
    expect(spokenHere(origin(false, ["telegram"]), false)).toBe(false);
    expect(spokenHere(origin(false, ["telegram"]), true)).toBe(true);
  });

  it("on the Mac, a child's reply to the Mac's user, or about its own agents, and nothing else", () => {
    expect(peerReplySpoken(origin(false, [], ["user@mac"]), "mac")).toBe(true);
    expect(peerReplySpoken(origin(false), "mac")).toBe(true);
    expect(peerReplySpoken(origin(false, [], ["kuru@mac"]), "mac")).toBe(false);
    expect(peerReplySpoken(origin(true), "mac")).toBe(false);
    expect(peerReplySpoken(origin(false, ["telegram"]), "mac")).toBe(false);
    expect(peerReplySpoken(origin(false, [], ["user@laptop"]), "mac")).toBe(false);
  });
});

describe("the address", () => {
  const names = ["omarchy", "box-2"];

  it("typed, is @name and nothing looser", () => {
    expect(addressOf("@omarchy start the build", names, false)).toEqual({ node: "omarchy", rest: "start the build" });
    expect(addressOf("@Omarchy: start it", names, false)).toEqual({ node: "omarchy", rest: "start it" });
    expect(addressOf("omarchy is slow today", names, false)).toBeNull();
    expect(addressOf("@omarchyx hi", names, false)).toBeNull();
    expect(addressOf("@omarchy", names, false)).toBeNull();
    expect(addressOf("@mac hi", names, false)).toBeNull();
    expect(addressOf("ask @omarchy later", names, false)).toBeNull();
  });

  it("spoken, is how a person says it", () => {
    expect(addressOf("At Omarchy, start a Claude agent.", names, true)).toEqual({ node: "omarchy", rest: "Start a Claude agent." });
    expect(addressOf("Hey omarchy what is running", names, true)).toEqual({ node: "omarchy", rest: "What is running" });
    expect(addressOf("Omarchy, stop.", names, true)).toEqual({ node: "omarchy", rest: "Stop." });
    expect(addressOf("box 2, run the tests", names, true)).toEqual({ node: "box-2", rest: "Run the tests" });
    expect(addressOf("Tell me about omarchy", names, true)).toBeNull();
    expect(addressOf("Omarchy is slow today", names, true)).toBeNull();
  });
});

describe("a prompt from another node", () => {
  it("from its Kuru is a colleague's line, not yours", () => {
    const read = readPrompt("[kuru@omarchy] the build on api is green. Want me to deploy?");
    expect(read?.kind).toBe("notice");
    if (read?.kind !== "notice") return;
    expect(read.notice.from).toBe("Kuru on omarchy");
    expect(read.notice.what).toBe("the build on api is green");
  });

  it("from its user is yours, with where it came from", () => {
    const turn: Turn = { id: 4, conversationId: "c", at: 10, role: "you", via: "typed", text: "[user@mac] [voice] start it", lang: null, voiceId: null };
    const [item] = mergeConversation({ turns: [turn], outbox: [], missed: [] }) as YouItem[];
    expect(item).toMatchObject({ kind: "you", text: "start it", via: "voice", through: "mac" });
  });

  it("from a Kuru still on its way is the line it will be, and one item once taken", () => {
    const entry = { id: "ask-00112233", at: 5, ms: 0, state: "queued" as const, text: "[kuru@mac] run the tests", typedAt: null, note: null };
    const before = mergeConversation({ turns: [], outbox: [entry], missed: [] });
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ kind: "notice", from: "Kuru on mac" });
    const turn: Turn = { id: 9, conversationId: "c", at: 6, role: "you", via: "typed", text: entry.text, lang: null, voiceId: entry.id };
    const after = mergeConversation({ turns: [turn], outbox: [{ ...entry, state: "delivered" }], missed: [] });
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe("t9");
  });
});

describe("what crosses a link", () => {
  const reply: KuruReply = { kind: "kuru", id: "t2", at: 2, text: "done", utterance: "u9-x", fate: "unheard", aside: false, files: [{ path: "/Users/me/plan.md", line: null, text: "plan.md" } as never] };
  const notice: NoticeItem = { kind: "notice", id: "t3", at: 3, from: "kururu", agent: { name: "migrate", program: "claude", workspace: "api", card: null }, what: "finished its turn", event: "done", text: 'finished its turn. It said:\nthe key is sk-live-123' };
  const colleague: NoticeItem = { kind: "notice", id: "t4", at: 4, from: "Kuru on mac", agent: null, what: "run the tests", event: null, text: "run the tests please" };

  it("a notice keeps its line and never the reply it quoted; a colleague's words keep theirs", () => {
    const [, n, c] = peerItems([reply, notice, colleague]) as [KuruReply, NoticeItem, NoticeItem];
    expect(n.text).toBe("");
    expect(n.agent?.name).toBe("migrate");
    expect(n.what).toBe("finished its turn");
    expect(JSON.stringify(peerItems([notice]))).not.toContain("sk-live");
    expect(c.text).toBe("run the tests please");
  });

  it("a reply loses its links and this node's fate", () => {
    const [r] = peerItems([reply]) as [KuruReply];
    expect(r.files).toBeUndefined();
    expect(r.utterance).toBeNull();
    expect(r.fate).toBeNull();
  });

  it("is the newest few", () => {
    const many: KuruItem[] = Array.from({ length: 100 }, (_, i) => ({ ...reply, id: `t${i}`, at: i }));
    const out = peerItems(many);
    expect(out).toHaveLength(40);
    expect(out[out.length - 1]!.id).toBe("t99");
  });
});

describe("one drawer", () => {
  const you = (id: string, at: number, outboxId: string | null, state: YouItem["state"] = "delivered"): YouItem => ({
    kind: "you",
    id,
    at,
    text: "start it",
    via: "typed",
    ms: 0,
    state,
    typedAt: null,
    note: null,
    outboxId,
  });
  const peer = (items: KuruItem[]): PeerKuru => ({ node: { id: "n0123456789ab", name: "omarchy" }, state: "up", lastSeen: 1, items, unheard: 0, talks: true });

  it("merges by time and says whose each line is", () => {
    const local: KuruItem[] = [{ kind: "kuru", id: "t1", at: 1, text: "a", utterance: null, fate: null, aside: false }];
    const merged = mergeNodes(local, [peer([{ kind: "kuru", id: "t1", at: 2, text: "b", utterance: null, fate: null, aside: false }])]);
    expect(merged.map((item) => [item.node, item.id])).toEqual([
      [null, "t1"],
      ["omarchy", "n0123456789ab/t1"],
    ]);
  });

  it("draws a message sent to another Kuru once: on the outbox until it arrives, the turn after", () => {
    const sent = you("m-1", 5, "m-1", "queued");
    // On its way: this node's copy, and the other's own outbox copy too.
    expect(mergeNodes([sent], [peer([you("m-1", 6, "m-1", "queued")])]).map((item) => item.node)).toEqual([null, "omarchy"]);
    const arrived = mergeNodes([{ ...sent, state: "delivered" }], [peer([you("t7", 6, "m-1")])]);
    expect(arrived).toHaveLength(1);
    expect(arrived[0]!.node).toBe("omarchy");
    // Resend is this node's own list's, never another's.
    expect((arrived[0] as YouItem).outboxId).toBeNull();
  });

  it("and the other way round, on the node it arrived at", () => {
    const turn = you("t1", 6, "m-1");
    const theirs = you("m-1", 5, "m-1");
    const merged = mergeNodes([turn], [peer([theirs])]);
    expect(merged.map((item) => [item.node, item.id])).toEqual([[null, "t1"]]);
  });
});

describe("the link's Kuru messages", () => {
  it("are known types, and an older node's unknown ones are still ignored", () => {
    expect(parseLinkMessage(JSON.stringify({ type: "say", id: "abcdefgh" }))?.type).toBe("say");
    expect(parseLinkMessage(JSON.stringify({ type: "topic-made" }))).toBeNull();
  });

  it("are checked field by field", () => {
    expect(asSay({ type: "say", id: "abcdefgh", at: 1, text: "hi", who: "kuru", spoken: false })).not.toBeNull();
    expect(asSay({ type: "say", id: "../etc", at: 1, text: "hi", who: "kuru", spoken: false })).toBeNull();
    expect(asSay({ type: "say", id: "abcdefgh", at: Number.NaN, text: "hi", who: "kuru", spoken: false })).toBeNull();
    expect(asSay({ type: "say", id: "abcdefgh", at: 1, text: "hi", who: "root", spoken: false } as unknown as PeerMessage)).toBeNull();
    expect(asSay({ type: "say", id: "abcdefgh", at: 1, text: "   ", who: "user", spoken: false })).toBeNull();
    expect(asSayState({ type: "say-state", id: "abcdefgh", state: "gone", note: null, typedAt: null } as unknown as PeerMessage)).toBeNull();
    expect(asBoard({ type: "board", id: "abcdefgh", verb: "run_card", args: {} } as unknown as PeerMessage)).toBeNull();
    expect(asBoard({ type: "board", id: "abcdefgh", verb: "add_card", args: { title: "x" } })?.args).toEqual({ title: "x" });
    const replied = asReplied({ type: "kuru-replied", item: { id: "t1", at: 1, text: "ok" }, origin: { here: true, channels: [], peers: ["user@mac", 4 as never] }, answers: ["ask-0011223344", "x"] });
    expect(replied?.origin.peers).toEqual(["user@mac"]);
    expect(replied?.answers).toEqual(["ask-0011223344"]);
    expect(asKuruTurns({ type: "kuru-turns", items: [{ kind: "kuru", id: "t1", at: 1, text: "ok" } as never] })).toHaveLength(1);
    expect(asKuruTurns({ type: "kuru-turns", items: [{ kind: "you", id: "t1", at: 1, text: "ok", state: "weird" } as never] })).toBeNull();
  });
});

describe("another node's agents, as kururu_status names them", () => {
  it("by name, workspace and node, with no id a tool here would take", () => {
    expect(agentName({ id: null, name: "Migrate", doing: null, program: "claude", workspace: "api", card: null, node: "omarchy" })).toBe('"Migrate" (claude in api on omarchy)');
    const node: NodeStatus = {
      id: "n0123456789ab",
      name: "omarchy",
      address: "100.64.0.2",
      port: 7717,
      rank: 2,
      parent: false,
      state: "up",
      since: 1,
      lastSeen: 1,
      error: null,
      leader: false,
      url: "http://100.64.0.2:7717/",
      summary: {
        at: 1,
        version: "0",
        host: { version: null, current: true },
        profile: { key: "p", name: "Default" },
        workspaces: [
          {
            key: "w",
            name: "api",
            folder: "/home/o/api",
            band: "working",
            needs: [],
            agents: [{ id: "a7", kind: "agent", agent: "claude", titleOverride: "Migrate", title: "", status: "working", card: null } as never],
          },
        ],
        needs: { count: 0, inWorkspaces: 0 },
        kuru: { unheard: 0, undelivered: 0 },
        leads: false,
        sees: [],
        dataMark: "m",
        talks: PEER_TALK,
      },
    };
    const text = nodesText([node]).join("\n");
    expect(text).toContain('"Migrate" (claude in api on omarchy)');
    expect(text).not.toContain("a7");
    expect(text).toContain("ask_kuru");
    expect(nodesText([{ ...node, summary: { ...node.summary!, talks: undefined } }]).join("\n")).toContain("too old for ask_kuru");
  });
});
