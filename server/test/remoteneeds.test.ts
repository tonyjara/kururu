/**
 * Another node's needs and notices on this window, and what Kuru may read of
 * it — phase 3 of `docs/plans/remote-workspaces.md`: the walk `C-a o` takes
 * across nodes, the edges a notice is raised on and the two sources they are
 * read from, the reveal a watch still opening keeps for the child, and a
 * remote screen read for `read_agent` through the watch — the last two
 * against a stand-in child on a loopback socket, which speaks the frames a
 * child's `/ws` would.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { needsOf } from "../../shared/needs";
import type { AgentSnapshot, AgentStatus, Profile, SessionSnapshot } from "../../shared/model";
import { nodesText, type NodeStatus, type NodeSummary, type SummaryAgent } from "../../shared/nodes";
import { DEFAULT_NOTIFY } from "../../shared/notify";
import {
  nextNeedAcross,
  nodeNeeds,
  qualify,
  snapshotAgents,
  statusEdges,
  summaryAgents,
} from "../../shared/remote";
import type { ClientMessage, ServerMessage } from "../../shared/wire";
import { NodeNotices } from "../src/nodenotice";
import { NodeWatches, type WatchClient } from "../src/nodewatch";
import { Workspaces } from "../src/workspaces";

const OMARCHY = "n0123456789ab";
const OLD = "nfedcba987654";

function agent(id: string, status: AgentStatus, more: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return { id, kind: "agent", status, exited: false, agent: "claude", unread: false, pid: 1, command: "claude", ...more } as AgentSnapshot;
}

function summaryAgent(id: string, status: AgentStatus): SummaryAgent {
  const { pid: _pid, command: _command, ...rest } = agent(id, status);
  return { ...rest, card: null } as SummaryAgent;
}

/** A child's profile: one workspace, two terminals, and its Kuru in a pane of its own. */
function childProfile(): { profile: Profile; key: string; id: string } {
  const child = new Workspaces();
  child.addTab("a1", "/home/o");
  child.split("row");
  child.addTab("a2", "/home/o");
  child.split("row");
  child.addTab("a9", "/home/o");
  const profile = { ...child.active, harness: { agentId: "a9" } } as Profile;
  const workspace = profile.workspaces[0]!;
  return { profile, key: workspace.key, id: workspace.id };
}

function summaryOf(workspaceKey: string, agents: SummaryAgent[], needs: NodeSummary["workspaces"][number]["needs"] = []): NodeSummary {
  return {
    watchable: 1,
    talks: 1,
    profile: { key: "pk", name: "Main" },
    needs: { count: needs.length, inWorkspaces: needs.length ? 1 : 0 },
    workspaces: [{ key: workspaceKey, name: "api", folder: "/home/o", band: needs.length ? "needs" : "quiet", needs, agents }],
  } as unknown as NodeSummary;
}

function node(id: string, name: string, summary: NodeSummary | null, state: NodeStatus["state"] = "up"): NodeStatus {
  return { id, name, state, summary, url: `http://${name}:7717/`, parent: false } as NodeStatus;
}

describe("the edges a notice is raised on", () => {
  it("a move into blocked or done, never a state first seen, and never an exit", () => {
    const one = (status: AgentStatus, exited = false) => [{ agent: agent("a1", status, { exited }), workspace: "api" }];
    expect(statusEdges(new Map(), one("blocked")).edges).toEqual([]);
    expect(statusEdges(new Map([["a1", "working"]]), one("blocked")).edges.map((e) => e.event)).toEqual(["blocked"]);
    expect(statusEdges(new Map([["a1", "working"]]), one("done")).edges.map((e) => e.event)).toEqual(["done"]);
    expect(statusEdges(new Map([["a1", "blocked"]]), one("blocked")).edges).toEqual([]);
    expect(statusEdges(new Map([["a1", "blocked"]]), one("working")).edges).toEqual([]);
    expect(statusEdges(new Map([["a1", "working"]]), one("done", true)).edges).toEqual([]);
    // What is remembered is what was just seen, and an agent that went is forgotten.
    expect([...statusEdges(new Map([["gone", "working"]]), one("idle")).seen]).toEqual([["a1", "idle"]]);
  });

  it("reads the same agents off a relayed snapshot as off the summary, and never the node's Kuru", () => {
    const { profile, key } = childProfile();
    const agents = [agent("a1", "working"), agent("a2", "idle"), agent("a9", "working")];
    const fromSnapshot = snapshotAgents({ profile, agents }).map((a) => a.agent.id);
    expect(fromSnapshot.sort()).toEqual(["a1", "a2"]);
    const fromSummary = summaryAgents(summaryOf(key, [summaryAgent("a1", "working"), summaryAgent("a2", "idle")])).map((a) => a.agent.id);
    expect(fromSummary.sort()).toEqual(fromSnapshot);
  });
});

