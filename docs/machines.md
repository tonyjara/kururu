# Machines

The user's other computers — a VPS, a PC on the same tailnet — as kururu sees
them: three gauges in the sidebar, a **Shell** for each in Settings → Machines, and workspaces whose
terminals — shells, nvim, agents — open on one. What is deliberately *not* here
yet is at the bottom.

## A machine is an ssh host

Settings → Connections → **Machines** adds one by naming an ssh destination — an
alias from `~/.ssh/config` or `user@host`, held to `validHost`'s grammar
because it lands in an argv. The list is `~/.config/kururu/vps.json`, named for
when every entry was a VPS; renaming the file would have bought a migration
forever for a word nobody sees.

The gauges are `server/src/machines.ts`: one fixed, read-only script over the
user's own ssh, `BatchMode` so nothing ever waits on a prompt, one warm
`ControlMaster` connection per host. The argument for ssh over an agent on the
box is at the top of `shared/machines.ts`. A desktop answers the same three
questions a VPS does — CPU, memory, the root filesystem — so nothing about the
gauges changed when the entry stopped being a VPS. `panel` is optional and only
means something for a box with a dashboard.

**Tailscale SSH.** A machine running `tailscale up --ssh` answers port 22 on its
tailnet address before sshd does and authenticates by tailnet identity, so
`authorized_keys` and `ssh-copy-id` do nothing on that address. In *check* mode
it periodically wants a browser visit: the poll then fails with that in its
error, and the machine's **Shell** in Settings → Machines is where you do the visit (it was a button on the sidebar's row until 2026-10-18). kururu never runs
`tailscale`.

## A shell on one is a command line

The pty host runs whatever command line it is handed under the login shell, so
a shell on another machine is a *command* in an ordinary pty — and the host,
the one process that costs every agent to change, never learns there is such a
thing as a remote. `remoteShellCommand` builds the line and `remoteShellOf`
reads it back out of `AgentSnapshot.command`, which is the record: the server
forgets everything on a restart and the host never does. Three readers:

- `agentLabel` names the tab after the host instead of a fragment of script —
  or, for an agent, after its CLI.
- `tabCwd` returns nothing for it, and `openTerminal` records no pane cwd and
  allows no file root — the `~` ssh runs in here is not a project, and without
  this a pinned workspace's tree would quietly become the user's home directory.
- `endRemote` ends its tmux session when the tab is closed.

The line is a loop in `/bin/sh` around `ssh -t`, so what it means does not
depend on the user's login shell. It exits with ssh when ssh exits on purpose;
on ssh's 255 it either reattaches by itself (a session tab that had been
connected for twelve seconds — not ten, because `ConnectTimeout=10` means a
host that never answers also takes about ten seconds to fail, and the margin
is what stops that failure from being misread as a connection that briefly
got in) or waits for Enter (everything else) — because the server reaps an
ended terminal at once, and a tab that vanished would take "connection
refused" with it. Either way, three failures in a row without a successful
connection between them and the loop stops offering to retry: it says the
machine hasn't answered and waits for Enter (or Ctrl-D, or the tab just being
closed) rather than trying forever on a host that is staying down. A
connection that does get in resets the count, even if it drops again right
after.

The sidebar's button is a plain `ssh -t <host>`. A pinned workspace's shells,
and the harness's, carry a session.

## Pinned workspaces

`Workspace.machine` is `{ machineId, dir }` or null. Set in Settings → General
→ Workspaces, **Runs on**; persisted with the layout as a preference, like the
mascot; read by `adoptPin`; removed from every workspace when its machine is.

What goes to the machine is **every terminal the workspace opens for itself**:

- the plain shell — the tab strip's terminal, `C-a T`, the terminal a split
  opens (`pinnedShell`: no command, no directory, no `local`);
- the + menu's **Nvim**, **LazyGit** and **every launcher**, and a workspace
  row's **Open LazyGit** — the `new-tab` handler asks `pinOf` and builds the
  remote line itself. LazyGit is typed behind `LAZYGIT_CHECK`
  (`shared/lazygit.ts`), the first half of the agents' check: no `lazygit` on
  the session shell's PATH is said in the tab, and nothing else is typed. A
  clean quit types `exit` after it, so the session ends and the tab with it, as
  `q` does on this Mac;
- a **card's run** and its resume (below);
- the harness's `open_shell` and `start_agent`, unless told `machine: local`.

What stays here is anything that names a place on this disk or is about this
Mac: a terminal opened with a directory (the file tree's "open here", a
worktree), a card's dev server, the harness's own session. The + menu in a
pinned workspace is the machine's menu: a heading says where, and every row
under it opens there. There is no "on this Mac" row any more — a local shell
is a workspace that is not pinned.

