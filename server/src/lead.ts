/**
 * One Telegram among the nodes: which node polls the bot, how the poll
 * moves between them, and the chat's words crossing the links.
 *
 * The bot is one bot. Each node could have had a bot of its own, and then
 * the user would have a chat per machine and would have to know which
 * machine to write to — the opposite of a phone that reaches Kuru. So the
 * chat is one, and Telegram's rule makes the rest of the shape: one reader
 * holds `getUpdates` at a time, and a second is answered 409. One node
 * polls — the leader, by rank among those that can (`LeadGate`) — and the
 * others reach the chat through it: their Kuru's lines are handed to it to
 * post, and what the chat says to them is handed from it to their outbox.
 *
 * **Why the poll moves, and why slowly.** The Mac is the leader while it is
 * awake, because that is where the user mostly is. When its lid closes the
 * child takes the poll after thirty seconds of silence, so a server restart
 * under `bun run dev` never moves it; when the Mac comes back it waits a
 * minute of steady link before asking for it, so a Mac that Power Nap wakes
 * for seconds does not take the poll and sleep with it; and a holder in the
 * middle of a conversation says busy, so a question and its follow-up are
 * not answered by two Kurus. The handshake hands everything the holder knew
 * — offset, queue, held messages, reply map, handled ids — before the new
 * holder polls, so nothing is read twice or lost between them.
 *
 * **Why not a vote.** Two nodes that both believe they lead are a split
 * tailnet, and Telegram's 409 already says so to both; rank decides who
 * backs off (`LeadGate.conflict`). No node needs to agree with another
 * about anything but the roster, which the parent signs, and the switch.
 *
 * **The switch from any node.** The channel is turned on and off from
 * whichever node's Settings the user has in front of them — the box's,
 * from a phone, while the Mac is shut. A flip is signed with that node's
 * own key and handed to every node it can reach, which hand it on; each
 * goes by the latest word, and the parent writes it into the next roster
 * when it hears it (`TelegramSwitch` in `shared/channels.ts` argues it).
 * Eligibility is the switch as this node has it, so a node that hears
 * "off" stops polling there and then, and the rule above still makes one
 * poller of whoever is left.
 *
 * On the restartable side, with nothing near a pty.
 */
import { randomBytes } from "node:crypto";

import { asTelegramSwitch, backLine, nodeSubject, switchPayload, switchTime, tookLine, type LeadStatus, type TelegramSwitch } from "../../shared/channels";
import { asLeadState, asTelegramIn, asTelegramOut, LeadGate, type LeadInput, type LeadPeer, type LinkMessage, type NodeStatus, type Sign, type Verify } from "../../shared/nodes";
import { signAsNode, verifySigned } from "./nodekeys";
import type { NodeHost } from "./nodes";
import type { TelegramChannel, TelegramShare } from "./telegram";

/** How often the rule is looked at again, beside every change that could move it. */
const BEAT_MS = 5_000;

type Nodes = Pick<
  NodeHost,
  | "selfId"
  | "role"
  | "parentId"
  | "name"
  | "member"
  | "members"
  | "ownRank"
  | "statuses"
  | "summaryOf"
  | "liveSummaryOf"
  | "linked"
  | "linkedIds"
  | "nameOf"
  | "send"
  | "on"
  | "onLinkUp"
  | "onLinkDown"
  | "onUnpair"
  | "rosterTelegram"
>;

export interface LeadDeps {
  nodes: Nodes;
  telegram: TelegramChannel;
  /** Whether this node may poll for the others, and why not: the switch, the token, a Claude login. */
  eligible: () => { eligible: boolean; why: string | null };
  /** This node has a bot of its own, not one lent by the parent: its channel stays its own. */
  ownBot: () => boolean;
  /** The chat's words for this node's Kuru, into its outbox; false when there is no Kuru to give them to. */
  say: (id: string, at: number, text: string) => boolean;
  /** What this node says about itself — its summary — may have moved. */
  changed: () => void;
  /** The switch moved on the parent's own file, by a flip made here or heard: the roster again. */
  switched?: () => void;
  log: (line: string) => void;
  /** For tests: this node's key, and the check of another's. */
  sign?: Sign;
  verify?: Verify;
  /** For tests: the clock the rule's times are read off. */
  now?: () => number;
}

