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
   Switching *tabs* is a rebuild on purpose: a hidden tab is not watched, so its
   emulator would be stale, and every live terminal holds a WebGL context of
   which a page gets about sixteen.
4. **Do not run `tailscale` commands.** Putting a port on the user's tailnet is
   their decision, never a side effect of a code change. Document the command;
   do not execute it.
5. **Do not run git commands automatically.** No commit, no push, no `git init`,
   unless the user explicitly asks. (Standing preference of this user.)

## ⚠️ The live-agent hazard

**Quitting the app kills every agent it is running. Restarting the *server* does
not** — the ptys live one process over, in the pty host. The distinction is the
one thing to keep straight when working in here:

| you edit | what it costs |
|---|---|
| `web/` | a repaint — ⌘R, or `C-a R` |
| `server/src/` (not `agents/`, not `ptyhost*`) | a reconnect — `C-a B`, or automatic under `KURURU_DEV=1` |
| `server/src/agents/`, `ptyhost.ts`, `hostlink.ts` | **every agent the user is running** |

So: batch changes to the host, and say so before asking for a relaunch. This is the deliberate
consequence of kururu owning its ptys instead of borrowing somebody else's, and
it is the sharpest edge in the project.

- `before-quit` in `desktop/main.js` asks first, but only when something is
  actually running. Do not "simplify" that dialog away.
- **Closing the window is not quitting.** `window-all-closed` declines to quit
  on macOS on purpose: it is what lets you shut the window while agents keep
  working and the phone stays served. Removing that guard would make closing a
  window destructive.
- Teardown signals the **process group**, not the pty's own pid — see the
  invariants below. Getting this wrong leaves orphaned agents with no terminal
  attached and no way to reach them again.
- `bun test` only exercises pure functions and a temp directory — `procs`,
  `report`, `status`, `files`, `workspaces` (which holds a tree and touches no
  pty), and the pane tree in `web/test`. Keep it that way; no test should spawn a
  real agent CLI.

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
server/      Node (not Bun — it loads inside Electron). Two processes, not one.
  ptyhost.ts     The half that cannot be restarted: createPtyHost(), a factory
  ptyhost-main.ts  ...as a process. The Electron entry; wiring only
  hostlink.ts    The protocol between the two, and the local pair for standalone
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
    Terminal.tsx   One xterm per visible tab. Fits itself, then resizes the pty
    Sidebar.tsx    Workspaces (numbered) and every agent in the profile
    Status.tsx     The status mark: a dot, or the mascot while it is working
    Settings.tsx   The cog's dialog: a tab bar, and the way out
    SettingsMascot.tsx  The ones you kept, and a run of cells dragged out of a sheet
    SettingsKeys.tsx    Every action, its keys, and a capture box to change them
    StatusBar.tsx  Where you are, and the PREFIX badge
    Dialog.tsx     Prompt / confirm / pick. While one is up, no key reaches a pty
    HelpOverlay.tsx  Printed from the keymap, so it cannot document a dead key
