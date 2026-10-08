# The file map

One line each. The *why* lives in the module doc comments and in the other files
in this folder.

## `shared/` — no runtime deps, imported by everything

| file | |
|---|---|
| `model.ts` | Agents and the hierarchy they live in. Not a mirror of anything |
| `wire.ts` | The browser↔server protocol, and the timer intervals |
| `layout.ts` | The split tree and every pure operation on it. Both halves use it |
| `harness.ts` | The harness's vocabulary: the MCP tool catalogue, the role prompt, key and paste grammar, inbox frames, transcript turns. Pure, tested |
| `board.ts` | A workspace's cards, and what an agent's status does to the one it was handed. Also the profile's board, a card's dates, and the timeline's layout |
| `days.ts` | Calendar days as strings, and the arithmetic over them. Why a card's date is not a timestamp |
| `projects.ts` | What a repository has been told about itself, and how a card's worktree is named |
| `keys.ts` | Every action, ghosttown's defaults, and a user's overrides |
| `labels.ts` | What to call a terminal and what to say it is doing — three places must agree |
| `notify.ts` | When kururu may interrupt you, and the words. Ported policy |
| `launchers.ts` | The agents and models the new-tab menu offers. Hand-kept; `/update-models` refreshes it |
| `cursor.ts` | DECSCUSR + OSC 12 in both directions. One parser over one stream |
| `theme.ts` | Every theme: the chrome's tokens and the emulator's ANSI palette |
| `skin.ts` | The shape tokens, the icon glyphs, and the twelve paintable parts |
| `styles.ts` | The registry's format, and every check on a stranger's manifest |

## `server/` — Node, not Bun (it was Electron's once and the bundles stayed)

**The pty host** — editing any of these costs every running agent:

| file | |
|---|---|
| `src/ptyhost.ts` | `createPtyHost()`, a factory |
| `src/ptyhostd.ts` | …as a daemon on a socket. Outlives every window and server |
| `src/agents/host.ts` | Spawns and owns every pty; the snapshot comes from here |
| `src/agents/screen.ts` | One headless xterm per pty; history for a pane opened late |
| `src/agents/status.ts` | idle/working/done heuristic. Ported verbatim |
| `src/agents/procs.ts` | Which agent program is running in a pty. Ported |
| `src/agents/report.ts` | Parses what an agent says about itself |
| `src/hostlink.ts` | The protocol between the halves, and the local pair for tests |
| `src/hostsock.ts` | That protocol over a unix socket. The framing, nothing else |

**The restartable half:**

