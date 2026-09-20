# Gotchas that have already cost time

Things that fail with an error naming something other than the cause.

## Install and build

- **`bun install` strips the executable bit off node-pty's `spawn-helper`.** The
  prebuilt helper lands as `0644` and every spawn then fails with a bare
  `posix_spawnp failed` that names nothing at all. `desktop/build.mjs` chmods it on
  every build, which is why that fix lives in the build and not in a README.
- **`bun add --cwd <workspace>` creates a nested lockfile and `node_modules`**
  instead of hoisting. If deps go missing or duplicate:
  `rm -rf */node_modules */bun.lock node_modules bun.lock && bun install` from the
  root. Never commit `web/bun.lock` or `desktop/bun.lock`.
- **TypeScript is pinned to ^5.8** everywhere. `bun add -d typescript` will pull
  v7 (the Go rewrite); keep the workspaces on one version.

## Running

- **Anything Electron you launch from a shell inside kururu runs as Node.** The
  server is started with `ELECTRON_RUN_AS_NODE=1`, and every pty underneath
  inherits it — every shell, every agent, everything either runs. So `electron .`
  in a kururu terminal starts Node: `require("electron")` returns the *path to the
  binary* instead of the API, and the first line touching `app` dies with `Cannot
  read properties of undefined`. A packaged .app launched the same way is worse —
  it exits instantly with an empty log — and `--remote-debugging-port` comes back
  from Node's own parser as `bad option`. Three symptoms, one cause, none of them
  names it. `env -u ELECTRON_RUN_AS_NODE` is the fix. The tell, when a stack trace
  is all you have, is a Node version Electron does not embed.
- **`EADDRINUSE` on 7717 means a stale server**, usually from an earlier turn. Not
  a code bug: `pkill -f "server/run.mjs"; pkill -f "desktop/dist/server.mjs"`. The
  pty host is deliberately *not* in that list — killing it is the one thing that
  costs agents.
- **`EINVAL` from `listen` on a unix socket means the path is too long.** macOS
  gives `sun_path` 104 bytes and complains about nothing else, so the error names
  no limit and reads exactly like a bug in the caller. `hostsock.ts` checks the
  length and says so; a `KURURU_HOST_SOCK` pointing somewhere deep is how you find
  out.
- **`pkill -f ptyhostd` is not reliable here.** macOS `pgrep -f` was observed
  matching two scratch hosts while consistently skipping the real one, with
  `ps -ww` showing an identical command line for all three. A `pkill` that
  silently matches nothing reads exactly like a host that restarted and did not
  pick up your change. Find a host **by its socket**:
  `kill $(lsof -t ~/.local/state/kururu/ptyhost.sock)`, or use
  `bun run kill-ptyhosts`, which does that and asks first.
- **macOS `/tmp` is a symlink to `/private/tmp`** — two strings for one directory.
  `files.ts` realpaths roots on *both* sides for this reason; do not "simplify" it
  back to a string compare.
- **`ws` hands you a Buffer for text frames too.** The `isBinary` argument is the
  only thing that distinguishes them; relaying without it turns every HMR message
  into a binary frame the dev server ignores. Bun's WebSocket did this for us and
  the port did not.

## When the whole machine misbehaves

**Kururu is usually the thing that shows it, not the thing doing it.** A renderer
killed by macOS looks identical from inside the app to a bug in the app, and the
tell is that it takes other programs with it — browser tabs going at the same
moment means jetsam, not kururu. `/Library/Logs/DiagnosticReports/JetsamEvent-*.ips`
names every process and its footprint at the moment of the kill, and
`sysctl vm.swapusage` says whether the machine is still in that state. Check those
before debugging the window.

Observed once: three `../ghosttown` daemons had grown to 11 GB, 11 GB and 3.5 GB
(roughly 200–300 MB per hour of uptime, swapped out, so `ps` showed them under
100 MB of RSS and hid it) and saturated swap. **That is ghosttown's to fix, not
kururu's** — it has been raised with the user rather than edited across.

## A black window is a symptom with several causes

Flat `--bg` with nothing on it is what you get from a React root that unmounted, a
renderer the OS killed, a server that never answered, and a sleeping display —
same picture, different fixes, and guessing between them is what makes this class
of bug expensive. Two of them now name themselves:

- `Crash` (`web/src/components/Crash.tsx`) wraps the root so a render that throws
  prints the error and the component stack. It deliberately does not retry,
  because a component that throws every render would spin; the only way out
  offered is a reload.
- `render-process-gone` in `desktop/main.js` covers the case where there is no
  page left to report anything. It **asks** before reloading rather than reloading
  itself: a fresh renderer allocated while the machine is still out of memory is
  killed too, and an automatic retry under real pressure is a loop.
