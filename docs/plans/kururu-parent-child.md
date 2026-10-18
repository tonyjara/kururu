# Kururu, parent and children

A plan, written 2026-10-18 from a read of the tree at `de21c93` and a read-only
look at the Omarchy PC, then revised the same day with the user. Nothing in it
is built. It is written so that an agent can take one phase, read the files it
names, and know what "done" is. The first draft had one Kuru driving every
node's agents and a Telegram poller set by hand; both are gone, for the
reasons under *Kurus are peers* and *One Telegram*.

## Summary

The Mac keeps the kururu it has: the window, the voice, the talk key, the
profiles and boards. Another PC gets a **child**: the same server and the
same pty host, built from the same checkout, run as a systemd user service
under a user of its own, with no window and no voice, serving the same web
app to a phone over the tailnet. A child owns its own workspaces, boards,
cards, agents and Kuru, in a database of its own, and keeps working when the
Mac's lid is closed.

**Nodes, ranks, a roster.** Every kururu is a *node*. The Mac is the
**parent**: it enrols and removes nodes, signs the roster that says who is a
member, and holds every secret. The roster also carries a **rank**, the Mac
first by default, and the highest-ranked node that is reachable is the
**leader**. Every node links to every other, so the Mac's sidebar and Needs
drawer draw each child's workspaces, agents and asks, and a child's own UI
says when the Mac went away.

**Kurus are peers.** One Kuru per node, always on for its own node: its own
agents' notices, its own boards, its own memory. The rule is *read anywhere,
act locally, ask a peer to act remotely*: any Kuru can see every node's
agents, only the local Kuru acts on them, and a Kuru that needs something done
elsewhere sends one message to that node's Kuru. One drawer shows every Kuru's
conversation, each bubble marked with its node, and `@omarchy` addresses one.

**One Telegram.** Only Kuru speaks. The leader polls the bot; a bare message
goes to the leader's Kuru, `@omarchy` or a reply to one of its lines goes to
that node's. When the Mac's lid closes, the next node in rank takes the poll
within a minute and the chat is told; when the Mac comes back, it takes the
poll back after its link has been steady for a minute and the holder is quiet.

**Secrets live on the parent and are lent, one grant at a time.** A small
store of kururu's own: the `0600` files the parent already keeps, pushed sealed
to a child's key, kept on the child as the same file every existing reader
reads, taken back with one click. The child's Claude account is the Mac's,
lent as a `claude setup-token` grant, so it can be lent again to a third
machine.

**With the lid closed**, the phone opens the child's own address and sees the
child's workspaces — everything that is still running — and a line saying the
Mac has been away since when. Nothing on the Mac can be driven while it
sleeps, and the plan does not pretend otherwise.

The first phase is useful alone: a headless child on the Omarchy PC with its
own phone UI over the tailnet, before any link, Telegram or secrets.

## The architecture

```
                  the tailnet (WireGuard; Tailscale's identity and encryption)
   ┌──────────────── Mac: the parent, rank 1 ────────────────┐       ┌────────── Omarchy PC: a child, rank 2 ──────────┐
   │  window ─┐                                               │       │  (a dedicated user; no window, no voice)         │
   │  pill   ─┼─ ws ─▶ server :7717 ◀─ sock ─ host (launchd)  │       │     server :7717 ◀─ sock ─ host (systemd unit)  │
   │  phone  ─┘        │     ▲                                │       │       ▲      ▲                                   │
   │                   │     │ /api/report (hooks)            │       │       │      │ /api/report (hooks, local)        │
   │               kururu.db, ~/.config/kururu (every secret) │       │  kururu.db, ~/.config/kururu (granted secrets)   │
   │                   │                                      │       │       │                                          │
   │   NodeHost ◀──────┼──── /link: one socket per pair ──────┼───────┼── NodeHost (the child dials; lower rank dials   │
   │   (roster signed  │     summaries, Kuru messages and     │       │    higher; every node links to every other)      │
   │    here; secrets  │     replies, board verbs, sealed     │       │                                                  │
   │    pushed from    │     secrets, lead handshake,         │       │   Kuru (harness) ──▶ its own agents only          │
   │    here)          │     a workspace moved)               │       │   polls Telegram while it is the leader           │
   │   Kuru (harness) ─┴─▶ its own agents only                │       └───────────────────────▲──────────────────────────┘
   │   polls Telegram while it is the leader                  │                               │
   └──────────────────────────────────────────────────────────┘        phone ── http://<child tailnet ip>:7717/?k=… ──┘
                                                                        api.telegram.org ◀── getUpdates, from the leader only
```

Three things to read off it:

- **A child is not a lesser kururu.** It is `server/` and `web/dist` with no
  `desktop/`. Everything a phone can do against the Mac today it can do
  against a child, because the server never knew whether a window was there.
- **The link is a mesh, and the roster is what lets strangers link.** Two
  nodes that have never met prove their keys to each other and trust the
  Mac's signature on the roster. The Mac dials nobody and listens on its
  tailnet address, which Share already turns on for the phone.
- **Leadership is one job, the Telegram poll, and it follows rank.** The
  Kurus do not move; only the poll and the default addressee do.

## What kururu is today, and what a child reuses

Read against the docs and the code; the file map is `docs/map.md`.

