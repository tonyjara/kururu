# kururu

*Kururu* is Guaraní for **frog**. It sits on top of [ghosttown](../ghosttown)
and gives it eyes: a GUI for the agents that mux is already running — on the
desktop, and on your phone.

Ghosttown is a terminal. That is its strength and its ceiling: it cannot show
you a rendered markdown file, an image, or the app you are building. Kururu is
the other half — the same agents, the same daemon, in a window that can draw.

## What it does today

- **Sees your agents.** Tab strip across the bottom, live status
  (idle / working / blocked / done), unread marks, context-window rings.
- **Talks to them.** Type into the panel; it goes to that agent's pty.
- **Previews your dev server.** Finds what is listening by asking the kernel,
  not by parsing a command line, and frames it — including from a phone, which
  cannot reach this machine's `localhost`.
- **Browses the project.** File tree and read-only code view, rooted in the
  directory a dev server is running in.

## Running it

```sh
bun install

# Terminal UI of the data, as a sanity check
bun run start            # server on :7717, serves the built web app

# Development: vite on :5173, server on :7717
bun run dev &            # the kururu server
bun run dev:web          # the UI

# The Electron window (starts the server itself if one is not up)
bun run dev:desktop
```

Then `http://localhost:5173` in dev, or `http://localhost:7717` after
`bun run build`.

### From your phone

There is no auth in kururu and there does not need to be — it is meant to be
reached over a tailnet, never off one:

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:7717
```

Preview proxies get their own ports (7800 and up); serve each one you want
reachable the same way. Kururu never runs `tailscale` for you: putting a port on
your tailnet is your decision to make, not a side effect of opening a tab.

## Layout

```
┌──────────────────────────────────────┐
│ ☰   profile                Code│Prev │
├──────────────────────────────────────┤
│                                      │
│   dev server preview, or a file      │
│   (both mounted, one visible)        │
│                                      │
├──────────────────────────────────────┤
│ ▁▁▁  claude ● │ codex ● │ shell      │  ← drag to resize
│ agent screen…                        │
│ [ say something…            ] [Send] │
└──────────────────────────────────────┘
```

## Shape

```
shared/     protocol types: ghosttown's (mirrored) and kururu's own
server/     Bun. Daemon link, dev-server discovery, preview proxy, file API
web/        React + Vite. Desktop and phone, one codebase
desktop/    Electron main + preload. ~200 lines; it opens a URL
```

See [PLAN.md](./PLAN.md) for why it is arranged this way.
