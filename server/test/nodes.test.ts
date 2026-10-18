/**
 * Nodes: the roster's signature and who adopts which, the pairing code,
 * who leads and who dials, the summary another node draws, and the link's
 * handshake over a fake pair of sockets.
 *
 * The crypto is real — Ed25519 from `node:crypto`, the same calls the
 * server makes — because a test that signed with a stand-in would pass on
 * a payload the server cannot verify.
 */
import { describe, expect, it } from "bun:test";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import {
  adoptRoster,
  asSignedRoster,
  byRank,
  canonical,
  checkCode,
  CODE_ATTEMPTS,
  CODE_LENGTH,
  defaultNodeName,
  dialTargets,
  formatCode,
  freeName,
  joinCommand,
  leaderOf,
  LinkHandshake,
  makeCode,
  nodeName,
  nodeRemoteAllowed,
  nodesNeedCount,
  nodesText,
  nodeUrl,
  normalizeCode,
  parseLinkMessage,
  parseJoin,
  parseNodeAddress,
  reranked,
  rosterPayload,
  summarize,
  summaryKey,
  withChange,
  withMember,
  withoutMember,
  type LinkMessage,
  type NodeEntry,
  type NodeStatus,
  type Roster,
  type SignedRoster,
} from "../../shared/nodes";
import { verifySigned } from "../src/nodekeys";
import { addCard, emptyBoard, startRun } from "../../shared/board";
import type { AgentSnapshot, Profile, Workspace } from "../../shared/model";

interface Pair {
  pub: string;
  sign: (payload: string) => string;
}

function keyPair(): Pair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  return { pub: spki.subarray(spki.length - 32).toString("base64"), sign: (payload) => edSign(null, Buffer.from(payload), privateKey).toString("base64") };
}

const BOX = Buffer.alloc(32, 7).toString("base64");

interface Node {
  id: string;
  keys: Pair;
}

function node(n: number): Node {
  return { id: `n${String(n).padStart(12, "0")}`, keys: keyPair() };
}

function entry(n: Node, name: string, rank: number): NodeEntry {
  return { id: n.id, name, keys: { sign: n.keys.pub, box: BOX }, address: `100.64.0.${rank}`, port: 7717, rank };
}

function signed(roster: Roster, signer: Pair): SignedRoster {
  return { roster, signature: signer.sign(rosterPayload(roster)) };
}

const parentKey = keyPair();
const mac = node(1);
const omarchy = node(2);
const laptop = node(3);

function roster(members: NodeEntry[], version = 1): Roster {
  return { version, parent: mac.id, signer: parentKey.pub, members, issuedAt: 1000 };
}

describe("canonical", () => {
  it("sorts keys at every depth and drops undefined", () => {
    expect(canonical({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"y":2,"z":1}]},"b":1}');
  });
  it("gives the same bytes for the same roster built in another order", () => {
    const a = roster([entry(mac, "mac", 1)]);
    const b = { issuedAt: a.issuedAt, members: a.members, signer: a.signer, parent: a.parent, version: a.version };
    expect(rosterPayload(b)).toBe(rosterPayload(a));
  });
});

