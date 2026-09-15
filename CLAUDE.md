# Working in kururu

Read this before touching anything. `PLAN.md` has the *why* (design principles,
architecture, roadmap); `README.md` has usage. This file is the operational
brief: what will bite you, and what you must not break.

## What this is, in one paragraph

Kururu is a **desktop and phone GUI for coding agents, which it runs itself**.
It spawns each agent in a pty it owns, keeps a headless terminal emulator beside
it, and serves the same URL to an Electron window and to a phone over Tailscale
— where it is for **watching and steering agents, not for writing code**. It
began as a front-end for [ghosttown](../ghosttown), the agent-first multiplexer
in the sibling directory, and still borrows code from it (see below), but it is
no longer a client of it: kururu's agents and ghosttown's are two separate sets.

It is **three processes, and the window is the least important of them**. The
pty host holds every pty and outlives everything; the server holds the protocol,
the layout and the discovery, and is restarted constantly; the Electron window
finds a server and draws it, exactly as the phone does. Which means the window
is disposable in a way it used to not be — quitting it costs a window, and the
server it was looking at may not even be on this machine.

## The rules that matter most

1. **Never modify `../ghosttown` from this project.** Kururu borrows *from* it —
   `status.ts` and the agent-detection half of `procs.ts` are ports — and the
   traffic is one-way. If something there needs changing, write it down and
   raise it with the user; do not reach across and edit it.
2. **The agents are real, and they are the user's.** Kururu spawns actual agent
   processes in real ptys, in real project directories. `input` types into one,
   keystroke for keystroke. `kill-agent` signals its whole process group. There is no sandbox and no
   dry-run mode: a careless test spends the user's tokens, or ends work they
   were in the middle of.
3. **Never unmount a terminal because the *layout* changed.** Panes are a flat,
   keyed list of absolutely-positioned boxes (`Panes.tsx`), so a rearrangement is
   a change of four CSS percentages and React moves the existing DOM node. They
   were nested flex boxes once and that is exactly how this rule got broken:
   React reconciles by position, so restructuring the tree rebuilt the pane, the
   emulator inside it came back empty, and — because the *set* of visible
   terminals had not changed — nothing asked for the history to refill it.
   Dragging a pane aside made its agent vanish until it happened to repaint.

   Switching *tabs* used to be a rebuild on purpose, and that reason is gone:
   an emulator is pooled by agent id in `web/src/terminals.ts` and lives as long
   as its terminal does, so a hidden tab keeps being fed off screen and comes
   back with its screen, its scrollback and its scroll position. **Nothing in
   the client rebuilds an emulator during ordinary navigation.** A pane renders
   an empty mount and the pooled element is moved into it, which means React
   must never render that element as a child of anything — it would remove it on
   the next commit.
4. **Do not run `tailscale` commands.** Putting a port on the user's tailnet is
   their decision, never a side effect of a code change. Document the command;
   do not execute it.
5. **Do not run git commands automatically.** No commit, no push, no `git init`,
   unless the user explicitly asks. (Standing preference of this user.)

## ⚠️ The live-agent hazard

**Only the pty host holds ptys, and only restarting *it* costs anybody their
agents.** Quitting the window does not. Restarting the server does not. The
distinction is the one thing to keep straight when working in here:

| you edit | what it costs |
|---|---|
| `web/`, `desktop/` | a repaint — ⌘R, or `C-a R` (a `desktop/` change wants the window relaunched, which is free) |
| `server/src/` (not `agents/`, not `ptyhost*`, not `hostsock.ts`) | a reconnect — `C-a B`, or automatic under `bun run dev` |
| `server/src/agents/`, `ptyhostd.ts`, `ptyhost.ts`, `hostlink.ts`, `hostsock.ts` | **every agent the user is running** |

So: batch changes to the host, and say so before asking for one to be restarted.
A live pty cannot be handed to a replacement process — ghosttown's config says
the same thing about its daemon in the same words — and that irreducible fact is
now the *only* thing in kururu that ends an agent by accident.

**The trap this leaves, and it has already cost a session:** a running
`bun run dev` is watching `server/src` and `shared`, so editing those files
restarts the user's server *while you work*, without anybody asking. That is
cheap and intended. What is not cheap is editing a file the watcher hands off —
`agents/`, `ptyhost*`, `hostsock.ts` — or rebuilding the bundles underneath a
server that is mid-flight. **Check whether a server is running before you start
(`curl -s localhost:7717/api/health`), and say what you are about to disturb.**

- Teardown signals the **process group**, not the pty's own pid — see the
  invariants below. Getting this wrong leaves orphaned agents with no terminal
  attached and no way to reach them again.
- The host is **detached**, not a child of whoever spawned it. That is what makes
  it survive, and it also means `pkill -f ptyhostd` is how it stops — there is no
  parent to close.
- `bun test` only exercises pure functions and a temp directory — `procs`,
  `report`, `status`, `files`, `workspaces` (which holds a tree and touches no
  pty), `hostsock` (two ports over a socket, no pty anywhere), and the pane tree
  in `web/test`. Keep it that way; no test should spawn a real agent CLI.

When testing by hand, spawn something harmless — `create-agent` takes a
`command`, so use `sleep 30` or `cat` rather than `claude`, and spend no tokens
proving that plumbing works.

## Layout

