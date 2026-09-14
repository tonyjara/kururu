# Working in kururu

Read this before touching anything. `PLAN.md` has the *why* (design principles,
architecture, roadmap); `README.md` has usage. This file is the operational
brief: what will bite you, and what you must not break.

## What this is, in one paragraph

Kururu is a **GUI front-end for [ghosttown](../ghosttown)**, the agent-first
terminal multiplexer in the sibling directory. Ghosttown is a TUI and therefore
cannot render markdown, images, or the app you are building; kururu is the other
half — the same agents, in a window that can draw — and it is reachable from a
phone over Tailscale, where it is for **watching and steering agents, not for
writing code**. It is a separate repo but *not* a fork: it is a **client** of
ghosttown's control socket.

## The rules that matter most

1. **Never modify `../ghosttown` from this project.** Kururu works with the
   protocol that is already there. If something genuinely needs a daemon-side
   change, write it down in `PLAN.md` → Open Questions and raise it with the
   user; do not reach across and edit it.
2. **One daemon.** Kururu must never spawn its own pty host or its own copy of
   ghosttown's state. Everything comes over the unix socket. Two daemons would
   silently give the user two disjoint sets of agents, which is the failure this
   whole architecture exists to prevent.
3. **Never unmount the preview iframe or a terminal view on tab switch.** Hide
   it (`hidden`, CSS). Remounting reloads the dev server view and loses whatever
   state the app under test was in — usually the exact thing the user was
   looking at. Ghosttown learned this same lesson with its surfaces.
4. **Do not run `tailscale` commands.** Putting a port on the user's tailnet is
   their decision, never a side effect of a code change. Document the command;
   do not execute it.
5. **Do not run git commands automatically.** No commit, no push, no `git init`,
   unless the user explicitly asks. (Standing preference of this user.)

## ⚠️ The live-daemon hazard

**The kururu server connects to the user's real, in-use ghosttown session by
default.** `DaemonLink` opens `/tmp/ghosttown-<uid>/<profile>.sock`, and the
protocol it speaks includes `send-text`, which types into a live agent's pty.

That means a careless test can send keystrokes into the agent the user is
actually working with.

- Pick the profile explicitly: `KURURU_SESSION=<name> bun run start`.
- To isolate completely, point the whole thing at a different socket dir:
  `GHOSTTOWN_SOCKET_DIR=/tmp/gt-test` (honoured by `shared/ghosttown.ts`).
- `list`, `read-screen` and `ping` are read-only and safe to poke at.
  `send-text`, `focus`, `select-tab` are **not** — they mutate the user's
  session.
- `bun test` only exercises pure functions and a temp directory. Keep it that
  way; no test should open the control socket.

At the time of writing the user runs two profiles: `main` and `MV`.

## Layout

```
shared/      Protocol types. No runtime deps, imported by every other package.
  ghosttown.ts   Ghosttown's control protocol, MIRRORED (see below)
  wire.ts        Kururu's own browser↔server protocol + poll intervals
server/      Bun. The only stateful process.
  daemon.ts      Persistent unix-socket link to ghosttown, with reconnect
  devservers.ts  lsof + ps discovery of running dev servers
  proxy.ts       Per-dev-server reverse proxy (HTTP + WS) for phone access
  files.ts       Traversal-safe file listing/reading
  sockbuf.ts     Partial-write-safe socket writer (copied from ghosttown)
  index.ts       Bun.serve: HTTP + WS + static, and the poll loops
web/         React 19 + Vite. Desktop and phone, one codebase, one build.
  session.ts     Module-level store + useSyncExternalStore; the WS client
  App.tsx        Layout: top bar / main slot / agent panel / sidebar
desktop/     Electron main + preload. ~200 lines. It opens a URL.
```

### `shared/ghosttown.ts` is a mirror, and will drift

Kururu and ghosttown are separate repos, so ghosttown's types are **copied**
here, not imported. The protocol is documented (in ghosttown's
`src/control/protocol.ts`) as *additive*, so a copy drifts by **missing new
fields**, never by disagreeing about old ones. When you need a field that isn't
here, check `../ghosttown/src/control/protocol.ts` and
`../ghosttown/src/core/types.ts` and copy it across. This file is the single
place to reconcile — do not scatter ad-hoc type assertions elsewhere.

## Commands

```sh
bun install            # from the ROOT. See the workspace gotcha below.
bun run dev            # server on :7717 (KURURU_DEV=1 — does not serve the UI)
bun run dev:web        # vite on :5173, proxying /api and /ws to 7717
bun run dev:desktop    # Electron; starts a server itself if none is up
bun run start          # server on :7717, serving web/dist
bun run build          # vite build → web/dist
bun run typecheck      # root tsconfig + web tsconfig
bun test               # pure-function tests only
```

