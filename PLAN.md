# kururu

A **GUI for the coding agents it runs** — in a window that can render markdown,
images, and the app you are building.
Reachable from a phone over Tailscale, where it is for *watching and steering*,
not for writing code.

## Why this exists

The limitation is the terminal: you cannot look at a rendered markdown file, an
image, or a running dev server through a VT grid. Once that is the thing you
need several times a day, the answer is a frontend that can draw.

Kururu began as a second frontend onto ghosttown's daemon, and the history is
worth keeping because it explains the shape of the code: the wire protocol, the
status heuristic and the agent-detection walk all come from that era, and two of
them were ported wholesale. What changed is ownership — see principle 1.

And the phone requirement settles the technology by itself. A mobile view has to
be web. Choosing a native desktop framework (GPUI was the candidate) means
writing that app *and* a web app, two renderers over one state, every feature
landing twice. Choosing web means the phone is a breakpoint.

## Design principles

1. **Kururu owns its agents.** It spawns each one in a pty it holds, keeps an
   emulator beside it, and is the only thing that knows about it. This was
   deliberately reversed once: kururu used to be a *client* of ghosttown's
   control socket, which meant one pty host and one set of agents shared with the
   TUI. Owning them is what makes kururu a whole application, and the price is
   what the old principle warned about: **kururu's agents and ghosttown's are two
   disjoint sets.**

   What is *no longer* the price is that they die with the app. That clause was
   here, and it was a consequence of Electron forking the pty host rather than
   anything the principle needed — the host is a daemon on a socket now
   (`server/src/ptyhostd.ts`), so it outlives the window, the server and the
   terminal any of them was started from. "One launch, nothing to have running
   first" went with it, and that was the trade: kururu is two commands, and the
   thing you get for the second one is that closing a window is not an act with
   consequences. Only restarting the host ends an agent, and nothing does that
   by accident.
2. **Borrow, never reach across.** Ghosttown is not a dependency and is never
   edited from here, but it is a source: `status.ts` was copied verbatim and the
   agent-detection half of `procs.ts` with one call swapped. Where a problem is
   already solved next door, port it and say so in the file.
3. **One UI, two widths.** The desktop window and the phone load the same URL
   from the same server and run the same components. There is no mobile build
   and no desktop build, so there is nothing to keep in step. *Currently owed:*
   the desktop layout was rebuilt around tiled terminals and the phone was not
   given a width of its own, so today this principle holds only in the sense
   that there is one build. See the open question below.
4. **The window is dumb, and it is now dumb enough to be disposable.** Electron's
   main process owns a window and a menu bar. Everything stateful — the ptys, the
   emulators, the proxies, the file reads — is in processes it did not start and
   cannot stop.

   It used to start them, as utilityProcesses: still the app, still dying with
   it, but off the thread that draws. That bought a real thing (one launch) and
   cost a confusing one — the agents were *the window's*, so quitting needed a
   dialog, closing the window had to be specially prevented from quitting, and an
   app running with no window, no tray icon and nothing to say it was there was
   the result. All of that machinery was mitigation for a problem the split
   removes. So: closing the last window quits, on every platform, and quitting
   costs a window. The desktop finds a server the way the phone does, which also
   means it can find one that is not on this machine.
5. **Semantics on the phone, pixels on the desktop.** This used to say the
   phone never renders a terminal, and that half stands: mirroring a VT grid
   onto a 390px screen is the wrong thing done well, and a phone wants a status,
   a transcript and an input box.

   The desktop is the opposite and the old UI got it backwards. It spent the
   window on a preview and a file tree and left the agents a drawer at the
   bottom — which is upside down when the agent *is* what you are watching, and
   when everything an agent draws (its diff colouring, its boxes, its spinner,
   its scrollback) only exists as pixels in a VT grid. A rendered-to-text screen
   in a `<pre>` could not be typed into, scrolled back through or selected out
   of. So the desktop runs a real emulator per pane, and the semantic view is
   what the phone gets when it is built.
6. **Ask the kernel.** Ports come from `lsof`, not from parsing `--port`.
   `npm run dev` names no port, and `vite --port 3001` lies the moment 3001 is
   taken.

