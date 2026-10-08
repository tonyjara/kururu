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
publishes, the role prompt, the grammar of a key press and of a paste, the
frames a message to a running Claude is, the transcript-tail reader. Tested.

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

One deliberate difference in `runCardAt`: a card's dev server is only started
when its workspace is on screen, because the dev terminal goes into a pane of
whatever *is* on screen. The card's ↻ starts it when the user gets there.

## The tools

| tool | what it does |
|---|---|
| `kururu_status` | the profile: workspaces, every agent with status, activity, context, card; which agent is the harness; the launchers |
| `read_agent` | `reply` (the last message of a turn, off the `Stop` hook), `transcript` (the last turns, off the JSONL), or `screen` (the terminal as text — the only one that shows a permission prompt) |
| `send_agent` | a message, through the inbox for a Claude with hooks (`when`: now / next / later) or typed into the pty with Enter for anything else |
| `press_keys` | enter, escape, arrows, ctrl-c, single characters — how a prompt is answered |
| `wait_agent` | until one of the named agents is done, blocked or exited; returns at once for a state already reached unless `include_current=false` |
| `start_agent` | a launcher with a prompt, in a pane beside the workspace's board |
| `stop_agent` | kill; refuses itself |
| `reveal_agent`, `rename_agent` | the user's screen and the sidebar |
| `cards`, `add_card`, `edit_card`, `move_card`, `run_card`, `send_card_to_workspace` | the boards, workspace and profile; `add_card` with `run` is the robot |
| `new_workspace` | a project, without switching the user to it |

Reads are capped (`READ_MAX`) and default small, on purpose: the orchestrator's
own context is the scarce thing, and the role prompt tells it so.

## Two channels into a running Claude

**The inbox socket.** Every Claude Code session since 2.1.224 binds a Unix
socket and exports its path and a per-session token to its hooks as
`CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN`. Kururu's
reporter (`report-cli.ts`) already runs as a hook, so it reports both, along
with the transcript's path and the `Stop` payload's `last_assistant_message`.
A message is newline-delimited JSON on that socket: the token as an `auth`
line, then one `user` frame — `{type, message: {role, content}, from,
priority}` — the shape the session's own stdin takes. The token is what makes
the message count as the session's *own*: a session that runs without
permission prompts holds a stranger's message for approval, and a held message
arrives after the user has gone to see why nothing happened. Verified by
posting a frame into the session this was written in.

What the inbox cannot do, by Claude Code's rule: answer a permission prompt.
That is `press_keys`, and the role says to relay the prompt to the user first.

**The pty.** For Codex, or a Claude whose hooks are not installed: a bracketed
paste, a beat, Enter. `when` cannot apply and the tool says so.

## Hearing back

`noticeStatuses` is the one place transitions are observed. On every `done` or
`blocked` edge — the same events a person is notified of — and on every exit,
`Harness.noticed` answers any `wait_agent` on that agent and posts a line to
the inbox of the profile's harness, if one runs and is not the agent itself:
`[kururu] <name> (<id>, in <workspace>, card …) finished its turn. It said: …`.
Throttled per agent like the notification gate. So the orchestrator reacts to
the afternoon instead of polling it; `wait_agent` is for when it has nothing
else to do.

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
- **Not voice, yet.** Anthropic has no voice API. The front-end is a vendor
  decision (Gemini Live, OpenAI Realtime, or a cascade around Claude) and it
  would drive these same tools.

## Gotchas

- **No inbox, no `when`.** An agent reports its socket only through the hooks.
  Without them `send_agent` types, and `read_agent` has only the screen.
- **A running harness keeps its old tools.** The role prompt names the
  workspaces at start; `kururu_status` is the live view.
- **Tool calls over two minutes become background tasks** in Claude Code
  (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`), which is fine for `wait_agent`: the
  session is told when it completes.
- **`/mcp` is open to any local process**, which is the point — kururu is
  scriptable now — and is why its scope is a profile and its verbs are the
  user's. The same gate as every route applies off loopback.
