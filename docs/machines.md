# Machines

The user's other computers — a VPS, a PC on the same tailnet — as kururu sees
them: three gauges in the sidebar, a shell button on each, and workspaces whose
shells open on one. Step one of a longer road; what is deliberately *not* here
yet is at the bottom.

## A machine is an ssh host

Settings → Monitors → **Machines** adds one by naming an ssh destination — an
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
error, and the row's shell button is where you do the visit. kururu never runs
`tailscale`.

## A shell on one is a command line

The pty host runs whatever command line it is handed under the login shell, so
a shell on another machine is a *command* in an ordinary pty — and the host,
the one process that costs every agent to change, never learns there is such a
thing as a remote. `remoteShellCommand` builds the line and `remoteShellOf`
reads it back out of `AgentSnapshot.command`, which is the record: the server
forgets everything on a restart and the host never does. Three readers:

- `agentLabel` names the tab after the host instead of a fragment of script.
- `tabCwd` returns nothing for it, and `openTerminal` records no pane cwd and
  allows no file root — the `~` ssh runs in here is not a project, and without
  this a pinned workspace's tree would quietly become the user's home directory.
- `endRemote` ends its tmux session when the tab is closed.

The line is a loop in `/bin/sh` around `ssh -t`, so what it means does not
depend on the user's login shell. It exits with ssh when ssh exits on purpose;
on ssh's 255 it either reattaches by itself (a session tab that had been
connected for ten seconds) or waits for Enter (everything else) — because the
server reaps an ended terminal at once, and a tab that vanished would take
"connection refused" with it.

The sidebar's button is a plain `ssh -t <host>`. A pinned workspace's shells,
and the harness's, carry a session.

## Pinned workspaces

`Workspace.machine` is `{ machineId, dir }` or null. Set in Settings → General
→ Workspaces, **Runs on**; persisted with the layout as a preference, like the
colour; read by `adoptPin`; removed from every workspace when its machine is.

What goes to the machine is a **plain shell** and nothing else: the tab strip's
terminal, `C-a T`, the terminal a split opens — the `openTerminal` calls with no
command, no directory and no `local`. A command means somebody built a line
for a reason (an agent, nvim, a dev server); a directory means a place on this
disk (a worktree, the file tree). The + menu adds **Terminal on this Mac**, and
marks the rows that stay here.

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

| what happens | the session |
|---|---|
| the tab is closed, its pane or workspace deleted, the harness's `stop_agent` | ended |
| `exit` at its prompt | ends itself; the tab goes |
| a detach | stays; the tab goes. The next shell in that slot reattaches |
| the connection drops | stays; the tab reattaches every 3 s until it is back or Ctrl-C |
| the pty host restarts | stays. Tabs are not restored, but the first shells opened in the workspace again take slots 1, 2… and find them |

## Copying out of one

The machine has no Mac clipboard to copy into, so a copy made there comes back
the only way it can: as `OSC 52` down the ssh connection, which the pane writes
to this Mac's clipboard ([terminals](terminals.md#the-clipboard)).

- **A drag is tmux's** when tmux has `mouse on` — Omarchy's tmux.conf does.
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
  config, which on omarchy1 already says it.

## The harness

`open_shell` takes a workspace, optionally a machine (by name, host or id, or
`local`), a folder and a command. Without a machine it follows the workspace's
pin. On a machine the command goes in through `send-keys`; on this Mac it waits
for the first prompt and is typed like any other harness message.
`kururu_status` lists the machines and each workspace's pin, and the role says
to run only what the user asked. A harness started before this has the old
role and tool list until it is reopened.

## Not yet

No agents, file tree, reader, worktrees, database scan or dev-server discovery
on a machine — each reads a disk or a process table kururu does not have there.
The pages say so rather than drawing nothing. Tabs on a machine are not
restored after a pty-host restart (the sessions are; see above).
