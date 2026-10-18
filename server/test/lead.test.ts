/**
 * One Telegram among several nodes, the pure half: who polls and when the
 * poll moves (`LeadGate`), where a message from the chat goes (`routeOf`),
 * how each node's lines are marked and remembered, and what crosses a
 * link in the handover.
 *
 * The gate is the thing worth pinning hardest, because every failure of it
 * is either two nodes polling — a 409 for both and messages answered twice
 * — or none, which is a chat that goes quiet. So each rule of the plan's
 * failover is a case here, as arithmetic on the times.
 */
import { describe, expect, it } from "bun:test";

import {
  adoptSharedTelegram,
  backLine,
  heldLine,
  markLine,
  mergeReplies,
  nodeSubject,
  postedToChat,
  rememberSent,
  repliedNode,
  REPLY_MAP_MAX,
  routeOf,
  tookLine,
  updatesFrom,
  type ReplyMap,
} from "../../shared/channels";
import {
  asLeadState,
  asTelegramIn,
  asTelegramOut,
  LEAD_ASK_EVERY_MS,
  LEAD_BUSY_MAX_MS,
  LEAD_HANDOVER_MS,
  LEAD_RETRY_MS,
  LEAD_SETTLE_MS,
  LEAD_STAND_DOWN_MS,
  LEAD_TAKEBACK_MS,
  LEAD_TAKEOVER_MS,
  LeadGate,
  parseLinkMessage,
  rosterTelegram,
  withChannels,
  withMember,
  type LeadInput,
  type LeadPeer,
  type Roster,
} from "../../shared/nodes";

const MAC = "n000000000001";
const BOX = "n000000000002";
const LAPTOP = "n000000000003";
const T0 = 1_000_000;

function peer(over: Partial<LeadPeer> & { id: string; rank: number }): LeadPeer {
  return { up: true, since: T0, eligible: true, polls: false, ...over };
}

/** The box, ranked second under the Mac. */
function box(over: Partial<LeadInput> = {}, mac: Partial<LeadPeer> = {}): LeadInput {
  return { rank: 2, eligible: true, polling: false, peers: [peer({ id: MAC, rank: 1, ...mac })], ...over };
}

/** The Mac, ranked first over the box. */
function mac(over: Partial<LeadInput> = {}, boxPeer: Partial<LeadPeer> = {}): LeadInput {
  return { rank: 1, eligible: true, polling: false, peers: [peer({ id: BOX, rank: 2, ...boxPeer })], ...over };
}

describe("LeadGate: who leads", () => {
  it("is the Mac while it is up, and the box stands aside", () => {
    const gate = new LeadGate(T0, false);
    expect(gate.next(box(), T0 + 1000).step.do).toBe("stop");
    const macGate = new LeadGate(T0, false);
    expect(macGate.next(mac(), T0 + LEAD_SETTLE_MS).step).toEqual({ do: "poll" });
  });

  it("waits a moment after a start before polling with nobody seen holding it, unless it held the poll before", () => {
    const fresh = new LeadGate(T0, false);
    expect(fresh.next(mac(), T0 + 1000)).toEqual({ step: { do: "stop", why: "just started" }, wait: LEAD_SETTLE_MS - 1000 });
    const resumed = new LeadGate(T0, true);
    expect(resumed.next(mac(), T0 + 1000).step).toEqual({ do: "poll" });
  });

  it("is nobody who is not eligible", () => {
    const gate = new LeadGate(T0, true);
    expect(gate.next(mac({ eligible: false, polling: true }), T0).step.do).toBe("stop");
  });

  it("passes over a node above that cannot poll", () => {
    const gate = new LeadGate(T0, true);
    expect(gate.next(box({}, { eligible: false }), T0).step).toEqual({ do: "poll" });
    // An older kururu never says; up and silent on it is not a poller.
    expect(gate.next(box({}, { eligible: null }), T0).step).toEqual({ do: "poll" });
  });

  it("stands aside for a node above that polls, even while polling itself: a split that healed", () => {
    const gate = new LeadGate(T0, true);
    expect(gate.next(box({ polling: true }, { polls: true }), T0).step.do).toBe("stop");
  });
});

