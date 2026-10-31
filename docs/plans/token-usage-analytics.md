# Token usage analytics, and whether the data should live somewhere else

A plan, written 2026-10-31 from a read of the tree at `106ec09`, of the real
logs on this Mac and of the current docs for Claude Code, Codex and OpenCode.
Nothing was built. The logs and `kururu.db` were read and never written; the
database was measured on a scratch copy that has since been removed. The
analysis script and its output are in `~/Documents/Kururu/` beside the two
research notes the subagents wrote
(`research-agent-logs-2026-10-31.md`, `research-storage-options-2026-10-31.md`).
The plan is written so that an agent can take one phase, read the files it
names, and know what "done" is.

**The ask, in the user's words:** to know how much we spend in general and
where the tokens go; "sometimes I feel like I run out of tokens too soon", so
show why; Kuru (the harness) versus the agents over time, and per workspace;
and the data for optimising tokens later, Kuru first of all. Then: kururu "is
going to grow a lot more" — are we storing things the best way? A data lake?
Are vector databases even worth it?

## Verdict

**Build a usage ledger, in a second SQLite file beside `kururu.db`, filled by
an incremental reader of the files the three programs already write, with the
attribution kururu alone knows written down at launch.** Every number the user
wants is already on this disk: Claude Code writes the model's own `usage`
object on every assistant record of every transcript, and since 2.1.3xx a
per-session `cost-state` record with its own dollar figure; Codex writes a
`token_count` event per API call into every rollout; OpenCode keeps tokens and
cost on every message row of its SQLite database. What none of them know is
which workspace, card, agent or harness a session was — and kururu does, at
the moment it spawns the pty. Reading what is there costs no model tokens, no
network request and, measured, under a second of CPU a day. The thing that
makes it urgent rather than nice is that **Claude Code deletes the transcripts
after 30 days and is deleting them now**: this profile's logs start on
2026-10-01, thirty days before today, and the week of 2026-09-24 has already
gone. The ledger is the durable copy; the raw logs are not worth copying
(3.7 GB, two thirds of it tool output, and they hold the content).

**On storage: stay on SQLite, and do not add a second engine.** `kururu.db` is
12.8 MB after five weeks and grows about a megabyte a week; the ledger will
grow about a megabyte every two days at this week's pace, a few hundred
megabytes a year. Both are ten years from the point where SQLite with proper
indexes and a daily rollup table takes longer than a blink. DuckDB would be a
native binary in an app that ships none, Parquet without an engine is a file
format with nothing to query it, a data lake is a word for a company's problem,
and semantic search over five thousand turns of a conversation the user
already finds with FTS5 is a hundred megabytes of model for a question nobody
has asked yet. The section at the end names the measurable points at which
each of those answers would change.

## What this week looked like

The first analysis the user asked for, on the real logs. Read off every
assistant record in the profile's Claude transcripts (1,011 sessions, 303
subagent files, 3.7 GB) and the machine login's older ones (284 sessions,
448 MB), usage fields and metadata only, deduplicated on message id. "This
week" is 2026-10-25 to 2026-10-31 in the Mac's zone. Dollar figures are
**estimates at Anthropic's published API list prices** (read off
platform.claude.com on 2026-10-31); the user pays a subscription, so they are
what the week *would* have cost on the API, which is also the only
denomination anybody publishes. They match Claude Code's own `cost-state`
figure to the cent on every session checked, so the arithmetic is the one
Claude Code uses.

| | messages | tokens | cache read | cache write | input | output | thinking | est. $ | share |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **agents** | 18,708 | 4,952 M | 4,873 M | 57.5 M | 69 k | 21.4 M | 8.6 M | 2,065 | 95.4 % |
| **Kuru** | 1,827 | 238 M | 233 M | 4.1 M | 5 k | 0.6 M | 0.1 M | 92 | 4.6 % |
| total | 20,535 | 5,190 M | 5,106 M | 61.6 M | 74 k | 22.1 M | 8.8 M | 2,157 | |

By workspace folder (the folder a session ran in; the harness's own folder is
Kuru):

| folder | messages | tokens | est. $ | share |
|---|---:|---:|---:|---:|
| `~` (the home folder) | 6,485 | 1,975 M | 867 | 38.0 % |
| rogapy | 3,531 | 988 M | 389 | 19.0 % |
| platypost | 3,148 | 875 M | 367 | 16.9 % |
| kururu | 1,822 | 351 M | 151 | 6.8 % |
| pasapy | 1,411 | 333 M | 129 | 6.4 % |
| Kuru | 1,827 | 238 M | 92 | 4.6 % |
| subignite | 944 | 226 M | 72 | 4.3 % |
| fastermenu | 435 | 81 M | 29 | 1.6 % |
| nine more | 932 | 125 M | 61 | 2.4 % |

By model: Opus 5.5 took 92.5 % of the tokens and $1,746; Fable 5.1 7.5 % and
$411 (its tokens cost 2.5× as much). Subagents were 1 % of tokens and $56.
By day the week ran from 231 M tokens (Monday) to 1,321 M (Thursday), $93 to
$486 a day. 158 sessions were touched; 28 cost over $20; the most expensive
tenth of the sessions took 35 % of the dollars.

By kind of token, which is the part that explains the bill:

| kind | est. $ | share of $ | tokens | share of tokens |
|---|---:|---:|---:|---:|
| cache read | 1,040 | 48.2 % | 5,106 M | 98.4 % |
| cache write, 1 h | 562 | 26.1 % | 59 M | 1.1 % |
| output, thinking included | 533 | 24.7 % | 22 M | 0.4 % |
| cache write, 5 m | 21 | 1.0 % | 2.5 M | |
| input, uncached | 0.50 | | 0.07 M | |

