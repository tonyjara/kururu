# Kururu, parent and children

A plan, written 2026-10-18 from a read of the tree at `de21c93` and a read-only
look at the Omarchy PC. Nothing in it is built. It is written so that an agent
can take one phase, read the files it names, and know what "done" is.

## Summary

The Mac keeps the kururu it has: the window, the voice, the talk key, the
profiles and boards. Another PC gets a **child**: the same server and the
same pty host, built from the same checkout, run as a systemd user service
with no window and no voice, serving the same web app to a phone over the
tailnet. A child owns its own workspaces, boards, cards, agents and Kuru, in a
database of its own, and keeps working when the Mac's lid is closed.

The Mac's kururu becomes the **parent**: it dials each child the way a phone
dials a server, holds one link per child, and draws what each child says about
itself — workspaces, agents, what needs you — in its own sidebar and Needs
drawer. Its Kuru reaches a child's agents with the tools it already has, each
taking a `node`. The parent is a client of its children, never the other way
round: a Mac that is asleep half the day cannot be anybody's server.

**One Telegram.** The bot's token stays a credential the parent holds and lends.
One node polls the bot — by default the always-on child, since the Mac is not
always on — and every node's Kuru speaks in the one chat, each line marked with
its node. A reply to a line goes back to the node that said it; a bare message
goes to the node you last spoke to, and `/to` changes that.

**Secrets live on the parent and are lent, one grant at a time.** A small store
of kururu's own, not a vault product: the files the parent already keeps at
`0600` are the store, a child is enrolled with a key pair, each secret is
granted per child, pushed sealed over the link, kept on the child as the same
`0600` file every existing reader already reads, and taken back with one click.
Logins are lent the way each CLI documents: a long-lived Claude token, a Codex
`auth.json`, never a copied Claude login.

**With the lid closed**, the phone opens the child's own address and sees the
child's workspaces — everything that is still running — and a line saying the
Mac has been away since when. Nothing on the Mac can be driven while it sleeps,
and the plan does not pretend otherwise.

The first phase is useful alone: a headless child on the Omarchy PC with its
own phone UI over the tailnet, before any link, Telegram or secrets.

## The architecture

```
                         the tailnet (WireGuard; Tailscale's identity and encryption)
   ┌──────────────────── Mac ─────────────────────┐          ┌────────────── Omarchy PC ──────────────┐
   │  window ─┐                                    │          │                                         │
   │  pill   ─┼─ ws ─▶ server :7717 ◀─ sock ─ host │          │     server :7717 ◀─ sock ─ host         │
   │  phone  ─┘        (parent)        (launchd)   │          │     (child)                (systemd)    │
   │                     │  ▲                       │          │       ▲   ▲                             │
   │                     │  │ /api/report (hooks)   │          │       │   │ /api/report (hooks, local)  │
   │                   kururu.db, ~/.config/kururu  │          │  kururu.db, ~/.config/kururu (granted)  │
   │                     │                          │          │       │                                 │
   │   NodeLinks ────────┼── ws /link + POST /mcp ──┼──────────┼──▶ NodeHost                             │
   │   (one per child)   │   (link token, sealed    │          │   (enrolment, summary, secrets taken,   │
   │                     │    secrets, forwarded    │          │    Telegram relay)                      │
   │                     │    Kuru verbs)           │          │                                         │
   │   Kuru (harness) ───┘                          │          │   Kuru (harness) ───▶ its own agents    │
   └────────────────────────────────────────────────┘          └───────────────▲─────────────────────────┘
                                                                               │ getUpdates (long poll;
                         phone ──── http://<child tailnet ip>:7717/?k=… ───────┤  the one poller)
                                                                               ▼
                                                                          api.telegram.org
```

Three things to read off it:

- **A child is not a lesser kururu.** It is `server/` and `web/dist` with no
  `desktop/`. Everything a phone can do against the Mac today it can do
  against a child, because the server never knew whether a window was there.
- **The link is a client connection the parent makes.** A child never needs
  the parent's address, never dials out, and treats the parent as one more
  thing that presents a token — a second kind of token, kept apart from the
  phone's.
- **The poller is one process, and it is where the uptime is.** Telegram ends
  a `getUpdates` with 409 the moment a second one starts, so the role is a
  setting rather than a race.

## What kururu is today, and what a child reuses

Read against the docs and the code; the file map is `docs/map.md`.