**Ports:** 7717 server · 5173 vite · **7800+** preview proxies (one per dev
server, allocated on demand).

## Gotchas that have already cost time

- **`EADDRINUSE` on 7717 means a stale server is still running**, usually from
  an earlier turn. It is not a code bug. Kill it and retry.
- **`pkill -f "kururu/server/src/index.ts"` does not match.** The process argv
  is `bun run server/src/index.ts` — the directory is the cwd, not part of the
  command line. Use `pkill -f "server/src/index.ts"`.
- **macOS `/tmp` is a symlink to `/private/tmp`.** Two different strings for one
  directory. `files.ts` realpaths roots on *both* sides for this reason; do not
  "simplify" it back to a string compare.
- **`bun add --cwd <workspace>` creates a nested lockfile and `node_modules`**
  instead of hoisting. If deps go missing or duplicate, `rm -rf */node_modules
  */bun.lock node_modules bun.lock && bun install` from the root. Never commit
  `web/bun.lock` or `desktop/bun.lock`.
- **`Bun.serve<T>` takes one type parameter** in Bun 1.2.15. A second (`<T, {}>`)
  fails to typecheck.
- **TypeScript is pinned to ^5.8** everywhere. `bun add -d typescript` will pull
  v7 (the Go rewrite); keep the workspaces on one version.

## Invariants in the code

- **`files.ts`: resolve, check, realpath, check again.** The first check catches
  lexical `../`; the second catches a symlink inside the project pointing at
  `~/.ssh`. An escaping path is **refused, never clamped** — a clamped traversal
  is a bug that looks like it worked. Roots are only ever learned from places
  the server already knows (a dev server's cwd, `KURURU_ROOTS`), **never from a
  client**. Kururu is reachable from the tailnet; this is the one place a bug
  hands over something it should not.
- **`devservers.ts`: ports come from the kernel, never from the command line.**
  `npm run dev` names no port, and `vite --port 3001` lies the moment 3001 is
  taken and vite falls back to 3002. Also: the process holding the port is often
  *not* the one that names the server (`bun run dev` → `bun run serve.ts`), so
  `resolveDevCommand` walks **up** the process tree. Ghosttown solves the mirror
  image of this by walking down from a surface (`collectTree`).
- **`proxy.ts`: a port per preview, never a path prefix.** Dev servers emit
  absolute URLs (`/@vite/client`, `/src/main.tsx`), so `/preview/<id>/` breaks
  on the first asset. The extra hop also rewrites `Host` to the upstream's own
  — which is why no project needs `server.allowedHosts` added to be previewable
  — and strips frame-blocking headers. Electron does the header strip natively
  via `onHeadersReceived`.
- **`index.ts` polls because ghosttown cannot push.** Its control protocol is
  request/response only. The server diffs before broadcasting, so a quiet
  session sends nothing over the tailnet. When the daemon grows an event stream
  these loops become subscriptions and nothing above them changes.
- **`session.ts` reconnects forever.** The kururu server restarts on edit, the
  daemon restarts on ghosttown's prefix+R, and a phone drops the socket every
  time it sleeps. Disconnection is the normal case; render `connected`, do not
  throw.
- **The agent panel is a split, not a modal sheet.** The user talks to an agent
  *about* what is on screen above it ("this wraps at 390px"), so covering that
  would defeat the purpose. Its smallest snap point still shows the tab strip.

## Code style

Match ghosttown — the user writes in a distinctive register and kururu follows it:

- **Module-level doc comments that explain *why the module exists*,** not what
  it does. Look at `server/src/proxy.ts` or `devservers.ts` for the target.
- **Comments explain decisions and rejected alternatives,** in prose. "Ports
  come from the kernel because `vite --port` lies when the port is taken" — not
  "// get port".
- Prose, not bullet-fragments, inside comments. Full sentences.
- No comment that restates the code on the next line.
- TypeScript strict, `noUncheckedIndexedAccess` on. Tests cover pure functions.

## State of play

Working and verified against a live daemon: daemon link + RPC passthrough,
state push with diffing, dev-server discovery, preview proxy, agent panel
(tabs / status / context rings / `read-screen` / `send-text`), file tree and
read-only code view, Electron shell that adopts a running server.

Next, in order — details in `PLAN.md`:

1. Syntax highlighting (Shiki, **server-side**, so the phone gets markup)
2. Markdown + image rendering — *the original reason this project exists*
3. Transcripts as chat (needs the transcript path added to ghosttown's `list`)
4. Push notifications to the phone
5. The element picker injected by the proxy — long-press an element, send the
   selector and source location to the agent
6. xterm.js terminals, desktop breakpoint only — deliberately last

Known gap: dev servers are discovered machine-wide rather than attributed to the
surface running them, because ghosttown's snapshot does not carry `cwd`/`dev`.
See PLAN.md → Open Questions.
