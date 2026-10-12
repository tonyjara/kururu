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
kept; and `backup/`, the mirror and its `.git`. Settings → About shows the
file and its size.

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
| `cards` | every column of a card, position in its board's order, `deleted_at` |
| `card_runs` | every run a card ever had, not only the last; the live agent id, checked against the host at start |
| `card_events` | the history: `created`, `moved`, `edited`, `sent`, `run`, `deleted`, `restored`, `imported`, each with who — `user`, `harness`, `automation`, `import` |
| `conversations`, `turns` | the harness conversation by session id: what you typed or said and what Kuru answered; every agent's final reply too, as its own conversation |
| `voice_messages`, `missed_replies` | the outbox's list and the missed list, keyed by profile key |
| `cards_fts`, `turns_fts` | FTS5 over titles, bodies and turns, accents folded |
| `meta` | the file's own facts; nothing reads it today |

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
record. Each becomes a turn (`recordTurn` in `index.ts`); a `[voice]`
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

Where it is: the **Search** button on the profile board's sheet. A card hit
goes to the card, scrolled to and lit — one of the profile's own in the
sheet, a workspace's on that workspace's board in its pane, with the sheet
closed — and a turn hit
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
directory holds a share token, an OpenRouter key, a Telegram bot token, a
Firecrawl key, the
leftovers of the removed accounts feature with ssh keys in them, and every
profile's Claude login. The files that go are named by name, and anything not named stays:

| in the repository | from |
|---|---|
| `config/*.json`, `config/styles/`, `config/sheets/` | the named settings files; installed and studio styles; mascot sheets |
| `boards/<profile>/<workspace>.json` | lanes, cards sorted by number, every run, every event, deleted cards marked |
| `conversations/<profile>/<session>.jsonl` | the harness conversation, one turn per line, so a diff is the new turns |
| `memory/<login>/<project>/` | every `projects/*/memory/` under the profiles kururu made |
| `profiles/<login>/settings.json` | with its `env` block dropped, since that is where a key would be |
| `state/session.json` | the arrangement: keys, never boards |
| `README.md` | what this is and how `bun run restore` uses it |

Never: `access.json`, `openrouter.json`, `telegram.json`, `identities/`, `.claude.json`,
`history.jsonl`, the transcripts, every cache, the database binary (git
keeps a whole copy per change; the text rebuilds it), and agents' replies.
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
OpenRouter key, the Firecrawl key, the Telegram token and account, Input
Monitoring.

## Git, in two files

`worktree.ts` was the one file that ran `git`, on the user's repositories.
`backup.ts` is the second, on the one repository kururu owns and nothing
else. Both run it through `gitcmd.ts`: one timeout, one reading of what git
said, `GIT_TERMINAL_PROMPT=0` so nothing ever waits on a password nobody is
there to type, and batch-mode ssh for the pushes. Neither forces anything.
