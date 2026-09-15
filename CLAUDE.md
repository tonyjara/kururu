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
- The host is **detached**, not a child of whoever spawned it. Its parent is pid
  1, it is its own process group and it has no controlling terminal, which is
  what makes it survive — and it also means it has to be stopped on purpose,
  because there is no parent to close. There is a command for it:

  ```sh
  bun run kill-ptyhosts          # lists them, asks, SIGTERMs — see server/kill-hosts.mjs
  bun run kill-ptyhosts --list   # what it would end, without ending it
  bun run kill-ptyhosts /tmp/k2  # only the scratch instance, not your work
  ```

  It finds hosts **by their socket, not by their name**, and so should you if you
  are doing it by hand (`kill $(lsof -t ~/.local/state/kururu/ptyhost.sock)`).
  `pkill -f ptyhostd` is the obvious command and it is **not reliable here**:
  macOS `pgrep -f` was observed matching two scratch hosts while consistently
  skipping the real one, with `ps -ww` showing an identical command line for all
  three. A `pkill` that silently matches nothing reads exactly like a host that
  restarted and did not pick up your change. The socket has one holder by
  construction (a second connection replaces the first), so asking it who is
  listening cannot match the wrong process. Note the script never *connects* to
  a host to find out what it is holding — that would knock the live server off
  its link — so the terminal count it prints is counted from the outside, as the
  host's own children.
- `bun test` only exercises pure functions and a temp directory — `procs`,
  `report`, `status`, `files`, `workspaces` (which holds a tree and touches no
  pty), `sizing` (a fold over some numbers, which is the whole size policy),
  `hostsock` (two ports over a socket, no pty anywhere), and the pane tree in
  `web/test`. Keep it that way; no test should spawn a real agent CLI.

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
  theme.ts       Every theme, both halves of each — the chrome's tokens and the
                 emulator's ANSI palette. Shared because both sides draw from it
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
  identity.ts    Which accounts a profile's terminals open as: three env vars,
                 the CLIs asked who that turned out to be and what there is to
                 pick from, and the five lines of gh config a choice is stored as
  appearance.ts  The theme id and the terminal's type. Persistence only, likewise
  config.ts      ~/.config/kururu, and how the three settings files are written
  devservers.ts  lsof + ps discovery of dev servers, from both ends; stopping one
  proxy.ts       Per-dev-server reverse proxy (HTTP + WS) for phone access
  files.ts       Traversal-safe file listing/reading
  sizing.ts      How big a terminal is when several panes have an opinion. tmux's
                 `smallest`, pure, so the one decision in it can be tested
  index.ts       The half that restarts freely: HTTP, WS, static, one timer
web/         React 19 + Vite. One build; the desktop is what it is shaped for.
  session.ts     Module-level store + useSyncExternalStore; the WS client.
                 Snapshots go through React; terminal output deliberately does not
  terminals.ts   Every emulator, pooled by agent id and moved between panes
                 rather than rebuilt. Twelve, LRU, never one that is on screen.
                 Measures its box and proposes a grid; never resizes itself
  keys.ts        The prefix, and a KeyboardEvent as a string the table can be
                 looked up by. The table itself is shared/keys.ts now
  colors.ts      What a workspace colour name looks like — now a lookup into the
                 theme, since a palette picked against one chrome is wrong on another
  theme.ts       Writes the theme's tokens onto <html> and hands the other half
                 to the emulators. One loop and a setProperty; no React anywhere
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
    SettingsProfiles.tsx  The profiles — switch, rename, delete — and the paths
                   that say which Claude and which github account each opens with
    SettingsMascot.tsx  The ones you kept, and a run of cells dragged out of a sheet
    SettingsKeys.tsx    Every action, its keys, and a capture box to change them
    SettingsAppearance.tsx  The theme list, drawn in the themes, and the terminal's
                   font and cursor. The tab Settings opens on
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
bun run kill-ptyhosts  # THE destructive one: ends every agent. --list to dry-run
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
the host below it. Only `bun run kill-ptyhosts` ends them — which asks first,
and which finds the host by its socket rather than by its name, for the reason
in the hazard section above.

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
- **A serialized screen does not carry the cursor's *visibility*, and it has to
  be told to.** A pane applies a backlog by resetting its emulator and writing
  it, and ghostty-web's `reset()` frees the WASM terminal and builds a new one —
  so every mode goes back to its default and the cursor comes back visible. The
  serializer restores eight modes and DECTCEM is not among them, so nothing in
  the screen says otherwise, while the cursor's *position* is restored
  faithfully. An agent that hides the real cursor and paints its own block in an
  input box parks the hidden one at home, so every newly-opened pane came up
  with a blinking cursor in its top-left corner and kept it: the sequence is
  sent once at startup and never mentioned again. `screen.ts` appends
  `\x1b[?25l` when `isCursorHidden`, and `server/test/screen.test.ts` holds both
  halves of it. Worth knowing that this read as a *focus* bug for a while — it
  is only ever visible in the focused pane, because the unfocused ones draw no
  cursor at all.
