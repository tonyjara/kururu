# Remote workspaces: another node's workspace, open in this window

A feasibility study and a plan, written 2026-10-20 from a read of the tree at
`157c168`, `docs/nodes.md`, `docs/plans/kururu-parent-child.md` and a look at
how four other tools do the same split. Phase 0's spike ran on 2026-10-20 in
throwaway instances and stayed out of `main`
([`docs/spikes/remote-workspaces-phase0.md`](../spikes/remote-workspaces-phase0.md)).
Its answers are folded into the sections below. **All five phases are built**
(2026-10-20 and 21); what they are now is in
[`docs/nodes.md`](../nodes.md#remote-workspaces). The plan is written so that an
agent can take one phase, read the files it names, and know what "done" is.

**The ask, in the user's words:** "Do you think it's possible to open a
workspace from another kururu in this kururu, and have it be clearly labeled
that it's from the other computer, and only show it while we have the
connection? The way it works now, I see the Needs you from the other kururu, I
click it and it sends me to the browser, and it's kinda annoying having 2
kururus open. I want the bridge between the 2 kururus to be seamless. I want it
to feel like I'm working on it from this PC, even though the other kururu is
doing the actual work. I want to see the agents in my agent sidebar, and I want
to see the panes and tabs: some sort of passthrough."

## Verdict

**Yes, and most of it is already there.** Kururu was built as a server that
never knew whether a window was attached, a wire that carries pty bytes rather
than a picture of them, and a client that draws whatever layout tree it is
handed. A child's server already sends every client the whole of its active
profile — every workspace with its pane tree, its tabs and its board — and
streams any terminal a client says it is watching. The Mac's window can draw
that with the components it has, if the Mac's server relays the child's
session to it. What is missing is the relay, an id grammar that keeps two
nodes' `a237`s apart, the labelling, and a rule for what crosses the boundary
and what does not.

**Hard in the middle, not at the edges.** The terminal path is the easy part:
`terminals.ts` pools emulators by id and feeds them from `session.ts`, and
neither cares where the bytes were born. The real work is the long tail of
things a workspace *is* beside its terminals — the file tree, the reader's
rendered markup, the board's verbs, a card's run, nvim, the dev servers, the
Needs rows, notifications — each of which today reaches a disk or a process
table on *this* machine and has to be sent across instead. That is why the plan
is phased by what a remote workspace can do, and why the first slice is the
terminals and the board and nothing else.

**Size.** The first useful slice — a child's workspace on screen in this
window, every pane and tab as the child has them, terminals live and typed
into, labelled, greyed when the link drops, back when it returns — is about
4–6 agent-days. Everything in this plan is 15–21. Nothing touches the pty host
on either node, so no phase costs anybody a running agent.

**The one thing it is not.** A pty cannot leave the machine it was opened on,
so a remote terminal is never "moved here": it is the child's, shown here, and
closing the window or the link ends nothing. That is the fact the whole design
rests on, and it is the same fact that made the pty host a process of its own.

## Where it stands today

Phase 2 of the parent-child plan put the child in the Mac's sidebar as a
**summary**: its workspaces as rows, its agents as status marks, its needs in
the Needs drawer under a band of its own, each of them an `<a href>` to the
child's address (`Sidebar.tsx`'s `NodeBlock`, `NeedsDrawer.tsx`'s `NodeBand`).
The desktop's picker and tray offer "Open omarchy", which **moves the whole
window** to the child's server (`desktop/main.js`'s `openNode`, `connect(…,
{node: true})`) — the emulators of this Mac's agents are destroyed on the way,
and the Mac's chrome, voice and Kuru drawer are gone until the window comes
back. That is the "two kururus open" the user is describing: the only way to
touch a child's terminal is to stop looking at the Mac's.

The plan's own words left the door open: *"Terminals drawn through the Mac — a
remote pane type whose emulator is fed from a second socket — are later work,
not the first shape"*, and its *Later* list priced a remote pane type at 4–6
days. This document is that later work, with one change of shape argued below:
the unit is the **workspace**, not the tab.

## What makes it possible

Read off the code, these are the facts the design leans on, and the file that
holds each:

- **The server never knew whether a window was attached**, and the client never
  knew where its server was. A phone, the Electron window and a loopback tab
  are the same `/ws` client (`server/src/index.ts`, `onUpgrade`); a child is
  the same server with no `desktop/`. A client that happens to be *another
  server* is nothing new to either side.
- **The snapshot carries every workspace of the active profile, whole**
  (`SessionSnapshot.profile: Profile`, `shared/model.ts`): each workspace's
  `layout`, `focusedPaneId`, `board`, `machine` pin and agent placement. A
  child has one profile, so one snapshot is the child's whole arrangement.
  Nothing has to be invented to draw a remote workspace's panes; the tree
  arrives.
- **Output is a byte stream per agent id, and emulators are pooled by that
  id** (`shared/wire.ts`: `output`, `grid`, `backlog`; `web/src/terminals.ts`).
  An emulator fed a child's bytes under a child-qualified id is an ordinary
  pooled emulator. Nothing in the pool, the frames or the cursor code asks
  where the pty is.
- **The server owns the size, per client, as a minimum over the clients that
  can see the terminal** (`server/src/sizing.ts`, `ClientState.proposals`,
  `looking`). A relay that is one client of the child composes with this
  exactly: the minimum over the Mac's lookers, forwarded as one proposal, is
  what the minimum over everybody would have taken from them anyway.
- **The backlog is asked for by the emulator and answered at the server's
  size, then output, per client** (`request-backlog`, `awaiting`). A relay
  holds live output behind a backlog for the Mac client that asked, with the
  same counting `index.ts` already does.
- **The nodes already link, proved by keys** (`shared/nodes.ts`'s
  `LinkHandshake`, a pure state machine; `server/src/nodes.ts`). The roster
  carries each member's address and port; the parent already holds each
  child's share token for its QR code. Letting a node in as a client needs no
  new secret.
- **Every arrangement verb is fire-and-forget and names its target by id**
  (`ClientMessage`: `input`, `watch`, `propose-size`, `split`, `move-tab`,
  `new-tab`, the card verbs). A verb whose ids name another node's things can
  be forwarded unchanged once the ids are de-qualified. Only `new-tab` and the
  `id`-carrying verbs want their `reply` routed back, which the relay does
  with the same `id`.
- **The machines feature already draws a terminal that is somewhere else**,
  with a chip naming the host and a tooltip saying what kururu cannot know
  about it (`web/src/labels.ts`: `remoteHost`, `remoteNote`). The labelling
  has a precedent and a component.

## The architecture

```
   ┌──────────────── Mac: the parent ───────────────────────────┐          ┌───────────── Omarchy: a child ──────────────┐
   │  window ─┐                                                 │          │                                              │
   │  pill   ─┼─ /ws ─▶ server :7717 ◀─ sock ─ host (launchd)   │          │   server :7717 ◀─ sock ─ host (systemd)      │
   │  phone  ─┘  ids: a12 (here)  n:<omarchy>:a7 (there)        │          │     ▲      ▲                                 │
   │                   │                                        │          │     │      │                                 │
   │   NodeHost ◀──────┼────── /link: roster, summaries, Kuru ──┼──────────┼── NodeHost                                   │
   │                   │                                        │          │     │                                        │
   │   NodeWatch ──────┼────── /link/watch: a /ws let in by ────┼──────────┼── clients.set(ws, …) — one more client,      │
   │   (one per node   │        the node handshake; opened      │          │     with proposals, watching, awaiting,      │
   │    while anything │        while a remote workspace or     │          │     exactly as a phone is                    │
   │    here watches)  │        agent of its is on screen       │          │                                              │
   │                   │                                        │          │   its own phone ── /ws ──▶ (unchanged)       │
   └───────────────────┴────────────────────────────────────────┘          └──────────────────────────────────────────────┘
```

