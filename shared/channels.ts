/**
 * Channels: other doors into the conversation with Kuru, and the rules every
 * one of them shares.
 *
 * The drawer and the talk key both assume you are at a screen kururu draws.
 * Away from it, the phone over Tailscale is a desktop layout on a small
 * screen, and the microphone there needs https nobody has set up. A chat app
 * is already on the phone, already wakes it with a notification, and already
 * keeps a thread. So a channel is a chat app you talk to Kuru through: what
 * you send it goes into the **same outbox** the drawer's composer types into,
 * and what Kuru says comes back out to it. There is still one conversation
 * with one home — the drawer — and a channel is a second window onto it, the
 * way the phone's browser is a second window onto the panes.
 *
 * Telegram is the only one, and it was first for two reasons that are both
 * about the server rather than the chat app. A bot reads its messages by
 * asking (`getUpdates`, a long poll), so nothing listens on a port and
 * nothing goes near the tailnet; and a bot is made in a minute with a chat,
 * not an app review. Discord and others fit the same shape — a kind, a
 * credential, an allow-list of the user's own accounts, a mark on the words
 * — which is why the kind is a type here and not a string in a dozen places.
 *
 * **The allow-list is the security, and it is checked first.** Kuru acts on
 * every agent with the user's authority, so whoever can talk to the bot can
 * do anything the user could. Anybody can find a bot by its name and write
 * to it. What reaches Kuru is a message in a private chat, from an account
 * whose id the user put on the list — a list that starts empty, so a new bot
 * passes nothing on until somebody on this Mac adds an account. Everything
 * else is ignored without an answer; an answer would only tell a stranger
 * the bot is alive. `judge` is that decision as arithmetic a test can hold.
 *
 * **Words carry where they came from.** A message from a channel is typed
 * into Kuru's terminal with a mark — `[telegram]`, the way the voice puts
 * `[voice]` — so Kuru knows it is answering somebody on a phone, and the
 * drawer, the search and the backup can tell the turn from a spoken or typed
 * one. The outbox tells a channel's message from the others by its id, which
 * the server mints (`channelMessageId`), for the reason it tells a clip from
 * a typed line by its length: one list and one table, with no column saying
 * which is which.
 *
 * This file is the pure half: the shapes, the decisions and the text. The
 * Telegram connection is `server/src/telegram.ts`; what ties channels to the
 * outbox and to Kuru's turns is `server/src/channels.ts`.
 */

/** Every kind of channel kururu knows. One today. */
export type ChannelKind = "telegram";
export const CHANNEL_KINDS: readonly ChannelKind[] = ["telegram"];

export const CHANNEL_NAMES: Record<ChannelKind, string> = { telegram: "Telegram" };

/** The mark a channel's words carry into Kuru's terminal, as `[voice]` marks speech. */
export const CHANNEL_PREFIX: Record<ChannelKind, string> = { telegram: "[telegram]" };

export function isChannelKind(value: unknown): value is ChannelKind {
  return typeof value === "string" && (CHANNEL_KINDS as readonly string[]).includes(value);
}

/** The channel a prompt came from, by its mark; null for one typed or spoken here. */
export function channelOfPrompt(text: string): ChannelKind | null {
  for (const kind of CHANNEL_KINDS) if (text.startsWith(CHANNEL_PREFIX[kind])) return kind;
  return null;
}

/** A prompt without a channel's mark: the words as the person wrote them. */
export function withoutChannelMark(text: string): string {
  const kind = channelOfPrompt(text);
  return kind ? text.slice(CHANNEL_PREFIX[kind].length).trim() : text;
}

/**
 * The words as they are typed into Kuru's terminal. A slash command goes in
 * bare, as it would from the drawer's composer: behind a mark it is text,
 * and `/compact` sent from a phone should compact.
 */
export function channelWords(kind: ChannelKind, text: string): string {
  return text.startsWith("/") ? text : `${CHANNEL_PREFIX[kind]} ${text}`;
}

/**
 * An outbox id for a message from a channel. Minted by the server from the
 * chat and the message, so a message read twice — a server that died between
 * taking it and saying so to Telegram — is one message and not two, which
 * `Outbox.say` already guarantees for an id it has seen. Inside `isClipId`'s
 * alphabet, and never one a window mints: those are UUIDs, which are hex,
 * and no kind's name is.
 */
export function channelMessageId(kind: ChannelKind, chat: string, message: number): string {
  return `${kind}-${chat.replace(/[^0-9A-Za-z]/g, "")}-${message}`;
}

