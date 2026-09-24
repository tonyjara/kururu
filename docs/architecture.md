# Architecture

Kururu is **three processes, and the window is the least important of them.**

| process | holds | restarting it costs |
|---|---|---|
| **pty host** (`ptyhostd.ts`) | every pty, every headless emulator, an opaque blob of the arrangement | **every agent the user is running** |
| **server** (`index.ts`) | the protocol, the layout, discovery, the registry | a reconnect |
| **window** (`desktop/main.js`) | a window | a repaint |

The phone is the window's equal: both load the same build from the same server
over Tailscale. Quitting the window costs a window, and the server it was
looking at may not even be on this machine.

## Why the split

A live pty cannot be handed to a replacement process. So everything that would
otherwise make you restart the process holding the ptys is pushed to the other
side of a socket. The host holds ptys, emulators, and the arrangement **as a
blob it cannot read** — opaque on purpose, because the moment it knows what a
workspace is, changing what a workspace is means ending somebody's agents.

Anything that would make `ptyhost.ts` need editing belongs on the server side.

## The link

`~/.local/state/kururu/ptyhost.sock`, framed JSON (`hostsock.ts`), protocol in
`hostlink.ts`.

- **The host is spawned detached** — parent is pid 1, its own process group, no
  controlling terminal. That is the difference between "my agents die when I
  close the terminal" and "my agents are a thing on this machine". Nothing
  reaps it; it is stopped on purpose, by its socket, and its log is a file
  (`~/.local/state/kururu/ptyhost.log`) rather than somebody's stdout.
- **The two halves find each other at a path, not through a parent.** It was an
  Electron `MessagePort` once, which quietly made Electron the only thing that
  could arrange the split at all — with no Electron, `index.ts` built a host
  inside itself and the property the seam exists for silently did not hold.
- **A second connection replaces the first.** The host keeps one blob and
  pushes output to one place; two servers sharing that would each see the
  other's idea of the layout arrive as their own. A new socket is treated as
  what it almost always is: the same server, restarted, arriving before the old
  one's FIN did.
- **`ptyhost.ts`'s relay forwards the request whole and never names its
  fields.** `case "create"` spreads everything but `type` and `id`. It used to
  enumerate them, and that cost a restart nobody had budgeted for: `env` was
  added to `ToHost`, to `HostLink.create` and to `AgentHost.create`, and
  dropped at this one line between them. Nothing complained — passing fewer
  properties than an optional parameter accepts is perfectly good TypeScript —
  and the symptom was three rooms away. A change to what a pty is spawned with
  touches four files; three of them cost the agents. Do not reintroduce an
  enumeration here to "be explicit".

## Restarting

- **A restart is an exit code, not a signal.** `C-a B` cannot re-fork the
  process it is running in. The server exits 75 and `server/run.mjs` reads that
  as "start me again" — distinguishable from a crash, which is left down on
  purpose, because a supervisor that resurrects a server which cannot start is
  a loop that fills a terminal with one error forever. Unsupervised,
  `restart-server` says so rather than doing half of it.
- **A restarted server prefers the host's blob over the disk snapshot.** The
  blob is complete and a moment old, with every tab still pointing at a live
  pty; `session.json` is the cold-start fallback with processes deliberately
  stripped. Neither is trusted blindly — a tab pointing at a terminal the host
  does not have is dropped, and an agent the host has that no layout mentions
  is placed, because otherwise it is running with nothing pointing at it.
- **A restored profile is adopted, not trusted** (`adopt()` in `workspaces.ts`).
  The blob was written by the previous server, which across a rebuild may be a
  previous *version*, so a field added since is simply not there. `undefined`
  where the type promises `null` is invisible until something compares against
  null.
- **The host says which protocol it speaks, and the server believes it.**
  `hello` answers with the host's `version` and `HOST_PROTOCOL`; a host that
  says neither is at protocol 1. A server ahead of its host warns once, reports
  it in `/api/health` and the snapshot's `host`, and holds back anything the old
  host would silently drop — a `create` with an `env`, which is how profiles
  keep their own logins. Bump the number when a host change must be restarted
  into, and only then.