**What it says.** Nearly every token is the conversation being re-read: on
each API call the model is sent everything so far, cached, and the cache read
is cheap per token but there are billions of them. The size of the context
being carried is therefore the whole story. The agents' median message this
week carried **235 k tokens of context, the 90th percentile 472 k, the largest
848 k** — Opus 5.5 and Fable have a million-token window and the sessions are
being driven deep into it. Half of the agents' cache-read dollars ($455 of
$994) were spent on messages carrying 200–400 k, and a third ($354) on
messages past 400 k. Kuru, by contrast, is held at 200 k by its compaction
point: its median message carries 128 k, and it is the single most expensive
session of the week ($92, 1,821 messages) only because it is woken 260 times a
day — every `[kururu]` notice is one more re-read of 128 k. The seven most
expensive sessions after Kuru's were all card runs that reached 550–850 k of
context.

Two things an optimisation pass would read straight off this: **where a
session's context passed 200 k and what it was doing when it did** (a
compaction point for agents, or a card-run rule that splits work, would have
saved more this week than anything done to Kuru), and **how many wakes Kuru
had per hour and what each cost** (fewer, batched notices are the lever there,
not a smaller role file). Both need the per-message rows this plan keeps; the
per-session totals Claude Code writes cannot answer either.

**A finding on its own:** 38 % of the week ran in the home folder, which no
workspace owns. 52 of the 53 sessions there were card runs — cards on the
profile board, which has no workspace and so gets `~` as its folder. The
ledger can attribute them by card, because `card_runs` records the session
id; but a card about rogapy run from `~` is a Claude with no `CLAUDE.md` and
no project context, and that is probably not what anybody meant. Noted for
the user, not for this plan to change.

Codex and OpenCode were a footnote this week: two Codex sessions on 2026-10-30
(17.3 M tokens, 96.5 % cached) and no OpenCode turns. Both are read the same
way and both are in the plan.

## Where the numbers come from

Everything below was verified against files on this Mac on 2026-10-31. Field
names are the programs' own and may move; see risks.

### Claude Code

`<CLAUDE_CONFIG_DIR>/projects/<folder-as-dashes>/<session>.jsonl`, one record
per line, plus `<session>/subagents/agent-<id>.jsonl` (with a `.meta.json`
beside each naming the agent type and the tool use that spawned it). The
directories to read are the machine's (`~/.claude`, or `CLAUDE_CONFIG_DIR`)
and each profile's `claude/` under `~/.config/kururu/profiles/` — exactly the
list `logins.ts` already knows, and nothing is scanned that the server would
not already open for the usage bar.

- **Assistant records** (`"type":"assistant"`) carry `message.usage`:
  `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`,
  `output_tokens`, `output_tokens_details.thinking_tokens`,
  `cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`,
  `server_tool_use` and `service_tier`; `message.model` and `message.id`;
  and on the record `sessionId`, `timestamp`, `cwd`, `requestId`,
  `isSidechain`, `version`, `gitBranch`, `requestedModel`, `effort`. A
  streamed reply is written as **several records sharing one `message.id`
  and `requestId`** — 500 assistant records in one session were 142 billed
  messages — so a row is keyed `(sessionId, message.id)`. On 2.1.311 every
  duplicate carries identical usage (124 of 124 checked); ccusage, which has
  watched this longer, keeps the most complete duplicate, and so does the
  reader — the last sighting wins, which is the same row today and the right
  one if the counts ever grow across the stream. `transcript.ts` already
  reads these fields for the context ring; the parser here is its sibling,
  not a replacement.
- **`cost-state` records** are Claude Code's own running total for the
  session: `totalCostUSD`, `startTime`, `totalDuration`, and `modelUsage`
  per model with input, output, thinking, cache read, cache creation split
  into 5 m and 1 h, web searches and `costUSD`, plus `hasUnknownModelCost`.
  Written a few times per session into the same file (four in a
  142-message session; 206 of the 211 sessions of the last ten days have
  one), cumulative and last-wins, no timestamp of its own but `startTime +
  totalDuration` is when it was written. It is the figure the page shows as
  "Claude Code says", and the cross-check on the estimate. It is
  **undocumented and absent from the changelog** — community notes trace it
  to 2.1.269 — so it is a cross-check, never the source of a row.
- **What is skipped.** `user` records (tool results inline) are 63 % of the
  bytes and `api-request-blob` records another 32 %: since 2.1.300 the
  changelog says transcripts "also record each API request's system prompt,
  tools and parameters", and **no setting turns that off**. The assistant
  records the ledger wants are under 2 %. The reader decides by a byte
  search for `"type":"assistant"` or `"type":"cost-state"` before it parses
  a line, so the heavy lines cost a read and nothing else.
- **Subagents** are rows of their own in the subagent file, `isSidechain`
  true, `sessionId` the parent's in the files here, `agentId` their own; the
  parent's transcript carries only a subagent's last turn, so the usage is
  only in these files. Keyed by `agentId`, they inherit the parent's
  attribution and are marked, so the page can show them inside or beside the
  session.
- **Compaction** writes a `compact_boundary` system record; it changes
  nothing here, since every message is still billed and recorded.
- **The harness** is the session in `harnessHome(profileKey)`'s project dir
  (`~/.local/share/kururu/harness/<pk…>` since 2026-10-15); before that it ran
  in a project's dir with `customTitle: "harness"` in its head, which
  `harnesshome.ts`'s `wasHarness` already recognises. Both rules are kept.