/** The channel an outbox message came from, by its id; null for one spoken or typed here. */
export function channelOfMessage(id: string): ChannelKind | null {
  for (const kind of CHANNEL_KINDS) if (id.startsWith(`${kind}-`)) return kind;
  return null;
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/**
 * An account on a channel. The id is a string for every kind, though
 * Telegram's are numbers: Discord's are snowflakes past 2^53, which a number
 * would round into somebody else's.
 */
export interface ChannelUser {
  id: string;
  /** The name the account shows, as it showed it when it was added. Not a check of anything: anybody can call themselves anything. */
  name: string | null;
  username: string | null;
}

export interface AllowedUser extends ChannelUser {
  addedAt: number;
}

/** "Ada Lovelace (@ada)", or the id when the account showed nothing else. */
export function userLabel(user: ChannelUser): string {
  const name = user.name?.trim();
  const handle = user.username ? `@${user.username}` : null;
  if (name && handle) return `${name} (${handle})`;
  return name || handle || `id ${user.id}`;
}

/** A Telegram account id as somebody types it in: digits, and not zero. Group chats are negative and are never on the list. */
export function validTelegramUserId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d{0,15}$/.test(value);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Telegram's settings, kept in the same owner-only file as the token
 * (`~/.config/kururu/telegram.json`). Beside the token rather than in a file
 * of their own because none of them means anything without it, and one file
 * is one thing to leave out of the backups.
 */
export interface TelegramSettings {
  enabled: boolean;
  /**
   * When it was last switched on. A message sent before this is not passed
   * on: Telegram keeps what a bot was sent for a day, and "off" has to mean
   * that what you sent while it was off never reaches Kuru later.
   */
  enabledAt: number | null;
  /**
   * When the switch last moved, on or off, and which node moved it (by
   * id; null for this one, or a file from before). What "last change wins"
   * compares among nodes (`TelegramSwitch`): on the parent it is the
   * roster's, and a node's switch made later than it is the newer word.
   */
  switchedAt: number | null;
  switchedBy: string | null;
  allowed: AllowedUser[];
  /** The profile whose Kuru it talks to, by key. Null until chosen, which reads as the active profile. */
  profileKey: string | null;
  /** Also read Kuru's replies to Telegram messages aloud on this Mac. Off: see `replySpoken`. */
  speakReplies: boolean;
}

export const TELEGRAM_DEFAULTS: TelegramSettings = { enabled: false, enabledAt: null, switchedAt: null, switchedBy: null, allowed: [], profileKey: null, speakReplies: false };

/** The most accounts on the list. Somebody with two phones has two; a list of forty is a group, which a channel is not for. */
export const ALLOWED_MAX = 8;

function adoptUser(value: unknown): AllowedUser | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "number" ? String(raw.id) : raw.id;
  if (!validTelegramUserId(id)) return null;
  return {
    id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 128) : null,
    username: typeof raw.username === "string" && /^[A-Za-z0-9_]{1,64}$/.test(raw.username) ? raw.username : null,
    addedAt: typeof raw.addedAt === "number" && Number.isFinite(raw.addedAt) ? raw.addedAt : 0,
  };
}

/** Settings off the disk, whatever a hand edit left there. On with nobody allowed reads as off: there is nobody it could be on for. */
export function adoptTelegramSettings(value: unknown): TelegramSettings {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const seen = new Set<string>();
  const allowed: AllowedUser[] = [];
  for (const item of Array.isArray(raw.allowed) ? raw.allowed : []) {
    const user = adoptUser(item);
    if (!user || seen.has(user.id) || allowed.length >= ALLOWED_MAX) continue;
    seen.add(user.id);
    allowed.push(user);
  }
  const enabled = raw.enabled === true && allowed.length > 0;
  return {
    enabled,
    enabledAt: enabled && typeof raw.enabledAt === "number" && Number.isFinite(raw.enabledAt) ? raw.enabledAt : null,
    switchedAt: typeof raw.switchedAt === "number" && Number.isFinite(raw.switchedAt) ? raw.switchedAt : null,
    switchedBy: typeof raw.switchedBy === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(raw.switchedBy) ? raw.switchedBy : null,
    allowed,
    profileKey: typeof raw.profileKey === "string" && raw.profileKey ? raw.profileKey : null,
    speakReplies: raw.speakReplies === true,
  };
}

// ---------------------------------------------------------------------------
// The token
// ---------------------------------------------------------------------------

/**
 * A bot token worth putting in a URL: the bot's id, a colon, and the secret.
 * The check is the URL's rather than Telegram's — a slash or a newline would
 * be a different request — with lengths around what BotFather issues so a
 * paste of something else is refused here rather than by a round trip.
 */
export function validTelegramToken(token: unknown): token is string {
  return typeof token === "string" && /^\d{3,20}:[A-Za-z0-9_-]{30,100}$/.test(token);
}

/** Enough of a token to tell two apart, as the OpenRouter key's `hint` is: the last four. */
export function tokenHint(token: string): string {
  return `…${token.slice(-4)}`;
}

/** A bot as `getMe` describes it, or null. */
export interface TelegramBot {
  id: string;
  username: string;
  name: string;
}

/** A bot as the settings file keeps it, or null for anything a hand edit broke. */
export function adoptBot(value: unknown): TelegramBot | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !/^\d+$/.test(raw.id)) return null;
  if (typeof raw.username !== "string" || !/^[A-Za-z0-9_]{3,64}$/.test(raw.username)) return null;
  return { id: raw.id, username: raw.username, name: typeof raw.name === "string" ? raw.name.slice(0, 128) : raw.username };
}