describe("adoptRoster", () => {
  const v1 = signed(roster([entry(mac, "mac", 1)]), parentKey);
  const v2 = signed(roster([entry(mac, "mac", 1), entry(omarchy, "omarchy", 2)], 2), parentKey);

  it("takes a newer roster the anchor signed", () => {
    const got = adoptRoster(v1, v2, parentKey.pub, verifySigned);
    expect(got.adopted).toBe(true);
  });
  it("refuses an older one and the same one", () => {
    expect(adoptRoster(v2, v1, parentKey.pub, verifySigned)).toEqual({ adopted: false, why: "older" });
    expect(adoptRoster(v2, v2, parentKey.pub, verifySigned)).toEqual({ adopted: false, why: "same" });
  });
  it("refuses a roster with a member added after signing", () => {
    const forged = { roster: { ...v2.roster, members: [...v2.roster.members, entry(laptop, "laptop", 3)] }, signature: v2.signature };
    expect(adoptRoster(v1, forged, parentKey.pub, verifySigned)).toEqual({ adopted: false, why: "forged" });
  });
  it("refuses another parent's roster, however well signed", () => {
    const other = keyPair();
    const theirs = signed({ ...roster([entry(mac, "mac", 1)], 9), signer: other.pub }, other);
    expect(adoptRoster(v1, theirs, parentKey.pub, verifySigned)).toEqual({ adopted: false, why: "stranger" });
    // With no anchor — a node being paired — it is taken, on the code's say-so.
    expect(adoptRoster(null, theirs, null, verifySigned).adopted).toBe(true);
  });
  it("refuses a malformed one: no parent among the members, a duplicate name, a bad key", () => {
    const noParent = signed({ ...roster([entry(omarchy, "omarchy", 1)]) }, parentKey);
    expect(adoptRoster(null, noParent, parentKey.pub, verifySigned).adopted).toBe(false);
    const dup = signed(roster([entry(mac, "mac", 1), entry(omarchy, "mac", 2)], 2), parentKey);
    expect(asSignedRoster(dup)).toBeNull();
    const badKey = signed(roster([{ ...entry(mac, "mac", 1), keys: { sign: "nope", box: BOX } }]), parentKey);
    expect(asSignedRoster(badKey)).toBeNull();
    expect(adoptRoster(null, "a string", null, verifySigned)).toEqual({ adopted: false, why: "malformed" });
  });
  it("signs and keeps a field a later phase adds, so it is passed on whole", () => {
    const later = { ...roster([entry(mac, "mac", 1)], 3), channels: { telegram: { allow: ["1"] } } } as Roster;
    const got = adoptRoster(v2, signed(later, parentKey), parentKey.pub, verifySigned);
    expect(got.adopted && (got.roster.roster as unknown as { channels: unknown }).channels).toEqual({ telegram: { allow: ["1"] } });
  });
});

describe("the parent's edits", () => {
  const base = roster([entry(mac, "mac", 1), entry(omarchy, "omarchy", 2)], 4);

  it("adds a member last, one version on", () => {
    const next = withMember(base, { id: laptop.id, name: "laptop", keys: { sign: laptop.keys.pub, box: BOX }, address: "100.64.0.9", port: 7717 }, 2000);
    expect(next.version).toBe(5);
    expect(byRank(next.members).map((m) => m.name)).toEqual(["mac", "omarchy", "laptop"]);
    expect(next.issuedAt).toBe(2000);
  });
  it("renumbers ranks when one goes, so a gap never makes two orders look different", () => {
    const three = withMember(base, { id: laptop.id, name: "laptop", keys: { sign: laptop.keys.pub, box: BOX }, address: "100.64.0.9", port: 7717 }, 2000);
    const two = withoutMember(three, omarchy.id, 3000);
    expect(two.members.map((m) => [m.name, m.rank])).toEqual([
      ["mac", 1],
      ["laptop", 2],
    ]);
  });
  it("reranks from the drag's order, keeping unnamed members after the named", () => {
    const three = withMember(base, { id: laptop.id, name: "laptop", keys: { sign: laptop.keys.pub, box: BOX }, address: "100.64.0.9", port: 7717 }, 2000);
    const moved = reranked(three, [omarchy.id, mac.id], 3000);
    expect(byRank(moved.members).map((m) => m.name)).toEqual(["omarchy", "mac", "laptop"]);
    expect(reranked(three, ["n999999999999", omarchy.id, omarchy.id], 3000).members.find((m) => m.id === omarchy.id)?.rank).toBe(1);
  });
  it("renames in place", () => {
    expect(withChange(base, omarchy.id, { name: "box" }, 1).members.find((m) => m.id === omarchy.id)?.name).toBe("box");
  });
});

