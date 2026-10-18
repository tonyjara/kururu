/**
 * This node among the others: pairing, the roster, the mesh of links, and
 * what each node tells the rest about itself.
 *
 * A child kururu on a box that stays on is only half useful until the Mac
 * can see it — its workspaces in the sidebar, its blocked agent in the
 * Needs tray, its boards in the backup — and the child can say when the
 * Mac went away. This is the part that makes them see each other, and the
 * rules it keeps are `shared/nodes.ts`'s: the parent signs a roster, a key
 * the roster lists is a member, the lower rank dials the higher, and what
 * crosses a link is a summary, never a copy of anything.
 *
 * **Why links and not polling.** The machines feature polls over ssh every
 * thirty seconds, which is right for three numbers about a VPS and wrong
 * for a dot that should turn amber when an agent on the child asks
 * something. A link is one WebSocket per pair, opened once, and a node
 * pushes its summary when it changes — so the Mac's dot follows the
 * child's hook within a second, and a sleeping Mac is noticed by silence:
 * every link pings every five seconds and a node is away after thirty,
 * because a lid that closes sends no FIN.
 *
 * **Why the handshake and not the share token.** A node could have been
 * let in with the other's share token, and then a child — a box other
 * programs run on — would hold a shell on the Mac. Instead each side signs
 * the other's challenge with a key the roster lists, and the roster is
 * checked against the parent's key learnt at pairing. There is nothing per
 * pair to mint, store or rotate; removing a node is a new roster, and a
 * node not in the newest roster is refused by everyone it meets.
 *
 * On the restartable side of the split, with nothing near a pty: a
 * restart is a reconnect for the links, as it is for every window.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { WebSocket } from "ws";
import {
  adoptRoster,
  asSignedRoster,
  AWAY_MS,
  byRank,
  checkCode,
  CODE_LENGTH,
  CODE_TTL_MS,
  codeRefusal,
  defaultNodeName,
  dialDelay,
  dialTargets,
  FORWARDING_HEADERS,
  freeName,
  isNodeId,
  isPeerMessage,
  joinCommand,
  leaderOf,
  LinkHandshake,
  makeCode,
  memberOf,
  nodeName,
  nodeRemoteAllowed,
  nodeUrl,
  parseLinkMessage,
  parseJoin,
  PING_MS,
  reranked,
  rosterPayload,
  rosterTelegram,
  withChannels,
  summaryKey,
  withChange,
  withMember,
  withoutMember,
  type LinkMessage,
  type LinkState,
  type NodeEntry,
  type NodeKeys,
  type NodeRole,
  type NodeStatus,
  type NodeSummary,
  type NodesView,
  type Pairing,
  type PeerMessage,
  type Roster,
  type SignedRoster,
  validHostName,
} from "../../shared/nodes";
import type { SharedTelegram } from "../../shared/channels";
import type { MoveCheck, MoveDone } from "../../shared/move";
import { readConfigFile, writeConfigFile } from "./config";
import { safeMirrorPath } from "./export";
import { becomeParent, challenge, identity, rosterSigner, signAsNode, signRoster, stopBeingParent, verifySigned, type Identity } from "./nodekeys";

const FILE = "nodes.json";
/** What was last heard from each node, kept across a restart so a child that restarts while the Mac sleeps still says since when. In the state directory: it is rebuilt by the next summary. */
const SEEN = "nodes-seen.json";
/** A link not up this long after its socket opened is dropped and dialled again. */
const HANDSHAKE_MS = 10_000;
/** Summaries at most this often: a turn ending flips three fields in one breath. */
const SUMMARY_MIN_MS = 1_000;
/** The join post. A node on the tailnet answers in milliseconds or not at all. */
const JOIN_MS = 10_000;
/** A child's backup export, which is its boards and conversations as text. */
const EXPORT_MS = 60_000;
/** The largest frame a link takes: a child's whole mirror is one, and conversations are long. */
const LINK_MAX_PAYLOAD = 64 * 1024 * 1024;
const SEEN_WRITE_MS = 5_000;
const DEFAULT_PORT = 7717;

/** What is kept, `0600`: the newest roster, the parent's key it was checked against, and — on the parent — each child's share token, for its QR code. */
interface Saved {
  anchor: string | null;
  roster: SignedRoster | null;
  tokens: Record<string, string>;
}

export interface NodeHostDeps {
  version: string;
  port: number;
  hostname: string;
  platform: string;
  stateDir: string;
  /** Where the others dial this node: `KURURU_NODE_ADDRESS`, else the tailnet address. */
  address: () => string | null;
  /** Why another node could not dial this one, or null when it could. */
  unreachable: () => string | null;
  /** This node's share token, handed to the parent at pairing for its QR code. */
  shareToken: () => string;
  /** This node's summary, now. */
  summary: (leads: boolean, sees: string[]) => NodeSummary;
  /** This node's backup mirror, now, for the parent's pull. */
  exportFiles: () => { mark: string; files: ReadonlyMap<string, string | Buffer> };
  /** Something a client draws changed. */
  changed: () => void;
  log: (line: string) => void;
  /**
   * A peer's workspace arriving here (`move.ts`): whether a folder will do,
   * and the move itself. Absent in a test that does not move anything, and
   * then a peer's ask is answered with why not.
   */
  moves?: {
    check: (peer: string, ask: unknown) => MoveCheck;
    adopt: (peer: string, offer: unknown) => Promise<MoveDone>;
  };
  /** A Kuru's message from a linked member, already past the handshake — `peerkuru.ts`'s to read. */
  peer?: (nodeId: string, message: PeerMessage) => void;
  /** A link to a member came up: what the other side should be told about this node's Kuru goes now. */
  linked?: (nodeId: string) => void;
  /**
   * Who leads, when something knows better than rank alone: the node that
   * polls Telegram (`lead.ts`), which is the one job leading is. Null to
   * fall back to `leaderOf`. Must not ask this host for its statuses, which
   * ask for the leader.
   */
  leader?: () => string | null;
}

interface PeerState {
  state: LinkState;
  since: number | null;
  lastSeen: number | null;
  error: string | null;
  summary: NodeSummary | null;
  /** The summary was pushed on the link that is up now, not one before it: what it says about this moment can be believed. */
  live?: boolean;
}

class Link {
  peer: string | null = null;
  up = false;
  lastHeard = Date.now();
  constructor(
    readonly ws: WebSocket,
    readonly dialled: string | null,
    readonly handshake: LinkHandshake,
  ) {}