describe("LeadGate: taking over", () => {
  it("takes the poll once every node above has been away 30 s, and not before", () => {
    const gate = new LeadGate(T0, false);
    const away = box({}, { up: false, since: T0 });
    expect(gate.next(away, T0 + 10_000)).toEqual({ step: { do: "stop", why: "a node above went away only just now" }, wait: LEAD_TAKEOVER_MS - 10_000 });
    expect(gate.next(away, T0 + LEAD_TAKEOVER_MS).step).toEqual({ do: "poll" });
  });

  it("counts from its own start for a node above it never heard from", () => {
    const gate = new LeadGate(T0, false);
    const never = box({}, { up: false, since: null, eligible: null });
    expect(gate.next(never, T0 + 5_000).step.do).toBe("stop");
    expect(gate.next(never, T0 + LEAD_TAKEOVER_MS).step).toEqual({ do: "poll" });
  });

  it("waits thirty seconds of its own run for a node above, however long ago it was last heard", () => {
    const gate = new LeadGate(T0, false);
    const longGone = box({}, { up: false, since: T0 - 6 * 3600_000 });
    expect(gate.next(longGone, T0 + 1_000).wait).toBe(LEAD_TAKEOVER_MS - 1_000);
    expect(gate.next(longGone, T0 + LEAD_TAKEOVER_MS).step).toEqual({ do: "poll" });
  });

  it("carries on at once from a poll it held before a restart, and only the once", () => {
    const gate = new LeadGate(T0, true);
    const away = box({}, { up: false, since: T0 });
    expect(gate.next(away, T0 + 1).step).toEqual({ do: "poll" });
    const again = new LeadGate(T0, true);
    expect(again.next(box({}, { polls: true }), T0 + 1).step.do).toBe("stop");
    expect(again.next(away, T0 + 2).step.do).toBe("stop");
  });

  it("does not wait for a node above that said it cannot poll", () => {
    const gate = new LeadGate(T0, true);
    expect(gate.next(box({}, { up: false, since: T0, eligible: false }), T0 + 1).step).toEqual({ do: "poll" });
  });

  it("keeps the poll it has while a node above is only just away: a restart under bun run dev", () => {
    const gate = new LeadGate(T0, true);
    expect(gate.next(box({ polling: true }, { up: false, since: T0 }), T0 + 2_000).step).toEqual({ do: "poll" });
  });

  it("with three, the middle node takes over and the bottom one waits for it", () => {
    const middle = new LeadGate(T0, false);
    const bottom = new LeadGate(T0, false);
    const now = T0 + LEAD_TAKEOVER_MS + 1;
    const macAway = peer({ id: MAC, rank: 1, up: false, since: T0 });
    expect(middle.next({ rank: 2, eligible: true, polling: false, peers: [macAway, peer({ id: LAPTOP, rank: 3 })] }, now).step).toEqual({ do: "poll" });
    expect(bottom.next({ rank: 3, eligible: true, polling: false, peers: [macAway, peer({ id: BOX, rank: 2 })] }, now).step.do).toBe("stop");
  });
});