- **A backlog is asked for at a size, and only an emulator can ask.** This is the
  one that took the longest to see. A backlog is the server's screen *serialized*,
  and a serialized screen is laid out at a width: reconstruct it into a grid of
  any other one and every row longer than the target wraps, the rows below slide
  down, and the top scrolls away. The client and the server then disagree about
  where everything is — permanently, because an agent redraws differentially and
  will never resend a row it believes is already correct. It was the borked text
  on a workspace switch and the cwd sitting inside an agent's input box, and
  those were the same bug.
  The grid used to travel **on** `request-backlog`, because the asking pane was
  the only thing that knew it. It does not now — the server owns the size (see
  below) and serializes at the one it already decided — but the *answer* still
  names the shape it used, and that is deliberate: a screen that states its own
  shape is correct for whoever receives it, and it covers the one ordering a
  single authoritative size does not, which is a resize landing while a screen
  is being built. `sendBacklog` then sends a second `grid` behind it.
  `watch` deliberately produces no backlog at all: it is a set of ids, and
  answering it meant sending a reconstruction before the emulator that would
  receive it had even been laid out. Watching is the tap; rebuilding is the
  emulator's own question, and the only things that ask it are a genuinely new
  emulator — a terminal borrowed for the first time, one that was evicted from
  the pool and came back — or a reconnect. A tab switch and a workspace change
  ask for nothing. A pooled emulator that was off screen when the socket dropped
  is told it is `stale` and asks once a pane gives it a box to measure; asking
  while detached would propose a grid for a pty nobody is looking at.
  `server/test/screen.test.ts` holds the invariant: serialize, rebuild, compare
  the buffers.
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
- **A size is proposed only once the box stops moving** (60ms in `terminals.ts`).
  Nothing follows immediately any more — the emulator does not resize itself
  either — because the proposal ends at the pty, every resize there is a
  SIGWINCH, and every agent TUI repaints completely on one. Without the
  debounce, dragging a divider or sliding a pane repaints the program on every
  frame of it. The two cases that skip the debounce are a pane *arriving* rather
  than moving: a first subscription and a reconnect, both of which propose at
  once because the history they are about to ask for is laid out in whatever the
  server settles on.
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
  `write` callback. Ghostty's renderer needs no equivalent, and the reason is
  narrower than this file used to claim — it said the renderer draws the viewport
  from the WASM buffer rather than from a record of what is dirty, and **that is
  not true**. `startRenderLoop` calls `render(buffer, forceAll = false, …)` and
  redraws only the rows the buffer reports dirty, plus the cursor's row. What
  saves the backlog is that replacing a whole screen dirties the whole screen, so
  the ordinary path happens to be a full repaint; `forceAll` is passed only by
  `open`, `resize` and a font change. Symptom if *that* is ever wrong: content
  from before the agent started, sitting inside its UI, until a window resize
  forces a full repaint. Anything that changes how the screen *looks* without
  writing to it — a palette swap is the one that exists — has to force the
  repaint itself, because nothing marks a row dirty for it.