- **Retention.** Claude Code's `cleanupPeriodDays` (settings reference,
  read 2026-10-31) defaults to **30**, minimum 1, `0` fails validation, and
  the documented way to keep everything is "a large value such as 3650". The
  sweep runs in the background once per session start — not under
  `-p --bare` — and deletes session files "older than" the period, with the
  subagent directory going with its parent; the docs do not say whether
  that is the file's mtime or its last message. `history.jsonl` and
  `stats-cache.json` are never swept, and neither holds usage. Observed:
  this profile's directory dates from 2026-09-24 and its oldest surviving
  session is 2026-10-01; the machine's `~/.claude`, where nothing has
  started since 2026-09-24, still holds July–September (13,342 messages)
  and will lose everything older than 30 days the next time a `claude`
  starts there. **Backfill it first.**

### Codex

`<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`. The first line
is `session_meta` (`id`, `cwd`, `cli_version`, `originator`); each turn opens
with a `turn_context` naming `model`, `cwd` and `turn_id`; and every API call
writes an `event_msg` of type `token_count` whose `info.last_token_usage` has
`input_tokens` (cached included), `cached_input_tokens`,
`cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens` —
`cached_input_tokens` is a subset of `input_tokens`, as Codex's own
`non_cached_input = input − cached` says — with `info.total_token_usage` the
session's running total and `rate_limits` the allowance `codexusage.ts`
already reads. The events carry no id, so a row is the **difference between
consecutive totals**, which is monotonic and survives a re-read. Newer
rollouts also write a `TokenUsageRecord` item; the reader takes whichever is
there. `~/.codex/state_5.sqlite` has a `threads` table with `tokens_used`,
`cwd`, `model` and `rollout_path` per thread — a cheap cross-check and the
map from a thread to its folder. Codex's config reference has **no
retention key** (`history.max_bytes` is for `history.jsonl` only) and
rollouts here go back to 2026-02 unpruned; `codex archive` exists and moves
a thread aside rather than deleting it.

### OpenCode

`~/.local/share/opencode/opencode.db` (Drizzle-managed SQLite since v1.2.0,
2026-02-14; the older `storage/message/*.json` files hold the same shape for
sessions before the move and are still read by OpenCode). Table `message`,
column `data` is JSON with `role`, `modelID`, `providerID`, `tokens{input,
output, reasoning, cache{read, write}}`, `path.cwd` and `cost` — OpenCode
prices the message itself from models.dev's list, reasoning at the output
rate — keyed by `id` with `session_id`, `time_created`, `time_updated`. Read
with a read-only connection, incrementally by `time_updated`. OpenCode has
no retention of its own (a 13 GB `event` table was closed "not planned" on
2026-10-30); here its db is 132 MB. Kururu mints the `ses_` id at launch
(`mintOpencodeSession`), so attribution is exact.

### What none of them know, and kururu writes at launch

A transcript says `cwd`; it does not say which workspace, which card, which
agent id, whether it was Kuru, or which node. Kururu knows all of it when it
spawns the pty, and for Claude it even mints the session id first
(`--session-id`, `index.ts` around the `createAgent` path; `HarnessState.
sessionId` for Kuru). So a **`sessions` row is written at spawn**: program,
session id, profile key, workspace key, card id and run id when it is a card,
agent id, kind (`harness`, `agent`, `card`), node, machine, started at. Codex
learns its id a moment later off the rollout (the `learned` callback
`workspaces.noteRunSession` already does this for card runs; for a Codex tab
from the + menu the row is matched by `cwd` and a start within a few seconds
of the spawn). A **resumed** session keeps its id and so its row; a new card
run on the same session adds a run but the session stays the card's.

For the backfill, `card_runs` (session id, card, cwd, launcher, agent id,
started at) and `conversations` (session id, kind, cwd, launcher) already
attribute most of the past: all but one of this week's 53 home-folder
sessions were card runs the database knows. Sessions nothing names are
attributed by folder, and the page says so ("folder only").

Agents **on a machine** write their transcripts there; `machines.ts` already
opens a remote transcript's tail and lists rollouts over ssh for `sleep.ts`,
and the same road, with an offset, is the remote tailer (phase 6). Agents on
**another node** are that node's: each node runs the reader on its own disk,
and the parent pulls daily rollups over the link into the same table, marked
with the node — the shape the backup pull already has. Nothing of a remote
node's rows is ever written as its own; `n:<node>:…` ids stay out of this
file like every other.

Logs **already cleaned up** cannot be recovered: `history.jsonl` keeps the
prompts, not the usage, and `cost-state` leaves with its transcript. The
backfill gets whatever is on disk the day phase 1 ships — 30 days of the
profile, three months of the machine login — and the loss before that is
stated on the page rather than guessed at.

## Decisions

1. **A second SQLite file, `~/.local/share/kururu/usage.db`, not tables in
   `kururu.db`.** The boards file is "the one thing nobody can rebuild", copied
   daily (seven copies, 73 MB today) and mirrored to the backup repository.
   The ledger is rebuildable from the logs for 30 days, grows twenty times
   faster, and would make every daily copy and every backup push carry it.
   Same `node:sqlite`, same `Store` idioms (`pragma user_version`, a
   `MIGRATIONS` list, write-through, refuse rather than diverge), its own
   module `server/src/usage/store.ts`. `KURURU_DATA_DIR` moves it with the
   rest, so the isolated instance has one of its own.

2. **One row per billed API message, exact tokens, and a daily rollup table
   beside it.** The message rows are what the optimisation pass needs (context
   size at the moment, model, thinking, who); the rollup is what the page
   draws, O(days × keys) rather than O(messages). The rollup is rebuilt for
   the (day, keys) a batch of new rows touched, in the same transaction.

