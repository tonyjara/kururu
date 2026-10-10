# The harness

One agent per profile that drives the others. The user talks to it, it starts
agents, reads what they say, answers them, keeps the boards, and tells the
user what happened — from a phone, it is the only thing they need to see.

The argument, in one paragraph: every project that puts a manager over coding
agents ends up as *an LLM over deterministic verbs* (claude-fleet's motto is
"models decide, scripts do"; Symphony's scheduler is code; Conductor's API is
spawn, send, read-with-cursor, status). Kururu already has the verbs and the
one thing none of those projects had — a server holding every pty, every
board and every status transition. So the harness is not a loop kururu runs.
It is a Claude Code session in a terminal like any other agent, handed
kururu's verbs as MCP tools and told who it is. The loop, context management,
permissions, resume and the subscription billing come with the session; the
control plane is what kururu adds.

## The three pieces

**`shared/harness.ts`** is the pure half: the tool catalogue the MCP endpoint
publishes, the role prompt, the grammar of a key press and of a paste, when
a waiting message may be typed (`due`), the frames a notice to the harness
is, the transcript-tail reader. Tested.

**`server/src/mcp.ts`** is five methods of MCP over JSON-RPC — `initialize`,
`notifications/initialized`, `ping`, `tools/list`, `tools/call` — written out
rather than pulled in as the SDK, because a server with seven dependencies
does not take a ninth to answer five methods. Pure; the test speaks the
protocol to it. `index.ts` serves it at `POST /mcp`.

**`server/src/harness.ts`** is the hands: `Harness.call` runs one tool for one
profile, `Harness.open` starts, resumes or reveals the session, `noticed` is
what `noticeStatuses` calls on every edge. It gets what it needs from
`index.ts` as a bag of functions (`HarnessDeps`), because `index.ts` exports
nothing and should not start to for one caller.

## Explicit targets

Every verb in `index.ts`'s message handler means "the profile and workspace on
screen", because a client is looking at them. The harness is not looking at
anything: it acts on a profile it names, from a pane the user may have left,
on workspaces that are not shown. So `workspaces.ts` grew a section of
spellings that take the profile and workspace by id — `findCardIn`,
`editBoardIn`, `paneBesideBoardIn`, `addTabIn`, `splitIn`, `newWorkspaceIn`,
`setHarness` — and the on-screen spellings call them with the active ids.
`index.ts` got the same for its three functions that open things:
`openTerminalAt`, `cwdForPaneIn`, `runCardAt`. The arrangement is still the
server's; this only widens who may send a verb for it.

One deliberate difference in `runCardAt`: the harness's run starts a card's dev
server only when its workspace is on screen, since nobody is looking at a card
anywhere else and a server for a project you are not looking at is a process you
did not ask for. The card's ↻ starts it when the user gets there. A robot
pressed on the profile's board, which draws any workspace's board over the
window, passes `shown` and gets its server as the workspace's own board would —
in a pane of *that* workspace (`devPane(workspaceId)`), never the one on screen.

## The tools