```
shared/      Protocol types and the tree. No runtime deps; imported by everything.
  model.ts       Agents, and the hierarchy they live in. Not a mirror of anything.
  layout.ts      The split tree and every pure operation on it. Both halves use it
  keys.ts        Every action, ghosttown's default keys, and the overrides a user
                 saved. Shared because the server validates a rebinding
  wire.ts        Kururu's own browser↔server protocol + timer intervals
server/      Node (not Bun — it was Electron's once and the bundles stayed). Two
             processes, and nothing owns either of them.
  ptyhost.ts     The half that cannot be restarted: createPtyHost(), a factory
  ptyhostd.ts    ...as a daemon on a socket. Outlives every window and server
  hostlink.ts    The protocol between the two, and the local pair for tests
  hostsock.ts    That protocol over a unix socket. The framing, and nothing else
  run.mjs        Builds, spawns and re-spawns the server. What `C-a B` reaches
  status.mjs     The daemon has no face; this is it. Socket + /api/agents
  agents/        Owned by the pty host. Editing anything here costs the agents
    host.ts      Spawns and owns every pty; the snapshot comes from here
    screen.ts    One headless xterm per pty; history for a pane opened late
    status.ts    idle/working/done heuristic — PORTED from ghosttown, verbatim
    procs.ts     Which agent program is running in a pty — PORTED from ghosttown
    report.ts    Parses what an agent says about itself (blocked, context usage)
  record.ts      Rolling raw-stream tape per agent, for bugs you can't reproduce
  transcript.ts  How full a Claude Code window is, off its transcript. PORTED
  report-cli.ts  What a Claude Code hook runs to say so. Not in agents/ on purpose
  workspaces.ts  Profiles, workspaces, focus. The arrangement lives HERE, not in web/
  persist.ts     The arrangement on disk. Structure only — never respawns anything
  mascot.ts      Which sheets the badge can animate, which parts, and which one.
                 Also the import: the one endpoint that writes a file for a client
  keys.ts        The keymap a user has amended. Persistence only; the table is shared
  config.ts      ~/.config/kururu, and how the two settings files are written
  devservers.ts  lsof + ps discovery of dev servers, from both ends; stopping one
  proxy.ts       Per-dev-server reverse proxy (HTTP + WS) for phone access
  files.ts       Traversal-safe file listing/reading
  index.ts       The half that restarts freely: HTTP, WS, static, one timer
web/         React 19 + Vite. One build; the desktop is what it is shaped for.
  session.ts     Module-level store + useSyncExternalStore; the WS client.
                 Snapshots go through React; terminal output deliberately does not
  terminals.ts   Every emulator, pooled by agent id and moved between panes
                 rather than rebuilt. Twelve, LRU, never one that is on screen
  keys.ts        The prefix, and a KeyboardEvent as a string the table can be
                 looked up by. The table itself is shared/keys.ts now
  colors.ts      What a workspace colour name looks like. The web's half of it
  desktop.ts     The preload bridge, typed. Null in a browser, and that's the contract
  drop.ts        A file dropped on a terminal → the path to type. Pure; tested
  labels.ts      What to call a terminal, in the two places that have to agree
  mascot.ts      Loads a sheet once per URL and reports how big it is
  App.tsx        Draws the server's layout; owns the prefix, zen, and dialogs
  components/
    Panes.tsx      Walks the tree into nested flex boxes; tab strips; dividers
    Terminal.tsx   A box for a pooled emulator, and the file drop. Owns no
                   emulator: it borrows one on mount and hands it back
    Sidebar.tsx    Workspaces (numbered) and every agent in the profile
    Status.tsx     The status mark: a dot, or the mascot while it is working
    Settings.tsx   The cog's dialog: a tab bar, and the way out
    SettingsMascot.tsx  The ones you kept, and a run of cells dragged out of a sheet
    SettingsKeys.tsx    Every action, its keys, and a capture box to change them
    StatusBar.tsx  Where you are, and the PREFIX badge
    Dialog.tsx     Prompt / confirm / pick. While one is up, no key reaches a pty
    HelpOverlay.tsx  Printed from the keymap, so it cannot document a dead key
desktop/     Electron main + preload, and the esbuild step that bundles the server.
  main.js        Finds a server, draws it. Owns a window and nothing else
  connect.html   The one page kururu draws itself — the address picker
  servers.js     Addresses you have connected to, and what a typed one means
  preload.js     Two bridges in one file, split on `file:` — see the comment
  build.mjs      server/src → dist/{server,ptyhostd}.mjs (ESM, node-pty external)
assets/      Artwork, served at runtime. Found the way web/dist is; KURURU_ASSETS
  spritesheets/  The frog, and guide.png — which labels the animations and is
                 skipped by the picker for exactly that reason. One sheet ships;
                 anything else is imported to ~/.config/kururu/sheets
```

### What was ported from ghosttown, and why it must not drift casually

`server/src/transcript.ts` is ghosttown's `src/core/transcript.ts`, parsing
verbatim, with `Bun.file().slice()` replaced by an fd and two reads. It sits in
`server/src/` rather than beside `report.ts` in `agents/` — where it belongs by
subject — because `agents/` is the pty host's and everything in there costs the
user their agents to edit. It touches no pty; it reads a file somebody else
wrote.

`server/src/agents/status.ts` is ghosttown's `src/core/status.ts` with the
import changed. Its thresholds were tuned against real agents, and the point of
copying rather than rewriting is that a dot meaning `working` here means the
same thing there. `procs.ts` is the agent-detection slice of ghosttown's
`src/core/procs.ts`, with `Bun.spawn` swapped for `execFile`. If you improve
either, check whether the original deserves the same fix — and tell the user
rather than editing across.

## Commands

```sh
bun install            # from the ROOT. See the workspace gotcha below.
bun run dev            # the agents: builds, starts the pty host if it is not
                       # already up, serves on :7717, restarts itself on save
bun run dev:desktop    # the window. Finds a server; starts vite for itself
bun run status         # is the host up, is a server up, what are they holding
bun run start          # same as dev without the watching, plus a web build
bun run host           # the pty host in the foreground, for debugging it
bun run dev:web        # vite alone, proxying to KURURU_SERVER or 7717
bun run build          # web → web/dist, server → desktop/dist/*.mjs
bun run build:server   # esbuild only; run.mjs does this for you
bun run typecheck      # root tsconfig + web tsconfig
bun test               # pure-function tests only
```

**Two commands, not one, and that is the shape now.** `dev` is the half that
holds your agents; `dev:desktop` is a window onto it. Kill the window and the
agents carry on; kill the server and they *still* carry on, because they are in
the host below it. Only `pkill -f ptyhostd` ends them.

**Ports:** 7717 server · 5173 vite · **7800+** preview proxies (one per dev
server, allocated on demand). **Socket:** `~/.local/state/kururu/ptyhost.sock`,
with `~/.local/state/kururu/ptyhost.log` beside it — the host is a daemon now
and its log is the only place its side of a bug shows up.

## Gotchas that have already cost time

- **`bun install` strips the executable bit off node-pty's `spawn-helper`.** The
  prebuilt helper lands as `0644` and every spawn then fails with a bare
  `posix_spawnp failed` that names nothing at all. `desktop/build.mjs` chmods it
  on every build, which is why that fix lives in the build and not in a README.
- **node-pty needs no `@electron/rebuild`.** Its prebuilds are N-API, so the
  same binary loads in Node 24 (ABI 137) and Electron 44 (ABI 149). Do not add a
  rebuild step to "fix" a spawn failure — check the executable bit first.
- **Killing a pty's own pid is not enough.** `zsh -l -c "claude"` does not
  necessarily exec, so the pty's pid is the shell and the agent is its child.
  Signal the group (`process.kill(-pid, …)`); node-pty opens the pty with setsid
  so the pty leader is the group leader.
