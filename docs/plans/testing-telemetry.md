# Testing telemetry

**The owner, 2026-11-25:** "I want it to be a kuru primitive, that when we run
tests… I want to know and to be able to see that, like how we have usage, I
want to know if something is testing, what kind of testing, how many tests,
how long it takes, how many tokens are spent in testing… in a performant way
that makes sense and doesn't burn tokens keeping track of this."

Kururu records every test run its agents make, and spends no model token doing
it: nothing is typed into a pty, no agent is told to report anything, and Kuru
hears of a run only when it asks. Typecheck, lint and build runs are recorded
too, because a project with no tests still spends its minutes there.

## How kururu hears agents today

| road | what it carries | who it reaches |
|---|---|---|
| Claude Code hooks → `report.mjs` → `POST /api/report` | status, context, the prompt, the transcript's path | Claude agents in kururu's ptys on this node |
| the usage ledger's reader (`server/src/usage/`) | every billed message, read off transcripts from an offset, nudged by each report | Claude, Codex and OpenCode on this disk; a machine's logs over ssh in the sweep |
| the screen (`server/src/agents/screen.ts`) | status, for a program with no hooks | agents on a machine |
| the process table (`proctable.ts`) | which program a pty runs, memory, dev servers | everything, every few seconds |

A test run is a tool call, and both of the first two roads already see every
tool call. So nothing new is listened to: the hook that already runs before
each tool says a test is starting, and the reader that already parses each
assistant line writes the run down.

## Capture

**The record is the transcript's.** An assistant line the ledger's reader
already parses holds the `Bash` call and its command. `classifyCommand`
(`shared/testing.ts`) decides whether it is a test and of what kind; if it is,
the reader adds the call's id to the needles it searches the rest of that file
for, so the one line that holds the call's result is parsed too and every
other tool result is still passed over unread. That gives a run its start,
end, exit code and counts, for any Claude session on this disk: kururu's
agents, a `claude` typed into a shell, a subagent. A run in the background
ends at its task notification, found by the same needle.

**The hook is the live half.** `PreToolUse` already runs the reporter for
every tool call with the call on its stdin; for a `Bash` call that classifies
as a test it adds a `test` field to the report it was sending anyway. That is
the chip. A second hook, `PostToolUse` and `PostToolUseFailure` on `Bash`
only, says the run ended, with Claude Code's own `duration_ms`, the exit code
and the counts parsed inside the hook's process, so no output crosses to the
server. Hook and transcript write the same row, keyed by session and call id;
the hook's times win because they exclude a permission prompt.

A directory that runs hand-installed reporter hooks has no `PostToolUse` one,
and kururu does not write into a login directory. So `hookSettingsFlag` now
layers only the events the directory does not already run, rather than
stepping aside whole. An agent started before this has no end hook: its chip
ends when the reader sees the result, a second or two after its next tool
call.

## Overhead

Measured on the M-series Mac this was built on, 2026-11-25.

- **Start of a run: no new process.** The classifier runs inside the
  `PreToolUse` reporter that was already spawned, 2.75 µs a command. The
  bundled reporter grew from 7 KB to 36 KB, which is 3 ms more of CPU a tool
  call where it is run by node (29 to 32 ms); run by bun from a checkout, as
  the hand-installed hooks do, it measured the same before and after (12 ms).
- **End of a run: one `sh`, 5 ms of CPU per Bash call.** The end hook is a
  shell `case` over the call for a test-looking word, and only a match
  starts node. Fifteen agents making four Bash calls a minute each is 0.3 s
  of CPU a minute, half a percent of one core.
- **The reader: one more line parsed per run.** Assistant lines were parsed
  already. Replaying 60 real transcripts, 1.1 GB, through a scratch ledger
  took 0.94 s before and 1.08 s after, and found 496 runs. That 15 % is on a
  full re-read, which is a backfill; an ordinary pass reads what a turn
  appended. The first version took 1.7 s, because Claude Code's saved API
  requests quote every call id and each is a megabyte: they are now passed
  over before they are strings, and a needle is retired once found.
- **No timer and no poll.** Retention rides the ledger's five-minute sweep.
  The chip's clock ticks in the page, only while a chip is drawn. The Testing
  page asks every 20 s while it is open, a read of a few hundred rows.

## Storage

One table, `test_runs`, in `usage.db` (version 5), written in the transaction
that writes the offsets that produced it. In the ledger because a run's
tokens are a sum over that file's `messages` and its place is that file's
`sessions` row; and because `usage.db` is in no copy and no backup, so a
command line never leaves the machine. About 300 bytes a run. Kept 180 days,
pruned in the sweep.

The ledger's rule was "numbers and never words". A run's command is the one
exception and it is narrow: only the segment that classified as a test (never
the heredoc or the `cd` around it), at most 240 characters, through
`redactCommand` first. Output is never stored, only the three counts read
from it.

## Parsing

All pure, in `shared/testing.ts`, with fixtures.