| file | |
|---|---|
| `src/index.ts` | HTTP, WS, static, one timer. The whole protocol surface |
| `src/workspaces.ts` | Profiles, workspaces, focus. The arrangement lives HERE |
| `src/persist.ts` | The arrangement on disk. Structure only — never respawns |
| `src/access.ts` | Bind address, the one token, the Origin check |
| `src/config.ts` | `~/.config/kururu`, and how the settings files are written |
| `src/sizing.ts` | How big a terminal is when several panes have an opinion |
| `src/cwd.ts` | Where a process *is*, not where it was spawned. One `lsof` |
| `src/memory.ts` | What each terminal costs the machine, off `ps`. Rounded first |
| `src/footprint.ts` | Settings → Processes: each terminal's tree read with argv — agents, nvims, dev servers counted once each. Only when the page asks (`/api/footprint`, types in `shared/footprint.ts`) |
| `src/record.ts` | Rolling raw-stream tape per agent, for bugs you can't reproduce |
| `src/transcript.ts` | How full a Claude Code window is, off its transcript. Ported |
| `src/usage.ts` | The plan allowance, off a Claude credential — the machine's or the profile's. Read, never written |
| `src/vps.ts` | The sidebar's VPSes: the user's own `ssh`, `BatchMode`, one fixed read-only script. A client names a host and nothing else (`shared/vps.ts`) |
| `src/openrouter.ts` | The sidebar's OpenRouter balance and spend, read with a management key kept owner-only in `~/.config/kururu/openrouter.json`. GETs only; the key comes in once and never goes back out (`shared/openrouter.ts`) |
| `src/databases.ts` | The database sheet: `DATABASE_URL` read out of the workspace's env files at the moment of connecting and never held, every query in a `READ ONLY` transaction unless the switch says otherwise, reads bounded through a cursor. Postgres only (`shared/databases.ts`) |
| `src/report-cli.ts` | What a Claude Code hook runs. Not in `agents/` on purpose. Also carries the session's inbox socket, transcript path and last reply for the harness |
| `src/harness.ts` | The harness's hands: kururu's verbs as MCP tools for one profile, a terminal read as text, a message into a Claude's inbox socket, the status feed. Explicit targets, never `active` (`shared/harness.ts`) |
| `src/mcp.ts` | Five methods of MCP over JSON-RPC, written out rather than the SDK. Pure; served at `POST /mcp` |
| `src/devservers.ts` | lsof + ps discovery of what is listening, and what started it — and stopping one: the named command's tree, never a terminal's (`stopTargets`) |
| `src/proxy.ts` | Per-dev-server reverse proxy (HTTP + WS) for phone access |
| `src/files.ts` | Traversal-safe file listing and reading |
| `src/fileops.ts` | The file tree's edits: new, rename, move, copy, Trash — the only writer |
| `src/markdown.ts` | Markdown → markup with Shiki. `html: false` IS the sanitizer |
| `src/nvim.ts` | The editor in a pane, found by its socket. An autocmd, not a poll; `:drop` for the tree |
| `src/mouseencoding.ts` | How a terminal writes its mouse reports |
| `src/reach.ts` | Which addresses this machine answers to, for the phone's QR |
| `src/version.ts` | What version this is, stamped in by the bundler |
| `src/update.ts` | Whether there is a newer kururu. A check, never an install |
| `src/styles.ts` | Fetching, installing and serving the registry; `measureImage` |
| `src/studio.ts` | The skins you make — an ordinary installed skin with `local: true` |
| `src/mascot.ts` | Which sheets, parts and clips; the one endpoint that writes for a client |
| `src/sounds.ts` | The croak, and the machine's alert sounds — transcoded |
| `src/appearance.ts` | Theme id and terminal font. Persistence only |
| `src/keys.ts` | The keymap a user has amended. Persistence only |
| `src/notify.ts` | When to interrupt somebody, as they left it. Persistence only |
| `src/launch.ts` | Which agents the new-tab menu leaves out. Persistence only |
| `src/projects.ts` | Per-repository settings, by root. Persistence only |
| `src/worktree.ts` | A card's checkout: `git worktree add` on a click, and rebase, fast-forward, `worktree remove`, `branch -d` when it is retired — never forced. The one place kururu runs `git` |
| `src/logins.ts` | Where a profile's logins live, and the two env vars. Makes, never deletes |
| `run.mjs` | Builds, spawns and re-spawns the server. What `C-a B` reaches |
| `status.mjs` | The daemon has no face; this is it. Socket + `/api/agents` |
| `kill-hosts.mjs` | Finds hosts by socket, asks, SIGTERMs |

## `web/` — React 19 + Vite. One build; the desktop is what it is shaped for

