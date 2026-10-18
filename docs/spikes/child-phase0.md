# Child phase 0 — the spike on the Omarchy PC

Phase 0 of [the parent-child plan](../plans/kururu-parent-child.md#phase-0--a-spike-on-the-box),
run on 2026-10-18 against `17d2db4`, by hand, in an isolated instance under
`/tmp/k2` on the box, reached over Tailscale SSH (no browser approval was
asked for). Nothing in the code was changed; this file is the whole output.
Every file and line below is at `17d2db4`, the commit the box ran; `main` has
moved since.

The short version: the bundle installs, builds and serves on Linux without a
single change, and a pty host on Linux holds agents through a server restart.
What breaks is everything that reaches the server by loopback once it is bound
to the tailnet address, everything that finds the host with `lsof`, and the
first contact of a new device with a shared server — which is not a Linux bug
at all and very likely bites the Mac too.

## The box, as found

Omarchy, kernel 7.2.5, systemd 261 with the user manager lingering. node
**26.12.0** through mise (the plan's appendix says 26.8.2; both are installed
and the global config asks for `26`), bun 1.4.3, Claude Code 2.1.299, `lsof`
absent. Port 7817 free; 7727 is held by something else. The login shell's
non-interactive `PATH` is `/usr/local/bin:/usr/bin:/bin`, so node is named by
its full path. Omarchy's `~/.local/bin/claude` is a wrapper that runs
`mise use -g claude` and then `mise x claude -- claude "$@"` — every launch
can rewrite the global mise config and install a newer Claude, which matters
below.

## What was run

```sh
git clone https://github.com/tonyjara/kururu.git /tmp/k2/src && git checkout 17d2db4
ELECTRON_SKIP_BINARY_DOWNLOAD=1 mise exec -- bun install    # 6 s, exit 0
mise exec -- bun run build                                  # 2 s, exit 0
ls node_modules/node-pty/build/Release/pty.node             # there, 75 888 bytes

KURURU_PORT=7817 KURURU_HOST_SOCK=/tmp/k2/ptyhost.sock \
KURURU_STATE_DIR=/tmp/k2 KURURU_DATA_DIR=/tmp/k2/data \
XDG_CONFIG_HOME=/tmp/k2/config XDG_STATE_HOME=/tmp/k2/state \
XDG_DATA_HOME=/tmp/k2/xdgdata XDG_CACHE_HOME=/tmp/k2/cache \
KURURU_BIND=100.101.102.103 KURURU_AGENT_CWD=/tmp/k2/work \
setsid nohup ~/.local/share/mise/installs/node/26.12.0/bin/node \
  server/run.mjs --no-build --entry desktop/dist/server.mjs
```

That is more environment than the plan's line, on purpose: four modules ignore
`KURURU_STATE_DIR` (failure 6), so without `KURURU_HOST_SOCK` and
`XDG_STATE_HOME` the socket and the hook file would have landed in the box
user's `~/.local/state/kururu`. `XDG_DATA_HOME` and `XDG_CACHE_HOME` were
set after reading `voice.ts` and `voicelab.ts`, and turned out to be what kept
mise's side effects in `/tmp/k2` (failure 7).

`bun install` printed "Saved lockfile": `bun.lock` still names the workspaces
at `0.2.0` while the package files say `0.4.0`, so every install on a fresh
clone dirties the tree. `--frozen-lockfile` passes regardless. The build
printed only vite's chunk-size warning and `talkkey: macOS only, skipping`.

## The start

stderr was **empty**, from the start and through a later restart. stdout:

```
kururu: no database at /tmp/k2/data/kururu.db, so a new one was made
kururu server  http://localhost:7817  (v0.4.0)
  agents       0 held by the pty host
  web app      /tmp/k2/src/web/dist
  reachable    from other machines, with the token from the Share dialog
```

`lifecycle.log`: the runner started, the server "started a pty host (pid
1777799), because none was answering", and listened on `:7817`. The host's
log says only `kururu pty host  /tmp/k2/ptyhost.sock`. Process titles work
on Linux (`Kururu server :7817`, `Kururu ptyhost - no agents`,
`Kururu runner (run.mjs)`), which is also why `pgrep -f` on a path finds none
of them.

