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
- **Keeps them.** Closing the window leaves them running, and reloading it costs
  a repaint. So does restarting the server — the ptys live in a host process of
  their own, so `C-a B` puts kururu back on current code with every agent, its
  scrollback and your layout intact. Only quitting stops them, and it asks first.

Under the surface and waiting for a pane to live in: dev-server discovery, the
preview proxy that lets a phone reach `localhost`, and a traversal-safe file API.
See [PLAN.md](./PLAN.md).

## Running it

```sh
bun install

# The whole thing. Starts the server, starts vite, opens the window.
bun run dev:desktop
```

That is the only command you need: there is no server to start in another
terminal and nothing to have running first.

Without the window, if you only want the phone to reach it:

```sh
bun run start            # builds, then serves everything on :7717
```

Then `http://localhost:7717`.

**Closing the window does not stop your agents** — they keep working and the
phone keeps its connection. Quitting does stop them, and asks first.

### From your phone

There is no auth in kururu and there does not need to be — it is meant to be
reached over a tailnet, never off one:

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
| `R` `B` | reload the window / restart the server (agents keep running) |
| `?` | these keys |

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

### Replacing the mascot

The frog is a file, and it is yours to change. Drop a PNG at
`~/.config/kururu/mascot.png` and that is the mascot; delete it and the frog is
back. `KURURU_MASCOT` names one outright if you would rather not move anything.

The whole contract is **a horizontal strip of square frames**:

```
┌────┬────┬────┬────┐
│ 1  │ 2  │ 3  │ 4  │   84 × 21  →  four 21px frames
└────┴────┴────┴────┘
```

There is no manifest and no frame size to declare, because a strip already says
both — the number of frames is its width over its height, and the browser reads
that off the image it has loaded anyway. Frames are scaled into a 16px box, so a
sprite drawn at 32 is welcome and will not make the tab strip taller. One loop
takes the same length of time however many frames are in it, so a replacement
keeps the cadence rather than running at whatever speed its frame count implies.

Nothing validates your file beyond refusing to serve something over a megabyte.
If it is not a PNG, or not a strip, the row falls back to the dot rather than
kururu quietly putting the frog back — a substitution would read as the feature
being broken instead of as the file being wrong.

`assets/mascots/` has the frog in six palettes, already cut:

```sh
cp assets/mascots/frog-purple.png ~/.config/kururu/mascot.png   # then reload
```

They were cut out of the sheets in `assets/spritesheets/` by
`tools/cut-mascot.py`, which is there for when you want a different animation or
a different facing — the sheets hold idle, croak, jump, hop and shock across
eight directions, and `guide.png` labels which columns are which.

```sh
python3 tools/cut-mascot.py --anim hop --row 2    # needs Pillow
```

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
