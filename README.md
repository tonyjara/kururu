# kururu

_Kururu_ is Guaraní for **frog**. It runs your coding agents and gives them
eyes: a GUI for the agents it is running — on the desktop, and on your phone.

A terminal cannot show you a rendered markdown file, an image, or the app you
are building. Kururu is the other half — your agents, in a window that can draw.
It began as a front-end for [ghosttown](../ghosttown) and still borrows code
from it, but it owns its own agents now: what runs here is not what runs there.

## What it does today

- **Runs your agents.** Spawns each one in a pty it owns, in the project you
  point it at. Plain shells too — "terminal" and "agent" are the same machinery
  and the same list.
- **Tiles them.** Split a pane right or down, drag the divider, stack terminals
  in a pane as tabs. Real terminals: xterm.js over the raw pty stream, so colour,
  scrollback, selection and mouse all work, and the pty resizes to the pane. A
  pane you make arrives with a terminal already in it — a split's starts in the
  directory the half you split is in — because there was nothing else it could
  have offered you.
- **Rearranges by dragging, at two scales.** Pick up a *tab* — from a strip or
  from the sidebar — and drop it along a strip, into another pane, onto a pane's
  edge to split it that way, or onto a workspace to send it there. Or pick up a
  whole *pane* by its tab strip and drop it on another pane to swap the two, on
  an edge to move it to that side, or on a tab strip to pour its tabs in.
  Nothing is ever stopped by moving it.
- **Organises them, the way ghosttown does.** Profiles are named sessions,
  workspaces are named layouts inside one, panes tile inside those, tabs stack
  inside a pane. Switching a workspace or a profile never stops anything.
- **Is driven from a prefix.** `C-a` then a key, tmux-style — the same table
  ghosttown uses, so your hands already know it. `C-a` twice sends it through.
- **Sees them.** Sidebar of everything running, live status (idle / working /
  blocked / done), unread marks, context-window rings.
- **Remembers the arrangement.** Workspaces, splits and each pane's project are
  written to `~/.local/state/kururu/session.json` and come back on the next
  launch — as empty panes. Nothing is respawned; that is deliberate.
- **Remembers what they said.** A pane opened ten minutes late is handed the
  history, because the server keeps an emulator beside every pty.
- **Keeps them, through everything except being told not to.** The ptys live in
  a host process of their own that nothing owns: quit the window, restart the
  server, close the terminal you started it from — every agent, its scrollback
  and your layout are still there. `C-a B` puts kururu back on current code
  without one of them noticing. Only stopping the host itself ends them.
- **Connects to a server, rather than being one.** The window finds a kururu
  server, on this machine or on a box that is always on, and draws it — the same
  thing the phone does. Start a server somewhere, point the desktop at it, and
  close your laptop lid.

Under the surface and waiting for a pane to live in: dev-server discovery, the
preview proxy that lets a phone reach `localhost`, and a traversal-safe file API.
See [PLAN.md](./PLAN.md).

## Running it

Two commands, and the split between them is the point.

```sh
bun install

bun run dev              # your agents: serves on :7717, restarts itself on save
bun run dev:desktop      # a window onto one
```

`bun run dev` is the half that matters. It starts the pty host if it is not
already running — a detached daemon on a unix socket that holds every pty — and
then a server in front of it. Editing the server restarts it and no agent
notices; so does `C-a B`. Closing the terminal you ran it in leaves the host, and
your agents, exactly where they were.

`bun run dev:desktop` opens a window and looks for a server. If it does not find
one it says so and offers a box to type an address into, and it keeps looking —
start a server and the window connects on its own. Addresses you have used are
remembered, so the next launch goes straight there.

For a built server with no watching:

```sh
bun run start            # builds the web app, then serves on :7717
```

If the server goes away for good — you stopped it, or the machine it was on went
to sleep — the window notices after about ten seconds and goes back to the
address picker, where it starts looking again. A *restart* is not that: `C-a B`
and editing a server file are a second or two of silence and the window sits
through them without blinking.