Three things to read off it:

- **The child does not learn a new protocol.** `/link/watch` is `/ws` with a
  different doorman: the node handshake instead of the share token. After the
  handshake the socket goes into `clients` like any other and the child's
  `handleMessage`, `applySize`, `sendBacklog` and `noticeStatuses` run
  unchanged. The child's own phone is unaffected and sees the Mac as one more
  client, which is what it is.
- **The Mac's server is a `session.ts` in Node, once per node**, and a
  prefixer. `NodeWatch` reads the child's `snapshot`, `output`, `grid`,
  `backlog`, `reply` and `notify`, qualifies every id with the node, and
  hands them to the Mac's own clients; it takes the Mac's clients' verbs whose
  ids are qualified, strips the prefix, and forwards them. Everything it holds
  is in memory and dies with the socket.
- **Nothing the Mac persists ever holds a remote thing.** `Workspaces`,
  `persist.ts`, the host's blob and `kururu.db` are never handed a remote
  workspace, pane, tab or card. A remote workspace is a *view*, rebuilt from
  the child's snapshot every time the watch comes up.

### The two ways to carry it, compared

**A. Relay through the Mac's server** (the drawing above). The Mac's server
opens a socket to the child, authenticated as a node, and re-emits the child's
session to its own clients under qualified ids.

**B. The Mac's page dials the child itself.** `session.ts` grows a second
socket per node, to the child's `/ws`, presenting the child's share token; the
page holds two sessions and merges them.

