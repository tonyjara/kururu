# Kururu, parent and children

A plan, written 2026-10-18 from a read of the tree at `de21c93` and a read-only
look at the Omarchy PC, then revised the same day with the user. **Built so
far:** phase 0 (`docs/spikes/child-phase0.md`), 1A and 1B — a child set up by
the skill and the wizard, verified on the Omarchy PC with the user there on
2026-10-18 (`docs/linux.md`); and phase 2, nodes (`docs/nodes.md`), checked
between the Mac and the box with throwaway instances and awaiting its
two-machine checks with the user; and phase 6, moving a workspace
(`docs/nodes.md#moving-a-workspace`), checked between two throwaway nodes on
the Mac and awaiting its two-machine checks; and phase 3, Kurus as peers
(`docs/nodes.md#kurus-as-peers`), checked between two throwaway nodes on
the Mac with a stand-in Claude and awaiting its two-machine checks. Its
marks are `[kuru@mac]` and `[user@mac]` rather than the bare `[mac]` below,
for the reason `docs/nodes.md` gives; and phase 4, lending secrets
(`docs/nodes.md#lending-secrets`), checked between two throwaway nodes on the
Mac with fake keys and awaiting its two-machine checks; and phase 4b, a
project's own secrets — env files, ssh keys, a GitHub login — lent to a
node and offered by the move dialog (`docs/nodes.md#lending-a-projects-secrets`),
checked the same way; and phase 5, one Telegram
(`docs/nodes.md#one-telegram`), checked in one process against a stand-in
Bot API and between two throwaway nodes on the Mac with a stand-in Claude,
and awaiting its two-machine checks. It is written so that an agent can take one phase, read the files it
names, and know what "done" is. Each phase is shaped as a card: its scope,
what it depends on, what it can run beside, and how it is verified. The first
draft had one Kuru driving every node's agents, a Telegram poller set by hand,
and a child set up by hand; all three are gone, for the reasons under *Kurus
are peers*, *One Telegram* and *Onboarding*.

## Summary

The Mac keeps the kururu it has: the window, the voice, the talk key, the
profiles and boards. Another PC gets a **child**: the same server and the
same pty host, built from the same checkout, run as a systemd user service
with no window and no voice, serving the same web app to a phone over the
tailnet. A child owns its own workspaces, boards, cards, agents and Kuru, in a
database of its own, and keeps working when the Mac's lid is closed.

**Setting one up is a wizard, not a checklist.** `kururu child setup` on the
new machine checks and fixes or guides each prerequisite in turn — Claude Code
and its login, node and bun, the user, linger and the service, the tailnet
address, no API key in the way, pairing with the Mac — explains each, re-checks
before moving on, is safe to run again, and ends with the same summary
`kururu child doctor` prints later. A skill in the repository is how an agent
on the new machine walks the user through it.

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
reads, taken back with one click. A child's Claude login is its own `/login`,
checked by the wizard; lending the Mac's as a token is there for a machine
where nobody can open a browser.

**With the lid closed**, the phone opens the child's own address and sees the
child's workspaces — everything that is still running — and a line saying the
Mac has been away since when. Nothing on the Mac can be driven while it
sleeps, and the plan does not pretend otherwise.

The first phases are useful alone: a headless child on the Omarchy PC, set up
by the wizard, with its own phone UI over the tailnet, before any link,
Telegram or secrets.

## The architecture

