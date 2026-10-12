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
  allowed: AllowedUser[];
  /** The profile whose Kuru it talks to, by key. Null until chosen, which reads as the active profile. */
  profileKey: string | null;
  /** Also read Kuru's replies to Telegram messages aloud on this Mac. Off: see `replySpoken`. */
  speakReplies: boolean;
}

export const TELEGRAM_DEFAULTS: TelegramSettings = { enabled: false, enabledAt: null, allowed: [], profileKey: null, speakReplies: false };

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
  return { updateId, messageId: raw.message_id, chatId: String(chat.id), chatType: chat.type, from, at, text: typeof raw.text === "string" ? raw.text : null };
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
