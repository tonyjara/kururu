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
   deliberately reversed: kururu used to be a *client* of ghosttown's control
   socket, which meant one pty host and one set of agents shared with the TUI.
   Owning them is what makes kururu a whole application — one launch, nothing to
   have running first — and the price is exactly what the old principle warned
   about: **kururu's agents and ghosttown's are two disjoint sets**, and they do
   not outlive the app. Accepted knowingly, and mitigated where it is sharpest
   (see principle 4).
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
4. **The window is dumb; the app is not.** Electron's main process owns a
   window, a menu bar and one dialog. Everything stateful — the ptys, the
   emulators, the proxies, the file reads — lives in the server, which runs as a
   utilityProcess: still this app, still dying with it, but not on the thread
   that draws. So closing the window disturbs nothing and the phone keeps
   working while it is shut. **Only quitting stops the agents, and it asks
   first.** That guard is the whole mitigation for principle 1's price; do not
   remove the macOS `window-all-closed` behaviour that makes it possible.
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
| Daemon | ghosttown's, unchanged | owns every pty; survives the GUI restarting |
| Server | Bun | `Bun.serve` for HTTP + WS; `Bun.connect` for the control socket |
| UI | React 19 + Vite | one codebase, desktop and phone |
| Desktop shell | Electron | main process is Node, which is *why* the server stays a separate Bun process |
| Transport | WebSocket, JSON | server pushes state; RPC passes through to ghosttown |
| Preview | reverse proxy, port per dev server | a path prefix cannot work — see below |
| Phone access | `tailscale serve` | tailnet-only; run by you, never by kururu |

## How the pieces fit

```
  ghosttown daemon ──unix socket── kururu server ──ws/http── web app
   (ptys, state)      (poll+RPC)    (Bun)                     ├── Electron window
                                      │                       └── phone, over tailscale
                                      └── preview proxies ──── dev servers
```

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
xterm.js draws them, which also means the *pty follows the pane* — split a pane
and the program inside genuinely redraws at the new size, because that is what
SIGWINCH is for.

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
- **Tiled terminals.** xterm.js per pane over a raw pty byte stream, panes split
  and resize, the pty follows the pane, and a pane opened late is handed the
  history from the emulator the server keeps beside every pty.
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
- **One terminal in two panes resizes last-writer-wins.** A pty has one size and
  a pane is a shape, so showing the same terminal twice at different widths makes
  the smaller one ragged. Correct enough — the pane you just resized is the one
  you are looking at — and the alternative is reflowing a grid nobody asked to
  reflow.
- **Agents do not survive the app** — but they do survive the server. The ptys
  moved into a pty host process of their own, so everything that changes weekly
  (protocol, layout, discovery) can be killed and re-forked without them
  noticing; `C-a B` does it, and `KURURU_DEV=1` does it on save. Quitting still
  ends them, and making them outlive *that* is the remaining step: a detached
  host with adopt-on-launch and a CLI to manage sessions, which is most of a
  multiplexer, and ghosttown is already that. Worth revisiting only if quitting
  turns out to hurt in practice — restarting was the part that actually did.
- **No auth, by design.** Tailnet-only. If kururu is ever reachable off a
  tailnet, that assumption has to be revisited before anything else is.