- **`EADDRINUSE` on 7717 means a stale server is still running**, usually from
  an earlier turn, and now possibly a supervisor holding one up. It is not a code
  bug. Kill both and retry:
  `pkill -f "server/run.mjs"; pkill -f "desktop/dist/server.mjs"`. The pty host is
  deliberately *not* in that list — killing it is the one thing that costs agents.
- **`EINVAL` from `listen` on a unix socket means the path is too long.** macOS
  gives `sun_path` 104 bytes and complains about nothing else, so the error names
  no limit and reads exactly like a bug in the caller. `hostsock.ts` checks the
  length and says so; the default path is nowhere near it, and a
  `KURURU_HOST_SOCK` pointing somewhere deep is how you find out.
- **macOS `/tmp` is a symlink to `/private/tmp`.** Two different strings for one
  directory. `files.ts` realpaths roots on *both* sides for this reason; do not
  "simplify" it back to a string compare.
- **`bun add --cwd <workspace>` creates a nested lockfile and `node_modules`**
  instead of hoisting. If deps go missing or duplicate, `rm -rf */node_modules
  */bun.lock node_modules bun.lock && bun install` from the root. Never commit
  `web/bun.lock` or `desktop/bun.lock`.
- **`ws` hands you a Buffer for text frames too.** The `isBinary` argument is the
  only thing that distinguishes them; relaying without it turns every HMR message
  into a binary frame the dev server ignores. Bun's WebSocket did this for us and
  the port did not.
- **TypeScript is pinned to ^5.8** everywhere. `bun add -d typescript` will pull
  v7 (the Go rewrite); keep the workspaces on one version.

## Invariants in the code

- **`files.ts`: resolve, check, realpath, check again.** The first check catches
  lexical `../`; the second catches a symlink inside the project pointing at
  `~/.ssh`. An escaping path is **refused, never clamped** — a clamped traversal
  is a bug that looks like it worked. Roots are only ever learned from places
  the server already knows (an agent's cwd, a dev server's cwd, `KURURU_ROOTS`),
  **never from a client**. Kururu is reachable from the tailnet; this is the one
  place a bug hands over something it should not.
- **`devservers.ts`: ports come from the kernel, never from the command line.**
  `npm run dev` names no port, and `vite --port 3001` lies the moment 3001 is
  taken and vite falls back to 3002. Also: the process holding the port is often
  *not* the one that names the server (`bun run dev` → `bun run serve.ts`), so
  `resolveDevCommand` walks **up** the process tree.
- **The same file also looks the other way, and the two answers differ.** From a
  listening socket *up* the tree comes the port and the process holding it
  (`node …/vite/bin/vite.js`); from a pty *down* (`findDevUnder`) comes the line
  somebody typed (`npm run dev`) and the process to interrupt. The preview wants
  the first. The workspace row's ▸/↻ wants the second — re-typing the first
  skips the build a launcher does before it execs, and interrupting it leaves
  the npm above it sitting there. The row is deliberately not derived from the
  port scan at all: a dev server that is still compiling holds no port, and the
  button would sit on ▸ for the ten seconds it takes to come up.
- **The dev buttons never type into a terminal with an agent in it.** A tab in
  two roles is a tab you act on twice by accident, and here the accident is
  expensive: `npm run dev` arriving at a waiting Claude Code is a *prompt*. So a
  terminal `procs.ts` reports an agent in is held out of the scan, and the
  remembered tab is passed over in favour of opening a new one. Everything else
  about the pair is ghosttown's, including the shape — which button you see *is*
  the status, and a workspace that has never had a dev server draws none.
- **`Workspace.dev` is written by watching, and only ever replaced.** The scan
  sees a server inside one of a workspace's terminals, so the workspace notes
  the line that started it — nothing is configured, and a server you started by
  hand an hour ago works the same as one kururu opened a tab for. Never cleared,
  because a *stopped* server is exactly when the memory is worth something. It
  goes to disk with the layout (`persist.ts`) minus the agent id, which is a
  process and therefore not the file's business: a restored profile comes back
  with empty panes, and ▸ is then the only thing left that can serve again.
- **Stopping a dev server signals its process *tree*, not its process group.**
  The one place in kururu that does not signal the group, and the exception
  proves the rule: the group here is the pty's and its leader is the shell, so
  signalling it would close the tab the restart is about to type into. A restart
  is exactly the `^C` and the re-typed line a person would do, which is why it
  needs no memory of how the tab was set up.
- **`proxy.ts`: a port per preview, never a path prefix.** Dev servers emit
  absolute URLs (`/@vite/client`, `/src/main.tsx`), so `/preview/<id>/` breaks
  on the first asset. The extra hop also rewrites `Host` to the upstream's own
  — which is why no project needs `server.allowedHosts` added to be previewable
  — and strips frame-blocking headers. It proxies with `http.request` and a
  pipe, **not `fetch`**: fetch decodes the body but forwards `content-encoding`
  untouched, which ships a decompressed body still labelled gzip.
- **`index.ts` pushes, and only times what cannot raise an event.** The server
  owns the ptys, so output is an event. The timers that survive are the ones that
  could not be events — end-of-work is *silence*, and the process table has to be
  asked — plus one that coalesces output at 16ms, because a pty mid-build emits
  thousands of writes a second and a socket should not.
- **Watched is now two sets, and only one of them is "somebody is looking".**
  `watch` carries what a client has *visible* and what it is keeping an emulator
  for (*warm*); the host is told to stream the union, because a pooled emulator
  that stops being fed is one that has to be reconstructed, which is the whole
  cost pooling removes. Bytes for a terminal that is in neither set still never
  become a message. Every pty is still *parsed* by its own emulator whether or
  not anyone is looking, because that is what makes a pane opened later able to
  show history; parsing is not rendering, and there is no renderer anywhere in
  the server.
- **`unread` is answered from both ends, and that is not redundancy.** The host
  derives it from its watched set — which now contains terminals a client is
  merely keeping warm, so the host clears the mark for exactly the terminals you
  would want it for. So `index.ts` keeps a set of its own: output arriving for a
  terminal no client has *visible* marks it, a client showing it clears it, and
  `overlay` ors the two. The host answers for what it is not streaming to this
  process (which `index.ts` cannot see at all), this side answers for what it
  is. Do **not** "finish the job" by editing `agents/host.ts`; that file costs
  the user every running agent.
- **`screen.ts` exists so a pane opened late is not empty.** It no longer renders
  anything — the browser does that. It is a headless emulator per pty, serialized
  on demand into the escape sequences that rebuild what it holds. Do not replace
  it with a ring buffer of raw bytes: trimming those to a budget cuts a sequence
  in half, and a cut sequence swallows everything after it until something
  resynchronises.
