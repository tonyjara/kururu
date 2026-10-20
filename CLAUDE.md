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
   **`../kururu-styles` is different and is ours** — see
   [styles](docs/styles.md#the-registry) for the two rules that cross that
   boundary.
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
`HostInfo.current` rather than letting an old host drop the field in silence —
and only then, because bumping it switches those features off until the
restart.

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
bun run restore <repo> # a new Mac put back from the backup; refuses while a server is up
bun run typecheck      # root tsconfig + web tsconfig
bun test               # pure functions only — see docs/testing.md
bun run schema         # publish the token and part vocabulary to ../kururu-styles
bun run build          # web → web/dist, server → desktop/dist/*.mjs, the talk-key hook → desktop/dist/talkkey
bun run build:talkkey  # just the hook (Swift, through xcrun; skipped with a warning without Xcode)
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
- **The agents kururu starts itself go to the agents' pane.** A card's run and
  resume and Kuru's `start_agent` ask `agentPaneIn` — the bottom pane by
  geometry (`shared/agentpane.ts`), marked `forAgents` so the next one joins
  it, the whole layout split when there is none — and read their directory
  off the old pane (`cwdPaneIn`); the keyboard stays where it was. The + menu's
  agents go where they were asked for, and `off` is the old `paneBesideBoard`.
  → [layout](docs/layout.md#the-agents-pane)
- **Boards live in the database and nowhere else, and a file never moves or
  deletes a card that is there.** A first start makes `kururu.db`, and there
  is no other mode. Every change to a profile goes through `Store.syncProfile`
  before memory takes it, the diff of the two boards is the history, and a
  deleted card is a stamp. The layout file carries keys and never a board;
  a card an old one or the host's blob carries that the database has never
  seen is adopted — never the other way round. Profiles and workspaces are
  known by `key`, not by their counter ids. A database that will not open is
  a server that does not start. → [data](docs/data.md)
- **Never write a hex or a px into `styles.css`.** Both axes are tokens and
  `web/test/theme.test.ts` fails on a drift. → [styles](docs/styles.md)
- **A token has a floor, and the pairs are read out of the stylesheet.** Right
  tokens and unreadable text is a thing a palette can be; `shared/contrast.ts`
  says what each one is held to as ink and `CONTRAST_KNOWN` records — not
  approves — the eighteen pairs already under it. → [styles](docs/styles.md)
- **Changing a theme must never resize a pty; changing a skin does**, and that is
  intended. → [styles](docs/styles.md#one-palette-and-a-theme-names-both-halves)
- **`files.ts`: resolve, check, realpath, check again — refuse, never clamp.**
  Roots are never learned from a client. →
  [architecture](docs/architecture.md#the-servers-shape)
- **The socket binds loopback and the `Origin` header is checked**, the second
  before the token. Loopback is exempt from the token unless `loopbackToken`
  (or `KURURU_LOOPBACK_TOKEN=1`) says otherwise, which a child sets; then
  every local caller presents it, from `server/localtoken.mjs` or the
  `KURURU_TOKEN` the server hands its ptys, and never on a command line.
  `KURURU_BIND=tailscale` is a child's tailnet address, with loopback beside
  it. → [architecture](docs/architecture.md#access)
- **Anything that takes a number off the wire gets `Number.isFinite`.** A clamp is
  not a check, because NaN loses every comparison it is in. →
  [layout](docs/layout.md#numbers-off-the-wire)
- **Notification policy runs once, on the server, per client.** →
  [notifications](docs/notifications.md)
- **A profile is a drawer of workspaces, plus — one switch, off by default — a
  login of its own.** It carried *chosen* accounts for a version and that is
  gone; what is back is a choice among directories kururu itself made.
  `Profile.loginKey` names a directory under `~/.config/kururu/profiles/`,
  `logins.ts` points `CLAUDE_CONFIG_DIR` and `CODEX_HOME` into it on every pty
  the profile opens, and the pty host takes an `env` again — which is why
  `HOST_PROTOCOL` exists. A profile may be pointed at another's key, from a
  list the server reads off the disk and refuses anything outside of; no path
  ever comes from a client. → [layout](docs/layout.md#profiles)
- **An idle card's agent is ended, nothing else's, and never before its
  conversation is found.** `server/src/sleep.ts` looks only at cards' runs —
  never a tab from the menu, the harness, a shell — and every doubt keeps one
  awake: a prompt or question on screen, a message held for it, a draft in its
  prompt, a command running under it, a last reply that asks. Then the
  transcript or rollout `--resume` needs is opened (over ssh on a machine; a
  Codex run's id is learned off its rollout first), the run is written
  `asleep`, and the close button's `endTerminal` ends it. Running the card
  again resumes; nothing on disk is touched. → [layout](docs/layout.md#idle-card-agents)
- **A card's worktree is git's to refuse, never kururu's to force.**
  `server/src/worktree.ts` and `server/src/backup.ts` are the only files that
  run `git`, through `gitcmd.ts` — the first on the user's repositories, the
  second on the one repository kururu owns and nothing else. `worktree add` on
  a click, with a timeout, and on the way back out a rebase, a fast-forward,
  `worktree remove` and `branch -d` with no `--force` and no capital — a dirty
  worktree or a conflicting rebase stays standing and says why. The card's
  "discard" is `git stash`, never a checkout over the work. Anything that
  ends an agent or removes a checkout asks first, in a centred dialog rather
  than at the foot of the card. Project settings
  are keyed by repository root and the root is only ever one the server found
  itself. → [layout](docs/layout.md#worktrees)
- **Backups leave the machine, and secrets never do.** What goes to the
  private repository is an allow-list in `shared/backup.ts` — named config
  files, the boards and the harness conversation as text, the memory folders —
  and anything not named stays: the share token, the OpenRouter key, the
  Telegram bot token, the web providers' keys, `identities/`, every login,
  a node's keys and the roster (`node.json`, `nodes.json`), and the lent
  secrets' records (`grants.json`, `secrets-held.json`, `claude-lend.json`,
  `claude-token.json`, a lent GitHub login's `gh/`). Never `--force`,
  never a rewrite; a push the
  remote refuses stops and says so. → [data](docs/data.md#backups)
- **A secret leaves the Mac only sealed, to a node it was lent to.** One
  switch per child per kind in Settings → Nodes, off by default.
  `shared/secrets.ts` names the kinds and which part of each file travels
  (Telegram's token, never its switch); `NEVER_SHARED` names the files that
  never go (the share token, the nodes' and the roster's keys), and a test
  holds every `0600` write in the server to one list or the other. A push
  is sealed to the child's X25519 key and signed by the parent's node key
  (`server/src/seal.ts`). The child takes it only from its parent, writes it
  as the same file the readers already read, refuses a held kind's setters,
  and lets go of everything when it leaves the roster. A lent Claude token
  is the one credential put in a pty's environment, as
  `CLAUDE_CODE_OAUTH_TOKEN` (`lentClaudeEnv`), never a copied
  `.credentials.json`; a Codex login is read only once it is switched on for
  a node, copied once, and never written over the child's own. A project's
  own secrets go the same road (`shared/vault.ts`, `server/src/vault.ts`):
  an env file into the node's checkout, never over one of its own; an ssh
  entry and its key under `~/.ssh/kururu` with one `Include` line, never
  over a `Host` of its own; a GitHub login as gh's and git's files in
  `~/.config/kururu/gh`, reached by path (`GH_CONFIG_DIR`), never by an
  environment variable holding it. Keys and tokens are read only once lent;
  Kuru's `lend_secrets` previews first and is never handed a value. Hints only to a client, on both nodes, and no value in
  a log. → [nodes](docs/nodes.md#lending-secrets)
- **The usage bar reads a Claude credential and never writes one** — the
  machine's, or the active profile's when profiles keep their own logins. It is
  one of the few things in kururu that reach off the machine on the user's
  behalf, beside OpenRouter's balance, a channel that is switched on and the
  pages agents fetch through a web provider; it is
  read at the moment of the fetch, never held, never logged, never on the wire —
  and no token refresh, because writing that store could log out a running agent
  to draw a bar. `server/src/usage.ts` is the only file that has seen it.
  Codex's allowance beside it reaches nowhere: `server/src/codexusage.ts`
  reads the `rate_limits` Codex writes into its own rollouts, and only stats
  `auth.json` to know it is signed in.
- **The OpenRouter key is one of the credentials kururu stores — a
  channel's bot token and the web providers' keys, below, are the others —
  and it only comes in, or goes out sealed to a node it is lent to.** A
  management key, pasted once in Settings, kept 0600 in
  `~/.config/kururu/openrouter.json`, read per fetch and used for GETs only.
  A client is sent its `hint` and dollars, never the key. →
  `shared/openrouter.ts`
- **The web is lent to agents through a chain, never a key.** Every agent
  kururu starts on this Mac — the + menu, a card's robot, the harness and
  its `start_agent`, a card picked back up — gets four MCP tools served at
  `POST /mcp/web` (`scrape_page`, `crawl_site`, `map_site`, `search_web`)
  through flags on its command line, `--mcp-config=` for Claude (spelt with
  `=` so a card's prompt is not read as a second config) and `-c` overrides
  for Codex, and kururu makes the request. Behind them is an ordered chain
  of providers set in Settings → Web (`server/src/web/chain.ts`): our
  self-hosted Firecrawl on a box on the tailnet first, then the **hand-back** — a
  provider like the others that tells the agent to use its own WebSearch /
  WebFetch — then cloud Firecrawl, reached only when the agent calls again
  with `ownToolsFailed`. A challenge page, a wall or nothing is a failure
  like an error or a timeout, and every answer says who served it. A
  provider is one file in `server/src/web/providers/` that registers itself;
  the build imports the directory and the page draws its fields, so nothing
  else is touched. Each keeps its key on the OpenRouter key's terms — 0600
  (`firecrawl.json`, `web-<id>.json`), read per request, sent only to its own
  address, never logged, never in a pty's environment, a client sent its
  hint, never backed up. The cloud reserves credits against a daily budget,
  a crawl is held to the page limit, and what comes back is wrapped and
  introduced as untrusted data. **The URL or search words of every call go
  to our Firecrawl over the tailnet, and to Firecrawl's servers when the
  chain reaches the cloud.** An agent on a machine does not get the tools;
  the endpoint answers only a program on this Mac. → [web](docs/web.md)
- **A database is whatever `DATABASE_URL` says, read when asked and never
  held.** The scan reads a workspace's `.env*` files under the roots the branch
  walk found, never a path a client sent, and a client is told host, port,
  database and user — never the URL. `server/src/databases.ts` reads the file
  again at the moment it connects. Every query runs in `BEGIN READ ONLY` and
  Postgres refuses the write; the viewer's switch sends `READ WRITE` for one
  run and no regex here decides what a query is. Postgres only, on purpose. →
  [layout](docs/layout.md#the-databases-on-the-row)
- **The harness is a session, not a loop.** One Claude Code session per
  profile, started by kururu with kururu's verbs as MCP tools (`POST /mcp`)
  and a role; nothing in kururu generates text and no API key exists. It
  runs in a folder of its own, never a project's (`harnesshome.ts`), and its
  model, effort and compaction point are flags on its line
  (`harnessRunFlags`), never the profile's settings. Its
  tools take a profile and workspace by id, never `active` — the `*In`
  spellings in `workspaces.ts`. What it says to an agent is **typed into the
  agent's pty as the user's words**, never posted to its inbox: Claude Code
  makes everything on that socket another session's message, which agents
  rightly refuse to take as the user's. `due` holds a message for the turn's
  end, and nothing is typed into a prompt or under the user's hands. The
  inbox carries only kururu's `[kururu]` notices to the harness, signed
  `kururu (no reply)` because SendMessage resolves names by prefix and
  "kururu" is the prefix of every session in this repo. It is told every
  agent's `done`/`blocked` edge in its profile — never a shell's, and
  `blocked` only when Claude is asking. A permission prompt is the user's to
  answer, and the role says so. A message from a channel comes in by the
  drawer's road — the outbox, typed — marked `[telegram]`, and the role says
  what that means. → [harness](docs/harness.md)
- **A node is let in by the roster, never by a token.** Every kururu is a
  node; the parent (the Mac) signs a roster of members' public keys, and two
  nodes link — one WebSocket per pair, `/link`, the lower rank dialling the
  higher — by each signing the other's challenge with a key that roster
  lists. Pairing is one command the Mac shows — `kururu child join
  <address> <code>`, the code single-use for ten minutes — run on the new
  computer, which posts to the Mac's `/api/nodes/join`.
  Those two routes are the only ones ahead of the token gate, and both
  refuse an `Origin`, a proxy's header and anything off the tailnet and
  loopback. What crosses a link is a summary a node pushes about itself,
  never a copy of a board; a node is away after 25 s of silence, because a
  sleeping Mac sends no FIN. The parent pulls each child's backup over its
  link into `nodes/<name>/`. A workspace moves by its board alone, never
  its code, and only with no agent running and no worktree standing. The
  source removes it only once the target has answered, and the move id
  makes a retry the same move. Each node's Kuru acts on its own node's
  agents only and hears only their notices; another node's is asked with
  words typed into it through its own outbox — `[kuru@mac]` from
  `ask_kuru`, `[user@mac]` from a drawer's `@box` — the mark written by
  the receiver, never off the wire. Board verbs with a `node` act directly,
  never a run. A notice crosses into another drawer without the reply it
  quoted. → [nodes](docs/nodes.md#kurus-as-peers)
- **Another node's workspace on this screen is that node's, shown here.** The
  Mac's server watches a child as one more client of it (`/link/watch`, let in
  by the node handshake, parent to child only, open only while something of
  the node is on screen) and relays its session under ids qualified `n:<node>:…`
  (`shared/remote.ts`, `server/src/nodewatch.ts`). The child owns the layout,
  the ptys and the size; a verb from here is forwarded, never applied here. No
  qualified id is ever written — not to `session.json`, the host's blob, the
  database or `made.json` — and a test holds it. Kuru's rule is unchanged: the
  user typing into a remote pane is the user; Kuru still acts locally and asks
  a peer. → [nodes](docs/nodes.md#remote-workspaces)
- **One Telegram bot for every node, read by one node at a time.** The
  parent's allow-list rides in the roster it signs, so only the parent
  sets it; the switch rides there too, but any node may flip it — a
  `TelegramSwitch` signed by that node and handed on, the latest word
  winning, written into the roster when the parent hears it — and only a
  node holding the token may turn it on. The token is lent on its own. `LeadGate`
  (`shared/nodes.ts`) says which node polls — the highest-ranked eligible
  one it can reach; 30 s of silence to take over, a minute of steady link
  and a holder that is not mid-conversation to take back; rank settles a
  409 — and `server/src/lead.ts` hands the offset, queue, held messages,
  reply map and handled ids over before the new holder polls. A node that
  does not hold the poll never calls `getUpdates`, not even once at start:
  that is a 409 for the one that does. Every Kuru's lines go through the
  reader, marked `[Omarchy]` but the parent's; `@node`, `/node` or a reply
  to a node's line reaches that Kuru (`routeOf`). → [nodes](docs/nodes.md#one-telegram)
- **A shell on another machine is a command line, never a host change.** A
  machine is an ssh host the user named (Settings → Machines, `vps.json`); its
  shell is `ssh -t` in an ordinary pty, built and read back by
  `shared/machines.ts`, so the pty host never learns there is a remote. A
  workspace pinned to one opens its terminals there — shells, nvim, agents,
  card runs — each in a named tmux session (`new -A` semantics); everything
  that reads a disk stays local. An agent there is typed in behind a check
  that its CLI is installed and signed in, and its status is **read off its
  screen** (`onscreen.ts`), because its hooks cannot reach kururu yet. Closing
  a tab ends its session; a dropped link, a detach or a host restart do not.
  Host and folder are grammars, not escapes. → [machines](docs/machines.md)
- **The voice is ears and a mouth around that session, not a second brain.**
  Speech becomes a `[voice]` turn typed into the harness's terminal; its last message
  becomes speech, off the same Stop report. No client plays a word while any client
  is talking (`hush`); the replies that waited play after, ahead of the answer,
  each starting "While you were talking", and nothing is dropped — a reply nobody
  played to its end is marked unheard in the Kuru drawer, which the clients'
  `speech-held`/`speech-played` reports decide, and seeing it in the open drawer counts as hearing it. **The
  conversation has one home, the drawer** (`KuruDrawer.tsx`): every prompt and
  reply out of the database's turns, your messages' states off the outbox,
  each reply's fate off the missed list, merged once on the server
  (`shared/kuru.ts`, `server/src/kuru.ts`) into the `kuru` message; its
  composer types to Kuru through the same outbox a clip takes. The chip is the
  only door, and the sidebar has no harness button. Both halves are local — Apple's
  recogniser through `yap`, Kokoro on the CPU with `say` as the fallback — and
  no audio leaves the machine; a channel, below, is the one road off it for
  the conversation, and carries only its text. Kokoro runs in a process of its own
  (`server/src/kokoro.ts`) and is never imported into the server, because its
  runtime turns the exit of whatever loaded it into a SIGABRT. The server hears and speaks for every client;
  a window only posts a WAV and plays one. `web/src/voice.ts` holds the
  microphone and installs the talk key once, through refs, never per render.
  → [voice](docs/voice.md)
- **A link to what an agent made is read off its last reply, never off
  everything it touched.** `shared/made.ts` finds the paths a reply names and
  keeps the deliverable — a document presented as the result or changed in a
  turn that changed no code, code only when presented and one of at most two —
  two at most per agent; `server/src/made.ts` resolves them under roots
  `files.ts` already allows and keeps them in `made.json` (by id *and* spawn
  time), and a card's agent writes them onto `Card.made` so they outlive it.
  A gone file's link goes within seconds. Kuru's `show_file` pins one; the
  drawer makes Kuru's own paths links. Opening is `open-made`: Markdown to the
  reader, code to a new nvim tab at the line. → [layout](docs/layout.md#what-an-agent-made)
- **What needs you is one rule, in `shared/needs.ts`, and three drawings of
  it.** An agent asking, a card in Review, a turn that ended unseen, a card
  whose agent went without finishing; never a working agent, a To do, a
  shell, or the harness. The Needs chip's tray counts it, `NeedsDrawer.tsx`
  lists it by workspace in three bands with Next a press away (`C-a i`,
  `C-a o`), and a workspace's sidebar row wears the dot. No component
  decides it again, and nothing in it is dismissed by hand — a row leaves
  when its state does. The profile board is the profile's own board and
  draws no workspace's; a card asked for by name goes to its board in its
  pane through `showCardNext`. → [layout](docs/layout.md#what-needs-you)
- **A channel is another door into the one conversation, and only the
  user's own accounts may use it.** Telegram, today (`shared/channels.ts`,
  `server/src/telegram.ts`, `server/src/channels.ts`). A message from an
  account on the allow-list — empty until the user pairs one in Settings →
  Channels, by a code this Mac shows — goes into the same outbox as the
  drawer's composer and is typed into Kuru as `[telegram] …`; anyone else,
  any group, any bot is ignored without an answer, and counted, and `judge`
  is that decision in the order that makes it safe. Every reply Kuru makes
  goes back while it is on — its answers to `[kururu]` notices too, never the
  notices, which quote agents' replies — with a silent copy of the user's
  words from here; a turn that answered only Telegram is not
  spoken on the Mac (`replySpoken`). The bot token is kept on the OpenRouter
  key's terms: 0600 in `~/.config/kururu/telegram.json`, read per request,
  put only in the request URL, never logged, a client sent its `hint`, never
  backed up. Long polling and never a webhook: nothing listens, and off is
  no request at all. **This is the one road off the machine for the
  conversation itself** — its text goes through Telegram's servers, which do
  not encrypt bot chats end to end — and the page says so above the switch.
  → [channels](docs/channels.md)
- **`server/run.mjs` is the one supervisor, and the app ships it.** The
  menu-bar frog (`desktop/tray.js`) starts it from the app's Resources with
  `--no-build --entry`, or from a checkout with `--watch`, on the app's
  Electron helper as node, because a titled process on the main binary is a
  Dock tile (`proctitle.ts`); a server already on the port is adopted and
  never stopped.
  A host restart goes *through the server* (`POST /api/host/restart`: SIGTERM
  the socket's holder, exit 75 when the link drops) so either runner comes
  back to a fresh host; the tray's dialog names the agent count and defaults
  to no. Where the server runs from is `~/.config/kururu/desktop.json`.
  → [architecture](docs/architecture.md#the-runner-and-the-menu-bar)
- **An agent's reload is asked for, and the page picks the moment.**
  `bun run reload-window` and the harness's `reload_window` reach
  `POST /api/reload-window`, which sends `reload` to every page that said it
  is on this Mac — the window, the floating pill, a loopback tab, never the
  phone. Each reloads itself only when nobody is talking and Kuru is not
  speaking, its hands have been still five seconds, and no dialog, menu or
  unsent field is open (`reloadHolds` in `shared/reload.ts`), then shows who
  asked and why. It is `location.reload()` — what `C-a R` costs, and the pty
  host never hears of it. → [architecture](docs/architecture.md#reloading-the-window)
- **While the talk key is hooked system-wide, the floating pill is the only
  voice client on this Mac.** `desktop/talkkey/talkkey.swift` is a listen-only
  event tap (Input Monitoring, nothing else) whose events go to the panel's
  webContents and no other; the window's `voice.ts` forwards its gestures
  there (`setVoiceRemote`) so a key both saw fires once. A chord — another
  key during the hold — drops the clip. → [voice](docs/voice.md#the-talk-key-everywhere)

## Code style

Match ghosttown — the user writes in a distinctive register and kururu follows it:

- **Module-level doc comments explain *why the module exists*,** not what it does.
  `server/src/proxy.ts` and `server/src/agents/screen.ts` are the target.
- **Comments explain decisions and rejected alternatives,** in prose and full
  sentences. "Ports come from the kernel because `vite --port` lies when the port
  is taken" — not `// get port`.
- No comment that restates the code on the next line.
- TypeScript strict, `noUncheckedIndexedAccess` on. Tests cover pure functions.

## Where we're going

Shipped: the three-process split, tiled terminals with the server owning the
size, the multiplexer hierarchy and dragging, the markdown reader with
server-side highlighting and draggable document tabs, the file tree (markdown to the
reader, everything else to nvim), foreground notifications, the styles registry, the
skin studio, the plan-usage bar, and a signed self-updating app.

Open, roughly in order — the argument for each is in `PLAN.md`:

1. **The preview as a pane type.** `proxy.ts` works and nothing points at it.
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