## The phone checks

Driven from the Mac over the tailnet by a WebSocket client of the isolated
server (the same messages the page sends, at a 60×30 grid, with a headless
emulator replaying the stream), because the page itself could not get a new
device in (failure 1). One line each:

- **`sleep 30` tab** — opened as `a2` in `/tmp/k2/work`, drew, ended after 30 s, and its tab left the layout by itself. Works.
- **Claude tab** — opened, stopped at Claude's folder-trust prompt for `/tmp/k2/work`; trusted, it came up as Claude Code 2.1.302, Opus 5.5 · Claude Max, signed in, drawn correctly at phone width. Its status stayed `idle` for good: no hooks (failure 3).
- **The harness** — opened with Opus 5.5 at high effort, stopped at a trust prompt for its own home, `/tmp/k2/data/harness/<key>`; trusted, `/mcp` lists `kururu` as **✘ failed** — every kururu tool is gone (failure 2).
- **The page** — with a cookie already exchanged, `index.html` and the bundle load and the app reaches "Connecting to the kururu server…" in headless Chrome at 390×844, and a hand-made upgrade with the page's `Origin` and the cookie gets `101`. Opened the way the QR code opens it, from a fresh browser, it is a blank page (failure 1). Not yet seen on a real phone.

The server's own restart was checked too: `SIGUSR2` to the runner gave a new
server in 0.2 s, the same host pid, and all three agents still there. On
Linux the cheap restart is cheap.

## systemd

- **`systemd-run --user` works** from the ssh session and from inside a kururu pty: `--unit=kururu-spike-… --collect --property=KillMode=process` gave `user@1000.service/app.slice/kururu-spike-….service`, `is-active` answers. Tailscale SSH sets `DBUS_SESSION_BUS_ADDRESS` but not `XDG_RUNTIME_DIR`, and either one is enough; with neither it fails with "`$DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined`". A unit under the user manager has both, so the only exposure is a server started by hand from a stripped environment.
- **`systemd-creds --user encrypt` works** without sudo: encrypt, decrypt, and a refused decrypt under the wrong `--name`. Decrypting works from inside a transient user unit, both by calling `systemd-creds --user decrypt` and through `-p LoadCredentialEncrypted=name:path`, which hands the plaintext in `$CREDENTIALS_DIRECTORY`. `--with-key=host` works too. The `.cred` file is written under the umask (0644); it is ciphertext, but phase 4 should still write it 0600.
- **Where the host is today:** the detached spawn put it in the cgroup of the ssh session that started the runner, `session-c8118.scope`, which sat in state `closing` after that ssh exited. It survives only because logind's `KillUserProcesses` is `false` on this box. That is the Linux form of the coalition: whatever ends that scope ends every agent.

## Failures, with file and line

1. **A new device cannot get in through the Share URL.** `/?k=…` serves
   `index.html` but sets no cookie (`server/src/index.ts:5268`, the gate, and
   `:5306`, the only `Set-Cookie`), so the module script it loads,
   `/assets/index-*.js`, goes out with neither token nor cookie and is refused
   `403`; the exchange that would set the cookie lives in that bundle
   (`web/src/access.ts:35`) and never runs. The QR code encodes exactly that
   URL (`web/src/components/Reach.tsx:185`). Reproduced from a fresh headless
   Chrome profile; going to `/api/access?k=…` first and then `/` works. The gate
   is the same on the Mac, so a phone pairing a Mac for the first time should
   hit it too — a phone with a year-long cookie would not notice.
   `manifest.webmanifest` is also `403` with a cookie, because a manifest is
   fetched without credentials, so Add to Home Screen gets no manifest.
