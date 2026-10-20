/**
 * Another node's workspace, on this window: the Mac's server as one more
 * client of a child, relaying the child's session to its own clients under
 * qualified ids.
 *
 * It exists because the only way to touch a child's terminal used to be to
 * stop looking at the Mac's — "Open omarchy" moved the whole window to the
 * child's server, and the Mac's agents, voice and drawer went with it. The
 * user asked for the bridge to feel like working from this computer while
 * the box does the work, and the shape that gives that is the one
 * `docs/plans/remote-workspaces.md` argues for: **the child does not learn a
 * new protocol.** The Mac dials `/link/watch`, proves itself with the node
 * handshake, and from then on is a `/ws` client of the child exactly as a
 * phone is — snapshot, output, grid, backlog. This module is the Mac's half:
 * one `NodeWatch` per node, open while something of that node is on a
 * screen here, and a prefixer between it and the Mac's clients.
 *
 * **Why a relay and not the page dialling the child.** Phase 0 measured
 * both. The relay costs half a millisecond against a 167 ms round trip to
 * the box, keeps the child's token out of every page, gives the phone the
 * remote workspace through the socket it already has, and keeps the rules
 * that run on the server — the size, the notification gate, the Needs —
 * on a server that sees the agents. The page holds no secret of the child's.
 *
 * **Why nothing here is written down.** A remote workspace is a view, rebuilt
 * from the child's snapshot each time the watch comes up. `Workspaces`,
 * `persist.ts`, the host's blob and the database are never handed anything
 * of the child's; which remote workspace is on screen is memory in this
 * file and dies with the process, so a restart comes back on the last local
 * workspace. The child owns its layout, its ptys and their size, and a verb
 * from here is forwarded to it and never applied here.
 *
 * **The size composes.** The child sizes a terminal to the smallest grid
 * over the clients that see it and are looking; this relay is one such
 * client, and what it proposes is the smallest over the Mac's own clients
 * that see it and are looking — `smallestGrid` applied twice, which is still
 * the smallest over everybody. Output is forwarded the moment it arrives and
 * never batched: the child's host already waits up to 16 ms, and a second
 * wait here would be a second frame on every keystroke (phase 0, finding 1).
 *
 * On the restartable side, with nothing near a pty: a restart is a
 * reconnect for every watch, as it is for every window.
 */
import { WebSocket } from "ws";
import { panes, terminalsOf } from "../../shared/layout";
import type { SessionSnapshot } from "../../shared/model";
import { dialDelay, type NodeSummary } from "../../shared/nodes";
import {
  parseRemote,
  qualify,
  qualifyAgent,
  qualifyReply,
  qualifyWorkspace,
  remoteLaunchers,
  route,
  type RemoteState,
  type RemoteView,
} from "../../shared/remote";
import type { ClientMessage, ServerMessage } from "../../shared/wire";
import { smallestGrid, type Grid } from "./sizing";

/** A watch nothing on screen wants any more is kept this long, so stepping between a local workspace and a remote one is not a reconnect each way. */
const LINGER_MS = 60_000;
/** The watch is pinged this often, and is dead after this much silence: a box whose lid shut sends no FIN, as on `/link`. */
const PING_MS = 5_000;
const SILENT_MS = 25_000;
/** The handshake's own timeout is `nodes.ts`'s; this is the socket's. */
const DIAL_MS = 10_000;
/** A child's frame: a backlog is the largest, and a screen of a wide terminal is not a megabyte. */
const MAX_PAYLOAD = 64 * 1024 * 1024;
/** Above this many bytes queued on a Mac client's socket, the relay says so in the log, once a minute. */
const BUFFER_WARN = 4 * 1024 * 1024;

/** What `index.ts` keeps per client that the relay reads and, for remote terminals, writes. */
export interface WatchClient {
  watching: Set<string>;
  warm: Set<string>;
  proposals: Map<string, Grid>;
  looking: boolean;
  awaiting: Map<string, { inflight: number; queued: string[] }>;
}