- **`classifyCommand`** splits a command line on `&&`, `||`, `;`, `|` and
  newlines outside quotes, drops wrappers (`env`, `time`, `timeout`, `npx`,
  `pnpm exec`, `vault run … --`, `slot … --`), and reads the head program:
  a known runner (vitest, jest, playwright, pytest, `go test`, `cargo test`,
  `bun test`, tsc, eslint, biome, xcodebuild, maestro…) or a package script
  whose name says what it is (`chat:e2e`, `typecheck`, `lint`, `build`,
  `check:contracts`). Kinds: unit, e2e, typecheck, lint, build, simulator,
  check. A call with several is one run of the heaviest kind, since its time
  cannot be split.
- **`redactCommand`**: `NAME=value` keeps the name; a flag named like a
  secret loses its value; credentials in a URL, query values, bearer headers
  and anything shaped like a token (known prefixes, or 32+ mixed characters)
  become `…`.
- **`parseTestCounts`** reads the summary line of bun, vitest, jest,
  playwright, pytest, go, cargo, node's runner, mocha, xcodebuild, maestro,
  rspec, phpunit, dotnet and Maven/Gradle; tsc and eslint give an error count.
  A run piped through `tail` may have no summary, and then has no counts.
- **Result**: failed tests in the counts, else a non-zero exit, else passed.
  A pipeline's exit is its last command's, which is why the counts are asked
  first.

## Tokens

A run's tokens are **what its session billed after the run started, through
the first message after it ended**: the message that read the result. For a
run in the foreground that is one message, and most of it is the conversation
read back from cache, which is what a test's round trip costs. A run in the
background also counts what else the agent did meanwhile. The message that
asked for the run is not counted, so two runs in a row never count a message
twice. Summed from `messages` when the run is written and again when the
session's next message arrives; the page says the rule in a sentence.

## Flags

Worked out when asked, never stored and never announced.

- **Loose project**: a unit, e2e or simulator run in a workspace marked
  "No test suite" (`Workspace.loose`, Settings → Workspaces).
- **Slow**: more than twice the median of that suite's earlier passing runs
  in the same folder, and at least 30 s over it, with three or more to
  compare against.
- **Reruns**: the same suite five or more times in one card.

## Where it shows

- **A chip** on the agent's row and on its card: `testing: chat:e2e · 2m10s`.
- **Settings → Testing**, beside Usage: what is running now; per workspace
  and suite the runs, fail rate, median and total time, tokens and estimated
  cost; the slowest suites; minutes per day; the flags.
- **A card's history**: Kuru's `card_history` lists the card's runs.
- **Kuru**: one tool, `testing`, which answers in a few lines of text, and a
  `testing …` note on an agent's line in `kururu_status`.

## Best effort

- **Codex**: its rollout is read for `exec_command` calls and their outputs
  (the stated wall time, the counts), so runs are recorded after the fact.
  No hook, so no chip. Its tool format has moved twice; a call the reader does
  not recognise is not a run.
- **An agent on a machine**: its transcript is read over ssh in the sweep,
  through a `grep` on the far side that drops tool results. So a run has its
  command and start, and ends at that session's next message, without counts
  or an exit code. No chip.
- **Another node**: it records its own runs in its own ledger. They are not
  pulled to the parent yet.
- **OpenCode and Antigravity**: not read.
- **A run started before the server restarted** keeps its row; its chip is
  forgotten and comes back with the next run.

## Questions, and the default taken

1. *Do typecheck, lint and build count as testing?* Yes, as kinds of their
   own, so a loose project still shows where its time goes.
2. *What makes a project loose?* A switch per workspace, off by default.
   Only unit, e2e and simulator runs are flagged there.
3. *Is anybody told about a flag?* No. It is drawn and Kuru can read it; a
   notice would cost the tokens this exists to count.
4. *How long is a run kept?* 180 days.
5. *Is history filled in?* No. Recording starts with this build; re-reading
   four gigabytes of logs for the past was not asked for.
6. *One Bash call with typecheck and tests in it?* One run, the heaviest
   kind, named for every part.
7. *Where does the command live?* `usage.db`, redacted, never backed up.

## Where it stands

Built on 2026-11-25, in one pass, as designed above. What the building
changed:

- **A background run's notice has two shapes.** Older transcripts have it as
  a `user` record of plain text; Claude Code 2.1.332 writes a
  `queue-operation` when the task finishes and an `attachment` when it is
  shown. All three are read. Its exit code is taken from the end of the
  summary, after the command it quotes; 130, 137 and 143 are a run somebody
  stopped, not a failure.
- **The hook payload was checked against a real Claude Code** (2.1.332, one
  Haiku call): `tool_use_id` is on all three events, `duration_ms` on both
  ends, a non-zero exit arrives as `PostToolUseFailure` with
  `error: "Exit code 3"`, and `tool_input` comes before `tool_response`,
  which is what the shell filter cuts on.
- **The hand-installed hooks stay.** This Mac's profiles run `report-cli.ts`
  from the checkout on five events, so a start is said by them and the two
  end events are layered on at launch (`claude-hooks-tests.json`). An agent
  already running when this landed has no end hook until it is started again.
- **Codex is written from two months of format, not a live run.** The
  parser is held to hand-written fixtures of the three shapes; no Codex
  agent ran a test while this was built.
- **A machine's run** ends at its session's next message (`timed_by` is
  `next`). Not exercised against a real machine.

Not built: pulling a child node's runs to its parent, a chip for Codex, a
backfill of history, and a chart of minutes per day (the page has the table).