```
                  the tailnet (WireGuard; Tailscale's identity and encryption)
   ┌──────────────── Mac: the parent, rank 1 ────────────────┐       ┌────────── Omarchy PC: a child, rank 2 ──────────┐
   │  window ─┐                                               │       │  (no window, no voice; set up by the wizard)     │
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
   │   Kuru (harness) ─┴─▶ its own agents only                │       │   kururu child setup / doctor / update            │
   │   polls Telegram while it is the leader                  │       └───────────────────────▲──────────────────────────┘
   └──────────────────────────────────────────────────────────┘                               │
                                                                        phone ── http://<child tailnet ip>:7717/?k=… ──┘
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
| profiles and logins (`logins.ts`) | `CLAUDE_CONFIG_DIR` / `CODEX_HOME` per profile under `~/.config/kururu/profiles/` | one profile, on the machine's own `/login` |
| harness (`harness.ts`, `mcp.ts`, `/mcp`) | one Claude Code session per profile with kururu's verbs as MCP tools | the same, on the child, its own Kuru; peers reach it by name over the link |
| hooks (`hooks.ts`, `report-cli.ts`) | `report.mjs` beside the server, `KURURU_PORT` in every pty | identical, and local — which is what the machines feature lacks |
| web tools (`/mcp/web`, `web/chain.ts`) | loopback-only MCP, keys read per request from `0600` files | identical once the keys are granted; an agent on a child finally has `kururu_web` |
| Telegram (`telegram.ts`, `channels.ts`) | long poll, allow-list, token `0600`, one profile's Kuru | the poll runs on the leader; every Kuru's replies reach the chat through it |
| the drawer (`kuru.ts`, `KuruDrawer.tsx`) | one profile's turns, outbox and missed list merged | the same, plus every reachable peer's turns, marked by node |
| machines (`machines.ts`) | ssh gauges, shells and agents in tmux, status read off the screen | stays for boxes that cannot run a child; a child supersedes it for the Omarchy PC |
| backups (`backup.ts`, `export.ts`) | mirror of the database and allowed config to a private repository | the parent pulls a child's export into its own mirror under `nodes/<name>/` |
| voice (`voice.ts`, `kokoro.ts`) | `yap`, Kokoro, `say`; macOS-only ears | off; a peer's replies are spoken on the Mac |
| the tools (`status.mjs`, `kill-hosts.mjs`, `reload-window.mjs`) | `bun run …` from a checkout | the same, behind one `kururu` command with `child setup`, `doctor`, `update`, `status` |
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

### Onboarding: a skill, a wizard, a doctor

Setting a child up by hand turned out to be a dozen steps across two machines
— a user, linger, node, a login, a unit, a token, a pairing — each with a way
to get it slightly wrong. So the steps are code, in three forms that share one
list of checks:

- **`kururu child setup`** is an interactive wizard that runs entirely in the
  terminal of the new machine. It walks the prerequisites in order, and for
  each one *checks*, then *fixes* what it safely can, *guides* what it cannot
  (prints the exact command and waits), and *re-checks* before moving on. It is
  idempotent — running it again on a working child changes nothing and says so
  — and it ends with the doctor's summary.
- **`kururu child doctor`** runs the same checks read-only, prints a table of
  ✓, ✗ and – with the fix beside each ✗, and exits non-zero when something
  fails, so it can be run after an update, after a reboot, or from the Mac
  over ssh.
- **The skill**, `.claude/skills/kururu-child/`, is how an agent on the new
  machine walks the user through it: "use the kururu skill to set up a child".
  It covers the two steps that come before the wizard can run — a clone of
  the repository and a node to run it on — then runs the wizard with the user
  there, relays each question, and never does the things the wizard refuses
  to do itself. The release skill is the shape to copy.

**The one command.** `tools/kururu.mjs` is plain node, like `run.mjs`, with
`child setup`, `child doctor`, `child update`, `child status` and `child code`
as subcommands; `child setup` links it to `~/.local/bin/kururu` so the
command exists after the first run. Before that it is `node tools/kururu.mjs
child setup`, which the skill says.

**The checks**, in order, each with what the wizard does about it:

| check | checks | fixes | guides |
|---|---|---|---|
| node and bun | `node` ≥ 24 and `bun` on this user's path, and the versions the checkout wants | — (it is running on node already) | `mise use -g node@26 bun@latest`, or the system package |
| the checkout | a git checkout, `bun install` done, `pty.node` built, `bun run build` current | runs `bun install` and `bun run build`, and says when the build is older than the sources | — |
| the user | which account runs the child: this one (default when the box is yours alone), or a dedicated one; home mode, no API key in rc files, sudo and docker group noted for what they mean under bypass permissions | — | `useradd`, the clones under that user, how to switch; never runs `sudo` on its own |
| linger | `loginctl show-user` says `Linger=yes` | `loginctl enable-linger` for oneself, which needs no root on most systems; otherwise prints the `sudo` line | — |
| Claude Code | `claude` on the path, its version, `claude auth status` signed in; `codex login status` if Codex is wanted | — | runs `claude` for `/login` with the copy-the-link flow explained, or takes a token from `claude setup-token` on the Mac if the user has one (phase 4 makes that a grant) |
| no API key | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `apiKeyHelper`, the cloud-provider switches: in this shell, in `systemctl --user show-environment`, in the unit, in the rc files, in Claude's settings `env` | — (it explains why: those outrank the login and bill as API usage) | which file to edit |
| the tailnet | a `tailscale0` interface with an address, read as `reach.ts` reads it; the port free; the server, once up, answering on that address and refusing the LAN address and the token-less loopback | — | `sudo tailscale up` in the user's hands; the wizard **never runs `tailscale`** (rule 4), only reads the interface |
| the service | the unit written, enabled, active; `/api/health` answering; the host a unit of its own; `lifecycle.log` clean | writes the unit, `daemon-reload`, enables, starts, waits for health | — |
| the phone | the URL with the token printed and as a QR in the terminal | — | open it on the phone; the wizard waits for the first client and says it saw it |
| pairing (phase 2) | a member of a roster, linked to the Mac | takes the join command the Mac shows (`--join`, or pasted), joins, confirms the link | the user presses Add a computer on the Mac and copies its command here |
| secrets (phase 4) | which kinds are held from the Mac, by hint | — | tick them on the Mac |
| leading (phase 5) | eligible to lead, leads now, rank | — | — |

The wizard explains before it acts, asks before anything that costs — a
`useradd`, writing over an existing unit, a `/login` that would replace one —
and prints what it would do when told `--dry-run`. It never prints a token or
a key, only hints. It grows with the phases: the pairing, secrets and leading
rows are added by the phases that build those things, so the steps the user
did by hand this week become rows the wizard owns.

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

**Enrolment** is one command, started on the parent. *(As built: the first
build had the child show a code to type into the Mac with its address, and
it read as a puzzle; it was turned round the same day.)* The parent's
Settings → Nodes → Add a computer shows `kururu child join <its address>
<code>`, the code single-use and good for ten minutes; run on the new
machine, its server posts its id, name, public keys, port and share token
with the code to the parent's `/api/nodes/join`; the parent signs a roster
with the new member, at the address the request came from, and answers
with it. The route refuses any remote address outside the CGNAT range
tailscale uses, and any request with a forwarding header. See
`docs/nodes.md`.

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

The phone opens **the child's own address**, scanned once from the wizard's
QR or any node's Share dialog (which draws each node's QR with that node's
share token). The browser keeps the cookie per origin for a year, as it does
for the Mac.

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
eligible to lead when it holds the token grant and is signed in to Claude.

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
TPM) is a later wrap, once shown to work for the child's user.

The model:

- **Kinds**, in a registry (`shared/secrets.ts`): the Telegram token, the
  OpenRouter key, each web provider's key file (`firecrawl.json`,
  `web-firecrawl-self.json`, `web-*.json`), a Claude long-lived token per Mac
  login (optional, see *Logins*), a Codex `auth.json`. Each kind names its
  file on a node, how its hint is read, what it unlocks, and how to revoke it
  at the source (BotFather `/revoke`, the OpenRouter and Firecrawl dashboards,
  `claude setup-token` again, `codex logout`). The share token, the roster's
  signing key, the nodes' key pairs and the backup's git credentials are *not*
  kinds: they never leave the node that minted them.
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
  and offers no field, and `kururu child doctor` lists them by hint. A client
  is sent hints, never values, on both nodes, as today.
- **Backups** leave all of it out, on both nodes: `nodes.json`, the roster's
  key, the token kinds, the logins. The allow-list in `shared/backup.ts` gains
  the new names in its "never" line.

### Logins

- **Claude Code: the machine's own `/login`.** A child is signed in the way
  any machine is — `claude`, `/login`, and when the browser cannot open over
  ssh, `c` copies the link to open elsewhere and the code is pasted back. The
  wizard checks `claude auth status` and walks that flow. It is a login of its
  own on the same subscription, revocable on its own, and nothing is
  propagated. `profiles keep their own logins` stays off on a child, so its
  profile uses `~/.claude`.
- **Lending the Mac's login is optional.** `claude setup-token` on the Mac
  mints a one-year token that only makes model requests; as a secret kind it
  can be granted to a child whose user cannot open a browser anywhere, and
  `loginEnv` sets it as `CLAUDE_CODE_OAUTH_TOKEN` on that profile's ptys —
  the one place a credential is allowed into a pty's environment, because
  that is how Claude Code takes it. It outranks a `/login` on the machine.
  Never a copied `.credentials.json`: its refresh token rotates, and two
  machines refreshing one token sign each other out.
- **It is subscription usage either way.** Both roads authenticate with the
  claude.ai account and draw on the same plan limits as the Mac; the usage
  bar on the Mac is the only gauge of that. What would bill as API usage is
  `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or an `apiKeyHelper` in the
  child's environment, which outrank both logins — the reason the wizard and
  the doctor look for them everywhere a pty could inherit one.
