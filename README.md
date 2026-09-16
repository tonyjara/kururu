# kururu

```text
     ▒▒▒▒▒▒    ▒▒▒▒▒▒▒▒
   ▒▒██████▒▒▒▒████████▒▒▒▒
   ▒▒    ████████    ██████▒▒
   ▒▒    ████████    ████████▒▒
   ░░████████████████████████░░░░
   ░░████      ██████████████░░██░░
   ░░██████████████████████████████░░
   ░░██████████████████████▒▒██████▒▒
     ░░██████████████████░░████████▒▒
     ▒▒████████▒▒████████░░░░██████░░
   ░░██▒▒████▒▒██▒▒████▒▒████████░░
   ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
```

_Kururu_ is Guaraní for **frog**. It runs your coding agents and gives them a
window that can draw — on the desktop, and on your phone.

A terminal cannot show you a rendered markdown file, an image, or the app you are
building. Kururu is the other half.

## What it does

- **Runs your agents** in ptys it owns. Plain shells too — terminal and agent are
  the same machinery.
- **Tiles them.** Split right or down, drag dividers, stack tabs in a pane. Real
  terminals ([ghostty-web](https://www.npmjs.com/package/ghostty-web) over the raw
  stream): colour, scrollback, selection, mouse, and the pty resizes to the pane.
- **Renders what a terminal cannot** — a pane can hold markdown with highlighted
  code, images and mermaid diagrams instead of a grid.
- **Rearranges by dragging**, a tab or a whole pane. Nothing is stopped by being
  moved.
- **Organises.** Profiles hold workspaces, workspaces hold panes, panes hold tabs.
- **Opens terminals as the right account** — a profile carries which Claude login
  and which github account it spawns with.
- **Is driven from a prefix**, `C-a` then a key, tmux-style.
- **Shows status** — idle / working / blocked / done, unread marks, context rings.
- **Is yours to dress:** themes, skins and mascots, with a registry of each.
- **Remembers the arrangement**, and brings it back as empty panes. Nothing is
  respawned.
- **Remembers what agents said.** A pane opened late is handed the history.
- **Keeps agents alive.** The ptys live in a host process nothing owns: quit the
  window, restart the server, close the terminal you started it from.
- **Connects to a server rather than being one.** Run it on a box that is always
  on and point the desktop — or the phone — at it.

Still unwired: the preview proxy that lets a phone reach `localhost`. See
[PLAN.md](./PLAN.md).

## Running it

```sh
bun install

bun run dev              # your agents: serves on :7717, restarts itself on save
bun run dev:desktop      # a window onto one
bun run start            # built, no watching
```

`dev` starts the pty host if it is not up — a detached daemon on a unix socket
holding every pty — then a server in front of it. Editing the server restarts it
and no agent notices.

`dev:desktop` looks for a server, offers a box to type an address into if there
is none, and keeps looking. Addresses you have used are remembered. A server that
goes away for good drops the window back to that picker after ~10s; a restart is
a second of silence and it sits through it.

```sh
bun run status                   # host, server, what they hold
bun run status http://vm:7717    # a server elsewhere
```

**Quitting the window stops nothing.** Neither does restarting the server. The
one thing that ends your agents:

```sh
bun run kill-ptyhosts         # lists what it holds, asks, then reaps
bun run kill-ptyhosts --list  # just the listing
```

It finds hosts by socket, not by name — the host has no controlling terminal and
`pgrep -f` cannot be relied on to match it. By hand:
`kill $(lsof -t ~/.local/state/kururu/ptyhost.sock)`. Its log is
`~/.local/state/kururu/ptyhost.log`.

### From your phone, or another computer

Everything above the server is a client; the desktop is not a privileged one. Put
the server where both can reach it and point either at it. The sidebar's **phone
button** draws two QR codes: the LAN address (faster, same Wi-Fi) and the tailnet
one (works from a train).

There is no auth. Kururu is for a tailnet or a LAN you trust and never off one —
anything that can reach the port gets a shell in your projects.

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:7717
```

Preview proxies get their own ports (7800+); serve each the same way. Kururu never
runs `tailscale` for you.

## Layout

```
┌───────────┬─────────────────────────────────────────────┐
│ ● main    │ [claude ●][zsh][+]            ⊟ ⊞ ✕        │
│           │ > running the tests…                        │
│ WORKSPACES│                                             │
│ 1 main  ▸3│                    │                        │
│ 2 review 1├────────────────────┴────────────────────────┤
│           │ [zsh ●][build][+]             ⊟ ⊞ ✕        │
│ AGENTS    │ $ git status                                │
│ ● claude  │ nothing to commit                           │
│ ○ zsh     │                                             │
│           ├─────────────────────────────────────────────┤
│[Terminal] │ main / 1 main        PREFIX          C-a ?  │
└───────────┴─────────────────────────────────────────────┘
```

### Keys

`C-a` arms the prefix for three seconds; the bar says `PREFIX` while it is armed.
Twice sends it through.

| after `C-a` | |
|---|---|
| `\|` `\` `%` `]` / `-` `"` `[` | split right / down |
| `T` | new terminal |
| `n` `p` | next / previous tab |
| `D` | close tab — **ends that terminal** |
| `,` | rename tab |
| `x` | close pane and everything in it |
| `h` `j` `k` `l` | focus pane left / down / up / right |
| `M` | open the reader on the markdown next door |
| `1`…`9` | jump to workspace |
| `C` / `N` `P` / `z` | new workspace / next, previous / last |
| `W` `X` | rename / delete workspace |
| `w` `a` | find workspace / agent |
| `s` `S` | profiles — switch, rename, accounts / new profile |
| `r` | resize mode — then `hjkl`, `esc` to leave |
| `m` `b` | zen mode / toggle sidebar |
| `g` | settings |
| `R` `B` | reload the window / restart the server (agents keep running) |
| `?` | these keys |