- **A backlog is self-describing, which is what replaced matching it to a
  particular asker.** It used to arrive unbidden and could land before any
  emulator had subscribed, so `session.ts` held one for whatever sink appeared
  next; then it was matched by an `epoch` the request carried, because two panes
  of two widths asked two different questions about one terminal and each had to
  be answered without wrecking the other. Both are gone. There is one shape now
  and the server owns it, so there is one answer — and an answer that names the
  grid it was laid out at is correct for whoever receives it, which is why
  `reset` applies the size it was given rather than assuming it already matches.
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
- **There is one palette, and a theme names both halves of it.** It was two,
  kept in step by hand: the chrome in `styles.css`, the emulator's in a `THEME`
  constant in `terminals.ts`, because ghostty paints into a canvas CSS cannot
  reach. That was a fair price for one hand-sync and an unpayable one per theme,
  so a `Theme` in `shared/theme.ts` holds the chrome tokens, the sixteen ANSI
  slots, and the eight workspace tags together. `web/src/theme.ts` writes the
  first onto `<html>` as custom properties and hands the second to every pooled
  emulator. **Never write a hex into `styles.css` or a component.** A rule that
  names a colour is a rule that stays one colour while the window changes around
  it — `web/test/theme.test.ts` fails on one, and also fails if a token the CSS
  asks for is one no theme answers, because that seam is held together by a
  string on both sides and drifting it is invisible in the default theme.
- **A theme is picked, not edited, and what is stored is its id.** Same argument
  `keys.ts` makes about storing the difference from the defaults: a saved palette
  would freeze kururu's tokens at the version you first opened Settings in, and a
  token added later would be unset forever for everybody who had ever chosen. So
  `appearance.json` holds an id, `themeFor` falls back rather than refusing (a
  name from a downgrade draws the default, which is the same answer a check would
  have bought), and a flavour restyled later restyles everywhere.
- **Changing the theme must never resize a pty.** Colours do not move the cell,
  so `applyTerminalAppearance` re-measures only when the *font* moved — a
  proposal is a SIGWINCH into every agent watching, and paying that to go from
  Mocha to Macchiato would make choosing a colour scheme repaint everybody's
  work. A font change *does* re-measure, and goes through the same 60ms settle a
  dragged divider does, for the same reason: a slider is dragged.
- **Restyle an emulator; never rebuild one to restyle it.** The renderer's theme
  is set directly (`renderer.setTheme`) rather than through `options.theme`,
  which warns it is unsupported and is half right: the palette also went to the
  WASM terminal at construction and nothing updates it there. That half only
  answers colour *queries*, and it is right again the moment the emulator is
  rebuilt; the renderer's copy is what every cell is actually drawn from, and it
  repaints on the next animation frame with nothing to force. Rebuilding instead
  would cost every visible terminal a backlog and every warm one its scrollback,
  which is the whole thing the pool exists to prevent.
- **The font setting is prepended to the built-in stack, never a replacement.**
  That stack ends in four patched Nerd Font faces so an agent TUI's devicons are
  not tofu, and somebody naming a font has said nothing about wanting those to
  stop working. It does move the grid metrics, because the cell is measured from
  the first face — which is exactly what choosing a font means, and the reason
  the patched faces are appended in the first place.
