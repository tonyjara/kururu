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
| `web/`, `desktop/` | a repaint — ⌘R, or `C-a R` (a `desktop/` change wants the window relaunched, which is free) |
| `server/src/` *except* the row below | a reconnect — `C-a B`, or automatic under `bun run dev` |
| `server/run.mjs` | nothing, until a runner is next started — the one running keeps the copy it loaded |
| `server/src/agents/`, `ptyhostd.ts`, `ptyhost.ts`, `hostlink.ts`, `hostsock.ts` | **every agent the user is running** |

So batch changes to the host, and say so before asking for one to be restarted. A
live pty cannot be handed to a replacement process, and that irreducible fact is
the only thing in kururu that ends an agent by accident. **A host that is behind
says so:** `hello` carries its version and `HOST_PROTOCOL`, and `/api/health`,
`bun run status` and Settings → About report a server ahead of its host. Bump
the protocol when a host change must be restarted into, and gate the feature on
`HostInfo.current` rather than letting an old host drop the field in silence.

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
`lifecycle.log` is there too: every server start, stop, restart and crash, and
why. It is the answer to "why did the window just reconnect", and
`bun run status` prints its end.

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
  before the token. → [architecture](docs/architecture.md#access)
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
- **A card's worktree is git's to refuse, never kururu's to force.**
  `server/src/worktree.ts` is the only file that runs `git`: `worktree add` on
  a click, with a timeout, and on the way back out a rebase, a fast-forward,
  `worktree remove` and `branch -d` with no `--force` and no capital — a dirty
  worktree or a conflicting rebase stays standing and says why. The card's
  "discard" is `git stash`, never a checkout over the work. Anything that
  ends an agent or removes a checkout asks in place first. Project settings
  are keyed by repository root and the root is only ever one the server found
  itself. → [layout](docs/layout.md#worktrees)
- **The usage bar reads a Claude credential and never writes one** — the
  machine's, or the active profile's when profiles keep their own logins. It is
  the only thing in kururu that leaves the machine on the user's behalf:
  read at the moment of the fetch, never held, never logged, never on the wire —
  and no token refresh, because writing that store could log out a running agent
  to draw a bar. `server/src/usage.ts` is the only file that has seen it.
- **The OpenRouter key is the one credential kururu stores, and it only comes
  in.** A management key, pasted once in Settings, kept 0600 in
  `~/.config/kururu/openrouter.json`, read per fetch and used for GETs only.
  A client is sent its `hint` and dollars, never the key. →
  `shared/openrouter.ts`
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
  and a role; nothing in kururu generates text and no API key exists. Its
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
  answer, and the role says so. → [harness](docs/harness.md)
- **A shell on another machine is a command line, never a host change.** A
  machine is an ssh host the user named (Settings → Machines, `vps.json`); its
  shell is `ssh -t` in an ordinary pty, built and read back by
  `shared/machines.ts`, so the pty host never learns there is a remote. A
  workspace pinned to one opens its *shells* there, each in a named tmux
  session (`new -A` semantics); agents and everything that reads a disk stay
  local. Closing a tab
  ends its session; a dropped link, a detach or a host restart do not. Host and
  folder are grammars, not escapes. → [machines](docs/machines.md)
- **The voice is ears and a mouth around that session, not a second brain.**
  Speech becomes a `[voice]` turn typed into the harness's terminal; its last message
  becomes speech, off the same Stop report. No client plays a word while any client
  is talking (`hush`); the replies that waited play after, ahead of the answer,
  each starting "While you were talking", and nothing is dropped — a reply nobody
  played to its end is on the missed list behind the harness button, which the
  clients' `speech-held`/`speech-played` reports decide. Both halves are local — Apple's
  recogniser through `yap`, Kokoro on the CPU with `say` as the fallback — and
  nothing leaves the machine. Kokoro runs in a process of its own
  (`server/src/kokoro.ts`) and is never imported into the server, because its
  runtime turns the exit of whatever loaded it into a SIGABRT. The server hears and speaks for every client;
  a window only posts a WAV and plays one. `web/src/voice.ts` holds the
  microphone and installs the talk key once, through refs, never per render.
  → [voice](docs/voice.md)
- **`server/run.mjs` is the one supervisor, and the app ships it.** The
  menu-bar frog (`desktop/tray.js`) starts it from the app's Resources with
  `--no-build --entry`, or from a checkout with `--watch`, on the app's own
  binary as node; a server already on the port is adopted and never stopped.
  A host restart goes *through the server* (`POST /api/host/restart`: SIGTERM
  the socket's holder, exit 75 when the link drops) so either runner comes
  back to a fresh host; the tray's dialog names the agent count and defaults
  to no. Where the server runs from is `~/.config/kururu/desktop.json`.
  → [architecture](docs/architecture.md#the-runner-and-the-menu-bar)
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