export function botFrom(body: unknown): TelegramBot | null {
  const result = (body as { ok?: unknown; result?: Record<string, unknown> } | null)?.result;
  if (!result || typeof result !== "object" || result.is_bot !== true) return null;
  const id = typeof result.id === "number" && Number.isFinite(result.id) ? String(result.id) : null;
  const username = typeof result.username === "string" && /^[A-Za-z0-9_]{3,64}$/.test(result.username) ? result.username : null;
  if (!id || !username) return null;
  const name = typeof result.first_name === "string" ? result.first_name.slice(0, 128) : username;
  return { id, username, name };
}

// ---------------------------------------------------------------------------
// What arrives
// ---------------------------------------------------------------------------

/** One message a bot was sent, as the decision needs it. */
export interface IncomingMessage {
  updateId: number;
  messageId: number;
  chatId: string;
  /** `private`, `group`, `supergroup` or `channel`. */
  chatType: string;
  /** Null for a post in a channel, which has no sender. */
  from: (ChannelUser & { bot: boolean }) | null;
  /** When Telegram took it, epoch ms. Telegram says seconds. */
  at: number;
  /** The words; null for a photo, a sticker, a voice note — anything without them. */
  text: string | null;
  /** The message this one answers, when it was sent as a reply: how a reply to one of a node's lines finds that node (`routeOf`). */
  replyTo: number | null;
}

/**
 * One answer to `getUpdates`: the messages in it, and the highest update id,
 * which is what the next poll confirms. Every update counts toward that id,
 * including the kinds nothing here reads — an edit, a reaction — or the next
 * poll would be answered with them again for ever. Null for an answer that is
 * not a list at all.
 */
export function updatesFrom(body: unknown): { messages: IncomingMessage[]; last: number | null } | null {
  const result = (body as { ok?: unknown; result?: unknown } | null)?.result;
  if (!Array.isArray(result)) return null;
  const messages: IncomingMessage[] = [];
  let last: number | null = null;
  for (const item of result) {
    if (!item || typeof item !== "object") continue;
    const update = item as Record<string, unknown>;
    if (typeof update.update_id !== "number" || !Number.isFinite(update.update_id)) continue;
    last = last === null ? update.update_id : Math.max(last, update.update_id);
    const message = messageFrom(update.update_id, update.message);
    if (message) messages.push(message);
  }
  return { messages, last };
}

function messageFrom(updateId: number, value: unknown): IncomingMessage | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const chat = raw.chat as Record<string, unknown> | undefined;
  if (typeof raw.message_id !== "number" || !chat || typeof chat.id !== "number" || typeof chat.type !== "string") return null;
  const fromRaw = raw.from as Record<string, unknown> | undefined;
  const from =
    fromRaw && typeof fromRaw.id === "number"
      ? {
          id: String(fromRaw.id),
          name: [fromRaw.first_name, fromRaw.last_name].filter((part): part is string => typeof part === "string" && part.trim() !== "").join(" ").slice(0, 128) || null,
          username: typeof fromRaw.username === "string" ? fromRaw.username.slice(0, 64) : null,
          bot: fromRaw.is_bot === true,
        }
      : null;
  const at = typeof raw.date === "number" && Number.isFinite(raw.date) ? raw.date * 1000 : 0;
  const answered = raw.reply_to_message as Record<string, unknown> | undefined;
  const replyTo = answered && typeof answered.message_id === "number" && Number.isFinite(answered.message_id) ? answered.message_id : null;
  return { updateId, messageId: raw.message_id, chatId: String(chat.id), chatType: chat.type, from, at, text: typeof raw.text === "string" ? raw.text : null, replyTo };
}

/** The most of a message passed on. Telegram's own limit is 4096; this is that, so nothing a bot can be sent is cut. */
export const CHANNEL_TEXT_MAX = 4096;

/**
 * The words of a message as they may be typed into a terminal. Control
 * characters go — all but the line break and the tab — because these words
 * are written into a pty, where a stray Ctrl-C interrupts Kuru and an escape
 * starts a sequence. Only an allowed account gets this far, but a paste from
 * somewhere else can carry one without anybody meaning it.
 */
export function cleanText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
    .trim()
    .slice(0, CHANNEL_TEXT_MAX);
}

/** What became of one message, and so what the bot does with it. */
export type Verdict =
  /** To Kuru, through the outbox, as these words. */
  | { kind: "pass"; text: string }
  /** `/start` from an allowed account: what a Telegram app sends the first time the bot is opened. A greeting, and nothing to Kuru. */
  | { kind: "start" }
  /** It carried the pairing code: this account is shown on the Mac, to be allowed or not. */
  | { kind: "pair"; user: ChannelUser }
  /** An allowed account, while the channel is off — which a message is only read in while pairing. */
  | { kind: "off" }
  /** Sent before the channel was last switched on. */
  | { kind: "stale" }
  /** No words to pass on. */
  | { kind: "unsupported" }
  /** Not a private chat with an account on the list. No answer, ever; counted, so Settings can say somebody found the bot. */
  | { kind: "ignore"; who: ChannelUser | null };

export interface JudgeContext {
  allowed: readonly string[];
  enabled: boolean;
  enabledAt: number | null;
  pairing: { code: string; until: number } | null;
  now: number;
}

