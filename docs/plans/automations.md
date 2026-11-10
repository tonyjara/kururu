# Automations: things kururu does on a schedule

A plan, written 2026-11-10 from a read of the tree at `6e83494`, of
`docs/harness.md`, `nodes.md`, `machines.md`, `layout.md`, `data.md` and
`invariants.md`, and of what other tools do
([the research notes](automations-research.md)). It is written so that an
agent can take one phase, read the files it names, and know what "done" is.

**Where it is:** phase 1 is built (2026-11-10, KUR-260): automations on this
Mac and the sidebar's section. What it does differently from the text below
is said under [phase 1](#phase-1-automations-on-this-mac-and-the-section).
Phases 2 to 5 are not started.

**The ask, in the owner's words:** "an Automations section in the left
drawer, where we have workspaces and agents, and a Kururu primitive for
automations. These are the things we do recurringly, like crons. We need to
be able to see them in Kururu, but they should be portable enough to deploy
on different hosts: the Omarchy PC, the Steam Deck, or my MV VPS. From
Kururu I'd see where each one lives, plus enough communication, not super
extreme, to know it's alive, when it'll trigger next, how often."

## In short

An **automation** is a schedule and a task with a name. The task is an
agent given a prompt, a shell command, or a card that the robot runs. Each
automation has one **home**: this Mac, a node (another kururu, like
omarchy), or a machine (an ssh host with no kururu, like MV or the Steam
Deck). Only its home ever fires it.

- On the Mac and on a node, the kururu server keeps the clock and starts
  the run as an ordinary agent in an ordinary terminal, so the sidebar, the
  Needs drawer, the notifications, Kuru's notices and the usage ledger all
  see it with almost no new code.
- On a machine, kururu installs a systemd timer and one small script, and
  reads the results back over the same ssh connection the gauges use.
- The sidebar gets an **Automations** section: a row per automation with a
  dot, its home and when it runs next. The Dashboard gets an
  **Automations** tab with the detail and the history.
- A run that found nothing makes no noise. A failure or a finding reaches
  you through the Needs drawer, a notification and one `[kururu]` line to
  Kuru, who tells you wherever you are, Telegram included.
- The definition is a small Markdown file, so it can be read, diffed, kept
  in a project and moved to another host.

## What the owner needs to decide

**Decided 2026-11-10: all five as recommended.** The database is the truth
and the file is how an automation travels, each host self-contained;
installing on a machine only from the dialog that lists the files, with no
credentials (phase 5); Kuru creates, pauses, runs and reschedules alone and
what changes what one may do or spend waits for one press (phase 3); every
automation names its launcher, 60 minutes and about $5 a run by default; the
Pasapy review on the Mac, every 2 weeks on Monday at 09:00 Asunción from
2026-11-23.

1. **What decides what runs: the database or the file?** Recommended: the
   database is what runs, and the file is how an automation travels. A file
   found in a project is *offered*, and a file that differs from what is
   installed is shown as a difference with two buttons. The other way
   round (the file is the switch, as in GitHub Actions) is simpler to
   explain, but then a `git pull` can change what runs unattended on your
   machine without anyone pressing anything.
2. **May kururu install things on a machine that has no kururu?** Today it
   puts nothing on MV or the Steam Deck. Running there while the Mac sleeps
   needs a timer and a script on the box. Recommended: yes, only from an
   **Install on MV** dialog that lists the exact files, only under your
   home directory, never a credential, and with an Uninstall that removes
   them. The alternative is that a machine's automations run only while a
   kururu is awake to drive them over ssh, which defeats the point for MV.
3. **How much may Kuru do alone?** Recommended: Kuru can make, edit, pause,
   resume, run now and reschedule. Anything that changes *what an
   automation may do or spend* (its prompt or command, its folder, its
   home, its permissions, a raised limit, a schedule tighter than hourly)
   waits for one press from you, shown as a difference. An automation is
   standing permission to spend tokens and run commands with nobody
   watching, and words from Telegram or from another node's Kuru should
   not be able to grant that by themselves.
4. **The defaults for model and cost.** Recommended: every automation names
   its launcher; the form suggests Sonnet for checks and digests and Opus
   for reviews that have to judge, and never Fable unless you pick it.
   Default limits of 60 minutes and about $5 a run, both editable, and an
   optional monthly budget that pauses the automation when it is passed.
5. **The first one: which day, and which host.** 2026-11-24 is a
   **Tuesday**. The plan assumes you meant Monday **2026-11-23**, then
   every second Monday. Recommended home: the Mac, where everything the
   crawl review needs already is, moving to omarchy once nodes can hold
   automations ([below](#the-first-one-the-pasapy-crawl-review)).

## What others do, and what we take

The detail and the sources are in [the research notes](automations-research.md).

| | gets right | gets wrong for us |
|---|---|---|
| **T3 Code** scheduled tasks | Per-task state (next, last, status, error, count). One tool that creates or updates. A stored start date so "every other Monday" survives edits. The next five runs shown. Runs never stack. | A task cannot leave the server it was made on. Times in the server's zone with no label. "Succeeded" meant "was queued". Finished one-offs pile up. No shell tasks. |
| **Claude Code**, desktop tasks | The prompt as the body of a Markdown file. Exactly one catch-up run after sleep. Skipped runs kept in the history with the reason. | The schedule, folder and model are not in the file. Runs only while the app is open. |
| **Claude Code**, cloud tasks | Run now, a pause switch, plain sentences for why a run did not start. | A fresh clone on Anthropic's machines: no local files, no tailnet, so no Pasapy database. |
| **Codex** automations | The list is an inbox: only runs that found something are unread. "Test the prompt by hand first." | The app must be open. A worktree per run piles up. |
| **Cursor** automations | A run may be late, never early. | Cloud only. Its duplicate guard once skipped every later run. |
| **GitHub Actions** | The definition is a file in the repository. History and a manual run come free. | The file *is* the switch. UTC only, no catch-up. |
| **systemd timers** | A zone on the calendar line, `Persistent=` catch-up, a hard timeout, no overlap. | No "every second week". A unit's `PATH` is not the shell's. |
| **launchd**, **cron** | They are already there. | No history, no zone, and in cron's case no catch-up and overlapping runs. |
| **Dokploy** schedules | A run button and logs per run, beside the service. | Only for what is deployed there. |

The short version of what is borrowed from **T3 Code**: the shape of the
record, the create-or-update tool with pause as a field, the stored anchor,
the next-five preview, and the two rules *never stack* and *reap a run left
running*. What is deliberately different: an automation has a home and can
move, every time is shown with its zone, and a run's result is how it
ended, never that it started.

## What kururu already has

Almost everything a run needs exists. This is the list the design leans on.

- **Starting an agent with a prompt, by id, off screen:** `openTerminalAt`
  and the `*In` spellings in `workspaces.ts` that the harness uses, with
  `agentPaneIn` putting agents kururu starts itself in the agents' pane.
- **Knowing when it finished and what it said:** the hooks' `done` and
  `blocked` edges through `noticeStatuses`, and the `Stop` hook's last
  reply.
- **Telling Kuru:** the `[kururu]` notice to the harness's inbox, batched
  for `done` and immediate for `blocked` and exits.
- **Telling you:** the notification gate (`shared/notify.ts`), the Needs
  rule (`shared/needs.ts`), and Telegram hearing every reply of Kuru's.
- **A link to what a run made:** `shared/made.ts` reads the paths in the
  last reply.
- **Ending an agent safely and bringing it back:** `sleep.ts` ends an idle
  card's agent only after its conversation is found; `--resume` reopens it.
- **Cost:** the usage ledger writes whose a session was when kururu starts
  it (`usage/attribute.ts`).
- **Other hosts:** a node pushes a summary of itself over `/link` and
  takes board verbs over it; a machine is reached by `BatchMode` ssh over a
  warm connection with fixed, read-only scripts (`machines.ts`).
- **A database that refuses rather than diverges** (`store.ts`), with a
  text export that the git backup carries.

What does not exist: a clock, a record of runs, a file format, anything
installed on a machine, and a place on screen.

## The primitive

```
automation = a name
           + a schedule       when, in a named time zone
           + a task           an agent prompt, a shell command, or a card
           + a home           this Mac, a node, or a machine
           + limits           time, money, catch-up
           + who to tell      never, on failure, on a finding, always
```

### The three tasks

- **`agent`:** a launcher and a prompt, in a folder. The prompt can be a
  slash command (`/crawl-maintenance`), since it is typed as the first turn
  the way a card's is. The run ends with a report.
- **`shell`:** a command line, in a folder. The result is its exit status
  and the last lines it printed.
- **`card`:** the robot's press, on a schedule. Each firing writes a card
  from the file's title and body into the workspace's To do and runs it
  with `runCardAt`, on the launcher named, with a worktree when the project
  asks for one. From there it is a card like any other: it lands in Review,
  which is already a need. This is the task for work that changes code and
  should be reviewed, such as a weekly dependency update.

A card's history already uses the word `automation` for moves the board
makes by itself when an agent's status changes (`noteRun`). Cards made by a
schedule are written with the actor `schedule`, so the two can be told
apart.

### The file

One Markdown file per automation. The frontmatter is flat `key: value`
lines, which a short pure parser reads, so the server takes no YAML
dependency. The body is the prompt, the command, or the card's body.

```markdown
---
name: Pasapy crawl review
description: Every second Monday, reviews the last two weeks of Pasapy's crawls with /crawl-maintenance: finds broken or silent sources and extraction bugs, and reports what to fix.
schedule: every 2 weeks on mon at 09:00 America/Asuncion from 2026-11-23
run: agent
launcher: claude:claude-opus-5-5
needs: machine MV, login claude
timeout: 90m
max-usd: 15
catch-up: 3d
tell: always
---
/crawl-maintenance
```

| key | what | default |
|---|---|---|
| `name` | what every screen and Kuru call it | required |
| `description` | what it is for, a sentence or two on one line (at most 400 characters); the row's tooltip and the top of the sheet | none |
| `schedule` | one line, below | required |
| `run` | `agent`, `shell` or `card` | `agent` |
| `launcher` | an id from `LAUNCHERS` (`shared/launchers.ts`) | required for `agent` and `card` |
| `dir` | a folder under the workspace's, relative, no `..` | the workspace's folder |
| `needs` | checks made before a run starts, below | none |
| `timeout` | wall-clock limit | `60m` |
| `max-usd` | cost limit for one run | `5` |
| `month-usd` | a monthly budget; passing it pauses the automation | none |
| `catch-up` | how late a missed run may still start | `12h` for daily or slower, none for faster |
| `tell` | `never`, `failure`, `finding`, `always` | `finding`, which includes failures |
| `permissions` | `profile`, `ask`, `auto` | `profile` |

**What is not in the file:** the home, whether it is on, who approved it,
and anything about past runs. The same file in a repository cloned on three
hosts must not fire three times, so where it runs is a fact about an
installation, kept by the kururu that installed it.

### The schedule, as one line

Cron is not the primary grammar. It cannot say "every second Monday", its
day-of-month and day-of-week fields combine in a way that surprises
everyone once, and it has no time zone. The line reads as words and is
held to a grammar, as a host and a folder are:

```
every <n> <minutes|hours|days|weeks|months> [on <days>] [at <HH:MM>] <zone> [from <YYYY-MM-DD>]
cron <five fields> <zone>
once <YYYY-MM-DD> <HH:MM> <zone>
manual
```

- **The zone is part of the schedule and is always shown.** It is an IANA
  name. "09:00 America/Asuncion" means that on every host, whatever the
  host's own clock is set to, and the screen shows it with the zone and,
  beside it, in the viewer's local time. This is T3 Code's issue #18632
  avoided by construction.
- **`from` is the anchor.** It fixes the first run and which weeks are the
  on-weeks. When it is left out, the day the automation was made is used
  and **stored**, so an edit or a restart never flips the alternation.
- **`on`** takes weekday names with weeks, and day numbers or `last` with
  months.
- **`manual`** has no clock: it runs only from Run now. It is a saved
  prompt with a history.
- **A floor of five minutes**, and anything tighter than hourly on an
  agent task needs your press even when you typed it, with the monthly
  cost at that rate shown in the dialog.
- **Daylight saving:** a wall time that does not exist on a day fires at
  the next minute that does, and one that happens twice fires once.

`shared/schedule.ts` holds `parseSchedule`, `nextRun(schedule, after)`,
`inWords` and `nextFive`, pure and tested, with the zone arithmetic done
through `Intl.DateTimeFormat`, which Node carries. The editor shows the
next five runs before anything is saved.

## Where it lives

**An automation lives in the database, and its file is how it travels.**
This is the boards' rule ([data](../data.md#write-through-and-refuse-rather-than-diverge))
applied again: one place holds the truth, and nothing a file says changes
what is there without a person.

- `kururu.db` gets two tables, kept by `keepShape` so the schema version
  does not move: `automations` (a key `ak…`, the profile, the workspace or
  none, the definition's text as approved, a pending text and who proposed
  it, the home, on or off and why, the anchor, the next slot) and
  `automation_runs` (below).
- **In a project:** `.kururu/automations/<slug>.md`. **Write to project**
  on an automation puts its file there; a file found there that is not
  installed is *offered* in the section ("1 in this project is not
  installed here"); a file that differs from the installed text shows
  **file differs** with **Take the file** and **Write ours**. Agents can
  propose an automation by writing a file. It does nothing until taken.
- **In the profile:** an automation with no workspace has no project to
  sit in. Its file is in the backup's export, `automations/<profile>/<slug>.md`,
  in the same format, and it runs in a folder of its own under
  `~/.local/share/kururu/automations/<key>/`, as the harness does, so it
  loads no project's instructions.
- **In the backup:** the export carries every definition and the run
  history as lines. `bun run restore` brings automations back **paused**,
  with "restored on <date>" as the reason. A second Mac built from the
  same backup would otherwise run everything twice.

## Homes and runners

| home | who keeps the clock | how a run starts | when the host is asleep or off |
|---|---|---|---|
| **this Mac** | the kururu server | an agent or a command in a pty the host holds | nothing fires; on wake or start, the catch-up rule |
| **a node** (omarchy) | that node's kururu server, the same code | the same, on the node | a child is a systemd service on a box that stays on; the same rule if it was off |
| **a machine** (MV, the Steam Deck) | a systemd user timer kururu installed | the timer starts a script, which runs the CLI headless or the command | `Persistent=true` runs a missed slot once at next start; the script applies the same catch-up window |

**An automation fires on one host, the one its record names.** A kururu
that is not the home never starts a run, and moving is "remove here once
the target has answered", with a move id so a retry is the same move, as a
workspace's move is (`shared/move.ts`).

### On the Mac and on a node: the server's clock

`server/src/automations.ts`, in the server and never in the pty host.

- **A tick every thirty seconds compares the wall clock with each
  automation's next slot.** A timer set for the exact moment would be
  simpler and is wrong after a sleep, when every timer is late and the
  clock has jumped.
- **The slot is the run's id.** A run row is written, keyed by the
  automation and the slot it was for, *before* anything is started, and
  the pair is unique. A server that restarts at 09:00:01, or two servers
  on one database, cannot fire a slot twice: the second insert is refused.
  A row the database refuses is a run that does not start.
- **The server restarting is not the run ending.** The agent lives in the
  pty host. At start the server finds each `running` row's terminal again
  by its session id, as `card_runs` does. One whose terminal is gone is
  marked `interrupted`, so a run left `running` can never block the
  schedule for good.
- **Why not launchd or cron on the Mac:** a job started by either would be
  an agent outside the pty host, which kururu could neither show nor stop.
  And the server is already supervised.
- **Why not the pty host:** it is the one process whose restart costs
  every agent. No phase of this plan touches `server/src/agents/`,
  `ptyhostd.ts`, `ptyhost.ts`, `hostlink.ts` or `hostsock.ts`.
- **An isolated instance never runs automations.** With `KURURU_DATA_DIR`
  set, the clock stays off unless `KURURU_AUTOMATIONS=1` says otherwise. A
  scratch server pointed at a copy of the real database would otherwise
  start the owner's real agents.

### On a machine: a timer and a script

A machine has no kururu, so the clock has to be something already there.
All three of the owner's boxes run systemd.

**Install on MV** shows the files before writing any, all under the home
directory of the ssh user, and writes them over the existing warm
connection:

```
~/.config/kururu-auto/run.sh                           one POSIX script, the same for every automation
~/.config/kururu-auto/<key>/automation.md              the definition, for whoever reads the box
~/.config/kururu-auto/<key>/task                       the prompt or the command
~/.config/systemd/user/kururu-auto-<key>.service       Type=oneshot, TimeoutStartSec=<timeout>, PATH written in
~/.config/systemd/user/kururu-auto-<key>.timer         OnCalendar=<…> <zone>, Persistent=true
~/.local/state/kururu-auto/<key>/runs.jsonl            one line per firing
~/.local/state/kururu-auto/<key>/<slot>.log            what the run printed
```

- **The script is a constant** in `shared/automationhost.ts`, like
  `REMOTE_SCRIPT`, tested by running the real text through `sh` against a
  fake `claude`. The key, the folder and the limits are held to grammars
  with nothing to escape in them.
- **The unit's `PATH` is written in at install**, read once from the
  machine's interactive shell the way `AGENT_CHECK` finds a CLI. A unit's
  own `PATH` has no `~/.local/bin`, nvm or bun on it; the child's unit
  solves it the same way.
- **An agent runs headless there:** `claude -p` with `--output-format
  json`, `--max-budget-usd`, `--permission-mode`, `--model` and
  `--session-id` (all checked against 2.1.322). Its JSON carries the
  result, the cost, the length and the session id, and the script files it
  whole for the Mac to parse. The unit's timeout is the hard time limit,
  and a oneshot unit cannot overlap itself.
- **"Every second week" is a guard in the script.** The timer fires every
  Monday at 09:00 in the zone; the script divides the seconds since the
  anchor by the period and writes a `skip: off-week` line on the others.
  `toSystemd(schedule)` compiles the line into the calendar expression and
  the guard, and refuses in words what a timer cannot express.
- **Timers run while you are logged out only with lingering on.** Install
  checks, and when it is off says the one command to run, as kururu does
  for anything that changes a system.
- **Nothing secret goes there.** An agent on a machine is signed in as
  whoever is signed in there, as today. Lending is to nodes only.
- **Uninstall** disables the timer and removes exactly those files, after
  reading the history back one last time.

The Steam Deck fits this as a machine, with one honest caveat: it is
asleep most of the time, so everything there is a catch-up run. It is a
home for "when it is next on, do this", and a poor one for 09:00.

### Asleep, late, missed

One pure rule, `decide` in `shared/automation.ts`, used by the server's
clock and written again in the script:

- A slot found **within two minutes** is on time.
- A slot found late but **within `catch-up`** runs once, marked "late by
  3 h: the Mac was asleep". Only the most recent missed slot is
  considered. A daily automation that missed six days runs once.
- A slot found later than that is written `missed`, with the reason and
  how many slots went by, and the next one is scheduled.
- A slot that arrives while the last run is still going is written
  `skipped: the last run is still going`. Runs never stack.
- At most two automation agents run at once across the profile; a third
  waits its turn rather than being skipped.
- A run is never early.

Every one of these is a row in the history, so "why did it not run on
Monday" is answered on screen.

## A run, from start to end

On the Mac or a node, for an `agent` task:

1. **Before starting**, each `needs` entry is checked. `machine MV`: the
   gauges' poll has answered in the last minute, or answers now. That is
   also the tailnet check, made without ever running `tailscale`.
   `login claude`: the CLI's own status command. `command <name>`: it is
   on the path. A need not met writes `skipped: MV has not answered` and
   tells you, with the catch-up window still open for a retry on the next
   tick. The launcher is checked too: one that has been removed from
   `LAUNCHERS` is a skip that asks for an edit.
2. **The run row is written**, then the terminal is opened in the agents'
   pane of the automation's workspace (`agentPaneIn`), on the launcher's
   own line, with a `--session-id`, named after the automation. The
   keyboard stays where it was. The ledger writes the session down as this
   automation's.
3. **The prompt is the file's body plus a few lines kururu adds:** that
   this is an unattended run of the automation named so, that nobody is
   watching, not to ask questions but to stop and say why, and to end the
   last message with one line: `RESULT: ok`, `RESULT: finding: <one
   sentence>` or `RESULT: failed: <one sentence>`.
4. **While it works** it is an agent like any other: a dot in the sidebar,
   a screen you can open, type into and stop.
5. **If it asks** (`blocked`), the existing rules apply unchanged: it is in
   the Needs drawer, the notification fires and Kuru is told at once. The
   run shows `asking`. If nobody answers before the timeout, it is ended
   and written `failed: asked "<the question>" and nobody answered`.
6. **When its turn ends**, `verdictOf` reads the last line of the reply. A
   reply with no result line is a `finding`, on the principle that a doubt
   tells you. The first path `shared/made.ts` finds is the run's report.
   The length and the cost are written on the row.
7. **Two minutes later the agent is ended**, under the sleeper's own
   checks: nothing running under it, no question on its screen, its
   conversation found on disk first. **Open conversation** on the run's
   row resumes it in a tab, as a card's resume does. Without this, a daily
   automation leaves a tab a day.
8. **Limits.** Past `timeout` the terminal is ended and the run is
   `failed: ran past 90 min`. The ledger's reading of the session is
   compared with `max-usd` whenever a report nudges the sweep; past it the
   run is ended the same way. The ledger learns of a message after it is
   written, so the limit can be passed by the turn in flight, and the row
   says what was actually spent.

A **`shell`** task is a pty whose command is the line under `sh -c`, with
a marker printed after it that carries the exit status. The pty host says
that a terminal exited and not with what status, and adding that would be
a host change, so the marker is read off the screen through the host's
existing `text`. The last forty lines are kept as the run's output. In a
pty and not a child of the server, because the server restarts on every
save and would take the command with it.

A **`card`** task writes the card and calls `runCardAt`. The run row
points at the card and is `ok` once the card's agent finishes; the card in
Review is the result, and the board, the sleeper and the worktree rules do
the rest.

### The run record

| column | |
|---|---|
| automation key, slot | the id; `now:<time>` for a manual run |
| why it started | `schedule`, `catch-up`, or `now` with who pressed it |
| started, ended | |
| state | `running`, `asking`, `ok`, `finding`, `failed`, `skipped`, `missed`, `interrupted` |
| words | the result line's sentence, or the reason for a skip |
| report | a path, when the run made one |
| session id, launcher, home | what **Open conversation** needs |
| cost | the ledger's reading, or the CLI's own figure on a machine |
| seen | when you opened it; what the Needs drawer goes by |

## Staying in touch, lightly

The owner asked for enough to know it is alive, when it triggers next and
how often, and no more. Per home:

- **The Mac.** The clock is in the server, so it is alive when the server
  is. `/api/health` and `bun run status` gain a line: how many automations
  are on, the next slot, and the last tick.
- **A node.** `NodeSummary` gains a short `automations` list: name, state,
  next slot, the last run's state, length and time. A summary already
  crosses the link whenever it changes, at most once a second, and
  `nodes-seen.json` already keeps the last one. So omarchy's automations
  are drawn on the Mac with no new traffic, and when omarchy is away the
  row greys and says "away since 23:10" over what was last known. A node
  from before this says so with a flag in its summary, as `talks` and
  `watchable` do, and is offered "update it". The history is the node's
  own; the Mac asks for a page of it over the link when the detail is
  open.
- **A machine.** One more fixed, read-only script on the gauges' poll: the
  last lines of each `runs.jsonl`, and the timer's `ActiveState`,
  `LastTriggerUSec` and `NextElapseUSecRealtime`. The Mac works out the
  slots itself from the schedule, so a slot that has passed with no line
  for it, on a machine that answered, is drawn as `missed: the timer did
  not fire`. A machine that does not answer is "cannot say: MV has not
  answered since 08:12", never a guess. The gauges are polled only while
  a window is connected, so a machine holding an automation is also read
  every ten minutes with none, or a failure at 03:00 would wait for you to
  open the app.

The heartbeat is therefore nothing new on the wire: a tick time on the
Mac, the summary on a node, the timer's last trigger on a machine.

## Results, and when you are bothered

**A run that found nothing is silent.** Its row turns green and that is
all. Every wake of Kuru re-reads its whole context, so a line saying
"nothing to report" every morning would cost more than the run did.

`tell` decides the rest: `failure` tells on a failed, missed or skipped
run; `finding`, the default, adds runs that found something; `always`
adds every run; `never` keeps everything on the row.

When a run is worth telling, all of this is existing road:

- **Kuru** gets one line in its inbox, through the notice batch:
  `[kururu] Automation "Pasapy crawl review" (on mac, in Pasapy) finished
  in 41 min, about $6.20. Finding: three sources silent since 12 Nov.
  Report: docs/research/crawl-review-2026-11-23.md`. The ordinary "finished
  its turn" notice for that agent is not sent as well: one subject, one
  line. The drawer reads notices back by their shape (`readPrompt` in
  `shared/kuru.ts`), so this line is added to that reader and its
  round-trip test.
- **You, at the Mac:** a notification through the server's gate, and a row
  in the Needs drawer. `shared/needs.ts` gains two kinds: a run that
  failed or found something and has not been opened, and an automation
  waiting for your press. Neither is dismissed by hand. The first leaves
  when the run is opened or a later run of the same automation is `ok`,
  the second when it is approved or the change is dropped.
- **You, elsewhere:** Kuru's reply, which Telegram already hears. A node's
  Kuru is told about its own node's runs and its line reaches the chat
  marked with the node's name, as its lines do now.
- **The report:** the run's row, the sidebar row and the notice all carry
  the link. A document opens in the reader, as any made link does.
- **A card,** for the `card` task, in Review.

For a machine, the Mac raises these when it reads the result, and the
notice says how late the news is.

## Secrets and permissions

**An automation never widens what an agent may do.** On the Mac and on a
node its agent starts on the profile's launcher line, exactly as a card's
run does, with the bypass flag only if the profile has it ticked for that
CLI. `permissions: ask` drops the flag for an automation that should stop
and ask. `permissions: auto` asks for Claude Code's auto mode where the
profile does not bypass. There is no setting that grants more than the
profile has.

On a machine there is no profile to follow and a headless run cannot ask.
The permission mode is part of what you approve in the Install dialog,
which shows the exact command line.

What carries over from the rules kururu already has:

- **The agents are real.** A scheduled run spends tokens with nobody
  there. That is why limits have defaults, why runs never stack, why the
  section's heading has a **Pause all**, and why Run now on a real
  automation is the only test that costs anything. Tests use `shell` tasks
  running `true` and `sleep`, stand-in CLIs in the isolated instance, and
  a fake clock over the pure rule.
- **No value in a definition.** A file holds names: a launcher, a
  workspace, a machine. A run gets the environment any agent tab gets,
  through the same code, and nothing else. On a node it uses what was lent
  to that node: an env file, an ssh entry, a gh login, a Claude login.
  `needs` says what must be there and the check refuses the run when it is
  not, rather than starting an agent that flails.
- **No path from a client.** The folder is a workspace's, named by key,
  plus a relative `dir` with no `..`. On a machine it is held to
  `validRemoteDir`, the host to `validHost`.
- **Numbers off the wire** (limits, intervals, slots) get
  `Number.isFinite`.
- **`tailscale` is never run.** Reachability is the machines' own poll.
- **Restoring restores structure, never processes.** A restart never
  fires anything by itself: a slot is due or it is not, by the clock and
  the rows. A restore from the backup brings automations back paused.
- **Approval is by content.** The database keeps the approved text and its
  hash. A change proposed by Kuru, by another node's Kuru or by a file
  sits beside it as pending, and the approved text keeps running until you
  press.
- **A compromised child** can already type into the Mac's Kuru as itself.
  With approval by content it can propose an automation and cannot switch
  one on.
- **Work in the main checkout.** An `agent` task runs in the project's
  folder, where you may have uncommitted work. That is right for a review
  that writes a report and wrong for anything that edits code, which is
  what the `card` task and its worktree are for. The form says so.

## Model and cost

- **The launcher is named per automation** and is one of `LAUNCHERS`, so
  `/update-models` keeps the choices current. A launcher that is retired
  makes the next run a skip that asks for an edit; it never falls back to
  another model silently.
- **Suggested in the form:** Sonnet for checks, digests and anything that
  runs daily; Opus for a review that has to read and judge; Haiku only for
  a pinpointed look; Fable never unless picked.
- **Three limits:** `timeout` (hard), `max-usd` per run, `month-usd` per
  automation. Dollars are the ledger's estimate from tokens at list price.
  On a subscription they are a measure of size, not a bill.
- **Shown:** each run's cost, the month's total per automation, and
  automations as their own slice on Settings → Usage, since the ledger
  already knows whose each session was.
- **Later:** `skip-over: 80%`, which skips a run when the plan's five-hour
  allowance is already that used, so a 09:00 automation does not spend the
  morning's allowance before you sit down.

## The screen

"The left drawer" is the sidebar (`web/src/components/Sidebar.tsx`), which
today has Workspaces, Agents, Nodes and the dev servers.

### The sidebar's section

**Automations**, under Agents. One row each:

```
AUTOMATIONS                                   ⏸  +
● Pasapy crawl review          Mon 23, 09:00
◐ Dependency bumps    omarchy     running 12 m
○ Disk check          MV               in 3 h
✕ Morning brief                 failed, 07:00
– Backup check        Steam Deck        paused
```

- **The dot** is the state: quiet until next, running, asking, found
  something unseen, failed, paused, waiting for your press, or "cannot
  say" for a home that is away.
- **The chip** is the home, drawn only when it is not this kururu.
- **The right side** is the one fact that matters now: the next run, how
  long it has been running, or what went wrong.
- **A click** opens the Dashboard's Automations tab on that automation.
- **The row's ⋯ menu,** as the workspace rows have: Run now, Pause or
  Resume, Edit, Move to…, Open last report, Reveal agent (while running),
  Delete.
- **The heading** has `+` (new) and **Pause all**, and offers files found
  in the project on screen that are not installed.
- Other nodes' automations are listed here, with their chip, and not under
  Nodes: the section is about a subject, not a place.
- On a phone the same section is in the drawer. The phone is for watching
  and steering: Run now and Pause are on the row's held touch.

### The Dashboard's tab

One entry in `DASHBOARD_TABS` (`dash:automations`), drawn in
`Dashboard.tsx`. It is the profile's, in no workspace, which is exactly
what the Dashboard is for.

- **The list**, every home, with the same dots.
- **The detail** of one: its name, state and home; the schedule in words
  with its zone and the next five runs in your local time; Run now, Pause,
  Edit, Move to…; the live run, with a door to its terminal, or **Watch**
  on a machine, which opens a shell tab tailing the log.
- **History:** one row per slot, newest first: when it was for and when it
  started, the result, the length, the cost, the report, Open
  conversation. Skipped and missed rows are grey and say why.
- **Edit** is a form (name, description, schedule with the next five updating as you
  type, task, launcher, folder, limits, tell, needs) with **Edit as text**
  showing the file. The form writes the same text the file holds.
- **Move to…** lists this Mac, each node and each machine, and for each
  says what the move would need before it is offered: a workspace of that
  name on the node, the CLI installed and signed in, the files that would
  be installed on a machine. A move with an open run is refused.
- **Delete** asks first, in a centred dialog, and keeps the history in the
  database marked gone, as a deleted card is kept.

## Kuru's tools

Five, in `shared/harness.ts`'s catalogue, listed always since making the
first one needs them. The role's **Automations** section and
`kururu_status`'s list appear only once one exists.

| tool | what it does |
|---|---|
| `automations` | the list: each with its home, schedule in words, next run, last result. With `automation`, one with its last ten runs; with `run`, that run's words and report |
| `set_automation` | create, or edit by name or key, with its description among the fields. Says what took effect and what is waiting for the user's press, and shows the next five runs |
| `run_automation` | run now. Returns the agent, so `wait_agent` and `read_agent` work on it |
| `pause_automation` | off or on, with a reason that the row shows |
| `move_automation` | to this node, another node or a machine. Previews first what the target lacks and what would be installed, as `lend_secrets` previews |

- **No delete.** That is the user's, in the menu, with its dialog.
- **Named by name.** "The Pasapy crawl review", never `ak3f…`, by the same
  rule as agents.
- **What the role says:** offer an automation when the user describes
  something they do again and again. Run it once with `run_automation`
  before trusting the schedule. Say nothing about quiet runs. A
  `[kururu] Automation …` line is the server's and is never answered.
- **Other nodes:** `automations` reads every node's from the summaries.
  `set_automation` and `run_automation` act on this node only. Another
  node's are asked for with words through `ask_kuru`, because a run starts
  an agent there, which is that node's Kuru's to do. The user's own
  presses on another node's automation are forwarded like any verb of
  theirs.

## The first one: the Pasapy crawl review

`/crawl-maintenance` is a skill in `~/Desktop/Nyto/pasapy/.claude/skills/`.
It runs saved read-only queries against `pasapy_prod`, reads the
collector's logs on the VPS, fetches the crawled sites' agenda pages,
writes `docs/research/crawl-review-YYYY-MM-DD.md` and commits it with
`fixes.md`. It needs the Pasapy checkout, the `hostinger_nytojara` checkout
beside it (its `scripts/db` and the credentials file that reads), the
tailnet (the database's direct port and ssh to `nytojara-vps` are closed
to everything else), a signed-in Claude, and web fetch.

**The date.** 2026-11-24 is a Tuesday. The file below says Monday
2026-11-23 at 09:00 Asunción, which is 12:00 UTC. The four after it are
7 and 21 December, 4 and 18 January. If Tuesdays were meant, it is one
word in the line.

**Where it should run: the Mac, to begin with.**

- **Not Claude's cloud.** A cloud run cannot join the tailnet, and the
  `db-pasapy` skill says so in its own words.
- **Not MV.** MV is the production box that holds the database. Running
  the review there means a signed-in agent CLI, a checkout with push
  rights and the database credentials all living on it, with only the
  skill's own "Never" list between an agent and production. The review
  reads MV; it should not live on it.
- **Not the Steam Deck.** It is asleep, and has none of what the review
  needs.
- **The Mac** has every one of those things today and needs nothing new
  beyond phase 1. Monday at 09:00 is a working hour, and when the Mac is
  closed that morning, `catch-up: 3d` runs the review when it next opens.
  A review that looks back fourteen days loses nothing by starting on a
  Tuesday, and the skill already counts the days since the last report
  itself.
- **omarchy, later.** It is the right home once nodes hold automations
  (phase 4): always on, on the tailnet, with its own Kuru to say what was
  found. It needs the two checkouts, three things lent to it (the
  credentials env file, the `nytojara-vps` ssh entry, the gh login for the
  push) and a Claude login, all of which lending already does. Then it is
  **Move to… → omarchy**.

```markdown
---
name: Pasapy crawl review
schedule: every 2 weeks on mon at 09:00 America/Asuncion from 2026-11-23
run: agent
launcher: claude:claude-opus-5-5
needs: machine MV, login claude
timeout: 90m
max-usd: 15
catch-up: 3d
tell: always
---
/crawl-maintenance
```

- **`needs: machine MV`** is the tailnet check: a run on a morning with
  Tailscale off is skipped with "MV has not answered", you are told, and
  it starts within the three days once it does.
- **Opus,** because twelve checks are read against thresholds and judged,
  and a run every two weeks is cheap whatever the model. The $15 and the
  90 minutes are guesses. The first Run now gives the real figures, and
  the limits should be set at about twice them.
- **`tell: always`,** because the skill's last step is to tell the owner
  the three findings that matter most. Kuru gets the line and says them.
- **Permissions** are the profile's. What stops the review writing to
  production is what stops it today when run by hand: the helper's
  read-only default and the skill's "Never" list. The automation adds no
  guard and removes none.
- It lives in the Pasapy workspace, and **Write to project** puts the file
  at `pasapy/.kururu/automations/crawl-review.md`.

## Phases

Each is one card. None touches the pty host, so none costs an agent:
`shared/` and `server/src/` are a reconnect, `web/` a reload. Make the
worktree before the first edit, as always under `bun run dev`.

### Phase 1: automations on this Mac, and the section

Useful alone, and enough for the Pasapy review on 2026-11-23.

- `shared/schedule.ts`: the grammar, `nextRun`, `inWords`, `nextFive`.
- `shared/automation.ts`: the shape, the file read and written, `decide`
  (on time, catch-up, missed, skipped), `verdictOf`.
- `server/src/store.ts`: the two tables through `keepShape`.
- `server/src/automations.ts`: the tick, the row before the start, the
  `agent` and `shell` tasks, the timeout, the agent ended after it
  finishes, the reattach at start, the clock off in an isolated instance.
- `server/src/ws/automations.ts`: the verbs (save, pause, run now,
  delete), and the list in the snapshot's deltas.
- The sidebar's section, with the row menu and a form in a sheet that
  shows the last twenty runs.
- A failed, missed or skipped run notifies and sends Kuru the line.
- **Done when:** in an isolated instance with the clock switched on, a
  `shell` automation running `true` every five minutes fires on time under
  a fake clock and for real; a restart of the server mid-run finds the run
  again; a slot is never fired twice with two servers on one database; a
  missed slot inside and outside the window does what `decide` says; an
  `agent` automation on a stand-in CLI ends with its result line read; the
  tests for the two shared files pass.
- **Out:** the Dashboard tab, cost limits, the file in a project, Kuru's
  tools, other hosts, the `card` task.

**Built 2026-11-10.** `shared/schedule.ts`, `shared/automation.ts`, the two
tables in `server/src/store.ts`, `server/src/automations.ts` and its verbs
in `server/src/ws/automations.ts`, the section and the sheet in
`web/src/components/Automations.tsx`; tested in
`server/test/{schedule,automation,automationstore,automations}.test.ts` and
in an isolated instance (`docs/testing.md`). Where the code went its own way:

- **A workspace is required.** A profile-level automation, with its own
  folder under `~/.local/share/kururu/automations/<key>/`, is left for a
  later phase: a run's terminal has to go in some workspace's agents' pane.
  The sidebar lists the active profile's automations, as it lists its
  workspaces.
- **Its folder is the workspace's main checkout**: the one the branch walk
  found, or the main checkout of wherever the workspace's agents start
  (`mainRoot`), never a subfolder or worktree a tab is in. `dir` is resolved
  under it and checked again through the real path.
- **Read and kept, not acted on yet:** `needs`, `max-usd` and `month-usd`
  (phase 2). `tell: never` silences a failure; every other value tells on a
  failed, missed, skipped or interrupted run, and findings are phase 2. The
  sheet says so.
- **Refused at save:** `run: card` and `permissions: auto`. `permissions:
  ask` is honoured: the bypass flag is dropped for that run.
- **The launcher is looked up as named** (`findLauncher`), not through
  `launcherFor`, which would put Claude launchers on the harness CLI when
  the profile switched it: an automation never runs on another model
  silently.
- **A run is found again by its tag** — `kururu-run-<id>-<nonce>`, in the
  unattended prompt and so in the terminal's command line, and in a shell
  run's status line — rather than by its session id alone, since Codex runs
  have none and ids are given out again after a host restart.
- **A shell run's terminal is kept from the reap** (`reapExited` asks
  `automations.holds`) until its status line has been read off the screen,
  which is then ended; the host's `text` reads it, as the plan says.
- **Its agent is closed by `Sleeper.whyAwake`**, the idle-card checks with
  the Settings switch not asked. A server restart starts the sleeper's quiet
  clock again, so a run that ended just before one closes two minutes after
  it.
- **A notification** is the gate's `blocked` event, aimed at the run's
  terminal when there is one; there is no automation event in
  `NotifySettings` yet.
- **Home** is `nodes.name()`, which is `mac` on this Mac.
- **A description** (added the same day, after the owner's "I would love to
  have a description there so we know the purpose of the automation") is
  a key in the file like the others, so the database keeps it inside the
  approved text, with no column of its own, and it travels with the file.
  The sidebar row's tooltip carries it under the name rather than a second
  line on every row; the sheet opens with it. Kuru's `set_automation` and a
  CLI are phase 3's, and take it as a field when they come.
- `/api/health` and `bun run status` are phase 2's, as listed there.

### Phase 2: the detail, the results, the limits

- The Dashboard's Automations tab: detail, history, Edit as text, the next
  five runs.
- Findings: the result line's three outcomes, `tell`, the report link from
  `made.ts`, the two new kinds in `shared/needs.ts`, quiet runs silent.
- Cost: the ledger's attribution for a run, `max-usd`, `month-usd`, the
  slice on Settings → Usage.
- `needs`, with the three checks.
- The `card` task.
- `/api/health` and `bun run status`.

### Phase 3: Kuru, approval, the file

- The five tools, the role's section, `kururu_status`.
- The pending text, the difference and the press; what Kuru may change
  alone.
- `.kururu/automations/` read, offered and written; the backup's export
  and the paused restore.

### Phase 4: nodes

- The clock on a child (the same code, switched on by the same rule).
- `NodeSummary.automations` and the flag; the rows on the Mac; the
  history asked for over the link.
- The verbs forwarded to a node; a node's failure raised on the Mac's
  clients; `ask_kuru` as Kuru's road.
- **Move to…** between the Mac and a node, with its move id.

### Phase 5: machines

- `shared/automationhost.ts`: the script, `toSystemd`, the read-back
  script and its parser, all tested against fakes.
- Install and Uninstall, with the dialog that lists the files and the
  command line; the linger check; the path written in.
- The status on the gauges' poll and every ten minutes without a window;
  `missed` and "cannot say".
- **Watch**, and Move to… a machine.
- Claude and `shell` first. Codex's `exec` after, when one is wanted.

### Later, each on its own

- `skip-over`, the allowance guard.
- A worktree for an `agent` task.
- cron for a machine without systemd.
- A trigger that is not a clock (a webhook, a push), which T3 Code and
  Cursor both grew into. Nothing here closes that door: a trigger would be
  one more way a slot comes to exist.
- A wake for the Mac (`pmset`), which needs root and is the owner's to set
  up if ever wanted.

## What this adds to the invariants

For `CLAUDE.md`, when phase 1 lands:

- **An automation lives in the database, and a file never switches one
  on.** A file is offered or shown as a difference; what runs is the
  approved text.
- **An automation fires on one host, the one its record names, and a slot
  fires once:** the run's row is written before anything starts and is
  unique by automation and slot.
- **An automation never widens what an agent may do,** and Kuru cannot
  grant one more than the user has pressed for.
- **The clock is the server's, never the pty host's,** and an isolated
  instance has none.
- **A quiet run tells nobody.**
- `sleep.ts`'s rule widens by one case: an automation's own agent, after
  its run has ended, under the same checks.

## Open, and not blocking

- **Dark wake.** A Mac in Power Nap can run timers briefly. Whether a tick
  there could start a run that the next sleep cuts off needs testing on
  the real machine; the fix would be to wait a minute after a wake before
  firing.
- **SteamOS.** User units under the home directory should survive its
  updates; unverified on the Deck itself.
- **The Mac as a machine.** A Mac reached by ssh has launchd, not systemd.
  Not planned: the Mac that matters runs kururu.
- **Memory per automation.** Cursor gives each automation notes shared
  across its runs. A project automation already has the project's own
  files (the crawl review reads its last report) and a profile-level one
  has its own folder, so nothing is added yet.