export interface NodeWatchDeps {
  /** A member's name and where it is dialled, or null once it is no member. */
  member: (nodeId: string) => { name: string; address: string; port: number } | null;
  /** The member's last summary, which says whether it can be watched and what its workspaces are before a watch has said anything. */
  summary: (nodeId: string) => NodeSummary | null;
  /** `NodeHost.watchHandshake`. */
  handshake: (ws: WebSocket, expect: string, up: (peer: string) => void, refused: (reason: string) => void) => void;
  clients: () => Map<WebSocket, WatchClient>;
  send: (ws: WebSocket, msg: ServerMessage) => void;
  /** What `snapshot.remote` says moved. */
  changed: () => void;
  log: (line: string) => void;
  /** A watch opening or closing, for `lifecycle.log`. */
  record: (line: string) => void;
}

/** Verbs that put one of this node's own workspaces on screen, and so take the remote one off it. */
const SHOWS_LOCAL = new Set<ClientMessage["type"]>([
  "switch-workspace",
  "workspace-index",
  "step-workspace",
  "last-workspace",
  "new-workspace",
  "switch-profile",
  "reveal-agent",
  "open-harness",
  "show-doc",
]);

/** A remote verb with a reply on its way back: the client that asked, and under which of its own ids. */
interface PendingReply {
  ws: WebSocket;
  id: number;
  type: ClientMessage["type"];
}

/**
 * One child, watched. Its socket, the child's latest snapshot, and the
 * bookkeeping that makes the Mac's many clients one client of the child:
 * which backlogs each asked for, which replies each is owed, and what the
 * child was last told about watching, looking and size, so nothing is said
 * twice.
 */
class NodeWatch {
  private ws: WebSocket | null = null;
  /** The handshake is done and the child is treating this as a client. */
  up = false;
  state: RemoteState = "opening";
  since: number | null = null;
  /** The child's latest snapshot, its ids bare, as it sent it. */
  snapshot: SessionSnapshot | null = null;
  private failures = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private lastHeard = 0;
  /** Not wanted since; closed once this is `LINGER_MS` old. */
  idleSince: number | null = null;
  private closing = false;
  /** Per bare agent id, the Mac clients whose `request-backlog` went to the child, in the order they went. */
  private readonly askers = new Map<string, WebSocket[]>();
  private readonly replies = new Map<number, PendingReply>();
  private nextReply = 1;
  /** What the child was last told, so the same thing is not said twice. */
  private toldWatch = "";
  private toldLooking: boolean | null = null;
  private readonly toldSize = new Map<string, string>();
  private warnedAt = 0;

  constructor(
    readonly node: string,
    private readonly deps: NodeWatchDeps,
    /** What this watch draws moved; `NodeWatches` passes it on only while this node is on screen. */
    private readonly changed: () => void,
  ) {}

  get name(): string {
    return this.deps.member(this.node)?.name ?? this.node;
  }