- **Codex.** `codex login` on the box, or `codex login --device-auth`; the
  wizard checks `codex login status` when Codex is wanted. OpenAI also
  documents copying `auth.json`, which the `codex-auth` kind carries into the
  profile's `CODEX_HOME` for a box with no browser.
- **gh, git.** The child's user needs its own read access to private
  repositories, and push access if its agents push: `gh auth login` as that
  user, or an SSH key. The wizard says so at the checkout step and does not
  do it.

### Linux: the user, the build, the service, the host, logs, updates

- **Which user runs the child is the wizard's first question.** The machine's
  own account is the default when the box is the user's alone: the login,
  node and the clones are already there, and linger is one command. A
  dedicated user — its own home, linger, node, clones, no sudo, no docker
  group — is the stronger posture under bypass permissions, because an
  injected `rm -rf` then stops at that user's clones; the wizard explains the
  trade, prints the `useradd` and `enable-linger` lines for the user to run
  as root, and never runs `sudo` itself. The Omarchy PC's own account is in
  `wheel` with sudo behind a password and not in `docker`, which the wizard
  reports as what it means.
- **A checkout, built there.** `desktop/dist/*.mjs` and `web/dist` are plain
  JavaScript, but node-pty is native and has no Linux prebuild, so it is
  compiled by node-gyp at install, which needs gcc, make and python (present)
  and the node headers (downloaded at build). bun runs node-pty's install
  script by default; `bun install` is enough, and the wizard checks for
  `pty.node` afterwards rather than assuming. Electron's download is skipped
  (`ELECTRON_SKIP_BINARY_DOWNLOAD=1`); nothing on a child imports it.
- **Node 26 or 24**, named by its full path in the unit, since mise's shims
  are on an interactive PATH and not on a service's. `node:sqlite` is
  unflagged from 22.13 and a release candidate from 25.7; the store's
  `backup()` call exists in both.
- **`kururu.service`**, a user unit the wizard writes to
  `~/.config/systemd/user/`, running `node server/run.mjs` (no `--watch`) with
  `KURURU_BIND=tailscale`, `KURURU_LOOPBACK_TOKEN=1`, `Restart=on-failure`,
  `KillMode=process`.
- **The host as a transient unit of its own**: `hostlaunch.ts` gets a Linux
  branch that runs `systemd-run --user --unit=kururu-ptyhost-<label>
  --collect --property=KillMode=process … node ptyhostd.mjs`, the exact
  analogue of the launchd job: its own cgroup, so restarting or stopping
  `kururu.service` ends no agent, and `hostJobRunning` asks `systemctl --user
  is-active`. `kururu child status` says `unit <label>` where `bun run status`
  says `coalition` today.
- **Logs**: `lifecycle.log`, `ptyhost.log` and `server.log` where they are on
  the Mac, plus `journalctl --user -u kururu` for the runner's stdout; the
  doctor prints the tail of `lifecycle.log`.