| piece | today | on a child |
|---|---|---|
| pty host (`ptyhostd.ts`, `agents/`) | a launchd job on a clone of the app, one unix socket, outlives the server | the same bundle, as a transient systemd user unit; the one piece that must not be in the server's cgroup |
| server (`index.ts` and the restartable half) | Node 24 (Electron's), `run.mjs` supervises, exit 75 restarts | the same, node 26, `run.mjs` under a `kururu.service` user unit |
| web app (`web/dist`) | one build for the window and the phone; `NARROW` (720px) and the coarse pointer decide the phone layout (`App.tsx`) | served unchanged; the phone is its only client |
| access (`access.ts`) | loopback bound unless shared; one token in the QR; `Origin` checked; loopback exempt | bound to the tailnet address only; the token required on loopback too (see security) |
| boards, turns, outbox (`store.ts`, `node:sqlite`) | `~/.local/share/kururu/kururu.db`, schema 4 | a database of its own, made on first start; nothing migrates |
| profiles and logins (`logins.ts`) | `CLAUDE_CONFIG_DIR` / `CODEX_HOME` per profile under `~/.config/kururu/profiles/` | one profile, its Claude account lent from the Mac as a token |
| harness (`harness.ts`, `mcp.ts`, `/mcp`) | one Claude Code session per profile with kururu's verbs as MCP tools | the same, on the child, its own Kuru; peers reach it by name over the link |
| hooks (`hooks.ts`, `report-cli.ts`) | `report.mjs` beside the server, `KURURU_PORT` in every pty | identical, and local — which is what the machines feature lacks |
| web tools (`/mcp/web`, `web/chain.ts`) | loopback-only MCP, keys read per request from `0600` files | identical once the keys are granted; an agent on a child finally has `kururu_web` |
| Telegram (`telegram.ts`, `channels.ts`) | long poll, allow-list, token `0600`, one profile's Kuru | the poll runs on the leader; every Kuru's replies reach the chat through it |
| the drawer (`kuru.ts`, `KuruDrawer.tsx`) | one profile's turns, outbox and missed list merged | the same, plus every reachable peer's turns, marked by node |
| machines (`machines.ts`) | ssh gauges, shells and agents in tmux, status read off the screen | stays for boxes that cannot run a child; a child supersedes it for the Omarchy PC |
| backups (`backup.ts`, `export.ts`) | mirror of the database and allowed config to a private repository | the parent pulls a child's export into its own mirror under `nodes/<name>/` |
| voice (`voice.ts`, `kokoro.ts`) | `yap`, Kokoro, `say`; macOS-only ears | off; a peer's replies are spoken on the Mac |
| desktop (`desktop/`) | window, tray, talk key, updater | not installed |

**What is tied to macOS**, from a grep of `process.platform` and the tools shelled out to:

- `hostlaunch.ts`: `launchHost` throws off darwin, and `index.ts` then spawns
  the host *detached as the server's child* (`startPtyHost`, around line 6814).
  On Linux under systemd that child is in the service's cgroup, and
  `systemctl --user restart kururu` would end every agent. This is the one
  change that is not optional.
- `status.mjs:64`, `kill-hosts.mjs:89` and the server's `socketHolder` find the
  host by `lsof`; `devservers.ts:335` lists listeners with it. `lsof` is not on
  the Omarchy PC (`ss` is).
- `desktop/build.mjs` restores the executable bit on node-pty's `spawn-helper`
  for the two darwin prebuild directories only, and node-pty 1.1.0 ships no
  Linux prebuild at all (checked on unpkg: `darwin-*` and `win32-*` only), so
  on Linux it is built from source by its `install` script. bun runs that
  script — node-pty is on `bun pm default-trusted` — and the build wants gcc,
  make, python3 and the node headers, which node-gyp downloads.
- `voice.ts`: `yap` and `/usr/bin/say` are macOS; `usage.ts` reads the Claude
  credential from the keychain on macOS and from `.credentials.json` elsewhere
  (already handled); `fileops.ts` already falls back to `gio trash` and
  `xdg-open`; `cwd.ts` already reads `/proc`; `sounds.ts` already knows the
  freedesktop directory.

Nothing in `web/` or `shared/` is platform-specific.

## Decisions

### A child is the whole server, headless

Not a cut-down daemon, not a new "kururu-lite", not an agent-runner that the
parent drives over a private protocol. The reasons:

- The server already serves a phone with no window present, the arrangement is
  already the server's, and the harness, hooks, web tools, boards and sleep all
  live on the restartable side. A child gets every one of them for the cost of
  running the bundle on Linux.
- The one remote-machines gap that mattered — status read off a screen because
  hooks on the box had nowhere to report — closes by itself: the hooks report to
  a server on the same box.
- Two codebases is how the remote path drifts. `docs/machines.md` lists five
  things it still cannot do; every one of them is a disk or a process table the
  child has.

What a child does not have: a window (so no `desktop/`), the voice, the talk
key, a Dock, notifications beyond the foreground ones a phone page draws.

### Nodes, ranks and the roster

Two words that are kept apart on purpose:

- **The parent** is the Mac, whatever its rank. It enrols a node, removes one,
  signs the roster, and is the only holder of secrets. A child can never add a
  member or hand out a key.
- **The leader** is the highest-ranked node that is reachable. Rank is a list
  in Settings → Nodes on the Mac, the Mac first by default and draggable, so a
  laptop that moves can be put below a box that does not. Leadership is one
  job — the Telegram poll and the default addressee — and nothing else moves
  with it.

**The roster** is a signed, versioned document: every member's id, short name,
public keys, tailnet address, rank, and the channel settings that are not
secrets (the Telegram allow-list, its switch and its switch time). The Mac
signs it with an Ed25519 key made once; every node keeps the newest version it
has seen and passes it along any link, so a change reaches a node the Mac
cannot see at the moment through one it can. Removing a node or changing a
rank is a new roster; a node that is not in the newest roster is dropped and
its key refused.

**Enrolment** is pairing, like Telegram's. The child shows a six-character
code (its own Settings → Nodes, or `bun run node:code` on the box, ten
minutes); the parent's Settings → Nodes takes an address and the code and
posts them with the roster; the child answers with its id, name, public keys
and share token; the parent signs a roster with the new member and sends it
back. The route refuses any remote address outside the CGNAT range tailscale
uses, and any request with a forwarding header.

**Links are a full mesh.** Every node holds one link to every other member:
the lower rank dials the higher, so the Mac dials nobody and only accepts,
and a child that can reach nothing above itself is, by the rule, leader of
what it can reach. Ten nodes is forty-five sockets, which is nothing. A link
is opened with a handshake in which each side signs the other's challenge
with its Ed25519 key and the roster says whether that key is a member;
there are no per-pair tokens to mint. Every link pings every five seconds and
a node is **away** after thirty seconds of silence, because a sleeping Mac
sends no FIN. The Mac listens on its tailnet address for this, which Share
already does for the phone.

**Mutual keys, not mTLS, not Tailscale identity.** Tailscale already
authenticates both machines and encrypts the path; what a key pair adds is
"this member, not any device on the tailnet", at the cost of one signature
check. mTLS would need a CA and certificate handling for a property the
tailnet already gives. Binding a link to a tailnet login through `tailscale
whois` is a `tailscale` command, so it is the user's to add (rule 4), and the
plan does not depend on it.

### What a child owns, what the parent shows, what is never synced

**Nothing structural is synchronised.** A child's profile, workspaces, panes,
boards, cards, runs, turns and agents are its own, in its own `kururu.db`, and
the parent's are the parent's. There is no merge, no conflict rule, and no
"the parent's copy wins", because there are no copies. A child has one
profile, so `@omarchy` names one Kuru; `@mac` is the profile the Telegram
channel is pointed at, or the active one.

What crosses the link is a **summary** the node pushes whenever it changes
(`NodeSummary` in `shared/nodes.ts`): its version and host state; its profile
by key and name; each workspace by key, name and folder; each agent by id,
name, program, status, activity, context and card; the Needs count by band;
the Kuru counts; whether it leads; and which peers it can see. It is what
`kururu_status` already prints, as data, and it is small.

Every node draws every other's summary under a node heading in the sidebar,
counts it in the Needs tray, lists it in the Needs drawer, hands it to its
Kuru in `kururu_status`, and lists each node in the Share dialog with that
node's own QR. **Opening a node's terminal means going to the node.** In a
browser that is a link; in the desktop window it is the address picker and the
tray's "Open <node>", because `preload.js` deliberately lets no served page
point the window at another address. Terminals drawn through the Mac — a
remote pane type whose emulator is fed from a second socket — are later work,
not the first shape.

### Offline, both ways

- **The Mac is asleep.** Every child carries on: its agents, its Kuru acting
  on its own notices, its phone UI, its sleep rule, and the Telegram poll if
  rank makes it leader. Its UI shows "the Mac has been away since 23:10" from
  the moment the link went silent, with the last summary the Mac pushed about
  itself, marked stale. Nothing on the Mac can be driven: its processes are
  frozen with it.
- **A child is unreachable.** Every other node shows it with its last summary
  greyed and the error, as the machines rows do. A message or verb for it is
  held and delivered when it answers, and the chat is told once.
- **Both restart.** Links reconnect with backoff forever, as `session.ts`
  does, because a server restart is every save under `bun run dev`.

### Kurus are peers

One Kuru per node, always on for its own node. The rule is **read anywhere,
act locally, ask a peer to act remotely**:

- `kururu_status` on any Kuru lists every node's workspaces and agents from
  the summaries, so "what is running on Omarchy" is answered without asking
  anybody.
- Only the local Kuru types into, reads, waits on, starts or stops its node's
  agents, and only it receives their `[kururu]` notices. No Kuru ever has two
  Kurus near it, and no Kuru manages another: the user is the manager, and
  the Kurus are colleagues in one room.
- `ask_kuru(node, message, wait)` is how a Kuru gets something done elsewhere:
  the message goes into the peer's outbox and is typed into it as `[mac] …`
  (the node's name as the mark), exactly as a Telegram line is typed today.
  `wait: false` returns once the peer has taken it; `wait: true` holds for the
  peer's reply, capped at a few minutes, and past two it becomes a background
  task in Claude Code as `wait_agent` does. The role says not to relay a
  question through a third Kuru.
- `read_kuru(node, turns)` reads a peer's recent turns, **on demand only**.
  Nothing is pushed into a Kuru when a link comes back: the user may be
  working on something unrelated when the lid opens, and says "catch up" when
  it matters.
- Boards are data, not agents, so `add_card`, `edit_card` and `move_card` take
  a `node` and act on that node's board directly over the link; `run_card`
  and `add_card` with `run` stay local, because a run starts an agent.
- Memory is per Kuru, in its node's harness folder, never shared or copied.

Each Kuru's context stays about its own node, which is the point: the Omarchy
Kuru knows the Omarchy projects, and the Mac's Kuru does not have to.

### One drawer, several Kurus

The drawer is still the conversation's one home, and it grows to hold every
reachable node's conversation at once:

- `shared/kuru.ts` merges each node's turns, outbox states and missed replies
  into one list by time, each entry tagged with its node; `server/src/kuru.ts`
  assembles the local half from the store as today and the peers' halves from
  `kuru-turns` messages the links carry (the last N turns, pushed on change).
  A node that is away shows its last turns and "last seen 23:10". Nothing is
  copied into a database.
- Bubbles are marked with their node; a chip per node filters. The composer
  addresses the local Kuru unless the message starts with `@<node>`, which
  sends it into that node's outbox over the link — the same door Telegram
  uses, so the delivered-means-Kuru-said-so guarantee holds across the link.
  Replying to a peer's bubble does the same.
- The voice follows: a clip is transcribed on the Mac; words for a peer cross
  the link as text; a peer's replies come back as `kuru-replied` and are spoken
  on the Mac through the same `hush` and missed rules, since the child has no
  speakers. With the lid open, Omarchy's Kuru effectively talks through the
  Mac.

### The phone with the lid closed

The phone opens **the child's own address**, scanned once from any node's
Share dialog (which draws each node's QR with that node's share token). The
browser keeps the cookie per origin for a year, as it does for the Mac.

What it shows is the child's own workspaces, agents, boards, Needs and drawer
— the whole UI, the drawer with the Mac's Kuru greyed as away — not a mirror of
the Mac's boards. A mirror would be a second storage for the most valuable
thing on the machine, with the merge rules `docs/data.md` was written to
avoid. A card that should be visible from the child while the Mac sleeps is
put on the child's board, by hand or by `add_card` with `node`.

The microphone on the phone still needs a secure context. On the child that is
`tailscale serve` in front of the server, which the user runs if they want it
(rule 4). It arrives on loopback, which is why the loopback rule below comes
first.

### One Telegram

**Only Kuru speaks, and only the leader polls.** The bot token is a secret the
parent grants; the allow-list and the switch ride in the roster. A node is
eligible to lead when it holds the token grant and a Claude login.

**Addressing.** A bare message from the chat goes to the leader's Kuru. A
message starting `@omarchy` — or `/omarchy`, since Telegram's apps may
autocomplete `@` against usernames — goes to that node's Kuru, as does a reply
to one of its lines; the poller keeps a bounded map of sent message ids to
nodes for that. A child's lines carry its mark, `[Omarchy] …`; the Mac's carry
none. A message for a node that is away is held in the poller's state and
delivered when the node answers, and the chat is told once.

**Transport.** A message for another node crosses the mesh to that node's
outbox; every Kuru's reply, `say` line and the quiet echo of your words from
the Mac cross the mesh to the leader, which posts them. A reply stuck on a
node that cannot reach the leader waits in that node's own queue.

**Automatic failover**, step by step. `LeadGate` in `shared/nodes.ts` is the
rule, pure, with the times passed in so it is tested as arithmetic:

- *Who leads:* the highest-ranked node among myself and the nodes I can reach.
  Every node evaluates this for itself from its own links.
- *Taking over:* when every node above me has been away for 30 s, I lead: I
  start the poll with my own saved offset and the chat gets one line —
  "Omarchy's Kuru is in charge. The Mac has been away since 23:10." No Kuru
  state moves, because the Kuru you were talking to still exists and
  `@omarchy` still reaches it.
- *Taking back:* when a higher-ranked node's link has been up for 60 s, it
  asks the holder to yield. The minute stops a Mac that wakes for thirty
  seconds of Power Nap from stealing the job and sleeping again. A holder that
  is mid-conversation — you wrote in the last 2 min, or its Kuru is mid-turn
  on a chat message — answers "busy" and is asked again, for at most 10 min.
- *The handshake:* the holder aborts its poll, hands over its state — the
  offset, the outgoing queue, the held messages, the reply map, the last
  hundred handled message ids — and acknowledges; only then does the new
  leader poll. The chat gets "The Mac's Kuru is back in charge."
- *The tie-break:* if the tailnet is split and two nodes both believe they
  lead, Telegram's 409 is the referee and rank decides who backs off — the
  lower-ranked node stands down for 5 min, the higher retries after 30 s — so
  the higher one wins within a minute with no vote. This never happens when
  the Mac merely sleeps.
- *Nothing is lost:* Telegram keeps unread messages for a day, so a gap with
  no leader is delivered late, not dropped. The existing "sent before the
  switch went on" rule therefore keys off the channel's own switch time from
  the roster, not a node's start. The one double-delivery case — a leader that
  typed a message into Kuru and died before confirming it — is closed by the
  handled ids in the handover state.

**Topics** (Bot API 9.3 lets a bot have forum topics in a private chat, one
per node) would replace marks and `@`, but a regression under the 10.0
rollout was reported in May 2026, so they are an option to try after the
baseline works. **Agents answered from the chat** — a `blocked` prompt
forwarded with an inline keyboard and answered through `press_keys` — is later
work; the role's rule that a permission prompt is the user's holds from
Telegram as much as from the Mac. **No other program on the box holds a
Telegram bot**, and none will, so the 409 only ever means two kururus.

### Secrets: a store of kururu's own

Weighed:

| option | for | against |
|---|---|---|
| **built-in**: the `0600` files kururu already keeps, pushed sealed over the link | no new service, no account, no cloud; every existing reader (`readConfigFile` per request) works unchanged on a child; grants, pushes and revocations are kururu's own verbs, visible in Settings; matches "secrets never leave the machine except on the user's decision" | kururu writes some crypto (X25519 + AES-GCM from `node:crypto`, two functions and a test); no history or audit beyond kururu's own |
| 1Password service accounts (`op read`) | polished; one token per machine; Connect server exists | a subscription and a hosted vault; every read is a network call to 1Password; the service-account token on each child is itself a secret to keep; the user may not use 1Password |
| Bitwarden Secrets Manager (`bws`) | machine accounts scoped to projects; a CLI | cloud by default; self-hosting is the whole Bitwarden server; the access token on each child is a secret to keep |
| Infisical (self-hosted, machine identities, agent) | fits a box that already runs containers; scoped identities; an agent that renders files | a Postgres-and-Redis service to run and keep up, for four keys; the child holds a client secret to fetch secrets with |
| sops + age in the backup repository | small, well understood, offline | `docs/data.md` already argued against an encrypted blob on GitHub, and the backup is an allow-list that names these files as what never goes |
| Vault | the reference | far too much for one person and two machines |

**Built-in, because every external option adds a service, an account, and a
bootstrap secret per child, to solve a problem kururu is one small module away
from.** The parent's at-rest story is unchanged (a FileVault disk and `0600`,
the posture every key already has). The child's at-rest story is the same
`0600` file; `systemd-creds --user` (systemd 256, TPM2-backed; the box has a
TPM) is a later wrap, once shown to work for the dedicated user.

The model:

- **Kinds**, in a registry (`shared/secrets.ts`): the Telegram token, the
  OpenRouter key, each web provider's key file (`firecrawl.json`,
  `web-firecrawl-self.json`, `web-*.json`), a Claude long-lived token per Mac
  login, a Codex `auth.json`. Each kind names its file on a node, how its hint
  is read, what it unlocks, and how to revoke it at the source (BotFather
  `/revoke`, the OpenRouter and Firecrawl dashboards, `claude setup-token`
  again, `codex logout`). The share token, the roster's signing key, the
  nodes' key pairs and the backup's git credentials are *not* kinds: they
  never leave the node that minted them.
