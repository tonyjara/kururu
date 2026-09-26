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
  signed into each — *tony@work*, *not signed in yet*, and which other
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

[Unreleased]: https://github.com/tonyjara/kururu/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/tonyjara/kururu/releases/tag/v0.2.0
[0.1.0]: https://github.com/tonyjara/kururu/releases/tag/v0.1.0