To see what is running, including the host, which otherwise has no face at all:

```sh
bun run status
bun run status http://vm:7717    # a server elsewhere
```

**Quitting the window stops nothing.** Neither does restarting the server. The
one thing that ends your agents is stopping the host:

```sh
bun run kill-ptyhosts         # lists what it holds, asks, then reaps the ptys
bun run kill-ptyhosts --list  # just the listing
```

It finds hosts by their socket rather than by their name, because the host has
no controlling terminal and macOS `pgrep -f` cannot be relied on to find it — a
`pkill -f ptyhostd` that matches nothing looks exactly like a host that
restarted and ignored you. By hand, the same thing is
`kill $(lsof -t ~/.local/state/kururu/ptyhost.sock)`.

Its log, when something is wrong down there, is
`~/.local/state/kururu/ptyhost.log`.

### From your phone, or from another computer

Same answer for both, and it is now the same mechanism: everything above the
server is a client, and the desktop is not a privileged one. Put the server on
your tailnet and point either at it.

There is no auth in kururu and there does not need to be — it is meant to be
reached over a tailnet, never off one. That was true when the server was always
on `localhost`; it carries considerably more weight now that it may be on a
machine that is always on, so: tailnet only, never a public address. Anything
that can reach the port gets a shell in your projects.

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:7717
```

Preview proxies get their own ports (7800 and up); serve each one you want
reachable the same way. Kururu never runs `tailscale` for you: putting a port on
your tailnet is your decision to make, not a side effect of opening a tab.

## Layout

```
┌───────────┬─────────────────────────────────────────────┐
│ ● main    │ [claude ●][zsh][+]            ⊟ ⊞ ✕        │
│           │ > running the tests…                        │
│ WORKSPACES│                                             │
│ 1 main   3│                    │                        │
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
Press `C-a` twice to send it to the terminal.

| after `C-a` | |
|---|---|
| `\|` `\` `%` / `-` `"` | split right / down |
| `T` | new terminal |
| `n` `p` | next / previous tab |
| `D` | close tab — **ends that terminal** |
| `,` | rename tab |
| `x` | close pane and everything in it |
| `h` `j` `k` `l` | focus pane left / down / up / right |
| `1`…`9` | jump to workspace |
| `C` / `N` `P` / `z` | new workspace / next, previous / last (a toggle) |
| `W` `X` | rename / delete workspace |
| `w` `a` | find workspace / agent |
| `s` `S` | switch / new profile |
| `r` | resize mode — then `hjkl`, `esc` to leave |
| `m` `b` | zen mode / toggle sidebar |
| `g` | settings |
| `R` `B` | reload the window / restart the server (agents keep running) |
| `?` | these keys |