- **Updates**: `kururu child update` — `git pull`, `bun install`, `bun run
  build`, `systemctl --user restart kururu`, then the doctor — restarts the
  server only; `/api/health` reports when the host is behind and a host
  restart is owed, exactly as on the Mac. The GitHub release check stays a
  check.
- **Port**: 7717 is free on the box; a neighbouring port is held by something
  else, which is why the port stays a setting and the wizard checks it.

### Security

- **Tailnet only, no public ports.** A child binds its tailscale address and
  nothing else (`KURURU_BIND=tailscale`, resolved through `reach.ts`'s
  interface read, never a `tailscale` command). The enrolment route and `/link`
  refuse a remote address outside 100.64/10 and any request carrying
  forwarding headers, as `/mcp/web` already does. The wizard verifies all
  three from the box.
- **The loopback exemption** (`verdict()` in `server/src/access.ts`, built on
  `fromLoopback` at line 176) is right for the Mac and wrong for a child. The
  argument was that anything on loopback already has a shell; on the Omarchy
  PC other long-running programs run on the box, and `tailscale serve`, if
  the user turns it on for the phone's microphone, delivers every request
  from loopback. So a child requires the token on loopback too
  (`KURURU_LOOPBACK_TOKEN=1`, also a field in `access.json`, default on for a
  child), and kururu's own callers on the box present it from `access.json`:
  the hooks (`report.mjs`), `kururu child status` and `doctor`,
  `reload-window.mjs`, the backup CLI, the harness's `--mcp-config` and the
  agents' `web-mcp.json` (both carry a header). The Mac keeps its exemption
  until the user wants otherwise; the switch exists on both.
- **Bypass permissions on a real machine.** A child's agents run as the
  child's user with everything that user can reach. Under the machine's own
  account that is the account's files, keys and tailnet shell; under a
  dedicated user it is that user's clones and granted secrets. The wizard
  says which the user chose and what it means; it does not choose.
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

## Phases, as cards

Effort is in agent-days: one focused Claude Code session, with its tests and
docs, is about a day. Each phase ends with its docs written — `docs/linux.md`
is phase 1B's, a `docs/nodes.md` grows through phases 2–6 — and with the
CLAUDE.md brief touched only where a rule changes. Every phase that touches
the wizard adds its rows to `kururu child setup` and `doctor` and to the
skill, so nothing the user did by hand this week survives as a hand step.

The order of dependencies, in one line: 0 and 1A first and together; 1B after
both; 2 after 1A and 1B; 3, 4 and 6 after 2, beside each other; 5 after 3 and
4.

### Phase 0 — a spike on the box

**Scope.** Run the current bundle on the Omarchy PC by hand, in an isolated
instance (`docs/testing.md`), and write down what breaks, with the file and
line, so phases 1A and 1B replace the list in this document with one measured
on the box. Clone into the user's home, `mise use bun@latest`,
`ELECTRON_SKIP_BINARY_DOWNLOAD=1 bun install`, `bun run build`, check
`node_modules/node-pty/build/Release/pty.node` exists; start the server with
`KURURU_PORT=7817 KURURU_STATE_DIR=/tmp/k2 KURURU_DATA_DIR=/tmp/k2/data
XDG_CONFIG_HOME=/tmp/k2/config KURURU_BIND=<tailnet ip> node server/run.mjs
--no-build --entry desktop/dist/server.mjs`; from the phone open a `sleep 30`
tab, a Claude tab (the box is signed in) and the harness; try
`systemd-run --user` from that context and `systemd-creds --user encrypt` for
later; `bun run kill-ptyhosts /tmp/k2` after. Half a day.

**Depends on.** Nothing in the tree. The box has node 26 through mise, gcc,
make, python3 and a Claude login already.

**In parallel with.** 1A, which can start from this document's list and take
the spike's findings as they land.

**Verified by.** The card holds the list of failures with file and line, the
stderr of the start, whether `systemd-run --user` and `systemd-creds --user`
worked, and a screenshot or a sentence per phone check. Nothing is committed.

### Phase 1A — Linux support in the server

**Scope.** Everything in `server/` that assumes macOS, made to work on Linux
without touching how the Mac runs. The host as a transient systemd user unit
(`hostlaunch.ts`: `launchHostSystemd`, `hostUnitRunning`,
`launchedBySystemd(pid)` off `/proc/<pid>/cgroup`, the unit name grammar;
`index.ts`'s `startPtyHost` takes it before the detached fallback and records
"as a transient systemd user unit"). `access.ts`: `KURURU_BIND=tailscale`
resolved at bind through `reach.ts`, and `loopbackToken` in `access.json` /
`KURURU_LOOPBACK_TOKEN` under which `verdict` stops exempting loopback; the
callers that then present the token from `access.json` — the hook settings
`hooks.ts` writes (as an env for `report.mjs`), `status.mjs`,
`reload-window.mjs`, `backup-cli.ts`, the `web-mcp.json` launch flags and the
harness's `--mcp-config` (both with a header). `server/sockowner.mjs` for
`status.mjs` and `kill-hosts.mjs` and a TS twin for `index.ts`'s
`socketHolder`: `lsof` on macOS, `ss -xlpn` on Linux; `devservers.ts` reads
listeners from `ss -ltnpH` on Linux. `desktop/build.mjs`'s `spawn-helper`
chmod loop covers `linux-x64` and `linux-arm64`. `voice.ts` says "not on this
platform" off darwin instead of "brew install yap". A `.github/workflows/ci.yml`
running typecheck and `bun test` on `ubuntu-latest` and `macos-latest`. 3–4
days.