export class TelegramLead {
  private readonly gate: LeadGate;
  /**
   * The asks this node sent, by id, to the node each went to: an answer is
   * taken only for one of them, and a late one — after this node took the
   * poll because the holder stopped — is still taken, so what it handed is
   * not left waiting for an acknowledgement.
   */
  private readonly asks = new Map<string, string>();
  /** The handover this node made and has not had acknowledged. */
  private handing: { id: string; peer: string } | null = null;
  /**
   * The next poll this node starts is the one it held before its server
   * restarted: carried on, not taken over, so the chat is told nothing.
   */
  private carryingOn: boolean;
  /** The busy answer last logged, so a holder asked every thirty seconds is one line, not twenty. */
  private lastBusy = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly beat: ReturnType<typeof setInterval>;
  private closed = false;

  private readonly now: () => number;

  constructor(private readonly deps: LeadDeps) {
    const { nodes, telegram } = deps;
    this.now = deps.now ?? Date.now;
    this.gate = new LeadGate(this.now(), telegram.resumes);
    this.carryingOn = telegram.resumes;
    telegram.connect({
      deliver: (held) => nodes.linked(held.node) && nodes.send(held.node, { type: "telegram-in", id: held.id, at: held.at, text: held.text }),
      away: (nodeId) => {
        const status = nodes.statuses().find((n) => n.id === nodeId);
        return { name: nodes.nameOf(nodeId) ?? "that node", since: status ? (status.state === "up" ? null : (status.lastSeen ?? status.since)) : null };
      },
      relay: (line) => {
        const holder = this.holder();
        return holder !== null && holder !== nodes.selfId() && nodes.send(holder, { type: "telegram-out", ...line });
      },
      conflict: () => this.conflict(),
      woke: () => {
        this.gate.woke(this.now());
        deps.log("lead: this node was asleep while it held the Telegram poll; it stopped, and looks again once its links are back");
        this.deps.changed();
        this.evaluate();
      },
      hurry: () => {
        this.gate.hurry(this.now());
        this.evaluate();
      },
      status: () => this.status(),
    });

    nodes.on("lead-ask", (peer, message) => this.onAsk(peer, message));
    nodes.on("lead-busy", (peer, message) => {
      if (message.type !== "lead-busy" || this.asks.get(message.id) !== peer) return;
      this.asks.delete(message.id);
      this.gate.busy(peer, this.now());
      const why = typeof message.why === "string" ? message.why.slice(0, 200) : "busy";
      if (why !== this.lastBusy) deps.log(`lead: ${this.name(peer)} is busy (${why}); asking again in a little while`);
      this.lastBusy = why;
      this.schedule(null);
    });
    nodes.on("lead-state", (peer, message) => this.onState(peer, message));
    nodes.on("lead-ack", (peer, message) => {
      if (message.type !== "lead-ack" || !this.handing || this.handing.id !== message.id || this.handing.peer !== peer) return;
      this.handing = null;
      telegram.handedOver();
    });
    nodes.on("telegram-in", (peer, message) => {
      const words = asTelegramIn(message);
      if (words && deps.say(words.id, words.at, words.text)) nodes.send(peer, { type: "telegram-in-ack", id: words.id });
    });
    nodes.on("telegram-in-ack", (peer, message) => {
      if (message.type === "telegram-in-ack" && typeof message.id === "string") telegram.heldDone(message.id, peer);
    });
    nodes.on("telegram-out", (peer, message) => {
      const line = asTelegramOut(message);
      if (line && telegram.fromNode(peer, { id: line.id, at: line.at, text: line.text, silent: line.silent, notice: line.notice })) nodes.send(peer, { type: "telegram-out-ack", id: line.id });
    });
    nodes.on("telegram-out-ack", (_peer, message) => {
      if (message.type === "telegram-out-ack" && typeof message.id === "string") telegram.relayed(message.id);
    });
    nodes.on("telegram-switch", (peer, message) => {
      if (message.type === "telegram-switch") this.heard(peer, message.switch);
    });

    nodes.onLinkUp((peer) => {
      telegram.deliverHeld(peer);
      // A flip made while this peer was away — the Mac shut — reaches it now.
      const pending = telegram.pendingSwitch();
      if (pending) nodes.send(peer, { type: "telegram-switch", switch: pending });
      this.evaluate();
    });
    nodes.onLinkDown((peer) => {
      // A handover whose acknowledgement never came: the queue is this
      // node's again. If the other side did take it, the worst is a line
      // posted twice, should this node take the poll back before it went.
      if (this.handing?.peer === peer) {
        this.handing = null;
        telegram.takeBack();
      }
      for (const [id, to] of this.asks) if (to === peer) this.asks.delete(id);
      this.evaluate();
    });
    nodes.onUnpair(() => this.evaluate());
    this.beat = setInterval(() => this.evaluate(), BEAT_MS);
    this.beat.unref();
  }