| piece | today | on a child |
|---|---|---|
| pty host (`ptyhostd.ts`, `agents/`) | a launchd job on a clone of the app, one unix socket, outlives the server | the same bundle, as a transient systemd user unit; the one piece that must not be in the server's cgroup |
| server (`index.ts` and the restartable half) | Node 24 (Electron's), `run.mjs` supervises, exit 75 restarts | the same, node 26 from mise, `run.mjs` under a `kururu.service` user unit |
| web app (`web/dist`) | one build for the window and the phone; `NARROW` (720px) and the coarse pointer decide the phone layout (`App.tsx`) | served unchanged; the phone is its only client |
| access (`access.ts`) | loopback bound unless shared; one token in the QR; `Origin` checked; loopback exempt | bound to the tailnet address only; the token required on loopback too (see security) |
| boards, turns, outbox (`store.ts`, `node:sqlite`) | `~/.local/share/kururu/kururu.db`, schema 4 | a database of its own, made on first start; nothing migrates |
| profiles and logins (`logins.ts`) | `CLAUDE_CONFIG_DIR` / `CODEX_HOME` per profile under `~/.config/kururu/profiles/` | the same; a child's profile is signed in on the child, or lent a token |
| harness (`harness.ts`, `mcp.ts`, `/mcp`) | one Claude Code session per profile with kururu's verbs as MCP tools | the same, on the child, driving the child's agents; the parent forwards verbs to it |
| hooks (`hooks.ts`, `report-cli.ts`) | `report.mjs` beside the server, `KURURU_PORT` in every pty | identical, and local — which is what the machines feature lacks |
| web tools (`/mcp/web`, `web/chain.ts`) | loopback-only MCP, keys read per request from `0600` files | identical once the keys are granted; an agent on a child finally has `kururu_web` |
| Telegram (`telegram.ts`, `channels.ts`) | long poll, allow-list, token `0600`, one profile's Kuru | the poll moves to the node holding the role; replies relayed |
| machines (`machines.ts`) | ssh gauges, shells and agents in tmux, status read off the screen | stays for boxes that cannot run a child; a child supersedes it for the Omarchy PC |
| backups (`backup.ts`, `export.ts`) | mirror of the database and allowed config to a private repository | the parent pulls a child's export into its own mirror (optional, phase 2) |
| voice (`voice.ts`, `kokoro.ts`) | `yap`, Kokoro, `say`; macOS-only ears | off; the page says so |
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

### A node is reached the way a phone is: the parent dials the child

The parent holds a `NodeLink` per child: a WebSocket client to the child's
`/link` route, authenticated by a *link token* the child minted at enrolment,
over the tailnet. The child never connects anywhere.

- **Direction.** The Mac sleeps; the child does not. A child that had to hold a
  connection to the parent would spend its life reconnecting to a machine that
  is not there, and the parent would have to listen on the tailnet for it — a
  port the user has not opened. The parent is already a client of things (the
  window is a client of the server); one more is nothing new.
- **Mutual tokens, not mTLS.** Tailscale already authenticates both machines
  and encrypts the path. What a token adds is "this parent, not any device on
  the tailnet", and `access.ts` already speaks tokens. mTLS would need a CA, a
  certificate per node, and Node's TLS on a port that is otherwise plain http —
  for a property the tailnet already gives. If the user later wants a link
  bound to a tailnet identity, Tailscale's `whois` on the child can confirm the
  peer's login; that is a `tailscale` command, so it is the user's to turn on
  (rule 4), and the plan does not depend on it.
- **Enrolment is pairing, like Telegram's.** The child shows a six-character
  code (its own Settings → Nodes, or `bun run node:code` on the box, ten
  minutes); the parent's Settings → Nodes takes an address and the code and
  posts them; the child answers with its id, name, a fresh link token, its
  public key and its share token; the parent answers with its name and public
  key. Both write the other down. The route refuses any remote address outside
  the CGNAT range tailscale uses, and any request with a forwarding header.
- **Two tokens on a child, on purpose.** The share token is the phone's and
  rides in a QR; the link token is the parent's and rides in a header. Rotating
  one does not log the other out. Both are presented through `hasToken`, which
  grows a second comparison and nothing else.

### What a child owns, what the parent shows, what is never synced

**Nothing structural is synchronised.** A child's profiles, workspaces, panes,
boards, cards, runs, turns and agents are its own, in its own `kururu.db`, and
the parent's are the parent's. There is no merge, no conflict rule, and no
"the parent's copy wins", because there are no copies.

What crosses the link is a **summary** the child pushes whenever it changes
(`NodeSummary` in `shared/nodes.ts`): its version and host state; each profile
by key and name; each workspace by key, name and pin; each agent by id, name,
program, status, activity, context and card; the Needs count by band; the
Kuru counts; which Telegram role it holds; and whether a parent is connected.
It is what `kururu_status` already prints, as data, and it is small.

The parent draws that under a node heading in the sidebar, counts it in the
Needs tray, lists it in the Needs drawer, hands it to its Kuru in
`kururu_status`, and lists each child in the Share dialog with the child's own
QR. **Opening a child's terminal means going to the child.** In a browser that
is a link; in the desktop window it is the address picker and the tray's
"Open <node>", because `preload.js` deliberately lets no served page point the
window at another address. Terminals drawn through the parent — a remote pane
type whose emulator is fed from a second socket — are a later phase (below),
not the first shape.

### Offline, both ways

- **The Mac is asleep.** Every child carries on: its agents, its Kuru acting on
  its own `[kururu]` notices, its phone UI, its sleep rule, its Telegram relay
  if it holds the role. Its UI shows "the Mac has been away since 23:10" from
  the moment the link dropped, with the last summary the parent pushed about
  itself (names and statuses only, marked stale). Nothing on the Mac can be
  driven: its processes are frozen with it.
- **A child is unreachable.** The parent shows the node with its last summary
  greyed and the error in ssh's words, as the machines rows do. A verb forwarded
  to it refuses with a sentence. A Telegram message routed to it is held in the
  poller's state and delivered when it answers, and the chat is told once.
- **Both restart.** The link reconnects with backoff forever, as `session.ts`
  does, because a server restart is every save under `bun run dev`.

### Kuru across nodes

The parent's Kuru gets a `node` argument on the tools that name an agent or a
board — `start_agent`, `send_agent`, `read_agent`, `press_keys`, `wait_agent`,
`stop_agent`, `rename_agent`, `reveal_agent` (refused across nodes, with the
link to go there), `open_shell`, `cards`, `add_card`, `edit_card`, `move_card`,
`run_card`, `new_workspace`, `search` — and `kururu_status` lists every node's
workspaces and agents with the node in the name. A call with a node is forwarded
to that child's `/mcp` with the link token and the child's profile id, and the
child's `harness.ts` runs it unchanged. The parent's harness does the routing
and nothing else.

Each child keeps a Kuru of its own, and **it is the one that acts unasked.** A
child's `[kururu]` notices go to the child's Kuru only; the parent's Kuru is
not told about a child's agent's edges. Two Kurus told the same edge would both
answer it, and the pty would take both. The parent's Kuru acts on a child's
agents when the user asks, through the forwarded tools, and `wait_agent` across
a node is answered by the child's own wait. The two can still type into one
agent in the same minute; that is the same collision two people at one terminal
have today, serialised by the pty, and the roles say who leads.

Auto Swap does not cross nodes.

### The phone with the lid closed

The phone opens **the child's own address**, scanned once from the parent's
Share dialog (which draws each child's QR with that child's share token) or
from the child's own Share dialog. The browser keeps the cookie per origin for
a year, as it does for the Mac.

What it shows is the child's own workspaces, agents, boards, Needs and Kuru
drawer — the whole UI — plus the Nodes section with the Mac marked away. Not
"everything the main one knew": a mirror of the parent's boards on the child
would be a second storage for the most valuable thing on the machine, with the
merge rules `docs/data.md` was written to avoid. If the user wants a card
visible from the child while the Mac sleeps, they put it on the child's board,
or Kuru does (`add_card` with `node`).

The microphone on the phone still needs a secure context. On the child that is
`tailscale serve` in front of the server, which the user runs if they want it
(rule 4). It arrives on loopback, which is why the loopback rule below comes
first.

### One Telegram

**One bot, one token, one chat, one poller.** The token stays a secret the
parent holds and grants (next section). The *role* — which node runs
`getUpdates` — is a setting on the parent's Settings → Channels, defaulting to
the first always-on child enrolled and otherwise the parent. Automatic failover
is deliberately not in the plan: two pollers is exactly the split brain the 409
exists to stop, and a lease with a clock has a window where both think they
hold it. A role holder that is unreachable means nothing polls, Settings says
so, Telegram keeps the messages for a day, and the user moves the role.

**Routing, outgoing.** Every line to the chat carries its node:
`[Omarchy] Acme migration finished…`, `[Mac] …`. The poller writes each sent
`message_id` into a bounded map (`telegram.json` state, last two thousand)
with where it came from: node, profile key, and the agent when the line is
about one.

**Routing, incoming.** A message that replies to a bot line goes to that line's
node (`reply_to_message.message_id` → the map). A bare message goes to the
*sticky target*: the node you last addressed, or that last spoke, shown by
`/where` and changed by `/to omarchy`, `/to mac` (`/nodes` lists them). Either
way it enters that node's outbox as `[telegram] …` and is typed into that
node's Kuru, as today. A `[telegram]` turn's reply is not spoken on the Mac,
as today (`replySpoken`).

**Transport.** The poller is a child or the parent; the other nodes reach it
over the links the parent holds. A child's Kuru reply travels child → parent →
poller; a message for a child travels poller → parent → child. When the poller
is a child and the parent is asleep, the poller serves itself and queues what
is for the Mac, telling the chat once. A second child while the Mac sleeps
cannot reach the chat, because children do not dial each other; with one child
today this costs nothing, and a mesh is listed under later work.

**Topics** (Bot API 9.3 lets a bot have forum topics in a private chat, one per
node) would replace prefixes and `/to`, but a regression under the 10.0 rollout
was reported in May 2026, so they are an option to try after the baseline, not
the baseline.

**Agents, not only Kuru.** An agent's question reaches the chat the way it
does today: as the child's Kuru's reply to the notice. Forwarding a `blocked`
prompt with an inline keyboard (1/2/3, Enter, Escape) answered through
`press_keys` is a later phase; the role's rule that a permission prompt is the
user's holds from Telegram as much as from the Mac.

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
`0600` file, with `systemd-creds --user` (systemd 256, TPM2-backed; the box has
a TPM) as an optional wrap in a follow-up once it is shown to work unprivileged
on that box.

The model:

- **Kinds**, in a registry (`shared/secrets.ts`): the Telegram token, the
  OpenRouter key, each web provider's key file (`firecrawl.json`,
  `web-firecrawl-self.json`, `web-*.json`), a Claude long-lived token, a Codex
  `auth.json`. Each kind names its file on a node, how its hint is read, what
  it unlocks, and how to revoke it at the source (BotFather `/revoke`, the
  OpenRouter and Firecrawl dashboards, `claude setup-token` again, `codex
  logout`). The share token, the link tokens and the backup's git credentials
  are *not* kinds: they never leave the node that minted them.
