# Channels

Other places to talk to Kuru from. **Telegram is the only one.** A message
you send the bot reaches Kuru exactly as a line typed in the Kuru drawer's
composer does — the same outbox, the same conversation — and every reply
Kuru makes comes back to the chat while the channel is on. Settings →
Channels sets it up with a walkthrough and holds the switch; the drawer's
header carries the same switch once it is set up.

The argument is in the header of `shared/channels.ts`: away from the Mac,
the phone's browser is a desktop layout on a small screen and its microphone
needs https nobody has set up, while a chat app is already on the phone,
already wakes it, and already keeps a thread. A channel is a second window
onto the one conversation, never a second conversation — the drawer stays
its home.

## The pieces

| piece | where | what |
|---|---|---|
| The rules | `shared/channels.ts` | Pure: the kinds, the settings, `judge` (what one message is allowed to do), the pairing code, splitting a reply under Telegram's limit, the echo line, `replySpoken`, the status a window draws. |
| The bot | `server/src/telegram.ts` | The token on disk, the long poll, the queue out, pairing, the test message, "typing…". `KURURU_TELEGRAM_API` points it somewhere other than `api.telegram.org`, which is how a test reaches a stand-in. |
| The router | `server/src/channels.ts` | Told what Kuru took in (`prompted`, `delivered`) and said (`replied`, `aside`); decides whether a reply is spoken and what each channel gets; tells a chat when one of its messages failed. A second kind of channel is a second field beside `telegram` here. |
| The way in | `Outbox.say` | A channel's message joins the outbox under an id the server mints, `telegram-<chat>-<message>`, so a message read twice is one message. Typed into Kuru's terminal as `[telegram] <words>`; a slash command goes in bare, as it would from the drawer. |
| The way out | `/api/report` → `Channels.replied` | Kuru's Stop report: the reply goes to every allowed account, whatever the turn answered — a `[kururu]` notice included. |
| The page | `settings/Channels.tsx` | The switch at the top, then four steps, each ticked off as the server confirms it, with the controls inside them. |
| The marks | `KuruDrawer.tsx`, `Search.tsx` | A turn from Telegram wears a paper plane and the word; search says "you, on Telegram". |
| Among nodes | `server/src/lead.ts` | With other kururus linked: which node reads the chat (`LeadGate`), the handover between them, and the chat's words and every Kuru's lines crossing the links. See [nodes](nodes.md#one-telegram). |

## Who may talk to it

**Only accounts on the allow-list, and the list starts empty.** Kuru acts on
every agent with your authority, so the list is the security. Telegram tells
the bot who sent each message (`from.id`), and that is what is checked — never
a name, which anybody can set to anything.

`judge` asks, in this order:

1. **A private chat with a person?** A group the bot was added to, a channel
   post, another bot: ignored, whoever is in it — a reply in a group is a
   reply to everybody there.
2. **The pairing code,** while pairing is on: the sender is offered in
   Settings to be allowed or refused. Nothing else happens.
3. **On the list?** If not: ignored, with no answer at all, and counted.
4. **Switched on?** If not: "the channel is off" (only seen while pairing,
   since nothing polls otherwise).
5. **Sent after the switch went on?** If not: dropped, with one line per
   batch saying how many.
6. `/start` gets a greeting; a photo, voice note or sticker gets "only text
   reaches Kuru"; anything else goes to Kuru.

**Pairing** is how the list is filled without anybody knowing their numeric
id, which Telegram's app does not show. Settings shows a six-character code
(no I, O, 0 or 1), a `t.me/<bot>?start=<code>` link and its QR; pressing
Start sends `/start <code>`. The account it came from is offered with its
name and id; **Yes, allow it** puts it on the list, **No, not me** kills the
code. Ten minutes, then the code is dead. An id can also be typed in by hand.

### If somebody finds the bot

A bot's username is public, and anybody can write to it. What they get:

- **Nothing reaches Kuru.** A message from an account not on the list never
  goes near the outbox, the harness or any agent.
- **No answer.** The bot does not reply, so it does not even confirm it is
  alive. The one exception is pairing, which only you start, from this Mac,
  for ten minutes: during it, a stranger would have to send the exact code
  shown on your screen, and even then their account is only *offered* — with
  its name and id — for you to refuse.
- **They read nothing.** The bot only ever writes to accounts on the list.
  Adding it to a group gets the group ignored too (and `/setjoingroups` →
  Disable in @BotFather stops that outright).
- **You hear about it.** Settings → Channels says "kururu ignored N messages
  from <name, id> not on your list", with when, until you dismiss it.

What would matter is the **token**: whoever has it can read what the bot is
sent and write as the bot (though still not reach Kuru, which only hears
accounts on the list, from this Mac's poll). If it leaks, send @BotFather
`/revoke` and paste the new one; the old one stops working at once, and
kururu says so on the page if it is still holding it.

## The token

Kept as the OpenRouter key is: `~/.config/kururu/telegram.json`, mode 0600,
beside the channel's settings (the switch, the profile, the list). Read off
the disk for each request and dropped with it. It is put in exactly one
place — the request URL, which is where the Bot API takes it — so nothing
kururu writes ever carries a URL, and every sentence Telegram answers with
is scrubbed of the token before anything sees it. A window gets `hint`, the
last four. `telegram.json` is not on the backup's allow-list and is named in
its "never" list, so a restore asks for the token again.

Before it is kept, the token is asked `getMe` (is it a bot?) and
`getWebhookInfo`: a bot that already hands its messages to a webhook is
being used by something else, and taking it over would break that, so it is
refused with the webhook's host.

## Long polling, and what "off" means

**Nothing listens.** The server calls `getUpdates` with a fifty-second
timeout and Telegram answers the moment a message arrives. No port, no
webhook, nothing near the tailnet.

**Off is nothing read and nothing sent.** The poll runs only while the
channel is on, or while you are pairing; switching off aborts the request
in flight rather than letting it run out, empties the queue out, and sends
one last quiet line ("Kuru stopped listening here"). Telegram keeps what the
bot is sent for a day, so when it comes back on, anything sent before that
moment is dropped rather than delivered late, and the chat is told how much.

**Where it got to is on the disk** (`telegram.json` in the state directory):
the last update confirmed — after it is handled, so a restart in between
reads it again and the outbox takes it once by its id — and the messages
still on their way out. A reply is queued, then sent strictly in order (a
reply split in two must not arrive second half first); a 429 is waited out,
a network failure retried on a backoff for up to twelve hours, and a 403 —
the account never pressed Start — drops that account's queue and says so on
the page.

## What goes to the chat

| what | when | how |
|---|---|---|
| Kuru's reply | every turn's end, while on, for the profile the channel talks to | a normal message, split under 4000 characters |
| A line Kuru says mid-turn (`say`) | as it says it | a normal message |
| Your words from here — spoken or typed | as Kuru takes them | **silent** (`disable_notification`): "🎙 You said: …", "⌨️ You typed: …" |
| A message from Telegram that failed in the outbox | as it fails | a line saying so, and that Resend is in the drawer |
| "typing…" | while Kuru works on something sent from the chat | `sendChatAction`, every 4.5 s, up to ten minutes |

The echo of your own words is what makes the chat read like the drawer:
without it, a reply to something said at the Mac arrives with no question in
front of it. Silent, because telling you what you just said is not news.

**`[kururu]` notices themselves do not go**, though the drawer shows them
(they reach Kuru's prompt hook wrapped as cross-session messages). A notice
quotes an agent's last reply, and an agent's reply can quote a file with a
secret in it — the reason the backup leaves agents' replies out. Kuru's
answer to a notice is Kuru's own summary, and goes like any reply.

## Is the reply spoken on the Mac?

**Not when the turn answered only Telegram** (`replySpoken`). Somebody
writing from Telegram is nearly always away from the Mac — that is why they
used it — and the reply is already in their hand. Said aloud, it plays to an
empty room, or over whoever is in it, and then sits on the unheard count as
a reply nobody heard, which is true and useless. The drawer shows it with no
speaker, like any reply that was never spoken.

Anything else in the turn and it is spoken, exactly as before channels: a
line you said or typed here (the outbox reports deliveries mid-turn too, not
only the prompts its hook sees), or a turn Kuru started itself to answer a
`[kururu]` notice — a notice counts as nobody's, so a notice alone is spoken
as it always was, and a notice beside a Telegram message changes nothing. A `say` line in a Telegram-only
turn goes to the chat and not the speakers, on the same rule.
**"Also read replies to Telegram messages aloud on this Mac"** in Settings
turns that off for somebody on the couch beside it.

## Which profile

The channel talks to one profile's Kuru: **whichever is active** unless
Settings points it at one (by key, so a cold start keeps the choice; a
profile that is gone falls back to the active one). Only that profile's
replies go to the chat, and the drawer only draws the switch for it.

## Kuru's side

The role prompt (`rolePrompt` in `shared/harness.ts`) says what `[telegram]`
means: the user is on their phone, the reply goes back as text and is not
read aloud, so a short list is fine but it stays phone-sized; and while the
channel is on every reply goes to the chat. **A running harness has the role
it was started with** — the new section arrives the next time Kuru is
started or resumed.

## What leaves the machine

With the channel on, the text of the conversation with Kuru goes through
Telegram's servers: what you write there, every reply of Kuru's, the quiet
copies of what you say or type here, and kururu's own short notices. Kuru's
replies are its own words, but they can repeat what an agent said — that is
what a summary is — so anything you would not put in a Telegram chat, do not
ask Kuru to read back to you while it is on. Bot
chats are cloud chats, not end-to-end encrypted. Audio never does. With it
off, nothing. The Settings page says this above the switch.

## With other kururus

Linked as [nodes](nodes.md), every kururu shares the parent's bot and chat:
one node reads it at a time — the Mac while it is awake, the next by rank
while it is away — and every Kuru speaks in it, each child's lines marked
`[Omarchy] …`. `@omarchy` or `/omarchy` at the front of a message, or a
reply to one of its lines, reaches that node's Kuru (`routeOf`). The
switch, the switch time and the list ride in the roster, so they are set on
the parent only; a child's page shows who reads the chat and why it can or
cannot. All of it is [One Telegram](nodes.md#one-telegram).

## Adding a channel

A kind in `CHANNEL_KINDS`, a prefix and a name beside it; its own module
beside `telegram.ts` with the same verbs (`setToken`, `set`, `pair`, `allow`,
`post`, `status`); a field beside `telegram` in `Channels` and in
`ChannelsStatus`; `channelFor` in `index.ts`; a section on the page.
Discord's ids are snowflakes past 2^53, which is why every account id is a
string.

## Gotchas

- **A bot cannot write first.** Telegram refuses a message to an account
  that never opened the bot (403). Pairing makes you open it; an id added by
  hand might not have — the test message finds out.
- **One reader per token.** Two programs polling the same bot fight: each
  `getUpdates` ends the other with a 409. A restart under `bun run dev`
  makes one, harmlessly; a run of them means another kururu, or something
  else, has the token — the page says so. Between linked nodes it is the
  referee instead: rank decides who stands down ([nodes](nodes.md#who-reads-it-and-when-that-moves)).
- **The isolated instance** wants `KURURU_TELEGRAM_API` pointed at a
  stand-in, or it talks to the real Telegram with whatever token you paste —
  see [testing](testing.md).
