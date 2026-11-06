# Antigravity

Antigravity's own terminal agent, `agy`, as kururu's fourth program beside
Claude Code, Codex and OpenCode. It is there for the day the Claude
subscription's allowance runs out: an Antigravity plan sells the same Claude
models on a quota of its own, and the sanctioned way to spend that quota is
Antigravity's own CLI. So kururu runs `agy` in a pty exactly as it runs
`claude`.

**Antigravity's sign-in is never lent.** No token of Antigravity's is read,
copied or handed to another program, and nothing is made to look like
Antigravity to Google. Everything below goes through doors `agy` documents.
That is the rule; it is in [invariants](invariants.md#antigravity).

## Installing it

`agy` does not come with Antigravity.app. Google's installer puts it in
`~/.local/bin`:

```sh
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

Signing in is the user's: run `agy` once in a terminal. `agy models` lists
what the account can use, and answering it at all is the sign that it is
signed in.

## The launchers

`LAUNCHERS` has an `agy` row with no model and one row per model `agy models`
offers, each at its top effort, plus Claude Opus 5.5 at medium:
`agy:claude-opus-5-5-high`, `agy:claude-sonnet-5-5-high`, the Gemini rows and
GPT-OSS. `agy` names a model and its effort in one id, so the id is the
model. Settings → Agents has an Antigravity group like Codex's: in the +
menu or not, its bypass (`--dangerously-skip-permissions`), and its models.

A card's words go in as `--prompt-interactive`, which starts the session on
them and stays, where `--prompt` would print one reply and exit.

## The switch

Settings → Agents → Kuru → **Runs on** has a third position, Antigravity,
with a model beside it (`agyModel`, `claude-opus-5-5-high` by default). It
does what OpenCode's position does (`launcherFor`, `switchedFrom` in
`shared/launchers.ts`):

- the default launcher and the Claude rows become the Antigravity row for
  `agyModel`; OpenCode's become it too;
- a Codex row, or an Antigravity row asked for by name, is kept;
- the + menu shows the switch's row first and then the other Antigravity rows;
- a card whose last run was on Claude or OpenCode starts fresh on Antigravity
  rather than resuming, since no program can read another's conversation;
- Kuru runs on `agy` from its next start, and Settings offers the restart.

Back on Claude Code, a card that ran on Antigravity resumes on Antigravity:
its rows are in the Claude menu, so it was somebody's choice.

## Status: the title command and the screen

`agy` takes no hooks per launch. It reads them only from
`~/.gemini/config/hooks.json` or a project's `.agents/hooks.json`, and kururu
writes into neither the user's config nor the user's projects. What it does
take per launch is `--settings`: settings.json keys for this session only,
never saved. Through it kururu sets a **title command**, which `agy` runs
on every change of state with a JSON payload and whose output is the window
title.

That command is `agyreport.mjs`, bundled beside `server.mjs`
(`server/src/agy-report-cli.ts`), run on the server's own runtime as the
Claude hooks are. It prints "Antigravity" and then reports what changed:

| `agy`'s state | reported |
|---|---|
| first `idle` | `idle`, which stops the host's byte-timing guess |
| `thinking`, `working`, `tool_use`, anything new | `working`, once |
| `idle` after any of those | `done`, with the reply read off the transcript |

It carries the conversation id with every report, which is how a card learns
its id and the drawer files an agent's reply. The title runs on every
redraw, so the last state is kept in `~/.local/state/kururu/agy/<nonce>.json`,
where the nonce is minted per launch: agent ids are handed out again after a
host restart, and a new agent must not inherit an old one's `working`.

**Blocked comes off the screen.** While a permission prompt waits, the title
still says `tool_use`, the same as while the tool runs. So `server/src/onscreen.ts`
reads local `agy` agents as it reads remote ones, and `shared/onscreen.ts`
knows agy's screen:

- working: a lowercase `esc to cancel` at the start of the footer, or the
  braille spinner (`⣽  Generating...`);
- asking: `↑/↓ Navigate` under a choice, with the question the nearest row
  above ending in `?` ("Run this command?", "Allow access to this file?",
  "Do you trust the contents of this project?"), and the command or path
  after "Requesting permission for:" added to it.

A card's worktree is a folder `agy` has not been told to trust, so its first
run stops on the trust question and shows as blocked. That is the user's to
answer, as Claude Code's is.

## Resume

`agy --conversation <id>` resumes a conversation by id, and `agy` keeps the
same id. A card resumes that way once its first report has named the id.
Without one it does not resume: `agy`'s `--continue` takes the newest
conversation in the folder, which in a shared checkout may be somebody
else's. Sleeping an idle card works as it does for Claude: the last reply is
read off `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript_full.jsonl`.

## Kuru on Antigravity

Kuru's folder is kururu's, so Kuru gets the project doors there, all under
`.agents/` and rewritten on every start (`prepareAgyHome`):

- `rules/kururu-role.md`, the role as an always-on rule;
- `mcp_config.json`, kururu's verbs at the same `/mcp` address Claude Code is
  given, every tool eager so `agy` registers it as `mcp_kururu_<tool>`; the
  web tools beside them when a provider is on. 0600, because when loopback
  wants a token it is written in as itself: `agy` documents no substitution;
- `hooks.json`, `PreInvocation` for the user's words (its first invocation
  of a turn carries them as `lastUserInput`) and `Stop` for the reply.

Its `--settings` trust the folder and allow `mcp(kururu/*)` for that launch,
so there is no dialog and no prompt per tool. The title runs in `kuru` mode,
which reports only that Kuru is up and the quota. The hooks report the turns,
and two reporters would read every reply aloud twice. kururu's notices are
typed into its prompt, as OpenCode's are. Its conversation is `agy`'s to
name: the first report's id is kept as `HarnessState.agySessionId`, and every
start after resumes it while `agy` still has it.

What it does not have: compaction at kururu's point (`agy` compacts on its
own), and the Claude-only parts of Kuru's start (memories carried over,
`--strict-mcp-config`).

## The usage bar

The title payload carries the plan's quota: per group (`3p` is every
non-Google model, so Claude's and GPT-OSS; `gemini`), a five-hour window and a
week, each as a fraction remaining and a reset time. The reporter writes the
windows and the plan to `~/.local/state/kururu/agy-quota.json`, and never the
email beside them in the payload. The server reads that file on the usage
beat (`server/src/agy.ts`) and the bottom bar draws an Antigravity chip like
Codex's: spent rather than left, amber from 75% and red from 90%, a window
whose reset has passed dropped. It is as fresh as the last `agy` that ran
under kururu.

## What it does not get

- kururu's web tools for an ordinary agent, which would need an MCP config in
  the user's project;
- the usage ledger, which reads Claude's, Codex's and OpenCode's logs
  (`noteLaunch` and `noteReported` leave `agy` out);
- a signed-in check on a machine: `AGENT_CHECK` asks only that `agy` is
  installed there, since it has no status subcommand.