  send(message: LinkMessage): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(message));
    } catch {
      // Closing; the close handler tidies up.
    }
  }

  close(reason: string): void {
    try {
      this.ws.close(1000, reason.slice(0, 120));
    } catch {
      this.ws.terminate();
    }
  }
}

interface Dialer {
  failures: number;
  timer: ReturnType<typeof setTimeout> | null;
  link: Link | null;
}

/** A question put to a peer that wants its answer back: a move's check, or the move. */
interface Ask {
  peer: string;
  resolve: (message: LinkMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Pull {
  peer: string;
  resolve: (value: { mark: string; files: Map<string, Buffer> }) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function adoptSaved(raw: unknown): Saved {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Saved>;
  const tokens: Record<string, string> = {};
  if (r.tokens && typeof r.tokens === "object") {
    for (const [id, token] of Object.entries(r.tokens)) if (isNodeId(id) && typeof token === "string") tokens[id] = token;
  }
  return { anchor: typeof r.anchor === "string" ? r.anchor : null, roster: asSignedRoster(r.roster), tokens };
}

/** What `Origin`, a proxy's header or an address off the tailnet says about a request to a node's own routes. Null when it may go on. */
export function nodeRequestRefusal(req: IncomingMessage): string | null {
  if (req.headers.origin) return "a page may not use a node's routes";
  if (FORWARDING_HEADERS.some((name) => req.headers[name] !== undefined)) return "a node's routes refuse anything that came through a proxy";
  if (!nodeRemoteAllowed(req.socket.remoteAddress)) return "a node's routes answer the tailnet only";
  return null;
}

export class NodeHost {
  private saved: Saved;
  private readonly me: Identity;
  /** The join code this node is showing, on the parent or a node about to be one. */
  private invitation: Pairing | null = null;
  private lastJoined: { name: string; at: number } | null = null;
  private readonly peers = new Map<string, PeerState>();
  /** Up links, by peer. */
  private readonly links = new Map<string, Link>();
  private readonly pending = new Set<Link>();
  private readonly dialers = new Map<string, Dialer>();
  private readonly pulls = new Map<string, Pull>();
  private readonly asks = new Map<string, Ask>();
  /** The data mark of each node's last backup pull. */
  private readonly pulled = new Map<string, string>();
  /**
   * What the later phases hang on a link: a handler per message type, and
   * the moments a link comes up or goes and this node leaves the roster.
   * Phase 2's messages and phase 6's moves are cases in `onFrame`, and
   * phase 3's Kurus go to `deps.peer`; the secrets (`secrets.ts`) register
   * theirs here, and a later phase can too, without growing it.
   */
  private readonly handlers = new Map<string, (peer: string, message: LinkMessage) => void>();
  private readonly upHooks: Array<(peer: string) => void> = [];
  private readonly downHooks: Array<(peer: string) => void> = [];
  private readonly unpairHooks: Array<() => void> = [];
  private lastSummaryKey = "";
  private lastSummaryAt = 0;
  private summaryTimer: ReturnType<typeof setTimeout> | null = null;
  private seenTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly beat: ReturnType<typeof setInterval>;
  /** Parent edits, one at a time: two adds at once would sign two rosters of the same version. */
  private editing: Promise<unknown> = Promise.resolve();
  private closed = false;
  /**
   * Why nodes are off for this run, or null. An identity file this server
   * cannot read is left alone rather than replaced — a new identity would be
   * a member nobody enrolled — and the server serves without nodes.
   */
  private readonly off: string | null = null;

  constructor(private readonly deps: NodeHostDeps) {
    let me: Identity;
    try {
      me = identity();
    } catch (err) {
      this.off = err instanceof Error ? err.message : String(err);
      deps.log(`nodes are off for this run: ${this.off}`);
      me = { id: "n000000000000", keys: { sign: "", box: "" } };
    }
    this.me = me;
    this.saved = this.off ? { anchor: null, roster: null, tokens: {} } : adoptSaved(readConfigFile(FILE));
    // A roster on the disk is checked like one off the wire: a hand-edited
    // file is not a way to add a member.
    if (this.saved.roster) {
      const anchor = this.saved.anchor;
      const ok = anchor !== null && adoptRoster(null, this.saved.roster, anchor, verifySigned).adopted;
      if (!ok) {
        deps.log(`nodes: the roster in ${FILE} does not check against the parent's key, so this node starts unpaired`);
        this.saved = { anchor: null, roster: null, tokens: {} };
      }
    }
    this.loadSeen();
    this.syncPeers();
    this.refreshOwnEntry();
    this.beat = setInterval(() => this.heartbeat(), PING_MS);
    this.beat.unref();
    if (this.off) this.closed = true;
    else this.mesh();
  }

  // ---------------------------------------------------------------------------
  // What this node is
  // ---------------------------------------------------------------------------

  private get roster(): Roster | null {
    return this.saved.roster?.roster ?? null;
  }

  role(): NodeRole {
    const roster = this.roster;
    if (!roster || !memberOf(roster, this.me.id)) return "alone";
    return roster.parent === this.me.id && rosterSigner() === roster.signer ? "parent" : "child";
  }

  /** This node's id. */
  selfId(): string {
    return this.me.id;
  }

  /** This node's name in the roster, or the one it would take. */
  name(): string {
    return this.selfName();
  }

  /** A member's name, for a sentence. */
  nameOf(nodeId: string): string | null {
    return memberOf(this.roster, nodeId)?.name ?? null;
  }

  /** Whether the link to a member is up now. */
  linked(nodeId: string): boolean {
    return this.links.has(nodeId);
  }

  /** The roster's parent, whoever holds the roster: this node on the parent. Null in no roster. */
  parentId(): string | null {
    const roster = this.roster;
    return roster && memberOf(roster, this.me.id) ? roster.parent : null;
  }

  /** A member as the roster lists it, keys and all. */
  member(id: string): NodeEntry | undefined {
    return memberOf(this.roster, id);
  }

  // ---------------------------------------------------------------------------
  // What the later phases hang on a link
  // ---------------------------------------------------------------------------

  /** Handle every message of this type that arrives on an up link, given the peer it came from. One handler a type. */
  on(type: LinkMessage["type"], handler: (peer: string, message: LinkMessage) => void): void {
    this.handlers.set(type, handler);
  }

  onLinkUp(hook: (peer: string) => void): void {
    this.upHooks.push(hook);
  }

  onLinkDown(hook: (peer: string) => void): void {
    this.downHooks.push(hook);
  }

  /** This node left the roster: removed by the parent, or paired anew. */
  onUnpair(hook: () => void): void {
    this.unpairHooks.push(hook);
  }

  private hook<T extends unknown[]>(hooks: ReadonlyArray<(...args: T) => void>, ...args: T): void {
    for (const hook of hooks) {
      try {
        hook(...args);
      } catch (err) {
        this.deps.log(`nodes: a link hook failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** What this node is called: its roster name, or the one it will be given. What `[kuru@mac]` says. */
  private selfName(): string {
    return memberOf(this.roster, this.me.id)?.name ?? defaultNodeName(this.deps.hostname, this.deps.platform);
  }

  /** A member by its name, as a Kuru or a person types it; never this node. */
  byName(name: string): NodeStatus | null {
    const wanted = name.trim().toLowerCase().replace(/^@/, "");
    return this.statuses().find((n) => n.name === wanted) ?? null;
  }

  /**
   * Say something to one member, if its link is up. False when it is not —
   * there is no queue here, because what is worth holding for a node that
   * is away is the caller's to hold and to say it is holding.
   */
  send(nodeId: string, message: LinkMessage): boolean {
    const link = this.links.get(nodeId);
    if (!link) return false;
    link.send(message);
    return true;
  }

  /** The members a link is up to now, by id. */
  linkedIds(): string[] {
    return [...this.links.keys()];
  }

  leader(): string | null {
    return this.deps.leader?.() ?? leaderOf(this.roster, new Set(this.links.keys()), this.me.id);
  }

  /** The last summary a member pushed, up or not. */
  summaryOf(nodeId: string): NodeSummary | null {
    return this.peers.get(nodeId)?.summary ?? null;
  }

  /**
   * The summary a member pushed on the link that is up now, or null —
   * never one kept from before it went away, which says what was true
   * then. Whether a node polls Telegram is read off this one: a Mac's
   * summary from before its lid closed says it polls, and it does not.
   */
  liveSummaryOf(nodeId: string): NodeSummary | null {
    const peer = this.peers.get(nodeId);
    return peer?.live && this.links.has(nodeId) ? peer.summary : null;
  }

  /** This node's rank in the roster, or null in none. */
  ownRank(): number | null {
    return memberOf(this.roster, this.me.id)?.rank ?? null;
  }

  /** The members, this node among them, by rank. Empty in no roster. */
  members(): NodeEntry[] {
    const roster = this.roster;
    return roster && memberOf(roster, this.me.id) ? byRank(roster.members) : [];
  }

  /** The Telegram settings the roster carries: the parent's, signed there. */
  rosterTelegram(): SharedTelegram | null {
    return memberOf(this.roster, this.me.id) ? rosterTelegram(this.roster) : null;
  }

  /**
   * The parent's Telegram settings into the roster, when they changed — a
   * new roster, relayed like any other. Not a secret: the token is lent on
   * its own (`secrets.ts`). Nothing on a node that is not the parent.
   */
  setChannels(telegram: SharedTelegram | null): void {
    if (this.role() !== "parent") return;
    void this.serially(async () => {
      if (this.role() !== "parent") return;
      const next = withChannels(this.roster!, telegram, Date.now());
      if (next) this.publish(next);
    }).catch((err: unknown) => this.deps.log(`nodes: the channel settings did not go into the roster: ${err instanceof Error ? err.message : String(err)}`));
  }

  private status(entry: NodeEntry): NodeStatus {
    const peer = this.peers.get(entry.id);
    const roster = this.roster;
    const token = this.role() === "parent" ? (this.saved.tokens[entry.id] ?? null) : null;
    return {
      id: entry.id,
      name: entry.name,
      address: entry.address,
      port: entry.port,
      rank: entry.rank,
      parent: roster?.parent === entry.id,
      state: peer?.state ?? "connecting",
      since: peer?.since ?? null,
      lastSeen: peer?.lastSeen ?? null,
      error: peer?.error ?? null,
      summary: peer?.summary ?? null,
      leader: this.leader() === entry.id,
      url: nodeUrl(entry, token),
    };
  }

  /** Every other member, by rank. */
  statuses(): NodeStatus[] {
    const roster = this.roster;
    if (!roster || !memberOf(roster, this.me.id)) return [];
    return byRank(roster.members)
      .filter((m) => m.id !== this.me.id)
      .map((m) => this.status(m));
  }

  view(): NodesView {
    const roster = this.roster;
    const mine = memberOf(roster, this.me.id);
    const now = Date.now();
    return {
      self: { id: this.me.id, name: this.selfName(), address: this.deps.address(), port: this.deps.port, rank: mine?.rank ?? null },
      role: this.role(),
      rosterVersion: mine ? (roster?.version ?? null) : null,
      leader: this.leader(),
      nodes: this.statuses(),
      invite: this.inviteView(),
      joined: this.lastJoined,
      reachable: this.off ? `Nodes are off for this run: ${this.off}` : this.deps.unreachable(),
    };
  }

  /** The few facts `/api/health` carries, for `bun run status` and the doctor. */
  health(): { role: NodeRole; name: string; leader: string | null; nodes: Array<{ name: string; state: LinkState; parent: boolean; since: number | null }> } {
    const leader = this.leader();
    return {
      role: this.role(),
      name: this.selfName(),
      leader: leader ? (memberOf(this.roster, leader)?.name ?? null) : null,
      nodes: this.statuses().map((n) => ({ name: n.name, state: n.state, parent: n.parent, since: n.since })),
    };
  }

  // ---------------------------------------------------------------------------
  // The roster
  // ---------------------------------------------------------------------------

  private save(): void {
    writeConfigFile(FILE, this.saved, 0o600);
  }

  /**
   * Take a roster that is newer and signed by the parent — off a link, out
   * of a join, or just signed here — and pass it on to every peer.
   * Learning from it that this node was removed ends the membership: the
   * links close and the node is alone again, ready to be paired anew.
   */
  private take(signed: SignedRoster): void {
    const wasMember = memberOf(this.roster, this.me.id) !== undefined;
    const isMember = memberOf(signed.roster, this.me.id) !== undefined;
    if (wasMember && !isMember) {
      this.unpair("the parent removed this node from the roster");
      return;
    }
    this.saved = { ...this.saved, roster: signed };
    if (this.role() === "parent") {
      // A removed child's token goes with it.
      for (const id of Object.keys(this.saved.tokens)) if (!memberOf(signed.roster, id)) delete this.saved.tokens[id];
    }
    this.save();
    for (const link of this.links.values()) link.send({ type: "roster", roster: signed });
    this.syncPeers();
    this.mesh();
    this.changed();
  }

  /** A roster a peer brought. Only one the anchor signed, and only when newer. */
  private offer(incoming: unknown): void {
    const anchor = this.saved.anchor;
    if (!anchor) return;
    const result = adoptRoster(this.saved.roster, incoming, anchor, verifySigned);
    if (result.adopted) this.take(result.roster);
  }

  private unpair(why: string): void {
    this.deps.log(`nodes: ${why}; this node is unpaired now`);
    this.saved = { anchor: null, roster: null, tokens: {} };
    this.save();
    for (const link of [...this.links.values(), ...this.pending]) link.close(why);
    this.links.clear();
    this.pending.clear();
    for (const dialer of this.dialers.values()) if (dialer.timer) clearTimeout(dialer.timer);
    this.dialers.clear();
    this.peers.clear();
    this.hook(this.unpairHooks);
    this.changed();
  }

  private syncPeers(): void {
    const roster = this.roster;
    const ids = new Set((roster?.members ?? []).map((m) => m.id).filter((id) => id !== this.me.id));
    if (!memberOf(roster, this.me.id)) ids.clear();
    for (const id of [...this.peers.keys()]) if (!ids.has(id)) this.peers.delete(id);
    for (const id of ids) if (!this.peers.has(id)) this.peers.set(id, { state: "connecting", since: null, lastSeen: null, error: null, summary: null });
  }

  /** Sign and take a roster: the parent's only way of changing one. */
  private publish(roster: Roster): SignedRoster {
    const signed = { roster, signature: signRoster(rosterPayload(roster)) };
    this.take(signed);
    return signed;
  }

  /**
   * The parent's own address and port, kept true: the Mac's tailnet address
   * can change, and a roster naming the old one is a mesh nobody can dial
   * up to. Checked once at start, which is when either could have moved.
   */
  private refreshOwnEntry(): void {
    if (this.role() !== "parent") return;
    const mine = memberOf(this.roster, this.me.id)!;
    const address = this.deps.address();
    if (address && (address !== mine.address || this.deps.port !== mine.port)) {
      this.publish(withChange(this.roster!, this.me.id, { address, port: this.deps.port }, Date.now()));
    }
  }

  private serially<T>(run: () => Promise<T>): Promise<T> {
    const next = this.editing.then(run, run);
    this.editing = next.catch(() => undefined);
    return next;
  }

  private parentOnly(): Roster {
    if (this.role() !== "parent") throw new Error("Only the parent changes the roster, and this node is not it.");
    return this.roster!;
  }

  // ---------------------------------------------------------------------------
  // Pairing: the parent's half
  // ---------------------------------------------------------------------------

  /**
   * Become a parent, for the first node added: the roster key, made once,
   * and a roster of one. Refused on a node in another parent's roster, and on
   * one no other node could dial — the Mac with sharing off.
   */
  private ensureParent(): Roster {
    if (this.off) throw new Error(`Nodes are off for this run: ${this.off}`);
    const role = this.role();
    if (role === "child") throw new Error("This node is in another parent's roster, so it cannot add nodes. Add them from the parent.");
    const why = this.deps.unreachable();
    if (why) throw new Error(why);
    const address = this.deps.address();
    if (!address) throw new Error("This machine has no tailnet address, so no other node could reach it.");
    if (role === "parent") return this.roster!;
    const signer = becomeParent();
    this.saved = { anchor: signer, roster: null, tokens: {} };
    const now = Date.now();
    this.publish({
      version: 1,
      parent: this.me.id,
      signer,
      members: [{ id: this.me.id, name: this.selfName(), keys: this.me.keys, address, port: this.deps.port, rank: 1 }],
      issuedAt: now,
    });
    this.deps.log("nodes: this node is a parent now, with a roster of its own");
    return this.roster!;
  }

  /**
   * Settings → Nodes → Add a computer: a single-use code for ten minutes,
   * and the command to run on the new PC with this node's address in it.
   * Refused where no other node could dial this one, since the command
   * would send the PC to an address nothing answers on.
   */
  invite(on: boolean): NodesView["invite"] {
    if (!on) {
      this.invitation = null;
      this.changed();
      return null;
    }
    if (this.off) throw new Error(`Nodes are off for this run: ${this.off}`);
    if (this.role() === "child") throw new Error("This node is in another parent's roster, so computers are added from the parent.");
    const why = this.deps.unreachable();
    if (why) throw new Error(why);
    this.invitation = { code: makeCode(randomBytes(CODE_LENGTH)), expiresAt: Date.now() + CODE_TTL_MS, misses: 0 };
    this.changed();
    return this.inviteView();
  }

  private inviteView(): NodesView["invite"] {
    const invite = this.invitation;
    const address = this.deps.address();
    if (!invite || invite.expiresAt <= Date.now() || !address) return null;
    return { code: invite.code, expiresAt: invite.expiresAt, command: joinCommand(address, this.deps.port, invite.code) };
  }

  /**
   * `POST /api/nodes/join`, from a new PC running the command this node
   * showed. The code is checked and burnt, the PC goes into a roster signed
   * here — this node becoming a parent if it was not one — and the answer
   * is that roster. The PC's address is the one its request came from, so
   * nobody has to know or type it; on loopback (two instances on one
   * machine) the address it says it has is used instead. Reached without the
   * share token, since the code is what it presents, and only from the
   * tailnet with no page and no proxy in between.
   */
  acceptJoin(req: IncomingMessage, body: unknown): { status: number; body: unknown } {
    const refused = nodeRequestRefusal(req);
    if (refused) return { status: 403, body: { error: refused } };
    const b = (body && typeof body === "object" ? body : {}) as { code?: unknown; node?: Record<string, unknown>; shareToken?: unknown };
    const check = checkCode(this.invitation, b.code, Date.now());
    if (!check.ok) {
      this.invitation = check.pairing;
      this.changed();
      return { status: 403, body: { error: codeRefusal(check.why) } };
    }
    const node = b.node ?? {};
    const keys = (node.keys ?? {}) as Partial<NodeKeys>;
    if (!isNodeId(node.id) || typeof keys.sign !== "string" || typeof keys.box !== "string") return { status: 400, body: { error: "The new PC's request was not one this kururu understands; update kururu there." } };
    if (node.id === this.me.id) return { status: 400, body: { error: "That command is for another computer, not this one." } };
    const port = typeof node.port === "number" && Number.isInteger(node.port) && node.port > 0 && node.port < 65536 ? node.port : DEFAULT_PORT;
    const remote = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    const loopback = remote === "::1" || remote.startsWith("127.");
    const said = typeof node.address === "string" && validHostName(node.address) ? node.address : null;
    const address = loopback ? (said ?? "127.0.0.1") : remote;
    let roster: Roster;
    try {
      roster = this.ensureParent();
    } catch (err) {
      return { status: 409, body: { error: err instanceof Error ? err.message : String(err) } };
    }
    const name = freeName(roster, nodeName(node.name) ?? "node", node.id);
    const next = withMember(roster, { id: node.id, name, keys: { sign: keys.sign, box: keys.box }, address, port }, Date.now());
    const signed = { roster: next, signature: signRoster(rosterPayload(next)) };
    if (!asSignedRoster(signed)) return { status: 400, body: { error: "The new PC's keys are not keys this kururu can put in a roster." } };
    const token = b.shareToken;
    if (typeof token === "string" && token.length >= 16 && token.length <= 200) this.saved.tokens[node.id] = token;
    this.invitation = null;
    this.lastJoined = { name, at: Date.now() };
    this.take(signed);
    this.deps.log(`nodes: ${name} joined, from ${address}:${port}`);
    return { status: 200, body: { roster: signed, name } };
  }

  rename(nodeId: unknown, nameRaw: unknown): Promise<NodesView> {
    return this.serially(async () => {
      const roster = this.parentOnly();
      if (typeof nodeId !== "string" || !memberOf(roster, nodeId)) throw new Error("That node is not in the roster.");
      const name = nodeName(nameRaw);
      if (!name) throw new Error("A name is letters, digits and dashes, starting with a letter.");
      if (roster.members.some((m) => m.id !== nodeId && m.name === name)) throw new Error(`${name} is taken.`);
      if (memberOf(roster, nodeId)!.name !== name) this.publish(withChange(roster, nodeId, { name }, Date.now()));
      return this.view();
    });
  }

  rank(order: unknown): Promise<NodesView> {
    return this.serially(async () => {
      const roster = this.parentOnly();
      const ids = Array.isArray(order) ? order.filter((id): id is string => typeof id === "string") : [];
      const next = reranked(roster, ids, Date.now());
      const same = byRank(next.members).every((m, i) => byRank(roster.members)[i]?.id === m.id);
      if (!same) this.publish(next);
      return this.view();
    });
  }

  remove(nodeId: unknown): Promise<NodesView> {
    return this.serially(async () => {
      const roster = this.parentOnly();
      if (typeof nodeId !== "string" || !memberOf(roster, nodeId)) throw new Error("That node is not in the roster.");
      if (nodeId === this.me.id) throw new Error("The parent cannot remove itself.");
      const name = memberOf(roster, nodeId)!.name;
      // Taken here, which relays the roster down every link — the removed
      // node's included, so it learns it is out — and only then do the
      // links to it close, after that frame.
      this.publish(withoutMember(roster, nodeId, Date.now()));
      this.deps.log(`nodes: removed ${name}`);
      return this.view();
    });
  }

  // ---------------------------------------------------------------------------
  // Pairing: the new PC's half
  // ---------------------------------------------------------------------------

  /**
   * `kururu child join <mac> <code>`, or the same pasted into this node's own
   * Settings → Nodes: post this node's id, keys, port and share token to the
   * Mac with the code, and take the roster it answers with. The roster is
   * checked against the key it names, which becomes this node's anchor —
   * trust on first use, made safe by the code the person copied off the
   * Mac's own screen.
   */
  join(text: unknown): Promise<NodesView> {
    return this.serially(async () => {
      if (this.off) throw new Error(`Nodes are off for this run: ${this.off}`);
      const target = parseJoin(text, DEFAULT_PORT);
      if (!target) throw new Error("That is not a join command. On the Mac, Settings → Nodes → Add a computer shows one: kururu child join <address> <code>.");
      const role = this.role();
      if (role === "parent" && (this.roster?.members.length ?? 0) > 1) throw new Error("This node is the parent of other nodes, so it cannot join another.");
      if (role === "child") {
        const parent = memberOf(this.roster, this.roster!.parent)?.name ?? "a parent";
        throw new Error(`This node is already paired with ${parent}. To pair it again, remove it in ${parent}'s Settings → Nodes first; it notices the next time the two link.`);
      }
      const host = target.address.includes(":") ? `[${target.address}]` : target.address;
      let res: Response;
      try {
        res = await fetch(`http://${host}:${target.port}/api/nodes/join`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            code: target.code,
            node: { id: this.me.id, name: this.selfName(), keys: this.me.keys, address: this.deps.address(), port: this.deps.port, version: this.deps.version },
            shareToken: this.deps.shareToken(),
          }),
          signal: AbortSignal.timeout(JOIN_MS),
        });
      } catch (err) {
        const said = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
        throw new Error(`Nothing answered at ${target.address}:${target.port} (${said}). Is the Mac awake, with sharing on, and is this PC on the same tailnet?`);
      }
      let answer: Record<string, unknown> = {};
      try {
        answer = (await res.json()) as Record<string, unknown>;
      } catch {
        // Not JSON is not a kururu that knows about nodes.
      }
      if (!res.ok) {
        throw new Error(typeof answer.error === "string" ? answer.error : res.status === 404 ? "The Mac's kururu does not know about nodes yet; update it." : `The Mac answered ${res.status}.`);
      }
      const adopted = adoptRoster(null, answer.roster, null, verifySigned);
      if (!adopted.adopted) throw new Error("The Mac's answer did not carry a roster this node could check.");
      if (!memberOf(adopted.roster.roster, this.me.id)) throw new Error("The Mac's roster does not list this node.");
      if (role === "parent") stopBeingParent();
      this.saved = { anchor: adopted.roster.roster.signer, roster: adopted.roster, tokens: {} };
      this.save();
      this.syncPeers();
      this.deps.log(`nodes: joined ${memberOf(this.roster, this.roster!.parent)?.name ?? "the parent"}'s roster as ${this.selfName()}`);
      this.mesh();
      this.changed();
      return this.view();
    });
  }