| file | |
|---|---|
| `src/session.ts` | Module-level store + `useSyncExternalStore`; the WS client |
| `src/terminals.ts` | Every emulator, pooled by agent id and moved between panes |
| `src/App.tsx` | Draws the server's layout; owns the prefix, zen and dialogs |
| `src/main.tsx` | The root, wrapped in `Crash` |
| `src/keys.ts` | The prefix, and a `KeyboardEvent` as a lookup string |
| `src/theme.ts` / `skin.ts` | Tokens onto `<html>`; the other half to the emulators. No React |
| `src/colors.ts` | A workspace colour as `var(--ws-<name>)` |
| `src/fonts.ts` | Which fonts *this device* can draw, two ways |
| `src/icons.ts` | Kururu's own vectors (Lucide, vendored) — see `icons.LICENSE` |
| `src/grid.ts` | Whether a pane was really measured |
| `src/mouse.ts` | The mouse as the program in the pty sees it |
| `src/boxdraw.ts` | Box-drawing glyphs painted to the cell |
| `src/cursortext.ts` | The character under a block cursor, drawn again on top |
| `src/keybar.ts` | The keys a soft keyboard has not got, as events |
| `src/drag.ts` | What is in flight, because `dataTransfer` can't be read on `dragover` |
| `src/drop.ts` | A file dropped on a terminal → the path to type. Pure |
| `src/notify.ts` | Making the noise and drawing the card. No policy |
| `src/mascot.ts` | Loads a sheet once per URL and reports its size |
| `src/mermaid.ts` | The one thing the reader draws itself — a diagram needs a DOM |
| `src/labels.ts` | How the window draws the answers `shared/labels.ts` decides |
| `src/docs.ts` | The document list, reduced to the three decisions it makes |
| `src/preview.ts` | Where to send a browser for a dev server. Pure |
| `src/qr.ts` | A QR code, encoded here. Pure |
| `src/access.ts` | The token in the address, exchanged once for a cookie. Five lines |
| `src/zoom.ts` | How big the reader's type is, per device |
| `src/when.ts` | What a card's dates are called here: month names, and which day a week starts on |
| `src/desktop.ts` | The preload bridge, typed. Null in a browser — that's the contract |
| `src/styles.css` | No hex, no px. See [styles](styles.md) |

**Components:**

`Panes.tsx` (flat positioned boxes, tab strips, dividers) · `Terminal.tsx` (a box
for a pooled emulator; owns none) · `Sidebar.tsx` · `StatusBar.tsx` ·
`Status.tsx` (a dot, or the mascot) · `Icon.tsx` (a class name and an
`aria-hidden` span) · `Dialog.tsx` (while one is up, no key reaches a pty) ·
`Menu.tsx` · `Reader.tsx` (**the thing kururu was built for**; one draggable tab per document) ·
`Board.tsx` (a workspace's cards; the robot hands one to an agent) ·
`ProfileBoard.tsx` (the profile's own cards, in a sheet over the window) ·
`Timeline.tsx` (that board by when its cards are for; holds only which weeks it is showing) ·
`FileTree.tsx` (markdown to the reader, the rest to nvim; holds the reader's zoom) · `DocPicker.tsx` (an empty reader only) ·
`Keybar.tsx` · `Reach.tsx` · `Crash.tsx` · `HelpOverlay.tsx` (printed from the
keymap, so it cannot document a dead key) · `Settings*.tsx`.

## `desktop/` — Electron main + preload, and the esbuild step

| file | |
|---|---|
| `main.js` | Finds a server, draws it. And the one thing a served page can't do: replace the app |
| `connect.html` | The one page kururu draws itself — the address picker |
| `servers.js` | Addresses you have connected to, and what a typed one means |
| `preload.js` | Two bridges in one file, split on `file:` |
| `build.mjs` | `server/src` → `dist/{server,ptyhostd}.mjs`; stamps the version |
| `brand.mjs` | postinstall: stamps and re-signs the Electron copy in `node_modules` |
| `electron-builder.yml` · `entitlements.mac.plist` · `notarize.mjs` | see [packaging](packaging.md) |
| `icon/` | Generated by `tools/icon.mjs`; committed |

## Elsewhere

- `tools/icon.mjs` — the frog as every icon, from one named cell of the sheet.
  Deliberately **not** the user's mascot: an identity that followed a setting is
  not an identity. Run by hand; outputs are committed.
- `tools/schema.mjs` — publishes the token and part vocabulary to
  `../kururu-styles`. Bun, because it imports TypeScript.
- `tools/release-notes.mjs` — one version's section out of `CHANGELOG.md`.
- `assets/` — served at runtime, found the way `web/dist` is (`KURURU_ASSETS`).
  `sounds/` holds the croak (`KURURU_SOUNDS` overrides); `spritesheets/` holds the
  frog and `guide.png`.
- `web/public/` — copied verbatim into `web/dist`. Icons and the manifest; **no
  fonts** — a skin's face arrives with the skin and is written as an `@font-face`
  at runtime.
- `.github/workflows/release.yml` — what a tag sets off.
- `.claude/skills/release/` — how `CHANGELOG.md` is drafted and a version cut.