  /**
   * The node that polls, as far as this node knows: itself, or a linked
   * member whose summary says it does. Read off the summaries alone, since
   * `NodeHost.leader` asks this and its statuses ask the leader.
   */
  holder(): string | null {
    if (!this.deps.telegram.isShared) return null;
    if (this.deps.telegram.polling) return this.deps.nodes.selfId();
    return this.deps.nodes.linkedIds().find((id) => this.deps.nodes.liveSummaryOf(id)?.lead?.polls === true) ?? null;
  }

  /** The roster as the channel needs it, or null when the channel is this node's alone. */
  private share(): TelegramShare | null {
    const { nodes } = this.deps;
    const role = nodes.role();
    const parent = nodes.parentId();
    if (role === "alone" || !parent) return null;
    const settings = nodes.rosterTelegram();
    if (!settings) return null;
    // A child that was given a bot of its own keeps it, and its chat, as it
    // was before there were nodes; it is not one of the shared bot's.
    if (role === "child" && this.deps.ownBot()) return null;
    return {
      self: nodes.selfId(),
      parent,
      nodes: nodes.members().map((m) => ({ id: m.id, name: m.name })),
      settings: role === "parent" ? null : settings,
    };
  }

  private input(): LeadInput {
    return {
      rank: this.deps.nodes.ownRank() ?? 1,
      eligible: this.deps.eligible().eligible,
      polling: this.deps.telegram.polling,
      peers: this.deps.nodes.statuses().map((s) => leadPeer(s, this.deps.nodes.liveSummaryOf(s.id))),
    };
  }

  /** Look at the rule again and do what it says. Called on every change that could move it, and every few seconds. */
  evaluate(): void {
    if (this.closed) return;
    const { telegram, nodes } = this.deps;
    // A freeze the tick has not caught yet is caught now, before anything is decided on it.
    telegram.noticeSleep();
    const wasPolling = telegram.polling;
    telegram.share(this.share());
    if (!telegram.isShared) {
      this.schedule(null);
      if (wasPolling) this.deps.changed();
      return;
    }
    const now = this.now();
    const input = this.input();
    const { step, wait } = this.gate.next(input, now);
    switch (step.do) {
      case "poll":
        if (!telegram.polling) {
          telegram.lead(true, this.carryingOn ? null : this.takeoverLine(input));
          this.gate.took();
          this.deps.log(`lead: this node polls Telegram for the others ${this.carryingOn ? "again, as it did before its restart" : "now"}`);
        }
        this.carryingOn = false;
        break;
      case "stop":
        this.carryingOn = false;
        if (telegram.polling) {
          telegram.lead(false);
          this.deps.log(`lead: this node stopped polling Telegram (${step.why})`);
        }
        break;
      case "ask": {
        const id = randomBytes(8).toString("hex");
        if (nodes.send(step.peer, { type: "lead-ask", id, force: step.force })) {
          this.asks.set(id, step.peer);
          if (this.asks.size > 20) this.asks.delete(this.asks.keys().next().value!);
          this.gate.asked(step.peer, now);
          if (!this.lastBusy) this.deps.log(`lead: asked ${this.name(step.peer)} to hand the Telegram poll back${step.force ? ", whether or not it is busy" : ""}`);
        }
        break;
      }
    }
    if (telegram.polling !== wasPolling) this.deps.changed();
    telegram.flushRelay();
    this.schedule(wait);
  }

  /**
   * The line the chat gets when this node takes the poll because those
   * above it went away: one line, naming them and since when. A node that
   * takes it with nobody above it gone — the Mac starting — says nothing.
   */
  private takeoverLine(input: LeadInput): string | null {
    const away = input.peers.filter((p) => p.rank < input.rank && !p.up && p.eligible !== false);
    if (!away.length) return null;
    return tookLine(
      this.name(this.deps.nodes.selfId()),
      away.map((p) => ({ name: this.name(p.id), since: p.since })),
    );
  }

