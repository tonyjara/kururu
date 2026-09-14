# kururu

A **GUI for the agents ghosttown is running** — the same mux, the same daemon,
in a window that can render markdown, images, and the app you are building.
Reachable from a phone over Tailscale, where it is for *watching and steering*,
not for writing code.

## Why this exists

Ghosttown works. The limitation is not in it, it is in the terminal: you cannot
look at a rendered markdown file, an image, or a running dev server through a VT
grid. Once that is the thing you need several times a day, the answer is a
second frontend, not a better TUI.

And the phone requirement settles the technology by itself. A mobile view has to
be web. Choosing a native desktop framework (GPUI was the candidate) means
writing that app *and* a web app, two renderers over one state, every feature
landing twice. Choosing web means the phone is a breakpoint.

## Design principles

1. **One daemon.** Kururu is a *client* of ghosttown's control socket, not a
   fork of it. The TUI, the desktop window and the phone all talk to the same
   pty host, so they are all looking at the same agents. A second daemon would
   quietly give you two disjoint sets of them.
2. **Additive, never invasive.** Nothing in ghosttown changes for kururu to
   work. It speaks the protocol that is already there (`list`, `read-screen`,
   `send-text`, `focus`). Where that protocol is short of something, kururu
   finds it out for itself — see dev-server discovery — rather than growing a
   fork of the mux.
3. **One UI, two widths.** The desktop window and the phone load the same URL
   from the same server and run the same components. There is no mobile build
   and no desktop build, so there is nothing to keep in step.
4. **The shell is dumb.** Electron owns a window and a menu bar. Everything
   stateful — the daemon link, the proxies, the file reads — lives in the Bun
   server, so closing the window disturbs nothing and the phone keeps working
   when the desktop app is not running.
5. **Semantics on the phone, not pixels.** The phone never renders a terminal.
   An agent is a status, a screen of text and an input box; a file is syntax
   and lines. Mirroring a VT grid onto a 390px screen would be the wrong thing
   done well.
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

- Persistent daemon link with reconnect; RPC passthrough over the WebSocket.
- Snapshot / dev-server / session push, diffed before broadcast.
- Dev-server discovery: `lsof` + `ps`, walking *up* the process tree so
  `bun run dev` is found via the child that actually holds the port.
- Preview proxy: HTTP + WebSocket, Host rewrite, frame-header stripping,
  Vite blocked-host detection with a page that says how to fix it.
- Agent panel: tab strip, status, context rings, screen polling, `send-text`.
- File tree + read-only code view, traversal-safe.
- Electron shell that adopts a running server rather than starting a second one.

**Next, roughly in order**

1. **Syntax highlighting.** Shiki, rendered on the server, so the phone is sent
   markup rather than a highlighter and every grammar it might need.
2. **Markdown and images.** The original reason for all of this. Markdown
   rendered, images shown, both from the same file API.
3. **Transcripts as chat.** Ghosttown's `core/transcript.ts` already reads
   Claude Code's JSONL from both ends to get context usage; the same read yields
   the last N turns as structured messages. That turns the agent panel from a
   screen of text into a conversation. Needs the transcript path in the
   snapshot — the first thing worth asking ghosttown to add.
4. **Push notifications.** Ghosttown's `notifyGate` already decides what is
   worth interrupting you for; the phone is another sink for it.
5. **The element picker.** Since the proxy is already an origin-level hop, it
   can inject a script into previewed HTML: long-press an element, capture the
   selector and source location, send it to the agent as *"the CTA in
   `src/Hero.tsx:42` wraps at 390px"*. This is the feature that makes the phone
   more than a viewer, and it is why the preview and the agent share a screen.
6. **Terminals on the desktop.** xterm.js + webgl, desktop breakpoint only.
   Deliberately last: the TUI is still the best place to type.

## Open questions

- **Dev servers are found machine-wide, not per surface.** Ghosttown attributes
  them to the surface running them; its snapshot does not carry that, so kururu
  scans instead. Additive fields on `list` (`cwd`, `dev`, `devPort`) would fix
  it and would help the file browser root itself per agent. Worth doing when
  the two projects next touch.
- **`read-screen` is a stopgap** for the agent panel. It works with any agent,
  which the transcript reader will not — so it stays as the fallback.
- **No auth, by design.** Tailnet-only. If kururu is ever reachable off a
  tailnet, that assumption has to be revisited before anything else is.