  // ---------------------------------------------------------------------------
  // The mesh
  // ---------------------------------------------------------------------------

  /**
   * Dial every member ranked above this one that is not already linked,
   * stop dialling any that is not, and close any link to a node the roster
   * no longer lists. A rank change that flips who dials whom leaves a
   * working link alone; the next one to drop is redialled the new way.
   */
  private mesh(): void {
    if (this.closed) return;
    const roster = this.roster;
    const targets = new Set(dialTargets(roster, this.me.id).map((m) => m.id));
    for (const [id, dialer] of this.dialers) {
      if (targets.has(id)) continue;
      if (dialer.timer) clearTimeout(dialer.timer);
      this.dialers.delete(id);
    }
    for (const link of [...this.links.values(), ...this.pending]) {
      const peer = link.peer ?? link.dialled;
      if (peer && !memberOf(roster, peer)) link.close("not in the roster");
    }
    for (const id of targets) {
      if (!this.dialers.has(id)) {
        this.dialers.set(id, { failures: 0, timer: null, link: null });
        this.dial(id);
      }
    }
  }

  private dial(nodeId: string): void {
    const dialer = this.dialers.get(nodeId);
    const entry = memberOf(this.roster, nodeId);
    if (this.closed || !dialer || !entry || dialer.link || this.links.has(nodeId)) return;
    dialer.timer = null;
    const host = entry.address.includes(":") ? `[${entry.address}]` : entry.address;
    const ws = new WebSocket(`ws://${host}:${entry.port}/link`, { handshakeTimeout: HANDSHAKE_MS, maxPayload: LINK_MAX_PAYLOAD });
    const link = this.open(ws, nodeId);
    dialer.link = link;
    let wasUp = false;
    ws.on("error", (err: Error) => {
      const peer = this.peers.get(nodeId);
      if (peer) peer.error = `${entry.address}:${entry.port}: ${err.message}`;
    });
    ws.on("open", () => link.send(link.handshake.hello()));
    ws.on("message", () => {
      wasUp ||= link.up;
    });
    ws.on("close", () => {
      if (dialer.link === link) dialer.link = null;
      if (this.closed || this.dialers.get(nodeId) !== dialer) return;
      dialer.failures = wasUp ? 0 : dialer.failures + 1;
      this.settleAway(Date.now());
      dialer.timer = setTimeout(() => this.dial(nodeId), wasUp ? 1000 : dialDelay(dialer.failures));
      dialer.timer.unref();
    });
  }