- **Only the focused pane draws a cursor, and kururu has to arrange that
  itself.** ghostty-web has no concept of focus: `renderCursor` fills a rectangle
  whenever the viewport is at the bottom and the terminal's own cursor mode says
  visible, and nothing asks whether anybody is typing into it. Tiled, that is a
  solid blinking block in every pane at once — and a terminal sitting at its home
  position draws it in the top-left corner, which is how it was noticed. A real
  terminal draws a hollow box unfocused; this renderer has no outline path, so
  the choice is solid or nothing, and nothing is right because `pane-on` already
  says where the keyboard is going. `setFocused` gives an unfocused emulator a
  cursor style the renderer does not recognise, whose switch has no default case
  and therefore draws nothing. Do **not** "fix" this by tinting the cursor to the
  background instead: `renderCursor` paints over the glyph and never redraws it
  in `cursorAccent`, so that is an erased character rather than a hidden cursor.
- **A profile's identity is a pointer, never a secret.** Tying a Claude account
  and a github account to a profile turns out to be three environment variables
  — `CLAUDE_CONFIG_DIR`, which scopes a Claude Code login *completely* (a
  directory that has not been logged in to comes up logged out, so two of them
  are two accounts signed in at once rather than a switch with global state),
  `GH_CONFIG_DIR`, which only names which of the accounts already in gh's keyring
  is active, and `GIT_CONFIG_GLOBAL`. So `ProfileIdentity` is three paths. It is
  three paths and not a free-form env map for a reason that is the same one
  `files.ts` argues from: a profile travels in every snapshot and is written to
  `session.json`, and kururu is reachable from the tailnet, so a map somebody
  could put `ANTHROPIC_API_KEY` into would be a credential store every client can
  read and that lands in plain text on disk. A path is not a secret; the secrets
  stay in the login keychain and in files the OS is already protecting. A profile
  that needs a key names an `apiKeyHelper` in the settings file the first path
  points at, and kururu never learns it.
  Null means the machine's default rather than the default *path*, on `mascotId`'s
  reasoning. A path that is not absolute is **refused, not resolved** — a relative
  one would resolve against whatever directory each terminal opened in, which is
  the bug the feature exists to prevent arriving through the feature itself, and
  unlike a run of cells a path has no nearest legal value.
- **The identity reaches a pty at spawn and at no other time.** Which makes
  changing it a statement about the *next* terminal, not about the five already
  running — the same way `Workspace.dev` is a memory of a command rather than a
  command. The overlay is built in `index.ts` from the **active** profile, never
  from anything a client sends: every gesture that ends in a spawn is one
  somebody just made in the profile they are looking at, and a client that could
  name its own environment is a client that could name any environment. The host
  takes it as an opaque map and merges it *under* `KURURU_AGENT_ID`, so nothing
  nameable from outside can take the hook's own variable away from it. This is
  the whole reason `agents/host.ts` had to be touched at all, and it is the one
  place the host learns anything new about a spawn — it is told a map, never a
  profile, for the same reason it holds the arrangement as a blob it cannot read.
- **A workspace may borrow another profile's accounts, and what it stores is a
  pointer.** A profile is one set of accounts and a workspace is one piece of
  work, and those disagree the afternoon a repository of your own turns up in
  your work profile. The alternative was a second profile holding a copy of the
  workspace, and a copy is where the two start diverging: same project, same dev
  server, same colour, different window. So `Workspace.identityProfileId` names
  a *profile*, never three paths — an identity has one home and this points at
  it, so an account re-pointed in Settings follows every workspace borrowing it.
  Null means the profile the workspace lives in, on `mascotId`'s reasoning, and
  an id naming a deleted profile reads as null because `identityForWorkspace`
  already falls back to exactly that. It is why `spawnEnv` takes a workspace:
  every other gesture spawns where you are standing, but ▸ on a workspace row
  deliberately starts a dev server somewhere you are not looking, and it has to
  start it as *that* workspace's accounts. On disk the pointer is an **index**
  into the stored profile list (`persist.ts`), the trick `activeWorkspace`
  already uses: profile ids are regenerated on the way back in, so an id written
  there would name nothing by the time it was read. It changes the next terminal
  in the workspace and none of the ones already running in it — and note the
  sign-in flows are unaffected by a borrowing workspace precisely because both
  lines name their own environment, which is the invariant above earning itself
  a second time.
