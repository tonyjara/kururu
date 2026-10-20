/**
 * Telegram: a bot that carries the conversation with Kuru to a phone and back.
 *
 * `shared/channels.ts` argues for channels and holds the decisions; this is
 * the half that talks to Telegram, and most of what there is to get right in
 * it is the token, the poll and the queue.
 *
 * **The token** is a credential: whoever holds it reads everything the bot is
 * sent and writes as the bot. It is kept the way the OpenRouter key is —
 * `~/.config/kururu/telegram.json`, mode 0600, beside the channel's settings
 * — read off the disk for each request and dropped with it, so it is never in
 * a module variable for a later edit to log. It is put in one place only, the
 * request's URL, because that is where Telegram wants it, and so no error
 * kururu writes ever carries a URL, and every sentence Telegram answers with
 * is scrubbed of the token before anything else sees it. A window is sent
 * `hint`. The file is not on the backup's list (`shared/backup.ts`), so it
 * never leaves the machine that way either.
 *
 * **Long polling, not a webhook.** A webhook is Telegram calling kururu,
 * which needs a public https address — a port open to the internet or a
 * tunnel through the tailnet, both of which are the user's decision and not
 * a side effect of turning on a chat. A long poll is kururu calling Telegram:
 * `getUpdates` held open for fifty seconds, answered the moment a message
 * arrives. Nothing listens. The poll runs only while the channel is on or an
 * account is being paired, and stops — its request aborted, not left to run
 * out — the moment it is switched off, so "off" is nothing read and nothing
 * sent.
 *
 * **Where it has got to is on the disk** (`telegram.json` in the state
 * directory): the last update confirmed, so a restart under `bun run dev`
 * does not read a message twice — and when it does, between a message being
 * taken and the poll after, the outbox knows the id and takes it once — and
 * the messages still on their way out. A reply is queued before it is sent
 * and leaves the queue when Telegram has it, so a Mac whose Wi-Fi dropped
 * sends Kuru's answer when it is back rather than never.
 *
 * **Among several nodes** (`docs/nodes.md`, "One Telegram") the bot is one
 * bot and only one node may poll it, so this channel has a second way of
 * being: *shared*, when the roster carries the parent's settings. Then the
 * list is the roster's, the switch is the newest word among the roster's
 * and the nodes' own flips (`TelegramSwitch`), the poll runs only
 * while `lead.ts` says this node leads, a message is routed to the node it
 * is for (`routeOf`) and held while that node is away, and every line out
 * remembers whose it was (`ReplyMap`) — and a node that does not poll hands
 * its Kuru's lines to the one that does, keeping them until that node has
 * them. What the next holder needs is `handOver`'s, and it is all on the
 * disk beside the offset, so a holder that restarts carries on.
 *
 * On the restartable side: it holds no pty, and a restart costs a poll.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  ALLOWED_MAX,
  PAIRING_MS,
  emptyAddress,
  heldLine,
  laterSwitch,
  markLine,
  mergeReplies,
  rememberSent,
  routeOf,
  rosterSwitch,
  sharedFrom,
  switchTime,
  withSwitch,
  SEND_GIVE_UP_MS,
  TELEGRAM_DEFAULTS,
  adoptBot,
  adoptTelegramSettings,
  asTelegramSwitch,
  botFrom,
  channelMessageId,
  chunkText,
  judge,
  pairingCode,
  pollRetryMs,
  sendRetryMs,
  tokenHint,
  updatesFrom,
  userLabel,
  validTelegramToken,
  validTelegramUserId,
  type AllowedUser,
  type ChannelLink,
  type ChannelUser,
  type IncomingMessage,
  type LeadStatus,
  type ReplyMap,
  type RouteNode,
  type SharedTelegram,
  type TelegramBot,
  type TelegramSettings,
  type TelegramStatus,
  type TelegramSwitch,
} from "../../shared/channels";
import { LEAD_BUSY_MS, LEAD_HANDLED_MAX, isNodeId, type LeadHeld, type LeadState } from "../../shared/nodes";
import { readConfigFile, removeConfigFile, writeConfigFile } from "./config";

const FILE = "telegram.json";

/**
 * Where requests go. An environment variable so an isolated instance can be
 * pointed at a stand-in Bot API on loopback, and a test never reaches
 * Telegram or a real chat.
 */
function apiBase(): string {
  return process.env.KURURU_TELEGRAM_API || "https://api.telegram.org";
}

/** How long Telegram holds a poll open. Its maximum is far above this; a minute is under every proxy and NAT timeout worth worrying about. */
const POLL_S = 50;
/** Any other request. A send that takes longer than this is retried, which is better than a queue stuck behind it. */
const REQUEST_MS = 15_000;
/** Telegram shows "typing…" for five seconds after each ask. */
const TYPING_EVERY_MS = 4_500;
/** How long "typing…" is kept up for one message, if Kuru never answers it. */
const TYPING_FOR_MS = 10 * 60_000;
/** Failed polls in a row before the status says so: one dropped request is not news, and a restart makes one. */
const QUIET_FAILURES = 2;
/** How old a message sent while the channel was off may be and still be told it did not get through. */
const HELD_ANSWERED_MS = 60 * 60_000;

const PAIRED = "Paired. While the Telegram channel is on in kururu, what you write here goes to Kuru, and Kuru's replies come back here.";
const START = "This chat reaches Kuru, your kururu harness. Write to it as you would in the drawer; its replies come back here.";
const OFF = "kururu's Telegram channel is off, so this did not reach Kuru. Turn it on in Settings → Channels.";
const UNSUPPORTED = "Only text reaches Kuru from here — not photos, voice notes, files or stickers.";
const OTHER_READER = "Something else is reading this bot's messages too — another kururu, or another program with the same token. Only one can.";
const REVOKED = "Telegram does not recognise this bot's token any more. If you revoked it in @BotFather, paste the new one.";
const OTHER_NODE = "Another kururu polled this bot at the same moment — a split tailnet, most likely. The lower-ranked one stands down; the poll settles within a minute.";
/** A line handed to the node that polls and not acknowledged in this long is handed again. */
const RELAY_AGAIN_MS = 15_000;
/** Lines from other nodes remembered by id, so one handed twice is posted once. */
const RELAYS_SEEN_MAX = 500;
/** How long a message waits for a node that is away: Telegram's own horizon for what a bot was sent. */
const HELD_KEEP_MS = 24 * 60 * 60_000;
/** The tick that tells this process was frozen: a Mac asleep runs no timers, so a tick this late means it slept. */
const TICK_MS = 1_000;
const FROZEN_MS = 10_000;

/** The settings, the token's name for itself and the token, as the file holds them. */
interface Stored {
  bot: TelegramBot | null;
  settings: TelegramSettings;
}

/** A message on its way out. `notice`: one of kururu's own, sent whether or not the channel is on, and never retried. */
interface Outgoing {
  id: string;
  chat: string;
  text: string;
  silent: boolean;
  at: number;
  attempts: number;
  nextAt: number;
  /** The node whose line it is, when the channel is shared: what the reply map remembers it by. */
  origin?: string;
}

/** A line of this node's on its way to the node that polls, kept until that node says it has it. */
interface Relay {
  id: string;
  at: number;
  text: string;
  silent: boolean;
  /** One of kururu's own lines, a message that did not get through, rather than Kuru's. */
  notice: boolean;
  /** When it was last handed over; memory only, so a restart hands it again, and the holder takes an id once. */
  sentAt: number;
}

