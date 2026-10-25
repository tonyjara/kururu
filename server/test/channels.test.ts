/**
 * Channels: that only the user's own account reaches Kuru, that the token
 * never comes back out, and that the conversation reads the same in the chat
 * as in the drawer.
 *
 * Two halves. The decisions in `shared/channels.ts` are arithmetic and are
 * held to it directly — every way a message can fail to be the user's, in
 * the order `judge` asks. Then `TelegramChannel` is run against a stand-in
 * Bot API in memory, with the config and state directories in a temp dir, so
 * what is tested is the module the server runs — the poll, the offset, the
 * queue, the file's mode — without a request ever leaving the process.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CHUNK_MAX,
  PAIRING_MS,
  adoptSharedTelegram,
  adoptTelegramSettings,
  answeredWords,
  asTelegramSwitch,
  laterSwitch,
  switchPayload,
  switchTime,
  withSwitch,
  carriesCode,
  channelMessageId,
  channelOfMessage,
  channelOfPrompt,
  channelWords,
  chunkText,
  cleanText,
  echoLine,
  judge,
  pairingCode,
  pairingLink,
  replySpoken,
  tokenHint,
  updatesFrom,
  userLabel,
  validTelegramToken,
  type IncomingMessage,
  type JudgeContext,
} from "../../shared/channels";
import { mergeConversation, plainWords, type YouItem } from "../../shared/kuru";
import { replyClock, splitReply } from "../../shared/reply";
import { viaOf, type Turn } from "../../shared/store";
import { isClipId } from "../../shared/voice";
import { Channels } from "../src/channels";
import { TelegramChannel, type Fetch, type TelegramDeps } from "../src/telegram";

const ME = "111222333";
const STRANGER = "999888777";
const TOKEN = `123456789:${"AAH-x_".repeat(6)}`;

function message(over: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    updateId: 1,
    messageId: 10,
    chatId: ME,
    chatType: "private",
    from: { id: ME, name: "Sam", username: "sam", bot: false },
    at: 50_000,
    text: "check the build",
    ...over,
  };
}

const ON: JudgeContext = { allowed: [ME], enabled: true, enabledAt: 10_000, pairing: null, now: 60_000 };

describe("judge", () => {
  it("passes a private message from an allowed account", () => {
    expect(judge(message(), ON)).toEqual({ kind: "pass", text: "check the build" });
  });

  it("ignores everybody else, and counts who", () => {
    const verdict = judge(message({ chatId: STRANGER, from: { id: STRANGER, name: "Eve", username: null, bot: false } }), ON);
    expect(verdict).toEqual({ kind: "ignore", who: { id: STRANGER, name: "Eve", username: null } });
  });

  it("ignores the allowed account in a group, where a reply is a reply to everybody", () => {
    expect(judge(message({ chatId: "-100200", chatType: "supergroup" }), ON).kind).toBe("ignore");
  });

  it("ignores a private chat whose id is not its sender's, and a bot, and a channel post", () => {
    expect(judge(message({ chatId: STRANGER }), ON).kind).toBe("ignore");
    expect(judge(message({ from: { id: ME, name: null, username: null, bot: true } }), ON).kind).toBe("ignore");
    expect(judge(message({ from: null, chatType: "channel" }), ON)).toEqual({ kind: "ignore", who: null });
  });

  it("says off, rather than passing, while the channel is off", () => {
    expect(judge(message(), { ...ON, enabled: false })).toEqual({ kind: "off" });
  });

  it("drops what was sent before the switch went on, but not in the same second", () => {
    expect(judge(message({ at: 5_000 }), ON)).toEqual({ kind: "stale" });
    expect(judge(message({ at: 9_000 }), { ...ON, enabledAt: 9_400 }).kind).toBe("pass");
  });

  it("answers /start itself and gives Kuru nothing", () => {
    expect(judge(message({ text: "/start" }), ON)).toEqual({ kind: "start" });
    expect(judge(message({ text: "/start@kuru_bot" }), ON)).toEqual({ kind: "start" });
    expect(judge(message({ text: "/compact" }), ON)).toEqual({ kind: "pass", text: "/compact" });
  });

  it("says a photo cannot be passed on, and so is an empty message", () => {
    expect(judge(message({ text: null }), ON)).toEqual({ kind: "unsupported" });
    expect(judge(message({ text: "\u0003\u001b" }), ON)).toEqual({ kind: "unsupported" });
  });

  it("takes the pairing code from an account not yet on the list", () => {
    const ctx: JudgeContext = { ...ON, allowed: [], enabled: false, pairing: { code: "K7Q2P9", until: 70_000 } };
    const stranger = message({ chatId: STRANGER, from: { id: STRANGER, name: "Sam", username: null, bot: false } });
    expect(judge({ ...stranger, text: "/start K7Q2P9" }, ctx)).toEqual({ kind: "pair", user: { id: STRANGER, name: "Sam", username: null } });
    expect(judge({ ...stranger, text: "k7q2p9" }, ctx).kind).toBe("pair");
    expect(judge({ ...stranger, text: "my code is K7Q2P9" }, ctx).kind).toBe("ignore");
    expect(judge({ ...stranger, text: "K7Q2P9" }, { ...ctx, now: 80_000 }).kind).toBe("ignore");
  });

  it("never pairs a group", () => {
    const ctx: JudgeContext = { ...ON, pairing: { code: "K7Q2P9", until: 70_000 } };
    expect(judge(message({ chatId: "-5", chatType: "group", text: "K7Q2P9" }), ctx).kind).toBe("ignore");
  });

  it("takes control characters out of what will be typed into a terminal", () => {
    expect(cleanText("stop\u0003 now\u001b[2J\r\nplease\t ")).toBe("stop now[2J\nplease");
  });
});

describe("pairing", () => {
  it("makes six characters from the unambiguous alphabet, the same for the same bytes", () => {
    const code = pairingCode(new Uint8Array([0, 1, 2, 31, 32, 255]));
    expect(code).toBe("ABC9A9");
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
  });

  it("reads the code alone, through a /start link, with spaces or a dash", () => {
    expect(carriesCode("K7Q 2P9", "K7Q2P9")).toBe(true);
    expect(carriesCode("/start K7Q2P9", "K7Q2P9")).toBe(true);
    expect(carriesCode("K7Q-2P9", "K7Q2P9")).toBe(true);
    expect(carriesCode("K7Q2P", "K7Q2P9")).toBe(false);
  });

  it("links to the bot with the code as the start parameter", () => {
    expect(pairingLink("kuru_bot", "K7Q2P9")).toBe("https://t.me/kuru_bot?start=K7Q2P9");
  });
});

describe("the words", () => {
  it("marks a channel's message for Kuru, and leaves a slash command bare", () => {
    expect(channelWords("telegram", "check the build")).toBe("[telegram] check the build");
    expect(channelWords("telegram", "/compact")).toBe("/compact");
  });

  it("reads the mark back as a turn's origin, and takes it off for the drawer", () => {
    expect(viaOf("[telegram] check the build")).toBe("telegram");
    expect(viaOf("[voice] check the build")).toBe("voice");
    expect(viaOf("check the build")).toBe("typed");
    expect(channelOfPrompt("[telegram] x")).toBe("telegram");
    expect(plainWords("[telegram] check the build")).toBe("check the build");
  });

  it("mints an outbox id the outbox accepts and no window would", () => {
    const id = channelMessageId("telegram", ME, 4521);
    expect(id).toBe(`telegram-${ME}-4521`);
    expect(isClipId(id)).toBe(true);
    expect(channelOfMessage(id)).toBe("telegram");
    expect(channelOfMessage(crypto.randomUUID())).toBeNull();
  });

  it("labels your own words from here, which go to the chat quietly", () => {
    expect(echoLine("voice", "check the build")).toBe("🎙 You said: check the build");
    expect(echoLine("typed", "/compact")).toBe("⌨️ You typed: /compact");
  });

  it("splits a long reply at a paragraph, and never through an emoji", () => {
    expect(chunkText("short")).toEqual(["short"]);
    const para = "a".repeat(CHUNK_MAX - 100);
    expect(chunkText(`${para}\n\n${"b".repeat(300)}`)).toEqual([para, "b".repeat(300)]);
    const emoji = `${"x".repeat(9)}😀${"y".repeat(10)}`;
    const parts = chunkText(emoji, 10);
    expect(parts.join("")).toBe(emoji);
    for (const part of parts) expect(part).not.toMatch(/^[\udc00-\udfff]|[\ud800-\udbff]$/);
  });
});

describe("replySpoken", () => {
  it("speaks a turn with nothing in it — a [kururu] notice — and one with anything from here", () => {
    expect(replySpoken(new Set(), false)).toBe(true);
    expect(replySpoken(new Set(["voice"]), false)).toBe(true);
    expect(replySpoken(new Set(["telegram", "typed"]), false)).toBe(true);
  });

  it("keeps quiet for a turn that answered only a channel, unless asked to speak", () => {
    expect(replySpoken(new Set(["telegram"]), false)).toBe(false);
    expect(replySpoken(new Set(["telegram"]), true)).toBe(true);
  });
});

describe("settings and the token", () => {
  it("reads on-with-nobody-allowed as off, and takes ids as strings", () => {
    expect(adoptTelegramSettings({ enabled: true, allowed: [] }).enabled).toBe(false);
    const settings = adoptTelegramSettings({ enabled: true, enabledAt: 5, allowed: [{ id: 111222333 }, { id: "111222333" }, { id: "-5" }, { id: "x" }] });
    expect(settings.allowed.map((u) => u.id)).toEqual(["111222333"]);
    expect(settings.enabled).toBe(true);
    expect(settings.enabledAt).toBe(5);
  });

  it("takes a token's shape and refuses what would change the URL", () => {
    expect(validTelegramToken(TOKEN)).toBe(true);
    expect(validTelegramToken(`${TOKEN}/getMe`)).toBe(false);
    expect(validTelegramToken(`${TOKEN}\n`)).toBe(false);
    expect(validTelegramToken("123:short")).toBe(false);
    expect(tokenHint(TOKEN)).toBe(`…${TOKEN.slice(-4)}`);
  });

  it("names an account by what it showed", () => {
    expect(userLabel({ id: ME, name: "Sam", username: "sam" })).toBe("Sam (@sam)");
    expect(userLabel({ id: ME, name: null, username: null })).toBe(`id ${ME}`);
  });
});

describe("updatesFrom", () => {
  it("counts every update toward the offset, and keeps the messages", () => {
    const body = {
      ok: true,
      result: [
        { update_id: 7, message: { message_id: 1, date: 100, chat: { id: 111, type: "private" }, from: { id: 111, is_bot: false, first_name: "Sa", last_name: "M", username: "sam" }, text: "hi" } },
        { update_id: 9, edited_message: { message_id: 1 } },
        { update_id: 8, message: { message_id: 2, date: 101, chat: { id: 111, type: "private" }, from: { id: 111, is_bot: false }, photo: [] } },
      ],
    };
    const got = updatesFrom(body)!;
    expect(got.last).toBe(9);
    expect(got.messages).toHaveLength(2);
    expect(got.messages[0]).toMatchObject({ chatId: "111", at: 100_000, text: "hi", from: { id: "111", name: "Sa M", username: "sam", bot: false } });
    expect(got.messages[1]!.text).toBeNull();
    expect(updatesFrom({ ok: false })).toBeNull();
  });

  it("keeps what a reply answers: its words, when, whether the bot said it, and the part quoted", () => {
    const got = updatesFrom({
      ok: true,
      result: [
        {
          update_id: 1,
          message: {
            message_id: 9,
            date: 200,
            chat: { id: 111, type: "private" },
            from: { id: 111, is_bot: false },
            text: "yes",
            reply_to_message: { message_id: 8, date: 100, from: { id: 5, is_bot: true }, text: "Want me to go ahead?" },
            quote: { text: "go ahead", position: 8 },
          },
        },
        { update_id: 2, message: { message_id: 10, date: 300, chat: { id: 111, type: "private" }, from: { id: 111, is_bot: false }, text: "no reply" } },
        { update_id: 3, message: { message_id: 11, date: 300, chat: { id: 111, type: "private" }, from: { id: 111, is_bot: false }, text: "x", reply_to_message: { message_id: 4, from: { id: 111, is_bot: false }, caption: "a photo" } } },
      ],
    })!;
    expect(got.messages[0]!.answered).toEqual({ text: "Want me to go ahead?", at: 100_000, bot: true, quote: "go ahead" });
    expect(got.messages[1]!.answered).toBeUndefined();
    // No date of its own is the reply's, and a caption is a photo's words.
    expect(got.messages[2]!.answered).toEqual({ text: "a photo", at: 300_000, bot: false, quote: null });
  });
});

/**
 * A reply in the chat reaches Kuru saying which line it answers, in the
 * drawer's own words for it, so "yes" to one of two questions is yes to that
 * one — what the reply map, which only picks the node, never told Kuru.
 */
