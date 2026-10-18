---
name: kururu-child
description: Set up, check or update a child kururu, which is the kururu server running headless on a Linux box under systemd and reached by a phone over the tailnet. Use when the user says "use the kururu skill to set up a child", "set up a child", "make this box a kururu child", "kururu child", "run the kururu doctor", or "update the child", on a Linux machine. It covers the clone and node that come before the wizard, then runs `kururu child setup` with the user and relays each question and hand step.
---

# Setting up a child kururu

A child is the whole kururu server on another PC. It has no window and no
voice. It runs as a systemd user unit, binds to its tailnet address only, and
is opened from a phone. The full argument is `docs/linux.md`, and the plan is
`docs/plans/kururu-parent-child.md`.

The work is done by a wizard, `kururu child setup`, and not by you. It checks
each prerequisite in order, fixes what it can as this user, and stops when it
needs the person. Your job is three things:

1. Get the box to where the wizard can run: a node and a clone.
2. Run the wizard, and relay every question and every hand step to the user,
   word for word.
3. Finish with the doctor.

Do not do the wizard's steps by hand, even when you know how. If you write the
unit yourself, the wizard and the doctor no longer agree about what is right.

## What you never do

These are the wizard's refusals, and they are yours too:

- **Never run `tailscale`.** Putting a machine on the tailnet is the user's
  decision (CLAUDE.md rule 4). When the wizard says the box is not on the
  tailnet, the user runs `sudo tailscale up` themselves.
- **Never run `sudo`.** Not for linger, not for a user, not for a package. Print
  the line, and the user types it.
- **Never read or show the token.** Do not `cat` `access.json`. Do not run
  `kururu share`, or `bun run share`, through your own tool. The phone's link is
  a key to a shell on this box, and your tool output is a transcript. The user
  runs `kururu share` in a terminal of their own.
- **Never edit the user's rc files** or Claude's settings to remove an API key
  without asking first. The wizard says where each key is. Ask whether you
  should remove it, or whether they will.
- **Never install the service on a box the user did not ask about**, and never
  run `kururu child restart-host` without the user's yes. It ends every agent
  the host holds.

## Before the wizard: node and a clone

Check the box first:

```sh
uname -s; command -v systemctl loginctl
node --version; bun --version
ls -d ~/kururu 2>/dev/null
```

- **Not Linux, or no systemd:** stop. A child is a Linux box with a user
  systemd. On the Mac, the Mac is the parent.
- **No node 24 or newer, or no bun:** with mise, run
  `mise use -g node@26 bun@latest`. That needs no root, so you may run it once
  the user agrees. Without mise, the user installs node and bun from their
  distribution's packages, which is sudo and theirs to type.
- **No clone:** ask where the user wants it (default `~/kururu`), then
  `git clone https://github.com/tonyjara/kururu.git ~/kururu`. If this skill was
  installed on its own, before any clone, it now also exists in the clone.

## Running the wizard

Show the user the plan first, with nothing changed:

```sh
cd ~/kururu && node tools/kururu.mjs child setup --dry-run
```

Then run it for real. Your tool has no terminal, so the wizard never waits on
you. It stops instead, and the exit status says why:

| exit | meaning | what you do |
|---|---|---|
| 0 | done; the doctor's table follows | read the table to the user and go to *Finishing* |
| 1 | a step failed after its repair | relay the message, fix the cause with the user, run it again |
| 2 | a flag was wrong | correct the flag and run it again |
| 3 | a question | ask the user exactly the question printed, with its options, then run the same command with the flag it names |
| 4 | a step only the person can do | relay the exact line(s) for the user to type in a terminal of their own, wait for them to say it is done, then run it again |

Every run checks everything again from the top, and leaves alone what is
already done. So "run it again" is always safe, and is always the next step.

The questions, so you can explain them when asked:

- `--account=this|dedicated` decides which user runs the child. Its agents run
  with bypass permissions as that user. This account is simple on a box that is
  the user's alone. A dedicated user, with no sudo and no docker group, limits
  what an injected command can reach. If they choose dedicated, the wizard
  prints the `useradd` lines for them to run as root. The rest of the setup
  then happens as that user, in a session of its own, and this session is done.
- `--codex=yes|no` decides whether agents here run Codex too. If yes, the user
  signs it in with `codex login --device-auth`.
- `--yes` agrees to writing over a unit that differs from the one this
  checkout would write, and to restarting the server onto it. That costs any
  open phone a reconnect. No agent ends.
- `--claude=login|lent` is asked only when Claude Code is not signed in here.
  `login` is the box's own `/login`, and it is the one to recommend wherever a
  browser can be opened, even on a phone. `lent` is for a user with no browser
  anywhere: the wizard goes on without a login, and once the box is paired the
  Mac lends its own as a token (see *Secrets* below).
