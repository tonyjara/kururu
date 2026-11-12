# The data

Boards, conversations and the voice's lists, in a database of their own; a
mirror of everything precious in a private git repository; and the way back.

## Why a database

Cards lived inside `session.json` with the layout, and the layout's rules
lost them. That file is *state*: ignored whole when its version does not
match, written last-writer-wins by whichever server was up, carried across
a restart by a blob an older build could read as it understood it. A board
is content somebody typed — the most valuable thing on the machine — and
wants the opposite rules: every change written as it happens, nothing ever
deleted but marked, and a history that says what moved and who moved it.

`node:sqlite`, because the server runs on Node (the app's own Electron as
node, 24 at the time of writing) and the module is built into it. No native
build, no `.node` beside the bundle, FTS5 already compiled in. The API is
five calls; `server/src/store.ts` is the whole exposure to it. Bun
implements the same module, so `bun test` covers the store against a temp
directory (`server/test/store.test.ts`).

## Where

`~/.local/share/kururu/kururu.db` — XDG's *data* directory, and not the
state one `persist.ts` uses or the config one `config.ts` does. `config.ts`
draws the line between those two: state is rebuildable, config is decisions.
This is a third thing: it grows, nobody hand-edits it, and it cannot be made
again. The first start makes it, and there is no other place a board is
kept. `KURURU_DATA_DIR` moves it for the isolated instance
([testing](testing.md#the-isolated-instance)). Beside it: `db-copies/`, one
copy of the file a day made with SQLite's online backup, the newest seven
kept; `backup/`, the mirror and its `.git`; `drops/`, the pictures and
files pasted or sent from a phone into Kuru's box, kept so Kuru can Read
them and never backed up ([harness](harness.md#a-file-the-user-hands-it));
and `telegram/`, the pictures sent from the Telegram chat (`inbox/`) and
copies of the ones on their way to it (`outbox/`), never backed up either
([channels](channels.md#pictures)).
Settings → About shows the file and its size.

## Keys, not ids

Profile and workspace ids are counters minted afresh on every cold start,
and a login key may be shared by two profiles, so neither can name a board
on disk. Each profile and workspace has a `key` — `pk…`/`wk…`, twelve hex
digits — minted when it is made, written to the layout file and the host's
blob exactly as `loginKey` is, and never changed (`shared/store.ts`). The
wire keeps its ids. The voice's two lists are keyed the same way: they used
to name the profile by its session id, and three host restarts in one
morning orphaned every entry on them.

A key the file lost — a `session.json` written fresh after the database
existed — is matched back to its rows by name at start, when exactly one
unclaimed row of that name is waiting (`Store.attach`). Only a key the
database has never seen is matched: a workspace made in a running server is
written down under its own new key the moment it is made, and never takes
another's board. Rows nothing claims are marked gone and kept, and the
search still finds their cards.

## The schema, in one screen

| table | |
|---|---|
| `profiles`, `workspaces` | key, name, when made, when gone |
| `boards` | one per profile and per workspace that opened one; `next` is the card counter |
| `lanes` | the profile board's own columns; a workspace board draws the fixed four |
| `cards` | every column of a card, position in its board's order, `deleted_at`; `needs_by` — who put it in the profile board's Needs you, on the cards there (schema 5) |
| `card_runs` | every run a card ever had, not only the last; the live agent id, checked against the host at start |
| `card_events` | the history: `created`, `moved`, `edited`, `sent`, `run`, `deleted`, `restored`, `imported`, each with who — `user`, `harness`, `automation`, `import`; also where a Needs you card's arrival time (`Card.needsSince`) is read from |
| `conversations`, `turns` | the harness conversation by session id: what you typed or said and what Kuru answered; every agent's final reply too, as its own conversation |
| `voice_messages`, `missed_replies` | the outbox's list and the missed list, keyed by profile key; delivered messages past the newest 100 per profile are let go |
| `cards_fts`, `turns_fts` | FTS5 over titles, bodies and turns, accents folded |
| `meta` | the file's own facts; nothing reads it today |
| `sim_pool` | each project's simulators for the slot queue: what `simctl` cannot say — booted since, the fingerprint installed, the lease, when last used. Never exported: a udid means nothing on another Mac. See [slots](slots.md#simulators) |
| `automations`, `automation_runs` | the things kururu does on a schedule: each definition's text as approved, its home, on or off and why, its anchor day and next slot; and one row per slot it came to — run, skipped, missed or interrupted, with why, the result line, a shell run's last lines, the session id. A run's row is unique by automation and slot and written before anything starts. Not in the export yet (the plan's phase 3). See [the plan](plans/automations.md) |
| `turn_pins` | the lines pinned in Kuru's drawer: a turn id and when it was pinned. In the export as the turn's `pinnedAt`, since a restore mints new turn ids. See [voice](voice.md#the-drawer) |
| `turn_tags` | the workspaces a line of Kuru's conversation is about where somebody said so: Kuru's tag line (`by = 'kuru'`) or the owner adding or taking one off (`by = 'user'`, `kept` 1 or 0), by workspace key. The tags read off a line's words are never written. In the export as the turn's `tags`. See [voice](voice.md#tags) |

`turns_at`, the `cards_au` trigger's `when`, `sim_pool`, `turn_pins`, `turn_tags` and the two automation tables are kept by
`keepShape` on every open rather than by a numbered migration, so the version
does not move and the installed app's older server still opens the file.

## Write-through, and refuse rather than diverge

`workspaces.ts` hands every change to a profile to `Store.syncProfile`
*before* memory takes it: names, workspaces come and gone, and every board
whose object is not the one it was. The pure functions in `shared/board.ts`
hand back the same object when nothing changed, which is what makes that
reference comparison exact, and comparing the two boards is where the
history comes from (`diffBoards`) — so every road onto a board writes the
right events without each verb being told, and a road added later cannot
miss. A write the disk refuses is a verb refused: the change is not kept
and the clients see nothing new, rather than a board in memory that the
file does not have. Who made a change is `Workspaces.as(actor, …)`: the
harness's tools say so, `noteRun` says `automation`, the rest is `user`.

Three things follow:

- **Nothing ever writes an empty board over a full one.** Boards are read
  from the database at start and never from the blob or the file again. The
  blob and the file still carry keys, and `persist.ts` never writes a board.
- **Delete is a stamp.** A deleted card is listed behind the profile board's
  **Search** → **Deleted cards**, and **Restore** puts it back in the column
  it left, at the foot. A workspace that is removed leaves its board, marked.
- **One way in from a file.** `Store.attach` adopts any card a layout file
  or blob carries that the database has never seen, with an `imported`
  event, and nothing a file says ever moves or deletes a card that is here.
  So an older build run against the old file cannot lose anything in either
  direction — see [the old file](#the-first-start-and-the-old-file).

What was lost from the file one morning, the design makes impossible rather
than diagnosed: two servers on one host cannot alternately overwrite one
file, a version mismatch never discards, and every move is reversible.

## The conversation

The report route already sees the harness's prompt on every
`UserPromptSubmit` — the one report that is `working` with a message — and
its reply on every `Stop`, with the session id in the profile's harness
record. Each becomes a turn (`recordTurn` in `conversation.ts`); a `[voice]`
prefix makes `via` spoken and a `[telegram]` one makes it `telegram` (see
[channels](channels.md)), and `promptCarries` links the turn to the outbox
message it delivered. Every other agent's reply is kept too, as an `agent`
conversation named by its transcript, so the search finds what an agent
said about a card. Those stay out of the mirror, since an agent's reply can
quote a file that holds a secret. The same words reported twice within a
few seconds — hooks installed in two places — are one turn.

## Search

`ftsQuery` in `shared/store.ts` turns what you typed into a query FTS5 will
take: every word quoted, the last a prefix, so a stray quote never errors
and "migr ord" finds "Migración de órdenes" once the tokenizer has folded
the accents. `GET /api/search?q=&scope=cards|turns|all&profile=` answers
with ranked hits carrying this session's ids beside the keys, so the window
can go to the card. Cards first, then turns, each ranked within its kind —
the two scales are not comparable.

Where it is: the **Search** button on the profile board, the Dashboard's tab.
A card hit goes to the card, scrolled to and lit — one of the profile's own on
that board, a workspace's on that workspace's board in its pane — and a turn
hit
opens its words in place. For the
harness, two tools: `search` with the same arguments, answering in lines
like `card KUR-12 "…" (Kururu, Done, moved 2026-10-09 14:02; id c…) — …`,
and `card_history` for a card's events ([harness](harness.md#the-tools)).

## The first start, and the old file

There is one storage. A start with no database makes one, empty, before
anything is served, and a fresh install's first start runs the same code as
every start after it. The layout file carries the arrangement and the keys
the database knows each profile and workspace by, and never a card.

Cards rode in `session.json` for a version, and a file of that shape can
still turn up: a copy put back by hand, or the one release from before the
database (0.3.0), which the menu bar can run from the app rather than the
checkout and which writes boards into the file as it always did. So the one
road in stays. At start, `Store.attach` adopts every card the file or the
host's blob carries that the database has never seen, by card id, onto the
board of the profile and workspace it was on, as `imported`. When anything
was adopted the file is written again at once, keys and no boards, so it is
read for cards once; reading the same file twice adds nothing twice, and a
card deleted here is still a row, so the file cannot bring it back. That is
the whole cost of keeping it — `adoptStray` in `store.ts` and the reading
half of `board` in `persist.ts` — and it can go once no build that writes
boards into the file is left to run.

What it does not carry: a board with no cards, whose columns a fresh
database draws as the default, and the voice's two lists from before the
database (`missed.json`, `outbox/outbox.json`), which nothing reads any
more. No install that kept them there is left.

A database that is there and will not open — a corrupt file, one from a
newer build, a disk that refuses — is a server that does not start, with
the reason in `lifecycle.log`. Boards live nowhere else, and a server
running on without it would draw boards that forget everything typed into
them. Move the file aside only to start from the last backup
(`bun run restore`).

## Backups

Settings → Backups: a repository URL you paste (make it on GitHub, private,
empty), an on/off switch, an interval with a default of five minutes and a
floor of one, **Back up now**, a status line, and the two lists — what goes
and what never does — so nobody has to take the second on trust. Saving the
URL runs `git ls-remote` in batch mode and reports before the switch can
be on; a repository nobody can push to failing quietly every five minutes
is the one way a backup is worse than none.

**An allow-list, not a deny-list** (`shared/backup.ts`). The config
directory holds a share token, an OpenRouter key, a Telegram bot token, the
web providers' keys, the
leftovers of the removed accounts feature with ssh keys in them, and every
profile's Claude login. The files that go are named by name, and anything not named stays:

| in the repository | from |
|---|---|
| `config/*.json`, `config/sheets/` | the named settings files; mascot sheets |
| `boards/<profile>/<workspace>.json` | lanes, cards sorted by number, every run, every event, deleted cards marked |
| `conversations/<profile>/<session>.jsonl` | the harness conversation, one turn per line, so a diff is the new turns |
| `memory/<login>/<project>/` | every `projects/*/memory/` under the profiles kururu made |
| `profiles/<login>/settings.json` | with its `env` block dropped, since that is where a key would be |
| `state/session.json` | the arrangement: keys, never boards |
| `README.md` | what this is and how `bun run restore` uses it |
| `nodes/<name>/` | each paired child's own mirror, the same tree, pulled over its link when its data moved ([nodes](nodes.md#backups)); `bun run restore <repo> --node <name>` reads it back onto a fresh child |

Never: `access.json`, `openrouter.json`, `telegram.json`, `node.json`, `nodes.json`, the lent secrets' records
(`grants.json`, `secrets-held.json`, `claude-lend.json`, `claude-token.json`), `identities/`, `.claude.json`,
`history.jsonl`, the transcripts, every cache, the database binary (git
keeps a whole copy per change; the text rebuilds it), agents' replies, and
`drops/` and `telegram/`, since a screenshot holds whatever was on the screen.
Secrets are left out rather than encrypted: an encrypted blob on GitHub is a
ciphertext to attack for ever behind a passphrase that is one more thing to
lose, and restoring them is one `/login` per profile and one paste of a key.

**The flow** (`server/src/backup.ts`). Every interval, if anything changed —
the store's write counter, or the mtimes of the config files, the memory
folders and the arrangement: write the mirror (`export.ts`), `git add -A`,
commit when the stage is not empty with a subject like `kururu backup
2026-10-10 12:00: 3 card changes, 2 turns, 1 file`, push with ssh in batch
mode and a timeout. The user's own git identity and credentials; kururu's
when there is no identity. A failed push keeps the commit and tries again
next time, and the page shows the stderr. Never `--force`, never a rewrite:
a push rejected as not a fast-forward stops and says so, because another
machine has been writing the same repository and which copy wins is not a
thing to decide unasked. `bun run backup` asks a running server for one
now, or does it itself; `--check` lists what would go.

**The way back.** `bun run restore <repository>` on a new Mac clones into
the mirror's place, rebuilds `kururu.db` from the boards and conversations
through the same importer, and puts config, memory folders and the
arrangement back — only where nothing is, unless `--replace`, which moves
what is there to `.bak` first. It refuses to run while a server is up, and
ends by printing what the backup never carried: a login per profile, the
OpenRouter key, the web providers' keys, the Telegram token and account, Input
Monitoring.

## The usage ledger

`~/.local/share/kururu/usage.db`, beside the boards and nothing to do with
them. Claude Code deletes a transcript thirty days after it was written, and
with it the only record of what that session spent, so the ledger keeps the
numbers and leaves the words: one row per billed API message (`messages`), a
rollup per local day and key that a page can draw (`daily`), what Claude Code
itself says a session spent (`session_totals`), and whose each session was
(`sessions`). `daily` and `session_days` are kept as messages are written —
each upserted row read before and after, the difference added in the same
transaction — and a whole day is rebuilt only for a session that changed
whose it was, or a node's numbers replaced: rebuilding every touched day on
every pass was ~15–20 ms of the server's thread every few seconds on a busy
day, and adding is ~0.3 ms. No column can hold a sentence, and
`server/test/usageledger.test.ts` writes a transcript through it and fails if a
marked word comes out, on any table or in the raw file.

It is a second file because it wants the opposite rules from `kururu.db`. It
grows twenty times faster, is rebuildable for thirty days, and is in no daily
copy and never itself in the backup: `shared/backup.ts`'s allow-list does not
name `usage.db`. What does go is its `daily` rollup, numbers and keys only —
see "The backup export" below. **A ledger that will not open is a server that
starts anyway**, without a chart, and saying so in its log. A newer build's
file is left alone.

`server/src/usage/` reads it in: `tail.ts` follows a file from its offset and
searches each chunk's raw bytes for two needles before anything becomes a
string, so the tool output and request blobs that are most of the bytes cost a
read and no more; `claude.ts` parses what is left into numbers, or into a
reason, kept in `skipped`; `sweep.ts` walks `~/.claude`, `identities/` and each
profile's login every five minutes, and tails one transcript the moment its
agent's `/api/report` names it. A first sweep over an empty ledger is the
backfill, and the same code: machine's login first, because its next `claude`
will prune all of it at once, then newest first. It sleeps as long as each chunk
took, and measured over 4.1 GB it took 20 seconds with the event loop's p99 at
6 ms. A restart anywhere in that carries on from offsets written in the same
transaction as their rows; a file's `size` is only recorded once a read has
finished, so that a flush part way through is not taken for the whole file.

**Codex and OpenCode are read the same way, by `codex.ts` and `opencode.ts`.**
A Codex rollout carries no session id on its lines, only in its filename
(`rollout-<time>-<id>.jsonl`), so that is where `placeOfCodex` reads it from; a
`turn_context` line names the model, and every `token_count` event afterward
already carries its own call's tokens in `info.last_token_usage` — Codex has
done the arithmetic the plan's "totals-difference rule" argued for, so nothing
here has to remember a running total across a restart to get the next call
right, and an event without it is counted in `skipped` rather than guessed at.
Its `rate_limits` rides on the same event into `limits`, kept whatever its
reset says rather than filtered to what is still current, which is
`codexusage.ts`'s job for the live bar. **Codex's own model ids are not in
`shared/prices.ts`, so its tokens are exact and its dollars are always
unpriced** — the user's choice, and not a gap. OpenCode keeps no log at all:
since 1.2.0 its sessions are rows of one SQLite database,
`~/.local/share/opencode/opencode.db`, read read-only and incrementally by
`time_updated`; the handful of Macs with files from before that version get
one backfill of `storage/message/<session>/<id>.json`, marked done in `files`
so the directory is never walked again. An OpenCode session on an Anthropic
model is priced off the same table a Claude Code one would be; any other
provider's is unpriced, the same as Codex's.

**Tokens are exact, as far as a transcript goes, and dollars are an estimate at
list price** (`shared/prices.ts`) that the user does not pay, since they pay a
subscription. Where Claude Code's token counts equal the ledger's the two
agree to the cent. They are often not equal, because **Claude Code spends tokens
that no transcript records** — its own Haiku calls, web searches, and about 9 %
more on the sessions that show a gap, none of it in any other record of the
file. Only its `cost-state` says so, which is why `session_totals` is kept and
why the page must draw that figure beside the estimate rather than call the
gap an error. On a session resumed after a restart the gap can go the other
way: its `cost-state` starts again, and a transcript does not.

**Whose a session was is written down when kururu starts it** (`usage/attribute.ts`),
because a transcript says which folder it ran in and nothing else, and a dozen
workspaces here live in the home folder. Each road that starts an agent says so:
the + menu, a card's run and resume (an idle card picked back up is one of those),
Kuru's `start_agent`, and Kuru itself. The row is `sessions`, keyed by the
session's id and `attributed_by = 'spawn'`, with its workspace, card, terminal,
kind, node and machine; a card resumed is the same id and so the same row.
Claude is told its id on its line (`--session-id`, which the menu and `start_agent`
now pass as a card's run always did); so is OpenCode. Codex takes none, so its
launch waits in `waiting`, on disk because the server restarts far more often than
an agent does: a card's run is settled by its own words when `sleep.ts` finds its
rollout, and a tab from the menu by folder and time (`matchRollouts`). One on a
machine waits for the remote reader. A launch that cannot be written is never why
an agent did not start.

A hook names a session too, which catches what no launch could: a card's agent
that moved to a new session with `/clear`, and a `claude` somebody typed into a
shell. Those are `attributed_by = 'report'`, under the terminal's card or workspace.

Everything else is read from this database through `Store.usageAttribution` and
never written back: a card's run first, then anything that says harness (the
conversation's kind, the harness's folder, its title), then the conversation,
then the folder alone. A session the database learns about later moves when the
next sweep reads the facts again, and never against a stronger word: a launch
takes only the run's number from there, since a card sent to another board spent
those tokens where it was. A row can exist with no message yet, so a page counts
sessions off `messages` or `daily`.

`bun run status` prints its count and its oldest day, off `/api/health`.

### The page

Settings → System → Usage (`web/src/settings/Usage.tsx`), and a mouse's click on
an allowance's chip; a finger still gets the popover, whose last row is the same
door. `GET /api/usage/report?range&by` is asked while the page is open and once a
minute after that, and the arithmetic is `shared/usagereport.ts`, pure, so a
tile and the chart under it cannot disagree.

**`session_days` is what it reads, not `daily`** (version 3; the plan said
`daily`). `daily` cannot name a folder or draw a session's row, and the messages
behind a month are 70,000 rows on the event loop every terminal shares. It is a
few rows per session per day with no attribution in it, so a session that changes
hands moves on the page with nothing to rebuild; `daily` stays for the backup
export (below).
A span that does not fall on midnight (a limit week, or "today") takes its two
ends off `messages` (`splitDays`), so a limit week is cut at the account's
instant. A report is about 10–40 ms on this Mac's 96,000 messages.

**Sessions are counted off cells, never off `sessions`**, because a launch writes
that row before anything is billed. Kuru is always a row of its own except by
model and by program, where carving it out would make Opus read shorter than its
bill. A comparison is the same length of time ending the same distance back, so
today at nine is set beside yesterday by nine.

**Colour.** The plan had the board's palette and `--accent`, and neither can pass:
those colours are chosen for chips and sit at OKLCH lightness 0.71–0.92 on a dark
ground where a chart's want 0.48–0.67. So the series are a table in
`shared/chartcolor.ts`, and the stylesheet's `:root` carries what `chartTokens`
works out from it as `--chart-*`. Kuru keeps the accent's hue, moved into the
band, and the quiet colour is `dim` stepped until it can be told from Kuru. A
series's slot goes by all-time rank (`seriesSlots`), so a filter never repaints a
survivor. `web/test/usage-palette.test.ts` reads the stylesheet's `:root`, fails
if its `--chart-*` values have drifted from `chartTokens`, and runs the checks on
both surfaces; its arithmetic is held to the figures the method publishes for its
own palette.

**Marks.** No charting library, in `web/src/charts/`. Bars, columns and segments
are boxes rather than SVG: a name then wraps and ellipsises by itself, and corners
come from the radius tokens. Only the lines are SVG. Every chart has a table
behind a toggle, which is what makes a tooltip and a colour under 3:1 legal. "What
kind of token" draws two bars, tokens over dollars, because tokens alone are one
block at 98 %.

**The limit panel** draws the `limits` table: history, not a snapshot. Codex's
rows ride free on the rollout tailer's own messages (`codexLimitSnapshots`, in
`flush`); Claude's are the one thing nothing else on disk ever wrote down, so
`usage/limits.ts`'s `recordClaudeLimits` is `pollAccountUsage`'s one extra call
per tick — a row per window, keyed on the reading's own `at` so a poll that
came back stale or unmoved (a `Retry-After` still waited out) adds nothing. The
"this limit week" range takes its instant from Claude's reading, then Codex's,
says whose, and says when it had to fall back to seven days.

`cleanupPeriodDays` is read per login, that one number and nothing else from the
file, and never written. The answer to the plan's first question stands.

### Other computers

An agent on a [machine](machines.md) writes its transcript there, and an agent on
another [node](nodes.md) is that node's. Both reach the page, by different roads,
because they are different things.

**A machine is read over ssh, by the sweep** (`usage/sweep.ts`, the two scripts in
`shared/machines.ts`). The same offsets, parsers and batch as this disk's logs,
keyed `machine/<id>/…` in `files`, after this disk's pass so a slow link never holds
up the page's own numbers. One listing (`find -exec wc -c`), then for each log that
grew a read from its offset: `grep` drops tool output on the far side, so ninety-odd
percent of a transcript never crosses, and the lines that do are parsed here and
forgotten. Whole lines only, by working out on the far side where the last one ends;
nothing is written there. A `grep` with no `-b` (Alpine's) says so in the machine's
row rather than running the offset on past lines nobody counted. A machine is read
once it has given a reason to, a workspace pinned to it or an agent kururu started
there, and then all of that login's logs are, as on this Mac, since a `claude` typed
into a shell there spends the same allowance. A Codex tab there finds its id by
folder and time over the same ssh, its pin's `~` read the way the far side would.
Its Codex allowance is a line of its own on the limit chart. OpenCode's logs are a
database on that disk and are not read.

**A node reads its own logs and tells its parent** (`usage/remote.ts`,
`shared/usagepull.ts`, the link's `usage-ask` and `usage-said`). Every five minutes
the parent says what it holds of each of the node's days, as a signature of that
day's `daily` rows, and the node sends the days that differ, each whole, replacing
what was there. There is no cursor to lose: a backfill that finds last month, or a
session a card comes to name, moves a signature. Only the parent asks, and only a
child answers; a node away keeps its numbers on the page with the time they were
last good, under Other computers.

**The rows are quarter hours, not days,** though the plan first said `daily`. A day
is the local day of whoever cut it, and a box on UTC would draw Thursday night on the
Mac's Friday; a quarter hour is an instant, and the parent cuts its own days. And the
page has to answer "today so far" and a limit week starting at ten past four, which
whole days cannot. On this Mac's whole history that is 4,200 rows against 96,000
messages, and 1.3 MB over the wire the first time. A node's session has no context
strip, since that needs its messages; its own page has one.

They live in `node_cells`, `node_sessions`, `node_days`, `node_names` and `node_pulls`
(version 4), keyed by the node's id, because a node can be renamed and its rows must
not be asked for again under the new name. **`session_days` and `daily` are made from
both**, so a rebuild of a day here cannot lose them and the page cannot tell them
apart. `daily`'s `node` column is the node's name, and the Mac's export carries those
rows too. A node's workspace and card are named by what it said they were called,
which is the one thing here that is not a number or a folder, and which the link
carries already in a summary and a mirror. Every field is checked on the way in
(`adoptUsagePart`) and a qualified id is refused, because this goes to disk.

**A machine that is also a child is counted once.** A session one road has read, the
other leaves alone: the sweep skips a log whose session a node has told us about, and
a pull drops the cells of a session whose messages are here. Whichever got there first
keeps it, and a test holds both orders.

The page's seventh split is **Computer**, a row each; the others name a computer that
is not this one beside the row (`Api · box`), since the same folder on two of them is
two rows and another's home is not this one's. A session's row says where it ran.

### The backup export

Decision 9: `usage.db` itself never leaves, but its `daily` rollup does, as
`usage/<month>.jsonl` — numbers, keys and folder names, grouped by calendar
month so a year is twelve files rather than one growing blob. `usage/export.ts`
reads `daily` through `Ledger.dailyExport` and `mirrorFiles` (`export.ts`) adds
its lines beside the boards and conversations, under the same `OWNED` subtree
rule that prunes a month gone stale. `bun run restore` reads it back with
`importUsageMirror`, upserted on `daily`'s own key so running it twice is the
same table, not a doubling — the one place in the restore where "added to,
never replaced" would have been wrong. `bun run backup --check` lists the path
without opening a ledger, the way it already lists everything else it would
carry.

## Git, in two files

`worktree.ts` was the one file that ran `git`, on the user's repositories.
`backup.ts` is the second, on the one repository kururu owns and nothing
else. Both run it through `gitcmd.ts`: one timeout, one reading of what git
said, `GIT_TERMINAL_PROMPT=0` so nothing ever waits on a password nobody is
there to type, and batch-mode ssh for the pushes. Neither forces anything.

Those are the two in a running server. Two commands run git as well, and
neither is the server: `bun run restore` (`restore-cli.ts`, through
`gitcmd.ts`) clones or pulls the backup repository onto a new machine, and
`kururu child update` (`tools/kururu.mjs`) runs `git pull --ff-only` on
kururu's own checkout and refuses a dirty one.

"What git said" is the first line of its stderr, as the error's message, and
all of it beside on a `GitError`. A refused push is the case that needs the
rest: it opens with `To <remote>` and says `rejected` below, and until the
backup read the whole of it, a remote with another machine's commits was
reported as a push to be tried again rather than a stop.