These are defaults; everything is rebindable under the cog, and `C-a ?` prints the
keymap you are actually using. ⌘ shortcuts are a second door — `⌘D` `⇧⌘D` split,
`⌘T` new terminal, `⇧⌘W` close pane, `⌘[` `⌘]` move focus. `⌘W` and `⌘R` stay
Electron's.

There is no "start an agent" button: that is a terminal with `claude` typed into
it. A new tab opens where the terminal you were just in *is*, read from the pty.

### The sidebar

Workspaces are numbered because the number is the shortcut. Double-click to
rename; right-click for colour, mascot, reorder, new, and delete. The colour
swatch tags a workspace and every terminal in it gets a rule down its left in that
colour.

The list below is **agents**, not terminals — the test is "has an agent ever been
seen in here", so a row does not flicker out while claude is between things, and
an exited agent stays listed with its screen and a `✕` to dismiss it. Every
terminal is still in its tab strip, and `C-a a` finds all of them.

Each row is two lines:

| | |
|---|---|
| **top** | status dot (or the hopping mascot while working), what is running, which workspace, and a `✕` that ends it |
| **bottom** | what it is doing, and how much of its context window is gone |

"What it is doing" is reported, never guessed — it needs
[the hook](#telling-kururu-what-an-agent-is-doing), and shows where the agent is
working until then.

Clicking a row reveals that terminal where it already is; dragging one moves it.
The profile menu is at the top, the cog and phone button at the bottom.

### The reader

`C-a M` splits the pane and puts a document in the new half: markdown rendered —
headings, tables, highlighted code, images, mermaid. Pressed from a reader it
re-points that one instead of making a second. It is a pane like any other, so it
splits, drags, stacks and moves between workspaces as a terminal does.

**On the desktop it follows your editor**: an nvim in a neighbouring pane and the
reader shows whatever buffer it is on, re-rendering on write. Nothing to install —
neovim listens on a socket named after its pid, kururu knows the pid of every pty,
and an autocmd does the rest. **On a phone** there is no editor to follow, so it
has a picker: the project's markdown, most recently written first.

Rendering happens on the **server**, so the phone is sent markup rather than a
parser and a highlighter. Raw HTML passthrough is off, which is also the
sanitizer.

The strip has **⇄ / ⊙** (follow the editor, or pin the file) and **− / +** (type
size, or `-` `+` `0` with the keyboard). The zoom is this device's and never
reaches the server.

### Dev servers

A workspace row grows a **▸** the first time kururu sees a dev server inside one of
its terminals, and **↻** while one is up. Which button you see is the status.

Nothing is configured: the scan notices `npm run dev` in a pty, the workspace
remembers the line and directory, and ▸ types it again in a fresh tab. The memory
is never cleared — a stopped server is when it is worth something. The buttons
never type into a terminal with an agent in it, since `npm run dev` arriving at a
waiting Claude Code is a prompt.

## Telling kururu what an agent is doing

Status is idle, **working**, **done** or **blocked**. Three of those mean
*stopped*, so they are dots; working gets the hopping mascot, because a glance
picks up movement and not a pulse.

Kururu guesses from the shape of the output over time, which tells "still going"
from "finished" and nothing else. It cannot guess **blocked** (nothing in a byte
stream separates *waiting for you* from *thinking*) or **how full the context
window is**. Both arrive through a hook, which replaces the guess permanently, per
agent.

In `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "async": true,
      "command": "bun /path/to/kururu/server/src/report-cli.ts working >/dev/null 2>&1 || true" }] }],
    "PreToolUse": [{ "hooks": [{ "type": "command", "async": true,
      "command": "bun /path/to/kururu/server/src/report-cli.ts working >/dev/null 2>&1 || true" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "async": true,
      "command": "bun /path/to/kururu/server/src/report-cli.ts done >/dev/null 2>&1 || true" }] }],
    "Notification": [{ "hooks": [{ "type": "command", "async": true,
      "command": "bun /path/to/kururu/server/src/report-cli.ts blocked >/dev/null 2>&1 || true" }] }]
  }
}
```

Nothing says which agent is reporting and nothing needs to: every pty is spawned
with `KURURU_AGENT_ID` and a hook is a child of the agent. Safe to install
globally — outside kururu the variable is absent and it exits silently.

## Settings

The cog, or `C-a g`. Five tabs, all server-side, in `~/.config/kururu` — so a
change reaches a second window and the phone without being told.

| | |
|---|---|
| **Appearance** | the theme, the skin, and what a terminal is set in |
| **Styles** | themes, skins and mascots from the registry |
| **Profiles** | the sessions, and which accounts they open terminals as |
| **Mascot** | what the badge does while an agent is working |
| **Keys** | what each key does after the prefix |

### Appearance

A **theme** is the palette — the chrome's tokens and the terminal's sixteen ANSI
slots in one place, since the emulator paints into a canvas CSS cannot reach. A
**skin** is the shape: radii, line weights, the type ramp, the icon glyphs.
Neither mentions the other, so "Catppuccin in a chunkier chrome" is a real thing
to ask for. Every theme is drawn in itself, so the list is the preview; four
Catppuccin flavours ship plus kururu's own green, default Mocha.

Below that, the terminal's own **font and cursor**. The list is built on the device
that draws, because over Tailscale the face has to exist on the phone. What you
name is prepended to a stack ending in four patched Nerd Font faces, so devicons
keep working.

Changing the theme never resizes a pty. Changing the skin or the font does — they
move the cell, and a moved cell is a SIGWINCH into every agent watching.

### Styles

Appearance is what you are wearing; Styles is the shop. It lists what
[`kururu-styles`](https://github.com/tonyjara/kururu-styles) offers — five IDE
themes, three skins, five mascots cut from CC0 art, and packs that wear all three
— with what you have and what has a newer version.

**Picking is installing**, and an installed style is a **copy with its version
pinned**, never a link: kururu has to come up with no network, and *check for
updates* means nothing without a version to compare against. The server fetches
the registry, never the browser; a font a skin names ships with it and is served
from kururu's own origin.

### Profiles

Profiles are named sessions — a set of workspaces with their own layouts. The
sidebar's profile name switches between them; this page renames, deletes, and
gives them an **identity**: which accounts their terminals open as. Underneath it
is three paths — `CLAUDE_CONFIG_DIR`, `GH_CONFIG_DIR`, `GIT_CONFIG_GLOBAL` — but
the page offers the accounts the tools already know about, and a path appears only
in the line underneath and behind `Custom…`.

`CLAUDE_CONFIG_DIR` scopes a Claude Code login completely, so two profiles are two
accounts signed in at once rather than a switch with global state.

**Signing in is a terminal, not a dialog.** The button does the setup, then opens
a new tab in the profile it is about and types the line you would have typed.

**A profile is a pointer, never a secret** — three paths, not a free-form
environment map, because a profile travels in every snapshot and kururu is
reachable from the tailnet. Secrets stay in the keychain.

A **workspace** can borrow another profile's accounts (right-click → **Accounts**)
for the afternoon a repository of your own turns up in your work profile. It
stores a pointer, so re-pointing the account follows every workspace borrowing it.

The identity reaches a pty at spawn and at no other time: changing it is a
statement about the next terminal, not the five already running.

### The mascot

Which part of which sprite sheet the badge is, and you can keep several. The list
down the left is the ones you kept, each hopping; click to edit, **+ Add** copies
the one you are looking at, double-click to rename, **★** marks the default.

Each mascot has two animations — `Working` and `Idle` — and you drag out a run of
cells for each. **Animate idle** gives idle frames, **Use the dot** takes them
away. `blocked` and `done` keep their dots on purpose: among moving neighbours a
still dot is what stands out, and those are the two states that want you.

| | |
|---|---|
| **Sheet** | the frog that ships, or anything you imported |
| **Cell** | the sheet's grid, in pixels. 32 for the ones that ship |
| **Speed** | one loop end to end, per animation — idle wants to be slower |
| **Motion** | always, follow the system, or never |
| *trim* | **computed** off the pixels, not offered |

The trim is one box across every frame of *both* animations. Per frame would land
a jump on the floor; per animation would scale a sitting frog and a jumping one to
the same badge, and the sprite would change size the moment its agent stopped.

**Motion** at *never* (or *follow the system* with Reduce Motion on) puts idle back
to a dot — an idle animation that cannot animate is the same picture as a frozen
working one. Always is the default: a 16px indicator is a spinner, not sliding
parallax.

The sheets that ship hold idle, croak, jump, hop and shock across eight facings;
`assets/spritesheets/guide.png` labels the columns.

#### Your own sprites

**Import…** takes a PNG into `~/.config/kururu/sheets` and selects it; dropping one
in that directory does the same. Any grid of frames works — set **Cell** to your
frame size and drag out a run. **PNG only**, because the trim is measured off the
alpha channel; Aseprite's *Export Sprite Sheet* gives exactly this grid.

An import is checked on the way in — a real PNG, under a megabyte, under a name
that is a name — because it is a client asking the server to write into your config
directory. A file you put there yourself is served as you left it, and falls back
to the dot if it is not a PNG.

#### A mascot per workspace

Right-click a workspace → **Mascot…**, where its colour lives; each option is drawn
animating. **Default** is an option in the list rather than a way of dismissing it:
it means the ★ moving in Settings moves this workspace too. Deleting a mascot a
workspace used needs no clean-up.

#### The icon is the same frog, and is not a setting

`bun run icon` cuts the sitting pose out of the sheet and writes the `.icns`, the
favicon and the home-screen icon. The cell is named in `tools/icon.mjs` and is
deliberately not read from your mascot config — an app's identity should not change
because somebody browsed a picker.

### The keys

**+** captures a key, clicking a key unbinds it, and taking a key another action
had is allowed. What is stored is the **difference** from the defaults, in
`~/.config/kururu/keys.json`, so a key you never touched follows kururu's table as
it changes. `1`–`9` and `C-a` itself are not up for grabs — the first are the
workspace jumps, the second is what you need to fix a keyboard you have broken.

## On a phone

Same URL, same components; what changes is the width.

- **One pane at a time.** A narrow window draws the focused pane and says so to
  the server, so it does not hold a desktop watching the same agents down to a
  quarter of a phone screen.
- **The sidebar is a sheet**, and going narrow closes it.
- **A row of the keys a soft keyboard lacks**: escape, tab, control, arrows, `^C`,
  `^D`, `^L`, `^R`, shell punctuation, `C-a`. It sends a `KeyboardEvent` rather
  than bytes, so an arrow is `\e[A` or `\eOA` depending on what the program asked
  for.

The phone is for watching and steering, not for writing code.

## Odds and ends

**Selecting text.** Hold **⌥** and drag. Agents turn on every mouse mode there is,
so a plain drag is an escape sequence; option says "this one is mine".

**Dropping a file in.** Drag it onto a terminal and the path is typed in, escaped,
with a space after — how you hand a screenshot to an agent that only takes text.
It goes to the pane you dropped on. Dropped anywhere else it does nothing: a web
page's default answer is to navigate to the file, and this page is the whole app.

**When a terminal misbehaves.** Kururu keeps the last 128KB of each open
terminal's raw stream interleaved with what it did to that terminal — every
resize, pane open and backlog replayed — because most terminal bugs are about
ordering, and a screenshot shows what was drawn rather than what was said.

```sh
curl 'http://127.0.0.1:7717/api/record?agent=a7&tail=40'     # the last 40 entries
curl 'http://127.0.0.1:7717/api/record?agent=a7' > tape.txt  # all of it
```

Sequences come out spelled (`\e[?1049h`), so printing the tape cannot repaint the
screen you read it on. Forgotten on restart; `KURURU_RECORD=0` turns it off.

## Dragging

Grab a **tab** to move one terminal, or the **tab strip** — the pane's title bar —
to move the whole pane.

| drag | drop on | what happens |
|---|---|---|
| a tab | its own strip | reorders |
| a tab | another pane's strip | moves there, at the position you dropped it |
| a tab | the middle of a pane | joins that pane |
| a tab | a pane's left / right / top / bottom quarter | splits it that way |
| a tab, or an agent from the sidebar | a workspace row | moves to that workspace |
| **a pane** | the middle of another pane | **the two swap places**, contents and all |
| **a pane** | another pane's edge | moves to that side of it |
| **a pane** | another pane's tab strip | pours its tabs in and disappears |
| a workspace row | another workspace row | reorders the list |

Neither swap nor move nests the tree deeper than it was. A pane you drag the last
tab out of closes itself; one you split and left empty on purpose stays.

`⌘R` **Reload Window** redraws the UI from the same server; `⇧⌘R` **Restart
Server** forks a new server process, which is how a change to the protocol, the
layout or the discovery is picked up. The agents are in neither.

## Shape

Three processes, and the window is the least important.

```
pty host    holds every pty and an emulator beside each. Outlives everything;
            restarting IT is the only thing that ends an agent
server      the protocol, the layout, the discovery, the renderers. Restarted
            constantly and freely; reconnects to the host over a unix socket
window      finds a server and draws it — exactly as the phone does
```

```
shared/     protocol types: the model, the split tree, the wire, the keymap,
            the themes and the skins. No runtime deps; imported by everything
server/     Node. The pty host and its daemon, the arrangement and its snapshot,
            markdown and highlighting, the styles registry, identities,
            dev-server discovery, the preview proxy, the file API
web/        React + Vite. Draws the server's layout; owns no state worth keeping
desktop/    Electron main + preload, the address picker, the esbuild step for
            the server, and the branding stamped into the dev shell
assets/     the sprite sheets, served at runtime
tools/      run by hand, outputs committed. The icon generator lives here
```

See [PLAN.md](./PLAN.md) for why it is arranged this way, and
[CLAUDE.md](./CLAUDE.md) for what will bite you if you work on it.
