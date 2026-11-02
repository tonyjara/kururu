# Slots

The queue agents wait in to use the expensive parts of one Mac: a native
build, a simulator booting, a UI test driving one, a heavy suite, the phone on
the cable. The server holds it (`server/src/slots.ts`); agents reach it with
`slot` (`server/src/slot-cli.ts`); the rule is pure (`shared/slots.ts`) and
tested in `server/test/slots.test.ts`.

## Why the server

Several agents building and testing mobile apps on one Mac go wrong in a
particular way: six `xcodebuild`s at once, each twice as slow as alone, a
24-second UI flow waiting behind a 20-minute build, every simulator booted and
torn down per run, and a lock released only when its holder remembered to. A
script with lanes (`ios-q`, from a skill for exactly this) fixed the shape —
lanes of their own widths, a line with places in it, admission by load, a
priority the orchestrator sets — and could still only learn that a holder had
gone by polling its pid whenever somebody next called it.

The server knows every agent it started and the moment each one exits. So a
lease names the kururu terminal it was taken from (`KURURU_AGENT_ID`, the way
the report hook knows which agent it is), and `host.onAgents` ends it at once.
The queue can then be drawn in the window, raised in Needs, and read by Kuru.
None of it is the pty host's: editing any of it costs a reconnect, and no
host restart was needed to build it.

## The lanes

The script's, unchanged, so a brief written for it reads the same:

| lane | width | closed above (× cores) | memory floor | default `--max` |
|---|---|---|---|---|
| `build` | 1 | 2 | yes | 60m |
| `boot` | 1, with at most 3 booted (4 for a priority) | 2 | yes | 10m |
| `maestro` | 2, 1 per simulator | 4 | yes | 25m |
| `heavy` | 1 | 2 | yes | 60m |
| `device` | 1 | — | no | 30m |
| a simulator (`sim`) | one per simulator | — (booting uses `boot`'s) | no | 60m |

First come, first served within a lane, the user's priority ahead of everyone.
Admission is checked for the whole lane, so while the load is high nobody in it
starts and the line keeps its order. A waiter whose simulator is busy anyway
does not hold up the ones behind it. Your own `sim` lease never blocks your own
Maestro run on it; another agent's always does.

The load is the 1-minute load average (`os.loadavg`), the memory what macOS
hands out without swapping (free, inactive, speculative and purgeable pages off
`vm_stat`; `freemem` on Linux), read every five seconds while anything is
queued or a window is open. A priority skips the load gate and never the memory
floor: a Mac that swaps is slower for the user's agent too.

Settings, all optional, in `~/.config/kururu/slots.json` — every default is the
script's:

```json
{ "widths": { "build": 1, "maestro": 2 }, "load": { "build": 2, "maestro": 4, "heavy": null },
  "minFreeGb": 4, "bootedMax": 3, "bootedMaxPriority": 4, "metroBase": 8081, "jobs": 8,
  "polite": true, "ccacheConfigPath": null, "simMatch": "exact", "priorityMinutes": 60,
  "derivedData": null, "sweep": true }
```

## A take

`slot take`, `slot run` and `slot sim` are a long poll. The CLI asks; the first
ask is answered at once (so it prints its place as it joins), and every ask
after it, carrying the waiter's id, is held until the lane is granted or twenty
seconds pass, and then asked again. The line is on disk
(`~/.local/state/kururu/slots.json`), so a server restarted under `bun run dev`
costs a waiter a retry and not its place: a waiter is kept for 90 seconds of
silence, and the CLI retries a server that does not answer for 90 seconds
before it gives up with exit 6.

Only a waiter with an ask open is granted. A CLI Ctrl-C'd between two asks is
not handed a lane it will never use; its pid (`cliPid`) is reaped at the next
tick and its place goes. A lane free now is granted inside the first ask.

**Who holds a lease.** The kururu terminal (`agentId`) and the process: for a
take typed by an agent, the first ancestor that is not a shell or a wrapper —
the agent itself — with its start time, so a reused pid is not the same holder;
for `slot run`, the CLI, which releases when its command ends. A lease goes
when either half goes, or at `--max`. Two holders are one when they name the
same terminal; two terminals are two agents whatever pid each was traced to.
`--who` defaults, inside kururu, to the code of the card the agent was handed.

## Simulators

`slot sim <project>` lends one of the project's pool: simulators named
`<Project>`, `<Project> B`, `<Project> C`… (`simMatch: "prefix"` takes any
`<Project> …`), booted ones first in pool order by place in line. The first
waiter nothing booted is left for gets the next shut-down one booted for it —
under the `boot` lane, when nobody holds or waits for it and the machine
admits a boot — and the waiter is lent it once `simctl bootstatus -b` returns.
A Metro port comes with it, from `metroBase + 1` up, never one another lease
holds or something already listens on.

The pool is in `kururu.db` (`sim_pool`: project, name, runtime, state, booted
since, the fingerprint installed, the lease, when last used), so what `simctl`
cannot say — since when, which development build it carries
(`slot installed <fingerprint>`), who has it — is a lookup. It is not
exported or backed up: a udid means nothing on another Mac. The table is made
on every open (`keepShape`), not by a numbered migration, so an older
installed app still opens the file.

`xcrun` is run only once somebody asks about a simulator. On a Mac without the
command-line tools a bare `xcrun` puts up the installer's dialog, and a footer
that counted booted simulators would put it up for everybody who never builds
for iOS. `KURURU_SIMCTL` names a stand-in for testing.

## The nightly sweep

Once a day, at the first tick between 04:00 and 09:00, and only once a pool
exists (`"sweep": false` turns it off): shut down pool simulators nobody has had
for an hour, `simctl delete unavailable` (simulators whose runtime is gone),
and remove DerivedData whose workspace (`WorkspacePath` in its `info.plist`)
is no longer on the disk — a deleted scratch copy leaves gigabytes nothing
will build into again. Never a simulator that is lent, never DerivedData
written in the last hour or belonging to a checkout a build lease names.
`slot sweep` says what it would do; `slot sweep --yes` does it now.

## Where it shows

- **The footer**: this Mac's load and free memory beside the allowances
  (`Load.tsx`), in the colour of the queue's own gates — over a build's, a
  warning; over a test's, critical — with the lanes, leases and waiters on a
  hover.
- **Under the agents' pane** of a workspace marked mobile: one line, what the
  agents in that pane hold and wait for ("P5 · waiting for build behind P2 (14m
  in)"). Always there in such a pane — "nothing held here" when idle — because
  a line that came and went with the leases would resize the pty above it each
  time. Only under a pane marked as the agents' (`forAgents`), so it does not
  move when a tab is switched.
- **Needs**, when a wait passes ten minutes (`queued`, after `asking`): the
  queue jammed, a lane held by something forgotten, or the user waiting without
  having said so. The server's clock decides the ten minutes.
- **Kuru**: `kururu_status` has a slots section while anything is held or
  waiting, naming agents the way it names them everywhere;
  `prioritize_agent` is the user-is-waiting priority, listed only where slots
  are in use (a pool, a lease, a waiter, or a workspace marked mobile).

## A workspace marked mobile

Settings → Workspaces → **Builds a mobile app** (`Workspace.mobile`). A card run
there, on this Mac, starts with a paragraph on how to queue (`cardRunPrompt` in
`cards.ts`): `DEFAULT_BRIEF`, which names no project and is true of anybody's
Mac, or `~/.config/kururu/slots-brief.md` — where anything about your own
projects goes — with `{slot}` filled in with the command. The Codex sleeper
looks for a run's rollout by the same words.

## The command

The server writes `~/.local/state/kururu/bin/slot` on each start: two lines
that run the bundled `slot.mjs` on the server's own runtime. A stable path is
the point — the agents it is for work in other projects, where `bun run slot`
means nothing, and the bundle moves with every app update. From the checkout,
`bun run slot` runs the source.

```
slot take <lane> --who W --why T [--max 30m] [--udid U] [--wait 10m] [--pid P]
slot run <lane> --who W --why T [--max …] [--udid U] -- <command…>
slot sim <project> --who W --why T [--max 60m] [--no-boot] [--wait …]
slot release [<lease> | <lane>] [--who W] [--any-holder]
slot status [--json] · slot who [<lane>]
slot prioritize <who> [--for 60m] · slot unprioritize <who>
slot installed <fingerprint> [--udid U] · slot sweep [--yes]
```

Output is the script's: `export IOS_Q_LEASE=…` (and `EXPO_CUSTOM_BUILD_ROOT`
for a build; `IOS_Q_UDID`, `IOS_Q_PORT`, `IOS_Q_SIM_NAME` and, when known,
`IOS_Q_FINGERPRINT` for a simulator) on stdout for `eval`, the rest on stderr.
`slot run build` adds `-jobs` and `COMPILER_INDEX_STORE_ENABLE=NO` to a bare
`xcodebuild`, runs it under `taskpolicy -c utility`, and passes
`CCACHE_CONFIGPATH` on. Exit codes: 0 granted (for `run`, the command's own),
2 usage, 3 gave up after `--wait`, 4 no simulator for that project, 5 a
simulator would not boot, 6 no server. `--user-waiting` is refused: an agent
never puts itself first.

The log of every grant, release and reap is `~/.local/state/kururu/slots.log`:
read it to learn why an agent sat idle.

## Moving from the script

The two queues do not see each other, so a lease held under the script and one
held here would both run. Move when nothing is held:

1. Pull and restart the server (a reconnect, not a host restart), and check
   `~/.local/state/kururu/bin/slot status` answers.
2. Wait for the script's own status to show no leases and nobody waiting —
   or tell the agents using it to finish their step first.
3. Replace the script with a shim, with an atomic `mv` so a copy already
   running keeps its old file:

   ```sh
   #!/bin/sh
   # ios-q: now kururu's slot queue. The script itself is kept as ios-q.legacy.
   SLOT="$HOME/.local/state/kururu/bin/slot"
   [ -x "$SLOT" ] || exec "$(dirname "$0")/ios-q.legacy" "$@"
   "$SLOT" "$@"; rc=$?
   [ "$rc" -eq 6 ] && exec "$(dirname "$0")/ios-q.legacy" "$@"
   exit "$rc"
   ```

   Every call goes to `slot`, which rides out a server restart; only exit 6 —
   no kururu server for a minute and a half — falls back to the script, so an
   agent is never left with no queue at all. A quicker probe was the first
   draft and is wrong: it sent calls to the old queue during every ordinary
   restart, and two queues are what this is moving away from.
4. Settings carry over by hand: an `IOS_Q_WIDTH_BUILD=2` line becomes
   `"widths": { "build": 2 }` in `slots.json`, and so on down the table above.
   The script's state and config directories are left alone and can be
   removed once nothing calls the script.
5. Mark the workspaces that build mobile apps, and put your own brief in
   `~/.config/kururu/slots-brief.md` if the default is not enough.

What changes for an agent: nothing in the commands it runs. `status --json` is
`SlotsView`, not the script's shape, and `reap` does nothing, since the server
reaps on its own.
