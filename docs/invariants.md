# The invariants, in full

`CLAUDE.md` names each load-bearing invariant in one line and links here.
This is the rest of each one: the argument, the files that hold it, and the
exceptions it has made room for.

They were all in `CLAUDE.md` until 2026-11-02, when it had grown to 40 KB.
Every agent started in this repository reads that file on every call, so the
long text came here and the rule stayed there, one line each. Nothing was cut
on the way: a rule in either place is the same rule, and a change to one is
a change to both. The subsystem docs each section links to are the reference;
this is the brief's long form.

## The agents pane

**The agents kururu starts itself go to the agents' pane.** A card's run and
resume and Kuru's `start_agent` ask `agentPaneIn` — the bottom pane by
geometry (`shared/agentpane.ts`), marked `forAgents` so the next one joins
it, the whole layout split when there is none — and read their directory
off the old pane (`cwdPaneIn`); the keyboard stays where it was. The + menu's
agents go where they were asked for, and `off` is the old `paneBesideBoard`.
→ [layout](layout.md#the-agents-pane)

## Boards in the database

**Boards live in the database and nowhere else, and a file never moves or
deletes a card that is there.** A first start makes `kururu.db`, and there
is no other mode. Every change to a profile goes through `Store.syncProfile`
before memory takes it, the diff of the two boards is the history, and a
deleted card is a stamp. The layout file carries keys and never a board;
a card an old one or the host's blob carries that the database has never
seen is adopted — never the other way round. Profiles and workspaces are
known by `key`, not by their counter ids. A database that will not open is
a server that does not start. → [data](data.md)

## Contrast floors

**A token has a floor, and the pairs are read out of the stylesheet.** Right
tokens and unreadable text is a thing a palette can be; `shared/contrast.ts`
says what each one is held to as ink and `CONTRAST_KNOWN` records — not
approves — the eighteen pairs already under it. → [styles](styles.md)

## Access

**The socket binds loopback and the `Origin` header is checked**, the second
before the token. Loopback is exempt from the token unless `loopbackToken`
(or `KURURU_LOOPBACK_TOKEN=1`) says otherwise, which a child sets; then
every local caller presents it, from `server/localtoken.mjs` or the
`KURURU_TOKEN` the server hands its ptys, and never on a command line.
`KURURU_BIND=tailscale` is a child's tailnet address, with loopback beside
it. → [architecture](architecture.md#access)

## Profiles and logins

**A profile is a drawer of workspaces, plus — one switch, off by default — a
login of its own.** It carried *chosen* accounts for a version and that is
gone; what is back is a choice among directories kururu itself made.
`Profile.loginKey` names a directory under `~/.config/kururu/profiles/`,
`logins.ts` points `CLAUDE_CONFIG_DIR` and `CODEX_HOME` into it on every pty
the profile opens, and the pty host takes an `env` again — which is why
`HOST_PROTOCOL` exists. A profile may be pointed at another's key, from a
list the server reads off the disk and refuses anything outside of; no path
ever comes from a client. → [layout](layout.md#profiles)

## Idle card agents

**An idle card's agent is ended, nothing else's, and never before its
conversation is found.** `server/src/sleep.ts` looks only at cards' runs —
never a tab from the menu, the harness, a shell — and every doubt keeps one
awake: a prompt or question on screen, a message held for it, a draft in its
prompt, a command running under it, a last reply that asks. Then the
transcript or rollout `--resume` needs is opened (over ssh on a machine; a
Codex run's id is learned off its rollout first), the run is written
`asleep`, and the close button's `endTerminal` ends it. Running the card
again resumes; nothing on disk is touched. → [layout](layout.md#idle-card-agents)

## Worktrees

**A card's worktree is git's to refuse, never kururu's to force.**
`server/src/worktree.ts` and `server/src/backup.ts` are the only files that
run `git` in a running server, through `gitcmd.ts` — the first on the user's
repositories, the second on the one repository kururu owns and nothing else.
Two commands run it too, never a server: `bun run restore`
(`server/src/restore-cli.ts`, through `gitcmd.ts`) clones or pulls that same
backup repository onto a new machine, and `kururu child update`
(`tools/kururu.mjs`) runs `git pull --ff-only` on kururu's own checkout,
refusing a dirty one. `worktree add` on
a click, with a timeout, and on the way back out a rebase, a fast-forward,
`worktree remove` and `branch -d` with no `--force` and no capital — a dirty
worktree or a conflicting rebase stays standing and says why. The card's
"discard" is `git stash`, never a checkout over the work. Anything that
ends an agent or removes a checkout asks first, in a centred dialog rather
than at the foot of the card. Project settings
are keyed by repository root and the root is only ever one the server found
itself. → [layout](layout.md#worktrees)

## Backups

**Backups leave the machine, and secrets never do.** What goes to the
private repository is an allow-list in `shared/backup.ts` — named config
files, the boards and the harness conversation as text, the memory folders —
and anything not named stays: the share token, the OpenRouter key, the
Telegram bot token, the web providers' keys, `identities/`, every login,
a node's keys and the roster (`node.json`, `nodes.json`), and the lent
secrets' records (`grants.json`, `secrets-held.json`, `claude-lend.json`,
`claude-token.json`, a lent GitHub login's `gh/`). Never `--force`,
never a rewrite; a push the
remote refuses stops and says so. → [data](data.md#backups)

## Lending secrets

**A secret leaves the Mac only sealed, to a node it was lent to.** One
switch per child per kind in Settings → Nodes, off by default.
`shared/secrets.ts` names the kinds and which part of each file travels
(Telegram's token, never its switch); `NEVER_SHARED` names the files that
never go (the share token, the nodes' and the roster's keys), and a test
holds every `0600` write in the server to one list or the other. A push
is sealed to the child's X25519 key and signed by the parent's node key
(`server/src/seal.ts`). The child takes it only from its parent, writes it
as the same file the readers already read, refuses a held kind's setters,
and lets go of everything when it leaves the roster. A lent Claude token
is the one credential put in a pty's environment, as
`CLAUDE_CODE_OAUTH_TOKEN` (`lentClaudeEnv`), never a copied
`.credentials.json`; a Codex login is read only once it is switched on for
a node, copied once, and never written over the child's own. A project's
own secrets go the same road (`shared/vault.ts`, `server/src/vault.ts`):
an env file into the node's checkout, never over one of its own; an ssh
entry and its key under `~/.ssh/kururu` with one `Include` line, never
over a `Host` of its own; a GitHub login as gh's and git's files in
`~/.config/kururu/gh`, reached by path (`GH_CONFIG_DIR`), never by an
environment variable holding it. Keys and tokens are read only once lent;
Kuru's `lend_secrets` previews first and is never handed a value. Hints only to a client, on both nodes, and no value in
a log. → [nodes](nodes.md#lending-secrets)

## The vault page

**Settings → Vault names the vault and never shows a value.** Kururu's
keys by the hint their own module already holds, env files by variable
name, ssh keys and Codex, gh and Vercel logins by their files being there —
nothing read that kururu would not read anyway, built when the page asks
and never broadcast; `server/test/vaultview.test.ts` fails on a value that
comes out. → [nodes](nodes.md#the-vault-page)

## The usage bar

**The usage bar reads a Claude credential and never writes one** — the
machine's, or the active profile's when profiles keep their own logins. It is
one of the few things in kururu that reach off the machine on the user's
behalf, beside OpenRouter's balance, a channel
that is switched on and the pages agents fetch through a web provider; it is
read at the moment of the fetch, never held, never logged, never on the wire —
and no token refresh, because writing that store could log out a running agent
to draw a bar. `server/src/usage.ts` is the only file that has seen it.
Codex's allowance beside it reaches nowhere: `server/src/codexusage.ts`
reads the `rate_limits` Codex writes into its own rollouts, and only stats
`auth.json` to know it is signed in. Antigravity's reaches nowhere either:
it is the quota `agy` hands its own title command, written to a file by
kururu's reporter without the email beside it (`server/src/agy.ts`).

## Antigravity

**Antigravity's sign-in is never lent.** `agy` runs in a pty as `claude` does,
on its own sign-in; no token of Antigravity's is read, copied or given to
another program, and no program is made to pass for Antigravity — the user's
account is bound by Google's terms. kururu reaches `agy` only through doors it
documents: `--settings` for one launch (a title command, Kuru's folder
trusted, Kuru's tools allowed), and `.agents/` in Kuru's own folder. It never
writes the user's `~/.gemini` config or a project's `.agents/`. See
[antigravity](antigravity.md).

## The usage ledger

**The usage ledger keeps the numbers and never the words.** `usage.db`, beside
`kururu.db` and in no copy or backup, because Claude Code deletes a transcript
at thirty days and this is the durable copy: one row per billed message, read
by `server/src/usage/` from the logs the programs already write, read-only,
with no model token spent and nothing told to Kuru. A byte search comes before
any parse; no column can hold a sentence, and a test fails if a marked word
gets out. It fails open: a ledger that will not open is a server without a
chart. Dollars are an estimate at list price (`shared/prices.ts`), and Claude
Code spends tokens no transcript records, so its own figure is kept beside
the estimate. Whose a session was is written when kururu starts it
(`usage/attribute.ts`), by id, so a resume is the same row, and that write is
never why an agent did not start. Settings → Usage counts sessions off what
was billed, never off a launch's row, reads `session_days` so a report stays
milliseconds on the event loop, and wears `--chart-*`, a validated table in
`shared/chartcolor.ts`, because the board's colours cannot be told apart at a
chart's size. A machine's logs are read over ssh by the sweep, read-only, once a
workspace is pinned to it or an agent was started there; a node reads its own and
its parent asks, keeping quarter-hour rollups by the node's id and never a
qualified one; a session one road has read, the other leaves alone. →
[data](data.md#other-computers)

## Stored credentials

**The OpenRouter key is one of the credentials kururu stores — a
channel's bot token and the web providers' keys, below, are the others —
and it only comes in, or goes out sealed to a node it is lent to.** A
management key, pasted once in Settings, kept 0600 in
`~/.config/kururu/openrouter.json`, read per fetch and used for GETs only.
A client is sent its `hint` and dollars, never the key. →
`shared/openrouter.ts`

## The web for agents

**The web is lent to agents through a chain, never a key.** Every agent
kururu starts on this Mac — the + menu, a card's robot, the harness and
its `start_agent`, a card picked back up — gets four MCP tools served at
`POST /mcp/web` (`scrape_page`, `crawl_site`, `map_site`, `search_web`)
through flags on its command line, `--mcp-config=` for Claude (spelt with
`=` so a card's prompt is not read as a second config) and `-c` overrides
for Codex, and kururu makes the request. Behind them is an ordered chain
of providers set in Settings → Web (`server/src/web/chain.ts`): the
**hand-back** first — a provider like the others that tells the agent to
use its own WebSearch / WebFetch — then cloud Firecrawl, reached only when
the agent calls again with `ownToolsFailed`. A self-hosted Firecrawl goes
first by default when one is set up; ours sits on a box of its own since
2026-11-01, moved after the hand-back and before the cloud. A challenge page, a wall or nothing is a failure
like an error or a timeout, and every answer says who served it. A
provider is one file in `server/src/web/providers/` that registers itself;
the build imports the directory and the page draws its fields, so nothing
else is touched. Each keeps its key on the OpenRouter key's terms — 0600
(`firecrawl.json`, `web-<id>.json`), read per request, sent only to its own
address, never logged, never in a pty's environment, a client sent its
hint, never backed up. The cloud reserves credits against a daily budget,
a crawl is held to the page limit, and what comes back is wrapped and
introduced as untrusted data. **The URL or search words of a call go to
Firecrawl's servers when the chain reaches the cloud, and to a
self-hosted Firecrawl over the tailnet when one is set up.** An agent on a machine does not get the tools;
the endpoint answers only a program on this Mac. → [web](web.md)

## Databases

**A database is whatever `DATABASE_URL` says, read when asked and never
held.** The scan reads a workspace's `.env*` files under the roots the branch
walk found, never a path a client sent, and a client is told host, port,
database and user — never the URL. `server/src/databases.ts` reads the file
again at the moment it connects. Every query runs in `BEGIN READ ONLY` and
Postgres refuses the write; the viewer's switch sends `READ WRITE` for one
run and no regex here decides what a query is. Postgres only, on purpose. →
[layout](layout.md#the-databases-on-the-row)

## The harness

**The harness is a session, not a loop.** One Claude Code session per
profile, started by kururu with kururu's verbs as MCP tools (`POST /mcp`)
and a role; nothing in kururu generates text and no API key exists. It
runs in a folder of its own, never a project's (`harnesshome.ts`), and its
model, effort and compaction point are flags on its line
(`harnessRunFlags`), never the profile's settings. Its
tools take a profile and workspace by id, never `active` — the `*In`
spellings in `workspaces.ts`. What it says to an agent is **typed into the
agent's pty as the user's words**, never posted to its inbox: Claude Code
makes everything on that socket another session's message, which agents
rightly refuse to take as the user's. `due` holds a message for the turn's
end, and nothing is typed into a prompt or under the user's hands. The
inbox carries only kururu's `[kururu]` notices to the harness, signed
`kururu (no reply)` because SendMessage resolves names by prefix and
"kururu" is the prefix of every session in this repo. **Or it runs on
OpenCode** (Settings → Agents → Kuru, `LaunchSettings.harnessCli`), for
when the subscription is spent: `--standalone --session ses_…`, its flags
as `.opencode/opencode.json` in its folder, its hooks as a plugin posting
the same `/api/report`s, its notices typed on their own — see
[harness](harness.md#on-opencode). It is told every
agent's `done`/`blocked` edge in its profile — never a shell's, and
`blocked` only when Claude is asking. A permission prompt is the user's to
answer, and the role says so. A message from a channel comes in by the
drawer's road — the outbox, typed — marked `[telegram]`, and the role says
what that means. → [harness](harness.md)

## Nodes

**A node is let in by the roster, never by a token.** Every kururu is a
node; the parent (the Mac) signs a roster of members' public keys, and two
nodes link — one WebSocket per pair, `/link`, the lower rank dialling the
higher — by each signing the other's challenge with a key that roster
lists. Pairing is one command the Mac shows — `kururu child join
<address> <code>`, the code single-use for ten minutes — run on the new
computer, which posts to the Mac's `/api/nodes/join`.
Those two routes are the only ones ahead of the token gate, and both
refuse an `Origin`, a proxy's header and anything off the tailnet and
loopback. What crosses a link is a summary a node pushes about itself,
never a copy of a board; a node is away after 25 s of silence, because a
sleeping Mac sends no FIN. The parent pulls each child's backup over its
link into `nodes/<name>/`. A workspace moves by its board alone, never
its code, and only with no agent running and no worktree standing. The
source removes it only once the target has answered, and the move id
makes a retry the same move. Each node's Kuru acts on its own node's
agents only and hears only their notices; another node's is asked with
words typed into it through its own outbox — `[kuru@mac]` from
`ask_kuru`, `[user@mac]` from a drawer's `@box` — the mark written by
the receiver, never off the wire. Board verbs with a `node` act directly,
never a run. A notice crosses into another drawer without the reply it
quoted. → [nodes](nodes.md#kurus-as-peers)

## Remote workspaces

**Another node's workspace on this screen is that node's, shown here.** The
Mac's server watches a child as one more client of it (`/link/watch`, let in
by the node handshake, parent to child only, open only while something of
the node is on screen) and relays its session under ids qualified `n:<node>:…`
(`shared/remote.ts`, `server/src/nodewatch.ts`). The child owns the layout,
the ptys and the size; a verb from here is forwarded, never applied here. No
qualified id is ever written — not to `session.json`, the host's blob, the
database or `made.json` — and a test holds it. What the window starts there
is the node's: its launchers in the `+` and the robot, its login, its web
tools; a new workspace's folder is judged on its disk, and a Needs row's
Done is its own rule asked again (`card-done-ask`). Kuru's rule is
unchanged: the user typing into a remote pane is the user; Kuru still acts
locally and asks a peer, and reads a remote agent's screen by its qualified
id, which every acting tool refuses. A remote agent's `blocked` is noticed
by this node's own gate (`nodenotice.ts`). The node's disk is read over the
watch (`files-ask`, `doc-ask`, through `/api/node/<id>/…`) and checked by
the node's own `files.ts`; its roots reach a page qualified, so a verb
pairing one machine's file with the other's pane is refused, and the tree
only reads there. Nothing crosses by a gesture either: a tab or file over
the other machine's pane, and a Finder file over a remote terminal, are
refused in words before they land; the node's own page is for its
Settings. → [nodes](nodes.md#remote-workspaces)

## One Telegram

**One Telegram bot for every node, read by one node at a time.** The
parent's allow-list rides in the roster it signs, so only the parent
sets it; the switch rides there too, but any node may flip it — a
`TelegramSwitch` signed by that node and handed on, the latest word
winning, written into the roster when the parent hears it — and only a
node holding the token may turn it on. The token is lent on its own. `LeadGate`
(`shared/nodes.ts`) says which node polls — the highest-ranked eligible
one it can reach; 30 s of silence to take over, a minute of steady link
and a holder that is not mid-conversation to take back; rank settles a
409 — and `server/src/lead.ts` hands the offset, queue, held messages,
reply map and handled ids over before the new holder polls. A node that
does not hold the poll never calls `getUpdates`, not even once at start:
that is a 409 for the one that does. Every Kuru's lines go through the
reader, marked `[Omarchy]` but the parent's; `@node`, `/node` or a reply
to a node's line reaches that Kuru (`routeOf`). → [nodes](nodes.md#one-telegram)

## Machines

**A shell on another machine is a command line, never a host change.** A
machine is an ssh host the user named (Settings → Machines, `vps.json`); its
shell is `ssh -t` in an ordinary pty, built and read back by
`shared/machines.ts`, so the pty host never learns there is a remote. A
workspace pinned to one opens its terminals there — shells, nvim, agents,
card runs — each in a named tmux session (`new -A` semantics); everything
that reads a disk stays local. An agent there is typed in behind a check
that its CLI is installed and signed in, and its status is **read off its
screen** (`onscreen.ts`), because its hooks cannot reach kururu yet. Closing
a tab ends its session; a dropped link, a detach or a host restart do not.
Host and folder are grammars, not escapes. → [machines](machines.md)

## The voice

**The voice is ears and a mouth around that session, not a second brain.**
Speech becomes a `[voice]` turn typed into the harness's terminal; its last message
becomes speech, off the same Stop report. No client plays a word while any client
is talking (`hush`); the replies that waited play after, ahead of the answer,
each starting "While you were talking", and nothing is dropped — a reply nobody
played to its end is marked unheard in the Kuru drawer, which the clients'
`speech-held`/`speech-played` reports decide, and seeing it in the open drawer counts as hearing it. **The
conversation has one home, the drawer** (`KuruDrawer.tsx`): every prompt and
reply out of the database's turns, your messages' states off the outbox,
each reply's fate off the missed list, merged once on the server
(`shared/kuru.ts`, `server/src/kuru.ts`) into the `kuru` message; its
composer types to Kuru through the same outbox a clip takes. The chip is the
only door, and the sidebar has no harness button. Both halves are local — Apple's
recogniser through `yap`, Kokoro on the CPU with `say` as the fallback — and
no audio leaves the machine; a channel, below, is the one road off it for
the conversation, and carries only its text. Kokoro runs in a process of its own
(`server/src/kokoro.ts`) and is never imported into the server, because its
runtime turns the exit of whatever loaded it into a SIGABRT. The server hears and speaks for every client;
a window only posts a WAV and plays one. `web/src/voice.ts` holds the
microphone and installs the talk key once, through refs, never per render.
→ [voice](voice.md)

## Notes

**A note is a card kept in sight, never a copy of one.** "Pop out as a
note" floats a card over the window (`Notes.tsx`); it is looked up by id
in the snapshot on every render, so it follows the card from the profile's
board to a workspace and shows every edit at once, and its body is the
reader's renderer on the card's own text (`/api/card-markdown`). Where
each note is lives in `web/src/notes.ts`, per device and per profile key,
in `localStorage`. Menus and dialogs are drawn into `document.body`,
because a pane is a stacking context and one opened in it was under the
notes and the drawers. **In the desktop app a note is a window of its
own over every application** (`desktop/notes.js`, a `panel` on every
Space, loading `/?note=` — `NotePage.tsx`, which draws the same
`NoteInside`); where each one is, its size, fold and whether it is up are
`desktop.json`'s, the tray lists them and pops a card out
(`GET /api/notes/cards`), and only the main window may pop one out and
only a note's own page may move, fold or close it. A browser and the
phone keep the in-page note. → [layout](layout.md#notes)

## What an agent made

**A link to what an agent made is read off its last reply, never off
everything it touched.** `shared/made.ts` finds the paths a reply names and
keeps the deliverable — a document presented as the result or changed in a
turn that changed no code, code only when presented and one of at most two —
two at most per agent; `server/src/made.ts` resolves them under roots
`files.ts` already allows and keeps them in `made.json` (by id *and* spawn
time), and a card's agent writes them onto `Card.made` so they outlive it.
A gone file's link goes within seconds. Kuru's `show_file` pins one; the
drawer makes Kuru's own paths links. Opening is `open-made`: Markdown to the
reader, code to a new nvim tab at the line. → [layout](layout.md#what-an-agent-made)

## What needs you

**What needs you is one rule, in `shared/needs.ts`, and three drawings of
it.** An agent asking, a card in Review, a turn that ended unseen, a card
whose agent went without finishing, a card in the profile board's Needs
you; never a working agent, a To do, a shell, or the harness. Needs you
(`needs`) is on every profile's board and cannot be renamed or deleted,
and each card in it says who put it there — `Card.needsBy`, stamped off the
change's actor by `markNeeds`, never passed by a verb. The Needs chip's tray counts it, `NeedsDrawer.tsx`
lists it by workspace in three bands with Next a press away (`C-a i`,
`C-a o`), and a workspace's sidebar row wears the dot. No component
decides it again, and nothing in it is dismissed by hand — a row leaves
when its state does. Its groups fold and its queue sorts per device
(`web/src/needsorder.ts`), which changes what is drawn first and what
Next walks to, never what is counted. The profile board is the profile's own board and
draws no workspace's; a card asked for by name goes to its board in its
pane through `showCardNext`. → [layout](layout.md#what-needs-you)

## Channels

**A channel is another door into the one conversation, and only the
user's own accounts may use it.** Telegram, today (`shared/channels.ts`,
`server/src/telegram.ts`, `server/src/channels.ts`). A message from an
account on the allow-list — empty until the user pairs one in Settings →
Channels, by a code this Mac shows — goes into the same outbox as the
drawer's composer and is typed into Kuru as `[telegram] …`; anyone else,
any group, any bot is ignored without an answer, and counted, and `judge`
is that decision in the order that makes it safe. Every reply Kuru makes
goes back while it is on — its answers to `[kururu]` notices too, never the
notices, which quote agents' replies — with a silent copy of the user's
words from here; a turn that answered only Telegram is not
spoken on the Mac (`replySpoken`). The bot token is kept on the OpenRouter
key's terms: 0600 in `~/.config/kururu/telegram.json`, read per request,
put only in the request URL, never logged, a client sent its `hint`, never
backed up. Long polling and never a webhook: nothing listens, and off is
no request at all. Pictures cross both ways as files, never bytes in a
prompt: one sent in is fetched into `telegram/inbox/` and Kuru is typed
its path; one goes out only when Kuru calls `send_telegram_photo` (or
`show_file` in a Telegram turn), only a picture by its bytes, only from a
project, an agent's folder, the user's own folders or kururu's — never a
hidden folder or `~/Library` — and only from the node reading the chat
(`shared/pictures.ts`). **This is the one road off the machine for the
conversation itself** — its text goes through Telegram's servers, which do
not encrypt bot chats end to end — and the page says so above the switch.
→ [channels](channels.md)

## The runner

**`server/run.mjs` is the one supervisor, and the app ships it.** The
menu-bar frog (`desktop/tray.js`) starts it from the app's Resources with
`--no-build --entry`, or from a checkout with `--watch`, on the app's
Electron helper as node, because a titled process on the main binary is a
Dock tile (`proctitle.ts`); a server already on the port is adopted and
never stopped.
A host restart goes *through the server* (`POST /api/host/restart`: SIGTERM
the socket's holder, exit 75 when the link drops) so either runner comes
back to a fresh host; the tray's dialog names the agent count and defaults
to no. A crash after a minute up is started again with backoff
(`server/restart.mjs`); one sooner is left down. Where the server runs from is `~/.config/kururu/desktop.json`.
→ [architecture](architecture.md#the-runner-and-the-menu-bar)

## Reloading the window

**An agent's reload is asked for, and the page picks the moment.**
`bun run reload-window` and the harness's `reload_window` reach
`POST /api/reload-window`, which sends `reload` to every page that said it
is on this Mac — the window, the floating pill, a loopback tab, never the
phone. Each reloads itself only when nobody is talking and Kuru is not
speaking, its hands have been still five seconds, and no dialog, menu or
unsent field is open (`reloadHolds` in `shared/reload.ts`), then shows who
asked and why. It is `location.reload()` — what `C-a R` costs, and the pty
host never hears of it. → [architecture](architecture.md#reloading-the-window)

## The talk key everywhere

**While the talk key is hooked system-wide, the floating pill is the only
voice client on this Mac.** `desktop/talkkey/talkkey.swift` is a listen-only
event tap (Input Monitoring, nothing else) whose events go to the panel's
webContents and no other; the window's `voice.ts` forwards its gestures
there (`setVoiceRemote`) so a key both saw fires once. A chord — another
key during the hold — drops the clip. → [voice](voice.md#the-talk-key-everywhere)

## The slot queue

**A lease ends with the terminal it was taken in, and nothing but the server
holds the line.** `server/src/slots.ts` keeps leases and waiters in
`slots.json` and ends a lease the moment `host.onAgents` says its terminal
exited, or its process (pid and start time) is gone, or `--max` passes; a
waiter is granted only while its CLI is asking, so a Ctrl-C'd one never holds
a lane. The rule is `shared/slots.ts`, the script's lanes and gates unchanged.
`xcrun` runs only once somebody asks about a simulator, and the nightly sweep
only once a pool exists, never on a lent simulator or a checkout a build
names. Nothing of it is the pty host's. → [slots](slots.md)