| tool | what it does |
|---|---|
| `kururu_status` | the profile: workspaces, every agent with status, activity, context, card; which agent is the harness; the launchers |
| `read_agent` | `reply` (the last message of a turn, off the `Stop` hook), `transcript` (the last turns, off the JSONL), or `screen` (the terminal as text — the only one that shows a permission prompt) |
| `send_agent` | a message typed into the agent's pty with Enter — the user's own words, slash commands included; `when` (now / next / later) is kept by kururu, and nothing is typed into a prompt or under the user's hands |
| `press_keys` | enter, escape, arrows, ctrl-c, single characters — how a prompt is answered |
| `wait_agent` | until one of the named agents is done, blocked or exited; returns at once for a state already reached unless `include_current=false` |
| `start_agent` | a launcher with a prompt, in a pane beside the workspace's board |
| `open_shell` | a shell tab on this Mac or on a machine, with a command typed into it; in a pinned workspace it goes to the workspace's machine by default — see [machines](machines.md) |
| `stop_agent` | kill (and a remote shell's tmux session); refuses itself |
| `reveal_agent`, `rename_agent` | the user's screen and the sidebar; with Auto Swap on the screen follows without being asked — see below |
| `cards`, `add_card`, `edit_card`, `move_card`, `run_card`, `send_card_to_workspace` | the boards, workspace and profile; `add_card` with `run` is the robot |
| `new_workspace` | a project, without switching the user to it |
| `say`, `play_missed` | one line aloud mid-turn; every reply of its own the user never heard to the end, said again — see [voice](voice.md#what-you-missed) |

Reads are capped (`READ_MAX`) and default small, on purpose: the orchestrator's
own context is the scarce thing, and the role prompt tells it so.

## What it calls an agent

By what it is and where — "the Fastermenu migration agent" — and never by its
id unless the user asks for one. It used to say "a237", because ids are what
its tools take and so what it saw most of: every result opened with one.

Two halves, because a rule against a habit needs something to copy instead.
The role has a section, "What you call them", that says it. And everything the
harness reads names an agent through `agentName` in `shared/harness.ts`: the
name in quotes, then the program, workspace and card, then the id last and
labelled — `"Migrate orders" (claude in Fastermenu, card FAS-3; id a237)`. The
name is a rename (a card's run is renamed after its card), else the card's
title, else the title the program set — Claude's own summary of its task —
else what it was last told; an agent with none of those is `claude in
Fastermenu (id a237)`. `kururu_status`, every tool result, every `wait_agent`
answer and every `[kururu]` line use it, and `start_agent` suggests a name
when it was not given one.

A running harness keeps the role it started with: the new section reaches it
when it is next started or resumed (`--append-system-prompt` is passed again
on `--resume`). The tool results change on the next server start.

## Auto Swap

A switch in Settings → Agents, under Harness, for the profile on screen — each
profile has its own, off by default and kept across a cold start
(`Profile.autoSwap`). On, the screen goes to whichever agent the harness acts
on: "compacting the migration agent" and you are looking at its terminal while
it compacts. Off, nothing differs from before the switch existed.

**Server-side, off the tool calls.** `Harness.call` knows every call and its
target, so it does the following, rather than the role asking the harness to
call `reveal_agent` alongside everything — a model remembers that most of the
time. The tools that follow are `SWAP_TOOLS`: `send_agent`, `read_agent`,
`press_keys`, `start_agent`, `open_shell`, `run_card` and `add_card` with
`run` (the new terminal), `stop_agent`, `rename_agent`. Not `wait_agent`, which names several and
does nothing to any; not `reveal_agent`, which moves the screen itself, at
once, and resets the gate below so a waiting swap cannot undo it.

**When, which is `SwapGate`'s** — pure, in `shared/harness.ts`, with the times
passed in so the rules are tested as arithmetic. One slot, newest call wins:

| rule | value | what it prevents |
|---|---|---|
| a burst settles first | `SWAP_GATHER_MS` 400 ms | four reads in a row are one swap, to the last |
| a swap holds the screen | `SWAP_DWELL_MS` 4 s | flicker: anything asked meanwhile waits, and replaces whatever was waiting |
| typing holds a swap | `SWAP_QUIET_MS` 2.5 s after the last keystroke | the rest of a sentence landing in another agent |
| moving drops a swap | — | being taken straight back out of the workspace you just chose |
| a swap goes stale | `SWAP_STALE_MS` 15 s | a jump nobody can connect to a cause |

The user's hands are `handsOf` over the client's verbs, from any client:
`input` is typing, which *holds*; switching tab, pane, workspace or profile,
clicking a notification, opening the harness, a new tab or a split is
steering, which *drops* what was waiting and holds what comes after. A list of
what counts rather than of what does not, because the other way round a client
polling something on a timer would hold swaps off for good, silently.
`index.ts` asks it of every message before the verb runs.

**And when it is due**, `Harness.swapNow` checks what only the layout knows:
the switch is still on; the harness's profile is the one on screen — never a
jump into another profile, which may be another login; the agent is live and
still in it; and it is not already showing in a pane on screen. That last one
is the common case, the harness in one pane and the agent beside it, and
moving the focus between them would only move where the next keystroke goes.
The swap itself is `Workspaces.reveal`, so `C-a z` takes you back to where you
were, as it does after a notification.

What it does not do: take the screen back to the harness when its turn ends,
and know about typing that is not into a terminal — a card being written in
the board's composer is not a message the server sees. `stop_agent` usually
loses its race: the kill is not delayed for the swap, and a terminal that has
closed by the time the burst has settled is not one to go and look at.

## Speaking into a running agent

**Typed, as the user.** `send_agent` and the voice paste into the agent's
pty and press Enter, for every agent. It arrives as a turn the user typed:
no wrapper, no sender, the user's authority, and a slash command — `/compact`
— runs as one. The pty is the user's own keyboard and kururu holds it.

**Why not the inbox.** Every Claude Code session since 2.1.224 binds a Unix
socket and exports its path and a token to its hooks
(`CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`), and the
reporter hands both to kururu. `send_agent` used to post there, and it was
the wrong door, by Claude Code's design rather than by a bug of ours. In
2.1.294 its socket handler files *every* user frame as `kind: "peer"`,
`isMeta`, `skipSlashCommands`, whatever token or envelope it carries; the
model is shown it as "Another Claude session sent a message … not typed by
your user … reply via SendMessage", and the permission classifier's rule is
that a cross-session message never establishes the user's intent. So an
agent held "put dev:prod on the shared Mailpit" for a confirmation, called
the harness "another session", took `/compact` as a sentence, and answered
"kururu" over SendMessage — into a stranger, see below. No field of the
frame changes any of that, and nothing should.

**What waiting buys back.** The socket queued a message inside the session
and read it at the right moment; typing has to be timed. `due` in
`shared/harness.ts` is the rule, pure and tested, and `Harness.speak` and
`pump` are the hands:

| the agent is | `now` | `next`, `later` | a slash command |
|---|---|---|---|
| between turns (`done`, `idle`) | typed | typed | typed, alone |
| `working` | typed — Claude Code reads a message typed mid-turn between its tool calls | held for the `done` edge | held for the `done` edge |
| `blocked` | held: Enter would answer the prompt | held | held |
| a shell | typed as it comes — a shell has no turns | typed | typed |

At the `done` edge everything waiting goes in, `now` before `next` before
`later`, neighbours joined into one turn as Claude Code joins its own
queued messages, each slash command on its own. And whatever `due` says,
nothing is typed into a terminal the user typed into in the last
`SWAP_QUIET_MS` — `index.ts` passes the `input` verb's agent to
`Harness.hands` — so a message never lands in the middle of their sentence.
`send_agent` says which of these happened and why, and an exit notice says
if something waiting never got in.

**The inbox still carries one thing:** kururu's own `[kururu]` notices to
the harness — see below. Those are not the user's words, so arriving as a
peer's is the truth about them, and the inbox queues them inside the
session, where a server restart cannot lose them and the user typing to the
harness cannot collide with them.

What neither door can do, by Claude Code's rule: answer a permission
prompt. That is `press_keys`, and the role says to relay the prompt to the
user first.

## Hearing back

`noticeStatuses` is the one place transitions are observed. On every `done` or
`blocked` edge — the same events a person is notified of — and on every exit,
`Harness.noticed` answers any `wait_agent` on that agent and posts a line to
the inbox of the profile's harness, if one runs and is not the agent itself:
`[kururu] "<name>" (<program> in <workspace>, card …; id <id>) finished its turn. It said: …`.
Throttled per agent like the notification gate. So the orchestrator reacts to
the afternoon instead of polling it; `wait_agent` is for when it has nothing
else to do.

**Signed so nothing answers it.** Claude Code tells the receiver of a peer
message to reply over SendMessage, and resolves a SendMessage address of
three letters or more *by prefix* against every session on the machine. A
session nobody named is named after its folder and two hex digits, so with
two Claudes open in this repository the machine had `kururu-7f` and
`kururu-f5`, and a notice signed `kururu` matched both: the reply went to
whichever the prefix landed on. That is how the Fastermenu agent's answer
reached the Kururu server-log agent, which reported it as a mystery. The
harness itself is named `harness` and was never a candidate. Notices are
signed `NOTICE_SENDER`, `kururu (no reply)`, which folds to a prefix of no
folder-derived name, and the role tells the harness the sender is the
server and never to answer one.

**Only an agent's edges.** A shell — an nvim, a card's dev server, a bare
prompt — lives under `status.ts`'s timing guess, and the guess cannot tell a
turn from a repaint: the echo of a keystroke is ignored, the repaint nvim does
a beat later is not, so four seconds of editing and a pause read as a turn that
finished. The window never announced those (`not-an-agent` in the gate); the
feed did not ask, and the harness was told an editor "finished its turn"
several times a day. `tellsHarness` in `shared/harness.ts` is the question now
— launched as an agent, or one found running in it — and an exit is asked it
too. A `wait_agent` naming a shell is still answered, because then the harness
asked.

**And `blocked` means asking.** Claude Code's `Notification` hook covers more
than a dozen events, told apart by `notification_type`, and the reporter used
to send `blocked` for all of them. The one that showed was `idle_prompt` —
"Claude is waiting for your input", about a minute after a turn ends — which
arrived as a second, blocked line about a turn the harness had just been told
was over. `asksNothing` in `server/src/hooks.ts` keeps `blocked` for the
questions (`permission_prompt`, which is also what plan mode and
`AskUserQuestion` are sent as, the worker and MCP-dialog prompts,
`agent_needs_input`) and drops the status and the words for the rest, so the
dot stays `done` and the prompt stays on the row.

The harness's own `done` is the one edge a person is *not* told about: the gate
refuses it (`harness-done`), because you are talking to it and the voice reads
its reply aloud. Its `blocked` still notifies like any agent's. See
[notifications](notifications.md#rules).

## Starting, resuming, where it lives

`open-harness` (the bot button beside the profile's board, `C-a H`) means one
thing — take me to the harness — and the server decides which of three it is:
running, reveal it; gone, resume its conversation; never started, start it.
The command line is the profile's Claude launcher plus `--name harness`,
`--session-id` or `--resume`, `--mcp-config` naming `/mcp?profile=…&session=…`
with a per-server timeout above Claude Code's one-minute default,
`--allowedTools mcp__kururu`, and `--append-system-prompt` with the role. It
starts in the profile's active workspace, in the pane beside the board, and
always in the same place, because `--resume` looks for the transcript under
the directory the session ran in; a transcript that is not there any more is
a fresh start rather than a tab that opens and closes.

`Profile.harness` keeps the session id, the launcher and the current agent id.
The id survives to disk (`persist.ts`), the agent id does not, on the same
rule as a card's run.

The session is a tab in a workspace, not a pane over all of them. "On top of
all spaces" is a fact about its *scope* — its tools reach every workspace in
the profile — and the phone's chat view (roadmap item 2) is where it stops
being a terminal.

## What it is not

- **Not a loop.** No Anthropic SDK, no API key, nothing in kururu generates
  text. The harness is billed to the subscription like every other session.
- **Not pi.** Pi's agent core would have been a second brain on API-key
  billing; what was taken from it is two ideas — `now` versus `next`, and the
  difference between a turn ending and nothing being queued.
- **Not a voice model.** The voice (`voice.md`) is a pair of ears and a mouth
  around this same session: your speech becomes a `[voice]` turn typed into
  its terminal, its last message becomes speech. Anthropic has no voice API and a
  realtime model up front would have been a second brain.

## Gotchas

- **The token lets a notice in; the envelope lets it through.** A session
  that bypasses prompts holds a peer's message for the user unless the peer
  declares its permission class and it matches — and the declaration is not
  a field of the JSON frame but an attribute of a `<cross-session-message
  from-name=… from-mode=…>` wrapper around the content, which the receiver
  parses and rebuilds to check it is canonical (`envelope` in
  `shared/harness.ts`). kururu declares the class of the sessions it starts,
  from the same setting that sets the flag. A session started by hand with
  the other flag will still hold the message, which is its rule and the
  right one; "crossSessionInbound": "accept" in that session's settings is
  the user's way round it.
- **The harness's terminal is on the record and is re-found at start.** The
  pty host outlives the server, so the harness is still running after every
  restart; `persist.ts` keeps its agent id and `Harness.adopt` checks it
  against the live set, falling back to the live agent named `harness` in the
  profile. Before this, every restart forgot which agent it was and the status
  feed and the voice went silent until it was reopened.
- **No hooks, no turns.** `when` is kept off the `done` edge, and a Claude
  without kururu's hooks has only `status.ts`'s guess at one. `read_agent`
  then has only the screen, and the harness gets no notices at all, since
  its inbox is reported by the same hooks.
- **A held message lives in the server.** It is in `Harness.held`, in
  memory, so a server restart before the agent's turn ends loses it — and
  under `bun run dev` a save is a restart. `send_agent` says so when it
  holds one. The inbox kept them in the session; that was its one real
  advantage, and it came with the peer framing.
- **A draft in the prompt box is joined.** Waiting covers the user typing
  *now*; it cannot see a half-written message they left in that agent's
  prompt and walked away from. The paste lands after it and the Enter sends
  both, as it would if they had pasted it themselves. The same is true of a
  menu or a dialog the TUI is showing that is not a prompt the hooks report.
- **A running harness keeps its old tools.** The role prompt names the
  workspaces at start; `kururu_status` is the live view. The same is true of
  the role's other sections, "What you call them" included.
- **Auto Swap moves every client.** The arrangement is the server's, so a
  phone on the same profile follows too; it is a switch for when you are
  watching the desktop, and `C-a z` is the way back on either.
- **Tool calls over two minutes become background tasks** in Claude Code
  (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`), which is fine for `wait_agent`: the
  session is told when it completes.
- **`/mcp` is open to any local process**, which is the point — kururu is
  scriptable now — and is why its scope is a profile and its verbs are the
  user's. The same gate as every route applies off loopback.