  /** A node above asks for the poll. Handed over unless this node is mid-conversation and the ask is not forced. */
  private onAsk(peer: string, message: LinkMessage): void {
    if (message.type !== "lead-ask" || typeof message.id !== "string" || message.id.length > 64) return;
    const { telegram, nodes } = this.deps;
    if (!telegram.polling) {
      nodes.send(peer, { type: "lead-state", id: message.id, state: null });
      return;
    }
    const mine = nodes.ownRank() ?? Infinity;
    const theirs = nodes.members().find((m) => m.id === peer)?.rank ?? Infinity;
    if (theirs >= mine) {
      nodes.send(peer, { type: "lead-busy", id: message.id, why: "that node ranks below this one, which polls" });
      return;
    }
    const busy = message.force === true ? null : telegram.busyReason();
    if (busy) {
      nodes.send(peer, { type: "lead-busy", id: message.id, why: busy });
      return;
    }
    const state = telegram.handOver();
    this.handing = { id: message.id, peer };
    nodes.send(peer, { type: "lead-state", id: message.id, state });
    this.deps.log(`lead: handed the Telegram poll to ${this.name(peer)}`);
    this.deps.changed();
  }

  /** The holder's answer to this node's ask: its state, or nothing because it was not polling. Either way the poll is this node's. */
  private onState(peer: string, message: LinkMessage): void {
    if (message.type !== "lead-state" || this.asks.get(message.id) !== peer) return;
    this.asks.delete(message.id);
    this.lastBusy = "";
    const state = message.state === null ? null : asLeadState(message.state);
    if (message.state !== null && !state) {
      this.deps.log(`lead: ${this.name(peer)} handed over a state this node could not read; asking again`);
      return;
    }
    const { telegram, nodes } = this.deps;
    nodes.send(peer, { type: "lead-ack", id: message.id });
    if (state) {
      telegram.adopt(state);
      // What the last holder kept for a node that is linked now goes to it.
      for (const id of nodes.linkedIds()) telegram.deliverHeld(id);
    }
    if (telegram.polling) return;
    this.gate.took();
    telegram.lead(true, state ? backLine(this.name(nodes.selfId())) : null);
    this.deps.log(`lead: took the Telegram poll back from ${this.name(peer)}`);
    this.deps.changed();
    this.evaluate();
  }

  /** Telegram said 409: rank says whether this node stands down for five minutes or retries in thirty seconds. */
  private conflict(): void {
    const side = this.gate.conflict(this.input(), this.now());
    this.deps.log(
      side === "lower"
        ? "lead: Telegram said 409 — another node polls this bot too; this one ranks lower and stands down for five minutes"
        : "lead: Telegram said 409 — another node polls this bot too; this one ranks highest and tries again in thirty seconds",
    );
    this.evaluate();
  }

  /**
   * Turn the shared channel on or off from this node: a flip, signed here,
   * taken here and handed to every node this one can reach. Throws the
   * sentence the page prints when it cannot be — the same one `status`
   * gives it beforehand.
   */
  flip(enabled: boolean): void {
    const { telegram, nodes } = this.deps;
    const refusal = this.refusal(enabled);
    if (refusal) throw new Error(refusal);
    if (telegram.switchedOn === enabled) return;
    const self = nodes.selfId();
    const unsigned = { enabled, at: switchTime(Date.now(), telegram.switchWord()?.at ?? null), by: self, told: telegram.hasToken };
    const change: TelegramSwitch = { ...unsigned, sig: (this.deps.sign ?? signAsNode)(switchPayload(unsigned)) };
    telegram.takeSwitch(change);
    this.deps.log(`lead: the Telegram channel was switched ${enabled ? "on" : "off"} here`);
    this.spread(change, null);
    this.afterSwitch();
  }

  /**
   * Another node's flip, from the peer that handed it on. Checked against
   * the roster's key for the node that made it — not the peer's, since a
   * flip crosses the mesh by any road — and taken only when it is the later
   * word, which is also what stops it going round for ever.
   */
  private heard(peer: string, raw: unknown): void {
    const change = asTelegramSwitch(raw);
    const maker = change ? this.deps.nodes.member(change.by) : undefined;
    if (!change || !maker) return;
    const { sig, ...unsigned } = change;
    if (!(this.deps.verify ?? verifySigned)(switchPayload(unsigned), sig, maker.keys.sign)) {
      this.deps.log(`lead: a Telegram switch said to be ${maker.name}'s, from ${this.name(peer)}, is not signed by it; ignored`);
      return;
    }
    if (!this.deps.telegram.takeSwitch(change)) return;
    this.deps.log(`lead: the Telegram channel was switched ${change.enabled ? "on" : "off"} on ${maker.name}`);
    this.spread(change, peer);
    this.afterSwitch();
  }