- **Grants** are per child per kind, off by default, ticked in Settings → Nodes
  → <node> → Secrets. A child holds only what is ticked.
- **A push** happens on grant, on link-up, and when the parent's file changes
  (the backup already watches these mtimes). The value is sealed to the child's
  public key (learned at enrolment) with an ephemeral X25519 key, HKDF and
  AES-256-GCM, so a push can only be opened by the node it was for, token or no
  token; the child writes it with `writeConfigFile(name, value, 0o600)` and
  acknowledges with the hint. Nothing is logged.
- **Rotation** is pasting the new value on the parent; every grantee is pushed
  and the page shows which acknowledged.
- **Revocation** is unticking: the child removes the file and acknowledges; the
  page shows the at-source step for that kind beside it.
- **On the child's disk**: the granted files, and nothing else. A child's
  Settings page for a granted kind says "held from the Mac, hint …, since …"
  and offers no field. A client is sent hints, never values, on both nodes, as
  today.
- **Backups** leave all of it out, on both nodes: `nodes.json`, the token
  kinds, the logins. The allow-list in `shared/backup.ts` gains the new names
  in its "never" line.

### CLI logins

- **Claude Code.** The child already has a login of its own (the box's user
  ran `/login`; `~/.claude/.credentials.json` is there). A child profile that
  uses the machine's directory works today. For a profile that should carry
  the Mac's account, the documented road is `claude setup-token` on the Mac —
  a one-year token that only makes model requests — granted as the
  `claude-oauth-token` kind, and put into `CLAUDE_CODE_OAUTH_TOKEN` by
  `loginEnv` on every pty of that profile, which is the one place a credential
  is allowed into a pty's environment, because that is how Claude Code takes it
  and the same exposure the login file already has. Never a copied
  `.credentials.json`: its refresh token rotates, and two machines refreshing
  one token sign each other out. Never the keychain item: it is the Mac's.
