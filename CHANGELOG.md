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

[Unreleased]: https://github.com/tonyjara/kururu/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/tonyjara/kururu/releases/tag/v0.1.0