2. **Everything that talks to the server by loopback is cut off once
   `KURURU_BIND` names the tailnet address**, because nothing listens on
   `127.0.0.1` then (`curl 127.0.0.1:7817` → connection refused). The harness's
   MCP URL (`shared/harness.ts:978`) — the harness has no tools; the web tools'
   URL (`shared/web.ts:803`); the hook reporter (`server/src/report-cli.ts:135`
   –`137`); `server/status.mjs:43`, which reports a running server as "down";
   `server/reload-window.mjs:72`; `server/src/backup-cli.ts:23` and `:44`. The
   plan's 1A covers the token for these callers; it also needs them to *reach*
   the server — a loopback listener beside the tailnet one, or the bound address
   handed to them.
3. **Claude tabs on the box get no hooks.** `--settings` is passed only while a
   profile has its own login (`server/src/index.ts:1636`); otherwise kururu
   relies on the reporter installed by hand in `~/.claude/settings.json`, and the
   box's has none. So no context ring, no amber dot, and no `done`/`blocked` edge
   to the harness. (With failure 2 fixed the hooks would still have to be put
   there.)
4. **Nothing finds the host, because `lsof` is absent.**
   `server/src/lifecycle.ts:166` (`socketHolder`): `POST /api/host/restart`
   answers `409 "nothing is holding the pty host's socket"`
   (`server/src/index.ts:6960`). `server/src/lifecycle.ts:277` (`socketHeld`)
   answers null, so a dropped link cannot be told apart. `server/status.mjs:64`
   calls a live host "stale — a socket with nobody behind it", and
   `server/status.mjs:151` asks `launchctl`. `server/kill-hosts.mjs:89`:
   `kill-ptyhosts --list /tmp/k2/ptyhost.sock` says "No pty host matches", so the
   plan's own cleanup step does not work on Linux. `server/src/devservers.ts:335`
   and `:436` find no dev servers. `ss -xlpH` names the holder
   (`users:(("Kururu ptyhost ",pid=…))`) and `/proc/<pid>/cwd` is already used
   by `server/src/cwd.ts:34`.
5. **The host is spawned detached into the starter's cgroup**
   (`server/src/index.ts:6825`), as above — the launchd branch at `:6814` is
   darwin-only and there is no Linux one yet.
6. **`KURURU_STATE_DIR` is not honoured everywhere.** `server/src/hostsock.ts:46`,
   `server/src/hooks.ts:121`, `server/src/persist.ts:149` and
   `server/src/machines.ts:86` read `XDG_STATE_HOME` instead. The plan's start
   line, run as written, would have put the socket in `~/.local/state/kururu`.
   And `server/src/config.ts:28` takes the config directory only from
   `XDG_CONFIG_HOME`, so isolating the config means changing it for every pty.