interface ChannelState {
  /** Which bot `offset` belongs to: a new token is a new bot, and its updates are counted from nothing. */
  botId: string | null;
  offset: number;
  outgoing: Outgoing[];
  ignored: { count: number; lastAt: number | null; last: string | null };
  lastInAt: number | null;
  lastOutAt: number | null;
  /** Shared: the chat's messages waiting for a node that is away. */
  held: LeadHeld[];
  /** Shared: which node said each line sent. */
  replies: ReplyMap;
  /** Shared: the last messages passed on, by id, so one read again is passed on once. */
  handled: string[];
  /** Shared, on a node that does not poll: its lines on their way to the one that does. */
  relaying: Relay[];
  /** Shared: this node polled for the others when it last stopped, and carries on at once when it starts. */
  holding: boolean;
  /** Shared, on a child: the newest flip of the switch it has heard that the roster does not carry yet. */
  switch: TelegramSwitch | null;
}

const EMPTY_STATE: ChannelState = {
  botId: null,
  offset: 0,
  outgoing: [],
  ignored: { count: 0, lastAt: null, last: null },
  lastInAt: null,
  lastOutAt: null,
  held: [],
  replies: [],
  handled: [],
  relaying: [],
  holding: false,
  switch: null,
};

function statePath(): string {
  const state = process.env.KURURU_STATE_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "kururu");
  return join(state, FILE);
}

/** The token on disk, or null. Read per request and never kept — see the module comment. */
function storedToken(): string | null {
  const raw = readConfigFile(FILE) as { token?: unknown } | null;
  return validTelegramToken(raw?.token) ? raw.token : null;
}

function readStored(): Stored {
  const raw = (readConfigFile(FILE) ?? {}) as Record<string, unknown>;
  return { bot: adoptBot(raw.bot), settings: adoptTelegramSettings(raw) };
}

function readState(path: string): ChannelState {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ChannelState>;
    const outgoing = Array.isArray(raw.outgoing)
      ? raw.outgoing.filter((o): o is Outgoing => Boolean(o) && typeof o.chat === "string" && typeof o.text === "string" && typeof o.at === "number")
      : [];
    return {
      botId: typeof raw.botId === "string" ? raw.botId : null,
      offset: typeof raw.offset === "number" && Number.isFinite(raw.offset) && raw.offset > 0 ? raw.offset : 0,
      outgoing: outgoing.map((o) => ({ ...o, id: typeof o.id === "string" ? o.id : randomUUID(), silent: o.silent === true, attempts: Number(o.attempts) || 0, nextAt: 0 })),
      ignored: {
        count: Number(raw.ignored?.count) || 0,
        lastAt: typeof raw.ignored?.lastAt === "number" ? raw.ignored.lastAt : null,
        last: typeof raw.ignored?.last === "string" ? raw.ignored.last : null,
      },
      lastInAt: typeof raw.lastInAt === "number" ? raw.lastInAt : null,
      lastOutAt: typeof raw.lastOutAt === "number" ? raw.lastOutAt : null,
      held: Array.isArray(raw.held)
        ? raw.held.filter((h): h is LeadHeld => Boolean(h) && isNodeId(h.node) && typeof h.id === "string" && typeof h.text === "string" && typeof h.at === "number")
        : [],
      replies: Array.isArray(raw.replies) ? raw.replies.filter((pair) => Array.isArray(pair) && typeof pair[0] === "string" && isNodeId(pair[1])) : [],
      handled: Array.isArray(raw.handled) ? raw.handled.filter((id): id is string => typeof id === "string").slice(-LEAD_HANDLED_MAX) : [],
      relaying: Array.isArray(raw.relaying)
        ? raw.relaying
            .filter((r): r is Relay => Boolean(r) && typeof r.id === "string" && typeof r.text === "string" && typeof r.at === "number")
            .map((r) => ({ id: r.id, at: r.at, text: r.text, silent: r.silent === true, notice: r.notice === true, sentAt: 0 }))
        : [],
      holding: raw.holding === true,
      switch: asTelegramSwitch(raw.switch),
    };
  } catch {
    return structuredClone(EMPTY_STATE);
  }
}

type Asked =
  | { ok: true; body: unknown }
  | { ok: false; aborted: boolean; code: number | null; description: string; retryAfter: number | null };

/** What `index.ts` lends this module. Profiles by key throughout; ids only for the wire. */
export interface TelegramDeps {
  /** A message for Kuru, through the outbox — `Outbox.say`, exactly as the drawer's composer sends one. */
  say: (profileKey: string, id: string, at: number, text: string) => void;
  /** The profile messages go to: the one chosen, if it is still there, else the active one. */
  profileKeyFor: (chosen: string | null) => string | null;
  profileIdOf: (key: string) => string | null;
  /** Whether a profile's Kuru is in a turn, which is when "typing…" is true. */
  kuruBusy: (profileKey: string) => boolean;
  /** The status moved. */
  changed: () => void;
  /** For tests: a stand-in for the network. */
  fetch?: Fetch;
  /** For tests: where the poll's state is kept, so two nodes can run in one process. */
  stateFile?: string;
}

/** The one shape of `fetch` this module uses, so a test's stand-in need not be all of it. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** The roster, as a shared channel needs it (`lead.ts` keeps it current). */
export interface TelegramShare {
  self: string;
  /** The roster's parent, whose lines carry no mark. */
  parent: string;
  /** Every member, this node among them: for `@name`, and each line's mark. */
  nodes: RouteNode[];
  /** The roster's copy of the parent's settings, which a child judges by; null on the parent, which judges by its own file. */
  settings: SharedTelegram | null;
}

/** What `lead.ts` lends a shared channel: the links, as far as this needs them. */
export interface LeadHooks {
  /** The chat's words for another node's Kuru: true when they went over its link. */
  deliver: (held: LeadHeld) => boolean;
  /** A node's name, for the line that says a message waits for it. */
  away: (nodeId: string) => string;
  /** A line of this node's, for the node that polls: true when it went. */
  relay: (line: Omit<Relay, "sentAt">) => boolean;
  /** Telegram said 409 while this node polled for the others. */
  conflict: () => void;
  /** This process was frozen, holding the poll, and has stopped polling on waking. */
  woke: () => void;
  /** Something here needs the poll soon — a pairing — and it should be asked for now. */
  hurry: () => void;
  /** Where the poll stands, for Settings. */
  status: () => LeadStatus | null;
}