These are the **defaults** — ghosttown's, key for key. Every one of them can be
rebound under the cog (see [Settings](#settings)), and `C-a ?` prints the keymap
you are actually using rather than this table.

The ⌘ shortcuts still work as a second door: `⌘D` `⇧⌘D` split, `⌘T` new terminal,
`⇧⌘W` close pane, `⌘[` `⌘]` move focus.

Every tab is a terminal — there is no separate "start an agent" button, because
that is a terminal with `claude` typed into it, and the tab says so either way
once it is running. A new one opens where the terminal you were just in *is*,
not where it was opened: the directory you cd'd to, read from the pty itself.

### The sidebar

Workspaces are numbered because the number is the shortcut. **Double-click** one
to rename it in place; **right-click** one for the rest — rename, colour, move it
up or down the list, a new workspace, and delete, which ends every terminal in it
and asks first.

Under each number is a **colour swatch**. Click it to tag the workspace, and
every terminal living in that workspace gets a rule down its left in the same
colour — so "which of these six is the one I have the browser open for" is
answered by glancing instead of reading. Untagged is the default and stays that
way: a list where everything is coloured says nothing.

The list below is **agents**, not terminals. A shell you opened to run `ls` in
is not one, and with a few of those open they would be most of the list and none
of them what you came looking for. The test is "has an agent ever been seen in
here" rather than "is one running right now" — so a row does not flicker out
while claude is between things, and an agent that has *exited* stays listed,
because its screen is the only record of what it said and the ✕ on its row is
how you dismiss it. Nothing becomes unreachable: every terminal is still in its
tab strip, and `C-a a` still finds all of them by name.

Each one takes two lines, and they are split by how often they change:

| | |
|---|---|
| **top** | status — a dot, or the hopping mascot while it is working — what is running (`claude`, `codex`, a shell), which workspace it is in, and a `✕` that ends it |
| **bottom** | what it is doing, and how much of its context window is gone |

The top line is the one you search the list with, so nothing on it moves while
you read. The bottom line is the one that changes. The terminal the keyboard is
currently pointed at is ringed and brightened — with six agents open, which one
the next keystroke belongs to is the most useful thing on the row.

"What it is doing" is reported, never guessed: it is the prompt the agent was
handed, or the reason it stopped to ask you something. It needs the hook below.
Until an agent has reported, that line shows where it is working instead.

Clicking a terminal in the list shows it where it already is, without
rearranging anything. Dragging one moves it.

### Telling kururu what an agent is doing

The mark beside every terminal is its status — idle, **working**, **done**, or
**blocked**. Three of those are a dot, because three of them mean *stopped* and
the only question is which kind. Working is the one that is not, so it gets the
**mascot**: a frog, hopping. A pulsing dot answers "is this one still going?"
only if you watch it for a second, and nobody watches a sidebar — they glance at
it, and movement is what a glance picks up. Hover any of them for the word.

Kururu guesses that from the shape of the output over time, which is enough to
tell "still going" from "finished", and not enough for anything else. Two things
it cannot guess:

- **`blocked`.** Nothing in a byte stream distinguishes *waiting for you to
  approve something* from *thinking hard*.
- **How full the context window is.** That is a number the agent knows and the
  terminal never carries.

Both arrive from the agent instead, through a hook. Point Claude Code's hooks at
`report-cli.ts` and the guess is replaced by the agent's own account of itself —
permanently, per agent: a process that reports once is a better source than a
heuristic forever after. The percentage used then shows beside the ring in the
sidebar.

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

Nothing is passed in to say *which* agent is reporting, and nothing needs to be:
kururu spawns every pty with `KURURU_AGENT_ID` in its environment, a hook is a
child of the agent, and a child inherits the environment. Which is also why this
is a hook rather than something the server works out on its own — it can see that
an agent is running in some directory, but two agents in one project would be
indistinguishable to it, and a context percentage on the wrong agent is worse
than none.

It is safe to install globally. Outside kururu `KURURU_AGENT_ID` is simply
absent, and it exits silently without touching the network.

### Settings

The cog in the bottom-left corner of the sidebar opens Settings — or `C-a g`.
Two pages: the **mascot**, and the **keys**.

Both are the server's rather than the browser's, so a change reaches a second
window and the phone without being told, and survives a restart. They live in
`~/.config/kururu` — the config directory, not the state one the session
arrangement is written to, because these are decisions kururu would never invent
and must not lose.

#### The mascot

**Which part of which sprite sheet the mascot is** — and you can keep several.

The list down the left is the ones you have kept, each hopping so you can tell
them apart; click one to edit it, **+ Add** copies the one you are looking at,
double-click a name to rename it. The **★** marks the default — what a workspace
gets when it has not picked one of its own. It starts on the frog and is yours to
move.

Each mascot has **two animations**: `Working` while the agent is going, `Idle`
while it is stopped. Switch between them above the picker and drag out a run of
cells for each; the sheet marks the other one faintly so you do not pick the same
frames twice. Idle starts as a dot on any mascot you made before it existed —
**Animate idle** gives it frames, **Use the dot** takes them away.

`blocked` and `done` keep their dots on purpose. Those are the two states that
*want you*, and in a sidebar where everything else is moving a still dot is the
thing that stands out — which is the right way round.

Drag along a row of the sheet to take a run of cells — that is an animation. The
sheets that ship hold idle, croak, jump, hop and shock across eight facings, and
`assets/spritesheets/guide.png` is the labelled key to which columns are which.
The frog hops beside the picker while you choose, at the size it will actually be
in a row and once more big enough to see.

Three things you can set, and one you cannot:

| | |
|---|---|
| **Sheet** | the frog that ships, or anything you imported |
| **Cell** | the sheet's grid, in pixels. 32 for the ones that ship |
| **Speed** | one loop, end to end. Per animation — idle wants to be slower |
| **Motion** | always, follow the system, or never |
| *trim* | **computed.** The part of a cell the sprite is in, measured off the pixels |

The trim is not offered because it is not a preference — you want "the part of
the cell the sprite is actually in", and a canvas answers that off the pixels
better than anybody types it. One box for every frame of *both* animations,
though, never each frame's own. Within an animation: where a sprite sits in its
cell is how a sheet draws a jump, so trimming frame by frame would land them all
on the floor and throw the jump away. Across the two: a sitting frog is smaller
than a jumping one, so a box each would scale them to the same badge and the frog
would visibly change size the moment its agent stopped.

Setting **Motion** to *never* (or to *follow the system* on a machine with Reduce
Motion on) puts idle back to a dot. An idle animation that cannot animate is the
same picture as a frozen working one, so it would cost you the one distinction
the badge is for; a still working frog is still not a dot, so that one stays.

**Motion is a setting rather than a media query, and “always” is the default.**
A 16px status indicator is in the class of a spinner, not the sliding parallax
`prefers-reduced-motion` exists to stop, and frozen on one frame it says exactly
as much as the dot it replaced: nothing. So the preference is offered instead of
obeyed — which is also the only way a machine with Reduce Motion switched on
system-wide gets to have this feature at all. Pick **Follow system** if you would
rather it went the other way.

#### Your own sprites

**Import…** beside the sheet dropdown takes a PNG and puts it in
`~/.config/kururu/sheets`, then selects it. Dropping a PNG in that directory
yourself does exactly the same thing — the directory is the mechanism and the
button is a door onto it. **Remove** appears for sheets you brought, never for
the one that ships.

Any grid of frames will do: set **Cell** to your frame size and drag out the run
you want. A plain horizontal strip is a sheet one row tall, so that works too.

**PNG, and only PNG.** The trim is measured off the alpha channel, so the format
has to have one. Aseprite's own files are not supported and are not worth
supporting — *File → Export Sprite Sheet* gives you a PNG laid out as exactly the
grid this picker wants, which is one step and the thing you would export anyway.

An import is checked on the way in — a real PNG, under a megabyte, under a name
that is a name — because it is a client asking the server to write a file into
your config directory, and kururu is reachable from the tailnet. A file you put
in the directory *yourself* is served exactly as you left it: if it turns out not
to be a PNG it fails in the browser and the row falls back to the dot, because
quietly substituting the frog would read as the feature being broken rather than
as the file being wrong.

A sheet left at the old `~/.config/kururu/mascot.png` is moved into the directory
on the next start rather than being stranded beside it.

They are written to `~/.config/kururu/mascot.json`. A file from the version of
kururu that could only hold one mascot becomes the first entry in the list rather
than being thrown away.

#### A mascot per workspace

Right-click a workspace in the sidebar → **Mascot…**, the same place its colour
lives. Each option is drawn animating, because "Michi" means nothing until you
have seen it hop.

**Default** is an option in that list rather than a way of dismissing it: it is a
choice with a consequence, namely that moving the ★ in Settings later moves this
workspace too. Picking a specific one opts out of that.

Deleting a mascot a workspace was using needs no clean-up — an id that names
nothing draws the default, which is the same answer as never having picked.

#### The keys

Every action after the prefix, with the keys that reach it. Click **+** and press
the key you want; click a key to unbind it. Taking a key another action had is
allowed — it says which one it came from, and the row it left is on the same
screen — because a key means exactly one thing, while an action can have several.

What is stored is the **difference** from the defaults, in
`~/.config/kururu/keys.json`. So a key you never touched follows kururu's table
as it changes, and an action added in a later version arrives with its key
working rather than unbound. **Reset to defaults** deletes the differences.

Two keys are not up for grabs. `1`–`9` jump to workspaces by number, and a
binding there would take one out of reach with nothing on screen to say where it
went. And **ctrl+a itself** stays ctrl+a, because it is what you need in order to
fix a keyboard you have broken — as is the cog, which is a mouse away whatever
you have done to the keys.

The help overlay (`C-a ?`) prints your keymap rather than a list beside it, so it
cannot end up documenting a key you moved.

### Selecting text out of an agent

Hold **⌥ (option)** and drag. Agents turn on every mouse mode there is, so from
then on a plain drag is an escape sequence sent to the agent rather than a
selection — option is what says "this one is mine".

### Dropping a file in

Drag a file from the Finder onto a terminal and its path is typed in, escaped,
with a space after it — what every terminal has done for thirty years, and how
you hand a screenshot to an agent that only takes text. It goes to the pane you
dropped on, not the focused one.

A file dropped anywhere else does nothing, deliberately: a web page's default
answer to a dropped file is to navigate to it, and this page is the whole
application.

### When a terminal does something inexplicable

Kururu keeps the last 128KB of each open terminal's raw stream, interleaved with
what it did to that terminal — every resize, every time a pane opened it, every
backlog it replayed. Ordering is what most terminal bugs turn out to be about,
and a screenshot shows what was drawn rather than what was said.

```sh
curl 'http://127.0.0.1:7717/api/record?agent=a7&tail=40'     # the last 40 entries
curl 'http://127.0.0.1:7717/api/record?agent=a7' > tape.txt  # all of it
```

Escape sequences come out spelled (`\e[?1049h`), so printing one cannot repaint
the screen you are reading it on. It records only terminals that are open in a
pane, it is forgotten when the server restarts, and `KURURU_RECORD=0` turns it
off.

### Dragging

Grab a **tab** to move one terminal. Grab the **tab strip itself** — the bit
beside the tabs, which is the pane's title bar — to move the whole pane.

| drag | drop on | what happens |
|---|---|---|
| a tab | its own strip | reorders |
| a tab | another pane's strip | moves there, at the position you dropped it |
| a tab | the middle of a pane | joins that pane |
| a tab | a pane's left / right / top / bottom quarter | splits it that way, tab in the new half |
| a tab, or an agent from the sidebar | a workspace row | moves to that workspace |
| **a pane** | the middle of another pane | **the two swap places**, contents and all |
| **a pane** | another pane's edge | moves to that side of it |
| **a pane** | another pane's tab strip | pours its tabs in and disappears |
| a workspace row | another workspace row | reorders the list |

So: two agents on the left, a terminal on the right — grab the left pane's strip,
drop it on the right pane, and they trade places. Dropping it on the right pane's
*right* edge does the same thing the long way round, and neither one nests the
tree deeper than it was.

A pane you drag the last tab out of closes itself. A pane you split and left
empty on purpose stays. Moving a terminal never stops it.

`⌘W` and `⌘R` are left to Electron on purpose: `⌘W` closes the window, which is
the gesture that shuts it while the agents keep working.

**View** has both reloads, because they are not two strengths of the same thing.
`⌘R` **Reload Window** redraws the UI from the same server. `⇧⌘R` **Restart
Server** throws the server process away and forks a new one, which is how a
change to the protocol, the layout or the discovery gets picked up. The agents
are in neither — they live in the pty host, one process over, and watch both
happen without noticing.

## Shape

```
shared/     protocol types: the model, the split tree, the browser↔server wire
server/     Node. Agent host (ptys + emulators), the arrangement and its
            snapshot, dev-server discovery, preview proxy, file API.
            Runs inside the app, not beside it.
web/        React + Vite. Draws the server's layout; owns the keymap
desktop/    Electron main + preload, and the esbuild step for the server
```

See [PLAN.md](./PLAN.md) for why it is arranged this way.