  private spread(change: TelegramSwitch, from: string | null): void {
    for (const id of this.deps.nodes.linkedIds()) if (id !== from) this.deps.nodes.send(id, { type: "telegram-switch", switch: change });
  }

  private afterSwitch(): void {
    if (this.deps.nodes.role() === "parent") this.deps.switched?.();
    this.deps.changed();
    this.evaluate();
  }

  /**
   * Why the switch cannot be turned on — or off — from this node, or null.
   * Off is always this node's to say, since it is the safe way to be wrong;
   * on wants somebody on the list and a token here, because the node the
   * user is standing at is often the only one awake to read the chat.
   */
  private refusal(enabled: boolean): string | null {
    const { telegram, nodes } = this.deps;
    if (!telegram.isShared) return null;
    const parentId = nodes.parentId();
    const parent = nodeSubject((parentId && nodes.nameOf(parentId)) || "the parent");
    const child = nodes.role() === "child";
    if (!telegram.switchable) return `${parent[0]!.toUpperCase()}${parent.slice(1)}'s kururu is from before the channel could be switched on any node: switch it there, or update it.`;
    if (!enabled) return null;
    if (telegram.allowedCount === 0) return child ? `Nobody is allowed to talk to Kuru yet: pair your account in ${parent}'s Settings → Channels.` : "Pair your Telegram account first: nobody is allowed to talk to Kuru yet.";
    if (!telegram.hasToken) {
      return child
        ? `This node holds no bot token, so it could not read the chat. Lend it from ${parent}'s Settings → Nodes → ${nodes.name()} → Secrets → Telegram, then switch it on here.`
        : "Give kururu a bot token first.";
    }
    return null;
  }

  /** Where the poll stands, for Settings → Channels. */
  status(): LeadStatus | null {
    const { telegram, nodes } = this.deps;
    if (!telegram.isShared) return null;
    const self = nodes.selfId();
    const parent = nodes.parentId();
    const eligible = this.deps.eligible();
    const statuses = new Map(nodes.statuses().map((s) => [s.id, s] as const));
    const holder = this.holder();
    const word = telegram.switchWord();
    return {
      polls: telegram.polling,
      holder: holder ? this.name(holder) : null,
      eligible: eligible.eligible,
      why: eligible.why,
      heldFrom: nodes.role() === "child" && parent ? this.name(parent) : null,
      standingDownUntil: this.gate.standingDown(this.now()),
      nodes: nodes.members().map((m) => {
        if (m.id === self) return { id: m.id, name: m.name, rank: m.rank, self: true, parent: m.id === parent, up: true, since: null, eligible: eligible.eligible, polls: telegram.polling };
        const s = statuses.get(m.id);
        const peer = s ? leadPeer(s, nodes.liveSummaryOf(m.id)) : null;
        return { id: m.id, name: m.name, rank: m.rank, self: false, parent: m.id === parent, up: peer?.up ?? false, since: s?.since ?? null, eligible: peer?.eligible ?? null, polls: peer?.polls ?? false };
      }),
      switch: {
        by: word?.by ? this.name(word.by) : null,
        at: word?.at ?? null,
        pending: telegram.pendingSwitch() !== null,
        refuseOn: this.refusal(true),
        refuseOff: this.refusal(false),
      },
    };
  }

  private name(nodeId: string): string {
    return this.deps.nodes.nameOf(nodeId) ?? "a node";
  }

  /** The next look, when the rule named a moment sooner than the beat. */
  private schedule(wait: number | null): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (wait === null || wait >= BEAT_MS || this.closed) return;
    this.timer = setTimeout(() => this.evaluate(), Math.max(0, wait) + 5);
    this.timer.unref();
  }

  close(): void {
    this.closed = true;
    clearInterval(this.beat);
    if (this.timer) clearTimeout(this.timer);
  }
}

/**
 * A member, as the rule reads it: away since it was last heard; eligible as
 * its last summary said, which is the best there is for a node that is
 * away; and polling only by a summary pushed on the link that is up now.
 */
function leadPeer(status: NodeStatus, live: NodeStatus["summary"]): LeadPeer {
  const up = status.state === "up";
  const lead = (live ?? status.summary)?.lead;
  return {
    id: status.id,
    rank: status.rank,
    up,
    since: up ? status.since : (status.lastSeen ?? null),
    eligible: lead ? lead.eligible : null,
    polls: up && live?.lead?.polls === true,
  };
}