export class TelegramChannel {
  private settings: TelegramSettings;
  private bot: TelegramBot | null;
  private hint: string | null;
  private state: ChannelState;
  private link: ChannelLink = "off";
  /** Why the poll is failing, or null. */
  private error: string | null = null;
  /** Why the last message out could not be sent, or null: kept apart from the poll's, so a reply refused does not read as a link that is down. */
  private sendError: string | null = null;
  private pairing: { code: string; until: number; candidate: ChannelUser | null } | null = null;
  private pairTimer: ReturnType<typeof setTimeout> | null = null;
  /** A token Telegram refused while polling: nothing is asked again until a new one is pasted. */
  private parked = false;
  private closed = false;
  private looping = false;
  private poller: AbortController | null = null;
  private resume: (() => void) | null = null;
  private failures = 0;
  /** Bumped when the token changes hands, so a poll sent with the old one cannot deliver into the new bot's offset. */
  private generation = 0;
  private sending = false;
  private sendTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly typing = new Map<string, { profileKey: string; until: number }>();
  private typingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly fetch: Fetch;
  /** The roster's, while the channel is shared among nodes; null while it is this node's alone. */
  private shared: TelegramShare | null = null;
  private hooks: LeadHooks | null = null;
  /** Shared: this node polls for the others now. */
  private leading = false;
  /** What was handed to the next holder and not yet acknowledged, to put back if the handshake dies half way. */
  private handed: { outgoing: Outgoing[]; held: LeadHeld[] } | null = null;
  /** Lines other nodes handed this one, by id: one handed twice is posted once. */
  private readonly relaysSeen = new Set<string>();
  /** 409s in a row while shared (`pollFailed`). */
  private conflicts = 0;
  /** When the freeze tick last ran (`FROZEN_MS`). */
  private tick = Date.now();
  private ticker: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: TelegramDeps) {
    this.fetch = deps.fetch ?? ((url, init) => fetch(url, init));
    const stored = readStored();
    const token = storedToken();
    this.settings = stored.settings;
    this.bot = token ? stored.bot : null;
    this.hint = token ? tokenHint(token) : null;
    this.state = readState(this.deps.stateFile ?? statePath());
  }

  /**
   * The file changed under this channel — a token lent by the parent, or
   * taken back (`secrets.ts`) — so it is read again as at start. The switch
   * is whatever the file says, which for a lent token is off: a held token
   * is the parent's bot, and a second poller of one bot is a 409 for both.
   */
  reread(): void {
    const stored = readStored();
    const token = storedToken();
    const hint = token ? tokenHint(token) : null;
    if (hint !== this.hint) {
      this.generation++;
      this.parked = false;
      this.failures = 0;
      this.error = null;
      this.endPairing();
    }
    // Another bot is another offset, and another chat's map: counted from nothing.
    if (token && stored.bot && this.state.botId !== stored.bot.id) {
      this.state = { ...structuredClone(EMPTY_STATE), botId: stored.bot.id };
      this.saveState();
    }
    this.settings = stored.settings;
    this.bot = token ? stored.bot : null;
    this.hint = hint;
    this.wake();
    this.deps.changed();
  }

  /** Start polling, if there is anything to poll for, and send whatever was waiting when the last server went. */
  start(): void {
    if (!this.looping) void this.loop();
    this.flush();
  }

  close(): void {
    this.closed = true;
    this.poller?.abort();
    this.resume?.();
    if (this.ticker) clearInterval(this.ticker);
    if (this.sendTimer) clearTimeout(this.sendTimer);
    if (this.pairTimer) clearTimeout(this.pairTimer);
    if (this.typingTimer) clearInterval(this.typingTimer);
    this.typing.clear();
  }

  status(): TelegramStatus {
    const now = Date.now();
    const pairing = this.pairing && this.pairing.until > now ? { ...this.pairing } : null;
    const rules = this.rules;
    return {
      kind: "telegram",
      hint: this.hint,
      bot: this.bot ?? this.shared?.settings?.bot ?? null,
      enabled: rules.enabled,
      allowed: rules.allowed,
      profileId: this.settings.profileKey ? this.deps.profileIdOf(this.settings.profileKey) : null,
      speakReplies: this.settings.speakReplies,
      link: this.hint ? this.link : "off",
      error: this.hint ? (this.error ?? this.sendError) : null,
      pairing,
      lastInAt: this.state.lastInAt,
      lastOutAt: this.state.lastOutAt,
      waiting: this.state.outgoing.length + this.state.relaying.length,
      ignored: { ...this.state.ignored },
      lead: this.hooks?.status() ?? null,
    };
  }

  /**
   * The switch, the switch time and the list this node goes by: on a child
   * of a shared channel the roster's, with a newer flip of the switch over
   * them; else its own file's. The parent's file is the roster's source, and
   * takes every newer flip it hears, so on the parent the two agree.
   */
  private get rules(): Pick<TelegramSettings, "enabled" | "enabledAt" | "allowed"> & Pick<SharedTelegram, "switchedAt" | "switchedBy"> {
    return this.shared?.settings ? withSwitch(this.shared.settings, this.state.switch) : this.settings;
  }

  /** Whether Kuru's replies to Telegram are also said aloud on the Mac. */
  get speakReplies(): boolean {
    return this.settings.speakReplies;
  }

  /** The profile whose Kuru this channel talks to, now. */
  profileKey(): string | null {
    return this.deps.profileKeyFor(this.settings.profileKey);
  }

  /**
   * Whether words from a profile's Kuru go to Telegram now: on, set up, and
   * that profile. Shared, a node with no token of its own still carries
   * them — to the node that polls.
   */
  carries(profileKey: string): boolean {
    const rules = this.rules;
    if (!rules.enabled || rules.allowed.length === 0 || profileKey !== this.profileKey()) return false;
    return this.shared !== null || this.hint !== null;
  }

  // ---------------------------------------------------------------------------
  // Shared among nodes (`lead.ts` drives this part)
  // ---------------------------------------------------------------------------

  /**
   * The links' half, lent once at start — and the tick that notices this
   * process slept. A Mac whose lid closed while it held the poll wakes
   * with its long poll still in hand, or an answer to it waiting, and
   * would read on as if nothing had happened, while a child took the chat
   * over half an hour ago: a 409 for the child, and the child's queue and
   * reply map never handed back. So a holder that slept stops first and
   * lets the rule look again (`LeadGate.woke`).
   */
  connect(hooks: LeadHooks): void {
    this.hooks = hooks;
    if (this.ticker) return;
    this.ticker = setInterval(() => {
      if (this.slept()) this.wokeUp();
      this.tick = Date.now();
    }, TICK_MS);
    this.ticker.unref();
  }

  /** The tick is late: this process was frozen since it last ran. */
  private slept(): boolean {
    return Date.now() - this.tick > FROZEN_MS;
  }

  /** Woken from a freeze: a holder of the shared poll lets go of it, and the lead looks again. */
  private wokeUp(): void {
    this.tick = Date.now();
    if (!this.shared || !this.leading) return;
    this.lead(false);
    this.hooks?.woke();
  }

  /**
   * The roster carries the channel, or stopped carrying it. A switch the
   * roster turned off is the parent's "off": nothing queued goes after it,
   * here as there.
   */
  share(next: TelegramShare | null): void {
    const before = JSON.stringify(this.shared);
    const wasOn = this.rules.enabled;
    this.shared = next;
    if (!next) this.leading = false;
    // A flip the roster now carries, or outdoes, has nothing left to say;
    // nor has one on a node that is no longer a child of a shared channel.
    const held = this.state.switch;
    if (held && (!next?.settings || !laterSwitch(rosterSwitch(next.settings), held))) {
      this.state.switch = null;
      this.saveState();
    }
    // A message for a node the roster no longer lists has nobody to wait
    // for, and one older than Telegram keeps anything is history.
    const now = Date.now();
    const kept = this.state.held.filter((h) => now - h.at < HELD_KEEP_MS && (!next || next.nodes.some((n) => n.id === h.node)));
    if (kept.length !== this.state.held.length) {
      this.state.held = kept;
      this.saveState();
    }
    this.rulesMoved(wasOn);
    if (before === JSON.stringify(next)) return;
    this.saveState();
    this.wake();
    this.deps.changed();
  }

  /** How many accounts are on the list this node goes by. */
  get allowedCount(): number {
    return this.rules.allowed.length;
  }

  /** Whether the channel is on, as this node goes by it. */
  get switchedOn(): boolean {
    return this.rules.enabled;
  }

  /** The newest word on the switch this node has: when it last moved, and from which node. Null when it never did. */
  switchWord(): { at: number; by: string | null } | null {
    const rules = this.rules;
    return typeof rules.switchedAt === "number" ? { at: rules.switchedAt, by: rules.switchedBy ?? null } : null;
  }

  /** Whether the roster's copy is from a parent that takes a node's flip into it. Always, on the parent. */
  get switchable(): boolean {
    const settings = this.shared?.settings;
    return !settings || settings.switchedAt !== undefined;
  }

  /** A flip this node holds that the roster does not carry yet: what it hands every node it links to. */
  pendingSwitch(): TelegramSwitch | null {
    const settings = this.shared?.settings;
    const held = this.state.switch;
    return settings && held && laterSwitch(rosterSwitch(settings), held) ? held : null;
  }

  /**
   * A flip of the shared switch — made here (`lead.ts` signs it) or heard
   * from another node — taken when it is the later word. On the parent it
   * goes into the file, which is the next roster; on a child it is kept
   * beside the roster until the roster says as much. True when taken, and
   * then it is this node's to hand on.
   *
   * The chat is told nothing. It used to be — "Kuru is listening here now",
   * "Kuru stopped listening here" — and with several nodes the lines came
   * from whichever one heard, which read as noise about machinery. The
   * switch is in Settings, where it was flipped; a message sent while it is
   * off is answered when it is next read.
   */
  takeSwitch(change: TelegramSwitch): boolean {
    const shared = this.shared;
    if (!shared || !laterSwitch(this.switchWord(), change)) return false;
    const wasOn = this.rules.enabled;
    if (shared.settings) {
      this.state.switch = change;
    } else {
      const enabled = change.enabled && this.settings.allowed.length > 0;
      this.settings = { ...this.settings, enabled, enabledAt: enabled ? change.at : null, switchedAt: change.at, switchedBy: change.by };
      this.save();
    }
    this.rulesMoved(wasOn);
    this.saveState();
    this.wake();
    this.flush();
    this.deps.changed();
    return true;
  }

  /**
   * The switch this node goes by moved, by the roster or by a flip. Off is
   * "off" at once: nothing queued goes after it, here or on the way to the
   * node that reads the chat.
   */
  private rulesMoved(wasOn: boolean): void {
    if (!wasOn || this.rules.enabled) return;
    this.state.outgoing = [];
    this.state.relaying = [];
    this.typing.clear();
  }

  /** The parent's own settings as the roster carries them: null with no bot to share. */
  ownShared(): SharedTelegram | null {
    return this.hint && this.bot ? sharedFrom(this.settings, this.bot) : null;
  }

  /** A token is on the disk here, the node's own or lent. */
  get hasToken(): boolean {
    return this.hint !== null;
  }

  /** Whether the channel is shared among nodes now. */
  get isShared(): boolean {
    return this.shared !== null;
  }

  /**
   * Shared: this node polls for the others. Not while it has just woken
   * from a freeze the tick has not caught yet: a summary sent in that
   * moment would tell the others a sleeping Mac still polls.
   */
  get polling(): boolean {
    return this.leading && !this.slept();
  }

  /** Catch a freeze now rather than at the next tick. */
  noticeSleep(): void {
    if (this.slept()) this.wokeUp();
  }

  /** This node held the poll when its last server stopped. */
  get resumes(): boolean {
    return this.state.holding;
  }

  /**
   * Start or stop polling for the others. Starting, what was waiting to be
   * handed to a holder is this node's to send. Nothing is said to the chat
   * either way: which node reads it is not something the user has to act
   * on, and it moves every time a lid closes. Settings → Channels and the
   * doctor show it, and `lifecycle.log` keeps every move (`lead.ts`).
   */
  lead(on: boolean): void {
    if (on === this.leading) return;
    this.leading = on;
    this.state.holding = on;
    if (on) {
      for (const relay of this.state.relaying) this.enqueue(relay.text, this.shared?.self, relay.silent, true);
      this.state.relaying = [];
      this.failures = 0;
    } else {
      this.poller?.abort();
    }
    this.saveState();
    this.wake();
    this.flush();
    this.deps.changed();
  }

  /**
   * Why this node should not hand the poll over this minute, or null: the
   * user is in the middle of a conversation through it. A handover then
   * would be a message answered by one Kuru and its follow-up by another.
   */
  busyReason(now = Date.now()): string | null {
    if (this.state.lastInAt !== null && now - this.state.lastInAt < LEAD_BUSY_MS) return "the user wrote in the chat in the last two minutes";
    for (const entry of this.typing.values()) if (this.deps.kuruBusy(entry.profileKey)) return "Kuru is answering a message from the chat";
    return null;
  }

  /**
   * Everything the next holder needs, and the poll stopped: what was waiting
   * to go out and what was waiting for a node go with it, and are kept
   * aside until the handshake's acknowledgement (`handedOver`) or put back
   * if it never comes (`takeBack`).
   */
  handOver(): LeadState {
    const self = this.shared?.self ?? "";
    const state: LeadState = {
      botId: this.state.botId,
      offset: this.state.offset,
      outgoing: this.state.outgoing.map((o) => ({ id: o.id, chat: o.chat, text: o.text, silent: o.silent, at: o.at, origin: o.origin ?? self })),
      held: [...this.state.held],
      replies: [...this.state.replies],
      handled: [...this.state.handled],
      lastInAt: this.state.lastInAt,
    };
    this.handed = { outgoing: this.state.outgoing, held: this.state.held };
    this.state.outgoing = [];
    this.state.held = [];
    this.lead(false);
    return state;
  }

  /** The next holder has it all: what was kept aside goes. */
  handedOver(): void {
    this.handed = null;
  }

  /** The handshake died before it was acknowledged: what was handed is this node's again, in front of anything since. */
  takeBack(): void {
    if (!this.handed) return;
    this.state.outgoing = [...this.handed.outgoing, ...this.state.outgoing];
    this.state.held = [...this.handed.held, ...this.state.held];
    this.handed = null;
    this.saveState();
    this.flush();
  }

  /**
   * The last holder's state, taken over: read to where it read, its queue in
   * front of this node's own, the maps merged. A message it held for this
   * node is this node's Kuru's now. Another bot's state is not this one's.
   */
  adopt(state: LeadState): void {
    if (state.botId && this.state.botId && state.botId !== this.state.botId) return;
    this.state.botId ??= state.botId;
    this.state.offset = Math.max(this.state.offset, state.offset);
    const queued = new Set(this.state.outgoing.map((o) => o.id));
    this.state.outgoing = [...state.outgoing.filter((o) => !queued.has(o.id)).map((o) => ({ ...o, attempts: 0, nextAt: 0 })), ...this.state.outgoing];
    const held = new Set(this.state.held.map((h) => h.id));
    this.state.held = [...this.state.held, ...state.held.filter((h) => !held.has(h.id))];
    this.state.replies = mergeReplies(this.state.replies, state.replies);
    this.state.handled = [...new Set([...this.state.handled, ...state.handled])].slice(-LEAD_HANDLED_MAX);
    if (state.lastInAt !== null) this.state.lastInAt = Math.max(this.state.lastInAt ?? 0, state.lastInAt);
    const self = this.shared?.self;
    const profileKey = this.profileKey();
    for (const item of this.state.held.filter((h) => h.node === self)) {
      if (!profileKey) break;
      this.deps.say(profileKey, item.id, item.at, item.text);
      this.state.held = this.state.held.filter((h) => h.id !== item.id);
    }
    this.saveState();
    this.flush();
    this.deps.changed();
  }

  /** A node linked: what waits for it is handed over. */
  deliverHeld(nodeId: string): void {
    for (const held of this.state.held) if (held.node === nodeId) this.hooks?.deliver(held);
  }

  /** A node said it has a message that waited for it. */
  heldDone(id: string, nodeId: string): void {
    const before = this.state.held.length;
    this.state.held = this.state.held.filter((h) => h.id !== id || h.node !== nodeId);
    if (this.state.held.length !== before) this.saveState();
  }

  /**
   * Another node's line, handed to this one to post: marked with that node,
   * remembered as its line once sent. Taken only while this node polls,
   * since the others hand their lines to whoever does; false, and the
   * sender keeps it for the next holder.
   */
  fromNode(nodeId: string, line: Omit<Relay, "sentAt">): boolean {
    if (!this.shared || !this.leading || !this.hint || !this.rules.enabled) return false;
    if (this.relaysSeen.has(line.id)) return true;
    this.relaysSeen.add(line.id);
    if (this.relaysSeen.size > RELAYS_SEEN_MAX) this.relaysSeen.delete(this.relaysSeen.values().next().value!);
    this.enqueue(line.text, nodeId, line.silent, true);
    this.saveState();
    this.deps.changed();
    this.flush();
    return true;
  }

  /** The node that polls has this line of ours. */
  relayed(id: string): void {
    const before = this.state.relaying.length;
    this.state.relaying = this.state.relaying.filter((r) => r.id !== id);
    if (this.state.relaying.length === before) return;
    this.saveState();
    this.deps.changed();
  }

  /**
   * Hand the node that polls whatever of ours it has not said it has: what
   * was never handed, and what was handed a while ago and not acknowledged.
   * Nobody to hand it to, and it all waits here — a reply stuck on a node
   * that cannot reach the holder waits in that node's own queue.
   */
  flushRelay(): void {
    if (!this.hooks || !this.shared || this.leading) return;
    const now = Date.now();
    // Given up after the same half day a line waits for Telegram itself.
    const fresh = this.state.relaying.filter((r) => now - r.at < SEND_GIVE_UP_MS);
    if (fresh.length !== this.state.relaying.length) {
      this.state.relaying = fresh;
      this.saveState();
    }
    for (const relay of this.state.relaying) {
      if (relay.sentAt && now - relay.sentAt < RELAY_AGAIN_MS) continue;
      if (!this.hooks.relay({ id: relay.id, at: relay.at, text: relay.text, silent: relay.silent, notice: relay.notice })) return;
      relay.sentAt = now;
    }
  }

  private relayLine(text: string, silent: boolean, notice: boolean): void {
    this.state.relaying.push({ id: randomUUID(), at: Date.now(), text, silent, notice, sentAt: 0 });
    this.saveState();
    this.deps.changed();
    this.flushRelay();
  }

  /** A node's mark in the chat: none for the parent's lines, or for a channel that is not shared. */
  private markOf(nodeId: string | undefined): string | null {
    const shared = this.shared;
    if (!shared || !nodeId || nodeId === shared.parent) return null;
    return shared.nodes.find((n) => n.id === nodeId)?.name ?? null;
  }

  /** A line for every allowed account, marked with its node when `mark`, split where Telegram's limit makes it two. */
  private enqueue(text: string, origin: string | undefined, silent: boolean, mark: boolean): void {
    const now = Date.now();
    const words = mark ? markLine(this.markOf(origin), text) : text;
    for (const user of this.rules.allowed) {
      for (const chunk of chunkText(words)) {
        this.state.outgoing.push({ id: randomUUID(), chat: user.id, text: chunk, silent, at: now, attempts: 0, nextAt: 0, ...(origin ? { origin } : {}) });
      }
    }
  }

  /** On a child of a shared channel, the list is the parent's: the roster's, signed there. */
  private parentsOnly(what: string): void {
    if (!this.shared?.settings) return;
    const parent = this.shared.nodes.find((n) => n.id === this.shared!.parent)?.name ?? "the parent";
    throw new Error(`${what} is ${parent}'s: change it in ${parent}'s Settings → Channels, and it reaches this node in the roster.`);
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  /**
   * Take a token from Settings: ask Telegram who it is, and keep it only if
   * it is a bot nothing else is reading through a webhook. Throws the
   * sentence the page prints.
   */
  async setToken(raw: unknown): Promise<TelegramStatus> {
    const token = typeof raw === "string" ? raw.trim() : raw;
    if (!validTelegramToken(token)) {
      throw new Error("That does not look like a bot token. BotFather's are a number, a colon, and about 35 letters and digits: 123456789:AAH…");
    }
    const me = await this.ask("getMe", {}, { token });
    if (!me.ok) throw new Error(me.code === 401 || me.code === 404 ? "Telegram does not recognise this token. Copy it again from @BotFather." : refusal(me));
    const bot = botFrom(me.body);
    if (!bot) throw new Error("Telegram answered, but not about a bot.");
    const hook = await this.ask("getWebhookInfo", {}, { token });
    const hookUrl = hook.ok ? (hook.body as { result?: { url?: unknown } }).result?.url : null;
    if (typeof hookUrl === "string" && hookUrl) {
      let where = "somewhere";
      try {
        where = new URL(hookUrl).host;
      } catch {
        // A webhook is a URL; one that is not is still a webhook.
      }
      throw new Error(`This bot already hands its messages to a webhook at ${where}, so something else is using it. Make a bot of its own for kururu with /newbot.`);
    }
    this.generation++;
    this.poller?.abort();
    if (this.state.botId !== bot.id) {
      this.state = { ...structuredClone(EMPTY_STATE), botId: bot.id };
      this.saveState();
    }
    this.bot = bot;
    writeConfigFile(FILE, { token, bot, ...this.settings }, 0o600);
    if (storedToken() !== token) throw new Error("Could not save the token to ~/.config/kururu/telegram.json.");
    this.hint = tokenHint(token);
    this.error = null;
    this.sendError = null;
    this.parked = false;
    this.failures = 0;
    this.wake();
    // A queue held back by a revoked token goes out under the new one.
    this.flush();
    this.deps.changed();
    return this.status();
  }

  /** Forget the bot: the token, its settings and the list, off the disk, and nothing more read or sent. */
  forget(): void {
    this.generation++;
    this.poller?.abort();
    removeConfigFile(FILE);
    this.settings = { ...TELEGRAM_DEFAULTS, allowed: [] };
    this.bot = null;
    this.hint = null;
    this.error = null;
    this.sendError = null;
    this.parked = false;
    this.endPairing();
    this.typing.clear();
    this.leading = false;
    this.handed = null;
    this.state = structuredClone(EMPTY_STATE);
    this.saveState();
    this.wake();
    this.deps.changed();
  }

  /**
   * On or off, the profile, whether replies are spoken. Turning on needs a
   * token and somebody to talk to. Throws the sentence. The switch of a
   * shared channel is not flipped here but by a signed flip every node
   * hears (`lead.ts`, then `takeSwitch`).
   */
  set(change: { enabled?: boolean; profileKey?: string | null; speakReplies?: boolean }): TelegramStatus {
    const now = Date.now();
    if (change.enabled !== undefined && change.enabled !== this.rules.enabled && this.shared) throw new Error("A shared channel's switch is flipped for every node at once, through the links.");
    if (change.enabled === true && !this.settings.enabled) {
      if (!this.hint) throw new Error("Give kururu a bot token first.");
      if (this.settings.allowed.length === 0) throw new Error("Pair your Telegram account first: nobody is allowed to talk to Kuru yet.");
      const at = switchTime(now, this.settings.switchedAt);
      this.settings = { ...this.settings, enabled: true, enabledAt: at, switchedAt: at, switchedBy: null };
    } else if (change.enabled === false && this.settings.enabled) {
      // Nothing queued goes after it.
      this.state.outgoing = [];
      this.settings = { ...this.settings, enabled: false, enabledAt: null, switchedAt: switchTime(now, this.settings.switchedAt), switchedBy: null };
      this.typing.clear();
      this.poller?.abort();
    }
    if (change.profileKey !== undefined) this.settings = { ...this.settings, profileKey: change.profileKey };
    if (change.speakReplies !== undefined) this.settings = { ...this.settings, speakReplies: change.speakReplies };
    this.save();
    this.wake();
    this.deps.changed();
    return this.status();
  }

  /** Start or stop listening for the pairing code. Polls while it lasts, even with the channel off; nothing reaches Kuru from it. */
  pair(on: boolean): TelegramStatus {
    if (!on) {
      this.endPairing();
    } else {
      this.parentsOnly("The list of accounts");
      if (!this.hint || !this.bot) throw new Error("Give kururu a bot token first.");
      this.endPairing();
      this.pairing = { code: pairingCode(randomBytes(8)), until: Date.now() + PAIRING_MS, candidate: null };
      this.pairTimer = setTimeout(() => {
        this.endPairing();
        this.wake();
        this.deps.changed();
      }, PAIRING_MS);
      this.pairTimer.unref();
      // The code arrives through the poll, which another node may hold now.
      if (this.shared && this.rules.enabled && !this.leading) this.hooks?.hurry();
    }
    this.wake();
    this.deps.changed();
    return this.status();
  }

  /**
   * Put an account on the list: the one that sent the pairing code, or an id
   * typed in by hand — whose name is asked of Telegram, which knows it only
   * if that account has opened the bot. Throws the sentence.
   */
  async allow(userId: string): Promise<TelegramStatus> {
    this.parentsOnly("The list of accounts");
    const candidate = this.pairing?.candidate;
    let user: AllowedUser;
    if (candidate && candidate.id === userId) {
      user = { ...candidate, addedAt: Date.now() };
      this.endPairing();
      this.notice(user.id, this.settings.enabled ? PAIRED : `${PAIRED} It is off right now: turn it on in Settings → Channels.`);
    } else {
      if (!validTelegramUserId(userId)) throw new Error("A Telegram account id is a number, like 123456789.");
      user = { id: userId, name: null, username: null, addedAt: Date.now() };
      const chat = await this.ask("getChat", { chat_id: userId });
      if (chat.ok) {
        const found = (chat.body as { result?: Record<string, unknown> }).result;
        const name = [found?.first_name, found?.last_name].filter((part): part is string => typeof part === "string" && part !== "").join(" ");
        user = { ...user, name: name || null, username: typeof found?.username === "string" ? found.username : null };
      }
    }
    const others = this.settings.allowed.filter((u) => u.id !== user.id);
    if (others.length >= ALLOWED_MAX) throw new Error(`At most ${ALLOWED_MAX} accounts.`);
    this.settings = { ...this.settings, allowed: [...others, user] };
    this.save();
    this.wake();
    this.deps.changed();
    return this.status();
  }

  /** "Not me": somebody else sent the code. The code is dead, and pairing starts again from a new one if asked. */
  refuse(): void {
    this.endPairing();
    this.wake();
    this.deps.changed();
  }

  /** Take an account off the list. The last one off switches the channel off: there is nobody it could be on for. */
  disallow(userId: string): void {
    this.parentsOnly("The list of accounts");
    const allowed = this.settings.allowed.filter((u) => u.id !== userId);
    this.settings = adoptTelegramSettings({ ...this.settings, allowed });
    this.state.outgoing = this.state.outgoing.filter((o) => o.chat !== userId);
    this.save();
    this.saveState();
    this.wake();
    this.deps.changed();
  }

  /** Send a test message to every allowed account, and say how it went. Works with the channel off: it is how you find out before turning it on. */
  async test(): Promise<string> {
    if (!this.hint) throw new Error("Give kururu a bot token first.");
    if (this.rules.allowed.length === 0) throw new Error("Nobody to send to yet: pair your account first.");
    const sent: string[] = [];
    for (const user of this.rules.allowed) {
      const asked = await this.ask("sendMessage", { chat_id: user.id, text: "Test from kururu. This is where Kuru's replies arrive while the channel is on." });
      if (!asked.ok) throw new Error(sendRefusal(asked, user, this.bot));
      sent.push(userLabel(user));
    }
    this.state.lastOutAt = Date.now();
    this.sendError = null;
    this.saveState();
    this.deps.changed();
    return `Sent to ${sent.join(", ")}. Look in Telegram.`;
  }

  clearIgnored(): void {
    this.state.ignored = { count: 0, lastAt: null, last: null };
    this.saveState();
    this.deps.changed();
  }

  // ---------------------------------------------------------------------------
  // The conversation
  // ---------------------------------------------------------------------------

  /**
   * Words from a profile's Kuru, or a quiet copy of your own, for every
   * allowed account — if the channel carries that profile now. Queued, then
   * sent in order; split where Telegram's limit makes a long reply two.
   */
  post(profileKey: string, text: string, options: { silent?: boolean } = {}): void {
    if (!this.carries(profileKey) || !text.trim()) return;
    if (this.shared && !this.leading) {
      this.relayLine(text, options.silent === true, false);
      return;
    }
    this.enqueue(text, this.shared?.self, options.silent === true, true);
    this.saveState();
    this.deps.changed();
    this.flush();
  }

  /** One of kururu's own lines to everybody on the list — a message that did not get through — if the channel carries the profile. */
  warn(profileKey: string, text: string): void {
    if (!this.carries(profileKey)) return;
    if (this.shared && !this.leading) this.relayLine(text, true, true);
    else if (this.shared && this.markOf(this.shared.self)) this.enqueue(text, this.shared.self, true, true);
    else this.noticeAll(text);
  }

  /** Kuru answered: no more "typing…" for its profile. */
  stopTyping(profileKey: string): void {
    for (const [chat, entry] of this.typing) if (entry.profileKey === profileKey) this.typing.delete(chat);
  }

  // ---------------------------------------------------------------------------
  // The poll
  // ---------------------------------------------------------------------------

  private pairingLive(): boolean {
    return this.pairing !== null && this.pairing.until > Date.now();
  }

  /**
   * Alone, while the channel is on or an account is being paired. Shared,
   * only while this node leads; a pairing on the parent polls while the
   * channel is off, when nobody else does, and asks for the poll back
   * while it is on (`pair`).
   */
  private shouldPoll(): boolean {
    if (this.closed || this.parked || this.hint === null) return false;
    if (!this.shared) return this.settings.enabled || this.pairingLive();
    return (this.rules.enabled && this.leading) || (this.pairingLive() && (this.leading || !this.rules.enabled));
  }

  /** Something the loop decides on changed: stop waiting, and stop a poll that should no longer be running. */
  private wake(): void {
    if (!this.shouldPoll()) this.poller?.abort();
    this.resume?.();
    if (!this.looping && !this.closed) void this.loop();
  }

  private pause(ms: number | null): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = ms === null ? null : setTimeout(done, ms);
      timer?.unref();
      this.resume = done;
      function done() {
        if (timer) clearTimeout(timer);
        resolve();
      }
    }).then(() => {
      this.resume = null;
    });
  }

  private async loop(): Promise<void> {
    this.looping = true;
    try {
      while (!this.closed) {
        if (!this.shouldPoll()) {
          if (!this.parked) this.setLink("off", null);
          await this.pause(null);
          continue;
        }
        if (this.shared && this.leading && this.slept()) {
          this.wokeUp();
          continue;
        }
        const generation = this.generation;
        const controller = new AbortController();
        this.poller = controller;
        if (this.link === "off") this.setLink("connecting", null);
        const asked = await this.ask(
          "getUpdates",
          { offset: this.state.offset || undefined, timeout: POLL_S, allowed_updates: ["message"] },
          { signal: controller.signal, timeoutMs: (POLL_S + 15) * 1000 },
        );
        this.poller = null;
        if (this.closed) break;
        // An answer that arrived across a freeze — or an ask made just
        // before one — is not this node's to act on if it held the poll for
        // the others: the chat may have moved on without it.
        if (this.shared && this.leading && this.slept()) {
          this.wokeUp();
          continue;
        }
        // Re-keyed or switched off while it was out: whatever came back is
        // the old bot's, or arrived for a channel that is off.
        if (generation !== this.generation || !this.shouldPoll()) continue;
        if (!asked.ok) {
          if (!asked.aborted) await this.pollFailed(asked);
          continue;
        }
        const updates = updatesFrom(asked.body);
        if (!updates) {
          await this.pollFailed({ ok: false, aborted: false, code: null, description: "Telegram's answer was not in a shape kururu knows.", retryAfter: null });
          continue;
        }
        this.failures = 0;
        this.conflicts = 0;
        this.setLink("listening", null);
        const held = { stale: new Map<string, number>(), off: new Map<string, number>() };
        for (const message of updates.messages) this.take(message, held);
        for (const [chat, n] of held.stale) {
          this.notice(chat, `${n === 1 ? "A message" : `${n} messages`} sent while the Telegram channel was off ${n === 1 ? "was" : "were"} not passed on to Kuru. Send it again if you still mean it.`);
        }
        for (const chat of held.off.keys()) this.notice(chat, OFF);
        // Confirmed after it is taken rather than before: a server that dies
        // in between reads the message again, and the outbox knows its id.
        if (updates.last !== null && updates.last + 1 > this.state.offset) {
          this.state.offset = updates.last + 1;
          this.saveState();
        }
      }
    } finally {
      this.looping = false;
    }
  }

  private async pollFailed(asked: Extract<Asked, { ok: false }>): Promise<void> {
    this.failures++;
    if (asked.code === 401 || asked.code === 404) {
      this.parked = true;
      this.setLink("error", REVOKED);
      return;
    }
    if (asked.code === 409 && /webhook/i.test(asked.description)) {
      this.parked = true;
      this.setLink("error", "This bot hands its messages to a webhook now, so kururu cannot read them. Something else is using the bot; give kururu one of its own.");
      return;
    }
    // Shared, 409s are another node polling too, and rank settles it
    // (`LeadGate.conflict`): this node stops, and is told when to try again.
    // Two in a row, not one: a server that restarted, or took the poll by
    // the handshake, can be answered one 409 while Telegram still holds the
    // last holder's request, and that is not a node to stand down for. Two
    // pollers are a 409 every second, so the second comes at once.
    if (asked.code === 409 && this.shared && this.hooks) {
      this.conflicts++;
      if (this.conflicts >= 2) {
        this.conflicts = 0;
        this.setLink("error", OTHER_NODE);
        this.hooks.conflict();
        return;
      }
      await this.pause(pollRetryMs(1));
      return;
    }
    if (this.failures > QUIET_FAILURES || asked.code === 409) {
      this.setLink("error", asked.code === 409 ? (this.failures > QUIET_FAILURES ? OTHER_READER : this.error) : refusal(asked));
    }
    const wait = asked.code === 429 && asked.retryAfter !== null ? asked.retryAfter * 1000 : pollRetryMs(this.failures);
    await this.pause(wait);
  }

  /**
   * One message, judged and acted on. What was sent while the channel was
   * off is counted per chat rather than answered one by one: a poll started
   * for pairing reads everything that piled up while nothing polled, and
   * twenty "this did not reach Kuru" in a row is noise. Older than an hour,
   * and it is not answered at all.
   */
  private take(message: IncomingMessage, held: { stale: Map<string, number>; off: Map<string, number> }): void {
    const now = Date.now();
    const rules = this.rules;
    const verdict = judge(message, {
      allowed: rules.allowed.map((u) => u.id),
      enabled: rules.enabled,
      enabledAt: rules.enabledAt,
      pairing: this.pairing,
      now,
    });
    const chat = message.chatId;
    switch (verdict.kind) {
      case "ignore":
        this.state.ignored = {
          count: this.state.ignored.count + 1,
          lastAt: now,
          last: verdict.who ? `${userLabel(verdict.who)}, id ${verdict.who.id}` : "a group or a channel",
        };
        this.saveState();
        this.deps.changed();
        return;
      case "pair":
        if (!this.pairing) return;
        this.pairing = { ...this.pairing, candidate: verdict.user };
        this.notice(chat, "Got it. Now confirm on your Mac: Settings → Channels shows this account; press Allow there.");
        this.deps.changed();
        return;
      case "off":
      case "stale":
        if (now - message.at < HELD_ANSWERED_MS) held[verdict.kind].set(chat, (held[verdict.kind].get(chat) ?? 0) + 1);
        return;
      case "unsupported":
        this.notice(chat, UNSUPPORTED);
        return;
      case "start":
        this.notice(chat, START);
        return;
      case "pass": {
        const id = channelMessageId("telegram", chat, message.messageId);
        let text = verdict.text;
        const shared = this.shared;
        if (shared) {
          // Read again — by a holder that took it and stopped before the
          // poll after confirmed it — and passed on once.
          if (this.state.handled.includes(id)) return;
          this.state.handled = [...this.state.handled, id].slice(-LEAD_HANDLED_MAX);
          const route = routeOf({ text, chat, replyTo: message.replyTo, map: this.state.replies, nodes: shared.nodes, leader: shared.self });
          this.state.lastInAt = now;
          if (!route.text) {
            this.saveState();
            this.notice(chat, emptyAddress(shared.nodes.find((n) => n.id === route.node)?.name ?? "it"));
            return;
          }
          if (route.node !== shared.self) {
            this.hold({ node: route.node, id, at: message.at || now, text: route.text }, chat);
            this.saveState();
            this.deps.changed();
            return;
          }
          text = route.text;
        }
        const profileKey = this.profileKey();
        if (!profileKey) {
          this.notice(chat, "kururu has no profile to give this to.");
          return;
        }
        this.state.lastInAt = now;
        this.saveState();
        this.deps.say(profileKey, id, message.at || now, text);
        this.startTyping(chat, profileKey);
        this.deps.changed();
        return;
      }
    }
  }

  /**
   * The chat's words for another node: over its link now, or kept until it
   * links. Kept either way until that node says it has them (`heldDone`),
   * so a link that drops in between loses nothing.
   *
   * The chat is told they wait only when nothing else was waiting for that
   * node. That is read off the held list rather than remembered beside it,
   * because the list is on the disk and in the handover: a server restart
   * or the poll moving to another node used to forget it had said so, and
   * say it again.
   */
  private hold(held: LeadHeld, chat: string): void {
    const waiting = this.state.held.some((h) => h.node === held.node);
    this.state.held.push(held);
    if (this.hooks?.deliver(held)) {
      void this.ask("sendChatAction", { chat_id: chat, action: "typing" });
      return;
    }
    if (!waiting) this.notice(chat, heldLine(this.hooks?.away(held.node) ?? "that node"));
  }

  // ---------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------

  /** One of kururu's own lines, to one chat, now: no queue and no retry. A pairing reply that did not arrive is a pairing to try again. */
  private notice(chat: string, text: string): void {
    void this.ask("sendMessage", { chat_id: chat, text, disable_notification: true }).then((asked) => {
      if (asked.ok) {
        this.state.lastOutAt = Date.now();
        this.saveState();
      }
    });
  }

  private noticeAll(text: string): void {
    for (const user of this.rules.allowed) this.notice(user.id, text);
  }

  /**
   * Send the head of the queue, then the next. Strictly in order — a reply in
   * two parts must not arrive second part first — so a message waiting out a
   * retry holds back what is behind it, which is the price of the order.
   */
  private flush(): void {
    if (this.sending || this.closed) return;
    if (this.sendTimer) {
      clearTimeout(this.sendTimer);
      this.sendTimer = null;
    }
    const head = this.state.outgoing[0];
    if (!head || !this.rules.enabled || !this.hint || this.parked) return;
    const wait = head.nextAt - Date.now();
    if (wait > 0) {
      this.sendTimer = setTimeout(() => {
        this.sendTimer = null;
        this.flush();
      }, wait);
      this.sendTimer.unref();
      return;
    }
    this.sending = true;
    void this.send(head).finally(() => {
      this.sending = false;
      this.flush();
    });
  }

  private async send(item: Outgoing): Promise<void> {
    const asked = await this.ask("sendMessage", {
      chat_id: item.chat,
      text: item.text,
      disable_notification: item.silent || undefined,
      link_preview_options: { is_disabled: true },
    });
    const drop = (ids: (o: Outgoing) => boolean) => {
      this.state.outgoing = this.state.outgoing.filter((o) => !ids(o));
    };
    const now = Date.now();
    if (asked.ok) {
      drop((o) => o.id === item.id);
      this.state.lastOutAt = now;
      this.sendError = null;
      // Whose line it was, by the id Telegram gave it, so a reply to it finds that node.
      const sent = (asked.body as { result?: { message_id?: unknown } } | null)?.result?.message_id;
      if (item.origin && typeof sent === "number" && Number.isFinite(sent)) this.state.replies = rememberSent(this.state.replies, item.chat, [sent], item.origin);
    } else if (asked.aborted) {
      return;
    } else if (asked.code === 429) {
      item.nextAt = now + (asked.retryAfter ?? 5) * 1000;
    } else if (asked.code === 401 || asked.code === 404) {
      this.parked = true;
      this.setLink("error", REVOKED);
    } else if (asked.code === 403 || (asked.code === 400 && /chat not found/i.test(asked.description))) {
      // Not this message's fault, and not going to change on a retry: every
      // message to that account goes, and the page says what to do.
      const user = this.settings.allowed.find((u) => u.id === item.chat) ?? { id: item.chat, name: null, username: null };
      drop((o) => o.chat === item.chat);
      this.sendError = sendRefusal(asked, user, this.bot);
    } else if (asked.code !== null && asked.code >= 400 && asked.code < 500) {
      drop((o) => o.id === item.id);
      this.sendError = `Telegram refused a reply: ${asked.description}`;
    } else if (now - item.at > SEND_GIVE_UP_MS) {
      drop((o) => o.id === item.id);
    } else {
      item.attempts++;
      item.nextAt = now + sendRetryMs(item.attempts);
    }
    this.saveState();
    this.deps.changed();
  }

  /** "typing…" in the chat while Kuru works on what was sent from it. */
  private startTyping(chat: string, profileKey: string): void {
    this.typing.set(chat, { profileKey, until: Date.now() + TYPING_FOR_MS });
    void this.ask("sendChatAction", { chat_id: chat, action: "typing" });
    if (this.typingTimer) return;
    this.typingTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, entry] of this.typing) {
        if (now > entry.until || !this.rules.enabled) this.typing.delete(id);
        else if (this.deps.kuruBusy(entry.profileKey)) void this.ask("sendChatAction", { chat_id: id, action: "typing" });
      }
      if (this.typing.size === 0 && this.typingTimer) {
        clearInterval(this.typingTimer);
        this.typingTimer = null;
      }
    }, TYPING_EVERY_MS);
    this.typingTimer.unref();
  }

  // ---------------------------------------------------------------------------
  // The wire to Telegram
  // ---------------------------------------------------------------------------

  /**
   * One Bot API call. The token is read here, for this request, unless one
   * being tried is passed in; it goes into the URL and nowhere else, and no
   * error from here carries the URL or anything from the network stack.
   */
  private async ask(method: string, params: Record<string, unknown>, options: { token?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Asked> {
    const token = options.token ?? storedToken();
    if (!token) return { ok: false, aborted: false, code: null, description: "No bot token is saved.", retryAfter: null };
    const signals = [AbortSignal.timeout(options.timeoutMs ?? REQUEST_MS)];
    if (options.signal) signals.push(options.signal);
    try {
      const res = await this.fetch(`${apiBase()}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: AbortSignal.any(signals),
      });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        // Not JSON: a proxy's error page, say. The status says enough.
      }
      const answer = body as { ok?: unknown; error_code?: unknown; description?: unknown; parameters?: { retry_after?: unknown } } | null;
      if (res.ok && answer?.ok === true) return { ok: true, body };
      const retry = answer?.parameters?.retry_after;
      return {
        ok: false,
        aborted: false,
        code: typeof answer?.error_code === "number" ? answer.error_code : res.status,
        description: scrub(typeof answer?.description === "string" ? answer.description.slice(0, 300) : `HTTP ${res.status}`, token),
        retryAfter: typeof retry === "number" && Number.isFinite(retry) && retry > 0 ? Math.min(retry, 3600) : null,
      };
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (options.signal?.aborted) return { ok: false, aborted: true, code: null, description: "Stopped.", retryAfter: null };
      return { ok: false, aborted: false, code: null, description: name === "TimeoutError" ? "Telegram did not answer in time." : "Could not reach Telegram.", retryAfter: null };
    }
  }

  // ---------------------------------------------------------------------------
  // The disk
  // ---------------------------------------------------------------------------

  private setLink(link: ChannelLink, error: string | null): void {
    if (this.link === link && this.error === error) return;
    this.link = link;
    this.error = error;
    this.deps.changed();
  }

  private endPairing(): void {
    this.pairing = null;
    if (this.pairTimer) clearTimeout(this.pairTimer);
    this.pairTimer = null;
  }

  /** The settings back to the file, with the token that is already there — read for the write and dropped. */
  private save(): void {
    const token = storedToken();
    if (!token) return;
    writeConfigFile(FILE, { token, bot: this.bot, ...this.settings }, 0o600);
  }

  /** Through a temporary file and a rename, as every file kururu keeps is. A write that fails costs a message read twice, not the server. */
  private saveState(): void {
    const path = this.deps.stateFile ?? statePath();
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.tmp`, `${JSON.stringify(this.state)}\n`, { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    } catch {
      // See above.
    }
  }
}

/** A sentence for a refusal, with the token out of it. */
function refusal(asked: Extract<Asked, { ok: false }>): string {
  if (asked.code === null) return asked.description;
  if (asked.code === 429) return "Telegram is rate-limiting this bot; kururu is waiting it out.";
  return `Telegram answered ${asked.code}: ${asked.description}`;
}

/** Why a message to an account could not be sent, as the page says it. A bot cannot write first: the account has to open it and press Start. */
function sendRefusal(asked: Extract<Asked, { ok: false }>, user: ChannelUser, bot: TelegramBot | null): string {
  if (asked.code === 403 || (asked.code === 400 && /chat not found/i.test(asked.description))) {
    return `Telegram will not let the bot write to ${userLabel(user)} until that account opens ${bot ? `@${bot.username}` : "the bot"} and presses Start.`;
  }
  return refusal(asked);
}

/** The token out of anything Telegram said, in case it ever quotes one back. */
function scrub(text: string, token: string): string {
  return text.split(token).join("<token>");
}