describe("answeredWords", () => {
  const now = new Date(2026, 9, 25, 21, 0).getTime();
  const at = new Date(2026, 9, 25, 18, 42).getTime();
  const kuru = { text: "Want me to tell the API agent to go ahead?", at, bot: true, quote: null };

  it("puts Kuru's line in front of the words, with no id, which Telegram's are not", () => {
    const words = answeredWords("yes", kuru, now);
    expect(words).toBe('[reply to Kuru 18:42 "Want me to tell the API agent to go ahead?"] yes');
    expect(splitReply(words)).toEqual({ ref: { who: "Kuru", when: "18:42", quote: "Want me to tell the API agent to go ahead?", id: null }, text: "yes" });
  });

  it("quotes the part picked with Telegram's quote, rather than the whole line", () => {
    expect(splitReply(answeredWords("yes", { ...kuru, quote: "go ahead" }, now))?.ref.quote).toBe("go ahead");
  });

  it("knows your own words, echoed by the bot or written by you, as yours", () => {
    expect(splitReply(answeredWords("and prod", { ...kuru, text: echoLine("typed", "deploy staging") }, now))?.ref).toMatchObject({ who: "me", quote: "deploy staging" });
    expect(splitReply(answeredWords("and prod", { ...kuru, text: echoLine("voice", "deploy staging") }, now))?.ref).toMatchObject({ who: "me", quote: "deploy staging" });
    expect(splitReply(answeredWords("and prod", { ...kuru, text: "deploy staging", bot: false }, now))?.ref).toMatchObject({ who: "me", quote: "deploy staging" });
  });

  it("drops a child's mark, since the words reach that child's own Kuru", () => {
    expect(splitReply(answeredWords("yes", { ...kuru, text: "[Omarchy] The build is red. Retry?" }, now))?.ref.quote).toBe("The build is red. Retry?");
    // A bracket that is not a node's title stays.
    expect(splitReply(answeredWords("yes", { ...kuru, text: "[voice] heard" }, now))?.ref.quote).toBe("[voice] heard");
  });

  it("leaves a slash command, a line with no words, and a message that answers nothing as they came", () => {
    expect(answeredWords("/compact", kuru, now)).toBe("/compact");
    expect(answeredWords("yes", { ...kuru, text: null }, now)).toBe("yes");
    expect(answeredWords("yes", undefined, now)).toBe("yes");
  });

  it("says the day of a line from another day", () => {
    const yesterday = new Date(2026, 9, 24, 18, 42).getTime();
    expect(splitReply(answeredWords("yes", { ...kuru, at: yesterday }, now))?.ref.when).toBe(replyClock(yesterday, now));
    expect(replyClock(yesterday, now)).toBe("Oct 24 18:42");
  });
});