## Stack

| Layer | Choice | Notes |
|---|---|---|
| Pty host | kururu's own, a daemon on a unix socket | owns every pty; outlives the server and the window |
| Server | Node | HTTP + WS; connects to the host, restarts freely |
| UI | React 19 + Vite | one codebase, desktop and phone |
| Desktop shell | Electron | a viewer: finds a server and draws it, exactly as the phone does |
| Host link | newline-delimited JSON over a unix socket | `hostlink.ts`'s protocol, `hostsock.ts`'s framing |
| Transport | WebSocket, JSON | server pushes state; the client sends verbs |
| Preview | reverse proxy, port per dev server | a path prefix cannot work — see below |
| Phone access | `tailscale serve` | tailnet-only; run by you, never by kururu |

## How the pieces fit

```
  kururu pty host ──unix socket── kururu server ──ws/http── web app
   (ptys, emulators)   (hostlink)   (Node)                   ├── Electron window, here or elsewhere
   outlives everything              restarts freely          └── phone, over tailscale
                                      │
                                      └── preview proxies ──── dev servers
```

The two boundaries do different jobs and it is worth saying which. The **socket**
is what makes a server restart cost nothing: the ptys are on the far side of it.
The **HTTP boundary** is what makes the window disposable and the phone possible:
everything above it is a client, and the desktop is not a privileged one.

### Why the server polls

Ghosttown's control protocol is request/response with no way to push, so "what
changed" can only be found by asking. Over a unix socket on the same machine
that is cheap, and the server diffs before it broadcasts, so a quiet session
sends nothing over the tailnet. When the daemon grows an event stream the poll
loops become subscriptions and nothing above them changes.

### Why a port per preview, not a path

Dev servers emit absolute URLs — `/@vite/client`, `/src/main.tsx`,
`/node_modules/.vite/deps/…`. Serve one under `/preview/<id>/` and it breaks on
the first asset, and the only fix is rewriting every absolute URL in the HTML,
the JS and the CSS. A port is an origin, and an origin makes that somebody
else's problem.

The extra hop through kururu (rather than pointing `tailscale serve` straight at
the dev server) buys two things:

- **The `Host` header is rewritten** to the upstream's own. Vite has refused
  unfamiliar `Host` values since 5.4.12/6.0.9, and a tailnet name is about as
  unfamiliar as it gets. Rewriting it here means no project needs
  `server.allowedHosts` added to be previewable.
- **Frame-blocking headers are stripped**, so the preview can live in an iframe.
  Electron does the same thing on the desktop side via `onHeadersReceived`.

### Why the server is two processes

Everything in `server/src` except the ptys changes constantly, and until the
split, restarting it to pick up a change took every agent with it. That is a
different cost from "agents die when you quit", which was accepted on purpose,
and it was never argued for — it was just where the code happened to sit.

So there are two utilityProcesses. The **pty host** holds what cannot be
recreated: the ptys, the emulators beside them, and an opaque blob of whatever
the server last called the arrangement. The **server** holds everything else and
can be thrown away in under a second. They are handed the two ends of a
MessageChannel and talk directly; the main process is never in the middle of a
terminal's output.

Restarting the *host* still kills everything, and there is no way around it:
a live pty cannot be handed to a replacement process. Ghosttown's config says the
same thing about its daemon in the same words. The difference the split buys is
that the file you edit almost never is the file that costs anything.

The blob is why a restart is *invisible* rather than merely survivable. The ptys
were never the only state worth keeping — a layout full of tabs pointing at them
is no use if it comes back empty, and the disk snapshot strips processes out on
purpose. So the host holds the layout too, without ever looking inside it.

### Why the arrangement lives on the server

It started in React state, which is the obvious place for it and wrong for the
same reason the agents were wrong there: reload the window and an afternoon's
arrangement is gone while every process it described is still running. A layout
is organized work — it takes longer to arrange than the panes take to fill.