- **A backlog is asked for at a size, and only an emulator can ask.** This is the
  one that took the longest to see. A backlog is the server's screen *serialized*,
  and a serialized screen is laid out at a width: reconstruct it into a grid of
  any other one and every row longer than the target wraps, the rows below slide
  down, and the top scrolls away. The client and the server then disagree about
  where everything is — permanently, because an agent redraws differentially and
  will never resend a row it believes is already correct. It was the borked text
  on a workspace switch and the cwd sitting inside an agent's input box, and
  those were the same bug.
  So the grid travels **on** `request-backlog`, `index.ts` resizes the screen
  before serializing, and the answer names the shape it used so the emulator can
  become it before writing. `watch` deliberately produces no backlog at all: it
  is a set of ids, it cannot carry a size, and answering it meant sending a
  reconstruction before the emulator that would receive it had even been laid
  out. Watching is the tap; rebuilding is the emulator's own question, and the
  only things that ask it now are a genuinely new emulator — a terminal borrowed
  for the first time, one that was evicted from the pool and came back — or a
  reconnect. A tab switch and a workspace change ask for nothing. A pooled
  emulator that was off screen when the socket dropped is told it is `stale` and
  asks once a pane gives it a size; asking while detached would claim a grid for
  a pty nobody is looking at. `server/test/screen.test.ts`
  holds the invariant: serialize, rebuild, compare the buffers.
- **The pane's emulator must never want a GPU context, and that is why it is
  Ghostty's.** This is the one that turned the whole window black, twice, and
  the reason the renderer was replaced rather than patched. xterm.js drew on
  WebGL and `dispose()` did *not* release the context — neither the addon nor
  xterm's core ever called `loseContext` — so it stayed live until Chromium
  collected the canvas, which can be never. A page gets about sixteen, and kururu
  built a fresh emulator on every tab switch, workspace change, profile swap and
  pane rebuild, so the corpses accumulated in dozens over an afternoon. (It does
  not any more — see the pool — and that is the point: sixteen is only a budget
  you can exhaust if you are building emulators continuously, so the renderer was
  replaced to fix a symptom of the lifetime bug. The rule below still stands on
  its own.) Past
  sixteen the browser does not refuse the new context, it kills the **oldest**,
  and the oldest was never a corpse: it was the pane you had open longest. Every
  terminal you were actually watching went dark at once, for the three seconds
  the addon waited on a restore that was not coming, and came back slower on the
  DOM renderer — with nothing wrong on the server and the agents a process away,
  which is exactly why it read as inexplicable. It was survivable with an
  explicit `loseContext` before every dispose, and that fix worked; it was still
  a budget being spent to draw text. `ghostty-web` renders to a 2D canvas —
  `getContext("2d")` is the only context call in the whole bundle — so there is
  no budget to run out of and nothing to hand back. **Do not reintroduce a
  GPU-backed renderer for a pane.** The thing to keep is the property, not the
  library.
- **A black window is a symptom with several causes, so each one has to say
  which it is.** Flat `--bg` with nothing on it is what you get from a React root
  that unmounted, a renderer the OS killed, a server that never answered, and a
  sleeping display — same picture, different fixes, and
  guessing between them is what makes this class of bug expensive. Two of them
  now name themselves. `Crash` in `web/src/components/Crash.tsx` wraps the root
  so a render that throws prints the error and the component stack instead of
  drawing nothing; it deliberately does not retry, because a component that
  throws every render would spin, and the only way out offered is a reload.
  `render-process-gone` in `desktop/main.js` covers the case where there is no
  page left to report anything — the main process survives being a few megabytes
  and is then the only thing that can put words on screen. It asks before
  reloading rather than reloading itself: a fresh renderer allocated while the
  machine is still out of memory is killed too, and an automatic retry under real
  pressure is a loop.
- **When the whole machine misbehaves, kururu is usually the thing that shows
  it, not the thing doing it.** A renderer killed by macOS looks identical from
  inside the app to a bug in the app, and the tell is that it takes other
  programs with it — browser tabs going at the same moment means jetsam, not
  kururu. `/Library/Logs/DiagnosticReports/JetsamEvent-*.ips` names every process
  and its footprint at the moment of the kill, and `sysctl vm.swapusage` next to
  it says whether the machine is still in that state. Check those before
  debugging the window. Observed once already: three `../ghosttown` daemons had
  grown to 11 GB, 11 GB and 3.5 GB (roughly 200–300 MB per hour of uptime,
  swapped out, so `ps` showed them at under 100 MB of RSS and hid it) and
  saturated swap. **That is ghosttown's to fix, not kururu's — see rule 1 — and
  it has been raised with the user rather than edited across.**
- **The pty is told about a resize only once the box stops moving** (60ms in
  `terminals.ts`). The emulator follows immediately; the pty does not, because
  every resize is a SIGWINCH and every agent TUI repaints completely on one.
  Without the debounce, dragging a divider or sliding a pane repaints the program
  on every frame of it.
- **Two rebuilds can overlap, and the first to finish must not release the
  second's hold.** This is rare now that a tab switch asks for nothing — it takes
  a reconnect landing on a pane that is also being borrowed — and `awaiting` is
  deliberately still a count rather than a flag, because the cost of counting is
  nothing and the bug it prevents is bytes the client never sees again. `awaiting` in
  `index.ts` therefore counts rebuilds rather than flagging them: letting the
  earlier one lift the hold sends live output ahead of the later screen, which
  wipes it on arrival, and those bytes never come again — the client's emulator
  is then permanently missing a piece the server's copy has. The hold lifts when
  the last rebuild is done.
- **A backlog no longer has to be *painted* again, and it is worth knowing why
  it once did.** xterm repainted only the rows it believed had changed, and after
  a `reset` plus a reconstruction its idea of what changed did not cover cells
  the renderer was still holding: the buffer was right and the picture was wrong,
  and it stayed wrong exactly where the agent never writes again, because an
  agent redraws differentially and never resends a cell it believes is already
  correct. That cost a `clearTextureAtlas` and a `refresh(0, rows-1)` in the
  `write` callback. Ghostty's renderer draws the viewport from the WASM buffer on
  its own loop rather than from a record of which cells it thinks are dirty, so a
  screen replaced wholesale is simply the screen it draws next, and the call is
  gone. Symptom if that assumption is ever wrong: content from before the agent
  started, sitting inside its UI, until a window resize forces a full repaint.