  open(): void {
    if (this.ws || this.closing) return;
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    const member = this.deps.member(this.node);
    if (!member) {
      this.down("it is no longer in the roster");
      return;
    }
    const host = member.address.includes(":") ? `[${member.address}]` : member.address;
    const ws = new WebSocket(`ws://${host}:${member.port}/link/watch`, { handshakeTimeout: DIAL_MS, maxPayload: MAX_PAYLOAD });
    this.ws = ws;
    ws.on("error", (err: Error) => this.deps.log(`watch: ${member.name}: ${err.message}`));
    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      const was = this.up;
      this.up = false;
      if (this.ping) clearInterval(this.ping);
      this.ping = null;
      if (was) this.deps.record(`stopped watching ${this.name}`);
      this.down(was ? "the watch dropped" : "it could not be reached");
      if (this.closing) return;
      this.failures = was ? 0 : this.failures + 1;
      this.retry = setTimeout(() => this.open(), was ? 1000 : dialDelay(this.failures));
      this.retry.unref();
    });
    ws.on("pong", () => (this.lastHeard = Date.now()));
    this.deps.handshake(
      ws,
      this.node,
      () => {
        if (this.ws !== ws) return;
        this.up = true;
        this.failures = 0;
        this.lastHeard = Date.now();
        // Before anything else can arrive: the child's snapshot follows the
        // proof in the same breath, and must find this listener.
        ws.on("message", (data) => this.fromChild(String(data)));
        this.ping = setInterval(() => this.beat(), PING_MS);
        this.ping.unref();
        this.deps.log(`watch: watching ${this.name}`);
        this.deps.record(`watching ${this.name}`);
        this.cameUp();
        this.sync();
        this.refill();
      },
      (reason) => this.deps.log(`watch: ${member.name} refused the watch: ${reason}`),
    );
  }

  /** Close for good: nothing wants it, or this server is going. */
  close(): void {
    this.closing = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      if (this.up) this.deps.record(`stopped watching ${this.name}: nothing of it is on screen`);
      this.up = false;
      try {
        ws.close(1000, "nothing of this node is on screen");
      } catch {
        ws.terminate();
      }
    }
    this.release("the watch was closed");
  }

  /** Dial again now rather than at the end of a backoff: its link came back. */
  nudge(): void {
    if (this.ws || this.closing) return;
    this.failures = 0;
    this.open();
  }

  private beat(): void {
    const ws = this.ws;
    if (!ws || !this.up) return;
    if (Date.now() - this.lastHeard > SILENT_MS) {
      this.deps.log(`watch: ${this.name} silent for ${Math.round((Date.now() - this.lastHeard) / 1000)} s`);
      ws.terminate();
      return;
    }
    try {
      ws.ping();
    } catch {
      // Closing; the close handler tidies up.
    }
  }

  /**
   * The watch is not up. What the panes hold stays drawn, greyed; what was
   * in flight is let go, so no pane waits for a backlog that is not coming
   * — when the watch is back, every one of them is told it is stale and
   * asks again (`refill`).
   */
  private down(why: string): void {
    const was = this.state;
    if (was !== "away") {
      this.state = "away";
      this.since = Date.now();
      this.changed();
    }
    this.release(why);
  }

  private release(why: string): void {
    for (const [, waiting] of this.askers) waiting.length = 0;
    this.askers.clear();
    for (const st of this.deps.clients().values()) {
      for (const id of [...st.awaiting.keys()]) if (parseRemote(id)?.node === this.node) st.awaiting.delete(id);
    }
    for (const [, reply] of this.replies) this.deps.send(reply.ws, { type: "reply", id: reply.id, ok: false, error: `${this.name} is away: ${why}.` });
    this.replies.clear();
    this.toldWatch = "";
    this.toldLooking = null;
    this.toldSize.clear();
  }

  /**
   * The watch came up, so every emulator of this node's that a client holds
   * has missed whatever happened while it was down — or since it was made,
   * for one built from a snapshot alone. `onopen`'s rule, said for these ids:
   * a pane on screen asks for its screen again, a pooled one waits until it
   * is borrowed.
   */
  private refill(): void {
    for (const [ws, st] of this.deps.clients()) {
      const ids = [...new Set([...st.watching, ...st.warm])].filter((id) => parseRemote(id)?.node === this.node);
      if (ids.length) this.deps.send(ws, { type: "stale", agentIds: ids });
    }
  }

  private cameUp(): void {
    this.state = "up";
    this.since = Date.now();
    this.changed();
  }

  private toChild(message: ClientMessage): boolean {
    const ws = this.ws;
    if (!ws || !this.up || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  // --- from the child ------------------------------------------------------

  private fromChild(raw: string): void {
    this.lastHeard = Date.now();
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "snapshot":
        this.snapshot = msg.snapshot;
        this.changed();
        return;
      case "output": {
        // Forwarded as it comes, frame for frame — see the module comment.
        const id = qualify(this.node, msg.agentId);
        for (const [ws, st] of this.deps.clients()) {
          if (!st.watching.has(id) && !st.warm.has(id)) continue;
          const pending = st.awaiting.get(id);
          if (pending) pending.queued.push(msg.data);
          else {
            this.deps.send(ws, { type: "output", agentId: id, data: msg.data });
            this.watchBuffer(ws);
          }
        }
        return;
      }
      case "grid": {
        const id = qualify(this.node, msg.agentId);
        for (const [ws, st] of this.deps.clients()) {
          if (st.watching.has(id) || st.warm.has(id)) this.deps.send(ws, { ...msg, agentId: id });
        }
        return;
      }
      case "backlog": {
        // The child answers the requests in the order they were sent, one
        // each, so the asker at the head is the client this one is for.
        const id = qualify(this.node, msg.agentId);
        const waiting = this.askers.get(msg.agentId);
        const ws = waiting?.shift();
        if (waiting && !waiting.length) this.askers.delete(msg.agentId);
        const st = ws ? this.deps.clients().get(ws) : undefined;
        const pending = st?.awaiting.get(id);
        if (!ws || !st || !pending) return;
        const sees = st.watching.has(id) || st.warm.has(id);
        if (sees) this.deps.send(ws, { ...msg, agentId: id });
        if (--pending.inflight > 0) return;
        st.awaiting.delete(id);
        if (sees) for (const data of pending.queued) this.deps.send(ws, { type: "output", agentId: id, data });
        // The ask is answered, so it no longer keeps the terminal listed.
        this.sync();
        return;
      }
      case "reply": {
        const reply = this.replies.get(msg.id);
        if (!reply) return;
        this.replies.delete(msg.id);
        this.deps.send(reply.ws, msg.ok ? { type: "reply", id: reply.id, ok: true, result: qualifyReply(this.node, reply.type, msg.result) } : { type: "reply", id: reply.id, ok: false, error: msg.error });
        return;
      }
      default:
        // Everything else a window is sent is the child's own business — its
        // usage, its voice, its nodes — and the child sends a watcher none of
        // it on purpose (`ClientState.watcher`). What arrives anyway from a
        // newer child is ignored rather than relayed.
        return;
    }
  }

  private watchBuffer(ws: WebSocket): void {
    if (ws.bufferedAmount < BUFFER_WARN) return;
    const now = Date.now();
    if (now - this.warnedAt < 60_000) return;
    this.warnedAt = now;
    this.deps.log(`watch: a window is ${Math.round(ws.bufferedAmount / 1024)} kB behind ${this.name}'s output`);
  }

  // --- to the child --------------------------------------------------------

  /**
   * Tell the child what the Mac's clients, together, are: which of its
   * terminals they have on screen, which they keep, whether anybody is
   * looking, and the smallest grid over those who are. Said only when it
   * changed.
   *
   * A terminal a client has proposed a size for counts as on screen, and
   * one with a backlog in flight is kept: the child drops a request for a
   * terminal its watcher does not list, and drops a proposal for one it does
   * not list as on screen — and the Mac's `watch` reaches the Mac a moment
   * after both, since a pane measures before its watch effect runs. Listed
   * this way, the child serves the same order a window gets from the Mac.
   */
  sync(): void {
    if (!this.up) return;
    const watching = new Set<string>();
    const warm = new Set<string>();
    let looking = false;
    const grids = new Map<string, Grid[]>();
    for (const st of this.deps.clients().values()) {
      if (st.looking) looking = true;
      for (const id of st.watching) this.add(watching, id);
      for (const id of st.warm) this.add(warm, id);
      for (const [id, grid] of st.proposals) {
        const bare = this.bare(id);
        if (!bare) continue;
        watching.add(bare);
        if (!st.looking) continue;
        const list = grids.get(bare) ?? [];
        list.push(grid);
        grids.set(bare, list);
      }
    }
    for (const id of this.askers.keys()) warm.add(id);
    for (const id of watching) warm.delete(id);
    const watch = JSON.stringify([[...watching].sort(), [...warm].sort()]);
    if (watch !== this.toldWatch) {
      this.toldWatch = watch;
      this.toChild({ type: "watch", agentIds: [...watching], warm: [...warm] });
      // A terminal that left the list lost its proposal on the child; the
      // next time it is on screen here, its size is said again.
      for (const id of [...this.toldSize.keys()]) if (!watching.has(id)) this.toldSize.delete(id);
    }
    if (looking !== this.toldLooking) {
      this.toldLooking = looking;
      this.toChild({ type: "looking", looking });
    }
    for (const [id, list] of grids) {
      const grid = smallestGrid(list);
      if (!grid) continue;
      const said = `${grid.cols}x${grid.rows}`;
      if (this.toldSize.get(id) === said) continue;
      this.toldSize.set(id, said);
      this.toChild({ type: "propose-size", agentId: id, cols: grid.cols, rows: grid.rows });
    }
  }

  private bare(id: string): string | null {
    const remote = parseRemote(id);
    return remote?.node === this.node ? remote.id : null;
  }

  private add(set: Set<string>, id: string): void {
    const bare = this.bare(id);
    if (bare) set.add(bare);
  }

  /** The child's own active workspace, moved to the one on screen here before a verb that means "the focused pane". */
  private follow(workspaceKey: string | null): void {
    if (!workspaceKey || !this.snapshot) return;
    const profile = this.snapshot.profile;
    const shown = profile.workspaces.find((w) => w.key === workspaceKey);
    if (shown && profile.activeWorkspaceId !== shown.id) {
      this.toChild({ type: "switch-workspace", workspaceId: shown.id });
      // Said, so the next verb in this breath does not say it again; the
      // child's next snapshot confirms it.
      this.snapshot = { ...this.snapshot, profile: { ...profile, activeWorkspaceId: shown.id } };
    }
  }

  /**
   * A client's verb for this node, ids already bare. What is about a
   * terminal's bytes is the relay's own; the rest is forwarded as it is,
   * with a reply routed back to whoever asked.
   */
  handle(ws: WebSocket, st: WatchClient, qualified: ClientMessage, message: ClientMessage, shown: string | null): void {
    switch (message.type) {
      case "propose-size": {
        const { cols, rows } = message;
        if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2) return;
        st.proposals.set((qualified as typeof message).agentId, { cols, rows });
        this.sync();
        return;
      }
      case "request-backlog": {
        // Nothing to ask while the watch is down: the emulator is told it is
        // stale when it comes back, and asks then.
        if (!this.up) return;
        const id = (qualified as typeof message).agentId;
        const pending = st.awaiting.get(id);
        if (pending) pending.inflight++;
        else st.awaiting.set(id, { inflight: 1, queued: [] });
        const waiting = this.askers.get(message.agentId) ?? [];
        waiting.push(ws);
        this.askers.set(message.agentId, waiting);
        this.sync();
        this.toChild(message);
        return;
      }
      case "input":
        if (!this.toChild(message)) this.deps.send(ws, { type: "remote-said", node: this.node, text: `${this.name} is away — that was not typed.` });
        return;
      case "switch-workspace":
      case "reveal-agent":
        // While the watch opens there is nothing to move; the window already
        // shows the workspace, and the first verb that needs the child's
        // focus moves it there (`follow`).
        if (!this.up) return;
        // A switch is the child's active workspace becoming the one shown
        // here, which `follow` says once; a reveal moves it itself.
        if (message.type === "switch-workspace") this.follow(shown);
        else this.toChild(message);
        return;
      default: {
        if (!this.up) {
          const id = "id" in message && typeof message.id === "number" ? message.id : null;
          if (id !== null) this.deps.send(ws, { type: "reply", id, ok: false, error: `${this.name} is away.` });
          else this.deps.send(ws, { type: "remote-said", node: this.node, text: `${this.name} is away — nothing was changed there.` });
          return;
        }
        this.follow(shown);
        if ("id" in message && typeof message.id === "number") {
          const relay = this.nextReply++;
          this.replies.set(relay, { ws, id: message.id, type: message.type });
          this.toChild({ ...message, id: relay } as ClientMessage);
          return;
        }
        this.toChild(message);
      }
    }
  }

  /** A workspace of the child's, by key, or by its counter id. */
  workspace(by: { key?: string; id?: string }): SessionSnapshot["profile"]["workspaces"][number] | null {
    const list = this.snapshot?.profile.workspaces ?? [];
    return list.find((w) => (by.key ? w.key === by.key : w.id === by.id)) ?? null;
  }

  /** The workspace a terminal of the child's is in: off its snapshot, else off its summary. */
  keyOfAgent(bare: string): string | null {
    for (const w of this.snapshot?.profile.workspaces ?? []) {
      if (panes(w.layout).some((p) => p.agentIds.includes(bare))) return w.key;
    }
    for (const w of this.deps.summary(this.node)?.workspaces ?? []) {
      if (w.agents.some((a) => a.id === bare)) return w.key;
    }
    return null;
  }

  /** Put that workspace in front on the child too — what two clients of one server do (the plan's question 2). */
  show(workspaceKey: string): void {
    this.follow(workspaceKey);
  }

  /**
   * A client went. Its replies are nobody's now. Its place in a backlog's
   * line stays, so the child's answers still match their askers; the answer
   * for it finds no `awaiting` and is dropped.
   */
  forget(ws: WebSocket): void {
    for (const [relay, reply] of this.replies) if (reply.ws === ws) this.replies.delete(relay);
  }

  view(workspaceKey: string): RemoteView {
    const snap = this.snapshot;
    const workspace = snap?.profile.workspaces.find((w) => w.key === workspaceKey) ?? null;
    const shownIds = new Set(workspace ? panes(workspace.layout).flatMap((p) => terminalsOf(p.agentIds)) : []);
    for (const card of workspace?.board?.cards ?? []) {
      if (card.run?.agentId) shownIds.add(card.run.agentId);
      if (card.dev?.agentId) shownIds.add(card.dev.agentId);
    }
    return {
      node: { id: this.node, name: this.name },
      workspaceKey,
      state: this.state,
      since: this.since,
      workspace: workspace ? qualifyWorkspace(this.node, workspace) : null,
      agents: (snap?.agents ?? []).filter((a) => shownIds.has(a.id)).map((a) => qualifyAgent(this.node, a)),
      launch: snap?.launch ?? null,
      launchers: remoteLaunchers(this.deps.summary(this.node)?.launchers, snap?.launch ?? null),
    };
  }

}