So it lives beside the ptys, in `server/src/workspaces.ts`, and the browser draws
what it is told. The protocol follows: the client sends *split the focused pane*,
never *here is my new tree*. Three things fall out of that. A window reload costs
a repaint. Two clients are two views of one session, the way two clients attached
to a multiplexer are. And the structure can be written to disk, which
`persist.ts` does — profiles, workspace names, splits, ratios, and the directory
each pane was working in.

What it deliberately does not persist is processes. A restored pane comes back
*empty*, with its cwd remembered so the terminal you open in it starts in the
right project. Ghosttown restores fresh shells; kururu must not, because a
snapshot with four agent tabs in it would launch four agents and spend four
context windows before anybody had asked for one. It is the one exception to
panes being born with a terminal in them: a pane brought back is not a pane being
made, and the difference is that nobody just asked for it.

### Why the hierarchy is ghosttown's, word for word

Profile → workspace → pane → tab, with the same names and the same keys. Not
because kururu inherited them — it had a flat list a week ago and the model file
argued for it — but because the value of a prefix is entirely in the hands that
already know it. A key that does something *different* in the sibling app is
worse than one that does nothing, which is why the actions kururu has no
equivalent for (detach, reboot, the markdown reader) are left unbound rather than
reused.

The one place the two differ is underneath. A ghosttown profile is a whole
session with its own daemon; kururu has one server that owns every pty, so a
profile here is a namespace rather than a process. The behaviour is the same —
switch away and what you left keeps running — and the switcher says so by
counting the live terminals on every row.

### Why panes are positioned rather than nested

Nested flex boxes describe a split tree exactly, and that is what this was until
a pane could be dragged somewhere else. React reconciles children by position, so
restructuring the tree — which is what every rearrangement does — moved a pane to
a different place in the element tree and React rebuilt it. The emulator came
back empty, and nothing refilled it: the *set* of visible terminals was
unchanged, so the one thing that asks for history had no reason to fire. An agent
covered it up by repainting its spinner a moment later. A shell just stayed
blank.

So panes are a flat list of absolutely-positioned boxes keyed by pane id, and the
geometry comes from the same pure `rects()` the directional-focus keys use. A
rearrangement is four CSS percentages, the DOM node is moved rather than rebuilt,
and the scrollback and scroll position come through it. It also made the
animation free, which is worth having for its own reason: a pane that teleports
across the window leaves you working out where it went.

### Why tiled panes, and why the terminal is real

Two agents working at once is the normal case, and the question a multiplexer
answers is how to look at both. Tabs answer it badly here: an agent is worth
watching precisely when you are not typing at it, and a tab you are not looking
at is a tab that might as well not exist. So panes tile, and the tree that
describes them (`web/src/layout.ts`) is the same shape tmux uses, for the same
reason — a split divides the space its parent had, so the geometry falls out of
the nesting and nothing stores a rectangle.

What fills a pane is a real emulator, not a rendering of one. The server used to
flatten each pty to plain text on a 150ms timer and push that, which is a
reasonable thing to send a phone and a poor thing to put on a desktop: it cannot
be typed into, scrolled back through or selected out of, and everything an agent
says in colour arrives grey. Now the pty's bytes go down the socket untouched and
a real emulator draws them, which also means the *pty follows the pane* — split
a pane and the program inside genuinely redraws at the new size, because that is
what SIGWINCH is for. Which pane it follows is the server's to decide (Part 2 of
the lifecycle rework): a pane proposes a shape, it does not impose one.

The server still keeps a headless emulator beside every pty, and it earns its
place for a different reason than before: a pane opened ten minutes after an
agent started has missed everything, and serializing the emulator's buffer gives
it history whose escape sequences are whole by construction. A ring buffer of raw
bytes trimmed to a budget would be cut mid-sequence, and a cut sequence swallows
whatever follows it.

### Why the file API is the paranoid part