- **A backlog goes to the emulator that asked for it, and to no other.** It used
  to arrive unbidden and could land before any emulator had subscribed, so
  `session.ts` held one for whatever sink appeared next. Nothing sends one
  unasked now, so the asker is always already there — and the `epoch` on the
  request comes back on the answer, because "the one that asked" has to be a fact
  rather than a hope. An emulator rebuilt while its predecessor's answer was
  still in flight must not be reset by that answer: it is a screen laid out for a
  box that no longer exists.
- **Backlog then output, in that order, per client.** A client that has just
  opened a pane clears its emulator and writes the history, so live output that
  overtakes the backlog is wiped. `index.ts` holds that terminal's output in the
  client's `awaiting` queue until the backlog has gone out. Serializing awaits
  the emulator's write queue, so the window is real.
- **A mascot has two animations and one trim.** `working` and `idle` are clips —
  a row, a run of cells, a speed. The sheet, the cell size and the trim are not
  in a clip, because they are facts about the *picture*: two clips at two cell
  sizes is not a mascot, it is two mascots. The trim especially is shared and
  measured across every frame of both, or a sitting frog and a jumping one would
  be scaled to the same badge and the sprite would change size the moment its
  agent stopped. `idle` is nullable and null is the dot. Only those two states
  animate: `blocked` and `done` are the two that *want a human*, and a still dot
  among moving neighbours is what makes them stand out.
- **An idle animation that cannot animate becomes the dot again.** Under
  `motion: never` — or `system` on a machine asking for less motion — a frozen
  idle sprite and a frozen working one are the same picture, so idle would cost
  the one distinction the badge exists to draw. The working clip keeps its frame
  either way, since frozen it is still not a dot. This is a choice of *element*,
  which is why it is in `Status.tsx` and not a media query in the stylesheet.
- **A workspace wears a mascot the way it wears a colour.** `mascotId`, nullable,
  where null means the set's `default` — so "I have not chosen" and "I chose the
  thing that is currently the default" stay different, and only the first follows
  when the default moves. Nothing validates the id: one naming a deleted mascot
  already draws the default, so a check would buy a refusal where the fallback is
  the same answer, and would make `workspaces.ts` learn about sprite sheets.
- **A mascot is a rectangle of cells, and there is a list of them.** It was one
  selection, which was right while picking one was the whole feature. It is not:
  a sheet holds six animations across eight facings, so what people do with the
  picker is find three they like — and a picker with no way to keep anything
  makes you re-find a selection you already made. So the config is a list with a
  chosen one, never empty, because an empty list means a working agent with
  nothing in its row. Which one is the *default* is server state; which one
  Settings has open for editing is not — a second window should not have its
  picker yanked because this one clicked a row. The one migration this has is a file from the version that
  held a single config: it has no `list`, and it becomes one entry rather than
  being thrown away for the default frog.
- **The keyboard is stored as the *difference* from the defaults.** A saved map
  would freeze kururu's keys at the version you first opened Settings in — an
  action added later would be unbound forever, for everybody who had ever touched
  a binding. Overrides cannot rot that way. Which is why an override may be
  `null`: "this default is off" is a thing somebody can mean, and nothing else
  could express it. `1`–`9` are refused outright, because they jump to a
  workspace by number, are not in the table to argue with, and a binding that won
  the lookup would take a workspace out of reach with nothing on screen to say
  where it went. The prefix itself is not rebindable either: it is the one chord
  that has to stay reachable to fix a keyboard you have broken.
- **The mascot is a rectangle of cells, and Settings is the only thing that
  picks it.** It was a pre-cut strip once, on the theory that a strip states its
  own frame count and so needs no manifest. True, and it put the one interesting
  decision outside the app: the sheets hold six animations across eight facings,
  so what is worth choosing was never the file but the *part*. The config is
  therefore a sheet, a grid size, a row and a run — and the trim, which is
  **computed from the pixels, never typed**, as one box across every frame in the
  run. Where a sprite sits in its cell is how a sheet draws a jump; trimming each
  frame to its own content lands them all on the floor.
- **An import is checked; a file you placed yourself is not.** The asymmetry is
  deliberate. A PNG you drop in `~/.config/kururu/sheets` is served exactly as you
  left it, and one that is not a PNG fails in the browser and falls back to the
  dot — substituting the frog would read as the feature being broken rather than
  the file being wrong, the same argument `set-workspace-color` makes. An import
  is a different act: a client asking the server to write a file into the user's
  config directory, over a socket that is on the tailnet. So it must be a real
  PNG by its magic bytes, under the size cap, under a name that is a name, and it
  refuses to overwrite rather than replacing a sheet other mascots are cut from.
- **A sheet name is a name, never a path.** It arrives from a client and picks a
  file, so `isSheetName` refuses anything with a slash or a dot in it *and*
  `sheetFile` checks it against the list — the two checks `files.ts` argues for,
  for the same reason. Every number in the config is clamped instead: a run that
  goes one cell off the edge is a drag gone too far, not an attack, and the
  nearest legal selection is the right answer. A *name* has no nearest legal
  value, so it is the one field that falls back rather than bends.
- **The mascot animates by default, whatever the system says.** `.mascot` carries
  the animation and only `motion: "system"` opts into `prefers-reduced-motion`.
  This is deliberate and was a bug first: a blanket reduced-motion rule froze the
  badge on frame one for anybody with Reduce Motion switched on in macOS, which
  is a status indicator that has stopped indicating — it says exactly what the
  dot said. A 16px sprite is in the class of a spinner, not the sliding parallax
  that preference exists to stop, so it is offered in Settings instead of obeyed
  silently.
- **A workspace colour is a name, never a CSS value.** `set-workspace-color`
  takes one of `WORKSPACE_COLORS` and the server refuses everything else,
  *leaving the old value alone* rather than clearing it — a rejected write that
  untagged the workspace would read as the feature being broken rather than as a
  refusal. What each name looks like is `web/src/colors.ts`, so the palette can
  be restyled without rewriting anybody's saved session. The check is not
  decoration: the value ends up in a style attribute, and kururu is reachable
  from the tailnet.
- **`record.ts` is for reading, never for replaying.** It keeps the last 128KB of
  one terminal's raw stream interleaved with what kururu did to it — resizes,
  watches, backlogs — because nearly every terminal bug is a disagreement about
  *ordering* and the bytes alone cannot show one. `GET /api/record?agent=<id>`,
  with `&tail=N`; a full tape is enormous, so redirect it to a file. It is
  trimmed by budget and therefore starts mid-sequence, which is the exact failure
  mode `screen.ts` exists to avoid: nothing may ever write it back to a terminal.
  It only sees *watched* terminals, since unwatched ptys are never streamed.