/**
 * The bot's whole decision about one message, in the order that makes it
 * safe. A private chat with a person comes first — a group the bot was added
 * to, a channel post, another bot are ignored whoever is in them, because a
 * reply in a group is a reply to everybody in it. The pairing code is next,
 * so an account not yet on the list can be found; then the list itself, and
 * only an account on it gets anything past here, including an answer.
 */
export function judge(message: IncomingMessage, ctx: JudgeContext): Verdict {
  const from = message.from;
  const who = from && !from.bot ? { id: from.id, name: from.name, username: from.username } : null;
  if (!from || from.bot || message.chatType !== "private" || message.chatId !== from.id) return { kind: "ignore", who };
  const text = message.text === null ? null : cleanText(message.text);
  if (ctx.pairing && ctx.pairing.until > ctx.now && text !== null && carriesCode(text, ctx.pairing.code)) {
    return { kind: "pair", user: { id: from.id, name: from.name, username: from.username } };
  }
  if (!ctx.allowed.includes(from.id)) return { kind: "ignore", who };
  if (!ctx.enabled) return { kind: "off" };
  // Telegram's clock says whole seconds, so a message sent in the second the
  // switch went on is let through rather than dropped for a rounding.
  if (ctx.enabledAt !== null && message.at + 1000 < ctx.enabledAt) return { kind: "stale" };
  if (!text) return { kind: "unsupported" };
  if (/^\/start(@\w+)?(\s|$)/.test(text)) return { kind: "start" };
  return { kind: "pass", text };
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

/** How long a pairing code is good for. Long enough to find the phone and open Telegram; short enough that a code on a screen somebody photographed is dead. */
export const PAIRING_MS = 10 * 60_000;

/**
 * Thirty-two letters and digits, without the ones a person reads as each
 * other — no I, no O, no 0, no 1 — so a byte modulo the length is unbiased.
 */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 6;

/** A pairing code from random bytes: the server hands in `crypto.randomBytes`. */
export function pairingCode(bytes: Uint8Array): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[(bytes[i] ?? 0) % CODE_ALPHABET.length];
  return code;
}

/**
 * Whether a message is the pairing code: typed alone, in any case, or as the
 * `/start <code>` a `t.me/<bot>?start=<code>` link makes Telegram send when
 * Start is pressed. The whole message and not a word in it, so a sentence
 * that happens to hold six capitals is not a pairing.
 */
export function carriesCode(text: string, code: string): boolean {
  const bare = text.replace(/^\/start(@\w+)?\s+/i, "").replace(/[\s-]/g, "").toUpperCase();
  return bare === code;
}

/** The link that opens the bot with the code ready to send. */
export function pairingLink(username: string, code: string): string {
  return `https://t.me/${username}?start=${code}`;
}

// ---------------------------------------------------------------------------
// What goes out
// ---------------------------------------------------------------------------

/**
 * The most of one Telegram message. Telegram's limit is 4096 characters after
 * its own parsing; a little under it, so a count that differs from ours by a
 * surrogate pair or two never costs a refused reply.
 */
export const CHUNK_MAX = 4000;

/**
 * A long reply as Telegram messages, each under the limit, split where a
 * reader would split it: at a blank line, else a line break, else a space,
 * and only through a word when a word is longer than a message. Never through
 * a surrogate pair, which would put half an emoji at the end of one message
 * and the other half at the start of the next.
 */
export function chunkText(text: string, max = CHUNK_MAX): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) {
      cut = max;
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut--;
    }
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Your own words, said or typed here, as a quiet line in the chat. Without
 * them a reply to something you said at the Mac arrives in Telegram with no
 * question in front of it; with them the chat reads as the drawer does. They
 * are sent without a notification, since telling you what you just said is
 * not news. A turn of yours from the channel itself is already in the chat.
 */
export function echoLine(via: "voice" | "typed", text: string): string {
  return `${via === "voice" ? "🎙 You said" : "⌨️ You typed"}: ${text}`;
}

/**
 * Whether Kuru's reply at the end of a turn is read aloud on the Mac, given
 * where everything that turn answered came from.
 *
 * A turn that answered only a channel is not spoken. Somebody writing from
 * Telegram is, nearly always, not at the Mac — that is why they used
 * Telegram — and the reply is already in their hand. Said aloud, it plays to
 * an empty room, or over whoever is in it, and then sits on the unheard
 * count as a reply nobody heard, which is true and useless: they read it.
 * Anything else in the turn — something you said or typed here, a turn Kuru
 * started itself to answer a `[kururu]` notice, which has nothing in it — and
 * it is spoken, as every reply was before channels. `speakChannelReplies` is
 * the switch for somebody who writes from the phone on the couch beside the
 * Mac and wants it heard anyway.
 */