- **Codex.** OpenAI documents copying `auth.json` to a headless machine, and
  `codex login --device-auth` on the box itself. The `codex-auth` kind carries
  the file into the profile's `CODEX_HOME`.
- **gh, git.** Out of scope; a child's git is the box's.

### Linux: build, install, service, host, logs, updates

- **A checkout on the box, built there.** `desktop/dist/*.mjs` and `web/dist`
  are plain JavaScript, but node-pty is native and has no Linux prebuild, so it
  is compiled by node-gyp at install, which needs the box's gcc, make and
  python (present) and the node headers for mise's node (downloaded at build).
  bun runs node-pty's install script by default; `bun install` is enough.
  Electron's download is skipped (`ELECTRON_SKIP_BINARY_DOWNLOAD=1`); nothing
  on a child imports it.
- **Node 26 from mise**, which is on the user's interactive PATH and not on a
  service's. The unit names the binary by its full path, as the box's other
  user unit does. `node:sqlite` is unflagged from 22.13 and a release candidate
  from 25.7; the store's `backup()` call exists in both.
- **`kururu.service`**, a user unit the installer writes to
  `~/.config/systemd/user/`, running `node server/run.mjs` (no `--watch`) with
  `KURURU_BIND=tailscale`, `KURURU_LOOPBACK_TOKEN=1`, `Restart=on-failure`,
  `KillMode=process`. The box already lingers (`Linger=yes`), so the unit runs
  with nobody logged in.
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
  PC other long-running programs run as the same user — another AI agent
  gateway among them — and `tailscale serve`, if the user turns it on for the
  phone's microphone, delivers every request from loopback. So a child requires
  the token on loopback too (`KURURU_LOOPBACK_TOKEN=1`, also a field in
  `access.json`, default on for a child), and kururu's own callers on the box
  present it from `access.json`: the hooks (`report.mjs`), `status.mjs`,
  `reload-window.mjs`, the backup CLI, the harness's `--mcp-config` and the
  agents' `web-mcp.json` (both carry a header). The Mac keeps its exemption
  until the user wants otherwise; the switch exists on both.
