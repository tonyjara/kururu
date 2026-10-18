/**
 * The other nodes' Kurus, as this node's Kuru and drawer meet them.
 *
 * Every node has a Kuru of its own, always on for its own node, and phase
 * 2 already let each see the others' agents in a summary. What this module
 * adds is the rest of *read anywhere, act locally, ask a peer*
 * (`docs/nodes.md`, "Kurus as peers"): a way to ask, a way to read, and one
 * drawer for every conversation.
 *
 * **Why the outbox, and not a tool call on the other side.** A Kuru that
 * wants something done on Omarchy could have been handed Omarchy's MCP
 * verbs over the link, and then there would be two Kurus near Omarchy's
 * agents, each acting on them with nobody to say which had. Instead the
 * request is *words*, typed into Omarchy's Kuru by Omarchy's own outbox the
 * way a Telegram line is — `[kuru@mac] start the build` — so the one Kuru
 * that acts on Omarchy's agents is Omarchy's, it hears the request in its
 * own context, and "delivered" means what it means for every other message:
 * that Kuru's own hook said it took it. The user's `@omarchy …` from the
 * Mac's drawer goes the same way, as `[user@mac]`. Boards are data, not
 * agents, so the board verbs are the exception and act directly — never a
 * run, which starts an agent.
 *
 * **Who hears what.** A child has no speakers, so a reply its Kuru made to
 * what the Mac's user said, or about its own agents, is said on the Mac
 * through the Mac's own voice, hush and missed rules, under a key of the
 * node's own on the missed list (`peerReplySpoken`). The `[kururu]` notices
 * about a node's agents stay on that node: they go to its Kuru and nobody
 * else's, and when its conversation crosses to the others, a notice crosses
 * as its line without the reply it quoted (`peerItems`).
 *
 * **What is held.** The user's words for a node that is away wait on the
 * outbox, which hands them over when the link is back. A Kuru's question
 * does not wait: `ask_kuru` to a node that is away says so, at once, and the
 * Kuru tells the user, which is better than a question answered at three
 * in the morning to nobody. Nothing is pushed into a Kuru when a node comes
 * back; `read_kuru` is on demand.
 *
 * On the restartable side, with nothing near a pty.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { cleanText, peerReplySpoken, peerWords, readPeerMark, type TurnOrigin } from "../../shared/channels";
import { clip } from "../../shared/harness";
import { addressOf, peerItems, PEER_RECENT, type KuruItem, type PeerKuru } from "../../shared/kuru";
import { asBoard, asBoardDone, asKuruTurns, asReplied, asSay, asSayState, isNodeId, type BoardVerb, type NodeStatus, type PeerMessage } from "../../shared/nodes";
import { VOICE_PREFIX } from "../../shared/store";
import type { OutboxEntry, StoredMissed } from "../../shared/voice";
import type { McpResult } from "./mcp";

/** How long `ask_kuru` waits for the other node to say it has the message. A node on the tailnet answers in milliseconds or is not there. */
const TAKEN_MS = 10_000;
/** How long a board verb on another node is waited for. */
const BOARD_MS = 15_000;
/** At most this often, a node's own conversation is pushed to the others: a turn ending moves three things in one breath. */
const PUSH_MIN_MS = 1_000;
/** An ask nobody answered is forgotten after this. */
const ASK_KEEP_MS = 30 * 60_000;
/** Replies heard before their node's next `kuru-turns`, kept so the drawer has them meanwhile. */
const REPLIES_KEEP = 20;
/** Replies said here, remembered so the drawer can say each was heard. A day of them is a few dozen. */
const SAID_KEEP = 500;
const CACHE = "kuru-peers.json";
const CACHE_WRITE_MS = 5_000;

/** The missed list's key for another node's replies: a profile key it cannot be (`isStoreKey` has no colon). */
export function peerKey(nodeId: string): string {
  return `node:${nodeId}`;
}

/** The utterance a reply of another node's is said as here: found again from the item, after a restart too. */
export function utteranceFor(nodeId: string, itemId: string): string {
  return `u-${nodeId}-${itemId}`;
}