  /** A link that came in on `/link`, already past `nodeRequestRefusal`. */
  accept(ws: WebSocket): void {
    if (this.closed || this.role() === "alone") {
      ws.close(1008, "this node is in no roster");
      return;
    }
    const link = this.open(ws, null);
    link.send(link.handshake.hello());
  }

  private open(ws: WebSocket, dialled: string | null): Link {
    const handshake = new LinkHandshake({
      self: this.me.id,
      version: this.deps.version,
      challenge: challenge(),
      sign: signAsNode,
      verify: verifySigned,
      roster: () => this.saved.roster,
      adopt: (incoming) => this.offer(incoming),
      ...(dialled ? { expect: dialled } : {}),
    });
    const link = new Link(ws, dialled, handshake);
    this.pending.add(link);
    const timer = setTimeout(() => {
      if (!link.up) {
        this.noteError(link.dialled, "the handshake did not finish");
        ws.terminate();
      }
    }, HANDSHAKE_MS);
    timer.unref();
    ws.on("message", (data) => this.onFrame(link, data.toString()));
    ws.on("close", (code) => {
      clearTimeout(timer);
      this.onClose(link, code);
    });
    ws.on("error", () => undefined);
    return link;
  }

  private noteError(nodeId: string | null, error: string): void {
    const peer = nodeId ? this.peers.get(nodeId) : undefined;
    if (peer) {
      peer.error = error;
      this.changed();
    }
  }