- **A dropped file must never reach the browser's default handler.** A page's
  answer to a dropped file is to *navigate to it*, and this page is the whole
  application — a screenshot missing a pane by ten pixels would replace kururu
  with a picture of a screenshot. `Terminal.tsx` claims file drags and types the
  path in; `App.tsx` swallows the ones that miss, in the bubble phase so the
  terminal sees them first. Both test `dataTransfer.types` for `Files` rather
  than reading the payload, because on `dragover` the payload is unreadable —
  the same restriction `drag.ts` exists to work around — and because kururu's own
  tab and pane drags carry custom MIME types and must fall straight through.
- **The sidebar lists agents; `lastAgent` is what makes that possible.** Filtering
  on `agent` alone would drop rows every time the process poll blinked, and would
  hide every *exited* agent — which reports no program, and whose row carries the
  only dismiss gesture there is. So the test is "has one ever been seen in here".
- **`AgentSnapshot.activity` is the server's, not the host's.** Everything else
  in a snapshot is a fact about a process, which only the host can answer. A
  sentence about the *work* is not: it arrives by a different road entirely
  (`POST /api/report`), it is stale the moment the turn moves on, and nothing
  depends on it surviving. Keeping it on the restartable side means the line can
  be reworded or dropped without the edit costing anybody a running agent. It is
  merged into the snapshot in `index.ts`; a server restart forgets it and the
  next report fills it in.
- **A restored profile is adopted, not trusted.** The host's blob was written by
  the *previous* server, which across a rebuild may be a previous version of it,
  so a field added since simply is not there. `adopt()` in `workspaces.ts` fills
  those in — `undefined` where the type promises `null` is invisible until
  something compares against null and gets a different answer than it did a
  restart ago.
- **`status.ts` can never produce `blocked`.** Nothing in a byte stream
  distinguishes "waiting for you" from "thinking". It arrives only via
  `POST /api/report`, and one report disables the heuristic for that agent
  permanently — a process that knows its own state beats a guess forever after.
- **An exited agent stays listed, and its screen still reflows.** That screen is
  the only record of what it said, including whatever it printed on the way out —
  and the record is handed out by being serialized at the emulator's current
  width, so a dead terminal that refused to resize would give every pane that
  opened it a screen laid out for the box it died in. `host.resize` therefore
  skips only the pty half once `exited` is set. The buffer is frozen, not
  immutable; there is simply no SIGWINCH to send about it. `kill-agent` is what
  removes it; that is the dismiss gesture. Closing a *pane* never kills anything
  — the two gestures are not undoable to the same degree, so they are not the
  same button.
- **A shell is an agent with nothing claimed about it.** Same pty, same emulator,
  same teardown; `kind` only records what was asked for. It is not counted by the
  quit dialog *unless* `procs.ts` finds an agent running inside it — err towards
  counting, since a needless dialog costs a keystroke and a missed one costs a
  turn.
- **`session.ts` reconnects forever.** The kururu server restarts on edit, and a
  phone drops the socket every time it sleeps. Disconnection is the normal case;
  render `connected`, do not throw. Note the agents survive it — they are
  processes on the other end, not a view onto somebody else's.
- **Anything that would make `ptyhost.ts` need editing belongs on the other side
  of the link.** That is the whole rule of the split. The host holds the ptys,
  the emulators, and an *opaque* blob of whatever the server last called the
  arrangement — opaque because the moment it knows what a workspace is, changing
  what a workspace is means ending somebody's agents.
- **The two halves find each other at a path, not through a parent.** The link
  was an Electron `MessagePort` handed to both children, which worked and quietly
  made Electron the only thing that could arrange the split at all: with no
  Electron there was no second process, so `index.ts` built a host *inside
  itself* and the property the seam exists for — restarting the server is free —
  silently did not hold. Every `bun run dev` had it backwards and nothing said
  so. A socket removes the matchmaker: the host listens, whoever wants it
  connects, and a restarted server connects again and is handed back the agents
  and the blob. It is also what lets the host run on a machine with no window.
- **The host is spawned detached, and that word is the feature.** A server that
  starts one is not its parent and does not take it down; that is the difference
  between "my agents die when I close the terminal" and "my agents are a thing on
  this machine". It follows that nothing *else* reaps it either, so it is stopped
  on purpose (`pkill -f ptyhostd`) and its log is a file rather than somebody's
  stdout.
- **A second connection to the host replaces the first; it is not a second
  client.** The host keeps one blob and pushes output to one place, and two
  servers sharing that would each see the other's idea of the layout arrive as
  their own. A new socket is treated as what it almost always is — the same
  server, restarted, arriving before the old one's FIN did.
- **A restart is an exit code, not a signal.** `C-a B` cannot re-fork the process
  it is running in, and the thing that *can* is whatever is supervising it. So
  the server exits 75 and `server/run.mjs` reads that as "start me again" —
  distinguishable from a crash, which is left down on purpose, because a
  supervisor that resurrects a server which cannot start is a loop that fills a
  terminal with one error forever. Unsupervised, `restart-server` says so rather
  than doing the half of it that ends the server.
- **`connect.html` is the one page kururu draws itself, and it is the exception
  that proves principle 3.** Everywhere else the window loads what the server
  serves — one build of the UI, no `file://` variant to keep in step. This is
  what is on screen when there is *no* server, and a page served by the thing you
  are looking for cannot tell you it is missing. So it stays small enough to
  never become a second UI: it picks an address and nothing else. The moment it
  can show an agent, it is one.
- **The picker's bridge and the app's bridge are split on `location.protocol`.**
  A preload is chosen when a window is built and cannot be swapped per
  navigation, so both live in `preload.js` — and the boundary is drawn where it
  can actually be trusted. The picker can point this window at any address; the
  served page must never be able to, because a served page that can call
  `connect()` is a redirect attack with none of the work. Nothing arriving over
  HTTP can make itself `file:`.
- **An address is a decision, so it goes in config, not state.** `servers.json`
  sits in `~/.config/kururu` beside the keymap on `config.ts`'s reasoning: a
  state directory wiped between versions is an inconvenience, and kururu can no
  more invent the address of your VM than it can invent your keyboard.
  `127.0.0.1:7717` is a *built-in* candidate rather than a saved one, so that "the
  local one" and "one I typed once" stay different things.
- **Discovery is polling, and there is nothing else it could be.** A server
  starting raises no event anything outside it can hear, so the picker asks every
  second and that is what makes starting one in another terminal look like the
  window noticing. It only sweeps while the picker is showing, which is what
  stops it from ever moving you off a server you are already using.