/** The node an utterance is another node's reply for, or null for one of this node's own. */
export function nodeOfUtterance(utterance: string): string | null {
  const id = /^u-(n[0-9a-f]{12})-/.exec(utterance)?.[1];
  return id && isNodeId(id) ? id : null;
}

/** What `NodeHost` lends: who the members are and a way to say something to one. */
export interface PeerNodes {
  name(): string;
  nameOf(nodeId: string): string | null;
  byName(name: string): NodeStatus | null;
  statuses(): NodeStatus[];
  linked(nodeId: string): boolean;
  linkedIds(): string[];
  send(nodeId: string, message: PeerMessage): boolean;
}

export interface PeerKurusDeps {
  nodes: PeerNodes;
  /** The profile whose Kuru is this node's to the others — the one Telegram is pointed at, else the active one — by key. */
  kuruKey: () => string | null;
  /** That profile's conversation, merged (`Kuru.items`), for the others' drawers. */
  items: () => readonly KuruItem[];
  /** This node's outbox: where another node's words go in, and where the ones this node relays report back. */
  outbox: {
    fromPeer(profileKey: string, id: string, at: number, text: string): OutboxEntry;
    peerState(id: string, report: { state: OutboxEntry["state"]; note: string | null; typedAt: number | null }): void;
    all(): readonly OutboxEntry[];
  };
  /** Say another node's reply aloud here, as `utterance`, under its own key; null when replies are muted. */
  speak: (key: string, text: string, utterance: string) => string | null;
  missed: (key: string) => readonly StoredMissed[];
  /** One of `BOARD_VERBS` on this node's Kuru profile, for another node's Kuru (`Harness.peerBoard`). */
  board: (verb: BoardVerb, args: Record<string, unknown>, from: string) => Promise<McpResult>;
  /** The drawer's message moved. */
  changed: () => void;
  stateDir: string;
  log: (line: string) => void;
}

interface Conversation {
  items: KuruItem[];
  /** Replies heard over `kuru-replied` that its next `kuru-turns` has not brought yet. */
  replies: KuruItem[];
}

interface Ask {
  nodeId: string;
  state: OutboxEntry["state"] | null;
  reply: string | null;
  taken: (() => void)[];
  answered: (() => void)[];
  at: number;
}

