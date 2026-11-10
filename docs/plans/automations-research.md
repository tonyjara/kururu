# Automations: what others do

Research for [the automations plan](automations.md), read 2026-11-10. Each
entry says where it came from and whether it was read at the source. What
kururu takes from each is at the end of its entry; the plan's own summary
table is the short form of this file.

## T3 Code (pingdotgg/t3code)

Read from the repository at `main` on 2026-11-10: the contract
(`packages/contracts/src/scheduledTask.ts`), the server
(`apps/server/src/scheduledTasks/Schedule.ts`, `ScheduledTaskService.ts`),
`docs/orchestration-v2/orchestrator-mcp-server.md`, and its issues and pull
requests. It has the feature. The settings page calls it **Scheduled tasks**
and the panel on a thread calls it **Automations**; they are one thing.

- **What a task is.** A title, a prompt, a project, a model selection, a
  runtime mode and an interaction mode (its permission settings), a
  workspace strategy (the project folder or a new worktree) and a schedule.
  Agent prompts only: there is no shell-command task.
- **Schedules.** `interval` (every N ms, floor one minute), `fixed_time`
  (HH:MM, optional weekdays), `once` (an ISO time with an offset) and
  `webhook` (a URL with a token, an optional HMAC signature, filters,
  replay and coalesce keys). Five-field cron and RRULE were added by pull
  requests #19381 and #24240, the second so that "every other Monday" could
  be said. That one stores the rule's start and time zone, because the
  start decides which Mondays are the on-weeks and an edit or a restart
  must not flip them. The editor shows the next five occurrences.
- **Where a run goes.** `new_thread` (a fresh thread per run), `continue`
  (the same thread, the same conversation) or `fresh_session` (the same
  thread, a new provider session each time).
- **State kept per task.** `nextRunAt`, `lastRunAt`, `lastRunStatus`
  (never, running, succeeded, failed), `lastRunError`, `runCount`,
  `enabled`. Pausing is `enabled: false`.
- **Missed runs.** A fixed-time run found more than ten minutes late is
  skipped and rescheduled (`isMissedFixedTimeRun`,
  `MISSED_FIXED_TIME_GRACE_MS`). There is no catch-up.
- **Overlap.** One live run per task, held in a set. A scheduled fire that
  finds the task busy returns quietly; a manual one says "already running".
  Rows left `running` by a crash are marked failed at the next start
  ("Run was interrupted by a server restart").
- **The agent's tools.** `schedule_task` (create, or update when given an
  id), `list_scheduled_tasks`, `delete_scheduled_task`. A task made from a
  thread binds to that thread by default.
- **Where it runs.** Inside the T3 server it was made on. T3 can run as a
  background service on any machine (`t3 service install`) and the app
  connects to several, but a task belongs to its server. Nothing moves one
  to another machine.
- **What went wrong for them**, from their tracker:
  - #18632: times are in the server's time zone and shown without a label,
    so a user in IST reading a UTC server sees the wrong hour.
  - #16818: a recurring task bound to a blocked thread queued a new copy of
    its prompt every interval, and reported success when the prompt was
    queued rather than when it ran.
  - #33826: finished one-off tasks pile up in the list.
  - #32491: a task made through the tool ignored the project's default
    workspace and always made a worktree.
  - #23578: delete had no confirmation.

**Taken:** the per-task state fields; one tool that creates or updates;
pause as a field; the stored anchor for "every second week"; the next five
runs in the editor; never stacking runs; reaping a run left `running`.
**Avoided:** unlabelled server time; "succeeded" meaning "was sent"; a task
that cannot leave its server; finished one-offs left in the list.

## Claude Code

Read at the source: `code.claude.com/docs/en/routines`,
`/desktop-scheduled-tasks` and `/scheduled-tasks`.