Remote, the line runs `REMOTE_SCRIPT` under `sh -c`: `~` expanded there, a
missing folder said and home used, then the named session made detached if it
does not exist, the harness's command typed into it with `send-keys -l`, and
attached. The folder rides in single quotes through whatever the remote login
shell is (bash, zsh, fish), which is why `validRemoteDir` is a grammar with no
quote, `$` or backslash in it rather than an escape; the command to type is
base64'd, the one encoding every layer leaves alone. `machines.test.ts` runs the
real line through zsh and bash against a fake `ssh` and `tmux` to prove it.

## Sessions, and what ends them

A session is `kururu-<workspace>-<n>`, `n` the lowest slot no tab holds — across
every machine, so two aliases for one box cannot collide — and not one being
ended or one handed to a spawn still in flight. Ending it is `tmux kill-session
-t '=name'`: exact match, quoted against zsh's `=cmd`.

A line that *types* something — an agent, nvim, LazyGit, the harness's `run` — also
skips every slot the machine itself reports (`sessionsOn`, one `tmux ls` over
the warm connection). `REMOTE_SCRIPT` attaches to a session that exists and
types nothing, which is right for a reconnect and wrong for "start Claude":
after a pty-host restart the old sessions outlive their tabs, and without the
listing the new agent would land in one of them with its prompt dropped. A
plain shell does not ask, because reattaching what was left in its slot is
the point of it.

| what happens | the session |
|---|---|
| the tab is closed, its pane or workspace deleted, the harness's `stop_agent` | ended |
| `exit` at its prompt | ends itself; the tab goes |
| a detach | stays; the tab goes. The next shell in that slot reattaches |
| the connection drops | stays; the tab reattaches every 3 s until it is back, three tries fail in a row, or Ctrl-C |
| the pty host restarts | stays. Tabs are not restored, but the first shells opened in the workspace again take slots 1, 2… and find them |

## Copying out of one

The machine has no Mac clipboard to copy into, so a copy made there comes back
the only way it can: as `OSC 52` down the ssh connection, which the pane writes
to this Mac's clipboard ([terminals](terminals.md#the-clipboard)).

- **A drag is tmux's** when tmux has `mouse on` — many a tmux.conf does.
  tmux copies on release and sends the copy out as `OSC 52` under its default
  `set-clipboard external`, because the pty's `TERM=xterm-256color` is in its
  default `terminal-features` as `clipboard`. **Shift**+drag is kururu's own
  selection instead, which copies on release and to ⌘C.
- **Claude Code inside tmux** (2.1) copies three ways at once: `tmux load-buffer -w`,
  a bare `OSC 52`, and one wrapped in tmux's passthrough (`ESC P tmux; …`). The
  wrapped one is dropped unless the pane allows passthrough, so `REMOTE_SCRIPT`
  sets `allow-passthrough on` on the session's window and an
  `after-new-window` hook on the session that does the same for any window
  opened in it later — on every attach, so a session made before this is put
  right by the next reconnect. Both are scoped to kururu's session; the
  machine's tmux.conf is never written.
- **`set-clipboard` is left alone.** It is a server option: `set -t <session>`
  is accepted and applied to the whole tmux server, every session of the
  user's included. `external` already carries tmux's own copies and
  `load-buffer -w`; only a program's bare `OSC 52` needs `on` — nvim's `osc52`
  provider is the one that matters — and that is a line for the user's own
  config, which on many boxes already says it.

## Agents on a machine

An agent there is the session line with two differences, both in
`shared/machines.ts`:

- **The CLI's name is the last word on the line** (`'claude'`), after
  everything `remoteShellOf` read before agents went to machines, so older and
  newer servers read each other's tabs. It is what names the tab and what
  tells the screen reader to read it.
- **What is typed is `AGENT_CHECK`, then `&&`, then the launcher's line**
  (`remoteAgentRun`). The check runs in the session's interactive shell — the
  one whose PATH has `~/.local/bin`, nvm and bun on it, which a
  non-interactive ssh does not read — and asks `command -v`, then the CLI
  itself (`claude auth status`, `codex login status`). Only an explicit "not
  logged in" is a no; anything else lets the agent start and say what it
  says. The status subcommand is asked only after the CLI's `--help` shows it
  has one, because an old Claude Code or Codex reads `auth status` as a
  prompt. When the answer is no, the tab prints two `kururu:` lines saying
  which and what to run, leaves the shell at its prompt, and is reported
  `blocked` with that sentence as its activity.