/**
 * Every watch this server has open, and which remote workspace — if any —
 * is on screen instead of a local one. One per server: the window, the pill
 * and the phone of one kururu share what is on screen, as they share the
 * active workspace.
 */
export class NodeWatches {
  private readonly watches = new Map<string, NodeWatch>();
  /** The remote workspace on screen, by node and key; null while a local one is. */
  private onScreen: { node: string; key: string } | null = null;
  /** The local profile and workspace that were active when the remote one went on screen. */
  private localWas = "";
  private readonly sweep: ReturnType<typeof setInterval>;

  constructor(private readonly deps: NodeWatchDeps) {
    this.sweep = setInterval(() => this.wanted(), 5_000);
    this.sweep.unref();
  }

  /** The node whose workspace is on screen, or null. */
  shownNode(): string | null {
    return this.onScreen?.node ?? null;
  }

  /** What `snapshot.remote` carries. */
  view(): RemoteView | null {
    const on = this.onScreen;
    if (!on) return null;
    const watch = this.watches.get(on.node);
    if (watch) return watch.view(on.key);
    return { node: { id: on.node, name: this.deps.member(on.node)?.name ?? on.node }, workspaceKey: on.key, state: "opening", since: null, workspace: null, agents: [], launch: null, launchers: remoteLaunchers(this.deps.summary(on.node)?.launchers, null) };
  }