describe("another node's needs, as doors", () => {
  const { profile: local } = childProfile();
  const here = needsOf({ ...local, harness: null }, [agent("a1", "blocked"), agent("a2", "idle")]);

  it("lists only a linked node this window can open, in the drawer's order", () => {
    const need = { kind: "asking" as const, agentId: "a7", cardId: null, title: "claude" };
    const nodes = [
      node(OMARCHY, "omarchy", summaryOf("k1", [], [need])),
      node("n111111111111", "away", summaryOf("k2", [], [need]), "away"),
      node(OLD, "old", { ...summaryOf("k3", [], [need]), watchable: undefined } as unknown as NodeSummary),
    ];
    expect(nodeNeeds(nodes)).toEqual([{ node: OMARCHY, workspaceKey: "k1", need }]);
  });

  it("C-a o walks this node's needs, then each node's, and steps on from the one under the keyboard", () => {
    const asking = { kind: "asking" as const, agentId: "a7", cardId: null, title: "claude" };
    const review = { kind: "review" as const, agentId: null, cardId: "c1", title: "Fix the login" };
    const elsewhere = nodeNeeds([node(OMARCHY, "omarchy", summaryOf("k1", [], [asking, review]))]);
    const at = { focusedAgentId: null as string | null, workspaceId: null, remote: null as { node: string; workspaceKey: string } | null, boardShowing: false };

    // From nowhere in particular, the first: this node's own.
    const first = nextNeedAcross(here, elsewhere, at);
    expect(first && "here" in first && first.here.agent?.id).toBe("a1");
    // From this node's last, onto the node's first.
    const second = nextNeedAcross(here, elsewhere, { ...at, focusedAgentId: "a1" });
    expect(second && "there" in second && second.there.need.agentId).toBe("a7");
    // The node's agent is under the keyboard by its qualified id.
    const third = nextNeedAcross(here, elsewhere, { ...at, focusedAgentId: qualify(OMARCHY, "a7") });
    expect(third && "there" in third && third.there.need.cardId).toBe("c1");
    // A card with no terminal is "here" while its board is showing on that workspace; then round to the start.
    const fourth = nextNeedAcross(here, elsewhere, { ...at, remote: { node: OMARCHY, workspaceKey: "k1" }, boardShowing: true });
    expect(fourth && "here" in fourth && fourth.here.agent?.id).toBe("a1");
    // A bare a7 of this node's is not the node's a7.
    const bare = nextNeedAcross(here, elsewhere, { ...at, focusedAgentId: "a7" });
    expect(bare && "here" in bare).toBe(true);
    expect(nextNeedAcross(needsOf({ ...local, harness: null }, []), [], at)).toBeNull();
  });
});