3. **Read the files the programs write; do not ask the programs.** Claude
   Code exports OpenTelemetry (`CLAUDE_CODE_ENABLE_TELEMETRY=1`,
   `OTEL_LOGS_EXPORTER=otlp` over `http/json`; an `api_request` event per
   call with the four token counts, the 5 m/1 h split and an estimated
   `cost_usd`, `session.id` on every point, logs flushed every 5 s and
   metrics every 60 s; no `cwd`), and a loopback receiver was considered. It
   is a second pipe for numbers the transcript already has; it needs
   environment in every pty, so a `claude` typed into a shell is missed; it
   cannot backfill a single day; Codex's token counts ride on an `sse_event`
   its current reference no longer documents; OpenCode has nothing
   comparable; and an agent on a machine could not reach the receiver. The
   transcript is written whether or not anybody listens. Revisit only if
   Claude Code stops writing `usage` into transcripts — the receiver would
   then be a day's work, since `session.id` is the key kururu already holds.

4. **Incremental, nudged by the hook, swept slowly otherwise.** Every turn of
   every Claude agent kururu started already posts `/api/report` with the
   transcript's path (`report-cli.ts`); that report is the nudge to tail that
   one file from its saved offset. A sweep every few minutes catches what has
   no hook — a `claude` typed into a shell, Codex rollouts, OpenCode's
   database, files pruned or appeared — by `readdir` and `stat` of the
   project directories (about a thousand files; a few milliseconds). Per-file
   state (`path`, `inode`, `size`, `offset`) lives in the ledger. Measured:
   a cold full read of all 4 GB took 8.7 s single-core in a Python
   prototype, so the week's 1.4 GB of appended bytes is under a second of
   CPU a day in steady state. The first backfill runs after start, in slices
   that yield to the event loop, and the page says "reading… 62 %" until it
   is done. Nothing is held in memory beyond one chunk and a partial line.

5. **Zero model tokens, by construction.** The reader types nothing into any
   pty and calls no tool. Kuru's wake carries exactly what it carries today:
   no notice, no line in the role, no new MCP tool — a tool's description sits
   in the cached prefix of every turn, and the user has not asked Kuru to
   answer spend questions. If they do, phase 7 adds `usage_report`, read on
   demand and returning a compact table; until then the page is the door.

6. **Prices are a table kururu ships, the estimate says it is one, and the
   program's own figure is shown beside it.** `shared/prices.ts`: model id,
   valid-from date, $/MTok for input, 5 m cache write, 1 h cache write, cache
   read, output; the long-context tier for Haiku 5.5 over 100 k; maintained
   by the `update-models` skill alongside `LAUNCHERS`. A model not in the
   table gets exact tokens and no dollars, flagged "unpriced" — never a
   guess. Claude Code's `cost-state` dollars and OpenCode's `cost` are kept
   in `session_totals` and drawn as "Claude Code says $x" / "OpenCode says";
   a gap between estimate and program means a stale table, and the page says
   which. Codex publishes no per-session cost and the plan does not invent
   one: Codex rows carry tokens, and dollars only if the user later supplies
   OpenAI's prices for the table (a question below).

7. **Three labels, never mixed.** *Tokens* — exact, "read off the
   transcripts". *Cost* — "estimate at API list prices; you pay a
   subscription" on every figure, and "Claude Code says" where it has one;
   this is the same footing Claude Code's own `/usage` stands on, whose
   docs call the session cost "computed locally from token counts at list
   price" and "not relevant for billing". *Limits* — the account's
   percentages from `usage.ts` and Codex's `rate_limits`, kept as snapshots
   over time so the page can draw "the week limit read 71 % at this point"
   beside the tokens of the same day, and never a token count derived from a
   percentage or the reverse. What Anthropic does say officially (help
   centre, read 2026-10-31): limits are a five-hour window and a week, with
   a separate weekly limit for Fable on Max; usage depends on length, model
   and effort; subagents "count toward the same usage limits"; thinking is
   "billed as output tokens"; a cached re-read "still draws usage for the
   whole conversation"; cache writes are charged "at a lower rate". No
   weighting is published, and the plan does not pretend to know it — the
   page says so in one line.

8. **Backfill in this order:** `~/.claude/projects` first (the one that will
   vanish wholesale on its next start), then each profile's directory
   newest-first so this week's picture appears within seconds, then Codex and
   OpenCode. Attribution of old sessions from `card_runs` and
   `conversations`; folder-only where nothing names them.

9. **The ledger is not pushed to the backup; its rollups are.** The raw db
   would be a binary growing by megabytes in a git repository. Instead the
   daily rollup is exported as text, one file a month
   (`usage/2026-10.jsonl`), appended through the backup's existing allow-list
   in `shared/backup.ts`. Numbers, keys and folder names only — no titles
   (a card title can be a sentence about a client), no content. The message
   rows are rebuildable for 30 days and, after that, are what a restore
   loses; the user can decide that is acceptable or ask for the db itself
   (a question below).

10. **Titles come from kururu, never from the transcript.** Claude Code
    writes an `ai-title` and `customTitle` into the file; those can quote the
    conversation. The page names a session by its card's title or the agent's
    label as `agentLabel` gives it, which the user typed or kururu made.

11. **Numbers off a file are numbers off the wire.** Every count is
    `Number.isFinite` before it is added; a NaN usage record is skipped and
    counted as skipped, and the page shows the skipped count under "rows not
    read" so a format change is visible rather than silent.

## Schema

`usage.db`, `pragma user_version = 1`. Times are epoch ms; keys are kururu's
`pk…`/`wk…` keys, never counter ids.