  /**
   * The local workspace this server shows changed, by any road — a click,
   * a key, Kuru's Auto Swap. While a remote workspace was on screen, the
   * window goes to the local one: a switch somebody made must be seen.
   */
  noteLocal(key: string): void {
    if (key === this.localWas) return;
    this.localWas = key;
    if (this.onScreen) this.hide();
  }

  /** Put a node's workspace on screen, and open its watch. */
  private show(node: string, key: string): void {
    const changed = this.onScreen?.node !== node || this.onScreen.key !== key;
    this.onScreen = { node, key };
    const watch = this.watch(node);
    watch.show(key);
    if (changed) this.deps.changed();
  }

  private hide(): void {
    if (!this.onScreen) return;
    this.onScreen = null;
    this.deps.changed();
    this.wanted();
  }

  private watch(node: string): NodeWatch {
    let watch = this.watches.get(node);
    if (!watch) {
      watch = new NodeWatch(node, this.deps, () => {
        if (this.onScreen?.node === node) this.deps.changed();
      });
      this.watches.set(node, watch);
      watch.open();
    }
    watch.idleSince = null;
    return watch;
  }

  /**
   * Whether each watch is still wanted: its node on screen, or a terminal of
   * its on screen in some client. Being merely pooled does not keep one
   * open — an idle Mac should cost the child nothing — but it lingers a
   * minute, so stepping away and back is not a reconnect.
   */
  private wanted(): void {
    const now = Date.now();
    const seen = new Set<string>();
    for (const st of this.deps.clients().values()) {
      for (const id of st.watching) {
        const node = parseRemote(id)?.node;
        if (node) seen.add(node);
      }
    }
    if (this.onScreen) seen.add(this.onScreen.node);
    for (const [node, watch] of this.watches) {
      if (seen.has(node) || !this.deps.member(node)) {
        if (seen.has(node)) watch.idleSince = null;
        else this.drop(node, watch);
        continue;
      }
      watch.idleSince ??= now;
      if (now - watch.idleSince >= LINGER_MS) this.drop(node, watch);
    }
  }