export function replySpoken(vias: ReadonlySet<string>, speakChannelReplies: boolean): boolean {
  if (speakChannelReplies || vias.size === 0) return true;
  for (const via of vias) if (!isChannelKind(via)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Another node's words
// ---------------------------------------------------------------------------

/**
 * Who on another kururu a message is from: the user, writing in that node's
 * drawer or speaking to it with `@omarchy …`, or that node's Kuru, asking
 * this one with `ask_kuru` (`docs/nodes.md`, "Kurus as peers").
 */
export type PeerWho = "user" | "kuru";

/**
 * The mark a message from another node is typed into Kuru behind, beside
 * `[telegram]`: `[user@mac]` for the user, `[kuru@mac]` for the Kuru there.
 *
 * Both halves, rather than the bare `[mac]` the plan first wrote, because a
 * node can be called anything a hostname can, and one called `voice`,
 * `telegram` or `kururu` would have made its Kuru's every message read as
 * speech, a phone or a notice. The `@` cannot appear in any of those marks,
 * and saying who is the point: the user through another door is the user,
 * and a colleague asking is a colleague.
 */
export function peerMark(node: string, who: PeerWho): string {
  return `[${who}@${node}]`;
}

const PEER_MARK = /^\[(user|kuru)@([a-z][a-z0-9-]{0,23})\]\s*/;

/**
 * The words as they are typed into Kuru. The user's slash command goes in
 * bare, as `channelWords` lets a phone's `/compact` compact; another Kuru's
 * never does, since one Kuru clearing another's context is nobody's wish.
 */
export function peerWords(node: string, who: PeerWho, text: string): string {
  return who === "user" && text.startsWith("/") ? text : `${peerMark(node, who)} ${text}`;
}

/** A prompt's peer mark, read off its front, and what follows it; null for a prompt without one. */
export function readPeerMark(text: string): { node: string; who: PeerWho; rest: string } | null {
  const match = PEER_MARK.exec(text);
  return match ? { who: match[1] as PeerWho, node: match[2]!, rest: text.slice(match[0].length) } : null;
}

/**
 * Where everything one of Kuru's turns answered came from, which is what
 * decides who hears the reply: words from here (spoken or typed at this
 * node), a channel's, and another node's — `user@mac`, `kuru@mac` — each by
 * its mark.
 */
export interface TurnOrigin {
  here: boolean;
  channels: ChannelKind[];
  peers: string[];
}

/**
 * Whether this node says a turn's reply aloud: `replySpoken`'s rule, with
 * another node's words counting as a channel's. A turn that answered only
 * the Kuru on the Mac, or the user typing at the box's own page, has its
 * reader already, and the reply goes back over the link to whoever asked.
 */
export function spokenHere(origin: TurnOrigin, speakChannelReplies: boolean): boolean {
  if (origin.here) return true;
  if (origin.peers.length) return speakChannelReplies && origin.channels.length > 0;
  return replySpoken(new Set(origin.channels), speakChannelReplies);
}

/**
 * Whether a reply another node's Kuru made is said aloud on this one. A
 * child has no speakers, so with the lid open its Kuru talks through the
 * Mac — but only to what the Mac's user said to it, or about its own agents
 * (a turn that answered nothing: a notice). A turn that answered somebody at
 * the child's own page, a phone in its channel, or this node's Kuru (which
 * hears the answer in its tool call and says it in its own words) is not.
 */
export function peerReplySpoken(origin: TurnOrigin, self: string): boolean {
  if (origin.peers.includes(`user@${self}`)) return true;
  return !origin.here && origin.channels.length === 0 && origin.peers.length === 0;
}

/**
 * How long after its `attempt`th failure (from 1) a message to a channel is
 * tried again. Seconds at first — a Wi-Fi hiccup — then minutes, capped at
 * five, because a Mac with no network for an hour should not wait a further
 * hour once it has one.
 */
export function sendRetryMs(attempt: number): number {
  return [2_000, 5_000, 15_000, 30_000, 60_000, 120_000][attempt - 1] ?? 300_000;
}

/**
 * How long a message waits for a channel before it is given up. Half a day: a
 * reply that took longer than that to reach the phone is history, and the
 * drawer has it.
 */
export const SEND_GIVE_UP_MS = 12 * 60 * 60_000;

/** How long after `failures` failed polls in a row the next is made. */
export function pollRetryMs(failures: number): number {
  return [1_000, 2_000, 5_000, 10_000, 30_000][failures - 1] ?? 60_000;
}

// ---------------------------------------------------------------------------
// One bot, several nodes
// ---------------------------------------------------------------------------

/*
 * With more than one kururu linked (`docs/nodes.md`), there is still one
 * bot and one chat, and only one node may read it: Telegram answers a
 * second `getUpdates` on the same token with a 409. So one node polls — the
 * leader, by rank, among the nodes that can (`LeadGate` in `shared/nodes.ts`
 * says which and when) — and every node's Kuru talks through it. What the
 * chat sends is routed to a node by what it says (`routeOf`); what each
 * Kuru says is marked with its node (`markLine`) and remembered by the
 * message id Telegram gave it (`ReplyMap`), so a reply to a line finds the
 * Kuru that said it.
 */

/**
 * The parent's Telegram settings as the roster carries them: what every
 * node needs to judge a message — the allow-list, the switch, the moment it
 * went on — and which bot it is. Never the token, which is a secret and is
 * lent on its own (`shared/secrets.ts`). In the roster rather than lent
 * beside the token because a node that holds no token still needs to know
 * the channel is on, to send its Kuru's replies to whichever node polls;
 * and because the roster is signed by the parent, so a child cannot add an
 * account to the list.
 *
 * The switch is the one part a child may move too (`TelegramSwitch`), so
 * the roster says when it last moved and from which node. `switchedAt` is
 * absent — not null — in a roster from a parent from before that, which
 * would never take a child's switch in, and a child does not offer one.
 */
export interface SharedTelegram {
  enabled: boolean;
  enabledAt: number | null;
  switchedAt?: number | null;
  switchedBy?: string | null;
  allowed: AllowedUser[];
  bot: TelegramBot | null;
}

/** The roster's copy, checked as the file's own settings are. Null for anything that is not one. */
export function adoptSharedTelegram(value: unknown): SharedTelegram | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const settings = adoptTelegramSettings(raw);
  return {
    enabled: settings.enabled,
    enabledAt: settings.enabledAt,
    ...("switchedAt" in raw ? { switchedAt: settings.switchedAt, switchedBy: settings.switchedBy } : {}),
    allowed: settings.allowed,
    bot: adoptBot(raw.bot),
  };
}

/** What the parent puts in the roster from its own file. */
export function sharedFrom(settings: TelegramSettings, bot: TelegramBot | null): SharedTelegram {
  return { enabled: settings.enabled, enabledAt: settings.enabledAt, switchedAt: settings.switchedAt, switchedBy: settings.switchedBy, allowed: settings.allowed, bot };
}

// ---------------------------------------------------------------------------
// The switch, from any node
// ---------------------------------------------------------------------------

/*
 * The roster is the parent's to sign, so a switch that rode in it alone
 * could only be moved on the Mac — and the Mac is exactly the node that is
 * shut when you are out with a phone and the box at home is the one
 * reading the chat. So the switch has a second road: a node that is
 * flipped makes a `TelegramSwitch`, signs it with its own node key, and
 * hands it to every node it can reach, which hand it on, as they do the
 * roster. Each node goes by the newest word it has, the roster's or a
 * switch's, by the time it was made; the parent writes a newer switch into
 * its own file, and so into the next roster, the moment it hears it, after
 * which the switch has nothing left to say and is dropped.
 *
 * Only the switch. The allow-list is who may give Kuru orders with the
 * user's authority, on every node at once; it stays the parent's to
 * change, by a pairing the user confirms there, so that a child — a box
 * other programs run on — cannot let an account in. The switch only lets
 * the accounts the Mac already allowed in, or keeps them out, and whoever
 * holds the token could read the bot anyway.
 */

/** One node's flip of the shared switch, as it crosses the links. */
export interface TelegramSwitch {
  enabled: boolean;
  /** When it was made, by its node's clock, and never before the switch it replaced (`switchTime`). */
  at: number;
  /** The node that made it. Its key in the roster is what checks `sig`. */
  by: string;
  /** That node told the chat itself. One with no token could not, so the node that reads the chat does. */
  told: boolean;
  /** Ed25519 by `by`'s node key over `switchPayload`, base64. */
  sig: string;
}

/** What a switch's signature covers: every field but the signature, under a label no other signed thing in kururu uses. */
export function switchPayload(change: Omit<TelegramSwitch, "sig">): string {
  return `kururu-telegram-switch\n${JSON.stringify([change.enabled, change.at, change.by, change.told])}`;
}

/** A switch off the wire or the disk, checked to the field; the signature is the receiver's to check against the roster. */
export function asTelegramSwitch(raw: unknown): TelegramSwitch | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled !== "boolean" || typeof r.at !== "number" || !Number.isFinite(r.at) || r.at <= 0) return null;
  if (typeof r.by !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(r.by) || typeof r.sig !== "string" || r.sig.length > 200) return null;
  return { enabled: r.enabled, at: r.at, by: r.by, told: r.told === true, sig: r.sig };
}

