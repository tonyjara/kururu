# Linux: a child kururu

A **child** is kururu's server on another PC: the same server, the same pty
host and the same web app, built from the same checkout. It has no window and
no voice, runs as a systemd user unit, and is reached by a phone over the
tailnet. It keeps its agents working while the Mac's lid is closed. A child
works alone, and can be paired with the Mac (phase 2): the Mac then draws its
workspaces and agents, counts its asks, and backs up its boards. One drawer for
every Kuru, secrets lent from the Mac and one Telegram are phases 3–6 of
[the plan](plans/kururu-parent-child.md#phases-as-cards).

This file covers the `kururu` command, its wizard and doctor, pairing from the
box's side, and the skill that walks an agent through them. What the server itself does
differently on Linux (the host as a systemd unit, `KURURU_BIND=tailscale`, the
loopback token, `ss` in place of `lsof`) is in
[architecture](architecture.md#the-link) and
[access](architecture.md#access).

## Setting one up

On the box, from nothing:

```sh
mise use -g node@26 bun@latest              # or the distribution's node 24+ and bun
git clone https://github.com/tonyjara/kururu.git ~/kururu
cd ~/kururu && node tools/kururu.mjs child setup
```

Or ask an agent on the box: *"use the kururu skill to set up a child"*. The
skill is `.claude/skills/kururu-child/` in the repository. On a box with no
clone yet, so that Claude Code can find the skill, install it on its own first:

```sh
curl -fsSL --create-dirs -o ~/.claude/skills/kururu-child/SKILL.md \
  https://raw.githubusercontent.com/tonyjara/kururu/main/.claude/skills/kururu-child/SKILL.md
```

The first run links `tools/kururu.mjs` as `~/.local/bin/kururu`, so after that
the command is just `kururu`.

## The command

`tools/kururu.mjs` is plain node with no dependencies, like `server/run.mjs`.
That is because the first time it runs is before `bun install`.

| | |
|---|---|
| `kururu child setup` | The wizard. It walks the checks in order, fixes what it can as this user, guides what it cannot, and checks again before moving on. `--dry-run` says what it would do |
| `kururu child doctor` | The same checks, read-only: a ✓/✗/– table with the fix under each ✗, the tail of `lifecycle.log`, and exit 1 on any ✗ |
| `kururu child update` | `git pull --ff-only`, then `bun install`, `bun run build` and a restart of the server, but only when the pull brought something; then the doctor. It refuses a dirty tree |
| `kururu child status` | The service's state, then `server/status.mjs`, which names the host's unit |
| `kururu child restart-host` | A new pty host, through the server's `POST /api/host/restart`. It ends every terminal the host holds, says how many, and asks. Default no; `--yes` without a terminal |
| `kururu child join <address> <code>` | Joins the Mac. The Mac shows this exact command, ready to copy, in Settings → Nodes → Add a computer. It pairs, waits up to half a minute for the link, and says how it went |
| `kururu share` | The phone's link and QR code, which is `bun run share` for this instance. `--url`, `--rotate` |

`doctor`, `update`, `status` and `join` answer without `child` too. The old
`kururu child code` only says where pairing starts now.

### The checks, in order

One list, `tools/kururu/checks.mjs`. The wizard repairs from it, and the doctor
only reads it, so the two cannot disagree about what is right.

| step | checks | the wizard |
|---|---|---|
| node and bun | node ≥ 24 (for `node:sqlite`) and bun ≥ 1.2 on this PATH; the unit's node still there | guides: `mise use -g node@26 bun@latest` |
| the checkout | a git checkout; `pty.node` built; `desktop/dist` and `web/dist` newer than their sources | `bun install --frozen-lockfile` (Electron's download skipped) and `bun run build` |
| the command | `~/.local/bin/kururu` links to this checkout | links it, and asks before moving a link that points elsewhere; never touches a file it did not write |
| the user | which account runs the child, and what it can reach: sudo, docker, a home others can read | asks: this account or a dedicated one. For dedicated it prints `useradd` and `enable-linger` for root to run |
| linger | `loginctl show-user` says `Linger=yes` | `loginctl enable-linger`, which most systems allow a user for themselves; otherwise it prints the `sudo` line |
| Claude Code | `claude` on the PATH, `claude auth status` signed in to a subscription; Codex's `login status` if wanted | asks whether Codex is wanted. With a terminal, runs `claude auth login --claudeai`; without one, prints it |
| no API key | the keys and switches that outrank the login, in this shell, the user manager, the rc files, `environment.d`, `/etc/environment`, the unit, Claude's settings and Claude's stored key | guides: names file and line, never the value |
| the tailnet | a 100.64/10 address on an interface; the port free or already kururu's | guides: `sudo tailscale up` is the user's, never the wizard's |
| the service | the unit as this checkout would write it, enabled, active; `/api/health` on the tailnet address; the gate refusing loopback and the tailnet without the token, and every LAN address outright; the host in a `kururu-ptyhost-…` unit and current | writes the unit, `daemon-reload`, enables, starts or restarts, and waits for health |
| the phone | a device on the tailnet has connected since the server started (`clients.remoteAt` in `/api/health`) | with a terminal: shows the QR and waits for the phone. Without one: tells the person to run `kururu share` in their own terminal |
| pairing | `nodes` in `/api/health`: ✓ paired and the link to the Mac up; – not paired, which is a child working as built, or paired with the Mac away, as it is while the lid is shut; ✗ paired and the Mac never reached since this server started | with a terminal, asks for the Mac's join command (Enter skips, and the skip is kept); `--join="<address> <code>"` gives it. Without either it says how to pair and moves on, since pairing is optional |

The secrets and leading rows arrive with phases 4 and 5.

### Asking, and stopping

With a terminal, the wizard asks and waits. Without one (an agent's tool, a
pipe, `--no-input`) it never waits. It stops, and the exit status says why:

- **3**: a question. The message names the flag that answers it:
  `--account=this|dedicated`, `--codex=yes|no`, `--yes`
  (write over a differing unit and restart onto it), `--relink`.
- **4**: a step only the person can do: sign in, `sudo`, `tailscale up`,
  remove a key. The message is the exact line to type.
- **1**: a step still failed after its repair. **2**: a bad flag.

Every run starts from the top and leaves alone what is done. Running it again
is always the next step, and a run on a working child ends with *"Nothing to
change: this child was already set up."* That is why the unit text is built
rather than copied. `PATH` is assembled from node's, bun's, `~/.local/bin` and
mise's shims, not taken from the shell the wizard ran in. If it were taken
from the shell, an ssh session and a tmux pane would write different units,
and every second run would rewrite one.

The answers are kept in `~/.config/kururu/child.json`: the account, Codex,
a skipped pairing, the port, the unit's name and the link's directory. Later commands find the child
without flags.

### What it refuses

It never runs `tailscale` (CLAUDE.md rule 4), never runs `sudo`, and never
prints a token or a key. The one exception is `kururu share`, whose whole job
is the link, and which an agent is told never to run through its own tool: the
link is a key to a shell on the box, and a tool's output is a transcript.

## Pairing with the Mac

Paired, the Mac draws this box's workspaces and agents under its name in the
sidebar, counts its asks in the Needs tray, pulls its boards into the Mac's
backup under `nodes/<name>/`, and its picker and menu-bar frog offer "Open
<name>". This box's own page, in turn, says when the Mac went away. Nothing
structural is copied either way. The design is
[the plan's](plans/kururu-parent-child.md#nodes-ranks-and-the-roster); this is
the box's half.

Pairing starts on the Mac, and on this box it is one command:

1. On the Mac, open Settings → Nodes and press **Add a computer**, then
   **Show the command**.
2. Copy the command it shows and run it here. It looks like
   `kururu child join 100.64.0.1:7717 ABCD-EFGH`: the Mac's address, and a
   code that works once, for ten minutes.
3. The Mac's page says *"omarchy joined"* by itself, and the command here says
   *"Linked."*

If this box has no kururu yet, the same page says what to run first: the clone
and `node tools/kururu.mjs child setup`, or ask an agent here to use the
kururu skill. The wizard's last step asks for the join command, so it can be
pasted there. The Mac must be shared (its Share dialog), since this box
dials it; the page says so and keeps the button off until it is.

The name the Mac gives this box is its hostname, and can be changed there.
The address the Mac records is the one the join came from, so nobody types
an address. `/api/nodes/join` on the Mac answers only the tailnet, with no
proxy header and no page in between, and five wrong codes burn the one
showing. This box sends the Mac its keys and its share token, which the Mac
keeps for its QR code and "Open" link, and takes back the roster the Mac
signed. A child whose Mac is asleep shows a – in the doctor's pairing row,
with how long, and the link comes back by itself when the Mac does.

## The unit

`~/.config/systemd/user/kururu.service`:

```ini
[Service]
WorkingDirectory=/home/<user>/kururu
Environment=KURURU_BIND=tailscale
Environment=KURURU_LOOPBACK_TOKEN=1
Environment=PATH=…
ExecStartPre=-…/node/26/bin/node …/tools/kururu.mjs child wait-tailnet
ExecStart=…/node/26/bin/node …/server/run.mjs --no-build
Restart=on-failure
KillMode=process
```

- **Node by mise's own name for it**, `installs/node/26/bin/node`. A service's
  PATH is not the login shell's, so mise's shims would not be found. Its link
  also follows the next 26.x, where the versioned directory behind it is
  deleted by a `mise prune`. With no mise it is the real path of the node that
  ran the wizard.
- **`--no-build`**: the wizard and `update` build, so a restart is only a
  restart and not a build that a half-pulled tree could fail.
- **`wait-tailnet`** waits up to 90 s for a tailnet address. At boot the user
  manager can start before `tailscaled` has one, and a server started then
  binds loopback until somebody restarts it. The `-` lets a box with no
  tailnet start anyway; the server then says in `lifecycle.log` why it is on
  loopback.
- **`KillMode=process`**: stopping the unit signals the runner, which stops
  its server. The pty host is a transient unit of its own
  (`kururu-ptyhost-<label>-<n>`), so the server's unit never reaches an agent.

## What restarting costs on a child

| you run | it costs |
|---|---|
| `systemctl --user restart kururu`, `kururu child update` | a reconnect, the same as `C-a B` on the Mac |
| `kururu child restart-host` | **every terminal the host holds**; it asks first |
| a reboot | every agent, as on any machine; the unit comes back by itself, because of linger |

## Testing the wizard on a real box

A throwaway instance is the wizard plus the isolation variables
([testing](testing.md#the-isolated-instance)). The unit carries those
variables. `--runtime` puts the unit in `$XDG_RUNTIME_DIR/systemd/user`, where
it is gone at the next boot. `--unit` and `--bin` keep it off the real names:

```sh
export KURURU_STATE_DIR=/tmp/k3/state KURURU_DATA_DIR=/tmp/k3/data \
  KURURU_CONFIG_DIR=/tmp/k3/config KURURU_HOST_SOCK=/tmp/k3/ptyhost.sock KURURU_AGENT_CWD=/tmp/k3/work
node tools/kururu.mjs child setup --port=7817 --unit=kururu-test --runtime --bin=/tmp/k3/bin
```

Clearing it up is `systemctl --user disable --now --runtime kururu-test`, then
`bun run kill-ptyhosts /tmp/k3/ptyhost.sock`, then removing `/tmp/k3`.

## Box notes

- **Omarchy's `claude` and `codex` are wrappers** that run `mise use -g` before
  every launch. The wizard's `claude --version` and `auth status` are
  launches, so they can update Claude through mise.
- **Tailscale SSH sets no `XDG_RUNTIME_DIR`.** The wizard supplies
  `/run/user/<uid>` for `systemctl --user`, as the server does for
  `systemd-run`.
- **A dedicated user's home** should be `0700`. The doctor's user row says
  when the home is readable by every user.