describe("rank: who dials, who leads", () => {
  const three = roster([entry(mac, "mac", 1), entry(omarchy, "omarchy", 2), entry(laptop, "laptop", 3)]);

  it("the lower rank dials the higher, so the first dials nobody", () => {
    expect(dialTargets(three, mac.id)).toEqual([]);
    expect(dialTargets(three, omarchy.id).map((m) => m.name)).toEqual(["mac"]);
    expect(dialTargets(three, laptop.id).map((m) => m.name)).toEqual(["mac", "omarchy"]);
    expect(dialTargets(three, "n999999999999")).toEqual([]);
  });
  it("leads: the highest-ranked of itself and what it can reach", () => {
    expect(leaderOf(three, new Set([omarchy.id]), mac.id)).toBe(mac.id);
    expect(leaderOf(three, new Set([mac.id, laptop.id]), omarchy.id)).toBe(mac.id);
    // The Mac's lid is shut: the next in rank leads what it can reach.
    expect(leaderOf(three, new Set([laptop.id]), omarchy.id)).toBe(omarchy.id);
    expect(leaderOf(three, new Set(), laptop.id)).toBe(laptop.id);
    expect(leaderOf(null, new Set(), mac.id)).toBeNull();
  });
});

describe("the join code and its command", () => {
  it("is eight characters from the unambiguous alphabet", () => {
    const code = makeCode(new Uint8Array([0, 30, 31, 255, 8, 100, 7, 9]));
    expect(code).toHaveLength(CODE_LENGTH);
    expect(code).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
    expect(formatCode("ABCDEFGH")).toBe("ABCD-EFGH");
  });
  it("is shown as one command with the Mac's address in it", () => {
    expect(joinCommand("100.64.0.1", 7717, "ABCDEFGH")).toBe("kururu child join 100.64.0.1:7717 ABCD-EFGH");
  });
  it("is read back out of whatever was pasted", () => {
    const want = { address: "100.64.0.1", port: 7717, code: "ABCDEFGH" };
    expect(parseJoin("kururu child join 100.64.0.1:7717 ABCD-EFGH", 7717)).toEqual(want);
    expect(parseJoin("  node tools/kururu.mjs child join 100.64.0.1 abcd-efgh\n", 7717)).toEqual(want);
    expect(parseJoin("100.64.0.1:7717 ABCDEFGH", 7717)).toEqual(want);
    expect(parseJoin("kururu child join 100.64.0.1:7717", 7717)).toBeNull();
    expect(parseJoin("kururu child join 100.64.0.1:7717 ABC-DEF", 7717)).toBeNull();
    expect(parseJoin("kururu child join https://x ABCD-EFGH", 7717)).toBeNull();
    expect(parseJoin(42, 7717)).toBeNull();
  });
  it("takes what a person typed: case, a dash, spaces", () => {
    expect(normalizeCode(" abcd-efgh ")).toBe("ABCDEFGH");
    expect(checkCode({ code: "ABCDEFGH", expiresAt: 10, misses: 0 }, "abcd efgh", 5)).toEqual({ ok: true });
  });
  it("expires, and a fifth wrong code burns it", () => {
    expect(checkCode({ code: "ABCDEFGH", expiresAt: 10, misses: 0 }, "ABCDEFGH", 10)).toEqual({ ok: false, why: "expired", pairing: null });
    expect(checkCode(null, "ABCDEFGH", 0)).toEqual({ ok: false, why: "none", pairing: null });
    let pairing = { code: "ABCDEFGH", expiresAt: 100, misses: 0 };
    for (let i = 1; i < CODE_ATTEMPTS; i++) {
      const miss = checkCode(pairing, "ZZZZZZZZ", 1);
      expect(miss.ok).toBe(false);
      if (miss.ok || !miss.pairing) throw new Error("expected a miss that keeps the code");
      pairing = miss.pairing;
    }
    expect(checkCode(pairing, "ZZZZZZZZ", 1)).toEqual({ ok: false, why: "burnt", pairing: null });
  });
});

