# Working in kururu

This file is the operational brief: what will bite you today, and what you must
not break. The reference lives in [`docs/`](docs/README.md) — one file per
subsystem, linked from each section below. `PLAN.md` has the design argument;
`README.md` is for people using kururu.

## What this is

Kururu is a **desktop and phone GUI for coding agents, which it runs itself**. It
spawns each agent in a pty it owns, keeps a headless terminal emulator beside it,
and serves the same URL to an Electron window and to a phone over Tailscale —
where it is for **watching and steering agents, not for writing code**.

It is **three processes, and the window is the least important of them.** The pty
host holds every pty and outlives everything; the server holds the protocol, the
layout and the discovery, and is restarted constantly; the window finds a server
and draws it, exactly as the phone does.

## The five rules

1. **Never modify `../ghosttown`.** Kururu borrows *from* it and the traffic is
   one-way; if something there needs changing, raise it with the user.
   **`../kururu-styles` is ours, and kururu no longer reads it**: the theme
   registry it served was taken out on 2026-11-09, so leave it alone unless
   the user asks.
2. **The agents are real, and they are the user's.** Real processes, real ptys,
   real project directories. `input` types into one keystroke for keystroke;
   `kill-agent` signals its whole process group. There is no sandbox and no
   dry-run: a careless test spends the user's tokens or ends work they were in
   the middle of. When testing by hand, spawn `sleep 30` or `cat` — `create-agent`
   takes a `command`.