describe("another node's agents, noticed here", () => {
  function setup() {
    const sent: Array<{ ws: WebSocket; msg: ServerMessage }> = [];
    const window = {} as WebSocket;
    const phone = {} as WebSocket;
    const watcher = {} as WebSocket;
    const clients = new Map<WebSocket, { watching: Set<string>; watcher?: string | null }>([
      [window, { watching: new Set<string>() }],
      [phone, { watching: new Set<string>() }],
      [watcher, { watching: new Set<string>(), watcher: "nsomebodyelse" }],
    ]);
    const notices = new NodeNotices({
      clients: () => clients,
      send: (ws, msg) => sent.push({ ws, msg }),
      settings: () => DEFAULT_NOTIFY,
      name: () => "omarchy",
    });
    return { sent, window, phone, clients, notices };
  }

  it("raises a card saying where, on each client that cannot see the terminal, off the summary while nothing is watched", () => {
    const { sent, window, phone, clients, notices } = setup();
    const { key } = childProfile();
    notices.summary(OMARCHY, summaryOf(key, [summaryAgent("a1", "working")]), true, false);
    expect(sent).toEqual([]);
    clients.get(window)!.watching.add(qualify(OMARCHY, "a1"));
    notices.summary(OMARCHY, summaryOf(key, [summaryAgent("a1", "blocked")]), true, false);
    // The window has it on screen, and `whenVisible` is off; the phone does not, and is told; the watch is nobody.
    expect(sent.map((s) => s.ws)).toEqual([phone]);
    const msg = sent[0]!.msg;
    expect(msg.type === "notify" && msg.notification).toMatchObject({ agentId: qualify(OMARCHY, "a1"), event: "blocked", title: "claude on omarchy needs input" });
    expect(msg.type === "notify" && msg.notification.body).toContain("api");
  });

  it("reads one source at a time, and a change of source is learnt rather than announced", () => {
    const { sent, notices } = setup();
    const { profile, key } = childProfile();
    const snap = (a1: AgentStatus): Pick<SessionSnapshot, "profile" | "agents"> => ({ profile, agents: [agent("a1", a1), agent("a2", "idle")] });
    notices.summary(OMARCHY, summaryOf(key, [summaryAgent("a1", "working")]), true, false);
    // The watch comes up with the agent already blocked: a first look, so nothing.
    notices.snapshot(OMARCHY, snap("blocked"));
    expect(sent).toEqual([]);
    // A summary a second behind says working: ignored while the watch is up.
    notices.summary(OMARCHY, summaryOf(key, [summaryAgent("a1", "working")]), true, true);
    notices.snapshot(OMARCHY, snap("blocked"));
    expect(sent).toEqual([]);
    notices.snapshot(OMARCHY, snap("working"));
    notices.snapshot(OMARCHY, snap("done"));
    expect(sent.length).toBe(2);
    // A node that is away is not read at all.
    notices.summary(OMARCHY, summaryOf(key, [summaryAgent("a1", "blocked")]), false, false);
    expect(sent.length).toBe(2);
  });

  it("holds an agent to the throttle, as a local one is", () => {
    const { sent, notices } = setup();
    const { profile } = childProfile();
    const snap = (a1: AgentStatus) => ({ profile, agents: [agent("a1", a1)] });
    notices.snapshot(OMARCHY, snap("working"));
    notices.snapshot(OMARCHY, snap("done"));
    notices.snapshot(OMARCHY, snap("working"));
    notices.snapshot(OMARCHY, snap("blocked"));
    expect(sent.length).toBe(2);
  });
});