- **What is picked is an account; a directory is how the choice is stored.**
  Nobody thinks "my work profile uses `~/.config/gh/work`" — they think "my work
  profile is that github user". So Settings offers the accounts the tools already
  know about and a path appears only in the line underneath and behind `Custom…`,
  which exists for an arrangement kururu did not make and should not stand in the
  way of. The two lists are built differently and the asymmetry is the tools':
  gh holds several accounts in one keyring and a config directory only says which
  is *active*, so an account has a name before any directory exists — which is
  why gh directories are named after the **account** (`identities/gh/<login>`),
  shared by every profile that picks it, and written by the server rather than
  named by a client. A Claude account *is* its config directory and has no name
  until somebody has signed in to one, so those are named after the **profile**
  (`identities/claude/<slug>`) and labelled with whatever email is found in them.
  `ensureGhConfig` writes that file once and never again: gh rewrites it itself
  on every login and logout inside one of those terminals, and a file kururu
  regenerated would throw away what gh had just recorded. Nothing it writes is a
  secret — the file names an account and the keyring answers for it, which is the
  whole reason a pointer is enough. And `slug()` trims leading dots as well as
  dashes, because a profile called `..` is a name a client typed that would
  otherwise build a path one directory up.
- **Signing in is a terminal, not a dialog.** Both flows are a browser, a code to
  paste and a few questions; the only thing a wrapper could add is somewhere for
  them to go wrong quietly. So `sign-in` does the setup and then does what the
  dev-server button does — opens a tab and types the line a person would type —
  in the profile it is about, switched to first, so the prompt is on screen
  rather than in a pane somewhere else. A **new** tab, never a live one, for the
  reason the dev buttons have the same rule: a command typed at a waiting agent
  is a prompt. The two tools want opposite things here and each half is load
  bearing. Claude: the profile gets a directory of its own *before* anything is
  typed, because signing in with nothing set would put the new account in
  `~/.claude` and replace the one the machine had. Github: the login belongs in
  gh's own config, where it is registered once and becomes pickable from every
  profile — hence `env -u GH_CONFIG_DIR`, undoing this profile's override for the
  length of one command rather than adding a second account to a directory named
  after the first.
  **Both lines name their own environment instead of relying on the pty's, and
  that is not belt and braces — it is the one place this feature meets the
  restart rule.** The overlay is applied by the pty host, the one process that
  does not pick up an edit when you save it, so every change to this feature
  opens a window where the server sends an `env` the running host is too old to
  understand and silently drops. A terminal that opens as the wrong account is a
  bad afternoon; a *login* that goes to the wrong directory replaces an account
  somebody had. It cost exactly that once — the profile's directory left empty,
  `~/.claude` written instead, and Settings correctly reporting "not signed in"
  for a profile the user had just signed in from. A command that states its own
  target works on any host, and being on screen it says where it is going while
  it goes there. `shellQuote` is there because that target is a path somebody
  named and the line is typed at a live shell.
