# Testing

## What `bun test` covers

Pure functions and a temp directory. **No test should spawn a real agent CLI.**

`procs`, `report`, `status`, `files`, `workspaces` (holds a tree, touches no pty),
`sizing` (a fold over some numbers, which is the whole size policy), `hostsock`
(two ports over a socket, no pty anywhere), `notify` (the gate, the words, and
what a hand-edited settings file can say), `access` (the token from each of the
three places one can arrive, and the cross-origin refusal — the case that works
against a kururu nobody shared), `update` (which of two versions is newer,
including the prerelease rule and the one where 0.10 is not smaller than 0.9),
`sounds` (the catalogue against a temp directory), `cursor` (DECSCUSR and OSC 12
in both directions, every spelling of a colour, a sequence cut in half by a read
boundary, and that the two directions round-trip), `styles` (the registry format
and every check applied to a manifest a stranger wrote — no network, no disk),
`screen` (serialize, rebuild, compare the buffers; and the hidden cursor),
`layout` (asserting *through* `JSON.stringify`), `markdown` (the reader's whole
security story: that raw HTML cannot be emitted and that no `href` or `src`
carries a scheme the browser would run — the one test that drives a real
dependency, since Shiki's wasm has to load), and the pane tree in `web/test`,
including that a number arriving from a client cannot enter the tree unless it is
one, and `grid`, which holds the clamp-floor refusal.

`web/test/theme.test.ts` holds both style axes in both directions, and then
whether the result can be *read* — every colour pair the stylesheet states,
against every theme, ratcheted against the nineteen that are under their floor
today. `contrast` is the arithmetic under it and the two ways it declines to
answer. See [styles](styles.md).

## Testing by hand

**Spawn something harmless.** `create-agent` takes a `command`, so use `sleep 30`
or `cat` rather than `claude`, and spend no tokens proving that plumbing works.

**Check whether a server is running before you start** —
`curl -s localhost:7717/api/health` — and say what you are about to disturb.

## The isolated instance

Anything that writes to config, installs a style, or acts as a second real client
goes in an isolated instance rather than against the user's server. A second real
client resizes their live agents; an install writes into their `~/.config/kururu`.

```sh
KURURU_PORT=7817 \
KURURU_HOST_SOCK=/tmp/k2/ptyhost.sock \
KURURU_STATE_DIR=/tmp/k2 \
XDG_CONFIG_HOME=/tmp/k2/config \
KURURU_STYLES_URL=http://127.0.0.1:8899
```

Registry testing serves the sibling checkout with
`python3 -m http.server 8899 --bind 127.0.0.1` from `../kururu-styles`, and a
scratch copy under `/tmp` is where `build-index.mjs` is run — never in the
checkout.

**The one trap in the isolated instance:** it sets `XDG_CONFIG_HOME`, and **nvim
reads its config from there too**. So nvim comes up with no colourscheme and no
per-mode cursor colours at all, which reads exactly like the cursor feature not
working. `XDG_CONFIG_HOME=$HOME/.config nvim` on the command line is the fix —
kururu stays isolated and nvim does not.

## What has been verified end to end

Kept short on purpose; the detail is in git history.

- **The three-process split**, against a real pty: the server spawns a detached
  host when none is listening; input and output round-trip with escape sequences
  intact; the server is killed and restarted and the agent comes back with **the
  same id and the same pid**; `C-a B` does the same through `run.mjs` and the
  host's pid never moves; a SIGKILLed host leaves a socket the next server
  recognises as a corpse; a SIGTERMed host reaps its ptys and unlinks. The desktop
  was left on the picker with nothing reachable, a server was started elsewhere,
  and the window found it within the second.
- **The pty layer:** spawn / type / kill / exit with process-group teardown, the
  status heuristic through a real pty, resize reaching the pty (`stty size`
  agrees), unwatched terminals not streaming, history surviving being unwatched.
- **The server owning the size:** one client's proposal comes back unchanged; a
  narrower second client takes the pty to the smaller of the two and **both** are
  told; each dimension is taken on its own; a client that stops looking hands the
  size back and a warm one never has a vote; a `watch` alone produces no backlog;
  a terminal nobody can see keeps its shape; an exited terminal's screen still
  reflows.
- **The hierarchy and dragging:** tabs stack and reorder, splits inherit the
  project, `focus-dir` crosses splits and stops at the edge, workspaces jump by
  number, a restart brings back names / splits / cwds with **nothing respawned**.
  A tab crosses panes and workspaces and splits a pane on the edge it was dropped
  on; a pane swaps without deepening the tree; a pane a drag emptied is pruned
  while a deliberately empty one stays.
- **Dev servers:** discovery from both ends, restart in the same tab, recovery in
  a fresh one after a cold start; the preview proxy including HMR websockets with
  subprotocol negotiation; traversal-safe file browsing.
- **Styles:** installing a theme, a skin, a mascot and a pack writes and
  activates; `/api/styles/asset` serves a font and refuses a traversal;
  `/api/styles/preview` proxies a sheet; `1.10.0 > 1.0.0` the right way round;
  removing a style leaves the id in `appearance.json` and falls back at draw time.
  The registry's own rules were exercised in a scratch copy: a changed colour
  under an unchanged version refused, a remote `url()` refused, a mascot clip
  running off its sheet refused.
- **The studio:** a skin created from nothing was worn at once, a PNG posted to it
  came back with its size, forking Handheld copied its pictures and re-pointed the
  manifest, a registry install over a local skin of the same id was refused, and a
  non-PNG, a path and an upload to a registry skin were each refused with a
  sentence.
- **Notifications:** a `blocked` report with nobody watching raised a card on both
  clients; a second transition inside the throttle was dropped; with one client
  watching and one not, **the watching one was not interrupted and the other
  was**. `reveal-agent` crossed profiles and prefix+z still went back.
  `Frog.aiff` decoded as WAV — the whole reason `sounds.ts` exists, since the same
  file decoded from disk throws.
- **The unread mark**, once it stopped meaning bytes: a shell bursting for six
  seconds and then going quiet was **not** marked while merely working, was
  marked the moment it reached `done` with nobody watching, and lost the mark
  when a client watched it. Done *while visible* left no mark at all, a
  chattering off-screen terminal stayed unmarked for as long as it chattered,
  typing into a marked one took the mark off as its status left `done`, and a
  terminal only the *second* client could see counted as seen by both.
- **The cursor:** nvim under its real config drew a rosewater block in normal, a
  grey bar in insert, a purple block in visual; `OSC 112` put the theme's cursor
  back on quit; and a **window reload — every emulator new — came back drawing the
  bar**, which is the half only the reconstruction can be wrong about. The
  character was legible through the block throughout.
- **The file tree and the editor handoff**, in an isolated instance with its own
  vite and a headless Chrome over CDP: the tree followed a new terminal into its
  repository; a markdown click split off a reader and a second click reused it;
  a file named `it's a file.ts` opened in a new nvim split titled `nvim`, and a
  second file went to that nvim with `:drop` (asked back over its socket);
  editors came back focused-pane first; a `..` path was refused. A double-clicked
  list gained an item and the file on disk changed in those lines only; a stale
  version got a 409, a `.json` and a root outside the allowed set a 400, and a
  foreign `Origin` a 403. At 390px wide the tree was a sheet and a code file
  raised the nvim prompt.
- **The gate**, checked from the LAN address so requests genuinely arrived from a
  non-loopback peer: no token 403, wrong token 403, right token 200;
  `/api/access` returned a cookie that then worked alone; a valid token with an
  `Origin` of `https://evil.example` was refused; loopback needed nothing.
- **Packaging:** the signed, notarized DMG checked the way a stranger's Mac will —
  quarantined, mounted, `spctl` answering `accepted, source=Notarized Developer
  ID`. From inside the `.app`: the window started the bundled server, which
  spawned a detached host whose parent is pid 1; `web/dist` and `assets` resolved
  out of `Resources`; SIGTERM took the server and left the host running.
- **The updater**, over CDP against the packaged app: the bridge answers `idle`
  rather than `unavailable`; a feed whose newest release is the running version
  found nothing newer; the same build packaged as 0.0.9 downloaded the real 0.1.0
  zip, 0% to 36% in four seconds, so `download-progress` genuinely fires.

**Not yet proven in place:** a card raised by the *heuristic* `done` rather than
by a report, and a click on a real OS notification — neither can be driven from a
script.