describe("LeadGate: taking back", () => {
  it("asks the holder only once the link has been up a minute", () => {
    const gate = new LeadGate(T0 - LEAD_SETTLE_MS, false);
    const holding = mac({}, { polls: true, since: T0 });
    expect(gate.next(holding, T0 + 30_000)).toEqual({ step: { do: "stop", why: "waiting for the link to settle before asking" }, wait: LEAD_TAKEBACK_MS - 30_000 });
    expect(gate.next(holding, T0 + LEAD_TAKEBACK_MS).step).toEqual({ do: "ask", peer: BOX, force: false });
  });

  it("asks a holder that never answers again, and a busy one every 30 s, then with force after ten minutes", () => {
    const gate = new LeadGate(T0 - LEAD_SETTLE_MS, false);
    const holding = mac({}, { polls: true, since: T0 });
    let now = T0 + LEAD_TAKEBACK_MS;
    expect(gate.next(holding, now).step.do).toBe("ask");
    gate.asked(BOX, now);
    expect(gate.next(holding, now + 1000).wait).toBe(LEAD_HANDOVER_MS - 1000);
    now += LEAD_HANDOVER_MS;
    expect(gate.next(holding, now).step).toEqual({ do: "ask", peer: BOX, force: false });
    gate.asked(BOX, now);
    gate.busy(BOX, now);
    expect(gate.next(holding, now + 200).wait).toBe(LEAD_ASK_EVERY_MS - 200);
    const first = T0 + LEAD_TAKEBACK_MS;
    for (now = now + LEAD_ASK_EVERY_MS; now < first + LEAD_BUSY_MAX_MS; now += LEAD_ASK_EVERY_MS) {
      expect(gate.next(holding, now).step).toEqual({ do: "ask", peer: BOX, force: false });
      gate.asked(BOX, now);
      gate.busy(BOX, now);
    }
    expect(gate.next(holding, now).step).toEqual({ do: "ask", peer: BOX, force: true });
  });

  it("asks at once and with force when hurried, for a pairing", () => {
    const gate = new LeadGate(T0 - LEAD_SETTLE_MS, false);
    gate.hurry(T0 + 1000);
    expect(gate.next(mac({}, { polls: true, since: T0 }), T0 + 1000).step).toEqual({ do: "ask", peer: BOX, force: true });
  });

  it("polls once it has taken the poll, and the holder stands aside", () => {
    const gate = new LeadGate(T0 - LEAD_SETTLE_MS, false);
    gate.asked(BOX, T0 + LEAD_TAKEBACK_MS);
    gate.took();
    expect(gate.next(mac({ polling: true }, { polls: false }), T0 + LEAD_TAKEBACK_MS + 1).step).toEqual({ do: "poll" });
    const boxGate = new LeadGate(T0 - LEAD_SETTLE_MS, false);
    expect(boxGate.next(box({ polling: false }, { polls: true }), T0 + LEAD_TAKEBACK_MS + 1).step.do).toBe("stop");
  });

  it("keeps the holder polling while the Mac is up and has not asked yet", () => {
    const gate = new LeadGate(T0 - LEAD_SETTLE_MS, false);
    expect(gate.next(box({ polling: true }, { since: T0 }), T0 + 5_000).step).toEqual({ do: "poll" });
  });
});

describe("LeadGate: waking", () => {
  it("starts again from a wake: no poll until the links had a moment, then the handshake for one a lower node took", () => {
    const gate = new LeadGate(T0, true);
    expect(gate.next(mac({ polling: true }, { up: false }), T0 + 1).step).toEqual({ do: "poll" });
    const woke = T0 + 3600_000;
    gate.woke(woke);
    expect(gate.next(mac({}, { up: false, since: T0 }), woke + 1).step.do).toBe("stop");
    // The box linked again and says it reads the chat: ask, a minute on.
    const holding = mac({}, { polls: true, since: woke + 3_000 });
    expect(gate.next(holding, woke + LEAD_SETTLE_MS).step.do).toBe("stop");
    expect(gate.next(holding, woke + 3_000 + LEAD_TAKEBACK_MS).step).toEqual({ do: "ask", peer: BOX, force: false });
  });
});

describe("LeadGate: the 409", () => {
  it("lets the higher of two pollers win: the lower stands down five minutes, the higher retries in thirty seconds", () => {
    const macGate = new LeadGate(T0, true);
    const boxGate = new LeadGate(T0, true);
    // A split: each sees the other away.
    const macSees = mac({ polling: true }, { up: false, since: T0 });
    const boxSees = box({ polling: true }, { up: false, since: T0 - LEAD_TAKEOVER_MS });
    expect(macGate.conflict(macSees, T0)).toBe("higher");
    expect(boxGate.conflict(boxSees, T0)).toBe("lower");
    expect(macGate.next(macSees, T0 + 1).step.do).toBe("stop");
    expect(macGate.next(macSees, T0 + LEAD_RETRY_MS).step).toEqual({ do: "poll" });
    expect(boxGate.next(boxSees, T0 + LEAD_RETRY_MS).step.do).toBe("stop");
    expect(boxGate.standingDown(T0 + 1)).toBe(T0 + LEAD_STAND_DOWN_MS);
    expect(boxGate.next(boxSees, T0 + LEAD_STAND_DOWN_MS).step).toEqual({ do: "poll" });
  });

  it("counts a node above that never said as the other poller", () => {
    const gate = new LeadGate(T0, true);
    expect(gate.conflict(box({}, { up: false, eligible: null }), T0)).toBe("lower");
    expect(new LeadGate(T0, true).conflict(box({}, { eligible: false }), T0)).toBe("higher");
  });
});

