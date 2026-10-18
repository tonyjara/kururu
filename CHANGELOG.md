# Changelog

What changed in kururu, for the people using it rather than the people writing
it. Entries are what you would *notice* — a new pane type, a key that moved, a
bug that used to eat your scrollback. Refactors that nobody can see do not
belong in here.

Kept in [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) shape and
versioned by [semver](https://semver.org/spec/v2.0.0.html). The section for a
version is also the body of its GitHub release and what the *What's new* dialog
shows, so it is written once and read in three places — see
`.claude/skills/release/SKILL.md`.

## [Unreleased]

### Added

- **Stop Kuru from its drawer.** While Kuru works on a turn, a "Thinking…" line sits
  just above the chat box, in view however far up you have scrolled, with a
  **Stop** button that interrupts the turn as Esc in its terminal would. The line
  goes once the turn has really ended, and anything you were typing stays in the
  box. Works on the phone too.

## [0.4.0] - 2026-10-17

Picking this up needs the pty host restarted, which ends the agents running in
it. Nothing breaks while you put it off — the host speaks the same protocol as
before — but the restart is what buys the release's most important fix: a host
started by this version is a launchd job of its own, so a force quit in the Dock
can no longer take every agent down with it. That only applies to the next host
that starts; the one running now keeps the old arrangement until it is
restarted, and `bun run status` says `coalition  shared` while it does. The
first host started from an installed app may make macOS ask once for access to
your files, and kururu waits for the answer. The wire between window and server
changed too — Kuru's conversation, what needs you, the channels, the web, the
boards — so a window and a server want to be on the same version.

### Added

- **Kuru has a drawer, and the whole conversation is in it.** The **Kuru** chip
  at the right of the status bar, or `C-a a`, opens a drawer beside the panes
  with every message you gave Kuru and every reply it made, spoken or typed, in
  one timeline. Each of your messages shows whether it arrived, with
  **Resend** or **Discard** on one that did not; each reply that nobody heard
  to the end is marked where it sits, with a **Play** of its own, and stops
  counting as unheard once it has been on screen in the open drawer for a
  moment. A line at the foot says what Kuru is doing now, and the chip says the
  same at a glance — thinking, speaking, asking, or off. Kururu's own notices
  to Kuru are drawn as one quiet line rather than as words of yours, a card
  code in a reply opens that card, and a file Kuru names opens with a click.
  The drawer has a composer, so you can type to Kuru from anywhere, the phone
  included, and the microphone button lives there now. **Terminal** in its
  header is the old harness button: it starts, resumes or shows the session.
  Clicking the pill opens the drawer at the reply it is showing, and the menu
  bar offers **Play** and **Open the conversation** when there are replies
  you missed or messages that did not get through.

- **Talk to Kuru from Telegram.** Settings → **Channels** walks you through
  making a bot, pasting its token, pairing your own account by sending the bot
  a code this Mac shows, and switching it on. A message to the bot then reaches
  Kuru exactly as if you had typed it in the drawer, every reply comes back to
  the chat, and what you say or type at the Mac is copied there silently, so
  the chat reads like the drawer. A reply to something sent only from Telegram
  is not read aloud on the Mac, since you are not there to hear it. Only the
  accounts you pair can reach Kuru; see Security for what else that means.

- **What needs you, in one list.** The **Needs you** chip on the status bar
  counts everything waiting on you across the profile's workspaces — an agent
  asking something, a card in Review, a turn that finished while nobody was
  watching, a card whose agent went away without finishing — and opens a
  drawer that lists them by workspace, with what is still working below and
  the quiet rest folded away. A row takes you to the terminal or the card.
  `C-a i` opens it and `C-a o` goes to the next need from wherever you are, so
  a prompt can be left for later. A workspace's row in the sidebar wears a dot
  while something in it is waiting. Nothing in it is dismissed by hand; a row
  leaves when the thing it describes has moved.

- **A card's agent that sits idle is put to sleep, and the card wakes it.**
  Agents are what drain a laptop's battery, and a card waiting in Review is an
  agent nobody is using. After ten minutes of idleness — on by default, set in
  Settings → Agents → **Idle card agents** — a card's agent is ended and its
  card says "asleep after sitting idle" with a **resume** button; running the
  card again picks up the same conversation, for Codex as well as Claude. Only
  agents started from a card are ever touched, never one from the + menu, a
  shell or the harness, and any doubt keeps one awake: a question or prompt on
  its screen, words typed into its prompt and not sent, a command still
  running under it, a last reply that asks you something, or a conversation
  kururu cannot find on disk to resume.

- **A link to what an agent made.** When an agent's last reply presents a file
  as the result — a plan, a research note, the script you asked for — a link
  to it appears under the agent's row, on its card and in the Needs you
  drawer. Markdown opens in the reader; anything else opens in nvim at the
  line the agent named. Two links at most, most rows have none, and a link
  goes once its file does. A card keeps its links after its agent has gone.

- **The agents kururu starts go to one pane.** A card's robot, a card picked
  back up and an agent Kuru starts all open in the workspace's bottom pane,
  which kururu makes by splitting the layout when there is none, so the top
  half stays what you are reading. Settings → Agents chooses the bottom, the
  top, or the old placement beside the board, and Settings → Workspaces can
  say otherwise for one workspace. The keyboard stays where it was, and an
  agent you open from a pane's + menu still opens where you asked.

- **Web search and page reading for every agent kururu starts.** Agents meet
  pages a plain fetch cannot read — a list drawn by JavaScript, a site that
  walls off anything that is not a browser, a PDF. Settings → **Web** sets up
  an ordered chain of providers, and every agent kururu starts gets four tools
  (`scrape_page`, `crawl_site`, `map_site`, `search_web`) that go down it: a
  Firecrawl you host yourself first, then a hand-back telling the agent to use
  its own web search and fetch, and only when the agent says those failed too,
  cloud Firecrawl on your credits. A challenge page or a wall counts as a
  failure, every answer says which provider served it, and the page shows the
  recent calls. The cloud is held to a page limit per call and a daily credit
  budget. The tools appear once a provider other than the hand-back is set up,
  in agents started after that.

- **Search every card and every conversation, and get a deleted card back.**
  **Search** on the profile's board looks through every card in the profile
  and everything you and Kuru have said, accents folded, so "migr ord" finds
  "Migración de órdenes". A card hit takes you to the card on its board and
  lights it. **Deleted cards** lists every card deleted by hand, and
  **Restore** puts one back in the column it left. Kuru can search too, and
  read a card's history of moves and runs.

- **Backups to a private repository of yours.** Settings → **Backups** takes
  the address of an empty private git repository and, every few minutes when
  something changed, commits and pushes the boards, Kuru's conversations, your
  settings and styles, and the memory folders of the profiles kururu made.
  `bun run backup` makes one now; `bun run restore <repository>` puts a new Mac
  back from it. What goes and what never does are listed on the page.

- **Agents on your other machines.** In a workspace that runs on a machine,
  everything it opens for itself now opens there: agents from the + menu,
  nvim, LazyGit, a card's robot and its resume, and the agents Kuru starts.
  Before typing an agent's command kururu checks that the CLI is installed
  and signed in there, and says what to run if it is not. Its status is read
  off its screen, so the dot, notifications, the card and Kuru all follow it,
  a poll or two late; the tab says so. A card that needs a worktree still runs
  on this Mac, where the worktree is.

- **LazyGit, a click away.** The + menu offers LazyGit, above nvim, and a
  workspace row's ⋯ menu opens it in the workspace's main checkout.

- **Escape stops Kuru mid-reply.** While Kuru is speaking, Escape is the
  pill's ✕: the reply stops, and what was left of it is marked unheard in the
  drawer. Any other Escape goes where it always went.

- **The card the keyboard is on is lit on the board.** With the board in one
  pane and an agent in the next, the card whose agent is in the focused pane
  wears the accent.

- **Board columns can be resized.** Drag a column's edge; double-click it to
  go back to the default width.

- **Text fields have a right-click menu.** Undo, Cut, Copy, Paste and Select
  All in any field in the window, Learn Spelling on a misspelled word, and
  Copy on selected text that is not editable. Terminals and kururu's own menus
  are unchanged.

- **An agent can reload the window instead of asking you to.** After a change
  to the web app, an agent runs `bun run reload-window --why "…"` (Kuru has the
  same as a tool), and the window and the floating pill reload themselves as
  soon as you are not talking, typing or in a dialog, then say who asked and
  why. A phone is never reloaded.

- **Trial voices for Kuru.** When running from a checkout with the trial
  engines downloaded, Settings → Voice offers four more text-to-speech engines
  under "trial" headings, to hear as Kuru for a while beside Kokoro. Nothing
  installs them for you, and the app does not carry them.

### Changed

- **Boards are kept in a database.** Cards used to ride in the layout file,
  whose rules could lose them; they are now in `~/.local/share/kururu/kururu.db`,
  every change written as it happens, a deleted card marked rather than gone,
  and a history of what moved and who moved it — you, Kuru, or the automation.
  Cards in an older layout file are taken in on the first start, and nothing
  in a file can ever move or delete a card the database has. Settings → About
  shows the file and its size.

- **Settings is one list of pages.** The tabs are gone: the pages are listed
  down the left in five groups — Appearance, General, Kuru, Connections and
  System — and on a phone the list is the first screen and a page opens over
  it. Styles is now **Explore**, and Machines is under Connections.

- **The status bar is cut to what you reach for.** On the left, the sidebar's
  toggle, the workspace's name and the mode badges; on the right, the Needs
  you and Kuru chips and the file tree's toggle. The profile's name, the
  `C-a ?` hint and the microphone went; the settings cog and the phone's QR
  code are in the sidebar's header, beside the profile's name.

- **A workspace row is its name.** The number and the branch line went — the
  keys still go by position, and the row's tooltip says which is its. After
  the name, `±3` counts files not committed and `↑2` `↓1` commits to push and
  pull, only when there are any. The git and database buttons are a **⋯** menu
  that appears on hover (always, on a touch screen), with the board, LazyGit,
  the databases and the git verbs. An agent row lost its corner buttons:
  **Hide**, **Go to card** and **Kill** are on its right-click menu, or a long
  press on a phone.

- **`C-a a` opens Kuru.** The agent finder moved to `C-a f`, and `C-a H` is no
  longer bound.

- **The harness runs in a folder of its own, on a model of its own.** It used
  to start in whichever project was active and load that project's
  instructions on every wake. Now it lives under kururu's data directory, and
  always runs on Claude Opus 5.5 at high effort, compacting near 200k tokens,
  whatever the profile's own `/model` says. Its memories are copied over on
  the first start there, but that start is a new conversation: the old one is
  filed under the old directory and cannot be resumed from the new one. The
  boards and the drawer keep everything that was said.

- **The question before Done is a dialog.** Moving a card with a worktree or a
  running agent into Done asks in a dialog centred over the window rather than
  at the foot of the card, focused on Yes.

- **Codex conversations resume by id.** Kururu now finds the rollout a card's
  Codex run wrote and resumes that conversation directly, rather than opening
  Codex's picker.

- **A machine that stays down stops being retried.** A shell on a machine
  whose connection drops still reconnects on its own, but after three
  failures in a row it says the machine has not answered and waits for you.
  In a pinned workspace the + menu is the machine's menu, with a heading
  saying where everything in it opens.

- **Tab strips scroll with a mouse wheel**, and keep the tab you are on in view.

- **Kururu's processes say what they are in Activity Monitor** — the server
  as `Kururu server :7717`, the runner and the voice by name too — and none of
  them takes a Dock tile of its own.

### Fixed

- **A Dock force quit could end every agent.** The pty host was spawned
  detached but stayed in the macOS coalition of the app that started the
  chain, and quitting a leftover Dock tile — which is a force quit — ended the
  whole coalition, host and agents included. The host is now a launchd job
  with a coalition of its own; see the note at the top.

- **The window used a core while it sat idle.** Every terminal redrew itself
  on every frame, on screen or not; an idle window now draws nothing, and a
  terminal draws only when something on it changed. With several agents
  running, the window's share of the CPU falls from around half a core to a
  tenth of one.

- **A long message reached its agent starting mid-word.** A line of more than
  about a thousand characters, typed into Kuru or by Kuru into an agent, was
  split by the terminal into a paste and some typing that landed in the wrong
  order. Long lines are now typed in small pieces and arrive whole.

- **The floating pill could disappear after a monitor change.** Its place is
  now kept as a share of the display it was on, it is put back on a display
  that exists whenever displays change, and the menu bar's **Reset Pill
  Position** shows it where it lands for five seconds. **Logs** has a
  floating pill log for whatever is still wrong.

- **A hot reload could leave the microphone open.** Running from a checkout,
  a save that hot-reloaded the voice while it was recording left the old copy
  recording, unseen, and sending clips to Kuru. A reload now sends what was
  recorded and closes the microphone.

### Removed

- **Workspace colours.** No rail, no picker, no colour on a new workspace;
  the mascot already tells two workspaces apart. Board columns keep their
  colours.
- **The bar of every board on the profile's board.** The profile's board is
  its own board again; which workspaces are waiting on you is the Needs you
  drawer's job, and Search finds a card on any board.
- **The harness button and its two badges in the sidebar.** The Kuru chip
  and its drawer replace them.
- **The agent count beside the menu-bar frog.**

### Security

- **Telegram is the one road off the machine for the conversation.** With
  the channel on, what you and Kuru say goes through Telegram's servers, which
  do not encrypt bot chats end to end, and the page says so above the switch.
  Only accounts you pair can reach Kuru; a stranger who finds the bot, a group
  or another bot gets no answer and reaches nothing, and the page tells you
  they tried. Kururu's own notices are never forwarded, since they quote
  agents' replies. Nothing listens on a port: kururu asks Telegram for new
  messages, and nothing at all while the channel is off. The bot token is kept
  readable only by you in `~/.config/kururu/telegram.json`, shown back only as
  its last four characters, and never backed up.

- **The web tools answer only programs on this Mac.** They are served at
  `POST /mcp/web`, which refuses anything not on loopback, anything with an
  `Origin`, and anything a proxy forwarded, whether or not sharing is on. The
  URL or search words of every call go to the Firecrawl you host, and to
  Firecrawl's servers when the chain reaches the cloud. Provider keys never
  enter an agent's environment, are sent only to their own provider, are kept
  readable only by you, and are never backed up. Agents on another machine do
  not get the tools.

- **Backups leave the machine, and secrets never do.** What is pushed is an
  allow-list of named files; the share token, the OpenRouter key, the Telegram
  token, the web providers' keys, every login and agents' replies all stay
  behind, and a restore ends by listing them for you to put back. A push is
  never forced: one the
  repository refuses stops and says why.

- **The reload an agent asks for goes through the same gate as everything
  else** — loopback, the `Origin` check and the token — and reaches only pages
  on this Mac.

## [0.3.0] - 2026-10-10

Picking this up needs the pty host restarted, which ends the agents running in
it: a terminal now opens with its profile's login environment, and the host
says which build it is, so an old one shows as behind rather than failing
quietly. The wire between window and server changed too — the boards, the
harness, the voice, the machines — so a window and a server want to be on the
same version.

### Added

- **A harness: one Claude that drives the others.** The bot button beside the
  profile's name, or `C-a H`, opens one Claude Code session per profile that
  oversees every agent in it. Talk to it about all of them at once — "start an
  agent on the migration card", "what did the API worker say", "is anybody
  stuck" — and it uses kururu's own verbs, handed to it as MCP tools, to start
  agents in panes, read their replies and screens, message them, press keys
  when you say so, and keep the boards. Whenever an agent in the profile
  finishes a turn or blocks, it is told and tells you. What it sends an agent
  is typed into that agent's terminal as your own words, slash commands
  included, and waits for the agent's turn to end, for a prompt to be
  answered, or for you to stop typing there. A permission prompt stays yours:
  it reads it to you and presses keys only as you say. It is a session, not a
  service — billed to your subscription like any other, visible in a pane,
  resumable; closing its tab loses nothing and the same button resumes the
  conversation. **Auto Swap**, in Settings → Agents, brings whichever agent it
  is dealing with onto the screen while it works, and `C-a z` takes you back.

- **A voice for it, on your Mac and nowhere else.** Hold the right Control key
  and speak; let go and the words go to the harness. Tap it to keep the
  microphone open until the next tap; Escape drops the clip. What the harness
  says at the end of each turn is read aloud, whether you spoke or typed. A
  pill over the panes shows the level while it listens, what it heard and what
  is being said, and the microphone in the status bar is the same key for a
  thumb. Hearing is Apple's on-device recogniser, through `yap`; speaking is
  Kokoro on the CPU, with the Mac's own voices until it is downloaded. English
  and Spanish, mixed in one sentence if you like, each with a voice of its own.
  Nothing plays while anybody is talking, on any client; the replies that
  waited play afterwards, each starting "While you were talking", ahead of the
  answer. Settings → Voice picks the key, the languages and the voices, and
  says what to install.

- **Nothing you say is lost, and nothing it says goes unheard.** A clip is kept
  in the browser until the server has it on its disk, sent again after a
  reconnect or a reload, and a long recording is rolled into a new clip every
  five minutes, so there is no length past which it fails. On the server a
  message stays on a list until the harness's own session confirms it took the
  words; one that did not get through is typed once more and then marked
  failed, with **Resend** and **Discard** on the list behind the harness
  button, whose corner counts them in red. A reply nobody heard to the end —
  you cut it off, no window or phone was listening, the server restarted
  mid-sentence — is kept too: the count on the button's other corner opens the
  list, **Play** says them again, each starting "Earlier", and asking the
  harness "what did I miss?" does the same.

- **The profile's board, and a timeline over it.** The icon beside the
  profile's name opens a board that belongs to no workspace: To do, In progress
  and Done to start, and columns you add, rename, recolour, reorder, fold and
  delete from their headers. No robot — a card goes to work through **Send to
  *workspace*** in its menu, which puts it on that workspace's board and makes
  the board if there was none. A bar under the header lists every board in the
  profile, those with a card in progress or in review first, and shows any of
  them in the same sheet without moving what is behind it. A card can carry a
  start and an end day; **Timeline** draws the dated ones as bars across five
  weeks in their column's colour — drag a bar or its end to move the dates,
  drop an undated card onto a day, double-click a day to write a card for it.
  On a phone a tap opens the card and the dates are two fields.

- **Stop a dev server from its row.** Each server listed under the agents has a
  stop, which ends the command the row is named after and everything under
  it — `next dev` and the server it forks, nodemon and whatever it was about
  to restart — and never the agent that started it, even when the two share a
  process group.

- **A frog in the menu bar runs kururu, and no terminal is needed.** Open the
  app and the tray icon starts the pty host and the server; close the window
  and the frog stays, the server keeps serving your phone, and the live agent
  count sits beside the icon. Click it for whether the host and the server are
  up, since when, which build each is (and a warning when the host is behind),
  why the server last restarted, and the verbs: **Open Window**, **Restart**,
  **Stop** and **Start Server**, and **Restart pty host…**, which names how
  many agents it ends and asks first. **Logs** opens the restart log, the
  server's output and the pty host's log. **Open at login** starts kururu with
  the Mac as the frog only, no window. A `bun run dev` already on 7717 is
  adopted rather than fought: the menu says whose it is and leaves stopping it
  to the terminal.

- **Run from a checkout, from the menu.** **Run from → Choose a checkout…**
  points the app at a kururu you cloned and installed: it builds that
  checkout's web app, runs its server with the file watcher exactly as
  `bun run dev` does, and the window shows its code. For forks, with no
  terminal. The app and `bun run dev` now share one supervisor, `run.mjs`.
  Save a file under `server/src` or `shared` and the server restarts on it;
  save one under `web/` and the window and the floating pill show it at once,
  through vite's hot reload, since the app runs the checkout's vite beside the
  server. The phone keeps the server's built page: **Run from → Rebuild the
  web app for the phone** rebuilds it, and the item says when it is behind.

- **The talk key works in every app.** Settings → Voice → **Talk key works in
  every app** (or the tray's switch): hold the key wherever you are and the
  pill floats over whatever you are in — listening, what was heard, Kuru's
  reply as it speaks — draggable, with the same ✕. macOS asks for Input
  Monitoring once. Hold, tap and Escape are unchanged; a key pressed with the
  talk key held is a shortcut for the app in front and drops the clip. ⌥Space
  can toggle the microphone as a fallback that needs no permission, off by
  default.

- **Machines, and a shell on one.** The sidebar's VPS section is now
  **Machines**: any computer you reach with `ssh` — a VPS, a PC on your
  tailnet — with its CPU, memory and disk, added in Settings → Monitors →
  **Machines**. Each row has a shell button that opens `ssh -t <host>` in a
  tab. A workspace can **run on** a machine (Settings → General → Workspaces):
  its new terminals then open there, in a folder you choose, inside a tmux
  session that survives a dropped connection and reattaches by itself. Closing
  the tab ends the session. Agents, the file tree, the reader, worktrees,
  databases and dev servers stay on this Mac, and the + menu keeps a
  **Terminal on this Mac**. The harness can open a shell on a machine and run
  a command in it, in a tab you can watch.

- **Copies made inside a program reach your clipboard, from any machine.** A
  terminal now accepts OSC 52, the sequence a program uses to put text on the
  clipboard of the terminal showing it. Text you drag out in tmux, or copy
  inside Claude or nvim, lands on this Mac even when the program runs on
  another machine. Only the window you are using takes the copy, and only
  for a terminal on screen. A program can never read the clipboard back.
  Where a program has taken the mouse (tmux with `mouse on`, nvim), hold
  **Shift** while you drag to get kururu's own selection, which copies on
  release and with ⌘C. A workspace's tmux sessions on a machine now let
  wrapped copies through (`allow-passthrough`), on those sessions only.

- **Every nvim on this Mac, and closing them.** Settings → Processes counts
  every nvim running on the machine, whoever started it: kururu's tabs, ones
  typed into a shell, ones in another terminal app. A list under the tiles
  shows each one's memory (the editor, its UI and its language servers
  together) and where it is running. **Close all** on the tile, or **Close**
  on a row, asks first, saying how many, then sends each one `:qa`. An nvim
  with unsaved changes refuses and stays open on the unsaved buffer, and the
  page lists it with the files it is holding. **Force close** ends those after
  a second yes: SIGTERM, which lets nvim write its swap files, then SIGKILL to
  that nvim and what it started, never the shell or app around it. A tab
  kururu opened as nvim closes with its nvim; a shell you typed nvim into
  stays.

- **A card can run in a worktree of its own.** Tick **Worktree** as you write a
  card (it is off by default) and pressing the robot starts the agent in
  `<repo>.worktrees/<card>`, on a branch
  `kururu/<card>` cut from whatever you had checked out, so two cards on one
  project are two agents that cannot touch each other's files. The card shows
  the branch and what it was cut from, and a second agent on the same card goes
  back into the same checkout. New in Settings → **Workspaces**, a tab per
  workspace showing the repository it is in: a
  **Setup** line run in a fresh worktree before the agent (`bun install` —
  a worktree starts with tracked files and nothing else), and a **Dev server**
  line for the preview button that is coming next. With worktrees standing,
  the page offers **Merge and remove**, which asks first, with the list, and then
  merges each one back into the branch it was cut from — a rebase and a
  fast-forward, never a merge commit — removes the worktree and deletes the
  branch. An agent still working in one is ended; a worktree with uncommitted
  work, or a rebase that conflicts, is left exactly as it was and the page
  says why. The card's own menu carries the git a worktree needs, so you never
  open a terminal in each one: **Commit changes** with the card as the message,
  **Set changes aside** (`git stash`, named after the card — the work is never
  thrown away), **Merge into `<base>`**, which merges the one card back, removes
  its worktree and puts the card in Done after asking on the card, and **Open a
  terminal in the worktree** for the rest. The rows show how many files are
  uncommitted and how many commits are waiting. Deleting a card still leaves
  its worktree on disk, and the menu says so.

- **A board for each workspace, and a robot on every card.** `C-a K`,
  **Open the board** in a pane's menu or a workspace's right-click menu, or
  **Board** in the `+` menu opens the workspace's board — To do, In progress,
  Review and Done. Nothing exists until you open it. The board is a tab: drag
  it along a strip, into another pane, or onto an edge, with terminals beside
  it; closing it puts the cards away and ends nothing. Press the robot on a card, pick a model, and an agent
  starts in a terminal next to the board with the card as its prompt, named
  after the card. The card follows it: it goes to In progress, shows the
  agent's live status, and moves to **Review** when the agent finishes its turn
  — never to Done, because an agent that has stopped talking may be asking
  you something. Cards drag between columns on the desktop and move from their
  menu on the phone, and they survive a restart; which agent was on them does
  not.

- **The reader has tabs, one per document, and they drag like terminal tabs.**
  Markdown opened from the tree or by the editor it follows opens as a new tab
  rather than replacing the one you were reading. Drag a tab to reorder it, onto
  another reader to move it, or onto any pane's edge for a reader of its own;
  closing the last tab closes the pane. The name that used to open a picker is
  gone — the tree is where documents come from now, and every pane's menu has
  **Show the file tree**. The text-size buttons moved to the tree's header.

- **A file tree, and a way out of it into nvim.** `C-a e`, or the folder at the
  right of the status bar, opens the workspace's project down the right-hand
  side. Markdown opens in the reader. Anything else opens in nvim: kururu
  finds every nvim running in the workspace and asks which — the nearest is
  first, so it is usually just `Enter` — and the file goes there with `:drop`,
  or into a new nvim in a split if none is running. No plugin, no config. On a
  phone it is a sheet, and a file picked there opens in the nvim on your
  desktop.

- **Each profile can keep its own logins.** Settings → Profiles has one switch,
  off by default: on, every terminal a profile opens starts Claude Code and
  Codex on directories of that profile's own, under
  `~/.config/kururu/profiles/`, so `/login` inside a profile signs in that
  profile alone and it stays signed in as whoever you logged into there last —
  a terminal opened in *work* is your work account, and one opened in *home*
  is not. Nothing is chosen and nothing is configured, which is the difference
  from the accounts that went: a profile is born with the name of its
  directory and keeps it through renames and restarts. Each profile starts as
  a fresh install of both tools — sign in, and set them up as you like;
  `~/.claude` and `~/.codex` are not touched, and switching it off goes back to
  them. The usage bar follows the profile you are in. It needs a pty host from
  this version: with an older one still running the switch waits, says so, and
  terminals keep opening as before rather than as the wrong account.
- **A profile can use another profile's login.** Each card on Settings →
  Profiles says which login it uses, in a picker labelled by the account
  signed into each — *you@work*, *not signed in yet*, and which other
  profiles share it. Point two profiles at the same one and they are the same
  account, settings and memory included; pick *a new login* to start a profile
  as nobody and sign in there. The picker offers the logins kururu already
  holds and nothing else, so there is no path to type and no way to land on
  an account you did not expect. Only terminals opened afterwards change — an
  agent already running keeps the account it started with.
- **Settings → About says which pty host is running.** The host keeps the code
  it started with until it is restarted, so it can be older than the app
  drawing the page; the page, `/api/health` and `bun run status` now say when
  it is behind.
- **Start an agent on a particular model from the +.** The new-tab button on a
  tab strip opens a menu now: a terminal, as before, then Claude and Codex —
  each on its default model or on a specific one, such as Claude Opus 5.5 or
  Codex GPT-5.6-Sol. The tab opens in the pane's project. C-a T still opens a
  plain terminal. Settings → *Agents* chooses which of them the menu shows,
  per model or a whole CLI at a time, and the phone's menu follows the
  desktop's.
- **Put an agent away without killing it.** The sidebar's rows have a second
  button beside the ✕: it takes the row out of the list and drops it into a
  *Hidden* drawer at the foot of it. Nothing else happens — the agent keeps
  running, its tab stays where it was, C-a a still finds it by name, and it can
  still reach you with a notification. For the four from this morning you have
  not got round to killing and do not want to scroll past. The shut drawer says
  how many are in it and lights up when one of them has said something.
- **How much of your Claude plan you have spent, in the sidebar.** A bar per
  limit — the five-hour session, the week, and any per-model cap your plan has —
  above Dev servers, filling as you spend it and saying when each one comes
  back. The numbers are your account's own, the same ones `/usage` prints, not an
  estimate from counting tokens. Amber and red are the account's judgement too,
  so the bar and the warning Claude Code prints in the terminal agree. A machine
  with no Claude login shows nothing.
- **Skins are pictures now.** A skin used to be a radius, a line weight and a
  scanline over the whole window; it can now paint every part of the chrome with
  your own PNG — a riveted bezel around each pane, a tile behind the sidebar, a
  HUD along the bottom, a bevelled button — as a nine-slice, a tile or a
  stretch, at a whole-number pixel scale. A skin that paints may also set the
  chrome's colours so its text reads against its own art; the terminals stay the
  theme's. Frames take room, so the terminals inside get smaller, which is the
  point of a bezel.
- **Skin studio.** Settings has a new tab that makes a skin of yours with the
  window as the preview: drop a picture on a part, dial its slice and scale,
  override a colour, type a glyph or drop a strip of sixteen pixel icons, add a
  font, pick a pointer. Every change lands on the window — and the phone — as
  you make it. Fork the skin you are wearing to start from it. What it writes
  is a folder in the registry's own format, one pull request from
  `kururu-styles`.
- **Five skins to show it**, in the registry with the palettes they were drawn
  against as packs: Ironclad (steel and one red line), Handheld (grey plastic,
  a screen bezel with a power light, four greens), Cobble (an inventory screen
  around a chat-coloured terminal), Quest (blue dungeon walls and a HUD with
  three hearts) and World 1-1 (bricks in a blue sky, a cloud for every
  dialog). Every picture in them is generated by the registry's `art.mjs`.
  The three token-only skins the registry opened with — Blueprint, Bubblegum,
  Teletype — and the packs that pointed at them are gone; the studio forks
  a built-in for that.
- **A wider gutter and a custom pointer** are things a skin can ask for, and so
  is a **panel** behind each of the sidebar's three sections — the thirteenth
  part, there because a sidebar picture busy enough to be worth painting is
  busy enough to hide the rows drawn over it.
- **Sounds are a kind of style.** A new shelf in Settings → Styles, alongside
  themes, skins and mascots: the noise a notification makes, installed the way
  everything else is. Its card is a button that plays it, so you can hear one
  before you have it. Five in the registry to start — Coin, Fanfare, Anvil,
  Blip and Knock — every one synthesised by the registry's new `sfx.mjs`
  rather than sampled from anything.
- **A pack brings its noise and its sprite.** Picking one now also picks the
  sound it was made with and a mascot drawn for it: World 1-1 comes with a
  plumber and a coin, Quest with somebody small with a sword and four notes up
  a major chord, Ironclad with a visored knight and struck steel, Cobble with a
  miner and a block being set down, Handheld with a menu blip. Picking a pack
  sets your notification sound; it does not switch notifications *on*, because
  whether to be interrupted is not a style's decision.
- **Four people in the registry** — Plumber, Hero, Knight and Miner — for the
  packs that were wearing whichever animal fit best. Drawn at sixteen pixels,
  which is the size the badge actually is, and generated by `art.mjs` like
  everything else there.
- **A pack you can put back on.** Installed packs are listed in Settings →
  Appearance, and an installed row in the Styles tab now offers *Use* where it
  used to just say *Installed*. Pressing one sets the theme, the skin, the
  mascot, the notification sound and the terminal's face together — which is
  the point, since a pack is five decisions and changing one of them by hand is
  exactly how you end up wanting the other four back. Nothing is downloaded, so
  it works with no network.
- **A pack can name a typeface.** The five in the registry each ask for one —
  World 1-1 in Andale Mono, Quest in Courier New, Ironclad in Menlo, Cobble in
  PT Mono, Handheld in Monaco — and the row in the Styles tab prints the name in
  that face, so you can see whether you have it before you press anything.
  Kururu installs no fonts: a machine without the face keeps the one it had.
- **The branch each workspace is on**, on a line under its name. Read straight out of
  `.git/HEAD` a few seconds after you switch, so the row is never a checkout
  behind. Works from anywhere inside the repo and inside a `git worktree`. A
  detached HEAD says so, in amber, with the short sha — because that is the
  state in which a commit goes somewhere you cannot find it.
- **New workspaces come with a colour**, and there are fourteen of them rather
  than eight. Made in the middle of doing something else, a workspace used to be
  born grey and stay grey; it now takes a colour nothing else in the profile is
  wearing. Set one yourself exactly as before.

### Changed

- **A workspace's colour is a rail down the side of its row**, not a 10×3px mark
  under the number — the same two pixels every agent living in that workspace
  already wears, so the two line up. The colour chip is now how you change it
  rather than how you see it.
- **The sidebar is quieter.** A workspace row is its number, its name and its
  colour chip, with the branch under it when there is one. **Usage** folds: shut,
  it is the one bar for the current session; open, every limit and the account.
  **Dev servers** folds too, shut by default, with a count in the heading. Both
  remember whether you left them open, per device.
- **A pane's corner is one menu.** The two split buttons in the top right are
  gone, and in their place is the button the phone has had all along. Behind it:
  the other panes in the workspace, split right, split down, close this pane —
  and **open a document**, which was a menu item on the phone and, on the
  desktop, a key you had to already know about. Every row prints the key that
  does the same thing, read from your keys rather than from the defaults, so the
  menu is also where you find out what they are.
- The pane's action buttons wear the tab strip's picture rather than a flat
  colour, so a painted strip is one strip.

### Fixed

- **The reader's pin button did nothing once pressed.** Pinning forgot which
  editor the reader was following, so asking to follow again had nobody to
  follow. It remembers now, and a reader opened from the tree — which never had
  an editor — no longer shows the button at all.

- **A phone you put down kept the desktop at phone width.** Two clients watching
  one agent both get a screen they can draw, which means the smaller of them
  decides — and a phone that locks keeps its panes and its connection, so it went
  on deciding from your pocket. Coming back to the window did not help: nothing
  in the window had moved, so nothing re-asked, and the terminal stayed narrow
  until you dragged a divider or switched screens. A client whose screen is off
  now stops voting on the size, and a window you come back to says its shapes
  again. It only touches the size — unread marks and notification cards still go
  by what is on screen.
- **Clicking a workspace sometimes did nothing.** Two reasons, both fixed. A
  workspace row can be dragged to reorder the list, and the moment a drag starts
  the browser stops sending the click — so a press that wobbled by three pixels,
  which on a trackpad is most of them, switched nothing and said nothing. A drag
  that ends where it began is now read back as the click it was. And since the
  row grew a second line, only the name's line was switching: the branch and the
  space around it lit up under the pointer like the rest of the row and did
  nothing when pressed. The whole row is the target now, minus its colour chip.
- **The branch on a workspace holding two checkouts was the wrong one.** The row
  reported whichever repository came first in its panes, so a workspace named
  after a project but with a sibling checkout beside it showed the sibling's
  branch — and went on showing it however much you checked out, which looks
  exactly like the row being broken. It now follows the pane you are looking at.
  Hovering it still names the working tree it came from.
- Pressing Use or Update on several styles in a row lost track of all but the
  last: the tab kept one "working" id, so the second press overwrote the first
  and the first finishing cleared the second, which went on installing behind a
  button offering to start it again. Every row now carries its own job —
  Installing, Updating, Removing — and its own failure, shown on the row beside
  the button that tries again, and Refresh says when it is refreshing. The
  same sweep gave the Mascot tab's import and remove, and the studio's Create,
  Delete, and uploads and licence file, a visible in-progress state and a guard
  against a second press.
- A skin's screenshot in the Styles tab went missing for up to ten minutes after
  every registry publish: the preview checked the picture against the digest in
  a cached catalogue, and a rebuilt index moves every digest. A picture that
  fails the check is now looked up again against a catalogue fetched just then,
  and only refused if it still fails.

### Removed

- **The dev-server and database buttons on a workspace row.** ↯ to run what the
  workspace last had serving, ↻ to restart it, ■ to stop it, and ▤ to start or
  stop a local Supabase are all gone, along with the workspace's memory of its
  dev command. Dev servers are still found and still listed, as links, under the
  agents; starting and stopping one is back to being a line in a terminal.
- **Profiles no longer carry accounts.** A profile could name a Claude login, a
  GitHub account, a gitconfig and an SSH key, and opened every terminal in it
  with those set; a workspace could borrow another profile's. All of it is gone,
  along with the sign-in buttons, the *Connect via SSH* button and the
  workspace menu's **Accounts** item. A profile is a set of workspaces again.

  Nothing on your machine was touched. The directories kururu made still sit in
  `~/.config/kururu/identities`, the logins inside them are still logins, and
  the keys are still in `~/.ssh` and still registered with GitHub — terminals
  simply open with your machine's own accounts now, as they did before any of
  this existed. If you were relying on a second Claude account, switch on
  *Each profile keeps its own logins* in Settings → Profiles — see above — or
  set `CLAUDE_CONFIG_DIR` in the terminal that wants it.

  It went because it was a second place for a login to go wrong quietly, and
  what it cost when it did was a terminal opened as somebody you did not expect
  — or worse, a login that landed in the wrong directory. Two accounts on one
  machine is a problem the tools already own.

## [0.2.0] - 2026-09-16

### Added

- **kururu installs its own updates.** The About tab has always been able to
  tell you a newer release was out; *Get it* now fetches it, shows how far along
  it is, and restarts into it — no browser, no disk image, nothing to drag. It
  appears only in the desktop app showing the server it started itself: a
  browser, the phone, and a window pointed at a machine in a cupboard still get
  the link to GitHub, because replacing the app on your desk would not change
  the version any of those are reporting.

### Fixed

- **The disk image lines up.** The app and the Applications shortcut you drag it
  onto sat thirty pixels above the arrow drawn between them.

## [0.1.0] - 2026-09-16

### Added

- **Runs your agents**, and plain shells, in ptys kururu owns. A pty host
  process holds them and outlives everything: quit the window, restart the
  server, close the terminal you started it from, and the agents carry on.
- **Tiles them.** Split right or down, drag the dividers, stack tabs in a pane.
  Real terminals over the raw stream — colour, scrollback, selection, mouse —
  and the pty is resized to the pane rather than the other way round.
- **Rearranges by dragging**, a tab or a whole pane, within a workspace or
  across one. Nothing is stopped by being moved.
- **Organises.** Profiles hold workspaces, workspaces hold panes, panes hold
  tabs. The arrangement is the server's and comes back after a restart — as
  empty panes, with the directory each was working in. Nothing is respawned.
- **Renders what a terminal cannot.** A pane can hold a markdown document
  instead of a grid: highlighted code, images and mermaid diagrams, with the
  highlighting done on the server so a phone is handed markup rather than a
  parser.
- **Remembers what agents said.** A pane opened ten minutes late is handed the
  history, laid out at the size the server actually sized the pty to.
- **Shows status** — idle, working, blocked, done — with unread marks and how
  full a Claude Code window's context is.
- **Interrupts you when it should.** A notification when an agent needs you,
  addressed per client, so the window you are looking at stays quiet and the
  phone in your pocket does not. Click it and kururu goes to that agent,
  switching profile and workspace on the way.
- **Is yours to dress:** themes, skins and mascots, installed from a registry
  and pinned by version and digest.
- **Opens terminals as the right account.** A profile carries which Claude login
  and which github account its terminals spawn with, and a workspace can borrow
  another profile's.
- **Opens your dev server on the phone.** Discovery from both ends, a ▸/↻ pair
  per workspace, and a reverse proxy so what you are building is reachable from
  the device in your hand.
- **Is driven from a prefix**, `ctrl+a` then a key, tmux-style, with every
  binding rebindable and a help overlay printed from the keymap.
- **Honours the cursor a program asks for** — shape and colour, through a
  reload, with the character under a block cursor still legible.
- **Listens on this machine only.** Your agents, your terminals and the files
  they can read are all behind kururu's server, so being reachable from anywhere
  else is a decision: press *Share with my devices* in the phone dialog and the
  QR code carries a code that nothing else on the network has. Stop sharing, or
  mint a new code, in the same place.
- **Says when there is a newer kururu.** Settings → About checks, and shows that
  release's notes — which are this file.
- **Installs from a DMG**, signed and notarized, or from the Homebrew tap.

[Unreleased]: https://github.com/tonyjara/kururu/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/tonyjara/kururu/releases/tag/v0.4.0
[0.3.0]: https://github.com/tonyjara/kururu/releases/tag/v0.3.0
[0.2.0]: https://github.com/tonyjara/kururu/releases/tag/v0.2.0
[0.1.0]: https://github.com/tonyjara/kururu/releases/tag/v0.1.0
