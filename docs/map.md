# The file map

One line each. The *why* lives in the module doc comments and in the other files
in this folder.

## `shared/` — no runtime deps, imported by everything

| file | |
|---|---|
| `model.ts` | Agents and the hierarchy they live in. Not a mirror of anything |
| `wire.ts` | The browser↔server protocol, and the timer intervals |
| `layout.ts` | The split tree and every pure operation on it. Both halves use it |
| `agentpane.ts` | Where the agents kururu starts go: the bottom (or top) pane by geometry, the mark that keeps them in one, the word to split when there is none. Pure, tested. See [layout](layout.md#the-agents-pane) |
| `harness.ts` | The harness's vocabulary: the MCP tool catalogue, the role prompt, key and paste grammar, when a waiting message may be typed, the frames of a notice, transcript turns, its model, effort and compaction point, its folder's two files. Pure, tested |
| `lifecycle.ts` | The line `lifecycle.log` is made of, and reading it back forgivingly. Three processes write it; two of them are plain JS and keep in step by hand |
| `voice.ts` | The voice's vocabulary: settings, the voice catalogue, which language a text is in, which of two transcripts is real, what of a reply to say aloud, the WAV encoder. Pure, tested |
| `reload.ts` | An agent reloading the window: what holds a reload, who asked in words, what the agent is told. Pure, tested |
| `kuru.ts` | The conversation with Kuru as one list: turns, your messages' states and each reply's fate merged, the chip's two counts, the card codes in a reply. Pure, tested |
| `made.ts` | What an agent made: the paths in a reply, which of them are the deliverable (a document presented or changed alone, code presented and few), and the drawer's split of a reply into words and paths. Pure, tested. See [layout](layout.md#what-an-agent-made) |
| `needs.ts` | What needs you across a profile's workspaces — an agent asking, a card in Review, a turn ended unseen, a card whose agent went — and the walk to the next. Pure, tested |
| `channels.ts` | Other doors into that conversation — Telegram. The kinds and their marks, the settings, `judge` (the allow-list decision for one message), pairing codes, splitting a reply, `replySpoken`, the status a window draws; among nodes, the roster's copy of the settings, `routeOf`, the marks and the reply map. Pure, tested. See [channels](channels.md) |
| `board.ts` | A workspace's cards, and what an agent's status does to the one it was handed. Also the profile's board, a card's dates, and the timeline's layout |
| `store.ts` | The database's pure half: the keys a profile and a workspace are known by, a board change as events (`diffBoards`), a typed query as one FTS5 takes, the export's rows. See [data](data.md) |
| `web.ts` | The web for agents, whatever provider answers: the chain's settings, what may be fetched, the calls checked, the one result shape, what counts as a failure (`resultVerdict`), pages wrapped as untrusted, the four tools' descriptions written from the chain's order, the launch flags, what a window is told. Pure, tested. See [web](web.md) |
| `firecrawl.ts` | Firecrawl's API as two providers speak it: the key, the cloud's daily budget, request bodies, its answers read, a self-hosted address, `crawlNext`. Pure, tested |
| `nodes.ts` | Every kururu as a node: the roster and its signature, `adoptRoster`, who dials and who leads, the pairing code, an address, the summary another node draws, `LinkHandshake` as a state machine, `LeadGate` (which node reads the Telegram chat, and when that moves) and the handover's shape, and `watchRefusal` (who may watch whom). Pure, tested. See [nodes](nodes.md) |
| `remote.ts` | Another node's things on this window: the one grammar of a qualified id (`n:<node>:<id>`), the child's workspace, agents and disk roots qualified, `route` (which node a client's verb is for, ids bare, or why it goes nowhere), a node's hue, and `containsQualified`, which the never-written test reads with. Pure, tested. See [nodes](nodes.md#remote-workspaces) |
| `secrets.ts` | The secrets the parent lends a child: the kinds (what part of which file travels, its hint, where it lands), the envelope's header, grant states and `plan`, the one rule for what to push and take back, and `NEVER_SHARED`. Pure, tested. See [nodes](nodes.md#lending-secrets) |
| `vault.ts` | A project's own secrets as text: which env files are offered, an ssh config's `Host` blocks and which of their lines travel, `known_hosts` lines plain and hashed, a key's type and passphrase from its preamble, gh's accounts, the entry, `Include` line and gh files a child writes, and the guesses at what a project needs. Pure, tested. See [nodes](nodes.md#lending-a-projects-secrets) |
| `backup.ts` | What leaves the machine and what never does: the allow-list, the settings, the commit subject. See [data](data.md#backups) |
| `days.ts` | Calendar days as strings, and the arithmetic over them. Why a card's date is not a timestamp |
| `projects.ts` | What a repository has been told about itself, and how a card's worktree is named |
| `machines.ts` | A machine, one sample of it, a workspace's pin to one, and the command line of a shell or an agent on it — built and read back, with the install-and-login check typed ahead of an agent. See [machines](machines.md) |
| `onscreen.ts` | What a remote agent is doing, read off its screen: working, asking, missing, quiet — and the edges a hook would have reported. See [machines](machines.md#status-read-off-the-screen) |
| `sleep.ts` | When a card's agent is idle enough to end: the rule, whether a reply asked you something, how much is typed into a prompt and not sent. See [layout](layout.md#idle-card-agents) |
| `sessions.ts` | The CLIs' conversation files read back: which Codex rollout is a card's, and an agent's last reply out of a transcript or a rollout. Pure |
| `keys.ts` | Every action, ghosttown's defaults, and a user's overrides |
| `labels.ts` | What to call a terminal and what to say it is doing — three places must agree |
| `notify.ts` | When kururu may interrupt you, and the words. Ported policy |
| `launchers.ts` | The agents and models the new-tab menu offers. Hand-kept; `/update-models` refreshes it |
| `lazygit.ts` | LazyGit as a tab: the line here, the line typed on a machine, and the is-it-installed check ahead of both. A clean quit closes the tab |
| `cursor.ts` | DECSCUSR + OSC 12 in both directions. One parser over one stream |
| `theme.ts` | Every theme: the chrome's tokens and the emulator's ANSI palette |
| `skin.ts` | The shape tokens, the icon glyphs, and the twelve paintable parts |
| `styles.ts` | The registry's format, and every check on a stranger's manifest |

## `server/` — Node, not Bun (it was Electron's once and the bundles stayed)

**The pty host** — editing any of these costs every running agent:

| file | |
|---|---|
| `src/ptyhost.ts` | `createPtyHost()`, a factory |
| `src/ptyhostd.ts` | …as a daemon on a socket. Outlives every window and server |
| `src/agents/host.ts` | Spawns and owns every pty; the snapshot comes from here |
| `src/agents/screen.ts` | One headless xterm per pty; history for a pane opened late |
| `src/agents/status.ts` | idle/working/done heuristic. Ported verbatim |
| `src/agents/procs.ts` | Which agent program is running in a pty. Ported |
| `src/agents/report.ts` | Parses what an agent says about itself |
| `src/hostlink.ts` | The protocol between the halves, and the local pair for tests |
| `src/hostsock.ts` | That protocol over a unix socket. The framing, nothing else |
| `src/proctitle.ts` | Naming a process without a Dock tile: on macOS a title registers it as an app of its bundle's kind, so node runs on Electron's `LSUIElement` helper and a main binary goes unnamed |
| `src/hostlaunch.ts` | Starting the host as a launchd job, in a coalition of its own, on a clone of Kururu.app under `runtime/`. Why a Force Quit used to end every agent. On Linux, a transient systemd user unit, in a cgroup of its own |

**The restartable half:**

| file | |
|---|---|
| `src/index.ts` | HTTP, WS, static, one timer. The whole protocol surface |
| `src/workspaces.ts` | Profiles, workspaces, focus. The arrangement lives HERE |
| `src/persist.ts` | The arrangement on disk. Structure only — never respawns. Keys, never boards |
| `src/store.ts` | The database: boards written through before memory takes them, every move as history, deleted cards kept, the conversation, the voice's lists, the search, the export and the restore's import. `node:sqlite`, under `~/.local/share/kururu`, made on the first start |
| `src/export.ts` | The mirror: the database and the allowed config as a tree git can diff, and the tree read back for `restore` |
| `src/backup.ts` | Every few minutes when something changed: mirror, commit, push to the user's private repository. Never forced |
| `src/gitcmd.ts` | Running `git`, for the two files allowed to |
| `src/nodes.ts` | `NodeHost`: joining (the Mac's `/api/nodes/join`, ahead of the gate, and the new computer's half), the roster taken and relayed, a link per pair (`/link`, ahead of the gate, proved by keys), pings and away, summaries pushed on change, the backup pull, and the handshake alone on a watch socket (`watchHandshake`). See [nodes](nodes.md) |
| `src/nodenotice.ts` | Another node's agents wanting a human, raised on this node's clients: `blocked`/`done` edges read off the watch's relayed snapshot while one is up and off the node's summary while none is, never both, through the same gate and throttle as a local agent's. See [notifications](notifications.md#rules) |
| `src/nodewatch.ts` | Another node's workspace on this window: one watch per node (`/link/watch`, this server as a client of the child's), the child's snapshot relayed under qualified ids, the clients' verbs routed there, their watching, looking and size composed into one client's, backlogs and replies matched to who asked, which remote workspace is on screen, and the reads of a node's disk `/api/node/<id>/…` asks over the watch. Memory only. See [nodes](nodes.md#remote-workspaces) |
| `src/nodekeys.ts` | This node's Ed25519 and X25519 pairs and, on the parent, the roster's signing key, in `node.json` at `0600`. Never sent, never backed up |
| `src/seal.ts` | A secret sealed to one node: X25519 with an ephemeral key, HKDF-SHA256, AES-256-GCM with the header as additional data; the parent's signature beside it |
| `src/secrets.ts` | Lending, both halves: the parent's catalogue, grants, pushes on a tick, a link-up and a file change, and the acknowledgements; a child's take, write at `0600`, take-back, and letting go when it leaves the roster; a workspace's offer and `lendProject`. See [nodes](nodes.md#lending-secrets) |
| `src/vault.ts` | The disk of a project's secrets: env files found and read in a checkout and written into one on a child; ssh entries read from `~/.ssh` and written to `~/.ssh/kururu` with the `Include` line; a gh token from `gh auth token` and its files on a child. See [nodes](nodes.md#lending-a-projects-secrets) |
| `src/backup-cli.ts`, `src/restore-cli.ts` | `bun run backup` and `bun run restore` |
| `src/share-cli.ts` | `bun run share`: the phone's link and the Share dialog's QR code, drawn in the terminal, for a server with no window to show them |
| `src/lifecycle.ts` | Why this server started and why the last one stopped, appended to `lifecycle.log`: its own start and stops, crashes through `uncaughtExceptionMonitor`, the host as seen from outside, and whether its supervisor is still alive (`supervised()`). `/api/lifecycle` |
| `src/access.ts` | Bind address, the one token, the Origin check |
| `src/config.ts` | `~/.config/kururu`, and how the settings files are written |
| `src/sizing.ts` | How big a terminal is when several panes have an opinion |
| `src/cwd.ts` | Where a process *is*, not where it was spawned. One `lsof` — or one for many, for the Processes page's nvims |
| `src/memory.ts` | What each terminal costs the machine, off `ps`. Rounded first |
| `src/footprint.ts` | Settings → Processes: each terminal's tree read with argv — agents, nvims, dev servers counted once each — and every nvim on the machine, placed in a tab or under an app. Processes are pid *and* start time. Only when the page asks (`/api/footprint`, types in `shared/footprint.ts`) |
| `src/record.ts` | Rolling raw-stream tape per agent, for bugs you can't reproduce |
| `src/transcript.ts` | How full a Claude Code window is, off its transcript. Ported |
| `src/usage.ts` | The plan allowance, off a Claude credential — the machine's or the profile's. Read, never written |
| `src/codexusage.ts` | The Codex allowance, off the `rate_limits` in the newest rollout of the Codex home in use. No credential, no request |
| `src/machines.ts` | The bottom bar's machines (a VPS, a PC on the tailnet): the user's own `ssh`, `BatchMode`, one fixed read-only script, `tmux ls` before a session that types something, `tmux kill-session` when a session tab is closed, and two fixed reads of an agent's conversation files for `sleep.ts`. A client names a host and nothing else (`shared/machines.ts`, [machines](machines.md)) |
| `src/onscreen.ts` | Reads each remote agent's screen every two seconds and posts the status through `host.report`, as a hook would have ([machines](machines.md#status-read-off-the-screen)) |
| `src/sleep.ts` | Ends a card's agent that has sat idle, once its conversation is made sure of, through the close button's own `endTerminal`; learns Codex runs' ids. `GET /api/sleep` says why each is still awake ([layout](layout.md#idle-card-agents)) |
| `src/made.ts` | A reply's paths found on this disk under allowed roots, and each agent's links kept in `made.json` beside `session.json` — by id *and* spawn time, since a restart must not lose them and a reused id must not inherit them |
| `src/sessions.ts` | The CLIs' files on this disk, bounded reads only: a Codex run's rollout found, any conversation's tail by its id |
| `src/openrouter.ts` | The bottom bar's OpenRouter balance and spend, read with a management key kept owner-only in `~/.config/kururu/openrouter.json`. GETs only; the key comes in once and never goes back out (`shared/openrouter.ts`) |
| `src/web/chain.ts` | The web chain behind `POST /mcp/web`: providers tried in Settings' order, each step skipped, served, failed, passed or stopped, answers judged, the record of recent calls, health on a timer, the launch flags ([web](web.md)) |
| `src/web/provider.ts` | What a web provider is, and the registry each provider file puts itself on |
| `src/web/firecrawlapi.ts` | Firecrawl's v2 API for both Firecrawl providers: one request under one base, failures as the chain reads them, crawls waited for and cancelled |
| `src/web/providers/` | One file per provider, each registering itself: `firecrawl-self.ts` (ours, on the tailnet), `handback.ts` (the agent's own tools), `firecrawl-cloud.ts` (firecrawl.dev: key, budget, account; `KURURU_FIRECRAWL_API` points it at a stand-in). The build imports the directory |
| `src/databases.ts` | The database sheet: `DATABASE_URL` read out of the workspace's env files at the moment of connecting and never held, every query in a `READ ONLY` transaction unless the switch says otherwise, reads bounded through a cursor. Postgres only (`shared/databases.ts`) |
| `src/report-cli.ts` | What a Claude Code hook runs. Not in `agents/` on purpose. Also carries the session's inbox socket, transcript path and last reply for the harness |
| `src/harness.ts` | The harness's hands: kururu's verbs as MCP tools for one profile, a terminal read as text, the user's words typed into a pty when it may take them, the status feed into the harness's inbox. Explicit targets, never `active` (`shared/harness.ts`) |
| `src/harnesshome.ts` | The folder each profile's harness runs in, under the data directory and no project's: made with its AGENTS.md and CLAUDE.md, and the harness's own memories carried over once from wherever it ran before |
| `src/mcp.ts` | Five methods of MCP over JSON-RPC, written out rather than the SDK. Pure; served at `POST /mcp` for the harness and `POST /mcp/web` for every agent |
| `src/voice.ts` | The harness's ears and mouth: a clip through `yap` once per language, the words into the harness; a reply through Kokoro (or `say`) a sentence at a time, Spanish phonemised by `espeak-ng`. `/api/voice/hear`, `/api/speech` (`shared/voice.ts`) |
| `src/kuru.ts` | The conversation assembled for the drawer, from the store's turns, the outbox and the voice's missed list — the `kuru` message, `GET /api/kuru`, the counts on `/api/health` |
| `src/channels.ts` | What each channel hears of Kuru's turns: told what Kuru took in and said, decides whether a reply is spoken here, echoes your words from here, says when a channel's message failed |
| `src/telegram.ts` | The Telegram bot: its token owner-only in `~/.config/kururu/telegram.json`, read per request and never sent back; the long poll (no webhook, nothing listens); the queue out; pairing; shared among nodes, the routing, the held messages, the reply map, the lines handed to the reader and the handover. `KURURU_TELEGRAM_API` points it at a stand-in |
| `src/lead.ts` | One Telegram among the nodes: runs `LeadGate` on the links, the `lead-*` handshake that moves the poll, and the chat's words (`telegram-in`) and every Kuru's lines (`telegram-out`) crossing them. See [nodes](nodes.md#one-telegram) |
| `src/reload.ts` | Agents' reload asks: sent to every page on this Mac, timed, answered with what each page did. Reloads nothing itself |
| `src/kokoro.ts` | Kokoro in a process of its own (`dist/kokoro.mjs`), forked by `voice.ts` and talked to over IPC. Never exits the ordinary way: its ONNX runtime aborts on exit, so it ends by SIGKILL |
| `src/devservers.ts` | lsof + ps discovery of what is listening, and what started it — and stopping one: the named command's tree, never a terminal's (`stopTargets`). Never kururu itself (`isKururu`) |
| `src/proxy.ts` | Per-dev-server reverse proxy (HTTP + WS) for phone access |
| `src/files.ts` | Traversal-safe file listing and reading |
| `src/fileops.ts` | The file tree's edits: new, rename, move, copy, Trash — the only writer |
| `src/markdown.ts` | Markdown → markup with Shiki. `html: false` IS the sanitizer |
| `src/nvim.ts` | The editor in a pane, found by its socket. An autocmd, not a poll; `:drop` for the tree; `:qa` with a deadline for Processes' close buttons, and `endHard` (SIGTERM then SIGKILL, by pid, never a group) for the second yes. `nvimCommand` builds an nvim tab and `isNvimTab` knows one again |
| `src/mouseencoding.ts` | How a terminal writes its mouse reports |
| `src/reach.ts` | Which addresses this machine answers to, for the phone's QR |
| `src/version.ts` | What version this is, stamped in by the bundler |
| `src/update.ts` | Whether there is a newer kururu. A check, never an install |
| `src/styles.ts` | Fetching, installing and serving the registry; `measureImage` |
| `src/studio.ts` | The skins you make — an ordinary installed skin with `local: true` |
| `src/mascot.ts` | Which sheets, parts and clips; the one endpoint that writes for a client |
| `src/sounds.ts` | The croak, and the machine's alert sounds — transcoded |
| `src/appearance.ts` | Theme id and terminal font. Persistence only |
| `src/keys.ts` | The keymap a user has amended. Persistence only |
| `src/notify.ts` | When to interrupt somebody, as they left it. Persistence only |
| `src/launch.ts` | Which agents the new-tab menu leaves out. Persistence only |
| `src/projects.ts` | Per-repository settings, by root. Persistence only |
| `src/worktree.ts` | A card's checkout: `git worktree add` on a click, and rebase, fast-forward, `worktree remove`, `branch -d` when it is retired — never forced. The one place kururu runs `git` on the user's repositories |
| `src/logins.ts` | Where a profile's logins live, and the two env vars. Makes, never deletes |
| `run.mjs` | Builds, spawns and re-spawns the server, one at a time, and writes down why. What `C-a B` reaches. Shipped in the app and run with `--no-build --entry`; `SIGUSR2` is "cycle now" |
| `status.mjs` | The daemon has no face; this is it. Socket + `/api/agents`, then the end of `lifecycle.log` |
| `reload-window.mjs` | An agent's ⌘R: asks the server, waits, prints what happened, and asks again across a server restart |
| `kill-hosts.mjs` | Finds hosts by socket, asks, SIGTERMs |
| `sockowner.mjs` | Who holds a unix socket: `lsof` on macOS, `ss` on Linux. The tools import it plain and the server through `sockowner.d.mts` |
| `localtoken.mjs` | The token kururu's own callers present, for a server that wants it on loopback too: `KURURU_TOKEN`, then `access.json` |

## `web/` — React 19 + Vite. One build; the desktop is what it is shaped for

| file | |
|---|---|
| `src/session.ts` | Module-level store + `useSyncExternalStore`; the WS client |
| `src/terminals.ts` | Every emulator, pooled by agent id and moved between panes |
| `src/App.tsx` | Draws the server's layout; owns the prefix, zen and dialogs |
| `src/main.tsx` | The root, wrapped in `Crash` |
| `src/keys.ts` | The prefix, and a `KeyboardEvent` as a lookup string |
| `src/theme.ts` / `skin.ts` | Tokens onto `<html>`; the other half to the emulators. No React |
| `src/colors.ts` | A board column's colour as `var(--ws-<name>)` |
| `src/fonts.ts` | Which fonts *this device* can draw, two ways |
| `src/icons.ts` | Kururu's own vectors (Lucide, vendored) — see `icons.LICENSE` |
| `src/grid.ts` | Whether a pane was really measured |
| `src/mouse.ts` | The mouse as the program in the pty sees it |
| `src/boxdraw.ts` | Box-drawing glyphs painted to the cell |
| `src/cursortext.ts` | The character under a block cursor, drawn again on top |
| `src/frames.ts` | When an emulator paints: in a pane, and only when something changed |
| `src/keybar.ts` | The keys a soft keyboard has not got, as events |
| `src/drag.ts` | What is in flight, because `dataTransfer` can't be read on `dragover` |
| `src/drop.ts` | A file dropped on a terminal → the path to type. Pure |
| `src/notify.ts` | Making the noise and drawing the card. No policy |
| `src/voice.ts` | The talk key (hold or tap), the microphone as PCM off a worklet, and the player for what the harness says. Module state, like `session.ts` |
| `src/reload.ts` | When this page may reload for an agent — the voice, the hands, what is open over it — and the notice carried across the reload |
| `src/kuru.ts` | Whether the Kuru drawer is open and at which reply, for every door that opens it; what Kuru is doing in one word, for the chip and the drawer |
| `src/needs.ts` | Whether the drawer of things that need you is open, for the tray and the key; one drawer at a time with Kuru's |
| `src/mascot.ts` | Loads a sheet once per URL and reports its size |
| `src/mermaid.ts` | The one thing the reader draws itself — a diagram needs a DOM |
| `src/labels.ts` | How the window draws the answers `shared/labels.ts` decides |
| `src/docs.ts` | The document list, reduced to the three decisions it makes |
| `src/disk.ts` | Which disk a read goes to: `/api/…` for this node's roots, `/api/node/<id>/…` for a qualified one |
| `src/preview.ts` | Where to send a browser for a dev server. Pure |
| `src/qr.ts` | A QR code, encoded here. Pure |
| `src/access.ts` | The token in the address, exchanged once for a cookie. Five lines |
| `src/zoom.ts` | How big the reader's type is, per device |
| `src/place.ts` | Where the voice pill was dragged to, as a share of the window rather than pixels. Pure |
| `src/when.ts` | What a card's dates are called here: month names, and which day a week starts on |
| `src/desktop.ts` | The preload bridge, typed. Null in a browser — that's the contract |
| `src/styles.css` | No hex, no px. See [styles](styles.md) |

**Components:**

`Panes.tsx` (flat positioned boxes, tab strips, dividers) · `Terminal.tsx` (a box
for a pooled emulator; owns none) · `Sidebar.tsx` · `StatusBar.tsx` (the window-wide bottom bar, and `WorkspaceToggle`) · `Usage.tsx` (the Claude and Codex allowances on that bar, and their bars on hover or tap) · `BarChip.tsx` (a bar chip's hover-and-pin popover, which the allowances and the machines share) · `Machines.tsx` (the machines on that bar: a glyph in the worst load's colour, the connected count, each machine's rings and Shell in the popover) · `DrawerChips.tsx` ·
`Status.tsx` (a dot, or the mascot) · `Icon.tsx` (a class name and an
`aria-hidden` span) · `Dialog.tsx` (while one is up, no key reaches a pty) ·
`Menu.tsx` · `Reader.tsx` (**the thing kururu was built for**; one draggable tab per document) ·
`Board.tsx` (a workspace's cards; the robot hands one to an agent) ·
`Search.tsx` (the search over every board and the conversations, and the deleted cards, in the profile board's sheet; a card hit is a door to the card) ·
`ProfileBoard.tsx` (the profile's own cards, in a sheet over the window; its own and no other's) ·
`ColorPicker.tsx` (a column's colour, from the profile board) ·
`NeedsDrawer.tsx` (what needs you across the workspaces, in three bands, with the next one a press away; opened by the tray in `DrawerChips.tsx`) ·
`NodeChip.tsx` (another node's name in its own hue, on every remote thing) · `RemoteBand.tsx` (the band over another node's workspace: whose, away since when, what could not be sent) ·
`Timeline.tsx` (that board by when its cards are for; holds only which weeks it is showing) ·
`FileTree.tsx` (markdown to the reader, the rest to nvim; holds the reader's zoom) · `DocPicker.tsx` (an empty reader only) ·
`MadeLinks.tsx` (the file or two an agent's turn ended in, under its sidebar row, on its card and on its Needs you row, and a path in Kuru's replies; a document to the reader, code to a new nvim tab) ·
`Keybar.tsx` · `Reach.tsx` · `Crash.tsx` · `HelpOverlay.tsx` (printed from the
keymap, so it cannot document a dead key) · `VoicePill.tsx` (the microphone is
open, and this is how loud the room is; dragged anywhere, ✕ or Esc to stop Kuru, a tap opens the drawer) ·
`ReloadNotice.tsx` (who reloaded the window and why, for ten seconds after an agent did) ·
`KuruDrawer.tsx` (the conversation with Kuru: every message's state, every reply's fate, a composer, the Telegram switch; opened by Kuru's chip in `DrawerChips.tsx`) · Settings is `web/src/settings/`, not a component: `ui.tsx` is the language every page is written in (a group is a card of rows; a row is a label and one control of a dozen kinds; the in-place danger question; lists, galleries, steps, details), `Settings.tsx` the shell and the list of pages, and one file per page (`Channels.tsx` is the Telegram walkthrough, `Firecrawl.tsx` the Firecrawl one), and `Secrets.tsx` the lent secrets as four pages draw them: a child's grants under Nodes (kururu's keys, then a project's env files, ssh hosts and GitHub logins, and *Lend a workspace's env files*), what a child holds, the *Held from* line a key's page draws in place of its field, and Agents' *Lend this login to a node*.

## `desktop/` — Electron main + preload, and the esbuild step

| file | |
|---|---|
| `main.js` | Finds a server, draws it, keeps the tray with no window open. And the things a served page can't do: replace the app, hear a key unfocused |
| `runner.js` | Starts `server/run.mjs` from the app or from a checkout, probes health, reads `lifecycle.log`, adopts a server already on the port, asks the server to restart itself or the host |
| `vite.js` | The checkout's vite, which the window and the pill load when the app runs from a checkout (and always in `dev:desktop`); adopts a kururu vite already on the port, refuses anything else there |
| `tray.js` · `menu.js` | The frog in the menu bar and its clicks; the menu as data, with no Electron in it, so its sentences are tested |
| `editmenu.js` | The right-click menu of a text field — Cut, Copy, Paste, spelling — as data; `main.js` pops it, the preload keeps it off terminals |
| `talkkey.js` · `talkkey/talkkey.swift` | The talk key in every app: the native listen-only event tap, its router, and the floating pill's panel window |
| `desktop.js` | `desktop.json`: where the server runs from, whether the hook is on, where the pill was left |
| `connect.html` | The one page kururu draws itself — the address picker |
| `servers.js` | Addresses you have connected to, and what a typed one means |
| `preload.js` | Two bridges in one file, split on `file:`; `voice` is the hook's half |
| `build.mjs` | `server/src` → `dist/{server,ptyhostd,report,kokoro}.mjs`; stamps the version. `talkkey/build.mjs` compiles the hook beside them |
| `brand.mjs` | postinstall: stamps and re-signs the Electron copy in `node_modules` |
| `electron-builder.yml` · `entitlements.mac.plist` · `notarize.mjs` | see [packaging](packaging.md) |
| `icon/` | Generated by `tools/icon.mjs`; committed |

## Elsewhere

- `tools/icon.mjs` — the frog as every icon, from one named cell of the sheet.
  Deliberately **not** the user's mascot: an identity that followed a setting is
  not an identity. Run by hand; outputs are committed.
- `tools/schema.mjs` — publishes the token and part vocabulary to
  `../kururu-styles`. Bun, because it imports TypeScript.
- `tools/release-notes.mjs` — one version's section out of `CHANGELOG.md`.
- `tools/kururu.mjs` — the `kururu` command on a child: `child setup`,
  `doctor`, `update`, `status`, `restart-host`, `share`. Plain node, since it
  runs before `bun install`. `tools/kururu/checks.mjs` is the one list of
  checks the wizard repairs from and the doctor reads; `tools/kururu/pure.mjs`
  is their text-in, text-out half, tested in `tools/test/`. See
  [linux](linux.md).
- `.claude/skills/kururu-child/` — how an agent on a new box walks the user
  through the wizard.
- `assets/` — served at runtime, found the way `web/dist` is (`KURURU_ASSETS`).
  `sounds/` holds the croak (`KURURU_SOUNDS` overrides); `spritesheets/` holds the
  frog and `guide.png`.
- `web/public/` — copied verbatim into `web/dist`. Icons and the manifest; **no
  fonts** — a skin's face arrives with the skin and is written as an `@font-face`
  at runtime.
- `.github/workflows/release.yml` — what a tag sets off.
- `.claude/skills/release/` — how `CHANGELOG.md` is drafted and a version cut.