- **Who a profile *is* is fetched, not pushed.** Everything else Settings edits is
  kururu's own state and arrives in the snapshot. This is the world's: it changes
  when somebody runs `claude auth login` inside a terminal the server is only
  watching, and answering it means running three CLIs. So `/api/identity` is
  asked by the one page that draws it, at the moment it draws it, and the answer
  is cached by the *environment* rather than by the profile — two profiles pointed
  at one directory are one account and should not be two lookups. Asking is not
  quite free of consequence and it is worth knowing which way: `claude auth
  status` creates the config directory it is pointed at. That is the directory the
  person just named and where their login is about to go, and the alternative —
  refusing to describe a path until something else has created it — leaves a new
  profile blank for no reason anybody could see.
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
- **`ptyhost.ts`'s relay forwards the request whole, and never names its
  fields.** `case "create"` spreads everything but `type` and `id` into
  `host.create`. It used to list them — `{ cwd, command, kind }` — and that cost
  a restart nobody had budgeted for: `env` was added to `ToHost`, to
  `HostLink.create` and to `AgentHost.create`, and dropped at this one line
  between them. Nothing complained, because passing fewer properties than an
  optional parameter accepts is perfectly good TypeScript, and the symptom was
  three rooms away — a profile whose terminals kept opening as the wrong account,
  with correct code on both sides of the gap. The general shape is worth
  remembering whenever this feature is extended: a change to what a pty is
  spawned with touches **four** files (`shared/wire.ts` or `hostlink.ts` for the
  type, `index.ts` to send it, `ptyhost.ts` to relay it, `agents/host.ts` to use
  it), three of them cost the agents, and only the last two look like they
  matter. Do not reintroduce an enumeration here to "be explicit".
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
  this machine". It follows that nothing *else* reaps it either — closing the
  terminal `bun run dev` is running in does not, because Ctrl-C signals that
  terminal's foreground process group and the host left that group the moment it
  was spawned. So it is stopped on purpose and by the socket rather than by name
  (`bun run kill-ptyhosts`), and its log is a file rather than somebody's
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
- **Switching a profile is a menu; editing one is a page.** This has been all
  three things a switcher can be, and the split it landed on is the one worth
  keeping. It was a pick dialog, which was right while a profile was a name over
  a list of workspaces. Then a profile grew an identity, which is a form, and a
  dialog that picks beside a page that edits is two places that immediately start
  disagreeing about what a profile is — so all of it moved to Settings →
  Profiles. **That overcorrected, and the tell was a "Switch to" button on every
  row.** Switching never stopped being *navigation*: it is done ten times an
  afternoon, and routing it through a modal meant opening a dialog, reading a
  list and clicking twice to move between two rooms — leaving the dialog standing
  over a window that had changed behind it.
  So the sidebar's profile name opens a menu (every profile, what each has
  running, then "New profile…" and "Profile settings…"), `switch-profile`
  (prefix+s) opens the same menu by measuring that button rather than guessing a
  corner, and **Settings does not switch at all** — it marks the current profile
  and otherwise edits. Each is the shape of its own job and neither duplicates
  the other. Which is also why `Settings` takes the tab to open on: where it
  opens is the caller's to say, where it goes next is not.
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
- **Nothing is subscribed, and nothing proposed, until the measurement is the
  pane's.** In `terminals.ts`, where the emulator is. A measurement is what the
  server sizes the pty to, and a bad one taken on the frame after a split — or
  before the renderer has measured a character — is a SIGWINCH into a shape no
  box has. A *detached* pooled element is the same question with a different
  cause and the same right answer: it reports no width, the measurement is
  refused, and the emulator keeps the shape it was last *told*, which is the
  server's and still correct for the bytes it is being fed. The pool gates on
  `proposeDimensions()` rather than on `fit()` throwing — fit does not throw
  when the renderer has no cell size, it quietly does nothing, so a try/catch
  cannot tell "fitted" from "skipped". `fit()` itself is never called any more:
  fitting is resizing, and resizing is the server's.
- **A measurement that is merely *small* is how the fit addon says it failed.**
  The sharp edge of the emulator swap, and it cost a freeze on the first tab
  drag. xterm's `proposeDimensions()` returned `undefined` for a box it could not
  measure, so "did it answer" *was* the whole test. Ghostty's does the same
  arithmetic and then ends it `Math.max(2, …)` by `Math.max(1, …)`, so an
  unlaid-out pane does not decline — **it answers `2x1`**, which is finite,
  positive and passes every check the old guard made. A pane is exactly that
  shape for a frame or two each time one is dragged, and believing it costs the
  lot — more now than it did, because the size policy is a *minimum*: one
  unlaid-out pane proposing two columns would hold every other client watching
  that agent down to two columns, and the SIGWINCH makes the agent redraw itself
  into them. `web/src/grid.ts` reads the clamp floor back as what it means — "I
  could not work this out" — and `web/test/grid.test.ts` holds it, because the
  refused value is a well-formed grid and an `if` with a number in it is what
  somebody simplifies away.