desktop/     Electron main + preload, and the esbuild step that bundles the server.
  main.js        Forks the server as a utilityProcess, owns the quit dialog
  build.mjs      server/src → dist/server.mjs (ESM, node-pty external)
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
bun run dev:desktop    # the whole app: server + vite + window, one command
bun run dev            # just the server on :7717 (build:server first)
bun run dev:web        # vite on :5173, proxying /api and /ws to 7717
bun run start          # build everything, then serve it on :7717
bun run build          # web → web/dist, server → desktop/dist/server.mjs
bun run build:server   # esbuild only; dev:desktop runs this for you
bun run typecheck      # root tsconfig + web tsconfig
bun test               # pure-function tests only
```

**Ports:** 7717 server · 5173 vite · **7800+** preview proxies (one per dev
server, allocated on demand).

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
  an earlier turn. It is not a code bug. Kill it and retry:
  `pkill -f "desktop/dist/server.mjs"`.
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
- **Only watched terminals are streamed.** Bytes for a terminal nobody has open
  never become a message. Note what changed: every pty is still *parsed* by its
  own emulator whether or not anyone is looking, because that is what makes a
  pane opened later able to show history. Parsing is not rendering; there is no
  renderer anywhere in the server.
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
  out. Watching is the tap; rebuilding is the emulator's own question, and only a
  fresh pane, a tab switch or a reconnect asks it. `server/test/screen.test.ts`
  holds the invariant: serialize, rebuild, compare the buffers.
- **A disposed emulator must hand its WebGL context back, out loud.** This is
  the one that turned the whole window black, twice. `terminal.dispose()` does
  *not* release the context: neither the addon nor xterm's core ever calls
  `loseContext`, so it stays live until Chromium collects the canvas, which can
  be never. A page gets about sixteen — and kururu builds a fresh emulator on
  every tab switch, workspace change, profile swap and pane rebuild, so the
  corpses accumulate in dozens over an afternoon. Past sixteen the browser does
  not refuse the new context, it kills the **oldest**, and the oldest is not a
  corpse: it is the pane you have had open longest. So the terminals that go
  dark are precisely the ones you were watching, all of them within a few tab
  switches of each other, for the three seconds the addon waits on a restore
  that is not coming — and they come back on the DOM renderer, slower than they
  left. Nothing is wrong with the server or the agents while this happens, which
  is exactly why it reads as inexplicable. `releaseWebglContexts` in
  `Terminal.tsx` runs **before** `terminal.dispose()`, because dispose is what
  takes the canvas out of the DOM and the addon exposes no handle on it.
  Measured: four live panes and eighteen rebuilds blacked out all four; with the
  release, a hundred rebuilds cost nothing.
- **A black window is a symptom with several causes, so each one has to say
  which it is.** Flat `--bg` with nothing on it is what you get from a lost GL
  context, a React root that unmounted, a renderer the OS killed, a server that
  never answered, and a sleeping display — same picture, different fixes, and
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
  `Terminal.tsx`). The emulator follows immediately; the pty does not, because
  every resize is a SIGWINCH and every agent TUI repaints completely on one.
  Without the debounce, dragging a divider or sliding a pane repaints the program
  on every frame of it.
- **Two rebuilds can overlap, and the first to finish must not release the
  second's hold.** Flick between two tabs fast enough and the second emulator
  asks before the first one's answer has been serialized. `awaiting` in
  `index.ts` therefore counts rebuilds rather than flagging them: letting the
  earlier one lift the hold sends live output ahead of the later screen, which
  wipes it on arrival, and those bytes never come again — the client's emulator
  is then permanently missing a piece the server's copy has. The hold lifts when
  the last rebuild is done.
- **A backlog has to be *painted* again, not just written.** xterm repaints the
  rows it knows changed, and after a `reset` plus a reconstruction its idea of
  what changed does not cover cells the renderer is still holding. The buffer is
  then right and the picture is wrong — and it stays wrong exactly where the
  agent never writes again, because an agent redraws differentially and will
  never resend a cell it believes is already correct. `Terminal.tsx` clears the
  WebGL texture atlas and calls `refresh(0, rows-1)` in the `write` callback,
  once the data has actually been parsed. Symptom when this is missing: content
  from before the agent started, sitting inside its UI, until a window resize
  forces a full repaint.
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
- **Nothing is subscribed until the grid is the pane's.** An xterm built without
  `cols`/`rows` is 80x24 and stays that way until a fit lands, which cannot
  happen on the frame after a split or before the renderer has measured a
  character. A backlog is a screen serialized at a size; written into an
  80-column grid it wraps and stays wrapped, and the result is a screen the agent
  believes it already drew correctly and will never repaint. `Terminal.tsx` gates
  on `proposeDimensions()` rather than on `fit()` throwing — fit does not throw
  when the renderer has no cell size, it quietly does nothing, so a try/catch
  cannot tell "fitted" from "skipped".
- **The pty follows the pane, not the other way round.** `Terminal.tsx` measures
  its box, fits the emulator to it, and sends the resulting grid to the server,
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
traversal-safe file browsing, and the Electron app bringing up server + vite +
window from one command.

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