```sql
files    (path PRIMARY KEY, program, login_dir, inode, size, offset, mtime, session_id, read_at)
sessions (id PRIMARY KEY, program, profile_key, login_dir, cwd, workspace_key, card_id, run_id,
          agent_id, kind, node, machine, started_at, last_at, parent_session, version,
          attributed_by)                     -- 'spawn' | 'card_runs' | 'conversations' | 'folder'
messages (session_id, message_id, at, model, requested_model, effort, input, cache_write_5m,
          cache_write_1h, cache_read, output, thinking, cost_est, sidechain, source,
          PRIMARY KEY (session_id, message_id))
          -- source: 'transcript' | 'subagent' | 'rollout' | 'opencode'; cost_est NULL when unpriced
session_totals (session_id, model, input, output, thinking, cache_read, cache_write_5m,
          cache_write_1h, cost_program, at, PRIMARY KEY (session_id, model))
          -- what the program itself says: Claude Code's cost-state, Codex's total_token_usage, OpenCode's cost
daily    (day, profile_key, workspace_key, card_id, kind, program, model, node, messages, input,
          cache_write_5m, cache_write_1h, cache_read, output, thinking, cost_est, unpriced,
          PRIMARY KEY (day, profile_key, workspace_key, card_id, kind, program, model, node))
limits   (at, account, kind, scope, percent, resets_at, source)    -- usage.ts and Codex rate_limits, as read
skipped  (path, line_no, why, at)                                   -- what the parser would not read, capped
```

Indexes: `messages(at)`, `messages(session_id, at)`, `daily(day)`,
`sessions(workspace_key)`, `sessions(card_id)`, `limits(at)`. The `daily` key
is wide on purpose: every filter the page offers is a `GROUP BY` over a subset
of it, so one table answers all of them. Rows: this week was 20,535 messages,
so about 3,000 a day on average and 5,300 at the peak; at ~150 bytes with
indexes that is a megabyte every two or three days, 150–250 MB a year.

`shared/usage.ts` holds the row types and the pure functions (dedupe,
rollup arithmetic, labels); `shared/prices.ts` the table and `priceOf(model,
at)`. Both halves read them, and `bun test` covers them on synthetic lines
(never a real transcript — see testing below).

## The page

**Where.** Settings → System → **Usage**, beside Processes ("what every
terminal is running and what it costs" is the same question asked of the
machine). The usage chip on the bottom bar keeps its hover (the bars), and a
**click opens this page** — the chip is where "am I running out" is asked, so
it is where "why" is answered. The phone gets the same page through
Settings' list-then-page layout; nothing is drawn twice.

**What it shows first** (the dataviz skill's form rules, in order: form, then
colour, validated; one axis; no pie):

1. **A range row** across the top: *This limit week* (the account's reset
   times from `limits`, when known), *Today*, *7 days*, *30 days*, *All*;
   and one dimension control — *by workspace · by card · by agent · by model
   · by program*. Filters in one row, charts below, as the skill says.
2. **A KPI row** of `Tile`s, the block Settings already has: tokens, cost
   estimate (labelled), Kuru's share, messages; each with its delta against
   the previous period.
3. **"Where the tokens went"**: ranked horizontal bars, largest first, one
   hue, top eight and *Other*, Kuru always its own row, the share printed at
   each bar's end. This is the chart the user looks at and sees at once.
4. **"Over the days"**: a stacked column per day, two series — Kuru and
   agents — categorical, fixed order, direct-labelled; the dimension control
   swaps the stack to workspaces (≤ 6 + Other). Beneath it, aligned on the
   same days, a **small second panel** with the limit percentage readings as
   a line — a separate chart, not a second axis — so "the week limit hit 80 %
   on Thursday" sits under the 1,321 M-token Thursday.
5. **"What kind of token"**: one tall segmented bar — cache read, cache
   write, output, input — with the share on each block, because this is the
   figure that explains why five billion tokens are not five billion of
   anything the limit counts equally.
6. **Context carried**: a small-multiples strip per agent session showing
   context per message over the session — the chart the optimisation pass
   reads, and the one that would have shown the 848 k session climbing.
7. **The table**, always present: sessions in the range — when, what (card
   title or agent label), workspace, program and model, messages, tokens by
   kind, estimate, "program says", attribution ("card", "folder only") —
   sortable, with *Reveal* on a live agent and *Open card* on a card. The
   table is the accessibility fallback the skill requires and the honest
   place for the long tail.

**Colour** is theme tokens, as everything in `styles.css` is: Kuru takes
`--accent`, agents the de-emphasis step, the ≤ 6 categorical series the
board-column palette `ColorPicker.tsx` keeps, in fixed order by entity (a
workspace keeps its hue when the filter changes). The skill's
`validate_palette.js` is run per theme in a web test against each theme's
light and dark surfaces, the way `theme.test.ts` already holds the contrast
pairs. Every chart is inline SVG drawn by a small `web/src/charts/` module —
no charting library (the bundle is one build and the pages are small), hover
tooltips on every mark, a 2 px surface gap between stacked segments, text in
text tokens never series colour.

**Honesty on the page.** Under the KPI row, one line: *"Tokens are read off
the programs' own logs. Dollars are an estimate at Anthropic's API list
prices — you pay a subscription. Limits are the account's percentages, and
Anthropic does not publish how tokens weigh against them."* The reading
progress during backfill, the skipped-row count and the oldest date read are
in the page's foot.

## Phases

Each is one agent's work, with the files it touches and what "done" is. The
default builder is Opus 5.5 at xhigh; where a phase is parsing with fixtures
and no judgment calls, Sonnet 5.5 is enough and said so. Nothing in any phase
touches `server/src/agents/`, the host or the protocol: the reader is server
code (a reconnect to deploy) and the launch records are written where the
server already spawns.