  private onFrame(link: Link, raw: string): void {
    link.lastHeard = Date.now();
    const message = parseLinkMessage(raw);
    if (!message) return;
    if (!link.up) {
      for (const step of link.handshake.receive(message)) {
        if (step.kind === "send") link.send(step.message);
        else if (step.kind === "up") this.linkUp(link, step.peer);
        else {
          if (step.tell) link.send({ type: "refuse", reason: step.reason });
          this.noteError(link.handshake.peerId ?? link.dialled, step.reason);
          this.deps.log(`nodes: refused a link${link.handshake.peerId ? ` with ${memberOf(this.roster, link.handshake.peerId)?.name ?? link.handshake.peerId}` : ""}: ${step.reason}`);
          link.close(step.reason);
        }
      }
      return;
    }
    const peer = this.peers.get(link.peer!);
    if (peer) peer.lastSeen = link.lastHeard;
    switch (message.type) {
      case "roster":
        this.offer(message.roster);
        return;
      case "summary":
        if (peer && validSummary(message.summary)) {
          peer.summary = message.summary;
          peer.live = true;
          this.queueSeen();
          this.changed();
        }
        return;
      case "export-ask":
        this.answerExport(link, message.id);
        return;
      case "export":
        this.onExport(message);
        return;
      case "workspace-move-check":
        this.answerMoveCheck(link, message);
        return;
      case "workspace-move":
        void this.answerMove(link, message);
        return;
      case "workspace-move-checked":
      case "workspace-moved":
        this.onAnswer(link, message);
        return;
      case "bye":
        this.noteError(link.peer, typeof message.reason === "string" ? message.reason : "it said goodbye");
        link.close("bye");
        return;
      case "refuse":
        link.close("refused");
        return;
      default: {
        // The Kurus' messages are `peerkuru.ts`'s; a later phase's that it
        // registered are its handler's; a ping, and whatever this one does
        // not know, are nothing here.
        if (isPeerMessage(message)) {
          this.deps.peer?.(link.peer!, message);
          return;
        }
        const handler = this.handlers.get(message.type);
        if (!handler) return;
        try {
          handler(link.peer!, message);
        } catch (err) {
          this.deps.log(`nodes: handling ${message.type} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
    }
  }

  private linkUp(link: Link, peerId: string): void {
    this.pending.delete(link);
    link.up = true;
    link.peer = peerId;
    const old = this.links.get(peerId);
    this.links.set(peerId, link);
    if (old && old !== link) old.close("replaced by a newer link");
    const now = Date.now();
    const peer = this.peers.get(peerId);
    if (peer) Object.assign(peer, { state: "up", since: now, lastSeen: now, error: null, live: false });
    const dialer = this.dialers.get(peerId);
    if (dialer) dialer.failures = 0;
    this.deps.log(`nodes: linked with ${memberOf(this.roster, peerId)?.name ?? peerId}`);
    link.send({ type: "summary", summary: this.summaryNow() });
    // That was this moment's, to this link alone: the next change goes to
    // every link whatever the others last heard, or a change back to what
    // they last heard would never reach this one.
    this.lastSummaryKey = "";
    this.deps.linked?.(peerId);
    this.hook(this.upHooks, peerId);
    this.changed();
    // Who this node sees changed, so its summary did.
    this.queueSummary();
  }

  /**
   * A link gone. Away from when it was last heard — unless it went saying
   * it was restarting (1001, what `close()` sends), which under `bun run
   * dev` is every save: that node is reconnecting, and only becomes away if
   * it is not back within `AWAY_MS` (`settleAway`).
   */
  private onClose(link: Link, code?: number): void {
    this.pending.delete(link);
    const peerId = link.peer;
    if (!peerId || this.links.get(peerId) !== link) return;
    this.links.delete(peerId);
    const peer = this.peers.get(peerId);
    if (peer) Object.assign(peer, code === 1001 ? { state: "connecting", lastSeen: link.lastHeard } : { state: "away", since: link.lastHeard });
    for (const [id, pull] of this.pulls) {
      if (pull.peer !== peerId) continue;
      clearTimeout(pull.timer);
      this.pulls.delete(id);
      pull.reject(new Error("the link dropped"));
    }
    for (const [id, ask] of this.asks) {
      if (ask.peer !== peerId) continue;
      clearTimeout(ask.timer);
      this.asks.delete(id);
      ask.reject(new Error("the link dropped"));
    }
    this.deps.log(`nodes: ${memberOf(this.roster, peerId)?.name ?? peerId} went away`);
    this.hook(this.downHooks, peerId);
    this.queueSeen();
    this.changed();
    this.queueSummary();
  }

  /**
   * Every five seconds: a ping down every link, and the end of any that
   * has been silent past `AWAY_MS` — the only way a sleeping machine is
   * noticed. And the join code's expiry, which a client draws.
   */
  private heartbeat(): void {
    const now = Date.now();
    for (const link of this.links.values()) {
      if (now - link.lastHeard > AWAY_MS) {
        this.noteError(link.peer, `silent for ${Math.round((now - link.lastHeard) / 1000)} s`);
        link.ws.terminate();
      } else link.send({ type: "ping", at: now });
    }
    this.settleAway(now);
    if (this.invitation && now >= this.invitation.expiresAt) {
      this.invitation = null;
      this.changed();
    }
  }

  /**
   * A node still `connecting` that was heard from once — this run, or the
   * last, by the seen file — and not for `AWAY_MS` is away since then. It is
   * what lets a child restarted while the Mac sleeps say since when at once,
   * and what turns a restart that never came back into an absence.
   */
  private settleAway(now: number): void {
    for (const [id, peer] of this.peers) {
      if (peer.state !== "connecting" || peer.lastSeen === null || this.links.has(id) || now - peer.lastSeen <= AWAY_MS) continue;
      peer.state = "away";
      peer.since = peer.lastSeen;
      this.changed();
    }
  }

  // ---------------------------------------------------------------------------
  // Summaries
  // ---------------------------------------------------------------------------

  private summaryNow(): NodeSummary {
    const sees = [...this.links.keys()];
    return this.deps.summary(this.leader() === this.me.id, sees);
  }

  /** Something a summary carries may have changed. Coalesced, and pushed only when it did. */
  queueSummary(): void {
    if (this.summaryTimer || this.closed) return;
    const wait = Math.max(0, this.lastSummaryAt + SUMMARY_MIN_MS - Date.now());
    this.summaryTimer = setTimeout(() => {
      this.summaryTimer = null;
      this.pushSummary();
    }, wait);
    this.summaryTimer.unref();
  }

  private pushSummary(): void {
    if (this.links.size === 0) return;
    this.lastSummaryAt = Date.now();
    const summary = this.summaryNow();
    const key = summaryKey(summary);
    if (key === this.lastSummaryKey) return;
    this.lastSummaryKey = key;
    for (const link of this.links.values()) link.send({ type: "summary", summary });
  }

  private loadSeen(): void {
    try {
      const raw = JSON.parse(readFileSync(join(this.deps.stateDir, SEEN), "utf8")) as Record<string, { summary?: unknown; lastSeen?: unknown }>;
      for (const [id, seen] of Object.entries(raw)) {
        if (!isNodeId(id)) continue;
        const lastSeen = typeof seen.lastSeen === "number" && Number.isFinite(seen.lastSeen) ? seen.lastSeen : null;
        this.peers.set(id, { state: "connecting", since: null, lastSeen, error: null, summary: validSummary(seen.summary) ? seen.summary : null });
      }
    } catch {
      // Nothing seen yet.
    }
  }

  private queueSeen(): void {
    if (this.seenTimer) return;
    this.seenTimer = setTimeout(() => {
      this.seenTimer = null;
      this.writeSeen();
    }, SEEN_WRITE_MS);
    this.seenTimer.unref();
  }

  private writeSeen(): void {
    const out: Record<string, { summary: NodeSummary | null; lastSeen: number | null }> = {};
    for (const [id, peer] of this.peers) out[id] = { summary: peer.summary, lastSeen: peer.lastSeen };
    try {
      mkdirSync(this.deps.stateDir, { recursive: true });
      const path = join(this.deps.stateDir, SEEN);
      writeFileSync(`${path}.tmp`, JSON.stringify(out));
      renameSync(`${path}.tmp`, path);
    } catch {
      // A cache.
    }
  }

  // ---------------------------------------------------------------------------
  // The backup pull
  // ---------------------------------------------------------------------------

  /** A child answering its parent's pull. Nobody else's: a mirror is the parent's to keep. */
  private answerExport(link: Link, id: unknown): void {
    if (typeof id !== "string" || id.length > 64) return;
    if (link.peer !== this.roster?.parent || this.role() !== "child") {
      link.send({ type: "export", id, mark: "", files: null, error: "only the parent pulls a node's backup" });
      return;
    }
    try {
      const { mark, files } = this.deps.exportFiles();
      const out: Record<string, string> = {};
      for (const [rel, content] of files) out[rel] = Buffer.from(content).toString("base64");
      link.send({ type: "export", id, mark, files: out, error: null });
    } catch (err) {
      link.send({ type: "export", id, mark: "", files: null, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private onExport(message: Extract<LinkMessage, { type: "export" }>): void {
    const pull = this.pulls.get(message.id);
    if (!pull) return;
    this.pulls.delete(message.id);
    clearTimeout(pull.timer);
    if (!message.files || typeof message.files !== "object") {
      pull.reject(new Error(typeof message.error === "string" ? message.error : "the node sent no files"));
      return;
    }
    const files = new Map<string, Buffer>();
    for (const [rel, b64] of Object.entries(message.files)) {
      if (!safeMirrorPath(rel) || typeof b64 !== "string") continue;
      files.set(rel, Buffer.from(b64, "base64"));
    }
    pull.resolve({ mark: typeof message.mark === "string" ? message.mark : "", files });
  }

  private pull(nodeId: string): Promise<{ mark: string; files: Map<string, Buffer> }> {
    const link = this.links.get(nodeId);
    if (!link) return Promise.reject(new Error("not linked"));
    const id = randomBytes(8).toString("hex");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pulls.delete(id);
        reject(new Error("the node did not send its backup in time"));
      }, EXPORT_MS);
      timer.unref();
      this.pulls.set(id, { peer: nodeId, resolve, reject, timer });
      link.send({ type: "export-ask", id });
    });
  }

  /** Whether any linked child's data moved since its last pull: the backup's "anything changed?". */
  mirrorsOwed(): boolean {
    if (this.role() !== "parent") return false;
    return this.statuses().some((n) => n.state === "up" && n.summary !== null && this.pulled.get(n.id) !== n.summary.dataMark);
  }

  /**
   * Each linked child's mirror whose data moved since the last pull, for
   * the parent's backup to write under `nodes/<name>/`. A child that is
   * away keeps the files of its last pull; one that fails says why.
   */
  async mirrors(): Promise<{ pulled: Array<{ name: string; files: Map<string, Buffer> }>; failed: string[] }> {
    const pulled: Array<{ name: string; files: Map<string, Buffer> }> = [];
    const failed: string[] = [];
    if (this.role() !== "parent") return { pulled, failed };
    for (const node of this.statuses()) {
      if (node.state !== "up" || !node.summary || this.pulled.get(node.id) === node.summary.dataMark) continue;
      try {
        const got = await this.pull(node.id);
        pulled.push({ name: node.name, files: got.files });
        this.pulled.set(node.id, got.mark || node.summary.dataMark);
      } catch (err) {
        failed.push(`${node.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { pulled, failed };
  }

  // ---------------------------------------------------------------------------
  // A workspace moved (`move.ts` decides; this carries it)
  // ---------------------------------------------------------------------------

  /**
   * Put a question to a linked peer and wait for its answer, by a fresh id.
   * The answer's own type is the caller's to check; a peer one phase behind
   * says nothing at all, which is the timeout and the sentence with it.
   */
  ask(nodeId: string, build: (id: string) => LinkMessage, timeoutMs: number, silent: string): Promise<LinkMessage> {
    const link = this.links.get(nodeId);
    if (!link) return Promise.reject(new Error(`${this.nameOf(nodeId) ?? "That node"} is not linked right now.`));
    const id = randomBytes(8).toString("hex");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.asks.delete(id);
        reject(new Error(silent));
      }, timeoutMs);
      timer.unref();
      this.asks.set(id, { peer: nodeId, resolve, reject, timer });
      link.send(build(id));
    });
  }

  private onAnswer(link: Link, message: Extract<LinkMessage, { type: "workspace-move-checked" | "workspace-moved" }>): void {
    const ask = typeof message.id === "string" ? this.asks.get(message.id) : undefined;
    // Only from the peer it was put to: an id is not a secret between members, and need not be.
    if (!ask || ask.peer !== link.peer) return;
    this.asks.delete(message.id);
    clearTimeout(ask.timer);
    ask.resolve(message);
  }

  private answerMoveCheck(link: Link, message: Extract<LinkMessage, { type: "workspace-move-check" }>): void {
    if (typeof message.id !== "string" || message.id.length > 64) return;
    const peer = this.nameOf(link.peer!) ?? link.peer!;
    try {
      if (!this.deps.moves) throw new Error("this node takes no workspaces");
      link.send({ type: "workspace-move-checked", id: message.id, check: this.deps.moves.check(peer, message.ask), error: null });
    } catch (err) {
      link.send({ type: "workspace-move-checked", id: message.id, check: null, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async answerMove(link: Link, message: Extract<LinkMessage, { type: "workspace-move" }>): Promise<void> {
    if (typeof message.id !== "string" || message.id.length > 64) return;
    const peer = this.nameOf(link.peer!) ?? link.peer!;
    try {
      if (!this.deps.moves) throw new Error("this node takes no workspaces");
      const done = await this.deps.moves.adopt(peer, message.offer);
      this.deps.log(`nodes: ${done.again ? "answered a repeated move of" : "took"} workspace ${done.name} from ${peer}, ${done.cards} cards`);
      link.send({ type: "workspace-moved", id: message.id, done, error: null });
    } catch (err) {
      const said = err instanceof Error ? err.message : String(err);
      this.deps.log(`nodes: refused a workspace from ${peer}: ${said}`);
      link.send({ type: "workspace-moved", id: message.id, done: null, error: said });
    }
  }

  // ---------------------------------------------------------------------------

  private changed(): void {
    if (!this.closed) this.deps.changed();
  }

  close(): void {
    this.closed = true;
    clearInterval(this.beat);
    if (this.summaryTimer) clearTimeout(this.summaryTimer);
    if (this.seenTimer) clearTimeout(this.seenTimer);
    this.writeSeen();
    for (const dialer of this.dialers.values()) if (dialer.timer) clearTimeout(dialer.timer);
    for (const link of [...this.links.values(), ...this.pending]) {
      try {
        link.ws.close(1001, "server restarting");
      } catch {
        // Gone.
      }
    }
  }
}

/** Enough of a summary's shape to draw it without a throw. */
function validSummary(raw: unknown): raw is NodeSummary {
  if (!raw || typeof raw !== "object") return false;
  const s = raw as Partial<NodeSummary>;
  return (
    typeof s.at === "number" &&
    typeof s.version === "string" &&
    !!s.profile &&
    typeof s.profile.name === "string" &&
    Array.isArray(s.workspaces) &&
    s.workspaces.every((w) => w && typeof w.name === "string" && Array.isArray(w.agents) && Array.isArray(w.needs)) &&
    !!s.needs &&
    typeof s.needs.count === "number" &&
    typeof s.dataMark === "string"
  );
}