describe("the relay, for a reveal and for Kuru", () => {
  let server: WebSocketServer | null = null;
  let watches: NodeWatches | null = null;
  afterEach(() => {
    watches?.close();
    server?.close();
    watches = null;
    server = null;
  });

  /** A stand-in child: answers a watch with a snapshot, a backlog request with a screen, and records the rest. */
  async function child(snapshot: SessionSnapshot) {
    const heard: ClientMessage[] = [];
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server!.once("listening", () => resolve()));
    server.on("connection", (ws) => {
      ws.send(JSON.stringify({ type: "snapshot", snapshot }));
      ws.on("message", (data) => {
        const msg = JSON.parse(String(data)) as ClientMessage;
        heard.push(msg);
        if (msg.type === "request-backlog") ws.send(JSON.stringify({ type: "backlog", agentId: msg.agentId, data: "hello from omarchy\r\n$ ", cols: 80, rows: 24 }));
      });
    });
    return { heard, port: (server.address() as AddressInfo).port };
  }

  function relay(port: number, summary: NodeSummary, relayed: SessionSnapshot[] = []) {
    const st: WatchClient = { watching: new Set(), warm: new Set(), proposals: new Map(), looking: true, awaiting: new Map() };
    const ws = {} as WebSocket;
    const clients = new Map([[ws, st]]);
    watches = new NodeWatches({
      member: (id) => (id === OMARCHY ? { name: "omarchy", address: "127.0.0.1", port } : null),
      summary: (id) => (id === OMARCHY ? summary : null),
      // The proof is the stand-in's to skip: the socket open is the child admitting the parent.
      handshake: (socket, _expect, up) => socket.once("open", () => up(OMARCHY)),
      clients: () => clients,
      send: () => undefined,
      changed: () => undefined,
      log: () => undefined,
      record: () => undefined,
      relayed: (_node, snap) => relayed.push(snap),
    });
    return { ws, st, watches };
  }

  async function until(check: () => boolean): Promise<void> {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
  }

  it("keeps a reveal asked while the watch opens, and moves the child's focus once it is up", async () => {
    const { profile, key } = childProfile();
    const snapshot = { profile, agents: [agent("a1", "blocked"), agent("a2", "idle")] } as unknown as SessionSnapshot;
    const { heard, port } = await child(snapshot);
    const relayed: SessionSnapshot[] = [];
    const { ws, st, watches } = relay(port, summaryOf(key, [summaryAgent("a1", "blocked"), summaryAgent("a2", "idle")]), relayed);
    // The Needs drawer's row, or a notification's click: the watch is not open yet.
    expect(watches.handle(ws, st, { type: "reveal-agent", agentId: qualify(OMARCHY, "a2") })).toBe(true);
    expect(watches.view()?.workspaceKey).toBe(key);
    await until(() => heard.some((m) => m.type === "reveal-agent"));
    expect(heard.find((m) => m.type === "reveal-agent")).toEqual({ type: "reveal-agent", agentId: "a2" });
    // And the relayed snapshot is what the notices read.
    expect(relayed.length).toBe(1);
    expect(watches.watched(OMARCHY)).toBe(true);
    expect(watches.shown()).toMatchObject({ node: OMARCHY, name: "omarchy", workspaceKey: key });
  });

  it("reads a remote screen for Kuru through a watch it opens, listing the terminal while the read is out", async () => {
    const { profile, key } = childProfile();
    const snapshot = { profile, agents: [agent("a1", "blocked")] } as unknown as SessionSnapshot;
    const { heard, port } = await child(snapshot);
    const { watches } = relay(port, summaryOf(key, [summaryAgent("a1", "blocked")]));
    const screen = await watches.screen(OMARCHY, "a1");
    expect(screen).toEqual({ data: "hello from omarchy\r\n$ ", cols: 80, rows: 24 });
    // Asked for by its bare id, after a watch that kept it, and let go once answered.
    const ask = heard.findIndex((m) => m.type === "request-backlog");
    const kept = heard.slice(0, ask).filter((m) => m.type === "watch").at(-1);
    expect(kept && kept.type === "watch" && kept.warm).toContain("a1");
    await until(() => heard.slice(ask).some((m) => m.type === "watch"));
    const after = heard.slice(ask).filter((m) => m.type === "watch").at(-1);
    expect(after && after.type === "watch" && [...after.agentIds, ...(after.warm ?? [])]).not.toContain("a1");
    // Nothing on screen here: the read did not put the node's workspace in front.
    expect(watches.view()).toBeNull();
    // A node that is not a member, or cannot be watched, is not read.
    expect(await watches.screen(OLD, "a1")).toBeNull();
  });
});

describe("what Kuru is told", () => {
  it("lists another node's agents by a qualified id it can read, and an old node's by none", () => {
    const fresh = node(OMARCHY, "omarchy", summaryOf("k1", [summaryAgent("a7", "blocked")]));
    const old = node(OLD, "old", { ...summaryOf("k2", [summaryAgent("a7", "idle")]), watchable: undefined } as unknown as NodeSummary);
    const text = nodesText([fresh, old]).join("\n");
    expect(text).toContain(`id ${qualify(OMARCHY, "a7")}`);
    expect(text).not.toContain(qualify(OLD, "a7"));
    expect(text).not.toMatch(/id a7\b/);
  });
});