- **Grants** are per child per kind, off by default, ticked in Settings → Nodes
  → <node> → Secrets. A child holds only what is ticked. The Telegram grant is
  what makes a node eligible to lead.
- **A push** happens on grant, on link-up, and when the parent's file changes
  (the backup already watches these mtimes). The value is sealed to the child's
  X25519 key with an ephemeral key, HKDF and AES-256-GCM, so a push can only be
  opened by the node it was for; the child writes it with
  `writeConfigFile(name, value, 0o600)` and acknowledges with the hint. Nothing
  is logged.
- **Rotation** is pasting the new value on the parent; every grantee is pushed
  and the page shows which acknowledged.
- **Revocation** is unticking: the child removes the file and acknowledges; the
  page shows the at-source step for that kind beside it.
- **On the child's disk**: the granted files, and nothing else. A child's
  Settings page for a granted kind says "held from the Mac, hint …, since …"
  and offers no field. A client is sent hints, never values, on both nodes, as
  today.
- **Backups** leave all of it out, on both nodes: `nodes.json`, the roster's
  key, the token kinds, the logins. The allow-list in `shared/backup.ts` gains
  the new names in its "never" line.

### CLI logins

- **Claude Code: the Mac's account, lent.** `claude setup-token` on the Mac
  makes a one-year token that only makes model requests; it is a kind, one per
  Mac login directory, granted to the child's profile, and `loginEnv` sets it
  as `CLAUDE_CODE_OAUTH_TOKEN` on every pty of that profile. That is the one
  place a credential is allowed into a pty's environment, because that is how
  Claude Code takes it and the same exposure the login file already has. It
  outranks a `/login` on the box (precedence 5 over 7 in Claude Code's list),
  so a login left there is a fallback and never a surprise. Never a copied
  `.credentials.json`: its refresh token rotates, and two machines refreshing
  one token sign each other out. Two Kurus and their agents then draw on one
  plan, and the usage bar reads the Mac's.
- **Codex.** OpenAI documents copying `auth.json` to a headless machine, and
  `codex login --device-auth` on the box itself. The `codex-auth` kind carries
  the file into the profile's `CODEX_HOME`.
- **gh, git.** Out of scope; a child's git is the dedicated user's.

### Linux: a dedicated user, the build, the service, the host, logs, updates

- **A dedicated user on the box**, made by hand before phase 0: its own home,
  `loginctl enable-linger` for it (one root step, the user's, so its services
  run with nobody logged in), its own node through mise or the system package,
  its own clones of the repositories it works on, no sudo, no docker group. The
  box's own account — its Claude login, its tmux sessions from the machines
  feature, its project folder — is not touched and not used.
- **A checkout in that user's home, built there.** `desktop/dist/*.mjs` and
  `web/dist` are plain JavaScript, but node-pty is native and has no Linux
  prebuild, so it is compiled by node-gyp at install, which needs the box's
  gcc, make and python (present) and the node headers (downloaded at build).
  bun runs node-pty's install script by default; `bun install` is enough.
  Electron's download is skipped (`ELECTRON_SKIP_BINARY_DOWNLOAD=1`); nothing
  on a child imports it.
- **Node 26**, named by its full path in the unit, since mise's shims are on an
  interactive PATH and not on a service's. `node:sqlite` is unflagged from
  22.13 and a release candidate from 25.7; the store's `backup()` call exists
  in both.
- **`kururu.service`**, a user unit the installer writes to
  `~/.config/systemd/user/`, running `node server/run.mjs` (no `--watch`) with
  `KURURU_BIND=tailscale`, `KURURU_LOOPBACK_TOKEN=1`, `Restart=on-failure`,
  `KillMode=process`.
- **The host as a transient unit of its own**: `hostlaunch.ts` gets a Linux
  branch that runs `systemd-run --user --unit=kururu-ptyhost-<label>
  --collect --property=KillMode=process … node ptyhostd.mjs`, the exact
  analogue of the launchd job: its own cgroup, so restarting or stopping
  `kururu.service` ends no agent, and `hostJobRunning` asks `systemctl --user
  is-active`. `bun run status` says `unit <label>` where it says `coalition`
  today.
- **Logs**: `lifecycle.log`, `ptyhost.log` and `server.log` where they are on
  the Mac, plus `journalctl --user -u kururu` for the runner's stdout.
- **Updates**: `bun run node:update` on the box — `git pull`, `bun install`,
  `bun run build`, `systemctl --user restart kururu` — restarts the server
  only; `/api/health` reports when the host is behind and a host restart is
  owed, exactly as on the Mac. The GitHub release check stays a check.
- **Port**: 7717 is free on the box; a neighbouring port is held by something
  else, which is why the port stays a setting.

### Security

- **Tailnet only, no public ports.** A child binds its tailscale address and
  nothing else (`KURURU_BIND=tailscale`, resolved through `reach.ts`'s
  interface read, never a `tailscale` command). The enrolment route and `/link`
  refuse a remote address outside 100.64/10 and any request carrying
  forwarding headers, as `/mcp/web` already does.
- **The loopback exemption** (`verdict()` in `server/src/access.ts`, built on
  `fromLoopback` at line 176) is right for the Mac and wrong for a child. The
  argument was that anything on loopback already has a shell; on the Omarchy
  PC other long-running programs run on the box, and `tailscale serve`, if
  the user turns it on for the phone's microphone, delivers every request
  from loopback. So a child requires the token on loopback too
  (`KURURU_LOOPBACK_TOKEN=1`, also a field in `access.json`, default on for a
  child), and kururu's own callers on the box present it from `access.json`:
  the hooks (`report.mjs`), `status.mjs`, `reload-window.mjs`, the backup CLI,
  the harness's `--mcp-config` and the agents' `web-mcp.json` (both carry a
  header). The Mac keeps its exemption until the user wants otherwise; the
  switch exists on both.
- **Bypass permissions on a real machine.** A child's agents run as the
  dedicated user, which owns its clones and nothing else, has no sudo and no
  docker group, so an injected `rm -rf` reaches those clones, that user's
  granted secrets and its tailnet shell, and no further.
- **What a child never holds**: the Mac's share token, the roster's signing
  key, the backup repository's credentials, any secret not granted.
- **What a compromised child gets**: its granted secrets, its own agents, the
  ability to answer with lies, and the ability to send messages into peers'
  Kurus as itself — which is why a peer's message is typed with the node's
  mark and the role says what the mark means, exactly as `[telegram]` is
  handled. It cannot sign a roster, cannot enrol anybody, and cannot ask the
  parent for a secret it was not granted.

### Children and the machines feature

A child **supersedes** the machines feature for a box that can run one, and
**sits beside** it for the rest. The machines rows stay for ssh gauges and
`ssh -t` shells (a VPS with no node, this box's CPU and disk), a node entry may
name the machine entry it is the same box as so the gauges draw under the node
heading. The "forward the hooks over `ssh -R`" item in `docs/machines.md` is
dropped in favour of children; the ssh road is not changed.

### Moving a workspace to a child

A workspace row's ⋯ menu (today: board, LazyGit, databases, git) gains **Move
to <node>…** for every reachable node, the parent included, so a move goes
either way. It opens a centred dialog, on the worktree rule's reasoning
(anything that ends work asks first, not at the foot of a card):

- **It asks for the folder on the target** — default the same basename under
  that node's projects folder — and the target checks it exists and is a
  repository before anything moves.
- **It says what moves**: the name, the board with every card and each card's
  history (arriving as `imported` events, dates kept), the machine pin
  dropped. **And what does not**: the pane arrangement (the new workspace
  starts with one pane), dev servers, worktrees, and the agents — a workspace
  with an agent running, or a card with a worktree standing, is refused with
  the reason; a card whose run is asleep moves as a card, and the dialog says
  its conversation stays on this node and cannot be resumed there.
- **The move** is one `workspace-move` exchange over the link with a move id:
  the source exports the board through `export.ts`'s rows, the target makes
  the workspace (`newWorkspaceIn`) and adopts the cards through the store's
  one road in, keyed by the move id so a lost acknowledgement is answered the
  same way twice, and only on the acknowledgement does the source remove the
  workspace — which keeps its board, marked gone, as removing one already
  does, with a `moved` event naming the node and the new key.

### A child's backups

A child runs no git. The parent pulls each child's export (`GET /api/export`,
behind the link handshake) into its own mirror under `nodes/<name>/` whenever
the child's write counter moved, and the usual commit and push carry it. A
child's boards are therefore backed up as often as the Mac is awake, which the
Backups page says. `bun run restore --node <name>` is the way back onto a
fresh child.

## The protocol, in one screen

| where | what | who proves what |
|---|---|---|
| child `POST /api/nodes/enrol` | `{code, roster}` → `{node: {id, name, keys, version}, shareToken}`; then the parent sends the signed roster with the new member | the pairing code; tailnet address only |
| any node `GET /link` (WebSocket, one per pair) | handshake: each side signs the other's challenge; then `roster` (newest wins), `summary` (coalesced), `kuru-turns` (last N, on change), `say {id, at, text, mark}` into the peer's outbox (the drawer's `@`, Telegram, `ask_kuru`), `kuru-replied` and `kuru-said` (replies and `say` lines, with origin), `cards-*` (board verbs with a node), `secrets-put {kind, envelope}` / `secrets-forget` / `secrets-ack`, `lead-ask` / `lead-busy` / `lead-state` / `lead-ack` (the handshake), `telegram-in` (a chat message for this node) / `telegram-out` (a line for the leader to post), `workspace-move` / `workspace-moved`, `export` for the backup pull | an Ed25519 key the roster lists |
| any node `/api/health`, snapshot | `nodes: NodeStatus[]`, a `nodes` message, `leader` | as today |

Everything on `/link` is JSON over the existing `ws` dependency; a link is a
client the way `session.ts` is, reconnecting forever. `/mcp` is not reached
across nodes: a peer's verbs arrive as messages into its Kuru, never as tool
calls on its agents.

## Phases

Effort is in agent-days: one focused Claude Code session, with its tests and
docs, is about a day. Each phase ends with its docs written — a `docs/nodes.md`
grows through phases 2–6, `docs/linux.md` is phase 1's — and with the CLAUDE.md
brief touched only where a rule changes. Before phase 0 the user makes the
dedicated user on the box and enables linger for it.

### Phase 0 — a spike on the box (half a day)

Run the current bundle on the Omarchy PC by hand, as the dedicated user, in an
isolated instance (`docs/testing.md`), and write down what breaks. The point is
to replace the list above with one measured on the box before anybody edits
`hostlaunch.ts`.

- clone into the user's home, `mise use bun@latest`,
  `ELECTRON_SKIP_BINARY_DOWNLOAD=1 bun install`, `bun run build`; check
  `node_modules/node-pty/build/Release/pty.node` exists and that the install
  did not silently skip node-pty's script;
- `KURURU_PORT=7817 KURURU_STATE_DIR=/tmp/k2 KURURU_DATA_DIR=/tmp/k2/data
  XDG_CONFIG_HOME=/tmp/k2/config KURURU_BIND=<tailnet ip> node server/run.mjs
  --no-build --entry desktop/dist/server.mjs`;
- from the phone: the QR from `bun run status`'s address, a `sleep 30` tab, a
  Claude tab (with `CLAUDE_CODE_OAUTH_TOKEN` exported by hand for the spike),
  the harness;
- try `systemd-run --user` from that context, and `systemd-creds --user
  encrypt` for later;
- note every stderr line; `bun run kill-ptyhosts /tmp/k2` after.

Done: a list in the card of what failed, with the file and line.

### Phase 1 — a headless child on Linux (4–6 days)

Useful alone: the Omarchy PC runs kururu as a service, the phone drives it over
the tailnet, agents survive a server restart, Kuru works there.

Files and modules:

- `package.json`: scripts `node:install`, `node:update`, `node:status`,
  `node:code` → `tools/node.mjs` (plain node, no bun at runtime), which writes
  the unit, enables it, prints the phone URL with the token, and does the
  update sequence. The installer checks for `pty.node` after `bun install`
  rather than assuming.
- `desktop/build.mjs`: the `spawn-helper` chmod loop covers `linux-x64` and
  `linux-arm64` (harmless where absent).
- `server/src/hostlaunch.ts`: `launchHostSystemd`, `hostUnitRunning`,
  `launchedBySystemd(pid)` (read `/proc/<pid>/cgroup` for the unit name), the
  unit name grammar; `index.ts`'s `startPtyHost` takes the Linux branch before
  the detached fallback and records "as a transient systemd user unit".
  `hostlaunch.test.ts` covers the `systemd-run` argv and the cgroup parse as
  text.
- `server/src/access.ts`: `KURURU_BIND=tailscale` resolved at bind;
  `loopbackToken` in `access.json` and `KURURU_LOOPBACK_TOKEN`; `verdict`
  stops exempting loopback when it is set. `access.test.ts` adds the verdict
  table for it.
- The callers that present the token on the box: `report-cli.ts` (the hook
  settings written by `hooks.ts` carry it as an env for the hook),
  `status.mjs`, `reload-window.mjs`, `backup-cli.ts`, the `web-mcp.json`
  launch flags (`headers`) and the harness's `--mcp-config`.
- `server/sockowner.mjs` (used by `status.mjs` and `kill-hosts.mjs`) and a TS
  twin in `index.ts`'s `socketHolder`: `lsof` on macOS, `ss -xlpn` on Linux;
  `devservers.ts`: `ss -ltnpH` parsed for listeners on Linux, with a test over
  captured output.
- `server/src/logins.ts`: `CLAUDE_CODE_OAUTH_TOKEN` from a token file in the
  profile's login directory when one is there (phase 4 is what puts it there;
  for phase 1 it is pasted by hand).
- `server/src/voice.ts`: off darwin, the ears and the system voice say "not on
  this platform" rather than "brew install yap"; Settings → Voice draws the
  sentence.
- `.github/workflows/ci.yml`: typecheck and `bun test` on `ubuntu-latest` and
  `macos-latest`, so a darwin-only assumption fails in CI rather than on the
  box.
- `docs/linux.md`: the dedicated user, install, the unit, logs, update, the
  host as a unit, what is missing (voice, window, Trash without `gio`).
  `CLAUDE.md`'s hazard table gets one row: on a child, `systemctl --user
  restart kururu` costs a reconnect and the host is its own unit.

Done when, on the Omarchy PC: `systemctl --user status kururu` is active with
nobody logged in; the phone opens the tailnet URL with the token and nothing
answers on the LAN address or without the token, loopback included; an agent
started from the phone survives `systemctl --user restart kururu`; its sidebar
dot follows its hooks; the harness starts, is trusted, and answers in the
drawer; `bun run status` on the box names the host's unit; `/api/health` says
the host is current.

Tests: the pure functions above; the Linux CI job; the phase-0 list re-run.

### Phase 2 — nodes: the roster, the mesh, the mirror (5–7 days)

Files and modules:

- `shared/nodes.ts`: `NodeEntry`, the `Roster` and its signing payload,
  `NodeSummary`, `summarize(snapshot, …)` (pure, from the same facts
  `kururu_status` reads), `NodeStatus`, the pairing code (reuse
  `pairingCode`'s alphabet), `leaderOf(roster, reachable, self)`, the `/link`
  message union, the handshake's challenge shapes, `adoptRoster` (newest
  version wins, signature checked). Tested.
- `server/src/nodekeys.ts`: the node's Ed25519 and X25519 pairs, made once,
  kept at `0600` in `node.json`; the Mac's roster signing key beside them.
- `server/src/nodes.ts`: `NodeHost` — the code, `enrol`, the `/link` route
  with the handshake, the coalesced `summary` push, the roster relay, the
  mesh's dial-up to every higher-ranked member with backoff, pings, the
  `away` timer, the `nodes` broadcast, `send(nodeId, message)` for later
  phases, the export pull for the backup. Every server runs it; parent-only
  verbs (`enrol`, `remove`, `rerank`, sign) refuse on a node without the
  signing key.
- `server/src/access.ts`: `/link`, `/api/nodes/*` and `/api/export` behind the
  handshake rather than a token.
- `server/src/index.ts`: the routes; `nodes` and `leader` in the snapshot and
  `/api/health`; `backup.ts` writes `nodes/<name>/` from the pulls;
  `restore-cli.ts` takes `--node`.
- `web/src/settings/Nodes.tsx`: on the parent, add by address and code,
  rename, drag to rank, remove, each node's status, version, last seen, "Open";
  on a child, the code button and the roster as it stands. `Sidebar.tsx`: a
  section per node with its workspaces as rows wearing the agents' dots and
  the Needs dot; the machine's gauges under it when the entry names one.
  `NeedsDrawer.tsx` and the tray count: a band per node whose rows are links
  to the node. `Reach.tsx`: a QR per node. `desktop/connect.html`,
  `servers.js`, `menu.js`: nodes read from `nodes.json` offered in the picker
  and as "Open <node>" in the tray.
- `shared/harness.ts`: `kururu_status` lists nodes; the role gets a "Nodes"
  section saying what a Kuru can see, and that acting is phase 3.
- `shared/backup.ts`: `nodes.json` and `node.json` in the never-list.

Done when: the parent's sidebar shows the Omarchy child's workspaces and
agents live, with dots that change as the child's hooks report; the Needs tray
counts a child's blocked agent and the drawer opens the child; the tray and
the picker open the child; the child's own UI says the Mac is away within
thirty seconds of the lid closing and shows its last summary; removing a node
on the parent drops its links everywhere within one roster relay; the Mac's
backup commit carries the child's boards.

Tests: `nodes.test.ts` for the summary, the code, the roster's signature and
adoption, `leaderOf`, the link state machine over a fake socket pair
(`hostlink.ts` has the pattern).

### Phase 3 — Kurus as peers (4–6 days)

- `shared/harness.ts`: `ask_kuru`, `read_kuru`, `node` on `add_card`,
  `edit_card`, `move_card` and `cards`, the `[<node>]` mark grammar beside
  `[telegram]`, `agentName` with the node in `kururu_status`, the role's
  Nodes section rewritten around *read anywhere, act locally, ask a peer*.
- `server/src/harness.ts`: `ask_kuru` through `NodeHost.send` into the peer's
  `Outbox.say`, with the wait held on the peer's `kuru-replied`; `read_kuru`
  off the cached `kuru-turns`; board verbs over the link into the peer's
  `workspaces.*In` spellings with the actor `peer:<node>`. `noticeStatuses`
  keeps notices local, and a test says so.
- `shared/kuru.ts`, `server/src/kuru.ts`, `KuruDrawer.tsx`: the merged list
  tagged by node, the chips, the `@<node>` composer grammar, reply-to-bubble,
  away nodes with their last turns.
- `server/src/outbox.ts`: an entry whose destination is a peer is delivered
  over the link and its state follows the peer's reports back; audio stays on
  the Mac.
- `server/src/voice.ts`, `channels.ts`: a peer's `kuru-replied` is spoken and
  marked missed on the same rules as a local reply.

Done when, from the Mac's drawer: `@omarchy start a Claude agent in <workspace>
with this prompt` is answered by Omarchy's Kuru in the same drawer with its
mark, and the agent appears in the child's agents' pane; the Mac's Kuru, asked
"what is Omarchy doing", answers from `kururu_status` without asking; asked to
get something done there, it uses `ask_kuru` and reports the peer's reply;
`read_kuru` brings back the overnight turns only when asked; a spoken
`@omarchy …` is answered aloud on the Mac.

Tests: the mark and `@` grammars, the merge, the routing of an outbox entry as
pure functions; `harness.test.ts` with a fake link.

### Phase 4 — secrets (4–6 days)

- `shared/secrets.ts`: the kinds registry, grant states, the envelope shape,
  the hint readers; a test that every secret file kururu writes is either a
  kind or named in the never-shared list.
- `server/src/seal.ts`: `seal(publicKey, bytes)`, `unseal(privateKey, envelope)`
  with X25519, HKDF-SHA256 and AES-256-GCM from `node:crypto`, over the keys
  `nodekeys.ts` made. Round-trip and tamper tests.
- `server/src/secrets.ts`: parent: catalogue, grants, pushes on grant, link-up
  and file change, acks; child: take, write with `writeConfigFile(…, 0o600)`,
  forget with `removeConfigFile`, status. The Claude kind lands as the token
  file `logins.ts` reads for `CLAUDE_CODE_OAUTH_TOKEN`; the Codex kind is
  written into the profile's `CODEX_HOME`.
- Settings → Nodes → <node> → Secrets on the parent; the "held from" line on a
  child's OpenRouter, Web and Channels pages; Settings → Agents on the Mac
  gets "Lend this login to a node" which runs `claude setup-token` in a tab
  and takes the pasted token as the kind.
- `shared/backup.ts`: the new files in the never-list; the README text.
- `docs/nodes.md`: the secrets section, with the at-source revocation per kind.

Done when: granting the self-hosted Firecrawl and OpenRouter kinds makes the
child's Settings → Web and sidebar balance ready with hints only; an agent on
the child uses `kururu_web`; changing the key on the Mac reaches the child
within seconds and the page shows the ack; unticking removes the file; the
child's profile runs an agent as the Mac's account with no login on the box.

### Phase 5 — one Telegram, with failover (4–6 days)

- `shared/nodes.ts`: `LeadGate` — away, takeover, takeback, busy, the 409
  backoffs — as arithmetic with the times passed in, like `SwapGate`.
  `shared/channels.ts`: the node mark line, the reply map shape, `routeOf`
  (reply-to, `@node`, `/node`, else the leader), the held-for-an-away-node
  notice, the switch time read from the roster. Tested.
- `server/src/telegram.ts`: the poll runs only while `leaderOf` says so;
  outgoing entries carry an origin and sent ids fill the map; incoming are
  judged as today and then routed — own node to `Outbox.say`, another node
  through the link; held for a node that is away, with one notice; the
  handover state (offset, queue, held, map, handled ids) given and taken
  through `lead-state`.
- `server/src/channels.ts`: `replied`, `aside` and the quiet echo on a
  non-leader go to the leader over the link.
- `server/src/nodes.ts`: the handshake messages; the roster carries the
  channel settings; eligibility checked before a node is counted as a
  candidate.
- Settings → Channels: the rank list shown with who leads now and who is
  eligible; on a child, the "polls here while the Mac is away, token held
  from the Mac" line.
- The role prompt's Telegram section says lines are marked by node and that a
  bare message reached the leader.

Done when: with the lid closed, a message to the bot is answered by the
Omarchy Kuru with its mark within a minute of the lid closing, and the chat
was told once; with the Mac back, the poll returns to the Mac after a minute
and the chat says so; `@omarchy` and a reply to one of its lines reach it
while the Mac leads; a message for the Mac while it sleeps is held and
delivered on wake; a simulated split (a firewall rule between the two for a
minute) ends with the Mac polling and one 409 in the child's log.

Tests: `LeadGate` and `routeOf` as pure functions; the fake Bot API from
`channels.test.ts` for the map, the queue and the handover; a link test for
the handshake.

### Phase 6 — moving a workspace to a child (2–3 days)

- `shared/nodes.ts`: `workspace-move` / `workspace-moved` shapes, the refusal
  rule (an agent running, a worktree standing) as a pure function over the
  workspace and its agents, the dialog's sentences.
- `server/src/nodes.ts` and `workspaces.ts`: the exchange with a move id, the
  export through `export.ts`'s rows, the adoption through the store's one
  road in with `imported` events, `newWorkspaceIn` on the target, removal on
  the acknowledgement with a `moved` event, idempotent on retry.
- `Sidebar.tsx`'s row menu: **Move to <node>…**; `Dialog.tsx` for the
  centred dialog with the folder field and the two lists.
- The harness: `move_workspace(node, folder)` is one more call into the same
  exchange, cheap once the exchange exists.

Done when: a workspace with cards and an asleep run moves to the child, its
cards and their histories appear on the child's board, the Mac's row is gone
and the board is in Search → Deleted with the `moved` event, a second click on
the same move id does nothing twice, and a workspace with a running agent is
refused with the reason.

### Later, each on its own

- **One window**: a remote pane type — a tab `{kind: "remote", node, agentId}`
  in the parent's layout whose emulator is fed from a second socket to the
  child, with the child owning that terminal's size as it owns every other
  client's. 4–6 days; touches `terminals.ts`, `Panes.tsx`, `session.ts`,
  `shared/layout.ts`.
- **A prompt answered from Telegram**: a `blocked` edge forwarded as a message
  with an inline keyboard; the answer through `press_keys`. 2 days.
- **Topics in the private chat** instead of marks, after checking the Bot API
  10.0 report. 1–2 days.
- **`systemd-creds --user`** wrapping of granted files on a child with a TPM.
  1–2 days, after the spike shows it works for the dedicated user.
- **Push notifications** (roadmap 3): a child is the natural pusher, being
  always on.
- **`tailscale serve`** on the child for the phone's microphone: the user's
  command, documented in `docs/linux.md`, gated on the loopback rule.

Total for phases 0–6: roughly 24–35 agent-days, in order, each shippable.

## Risks

- **node-pty from source.** node-gyp needs the node headers for mise's node
  26, downloaded at build; a box without internet at that moment fails the
  install. The spike finds out.
- **A transient unit under a lingering user manager** is the design's load-
  bearing fact on Linux; if `systemd-run --user` refuses from the service's
  context, the fallback is `KillMode=process` on `kururu.service` with the host
  spawned detached — which survives a restart but not a `systemctl --user
  stop`. The spike tries both.
- **`node:sqlite` is a release candidate** on node 26 and experimental-with-no-
  flag on node 24; the store uses five calls and `backup()`. A node major that
  changes an option name breaks the child's start, which `lifecycle.log` says.
- **The lent Claude token** lives a year, makes model requests only (no
  Remote Control, no claude.ai connectors), and there are reports of 401s in
  long-running sessions; the child's Settings says when it was lent and the
  usage bar on the Mac is the only gauge of the shared plan.
- **Failover under a split tailnet** is settled by rank and the 409, which
  means up to a minute of two pollers and one message possibly answered by
  the lower node first. Rare, bounded, and logged on both sides.
- **Power Nap** on a Mac on power can wake it for seconds at a time; the
  one-minute steady link before a takeback is what stops leadership flapping,
  and the user may still want "wake for network access" off.
- **A peer's message is a message, not the user.** It is typed with the node's
  mark, so a compromised child could say things to the Mac's Kuru. The role
  treats a `[omarchy]` line as it treats `[telegram]`: words from somewhere,
  not an instruction with the user's authority behind it.
- **The drawer merge over slow links** fetches turns on change; a chatty Kuru
  on a far node is a few kilobytes a turn. Capped by N.
- **The desktop cannot be sent to a child by a served page**, by design. The
  picker and the tray do it; a phone follows a link.
- **A child's backups** are only as fresh as the Mac is awake. Said on the
  page.
- **A move with a lost acknowledgement** is answered the same way twice by
  the move id; a move interrupted before the target adopted anything leaves
  the source untouched, since removal waits for the acknowledgement.

## What the user does by hand

- Before phase 0: make the dedicated user on the box, `loginctl enable-linger`
  for it, give it node (mise or the system package) and clones of the
  repositories the child will work on.
- When phase 4 arrives: `claude setup-token` on the Mac, once per login to
  lend; `@BotFather` needs nothing new.
- If the phone's microphone on the child is wanted: `tailscale serve` on the
  box, after phase 1's loopback rule is in.

## Appendix — what was checked, read-only, on 2026-10-18

On the Mac: the server at `0.4.0` with a `0.3.0` host at protocol 2, node
24.18; node-pty 1.1.0's prebuilds are darwin and win32 only; bun 1.4.2's
default trusted list names node-pty, so its install script runs; `origin/main`
equals `main` at `de21c93`.

On the Omarchy PC, through the server's own warm ssh connection: Omarchy 4.0.4
on a 7.2 kernel, systemd 261, the user manager running with `Linger=yes`,
Hyprland on the console and a VNC server on the tailnet address, 12 cores and
15 GB, a TPM2 (`systemd-analyze has-tpm2` yes), gcc, make, python3, tmux 3.7
(two kururu sessions from the machines feature still alive), git, docker, no
`lsof`, no `node` on the login shell's non-interactive PATH, node 26.8.2, Claude
Code 2.1.299 (signed in, credentials file `0600`), Codex and gh through mise,
port 7717 free, another node service of the box user's on loopback, the box
user in `wheel` with sudo behind a password and not in `docker`, and a
`~/Projects` folder. The web's facts: `node:sqlite` history from nodejs.org;
node-pty's prebuild listing from unpkg; `claude setup-token` and the
credential locations and precedence from code.claude.com; Codex's `auth.json`
copy and `--device-auth` from developers.openai.com; `message_thread_id`,
`reply_to_message` and private-chat topics from core.telegram.org and the
aiogram changelog; `systemd-creds --user` from the Arch man page; Tailscale
Serve's identity headers from tailscale.com.