| # | phase | files | done when | model |
|---|---|---|---|---|
| 1 | **Ledger and the Claude reader.** `usage.db` store with migrations; the tailer (offset per file, byte-search before parse, dedupe on message id, `cost-state` into `session_totals`, subagent files); the sweep and the `/api/report` nudge; backfill in the order of decision 8, sliced; attribution from `card_runs`/`conversations`/harness folder; `daily` rollup; `shared/prices.ts` with the current table. | `server/src/usage/{store,claude,tail,sweep}.ts`, `shared/usage.ts`, `shared/prices.ts`, hooks in `index.ts` where `/api/report` lands, tests on synthetic lines | `bun run status` prints the ledger's row count and oldest day; a fresh server backfills this Mac within a minute without the window stuttering; `SELECT` by week reproduces the table above to the message. | Opus 5.5 xhigh |
| 2 | **Attribution at launch.** `sessions` rows written at every spawn kururu makes — + menu, card run and resume, Kuru's `start_agent`, the harness itself, idle-sleep resume — with workspace key, card, run, agent id, kind, node, machine; Codex's id on `learned`, else matched by folder and time. | `index.ts` spawn paths, `harness.ts`, `workspaces.ts` (`noteRunSession`), `server/src/usage/attribute.ts` | Every agent started after the phase shows under its workspace and card on the page with `attributed_by = 'spawn'`; a resumed card keeps one session row; the `~` folder stops appearing for profile-board cards (they show as the card). | Opus 5.5 xhigh |
| 3 | **Codex and OpenCode readers.** Rollout tailer with the totals-difference rule and `turn_context` model; `rate_limits` snapshots into `limits`; OpenCode's db read-only, incremental by `time_updated`, legacy `storage/` once for backfill. | `server/src/usage/{codex,opencode}.ts`, fixtures | A Codex and an OpenCode session started by hand (`sleep`-safe stand-ins per `docs/testing.md`) appear with exact tokens, and the two 2026-10-30 Codex sessions backfill to 17.3 M tokens. | Sonnet 5.5, default effort |
| 4 | **The page.** `GET /api/usage/report?range&by`, computed from `daily` and `sessions`; Settings → System → Usage with the seven elements above; chip click; `web/src/charts/` SVG primitives (bar, stacked columns, line, segmented bar, sparkline, tooltip); palette validation test per theme. | `web/src/settings/Usage.tsx`, `web/src/charts/*`, `web/src/components/Usage.tsx` (the click), `Settings.tsx` GROUPS, `web/test/usage-palette.test.ts`, one route in `index.ts` | The user opens it and the first screen is the ranked bars for this limit week; every chart has a table view; light and dark pass the validator; phone layout works at 390 px with no horizontal scroll. Verified in a real window, not only headless (the pattern in memory: Settings pages have shipped unpressed before). | Opus 5.5 xhigh, with the dataviz skill loaded |
| 5 | **Limits over time and the backup export.** `usage.ts` and `codexusage.ts` write each reading into `limits`; the second panel draws them; monthly rollup export as text through `shared/backup.ts`'s allow-list; `bun run backup --check` lists it. | `server/src/usage/{limits,export}.ts`, `shared/backup.ts`, `backup.ts` | The limit line appears under the day chart; a backup carries `usage/2026-10.jsonl` and nothing else new; a restore reads it back into `daily`. | Sonnet 5.5, default effort |
| 6 | **Remote: machines and nodes.** Over ssh, tail a pinned workspace's transcripts and rollouts from a saved offset on the sweep (`machines.ts`'s `sessionTailOn` grown an offset); a child node runs the reader itself and the parent pulls its `daily` rows over the link into the same table marked `node`. | `server/src/usage/remote.ts`, `machines.ts`, `nodewatch.ts` or the backup-pull road, `shared/nodes.ts` | An agent on a stand-in machine and a throwaway child both show on the Mac's page with their node or machine named; nothing qualified is written to disk. | Opus 5.5 xhigh |
| 7 | **Optional, on the user's word: Kuru's `usage_report`.** One MCP tool returning the KPI row and the ranked list as a compact table for a range; the role gains one line saying it exists and is for when the user asks. | `shared/harness.ts`, `server/src/harness.ts` | Kuru answers "what did I spend this week" from the ledger; its wake carries nothing new otherwise. | Sonnet 5.5 |

Phase 1 is the one that matters today, because of the pruning. Phases 2 and
3 can run in parallel with it in worktrees (both touch `index.ts`; the
worktree rule in memory applies — make the worktree before the first edit,
since `bun run dev` restarts the user's server on any save under
`server/src`). Phase 4 needs 1; 5 and 6 need 4; 7 needs the user.

**Testing.** Pure functions on synthetic lines only: a fixture of a dozen
hand-written records with the real field names and made-up numbers, in
`server/test/fixtures/usage/`, never a copy of a real transcript (it holds
content). The tailer against a temp directory the test appends to, including
a half-written last line and a file deleted mid-read. The isolated instance
(`docs/testing.md`) with `KURURU_DATA_DIR` for the end-to-end, spawning
`sleep 30` as the agent — nothing here needs a real model.

## Risks

- **The formats are the programs' private business.** `cost-state`,
  `api-request-blob`, the `cache_creation` split and `iterations` are
  undocumented; Codex's `token_count` has moved before; OpenCode moved from
  JSON files to SQLite this year. Every field is read defensively, a line
  that will not parse is counted in `skipped` and shown, and an unknown
  model is unpriced rather than priced wrong. The parsers are pure and small
  so a drift is a one-file fix.
- **Double counting.** Streamed records sharing a `message.id`; the same
  rollout totals re-read after a crash; a transcript visible through two
  config dirs (it cannot be — each session has one home). Dedupe keys and
  the totals-difference rule cover the first two; a test holds each.
- **The backfill is the only heavy moment.** 4 GB read once. Sliced with
  yields, started after the window is up, newest first; the page shows
  progress. On a child node with a slow disk it is the same code and the same
  slices.
- **A pruned or rotated file.** Deleted between `readdir` and `open`: skip
  and forget the offset. An inode changed under the same path: start from
  zero (the dedupe makes a re-read harmless).