Kururu is reachable from the tailnet, so "read a file" is the one request that
could hand over something it should not. Roots are only ever learned from places
the server already knows about (a dev server's cwd, `KURURU_ROOTS`), never from
a client. Paths are resolved, checked, realpath'd, and checked again — the second
check is the one that catches a symlink inside the project pointing at `~/.ssh`.
An escaping path is refused, never clamped: a clamped traversal is a bug that
looks like it worked.

## Where it is

**Done**

- Agent host: kururu spawns every agent in a pty it owns, and tears the whole
  process group down on quit (a login shell may not exec, so the pty's pid is
  not the agent's).
- Status heuristic through a real pty, and `POST /api/report` for the one state
  no heuristic can reach — an agent that reports itself never gets guessed at
  again.
- Dev-server discovery: `lsof` + `ps`, walking *up* the process tree so
  `bun run dev` is found via the child that actually holds the port.
- Preview proxy: HTTP + WebSocket, Host rewrite, frame-header stripping,
  Vite blocked-host detection with a page that says how to fix it. Server-side
  and working; nothing in the UI points at it since the window became terminals.
- Traversal-safe file API. Same: built, tested, currently unused by the UI.
- **Tiled terminals.** A Ghostty (WASM, 2D canvas) emulator per terminal over a
  raw pty byte stream, panes split and resize, the pty follows the pane it is
  given, and a pane opened late is handed the history from the emulator the
  server keeps beside every pty.
- **One emulator per terminal, never rebuilt** — Part 1 of the lifecycle rework
  below. Emulators are pooled by agent id in `web/src/terminals.ts` and *moved*
  between panes, so a tab switch, a workspace change and a drag are DOM moves
  and ask the server for nothing. The client tells the server what is visible
  and what it is keeping warm; the host streams the union, and the unread mark
  moved to the restartable half because the host's watched set is no longer the
  same question as "somebody is looking".
- **The server owns the size** — Part 2. A pane measures its box and *proposes*
  a grid; `index.ts` takes the smallest proposal among the clients that can see
  that terminal, resizes the pty once, and tells every client what to draw at.
  An emulator changes shape only when it is told, which is what makes the pty
  and the picture of it unable to disagree — the disagreement every borked
  screen has turned out to be. The policy is tmux's `window-size smallest` and
  lives in `server/src/sizing.ts`, so a phone and a desktop on one agent both
  see a correct screen rather than taking turns.
- **The multiplexer hierarchy**, ghosttown's: profiles → workspaces → panes →
  tabs, owned by the server, driven by a ctrl+a prefix, and written to disk as
  structure that never respawns anything.
- **Rearranging by drag, at two scales**: a tab along a strip, across panes, onto
  a pane edge to split it, or onto a workspace; and a whole pane by its strip —
  onto another pane to swap the two, onto an edge to move it there, onto a strip
  to merge. One server verb per meaning, because the client should not be
  computing a new tree and sending it.
- Electron shell bringing up server + vite + window from one command.

**Next, roughly in order**

1. **The preview, as a pane type.** It was a top-level view and it is now nothing;
   the proxy that made it work is still running. A pane holds a terminal today
   and should hold a preview or a file the same way — one pane type per thing
   worth looking at, which is what tiling was for.
2. **Syntax highlighting.** Shiki, rendered on the server, so the phone is sent
   markup rather than a highlighter and every grammar it might need.
3. **Markdown and images.** The original reason for all of this. Markdown
   rendered, images shown, both from the same file API.
4. **Transcripts as chat.** Ghosttown's `core/transcript.ts` already reads
   Claude Code's JSONL from both ends to get context usage; the same read yields
   the last N turns as structured messages. This is what the phone shows instead
   of a terminal, and it is the larger half of giving the phone its own width.
5. **Push notifications.** Ghosttown's `notifyGate` already decides what is
   worth interrupting you for; the phone is another sink for it.
6. **The element picker.** Since the proxy is already an origin-level hop, it
   can inject a script into previewed HTML: long-press an element, capture the
   selector and source location, send it to the agent as *"the CTA in
   `src/Hero.tsx:42` wraps at 390px"*. Waits on the preview pane.

## The terminal lifecycle rework

Written 2026-09-15, after a session in which typing into a pane stopped
arriving, workspaces came back borked, and selection looked broken. Those are
not three bugs. They are one decision, and this section is the plan for undoing
it in two parts, each of which can be executed on its own.

**The decision: kururu ties an emulator's lifetime to the view that draws it.**
A tab switch, a workspace change, a profile swap or a pane rebuild throws the
emulator away and builds a new one, which then has to be refilled from a screen
the server serializes on demand — at a width the client names in the request,
because a serialized screen is laid out at a width and reconstructing it at any
other one wraps every row and never recovers. Everything expensive in the
terminal path exists to make that survivable: `screen.ts`'s serialize-at-a-size,
the grid travelling on `request-backlog`, `awaiting` counting overlapping
rebuilds, backlog-before-output ordering, the epoch matching an answer to the
emulator that asked. A whole subsystem, and its only job is to paper over the
rebuild.

Nobody else does this, including the people who wrote our emulator.
[coder/mux](https://github.com/coder/mux) is an Electron-plus-browser app for
parallel coding agents built on ghostty-web by ghostty-web's own authors, and
its `TerminalView.tsx` says, in a comment, *"we intentionally keep the terminal
instance alive when hidden so we don't lose frontend-only state"* — created
lazily on first visibility, kept through every hide. [rcarmo/webterm](https://github.com/rcarmo/webterm),
which tiles live terminals the way our panes do, holds `Map<HTMLElement,
WebTerminal>` and disposes only when the element leaves the document; a
reconnect reconnects the socket and never the terminal. VS Code re-parents the
same wrapper element between containers — `attachToElement` / `detachFromElement`
in `terminalInstance.ts` — and has never rebuilt an xterm to move it.

The WebGL blackouts that cost us xterm.js belong to this too. A page gets about
sixteen contexts; sixteen is only a budget you can exhaust if you are building
emulators continuously. The renderer was replaced to fix a symptom.

Two more things follow from the same root, and they are Part 2.

**The pty's size was decided by whichever client resized last.** mux proposes a
size, resizes the *pty first*, and then sets its own emulator to match, so the
server is authoritative and every client conforms to it. We did the opposite —
`Terminal.tsx` fitted the emulator to its box and told the pty what shape it was
now — which is why a backlog had to carry a grid, why the server's single shared
screen got reshaped to each client's guess at serialize time, and why two
clients of different sizes fought forever. tmux settled this in the 1990s with
`window-size`: `largest`, `smallest`, `manual`, `latest`. We had last-wins and
no policy, which is fine with one window and is why a phone made the desktop
ragged. Part 2 is that inversion, and it is done.

### Part 1 — one emulator per terminal, never rebuilt — **done**

Built as described, with one correction to the unread plan: see the note at the
end of this section.

Client-side only. Nothing in `server/src/agents/`, `ptyhost*`, or `hostsock.ts`
is touched, so this costs a repaint and never an agent.

**The shape.** A new `web/src/terminals.ts` owns a pool keyed by agent id: the
ghostty-web `Terminal`, the host `<div>` it was opened into, and its
subscription to `session.ts`. It is created on first use and kept. A pane does
not create a terminal, it **borrows** one: `TerminalView` renders an empty
mount `<div>`, appends the pooled host element into it on mount, and on unmount
leaves it detached in the pool. React must never render the pooled element as a
child of anything — it would try to remove it — so it is appended imperatively
into a ref'd node, which is what makes a tab switch, a workspace change and a
drag a DOM move rather than a rebuild.

`open()` throws on a second call in ghostty-web, which is not an obstacle: the
element is moved, never re-opened.

**Eviction.** The pool is capped — start at twelve, LRU — and an entry is
disposed when its agent is closed or killed, or when it falls off the end. A
terminal that has been evicted and comes back is exactly the cold case the
backlog path still exists for, so nothing is lost; it just stops happening
during ordinary navigation.

**Watched vs warm, and the unread trap.** A pooled emulator must be fed whether
or not it is on screen, or it goes stale and we are back to reconstructing. So
the client sends two sets rather than one: what is *visible* (the active tab of
every pane in the current workspace, which is what `watch` means today) and what
is *warm* (everything in the pool). The host streams the union.

The trap: `host.ts` derives `unread` from its watched set — *"output nobody is
looking at is the definition of unread"* — so streaming the warm set would
silently stop every unread mark from ever appearing. Do **not** fix that by
editing `agents/host.ts`; that file costs the user every running agent to
change. Move `unread` to the server instead, exactly as `activity` already
lives there and for the same stated reason: `index.ts` sets it when output
arrives for a terminal no client has visible, clears it when one does, and
merges it into the snapshot over the host's now-vestigial flag.

**Correction, found while building it.** The host's flag is not vestigial and
the move cannot be total, because `index.ts` does not see the output it would
have to count. The host streams only what it is watching, so output for a
terminal in neither set never reaches this process at all — and a terminal in
neither set is precisely the common case for the mark, a background workspace's
agent nobody has pooled. So the two answers are *ored* in `overlay`: this side
marks what it is streaming and cannot see, the host marks what it is not
streaming and this side cannot see. Between them every terminal is covered, and
`agents/host.ts` is still untouched.

**Rendering cost to measure, not assume.** ghostty-web runs a
`requestAnimationFrame` loop per terminal and exposes no way to pause it, so a
dozen pooled terminals are a dozen loops drawing to detached canvases. Measure
it with the pool full before deciding anything; if it shows up, the honest fix
is a `setRenderingEnabled(boolean)` upstream, or a local patch, not a smaller
pool that brings the rebuilds back.

**What must still be true afterwards**

- A backlog is requested only by a genuinely new emulator: a first mount, an
  eviction that came back, or a reconnect. Switching tabs and workspaces asks
  for nothing.
- Closing a tab or killing an agent disposes its pooled entry. An emulator for
  an agent that no longer exists is a leak with a canvas in it.
- The focused pane still takes the keyboard, including after a dialog or a
  sidebar rename closes (`paneKeyboard`, already in `App.tsx`).
- `web/test` still passes, and the pane-tree tests are untouched by any of this.

**Verified** — the server half, against an isolated instance on
`KURURU_PORT=7817 KURURU_HOST_SOCK=/tmp/k2/ptyhost.sock KURURU_STATE_DIR=/tmp/k2`
with two ptys running `cat`: a warm terminal streams while an unwatched one does
not, a visible terminal is never unread, a warm-but-unseen one is, showing it
clears the mark, a terminal dropped from both sets still gets the host's mark, a
warm emulator's `request-backlog` is answered at the grid it asked for, live
output still arrives behind the backlog that would have wiped it, and a `watch`
with no `warm` field behaves exactly as before. The window half is the list
below and wants a real window.

**Verify** — against an isolated instance, never the user's agents. A second
kururu with `KURURU_PORT=7817 KURURU_HOST_SOCK=/tmp/k2.sock
KURURU_STATE_DIR=/tmp/k2` is a complete, separate world; spawn terminals
running `cat` or `sleep 300`, never `claude`. Then: split a pane, open four
tabs, switch between them and confirm the screen is *identical* across the
switch with no flash and no `request-backlog` on the wire; switch workspaces
and back; drag a pane across the grid; reload the window and confirm exactly
one backlog per visible terminal.

### Part 2 — the server owns the size — **done**

Server plus client. `server/src/index.ts` is the restartable half, so this costs
a reconnect — `C-a B`, or automatic under `bun run dev` — and still never an
agent. Do it after Part 1: the deletions below are only safe once nothing
rebuilds emulators.

**The inversion.** `Terminal.tsx` stops resizing the pty. It measures its box,
puts the result through `usableGrid`, and *proposes* — `propose-size` on the
wire. The server keeps the proposals per agent, applies a policy, resizes the
pty once, and tells every watcher the authoritative grid; the client's emulator
resizes when it is told, and at no other time. That is mux's order, and the
reason for it is that the pty and the emulator can then never disagree about
shape, which is the disagreement every borked screen has turned out to be.

**The policy** is `smallest` — the smallest proposal among clients that
currently have that terminal visible. Chosen over `latest` because a phone and a
desktop looking at one agent should both see a correct screen rather than take
turns, and over `largest` because the smaller client would clip. A terminal with
no visible watcher keeps the size it had; it is not resized to nothing and it is
not resized by a warm client that is only keeping its emulator current. It lives
in `server/src/sizing.ts`, pure and tested, because it is the one decision in a
change that is otherwise bookkeeping about whose proposals are still in play.

**How "visible" is enforced, which was the one thing the plan did not settle.**
Not by testing `watching` when the minimum is taken: a pane measures its box in
a layout effect and the `watch` listing it arrives a passive effect later, so a
proposal is reliably the *first* the server hears of a terminal being on screen,
and requiring the watch to have landed already would mean answering the first
backlog at a size nobody asked for. So a proposal counts from the moment it
arrives and a `watch` that no longer lists the terminal is what withdraws it —
which is also what keeps a warm client out, since a detached emulator cannot
measure a box and never proposes in the first place.

**What this deletes.** `request-backlog` stops carrying `cols`/`rows` — the
server serializes at the size it already owns. The `epoch` goes with it: it
existed because two emulators could ask at two sizes and get each other's
answers, and there is now one size and, after Part 1, usually no second asker.
`sendBacklog` stops calling `host.resize`. `OutputSink.grid()` in `session.ts`
goes, replaced by `size()` going the other way. `awaiting` stays — a backlog
must still precede live output for the client receiving it — and its inflight
*count* stayed a count: it was checked, and it is free, and what it prevents is
bytes the client never sees again.

Two things the plan expected to delete that earned their place. The backlog
*answer* keeps its `cols`/`rows`: a screen that states the shape it is laid out
in cannot be desynchronised by anything, and it covers the one ordering a single
authoritative size does not — a resize decided while a screen is being
serialized, where the host answers at the older grid and a `grid` has already
gone out naming the newer. `sendBacklog` sends a second `grid` behind the
backlog for exactly that case. And the *request* still has a size beside it,
one message earlier: `session.ts` sends `propose-size` and `request-backlog`
from one function, so a history can never be asked for before the shape it will
be laid out in has been established.

**What must still be true afterwards**

- A pane genuinely resizes the terminal: drag a divider, and `stty size` inside
  the pty agrees within the settle window. The debounce stays; every resize is a
  SIGWINCH and every agent TUI repaints completely on one.
- An exited agent's screen still reflows (`host.resize` skips only the pty half
  once `exited` is set).
- Two clients of different widths on one workspace both draw correctly, and
  neither makes the other ragged. This is the whole point; test it with two
  browser windows before calling it done.
- `server/test/screen.test.ts` still holds: serialize, rebuild, compare.

**Verified** — against an isolated instance on `KURURU_PORT=7817
KURURU_HOST_SOCK=/tmp/k2/ptyhost.sock KURURU_STATE_DIR=/tmp/k2`, with bare login
shells and never an agent CLI. One client's proposal comes back unchanged as the
grid and `stty size` inside the pty agrees. A second, narrower client takes the
pty down to the smaller of the two and **both** clients are told, so neither is
drawing at a shape the pty is not. Each dimension is taken on its own: a short
wide pane and a tall narrow one land on the intersection, which is neither
proposal. A client that stops looking — by `watch`, or by dropping its socket —
hands the size back to whoever is left, and a warm one never has a vote. A
`watch` alone still produces no backlog; one that is asked for comes back at the
grid the policy owns rather than the asker's own box, and carries no epoch. A
terminal nobody can see keeps its shape, and watching it again is not itself a
resize. An exited terminal's screen still reflows into a new pane with what it
said intact. `bun test` covers the policy itself in `server/test/sizing.test.ts`.

**Still wanted by hand:** two real browser windows of different widths on one
workspace, which is the only way to see the letterboxing described in the open
questions rather than reason about it, and a divider dragged through a real
agent's TUI to watch it repaint once at the end rather than on every frame.

### Not in either part

**Selection.** Dragging over text in a busy pane looks broken, and the isolated
finding is that it half is. In ghostty-web 0.4.0 a drag always selects — mouse
tracking modes are irrelevant, since the library sends no mouse reports at all,
which is its own missing feature — and the text *is* copied to the clipboard on
release. What vanishes is the highlight: the selection is anchored to absolute
rows, so output scrolling underneath carries it off the viewport within a frame
or two, and in a pane running a chatty agent that is indistinguishable from
nothing having happened. Part 1 removes the kururu-specific half of this (a
rebuild and every backlog `reset()` destroy a selection outright). What is left
is a product decision — hold the viewport while a selection exists, or show that
the copy happened — and it wants its own pass.

**The stale lines this invalidates.** Both parts corrected the prose they made
untrue, in the same change, which is what this section asked for: `CLAUDE.md`'s
tab-switch-as-WebGL-budget and its "the pty follows the pane", `PLAN.md`'s
"Done", and the open question about last-writer-wins resize, which Part 2
answered and which has been replaced with what is actually open now.

### Rules for whoever executes this

- **Never edit `server/src/agents/`, `ptyhostd.ts`, `ptyhost.ts`, `hostlink.ts`
  or `hostsock.ts`** for either part. Every one of those costs the user every
  agent they are running. If something seems to need it, it belongs on the
  other side of the link — say so and stop.
- A `bun run dev` may be watching `server/src` and `shared` while you work.
  Check with `curl -s localhost:7717/api/health` before starting and say what
  you are about to disturb.
- No git commands, no `tailscale` commands, no edits to `../ghosttown`.
- Test with `cat` and `sleep`, never a real agent CLI.

## Open questions

- **Dev servers are found machine-wide, not per agent.** This used to be forced
  — the daemon's snapshot did not say which surface ran what. It is no longer:
  kururu holds the pty pids itself and `procs.ts` already builds the child index
  that would answer it. Still unbuilt, because a dev server is just as useful
  without knowing who started it, and the machine-wide scan also finds the ones
  you started in a plain terminal.
- **The phone has no view of its own.** It loads the desktop layout, which means
  a sidebar and tiled xterm panes on a 390px screen — usable to *read*, and
  nobody's idea of a phone app. The answer is not a mobile terminal; it is
  transcripts (item 4) plus a single-pane width, and until that lands principle 3
  is owed rather than kept.
- **The prefix is a constant, not a setting.** ctrl+a lives in `web/src/keys.ts`
  and changing it is a one-line edit. Kururu has no config system, and inventing
  one for a single value would be the wrong first user of it — but a second value
  wanting to be configurable is the signal to build one.
- **A client that is not the smallest draws its terminal letterboxed.** Answered
  in part: the size is the server's now and the policy is `smallest`, so two
  clients on one agent both see a *correct* screen instead of taking turns being
  ragged. What is left is cosmetic and real — the wider pane has a band of
  background where its box exceeds the grid it was given, because an emulator
  drawing fewer columns than its box holds cannot fill it. Nothing is wrong on
  screen; there is simply less of it. The alternative is `largest` and clipping
  the smaller client, which is worse, so this waits on the phone having a view
  of its own rather than a share of the desktop's.
- **Agents do not survive the app** — but they do survive the server. The ptys
  moved into a pty host process of their own, so everything that changes weekly
  (protocol, layout, discovery) can be killed and re-forked without them
  noticing; `C-a B` does it, and `KURURU_DEV=1` does it on save. Quitting still
  ends them, and making them outlive *that* is the remaining step: a detached
  host with adopt-on-launch and a CLI to manage sessions, which is most of a
  multiplexer, and ghosttown is already that. Worth revisiting only if quitting
  turns out to hurt in practice — restarting was the part that actually did.
- **~~No auth, by design.~~ Answered, because shipping is what this line said
  would force it.** The assumption was tailnet-only, and it held exactly as long
  as kururu was a thing you ran out of a checkout — a downloadable app is one
  double-click away from a stranger's laptop, and a server on `0.0.0.0` with no
  gate hands them a shell with your accounts signed into it. So the socket binds
  loopback and being reachable is a decision made in the Share dialog, which
  mints a token the QR code carries; and the `Origin` header is checked on every
  request, because a WebSocket is exempt from the same-origin policy and without
  that check any page in any tab could drive a kururu nobody had shared at all.
  `server/src/access.ts` is the whole of it. What is still owed is the *next*
  question, which is a kururu on the open internet rather than on a tailnet: one
  token and no accounts is the right shape for one person's machine and not for
  anything else.