3. **Never rebuild a terminal emulator.** They are pooled by agent id and *moved*
   between panes. Nothing in the client rebuilds one during ordinary navigation —
   see [terminals](docs/terminals.md#the-pool).
4. **Do not run `tailscale` commands.** Putting a port on the user's tailnet is
   their decision, never a side effect of a code change. Document it; do not
   execute it.
5. **Do not run git commands automatically.** No commit, no push, no `git init`,
   unless the user explicitly asks.

## ⚠️ The live-agent hazard

**Only the pty host holds ptys, and only restarting *it* costs anybody their
agents.** Quitting the window does not. Restarting the server does not.

| you edit | what it costs |
|---|---|
| `web/`, `desktop/` | a repaint — ⌘R, or `C-a R`, and an agent asks for it with `bun run reload-window --why "…"` rather than asking the user: the window reloads once it is safe and the command says whether it did (a `desktop/` change wants the window relaunched, which is free) |
| `server/src/` *except* the row below | a reconnect — `C-a B`, or automatic under `bun run dev` |
| `server/run.mjs` | nothing, until a runner is next started — the one running keeps the copy it loaded |
| `server/src/agents/`, `ptyhostd.ts`, `ptyhost.ts`, `hostlink.ts`, `hostsock.ts` | **every agent the user is running** |
| on a child: `systemctl --user restart kururu`, `kururu child update` | a reconnect — the host is a systemd unit of its own; only `kururu child restart-host` ends agents, and it asks. See [linux](docs/linux.md) |

So batch changes to the host, and say so before asking for one to be restarted. A
live pty cannot be handed to a replacement process, and that irreducible fact is
the only thing in kururu that ends an agent by accident. **A host that is behind
says so:** `hello` carries its version and `HOST_PROTOCOL`, and `/api/health`,
`bun run status` and Settings → About report a server ahead of its host. Bump
the protocol when a host change must be restarted into, and gate the feature on
the number it arrived in (`HOST_SINCE` in `hostlink.ts`) rather than letting an
old host drop the field in silence. Never gate one on `HostInfo.current`: every
bump makes older hosts not current, so a feature an old host does fine would go
off until a restart nobody has chosen. `current` says a restart is owed.

**The other thing that ended agents by accident was macOS,** twice on
2026-10-10, 27 agents. A host spawned detached still sat in the *coalition* of
the app that started the chain, and a Dock force quit — which is what quitting
a leftover tile is — ends a whole coalition. `server/src/hostlaunch.ts` starts
the host as a launchd job instead, on a clone of Kururu.app it owns; never go
back to spawning it as anybody's descendant. It is server code, so editing it
costs a reconnect and changes only the *next* host. `bun run status` prints
`coalition  shared` for a host started the old way. On Linux the same file
starts it as a transient systemd user unit, because a child's server is a
service and a service's cgroup ends with it; `unit  shared` is the tell
there. See [gotchas](docs/gotchas.md#running).

**The trap, which has already cost a session:** a running `bun run dev` watches
`server/src` and `shared`, so editing those restarts the user's server *while you
work*. That is cheap and intended. What is not cheap is editing a file the
watcher hands off, or rebuilding the bundles underneath a server mid-flight.
**Check first (`curl -s localhost:7717/api/health`) and say what you are about to
disturb.**

Ending a host is `bun run kill-ptyhosts` (`--list` to dry-run, or a socket path
for just the scratch instance). It finds hosts **by their socket, not by their
name**, and so should you — `pkill -f ptyhostd` is unreliable here, see
[gotchas](docs/gotchas.md#running).

## Commands

```sh
bun install            # from the ROOT
bun run dev            # the agents: builds, starts the host if needed, serves :7717, restarts on save
bun run dev:desktop    # the window. Finds a server; starts vite for itself
bun run status         # is the host up, is a server up, what are they holding
bun run kill-ptyhosts  # THE destructive one: ends every agent. --list to dry-run
bun run reload-window --why "…"  # an agent's ⌘R: waits for a safe moment, says what happened
bun run backup         # a backup now, through the server when one is up; --check lists what goes
bun run share          # the phone's link and its QR code in the terminal, for a box with no window; --rotate, --url
bun run slot status    # the slot queue agents share for builds and simulators; agents run ~/.local/state/kururu/bin/slot
bun run restore <repo> # a new Mac put back from the backup; refuses while a server is up
bun run typecheck      # root tsconfig + web tsconfig + the JS half (tsconfig.js.json)
bun test               # pure functions only — see docs/testing.md
bun run build          # web → web/dist, server → desktop/dist/*.mjs, the talk-key hook → desktop/dist/talkkey, the canHide addon → desktop/dist/stay.node
bun run build:talkkey  # just the hook (Swift, through xcrun; skipped with a warning without Xcode)
bun run build:stay     # just the addon that keeps the floating windows up while kururu is hidden (clang, same terms)
bun run dist           # signed, notarized DMG + zip. `dist:unsigned` for testing
```

`dev` is the half that holds your agents; `dev:desktop` is a window onto it. Kill
either and the agents carry on. **The installed app needs no terminal:** its
menu-bar frog runs `run.mjs` itself, from the app or from a checkout picked in
the menu — see [architecture](docs/architecture.md#the-runner-and-the-menu-bar).
A `bun run dev` already on 7717 is adopted, never fought.

**Ports:** 7717 server · 5173 vite · 7800+ preview proxies.
**Socket:** `~/.local/state/kururu/ptyhost.sock`, with `ptyhost.log` beside it —
the host is a daemon and its log is the only place its side of a bug shows up.
**Data:** `~/.local/share/kururu/kururu.db` — boards, conversations and the
voice's lists, the one thing on the machine nobody can rebuild; `backup/`
beside it is the mirror git pushes. See [data](docs/data.md).
`lifecycle.log` is there too: every server start, stop, restart and crash, and
why. It is the answer to "why did the window just reconnect", and
`bun run status` prints its end. `pill.log` beside it is the same for the
floating pill: every place it was put, why, and the displays it chose between.

Anything that writes config, installs a style, or acts as a second real client
goes in an **isolated instance** — see
[testing](docs/testing.md#the-isolated-instance).

## The shape, in one screen

`shared/` protocol types and the tree, no runtime deps · `server/` two processes,
Node not Bun · `web/` React 19 + Vite, one build · `desktop/` Electron main +
preload + the esbuild step. Full annotated map: [docs/map.md](docs/map.md).

The load-bearing invariants, one line each, with the argument behind the link:

- **The arrangement is the server's, and the client sends verbs.** A message says
  *split the focused pane*, not *here is my new tree*. → [layout](docs/layout.md)
- **The server owns the size.** A pane *proposes* a grid; the server takes the
  smallest over the clients that can see the terminal and tells everyone what to
  draw at. → [terminals](docs/terminals.md#the-size-policy)
- **A backlog is a serialized screen laid out at a width**, and backlog-then-output
  ordering is per client. → [terminals](docs/terminals.md#the-backlog)
- **No GPU-backed renderer in a pane**, ever. →
  [terminals](docs/terminals.md#no-gpu-context-in-a-pane)
- **`persist.ts` restores structure, never processes.** Four restored agent tabs
  must not launch four agents. → [layout](docs/layout.md#persistence)
- **The Dashboard is the profile's, not a workspace** — beside `workspaces`,
  never in it, holding its fixed tabs once each and nothing else
  (`fitsDashboard`, kept in `Workspaces.mutate`). →
  [layout](docs/layout.md#the-dashboard)
- **Terminals open in the lower half, everything else in the upper**
  (`paneForIn`, `shared/halves.ts`) when nobody named a pane; the keyboard
  stays where it was, and a pane's + menu goes where it was asked. No setting.
  → [more](docs/invariants.md#the-two-halves)
- **Everything new in a workspace starts in its root** (`Workspace.root`,
  Settings → Workspaces), never the folder of the pane it came from; a named
  `dir`, a worktree and a resume still win, and a workspace with no root
  keeps the old follow-the-pane rule. → [layout](docs/layout.md#terminals-tabs-and-panes)
- **Boards live in the database and nowhere else, and a file never moves or
  deletes a card that is there.** Every change goes through `Store.syncProfile`; a
  database that will not open is a server that does not start. →
  [more](docs/invariants.md#boards-in-the-database)
- **Kururu has one look, and it is the `:root` block of `web/src/styles.css`.**
  Nothing writes a colour or a shape at run time; the interface's face and
  size are the two properties that are written (`--ui-font`, `--ui-scale`,
  Settings → Fonts), and the terminal's palette is `TERMINAL` in
  `shared/theme.ts`, kept in step with `--bg` by hand. Themes, skins, packs,
  the registry and the studio were removed on 2026-11-09: do not bring a
  switch back without the user asking. → [styles](docs/styles.md)
- **A pane is a card, and a size is a token.** Gutter on every side, the top
  included; an icon is one of `--icon-sm/-md/-lg` and type is the `--fs-*`
  ramp, so the interface's size scales both. The window's three buttons are
  the page's only after it asks (`frame.claim`), and go back to the system's
  when that page goes. → [styles](docs/styles.md#the-window-as-cards)
- **A terminal's font change re-measures and nothing else about the look
  does.** A proposal is a pty resize and a SIGWINCH into every agent. →
  [terminals](docs/terminals.md#the-size-policy)
- **`files.ts`: resolve, check, realpath, check again — refuse, never clamp.**
  Roots are never learned from a client. →
  [architecture](docs/architecture.md#the-servers-shape)
- **The socket binds loopback and the `Origin` header is checked**, the second
  before the token; loopback is exempt unless `loopbackToken` says otherwise, and
  the token never goes on a command line. → [more](docs/invariants.md#access)
- **A page is sent the snapshot once and then what changed** (`shared/snapdelta.ts`),
  and a board's change is seen by its identity: replace a board, never edit one
  in place. → [architecture](docs/architecture.md#restarting)
- **Anything that takes a number off the wire gets `Number.isFinite`.** A clamp is
  not a check, because NaN loses every comparison it is in. →
  [layout](docs/layout.md#numbers-off-the-wire)
- **Notification policy runs once, on the server, per client.** →
  [notifications](docs/notifications.md)
- **A profile is a drawer of workspaces, plus — one switch, off by default — a
  login of its own** under `~/.config/kururu/profiles/`; no path ever comes from a
  client. → [more](docs/invariants.md#profiles-and-logins)
- **An idle card's agent is ended, nothing else's, and never before its
  conversation is found** (`server/src/sleep.ts`); every doubt keeps one awake,
  and nothing on disk is touched. → [more](docs/invariants.md#idle-card-agents)
- **A card's worktree is git's to refuse, never kururu's to force** — no
  `--force`, no capital; anything that ends an agent or removes a checkout asks
  first, in a centred dialog. → [more](docs/invariants.md#worktrees)
- **Backups leave the machine, and secrets never do** — an allow-list in
  `shared/backup.ts`; never `--force`, never a rewrite. →
  [more](docs/invariants.md#backups)
- **A secret leaves the Mac only sealed, to a node it was lent to**
  (`server/src/seal.ts`), one switch per child per kind, off by default; hints
  only to a client, no value in a log. →
  [more](docs/invariants.md#lending-secrets)
- **Settings → Vault names the vault and never shows a value**;
  `server/test/vaultview.test.ts` fails on a value that comes out. →
  [more](docs/invariants.md#the-vault-page)
- **A vault value goes from the owner's field to the Keychain and its env
  file, never through a model** — `ask_secret` / `vault ask` open a dialog on
  every page, the caller hears a word per field; an item is still readable by
  any process running as the owner, and the docs say so. →
  [vault](docs/vault.md)
- **The usage bar reads a Claude credential and never writes one** — read at the
  fetch, never held, logged or refreshed; `server/src/usage.ts` is the only file
  that has seen it. → [more](docs/invariants.md#the-usage-bar)
- **The usage ledger keeps the numbers and never the words** — `usage.db`, in no
  copy or backup, read-only off the logs the programs already write; it fails
  open. → [more](docs/invariants.md#the-usage-ledger)
- **The OpenRouter key, a channel's bot token and the web providers' keys are the
  credentials kururu stores** — 0600, read per request, a client sent its hint,
  out only sealed to a node; on a Mac the key itself in the Keychain behind
  `readConfigFile` (`configkeys.ts`). → [more](docs/invariants.md#stored-credentials)
- **The web is lent to agents through a chain, never a key** — four MCP tools at
  `POST /mcp/web` for agents on this Mac, the hand-back to their own tools first.
  → [more](docs/invariants.md#the-web-for-agents)
- **Antigravity's sign-in is never lent** — `agy` runs in a pty on its own
  login, reached only by `--settings` per launch and `.agents/` in Kuru's own
  folder; nothing writes `~/.gemini` or a project's `.agents/`. →
  [more](docs/invariants.md#antigravity)
- **A database is whatever `DATABASE_URL` says, read when asked and never held** —
  every query in `BEGIN READ ONLY` unless the viewer's switch says otherwise;
  Postgres only. → [more](docs/invariants.md#databases)
- **The harness is a session, not a loop** — one session per profile; what it says
  to an agent is typed into the pty as the user's words, never posted to its
  inbox. → [more](docs/invariants.md#the-harness)
- **A node is let in by the roster, never by a token** — paired by a single-use
  code, linked by keys the roster lists; each Kuru acts on its own node's agents
  only. → [more](docs/invariants.md#nodes)
- **Another node's workspace on this screen is that node's, shown here** — a verb
  is forwarded, never applied here, and no qualified `n:<node>:…` id is ever
  written. → [more](docs/invariants.md#remote-workspaces)
- **One Telegram bot for every node, read by one node at a time** (`LeadGate`); a
  node that does not hold the poll never calls `getUpdates`. →
  [more](docs/invariants.md#one-telegram)
- **A shell on another machine is a command line, never a host change** — `ssh -t`
  in an ordinary pty, in a named tmux session; an agent's status is read off its
  screen. → [more](docs/invariants.md#machines)
- **The voice is ears and a mouth around that session, not a second brain** —
  local only, the drawer is the conversation's one home, and Kokoro is never
  imported into the server. → [more](docs/invariants.md#the-voice)
- **Kururu records and Hex only hears** — a finished WAV to Hex's local
  `/transcriptions`, `yap` behind it; Hex's vocabulary is made from
  `~/Documents/Kururu/dictation/vocabulary.json`, in its order. →
  [voice](docs/voice.md#hex)
- **A note is a card kept in sight, never a copy of one** — looked up by id on
  every render; in the desktop app, a window of its own. →
  [more](docs/invariants.md#notes)
- **A link to what an agent made is read off its last reply, never off everything
  it touched** (`shared/made.ts`), at most two per agent. →
  [more](docs/invariants.md#what-an-agent-made)
- **A line of Kuru's chat is tagged by what it says, on every draw** — by
  workspace, and by project inside one (`shared/subprojects.ts`, keys
  `<workspace>/<slug>`, found under the root and never stored) — only
  Kuru's `[tags: …]` line, taken off the reply at `/api/report`, and the
  owner's corrections are written (`turn_tags`); `shared/kurutags.ts`. →
  [voice](docs/voice.md#tags)
- **What needs you is one rule, in `shared/needs.ts`, and three drawings of it**;
  no component decides it again, and nothing in it is dismissed by hand. →
  [more](docs/invariants.md#what-needs-you)
- **A channel is another door into the one conversation, and only the user's own
  accounts may use it** — the one road off the machine for the conversation's
  text. → [more](docs/invariants.md#channels)
- **`server/run.mjs` is the one supervisor, and the app ships it**; a server
  already on the port is adopted, and a host restart goes through the server. →
  [more](docs/invariants.md#the-runner)
- **An agent's reload is asked for, and the page picks the moment** (`reloadHolds`
  in `shared/reload.ts`); the pty host never hears of it. →
  [more](docs/invariants.md#reloading-the-window)
- **A slot lease ends with the terminal it was taken in, and only the server holds
  the line** (`server/src/slots.ts`); `xcrun` only once a simulator is asked
  about. → [more](docs/invariants.md#the-slot-queue)
- **While the talk key is hooked system-wide, the floating pill is the only voice
  client on this Mac** — a listen-only tap, and a key both saw fires once. →
  [more](docs/invariants.md#the-talk-key-everywhere)
- **The floating Kuru's chat is the drawers themselves, mounted only while it
  is open, and never a voice client** — the pill's page still holds the
  microphone; its window is docked to the logo and draws a waveform
  (`desktop/float.js`). It, the pill and the ink stay up while kururu is
  hidden (`canHide`, `desktop/stays.js`), and opening the chat never
  unhides the window. → [voice](docs/voice.md#the-floating-kuru)
- **An automation lives in the database and fires on one host, once a slot** —
  a file never switches one on; the run's row, unique by automation and slot,
  is written before anything starts (`server/src/automations.ts`). →
  [more](docs/invariants.md#automations)
- **The clock is the server's, never the pty host's, and an isolated instance
  has none** (`KURURU_DATA_DIR` without `KURURU_AUTOMATIONS=1`); an automation
  never widens what an agent may do, and a quiet run tells nobody. →
  [more](docs/invariants.md#automations)

## Code style

Match ghosttown — the user writes in a distinctive register and kururu follows it:

- **Module-level doc comments explain *why the module exists*,** not what it does.
  `server/src/proxy.ts` and `server/src/agents/screen.ts` are the target.
- **Comments explain decisions and rejected alternatives,** in prose and full
  sentences. "Ports come from the kernel because `vite --port` lies when the port
  is taken" — not `// get port`.
- No comment that restates the code on the next line.
- TypeScript strict, `noUncheckedIndexedAccess` and `noUnusedLocals` on. Tests cover pure functions.

## Where we're going

Shipped: the three-process split, tiled terminals with the server owning the
size, the multiplexer hierarchy and dragging, the markdown reader with
server-side highlighting and draggable document tabs, the file tree (markdown to the
reader, everything else to nvim), foreground notifications, the plan-usage bar,
and a signed self-updating app. The styles registry and the skin studio shipped
and were removed on 2026-11-09, for one look to be started again from.

Open, roughly in order — the argument for each is in `PLAN.md`:

1. **The preview as a pane type.** `proxy.ts` already opens a proxy per
   discovered dev server and `web/src/preview.ts` links to it; what is owed is
   the pane that shows one.
2. **Transcripts as chat** — also how the phone stops being a desktop layout.
3. **Push notifications**, so a phone with its screen off can be reached. The
   foreground layer is done; this is the other one.
4. **The element picker** injected by the proxy: long-press an element, send the
   selector and source location to the agent. Waits on the preview pane.
5. **The voice on the phone.** The voice is built (`docs/voice.md`) and the
   phone's button is there; what the phone lacks is a secure context for its
   microphone, which is `tailscale serve` and the user's decision. Also owed:
   a verified DMG with the Kokoro stack and the talk-key hook in it — the
   system-wide key and the floating pill are built (`docs/voice.md`) and
   unpressed in a signed build.

Smaller things owed: the Homebrew tap, and attributing a discovered dev server
to the workspace that owns it — the machine-wide port scan still says nothing
about who owns a listener.

`PLAN.md`'s own "Where it is" list is stale: it has the reader and highlighting
as upcoming when both shipped in 0.1.0.
