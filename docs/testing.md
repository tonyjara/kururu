# Testing

## What `bun test` covers

Pure functions and a temp directory. **No test should spawn a real agent CLI.**

`procs`, `report`, `status`, `files`, `workspaces` (holds a tree, touches no pty),
`sizing` (a fold over some numbers, which is the whole size policy), `hostsock`
(two ports over a socket, no pty anywhere), `notify` (the gate, the words, and
what a hand-edited settings file can say), `access` (the token from each of the
three places one can arrive, and the cross-origin refusal — the case that works
against a kururu nobody shared), `update` (which of two versions is newer,
including the prerelease rule and the one where 0.10 is not smaller than 0.9),
`sounds` (the catalogue against a temp directory), `cursor` (DECSCUSR and OSC 12
in both directions, every spelling of a colour, a sequence cut in half by a read
boundary, and that the two directions round-trip), `styles` (the registry format
and every check applied to a manifest a stranger wrote — no network, no disk),
`screen` (serialize, rebuild, compare the buffers; and the hidden cursor),
`layout` (asserting *through* `JSON.stringify`), `days` (that a day no calendar
has is refused rather than rolled into the next month, and that a change of
clocks is not a day), `board` (the run automation, and a card's dates and the
timeline's window), `sleep` (what idle is, the question in a reply, the
draft in a prompt, and the CLIs' conversation files — a Codex rollout found
by its card's words, a last reply read off a tail — against a temp directory), `store` (the database against a temp directory: boards written through and read back, the history, deleted cards kept and restored, the file never taking a card off the database, keys matched back by name, and the mirror written and read back as the same database), `reload` (when a page may reload for an agent, what the agent is told, and the server's bookkeeping on a hand-turned clock, plus the harness's tool), `channels` (every way a Telegram message can fail to be the user's, in `judge`'s order; pairing codes; splitting a reply; when a reply is spoken; and the bot module itself against a stand-in Bot API in memory — the token's file mode, the offset kept across a restart, the queue's order through a 429, a 403, a revoked token, and the token never in an error), `markdown` (the reader's whole
security story: that raw HTML cannot be emitted and that no `href` or `src`
carries a scheme the browser would run — the one test that drives a real
dependency, since Shiki's wasm has to load), and the pane tree in `web/test`,
including that a number arriving from a client cannot enter the tree unless it is
one, and `grid`, which holds the clamp-floor refusal.

`web/test/theme.test.ts` holds both style axes in both directions, and then
whether the result can be *read* — every colour pair the stylesheet states,
against every theme, ratcheted against the nineteen that are under their floor
today. `contrast` is the arithmetic under it and the two ways it declines to
answer. See [styles](styles.md).

## Testing by hand

**Spawn something harmless.** `create-agent` takes a `command`, so use `sleep 30`
or `cat` rather than `claude`, and spend no tokens proving that plumbing works.

**Check whether a server is running before you start** —
`curl -s localhost:7717/api/health` — and say what you are about to disturb.

## The isolated instance

Anything that writes to config, installs a style, or acts as a second real client
goes in an isolated instance rather than against the user's server. A second real
client resizes their live agents; an install writes into their `~/.config/kururu`.

```sh
KURURU_PORT=7817 \
KURURU_HOST_SOCK=/tmp/k2/ptyhost.sock \
KURURU_STATE_DIR=/tmp/k2 \
KURURU_DATA_DIR=/tmp/k2/data \
XDG_CONFIG_HOME=/tmp/k2/config \
KURURU_STYLES_URL=http://127.0.0.1:8899
```

**The desktop app in isolation** takes three more, and is launched from
`desktop/` with `env -u ELECTRON_RUN_AS_NODE` (see [gotchas](gotchas.md#running)):

```sh
KURURU_USER_DATA=/tmp/k2/ud      # its own Chromium profile and single-instance lock
KURURU_AUTOSTART=1               # start the server as the app does, with nobody to click the tray
KURURU_TALKKEY=/tmp/k2/none      # a hook that is "missing", so no Input Monitoring prompt
```

`servers.js` reads `KURURU_PORT` too, so the picker looks for the isolated
server and never adopts the real one. The isolated dev shell runs *this*
checkout's `run.mjs --watch`, which builds into the same `desktop/dist` the
real runner uses — identical output, but do not save a server file while both
are up, or two esbuilds race for one file. Its host lands at
`/tmp/k2/ptyhost.sock`; `bun run kill-ptyhosts /tmp/k2` clears it up.

Registry testing serves the sibling checkout with
`python3 -m http.server 8899 --bind 127.0.0.1` from `../kururu-styles`, and a
scratch copy under `/tmp` is where `build-index.mjs` is run — never in the
checkout.

**Run it from a copy outside `~/Desktop`, with `node-pty` copied rather than
linked.** The isolated server starts its host as the real one does, a launchd
job on a clone of Kururu.app, and macOS's privacy settings treat that clone as
a new face: anything it opens under `~/Desktop` waits on a folder-access
prompt, the host blocks in `open()`, and the server says it is "running but not
listening". A checkout on the Desktop is that, and so is a scratch copy whose
`node_modules` is a symlink back into one, since `node-pty` is the module the
host loads. Copy the tree into the scratchpad, make `node_modules` a directory
of symlinks with `node-pty` itself copied (`cp -cR`, a clone on APFS), build
there, and keep the socket's path short — macOS caps one near 104 bytes. It
also keeps the two esbuilds out of each other's `desktop/dist`. A client for
it can be hidden Electron windows on the real preload, driven through
`executeJavaScript`, with `app.dock.hide()` and a hard exit: an Electron tile
left in the Dock is how a force quit reached a coalition on 2026-10-10.

**The one trap in the isolated instance:** it sets `XDG_CONFIG_HOME`, and **nvim
reads its config from there too**. So nvim comes up with no colourscheme and no
per-mode cursor colours at all, which reads exactly like the cursor feature not
working. `XDG_CONFIG_HOME=$HOME/.config nvim` on the command line is the fix —
kururu stays isolated and nvim does not.

## What has been verified end to end

Kept short on purpose; the detail is in git history.

- **Firecrawl for agents** (2026-10-12), in an isolated instance on :7817 from
  a scratch copy, with a stand-in Firecrawl (`KURURU_FIRECRAWL_API`) in the
  documented v2 shapes. Settings: a wrong key refused with Firecrawl's
  reason, a padded one saved 0600, the test page, a NaN limit ignored, and
  none of 31 messages to the window carrying the key. The tools over
  `/mcp/web`: a scrape wrapped and its `</web_page>` defused, a three-page
  PDF charged three, `localhost` refused before anything was sent, map and
  search, a crawl capped at the page limit and lowered to the budget's last
  four credits (Firecrawl was sent `limit: 4`) and followed through `next`,
  the next call refused as over budget, a crawl that never finished
  cancelled at four minutes with its pages returned and a foreign `next`
  link never requested, an `Origin` or `X-Forwarded-For` refused. Launches
  through the isolated host, stand-in CLIs recording argv: the menu's
  Claude and Codex, a card's robot (its prompt intact after
  `--mcp-config=`) and the harness (two `--mcp-config` values) all got the
  flags, and no agent's environment held the key. The real CLIs against
  stand-in model APIs, no tokens spent: Claude Code 2.1.296 listed the four
  tools, expanded `${KURURU_AGENT_ID}` into the header, called
  `scrape_page` and handed the model the wrapped page — and in a stuck
  tool loop made 1,104 calls in twenty seconds, which the budget stopped at
  exactly its 500 credits; Codex 0.146 took the `-c` overrides, sent the
  header and called `scrape_page` in its `mcp__kururu_web` namespace (on a
  model name it did not know, since for its own models it defers MCP tools
  behind `tool_search`). Not pressed: the real Firecrawl, which refused this
  network's keyless tier, and a key, which the user pastes; the page in a
  real window.
- **The three-process split**, against a real pty: the server spawns a detached
  host when none is listening; input and output round-trip with escape sequences
  intact; the server is killed and restarted and the agent comes back with **the
  same id and the same pid**; `C-a B` does the same through `run.mjs` and the
  host's pid never moves; a SIGKILLed host leaves a socket the next server
  recognises as a corpse; a SIGTERMed host reaps its ptys and unlinks. The desktop
  was left on the picker with nothing reachable, a server was started elsewhere,
  and the window found it within the second.
- **The pty layer:** spawn / type / kill / exit with process-group teardown, the
  status heuristic through a real pty, resize reaching the pty (`stty size`
  agrees), unwatched terminals not streaming, history surviving being unwatched.
- **The server owning the size:** one client's proposal comes back unchanged; a
  narrower second client takes the pty to the smaller of the two and **both** are
  told; each dimension is taken on its own; a client that stops looking hands the
  size back and a warm one never has a vote; a `watch` alone produces no backlog;
  a terminal nobody can see keeps its shape; an exited terminal's screen still
  reflows.
- **The hierarchy and dragging:** tabs stack and reorder, splits inherit the
  project, `focus-dir` crosses splits and stops at the edge, workspaces jump by
  number, a restart brings back names / splits / cwds with **nothing respawned**.
  A tab crosses panes and workspaces and splits a pane on the edge it was dropped
  on; a pane swaps without deepening the tree; a pane a drag emptied is pruned
  while a deliberately empty one stays.
- **Dev servers:** discovery from both ends, restart in the same tab, recovery in
  a fresh one after a cold start; the preview proxy including HMR websockets with
  subprotocol negotiation; traversal-safe file browsing. Stopping one, against
  throwaway servers on real sockets: a nodemon-shaped parent that respawns its
  listener stays down, a server that ignores SIGTERM is gone after the grace,
  and a stale pid is refused.
- **Styles:** installing a theme, a skin, a mascot and a pack writes and
  activates; `/api/styles/asset` serves a font and refuses a traversal;
  `/api/styles/preview` proxies a sheet; `1.10.0 > 1.0.0` the right way round;
  removing a style leaves the id in `appearance.json` and falls back at draw time.
  The registry's own rules were exercised in a scratch copy: a changed colour
  under an unchanged version refused, a remote `url()` refused, a mascot clip
  running off its sheet refused.
- **The studio:** a skin created from nothing was worn at once, a PNG posted to it
  came back with its size, forking Handheld copied its pictures and re-pointed the
  manifest, a registry install over a local skin of the same id was refused, and a
  non-PNG, a path and an upload to a registry skin were each refused with a
  sentence.
- **Idle card agents** (2026-10-11), in an isolated instance with a stand-in
  `claude` on the `PATH` and a scratch `HOME`: at one minute, the plain card's
  agent was ended and its card read `asleep` with its session id; the card
  whose reply asked a question and the one with half a message typed into it
  stayed awake and `/api/sleep` said why; an agent from the menu idle as long
  was never looked at; running the asleep card started `claude --resume` with
  the same id; switched off, nothing was ended. Against the real CLIs, on the
  cheapest models in a scratch folder: `claude --session-id` then `claude
  --model … --dangerously-skip-permissions --resume <id>` recalled a word from
  the first turn in the same transcript; Codex's TUI started as a card starts
  it was found by its rollout (and another card's words and another folder
  were not), and `codex resume … <id>` recalled its word in the same rollout.
  The machine path ran on this Mac through a stand-in `ssh`: the tab's own
  line — ssh loop, tmux session, the install check, `claude --resume` in the
  pin's folder — brought the conversation back, the transcript was read "over
  ssh", and `endSession` took the session and the process down. No real
  machine was reachable with a CLI on it.
- **Telegram** (2026-10-12), in an isolated instance on :7817 run from a
  scratch copy with `KURURU_TELEGRAM_API` pointed at a stand-in Bot API on
  loopback and a stand-in `claude` as the harness — a Python script that
  reads a prompt off its terminal and reports it, then a reply, through
  `/api/report` as the hooks do (hard-wired to :7817), with `HOME`, `SHELL`
  and `PATH` set so the real CLI could not run. Thirty-four checks: a
  malformed token refused without a request, a good one asked `getMe` and
  kept 0600, the status carrying the last four and never the rest; no poll
  while off and not pairing; on refused with nobody allowed; pairing offered
  the account that sent `/start <code>` and not the stranger who wrote first,
  who was counted and never answered; the test message; on. A stranger's
  "stop every agent" reached nothing. A message from the paired account went
  into the outbox as `telegram-<chat>-<id>`, was typed into the stand-in as
  `[telegram] …`, delivered, and its reply came back to the fake chat; the
  drawer's item said `telegram` and the reply had no utterance. A line typed
  in the drawer reached the chat as a silent "⌨️ You typed" ahead of its
  reply, which was spoken. Off: no poll and nothing sent, even for a drawer
  line's reply, and a Telegram message went nowhere; on again, it was
  dropped with one line saying so. The token was in no window message, no
  server output, no `lifecycle.log` and not the state file. Not tried: the
  real Telegram, a phone, the page in a real window.
- **An agent reloading the window** (2026-10-11), in an isolated instance on
  :7817 run from a scratch copy, with two hidden Electron pages on the real
  preload — a window and the pill — and the real `bun run reload-window`. Both
  idle reloaded at once and came back, and the window named who asked. A
  keystroke a second held the window until five seconds after the last while
  the pill went at once. A `.scrim` held the window to the timeout, which let
  it go, and it did not reload when the scrim went. A third client's
  `talking` held both. The pill speaking, as the bridge told the window, held
  the window, and so did a focused field with words in it. An agent's id put
  its name on the notice, and the harness's tool through `/mcp` said Kuru.
  With no page the answer was "nothing was reloaded". A server killed
  mid-wait came back to a command that asked again and a window that
  reconnected without reloading. Not pressed: a real microphone, the
  installed app's own pill, a phone.
- **Notifications:** a `blocked` report with nobody watching raised a card on both
  clients; a second transition inside the throttle was dropped; with one client
  watching and one not, **the watching one was not interrupted and the other
  was**. `reveal-agent` crossed profiles and prefix+z still went back.
  `Frog.aiff` decoded as WAV — the whole reason `sounds.ts` exists, since the same
  file decoded from disk throws.
- **The unread mark**, once it stopped meaning bytes: a shell bursting for six
  seconds and then going quiet was **not** marked while merely working, was
  marked the moment it reached `done` with nobody watching, and lost the mark
  when a client watched it. Done *while visible* left no mark at all, a
  chattering off-screen terminal stayed unmarked for as long as it chattered,
  typing into a marked one took the mark off as its status left `done`, and a
  terminal only the *second* client could see counted as seen by both.
- **The cursor:** nvim under its real config drew a rosewater block in normal, a
  grey bar in insert, a purple block in visual; `OSC 112` put the theme's cursor
  back on quit; and a **window reload — every emulator new — came back drawing the
  bar**, which is the half only the reconstruction can be wrong about. The
  character was legible through the block throughout.
- **The file tree and the editor handoff**, in an isolated instance with its own
  vite and a headless Chrome over CDP: the tree followed a new terminal into its
  repository; a markdown click split off a reader and a second click reused it;
  a file named `it's a file.ts` opened in a new nvim split titled `nvim`, and a
  second file went to that nvim with `:drop` (asked back over its socket);
  editors came back focused-pane first; a `..` path was refused. A double-clicked
  list gained an item and the file on disk changed in those lines only; a stale
  version got a 409, a `.json` and a root outside the allowed set a 400, and a
  foreign `Origin` a 403. At 390px wide the tree was a sheet and a code file
  raised the nvim prompt.
- **The gate**, checked from the LAN address so requests genuinely arrived from a
  non-loopback peer: no token 403, wrong token 403, right token 200;
  `/api/access` returned a cookie that then worked alone; a valid token with an
  `Origin` of `https://evil.example` was refused; loopback needed nothing.
- **Packaging:** the signed, notarized DMG checked the way a stranger's Mac will —
  quarantined, mounted, `spctl` answering `accepted, source=Notarized Developer
  ID`. From inside the `.app`: the window started the bundled server, which
  spawned a detached host whose parent is pid 1; `web/dist` and `assets` resolved
  out of `Resources`; SIGTERM took the server and left the host running.
- **The updater**, over CDP against the packaged app: the bridge answers `idle`
  rather than `unavailable`; a feed whose newest release is the running version
  found nothing newer; the same build packaged as 0.0.9 downloaded the real 0.1.0
  zip, 0% to 36% in four seconds, so `download-progress` genuinely fires.

- **The menu-bar runner**, in an isolated dev shell (`KURURU_AUTOSTART=1`,
  `KURURU_TALKKEY` pointed at nothing) on 7817 with its own host and config:
  the app built the checkout's web app with its own `vite build` on Electron
  as node (619 ms), started `run.mjs --watch` from the checkout, and the
  server came up and spawned a host under `/tmp/k2`; `/api/health` reported
  `supervisor` equal to the runner's pid and `because: the menu bar was
  started`. `POST /api/restart` answered `{ok:true}` and the record read
  *stop: the menu bar asked for a restart → runner: it asked to be restarted →
  start*, with a new server pid under the same runner. `POST /api/host/restart`
  answered `{ok:true}`, the host was SIGTERMed, the server exited 75, the
  runner brought a new server that started a new host, and the record said
  *the last one was stopped by SIGTERM with 0 agent(s) running*. The pill page
  loaded at `/?pill` with the bridge and reported its phase. SIGTERM to the app
  stopped the runner and the server and left the host holding its socket, which
  `kill-ptyhosts /tmp/k2` then cleared; the real host on 7717 was never
  touched. The menu's sentences are `desktop/test/menu.test.js`.
- **Agents on a machine**, in an isolated instance on 7817 whose `PATH` held a
  fake `ssh` (it runs the far side here, under `/bin/sh`), a fake `claude`
  that draws Claude Code 2.1's working, done and permission screens, and a
  fake `codex` that is signed out; `TMUX_TMPDIR` gave it a tmux server of its
  own, and `SHELL` was a two-line wrapper, because macOS's login profile puts
  `/usr/bin` ahead of everything and the real `ssh` (and a real `claude`)
  would have won. Pinned to the fake machine, `new-tab` with a launcher came
  back `working` within a second, `done` two seconds after the turn stopped,
  `blocked` with "Do you want to proceed?" as its activity, `working` again on
  the answer and `done` after; Claude's window title reached the tab through
  tmux. Codex came back `blocked` with "Codex is not logged in on fakebox".
  Closing each tab ended its session. The check itself runs under bash and zsh
  in `machines.test.ts`. A real machine with a real Claude — and the + menu and
  the chip in a real window — have not been tried.
- **The host as a launchd job** (`hostlaunch.ts`), on macOS 26. Probe jobs
  first: each got a resource and a jetsam coalition of its own, named after its
  label (`launchctl print`, and `proc_pidinfo(PROC_PIDCOALITIONINFO)` through
  Python's ctypes), with `spawn type = interactive`; no Background Task
  Management item; *no Dock tile, though `process.title` registers it with
  LaunchServices under that name* — wrong, read off `visibleProcessList`,
  which does not list a windowless app: a titled job on the main binary is
  `type="Foreground"` and has a tile (corrected 2026-10-12, below); open-file limits, process limits and umask
  the same as an agent's today; a pty spawned through node-pty under the job,
  on a clone of the release build, listed a folder under `~/Desktop` with no prompt; and
  an Electron launched from the job, which quit itself after three seconds,
  left no tile in `lsappinfo visibleProcessList`, with and without the title.
  Then the real code, isolated under `/tmp/k2` on 7817: a server on the
  release binary cloned the bundle (308 ms), started the host through launchd
  and recorded *through launchd, in a coalition of its own, on a copy of …*;
  the host answered `hello`, ran `sleep 30` and three `cat`s, and retitled
  itself `Kururu ptyhost - 3 agents`; `kill-ptyhosts /tmp/k2` stopped it and
  launchd left it `not running`, `runs = 1`; the next start booted out the
  stale job and swept the unused clone. A clone of the Developer-ID
  `/Applications/Kururu.app` ran fine with its entry in `/tmp` and **blocked in
  `open()` with its entry under `~/Desktop`** — the privacy prompt for an app
  that had not been allowed there, which is why `linkToHost` waits for a
  running job. Not tried: a Dock force quit of a *live* app an agent launched,
  under the new arrangement, and the real host restarted into it.
- **No Dock tiles for the runner, the server or the host** (`proctitle.ts`,
  2026-10-12). Probes first, each a titled `sleep` on a clone of the release
  build, read off `lsappinfo list`: main binary `Foreground` from a shell and
  as a launchd job; the helper `UIElement`, ad-hoc and Developer ID alike;
  plain node `BackgroundOnly`; no title, not registered at all. A helper under
  a Kururu process read a checkout under `~/Desktop` with no prompt. Then the
  isolated instance on 7817, from a scratch copy, in the dev shell with
  `KURURU_AUTOSTART`: the window `Foreground`; the runner and the server on
  `Electron Helper`, named and `UIElement`; vite on the helper and
  unregistered; the host a launchd job on a clone's main binary, unnamed and
  unregistered. The new `run.mjs` on the release build's main binary, as an
  older app starts it: the runner unnamed and unregistered, its server on
  `Kururu Helper` and `UIElement`. `hostRuntime` for a server on the helper
  cloned the server's own Kururu.app. Not seen: the Dock itself, which only
  the user's eyes report, and a packaged build with the new `runner.js`.

**Not yet proven in place:** a card raised by the *heuristic* `done` rather than
by a report, and a click on a real OS notification — neither can be driven from a
script. Nor, for the menu bar: the tray's clicks themselves (the menu is built
from tested data, but nobody has clicked it under a script), the native key hook
under a signed build (it needs Input Monitoring, which is a prompt), **Open at
login** and the no-window launch it implies, the panel floating over a
full-screen app, and a checkout chosen through the dialog rather than written
into `desktop.json`.