The launcher's line goes without the hook settings a local agent gets — they
name files on this Mac — and a profile's own login directory does not follow
it: `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are environment on this side of the
ssh. An agent on a machine is signed in as whoever is signed in there.

Nor does it get kururu's web tools (`kururu_web`): they are served on this
Mac's loopback, and nothing on the machine can reach that address. An agent
there has no `kururu_web` tools rather than tools that fail — see
[web](web.md#agents-on-a-machine) for what making it work would take.

`REMOTE_SCRIPT` turns `set-titles` on for an agent's session, scoped with `-t
"=$S:"` (the bare `=$S` that `has-session` takes is refused by `set-option`),
so Claude's own window title — its summary of the task — reaches the tab the
way a local agent's does. A shell's session is left alone.

## Status, read off the screen

A remote agent's hooks post to a port on the machine where nothing listens,
and its bytes are tmux redrawing a pane, so neither of the ways a local
agent's status is known works. `server/src/onscreen.ts` reads each remote
agent's screen every two seconds (the host's backlog, rendered the way
`read_agent` renders it) and `shared/onscreen.ts` turns it into the reports a
hook would have sent, through `host.report` — so the dot, notifications, the
card's run, the harness's `[kururu]` messages and `wait_agent` all work
unchanged:

| on the screen, in the last rows that say anything | reported |
|---|---|
| `esc to interrupt` (Claude's footer, Codex's Working line), or Claude's spinner with its clock | `working` |
| `Do you want to …?` / `Would you like to …?` over a list with `❯ 1.` / `› 1.` marked, or Claude's question tool (`Enter to select`) | `blocked`, the question as activity |
| the check's `kururu: … is not installed / not logged in on …`, or the loop's `kururu: … has not answered in 3 tries running` | `blocked`, that sentence as activity |
| none of these, twice running, after `working` | `done` |

It counts rows with something on them, never rows of the screen: a fresh agent
draws at the top of a tall pane, with tmux's status line far below it.

**What is missing, and the tab says so** (a chip with the machine's name, and
a tooltip): done and blocked arrive a poll or two late; a prompt it does not
recognise is never `blocked`; there is no transcript, no last reply, no
context ring, and nothing records what the agent was asked. The harness's
`read_agent` defaults to the screen for these, and its role says to read
rather than wait.

**Forwarding the hooks is the later step**, and most of it is plumbing that
already exists: `ssh -R` a port (or a unix socket) on the machine back to
`127.0.0.1:7717`, pass `KURURU_AGENT_ID` and `KURURU_PORT` in the typed line,
and hand the agent `--settings` naming a hook script that lives on the machine
— the one thing kururu would have to put there, which is why it is not done
yet. With that, `onscreen.ts` would stand down for any agent that has reported,
the way the byte heuristic does today. The transcript would still be on the
machine, so `read_agent source=transcript` would need a read over ssh of its
own.

## Card runs

In a pinned workspace the robot runs the card on the machine, in the pin's
folder: the card's prompt, its `--session-id`, no hooks. Two exceptions, both
because a worktree is git's on *this* disk: a card with a worktree still
standing here runs here, where its work is; and a card that asks for a new
worktree is refused with a message rather than run on the machine in the main
checkout. A card's dev server only starts with a worktree, so it never starts
for a remote run. The run keeps no directory (`cwd: null`), so its resume goes
back to the machine through the pin; a run that started here resumes here.

A card's agent on a machine is put to sleep when idle like any other
([layout](layout.md#idle-card-agents)), with its facts gathered there: its
screen is the tab's, its conversation is read on the machine by id over the
same `BatchMode` ssh (`sessionTailOn`: `tail -c` of Claude's transcript under
any project, or of Codex's rollout under any day), and a Codex run's id is
found there too (`codexRolloutsOn`: each rollout touched since the run began,
its first line and first message cut short). Both are constants with a UUID or
a whole number in them, run under `sh -c` in single quotes so that the
account's shell — fish included — does not read them, and so they hold no
quote and no backslash. What a machine cannot show is the processes under the
agent, so a command still running there does not keep it awake; and a machine
that cannot be reached keeps its agents awake, since their conversations cannot
be checked. Ending one is the close button's: `tmux kill-session`.

## The harness

`open_shell` and `start_agent` take a workspace, optionally a machine (by
name, host or id, or `local`) and a folder; `open_shell` also a command.
Without a machine they follow the workspace's pin. On a machine
`open_shell`'s command goes in through `send-keys`; on this Mac it waits for
the first prompt and is typed like any other harness message. `start_agent`
on a machine is the menu's agent line with the prompt on it, and its result
says the status will come off the screen. `kururu_status` lists the machines
and each workspace's pin, and marks each remote agent "status read off its
screen, no transcript". A harness started before this has the old role and
tool list until it is reopened.

## Not yet

- **Hook reports from a machine** — see above.
- **The web tools for an agent on a machine** — a reverse tunnel per link to a
  listener that serves only the web tools; see [web](web.md#agents-on-a-machine).
- **The file tree, reader, worktrees, database scan and dev-server discovery**
  on a machine — each reads a disk or a process table kururu does not have
  there. The pages say so rather than drawing nothing.
- **Restoring tabs on a machine** after a pty-host restart. The sessions
  survive, agents included, and a plain shell opened in the workspace
  reattaches by slot; an agent opened from the menu takes a fresh slot
  instead (see Sessions), so a surviving agent session is found by `tmux ls`
  on the machine, or by a plain shell landing in its slot.