- **`adoptSeq` tells the id counter what a restored arrangement already holds.**
  `persist.ts` mints ids as it rebuilds, so the disk path walks the counter past
  its own work for free. The host's blob is the opposite: it carries ids, so a
  new process starts at zero with `n1` and `w2` already live and the next split
  hands out an id something is using. Nothing throws — a duplicate is a
  perfectly good string — and the symptom is two panes answering to one id.
  It renames nothing: repairing ids already in a blob means remapping
  `focusedPaneId` and `activeWorkspaceId`, which is a silent rewrite of
  somebody's live layout.

## Discovery, and the window giving up

- **An address is a decision, so it goes in config** (`servers.json`, beside the
  keymap). `127.0.0.1:7717` is a *built-in* candidate rather than a saved one,
  so "the local one" and "one I typed once" stay different things.
- **Discovery is polling**, because a server starting raises no event anything
  outside it can hear. It only sweeps while the picker is showing, which is what
  stops it moving you off a server you are already using.
- **`connect.html` is the one page kururu draws itself.** Everywhere else the
  window loads what the server serves. This is what is on screen when there is
  *no* server, and a page served by the thing you are looking for cannot tell
  you it is missing. It stays small enough never to become a second UI: the
  moment it can show an agent, it is one.
- **The picker's bridge and the app's bridge are split on `location.protocol`.**
  A preload is chosen when a window is built and cannot be swapped per
  navigation, so both live in `preload.js`. The picker may point this window at
  any address; the served page must never be able to — a served page that can
  call `connect()` is a redirect attack with none of the work.
- **The window gives up on a server; `session.ts` never does, and both are
  right.** The page reconnects forever because the server restarts on every save
  and a phone drops the socket every time it sleeps. But "forever" answers a
  *gap*, not a server that is not coming back. So the main process probes
  `/api/health`, and **strike count × interval is the whole design**: a
  `run.mjs` restart is one to three seconds of legitimate silence. Three strikes
  at three seconds is ~10s of confirmed silence. If you retune either number,
  retest the *negative* case — that is the expensive direction.
- **Status asks the server, never the host.** The host's socket takes one server
  at a time, so a status tool that asked it directly would knock the live server
  off its link. Hence `/api/agents`, and hence `status.mjs` saying "nobody can
  list the agents" when no server is up rather than inventing an answer.

## Access

The socket binds **loopback**, and being reachable is a decision. A downloadable
app is one double-click from somebody else's laptop, and a server on `0.0.0.0`
with nothing in front of it hands every device on the café Wi-Fi a shell with
your accounts signed into it. The Share dialog is what moves it — the same
argument that keeps `tailscale` commands out of kururu.

- **The bind address is read once and held.** Between pressing the button and
  the restart, the file says one thing and the kernel another; answering from
  the file would draw a QR code for an address nothing is listening on. Hence
  `shared` *and* `wanted` on the wire.
- **Loopback is exempt from the token** — anything that can connect from there
  can already start a shell.
- **The preview proxies bind the same address**, or kururu would be locked while
  the dev app beside it was not.
- **The `Origin` header is checked, and that one is not about the network.** A
  WebSocket is exempt from the same-origin policy and sends no preflight, so
  without it any page in any tab could open one to a *loopback-bound* kururu,
  read the snapshot and spawn a pty — RCE reached by clicking a link, against
  the configuration that looks safest. Absent means not a browser and is
  allowed. Present must be one of ours: same origin, loopback (vite forwards the
  browser's `Origin` untouched while rewriting `Host`, so the two cannot be
  compared in development), this machine's own addresses, and `*.ts.net`. It is
  checked **before** the token, because a foreign page holding a token it got
  hold of is precisely the case where the first check is the only one left.