/**
 * Whether `b` is a later word than `a`. By time, and a tie — two nodes
 * flipped in the same millisecond — by node id, so every node picks the
 * same one of the two.
 */
export function laterSwitch(a: { at: number; by: string | null } | null, b: { at: number; by: string | null }): boolean {
  if (!a) return true;
  return b.at > a.at || (b.at === a.at && (b.by ?? "") > (a.by ?? ""));
}

/**
 * The time a new flip is made at: now, or just after the word it replaces
 * if that one is stamped later — a node whose clock runs behind another's
 * still makes the newest word when the user flips it, since the user saw
 * the other one first.
 */
export function switchTime(now: number, current: number | null): number {
  return Math.max(now, (current ?? 0) + 1);
}

/** The switch a roster's copy says, as a word to compare a node's against. Null when it never moved. */
export function rosterSwitch(shared: SharedTelegram): { at: number; by: string | null } | null {
  return typeof shared.switchedAt === "number" ? { at: shared.switchedAt, by: shared.switchedBy ?? null } : null;
}

/**
 * The roster's settings with a node's switch over them, when the switch is
 * the later word. On with nobody allowed is still off, as in the file.
 */
export function withSwitch(shared: SharedTelegram, change: TelegramSwitch | null): SharedTelegram {
  if (!change || !laterSwitch(rosterSwitch(shared), change)) return shared;
  const enabled = change.enabled && shared.allowed.length > 0;
  return { ...shared, enabled, enabledAt: enabled ? change.at : null, switchedAt: change.at, switchedBy: change.by };
}

