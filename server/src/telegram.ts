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
 * On the restartable side: it holds no pty, and a restart costs a poll.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  ALLOWED_MAX,
  PAIRING_MS,
  SEND_GIVE_UP_MS,
  TELEGRAM_DEFAULTS,
  adoptBot,
  adoptTelegramSettings,
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
  type TelegramBot,
  type TelegramSettings,
  type TelegramStatus,
} from "../../shared/channels";
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
const ON_NOTICE = "Kuru is listening here now.";
const OFF_NOTICE = "Kuru stopped listening here. Nothing you write reaches it until the channel is turned on again in kururu.";
const OTHER_READER = "Something else is reading this bot's messages too — another kururu, or another program with the same token. Only one can.";
const REVOKED = "Telegram does not recognise this bot's token any more. If you revoked it in @BotFather, paste the new one.";

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
}

interface ChannelState {
  /** Which bot `offset` belongs to: a new token is a new bot, and its updates are counted from nothing. */
  botId: string | null;
  offset: number;
  outgoing: Outgoing[];
  ignored: { count: number; lastAt: number | null; last: string | null };
  lastInAt: number | null;
  lastOutAt: number | null;
}

const EMPTY_STATE: ChannelState = { botId: null, offset: 0, outgoing: [], ignored: { count: 0, lastAt: null, last: null }, lastInAt: null, lastOutAt: null };

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

function readState(): ChannelState {
  try {
    const raw = JSON.parse(readFileSync(statePath(), "utf8")) as Partial<ChannelState>;
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
}

/** The one shape of `fetch` this module uses, so a test's stand-in need not be all of it. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

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

  constructor(private readonly deps: TelegramDeps) {
    this.fetch = deps.fetch ?? ((url, init) => fetch(url, init));
    const stored = readStored();
    const token = storedToken();
    this.settings = stored.settings;
    this.bot = token ? stored.bot : null;
    this.hint = token ? tokenHint(token) : null;
    this.state = readState();
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
    if (this.sendTimer) clearTimeout(this.sendTimer);
    if (this.pairTimer) clearTimeout(this.pairTimer);
    if (this.typingTimer) clearInterval(this.typingTimer);
    this.typing.clear();
  }

  status(): TelegramStatus {
    const now = Date.now();
    const pairing = this.pairing && this.pairing.until > now ? { ...this.pairing } : null;
    return {
      kind: "telegram",
      hint: this.hint,
      bot: this.bot,
      enabled: this.settings.enabled,
      allowed: this.settings.allowed,
      profileId: this.settings.profileKey ? this.deps.profileIdOf(this.settings.profileKey) : null,
      speakReplies: this.settings.speakReplies,
      link: this.hint ? this.link : "off",
      error: this.hint ? (this.error ?? this.sendError) : null,
      pairing,
      lastInAt: this.state.lastInAt,
      lastOutAt: this.state.lastOutAt,
      waiting: this.state.outgoing.length,
      ignored: { ...this.state.ignored },
    };
  }

  /** Whether Kuru's replies to Telegram are also said aloud on the Mac. */
  get speakReplies(): boolean {
    return this.settings.speakReplies;
  }

  /** The profile whose Kuru this channel talks to, now. */
  profileKey(): string | null {
    return this.deps.profileKeyFor(this.settings.profileKey);
  }

  /** Whether words from a profile's Kuru go to Telegram now: on, set up, and that profile. */
  carries(profileKey: string): boolean {
    return this.settings.enabled && this.hint !== null && this.settings.allowed.length > 0 && profileKey === this.profileKey();
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
    this.state = structuredClone(EMPTY_STATE);
    this.saveState();
    this.wake();
    this.deps.changed();
  }

  /** On or off, the profile, whether replies are spoken. Turning on needs a token and somebody to talk to. Throws the sentence. */
  set(change: { enabled?: boolean; profileKey?: string | null; speakReplies?: boolean }): TelegramStatus {
    const now = Date.now();
    if (change.enabled === true && !this.settings.enabled) {
      if (!this.hint) throw new Error("Give kururu a bot token first.");
      if (this.settings.allowed.length === 0) throw new Error("Pair your Telegram account first: nobody is allowed to talk to Kuru yet.");
      this.settings = { ...this.settings, enabled: true, enabledAt: now };
      this.noticeAll(ON_NOTICE);
    } else if (change.enabled === false && this.settings.enabled) {
      // The notice is the last thing sent, and nothing queued goes after it.
      this.state.outgoing = [];
      this.noticeAll(OFF_NOTICE);
      this.settings = { ...this.settings, enabled: false, enabledAt: null };
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
      if (!this.hint || !this.bot) throw new Error("Give kururu a bot token first.");
      this.endPairing();
      this.pairing = { code: pairingCode(randomBytes(8)), until: Date.now() + PAIRING_MS, candidate: null };
      this.pairTimer = setTimeout(() => {
        this.endPairing();
        this.wake();
        this.deps.changed();
      }, PAIRING_MS);
      this.pairTimer.unref();
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
    if (this.settings.allowed.length === 0) throw new Error("Nobody to send to yet: pair your account first.");
    const sent: string[] = [];
    for (const user of this.settings.allowed) {
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
    const now = Date.now();
    for (const user of this.settings.allowed) {
      for (const chunk of chunkText(text)) {
        this.state.outgoing.push({ id: randomUUID(), chat: user.id, text: chunk, silent: options.silent === true, at: now, attempts: 0, nextAt: 0 });
      }
    }
    this.saveState();
    this.deps.changed();
    this.flush();
  }

  /** One of kururu's own lines to everybody on the list — a message that did not get through — if the channel carries the profile. */
  warn(profileKey: string, text: string): void {
    if (this.carries(profileKey)) this.noticeAll(text);
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

  private shouldPoll(): boolean {
    return !this.closed && !this.parked && this.hint !== null && (this.settings.enabled || this.pairingLive());
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
    const verdict = judge(message, {
      allowed: this.settings.allowed.map((u) => u.id),
      enabled: this.settings.enabled,
      enabledAt: this.settings.enabledAt,
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
        const profileKey = this.profileKey();
        if (!profileKey) {
          this.notice(chat, "kururu has no profile to give this to.");
          return;
        }
        this.state.lastInAt = now;
        this.saveState();
        this.deps.say(profileKey, channelMessageId("telegram", chat, message.messageId), message.at || now, verdict.text);
        this.startTyping(chat, profileKey);
        this.deps.changed();
        return;
      }
    }
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
    for (const user of this.settings.allowed) this.notice(user.id, text);
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
    if (!head || !this.settings.enabled || !this.hint || this.parked) return;
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
        if (now > entry.until || !this.settings.enabled) this.typing.delete(id);
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
    const path = statePath();
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