- **The token is exchanged for a cookie, once, by the client.** It arrives as
  `?k=` because that is what a QR code can carry; `web/src/access.ts` hands it to
  `/api/access` before the socket opens. After that the browser attaches it to
  every fetch *and to the handshake* — the alternative is a header at eleven call
  sites, one of which would be missed, and the one missed would be an `<img>`.
  It leaves the address bar only when the exchange worked: a failure is nearly
  always the server restarting, which is exactly what turning sharing on does,
  and a phone left holding an address with no token cannot retry by reloading.

## The server's shape

- **`index.ts` pushes, and only times what cannot raise an event.** The server
  owns the ptys, so output is an event. The surviving timers are the ones that
  could not be events — end-of-work is *silence*, and the process table has to be
  asked — plus one that coalesces output at 16ms, because a pty mid-build emits
  thousands of writes a second and a socket should not.
- **Watched is two sets, and only one is "somebody is looking".** `watch`
  carries what a client has *visible* and what it is keeping an emulator for
  (*warm*); the host streams the union, because a pooled emulator that stops
  being fed has to be reconstructed, which is the whole cost pooling removes.
  Every pty is still *parsed* by its own emulator whether or not anyone is
  looking — that is what makes a pane opened later able to show history. Parsing
  is not rendering, and there is no renderer anywhere in the server.
- **`unread` is a notification nobody was there to receive, not bytes.** It was
  bytes, and that is what made it useless: a spinner or a dev server's log lit
  every row that was not the one visible tab and it stayed lit. It is now set by
  the same transition a card fires on — into `blocked` or `done`, for a terminal
  no client has *visible* — decided beside the card in `noticeStatuses`, and
  cleared by looking at the terminal or by its going back to work. The host still
  keeps a byte-derived flag of the same name; it is vestigial, `overlay`
  **replaces** it rather than oring it in, and it stays where it is because
  `agents/host.ts` costs the user every running agent to edit. Do not "finish the
  job" there.
- **`AgentSnapshot.activity` is the server's, not the host's.** Everything else
  in a snapshot is a fact about a process. A sentence about the *work* arrives by
  a different road (`POST /api/report`), is stale the moment the turn moves on,
  and nothing depends on it surviving. Keeping it on the restartable side means
  the line can be reworded without the edit costing anybody a running agent.
- **`record.ts` is for reading, never for replaying.** The last 128KB of one
  terminal's raw stream interleaved with what kururu did to it — resizes,
  watches, backlogs — because nearly every terminal bug is a disagreement about
  *ordering* and the bytes alone cannot show one. It is trimmed by budget and
  therefore starts mid-sequence: nothing may ever write it back to a terminal.
- **`devservers.ts`: ports come from the kernel, never from the command line.**
  `npm run dev` names no port, and `vite --port 3001` lies the moment 3001 is
  taken. The process holding the port is often not the one that names the server
  (`bun run dev` → `bun run serve.ts`), so `resolveDevCommand` walks **up** the
  process tree.
- **`proxy.ts`: a port per preview, never a path prefix.** Dev servers emit
  absolute URLs (`/@vite/client`), so `/preview/<id>/` breaks on the first asset.
  The extra hop rewrites `Host` to the upstream's own — which is why no project
  needs `server.allowedHosts` to be previewable — and strips frame-blocking
  headers. It proxies with `http.request` and a pipe, **not `fetch`**: fetch
  decodes the body but forwards `content-encoding` untouched, which ships a
  decompressed body still labelled gzip.
- **`files.ts`: resolve, check, realpath, check again.** The first check catches
  lexical `../`; the second catches a symlink inside the project pointing at
  `~/.ssh`. An escaping path is **refused, never clamped** — a clamped traversal
  is a bug that looks like it worked. Roots are only ever learned from places the
  server already knows (an agent's cwd, a dev server's cwd, `KURURU_ROOTS`),
  never from a client.
- **`markdown.ts`: `html: false` IS the sanitizer.** Server-side so the phone
  gets no parser.
- **`update.ts` checks and never installs.** See [packaging](packaging.md).