describe("addresses", () => {
  it("parses what the user types into the parent's form", () => {
    expect(parseNodeAddress("100.96.1.2", 7717)).toEqual({ address: "100.96.1.2", port: 7717 });
    expect(parseNodeAddress("100.96.1.2:7817", 7717)).toEqual({ address: "100.96.1.2", port: 7817 });
    expect(parseNodeAddress("http://box1:7717/?k=secret", 7717)).toEqual({ address: "box1", port: 7717 });
    expect(parseNodeAddress("box.example-tailnet.ts.net", 7717)).toEqual({ address: "box.example-tailnet.ts.net", port: 7717 });
  });
  it("refuses anything that is not a host", () => {
    for (const bad of ["", "https://x", "a b", "user:pw@host", "999.1.1.1", "x:99999", 42]) expect(parseNodeAddress(bad, 7717)).toBeNull();
  });
  it("lets a node's routes answer the tailnet and loopback only", () => {
    expect(nodeRemoteAllowed("100.96.20.30")).toBe(true);
    expect(nodeRemoteAllowed("::ffff:100.64.0.1")).toBe(true);
    expect(nodeRemoteAllowed("127.0.0.1")).toBe(true);
    expect(nodeRemoteAllowed("192.168.1.20")).toBe(false);
    expect(nodeRemoteAllowed("100.128.0.1")).toBe(false);
    expect(nodeRemoteAllowed(undefined)).toBe(false);
  });
  it("builds the URL a browser opens, with the token only when given", () => {
    expect(nodeUrl({ address: "100.64.0.2", port: 7717 }, null)).toBe("http://100.64.0.2:7717/");
    expect(nodeUrl({ address: "100.64.0.2", port: 7717 }, "a+b")).toBe("http://100.64.0.2:7717/?k=a%2Bb");
  });
});

describe("names", () => {
  it("are lowercase, start with a letter, and fit", () => {
    expect(nodeName("Omarchy PC")).toBe("omarchy-pc");
    expect(nodeName("42box")).toBe("box");
    expect(nodeName("---")).toBeNull();
    expect(nodeName("a".repeat(40))).toHaveLength(24);
  });
  it("defaults to mac on a Mac and the hostname's first label elsewhere", () => {
    expect(defaultNodeName("Somebodys-MacBook-Pro.local", "darwin")).toBe("mac");
    expect(defaultNodeName("box1.lan", "linux")).toBe("box1");
    expect(defaultNodeName("", "linux")).toBe("node");
  });
  it("finds a free one", () => {
    const r = roster([entry(mac, "mac", 1), entry(omarchy, "box", 2)]);
    expect(freeName(r, "box")).toBe("box-2");
    expect(freeName(r, "box", omarchy.id)).toBe("box");
  });
});

function agent(id: string, over: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return { id, kind: "agent", title: null, status: "idle", agent: "claude", unread: false, cwd: "/w", pid: 99, command: "claude --secret-prompt", createdAt: 0, contextUsage: null, exited: false, exitCode: null, titleOverride: null, ...over } as AgentSnapshot;
}

function workspace(id: string, name: string, agentIds: string[], over: Partial<Workspace> = {}): Workspace {
  return {
    id,
    key: `k-${id}`,
    name,
    layout: { type: "pane", pane: { id: `p-${id}`, agentIds, activeIdx: 0, cwd: "/w" } },
    focusedPaneId: `p-${id}`,
    lastPaneId: null,
    mascotId: null,
    group: null,
    board: null,
    machine: null,
    agentPlacement: null,
    ...over,
  } as Workspace;
}