7. **kururu's environment reaches every pty, and on this box that rewires
   mise.** The host is spawned with the whole of `process.env`
   (`server/src/index.ts:6830`), so each shell had `XDG_CONFIG_HOME=/tmp/k2/config`,
   `KURURU_BIND`, `KURURU_HOST_SOCK`, `KURURU_SUPERVISED`,
   `KURURU_STARTED_BECAUSE` and the rest. mise reads its global config from
   `XDG_CONFIG_HOME`, so in a kururu shell `node` failed ("`node is not a valid
   shim`"), and Omarchy's Claude wrapper ran `mise use -g claude` into
   `/tmp/k2/config/mise/config.toml` and downloaded Claude 2.1.302 into
   `/tmp/k2/xdgdata` — contained only because those were set too. A real child
   sets none of them; an isolated instance on Linux wants a `KURURU_CONFIG_DIR`
   rather than XDG overrides. `KURURU_PORT` reaching the pty is load-bearing
   (`report-cli.ts` reads it); `KURURU_SUPERVISED` reaching it is not, and an
   agent running `bun run dev` in a kururu checkout inherits it.
8. **A headless server has no way to show its token.** With `KURURU_BIND` set,
   `bindAddress` never calls `load()` (`server/src/access.ts:120`) and
   `hasToken` returns before `token()` when nothing is presented
   (`server/src/access.ts:218`), so `access.json` is not written until something
   asks — and the only askers are a window's Share dialog and loopback, neither
   of which a child has. The spike wrote `access.json` by hand (0600, its own
   token) before the first request; `writeConfigFile` would have written it under
   the umask, 0644 (`server/src/config.ts:60`, called from
   `server/src/access.ts:97`), for a token that is a shell. The banner says
   `http://localhost:7817` while nothing listens there and points at "the Share
   dialog" (`server/src/index.ts:6718`).
9. **Claude's folder-trust prompt stops the first start** of both a Claude tab
   in a new directory and the harness in its new home
   (`server/src/harnesshome.ts:37`). On a phone it is one tap; for an unattended
   child it is a harness that is not there until somebody looks.

## What phase 1A should fold in

- **Reach before token.** When `KURURU_BIND` names an address, also listen on
  `127.0.0.1` (the plan's `KURURU_LOOPBACK_TOKEN` then guards it) — or hand the
  bound address to every caller in failure 2. One of the two has to be in 1A,
  or the harness on a child has no tools and no agent reports.
- **The Share URL must work from a fresh device** (failure 1), and it belongs
  in 1A rather than later because it is the Mac's bug as well: set the cookie on
  any request that presents a valid `?k=`, or let `index.html`'s own assets
  through and gate only `/api` and `/ws`. Send the manifest with
  `crossorigin="use-credentials"` or let it through.
- **`sockowner` covers every `lsof` in failure 4**, not only `status.mjs` and
  `kill-hosts.mjs`: `lifecycle.ts`'s `socketHolder` and `socketHeld` decide the
  host restart and the dropped link. `ss -xlpH` for sockets, `ss -ltnpH` for
  `devservers.ts`, as planned; `status.mjs` should print `unit` in place of
  `coalition` off darwin, not call `launchctl`.
- **The systemd-run branch as planned** — it worked as written — plus a check
  that `XDG_RUNTIME_DIR` or `DBUS_SESSION_BUS_ADDRESS` is set, setting
  `XDG_RUNTIME_DIR=/run/user/$UID` when neither is, before falling back to the
  detached spawn and its "shares the session's cgroup" note.
- **`KURURU_STATE_DIR` everywhere** (failure 6) and a `KURURU_CONFIG_DIR`, so an
  isolated instance stops needing XDG overrides that leak into ptys; and strip
  the runner's own variables (`KURURU_SUPERVISED`, `KURURU_STARTED_BECAUSE`,
  `KURURU_BIND`, `KURURU_HOST_SOCK`) from the pty environment while keeping
  `KURURU_PORT` and `KURURU_AGENT_ID`.
- **Mint the token at startup when shared**, write `access.json` 0600, and print
  the URL in the banner with the bound address instead of `localhost` — 1B's
  wizard then has something to show as a QR code in the terminal.
- **Hooks without the hand install**: pass `--settings` whenever the Claude
  directory in use does not already run the reporter (`runsReporter` exists for
  exactly that test), not only under profile logins.

For 1B rather than 1A: the wizard should pre-answer or at least report the
trust prompt for the harness home (failure 9); `kururu child update` should
expect `bun.lock` to be dirty until it is regenerated and committed on the Mac;
and the doctor's node check should name the version mise actually resolves.

## What was touched outside `/tmp/k2`

Claude Code, being run, wrote what it always writes: trust entries for
`/tmp/k2/work` and the harness home in `~/.claude.json`, and transcript folders
under `~/.claude/projects/` for those two directories. The first Claude tab was
ended at the trust prompt by the driver's own mistake and trusted nothing.
Nothing else in the box user's home changed: no `~/.config/kururu`,
`~/.local/state/kururu` or `~/.local/share/kururu`, the real mise config and
installs untouched, no tmux session, container or service of the user's
touched, and no sudo. Three transient units, `kururu-spike-ssh`,
`kururu-spike-pty` and `kururu-spike-rtdir`, were run with `--collect` and are
gone.

## Cleanup

Pending the phone check: the isolated instance is still up on the box at
`http://100.101.102.103:7817`. `kill-ptyhosts` cannot do it (failure 4), so the
host goes by its socket's holder from `ss`, the runner by its pid, and
`/tmp/k2` is removed, since it is RAM on this box (`/tmp` is tmpfs).