- `--join="<address> <code>"` pairs this child with the Mac, from the command
  the Mac shows. It is optional: a child works alone, and without it the
  wizard says how to pair and moves on. See *Pairing* below.
- `--port=N`, only when 7717 is taken by something that is not kururu.

The hand steps you will most likely relay:

- **Claude not signed in:** `claude auth login --claudeai`. It prints a link to
  open on any device. The user signs in to the same Claude account as the Mac
  and pastes the code back. Never an API key: it bills as API usage.
- **An API key found:** the wizard names each file and line, never the value.
- **Linger:** `sudo loginctl enable-linger <user>`, only when the wizard's own
  attempt was refused.
- **No tailnet address:** `sudo tailscale up`.
- **Pairing with the Mac:** see *Pairing*.
- **A token to be lent:** see *Secrets*.

## Pairing

Pairing starts on the Mac, and the user carries one command from the Mac to
you. When they want the box paired, tell them, in these words:

> On the Mac, open Settings → Nodes and press **Add a computer**, then
> **Show the command**. Copy the command it shows and paste it to me.

The command looks like `kururu child join 100.64.0.1:7717 ABCD-EFGH`: the
Mac's address and a code that works once, for ten minutes. It is not a secret
worth hiding from the user, since it pairs only this box and only once. Run it
as given. It says *"Joined mac as omarchy"* and then *"Linked."*, and the
Mac's page says *"omarchy joined"* by itself. During setup you can instead
pass it to the wizard: `kururu child setup --join="<address> <code>"`.

If it says the Mac is not showing a command, or the command expired, ask for a
new one: Add a computer again. If nothing answers at the address, the Mac is
asleep, not shared (its Share dialog), or not on the same tailnet; say which
the message names. The doctor's pairing row is ✓ once linked.

## Secrets

Once paired, the Mac can lend this box its keys: the self-hosted Firecrawl
(which gives the agents here `kururu_web`), the OpenRouter balance, a Claude
login as a token, the Telegram bot's token, a Codex login. Each is one switch
on the Mac, off until the user turns it on. Nothing is done here: tell them,

> On the Mac, open Settings → Nodes. Under **Secrets lent to <this box>**,
> switch on what this box should have.

For a Claude token, first: Settings → Agents → **Lend this login to a node**
on the Mac, which opens a tab running `claude setup-token`; they paste what it
prints into the field beside it. The doctor's `secrets` row lists what is held
by hint, and the setup's last step waits for the token when `--claude=lent`
was the answer. Never ask the user to paste a key or a token to you, or into
this box: the Mac sends it, sealed.

## Reading the Telegram chat

With the Mac's Telegram channel on, every paired kururu shares its one bot:
the Mac reads the chat while it is awake, and this box takes it over when
the Mac has been away for thirty seconds, then hands it back a minute after
the Mac returns. For that this box needs the bot's token lent — the Mac's
Settings → Nodes → <this box> → Secrets → **Telegram bot token** — and
Claude signed in here. The doctor's `leading` row says whether it is
eligible, why not, and whether it reads the chat now. It is optional and
never a ✗: a box that cannot still speaks in the chat through the Mac. Never
paste a bot token here: the bot and the accounts are the Mac's. The switch
is every node's — this box's Settings → Channels turns the chat on or off
for all of them, the Mac too, even while it is shut — once the token is
lent here.

## Finishing

When setup exits 0, the child is running. Then:

1. Ask the user to run `kururu share` **in a terminal of their own** (a new
   ssh session, or the box's own screen). It prints a QR code and the link.
   Ask them to scan it on the phone.
2. Run `kururu child doctor`. Every row should be ✓. The phone row says ✓ once
   a device on the tailnet has connected, and – before that; the pairing row
   is – for a child that is not paired, and for one whose Mac is asleep. A –
   is not a failure. The doctor exits 1 on any ✗, with the fix under it.
3. Run `kururu child setup` once more. It should end with *"Nothing to change:
   this child was already set up."*
4. Tell the user what to try from the phone: open a shell tab, start an agent,
   and open Kuru's drawer. The first time the harness starts, kururu answers
   Claude's folder-trust prompt for Kuru's own folder by itself.

After that, the commands on the box are:

```sh
kururu child doctor        # the same checks, read-only
kururu child status        # the service, the pty host and its unit, the agents
kururu child update        # pull, install, build, restart the server, doctor
kururu child join <address> <code>   # join the Mac: the command its Settings → Nodes → Add a computer shows
kururu share               # the phone's link and QR code (the user's terminal only)
```

`systemctl --user restart kururu` costs a reconnect and nothing more. The pty
host is a unit of its own. Only `kururu child restart-host` ends agents, and
it asks first.