describe("summarize", () => {
  const board = (() => {
    const b = addCard(emptyBoard(), { title: "Fix the checkout", column: "doing" }, "c1", 1);
    return startRun(b, "c1", { agentId: "a2", label: "Claude", launcher: "claude", startedAt: 1 } as never);
  })();
  const profile = {
    id: "p1",
    key: "pk",
    name: "Work",
    workspaces: [workspace("w1", "api", ["a1", "a2", "a9"], { board }), workspace("w2", "web", ["a3"])],
    activeWorkspaceId: "w1",
    harness: { agentId: "a9" },
  } as unknown as Profile;
  const agents = [agent("a1", { status: "blocked", activity: "x".repeat(400) }), agent("a2", { status: "working" }), agent("a3"), agent("a9", { status: "blocked" })];
  const summary = summarize({
    at: 5,
    version: "0.4.0",
    host: { version: "0.4.0", current: true },
    profile,
    agents,
    folderOf: (id) => (id === "w1" ? "/code/api" : null),
    kuru: { unheard: 1, undelivered: 0 },
    leads: true,
    sees: ["n000000000002"],
    dataMark: "1.2.3@4",
  });

  it("carries each workspace with its folder, band and agents, the harness left out", () => {
    expect(summary.workspaces.map((w) => [w.name, w.folder, w.band])).toEqual([
      ["api", "/code/api", "needs"],
      ["web", null, "quiet"],
    ]);
    expect(summary.workspaces[0]!.agents.map((a) => a.id)).toEqual(["a1", "a2"]);
  });
  it("counts what needs the user by needsOf's rule, never the harness", () => {
    expect(summary.needs).toEqual({ count: 1, inWorkspaces: 1 });
    expect(summary.workspaces[0]!.needs).toEqual([{ kind: "asking", agentId: "a1", cardId: null, title: "claude" }]);
  });
  it("names the card an agent runs, drops the process's own fields, and clips long text", () => {
    const a2 = summary.workspaces[0]!.agents.find((a) => a.id === "a2")!;
    expect(a2.card?.title).toBe("Fix the checkout");
    const a1 = summary.workspaces[0]!.agents[0]! as unknown as Record<string, unknown>;
    expect(a1.pid).toBeUndefined();
    expect(a1.command).toBeUndefined();
    expect((a1.activity as string).length).toBeLessThanOrEqual(160);
  });
  it("compares without its timestamp", () => {
    expect(summaryKey({ ...summary, at: 99 })).toBe(summaryKey(summary));
    expect(summaryKey({ ...summary, leads: false })).not.toBe(summaryKey(summary));
  });
  it("is counted by the tray only while its node is up, and listed to Kuru without the token", () => {
    const status: NodeStatus = {
      id: omarchy.id,
      name: "omarchy",
      address: "100.64.0.2",
      port: 7717,
      rank: 2,
      parent: false,
      state: "up",
      since: 0,
      lastSeen: 0,
      error: null,
      summary,
      leader: false,
      url: "http://100.64.0.2:7717/?k=secret",
    };
    expect(nodesNeedCount([status, { ...status, state: "away" }])).toBe(1);
    const text = nodesText([status]).join("\n");
    expect(text).toContain("omarchy");
    expect(text).toContain("api (/code/api) · needs");
    expect(text).not.toContain("secret");
    expect(nodesText([]).join("\n")).toContain("not paired");
  });
});

/**
 * Two handshakes wired to each other the way two ends of a socket are: what
 * one sends, the other receives, in order. Each side holds its own roster
 * and adopts what the other brings by the real rule.
 */
function wire(a: { me: Node; held: SignedRoster | null; expect?: string }, b: { me: Node; held: SignedRoster | null; expect?: string }) {
  const sides = [a, b].map((side) => {
    const state = { roster: side.held, up: null as string | null, refused: null as string | null, sent: [] as LinkMessage[] };
    const hs = new LinkHandshake({
      self: side.me.id,
      version: "test",
      challenge: Buffer.from(side.me.id.repeat(3)).toString("base64"),
      sign: side.me.keys.sign,
      verify: verifySigned,
      roster: () => state.roster,
      adopt: (incoming) => {
        const got = adoptRoster(state.roster, incoming, parentKey.pub, verifySigned);
        if (got.adopted) state.roster = got.roster;
      },
      ...(side.expect ? { expect: side.expect } : {}),
    });
    return { hs, state };
  });
  const queue: Array<{ to: 0 | 1; message: LinkMessage }> = [
    { to: 1, message: sides[0]!.hs.hello() },
    { to: 0, message: sides[1]!.hs.hello() },
  ];
  while (queue.length) {
    const { to, message } = queue.shift()!;
    const side = sides[to]!;
    // Through JSON, as on the wire.
    for (const step of side.hs.receive(parseLinkMessage(JSON.stringify(message))!)) {
      if (step.kind === "send") queue.push({ to: to === 0 ? 1 : 0, message: step.message });
      else if (step.kind === "up") side.state.up = step.peer;
      else {
        side.state.refused = step.reason;
        if (step.tell) queue.push({ to: to === 0 ? 1 : 0, message: { type: "refuse", reason: step.reason } });
      }
    }
  }
  return sides.map((s) => s.state);
}