- **The window gives up on a server; `session.ts` never does, and both are
  right.** The page reconnects forever because it has to — the server restarts on
  every save and a phone drops the socket every time it sleeps, so a client that
  gave up would be wrong far more often than right. But "forever" answers *a
  gap*, not *a server that is not coming back*, and a window reconnecting into
  nothing has no way to say where it would rather be pointed. So the main process
  probes `/api/health` and falls back to the picker, and **the strike count times
  the interval is the whole design**: a `run.mjs` restart is one to three seconds
  of entirely legitimate silence, and bouncing during one would tear down every
  emulator in the window to reconnect to a server that was always coming back.
  Three strikes at three seconds is ~10s of confirmed silence — past any restart,
  prompt when it is real. Both cases are tested by hand; if you retune either
  number, retest the *negative* one, because that is the expensive direction.
- **Status asks the server, never the host, and that is not politeness.** The
  host's socket takes one server at a time and reads a second connection as a
  restarted first (see above), so a status tool that asked the host directly
  would knock the live server off its link to find out how things were going.
  `/api/agents` exists for that reason. It follows that with no server running
  there is nobody who *can* list the agents — `status.mjs` says so rather than
  inventing it, which is also the honest description of the architecture.
- **A restarted server prefers the host's blob over the disk snapshot.** The blob
  is complete and a moment old, with every tab still pointing at a live pty; the
  file is the cold-start fallback and has the processes deliberately stripped
  out. Neither is trusted blindly — a tab pointing at a terminal the host does
  not have is dropped, and an agent the host has that no layout mentions is
  placed, because otherwise it is running with nothing pointing at it.
- **The arrangement is the server's, and the client sends verbs.** `web/` draws
  the layout in the snapshot; it never holds one. A message says *split the
  focused pane*, not *here is my new tree*. That is what makes a window reload
  cost a repaint, what lets two clients agree, and what makes the layout worth
  writing to disk. Never move a layout decision back into React state.
- **A new terminal starts where the last one *is*, not where it was opened.**
  `cwdForNewTab` in `index.ts` asks the kernel for the pty's own cwd (`cwd.ts`,
  one `lsof`) and only falls back to the directory recorded at spawn. A shell is
  cd'd into a project within seconds of opening, and a tab that landed in the
  spawn directory would open in `~` all afternoon. The ladder is: the terminal
  this pane is showing, then the pane's remembered project (which is all a
  restored layout or a fresh split has), then the newest terminal anywhere in
  the workspace. This is the one thing that wants `pid` in the snapshot.
- **There is one kind of new tab, and it is a terminal.** Opening an agent was a
  second button that ran `claude` for you; it is the same pty either way, and
  `procs.ts` reports what is running in there regardless, so the distinction was
  a choice the user had to make for no difference. `PtyKind` survives because
  `countsAsAgent` reads it and the host can still be told — nothing in the UI
  says `agent` any more, and the server defaults a `new-tab` without one to
  `shell`.
- **Making a pane opens a terminal in it.** A split, a new workspace, a new
  profile and a first launch all end in `openTerminal` in `index.ts`, because an
  empty pane offering one button that opened a terminal was a choice with one
  option — a step that decided nothing. A split's terminal starts where the
  half you split *is*, which is why `openTerminal` takes the pane to read the
  cwd off separately from the pane the terminal lands in.
- **`persist.ts` restores structure, never processes.** A snapshot with four
  agent tabs in it must not launch four agents on the next start — that spends
  four context windows before anybody asked. Panes come back empty, with the cwd
  they were working in, and the terminal you open in one starts there. This is
  the exception to the rule above, and the line is that a restored pane is not a
  pane being made: nobody just asked for it.
- **An empty pane is the button.** The two ways to have one are closing a pane's
  last tab and restoring a layout, and in both there is exactly one thing it can
  do — so the pane body itself is what you click, rather than something drawn in
  the middle of it. Do not put a second action in there without a reason the
  first one does not already cover.
- **Closing a tab ends its terminal.** A tab is where a terminal lives, so this
  is not putting it away; the key is shifted (`prefix+D`) for that reason, and
  the sidebar's ✕ is the same verb. Closing a *pane* ends everything in it. What
  does *not* end anything: switching workspace or profile, which is the whole
  reason those exist.
- **A pane a drag emptied is closed; a pane you emptied on purpose is not.** A
  pane whose last tab was just dragged out is a gap, not a place — leaving it
  would mean rearranging accumulated holes. A fresh split is *deliberately*
  empty and must survive, which is why `pruneEmptied` takes the source pane of
  one move rather than sweeping the tree for empties.
- **A swap is not a move-and-split.** Two panes trading places touches two
  leaves; doing it by removing one and splitting the other rebuilds the tree
  around them and changes ratios nobody asked about. `movePaneTo` removes *then*
  splits for the same reason in reverse — that order is what stops two panes
  side by side from ending up as a split nested inside the split they were
  already in.
- **`dragstart` bubbles, and the tab strip is a drag handle with draggable
  children in it.** A tab drag reaches the strip's handler too, so the strip
  checks `event.target === event.currentTarget` before claiming the drag.
  Without it, picking up a tab puts the whole pane in flight.
- **`dataTransfer` cannot be read on `dragover`, only on `drop`.** That is why
  `web/src/drag.ts` exists: a pane has to know what is in flight to decide
  whether to light up, and the spec will not tell it until the drop has already
  happened. The payload still travels on the event — the store is only for
  deciding what to draw on the way.
- **Drop zones are drawn only while a drag is in flight.** A permanent grid of
  invisible targets over a terminal is a terminal you cannot click. They are also
  the highlight, so what lights up and what happens cannot disagree.
- **An agent is in exactly one tab.** Not zero (it would be running with nothing
  pointing at it and no way back to it) and not two. `new-tab` is what creates
  one, and it places it in the same breath.
- **The prefix is a mode, so it is always labelled.** `StatusBar` shows PREFIX
  while it is armed and stops when it times out. An unlabelled mode is what makes
  people distrust modal interfaces — and the recovery, pressing it twice to send
  it through, has to be discoverable from somewhere.
- **Nothing is subscribed until the grid is the pane's.** Now in `terminals.ts`,
  where the emulator is. An emulator built
  without `cols`/`rows` is 80x24 and stays that way until a fit lands, which cannot
  happen on the frame after a split or before the renderer has measured a
  character. A backlog is a screen serialized at a size; written into an
  80-column grid it wraps and stays wrapped, and the result is a screen the agent
  believes it already drew correctly and will never repaint. A *detached* pooled
  element is the same question with a different cause and the same right answer:
  it reports no width, the measurement is refused, and the emulator keeps the
  shape it was last drawn at. The pool gates
  on `proposeDimensions()` rather than on `fit()` throwing — fit does not throw
  when the renderer has no cell size, it quietly does nothing, so a try/catch
  cannot tell "fitted" from "skipped".