**Depends on.** Nothing; the spike's findings are folded in as they arrive.

**In parallel with.** 0, and with 1B's CLI once the env names above are
fixed (they are fixed here: `KURURU_BIND=tailscale`,
`KURURU_LOOPBACK_TOKEN=1`).

**Verified by.** `bun test` and typecheck green on both CI runners;
`hostlaunch.test.ts` covers the `systemd-run` argv and the cgroup parse as
text; `access.test.ts` has the verdict table with the loopback token on and
off; `devservers.test.ts` parses captured `ss` output; on the Mac nothing
changes (`bun run status` and the window behave as before, checked by hand).
The end-to-end check on the box is 1B's.

### Phase 1B — the child command, the wizard, the doctor, the skill

**Scope.** `tools/kururu.mjs`, plain node, with `child setup`, `child doctor`,
`child update`, `child status` and `child code` (the last a stub until phase
2), linked to `~/.local/bin/kururu` by `setup`. The wizard walks the checks in
the *Onboarding* table through the phone row: node and bun, the checkout
built with `pty.node` present, the user (this account or a dedicated one,
with the `useradd` and `enable-linger` lines printed and never run as root by
the wizard), linger, Claude Code installed and signed in (and Codex if
wanted), no API key anywhere a pty could inherit one, the tailnet address
read off the interface and the port free, the unit written and started with
`/api/health` answering on the tailnet address and refusing the LAN address
and a token-less loopback, the host a unit of its own, and the phone URL with
its QR, waiting for the first client. Each check explains, fixes or guides,
re-checks, and the run is idempotent and has `--dry-run`. The doctor is the
same checks read-only with a ✓/✗/– table, the fix beside each ✗, the tail of
`lifecycle.log`, and a non-zero exit on failure. `child update` is pull,
install, build, restart the server, doctor. The skill,
`.claude/skills/kururu-child/SKILL.md`, covers the clone and the node before
the wizard, then runs the wizard with the user and relays it; it says what
the wizard refuses to do (`tailscale`, `sudo`, printing a secret).
`docs/linux.md` documents all of it; `CLAUDE.md`'s hazard table gets one row
(on a child, `systemctl --user restart kururu` costs a reconnect and the host
is its own unit). 3–4 days.

**Depends on.** 1A merged (the host unit, the bind and loopback rules, the
`ss` fallbacks are what the wizard checks and the doctor reports).

**In parallel with.** The CLI's skeleton and the check functions can be
written beside 1A against the names fixed there; the verification waits for
1A.

**Verified by.** On the Omarchy PC, with the user present: an agent given
"use the kururu skill to set up a child" reaches a running child without a
hand step beyond the ones the wizard guides; `systemctl --user status kururu`
is active with nobody logged in; the phone opens the printed URL and nothing
answers on the LAN address or without the token, loopback included; an agent
started from the phone survives `systemctl --user restart kururu`; its
sidebar dot follows its hooks; the harness starts, is trusted, and answers in
the drawer; `kururu child doctor` prints all ✓ and exits 0; running `setup`
again changes nothing and says so; `kururu child status` names the host's
unit; `/api/health` says the host is current. Pure parts of the checks (the
unit text, the table, the API-key scan over fixture files) have tests.

### Phase 2 — nodes: the roster, the mesh, the mirror

**Scope.** `shared/nodes.ts`: `NodeEntry`, the `Roster` and its signing
payload, `NodeSummary` and `summarize(snapshot, …)`, `NodeStatus`, the pairing
code, `leaderOf(roster, reachable, self)`, the `/link` message union, the
handshake shapes, `adoptRoster`. `server/src/nodekeys.ts`: the node's Ed25519
and X25519 pairs at `0600` in `node.json`, the Mac's roster signing key beside
them. `server/src/nodes.ts`: `NodeHost` — the code, `enrol`, the `/link`
route with the handshake, the coalesced `summary` push, the roster relay, the
mesh's dial-up to every higher-ranked member with backoff, pings, the `away`
timer, the `nodes` broadcast, `send(nodeId, message)`, the export pull for
the backup; parent-only verbs refuse on a node without the signing key.
`access.ts`: `/link`, `/api/nodes/*` and `/api/export` behind the handshake.
`index.ts`: the routes, `nodes` and `leader` in the snapshot and
`/api/health`; `backup.ts` writes `nodes/<name>/` from the pulls;
`restore-cli.ts` takes `--node`. `web/src/settings/Nodes.tsx` (add by address
and code, rename, drag to rank, remove, status, "Open"; on a child the code
button and the roster), `Sidebar.tsx`'s section per node with the agents'
dots and the Needs dot, `NeedsDrawer.tsx` and the tray count with a band per
node, `Reach.tsx`'s QR per node, `connect.html`, `servers.js` and `menu.js`
offering nodes. `kururu_status` lists nodes; the role's "Nodes" section says
what a Kuru can see. The wizard and doctor gain the pairing row and `child
code` becomes real. `nodes.json` and `node.json` join the backup's
never-list. 5–7 days.

**Depends on.** 1A (the bind and loopback rules, the Mac shared on its
tailnet address) and 1B (the wizard's pairing step, a child to pair with).

**In parallel with.** 4's pure half (`shared/secrets.ts`, `seal.ts` written
against the key shapes fixed here) and 6's pure half (the refusal rule, the
dialog's sentences).