| | A — relay | B — direct |
|---|---|---|
| **Latency** | child → Mac server over the tailnet, then Mac server → page over loopback. Measured: 0.5–0.8 ms over B on loopback; Mac to omarchy, a median of 167–170 ms and a p99 of 250–260 ms. | one hop fewer, and the hop saved is loopback. Measured: a median of 166–168 ms, the same; a p99 of 520–560 ms on a freshly opened socket. |
| **Auth** | the node handshake, already proved by keys the roster lists. No token leaves the Mac; the page never holds a secret of the child's. | the child's share token has to reach a *page*. Cookies are per origin and `SameSite=Lax`, so a cross-site WebSocket sends none: the token rides on the socket URL on every reconnect, in page memory. The child's `Origin` check must also learn the Mac's addresses (a loopback `Origin` passes; a phone's tailnet address does not). |
| **The phone** | nothing changes: one socket to the Mac, the Mac's cookie, remote workspaces arrive through it. `tailscale serve` for the microphone stays one origin. | the phone must reach the child directly and hold its token; an `https:` page from `tailscale serve` cannot open a `ws:` to the child at all (mixed content). |
| **Version skew** | the relay reads the child's messages with the Mac's types and passes what it knows; an older child says what it lacks in its summary (as `talks` does today) and the Mac greys the feature with "update omarchy". | the Mac's bundle speaks to a server of another version with no translator in between. There is no wire protocol version today. |
| **The rules it keeps** | the notification gate, the Needs rule, `kururu_status` and the unread mark run on the Mac's server over remote agents as they run over local ones, because the server sees them. | each would be redone on the client, or skipped: the Mac's server never sees the child's agents in full. |
| **Code** | `NodeWatch` on the server (one new file), an id grammar in `shared/`, labelling in the client. | a second `session.ts` and store on the client (the file says "one session to show and there will never be a second"), plus the token plumbing on both ends. |
| **If the Mac's page is compromised** | it can type into a child's terminal *through* the Mac's server, as it can type into the Mac's today; the gate (Origin, then token) is unchanged. | it holds the child's share token outright. |

**A is the recommendation**, and not narrowly: the direct route saves a loopback
hop and costs the phone, the auth story and the one place the rules run. The
parent-child plan's rule that *"opening a node's terminal means going to the
node"* was about not having a relay; the relay is what this plan adds.

### The watch socket, in detail

- **A second socket per pair, not more traffic on `/link`.** The `/link` socket
  carries the roster, summaries, the Kurus' words, sealed secrets and the
  Telegram handshake; its frames are small and a `lead-ask` must not wait
  behind a serialized screen. A pty stream and the occasional 100 KB backlog
  get a socket of their own, with its own buffer. The invariant "one WebSocket
  per pair" was about *presence* — a dropped link means away — and this socket
  says nothing about presence: it is **opened by the watcher while something
  of that node is on a screen here, and closed when nothing is**, so that an
  idle Mac costs the child nothing and a dropped watch is retried without
  anybody being marked away.
- **The watcher dials.** The roster carries the child's address and port, and
  a child binds its tailnet address, so the Mac can reach it (it draws
  `nodeUrl` for the window already). The handshake is the same two messages;
  `LinkHandshake` is reused as it stands. Should a child be unreachable from
  the Mac — a tailnet ACL that allows only outbound — the fallback is a
  `watch-open` ask over `/link` and the child dialling `/link/watch` back to
  the Mac, which is shared already. Both ends accept either direction; the
  first implementation does the first.
- **After the handshake, it is a client.** The child's `onUpgrade` for
  `/link/watch` refuses what `/link` refuses (`nodeRequestRefusal`: an
  `Origin`, a proxy's header, an address off the tailnet and loopback), runs
  the handshake, and then does precisely what `/ws` does on success:
  `clients.set(ws, {watching, warm, proposals, looking, awaiting})` and the
  opening sends. It gains one line: the client is tagged with the node id it
  proved, for the log and for the "mac is watching" chip below.
- **Confirmed by the spike, with three amendments.** The child needed the
  door and nothing more. `/ws`'s success path, lifted out as
  `admitClient(ws)`, served a proved parent unchanged, and the size the Mac
  proposed came back in the child's backlog. What the spike added to the
  design:
  - **The hand-off is synchronous.** `ws` emits every frame parsed from one
    chunk in one tick, so the frame that proves the peer must swap the
    handshake's listener for the client's inside the same call. A promise
    would drop the frames behind it: the Mac's first `watch`, or the child's
    `snapshot`. `LinkHandshake` is reused as it stands. `NodeHost` gains
    `watchHandshake(ws, expect, up, refused)` beside `open`, because `open`
    ties the handshake to a `Link`.
  - **A watcher is tagged, and the tag is read.** A watch is sent everything
    a window is: 18 message types and about 13 kB on open, on a near-empty
    profile. It also counts in `clients.size`, which starts the child's usage
    poll and, for a first client, its machine and OpenRouter polls.
    `ClientState.watcher` (the proved node id) makes the opening sends,
    those polls and the voice's `hush` skip it. It must never set
    `remoteClientAt`, which the setup wizard reads as the phone arriving.
  - **The relay forwards each frame as it comes and never coalesces.** The
    pty host already waits up to 16 ms (`OUTPUT_FLUSH_MS`) on the node that
    holds the pty. A second batching step on the Mac would be a second frame
    on every keystroke.
- **Who may watch whom is the parent's to say.** A watch is a client with
  hands on every pty of that node. A child's compromise is accepted in the
  parent-child plan as *"the ability to send messages into peers' Kurus as
  itself"*, marked; a shell on the Mac is a different order of thing. So in
  this plan **the parent watches children and nothing watches the parent.** A
  child refuses a watch from anyone but the roster's parent, and the parent
  refuses every watch. A later roster field can widen it (a child watching a
  sibling, for a second screen in another room); nothing here needs it.
- **The child says who is watching.** Its own page draws a small chip in the
  status bar — "mac is watching" — off a field in its `nodes` message, and
  `lifecycle.log` records each watch opened and closed with the node's name.
  The person at the box's own phone should be able to see that the Mac's
  window has hands on these terminals; it costs one field.
- **An old child cannot be watched, and says so.** `NodeSummary` gains
  `watchable: 1`, beside `talks`. A node without it is drawn as today — rows
  that link to it — with "update omarchy to open it here" in the tooltip.

### Ids, and the one grammar

Two nodes both mint `a237`, and two pools would collide. On the Mac's wire and
in its pool a remote thing is **qualified**: `n:<nodeId>:<id>`, for an agent,
a pane, a workspace, a tab (a doc tab's JSON address inside it unchanged) and a
card. `shared/remote.ts` is the grammar — `qualify`, `parseRemote`, `isRemote`,
`route(message)`: which node a `ClientMessage` is for, if any, with every id
in it de-qualified — pure and tested, and the only place the prefix is spelt.
A message that mixes two nodes' ids, or a local id with a remote one, is
refused there (a `move-tab` of a remote tab into a local pane is exactly such a
message, and the refusal is the rule for it).

A qualified id is **never written**: not into `session.json`, not into the
host's blob, not into `kururu.db`, not into `made.json`, not into
`nodes-seen.json`. The test for it is `persist.test.ts`'s sibling: a layout
file and a store export containing a qualified id anywhere fail.

### Latency, and what to expect

A keystroke travels page → Mac server (loopback) → child over the tailnet →
the pty, and the echo comes back the same way, after up to 16 ms in the
child's host (`OUTPUT_FLUSH_MS`, mean 8). **Measured on 2026-10-20, Mac to
omarchy, a key's echo costs 167 ms at the median, 235 ms at p90 and 255 ms at
p99, relayed through the Mac's server.** The direct path (B) measured the
same at the median, and `ssh -tt omarchy` (the machines feature's road)
measured 170 ms. ICMP ping averaged 165–173 ms. The relay itself costs
0.5–0.8 ms, measured on loopback, where a local terminal echoes in 10 ms and
a relayed one in 11. The full tables are in
[the spike](../spikes/remote-workspaces-phase0.md#the-numbers).

`tailscale status` said `direct` on both sides, but both endpoints were
public addresses: the two machines are on different networks, and "direct" is
a straight line across the internet. **That distance is the cost, not the
relay and not DERP.** The figure written here before the spike — 1–5 ms,
indistinguishable from local — holds only for two machines on one LAN. DERP
was not seen and could not be forced without running more `tailscale` than
`status`. A DERP path would add its relay's distance on top of these figures.

So **a remote pane feels exactly like the ssh shells to omarchy feel today**,
and nothing in kururu's relay changes that. Only a local echo, mosh's
prediction, would make typing feel local, and that is a feature of its own
(*Later*). A remote pane's backlog also arrives one round trip after it is
asked for: 150–360 ms against 2–5 ms locally. Keeping remote emulators warm
in the pool is worth more for them than for local ones.

A pty's output is the heavier direction: an agent TUI repaints a whole screen
on every token. The child already sends only what some client is watching
(`syncWatched` → `host.watch`), and the relay forwards only what some Mac
client is watching. Backpressure is the `ws` library's buffer on each hop, as
it is for the Mac's own clients today; a Mac window that falls behind holds
only its own socket back, and the relay drops `warm`-only output for remote
terminals nobody on the Mac is looking at rather than buffering it.

## Who owns what

| thing | owner | what the Mac holds | written to disk on the Mac |
|---|---|---|---|
| a remote workspace's layout, focus, tabs | the child's `Workspaces` | the latest snapshot, in `NodeWatch` memory | never |
| its ptys, their sizes, the backlog | the child's host and server | pooled emulators under qualified ids, per page | never |
| its board, cards, runs, history | the child's `Store` | the board as the snapshot carries it; verbs forwarded | never — the backup's `nodes/<name>/` mirror is the child's own export, as today |
| its files, documents, nvim | the child's disk and processes | nothing; reads are asked over the socket when a pane needs them | never |
| which remote workspace is on screen here | the Mac's server, in memory | `remoteOnScreen: {node, workspaceKey} | null` | never; a restart comes back on the last *local* workspace |
| the Mac's own layout, profiles, boards | the Mac, as today | as today | as today, and a qualified id in any of it is a test failure |
| the node chip's colour, the greying, the "away since" | the Mac's client, off the `nodes` message | `NodeStatus.state` and `since`, as today | never |

**The child is the source of truth, and the Mac's window is one more client of
it.** That is the whole of the ownership rule, and it is kururu's existing
rule for the phone and the window of one server. It has one consequence worth
saying aloud: a split, a tab move or a focus change made from the Mac's
window is made on the child, and the child's own phone sees it. That is how
two clients of one server have always behaved here (the arrangement is the
server's so that *"two clients agree"*), and it is the right answer for one
person with two screens. The alternative — a Mac-side copy of the child's
tree that could be arranged differently — is a second arrangement with a
merge rule, which is what `docs/layout.md` was written to avoid.

**Nothing on the Mac is written with it.** `Workspaces` never gains a remote
workspace; `persist.ts` never sees one; `Store` never sees a remote card;
`backup.ts` carries the child's boards only as the child's own export under
`nodes/<name>/`, as it does today. `remoteOnScreen` lives beside
`workspaces.active` and not in it, and `snapshot()` reports it in a field of
its own (`remote: {node, workspaceKey} | null`) so that a client knows the pane
area is drawing another node's tree. `agentPaneIn`, `sleep.ts`, `made.ts`,
`devservers.ts`, the branch walk and the database scan all read the Mac's
`Workspaces` and so never meet a remote workspace; the child's own copies of
each run on the child.

## Labelling and presence

A remote thing is never drawn without its node's name. One component, `Node
chip` (`web/src/components/NodeChip.tsx`), the machines chip's shape with the
node's name in it and a hue of that node's own — derived from its id and set
through tokens, never a hex, so `web/test/theme.test.ts` holds. Where it goes:

- **The sidebar.** The Nodes section stays where it is, under the Mac's own
  workspaces, and each node's workspaces become rows of the same shape as
  local ones — the name, the dot, the agent rows beneath with their mascots —
  and not links: a click on the workspace *switches the window to it*, a click
  on an agent reveals it, exactly as a local row does. Each node's block is
  headed by its name in its hue, and the chip rides on every agent row's
  tooltip ("claude on omarchy · asking something"). An away node's rows grey
  with "away since 23:10" as today.
- **The pane area.** While a remote workspace is on screen, the top band every
  pane strip shares (`--top-h`) is tinted in the node's hue and carries the
  node's name at the left of the first strip, so the whole tiled region reads
  as "this is omarchy's" from across the room. Each tab's label gets the chip
  after it, as a remote-machine tab does today.
- **Cards.** The board tab draws the child's board with "omarchy" in its
  heading, and every card's run says where its agent runs. A card's robot
  starts the run *there*.
- **The Needs drawer.** The node band stays, and its rows gain the door they
  lacked: a row goes to the terminal in this window (a `reveal-agent` with a
  qualified id, which switches to the remote workspace and focuses the pane),
  a card's row to the card on its board here. `Done` stays off for remote
  cards until phase 4, since a move to Done may retire a worktree on the
  child and asks there.
- **Notifications.** "claude on omarchy needs you", through the same
  per-client gate (`shared/notify.ts`), consulting the Mac client's `watching`
  of the qualified id. A remote agent's `blocked` is one the Mac's server now
  *sees* — in the relayed snapshot — rather than reads out of a summary.
- **The status bar.** Nothing: the bar is the Mac's (its usage, its OpenRouter,
  its machines). The child's own bar is on the child's page.

**Presence.** The watch is opened when a remote workspace goes on screen or a
remote agent's row is expanded, and retried with `dialDelay`'s backoff while
either is true. When the link drops:

- the panes stay drawn with what the pooled emulators hold, greyed as the
  sidebar's rows grey, with "away since 23:10" in the tinted band; nothing is
  torn down, because a window that empties itself when a lid closes is a
  window you cannot read;
- `input` to a remote terminal is refused at the Mac's server with the same
  words the drawer uses for a message it cannot send ("omarchy is away"), and
  the client draws it in the band for a moment rather than typing into
  nothing;
- the Needs chip stops counting that node, as it does today;
- `C-a` keys and the sidebar still move the window anywhere local.

When the link returns, the watch reconnects and the Mac's `NodeWatch` does what
`session.ts` does on `onopen`: it says `looking`, re-sends `watch` for the
union of what its clients have of that node, and tells every emulator of that
node's it is `stale`, so each asks for its backlog at its own size. The screens
fill in, the greying lifts, and nothing on either side was lost, because
nothing was held on the Mac in the first place. A child whose *host* restarted
has new agent ids and no old agents; that is the child's own cold start, and
the sidebar's rows and the panes draw what its snapshot now says.

**A server restart on the Mac** comes back on the last local workspace
(`remoteOnScreen` is memory) and reopens no watch until something of a node
is put on screen again. A window reload (`C-a R`) keeps nothing either; the
window re-asks for the workspace it was on through the snapshot's `remote`
field, as it does for a local one.

## Interaction

**Typing** is `input` with a qualified id, forwarded. The child records it
(`record.ts`), feeds `sleeper.typed`, and writes to its pty, as for its own
clients. The harness's `send_agent` is not this road and stays refused for a
remote id (below).

**Starting things.** A remote pane's `+` menu offers the *child's* launchers:
its `launch` settings arrive in its snapshot, and its `LAUNCHERS` are the
shared catalogue of whichever version it runs. `new-tab` with a qualified pane
id is forwarded with its `id`, and the child's `reply` comes back under the
same `id` — a child without Codex installed, or signed out, answers as it
answers its own phone. The spawn is the child's: its `logins.ts`, its lent
Claude token, its `kururu_web` flags, its hooks posting to its own loopback.
A card's run and resume are `run-card`/`resume-card` with a qualified
workspace id, forwarded; the agent lands in the child's agents' pane by the
child's `agentPaneIn`. A shell is `new-tab kind: shell`, the same.

**The file tree, the reader, nvim.** The tree reads a disk, and the disk is the
child's. `GET /api/files`, `/api/doc` (the rendered markup — the child's
`markdown.ts` highlights with its own Shiki, and the Mac draws the markup), the
reader's tabs and `open-in-editor` all go over the watch socket as asks with
replies, bounded in size and time the way `export-ask` is. The client fetches
`/api/node/<id>/files?…` on the Mac instead of `/api/files?…` when the
workspace on screen is remote, and the Mac's handler asks the child. The
alternative — the Mac's server fetching the child's HTTP routes with the share
token it already holds for the QR code — works for the parent only (a child
holds no token of the Mac's) and puts a token on a request a later edit could
log; the socket is symmetric and already has a timeout and an id. nvim needs
nothing: it is a pty, and its RPC socket is the child's `nvim.ts`'s. Made links
on a remote card name the child's disk and open through the same asks.

**Drag and drop.** Within a remote workspace every gesture works, because the
pane and tab ids it names are the same node's and the verb is forwarded. Across
the boundary nothing moves: a remote tab dropped on a local pane, or a local
tab on a remote pane, is refused by `route()` and the drop zone says "stays on
omarchy" — a pty cannot change machines, and a document dropped across would
be a different file. A file dragged from the Finder onto a remote terminal
would type a path the box has not got; it is refused with a sentence rather
than typed. Uploading the file is a different feature and is not in this plan.

**The keyboard.** The prefix and every action are the Mac client's, off the
Mac's keymap; what changes is where the verb goes. `C-a |` on a remote pane is
a `split` with a qualified pane id, forwarded. `C-a 1–9` stays the Mac's own
workspaces: remote ones live under their node and are reached by click, by the
Needs drawer, by `C-a o` (the next need, which may be on a node), and by `C-a
w`'s list, where they appear under their node's heading. Workspace stepping
(`C-a N`/`C-a P`) walks local workspaces, then each node's, in sidebar order.

**Focus.** The child's `focusedPaneId` is the child's and shared with its own
clients, as the Mac's is with its phone. Clicking a remote pane sends
`focus-pane`, forwarded, and the child's phone follows. One person, two
screens: this is today's rule between the Mac's window and its phone.

**Resizing.** The child decides, as the smallest grid over the clients that
can see the terminal and are `looking`. `NodeWatch` is one such client, and
presents, per remote terminal, `smallestGrid` over the Mac's own clients that
have it visible and are looking — the same pure function, composed — and
`looking: true` while any of them is. The result: a terminal watched from the
Mac's window and the box's own phone at once is drawn at the smaller of the
two, which is what the two screens of one server already get, and the phone
locking (`looking: false`) hands the size back. The Mac's skin changing pane
chrome resizes a remote pty as it resizes a local one, and a theme change
never does.

**Unread.** The child's `unread` is per agent and clears when any client
watches it; a Mac window watching a remote agent clears it on the child, and
the child's phone sees the mark go. One mark, one server.

## Kuru

**The rule stays: read anywhere, act locally, ask a peer.** The user typing into
omarchy's terminal from the Mac's window is the *user*, with the user's
authority, at a keyboard — not a Kuru, and not the harness's road. Nothing in
the relay goes near `/mcp`. So:

- The Mac's Kuru still hears nothing about omarchy's agents' `done`/`blocked`
  edges — those go to omarchy's Kuru — and `send_agent`, `read_agent`,
  `wait_agent`, `stop_agent`, `start_agent` and `run_card` still refuse a
  remote agent or workspace with "ask omarchy's Kuru with ask_kuru". The
  argument in `docs/nodes.md` ("two Kurus near Omarchy's agents, each acting
  on them with nobody saying which had") is unchanged by a human having a
  window on them.
- `kururu_status` gains one line: which remote workspace, if any, is on the
  user's screen, so that "what is this agent doing" spoken while looking at
  omarchy's pane resolves to the right node, and Kuru knows to `ask_kuru`
  rather than hunt locally.
- **One widening, read-only, in phase 3:** `read_agent` accepts a remote agent
  and answers with its screen off the relayed backlog, marked "on omarchy,
  read through the link". Reading is already allowed — the summaries carry
  every node's agents and their activity — and a user who can see the screen
  will ask Kuru about it. Acting stays with the node's own Kuru.
- Typing into omarchy's **Kuru terminal** directly, from a remote pane, is
  the user talking to omarchy's Kuru at its own keyboard; its hook takes the
  words as the user's. That is fine and honest. The drawer's `@omarchy` road
  (`[user@mac]`) remains the one that keeps the conversation in one place and
  speaks the reply here; the pane is the one that does not.

## Security

**What the Mac can do on the child:** everything a client of the child can do
— type into any pty, start agents and shells in any folder the child's user
can reach, read any file under the roots the child's `files.ts` allows, run
card verbs on its boards. It cannot change the child's settings (those verbs
carry no id and are never routed), cannot read a secret (`hint`s only cross,
as today), cannot reach the child's `/mcp`, and cannot restart its server or
host. This is the same reach the parent has had since phase 2 by holding the
child's share token for its QR code; what changes is that it is exercised
without the token, through a key the child can see is the parent's.

**The gate on the child.** `/link/watch` refuses what `/link` refuses, then
runs the handshake, then accepts only the roster's parent. Nothing it carries
is a token. A child removed from the roster drops the watch with the link, as
it drops everything else.

**The gate on the Mac** is unchanged: the window, the pill and the phone are
let in as today, and a page that is not ours is refused by `Origin` before
anything else. A compromised page on the Mac — an XSS in the web app — gains
what it has over the Mac's own agents today: typing. It gains it over the
children too, through the Mac's server. It gains no secret, because the page
holds none.

**The phone** touches none of this. It talks to the Mac and is handed remote
workspaces through the same socket and cookie; it never learns a child's
address or token.

**If the Mac is compromised** — the server, with its node key and its config
directory — the attacker already holds every secret kururu has, every child's
share token and the roster's signing key. A watch gives them nothing those do
not. What the child gains from this plan is a *record*: its `lifecycle.log`
says when the Mac opened a watch and its page shows a chip while one is open,
so a watch at three in the morning is at least visible to the person who looks.

**Over the tailnet**, everything is inside WireGuard, as every link is; the
watch refuses off-tailnet addresses and proxy headers like `/link`. The
relayed bytes include whatever an agent prints, which may include a secret
in a file it read; that is true of every terminal kururu already streams to a
phone, and the watch adds no new place those bytes rest — they pass through
the Mac's server's memory and are not recorded there (`record.ts` records
the Mac's own ptys, keyed by its own agents, and never a qualified id).

## Phases, as cards

Effort is in agent-days, as the parent-child plan counts them. Every phase ends
with its tests (pure functions in `shared/`; the routing checked between two
throwaway instances on this Mac, as the nodes were verified), with
`docs/nodes.md` grown by a section, and touches CLAUDE.md only where a rule
changes. **No phase edits the pty host, `hostlink.ts` or `hostsock.ts`**, so
none costs a running agent; the child needs `kururu child update` once, for phase 1.

### Phase 0 — a spike, measured (1 day)

The Mac's server opens a socket to a throwaway child on this Mac (two
isolated instances, as the nodes were verified), authenticated by the node
handshake, and prints the child's snapshot; then relays one agent's bytes into
a hard-coded pane. Then the same against the Omarchy PC, with `tailscale status`
read by hand on both sides, to write down what a keystroke's echo costs
direct and relayed. **Done** is a number in this document's latency section and the
"watch socket is a `/ws`" idea confirmed or replaced.

**Done, 2026-10-20.** The spike ran on two throwaway instances on the Mac,
then against a throwaway child on omarchy (its own port, config and host,
never the box's kururu). The snapshot printed, and one agent drew in a
hard-coded pane of a real page. Keys typed there reached the box's pty.
"The watch socket is a `/ws`" is **confirmed**, with the three amendments in
[the watch socket](#the-watch-socket-in-detail). The number is in
[latency](#latency-and-what-to-expect): 167 ms at the median from the Mac to
omarchy, the same as ssh. The record, the patch and the timing scripts are
in [`docs/spikes/remote-workspaces-phase0.md`](../spikes/remote-workspaces-phase0.md).
The spike never tried a sibling's watch being refused; phase 1's test does.

### Phase 1 — a remote workspace on screen (4–6 days)

The first useful slice, and the one that ends "two kururus open" for
terminals.

- `shared/remote.ts`: the grammar and `route()`, tested; `NodeSummary.watchable`.
- The child: `/link/watch` → `watchHandshake` → parent only →
  `admitClient` (lifted out of `/ws`); `ClientState.watcher`, which skips
  the opening sends, the polls and the voice; `lifecycle.log` lines; the
  "mac is watching" field. A `nodes.test.ts` case: a sibling's watch is
  refused, and the parent's is let in. The spike's patch
  (`docs/spikes/remote-workspaces-phase0/spike.patch`) is a starting point
  for the door and the handshake. Its relay is not: it handles one agent, and
  its prefix is spelt in place rather than in `shared/remote.ts`.
- The Mac: `server/src/nodewatch.ts` — one per node, opened while anything of
  the node is on screen; snapshot held; ids qualified on the way in,
  de-qualified on the way out; `watch`/`looking`/proposals composed; a
  per-client `awaiting` for remote backlogs; `remoteOnScreen` and the
  snapshot's `remote` field; `switch-workspace` with a qualified id.
- The client: the Nodes section's rows become real rows (switch, reveal); the
  pane area draws the remote tree from the `remote` snapshot with the tinted
  band and chips; the board tab draws the child's board with its verbs
  forwarded; a doc tab in a remote pane draws "a document on omarchy — opens
  there in phase 2" rather than nothing; greying and the away words; the
  input refusal.
- **Done:** on the Mac's window, click omarchy's workspace in the sidebar; its
  panes and tabs appear as its own phone shows them; type into its claude and
  see the echo; split a pane and watch the phone follow; close the box's
  server and see the band grey; start it again and see every pane refill
  without a reload; `session.json` and the database carry no `n:` anywhere
  (the new test). Verified between two throwaway nodes, then with the user on
  the Omarchy PC.

Depends on phase 0's answer. Runs beside nothing (it touches `index.ts`'s
`handleMessage` on both nodes).

**Built, 2026-10-20, and verified between two throwaway nodes on the Mac**
(a parent on :7871 and a child on :7872, paired by the join command, from a
scratch copy; the user's server and host untouched). Over the protocol: a
`cat` on the child shown, its backlog at the parent's proposed 90×24, a key's
echo in 2 ms on loopback, the child's own client seeing the typed line and
held to the smaller grid, a split made from the parent arriving on the child's
own client, a `new-tab` in a remote pane answered under its qualified id and
closed through the relay, a remote tab dropped on a local pane refused with
its sentence, `C-a 1` putting the local workspace back, and the idle watch
closed after its minute with both `lifecycle.log`s saying so. The child's
server stopped with SIGTERM (its host kept): the parent's view went `away`
within milliseconds, typing was refused with "omarchy is away — that was not
typed", and on the restart the watch was back in under a second, the
emulator was told it was stale, the same pty's screen refilled, and typing
echoed again. In a real page (headless Chrome over the DevTools protocol):
the Nodes rows as buttons, the band in the node's hue with its name, every
tab's chip, keys typed into a stand-in `claude` on the child, the greying
with "away since", the refusal in the band, the refill without a reload, and
"mac is watching" on the child's own page. No file in the parent's state
directory held a qualified id afterwards. **Not yet:** the two real
machines, which want the Mac's server on this code and `kururu child update`
on the box.

Decisions taken in the building, beyond the text above: a card's id is not
qualified, since every verb about a card names its workspace and the
workspace says whose it is; the watch closes a minute after nothing of the
node is on screen, and pooled emulators alone do not keep it open (they are
told `stale` and rebuild when borrowed); a document tab in a remote pane says
where it is rather than reading this disk, and the file tree stays shut;
the `+` menu offers the child's own launch settings already, which phase 4
was to do; `bun run status` prints `watching` and `watched by`, which phase 5
was to do.

### Phase 2 — files, the reader, nvim's hand-offs (3–4 days)

- Asks over the watch: `files-ask`/`files` (the tree), `doc-ask`/`doc` (the
  rendered markup and the raw text), `editors-ask` (for `open-in-editor`),
  `made-ask`, each bounded as `export-ask` is.
- The Mac's `/api/node/<id>/…` handlers and the client's fetch choosing them
  when the workspace on screen is remote; the reader's zoom and tabs
  unchanged.
- `open-made` for a remote card's links; `MadeLinks` draws them with the chip.
- **Done:** the file tree of omarchy's workspace draws in the Mac's window,
  a markdown file opens in the reader with highlighting, a code file opens in
  a new nvim tab there at the line, and a made link on one of its cards opens.

Depends on 1. Runs beside 3 and 4.

**Built, 2026-10-20, and verified between two throwaway nodes on the Mac**
(a parent on :7961 and a child on :7962, paired by the join command, from a
scratch copy; the user's server and host untouched, and phases 3 and 4's
throwaways on their own ports). Over the protocol: the child's project came
up in `snapshot.remote.project` with its root qualified; the parent's
`/api/node/<id>/ls` listed the child's folder and a folder under it,
`docs` named the child's roots qualified, `markdown` was the child's render
with its code highlighted and its image pointed back through the parent,
and `file-raw` served that image's bytes under the reader's CSP. A root the
child never found, a path out of its root and a node that is no member were
each refused, and there is no `fs`. `show-doc` with a qualified root opened
the README as a tab in the remote pane, with its root qualified on the
parent's view and bare on the child's own client. `find-editors` was the
child's, `open-in-editor` started an nvim on the child at `+2` in the
project and came back with its id qualified, and a second file went into
that same nvim over its RPC. A file of this disk's sent into the remote pane
was refused with its sentence. A card run on the child (a stand-in claude)
whose turn ended naming `docs/PLAN.md` gave the remote card a made link on
the child's disk, and `open-made` of it, routed, opened PLAN.md in the
remote workspace's reader. In a real page (headless Chrome over the
DevTools protocol): `C-a e` opened the tree of the child's disk with the
node's chip and the root as the child spells it, the root picker moved it
between the child's folders, the README drew with highlighting and its
image, a tree click read PLAN.md, a code file's click offered the child's
nvims by their tabs' names and a new one, and the card's made link wore the
chip and said where it opens. No file in the parent's state directory,
database included, held a qualified id. Run again after rebasing onto
phases 3 and 4. **Not yet:** the two real machines.

Decisions taken in the building, beyond the text above:

- **Roots are qualified, not only ids.** The plan had the tree choose the
  node's routes "when the workspace on screen is remote". That holds the
  disk in the component's head, and a verb would still be routed by its
  pane alone. A root of a node's reaches a page as `n:<node>:<root>`
  instead, wherever it appears: a document tab, a reader, the project, a
  made file. The root a component already holds says which disk it is, the
  URL is decided once (`web/src/disk.ts`), and `route` refuses a pane and a
  root of two machines' with one sentence for both directions. Phase 1's
  "a file from this computer cannot open on another one" is that rule.
- **`editors-ask` and `made-ask` are the verbs that were already there.**
  The watch is a `/ws` client of the child, and `find-editors`,
  `open-in-editor` and `open-made` are verbs with replies there, which the
  relay carries. A second message for each would have been a copy of the
  first with a different name. Their replies' ids are qualified on the way
  back, a list of them for `find-editors`. Only the HTTP reads needed new
  asks: `files-ask` (`ls`, `docs`) and `doc-ask` (`markdown`, `raw`). The
  raw text the plan listed (`/api/file`) is something no page fetches, so it
  was left out.
- **The tree only reads on a node.** Its edits — new, rename, move, the
  Trash — are not offered there, and the parent has no `/api/node/<id>/fs`.
  The plan's Security section names reading the node's files, not changing
  them, and a delete on another machine should not look like a
  right-click on this one's. If wanted, it is one more op on `files-ask`
  and a confirmation that names the node.
- **The child renders in the asker's theme**, sent with `doc-ask`, rather
  than its own, so code in a document matches the Mac's panes. A theme the
  child does not know draws the child's fallback, as an unknown theme on a
  page there always has.
- **`watchable` is 2** from a node that answers the reads (`WATCH_READS`).
  One at 1 keeps phase 1's view and its tree says to update it, rather than
  timing out.

### Phase 3 — needs, notifications, and what Kuru is told (2–3 days)

- The Needs drawer's node rows become doors into this window; `C-a o` steps
  onto a node's need.
- `noticeStatuses` runs over relayed snapshots for the Mac's clients'
  `watching` of qualified ids; the words carry the node.
- `kururu_status`'s "on your screen" line; `read_agent` read-only for a remote
  agent, marked.
- **Done:** a blocked agent on omarchy raises a card on the Mac saying so and
  the click lands on its pane here; Kuru, asked about the agent on screen,
  reads it and says where it is.

Depends on 1. Runs beside 2 and 4.

**Built, 2026-10-20, and verified between two throwaway nodes on the Mac**
(a parent on :7871 and a child on :7872, paired by the join command, from a
scratch copy; the user's server and host untouched). Over the protocol: a
stand-in agent on the child reported `blocked` with no watch open, and the
parent's client was sent "… on mac-2 needs input" under the qualified id,
read off the summary; the click's `reveal-agent` put the child's workspace on
screen, and once the watch was up the child's own focus moved to that tab,
which had not been the selected one; with the watch up, a `done` was raised
off the relayed snapshot; with the terminal on the client's screen, nothing
was (`whenVisible` off). Over `/mcp`: `kururu_status` said which node's
workspace was on the user's screen and the agent with the keyboard there,
`read_agent` with the qualified id read the text typed into it "through the
link", and `send_agent` and `source=reply` were refused with the road that
does reach it. In a real page (headless Chrome over the DevTools protocol):
the drawer's node band as buttons, a row landing on its pane, `C-a o` from a
local workspace onto the node's first need and then its next, and a card in
Review with no agent opening the node's board with the card lit.
`server/test/remoteneeds.test.ts` holds the walk, the edges and their two
sources, the kept reveal and the read against a stand-in child. **Not yet:**
the two real machines.

Decisions taken in the building: the notices read the relayed snapshot
while a watch is up and the summary while none is, rather than only the
snapshot, since the watch is open only while something of the node is on
screen and the card is most wanted when nothing is; a change of source is a
first look and raises nothing. Kuru names another node's agent by its
qualified id (`kururu_status` lists it), not by a `node` argument with a
bare id, so that an acting tool handed the id refuses it by its prefix
instead of finding this node's own `a7`. A remote `read_agent` is the screen
only. Done on a node's card in the drawer is phase 4's, which landed
first; the node's band carries both.

### Phase 4 — starting work from here (2 days)

- The `+` menu in a remote pane offers the child's launchers; `new-tab`
  replies routed; a card's robot and resume forwarded; the `Done` button on a
  remote card's Needs row where the move is plain (the child's own rule,
  answered through a `plain-done-ask`), the dialog's cases going to the board.
- "New workspace on omarchy" from the node's heading, with the folder judged
  there (`judgeFolder` from `move.ts`, reused as an ask).
- **Done:** from the Mac's window, a claude is started in omarchy's workspace
  with omarchy's login and web tools, a card is run there, and a new workspace
  is made there in a folder the box checked.

Depends on 1. Runs beside 2 and 3.

**Built, 2026-10-20, and verified between two throwaway nodes on the Mac**
(a parent on :7941 and a child on :7942, paired by the join command, from a
scratch copy, with a stand-in `claude` and `codex` that print what they were
started with; the user's server and host untouched). Over the protocol, from
the parent's socket: the child's guess for a new workspace's folder
(`~/Projects`, "not a git repository"), `/etc` refused there with its
sentence, `~/Projects/pagos` made and put on screen; a claude and a codex
started in it from a remote pane, each with the child's hooks and its
`kururu_web` flags pointed at the child's own `/mcp/web` and token, and no
config directory of the parent's; a card run there with its reply's agent
qualified, its resume refused by the child while the agent was open; a card
in Review with nothing open marked `plainDone` in the child's summary and
moved by `node-card-done`, one with its agent open refused with "Its agent
is still open…", and the same Done twice answered "It is in Done already."
In a real page (headless Chrome over the DevTools protocol): the `+` beside
the child's name, the dialog's guess and its check as a folder was typed,
the new workspace on screen in the node's band, the remote pane's `+` menu
drawing the child's rows, and the Needs drawer's Done on the child's row
taking it away; on the child's own page, no `+` on its parent's heading.
**Not yet:** the two real machines.

Decisions taken in the building: Done and the new workspace go over `/link`,
not the watch, because the Needs drawer and the sidebar draw them from the
summary whether or not a watch is open; "plain" is `doneRefusal`, one rule
the summary's mark and the node's answer both read, rather than a
`plain-done-ask` that only asked; the folder check is the move's own
`workspace-move-check`, with a folder that is not a checkout let through
(`newFolderOk`); the `+` on a node's heading is drawn only on the parent,
which is the only node that can then show what it made; the launchers ride
in the summary (`NodeSummary.launchers`), so the robot on a remote board
offers the box's rows before any snapshot of it has arrived.

### Phase 5 — edges and polish (3–5 days)

- Cross-boundary drops refused with their sentence; the Finder drop refused;
  `C-a w` and workspace stepping across nodes; the `remote` field through a
  window reload; the picker's "Open omarchy" kept as the way to the child's
  Settings and nothing else, and said so in Settings → Nodes.
- ~~The child's chip and log; the Mac's `bun run status` saying which nodes it
  watches.~~ Built with phase 1.
- Docs: grow `docs/nodes.md#remote-workspaces` (written with phase 1, as
  was the CLAUDE.md invariant below).
- **Done:** the user drives omarchy for a day from the Mac's window and opens
  the child's page only for its Settings.

Depends on 1–4.

**Built, 2026-10-21, and verified between two throwaway nodes on the Mac**
(a parent on :7981 and a child on :7982, paired by the join command, from a
scratch clone; the user's server and host untouched). In a real page
(headless Chrome over the DevTools protocol): `C-a N` from the parent's
first workspace walked its second, the child's two and back round, and
`C-a P` from there went back onto the child's last; `C-a z` went from the
child's workspace to the local one it was put up over and back again; a
reload kept the child's workspace on screen, its terminal borrowed again
and the watch up; `C-a w` listed the parent's two, then the child's under
its name, marked the one on screen, filtered by the node's name and put the
pick on screen; a sidebar agent dragged over the child's pane drew "Stays
on mac: a terminal cannot move between computers" and no zones, the
child's own tab over its pane still drew them, the child's tab over the
parent's sidebar rows lit none, and a Finder file over the child's terminal
was refused with its sentence in the band; Settings → Nodes said what the
child's page is for, its button pointed at the child's page with
`#settings`, and that page opened on Settings with the hash taken out.
`server/test/remoteedges.test.ts` holds the walk, the stepping and the
toggle through `NodeWatches`, and the refusals; the tray's and the
picker's rows are held by `desktop/test`. **Not yet:** the two real
machines, which this phase's Done is about.

Decisions taken in the building:

- **The window reload needed nothing.** Which remote workspace is on screen
  was the server's from phase 1, so a page that reloads is handed it in its
  first snapshot; the check was that nothing a fresh page sends takes it off
  screen, and nothing does.
- **`C-a z` was a bug, not polish.** Before, it took a remote workspace off
  screen and then ran the local toggle, which went to the local workspace
  *before* the one the window had been on. It now goes back to the one
  under the remote workspace, and from there to the remote one again; the
  local one the window landed on is read after the verb that took the
  remote one off screen has run, so a click, a key or Auto Swap all count.
- **A drop is refused before it lands, not after.** `route` already refused
  the verb; what was missing was saying so while the thing was over the
  pane, so nobody lets go and watches nothing happen. The sentence is the
  same one, from one function (`dropRefusal`), and a node's tab over this
  node's sidebar rows lights nothing rather than saying anything, since
  those rows are all this machine's.
- **The Finder's refusal is said while the file is held**, in the band, at
  most once a second; `dropEffect` is `none`, so no drop happens to refuse.
- **"Open omarchy" opens its Settings.** Moving the window there is kept,
  as the plan's question 7 says, but the window lands in Settings
  (`#settings`) and the row says "omarchy's Settings", so the gesture is
  what it is for. A node too old to be watched keeps "Open".

### Later, each on its own, not scheduled

- **A remote tab beside a local one** — `n:` ids in the Mac's own tree, with
  `persist.ts` stripping them on the way to disk. The workspace-as-unit shape
  above does not need it, and it is the one thing in this plan that would put
  a qualified id into `Workspaces`. 3–4 days, if wanted.
- **A child watching another node** — one roster field, parent-set. 1 day.
- **The child's Settings in the Mac window** — its pages are the same bundle
  drawing a `settings` view off a snapshot; the setters would need routing by
  a node field rather than by id. 2–3 days.
- **Dev servers of a remote workspace** — the child's proxies are on the
  child's address, which the phone cannot reach through the Mac without a
  second relay. The row says "on omarchy" and links to the child's proxy
  for the window; the phone's road is a proxy-of-a-proxy and not worth it.
- ~~**The direct path (B) for the window only**, should the spike show the
  relay's loopback hop matters.~~ It does not: the hop costs 0.5–0.8 ms
  against a 167 ms round trip, and B showed the worse tail.
- **A local echo for remote panes**, mosh-style: the emulator draws a typed
  character before the round trip confirms it. This is the only thing that
  makes a 170 ms link feel local. It needs care with TUIs that do not echo,
  such as Claude's input box and nvim. Days, and its own design.

Total: roughly 15–21 agent-days, 0 then 1, then 2, 3 and 4 side by side,
then 5.

## The invariant, for CLAUDE.md, once phase 1 ships

> **Another node's workspace on this screen is that node's, shown here.** The
> Mac's server watches a child as one more client of it (`/link/watch`, let in
> by the node handshake, parent to child only, open only while something of
> the node is on screen) and relays its session under ids qualified `n:<node>:…`
> (`shared/remote.ts`). The child owns the layout, the ptys and the size; a
> verb from here is forwarded, never applied here. No qualified id is ever
> written — not to `session.json`, the host's blob, the database or
> `made.json` — and a test holds it. Kuru's rule is unchanged: the user typing
> into a remote pane is the user; Kuru still acts locally and asks a peer.

## Prior art, briefly

Four tools draw the same line, and the lesson is the same from each: **the
side with the data owns the state; the other side is a view, and it says so.**

- **VS Code Remote** runs a *VS Code Server* on the remote machine — the
  extension host, the file system, the terminals — and a thin UI locally, over
  one tunnelled connection. Extensions are split by where they need to be
  (UI extensions local, workspace extensions remote), and every remote path is
  a `vscode-remote://` URI so nothing in the UI can mistake it for a local
  one. Kururu's analogue is the qualified id: a remote thing is never spelt
  like a local one.
- **JetBrains Gateway** goes further: a whole headless IDE backend on the
  remote, and a thin client that renders the backend's UI state; Gateway
  supervises both ends over SSH. The backend owns the project entirely. That
  is the child already — a whole kururu server — and the lesson is that the
  client should hold nothing the backend does not.
- **Zed remote development** runs a headless Zed server over SSH, with the
  project, its files and its terminals on the remote and the UI local; its
  own account of building it says the hard part was re-establishing the
  connection without losing the local UI's state. That is the presence
  section above: the Mac holds nothing, so there is nothing to lose, and the
  emulators keep their last screen until the stream returns.
- **tmux** is the oldest of them and the one kururu copies most: a session is
  the server's, any number of clients `attach`, a detached client loses
  nothing, and `window-size smallest|largest|latest|manual` is the whole
  argument about size that `sizing.ts` already had with itself. A relay that
  composes the minimum is `smallest` applied twice, which is still `smallest`.

## Risks

- **Distance, and DERP on top of it.** Mac to omarchy is 167 ms per key on a
  `direct` path, because direct here crosses the internet (the spike). A
  pair that cannot punch through types over a DERP relay as well. Kururu itself never
  runs `tailscale` (`reach.ts` says why, and rule 4 says so), so it cannot
  draw `direct`/`relay` beside a node; the user reads `tailscale status` on
  either machine, and Settings → Nodes says that is where the answer is.
- **Version skew between the two `index.ts`.** The relay passes the message
  types it knows and ignores the rest; a child ahead of the Mac sends fields
  the Mac drops. `watchable` gates the feature; a wire protocol version for
  `/ws` would be the honest fix and is a day of its own.
- **Two clients, one focus.** The box's phone following the Mac's clicks is
  today's rule and may still surprise. If it does, a Mac-local focus for
  remote panes is a client-side map and a day.
- **Backpressure on a slow Mac window** with a chatty agent on the box. The
  relay drops warm-only output and the window's own socket buffers the rest;
  `ws.bufferedAmount` is watched and logged above a threshold.
- **The reader's markup is the child's Shiki's**, at the child's version;
  a theme the Mac has and the child lacks draws the child's fallback. Said in
  the tooltip.
- **A remote workspace on screen during `bun run dev`** restarts the Mac's
  server on every save and reopens the watch each time — the child sees a
  client come and go, which is what its phone does when it sleeps. Cheap, but
  noisy in `lifecycle.log`; the lines say "watch" so they can be told apart.

## Open questions, each with a recommended answer

1. **Mirror the child's layout, or a remote tab in the Mac's own panes?**
   *Mirror.* The workspace is the unit; the tree arrives in the snapshot; the
   arrangement stays the server's — the child's. A remote tab beside a local
   one is the one shape that writes a qualified id into the Mac's tree, and it
   waits until somebody wants it.
2. **Should focus, tab selection and splits made here move the child's own
   screen?** *Yes.* It is what two clients of one server do today, and it is
   one person. A Mac-local focus is a day if it grates.
3. **Who may watch whom?** *The parent watches children; nothing watches the
   parent.* A compromised child must not gain a pty on the Mac. A roster flag
   can widen it later.
4. **Should the child show who is watching?** *Yes*, a chip and a log line.
   Honest and nearly free.
5. **One hue per node for the band and chips?** *Yes*, derived from the node id
   through tokens, and the same hue in the Kuru drawer's node chips so the two
   agree.
6. **The watch on `/link`, or a socket of its own?** *Its own*, same handshake,
   opened by the watcher only while something is on screen. Pty bytes must not
   queue ahead of a `lead-ask`, and a dropped watch must not mean away.
7. **Keep "Open omarchy" in the picker and tray?** *Yes, demoted*: it becomes
   the way to the child's Settings and the fallback for an old child, and
   Settings → Nodes says so.
8. **Kuru reading a remote agent through the watch?** *Yes, read-only, in
   phase 3.* Acting stays with `ask_kuru`.
9. **Remote workspaces in `C-a 1–9`?** *No.* They live under their node; `C-a
   w`, `C-a o`, the Needs drawer and the click reach them.
10. **The phone's road?** *Through the Mac only.* The relay gives it for free;
    the direct route needs the child's token on the phone and breaks under
    `https:`.
11. **Accept relayed (DERP) latency, or warn?** *Measure in the spike, and
    point at `tailscale status` in Settings → Nodes.* Kururu runs no
    `tailscale` command and cannot change which path the tailnet takes.
    *Measured:* 167 ms at the median on a direct path to omarchy, the same
    as ssh. Settings → Nodes should say that a remote pane types like ssh to
    that box, which the user already knows the feel of.
12. **Should a remote pane's `+` offer the Mac's launchers or the child's?**
    *The child's.* The agent runs there with its logins and tools; offering
    a model the box has not got would be a tab that says so after the fact.

## Appendix — what was read, 2026-10-20

`shared/wire.ts` (the protocol: `watch`, `propose-size`, `request-backlog`,
`output`/`grid`/`backlog`, every verb by id), `shared/model.ts`
(`SessionSnapshot.profile` carries every workspace's layout and board),
`shared/layout.ts` (`BOARD_TAB`, `docTab`, `terminalsOf`), `shared/nodes.ts`
(`LinkMessage`, `NodeSummary.talks`, `LinkHandshake`, `nodeUrl`),
`server/src/index.ts` (`onUpgrade` for `/ws` and `/link`, `ClientState`,
`applySize`, `syncWatched`, `sendBacklog`, `pushSnapshot`, the `NodeHost`
wiring), `server/src/nodes.ts` (`NodeHost`, `ask`, dialling, away),
`server/src/access.ts` (`verdict`, `originAllowed`, `presented`,
`cookieHeader`'s `SameSite=Lax`), `server/src/sizing.ts`, `server/src/hostlink.ts`
(`HOST_PROTOCOL`: nothing here touches it), `web/src/session.ts` (one socket,
`onopen`'s re-`watch` and `stale`), `web/src/terminals.ts` (the pool by id),
`web/src/components/Panes.tsx`, `Terminal.tsx`, `Sidebar.tsx` (`NodeBlock`),
`NeedsDrawer.tsx` (`NodeBand`), `web/src/labels.ts` (`remoteHost`,
`remoteNote`), `web/src/nodes.ts`, `desktop/preload.js`, `desktop/nodes.js`,
`desktop/main.js` (`openNode`, `connect`, `withToken`); `docs/nodes.md`,
`docs/terminals.md`, `docs/architecture.md` (Access, Discovery),
`docs/machines.md`, `docs/layout.md` (What needs you, Persistence),
`docs/notifications.md`, `docs/testing.md` (the isolated instance), and the
parent-child plan's architecture, ownership, security and *Later* sections.
On the web, through kururu's own Firecrawl: VS Code's Remote Development and
VS Code Server pages, JetBrains' Gateway deep-dive and the CLion remote
development overview, Zed's remote development docs and its "SSH Remoting is
Here" post, and tmux's `window-size` as its manual and three answers describe
it.