export class PeerKurus {
  private readonly convos = new Map<string, Conversation>();
  private readonly asks = new Map<string, Ask>();
  private readonly boards = new Map<string, { resolve: (result: McpResult) => void; timer: ReturnType<typeof setTimeout> }>();
  /** The state each message from another node was last reported back as, so a report is sent once per move. */
  private readonly reported = new Map<string, string>();
  /**
   * Which node each message from another node came from, by id. The mark
   * says so too and survives a restart, but a slash command goes in bare
   * (`peerWords`), and its state is still owed to whoever sent it.
   */
  private readonly origins = new Map<string, string>();
  private readonly said = new Set<string>();
  private lastPush = "";
  private lastPushAt = 0;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private cacheTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: PeerKurusDeps) {
    this.loadCache();
  }

  // ---------------------------------------------------------------------------
  // The link
  // ---------------------------------------------------------------------------

  /** A message from a member, its link already past the handshake. */
  message(nodeId: string, message: PeerMessage): void {
    const from = this.deps.nodes.nameOf(nodeId);
    if (!from) return;
    switch (message.type) {
      case "say": {
        const say = asSay(message);
        const key = this.deps.kuruKey();
        if (!say || !key) return;
        // The mark is this node's to write, from the link's own peer: one
        // off the wire would be a node saying it is another.
        const words = cleanText(say.spoken ? `${VOICE_PREFIX} ${say.text}` : say.text);
        if (!words) return;
        this.origins.set(say.id, nodeId);
        const entry = this.deps.outbox.fromPeer(key, say.id, say.at, peerWords(from, say.who, words));
        this.report(nodeId, entry, true);
        return;
      }
      case "say-state": {
        const state = asSayState(message);
        if (!state) return;
        const ask = this.asks.get(state.id);
        if (ask) {
          if (ask.nodeId !== nodeId) return;
          ask.state = state.state;
          for (const done of ask.taken.splice(0)) done();
          return;
        }
        this.deps.outbox.peerState(state.id, state);
        return;
      }
      case "kuru-turns": {
        const items = asKuruTurns(message);
        if (!items) return;
        const convo = this.convo(nodeId);
        convo.items = items;
        const ids = new Set(items.map((item) => item.id));
        convo.replies = convo.replies.filter((reply) => !ids.has(reply.id));
        this.queueCache();
        this.deps.changed();
        return;
      }
      case "kuru-replied": {
        const replied = asReplied(message);
        if (replied) this.heard(nodeId, replied.item, replied.origin, replied.answers);
        return;
      }
      case "board": {
        const board = asBoard(message);
        if (!board) return;
        void this.deps
          .board(board.verb, board.args, from)
          .catch((err: unknown): McpResult => ({ text: err instanceof Error ? err.message : String(err), isError: true }))
          .then((result) => this.deps.nodes.send(nodeId, { type: "board-done", id: board.id, text: result.text, error: result.isError === true }));
        return;
      }
      case "board-done": {
        const done = asBoardDone(message);
        const waiting = done ? this.boards.get(done.id) : undefined;
        if (!done || !waiting) return;
        this.boards.delete(done.id);
        clearTimeout(waiting.timer);
        waiting.resolve({ text: done.text, ...(done.error ? { isError: true } : {}) });
        return;
      }
    }
  }

  /**
   * A link came up. The other side hears this node's conversation at once
   * rather than on its next change, and where each of its messages here
   * has got to, since a report sent while the link was down went nowhere.
   */
  linked(nodeId: string): void {
    this.deps.nodes.send(nodeId, { type: "kuru-turns", items: peerItems(this.deps.items()) });
    for (const id of [...this.reported.keys()]) this.reported.delete(id);
    this.outboxMoved(this.deps.outbox.all());
  }

  /** This node's own conversation moved: the others hear of it, coalesced, and only if it changed. */
  conversationMoved(): void {
    if (this.pushTimer) return;
    const wait = Math.max(0, this.lastPushAt + PUSH_MIN_MS - Date.now());
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      this.push();
    }, wait);
    this.pushTimer.unref();
  }

  private push(): void {
    const linked = this.deps.nodes.linkedIds();
    if (!linked.length) return;
    this.lastPushAt = Date.now();
    const items = peerItems(this.deps.items());
    const key = JSON.stringify(items);
    if (key === this.lastPush) return;
    this.lastPush = key;
    for (const nodeId of linked) this.deps.nodes.send(nodeId, { type: "kuru-turns", items });
  }

  /**
   * The outbox moved: every message another node handed it is reported
   * back to that node when its state did. Which node is read off the mark
   * the message was typed behind, so a restart in between loses nothing.
   */
  outboxMoved(entries: readonly OutboxEntry[]): void {
    for (const entry of entries) {
      const mark = entry.text ? readPeerMark(entry.text) : null;
      const nodeId = this.origins.get(entry.id) ?? (mark ? this.deps.nodes.byName(mark.node)?.id : undefined);
      if (nodeId) this.report(nodeId, entry, false);
    }
    const ids = new Set(entries.map((entry) => entry.id));
    for (const id of [...this.origins.keys()]) if (!ids.has(id)) this.origins.delete(id);
  }

  private report(nodeId: string, entry: OutboxEntry, always: boolean): void {
    const said = `${entry.state}|${entry.typedAt ?? ""}|${entry.note ?? ""}`;
    if (!always && this.reported.get(entry.id) === said) return;
    if (this.deps.nodes.send(nodeId, { type: "say-state", id: entry.id, state: entry.state, note: entry.note, typedAt: entry.typedAt })) this.reported.set(entry.id, said);
  }

  /**
   * This node's Kuru ended a turn: every linked node hears the reply, with
   * what it answered, so each can say whether its user should hear it and
   * which of its questions it answers.
   */
  replied(item: { id: string; at: number; text: string }, origin: TurnOrigin, answers: string[]): void {
    if (!item.text.trim()) return;
    for (const nodeId of this.deps.nodes.linkedIds()) this.deps.nodes.send(nodeId, { type: "kuru-replied", item, origin, answers });
  }

  /** Another node's Kuru replied: into its conversation here, said aloud by the rule, and the answer to any question of ours it answered. */
  private heard(nodeId: string, item: { id: string; at: number; text: string }, origin: TurnOrigin, answers: string[]): void {
    const convo = this.convo(nodeId);
    if (!convo.items.some((known) => known.id === item.id) && !convo.replies.some((known) => known.id === item.id)) {
      convo.replies = [...convo.replies, { kind: "kuru" as const, id: item.id, at: item.at, text: item.text, utterance: null, fate: null, aside: false }].slice(-REPLIES_KEEP);
    }
    if (peerReplySpoken(origin, this.deps.nodes.name())) {
      const utterance = utteranceFor(nodeId, item.id);
      if (this.deps.speak(peerKey(nodeId), item.text, utterance)) {
        this.said.add(utterance);
        if (this.said.size > SAID_KEEP) this.said.delete(this.said.values().next().value!);
      }
    }
    for (const id of answers) {
      const ask = this.asks.get(id);
      if (!ask || ask.nodeId !== nodeId) continue;
      ask.reply = item.text;
      for (const done of ask.answered.splice(0)) done();
    }
    this.deps.changed();
  }

  // ---------------------------------------------------------------------------
  // The drawer
  // ---------------------------------------------------------------------------

  /**
   * Every other node's Kuru, for the drawer: its last items, with each reply
   * that was said here carrying this node's utterance and fate, and the
   * replies nobody heard out that no item it sent still holds.
   */
  peers(): PeerKuru[] {
    return this.deps.nodes.statuses().map((node): PeerKuru => {
      const convo = this.convos.get(node.id) ?? { items: [], replies: [] };
      const missed = new Map(this.deps.missed(peerKey(node.id)).map((entry) => [entry.id, entry] as const));
      const shown = new Set<string>();
      const items = [...convo.items, ...convo.replies].map((item): KuruItem => {
        if (item.kind !== "kuru") return item;
        const utterance = utteranceFor(node.id, item.id);
        const entry = missed.get(utterance);
        if (!entry && !this.said.has(utterance)) return item;
        shown.add(utterance);
        return { ...item, utterance, fate: entry ? (entry.pending ? "speaking" : "unheard") : "heard" };
      });
      for (const entry of missed.values()) {
        if (!shown.has(entry.id)) items.push({ kind: "kuru", id: `m${entry.id}`, at: entry.at, text: entry.text, utterance: entry.id, fate: entry.pending ? "speaking" : "unheard", aside: false });
      }
      return {
        node: { id: node.id, name: node.name },
        state: node.state,
        lastSeen: node.lastSeen,
        items: items.sort((a, b) => a.at - b.at).slice(-PEER_RECENT * 2),
        unheard: [...missed.values()].filter((entry) => !entry.pending).length,
        talks: !node.summary || (node.summary.talks ?? 0) >= 1,
      };
    });
  }

  /**
   * Whether words of the user's are for another node's Kuru, by the
   * drawer's grammar (`addressOf`) over the members' names. A node that
   * cannot take them still gets them addressed, so the reason is said on
   * the message rather than the words going to this Kuru with an `@` in.
   */
  addressed(text: string, spoken: boolean): { nodeId: string; name: string; rest: string } | null {
    const nodes = this.deps.nodes.statuses();
    const found = addressOf(text, nodes.map((n) => n.name), spoken);
    const node = found ? nodes.find((n) => n.name === found.node) : undefined;
    return found && node ? { nodeId: node.id, name: node.name, rest: found.rest } : null;
  }

  /** The user's words, relayed. Null when they went; the sentence that says why not, when they did not. */
  relay(nodeId: string, words: { id: string; at: number; text: string; spoken: boolean }): string | null {
    const node = this.deps.nodes.statuses().find((n) => n.id === nodeId);
    if (!node) return "that node is not in the roster any more";
    if (node.summary && (node.summary.talks ?? 0) < 1) return `the kururu on ${node.name} is too old to take messages for its Kuru; update it (kururu child update)`;
    const sent = this.deps.nodes.send(nodeId, { type: "say", id: words.id, at: words.at, text: words.text, who: "user", spoken: words.spoken });
    return sent ? null : `${node.name} is away; this goes to the Kuru there when it is back`;
  }

  // ---------------------------------------------------------------------------
  // The harness's tools
  // ---------------------------------------------------------------------------

  /** The node a Kuru named, linked and able to take a Kuru's messages, or the sentence that says why not. */
  private reachable(name: string): NodeStatus | string {
    const node = this.deps.nodes.byName(name);
    if (!node) return `No node "${name}". kururu_status lists them under nodes.`;
    if (node.summary && (node.summary.talks ?? 0) < 1) return `The kururu on ${node.name} is too old to take messages for its Kuru. Tell the user it wants an update there (kururu child update).`;
    if (!this.deps.nodes.linked(node.id)) {
      const since = node.since ? ` since ${clock(node.since)}` : "";
      return `${node.name} is away${since}, so nothing was sent. Tell the user; ask again once it is back.`;
    }
    return node;
  }

  /** `ask_kuru`: the words into that node's Kuru, and — with `wait` — its reply. */
  async ask(name: string, message: string, wait: boolean, timeoutS: number): Promise<McpResult> {
    const node = this.reachable(name);
    if (typeof node === "string") return fail(node);
    const id = `ask-${randomBytes(8).toString("hex")}`;
    const ask: Ask = { nodeId: node.id, state: null, reply: null, taken: [], answered: [], at: Date.now() };
    this.asks.set(id, ask);
    this.sweepAsks();
    const text = message.slice(0, 20_000);
    if (!this.deps.nodes.send(node.id, { type: "say", id, at: Date.now(), text, who: "kuru", spoken: false })) {
      this.asks.delete(id);
      return fail(`${node.name} went away just now, so nothing was sent. Tell the user; ask again once it is back.`);
    }
    await until(ask, "taken", TAKEN_MS, () => ask.state !== null);
    if (ask.state === null) return ok(`Sent to the Kuru on ${node.name}, which has not said it got it yet. Its reply, when there is one, is in its drawer; read_kuru reads it.`);
    if (ask.state === "failed") return fail(`The Kuru on ${node.name} could not take it: its outbox gave up. Tell the user.`);
    if (!wait) {
      return ok(
        `The Kuru on ${node.name} has it${ask.state === "delivered" ? "" : ", and takes it the moment it is between turns"}. Its reply goes to its drawer, where the user sees it; read_kuru reads it, or ask with wait=true when you need the answer to go on.`,
      );
    }
    await until(ask, "answered", timeoutS * 1000, () => ask.reply !== null);
    if (ask.reply === null) return ok(`No reply from the Kuru on ${node.name} in ${timeoutS}s; it may still be working on it. read_kuru shows what it says later.`);
    this.asks.delete(id);
    return ok(`The Kuru on ${node.name} answered:\n${clip(ask.reply, 8000)}`);
  }

  /** `read_kuru`: what a node last said about its conversation, newest last, which works while it is away too. */
  read(name: string, turns: number): McpResult {
    const node = this.deps.nodes.byName(name);
    if (!node) return fail(`No node "${name}". kururu_status lists them under nodes.`);
    const convo = this.convos.get(node.id);
    const items = [...(convo?.items ?? []), ...(convo?.replies ?? [])].sort((a, b) => a.at - b.at).slice(-turns);
    const state = node.state === "up" ? "linked" : `away${node.since ? ` since ${clock(node.since)}` : ""}; this is what it last sent`;
    if (!items.length) return ok(`Nothing from the Kuru on ${node.name} yet (${state}).`);
    const lines = items.map((item) => `- ${stamp(item.at)} ${itemLine(item)}`);
    return ok(clip([`The Kuru on ${node.name} (${state}), newest last:`, ...lines].join("\n")));
  }

  /** A board verb on another node's boards, and the line that came of it there. */
  async board(name: string, verb: BoardVerb, args: Record<string, unknown>): Promise<McpResult> {
    const node = this.reachable(name);
    if (typeof node === "string") return fail(node);
    const id = `brd-${randomBytes(8).toString("hex")}`;
    const result = await new Promise<McpResult>((resolve) => {
      const timer = setTimeout(() => {
        this.boards.delete(id);
        resolve(fail(`${node.name} did not answer in ${BOARD_MS / 1000}s.`));
      }, BOARD_MS);
      timer.unref();
      this.boards.set(id, { resolve, timer });
      if (!this.deps.nodes.send(node.id, { type: "board", id, verb, args })) {
        clearTimeout(timer);
        this.boards.delete(id);
        resolve(fail(`${node.name} went away just now.`));
      }
    });
    return { ...result, text: `On ${node.name}: ${result.text}` };
  }

  // ---------------------------------------------------------------------------

  private convo(nodeId: string): Conversation {
    let convo = this.convos.get(nodeId);
    if (!convo) this.convos.set(nodeId, (convo = { items: [], replies: [] }));
    return convo;
  }

  private sweepAsks(): void {
    const now = Date.now();
    for (const [id, ask] of this.asks) if (now - ask.at > ASK_KEEP_MS) this.asks.delete(id);
  }

  /** The last conversation each node sent, kept across a restart, so a node that is away still shows its last turns. A cache: the next push replaces it. */
  private loadCache(): void {
    try {
      const raw = JSON.parse(readFileSync(join(this.deps.stateDir, CACHE), "utf8")) as Record<string, unknown>;
      for (const [nodeId, items] of Object.entries(raw)) {
        if (!isNodeId(nodeId)) continue;
        const ok = asKuruTurns({ type: "kuru-turns", items: items as KuruItem[] });
        if (ok) this.convos.set(nodeId, { items: ok, replies: [] });
      }
    } catch {
      // Nothing yet.
    }
  }

  private queueCache(): void {
    if (this.cacheTimer) return;
    this.cacheTimer = setTimeout(() => {
      this.cacheTimer = null;
      this.writeCache();
    }, CACHE_WRITE_MS);
    this.cacheTimer.unref();
  }

  private writeCache(): void {
    const out: Record<string, KuruItem[]> = {};
    for (const [nodeId, convo] of this.convos) out[nodeId] = convo.items;
    try {
      mkdirSync(this.deps.stateDir, { recursive: true });
      const path = join(this.deps.stateDir, CACHE);
      writeFileSync(`${path}.tmp`, JSON.stringify(out));
      renameSync(`${path}.tmp`, path);
    } catch {
      // A cache.
    }
  }

  close(): void {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    if (this.cacheTimer) {
      clearTimeout(this.cacheTimer);
      this.writeCache();
    }
    for (const waiting of this.boards.values()) clearTimeout(waiting.timer);
  }
}