**Verified by.** `nodes.test.ts`: the summary, the code, the roster's
signature and adoption, `leaderOf`, the link state machine over a fake socket
pair. On the two machines: the Mac's sidebar shows the child's workspaces and
agents live with dots that follow the child's hooks; the Needs tray counts a
child's blocked agent and the drawer opens the child; the tray and the picker
open the child; the child's own UI says the Mac is away within thirty seconds
of the lid closing and shows its last summary; removing the node on the Mac
drops the link on the child within one roster relay; the Mac's next backup
commit carries the child's boards; `kururu child doctor` shows the pairing
row ✓.

### Phase 3 — Kurus as peers

**Scope.** `shared/harness.ts`: `ask_kuru`, `read_kuru`, `node` on
`add_card`, `edit_card`, `move_card` and `cards`, the `[<node>]` mark grammar
beside `[telegram]`, `agentName` with the node, the role's Nodes section
rewritten around *read anywhere, act locally, ask a peer*. `harness.ts`:
`ask_kuru` through `NodeHost.send` into the peer's `Outbox.say` with the wait
held on its `kuru-replied`; `read_kuru` off the cached `kuru-turns`; board
verbs over the link into the peer's `*In` spellings with the actor
`peer:<node>`; `noticeStatuses` keeps notices local. `shared/kuru.ts`,
`server/src/kuru.ts`, `KuruDrawer.tsx`: the merged list tagged by node, the
chips, the `@<node>` composer grammar, reply-to-bubble, away nodes with their
last turns. `outbox.ts`: an entry for a peer delivered over the link with its
state following the peer's reports back, audio staying on the Mac.
`voice.ts`, `channels.ts`: a peer's `kuru-replied` spoken and marked missed
on the local rules. 4–6 days.

**Depends on.** 2 (links, `send`, `kuru-turns`).

**In parallel with.** 4 and 6.