- **A measurement that is merely *small* is how the fit addon says it failed.**
  The sharp edge of the emulator swap, and it cost a freeze on the first tab
  drag. xterm's `proposeDimensions()` returned `undefined` for a box it could not
  measure, so "did it answer" *was* the whole test. Ghostty's does the same
  arithmetic and then ends it `Math.max(2, …)` by `Math.max(1, …)`, so an
  unlaid-out pane does not decline — **it answers `2x1`**, which is finite,
  positive and passes every check the old guard made. A pane is exactly that
  shape for a frame or two each time one is dragged, and believing it costs the
  lot: the emulator fits to two columns, asks for a backlog serialized at two
  columns, and tells the server a grid, which is a SIGWINCH that makes the agent
  redraw itself into it. `web/src/grid.ts` reads the clamp floor back as what it
  means — "I could not work this out" — and `web/test/grid.test.ts` holds it,
  because the refused value is a well-formed grid and an `if` with a number in it
  is what somebody simplifies away.
- **The pty follows the pane, not the other way round.** The pooled emulator
  measures its box, fits itself to it, and sends the resulting grid to the server,
  which resizes both its own emulator and the pty. Never clamp a pane to a fixed
  grid: the program inside genuinely redraws at the size of the box it is in, and
  that is the whole difference between a terminal and a picture of one.

## Keys

Prefix is **ctrl+a**, ghosttown's, in `web/src/keys.ts`. The default table is
`shared/keys.ts`, and it is ghosttown's `[keybinds]` section key for key; where
kururu has no equivalent (detach, reboot, the markdown reader) the key is left
*unbound* rather than reused: a key that does something different in the sibling
app is worse than one that does nothing. Press it twice to send `\x01` through.

The ⌘ shortcuts (⌘D ⇧⌘D ⌘T ⇧⌘W ⌘[ ⌘]) are a second door onto the same action
table in `App.tsx`, not a second implementation. ⌘W and ⌘R stay Electron's.
`A` and ⇧⌘T were "new agent tab" and are now unbound: every terminal is the same
thing, and the one that used to mean something else is left alone. `g` opens
Settings — a key ghosttown leaves unbound, which is the same licence `]` and `[`
were added under.

The table is the **default**, not the keymap: `shared/keys.ts` holds it,
`~/.config/kururu/keys.json` holds what a user changed, and the two are merged
per window out of the snapshot. Anything that prints a key reads the merged map
— the help overlay inverts it rather than keeping a list beside it, because a
list beside it starts lying the first time somebody moves a key.

## Code style

Match ghosttown — the user writes in a distinctive register and kururu follows it:

- **Module-level doc comments that explain *why the module exists*,** not what
  it does. Look at `server/src/proxy.ts` or `agents/screen.ts` for the target.
- **Comments explain decisions and rejected alternatives,** in prose. "Ports
  come from the kernel because `vite --port` lies when the port is taken" — not
  "// get port".
- Prose, not bullet-fragments, inside comments. Full sentences.
- No comment that restates the code on the next line.
- TypeScript strict, `noUncheckedIndexedAccess` on. Tests cover pure functions.

## State of play

Verified end to end: agent host (spawn / type / kill / exit, process-group
teardown), status heuristic through a real pty, the report endpoint, dev-server
discovery, preview proxy including HMR websockets with subprotocol negotiation,
and traversal-safe file browsing.

And the three-process split, against a real pty: the server spawns a detached
host when none is listening and links to it over the socket; input and output
round-trip through the JSON framing with their escape sequences intact; the
server is killed and started again and the agent comes back with **the same id
and the same pid**, which is the whole point; `C-a B` does the same thing
through `run.mjs` and the host's pid never moves; a host killed with SIGKILL
leaves a socket file that the next server recognises as a corpse and clears; and
a host sent SIGTERM reaps its ptys and unlinks. The desktop was left sitting on
the picker with nothing reachable, a server was started in another terminal, and
the window found it and connected within the second — which is the feature, and
it is also the end-to-end test of it.

Also verified against a real pty, over the wire: a shell spawns interactive and
echoes, a resize reaches the pty (`stty size` agrees), unwatched terminals stop
streaming, history survives being unwatched and replays on re-watch, and
`liveAgents` counts an agent but not a bare shell.

And the hierarchy, end to end: tabs stack in a pane and reorder, a split inherits
its parent's project, `focus-dir` crosses splits and stops at the edge, workspaces
create / jump by number / toggle back, a new profile is empty while the one you
left still counts its live terminals, closing a tab ends it, deleting a workspace
ends what is in it, and a restart brings back the workspace names, the splits and
each pane's cwd with **nothing respawned**.

Dragging, likewise, at both scales. A tab reorders along its strip, crosses into
another pane at the position it was dropped, splits a pane when dropped on one of
its edges (on the side it was dropped on), moves to another workspace and back,
and prunes the pane it emptied — while a deliberately empty pane stays put. A
whole pane swaps places with another without deepening the tree, moves to an edge
of one (collapsing the split it left), and merges its tabs into one. Dropping a
pane on itself does nothing, and nothing being dragged is ever ended.

The desktop UI is a multiplexer: profiles → workspaces → tiled panes → tabs, all
of it server-owned and written to `~/.local/state/kururu/session.json`, driven by
a ctrl+a prefix. A workspace row carries ghosttown's dev-server pair: ▸ to run
what it last had serving, ↻ to restart it, verified end to end against a real
`npm run dev` — detected, remembered with its directory, restarted in the same
tab, and brought back in a fresh one after the tab was closed and after a cold
start with nothing running at all. The preview and the file tree are still out
of the window — `proxy.ts` and `files.ts` run server-side with nothing pointing
at them, which is where PLAN.md's next item starts.

Next, in order — details in `PLAN.md`:

1. The preview as a pane type, so the proxy has something pointing at it again
2. Syntax highlighting (Shiki, **server-side**, so the phone gets markup)
3. Markdown + image rendering — *the original reason this project exists*
4. Transcripts as chat — also how the phone stops being a desktop layout
5. Push notifications to the phone
6. The element picker injected by the proxy — long-press an element, send the
   selector and source location to the agent

Attributing dev servers to the terminal running them is done — `findDevServers`
walks down from the pty pids kururu holds — but only one way round: the
machine-wide port scan still says nothing about who owns a listener, so a
preview cannot yet name the workspace it belongs to.