- **Cloud scheduled tasks (formerly routines).** A prompt, repositories and
  connectors, run on Anthropic's machines from a fresh clone. Triggers:
  schedule, an API call with a bearer token, GitHub events. Minimum
  interval one hour. A bare cron expression is read in UTC unless it opens
  with `CRON_TZ=`. Runs start in auto mode, where a classifier allows or
  blocks what would have prompted. Run now, a pause switch, a history, and
  plain sentences for a run that did not start ("The last run didn't start
  because…"). Hourly caps per account. It cannot reach a private network:
  no local files, no tailnet.
- **Desktop scheduled tasks.** Run on the user's machine while the app is
  open and the machine awake. Each task is a folder,
  `~/.claude/scheduled-tasks/<name>/SKILL.md`, with `name` and
  `description` in the frontmatter and the prompt as the body. The
  schedule, folder, model and enabled state are **not** in the file.
  Presets (hourly, daily, weekdays, weekly, manual) and a custom cron in
  local time. A deterministic delay of a few minutes staggers starts.
  **Missed runs:** on start or wake, exactly one catch-up run for the most
  recently missed time in the last seven days, older ones discarded, and a
  notification that it is a catch-up. The history lists skipped runs with
  the reason: asleep, the previous run still going, other tasks running.
  A permission mode per task, and an "always allowed" list per task built
  by pressing Run now once and answering the prompts.
- **`/loop` and `CronCreate`.** Inside one session. Gone with the session,
  expired after seven days, no catch-up.
- **The CLI's headless mode**, checked against `claude --help` on this Mac
  (2.1.322): `-p` with `--output-format json`, `--max-budget-usd` (print
  mode only), `--permission-mode`, `--session-id`, `--model`.

**Taken:** one catch-up run and no more; skipped runs kept in the history
with the reason; the prompt as the body of a Markdown file; a "manual"
schedule; Run now as the way to test; plain sentences for why a run did not
start. **Avoided:** half the definition living outside the file; the cloud
as a host, since it cannot reach the tailnet (see [the Pasapy
example](automations.md#the-first-one-the-pasapy-crawl-review)).

## Codex app

Read at the source: `developers.openai.com/codex/app/automations`, which
now redirects to `learn.chatgpt.com/docs/automations`.

- Recurring tasks, called scheduled tasks on the page. Advanced schedules
  are RRULEs. A task runs in the local project or in a new worktree, and
  the app must be running with the project on disk.
- The **Scheduled** view "acts as your inbox": runs with findings appear
  there with an unread mark.
- They run unattended with the default sandbox settings and
  `approval_policy = "never"`.
- A model and reasoning effort per task; a task naming a retired model has
  to be edited.
- Advice the page gives: test the prompt by hand first; write the prompt so
  it says what to do each run, how to decide what to report and when to
  stop; archive old runs, because a worktree per run piles up.

**Taken:** a run with nothing to report makes no noise; the unread mark on
runs that found something; the prompt saying how to decide what to report.
**Avoided:** a worktree per run by default.

## Cursor automations

Read at the source: `cursor.com/docs/cloud-agent/automations`.

- Cloud agents started by triggers: a schedule (presets or cron), GitHub,
  GitLab, Slack, Linear, Sentry, PagerDuty, a webhook. A scheduled run "may
  run with a delay but will not start before the indicated time".
- Results are pull requests, comments and Slack messages.
- A **memory** shared across the runs of one automation (`MEMORIES.md`),
  on by default, with a warning about untrusted input.
- A forum thread ("Cursor automations stopped running on hourly schedule")
  has staff explaining that a guard against duplicate agents had been
  skipping every new scheduled run.

**Taken:** late, never early; a note that an overlap guard needs a reaper,
or it becomes a schedule that never runs again. **Not taken yet:** a memory
per automation. An agent in a project already has the project's own notes
and reports (the Pasapy skill reads the last report), and a profile-level
automation gets a folder of its own, where Claude Code keeps memory anyway.

## GitHub Actions `schedule`

From memory of the documentation, not re-read today.

- A workflow file in the repository with a cron line. Deploying is a push;
  the history, the logs and a manual run (`workflow_dispatch`) come with
  the platform.
- Cron is in UTC, starts are often late at the top of the hour, there is no
  catch-up, and schedules in an inactive public repository are switched off
  after sixty days.

**Taken:** the definition as a file that travels with the repository; run
now beside every schedule. **Avoided:** the file being the switch. A pull
that changes a file must not change what runs unattended on a machine.

## systemd timers

From the manual pages, not re-read today. To be checked on each box when
the machine phase is built.

- `OnCalendar=` takes a weekday, a date pattern, a time and an IANA zone
  (`Mon *-*-* 09:00:00 America/Asuncion`). It cannot say "every second
  week".
- `Persistent=true` runs a missed timer once at the next start.
- `Type=oneshot` with `TimeoutStartSec=` is a hard time limit, and one unit
  never runs twice at once.
- `systemctl --user show <timer>` gives `LastTriggerUSec` and
  `NextElapseUSecRealtime`.
- A user's timers run while they are logged out only with lingering on,
  which a child kururu already relies on ([linux](../linux.md#the-unit)).
- A unit's `PATH` is not the login shell's. The child's unit writes the
  path in for that reason.

**Taken:** this is the runner on a machine with no kururu.

## launchd

- `StartCalendarInterval` in a job's plist. A time that passed while the
  Mac slept runs once on wake, several missed times as one. Nothing runs
  while it is off. No time zone but the system's, no history.

**Not used for scheduling.** The server already runs under a supervisor
(`run.mjs`, the menu-bar runner), and a launchd job per automation would
start agents outside the pty host, where kururu could not show or stop
them. launchd stays what it is today: how the host is started
(`hostlaunch.ts`).

## cron

- Everywhere, and the least it could be: no catch-up, no time zone on most
  systems, a bare environment, output mailed to nobody, overlap allowed.

**A fallback only**, for a machine without systemd, and not in the first
phases: all three of the owner's boxes have systemd.

## Dokploy schedules

Read from a search of `docs.dokploy.com/docs/core/schedule-jobs`; the time
zone detail comes from a third-party mirror and is unverified.

- A cron line attached to an application, a compose service or the server
  itself, run with `docker exec` or as a host script, with a run button and
  logs per run. The docs say to test the command by hand first.

**Noted:** MV already runs Dokploy, and the Pasapy collector's own schedule
lives there. A job that belongs to a deployed service should stay a Dokploy
schedule. A kururu automation is for work that needs an agent or belongs to
the owner rather than to a service.

## Sources

- [pingdotgg/t3code](https://github.com/pingdotgg/t3code)
- [Claude Code: scheduled tasks in the cloud](https://code.claude.com/docs/en/routines)
- [Claude Code: Desktop scheduled tasks](https://code.claude.com/docs/en/desktop-scheduled-tasks)
- [Claude Code: /loop and the cron tools](https://code.claude.com/docs/en/scheduled-tasks)
- [Codex: scheduled tasks](https://developers.openai.com/codex/app/automations)
- [Cursor: automations](https://cursor.com/docs/cloud-agent/automations)
- [Cursor forum: automations stopped running on hourly schedule](https://forum.cursor.com/t/cursor-automations-stopped-running-on-hourly-schedule/155679)
- [Dokploy: schedule jobs](https://docs.dokploy.com/docs/core/schedule-jobs)