describe("the link's handshake", () => {
  const v1 = signed(roster([entry(mac, "mac", 1), entry(omarchy, "omarchy", 2)]), parentKey);

  it("brings two members up, each knowing the other", () => {
    const [m, o] = wire({ me: mac, held: v1 }, { me: omarchy, held: v1, expect: mac.id });
    expect(m!.up).toBe(omarchy.id);
    expect(o!.up).toBe(mac.id);
  });
  it("refuses a node the roster does not list", () => {
    const [m, l] = wire({ me: mac, held: v1 }, { me: laptop, held: v1 });
    expect(m!.up).toBeNull();
    expect(m!.refused).toBe("not a member of the roster");
    expect(l!.up).toBeNull();
  });
  it("refuses a node whose key is not the one the roster lists", () => {
    const impostor = { id: omarchy.id, keys: keyPair() };
    const [m] = wire({ me: mac, held: v1 }, { me: impostor, held: v1 });
    expect(m!.up).toBeNull();
    expect(m!.refused).toContain("the proof does not match");
  });
  it("lets a new member in through a peer that had not heard of it, by the roster it brings", () => {
    const v2 = signed(roster([entry(mac, "mac", 1), entry(omarchy, "omarchy", 2), entry(laptop, "laptop", 3)], 2), parentKey);
    const [o, l] = wire({ me: omarchy, held: v1 }, { me: laptop, held: v2, expect: omarchy.id });
    expect(o!.up).toBe(laptop.id);
    expect(l!.up).toBe(omarchy.id);
    expect(o!.roster?.roster.version).toBe(2);
  });
  it("tells a removed node it is out, from the first node it meets", () => {
    const v2 = signed(withoutMember(v1.roster, omarchy.id, 2000), parentKey);
    const [m, o] = wire({ me: mac, held: v2 }, { me: omarchy, held: v1, expect: mac.id });
    expect(m!.up).toBeNull();
    expect(o!.up).toBeNull();
    // The removed node now holds the roster it is not in, which is how it unpairs.
    expect(o!.roster?.roster.version).toBe(2);
    expect(o!.refused).toBe("this node is not in the roster it holds");
  });
  it("refuses a different member answering at the address dialled", () => {
    const three = signed(roster([entry(mac, "mac", 1), entry(omarchy, "omarchy", 2), entry(laptop, "laptop", 3)], 2), parentKey);
    const [, l] = wire({ me: omarchy, held: three }, { me: laptop, held: three, expect: mac.id });
    expect(l!.up).toBeNull();
    expect(l!.refused).toBe("a different member answered at that address");
  });
  it("refuses a peer on another link protocol, and anything before a hello", () => {
    const hs = new LinkHandshake({ self: mac.id, version: "t", challenge: "c".repeat(20), sign: mac.keys.sign, verify: verifySigned, roster: () => v1, adopt: () => undefined });
    const steps = hs.receive({ type: "hello", node: omarchy.id, challenge: "x".repeat(20), roster: null, protocol: 99, version: "t" });
    expect(steps[0]?.kind).toBe("refuse");
    const early = new LinkHandshake({ self: mac.id, version: "t", challenge: "c".repeat(20), sign: mac.keys.sign, verify: verifySigned, roster: () => v1, adopt: () => undefined });
    expect(early.receive({ type: "summary", summary: {} as never })[0]).toMatchObject({ kind: "refuse" });
  });
  it("parses only the frames it knows", () => {
    expect(parseLinkMessage('{"type":"ping","at":1}')).toEqual({ type: "ping", at: 1 });
    expect(parseLinkMessage('{"type":"rm -rf"}')).toBeNull();
    expect(parseLinkMessage("not json")).toBeNull();
  });
});