/** A node's name as a person reads it in the chat: "Omarchy", "Box-2". */
export function nodeTitle(name: string): string {
  return name ? `${name[0]!.toUpperCase()}${name.slice(1)}` : name;
}

/** A node as the subject of a sentence: "the Mac" for the one called mac, which is what everybody calls it, else its title. */
export function nodeSubject(name: string): string {
  return name === "mac" ? "the Mac" : nodeTitle(name);
}

/** The same, starting a sentence. */
function Subject(name: string): string {
  const said = nodeSubject(name);
  return `${said[0]!.toUpperCase()}${said.slice(1)}`;
}

/**
 * A line of a node's Kuru as the chat shows it: `[Omarchy] …` for a child,
 * the words alone for the parent, so a chat with one kururu reads as it did
 * before there were nodes, and the Mac — the one the user mostly talks to —
 * carries no noise. The mark goes on before the reply is cut into
 * messages, so only the first of a long reply carries it; every part is
 * remembered as that node's (`rememberSent`), so a reply to any part finds it.
 */
export function markLine(node: string | null, text: string): string {
  return node ? `[${nodeTitle(node)}] ${text}` : text;
}

/**
 * Which node said each line the bot sent, by chat and message id: how a
 * reply in the chat — Telegram's "reply to this message" — reaches the Kuru
 * that said what it replies to. Node ids, so a rename does not lose a line.
 * Oldest first and bounded; a reply to a line older than the map goes to
 * the leader, which is where a bare message goes anyway.
 */
export type ReplyMap = Array<[key: string, node: string]>;

/** Lines remembered. A day of a chatty conversation, with room. */
export const REPLY_MAP_MAX = 500;

function sentKey(chat: string, messageId: number): string {
  return `${chat}:${messageId}`;
}

/** The map with these sent messages remembered as this node's, the oldest dropped past the bound. */
export function rememberSent(map: ReplyMap, chat: string, messageIds: readonly number[], node: string): ReplyMap {
  const keys = new Set(messageIds.map((id) => sentKey(chat, id)));
  const kept = map.filter(([key]) => !keys.has(key));
  return [...kept, ...[...keys].map((key): [string, string] => [key, node])].slice(-REPLY_MAP_MAX);
}

/** The node whose line a message answers, or null. */
export function repliedNode(map: ReplyMap, chat: string, replyTo: number | null): string | null {
  if (replyTo === null) return null;
  const key = sentKey(chat, replyTo);
  for (let i = map.length - 1; i >= 0; i--) if (map[i]![0] === key) return map[i]![1];
  return null;
}

/** Two maps as one, the second's word winning, in the order the second last heard them. */
export function mergeReplies(older: ReplyMap, newer: ReplyMap): ReplyMap {
  const keys = new Set(newer.map(([key]) => key));
  return [...older.filter(([key]) => !keys.has(key)), ...newer].slice(-REPLY_MAP_MAX);
}

/** A member as the routing needs it. */
export interface RouteNode {
  id: string;
  name: string;
}

/** Where a message from the chat goes, and the words that go: without the address that sent it there. */
export interface Route {
  node: string;
  text: string;
  /** What decided it, for the log and the tests. */
  by: "address" | "reply" | "leader";
}

const ROUTE_ADDRESS = /^[@/]([a-z][a-z0-9-]{0,23})(?:@\w+)?(?:[\s,:]+|$)/i;

/**
 * Which node's Kuru a message from the chat is for.
 *
 * An address first: `@omarchy …`, or `/omarchy …`, since Telegram's apps
 * autocomplete `@` against usernames and a `/` is a command the bot's menu
 * can offer. It has to be a member's name and at the very front, so `/compact`
 * is still Kuru's slash command and "ask @omarchy later" is still a sentence.
 * Then a reply to one of a node's lines, by the map. Then the leader, which
 * is the node reading the chat — the Kuru the user is talking to when they
 * name nobody. An address wins over a reply because it is the more
 * deliberate of the two: someone who replies to the Mac's line and writes
 * `@omarchy` in it meant Omarchy.
 */
export function routeOf(input: { text: string; chat: string; replyTo: number | null; map: ReplyMap; nodes: readonly RouteNode[]; leader: string }): Route {
  const match = ROUTE_ADDRESS.exec(input.text);
  const named = match ? input.nodes.find((n) => n.name === match[1]!.toLowerCase()) : undefined;
  if (match && named) return { node: named.id, text: input.text.slice(match[0].length).trim(), by: "address" };
  const replied = repliedNode(input.map, input.chat, input.replyTo);
  if (replied && input.nodes.some((n) => n.id === replied)) return { node: replied, text: input.text, by: "reply" };
  return { node: input.leader, text: input.text, by: "leader" };
}

/** What the chat is told about a message addressed to nobody's words: `@omarchy` alone. */
export function emptyAddress(name: string): string {
  return `Write something after @${name} for ${nodeSubject(name)}'s Kuru.`;
}