describe("routeOf", () => {
  const nodes = [
    { id: MAC, name: "mac" },
    { id: BOX, name: "omarchy" },
  ];
  const map = rememberSent([], "42", [7, 8], BOX);
  const route = (text: string, replyTo: number | null = null) => routeOf({ text, chat: "42", replyTo, map, nodes, leader: MAC });

  it("sends a bare message to the leader", () => {
    expect(route("check the build")).toEqual({ node: MAC, text: "check the build", by: "leader" });
  });

  it("sends @node and /node to that node, without the address", () => {
    expect(route("@omarchy start the build")).toEqual({ node: BOX, text: "start the build", by: "address" });
    expect(route("/omarchy start the build")).toEqual({ node: BOX, text: "start the build", by: "address" });
    expect(route("/omarchy@kuru_bot what is running")).toEqual({ node: BOX, text: "what is running", by: "address" });
    expect(route("@Omarchy: hi")).toEqual({ node: BOX, text: "hi", by: "address" });
    expect(route("@mac hi").node).toBe(MAC);
    expect(route("@omarchy")).toEqual({ node: BOX, text: "", by: "address" });
  });

  it("leaves a slash command and a sentence alone", () => {
    expect(route("/compact")).toEqual({ node: MAC, text: "/compact", by: "leader" });
    expect(route("ask @omarchy later").node).toBe(MAC);
    expect(route("@omarchyx hi").node).toBe(MAC);
  });

  it("sends a reply to one of a node's lines to that node, and an address beats it", () => {
    expect(route("yes, deploy it", 8)).toEqual({ node: BOX, text: "yes, deploy it", by: "reply" });
    expect(route("yes", 9).node).toBe(MAC);
    expect(route("@mac never mind", 8).node).toBe(MAC);
  });

  it("does not follow the map to a node that has left the roster", () => {
    const gone = rememberSent([], "42", [5], LAPTOP);
    expect(routeOf({ text: "hi", chat: "42", replyTo: 5, map: gone, nodes, leader: MAC }).node).toBe(MAC);
  });

  it("knows a reply is a reply off Telegram's own update", () => {
    const parsed = updatesFrom({
      ok: true,
      result: [{ update_id: 1, message: { message_id: 9, date: 1, chat: { id: 42, type: "private" }, from: { id: 42, is_bot: false }, text: "yes", reply_to_message: { message_id: 8 } } }],
    });
    expect(parsed!.messages[0]!.replyTo).toBe(8);
  });
});

describe("the reply map", () => {
  it("remembers every part of a long line, per chat, and stays bounded", () => {
    let map: ReplyMap = [];
    map = rememberSent(map, "1", [10, 11], BOX);
    expect(repliedNode(map, "1", 11)).toBe(BOX);
    expect(repliedNode(map, "2", 11)).toBeNull();
    for (let i = 0; i < REPLY_MAP_MAX + 10; i++) map = rememberSent(map, "1", [100 + i], MAC);
    expect(map.length).toBe(REPLY_MAP_MAX);
    expect(repliedNode(map, "1", 10)).toBeNull();
  });

  it("merges with the newer word winning", () => {
    const older = rememberSent(rememberSent([], "1", [1], MAC), "1", [2], MAC);
    const newer = rememberSent([], "1", [2], BOX);
    const merged = mergeReplies(older, newer);
    expect(repliedNode(merged, "1", 1)).toBe(MAC);
    expect(repliedNode(merged, "1", 2)).toBe(BOX);
  });
});