- **Bypass permissions on a real machine.** A child runs agents as the box's
  user. On the Omarchy PC that user is in `wheel` with sudo behind a password
  and not in the docker group, so an injected `rm -rf` reaches that user's
  files, keys and tailnet shell and no further. The plan recommends a dedicated
  user for the child with the project checkouts and nothing else, and says so
  in the install doc; it does not create one.
- **What a child never holds**: the parent's share token, its link tokens to
  other children, the backup repository's credentials, any secret not granted.
- **What a compromised child gets**: its granted secrets, its own agents, and
  the ability to answer the parent's forwarded verbs with lies. It cannot
  reach the parent's server (the parent listens on loopback), cannot reach
  another child, and cannot ask the parent for a secret it was not granted.

### Children and the machines feature

A child **supersedes** the machines feature for a box that can run one, and
**sits beside** it for the rest. The machines rows stay for ssh gauges and
`ssh -t` shells (a VPS with no node, this box's CPU and disk), a node entry may
name the machine entry it is the same box as so the gauges draw under the node
heading, and a workspace that was pinned to the box is remade on the child —
its board can be carried by hand through the profile board's send, or by Kuru.
The "forward the hooks over `ssh -R`" item in `docs/machines.md` is dropped in
favour of children; the ssh road is not changed.

## The protocol, in one screen

| where | what | who presents what |
|---|---|---|
| child `POST /api/nodes/enrol` | `{code, parent: {name, publicKey}}` → `{node: {id, name, publicKey, version}, linkToken, shareToken}` | the pairing code; tailnet address only |
| child `GET /link` (WebSocket) | child → parent: `summary` (coalesced, on change), `telegram-out` (a Kuru reply or `say` line with its origin), `secrets-ack`, `telegram-role-ack`; parent → child: `hello {parent summary}`, `secrets-put {kind, envelope}`, `secrets-forget {kind}`, `telegram-role {holder, settings}`, `telegram-in {id, at, text}` | the link token in `Authorization` |
| child `POST /mcp?profile=…&session=parent:…` | the harness's tools, unchanged | the link token |
| child `GET /api/export` (exists) | the child's boards and turns for the parent's mirror | the link token |
| parent `GET /api/health`, snapshot | `nodes: NodeStatus[]` and a `nodes` message | as today |

Everything on `/link` is JSON over the existing `ws` dependency; the parent's
`NodeLink` is a client the way `session.ts` is, reconnecting forever.

## Phases

Effort is in agent-days: one focused Claude Code session, with its tests and
docs, is about a day. Each phase ends with its docs written — a `docs/nodes.md`
grows through phases 2–5, `docs/linux.md` is phase 1's — and with the CLAUDE.md
brief touched only where a rule changes.

### Phase 0 — a spike on the box (half a day)

Run the current bundle on the Omarchy PC by hand, in an isolated instance
(`docs/testing.md`), and write down what breaks. The point is to replace the
list above with one measured on the box before anybody edits `hostlaunch.ts`.

- clone to `~/Projects/kururu` on the box, `mise use bun@latest`,
  `ELECTRON_SKIP_BINARY_DOWNLOAD=1 bun install`, `bun run build`; check
  `node_modules/node-pty/build/Release/pty.node` exists and that the install
  did not silently skip node-pty's script;
- `KURURU_PORT=7817 KURURU_STATE_DIR=/tmp/k2 KURURU_DATA_DIR=/tmp/k2/data
  XDG_CONFIG_HOME=/tmp/k2/config KURURU_BIND=<tailnet ip> node server/run.mjs
  --no-build --entry desktop/dist/server.mjs`;
- from the phone: the QR from `bun run status`'s address, a `sleep 30` tab, a
  Claude tab (the box is signed in), the harness;
- note every stderr line; `bun run kill-ptyhosts /tmp/k2` after.

Done: a list in the card of what failed, with the file and line.

### Phase 1 — a headless child on Linux (4–6 days)

Useful alone: the Omarchy PC runs kururu as a service, the phone drives it over
the tailnet, agents survive a server restart, Kuru works there.

Files and modules:

- `package.json`: scripts `node:install`, `node:update`, `node:status` →
  `tools/node.mjs` (plain node, no bun at runtime), which writes the unit,
  enables it, prints the phone URL with the token, and does the update
  sequence. `trustedDependencies` is only needed if bun's default list ever
  drops node-pty; the installer checks for `pty.node` after `bun install`
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
- The callers that present the token on the box: `report-cli.ts` (reads
  `access.json` when `KURURU_PORT`'s server wants it — the hook settings
  written by `hooks.ts` can carry it as an env for the hook instead), `status.mjs`,
  `reload-window.mjs`, `backup-cli.ts`, `hooks.ts`' settings file, the
  `web-mcp.json` launch flags (`headers`) and the harness's `--mcp-config`.
- `server/sockowner.mjs` (used by `status.mjs` and `kill-hosts.mjs`) and a TS
  twin in `index.ts`'s `socketHolder`: `lsof` on macOS, `ss -xlpn` on Linux;
  `devservers.ts`: `ss -ltnpH` parsed for listeners on Linux, with a test over
  captured output.
- `server/src/voice.ts`: off darwin, the ears and the system voice say "not on
  this platform" rather than "brew install yap"; Settings → Voice draws the
  sentence.
- `.github/workflows/ci.yml`: typecheck and `bun test` on `ubuntu-latest` and
  `macos-latest`, so a darwin-only assumption fails in CI rather than on the
  box.
- `docs/linux.md`: install, the unit, logs, update, the host as a unit, what is
  missing (voice, window, Trash without `gio`), the dedicated-user advice.
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

### Phase 2 — nodes: enrolment and the mirror (4–6 days)

Files and modules:

- `shared/nodes.ts`: `NodeEntry`, `NodeSummary`, `summarize(snapshot, …)`
  (pure, from the same facts `kururu_status` reads), `NodeStatus`, the pairing
  code (reuse `pairingCode`'s alphabet), `adoptNodeList`, the enrolment request
  and answer shapes, the `/link` message union. Tested.
- `server/src/nodes.ts`: `NodeHost` (the child's half: the code, `enrol`, the
  `/link` route with its coalesced `summary` push, the parent-present flag) and
  `NodeLinks` (the parent's half: one client per entry in
  `~/.config/kururu/nodes.json` at `0600`, reconnect with backoff, `nodes`
  broadcast, `forward(nodeId, fn)` for later phases). Both halves in every
  server; a node can be a parent and a child at once, which costs nothing and
  keeps one bundle.
- `server/src/access.ts`: link tokens as a second set in `hasToken`, scoped to
  `/link`, `/mcp`, `/api/export`, `/api/nodes/*`.
- `server/src/index.ts`: the routes; `nodes` in the snapshot and `/api/health`;
  the backup's mirror gains `nodes/<name>/` from each child's export (optional
  in this phase, one day; `bun run restore --node <name>` is the way back).
- `web/src/settings/Nodes.tsx`: on a parent, add by address and code, rename,
  remove, each node's status, version, last seen, "Open"; on a child, the code
  button and the parents list. `Sidebar.tsx`: a section per node with its
  workspaces as rows wearing the agents' dots and the Needs dot; the machine's
  gauges under it when the entry names one. `NeedsDrawer.tsx` and the tray
  count: a band per node whose rows are links to the node. `Reach.tsx`: a QR
  per child. `desktop/connect.html`, `servers.js`, `menu.js`: nodes read from
  `nodes.json` offered in the picker and as "Open <node>" in the tray.
- `shared/harness.ts`: `kururu_status` lists nodes; the role gets a "Nodes"
  section saying what the parent's Kuru can and cannot do yet.
- `shared/backup.ts`: `nodes.json` in the never-list.

Done when: the parent's sidebar shows the Omarchy child's workspaces and
agents live, with dots that change as the child's hooks report; the Needs tray
counts a child's blocked agent and the drawer opens the child; the tray and
the picker open the child; the child's own UI says the Mac is away within
seconds of the lid closing and shows its last summary; removing a node on the
parent revokes the link token on the child.

Tests: `nodes.test.ts` for the summary, the code, the adopt, the link state
machine over a fake socket pair (`hostlink.ts` has the pattern).

### Phase 3 — Kuru across nodes (2–4 days)

- `shared/harness.ts`: the `node` argument on the tools listed above, the
  `<node>:<id>` agent id grammar in every tool result and in `kururu_status`,
  `agentName` with the node, the role's Nodes section rewritten.
- `server/src/harness.ts`: `Harness.call` routes a call with a node (or a
  prefixed id) through `NodeLinks.forward` to the child's `/mcp` with the
  child's profile id, prefixes the result, refuses `reveal_agent` with the
  node's URL, and leaves Auto Swap alone. The child's `selfFor` accepts a
  `parent:` session as a caller that is not one of its agents.
- `server/src/index.ts`: `noticeStatuses` keeps notices local (no change, and
  a test that says so).

Done when, from the Mac's drawer: "start a Claude agent on Omarchy in <workspace>
with this prompt and tell me when it is done" starts it in the child's agents'
pane, `wait_agent` answers from the child, `read_agent` shows its reply, a card
added with `node` lands on the child's board.

Tests: the routing decision as a pure function; `harness.test.ts` with a fake
forwarder.

### Phase 4 — secrets (4–6 days)

- `shared/secrets.ts`: the kinds registry, grant states, the envelope shape,
  the hint readers; a test that every secret file kururu writes is either a
  kind or named in the never-shared list.
- `server/src/seal.ts`: `seal(publicKey, bytes)`, `unseal(privateKey, envelope)`
  with X25519, HKDF-SHA256 and AES-256-GCM from `node:crypto`; keys made at
  enrolment and kept at `0600` in `nodes.json` (parent) and `node.json`
  (child). Round-trip and tamper tests.
- `server/src/secrets.ts`: parent: catalogue, grants, pushes on grant, link-up
  and file change, acks; child: take, write with `writeConfigFile(…, 0o600)`,
  forget with `removeConfigFile`, status. The Claude kind reaches `loginEnv`
  as `CLAUDE_CODE_OAUTH_TOKEN` for profiles set to use it; the Codex kind is
  written into the profile's `CODEX_HOME`.
- Settings → Nodes → <node> → Secrets on the parent; the "held from" line on a
  child's OpenRouter, Web and Channels pages.
- `shared/backup.ts`: the new files in the never-list; the README text.
- `docs/nodes.md`: the secrets section, with the at-source revocation per kind.

Done when: granting the self-hosted Firecrawl and OpenRouter kinds makes the
child's Settings → Web and sidebar balance ready with hints only; an agent on
the child uses `kururu_web`; changing the key on the Mac reaches the child
within seconds and the page shows the ack; unticking removes the file; a child
started with the Claude token kind runs an agent as that account.

### Phase 5 — one Telegram (4–6 days)

- `shared/channels.ts`: the node prefix line, the reply map shape, `routeOf`
  (reply-to, sticky target, `/to`, `/where`, `/nodes`), the role in
  `TelegramSettings`, the held-for-a-sleeping-node notice. Tested.
- `server/src/telegram.ts`: the poll runs only on the role holder; outgoing
  entries carry an origin and sent ids fill the map; incoming are judged as
  today and then routed — own node to `Outbox.say`, another node through the
  link; queued for a node that is away, with one notice.
- `server/src/channels.ts`: `replied` and `aside` on a non-holder go to the
  holder over the link; `prompted`'s quiet echo too.
- `server/src/nodes.ts`: `telegram-role` carries the settings (allow-list,
  `enabledAt`, speak-replies) to the holder; the token itself is the phase-4
  kind, granted first.
- Settings → Channels: the role picker on the parent; the "polls here, token
  held from the Mac" line on a child.
- The role prompt's Telegram section says lines are marked by node.

Done when: with the lid closed, a message to the bot is answered by the
Omarchy Kuru with its prefix; with the Mac awake, both Kurus' replies arrive in
the one chat; replying to a line reaches that node; `/to mac` then a bare
message reaches the Mac; a message for the Mac while it sleeps is held and
delivered on wake, and the chat was told once; switching the role moves the
poll with no 409 in either log.

Tests: routing, prefixes and commands as pure functions; the fake Bot API from
`channels.test.ts` for the map and the queue; a link test for the role
handover.

### Phase 6 — later, each on its own (optional)

- **One window**: a remote pane type — a tab `{kind: "remote", node, agentId}`
  in the parent's layout whose emulator is fed from a second socket to the
  child, with the child owning that terminal's size as it owns every other
  client's. 4–6 days; touches `terminals.ts`, `Panes.tsx`, `session.ts`,
  `shared/layout.ts`.
- **A prompt answered from Telegram**: a `blocked` edge forwarded as a message
  with an inline keyboard; the answer through `press_keys`. 2 days.
- **Topics in the private chat** instead of prefixes, after checking the Bot
  API 10.0 report. 1–2 days.
- **`systemd-creds --user`** wrapping of granted files on a child with a TPM.
  1–2 days, after the spike shows it works unprivileged.
- **A mesh** for a second child while the Mac sleeps: children dialing the
  role holder. Only if a second child appears.
- **Push notifications** (roadmap 3): a child is the natural pusher, being
  always on.
- **`tailscale serve`** on the child for the phone's microphone: the user's
  command, documented in `docs/linux.md`, gated on the loopback rule.

Total for phases 0–5: roughly 19–29 agent-days, in order, each shippable.

## Risks and open questions

- **node-pty from source.** node-gyp needs the node headers for mise's node
  26, downloaded at build; a box without internet at that moment fails the
  install. The spike finds out.
- **A transient unit under a lingering user manager** is the design's load-
  bearing fact on Linux; if `systemd-run --user` refuses from the service's
  context, the fallback is `KillMode=process` on `kururu.service` with the host
  spawned detached — which survives a restart but not a `systemctl --user stop`.
  The spike tries both.
- **`node:sqlite` is a release candidate** on node 26 and experimental-with-no-
  flag on node 24; the store uses five calls and `backup()`. A node major that
  changes an option name breaks the child's start, which `lifecycle.log` says.
- **Two Kurus on one agent.** Serialised by the pty and bounded by the roles;
  not prevented. If it bites, the fix is the child refusing a forwarded
  `send_agent` while its own Kuru is mid-turn on that agent, which `due`'s
  bookkeeping already knows.
- **The Telegram role with no failover** means a dead child silences the chat
  until the user moves the role. That is the honest trade against split brain;
  the parent's Settings page says it in red.
- **A credential in a pty's environment** (`CLAUDE_CODE_OAUTH_TOKEN`) is the
  one exception to the web tools' rule, by the CLI's design. It is per profile
  and granted, and the install doc names it.
- **Another Telegram client on the box.** Another agent gateway already runs
  there as a user service; if it ever holds the same bot token, the 409 fight
  is with it, and the page's "something else is reading this bot" line is the
  tell.
- **The desktop cannot be sent to a child by a served page**, by design. The
  picker and the tray do it; a phone follows a link. If that feels like two
  windows, phase 6's remote pane is the answer, not a bridge call.
- **A child's backups.** Pulling a child's export into the parent's mirror
  means the child's boards are only as backed up as the Mac is awake; a child
  with its own repository means a second repository and git credentials on the
  box. The plan prefers the first and asks below.
- **Bypass permissions on the box.** The user's account there can read every
  key and project on it. A dedicated user is advice in the doc, not a step in
  the installer.

## Questions for the user

1. **Telegram routing**: prefixes with reply-to and `/to` as the baseline — or
   try topics in the private chat first, accepting the reported 10.0 breakage?
2. **The poller**: the Omarchy child by default, since it is always on? And is
   it acceptable that a child that is down silences the chat until the role is
   moved by hand?
3. **The parent's Kuru and children's agents**: act only when asked, as
   planned, or also be told each child's `done`/`blocked` edges (and risk two
   Kurus answering one prompt)?
4. **The child's Claude account**: the login already on the box, or the Mac's
   account through a `setup-token` grant — per profile?
5. **Secrets at rest on the child**: `0600` files as on the Mac, or wrapped
   with `systemd-creds` and the TPM once shown to work?
6. **A child's backups**: into the Mac's backup repository under `nodes/`, or
   a repository of its own on the box?
7. **The child's unix user**: the box's own account (in `wheel`, sudo with a
   password, not in `docker`), or a dedicated one made by hand first?
8. **Which workspaces move to the child first**, given the box also runs
   production containers that are given CPU priority?
9. **One window**: is "the picker opens the child" enough for a long while, or
   is the remote pane wanted soon after phase 2?
10. **`tailscale serve`** on the child for the phone's microphone: wanted, so
    the loopback rule and the doc are written with it in mind?
11. **Node names** for the chat and the sidebar: "Mac" and "Omarchy"?
12. **The other agent gateway on the box**: does it hold a Telegram bot of its
    own (so two tokens, no 409), and does it share the box's Claude login?

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
port 7717 free, another node service of the user's on loopback, the user in
`wheel` with sudo behind a password and not in `docker`, and a `~/Projects`
folder. The web's facts: `node:sqlite` history from nodejs.org; node-pty's
prebuild listing from unpkg; `claude setup-token` and the credential locations
from code.claude.com; Codex's `auth.json` copy and `--device-auth` from
developers.openai.com; `message_thread_id`, `reply_to_message` and private-chat
topics from core.telegram.org and the aiogram changelog; `systemd-creds
--user` from the Arch man page; Tailscale Serve's identity headers from
tailscale.com.