/** A time of day the way the chat says it, for "away since 23:10". */
function clockOf(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * What the chat is told once, the first time a message waits for a node
 * that is away: that it waits, and that it is not lost. Once per absence,
 * not per message, since the second message waits the same way.
 */
export function heldLine(name: string, since: number | null): string {
  return `${Subject(name)} is away${since ? ` (since ${clockOf(since)})` : ""}, so this waits for it and reaches its Kuru when it is back.`;
}

/**
 * The one line the chat gets when a node takes the poll over because those
 * ranked above it went away: who answers now, and since when the others
 * were gone — so a reply marked `[Omarchy]` is not a surprise.
 */
export function tookLine(self: string, away: ReadonlyArray<{ name: string; since: number | null }>): string {
  const gone = away.map((a) => `${nodeSubject(a.name)}${a.since ? ` since ${clockOf(a.since)}` : ""}`);
  const said = gone.length === 0 ? "" : gone.length === 1 ? ` ${Subject(away[0]!.name)} has been away${away[0]!.since ? ` since ${clockOf(away[0]!.since)}` : ""}.` : ` Away: ${gone.join(", ")}.`;
  return `${Subject(self)}'s Kuru is in charge.${said}`;
}

/** The line when the poll comes back up the ranks by the handshake. */
export function backLine(self: string): string {
  return `${Subject(self)}'s Kuru is back in charge.`;
}

/**
 * Whether a Kuru's reply goes to the chat at all. Every reply does — a
 * reply to the user anywhere, to a `[kururu]` notice — but one to another
 * Kuru's `ask_kuru` alone, which is two colleagues talking: the asking Kuru
 * hears the answer in its tool call and tells the user in its own words, and
 * the chat would read the same thing twice.
 */
export function postedToChat(origin: TurnOrigin): boolean {
  if (origin.here || origin.channels.length > 0 || origin.peers.length === 0) return true;
  return origin.peers.some((peer) => !peer.startsWith("kuru@"));
}

/**
 * Where the poll stands among the nodes, as Settings → Channels draws it.
 * Null when this node is in no roster that carries the channel: then the
 * page is the one it always was.
 */
export interface LeadStatus {
  /** This node polls now. */
  polls: boolean;
  /** The node that polls, by this node's knowledge: itself, a linked peer that says so, or nobody. */
  holder: string | null;
  /** Whether this node may poll, and why not when it may not. */
  eligible: boolean;
  why: string | null;
  /** On a child: the parent the token is held from; null on the parent. */
  heldFrom: string | null;
  /** A 409 seen and this node standing down until then. */
  standingDownUntil: number | null;
  /** Every member by rank, this node among them. */
  nodes: Array<{ id: string; name: string; rank: number; self: boolean; parent: boolean; up: boolean; since: number | null; eligible: boolean | null; polls: boolean }>;
  /**
   * The switch, as this node goes by it: who last moved it and when, whether
   * that word is still on its way to the parent's roster (`pending`), and
   * why it cannot be turned on or off here — a sentence, or null when it can.
   * Absent from a server from before, which a newer page may be drawn against.
   */
  switch?: { by: string | null; at: number | null; pending: boolean; refuseOn: string | null; refuseOff: string | null };
}

// ---------------------------------------------------------------------------
// What a window is told
// ---------------------------------------------------------------------------

/**
 * Where the link to Telegram stands. `off`: no token, or switched off with
 * nothing being paired. `connecting`: asking, and no answer yet. `listening`:
 * the last poll was answered. `error`: it was not, and `error` says why.
 */
export type ChannelLink = "off" | "connecting" | "listening" | "error";

/**
 * Telegram, as a window draws it. Never the token: `hint` is the last four
 * of it, which is all of it a window ever sees again.
 */
export interface TelegramStatus {
  kind: "telegram";
  /** Null until a token is saved. */
  hint: string | null;
  bot: TelegramBot | null;
  enabled: boolean;
  allowed: AllowedUser[];
  /** The profile it talks to, as this session's id; null for one nobody chose, which is the active one. */
  profileId: string | null;
  speakReplies: boolean;
  link: ChannelLink;
  error: string | null;
  /** A pairing in progress: the code to send, when it stops working, and the account that sent it, waiting to be allowed or refused. */
  pairing: { code: string; until: number; candidate: ChannelUser | null } | null;
  lastInAt: number | null;
  lastOutAt: number | null;
  /** Messages waiting to reach Telegram, because it did not answer. */
  waiting: number;
  /** Messages from accounts not on the list, since the count was last cleared — how Settings says somebody found the bot. */
  ignored: { count: number; lastAt: number | null; last: string | null };
  /** Who polls among the nodes, when this node is in a roster that carries the channel; null otherwise. */
  lead: LeadStatus | null;
}

export interface ChannelsStatus {
  telegram: TelegramStatus;
}

/**
 * Whether a channel is set up enough to switch on: a token, and somebody to
 * talk to. The drawer's switch is only drawn for one that is.
 */
export function channelReady(status: Pick<TelegramStatus, "hint" | "allowed">): boolean {
  return status.hint !== null && status.allowed.length > 0;
}