  private drop(node: string, watch: NodeWatch): void {
    watch.close();
    this.watches.delete(node);
    // Its emulators are no longer fed: told now, so a pooled one borrowed
    // later rebuilds rather than drawing a screen that stopped.
    for (const [ws, st] of this.deps.clients()) {
      const ids = [...st.warm].filter((id) => parseRemote(id)?.node === node);
      if (ids.length) this.deps.send(ws, { type: "stale", agentIds: ids });
    }
  }

  /** Recompute what every watch tells its child: a client's sets or proposals moved, or a client went. */
  sync(): void {
    for (const watch of this.watches.values()) watch.sync();
  }

  /** A client went away. */
  leave(ws: WebSocket): void {
    for (const watch of this.watches.values()) watch.forget(ws);
    this.sync();
  }

  /** A node's link came up: a watch waiting out a backoff dials now. */
  linked(node: string): void {
    this.watches.get(node)?.nudge();
  }

  /**
   * A client's verb. True when it was another node's and has been dealt
   * with here — forwarded, refused or answered; false when it is this
   * node's, for `handleMessage` to do as ever.
   */
  handle(ws: WebSocket, st: WatchClient, msg: ClientMessage): boolean {
    if (msg.type === "show-node-workspace") {
      const summary = this.deps.summary(msg.nodeId);
      if (typeof msg.workspaceKey !== "string" || !this.deps.member(msg.nodeId) || !summary?.watchable) return true;
      this.show(msg.nodeId, msg.workspaceKey);
      return true;
    }
    const routed = route(msg, this.onScreen?.node ?? null);
    if (routed.to === "here") {
      if (SHOWS_LOCAL.has(msg.type)) this.hide();
      else if ((msg.type === "new-tab" || msg.type === "open-board" || msg.type === "open-made") && typeof msg.workspaceId === "string") this.hide();
      return false;
    }
    if (routed.to === "nowhere") {
      const id = "id" in msg && typeof msg.id === "number" ? msg.id : null;
      if (id !== null) this.deps.send(ws, { type: "reply", id, ok: false, error: routed.why });
      else if (routed.node) this.deps.send(ws, { type: "remote-said", node: routed.node, text: routed.why });
      return true;
    }
    const { node, message } = routed;
    if (!this.deps.member(node) || !this.deps.summary(node)?.watchable) {
      const id = "id" in msg && typeof msg.id === "number" ? msg.id : null;
      if (id !== null) this.deps.send(ws, { type: "reply", id, ok: false, error: "That computer cannot be driven from here; update it." });
      return true;
    }
    const watch = this.watch(node);
    // The verbs that say which workspace is in front move the screen here
    // too, then go on to the child, which moves its own.
    if (message.type === "switch-workspace") {
      const key = watch.workspace({ id: message.workspaceId })?.key;
      if (key) this.show(node, key);
    } else if (message.type === "reveal-agent") {
      const key = watch.keyOfAgent(message.agentId);
      if (key) this.show(node, key);
    }
    const shown = this.onScreen?.node === node ? this.onScreen.key : null;
    watch.handle(ws, st, msg, message, shown);
    return true;
  }

  /** For `/api/health` and `bun run status`: which nodes this server is watching. */
  status(): Array<{ node: string; state: RemoteState; since: number | null; onScreen: boolean }> {
    return [...this.watches.values()].map((w) => ({ node: w.name, state: w.state, since: w.since, onScreen: this.onScreen?.node === w.node }));
  }

  close(): void {
    clearInterval(this.sweep);
    for (const watch of this.watches.values()) watch.close();
    this.watches.clear();
  }
}