/** Wait for an ask's event, or the time, whichever is first. */
function until(ask: Ask, event: "taken" | "answered", ms: number, already: () => boolean): Promise<void> {
  if (already()) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
    ask[event].push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** One item of another Kuru's conversation as a line for `read_kuru`. */
function itemLine(item: KuruItem): string {
  switch (item.kind) {
    case "you": {
      const where = item.through ? ` (through ${item.through})` : item.via === "voice" ? " (spoken)" : item.via !== "typed" ? ` (on ${item.via})` : "";
      return `the user${where}: ${item.text ?? "(not in words yet)"}${item.state === "delivered" ? "" : ` [${item.state}]`}`;
    }
    case "kuru":
      return `Kuru: ${item.text}`;
    case "notice": {
      const agent = item.agent ? `${item.agent.name ? `"${item.agent.name}"` : item.agent.program}${item.agent.workspace ? ` in ${item.agent.workspace}` : ""} ` : "";
      return `${item.from}: ${agent}${item.what}${item.from.startsWith("Kuru on ") && item.text ? ` — ${item.text}` : ""}`;
    }
    case "session":
      return "(a new conversation began)";
  }
}

function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function stamp(at: number): string {
  const d = new Date(at);
  return `${d.toISOString().slice(5, 10)} ${clock(at)}`;
}

function ok(text: string): McpResult {
  return { text };
}

function fail(text: string): McpResult {
  return { text, isError: true };
}