- **Secrets and content.** The reader parses only assistant and cost lines
  and stores only numbers, ids, model names, folders and kururu's own
  titles. No transcript text ever enters `usage.db`, the API or the backup; a
  test on the store's writers holds it, the way `vaultview.test.ts` holds
  that no value comes out of the vault page.
- **Time.** Days are the Mac's local day; the limit week is the account's
  reset instant. Codex timestamps are UTC ISO; OpenCode's are epoch ms;
  Claude's are ISO Z. All stored as epoch ms, bucketed at display time.
- **Attribution drift.** A session whose folder is a worktree
  (`…/kururu/.worktrees/…`) belongs to the workspace, not a workspace of its
  own: phase 2 maps by the workspace's root, as `files.ts` already finds it.
- **The context ring and this disagree.** They read the same fields; the
  ring reads the last message, the ledger all of them. A disagreement is a
  parser bug and visible on the table (context carried on the last row vs
  the ring).

## Part 2 — Kururu's data, and whether it should live differently

### What there is, measured 2026-10-31

| what | where | size | growth | who can rebuild it |
|---|---|---|---|---|
| boards, conversations, voice lists | `~/.local/share/kururu/kururu.db` | 12.8 MB (turns 5.8 MB, turns FTS 2.2 MB, cards 1.5 MB, events 0.7 MB, voice 0.5 MB) | ~1.2–1.7 k turns a week ≈ 1 MB/week; 724 cards, 4,750 turns, 6,362 events after five weeks | nobody — this is the precious one |
| daily copies and the mirror | `db-copies/` (7), `backup/` | 73 MB, 25 MB | with the db | derived |
| Claude Code transcripts | profile `claude/projects` + `~/.claude/projects` | 3.7 GB + 448 MB | **1.4 GB this week** (200–320 MB/day); 63 % tool output, 32 % request-debug blobs, < 2 % the usage records | Claude Code deletes at 30 days |
| Codex rollouts | `~/.codex/sessions` + profile | 38 MB | small; unpruned since 2026-02 | Codex keeps them |
| OpenCode | `~/.local/share/opencode` | 606 MB (snapshots 186, its binary 161, db 132) | little lately | OpenCode's |
| kururu state | `~/.local/state/kururu` | 570 MB, of which `runtime/0.5.0-…` is 569 MB (one app version's runtime copy) and every log and json under 1 MB | runtime per app version | rebuildable |
| caches | `~/.cache/kururu/voicelab` | 11 GB of trial TTS engines | none | the user said they would name which to delete |

Query times on the database copy: an FTS match 1–3 ms, a `GROUP BY`
conversation over all turns 7 ms, a full scan of turns with `length(text)`
26 ms. Nothing here is slow or near slow. Terminal screens and backlogs are
never on disk: they live in the pty host's memory and die with it, by design.

### Projection

At this week's pace `kururu.db` reaches ~60 MB in a year and FTS stays in
single-digit milliseconds; it would need a decade to reach a size where
SQLite's own guidance (it names "data analysis" and log analysis as fitting
uses, and says to look elsewhere when content "might creep into the
terabyte range" or there are many concurrent writers) is in sight. The
ledger: ~1 M message rows and 150–250 MB a year; a `GROUP BY day,
workspace` over `daily` is thousands of rows however many messages are
behind it, and over `messages` with a covering index the published figure
to hold onto is a filtered `GROUP BY` over **10 M rows in ~113 ms** in
SQLite (a 2021 gist, integer columns, laptop) — ten years of this user's
ledger — and seconds without the index, which is why the rollup table is
not optional. The worst query the page has, the context-per-message strip,
reads one session. Ten heavy users on ten nodes pulled into one parent is
ten times that, still SQLite's weather. The thing that *does* grow without
bound is other programs' logs, and the answer there is the ledger, not a
bigger disk.

`node:sqlite` itself: added in Node 22.5, unflagged in 22.13, "release
candidate" from 24.15; the app's Electron 44.3 runs Node 24.22, and
Electron has shipped `node:sqlite` working since 37.2.3. Extensions load
through `allowExtension: true` + `loadExtension()` (22.13+), which is the
door sqlite-vec would use. FTS5 is compiled in (`SQLITE_ENABLE_FTS5` in
Node's `sqlite.gyp`), as this repository's tables already prove.

### The options, against that

| option | what it would buy | what it costs | verdict |
|---|---|---|---|
| **SQLite, as now, with the ledger in its own file** | nothing new to ship, one API (`node:sqlite`, in the Node the app already runs), FTS5 built in, the daily-copy and backup story unchanged, the isolated instance unchanged | a schema and a rollup table — work this plan already specifies | **do this** |
| SQLite, ledger inside `kururu.db` | one file | the precious file grows 20× faster, every daily copy and backup push carries the ledger, a restore gets both or neither | no |
| **DuckDB** (`@duckdb/node-api` 2.0) | columnar aggregates, fastest in every published comparison at tens of millions of rows (and at parity with indexed SQLite at 10 M in the one gist with numbers); attaches a SQLite file and reads or writes Parquet directly | a native binary per platform — 66 MB unpacked for darwin-arm64, 96 MB for linux-x64 — in an app that today ships no native module; whether it loads under Electron's helper is undocumented and would need a hands-on test; DuckDB's own docs warn that two copies of the SQLite library in one process "can cause errors", and `node:sqlite` is already one; a second query language and connection model in the server | not until the ledger passes ~50 M rows or a `daily` query passes 500 ms, neither of which this decade's usage reaches |
| **Parquet** files for the ledger | compact (zstd Parquet ~8× over a SQLite file in the one archive measured), portable, the lingua franca of analytics tools | no engine to query it without DuckDB; the one credible pure-JS writer (`hyparquet-writer`, 246 KB, no native code, weekly releases, created 2025) is young; a desktop app would be writing a format for a tool it does not ship | as a **cold export**, maybe — a yearly `usage-2026.parquet` the user can open in anything — and only once somebody asks |
| **A data lake / lakehouse** (Iceberg, Delta) | table formats for petabytes across many engines and writers on object storage, through a catalog | all of their machinery, for one writer's gigabytes on one laptop | no; the phrase does not apply at this scale |
| **A vector store** (sqlite-vec, LanceDB) for semantic search over turns and cards | "find the conversation where we decided X" without the exact word | an embedding model on the CPU for every turn (MiniLM int8 is 23 MB, fp32 90 MB; no trustworthy per-text latency figure found), ~1.5 KB of vector per turn, and a second index to keep consistent — for a corpus of 4,750 turns and 724 cards that FTS5 already searches in a millisecond with BM25 ranking, prefix, phrase and a trigram tokenizer that suits identifier-heavy text; BEIR's finding that BM25 is a robust baseline and dense retrieval often underperforms out of domain applies to transcripts full of paths and card codes | not now; the measurable trigger is the user failing to find something with FTS that they know is there, more than once — then sqlite-vec (162 KB, pre-v1, brute force to hundreds of thousands of rows, loads into `node:sqlite`) is the smallest step, and it is a step, not a migration; LanceDB's 262 MB binary is the one to avoid |
| **Compress the raw logs ourselves** (zstd in `node:zlib` since 22.15 / 23.8, still marked experimental) | keep every transcript at ~1/6 to 1/13 the size (5–10× is typical for JSON lines; Zed got 12.75× on thread JSON), past Claude Code's 30 days | kururu becomes the keeper of 10–20 GB a year of other programs' content, with every secret in it, on a disk the user did not offer | no; keep the numbers, not the words — and tell the user `cleanupPeriodDays` exists |

The precedents point the same way. ccusage, the most-used tool for exactly
this, keeps no store and re-reads the JSONL every time — fine for a CLI,
not for a page that must survive the 30-day sweep. Claude Code's own
`/usage` computes from local session history and its `/insights` report is
pruned at 30 days too. Zed moved its threads from LMDB to SQLite with
zstd-compressed JSON (200 MB → 4 MB); Warp and VS Code keep state in SQLite;
Cursor's and Windsurf's usage pages are server-side, which is not an option
here. Nobody shipping a desktop tool at this scale reached for a second
engine.

**Position.** Stay on SQLite, two files, with the discipline this plan
adds: a rollup table for anything drawn on a page, text exports for anything
that must survive a lost machine, and nothing stored that another program is
the keeper of. The honest answer to "data lake" and "vector database" is
*not worth it yet*, and the points at which that changes are measurable and
written above: 50 M ledger rows or a 500 ms page query for the engine; a
search the user cannot make FTS answer for the vectors. Growth that would
move those dates is not the user typing more, it is more nodes — and a node
keeps its own ledger and sends rollups, so the parent's tables grow by the
rollup, not the message.

## Questions only the user can answer

1. **Should kururu set `cleanupPeriodDays` for the profile logins it made?**
   The ledger keeps the numbers either way. Keeping the transcripts longer
   (90, 365, or the documented "3650" for never) keeps `--resume` and the
   conversation search working further back, and costs ~200–300 MB a day of
   disk at this pace — a third of it the request-debug blobs nothing can
   switch off. Writing that key into a profile's `settings.json` is a line
   kururu has not crossed — it writes hooks there already, so it is a
   decision, not a technical question. Default if unanswered: do not write
   it; show the current value on the Usage page with the sentence that
   explains it.
2. **Codex in dollars?** Codex publishes no per-session cost. If the user
   wants a Codex estimate, somebody pastes OpenAI's current prices for the
   models in use into `shared/prices.ts`, labelled as such. Default: tokens
   only for Codex.
3. **Should the raw `usage.db` go in the backup as well as the text
   rollups?** Rollups restore the charts; the message rows restore the
   per-message analysis. The file is ~200 MB a year in a git repository.
   Default: rollups only.
4. **Does Kuru get `usage_report` (phase 7)?** It is the one phase that adds
   anything to Kuru's context — a tool description on every turn. Default:
   not until asked.
5. **The profile-board cards running in `~`.** 38 % of this week. Was that
   intended (planning cards with no project), or should a profile-board card
   run in the folder of the workspace its text names, or ask? Not this
   plan's change, but the page will make it visible on day one.
6. **Which `~/.cache/kururu/voicelab` engines go**, as promised earlier — 11 GB
   that no plan here touches.

## How the analysis was made

Read-only, usage fields only, no conversation text read or kept. The scan
(`scan.py`) walked both Claude `projects` directories, byte-searched each line
for the two record types, parsed only those, deduplicated on `(sessionId,
message.id)`, and wrote one JSON of numbers and metadata; `week.py` grouped
it. Both scripts and their printed output are in
`~/Documents/Kururu/token-usage-analysis-2026-10-31/`. Measurements of
`kururu.db` were made on a copy in the session scratchpad with `sqlite3`,
then the copy was removed; Codex's `state_5.sqlite` and OpenCode's db were
copied and inspected the same way. Prices are from
<https://platform.claude.com/docs/en/about-claude/pricing> as read on
2026-10-31: Fable 5.1 $10 / $12.50 / $20 / $0.25 / $50 per MTok for input,
5 m write, 1 h write, cache read, output; Opus 5.5 $4 / $5 / $8 / $0.20 /
$20; Sonnet 5.5 and 5 $2 / $2.50 / $4 / $0.20 / $10; Haiku 5.5 $0.10 /
$0.125 / $0.20 / $0.01 / $0.50 up to 100 k, five times that above. The two
research notes in `~/Documents/Kururu/` carry the sources for the retention,
format and storage facts above, with the dates they were read.
