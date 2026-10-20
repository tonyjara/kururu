# Nodes: the Mac and its children, linked

A **node** is any kururu. The Mac is the **parent**, a box set up by
[`kururu child setup`](linux.md) is a **child**, and once the two are paired
each draws the other: the Mac's sidebar and Needs drawer show the child's
workspaces, agents and asks, the Mac's backup carries the child's boards, and
the child's own page says when the Mac went away. This is phase 2 of
[the plan](plans/kururu-parent-child.md#phase-2--nodes-the-roster-the-mesh-the-mirror).
The Kurus talking to each other, phase 3, is [below](#kurus-as-peers), and so
are lending secrets, phase 4 ([below](#lending-secrets)) — a project's own
env files, ssh keys and GitHub login among them
([below](#lending-a-projects-secrets)) — moving a workspace, phase 6
([below](#moving-a-workspace)), and one Telegram bot for every node, phase
5 ([below](#one-telegram)).

The code is `shared/nodes.ts` (the shapes and every rule, pure and tested),
`server/src/nodekeys.ts` (the keys), `server/src/nodes.ts` (`NodeHost`),
`server/src/peerkuru.ts` (the Kurus) and `server/src/lead.ts` (who reads
the chat).

## Two words kept apart

- **The parent** is the node holding the roster's signing key. It pairs a
  node, removes one, renames one and sets the rank. A child can never add a
  member. A node becomes a parent the first time somebody adds a node from
  its Settings → Nodes; until then it is **alone**.
- **The leader** is the node that reads the Telegram chat for the others:
  the highest-ranked one that can, among those each node can reach
  (`LeadGate`, [below](#one-telegram)). Rank is the parent's list, the
  parent first by default, and draggable. With no shared chat it is the
  highest-ranked reachable node (`leaderOf`), and leads nothing.

## Pairing

Pairing starts on the Mac and is one command on the new computer. Settings →
Nodes → **Add a computer** says it in three steps: make sure the new
computer has kururu (the clone and the wizard, or "use the kururu skill"),
run this command on it, wait here. The command is shown ready to copy, with
the Mac's address and a code in it:

```sh
kururu child join 100.64.0.1:7717 ABCD-EFGH
```

The code is eight characters, works once, and lasts ten minutes. Running the
command makes the new computer's server post its id, name, public keys,
port and share token, with the code, to the Mac's `POST /api/nodes/join`.
The Mac checks and burns the code. It becomes a parent if it was alone, and
signs a roster with the new member in it at the address the request came
from. It answers with that roster. The new computer checks the roster's
signature against the key the roster names (trust on first use, made safe
by the code the person copied off the Mac's own screen), keeps that key as
its **anchor**, and starts dialling. The Mac's page notices the join on its
own (`joined` in the view) and says "omarchy joined". The same command can
be pasted into the new computer's own Settings → Nodes ("Is this the new
computer?"), or given to the wizard as `--join`.

It started the other way round: the new computer showed a code, and the
person typed it and the computer's address into the Mac. Nobody could tell
from the page what the code was for, where it came from or where it went.
Both directions trust the same two things, a short-lived single-use code
carried by the person and then only keys. This one is a copy and a paste,
from the screen the person is already looking at.

The parent keeps the new computer's share token, so that its Open links and
QR codes let a device in. A child never holds another node's token.

`/api/nodes/join` is the only route ahead of the token gate besides `/link`,
because the code is its token. Both refuse:

- any request with an `Origin` (a page);
- any request with a proxy's header (`tailscale serve` delivers from loopback);
- any remote address outside 100.64/10 and loopback (`nodeRequestRefusal`).

A wrong code counts, and the fifth burns the code. A computer already in a
roster refuses to join another: it is removed on its parent first, which it
learns the next time the two link. A parent with members of its own refuses
too. A lone parent that joins another drops its signing key.

## The roster

The roster is a signed, versioned list: every member's id, name, public keys
(Ed25519 to sign, X25519 for [the sealed secrets](#the-envelope)), address, port and
rank. The parent signs `rosterPayload`, which is canonical JSON with sorted
keys, so the bytes signed on one node are the bytes checked on another.
The signature covers the object *as received*, extra fields included, so a
later phase can add fields without an older node cutting them out before it
checks or forwards.

`adoptRoster` is the whole rule: only a roster the anchor signed, and only
when its version is newer. Every node keeps the newest it has seen and
passes it down every link, so a change reaches a node the parent cannot see
through one it can. A node also offers its roster in every `hello`. That is
how a new member gets in through a peer that had not heard of it, and how a
removed node learns it is out from the first node it meets. A node that
takes a roster it is not in **unpairs**: it closes its links, forgets the
roster and its anchor, and is alone again, ready to be paired anew.

## Links

**There is one WebSocket per pair, `GET /link`, and the lower rank dials the
higher.** The first-ranked node, the Mac by default, dials nobody and only
listens. That is why the Mac must be shared: Settings → Nodes refuses to add
a node while `reachable` names a reason. A failed dial is retried with
backoff (1 s, doubling, capped at 30 s) forever, as `session.ts` does,
because under `bun run dev` a server restart is every save.

**The handshake** (`LinkHandshake`, a state machine with no socket in it) is
the same on both ends:

1. Each end sends a `hello`: its id, a fresh challenge, the roster it holds,
   and the link protocol.
2. On the peer's `hello`, each end adopts the peer's roster if it is newer,
   checks that the peer is a member and that it still is itself, and answers
   with a `prove`: an Ed25519 signature over the *peer's* challenge and both
   ids, in signer-then-verifier order.
3. On the peer's `prove`, each end checks it against the key the roster lists.

There are no per-pair tokens to mint or rotate. Removing a node is a new
roster, and every node it meets refuses its key. A dialler that reaches a
different member at the address it dialled refuses that member.

**Away.** Every link pings every five seconds. A node is away after
twenty-five seconds of silence, which the five-second look turns into at
most thirty, because a lid that closes sends no FIN. A link that closes with
1001 is a server restarting. That is what `close()` sends on the way out, so
the peer shows as *connecting* rather than *away*, and becomes away only if
it is not back within the same twenty-five seconds. `nodes-seen.json`, in the
state directory, keeps each node's last summary and when it was last heard.
A child restarted while the Mac sleeps can therefore still say "away since
23:10" at once.

## Summaries

What crosses a link is a **summary** (`NodeSummary`), never a copy. A node
pushes one whenever it changes, at most once a second, and only when it
differs from the last. It contains:

- its version and host state;
- the profile on screen;
- each workspace's name, folder and Needs band, with its agents and its needs;
- the Needs count;
- Kuru's counts;
- whether it leads, which peers it sees, and a data mark that moves when its
  database is written.

`summarize` uses `needsOf`, so a child's band on the Mac is the band the
child's own drawer draws. Agents go without pid, command line, memory or
links, and long text is clipped. A busy node's summary is a few kilobytes.

Nothing structural is synchronised. A child's boards are its own, in its own
database, and the parent's are the parent's.

## What draws it

- **Settings → Nodes** (`web/src/settings/Nodes.tsx`):
  - On the parent: the roster by rank with drag-to-rank (and ↑/↓ on a
    phone), rename, remove, each node's state and Open, and Add a computer.
  - On a child: the parent's roster, read-only.
  - On a node in no roster: Add a computer, and the place to paste the
    Mac's command when this is the new computer.
- **The sidebar's Nodes section:** each node's workspaces with the Needs
  dot, greyed with "away since" when not up. On a node that can be watched
  (`NodeSummary.watchable`), a workspace's row puts it on this screen and
  its agents' rows go to their terminals ([below](#remote-workspaces)); the
  heading stays a link to the node's own page, for its Settings. An older
  node's rows are links to it, with "update it" in the tooltip.
- **The Needs chip and drawer:** add each up node's needs and draw a band per
  node. An away node is not counted.
- **The Share dialog:** each node's own QR code. On the parent that QR
  carries the node's token; on a child it is the bare address.
- **The desktop:** the picker and the tray offer "Open <node>". This is the
  window's own choice, never a served page's (`preload.js`). The node's
  token is held in memory and never written to `servers.json`, so a node is
  never where the next launch lands, and the floating pill stays on this
  Mac.
- **`kururu_status`:** gives Kuru every node with its workspaces, agents and
  needs from the summaries, never the token. Each agent is named the way
  `agentName` names one here, with "on omarchy" and no id. The role's Nodes
  section says they can be read and not driven, and how another node's Kuru
  is asked ([below](#kurus-as-peers)).
- **The Kuru drawer:** every node's conversation, merged
  ([below](#one-drawer)).
- **`/api/health`:** carries `nodes` (role, name, leader, each member's state)
  for `bun run status` and the doctor's pairing row. `/api/nodes` is the
  whole view, behind the gate.

## Kurus as peers

Every node has a Kuru of its own, always on for its own node, with its own
memory in its own harness folder. The rule is **read anywhere, act locally,
ask a peer**, and the user is the manager of colleagues, not of a chain:

- **Read anywhere.** `kururu_status` lists every node's workspaces and agents
  from the summaries, so "what is running on omarchy" needs nobody. Each
  agent there carries its qualified id (`n:<node>:a7`), and `read_agent`
  takes it and reads that agent's screen through the watch; every tool
  that acts refuses it by its prefix, which a bare `a7` could not do, since
  it might be this node's own `a7`. See [remote workspaces](#remote-workspaces).
- **Act locally.** Every agent tool acts on this node's agents only, and a
  Kuru is told only about its own node's agents finishing or blocking. The
  `[kururu]` notices about a node's agents go to that node's Kuru and to
  nobody else's (`peerkuru.test.ts` pins it).
- **Ask a peer.** `ask_kuru(node, message, wait)` types the message into the
  other node's Kuru, through that node's own outbox, as `[kuru@mac] …`.
  `wait: false` returns once that node has the message. `wait: true` also
  waits for the reply that answered it (`timeout_s`, as `wait_agent` takes).
  `read_kuru(node, turns)` reads another Kuru's recent conversation off what
  that node last sent. It works while the node is away, and is used only
  when asked: nothing is pushed into a Kuru when a node comes back.
- **Boards are data, not agents.** `cards`, `add_card`, `edit_card` and
  `move_card` take a `node` and act on that node's board directly, over the
  link (`board` / `board-done`). The workspace is named by its name, since
  ids are each node's own. The card's history says "the Kuru on mac"
  (`peer:mac`). `add_card` with `run` and `run_card` are refused for
  another node, because a run starts an agent.

**Why words and not tool calls.** A Kuru could have been handed another
node's MCP verbs over the link. Then two Kurus would be near Omarchy's
agents, each acting on them with nobody saying which had. Instead a request
is words, typed into Omarchy's Kuru the way a Telegram line is. The one Kuru
that acts on Omarchy's agents is Omarchy's, it hears the request in its own
context, and "delivered" means what it means for every message: that Kuru's
own hook said it took it.

### The marks

Words from another node are typed behind a mark the *receiving* node writes,
from the link's own peer. A mark off the wire would be a node saying it is
another.

| mark | from | means |
|---|---|---|
| `[user@mac]` | the user, in the Mac's drawer or speaking to it with `@box …` | their own words, with their authority; the reply goes back there |
| `[user@mac] [voice]` | the same, spoken | transcribed on the Mac, so a name may be misheard |
| `[kuru@mac]` | the Mac's Kuru, through `ask_kuru` | a colleague asking; done within what the user would plainly want, the reply goes back to it |

The plan wrote a bare `[mac]`. Both halves are there because a node can be
called anything a hostname can. One called `voice`, `telegram` or `kururu`
would otherwise have made its Kuru's every message read as speech, a phone
or a notice. The user's slash command goes in bare, as a phone's does in
`channelWords`. Another Kuru's never does. The grammar is in
`shared/channels.ts`, beside `[telegram]`.

A compromised child can therefore type into the Mac's Kuru as itself. That
was accepted in [the plan's security section](plans/kururu-parent-child.md#security):
the mark says which node, and the role says what each mark means, as it
does for `[telegram]`.

### One drawer

The drawer holds every node's conversation at once. Each node pushes its own
Kuru's newest items (`kuru-turns`, `peerItems`, at most once a second and
only when they changed). They arrive on every client as the `kuru` message's
`peers`, and the drawer merges them with this node's own (`mergeNodes`):

- A chip per node narrows the list to one. A node that is away is greyed,
  says when it was last seen, and keeps its last items. Those are cached in
  `kuru-peers.json` in the state directory, so a restart while it is away
  still shows them.
- Every line of another node's wears that node's name. The user's words
  written at one node and taken at another say "from mac".
- The composer is this node's Kuru's unless the message starts `@box`.
  Spoken, "at box, …", "hey box …" or "box, …" does it too (`addressOf`).
  Reply on another node's reply starts the message that way.
- An `@` at the front opens a list of the other nodes, filtered as you
  type: arrows and Enter or Tab, a click or a tap pick one, Escape closes
  it, and Enter never sends while it is open. A name that will route is
  bold in the field, off `typedAddress` — the typed half of `addressOf`
  itself, so the bold and the server's routing are one decision. This node
  is not in the list, because `@mac` on the Mac routes nowhere. An address
  with nothing after it does not send: the server would hand `@box` to this
  node's Kuru as words. The bold is a stroked mirror behind the textarea,
  not a heavier weight; the reason is on `Composer`.
- A message sent from one node to another is on the sender's outbox until
  it arrives, and a turn on the receiver after. It is drawn once: the turn
  once some node has it, the outbox's copy until then.

What crosses is the conversation, not a copy into anybody's database. A
reply loses its file links, which name another disk. A `[kururu]` notice
crosses as its line, without the agent reply it quoted, for the reason the
Telegram channel never carries one: a reply can quote a file with a secret
in it. Another Kuru's message keeps its words.

### Words for another node, through the outbox

`@box start the build` is heard and queued on the sender's outbox like any
message, in order with the rest. It is then handed to the link rather than
to this node's Kuru (`say`). On the receiving node it goes into that node's
outbox, marked, the way a Telegram line goes in. Every move it makes there
is reported back (`say-state`), so the sender's drawer reads "Sent",
"Typed", then delivered when that Kuru's hook took it. The audio of a clip
stays on the Mac and only its words cross.

A node that is away holds nothing up. The user's words wait on the sender's
outbox ("Not sent yet: box is away"), and go the moment the link is back,
under the same id, which the receiver keeps one copy of. A Kuru's
`ask_kuru` to a node that is away is refused at once, so Kuru tells the user
rather than having a question answered at three in the morning to nobody.

### Who hears a reply

Every node hears every linked node's Kuru's replies (`kuru-replied`), with
what the turn answered (`TurnOrigin`). A child has no speakers, so with the
lid open its Kuru talks through the Mac, by `peerReplySpoken`:

- **Said on the Mac:** a reply to what the Mac's user said to it
  (`user@mac`), and one about its own agents (a turn that answered nothing:
  a notice).
- **Not said on the Mac:** a reply to the Mac's Kuru, which hears the answer
  in its tool call and says it in its own words; a reply to somebody at the
  child's own page; a reply to a channel.

A reply said here goes through this node's own voice, hush and missed
rules, under a key of the other node's own on the missed list
(`node:<id>`), as utterance `u-<node id>-<item id>`. That is how the drawer
finds its fate again, after a restart too. This node's Kuru keeps its own
rule (`spokenHere`): a turn that answered only another node is not said
here either.

### The messages

Added to `/link` in phase 3, all ignored by a node from before them. A node
says it speaks them with `talks` in its summary. `@` to an older node is
refused with "update it" rather than sent into silence.

| message | way | what |
|---|---|---|
| `kuru-turns` | each node to all | its Kuru's newest items, on change and when a link comes up |
| `say` | sender to receiver | words for the receiver's Kuru: `who` (user or kuru), `spoken`, an outbox id |
| `say-state` | receiver to sender | each move of one `say` on the receiver's outbox |
| `kuru-replied` | each node to all | a reply, what its turn answered, and the outbox ids it took (how `ask_kuru` knows its answer) |
| `board` / `board-done` | asker to node, and back | one board verb on that node's Kuru profile |

A node's Kuru, to the others, is the profile its Telegram channel is pointed
at, else the active one. On a child that is its one profile.

## Backups

A child runs no git. When the parent backs up, it asks each linked child
whose data mark moved for its mirror over the link (`export-ask`). The child
walks the same allow-list as the parent's own (`mirrorFiles`), and the
parent writes the result under `nodes/<name>/` in its repository. A child
that is away keeps the files of its last pull. Only the parent may pull. A
child's boards are therefore backed up as often as the Mac is awake.
`bun run restore <repo> --node <name>` on a fresh child reads that subtree
back. The child is then paired again, because its keys and the roster were
never in the backup.

## Moving a workspace

Phase 6. A workspace row's ⋯ menu (and its right-click) has **Move to
<node>…** for every other member, the parent included, so a move goes either
way. A node that is not linked is listed, greyed, with its state. The same
move is Kuru's `move_workspace`: without `confirm` it returns the plan as
text, and with `confirm: true` it moves the workspace. The tool tells Kuru to
ask the user before confirming.

**The dialog** is centred, like everything else that ends work. It asks for
the project's folder on the other node, and that node judges it as it is
typed. The first guess is the folder name from here under the other node's
projects folder: the folder most of its workspaces sit in, else `~/Projects`
or one of the usual names, else home. Then come two lists, worded in
`shared/move.ts`:

- **Moves:** the name, and the board. Every card goes, deleted ones too,
  each with its number, dates, runs and history. The runs come as history
  only: their conversations stay here, so running such a card there starts
  a new conversation. An asleep run arrives `ended`, so the card does not
  promise a resume.
- **Stays:** the code (the other node uses its own checkout, so push here
  and pull there), the env files unless they are lent, any database the
  project points at, the panes (it arrives with one pane in its folder), the
  open terminals (they close), the cards' dev servers, a machine pin, the
  links to files agents made, and this node's copy of the board, which goes
  to Search → Deleted.
- **Lend with it:** under the two lists, on the parent, the workspace's env
  files, then the ssh hosts and GitHub logins this Mac has — the ones the
  project seems to need shown, the rest behind a press — each a box, none
  ticked. What is ticked is lent once the move has landed, into the folder
  it landed in. See [Lending a project's secrets](#lending-a-projects-secrets).

**Refused** while it is the profile's only workspace, while Kuru's own tab is
in it, while an agent is running in it or on one of its cards (a shell
running `claude` counts), or while a card has a worktree on the disk. A
worktree the disk no longer has is dropped and does not block the move. The
refusal is drawn above the lists. The folder is still checked under it, so
both fixes show at once.

**The folder is the other node's to judge.** `judgeFolder` in
`server/src/move.ts` expands `~` and wants an absolute path inside home,
both before and after links are followed (refuse, never clamp). The path
must be a directory with a `.git` in it. Nothing runs `git`.

**The exchange** is two questions on the link:

| message | answer | what it carries |
|---|---|---|
| `workspace-move-check` | `workspace-move-checked` | the folder (or null for the guess); answered with the resolved folder, the problem if any, the profile it would land in and whether a workspace of that name is there |
| `workspace-move` | `workspace-moved` | a move id, the workspace's key and name, the folder, and the board as `Store.exportBoard` writes it (the backup's `BoardExport`); answered with what was made |

The receiving node checks the offer down to every event (`adoptOffer`) and
judges the folder again. It makes the workspace in the profile on screen,
with one pane in that folder. Then `Store.adoptMove` writes the cards, runs
and events in one transaction, adds an `imported` event to each card naming
both nodes, and stores its answer in `meta` under the move id. The board is
read back into memory from those rows, as a restored card is.

Only when the answer arrives does the moving node act. `Store.markMovedAway`
marks every card on the board deleted, with a `moved` event naming the node
and the new key. Then the workspace is removed, as deleting one would, and
its terminals are ended. **The move id is
the same every time** this workspace is sent to that node (a hash of the
two node ids and the workspace's key). So a second press after a lost answer
is the same move, and the other node replies from its record with
`again: true` and makes nothing twice. A move interrupted before the answer
leaves this node as it was.

**A card that comes back** keeps its row. Moving a workspace there and back
finds the cards' ids already in this database, on the board they left,
marked moved. `adoptMove` takes those rows up again: new board, the export's
fields, deletion as the export says. It adds only the runs and events that
are not already there, matched by when and what, so the history reads
straight through both machines.

## Lending secrets

The parent can lend a child the keys it keeps: the self-hosted Firecrawl's
address and key (which is what gives an agent on the child `kururu_web`), the
cloud Firecrawl's key, the OpenRouter key, the Telegram bot's token, a Claude
login as a token, a Codex login. This is phase 4 of
[the plan](plans/kururu-parent-child.md#phase-4--secrets). The code is
`shared/secrets.ts` (the kinds and every rule, pure and tested),
`server/src/seal.ts` (the crypto) and `server/src/secrets.ts` (both halves).

**A store of kururu's own.** 1Password, Bitwarden, Infisical, sops and
Vault were weighed in the plan, and each one added a service, an account and
a secret per child to fetch the secrets with. These are files the Mac already
keeps at `0600` and reads per request, so the store is those files, sealed
and pushed over the link, and kept on the child as the same file. None of the
readers (`openrouter.ts`, the web providers, `telegram.ts`) knows a value was
lent.

### Kinds

A kind is one thing that can be lent. It names the file on the parent, the
file it lands as on the child, the part of it that is the secret, how its hint
is read, what it unlocks, and how to end it at the source.

| kind | on the parent | on the child | what travels |
|---|---|---|---|
| `telegram` | `telegram.json` | `telegram.json` | the token and the bot, never the switch or the allow-list |
| `openrouter` | `openrouter.json` | the same | the management key |
| `firecrawl-cloud` | `firecrawl.json` | the same, beside the child's own daily budget | the key |
| `web:<id>` | `web-<id>.json` | the same | the provider's file: address and key |
| `claude-token:<login>` | `claude-lend.json`, one per Mac login | `claude-token.json` | the token from `claude setup-token`, and whose account |
| `codex-auth:<login>` | `auth.json` in that login's Codex home | `auth.json` in the child's default Codex home | the file |

Only the secret part travels. A Telegram file carrying the Mac's switch would
make the child a second poller of the same bot, and both would get a 409. The
digest that decides whether a push is owed is taken over that part too, so a
change to the Mac's settings is not a push.

The share token, the nodes' keys, the roster's key and the backup's git
credentials are not kinds. They never leave the node that made them.
`NEVER_SHARED` lists them, and `server/test/secrets.test.ts` reads every
`0600` write in the server and fails on a file that is in neither list. The
next secret file is then a decision, not an accident.

### Grants, pushes and take-backs

A grant is one kind for one child, off until it is switched on in the
parent's Settings → Nodes → *Secrets lent to <node>*. A child holds only what
is switched on there. `plan` is the whole rule:

- A kind switched on is pushed when the child holds none of it, or holds
  another version.
- A kind switched off that the child holds is taken back.
- A kind the parent no longer has is left as the child holds it. Clearing a
  key on the Mac is not a decision to take it away from a node; switching it
  off is.

A push happens when a kind is switched on, when a child links and says what it
holds (`secrets-held`, on every link-up, since the parent forgets it with the
link), and when the parent's copy changes. The parent stats each kind's file
every two seconds, and a pasted key reaches every node that holds it in about
two. The child acknowledges every push and take-back with its hint
(`secrets-ack`), and the page shows each node's state: held, sending,
waiting for it to link, refused and why, or nothing to send.

**A Codex login is copied once.** Codex refreshes `auth.json` itself. Pushing
the Mac's refreshes over the child's would leave two machines refreshing one
login and signing each other out. So the kind does not follow its source. It
is pushed when switched on, and again only from *Push again*. The child never
writes over a Codex login it did not put there: that is somebody's own
`codex login`, and the grant is refused with that reason.

**Two Claude tokens are one variable**, so switching one on switches off the
other for that node.

**A node removed from the roster** lets go of everything it held as soon as it
learns it was removed, and the parent drops its grants. Its id survives in its
own `node.json`, so a node that joins again starts with nothing switched on. A
server that starts holding secrets from a parent it no longer has lets go of
them at once.

### The envelope

Each push is sealed to the child's X25519 key from the roster:

1. An ephemeral key agreement.
2. HKDF-SHA256, with both public keys as salt.
3. AES-256-GCM with a random nonce. The header (the kind, the parent, the
   child, the push's number) is the additional data, so an envelope for one
   kind or one node does not open as another.

A seal says who may open an envelope and not who made it, so the parent's
node key signs it too. A take-back is signed the same way. The child takes a
push only:

- on the link from the roster's parent;
- signed by that parent's key;
- addressed to itself;
- numbered higher than anything it has taken for that kind.

It writes the value at `0600`, reads it back, and acknowledges only what is on
the disk. Nothing in either half logs a value; the lines say the kind and the
node.

The link is already an authenticated WebSocket over WireGuard, so sealing can
look like belt and braces. It is there because the payload passes through
buffers and libraries and any log a later edit adds, and it is ciphertext in
all of them. It also makes the envelope the thing that is trusted, not the
road it came by, so a later phase can relay or hold one without weakening
anything.

### On the child

- **Settings → Nodes** lists what it holds, by hint and since when.
- **Settings → Web, OpenRouter and Channels** draw *Held from mac* in place
  of the field: a value pasted there would be written over by the next push.
  The server refuses those setters for a held kind with the same sentence.
  The switch and the cloud Firecrawl's daily budget stay the child's own.
- **A held Telegram token** cannot be switched on or off here: the switch and
  the accounts are the parent's, carried in the roster. Holding it is what
  lets the child read the chat for the others while the parent is away
  ([below](#one-telegram)).
- **A held Claude token** is set as `CLAUDE_CODE_OAUTH_TOKEN` on every
  terminal the child opens (`lentClaudeEnv` in `logins.ts`, read at each
  spawn, on a host with the `env` of protocol 2). It is the one credential
  kururu puts into a pty's environment, because that is how Claude Code
  takes a token, and it outranks a `/login` on the box. A terminal already
  open keeps the environment it was started with.
- **`kururu child doctor`** has a `secrets` row listing the held kinds by
  hint. Its Claude row counts a held token as signed in.

### Lending a Claude login

The usual road is the box's own `/login`, which the wizard walks: its own
login on the same subscription, revocable on its own. For a user who cannot
open a browser anywhere there is a second road.

1. The Mac's Settings → Agents → **Lend this login to a node** opens a tab
   running `claude setup-token` as the profile's login.
2. The token it prints is pasted back. It is kept in `claude-lend.json`, per
   Mac login, and sent nowhere.
3. It is switched on for the node like any other kind.

The token only makes model requests and lasts a year. It is never a copied
`.credentials.json`, whose refresh token rotates. The wizard asks which road
when Claude is not signed in (`--claude=login|lent`), and with `lent` its
`secrets` step waits for the token once the box is paired.

### Lending a project's secrets

Moving a workspace leaves behind what the project needs to run: its
`.env.local`, the key its deploy script uses, a login that can push. These
are three more families of kind on the same road — sealed, signed, one
grant per node per kind, off until switched on, pushed on a change, taken
back when switched off. The difference is that each is a file some other
program owns, so the rules are about not breaking that program's file. The
code is `shared/vault.ts` (what each file is read as, pure and tested) and
`server/src/vault.ts` (the disk); `secrets.ts` decides when.

| kind | on the parent | on the child | what travels |
|---|---|---|---|
| `env:<id>` | an env file in a workspace's checkout | the same relative path in the project's checkout there, `0600` | the file, the folder it goes to, the workspace's name |
| `ssh:<alias>` | a `Host` entry in `~/.ssh/config`, its key, its `known_hosts` lines | `~/.ssh/kururu/<alias>`, `.pub`, `.known_hosts`, `.conf`, and one `Include` line in `~/.ssh/config` | the entry's portable lines, the key, the host's public keys |
| `gh:<account>` | gh's token for that account on github.com | `~/.config/kururu/gh/`: gh's `hosts.yml` and git's credential file | the account and its token |

**An env file is lent to one node.** Its kind is a hash of the node, the
checkout here and the file, and where it lands is part of what travels, so
the digest that says a push is owed is the same on both ends and a new
folder there is a push like a new key. The lend (`node`, `from`, `file`,
`to`, the workspace's name) is kept beside the grants in `grants.json`.
`from` is a checkout the server found for the workspace, never a path a
client sent, and it outlives the workspace: a project moved to the node
keeps its env files following the Mac's. Only `.env` and its dotted kin
are offered, down to two folders (`apps/web/.env`), never in
`node_modules` or build output, and never `.env.example` or a backup
(`isEnvFile`, the databases scan's rule).

On the child the folder is judged again (`judgeFolder`: inside home, a
directory, a checkout) and the file is written at the same relative path,
never through a link. **It never goes over a file of the node's own** that
says something else. The grant is refused with that reason, as a Codex
login is; a file with the same bytes is taken as lent already. A lend
pointed at another folder removes the copy in the old one.

**An ssh entry lands beside the node's config, never in it.** Only the
directives that mean the same on any machine travel: `HostName`, `User`,
`Port`, `ProxyJump`, keep-alives, forwards and algorithms. What does not is
named in a comment at the top of the entry's file: paths, the Keychain
(`UseKeychain` is a fatal "Bad configuration option" on Linux), an
`IdentityAgent` socket, and a `ProxyCommand`, which is a program on the Mac.
The entry gets `IdentityFile ~/.ssh/kururu/<alias>`, `IdentitiesOnly yes`,
and the host's lines from the Mac's `known_hosts` (plain or hashed) as a
second `UserKnownHostsFile`, so an agent's first `ssh` there is not a
question it cannot answer. One line at the top of `~/.ssh/config`,
`Include ~/.ssh/kururu/*.conf`, brings them in; it is written through a
link if the config is one, and goes again with the last entry (the file
too, if that line was all it held). **An entry is refused when the node's
own config has a `Host` by one of its names**: a lent entry read first
would take its place without anyone seeing. A key in an agent rather than a
file (1Password's `IdentityAgent`) is listed and cannot be lent; a key with
a passphrase can be, and its hint says so, since an agent there cannot type
it.

**A GitHub login lands where only kururu's terminals look.** gh keeps its
tokens in the Keychain on a Mac; the parent asks `gh auth token --user
<account>` for one only once it is switched on for a node (or reads it from
`hosts.yml`, when gh keeps it there). The child writes gh's own `hosts.yml`
and a `git-credentials` line into `~/.config/kururu/gh/`, and every
terminal kururu opens gets `GH_CONFIG_DIR` pointing there and, through
`GIT_CONFIG_*`, git's `store` helper for `https://github.com` — after an
empty helper, which clears the node's own for that host, so the lent login
outranks a `gh auth login` there the way a lent Claude token outranks a
`/login` (`lentGhEnv` in `logins.ts`, read at each spawn). Paths only: the
token stays in its `0600` files, never in an environment. Only github.com.
One login per node: switching one on switches off the other.

**What is offered.** `Secrets.offer` lists, for a workspace and a node, the
env files in its checkout (read for their count of variables and dropped),
every lendable `Host` entry and every gh account — keys and tokens unread —
the ones the project seems to need first, and why: the host its shells are
pinned to, a host its scripts or notes name (`hostsMentioned`: the top of
the checkout and `ops/`, `scripts/`, `deploy/` and the like, a few hundred
small files, never an env file), the account that owns the checkout's
`origin`. A host with the node's own name is not suggested.

**Where it is lent from:**

- **The move dialog**, under what moves and stays: *Lend <node> with it*,
  nothing ticked. What is ticked is lent once the move has landed, into the
  folder it landed in; a lend that fails after a move that worked is said
  beside the move, since the move is done.
- **Settings → Nodes**, under each node's own keys: *Projects' env files
  lent to <node>*, grouped by workspace with each file's switch, and
  *Lend a workspace's env files*, which picks a workspace, asks the node for
  its folder (its guess first, as the move dialog does) and gives each file
  a switch; then *SSH hosts and GitHub for <node>*.
- **Kuru's `lend_secrets`.** Without `confirm` it returns `lendableText`:
  the same lists by hint — file names and how many variables, aliases and
  key file names, account names — which are suggested and why, and what is
  lent already. With `confirm: true` it lends only names the preview
  offered. It is never given a value, and its description says to lend
  before `move_workspace`, after which the workspace is not here to lend
  from.

On the child, Settings → Nodes lists each by hint (*storefront/.env.local · 14
variables*, *vps · key vps_key (ed25519)*, *someone · …wxyz*), and
`kururu child doctor`'s `secrets` row names them by hint too: `env …`,
`ssh …`, `github …`.

## One Telegram

There is one bot and one chat for every node, and every node's Kuru speaks
in it. Telegram lets one reader at a time hold a bot's `getUpdates` and
answers a second with a 409, so one node reads the chat — **the leader** —
and the others reach it through that node. The argument and the numbers
are the plan's ([One Telegram](plans/kururu-parent-child.md#one-telegram));
this is what was built.

### What is shared, and with whom

- **The settings ride in the roster.** The parent's switch, when it last
  moved and from which node, its allow-list, and which bot go into the
  roster it signs (`Roster.channels.telegram`) whenever they change. A
  child judges every message by those, so only the parent can let an
  account in. The switch is the exception: any node may flip it
  ([below](#the-switch-from-any-node)), and the parent writes the newest
  flip into the next roster. The token is not in the roster: it is a
  secret, lent on its own ([Kinds](#kinds)).
- **Shared mode.** A node is in it when it is in a roster that carries the
  channel, unless it is a child with a bot of its own pasted there — that
  child keeps its own bot and chat, as before there were nodes. A child with
  no token at all is still in it: its Kuru speaks in the chat through
  whichever node reads it.
- **Eligible to read the chat**: the channel is on — the switch as this
  node last heard it, from the roster or a node's flip — the node holds the
  token (its own on the parent, lent on a child), and Claude is signed in
  there (`leadEligibility` in `index.ts`). Each node says so in its summary
  (`NodeSummary.lead`), with whether it reads the chat now. A kururu from
  before says nothing, and is never counted as one that could.

### Who reads it, and when that moves

`LeadGate` in `shared/nodes.ts`, every node for itself, on its own links,
with the times passed in:

- **The highest-ranked eligible node among those it can reach** reads the
  chat. One above that reads it already is left to it, even by a node that
  was reading too (a split that healed).
- **Taking over**: every eligible node above has been unheard for 30 s —
  counted from this server's own start too, so a node that restarts gives
  the links that long. A node that read the chat when its server stopped
  carries on at once.
- **Taking back**: a node that should lead and sees a lower one reading
  waits for that link to be up for 60 s, then sends `lead-ask`. The holder
  answers `lead-busy` while the user wrote in the chat in the last two
  minutes or its Kuru is answering a chat message; it is asked again every
  30 s, and after 10 min with `force`, which it does not refuse. Otherwise
  it stops polling and answers `lead-state` with everything it knew — the
  offset, the queue of lines going out, the messages held for nodes that
  are away, the reply map, the last hundred message ids it passed on — and
  the asker adopts it, acknowledges with `lead-ack`, and polls. Until the
  acknowledgement the old holder keeps its copy aside, and puts it back if
  the link drops.
- **A pairing** on the parent while a child reads the chat asks for it back
  at once and with force: the code arrives through the poll.
- **The 409**: two nodes that both read the chat are a split tailnet. The
  one with an eligible node above it stands down for five minutes, the
  highest retries after thirty seconds, and each says which in its log —
  one line per 409.

**The chat is never told.** Not when a node takes over, not when the Mac
takes it back, not on a 409 or a stand-down: the poll moves every time a
lid closes and opens, the user has nothing to do about it, and every Kuru
answers in the chat whichever node reads it. It used to say *"Omarchy's
Kuru is in charge…"* and *"The Mac's Kuru is back in charge"*, and that was
a message a move, several a day. Where the poll is shows in Settings →
Channels' list and the doctor's `leading` row
([What draws it](#what-draws-it)), and every move is a `telegram` line in
`lifecycle.log` on the node it moved to or from — took it, with who was
away and since when; handed it to; took it back from; stopped, and why;
asleep while holding it; the 409 and which way it went. `bun run status`
and Settings → About print them with the restarts. A node carrying on after
its own restart is not a move and writes none.

### The switch, from any node

The channel is turned on and off from whichever node's Settings → Channels
the user has in front of them — the Mac's, the box's, or either one's
phone link — and the Mac need not be awake. The case it is for: out with a
phone, the Mac shut, the box at home the one that could read the chat.

- **A flip is signed and handed on.** `TelegramLead.flip` makes a
  `TelegramSwitch` (`shared/channels.ts`): on or off, when, which node, and
  whether that node told the chat. It is signed with the node's own key —
  the one the roster lists for it, the link handshake's — and sent as
  `telegram-switch` to every node this one can reach, and to each one that
  links later while it is still news. A node checks the signature against
  the roster's key for the node named in it, not the peer it came from, so
  it crosses the mesh by any road, and takes it only when it is the later
  word, which is also what stops it going round.
- **Last change wins.** Each node goes by the latest word it has, the
  roster's or a flip's, by the time it was made, a tie by node id. A new
  flip is stamped no earlier than one past the word it replaces
  (`switchTime`), so a node whose clock runs behind another's still makes
  the newest word when the user flips it there.
- **It works at once.** The node that flips goes by it there and then, and
  so does every node that hears it; eligibility is the switch as each node
  has it, so off stops the poll on whichever node holds it the moment that
  node hears, and on lets `LeadGate` pick one poller among the nodes that
  can. A Mac that was last heard saying it could not read the chat — it was
  off — is not waited for: the box polls as soon as it is switched on.
- **The Mac takes it in when it is back.** A child keeps a flip the roster
  does not carry yet in `telegram.json` (state) and hands it to the Mac when
  their link comes up. The Mac writes it into its own `telegram.json` —
  switch, switch time, and who flipped it — and so into the next roster,
  after which every child drops its copy. Nothing is lost by the Mac being
  shut, and nothing a child said is undone by the Mac coming back with an
  older roster. A flip on the Mac made later than the box's while the two
  were apart is the later word and stands.
- **The chat is not told.** The switch is in Settings, where it was
  flipped; the chat used to get *"Kuru is listening here now."* or *"Kuru
  stopped listening here…"*, and no longer does. A flip still carries
  `told`, always true now, because it is under the signature and because a
  node from before reads false as its cue to say it.
- **What a node may not do.** Turn it on without a token of its own: the
  node the user is standing at is often the only one awake to read the
  chat, so a box with nothing lent says *"This node holds no bot token, so
  it could not read the chat. Lend it from the Mac's Settings → Nodes → box
  → Secrets → Telegram, then switch it on here."* Off it always may. And
  nothing, on or off, when the roster comes from a parent from before this
  (its copy has no `switchedAt`), which would never take the flip in: the
  page says to switch it there or update it. A node on a split tailnet that
  cannot reach the holder cannot stop it; the holder stops when the link
  comes back.
- **The list stays the parent's.** The allow-list is who may give Kuru
  orders with the user's authority, on every node at once. A child is a
  box other programs run on, and an account it let in would reach the
  Mac's Kuru too; so the list is changed only on the Mac, by a pairing the
  user confirms there, and signed into the roster. The switch lets in only
  the accounts the Mac already allowed, or keeps them out, and whoever holds
  the token could read the bot anyway — so it is safe to let any member
  flip it.

### Where a message goes

`routeOf` in `shared/channels.ts`, on the node that reads the chat, after
`judge` has let the message through:

1. `@omarchy …` or `/omarchy …` at the very front, for a member's name
   (`/omarchy@yourbot …` too) goes to that node's Kuru without the address.
   `/compact` is still Kuru's slash command, unless a node is called
   `compact`.
2. A reply to one of a node's lines goes to that node, by the **reply map**:
   every line sent is remembered by its chat and Telegram message id, as the
   node whose line it was, the last 500.
3. Anything else goes to the node reading the chat.

A message for another node crosses as `telegram-in` and goes into that
node's outbox under the same id, so it is typed into its Kuru as
`[telegram] …` and its reply comes back the way every line does. The reader
keeps it until `telegram-in-ack`; for a node that is away it is **held** —
in the state the next holder is handed — and the chat is told, once, when
the first message starts waiting: *"The Mac is away; this reaches its Kuru
when it is back."* Not again while anything still waits for that node,
which is read off the held list itself, so a server restart or the poll
moving does not repeat it. It goes the moment that node links, a day at
most. This is the one line about the nodes kururu ever puts in the chat,
because it is the one the user has to know: no answer is coming yet.

### Every Kuru's lines

A Kuru's reply, its `say` lines, a quiet echo of what the user typed or said
at that node, and kururu's own "did not reach Kuru" warnings all go through
`TelegramChannel.post`. On the node reading the chat they are queued and
sent; on any other they are handed to it as `telegram-out`, kept on the node
until `telegram-out-ack`, and handed again every 15 s and on every link that
comes up — a line stuck on a node that cannot reach the reader waits there,
for half a day. The reader marks each with the node it came from, by the
link it arrived on: `[Omarchy] …`. The parent's lines carry no mark, so a
chat with one kururu reads as it always did. A reply that answered only
another node's Kuru (`ask_kuru`) is not posted (`postedToChat`): the asking
Kuru says it in its own words.

### What draws it

- **Settings → Channels** lists the nodes by rank: which reads the chat now,
  which could, and why not for the rest. On a child it is that list, the
  switch — live, with the refusal under it when it cannot be flipped here —
  the token held from the parent, and *Talks to*. Under the switch, on any
  node: who flipped it last when that was another node (*turned on from
  Box at 23:10*), and on a child whose flip the Mac has not taken in yet,
  *the Mac takes it in when it is back*. The drawer's switch, drawn for a
  node with a token and a list, is the same flip.
- **Settings → Nodes** marks the node that reads the chat as the leader.
- **`kururu child doctor`** has a `leading` row: rank, eligible or why not,
  and whether this box reads the chat now. Never a ✗.
- **The role prompt**'s Telegram section says lines are marked by node and
  which messages reach which Kuru.

### The messages

| message | from | what |
|---|---|---|
| `lead-ask {id, force}` | the node that should lead | hand the poll over |
| `lead-busy {id, why}` | the holder | not now; asked again |
| `lead-state {id, state}` | the holder | everything it knew, or `null` when it was not polling |
| `lead-ack {id}` | the new holder | it has it; the old copy goes |
| `telegram-in {id, at, text}` | the reader | the chat's words for this node's Kuru |
| `telegram-in-ack {id}` | that node | in its outbox |
| `telegram-out {id, at, text, silent, notice}` | any node | a line for the reader to post |
| `telegram-out-ack {id}` | the reader | queued |
| `telegram-switch {switch}` | any node, and each node that takes it | a signed flip of the switch, handed on |

## Remote workspaces

**Another node's workspace can be on this window, drawn by this window's
own components, with the node doing the work.** The argument and the phases
are in [the plan](plans/remote-workspaces.md); this is what phase 1 built.

**The watch socket.** The parent's server dials the child's
`GET /link/watch`. The child refuses what `/link` refuses (an `Origin`, a
proxy's header, an address off the tailnet and loopback), then runs the node
handshake (`NodeHost.watchHandshake`, `LinkHandshake` as it stands), then
`watchRefusal`: the roster's parent may watch, and nobody else may watch
anyone. A sibling proves itself as well as the parent does and is still
turned away; the parent refuses every watch of itself. Past that, the
socket is an ordinary `/ws` client of the child (`admitClient`), tagged
`ClientState.watcher` with the node it proved. The hand-off is synchronous,
inside the frame that proved the peer, because `ws` emits every frame of one
chunk in one tick and the parent's first `watch` may be the next one.

**A watcher is a client for the terminals and nobody for anything else.**
It is sent the snapshot and the terminals' bytes, never the usage, voice,
nodes or backup messages a page gets. It starts none of the polls a first
window starts and counts in none of the "is anybody connected" checks
(`windows()`), and it never sets `remoteClientAt`, which the setup wizard
reads as the phone arriving. The child's notifications skip it. It does
count where the terminals count: its `watching` clears the child's unread
mark, its proposals size the child's ptys, and its `looking` gates them.

**The relay** (`server/src/nodewatch.ts`). One `NodeWatch` per node, opened
while that node's workspace is on screen or a client has one of its
terminals on screen, and closed a minute after neither is. It holds the
child's latest snapshot in memory and nothing else. Toward this node's
clients it qualifies every id as `n:<node>:<id>` (`shared/remote.ts`).
Toward the child it is one client whose opinion is everyone's here:

- **watching** is every child terminal a client here has on screen or has
  proposed a size for; **warm** is the ones pooled, plus any with a backlog
  in flight. The child drops a backlog request for a terminal its watcher
  does not list, and drops a proposal for one it does not list as on
  screen, and a pane proposes and asks before its `watch` effect runs, so
  the relay lists them first;
- **looking** is true while any client here is;
- **the size** proposed is `smallestGrid` over the clients here that see the
  terminal and are looking. The child then takes the smallest over its own
  clients, the relay among them, which is the smallest over everybody;
- **output** is forwarded frame for frame, the moment it arrives, behind the
  same per-client backlog hold `index.ts` keeps for local terminals. The
  child's host already waits up to 16 ms, so the relay never batches.

**Routing** (`route` in `shared/remote.ts`). A verb whose ids are a node's
goes to that node with its ids bare. A verb that names nothing and means the
focused pane (a split from the keyboard, `C-a h`) goes to the node on
screen. The board's tab and a document's tab take the side of the pane they
are named with. A card is found by its workspace, so its id is never
qualified. A verb that mixes two machines' ids is refused with a sentence
("a terminal cannot move between computers"), as is a file from this disk
into a remote pane, and any verb outside the routed list that carries a
qualified id. Before a focused-pane verb the relay moves the child's active
workspace to the one on screen here, so "the focused pane" means the same
pane on both. A reply is routed back to the client that asked, under its own
id, with the agent it names qualified.

**What is on screen.** `NodeWatches` holds which remote workspace is
showing, by node and key, in memory. `snapshot.remote` carries it with the
tree and its agents qualified, the child's launch settings and the rows its
`+` offers, and the watch's state. A local switch by any road takes it off screen: a click, `C-a 1`, a
reveal, Kuru's Auto Swap. A restart of this server comes back on the last
local workspace. Showing a workspace here also makes it the child's active
one, and a split or a focus made here moves the child's own phone, which is
what two clients of one server have always done.

**The window.** The pane area draws `remote.workspace` with the agents from
both lists. The top band takes the node's hue (`nodeHue`, a board-palette
token set as `--node-hue`, which the Kuru drawer's chips also wear), with
the node's name at its left end. Every tab wears the node's chip
(`NodeChip.tsx`). A document tab in a remote pane says it is on that node
rather than reading this disk. The file tree is closed, since it reads this
disk. Rename and Delete workspace do nothing while a remote workspace is on
screen, rather than act on the local one nobody is looking at.

**Away.** When the watch drops, the panes keep what their emulators hold,
greyed, and the band says "away since 23:10". Typing is refused at this
server with "omarchy is away — that was not typed", drawn in the band for a
moment (`remote-said`). Every pending backlog and reply for that node is let
go. When the watch comes back (dialled at once when the node's link comes
up, or on `dialDelay`'s backoff), each client is sent `stale` for that
node's terminals. A pane on screen asks for its screen again, and a pooled
one waits until it is borrowed: the same thing `onopen` does after a
reconnect.

**Nothing of a remote workspace is written here.** `Workspaces`,
`persist.ts`, the host's blob, `made.json` and the database never see a
qualified id. `nodewatch.ts` imports none of them, and `handleMessage`
returns before its switch for every verb the relay takes.
`server/test/remote.test.ts` drives a remote workspace through the relay
and finds no `n:` in `session.json`, the host's blob or the database.

**What the child shows.** Its status bar says "mac is watching" while a
watch is open (`NodesView.watchedBy`), and its `lifecycle.log` has a
`watch` line for each one opened and closed. `bun run status` prints
`watching` on the parent and `watched by` on the child.

**Starting work there** (phase 4). Everything the window starts on a remote
workspace is the node's, made by the node's own code. The `+` menu and a
card's robot offer the node's rows: its summary carries the launchers its
own `+` shows (`NodeSummary.launchers`, its catalogue less its switched-off
ones), and `remoteLaunchers` falls back on this node's catalogue under the
node's settings for a node from before. The id goes back to the node and is
looked up in its catalogue there, so a model only one side knows is still
offered by the side that runs it. `new-tab`, `run-card` and `resume-card`
are routed verbs, and their replies come back with the agent qualified. The
spawn is the node's own, with its hooks, its login (`logins.ts` there, or a
lent token) and its `kururu_web` flags pointed at its own `/mcp/web`. A
card's agent lands in the node's agents' pane by the node's `agentPaneIn`.

Two things are asked over `/link` rather than the watch, because the rows
that ask them are drawn from the summary whether or not a watch is open:

- **A Needs row's Done.** The summary marks a card's need whose move to Done
  is plain (`SummaryNeed.plainDone`), and the node's band draws Done on just
  those rows. The press is `card-done-ask`. The node asks its own rule again
  at that moment (`doneRefusal` in `shared/needs.ts`, which `plainDone` is
  drawn by too), because the summary may be seconds old. It moves the card
  as its board's `move-card` would, or answers with the sentence why not,
  which takes the row's second line for a few seconds. Every other move to
  Done is a question that node's board asks.
- **A new workspace.** The `+` beside a node's name (on the parent, for a
  node up, watchable and new enough: `NodeSummary.drives`) opens a dialog
  whose folder is judged on the node's disk as it is typed. That is the
  move's own `workspace-move-check`, read by `newFolderOk`, which lets a
  folder that is not a checkout through where a move would not. `Make` is
  `workspace-new`. The node runs `judgeFolder` again and makes the workspace
  in its profile on screen, one pane in that folder, named after it unless
  it was named. It does not switch to it: the window that asked puts it on
  screen through its watch, which moves the node's active workspace as any
  show does.

Either may be asked by any member of the roster, as a move or a peer Kuru's
`move_card` may. The node's own rule decides, and nothing on the asking side
is written.

**What needs you there** (phase 3). The Needs drawer's band for a node
this window can open is doors, not links: an agent's row is a `reveal-agent`
with its qualified id, which puts the node's workspace on screen with that
pane in front; a card with no terminal opens the node's board here with the
card lit, once the workspace's snapshot says its qualified id; the
workspace's head is `show-node-workspace`. A card's Done is phase 4's,
above, and there is no row menu: every other move to Done is a question the
node's board asks. `C-a o` walks this node's needs and then each node's
(`nextNeedAcross` in `shared/remote.ts`), and steps on from the one under
the keyboard, which on a remote pane is its qualified id. A node from
before keeps its rows as links to its page. A reveal asked while the watch
is still opening, which is the usual case for a click from the drawer or a
notification, is kept (`NodeWatch.pending`) and sent to the child with its
first snapshot, so the child's focus moves to the terminal and not only
the window to the workspace. The parent's own summary does not say `watchable`,
since nothing watches it: a child's page draws the Mac's rows as links to
the Mac's page, raises no card for its agents, and its Kuru reads none of
their screens.

**Notifications** for a node's agent are this node's, by this node's gate:
see [notifications](notifications.md#rules). Off the relayed snapshot while
a watch is up, off the node's summary while none is, one source at a time.

**What Kuru is told.** `kururu_status` says when another node's workspace
is on the user's screen — whose, which, and the agent with the keyboard
there, by its qualified id — so "what is this one doing" is heard as a
question about that node's agent. `read_agent` with a qualified id reads
that agent's screen: the watch is opened if it is not (and let go a minute
after, as ever), the backlog is asked as a client here asks for one, listed
as kept while it is out, and answered to this server instead of a page
(`NodeWatches.screen`). The answer says it was read through the link.
`source=reply` and `transcript` are refused, since both are on the node's
disk and in its Kuru's hearing; every acting tool refuses a qualified id
with "ask_kuru omarchy". Nothing in this goes near the node's `/mcp`.

Not yet (later phases of the plan): the file tree, the reader and nvim's
hand-offs on a remote workspace; `C-a w` and workspace stepping across
nodes.

| message | way | what |
|---|---|---|
| `show-node-workspace {nodeId, workspaceKey}` | page → parent | put that workspace on screen; never forwarded |
| `stale {agentIds}` | parent → page | those remote terminals missed bytes; rebuild as after a reconnect |
| `remote-said {node, text}` | parent → page | a verb for that node did not go, and why |
| `node-new-check {nodeId, name, folder}` | page → parent | the node's word on a folder for a new workspace there; a `MoveCheck` |
| `node-new-workspace {nodeId, name, folder}` | page → parent | make it there; a `NewWorkspaceMade`, then the page shows it |
| `node-card-done {nodeId, workspaceKey, cardId}` | page → parent | a Needs row's Done, asked of the node |
| `card-done-ask` / `card-done-said` | link | the card moved, or the node's sentence why not |
| `workspace-new` / `workspace-made` | link | a new workspace, its folder judged there |

## Files

| file | where | what |
|---|---|---|
| `node.json` | config, `0600` | this node's id and its Ed25519 and X25519 pairs; on the parent, the roster's signing pair. Never backed up, never sent |
| `nodes.json` | config, `0600` | the newest roster, the anchor, and on the parent each child's share token. Never backed up |
| `nodes-seen.json` | state | each node's last summary and when it was heard; rebuilt by the next summary |
| `kuru-peers.json` | state | each node's last pushed Kuru conversation, for the drawer while it is away; rebuilt by the next push |
| `grants.json` | config, `0600`, the parent | which child may hold which kind, and what each said it holds, by digest and hint; and each lent env file's checkout here and folder there. Never backed up |
| `claude-lend.json` | config, `0600`, the parent | the Claude tokens made for lending, one per Mac login. Never backed up, never sent until switched on for a node |
| `secrets-held.json` | config, `0600`, a child | what it holds from the parent: kinds, hints, digests, push numbers, never a value. The doctor reads it |
| `claude-token.json` | config, `0600`, a child | a lent Claude token, which `logins.ts` sets as `CLAUDE_CODE_OAUTH_TOKEN` |
| `gh/` | config, `0700`, a child | a lent GitHub login: gh's `hosts.yml` and git's `git-credentials`, both `0600`; kururu's terminals are pointed at it. Never backed up |
| `~/.ssh/kururu/` | home, `0700`, a child | lent ssh entries: each key, `.pub`, `.known_hosts` and `.conf`, brought in by one `Include` line at the top of `~/.ssh/config` |
| a project's `.env*` | its checkout, `0600`, a child | a lent env file, at the path it has on the parent |
| `telegram.json` | state, `0600` | the poll's place, and when the chat is shared: the held messages, the reply map, the handled ids, the lines on their way to the reader, whether this node held the poll when it stopped, and on a child a flip of the switch the roster does not carry yet. Never the token, which is in config |

A `node.json` the server cannot read is left as it is, and nodes are off for
that run. A new identity would be a member nobody enrolled.

## Testing two nodes on one Mac

Two [isolated instances](testing.md#the-isolated-instance), each with
`KURURU_NODE_ADDRESS=127.0.0.1`, which is the address the others dial in
place of the tailnet one. Give the second `KURURU_LOOPBACK_TOKEN=1` so it
behaves like a child. Then:

```sh
# node-invite on the parent's socket, {"type":"node-invite","id":1,"on":true}, replies with the command
curl -X POST -H "Authorization: Bearer $(jq -r .token /tmp/kn2/config/access.json)" \
  -d '{"text":"kururu child join 127.0.0.1:7871 ABCD-EFGH"}' 127.0.0.1:7872/api/nodes/pair
```

Name each socket `ptyhost.sock`, or `kill-ptyhosts` cannot find it afterwards.

`kill -STOP` on a server's pid is a lid closing (no FIN), and `kill -CONT` opens it again.
`kill -USR2` on its runner is a restart.

**For a remote workspace**, a client on the parent's `/ws` sends
`show-node-workspace` with a key from the child's summary, then does what
a pane does: `propose-size`, `request-backlog`, `watch` for a qualified id
off `snapshot.remote.agents`, then `input`. A `cat` on the child is the
agent to type into. SIGTERM on the child's server (never its host) is the
band going grey, and starting it again is the refill. The page itself can be
driven in headless Chrome over the DevTools protocol.

**For the Kurus**, give both instances `HOME=<scratch>`, `SHELL=/bin/sh`
and a `PATH` whose first `claude` is a stand-in. The stand-in posts
`{agentId, status: "idle"}` to `/api/report` on start. For every line typed
into it, it posts a `working` report with the line as `message`, then a
`done` with a `reply`. Those are the prompt hook and the Stop hook, which
is everything the outbox, the drawer and `kuru-replied` read. Then, in
place of the user and the Mac's Kuru:

- `{"type":"kuru-say","profileId":…,"id":"drawer-msg-0001","text":"@box hello","at":…}`
  on the first instance's socket;
- `POST /mcp?profile=<id>&session=x` with `tools/call` for `ask_kuru`,
  `read_kuru`, or `add_card` with `node`.
