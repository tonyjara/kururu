/**
 * One Telegram between two nodes, run: the Mac and a box, each a real
 * `TelegramChannel` and a real `TelegramLead`, on a pair of stand-in links
 * and one stand-in Bot API that answers a second poller the way Telegram
 * does — the older request gets a 409.
 *
 * What is being held is the plan's promise for the lid closing and
 * opening: the chat is read by exactly one node, the box takes it over
 * thirty seconds after the Mac goes quiet without a word to the chat, and
 * writes the move where the lifecycle log would have it; a message for
 * the Mac while it sleeps is held and reaches it when it is back, the Mac
 * takes the chat back a minute after it returns — waiting while the box is
 * mid-conversation — and nothing read is lost or passed on twice across
 * the handover. The clock the rule reads is the test's, so a minute is a
 * line, not a minute.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { adoptSharedTelegram, type SharedTelegram } from "../../shared/channels";
import { LEAD_BUSY_MAX_MS, LEAD_SETTLE_MS, LEAD_TAKEBACK_MS, LEAD_TAKEOVER_MS, type LinkMessage } from "../../shared/nodes";
import { TelegramLead } from "../src/lead";
import { TelegramChannel, type Fetch } from "../src/telegram";

const ME = "111222333";
const TOKEN = `123456789:${"AAH-x_".repeat(6)}`;
const BOT = { id: "123456789", username: "kuru_test_bot", name: "Kuru" };
const MAC_ID = "n0000000000a1";
const BOX_ID = "n0000000000b2";
const T0 = 2_000_000_000_000;

interface Update {
  update_id: number;
  message: Record<string, unknown>;
}

/** The Bot API in memory, with Telegram's rules for offsets and for two readers. */
function fakeBot() {
  let queue: Update[] = [];
  let nextUpdate = 100;
  let nextMessage = 5_000;
  let waiting: { who: string; answer: (res: Response) => void } | null = null;
  const calls: { who: string; method: string; params: Record<string, unknown> }[] = [];
  const sent: { who: string; chat: string; text: string; id: number }[] = [];
  const fetchFor =
    (who: string): Fetch =>
    async (url, init) => {
      const method = url.slice(url.lastIndexOf("/") + 1);
      const params = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      calls.push({ who, method, params });
      if (method === "getUpdates") {
        const offset = typeof params.offset === "number" ? params.offset : 0;
        queue = queue.filter((u) => u.update_id >= offset);
        // A second reader: the held request is ended with a 409, as Telegram does.
        if (waiting && waiting.who !== who) {
          waiting.answer(Response.json({ ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running" }, { status: 409 }));
          waiting = null;
        }
        if (queue.length) return Response.json({ ok: true, result: queue.slice() });
        return await new Promise<Response>((resolve, reject) => {
          const mine = { who, answer: resolve };
          waiting = mine;
          const timer = setTimeout(() => {
            if (waiting === mine) waiting = null;
            resolve(Response.json({ ok: true, result: queue.slice() }));
            // Held past the second a node waits after a 409, as Telegram's
            // fifty seconds are: two pollers end each other's polls, never
            // with an empty answer in between.
          }, 1_500);
          init.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            if (waiting === mine) waiting = null;
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        });
      }
      if (method === "sendMessage") {
        const id = nextMessage++;
        sent.push({ who, chat: String(params.chat_id), text: String(params.text), id });
        return Response.json({ ok: true, result: { message_id: id } });
      }
      return Response.json({ ok: true, result: true });
    };
  return {
    fetchFor,
    calls,
    sent,
    /** A message from the user, now; `extra` for a reply. */
    deliver(text: string, extra: Record<string, unknown> = {}) {
      const id = nextUpdate++;
      queue.push({
        update_id: id,
        message: { message_id: id, date: Math.floor(Date.now() / 1000) + 1, chat: { id: Number(ME), type: "private" }, from: { id: Number(ME), is_bot: false, first_name: "Sam" }, text, ...extra },
      });
      if (waiting) {
        const w = waiting;
        waiting = null;
        w.answer(Response.json({ ok: true, result: queue.slice() }));
      }
      return id;
    },
  };
}

type Handler = (peer: string, message: LinkMessage) => void;

interface Side {
  name: string;
  id: string;
  rank: number;
  telegram: TelegramChannel;
  lead: TelegramLead | null;
  handlers: Map<string, Handler>;
  up: Array<(peer: string) => void>;
  down: Array<(peer: string) => void>;
  said: { id: string; text: string }[];
  logs: string[];
  /** What the server would write to `lifecycle.log`. */
  moves: string[];
}

let dir: string;
const was: Record<string, string | undefined> = {};
let bot: ReturnType<typeof fakeBot>;
let now: number;
let linked: boolean;
let upSince: number;
let downSince: number | null;
let mac: Side;
let box: Side;
let shared: SharedTelegram;

function other(side: Side): Side {
  return side === mac ? box : mac;
}

function nodesOf(side: Side) {
  const members = () => [mac, box].map((s) => ({ id: s.id, name: s.name, rank: s.rank }));
  return {
    selfId: () => side.id,
    role: () => (side.rank === 1 ? "parent" : "child"),
    parentId: () => mac.id,
    name: () => side.name,
    // Each node's signing key is its id here, and a signature is that and the payload's hash (`fakeSign`).
    member: (id: string) => [mac, box].filter((s) => s.id === id).map((s) => ({ id: s.id, name: s.name, rank: s.rank, keys: { sign: s.id, box: "" }, address: "", port: 0 }))[0],
    members,
    ownRank: () => side.rank,
    statuses: () => {
      const o = other(side);
      return [
        {
          id: o.id,
          name: o.name,
          rank: o.rank,
          parent: o === mac,
          state: linked ? "up" : "away",
          since: linked ? upSince : downSince,
          lastSeen: linked ? now : downSince,
          error: null,
          summary: { lead: { eligible: o.telegram.switchedOn, polls: o.telegram.polling } },
          leader: false,
          url: "",
          address: "",
          port: 0,
        },
      ];
    },
    summaryOf: (id: string) => (id === other(side).id ? { lead: { eligible: other(side).telegram.switchedOn, polls: other(side).telegram.polling } } : null),
    liveSummaryOf: (id: string) => (linked && id === other(side).id ? { lead: { eligible: other(side).telegram.switchedOn, polls: other(side).telegram.polling } } : null),
    linked: (id: string) => linked && id === other(side).id,
    linkedIds: () => (linked ? [other(side).id] : []),
    nameOf: (id: string) => [mac, box].find((s) => s.id === id)?.name ?? null,
    send: (peer: string, message: LinkMessage) => {
      if (!linked || peer !== other(side).id) return false;
      const copy = JSON.parse(JSON.stringify(message)) as LinkMessage;
      queueMicrotask(() => {
        if (linked) other(side).handlers.get(copy.type)?.(side.id, copy);
      });
      return true;
    },
    on: (type: string, handler: Handler) => void side.handlers.set(type, handler),
    onLinkUp: (hook: (peer: string) => void) => void side.up.push(hook),
    onLinkDown: (hook: (peer: string) => void) => void side.down.push(hook),
    onUnpair: () => undefined,
    rosterTelegram: () => shared,
  };
}

function makeSide(name: string, id: string, rank: number): Side {
  const side: Side = { name, id, rank, telegram: null as never, lead: null, handlers: new Map(), up: [], down: [], said: [], logs: [], moves: [] };
  side.telegram = new TelegramChannel({
    say: (_key, messageId, _at, text) => void side.said.push({ id: messageId, text }),
    profileKeyFor: () => "pk-main",
    profileIdOf: () => "p1",
    kuruBusy: () => false,
    changed: () => undefined,
    fetch: bot.fetchFor(name),
    stateFile: join(dir, "state", `${name}.json`),
  });
  return side;
}

const fakeSign = (key: string, payload: string) => `${key}:${Bun.hash(payload).toString(36)}`;

/** The node's lead, as a server builds it — again after a sleep, which is what a frozen process waking looks like to the rule. */
function startLead(side: Side): void {
  side.lead = new TelegramLead({
    nodes: nodesOf(side) as never,
    telegram: side.telegram,
    // Eligible is the switch, as on a server whose token and Claude login are both there.
    eligible: () => ({ eligible: side.telegram.switchedOn, why: side.telegram.switchedOn ? null : "the channel is off" }),
    ownBot: () => false,
    say: (id, _at, text) => {
      side.said.push({ id, text });
      return true;
    },
    changed: () => undefined,
    // The parent's file into the roster, and the roster to every node at once.
    switched: () => {
      shared = mac.telegram.ownShared()!;
    },
    log: (line) => void side.logs.push(line),
    moved: (line) => void side.moves.push(line),
    now: () => now,
    sign: (payload) => fakeSign(side.id, payload),
    verify: (payload, signature, key) => signature === fakeSign(key, payload),
  });
}

function link(): void {
  linked = true;
  upSince = now;
  for (const side of [mac, box]) for (const hook of side.up) hook(other(side).id);
}

function unlink(): void {
  linked = false;
  downSince = now;
  for (const side of [mac, box]) for (const hook of side.down) hook(other(side).id);
}

/** The Mac's lid closing: its process freezes, polling nothing and hearing nothing. */
function sleepMac(): void {
  mac.lead?.close();
  mac.lead = null;
  mac.handlers.clear();
  mac.up = [];
  mac.down = [];
  mac.telegram.lead(false);
  unlink();
}

function evaluate(...sides: Side[]): void {
  for (const side of sides) side.lead?.evaluate();
}

async function until(test: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!test()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kururu-lead-"));
  for (const name of ["KURURU_STATE_DIR", "XDG_CONFIG_HOME", "KURURU_TELEGRAM_API"]) was[name] = process.env[name];
  process.env.KURURU_STATE_DIR = join(dir, "state");
  process.env.XDG_CONFIG_HOME = join(dir, "config");
  process.env.KURURU_TELEGRAM_API = "http://telegram.invalid";
  mkdirSync(join(dir, "config", "kururu"), { recursive: true });
  const allowed = [{ id: ME, name: "Sam", username: null, addedAt: 1 }];
  // One bot: the Mac's own, and the box's lent copy of its token — the same file, here.
  writeFileSync(join(dir, "config", "kururu", "telegram.json"), JSON.stringify({ token: TOKEN, bot: BOT, enabled: true, enabledAt: Date.now() - 60_000, allowed }), { mode: 0o600 });
  shared = adoptSharedTelegram({ enabled: true, enabledAt: Date.now() - 60_000, switchedAt: null, allowed, bot: BOT })!;
  bot = fakeBot();
  now = T0;
  linked = false;
  upSince = T0;
  downSince = null;
  mac = makeSide("mac", MAC_ID, 1);
  box = makeSide("box", BOX_ID, 2);
  // As the server starts them: the lead decides before the channel polls.
  for (const side of [mac, box]) {
    startLead(side);
    side.lead!.evaluate();
    side.telegram.start();
  }
});

afterEach(() => {
  for (const side of [mac, box]) {
    side.lead?.close();
    side.telegram.close();
  }
  for (const [name, value] of Object.entries(was)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Both up and linked, the Mac reading the chat. */
async function macLeads(): Promise<void> {
  link();
  now = T0 + LEAD_SETTLE_MS;
  evaluate(mac, box);
  await until(() => mac.telegram.polling);
  evaluate(box);
  expect(box.telegram.polling).toBe(false);
}

const texts = () => bot.sent.map((m) => m.text);
/** Anything kururu ever said in the chat about who reads it. */
const leaderLines = () => texts().filter((t) => /in charge|listening|took over|stood down|stands down/i.test(t));
const HELD = "The Mac is away; this reaches its Kuru when it is back.";

describe("one Telegram between two nodes", () => {
  it("is read by the Mac, and the box's Kuru speaks through it; a reply to its line reaches it", async () => {
    await macLeads();
    bot.deliver("check the build");
    await until(() => mac.said.some((m) => m.text === "check the build"));
    bot.deliver("@box start the tests");
    await until(() => box.said.some((m) => m.text === "start the tests"));
    expect(box.said[0]!.id).toMatch(new RegExp(`^telegram-${ME}-\\d+$`));
    expect(mac.said.map((m) => m.text)).toEqual(["check the build"]);
    expect(bot.calls.filter((c) => c.method === "getUpdates").every((c) => c.who === "mac")).toBe(true);

    box.telegram.post("pk-main", "Tests are running.");
    await until(() => texts().includes("[Box] Tests are running."));
    const line = bot.sent.find((m) => m.text === "[Box] Tests are running.")!;
    expect(line.who).toBe("mac");
    expect(box.telegram.status().waiting).toBe(0);

    bot.deliver("stop them", { reply_to_message: { message_id: line.id } });
    await until(() => box.said.some((m) => m.text === "stop them"));
    mac.telegram.post("pk-main", "All green.");
    await until(() => texts().includes("All green."));
  });

  it("keeps a line of the box's while nobody can take it, and sends it once somebody can", async () => {
    box.telegram.share({ self: BOX_ID, parent: MAC_ID, nodes: [{ id: MAC_ID, name: "mac" }, { id: BOX_ID, name: "box" }], settings: shared });
    box.telegram.post("pk-main", "Done while you were away.");
    await settle();
    expect(box.telegram.status().waiting).toBe(1);
    await macLeads();
    await until(() => texts().includes("[Box] Done while you were away."));
    await until(() => box.telegram.status().waiting === 0);
  });

  it("is taken over by the box thirty seconds after the Mac goes quiet, in silence, and the Mac's messages wait for it", async () => {
    await macLeads();
    sleepMac();
    const asleep = now;
    now = asleep + 10_000;
    evaluate(box);
    await settle();
    expect(box.telegram.polling).toBe(false);
    now = asleep + LEAD_TAKEOVER_MS;
    evaluate(box);
    await until(() => box.telegram.polling);
    expect(box.moves).toEqual([`this node polls Telegram for the others now — away: mac since ${new Date(asleep).toISOString()}`]);

    bot.deliver("what is running");
    await until(() => box.said.some((m) => m.text === "what is running"));
    bot.deliver("@mac are you there");
    bot.deliver("@mac and this");
    await until(() => texts().includes(HELD));
    await settle();
    expect(texts().filter((t) => t === HELD).length).toBe(1);
    expect(mac.said.map((m) => m.text)).toEqual([]);

    // The box's server restarts while they wait: it does not say so again.
    box.lead?.close();
    box.telegram.close();
    box.handlers.clear();
    box.up = [];
    box.down = [];
    box.telegram = makeSide("box", BOX_ID, 2).telegram;
    startLead(box);
    box.lead!.evaluate();
    box.telegram.start();
    bot.deliver("@mac and one more");
    await until(() => box.telegram.status().waiting === 0 && bot.calls.filter((c) => c.who === "box" && c.method === "getUpdates").length > 3);
    await settle();
    expect(texts().filter((t) => t === HELD).length).toBe(1);

    // The lid opens: what waited reaches the Mac at once, before the poll moves.
    startLead(mac);
    const woke = now + 60 * 60_000;
    now = woke;
    link();
    evaluate(mac, box);
    await until(() => ["are you there", "and this", "and one more"].every((t) => mac.said.some((m) => m.text === t)));
    expect(box.telegram.polling).toBe(true);
    expect(mac.telegram.polling).toBe(false);

    // A minute of steady link, and the Mac asks — but the box was written to
    // a moment ago, so it is busy, and is asked again until ten minutes are up.
    now = woke + LEAD_TAKEBACK_MS - 1000;
    evaluate(mac);
    await settle();
    expect(mac.telegram.polling).toBe(false);
    now = woke + LEAD_TAKEBACK_MS;
    evaluate(mac);
    await until(() => mac.logs.some((l) => l.includes("is busy")));
    expect(box.telegram.polling).toBe(true);
    now = woke + LEAD_TAKEBACK_MS + LEAD_BUSY_MAX_MS;
    evaluate(mac);
    await until(() => mac.telegram.polling);
    await until(() => !box.telegram.polling);
    expect(mac.moves).toContain("took the Telegram poll back from box");
    expect(box.moves).toContain("handed the Telegram poll to mac");

    // Read from where the box got to: nothing it passed on comes again.
    const before = mac.said.length;
    bot.deliver("thanks");
    await until(() => mac.said.some((m) => m.text === "thanks"));
    await settle();
    expect(mac.said.length).toBe(before + 1);
    expect(box.said.filter((m) => m.text === "what is running").length).toBe(1);
    expect(box.said.some((m) => m.text === "thanks")).toBe(false);
    expect(leaderLines()).toEqual([]);
  });

  it("settles a split by rank: one 409 on the box, which stands down, and the Mac keeps the chat", async () => {
    await macLeads();
    // Both awake, the link between them cut: each thinks the other gone.
    unlink();
    now += LEAD_TAKEOVER_MS;
    evaluate(box);
    // The two end each other's polls, a 409 a second, and whichever has two
    // in a row first stands aside: the box for five minutes, or the Mac — as
    // the higher — for thirty seconds, after which the box is the one.
    const said = (side: Side) => side.logs.some((l) => l.includes("Telegram said 409"));
    await until(() => said(mac) || said(box), 10_000);
    if (said(mac)) {
      expect(mac.logs.find((l) => l.includes("Telegram said 409"))).toContain("tries again in thirty seconds");
      now += 30_000;
      evaluate(mac);
    }
    await until(() => said(box), 10_000);
    await until(() => !box.telegram.polling && mac.telegram.polling, 10_000);
    await settle();
    expect(mac.telegram.polling).toBe(true);
    expect(box.telegram.polling).toBe(false);
    expect(box.logs.filter((l) => l.includes("Telegram said 409")).length).toBe(1);
    expect(box.logs.find((l) => l.includes("Telegram said 409"))).toContain("stands down for five minutes");
    expect(box.moves.some((l) => l.includes("stands down for five minutes"))).toBe(true);
    expect(leaderLines()).toEqual([]);
    bot.deliver("still there?");
    await until(() => mac.said.some((m) => m.text === "still there?"));
  }, 30_000);
});

describe("a restart of the node that reads the chat", () => {
  it("carries on at once, and tells the chat nothing", async () => {
    await macLeads();
    sleepMac();
    now += LEAD_TAKEOVER_MS;
    evaluate(box);
    await until(() => box.telegram.polling);
    expect(box.moves.length).toBe(1);
    await settle();
    // The box's server restarts: a new channel and lead on the same state file.
    box.lead?.close();
    box.telegram.close();
    box.handlers.clear();
    box.up = [];
    box.down = [];
    const again = makeSide("box", BOX_ID, 2);
    box.telegram = again.telegram;
    startLead(box);
    box.lead!.evaluate();
    box.telegram.start();
    expect(box.telegram.polling).toBe(true);
    expect(box.logs.at(-1)).toContain("as it did before its restart");
    await settle();
    // Carried on, not moved: nothing for the lifecycle log, nothing for the chat.
    expect(box.moves.length).toBe(1);
    expect(leaderLines()).toEqual([]);
  });
});

describe("a shared channel on its own", () => {
  it("passes on a message read again after a handover once", async () => {
    await macLeads();
    const id = bot.deliver("first");
    await until(() => mac.said.some((m) => m.text === "first"));
    // A holder that took it and stopped before confirming it: the next
    // holder reads it again, and its handed-over ids say it was passed on.
    const state = mac.telegram.handOver();
    expect(state.handled).toContain(`telegram-${ME}-${id}`);
    box.telegram.adopt({ ...state, offset: 0 });
    expect(box.telegram.status().waiting).toBe(0);
  });

  it("leaves the list to the parent on a child, and the switch to the links", async () => {
    await macLeads();
    expect(() => box.telegram.set({ enabled: false })).toThrow(/through the links/);
    expect(() => box.telegram.pair(true)).toThrow(/mac's/);
    expect(() => box.telegram.disallow(ME)).toThrow(/mac's/);
    expect(box.telegram.status().lead?.heldFrom).toBe("mac");
    expect(mac.telegram.status().lead?.nodes.map((n) => [n.name, n.polls])).toEqual([
      ["mac", true],
      ["box", false],
    ]);
  });
});

describe("the switch, from any node", () => {
  const notices = (text: string) => bot.sent.filter((m) => m.text === text).length;
  const ON = "Kuru is listening here now.";
  const OFF = "Kuru stopped listening here. Nothing you write reaches it until the channel is turned on again in kururu.";

  it("is turned off from the box while the Mac reads the chat: the Mac stops at once, and takes it into the roster", async () => {
    await macLeads();
    box.lead!.flip(false);
    expect(box.telegram.switchedOn).toBe(false);
    await until(() => !mac.telegram.polling);
    expect(mac.telegram.switchedOn).toBe(false);
    expect(shared.enabled).toBe(false);
    expect(shared.switchedBy).toBe(BOX_ID);
    evaluate(mac, box);
    expect(box.telegram.pendingSwitch()).toBeNull();
    await settle();
    expect(notices(OFF)).toBe(0);
    // Off is no request at all, on either node.
    const polls = bot.calls.filter((c) => c.method === "getUpdates").length;
    await settle();
    expect(bot.calls.filter((c) => c.method === "getUpdates").length).toBe(polls);
    expect(mac.telegram.status().lead?.switch.by).toBe("box");
  });

  it("is turned on from the box while the Mac is frozen, works at once, and reaches the Mac's roster when it wakes", async () => {
    await macLeads();
    mac.lead!.flip(false);
    await until(() => !box.telegram.switchedOn);
    sleepMac();
    now += 5 * 60_000;
    evaluate(box);

    box.lead!.flip(true);
    expect(box.telegram.switchedOn).toBe(true);
    // The Mac said last that it could not read the chat, so the box does not wait thirty seconds for it.
    evaluate(box);
    await until(() => box.telegram.polling);
    expect(box.telegram.status().lead?.switch).toMatchObject({ by: "box", pending: true });
    bot.deliver("anything new?");
    await until(() => box.said.some((m) => m.text === "anything new?"));
    // The Mac's roster still says off, and the box's word is the later one.
    expect(shared.enabled).toBe(false);

    startLead(mac);
    const woke = now + 60 * 60_000;
    now = woke;
    link();
    await until(() => mac.telegram.switchedOn);
    expect(shared).toMatchObject({ enabled: true, switchedBy: BOX_ID });
    evaluate(mac, box);
    expect(box.telegram.pendingSwitch()).toBeNull();
    expect(box.telegram.switchedOn).toBe(true);
    // And the chat moves back as it always does: a minute of steady link,
    // then the handshake — busy at first, since the box was just written to.
    now = woke + LEAD_TAKEBACK_MS;
    evaluate(mac);
    await until(() => mac.logs.some((l) => l.includes("is busy")));
    now = woke + LEAD_TAKEBACK_MS + LEAD_BUSY_MAX_MS;
    evaluate(mac);
    await until(() => mac.telegram.polling && !box.telegram.polling);
    expect(notices(ON)).toBe(0);
    expect(leaderLines()).toEqual([]);
  });

  it("is the latest word: a flip on the Mac after the box's, made while they were apart, stands", async () => {
    await macLeads();
    sleepMac();
    now += 60_000;
    box.lead!.flip(false);
    expect(box.telegram.pendingSwitch()).not.toBeNull();
    // The Mac, awake again before its links are: switched off and on by hand there, later than the box.
    startLead(mac);
    now += 60_000;
    mac.lead!.flip(false);
    mac.lead!.flip(true);
    expect(shared.enabled).toBe(true);
    link();
    await settle();
    evaluate(mac, box);
    expect(mac.telegram.switchedOn).toBe(true);
    expect(box.telegram.switchedOn).toBe(true);
    expect(box.telegram.pendingSwitch()).toBeNull();
  });

  it("is left to the parent when the parent's kururu is from before, since it would never take the flip in", async () => {
    shared = adoptSharedTelegram({ enabled: true, enabledAt: Date.now() - 60_000, allowed: shared.allowed, bot: BOT })!;
    await macLeads();
    expect(() => box.lead!.flip(false)).toThrow("The Mac's kururu is from before the channel could be switched on any node");
    expect(box.telegram.switchedOn).toBe(true);
  });

  it("ignores a flip that the node it names did not sign", async () => {
    await macLeads();
    mac.handlers.get("telegram-switch")!(BOX_ID, { type: "telegram-switch", switch: { enabled: false, at: Date.now() + 1000, by: BOX_ID, told: true, sig: fakeSign(MAC_ID, "x") } });
    expect(mac.telegram.switchedOn).toBe(true);
    expect(mac.logs.some((l) => l.includes("is not signed by it"))).toBe(true);
    expect(mac.telegram.polling).toBe(true);
  });

  it("is not turned on from a node with no token, and says to lend it; off it is, and the chat is not told", async () => {
    await macLeads();
    // The box again, with nothing in its config: no token lent.
    box.lead?.close();
    box.telegram.close();
    box.handlers.clear();
    box.up = [];
    box.down = [];
    process.env.XDG_CONFIG_HOME = join(dir, "empty");
    box = makeSide("box", BOX_ID, 2);
    process.env.XDG_CONFIG_HOME = join(dir, "config");
    startLead(box);
    evaluate(box);
    expect(box.telegram.hasToken).toBe(false);

    box.lead!.flip(false);
    await until(() => !mac.telegram.polling);
    await settle();
    expect(notices(OFF)).toBe(0);
    expect(() => box.lead!.flip(true)).toThrow("This node holds no bot token, so it could not read the chat. Lend it from the Mac's Settings → Nodes → box → Secrets → Telegram, then switch it on here.");
    expect(box.telegram.status().lead?.switch.refuseOn).toContain("holds no bot token");
    expect(box.telegram.status().lead?.switch.refuseOff).toBeNull();
    expect(box.telegram.switchedOn).toBe(false);
  });
});