describe("the lines", () => {
  it("marks a child's line and not the parent's", () => {
    expect(markLine("omarchy", "The build passed.")).toBe("[Omarchy] The build passed.");
    expect(markLine(null, "The build passed.")).toBe("The build passed.");
  });

  it("says who is in charge, and since when the others were away", () => {
    const at = new Date(2026, 9, 18, 23, 10).getTime();
    expect(tookLine("omarchy", [{ name: "mac", since: at }])).toBe("Omarchy's Kuru is in charge. The Mac has been away since 23:10.");
    expect(backLine("mac")).toBe("The Mac's Kuru is back in charge.");
    expect(heldLine("mac", at)).toBe("The Mac is away (since 23:10), so this waits for it and reaches its Kuru when it is back.");
    expect(nodeSubject("box-2")).toBe("Box-2");
  });

  it("posts every reply but one that only answered another Kuru", () => {
    expect(postedToChat({ here: false, channels: [], peers: [] })).toBe(true);
    expect(postedToChat({ here: false, channels: [], peers: ["kuru@mac"] })).toBe(false);
    expect(postedToChat({ here: false, channels: [], peers: ["user@mac"] })).toBe(true);
    expect(postedToChat({ here: false, channels: ["telegram"], peers: ["kuru@mac"] })).toBe(true);
  });
});

describe("the roster's channel settings", () => {
  const roster: Roster = {
    version: 3,
    parent: MAC,
    signer: `${"A".repeat(43)}=`,
    members: [{ id: MAC, name: "mac", keys: { sign: `${"B".repeat(43)}=`, box: `${"C".repeat(43)}=` }, address: "100.64.0.1", port: 7717, rank: 1 }],
    issuedAt: 1,
  };
  const telegram = { enabled: true, enabledAt: 5, allowed: [{ id: "111", name: "Sam", username: null, addedAt: 1 }], bot: { id: "123", username: "kuru_bot", name: "Kuru" } };

  it("rides in the roster, a version on, and only when it changed", () => {
    const next = withChannels(roster, telegram, 10)!;
    expect(next.version).toBe(4);
    expect(rosterTelegram(next)).toEqual(telegram);
    expect(withChannels(next, telegram, 11)).toBeNull();
    expect(rosterTelegram(withChannels(next, null, 12))).toBeNull();
  });

  it("survives the parent's other edits", () => {
    const next = withChannels(roster, telegram, 10)!;
    const grown = withMember(next, { id: BOX, name: "omarchy", keys: { sign: `${"D".repeat(43)}=`, box: `${"E".repeat(43)}=` }, address: "100.64.0.2", port: 7717 }, 20);
    expect(rosterTelegram(grown)).toEqual(telegram);
  });

  it("is checked as the file's own settings are: on with nobody allowed is off", () => {
    expect(adoptSharedTelegram({ enabled: true, allowed: [] })!.enabled).toBe(false);
    expect(adoptSharedTelegram("nope")).toBeNull();
  });
});

describe("the handover on the wire", () => {
  const state = {
    botId: "123",
    offset: 501,
    outgoing: [{ id: "o1", chat: "111", text: "[Omarchy] done", silent: false, at: 5, origin: BOX }],
    held: [{ node: MAC, id: "telegram-111-9", at: 6, text: "for the Mac" }],
    replies: rememberSent([], "111", [3], BOX),
    handled: ["telegram-111-8"],
    lastInAt: 7,
  };

  it("crosses whole and comes back the same", () => {
    expect(asLeadState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it("refuses a state with anything wrong in it, rather than half of one", () => {
    expect(asLeadState({ ...state, offset: Number.NaN })).toBeNull();
    expect(asLeadState({ ...state, outgoing: [{ ...state.outgoing[0], origin: "someone" }] })).toBeNull();
    expect(asLeadState({ ...state, held: [{ ...state.held[0], id: "../x" }] })).toBeNull();
    expect(asLeadState({ ...state, replies: [["k", 5]] })).toBeNull();
  });

  it("knows the new messages, and checks the chat's words both ways", () => {
    expect(parseLinkMessage(JSON.stringify({ type: "lead-ask", id: "a1", force: false }))?.type).toBe("lead-ask");
    const inMsg = parseLinkMessage(JSON.stringify({ type: "telegram-in", id: "telegram-111-9", at: 5, text: "hi" }))!;
    expect(asTelegramIn(inMsg)).toEqual({ type: "telegram-in", id: "telegram-111-9", at: 5, text: "hi" });
    expect(asTelegramIn({ ...inMsg, text: "  " } as never)).toBeNull();
    const out = parseLinkMessage(JSON.stringify({ type: "telegram-out", id: "out-12345678", at: 5, text: "done", silent: 1 }))!;
    expect(asTelegramOut(out)).toEqual({ type: "telegram-out", id: "out-12345678", at: 5, text: "done", silent: false, notice: false });
  });
});