describe("the drawer", () => {
  it("marks a Telegram turn, and a Telegram message still on its way", () => {
    const turns: Turn[] = [{ id: 1, conversationId: "s", at: 1_000, role: "you", via: "telegram", text: "[telegram] check the build", lang: null, voiceId: "telegram-111-1" }];
    const outbox = [
      { id: "telegram-111-1", at: 990, ms: 0, state: "delivered" as const, text: "check the build", typedAt: 995, note: null },
      { id: "telegram-111-2", at: 2_000, ms: 0, state: "queued" as const, text: "and the tests", typedAt: null, note: null },
    ];
    const items = mergeConversation({ turns, outbox, missed: [] }).filter((item): item is YouItem => item.kind === "you");
    expect(items.map((item) => [item.via, item.text])).toEqual([
      ["telegram", "check the build"],
      ["telegram", "and the tests"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// The channel, against a stand-in Bot API
// ---------------------------------------------------------------------------

/**
 * A Bot API in memory. Updates are queued with `deliver` and handed to the
 * next `getUpdates`; with none queued, a poll is held until it is aborted or
 * a little time passes, the way Telegram's long poll is, so the loop never
 * spins. Every call is recorded with its method and parameters.
 */
function fakeTelegram() {
  const calls: { method: string; params: Record<string, unknown>; url: string }[] = [];
  const pending: unknown[] = [];
  let nextUpdate = 100;
  const replies = new Map<string, () => { status: number; body: unknown }>();
  let waiters: (() => void)[] = [];
  const fetch: Fetch = async (url, init) => {
    const method = url.slice(url.lastIndexOf("/") + 1);
    const params = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
    calls.push({ method, params, url });
    const scripted = replies.get(method);
    if (scripted) {
      const { status, body } = scripted();
      return new Response(JSON.stringify(body), { status });
    }
    if (method === "getMe") return Response.json({ ok: true, result: { id: 123456789, is_bot: true, first_name: "Kuru", username: "kuru_test_bot" } });
    if (method === "getWebhookInfo") return Response.json({ ok: true, result: { url: "" } });
    if (method === "getUpdates") {
      if (pending.length === 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 30);
          waiters.push(resolve);
          init.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        });
      }
      const result = pending.splice(0);
      return Response.json({ ok: true, result });
    }
    if (method === "getChat") return Response.json({ ok: true, result: { id: Number(params.chat_id), first_name: "Sam", username: "sam" } });
    return Response.json({ ok: true, result: { message_id: calls.length } });
  };
  return {
    fetch,
    calls,
    replies,
    deliver(from: string, text: string | null, chat = from, extra: Record<string, unknown> = {}) {
      pending.push({
        update_id: nextUpdate++,
        message: { message_id: nextUpdate, date: Math.floor(Date.now() / 1000) + 1, chat: { id: Number(chat), type: Number(chat) < 0 ? "group" : "private" }, from: { id: Number(from), is_bot: false, first_name: "Sam" }, ...(text === null ? { photo: [] } : { text }), ...extra },
      });
      for (const wake of waiters.splice(0)) wake();
    },
    sent: () => calls.filter((c) => c.method === "sendMessage").map((c) => ({ chat: String(c.params.chat_id), text: String(c.params.text), silent: c.params.disable_notification === true })),
  };
}

let dir: string;
const was: Record<string, string | undefined> = {};
let open: TelegramChannel[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kururu-channels-"));
  for (const name of ["KURURU_STATE_DIR", "XDG_CONFIG_HOME", "KURURU_TELEGRAM_API"]) was[name] = process.env[name];
  process.env.KURURU_STATE_DIR = join(dir, "state");
  process.env.XDG_CONFIG_HOME = join(dir, "config");
  process.env.KURURU_TELEGRAM_API = "http://telegram.invalid";
});

afterEach(() => {
  for (const channel of open) channel.close();
  open = [];
  for (const [name, value] of Object.entries(was)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

function channel(fake: ReturnType<typeof fakeTelegram>, over: Partial<TelegramDeps> = {}) {
  const said: { profileKey: string; id: string; text: string }[] = [];
  const made = new TelegramChannel({
    say: (profileKey, id, _at, text) => said.push({ profileKey, id, text }),
    profileKeyFor: (chosen) => chosen ?? "pk-main",
    profileIdOf: (key) => (key === "pk-main" ? "p1" : null),
    kuruBusy: () => false,
    changed: () => {},
    fetch: fake.fetch,
    ...over,
  });
  open.push(made);
  made.start();
  return { channel: made, said };
}

async function until(test: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!test()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function ready(fake: ReturnType<typeof fakeTelegram>, over: Partial<TelegramDeps> = {}) {
  const made = channel(fake, over);
  await made.channel.setToken(TOKEN);
  await made.channel.allow(ME);
  made.channel.set({ enabled: true });
  return made;
}

describe("TelegramChannel", () => {
  it("refuses a malformed token without asking anybody", async () => {
    const fake = fakeTelegram();
    const { channel: c } = channel(fake);
    await expect(c.setToken("not a token")).rejects.toThrow(/does not look like a bot token/);
    expect(fake.calls).toHaveLength(0);
  });

  it("keeps the token owner-only and never hands it back", async () => {
    const fake = fakeTelegram();
    const { channel: c } = channel(fake);
    const status = await c.setToken(`  ${TOKEN}\n`);
    const file = join(dir, "config", "kururu", "telegram.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8")).token).toBe(TOKEN);
    expect(JSON.stringify(status)).not.toContain(TOKEN.split(":")[1]!);
    expect(status.bot).toEqual({ id: "123456789", username: "kuru_test_bot", name: "Kuru" });
    expect(status.hint).toBe(tokenHint(TOKEN));
  });

  it("refuses a bot that something else reads through a webhook", async () => {
    const fake = fakeTelegram();
    fake.replies.set("getWebhookInfo", () => ({ status: 200, body: { ok: true, result: { url: "https://example.com/hook/abc" } } }));
    const { channel: c } = channel(fake);
    await expect(c.setToken(TOKEN)).rejects.toThrow(/webhook at example.com/);
    expect(existsSync(join(dir, "config", "kururu", "telegram.json"))).toBe(false);
  });

  it("will not switch on without a token or anybody allowed", async () => {
    const fake = fakeTelegram();
    const { channel: c } = channel(fake);
    expect(() => c.set({ enabled: true })).toThrow(/token first/);
    await c.setToken(TOKEN);
    expect(() => c.set({ enabled: true })).toThrow(/Pair your Telegram account/);
  });

  it("does not poll while off and not pairing", async () => {
    const fake = fakeTelegram();
    const { channel: c } = channel(fake);
    await c.setToken(TOKEN);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fake.calls.some((call) => call.method === "getUpdates")).toBe(false);
    expect(c.status().link).toBe("off");
  });

  it("passes the allowed account's words to the outbox, and nobody else's", async () => {
    const fake = fakeTelegram();
    const { channel: c, said } = await ready(fake);
    fake.deliver(STRANGER, "delete everything");
    fake.deliver(ME, "check the build");
    await until(() => said.length === 1);
    expect(said[0]).toMatchObject({ profileKey: "pk-main", text: "check the build" });
    expect(said[0]!.id).toMatch(new RegExp(`^telegram-${ME}-\\d+$`));
    await until(() => c.status().ignored.count === 1);
    expect(c.status().ignored.last).toContain(STRANGER);
    // The stranger got no answer at all.
    expect(fake.sent().filter((m) => m.chat === STRANGER)).toEqual([]);
    expect(c.status().link).toBe("listening");
  });

  it("passes a reply on with the line it answers in front", async () => {
    const fake = fakeTelegram();
    const { said } = await ready(fake);
    const date = Math.floor(Date.now() / 1000) - 60;
    fake.deliver(ME, "yes", ME, { reply_to_message: { message_id: 3, date, from: { id: 123456789, is_bot: true }, text: "Want me to tell the API agent to go ahead?" } });
    fake.deliver(ME, "/compact", ME, { reply_to_message: { message_id: 3, date, from: { id: 123456789, is_bot: true }, text: "Done." } });
    await until(() => said.length === 2);
    expect(said[0]!.text).toBe(`[reply to Kuru ${replyClock(date * 1000, Date.now())} "Want me to tell the API agent to go ahead?"] yes`);
    expect(said[1]!.text).toBe("/compact");
  });

  it("confirms what it read, and a new server starts from there", async () => {
    const fake = fakeTelegram();
    const { channel: c, said } = await ready(fake);
    fake.deliver(ME, "one");
    await until(() => said.length === 1);
    await until(() => JSON.parse(readFileSync(join(dir, "state", "telegram.json"), "utf8")).offset === 101);
    c.close();
    const again = channel(fake);
    const polls = () => fake.calls.filter((call) => call.method === "getUpdates");
    const before = polls().length;
    await until(() => polls().length > before);
    expect(polls().at(-1)!.params.offset).toBe(101);
    again.channel.close();
  });

  it("sends Kuru's replies to every allowed account, your own words quietly, and only for its profile", async () => {
    const fake = fakeTelegram();
    const { channel: c } = await ready(fake);
    const before = fake.sent().length;
    c.post("pk-main", "The build passed.");
    c.post("pk-main", "🎙 You said: and the tests", { silent: true });
    c.post("pk-other", "Not for this chat.");
    await until(() => fake.sent().length === before + 2);
    expect(fake.sent().slice(before)).toEqual([
      { chat: ME, text: "The build passed.", silent: false },
      { chat: ME, text: "🎙 You said: and the tests", silent: true },
    ]);
  });

  it("sends nothing once switched off, not even a line that says so", async () => {
    const fake = fakeTelegram();
    const { channel: c, said } = await ready(fake);
    const sent = fake.sent().length;
    c.set({ enabled: false });
    c.post("pk-main", "a reply");
    fake.deliver(ME, "are you there");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fake.sent().length).toBe(sent);
    expect(said).toEqual([]);
  });

  it("drops what was sent while it was off, with one line for all of it", async () => {
    const fake = fakeTelegram();
    const { channel: c, said } = channel(fake);
    await c.setToken(TOKEN);
    await c.allow(ME);
    fake.deliver(ME, "sent while off", ME, { date: Math.floor(Date.now() / 1000) - 120 });
    fake.deliver(ME, "also while off", ME, { date: Math.floor(Date.now() / 1000) - 60 });
    c.set({ enabled: true });
    await until(() => fake.sent().some((m) => m.text.includes("2 messages sent while")));
    expect(said).toEqual([]);
  });

  it("pairs the account that sends the code, once the Mac says yes", async () => {
    const fake = fakeTelegram();
    const { channel: c, said } = channel(fake);
    await c.setToken(TOKEN);
    const code = c.pair(true).pairing!.code;
    expect(c.status().pairing!.until).toBeGreaterThan(Date.now() + PAIRING_MS - 1000);
    fake.deliver(STRANGER, "hello");
    fake.deliver(ME, `/start ${code}`);
    await until(() => c.status().pairing?.candidate !== null && c.status().pairing?.candidate !== undefined);
    expect(c.status().pairing!.candidate!.id).toBe(ME);
    expect(c.status().allowed).toEqual([]);
    await c.allow(ME);
    expect(c.status().allowed.map((u) => u.id)).toEqual([ME]);
    expect(c.status().pairing).toBeNull();
    await until(() => fake.sent().some((m) => m.chat === ME && m.text.startsWith("Paired.")));
    expect(said).toEqual([]);
  });

  it("waits out a rate limit, and keeps the order", async () => {
    const fake = fakeTelegram();
    const { channel: c } = await ready(fake);
    let refused = false;
    fake.replies.set("sendMessage", () => {
      if (!refused) {
        refused = true;
        return { status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 0.05 } } };
      }
      return { status: 200, body: { ok: true, result: {} } };
    });
    c.post("pk-main", "first");
    c.post("pk-main", "second");
    await until(() => c.status().waiting === 0);
    const texts = fake.calls.filter((call) => call.method === "sendMessage").map((call) => call.params.text);
    expect(texts.slice(-3)).toEqual(["first", "first", "second"]);
  });

  it("says what to do when the account never pressed Start", async () => {
    const fake = fakeTelegram();
    const { channel: c } = await ready(fake);
    fake.replies.set("sendMessage", () => ({ status: 403, body: { ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" } }));
    c.post("pk-main", "hello");
    await until(() => c.status().error !== null);
    expect(c.status().error).toContain("presses Start");
    expect(c.status().waiting).toBe(0);
  });

  it("never lets the token into an error", async () => {
    const fake = fakeTelegram();
    const { channel: c } = await ready(fake);
    fake.replies.set("getUpdates", () => ({ status: 500, body: { ok: false, error_code: 500, description: `boom at /bot${TOKEN}/getUpdates` } }));
    await until(() => (c.status().error ?? "").includes("boom"), 8000);
    expect(c.status().error).not.toContain(TOKEN);
    expect(c.status().error).toContain("<token>");
  }, 10_000);

  it("stops asking when Telegram no longer knows the token", async () => {
    const fake = fakeTelegram();
    const { channel: c } = await ready(fake);
    fake.replies.set("getUpdates", () => ({ status: 401, body: { ok: false, error_code: 401, description: "Unauthorized" } }));
    await until(() => c.status().link === "error");
    const polls = fake.calls.filter((call) => call.method === "getUpdates").length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fake.calls.filter((call) => call.method === "getUpdates").length).toBe(polls);
    expect(c.status().error).toContain("revoked");
  });

  it("forgets everything when asked", async () => {
    const fake = fakeTelegram();
    const { channel: c } = await ready(fake);
    c.forget();
    expect(existsSync(join(dir, "config", "kururu", "telegram.json"))).toBe(false);
    expect(c.status()).toMatchObject({ hint: null, bot: null, enabled: false, allowed: [], link: "off" });
  });
});

describe("Channels", () => {
  it("keeps quiet for a reply to Telegram alone, and sends every reply to the chat", async () => {
    const fake = fakeTelegram();
    const channels = new Channels({
      broadcast: () => {},
      say: () => {},
      profileKeyFor: (chosen) => chosen ?? "pk-main",
      profileIdOf: () => "p1",
      kuruBusy: () => false,
      fetch: fake.fetch,
    });
    open.push(channels.telegram);
    channels.start();
    await channels.telegram.setToken(TOKEN);
    await channels.telegram.allow(ME);
    channels.telegram.set({ enabled: true });

    channels.prompted("pk-main", "[telegram] check the build");
    expect(channels.speaks("pk-main")).toBe(false);
    channels.replied("pk-main", "The build passed.");
    // A notice's turn has no prompt in it, and is spoken.
    expect(channels.speaks("pk-main")).toBe(true);

    channels.prompted("pk-main", "[voice] and the tests");
    expect(channels.speaks("pk-main")).toBe(true);
    channels.replied("pk-main", "They passed too.");

    // A reply typed in the drawer is echoed as a person reads it, not as the brackets Kuru reads.
    channels.prompted("pk-main", '[reply to Kuru 18:42 "Want me to retry?" (t12)] yes');
    channels.replied("pk-main", "Retrying.");

    channels.prompted("pk-main", "[telegram] and lint");
    channels.delivered("pk-main", { id: crypto.randomUUID(), ms: 4_000 });
    expect(channels.speaks("pk-main")).toBe(true);
    channels.replied("pk-main", "Lint is clean.");

    // A notice is kururu's, not the user's: it stays here, and does not make
    // a Telegram turn a spoken one.
    const notice = '<cross-session-message from-name="kururu (no reply)" from-mode="bypass">\n[kururu] "the API agent" finished its turn. It said: the key is sk-123\n</cross-session-message>';
    channels.prompted("pk-main", "[telegram] what is the API agent doing");
    channels.prompted("pk-main", notice);
    expect(channels.speaks("pk-main")).toBe(false);
    channels.replied("pk-main", "It finished.");
    channels.prompted("pk-main", notice);
    expect(channels.speaks("pk-main")).toBe(true);
    // Nor is a background task's report, which arrives the same way.
    channels.prompted("pk-main", '<task-notification>\n<summary>Agent "research" finished</summary>\n</task-notification>');

    await until(() => fake.sent().some((m) => m.text === "It finished."));
    const texts = fake.sent().map((m) => m.text);
    expect(texts).toContain("The build passed.");
    expect(texts).toContain("🎙 You said: and the tests");
    expect(texts).toContain("They passed too.");
    expect(texts).toContain('⌨️ You typed: ↩ Kuru 18:42: "Want me to retry?"\nyes');
    expect(texts).not.toContain("⌨️ You typed: [telegram] check the build");
    expect(texts.some((t) => t.includes("sk-123") || t.includes("cross-session") || t.includes("task-notification"))).toBe(false);
    channels.close();
  });

  it("tells the chat when one of its messages failed, once, and not what failed before it started", () => {
    const fake = fakeTelegram();
    const warned: string[] = [];
    const channels = new Channels({ broadcast: () => {}, say: () => {}, profileKeyFor: () => "pk-main", profileIdOf: () => "p1", kuruBusy: () => false, fetch: fake.fetch });
    open.push(channels.telegram);
    channels.telegram.warn = (_key, text) => void warned.push(text);
    const entry = (id: string, state: "queued" | "failed") => ({ id, profileId: "p1", at: 1, ms: 0, state, text: "check the build", lang: null, typedAt: null, note: state === "failed" ? "Typed twice, and Kuru never took it." : null });
    channels.outboxMoved([entry("telegram-1-1", "failed")], () => "pk-main");
    expect(warned).toEqual([]);
    channels.outboxMoved([entry("telegram-1-1", "failed"), entry("telegram-1-2", "queued"), entry("abc-uuid-x", "queued")], () => "pk-main");
    channels.outboxMoved([entry("telegram-1-1", "failed"), entry("telegram-1-2", "failed"), entry("abc-uuid-x", "failed")], () => "pk-main");
    channels.outboxMoved([entry("telegram-1-2", "failed")], () => "pk-main");
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('"check the build" did not reach Kuru');
  });
});

describe("the switch from any node", () => {
  const allowed = [{ id: "111222333", name: "Sam", username: null, addedAt: 1 }];
  const roster = adoptSharedTelegram({ enabled: true, enabledAt: 100, switchedAt: 100, switchedBy: "n0000000000a1", allowed, bot: null })!;
  const flip = (enabled: boolean, at: number, by = "n0000000000b2") => ({ enabled, at, by, told: true, sig: "s" });

  it("tells a roster from a parent that takes flips from one that predates them", () => {
    expect(roster.switchedAt).toBe(100);
    const old = adoptSharedTelegram({ enabled: true, enabledAt: 100, allowed, bot: null })!;
    expect("switchedAt" in old).toBe(false);
    expect(adoptSharedTelegram({ enabled: false, enabledAt: null, switchedAt: null, allowed, bot: null })!.switchedAt).toBeNull();
  });

  it("goes by the later word, a tie by node id, and on with nobody allowed is off", () => {
    expect(withSwitch(roster, flip(false, 99))).toBe(roster);
    expect(withSwitch(roster, flip(false, 101))).toMatchObject({ enabled: false, enabledAt: null, switchedAt: 101, switchedBy: "n0000000000b2" });
    expect(withSwitch({ ...roster, enabled: false }, flip(true, 150))).toMatchObject({ enabled: true, enabledAt: 150 });
    expect(withSwitch({ ...roster, allowed: [] }, flip(true, 150)).enabled).toBe(false);
    expect(laterSwitch({ at: 5, by: "a" }, { at: 5, by: "b" })).toBe(true);
    expect(laterSwitch({ at: 5, by: "b" }, { at: 5, by: "a" })).toBe(false);
    expect(laterSwitch(null, { at: 1, by: null })).toBe(true);
  });

  it("stamps a new flip after the word it replaces, whatever this clock says", () => {
    expect(switchTime(1_000, 400)).toBe(1_000);
    expect(switchTime(1_000, 5_000)).toBe(5_001);
    expect(switchTime(1_000, null)).toBe(1_000);
  });

  it("checks a flip off the wire, and signs every field but the signature", () => {
    expect(asTelegramSwitch(flip(true, 5))).toEqual(flip(true, 5));
    expect(asTelegramSwitch({ ...flip(true, 5), at: Number.NaN })).toBeNull();
    expect(asTelegramSwitch({ ...flip(true, 5), enabled: "yes" })).toBeNull();
    expect(asTelegramSwitch({ ...flip(true, 5), by: "../x" })).toBeNull();
    const { sig: _sig, ...unsigned } = flip(true, 5);
    expect(switchPayload(unsigned)).not.toBe(switchPayload({ ...unsigned, enabled: false }));
    expect(switchPayload(unsigned)).not.toBe(switchPayload({ ...unsigned, told: false }));
  });
});