**Verified by.** The mark and `@` grammars, the merge and the routing of an
outbox entry as pure tests; `harness.test.ts` with a fake link. On the two
machines, from the Mac's drawer: `@omarchy start a Claude agent in
<workspace> with this prompt` is answered by Omarchy's Kuru in the same
drawer with its mark and the agent appears in the child's agents' pane; the
Mac's Kuru answers "what is Omarchy doing" from `kururu_status` without
asking; asked to get something done there it uses `ask_kuru` and reports the
reply; `read_kuru` brings the overnight turns only when asked; a spoken
`@omarchy …` is answered aloud on the Mac; a test asserts a child's notices
never reach the Mac's Kuru.

### Phase 4 — secrets

**Scope.** `shared/secrets.ts`: the kinds registry, grant states, the
envelope shape, the hint readers, and a test that every secret file kururu
writes is a kind or named never-shared. `server/src/seal.ts`: `seal` and
`unseal` with X25519, HKDF-SHA256 and AES-256-GCM over the keys from phase 2.
`server/src/secrets.ts`: on the parent the catalogue, grants, pushes on grant,
link-up and file change, acks; on a child take, write at `0600`, forget,
status; the Claude token kind landing as the token file `logins.ts` reads for
`CLAUDE_CODE_OAUTH_TOKEN`, the Codex kind into `CODEX_HOME`. Settings → Nodes
→ <node> → Secrets on the parent; the "held from" line on a child's
OpenRouter, Web and Channels pages; Settings → Agents on the Mac gets "Lend
this login to a node", which runs `claude setup-token` in a tab and takes the
pasted token as the kind. The wizard's login step offers the token road; the
doctor lists held kinds by hint. The backup's never-list and README grow; the
secrets section of `docs/nodes.md`. 4–6 days.

**Depends on.** 2 (keys, link messages, Settings → Nodes). The pure half can
be written beside 2.

**In parallel with.** 3 and 6.

**Verified by.** Round-trip and tamper tests on `seal.ts`; the grant state
machine as a pure test; the registry completeness test. On the two machines:
granting the self-hosted Firecrawl and OpenRouter kinds makes the child's
Settings → Web and sidebar balance ready with hints only; an agent on the
child uses `kururu_web`; changing the key on the Mac reaches the child within
seconds and the page shows the ack; unticking removes the file; a child whose
user has no browser login runs an agent on a lent token; `kururu child
doctor` lists the held kinds.

**As built**, 2026-10-18, beside the scope above:

- **Only the secret part of a file travels**, and the digest is over that
  part. The Telegram kind is the token and the bot, never the Mac's switch
  or allow-list, which would have made the child a second poller. A child
  holding it cannot switch it on; phase 5 made holding it the takeover.
- **A Codex login does not follow its source.** Codex refreshes `auth.json`
  itself, so pushing the Mac's refreshes would be two machines refreshing
  one login. It is copied once, and *Push again* sends the Mac's again. It is
  never written over a Codex login the child made itself.
- **Clearing a key on the Mac takes nothing away from a node**; switching it
  off does. A node removed from the roster lets go of everything, and the
  parent drops its grants at once, since its id survives a removal and
  joining again should start with nothing switched on.
- **A child reports what it holds on every link-up**, and the parent pushes
  only against that report, so a child restarted while the Mac slept is
  never assumed to hold what it no longer does.
- **The envelope is signed** by the parent's node key as well as sealed, and
  numbered, so a child takes a push only from its parent and never an older
  one over a newer.
- `NodeHost` gained `on(type, handler)`, link-up and link-down hooks, an
  unpair hook and `send(peer, message)`, for this and the later phases.

### Phase 4b — a project's secrets

**Scope.** Moving a workspace (phase 6) left behind what the project needs
to run on the node, and the dialog said "copy what it needs by hand". The
first real use is Storefront to the Omarchy PC (STO-58). Three more families of
kind on phase 4's road: a workspace's env files (`.env`, `.env.local`,
`.env.production` and the like, detected and picked), into the matching
checkout on the node at `0600`, following the Mac's file and removed when
switched off; an ssh `Host` entry with its key, so agents there can deploy
and connect, removed with its entry when switched off; a GitHub login for a
chosen gh account, so the node can clone and push. Seen in Settings → Nodes
beside phase 4's switches and in the Move to <node>… dialog, which offers to
lend them with the move; Kuru gets `lend_secrets`, previewing first and
never handed a value; the doctor's secrets row names them by hint.

**Depends on.** 4 (grants, the envelope, pushes) and 6 (the folder check).

**Verified by.** The text rules as pure tests (`server/test/vault.test.ts`:
env names, ssh config blocks and what travels, hashed `known_hosts`, key
preambles, gh's `hosts.yml`, the `Include` line in and out); each family
round-tripped between a parent and a child `Secrets` with fake keys in
`secrets.test.ts`, with no value in any view, record or log line; two
throwaway nodes on the Mac on free ports with a scratch home. On the two
machines: Storefront's `.env.local` lent with its move lands in its checkout on
the box and follows an edit on the Mac; the VPS's entry lets an agent there
`ssh` it; a lent gh login clones a private repository there; switching each
off removes it.

**As built**, 2026-10-18:

- **An env file is lent to one node**, its kind a hash of node, checkout
  and file, and where it lands travels inside the seal — so the folder is
  part of the digest and pointing the lend somewhere else is a push. The
  lend is kept in `grants.json` beside the grants and outlives the
  workspace here, which is what lets a moved project's env files keep
  following the Mac's.
- **Never over the node's own.** An env file that is there and says
  something else, or a `Host` the node's config already has, refuses the
  grant with the reason, as a Codex login does. The same bytes are taken
  as lent already.
- **ssh lands beside, never in.** `~/.ssh/kururu/<alias>.conf` and one
  `Include` line at the top of `~/.ssh/config`; only portable directives
  travel, because `UseKeychain` is fatal on Linux and a `ProxyCommand` is a
  program on the Mac. The host's `known_hosts` lines travel with it.
- **A GitHub login is a directory, not an environment.** gh's `hosts.yml`
  and git's credential file in `~/.config/kururu/gh`, with kururu's
  terminals pointed there by `GH_CONFIG_DIR` and `GIT_CONFIG_*` — paths
  only. The Claude token stays the one credential in a pty's environment.
- **Keys and tokens are read only once lent.** Until then an entry or an
  account is listed by being there, as a Codex login is; env files are read
  for their count of variables.
- **Nothing is pre-ticked.** The move dialog offers, suggests with a
  reason, and lends what the user ticks, after the move lands.

### Phase 5 — one Telegram, with failover

**Scope.** `shared/nodes.ts`: `LeadGate` — away, takeover, takeback, busy,
the 409 backoffs — as arithmetic with the times passed in, like `SwapGate`.
`shared/channels.ts`: the node mark line, the reply map shape, `routeOf`
(reply-to, `@node`, `/node`, else the leader), the held-for-an-away-node
notice, the switch time read from the roster. `telegram.ts`: the poll runs
only while `leaderOf` says so; outgoing entries carry an origin and sent ids
fill the map; incoming are judged as today and routed — own node to
`Outbox.say`, another node over the link, held for a node that is away with
one notice; the handover state (offset, queue, held, map, handled ids) given
and taken through `lead-state`. `channels.ts`: `replied`, `aside` and the
quiet echo on a non-leader go to the leader. `nodes.ts`: the handshake
messages; the roster carries the channel settings; eligibility checked.
Settings → Channels shows the rank list with who leads and who is eligible;
on a child the "polls here while the Mac is away, token held from the Mac"
line. The role prompt's Telegram section says lines are marked by node. The
doctor gains the leading row. 4–6 days.

**Depends on.** 3 (a message into a peer's outbox over the link; replies
relayed) and 4 (the Telegram token as a grant, which is eligibility).

**In parallel with.** 6. `LeadGate` and `routeOf` can be written beside 3
and 4.

**Verified by.** `LeadGate` and `routeOf` as pure tests; the fake Bot API
from `channels.test.ts` for the map, the queue and the handover; a link test
for the handshake. On the two machines: with the lid closed, a message to the
bot is answered by the Omarchy Kuru with its mark within a minute, and the
chat was told once; with the Mac back, the poll returns to the Mac after a
minute and the chat says so; `@omarchy` and a reply to one of its lines reach
it while the Mac leads; a message for the Mac while it sleeps is held and
delivered on wake; a simulated split (a firewall rule between the two for a
minute) ends with the Mac polling and one 409 in the child's log.

**As built**, 2026-10-18, beside the scope above:

- **Eligible is the switch, the token and a Claude login**, and each node
  says it in its summary (`lead {eligible, polls}`) — so the rule reads who
  could poll off the links it already has, and a kururu from before, which
  never says, is never counted as one that could while it is up.
- **Leading is among the eligible.** A node above that is up but cannot
  poll is passed over at once; one that is away counts until it has been
  unheard for 30 s, measured from this server's start too, so a child that
  restarts while the Mac is awake gives the links time to come up before
  polling. A node that held the poll when its server stopped carries on at
  once, which a `bun run dev` restart of the holder relies on. The lead is
  asked before the channel's first poll, for the same reason: a single
  `getUpdates` from a node that does not hold it is a 409 for the one that
  does.
- **A child with a bot of its own keeps it**, outside the roster's channel,
  as before; one with no token at all is still shared, and its Kuru speaks
  through the reader. The roster's settings are set on the parent only, so
  a child's switch and list are read-only, and pairing on the parent while
  a child reads the chat asks for it back at once and with force.
- **Every crossing is acknowledged** — `telegram-in-ack`, `telegram-out-ack`
  and `lead-ack` beside the plan's four — and the sender keeps what it sent
  until then: a held message until the node has it in its outbox, a line
  until the reader has queued it, a handover until the new holder adopted
  it, and back into the queue if the link drops first.
- **A reply that answered only another Kuru's `ask_kuru` is not posted**
  (`postedToChat`), for the reason `peerReplySpoken` does not speak it: the
  asking Kuru says it in its own words. Every other reply is, the `[kururu]`
  notices' included.
- **The address wins over a reply**: `@mac` written in a reply to one of
  Omarchy's lines goes to the Mac. `/compact` stays a slash command, unless
  a node is called `compact`.
- Held messages wait at most a day, Telegram's own horizon, and go for a
  node that leaves the roster; a line on its way to the reader waits half a
  day, as a line on its way to Telegram does.

### Phase 6 — moving a workspace to a child

**Scope.** `shared/nodes.ts`: the `workspace-move` / `workspace-moved`
shapes, the refusal rule (an agent running, a worktree standing) as a pure
function over a workspace and its agents, the dialog's sentences.
`nodes.ts` and `workspaces.ts`: the exchange with a move id, the export
through `export.ts`'s rows, the adoption through the store's one road in with
`imported` events, `newWorkspaceIn` on the target, removal on the
acknowledgement with a `moved` event, idempotent on retry. `Sidebar.tsx`'s
row menu gains **Move to <node>…**; `Dialog.tsx` draws the centred dialog
with the folder field and the two lists. The harness gets `move_workspace`
over the same exchange. 2–3 days.

**Depends on.** 2 (the link exchange, `newWorkspaceIn` reachable by a peer).

**In parallel with.** 3, 4 and 5.

**Verified by.** The refusal rule and the export-import round trip as tests
(`store.test.ts` has the importer). On the two machines: a workspace with
cards and an asleep run moves to the child, its cards and their histories
appear on the child's board, the Mac's row is gone and the board is in
Search → Deleted with the `moved` event; a second click on the same move id
does nothing twice; a workspace with a running agent is refused with the
reason; the move back works the same way.

### Later, each on its own, not scheduled

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
  1–2 days, after the spike shows it works for the child's user.
- **Push notifications** (roadmap 3): a child is the natural pusher, being
  always on.
- **`tailscale serve`** on the child for the phone's microphone: the user's
  command, documented in `docs/linux.md`, gated on the loopback rule.

Total for phases 0–6: roughly 27–39 agent-days, with 0 and 1A together, then
1B, then 2, then 3, 4 and 6 side by side, then 5.

## Risks

- **node-pty from source.** node-gyp needs the node headers for mise's node
  26, downloaded at build; a box without internet at that moment fails the
  install. The spike finds out, and the wizard says so when `pty.node` is
  missing.
- **A transient unit under a lingering user manager** is the design's load-
  bearing fact on Linux; if `systemd-run --user` refuses from the service's
  context, the fallback is `KillMode=process` on `kururu.service` with the host
  spawned detached — which survives a restart but not a `systemctl --user
  stop`. The spike tries both.
- **`node:sqlite` is a release candidate** on node 26 and experimental-with-no-
  flag on node 24; the store uses five calls and `backup()`. A node major that
  changes an option name breaks the child's start, which `lifecycle.log` and
  the doctor say.
- **The wizard's reach.** It never runs `tailscale` or `sudo`, so two steps
  stay the user's hands: bringing the tailnet up and making a dedicated user
  or enabling linger for one. It prints the exact lines and waits.
- **An API key in the way** bills as API usage and outranks the login; the
  wizard and doctor scan every place a pty could inherit one, but a key
  exported in a shell started later is outside their sight.
- **A lent Claude token** lives a year, makes model requests only, and there
  are reports of 401s in long-running sessions; the child's Settings says
  when it was lent and the usage bar on the Mac is the only gauge of the
  shared plan.
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

## What stays in the user's hands

- Bringing the tailnet up on a new machine (`tailscale up`), and `tailscale
  serve` if the phone's microphone on a child is wanted.
- Running the one or two root lines the wizard prints when a dedicated user
  is chosen: the `useradd` and its `enable-linger`.
- Typing a child's pairing code and address into the Mac's Settings → Nodes,
  and ticking the secrets a child may hold.
- The browser half of a `/login` on a machine with no browser, from the link
  the wizard shows.

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
node-pty's prebuild listing from unpkg; `claude setup-token`, the credential
locations and the precedence list from code.claude.com; Codex's `auth.json`
copy and `--device-auth` from developers.openai.com; `message_thread_id`,
`reply_to_message` and private-chat topics from core.telegram.org and the
aiogram changelog; `systemd-creds --user` from the Arch man page; Tailscale
Serve's identity headers from tailscale.com.