- **The pty follows the pane, but only the server may say which pane.** The
  pooled emulator measures its box and *proposes* that grid; `index.ts` keeps a
  proposal per client, takes the smallest over the clients that can see the
  terminal, resizes the screen and the pty once, and sends every client the grid
  to draw at. The emulator resizes when it is told and at no other time.

  It was the other way round until Part 2 of the lifecycle rework: a pane fitted
  itself and informed the pty afterwards, so the size was whichever client
  resized last — fine with one window, and why a phone made the desktop ragged.
  The deeper cost was that a client and the pty could hold two ideas of where a
  row ends at once, which is the disagreement every borked screen has turned out
  to be. The policy is `smallest` (tmux's `window-size`) so a phone and a desktop
  on one agent both see something correct rather than taking turns; it is in
  `server/src/sizing.ts`, pure and tested, because it is the one decision in
  there. A proposal is withdrawn by a `watch` that stops listing the terminal as
  visible — the same message that already says what a human can see — so a warm
  client never has a vote and a terminal nobody can see keeps the shape it had
  rather than being resized to nothing.

  Still never clamp a pane to a fixed grid: the program inside genuinely redraws
  at the size of the box it is in, and that is the whole difference between a
  terminal and a picture of one.

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

And the server owning the size, against real ptys in an isolated instance
(`KURURU_PORT=7817 KURURU_HOST_SOCK=/tmp/k2/ptyhost.sock KURURU_STATE_DIR=/tmp/k2`,
bare login shells): one client's proposal comes back unchanged as the grid and
`stty size` agrees; a second, narrower client takes the pty down to the smaller
of the two and **both** clients are told; each dimension is taken on its own, so
a short wide pane and a tall narrow one land on the intersection; a client that
stops looking — by `watch`, or by dropping its socket — hands the size back to
whoever is left, and a warm one never has a vote; a `watch` alone still produces
no backlog, and one that is asked for comes back at the grid the *policy* owns
rather than the grid the asker's own box is; a terminal nobody can see keeps its
shape, and watching it again is not itself a resize; and an exited terminal's
screen still reflows into a new pane with what it said intact.

And profiles carrying an identity, against a real pty: an env overlay handed to
`AgentHost.create` arrives in the pty's environment intact (`echo
$CLAUDE_CONFIG_DIR` in a spawned shell prints it), `CLAUDE_CONFIG_DIR` was
confirmed to scope a Claude login rather than only its settings (a scratch
directory reports `loggedIn: false` while the default reports the real account),
`GH_CONFIG_DIR` was confirmed to select a different one of the accounts in gh's
keyring with the real config untouched, and `/api/identity` answers for a profile
in about a second cold and instantly warm.

And the picking: `/api/identity/known` enumerates every github account gh holds
(three, each with the directory it would be stored as) alongside the Claude
logins it can find, in about two seconds cold; `ensureGhConfig` writes a config
gh then reads back as that account with a working token, is idempotent, leaves a
file gh has since rewritten alone, and refuses an account name with a path in it;
and `env -u GH_CONFIG_DIR` was confirmed to put a command back on the default
registry from inside a profile that has an override.

Both sign-in flows have since been run for real, and two accounts are signed in
at once in two profiles. The overlay reaching an ordinary terminal is the part
that is **still unproven in place**: the first attempt was against a host that
predated the `env` parameter, and the second — with the host restarted and both
bundles current — found that `ptyhost.ts` was dropping the field as it relayed
it (see the invariant above). That is fixed and costs one more host restart to
take effect. The check is `echo $CLAUDE_CONFIG_DIR` in a terminal opened in a
profile that has claimed an account.

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
