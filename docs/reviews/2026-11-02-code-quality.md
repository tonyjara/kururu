# Code quality review — 2026-11-02

A read-only review of kururu at `0b967c4` (main, in step with origin): structure
and best practices, scalability, the tokens kururu makes models spend, two known
bugs, and a short pass over security and reliability. Nothing in the code was
changed. Measurements were made on `.backup` copies of `kururu.db` and
`usage.db` in a scratch directory, which has since been deleted. The live server
and host were only asked `GET /api/health` and `bun run status`.

**Caveat on timings.** The Mac's load average was 450–700 while the copies were
measured (the user's agents were running Xcode builds and simulators), so CPU
timings are probably 2–5× what a quiet machine would show. Sizes, row counts and
token figures are exact or labelled as estimates.

**Severity.** *High*: costs correctness, security, or will hurt at the scale the
Mac is already at. *Medium*: real, but bounded or a year away. *Low*: hygiene.
**Effort.** S = under half a day · M = one to two days · L = more.

---

## Summary

Kururu is in good health for a 118k-line codebase grown in about seven weeks.
TypeScript is strict with zero `any`, `@ts-ignore` or real casts outside SQLite
rows; 2,404 tests pass in 25 s and assert behaviour, not snapshots; every module
opens with the "why" comment CLAUDE.md asks for; memory is well pruned over days
of uptime; SQLite has one writer per database and no contention. The invariants
in CLAUDE.md hold where they were sampled (`Number.isFinite`, git only through
`gitcmd.ts`, kokoro never imported, no hex in `styles.css`).

What needs attention, most important first:

1. **Security — any `*.ts.net` page can drive a loopback kururu.**
   `originAllowed` accepts every origin ending in `.ts.net`
   (`server/src/access.ts:339`), and loopback is exempt from the token. Anyone
   can publish a public page on a `*.ts.net` name with Tailscale Funnel; opened
   in a browser on the Mac, it can open the WebSocket to `127.0.0.1:7717`, pass
   the gate, and spawn a pty. Verified with the pure functions (see §5.1).
2. **Correctness — the `say` tool speaks with voice replies switched off.**
   `sayAside` calls `voice.speak` directly; only `voice.spoke` checks
   `settings.speak` (`server/src/index.ts:2528`, `server/src/voice.ts:571`).
   One-line fix (§4.1).
3. **Scalability — every snapshot carries every card in the profile, and goes
   to every client on every hook report.** 1.23 MB today, 85 % of it Done cards,
   about 1.8 snapshots a second at peak (§2.1). The same profiles are also sent
   to the pty host as a 1.27 MB frame on every layout or board change, with no
   debounce, on the socket that carries keystrokes (§2.2).
4. **Correctness — Kuru's `cards` tool shows the Done column and cuts the live
   work** on any board over 24k characters, because `clip` keeps the end
   (`shared/harness.ts:982`, `server/src/harness.ts:1734`). It has already
   happened four times in Kuru's transcript (§3.4).
5. **Reliability — a WebSocket message of `null` crashes the server.**
   `handleMessage` reads `msg.type` off whatever `JSON.parse` returned, with no
   try around the dispatch (`server/src/index.ts:4801-4811`, `:7769`) (§5.3).

**Tokens.** Kuru is about **4 % of estimated spend** ($330 of $7,760 over 30 days
at list price); agents are the rest. Kururu's own fixed overhead per agent call is
about 110 tokens. The largest lever in Kuru is not kururu's code: Kuru (and every
agent) carries **~12k tokens of the profile's plugins and other MCP servers** on
every call — mostly a 36k-character skill listing, 164 skills of it posthog's.
After that: compaction summaries that have grown 5.7k → 25k tokens, and done
notices that wake Kuru 41–47 times a day, nearly undebounced. Ranked table in §3.9.

**Structure.** `server/src/index.ts` is 8,685 lines — a composition root plus
about twenty features that never got a module, a 1,316-line `handleMessage` with
171 cases and a 1,315-line `handleRequest` with 56 routes. The subsystems around
it are already deps-injected classes, so the cut is mechanical (§1.1).

---

## 1. Structure and best practices

### 1.1 `index.ts` is the composition root and about twenty features · high (maintainability) · L

**Evidence.** 8,685 lines (about 5,170 of code), 130 imports, 189 top-level
functions, 45 module-level `let`s — 15 of them `let x!:` singletons assigned in
`attach()` (`server/src/index.ts:521-569`) — and 19 module-level Maps and Sets.
The big pieces: `handleMessage` (`:4795-6111`, 171 cases), `handleRequest`
(`:6254-7569`, a 56-route `if` chain), `attach()` (`:7832-8345`, builds 17
subsystems), and eight `setInterval` sweeps (`:4748`). What is left in the file is
glue plus features with no home: card runs, worktree verbs, card dev servers, git
status, nvim census, footprint, style install and wear, made links,
notifications, backlog and sizing.

The good news is that the subsystems around it (Harness, Voice, Outbox, …) are
already classes taking a deps object, and the pure policy is already extracted
and tested (`sizing.ts`, `smallestGrid`).

**Recommendation.** First a `server/src/context.ts` that `attach()` fills (the
singletons, `clients`, `send`/`broadcast`/`push*`, `snapshot()`), then cut along
the `// ---` markers that are already in the file. Proposed modules, with the
approximate lines they would take today:

| module | lines now | what moves |
|---|---|---|
| `context.ts` | 419–720, 1421–1472 | singletons, clients, send/broadcast, `snapshot()` |
| `ws/dispatch.ts` + `ws/{terminals,panes,workspaces,look,voice,kuru,dbviewer,profiles,board,reader}.ts` | 4763–6111 | `handleMessage`, `reply`/`replyAsync`, cut at 4819, 5030, 5082, 5116, 5191, 5214, 5476, 5506, 5573, 5607, 5629, 5656, 5702, 5780, 5838, 5995 |
| `http/router.ts` + `http/{kuru,styles,nodes,mcp,files,voice,admin}.ts` | 6112–7633 | routes as a `{method, path, handler}` table, join kept ahead of the gate |
| `cards.ts` | 2289–2456, 2823–3138 | `runCardAt`, `resumeCardAt`, worktree verbs |
| `carddev.ts` | 3139–3254 | card dev servers |
| `terminals.ts` | 1842–2135, 3255–3358, 3393–3623 | open/spawn, forget/reap, sizes, backlog, output queue |
| `appearance.ts` | 1138–1420 | install, wear, `saveLook`, mascots |
| `lending.ts` | 893–1137 | spawn env, logins, vault, lend |
| `notices.ts` | 1639–1815 | status edges, `announce` |
| `madelinks.ts` | 2558–2822 | made sweep, `openMade`, `showFile`, pictures |
| `repostatus.ts` | 3759–4085 | workspace dirs, branches, git status |
| `editors.ts` | 4086–4331, 4457–4655 | nvim hooks, census, close/kill |
| `sweeps.ts` | 3624–3734, 4332–4456, 4656–4762 | dev-server scan, memory, polls, timers (with §1.4's wrapper) |
| `boot.ts` | 7634–8633 | listen, upgrade, admit, `attach()`, host start |

`index.ts` ends under 300 lines and no file over about 1,300. Every one of these is
`server/src` — a reconnect, never a host restart — but **do it in a worktree**:
every save in `server/src` restarts the live :7717 under `bun run dev`, and a
half-cut file crashes it (see the `watcher-split-edits` gotcha). Cut one module
per card so each lands green.

### 1.2 `handleMessage` has no exhaustiveness check and no shape check · medium · S

No `default:` with a `never`, so a new `ClientMessage` variant without a case
compiles silently (172 variants, 171 cases; `show-node-workspace` is handled in
`nodewatch.ts:936`). Field checks are by hand per case. Add
`default: msg satisfies never` and the guard from §5.3.

### 1.3 Other large single classes · low–medium · M each

`Harness` is ~1,550 lines (`server/src/harness.ts:307-1857`, 36 tool cases);
`TelegramChannel` ~1,480 (`server/src/telegram.ts:396-1878`); `Workspaces` has 123
methods, with nine `X`/`XIn` pairs where `X` copies `XIn`'s body instead of calling
it (e.g. `editBoard`/`editBoardIn`); `App()` is ~1,460 lines with 27 `useState` and
28 `useEffect` (`web/src/App.tsx:271-~1730`); `web/src/session.ts` has 185 one-line
verb wrappers mirroring `wire.ts`. Move Harness's tool handlers into a table keyed
by name (which also makes §3.7's per-feature tool list trivial); pull App's effects
into hooks (`useVoiceWiring`, `useReloadGate`, …); make `X` call `XIn`.

### 1.4 Sweeps have no error handling at the loop · medium · S

`server/src/index.ts:4748-4759` runs seven async polls as
`setInterval(() => void pollX())` with no top-level try. They are safe only because
every helper downstream happens to resolve rather than reject; one rejection (a
broadcast, a SQLite write in `recordClaudeLimits`) is an unhandled rejection, which
Node turns into a crash that `lifecycle.ts:120` only records. One
`sweep(name, fn)` wrapper that catches and logs.

### 1.5 Swallowed errors, including failed saves · medium · S

`server/src` has 326 catch blocks, 90 empty (82 with an explaining comment; eight
without: `opencode.ts:160,248,271,305,358`, `studio.ts:230`, `styles.ts:382,713`),
and only 43 `console.error/warn` calls. The risky ones:

- `server/src/config.ts:68` — `writeConfigFile` swallows every failure. It is the
  write path for the OpenRouter, Telegram, Firecrawl and access keys and
  `nodes.json`: a key pasted on a full or read-only disk is "saved" and gone at the
  next restart, with no trace anywhere.
- `server/src/persist.ts:229` (`session.json`) is silent, where `made.ts:214` logs
  the same failure.
- `onRequest`'s `.catch` (`server/src/index.ts:7638`) returns a 500 and drops the
  error.

Log in all three (lifecycle log or stderr); have `writeConfigFile` return whether it
wrote, so a Settings setter can say so.

### 1.6 The atomic write is hand-rolled about fifteen times · medium · S

The canonical one is `server/src/config.ts:60`, whose comment explains that the
mode must be set with `chmod` because `writeFileSync`'s option does not apply to a
leftover temp. Copies: `telegram.ts:1869` (mode option only — against that very
rule, on the bot token's file), `secrets.ts:846`, `vault.ts:89`, `nodes.ts:1273`,
`peerkuru.ts:488`, `web/chain.ts:120`, `web/providers/firecrawl-cloud.ts:108`,
`persist.ts:226`, `made.ts:209`, `styles.ts:159`, `mascot.ts:239`,
`studio.ts:152,340`, `outbox.ts:714`, with different temp names (`.tmp`,
`.kururu-tmp`) and different failure handling. One `writeAtomic(path, text, {mode})`
in a `server/src/fsutil.ts`; point the 0600-list test at it.

### 1.7 Other duplicated helpers · low · S

| helper | copies | where |
|---|---|---|
| POSIX single-quote | 8 | `index.ts:4327`, `nvim.ts:388`, `hooks.ts:100`, `web/chain.ts:168`, `harness.ts:1872` (the only one that strips control characters), `shared/opencode.ts:93`, `shared/lazygit.ts:41`, `shared/machines.ts:534` |
| state dir (`KURURU_STATE_DIR \|\| XDG_STATE_HOME …`) | 11 in `server/src`, plus `run.mjs`, `status.mjs`, `runner.js`, `tools/` | `outbox.ts:152`, `hostsock.ts:48`, `lifecycle.ts:50`, `opencode.ts:117,391`, `telegram.ts:264`, `persist.ts:149`, `machines.ts:96`, `hooks.ts:123`, `firecrawl-cloud.ts:75`, `web/chain.ts:91` |
| random hex id | 5 | `shared/board.ts:204,423`, `shared/model.ts:894`, `opencode.ts:59`, `store.ts:45` |
| path-inside check | 13 outside `files.ts` | `move.ts:352`, `vault.ts:86`, `index.ts:2798`, `web/src/components/FileTree.tsx:103`, … |
| `~` abbreviation | 5 | `shared/move.ts:344`, `index.ts:2213`, `lifecycle.ts:193`, `desktop/menu.js:351`, `desktop/runner.js:242` — three use `startsWith(home)` without `/` |
| request-body reader | 3 | `index.ts:6162`, `6190`, `6207` (`readJsonBody` says it is built on `readBody`; it is a copy) |

A `stateDir()` beside `configDir()` (which is done once, correctly), one `shq()`
in `shared/text.ts` (the control-character-stripping one), and one `inside()` next
to `files.ts`.

### 1.8 Dead code is small · low · S

Never referenced: `hostlaunch.ts:614 launchedBySystemd`,
`shared/board.ts:48 isBoardColumn`, `web/src/mouse.ts:89-90 WHEEL_LEFT/RIGHT`. Ten
exports are referenced only by tests (`git.ts headAt`, `nodekeys.ts forgetIdentity`,
`transcript.ts contextPercent`, `layout.ts docsOf`, …). `--noUnusedLocals
--noUnusedParameters` gives 9 errors in root (`index.ts:128 LendAsk`,
`index.ts:7652 server`, `usage/store.ts:180 CELL_SUMS`, `nodes.ts:506 now`, …) and 6
in web. No orphan files; all 40 `KURURU_*` variables are read. Delete them and turn
`noUnusedLocals` on in both tsconfigs.

### 1.9 Typing: excellent in TS, absent in 6,360 lines of JS · medium · M

TS: 0 `any`, 0 `as any`, 0 `@ts-ignore`; 13 `as unknown as`, all SQLite rows
(`store.ts:745,772,1270,1285`) or library internals (`agents/screen.ts:158`,
`web/src/frames.ts:403`, `terminals.ts:1004`). Non-null `!` hotspots: `web/src/qr.ts`
(44), `shared/vault.ts` (22), `server/src/nodes.ts` and `harness.ts` (21 each). Both
tsconfigs have `strict` and `noUncheckedIndexedAccess`; only root has
`noImplicitOverride`.

But `desktop/*.js` and `server/*.mjs` — 6,360 lines including `run.mjs`, the one
supervisor, and `desktop/main.js` (1,320) — have no `@ts-check` and no typecheck.
KUR-179 (§4.2) lives there. Add `// @ts-check` with JSDoc, or a
`desktop/tsconfig.json` with `allowJs`/`checkJs`, and include it in
`bun run typecheck`.

### 1.10 Tests: strong on pure logic, thin on the glue and the web app · medium · M

2,404 pass, 0 fail, 8,456 `expect()`s, 120 files, 24.6 s wall for about 9.6 s of CPU —
the rest is real-time waits (`channels.test.ts` ~7 s, `telegramlead.test.ts` ~4.7 s,
`harness.test.ts` ~4.3 s; inject a clock). Files no test imports: `shared` 0 / 54,
`server/src` 34 / 108, `web/src` 95 / 117. The untested server files that most
deserve a test, because they guard something: `databases.ts` (the `READ ONLY`
gate), `backup.ts` (pushes user data with git), `sleep.ts` (the part that ends
agents), `proxy.ts`, `agents/host.ts`, `machines.ts`, `firecrawl-cloud.ts` (the
credit budget). §1.1's cut is what makes `index.ts`'s dispatch testable with a fake
`ctx`.

### 1.11 Dependencies: current, but the DMG is heavy · low · S–M

Everything is within a minor except `typescript` 5.9.3 → 7.0.2 and `electron` 44.3 →
45.2. No unused declared dependencies. `electron-builder.yml` copies whole into the
DMG: `onnxruntime-web` 91 MB (a `1.22.0-dev` prerelease pulled in by
`@huggingface/transformers`, probably unused under Node — unverified),
`onnxruntime-node` 65 MB, `@huggingface/transformers` 47 MB (both web and node
builds), `kokoro-js` 29 MB, `@img` 16 MB; and `onnxruntime-common` is there twice
(1.21.0 and 1.22.0-dev). Try filtering out `onnxruntime-web` and transformers'
web/wasm builds, then check Kokoro still loads in a signed build.

### 1.12 Conventions and documentation drift · low · S

Holding: "why" doc comments everywhere except `web/src/main.tsx`; one TODO in the
codebase; no hex outside tokens (`theme.test.ts` passes); `Number.isFinite` on wire
numbers (sampled `propose-size` at `index.ts:4943`, docs at `6025-6100`, the db
viewer at `5719`; where `index.ts` does not check, the pure callee does, e.g.
`layout.ts:383`, `board.ts:531,950,963`); `kokoro-js` only dynamically imported
(`kokoro.ts:81`); `shared/` imports no package and no `node:` module.

Drifting:

- **Boundary:** `server/src/share-cli.ts:22` imports `../../web/src/qr`. Pure, but it
  belongs in `shared/`.
- **Git:** `restore-cli.ts:70,79` also runs git through `gitcmd.ts`, which CLAUDE.md's
  "only `worktree.ts` and `backup.ts`" does not name; `tools/kururu.mjs:255` runs
  `git pull` for `kururu child update`.
- **Stale since `7831c9b` (credit chip removed):** CLAUDE.md:222 still lists "the
  Anthropic Admin key", CLAUDE.md:259 "Anthropic's cost report", and
  `shared/backup.ts:171` — **user-facing restore text** — still tells someone to paste
  the Anthropic Admin key.
- CLAUDE.md:559 says "`proxy.ts` works and nothing points at it", but
  `pollDevServers` opens a proxy per dev server (`index.ts:347`) and
  `web/src/preview.ts:59` links it; only the pane is owed.
- `docs/map.md` names the deleted `Firecrawl.tsx` and omits `peerkuru.ts`,
  `opencode.ts` (server and shared), `hooks.ts`, `connectbudget.ts`,
  `usage/limits.ts`, `usage/codex.ts`.
- `server/package.json`'s `start`/`dev` run `bun run src/index.ts`, against "Node, not
  Bun".
- Nine gitignored `*.orig` leftovers in the working tree (`CLAUDE.md`,
  `shared/harness.ts`, `shared/wire.ts`, `server/src/harness.ts`,
  `server/src/index.ts`, `web/src/styles.css`, `docs/map.md`, `docs/voice.md`,
  `docs/harness.md`) — harmless to git, confusing to grep and to agents.
- **CLAUDE.md is 576 lines / 40 KB and `AGENTS.md` links to it**, so every agent
  started in this repo reads ~11k tokens of it on every call. Cutting each invariant
  to one line plus a doc link (the shape the "Shape" section already promises) would
  roughly halve it. See §3.8.

---

## 2. Scalability

### Measured

| | now | growth | one year (estimate) |
|---|---|---|---|
| `kururu.db` | 14.1 MB (24 days) | ~0.58 MB/day | ~210 MB |
| `turns` | 5,039 rows, 6.0 MB + 2.3 MB FTS (2,789 in one harness conversation) | ~230/day | ~84k rows |
| `cards` | 768 (707 live, 602 of those Done), 1.6 MB + 1.0 MB FTS | ~26/day | ~10k |
| `card_events` | 6,851 | ~285/day | ~110k |
| `voice_messages` | 865, never pruned | ~36/day | |
| `usage.db` | 37 MB; 97,797 messages (16 MB + 18 MB of two indexes) | ~2,500 msgs/day (peak 6,487), ~0.87 MB/day | ~320 MB |
| server | RSS 121–222 MB, ~3.5 % CPU | 488 starts in 25 days, up to 87 a day; restart-to-listening median 0.48 s | |
| pty host | RSS 58–80 MB, 12 agents, up 2 d 21 h | 2–6 MB per agent at full 5,000-line scrollback | ~100–300 MB at 50 agents |
| snapshot | **1,231 KB** for the active profile (23 boards); stringify 20–28 ms, parse 21–25 ms | grows with cards | ~17 MB at 10k cards |

Pragmas: both WAL; `kururu.db` `synchronous=FULL`, busy timeout 5 s; `usage.db`
`synchronous=NORMAL`. One connection per database, inside the server, writes in
`begin immediate` transactions — **no write contention.**

### 2.1 Every snapshot carries every card, on every hook report · high · M

`snapshot()` sends the whole active profile, every board (`server/src/index.ts:1440-1461`,
`shared/model.ts:968`). Every `/api/report` — every PreToolUse of every agent — calls
`host.report`, which always fires `onChange` (`server/src/agents/host.ts:283-290`) →
`onAgents` → `pushSnapshot()` (`index.ts:7834-7843`), and `pushSnapshot` coalesces only
within one microtask (`index.ts:711`), so separate HTTP requests each broadcast.
Memory readings push one too on each 10 MB step (`memory.ts:145`, `index.ts:4375`).
At the measured peak of 107 billed messages a minute that is ~1.8 snapshots/s: ~2.2
MB/s to each client, ~9 MB/s across four, ~25 ms of stringify per snapshot on the
server and a ~21 ms parse in each window — and on the phone over the tailnet. At a
year of cards the event loop saturates at peak.

**Recommendation.** Boards out of the snapshot: one `board` message per board with a
version, sent when that board changes. Agent status and activity as small deltas. A
trailing 100–250 ms debounce on the snapshot. Consider `perMessageDeflate` on `wss`
(3.3× on this payload). Web and server only; no host change.

### 2.2 The host keepalive blob re-sends every profile on every change · high · S

`queueSave()` runs `host.keep(JSON.stringify({profiles: workspaces.all(), …}))`
synchronously on every `workspaces.onChange` (`index.ts:1817-1819`, wired at
`:8295-8298`); only the disk write is debounced. Each is a 1.27 MB line on the single
newline-delimited socket (`server/src/hostsock.ts:90-120`), queued ahead of
keystrokes, and the host spends 13–27 ms parsing it on the thread that flushes every
pty's output each 16 ms. A divider drag sends one per frame.

**Recommendation.** Leave boards out of the blob (the database is the authority —
CLAUDE.md already says the host's blob only adopts cards the database never saw),
coalesce on a ~100 ms trailing timer, and skip the send when the layout's hash is
unchanged. Server-side only: a reconnect, not agents.

### 2.3 `harnessTurns` scans the whole `turns` table on every Kuru change · medium (high within a year) · S

`kuru.changed()` runs `conversation()` per profile, each doing `harnessTurns(…, 60)`
(`server/src/kuru.ts:175-195`, query at `server/src/store.ts:1099-1107`). The plan
walks `turns_conversation` then sorts in a temp B-tree: 6.65 ms now, **193 ms at 85k
turns** (simulated). `create index turns_at on turns(at, id)` takes it to 0.31 ms. Kuru
search (`kuru.ts:136`) also loads every harness turn before its yielding loop: 20 ms
now, ~1 s and 51 MB at a year — pre-filter through `turns_fts`, which exists.

### 2.4 Every usage flush rebuilds the whole day's rollup · medium · M

`Ledger.flush` calls `rollup(day)` for each day touched (`server/src/usage/store.ts:388-402`):
delete the day, re-aggregate from `messages` twice (`daily`, `session_days`), re-insert
(`:542-590`). Nudges coalesce over 1.5 s (`usage/sweep.ts:62`). On a busy day that is
61–202 ms of synchronous work every few seconds, growing superlinearly (the default
2 MB page cache thrashing on `messages_at`). Upsert the batch's aggregates
incrementally, or run the rollup on a ~30 s trailing timer; raise `cache_size`.

### 2.5 No backpressure and no liveness on window WebSockets · medium · S–M

`send`, `broadcast` and `onOutput` never read `bufferedAmount`
(`index.ts:653-671`, `:3536-3545`); `/ws` has no ping/pong (`admitClient`,
`:7760-7771`), so a half-open phone stays in `clients` until TCP gives up while 1.2 MB
snapshots and terminal output pile up for it in server memory. Output is stringified
once per client per chunk. Ping every 15–30 s and terminate on a missed pong; past a
few MB buffered, keep only the latest snapshot and stop output to that client (it
already asks for a backlog on reconnect); stringify each chunk once.

### 2.6 Reconnect storm after every server restart · medium · M (host change)

Every visible pane in every client asks for a backlog on reconnect
(`web/src/session.ts:284-306` → `sendBacklog`, `index.ts:3587`), serialised one at a
time in the host (`server/src/agents/screen.ts:193-195`, 1,500 lines): 4 clients × ~4
panes ≈ 16 × 28–150 ms of host thread and ~5 MB, plus a 1.2 MB snapshot each — up to
87 times a day under `--watch`. Cache the serialised backlog per agent, grid and
output position so identical asks share one serialisation. **Host code — batch it**
with other host work (§6, card H1).

### 2.7 Remote agents' status costs a full backlog and a fresh emulator every 2 s · medium · M

`OnScreen` asks the host for a 1,500-line backlog then builds a new xterm `Terminal`
in `screenText`, per remote agent, every 2 s (`server/src/onscreen.ts:64-66`,
`server/src/harness.ts:1857`): ~27 ms per agent for a tmux tab, 5–10× for one off the
alternate screen. Add a host verb that returns the visible rows as text (host change,
batch it), or keep one reader emulator per agent in the server (no host change).

### 2.8 Smaller

- **Process polling** costs ~4–5 % of a core regardless of agents: `lsof` + `ps -eo args`
  every 3 s for dev servers, `ps` every 5 s for memory (`index.ts:4749-4752`), another
  `ps` every 2 s in the host. Share one `ps` read; back off with no window open. · low · S
- **FTS trigger** re-indexes a card on every run-state change, because `updateCard`
  always sets `title, body`; add `when old.title is not new.title or old.body is not
  new.body` to `cards_au`. · low · S
- **Backups** export everything synchronously (`store.ts:1323-1345`,
  `server/src/export.ts:75-126`): 290 ms now, ~1 s at a year. Fine at 240 minutes; the
  allowed minimum is 1 minute. Export conversations incrementally from the mark. · low · S
- **`voice_messages`** is never pruned (865 rows). Cap it like `missed_replies`. · low · S
- **Nodes and machines** are fine to about ten. The node mesh is n(n−1)/2 links with 5 s
  pings and summaries compared before sending (`nodes.ts:1185`, `:1225-1243`). One
  amplifier: every snapshot from a watched child (its whole profile — §2.1 again)
  triggers a full local broadcast (`nodewatch.ts:414-421`). Machine polls share an ssh
  `ControlMaster` (`machines.ts:153-157`) but each remote terminal opens its own
  `ssh -t` with no `ControlPath` (`shared/machines.ts:527`): 10 machines × 5 tabs is 50
  ssh sessions. Add `ControlPath`/`ControlMaster=auto` to terminal lines. · low · S
- **Memory over days of uptime is well kept.** `forget()` clears ~14 per-agent maps
  (`index.ts:3298-3315`); tapes cap at 128 KB per agent; `kuruFound`, the outbox (20
  delivered per profile), missed replies (30) and Telegram's `relaysSeen` are capped.
  No unpruned map was found.

---

## 3. Token usage

### Measured (30 days, list prices from `shared/prices.ts`; the user is on a subscription, so read dollars as weights)

| | input | cache read | cache write | output | est. $ |
|---|---|---|---|---|---|
| Kuru | 0.014M | 856M | 14.9M | 2.0M | **330 (4.3 %)** |
| agents and cards | 0.87M | 15,684M | 232M | 80.8M | 7,428 |

- By model: Opus 5.5 — cards $3,748, agents $1,608, Kuru $330; Fable 5.1 — cards
  $1,335, agents $626; Sonnet 5 $109; Codex unpriced (167 messages).
- Top workspaces, 7 days (other projects unnamed here — the repo is public): four
  project workspaces at $215–477 each, Kururu $182, Kuru $90.
- **Kuru's context per call:** 156k cache read (30 d), 129k (7 d); ~213 calls a day.
- **What wakes Kuru, per day:** `[kururu]` notices 41–47 (58 % of wakes), typed 23,
  `[voice]` ~3, `[telegram]` 2–3.
- **A notice wake** costs 2.2 calls and ~$0.10; notice wakes are 42–46 % of Kuru's
  spend. 47 % of them were one call, no tools, median 42 output tokens — reading 146k to
  say "noted".
- **Notices:** 839 in 19 days — 791 done (median 1,619 chars), 41 blocked, 7 exited. 386
  quoted exactly 1,500 characters, cut with no marker; Kuru then called
  `read_agent(reply)` 170 times.
- **Compaction:** 24 auto-compactions, all at ~200k. The post-compaction floor rose 42k →
  77k between 10-15 and 11-01; the summary alone grew 5.7k → 25k tokens.
- **Cold wakes:** 73 wakes after more than an hour idle, each rewriting ~122k tokens of
  cache at the 1-hour price — $71 in 30 days, 21 % of Kuru's spend.
- **Kuru's fixed prompt:** the role (rebuilt with this profile's 18 workspaces and 12
  launchers) is 15.1k chars ≈ 4.2k tokens; 28 kururu tools are 24.9k chars ≈ 7.6k
  tokens but **deferred** (fetched through ToolSearch, 142 times in 19 days); the web
  tools ≈ 2.1k tokens, also deferred.
- **Not kururu's, on every Kuru call:** a skill listing of ~36k chars (≈ 10k tokens;
  164 skills are posthog's) and other MCP servers' instructions and ~70 deferred names
  (a project's own MCP server, Claude Docs, posthog, Google connectors; ≈ 1.8k tokens). Agents carry
  the same (~41k chars).
- **Kururu's own per-agent overhead:** ~110 tokens a call (web-tool instructions plus four
  deferred names) — ~0.25M tokens a day, negligible.
- Nothing polls a model: `sleep.ts` only ends agents, `due` and `wait_agent` hold without
  spending, hooks print nothing.

### 3.1 Kuru carries ~12k tokens of prefix that is not kururu's · medium · S

The harness line (`server/src/harness.ts:1365-1378`) passes `--mcp-config` and
`--allowedTools mcp__kururu` but not `--strict-mcp-config`, and does nothing to keep the
profile's plugins and skills out. Kuru used the non-kururu servers five times in 19 days (85k
characters of results). Add `--strict-mcp-config` (kururu and kururu_web only, plus
anything the user names) and keep plugin skills out of the harness session —
`--disable-slash-commands` or a `--settings` override in the harness folder; confirm
against the installed CLI. Harness restart only. **~2.5M cache-read tokens a day.**

### 3.2 Compaction summaries grow every cycle · medium · S–M

Summary 5.7k → 25k, floor 42k → 77k over 24 compactions, so each cycle has less room —
three compactions on 11-01. Put compaction instructions in the harness's
`HARNESS_AGENTS_MD`: under ~5k tokens, drop finished agents and done cards (the board
and the database keep them). Or rotate Kuru into a fresh session daily or weekly with a
handoff note (M). **2–4M read a day.** Lowering the compaction point alone does not pay:
200k ≈ $7.0/day, 140k ≈ $6.8, 120k ≈ $7.25 — flat until the floor shrinks.

### 3.3 Every done edge wakes Kuru for a full turn · medium · M

The only debounce is `TELL_THROTTLE_MS` = 4 s, same agent and status only
(`server/src/harness.ts:274, 651`). 144 notice wakes came within 60 s of another; 159
times one agent finished again within five minutes untouched. On OpenCode each notice
is typed alone (`alone: true`, `:662`). Hold done notices 30–60 s and send all that
arrived as one message; drop a held done if the agent goes back to working; `blocked`
stays immediate. **1.2–1.6M read a day** (more if merged wakes share tool calls).

### 3.4 `cards` shows the Done column and cuts the live work · high (correctness) · S

`boardText` lists columns todo → doing → review → done and returns
`clip(out.join("\n"))` (`server/src/harness.ts:1727-1735`); `clip` keeps the **end**
(`shared/harness.ts:982`) because it was written for screens, where the newest part is
at the bottom. On a board over `READ_MAX` = 24k chars (`shared/harness.ts:45`) only
Done survives. Done is 72–100 % of each large board's text (Kururu: 193 cards, 188 done,
~63k chars). Happened four times in the transcript. The schema takes only `workspace`
and `node` (`shared/harness.ts:317-320`), yet Kuru passed `column` 12 times and `card` 4
times — ignored, whole board each time. **Fix:** honour `column` and `card`; by default
list the live columns, then a Done count and the last five; clip from the front of a
board, never the end.

### 3.5 Cut notice quotes are not marked · low · S

`.slice(0, TELL_QUOTE)` (1,500) with no marker (`server/src/harness.ts:276, 656`). Say
"(first 1,500 of N characters)" so Kuru reads more only when it needs to. A longer
quote does not pay (41 notices a day of extra resident tokens outweigh ~9 re-reads).

### 3.6 Overnight notices hit a cold cache · low–medium · M

0.7 notice wakes a day arrive after an hour idle, each rewriting ~107k of cache
(~$0.86). An opt-in "away digest": hold done notices while Kuru has been idle over 55
minutes and deliver them with the user's next message or after a cap. Opt-in, because
Kuru is sometimes left driving overnight runs.

### 3.7 Role sections sent when their feature is off · low · S

Nodes, Telegram, Machines and Voice (~1.9k tokens) are always in the role
(`shared/harness.ts:1008` onward), and Voice says "your last message of every turn is
read aloud" even when replies are off — which also ties to §4.1. Include each only when
set up; with `speak` off, say replies are not read aloud and leave `say` and
`play_missed` out of `tools/list`.

### 3.8 Agents in this repo read 40 KB of CLAUDE.md on every call · low–medium · S

Not counted by the reviewers' table, but the same arithmetic as §3.1: CLAUDE.md is
~11k tokens and loads into every agent started in the kururu checkout (Kururu: $182 of
agent spend in the last 7 days). Cutting the invariants to one line and a link each
would save several thousand tokens per call for every kururu agent.

### 3.9 Ranked savings

| change | arithmetic | tokens/day | ≈ $/day | effort |
|---|---|---|---|---|
| Strip the foreign prefix from Kuru (3.1) | 11.8k × 213 calls + 11.8k × ~4.3 cache rewrites | ~2.5M read + 51k write | 0.9 | S |
| Cap the compaction summary / rotate (3.2) | 10–19k smaller floor × 213 | 2–4M read | 0.4–0.8 | S–M |
| Batch and debounce done notices (3.3) | 8–11 wakes saved × ~145k | 1.2–1.6M read | 0.3–0.9 | M |
| Away digest, opt-in (3.6) | 0.7 cold wakes × 107k write | ~75k write + 0.2M read | 0.6 | M |
| Mark cut quotes (3.5) | ≤ 9 re-reads × 140k | ≤ 1.3M read | ≤ 0.25 | S |
| Fix `cards` (3.4) | ~2.1k tokens × 1.8 calls, resident ~75 calls | ~0.2M read | 0.09 (do it for correctness) | S |
| Role sections only when on (3.7) | 1.9k × 213 | 0.4M read | 0.08 | S |
| **Outside kururu's code:** plugins in every agent | ~15k × ~2.2k agent calls | **~33M read** | **~7** | S (a decision) |

The last row is the largest number in this report and it is the user's call: whether the
agents kururu starts should load the profile's posthog, project and Docs plugins at
all. Kururu could offer it per profile (a `--strict-mcp-config` switch on agent lines in
Settings → Agents), defaulting to today's behaviour.

---

## 4. Known issues

### 4.1 The `say` tool speaks with voice replies switched off · high (user-visible) · S

**Why.** There are two doors into the speaker and only one checks the setting.
`Voice.spoke()` — the end-of-turn reply — returns null when `settings.speak` is off
(`server/src/voice.ts:570-572`). The `say` tool goes
`Harness.call("say")` → `deps.say` (`server/src/harness.ts:1198-1203`,
wired at `server/src/index.ts:7984`) → `sayAside` → **`voice.speak(key, text)`**
(`server/src/index.ts:2528`), the low-level method that queues an utterance
unconditionally. `sayAside` only asks `channels.speaks(key)` (is this a
Telegram-only turn?), never `settings.speak`. The role prompt makes it worse: it tells
Kuru its final message is read aloud and offers `say` for mid-turn lines regardless of
the setting (`shared/harness.ts:1072`).

**Fix.**
1. Add `Voice.aside(profileKey, text)` that returns null when `!this.settings.speak`,
   mirroring `spoke`, and call it from `sayAside`. Keep writing the turn down (the
   drawer still shows the line, as it shows an unspoken reply).
2. With `speak` off, have `say` return "Not said: voice replies are off" so Kuru
   stops reaching for it, and (with §3.7) leave `say`/`play_missed` out of the role and
   the tool list.
3. A unit test on the pure part: `spoke`/`aside` both null with `speak: false`.

Server only — a reconnect. Step 2's role change needs a harness restart to reach Kuru.
The `peerkuru` path already goes through `spoke` (`index.ts:8217`) and is fine.

### 4.2 KUR-179 — SIGTERM to the app shows the quit dialog · medium · S (+ a packaged-build test)

**Why.** `desktop/main.js:1312-1320` registers `process.on("SIGTERM"/"SIGINT")`
handlers that set `quitting = true` and stop the runner quietly. But Electron's browser
process handles shutdown signals itself and calls the normal quit, which emits
`before-quit` — and `before-quit` (`desktop/main.js:1116-1128`) sees `quitting === false`,
calls `preventDefault()` and `confirmQuit()`, which shows "N agents are still running"
with **"Quit and end them"** one button away. Node's signal callbacks run from libuv on a
later loop turn, if at all: only one `sigaction` per signal can win, and observed
behaviour in the signed app (KUR-177) is that Electron's does. Unverified which of the
two orderings it is; the fix below covers both.

**Fix, in order of preference:**
1. **Decide one tick later.** In `before-quit`, when not already `quitting`,
   `preventDefault()` and defer the decision with `setImmediate`/`setTimeout(0)`; if a
   signal handler set `quitting` meanwhile, finish quietly, else `confirmQuit()`. Cheap,
   and harmless for ⌘Q.
2. If Node's handler never runs at all in the packaged app, register the signal handlers
   inside `app.whenReady()` (libuv installs its `sigaction` on the first listener, so
   the early registration has to go) and test which handler wins on a signed build.
3. Give scripts a door that is not a signal — e.g. a `kururu://quit?quiet` URL the app
   handles, or a tray-menu id the desktop harness already drives — so the app-swap
   watcher stops depending on signal semantics.

Test on a packaged build, as the card asks: `kill -TERM <main pid>` with agents up must
quit without a dialog and leave the host and every agent running (`bun run status`).
`desktop/` change — relaunch the app, no agents at risk. Note §1.9: this code has no
typecheck.

---

## 5. Security and reliability

### 5.1 Any `*.ts.net` page passes the Origin check · high · S

`originAllowed` returns true for any origin whose host ends in `.ts.net`
(`server/src/access.ts:339`), and `decide` lets a loopback request through without a
token when `loopbackToken` is off — the Mac's default (`access.ts:371-376`). The
WebSocket upgrade uses the same verdict (`server/src/index.ts:7745`). Checked in a
scratch script against the real functions: origin
`https://anything.tail0000.ts.net`, host `127.0.0.1:7717` → `originAllowed: true`,
verdict `ok`.

**Why it matters.** Anyone with a Tailscale account can publish a public HTTPS page on a
`*.ts.net` name with Funnel. If the user opens such a link in a browser on the Mac, the
page can open `ws://127.0.0.1:7717/ws`, receive the snapshot and send `create-agent`
with any command — the exact attack `access.ts`'s own comment describes, reached by
clicking a link. Safari and Firefox do not block a public page from reaching loopback;
Chrome's Local Network Access may prompt. The phone's cookie is `SameSite=Lax` and
would not ride a cross-site WebSocket, so the hole is the loopback exemption on the Mac
(and any child where `loopbackToken` is off).

**Fix.** Drop the blanket `.ts.net` rule. Allow a `ts.net` origin only when its host is
this machine's own MagicDNS name, learned without running `tailscale` (rule 4): from the
`Host` header of a request that arrived on the tailnet address `reach()` already knows,
or from a name the user confirms once in the sharing dialog and kururu keeps in
`access.json`. Development through vite keeps working via `KURURU_ALLOWED_ORIGINS` or
by having vite's proxy set `Origin` to the upstream. Add the rows to the existing
`decide` test table. Update `docs/architecture.md:420`. Server only — a reconnect.

### 5.2 Loopback is exempt from the token · accepted, noted

A documented decision (`access.ts:29-46`): anything on loopback is already running as
the user. It still means any local process can reach `/mcp` and drive Kuru's verbs —
including `send_agent`, which types into another agent *as the user* — and `/api/*`,
including `POST /api/host/restart`. An agent prompt-injected by a fetched page already
has a shell, so this adds reach rather than privilege. No change recommended; worth a
line in `docs/architecture.md` under Access so the trade is written down, and §5.1 is
what keeps browsers out of it.

### 5.3 A `null` WebSocket message crashes the server · medium · S

`handleMessage` parses with `JSON.parse(raw) as ClientMessage` and catches only parse
errors (`server/src/index.ts:4801`); `JSON.parse("null")` succeeds and `handsOf(msg.type)`
(`:4811`) throws. `ws.on("message")` calls it with no try (`:7769`), so it is an
uncaught exception and the server dies — and under `bun run dev` a crash stays down
until the next save (`server/run.mjs:218-225`). Any client past the gate can do it,
including a parent's watcher, and — with §5.1 — a `ts.net` page. Guard the shape
(`msg && typeof msg === "object" && typeof msg.type === "string"`) and wrap the dispatch
in a try that logs. The HTTP side is already guarded (`index.ts:7637`).

### 5.4 Secrets and the vault · holding

The 0600 list is test-held, the token comparison is constant-time
(`access.ts:303-309`), the join code is 8 characters over a 31-symbol alphabet with
misses counted and the code burnt after a few (`shared/nodes.ts:69-74, 515-517`),
sealed lending is signed and sealed per node (`seal.ts`), and the vault page has a test
that fails on a value coming out (`server/test/vaultview.test.ts`). Two gaps: the bot
token's file is written with `writeFileSync`'s mode option rather than `chmod`
(`telegram.ts:1869`, §1.6), and failed key saves are silent (§1.5).

### 5.5 Crash recovery · low · S

The pty host is a launchd job of its own and outlives everything; `lifecycle.log` shows
no crashes in its 153 current lines. The gap: the installed app's runner does not
restart a server that crashes after running for hours (`server/run.mjs:227-233` — it
exits with it). That is right for a server that cannot start, wrong for one that ran
for an hour and hit a rare bug at 3 a.m. while the phone was the only client. Restart
with backoff when the server had been up longer than, say, 60 s; keep today's
behaviour for a crash at startup.

---

## 6. Refactoring plan, card-sized

Ordered by value against effort. **Cost** is what landing it disturbs: *reload* (web),
*reconnect* (server), *harness* (Kuru restarted), *relaunch* (desktop), *host* (every
agent — batch these).

### Now — correctness and security

| # | card | area | effort | cost |
|---|---|---|---|---|
| 1 | Origin check: drop the blanket `*.ts.net` rule, allow only this machine's name; add `decide` test rows; update architecture.md (§5.1) | security | S | reconnect |
| 2 | `say` respects "speak replies": `Voice.aside`, the tool says why when off, test (§4.1) | voice | S | reconnect |
| 3 | WebSocket dispatch: shape guard, try/log around `handleMessage`, `default: satisfies never` (§5.3, §1.2) | server | S | reconnect |
| 4 | `cards` tool: honour `column`/`card`, live columns first, Done summarised, clip from the front (§3.4) | harness | S | reconnect + harness for the schema |
| 5 | KUR-179: defer the quit decision one tick, test SIGTERM on a signed build (§4.2) | desktop | S | relaunch |
| 6 | Sweeps wrapper that catches and logs; log failed `writeConfigFile`, `session.json` and `onRequest` errors (§1.4, §1.5) | server | S | reconnect |

### Next — scalability, before the boards grow

| # | card | area | effort | cost |
|---|---|---|---|---|
| 7 | Host blob: no boards, ~100 ms coalesce, skip when unchanged (§2.2) | server | S | reconnect |
| 8 | `turns(at, id)` index; Kuru search through `turns_fts`; FTS trigger only on text changes; cap `voice_messages` (§2.3, §2.8) | store | S | reconnect |
| 9 | Snapshot debounce (100–250 ms trailing) and `perMessageDeflate` — the quick half of §2.1 | server | S | reconnect |
| 10 | Boards out of the snapshot: per-board messages with versions; agent deltas (§2.1) | server + web | M | reconnect + reload |
| 11 | WebSocket ping/pong, bufferedAmount cap, stringify output once (§2.5) | server | S–M | reconnect |
| 12 | Usage rollup incremental, or a 30 s trailing timer; raise `cache_size` (§2.4) | usage | M | reconnect |
| 13 | One shared `ps` read for dev servers and memory; back off with no window (§2.8) | server | S | reconnect |
| 14 | Runner restarts a server that crashed after > 60 s up, with backoff (§5.5) | runner | S | next runner start |

### Next — tokens

| # | card | area | effort | cost |
|---|---|---|---|---|
| 15 | Harness line: `--strict-mcp-config`, no plugin skills, allow-list by name (§3.1) | harness | S | harness |
| 16 | Compaction instructions in `HARNESS_AGENTS_MD` (≤ 5k summary, drop finished work) (§3.2) | harness | S | harness |
| 17 | Batch done notices over 30–60 s, drop when the agent resumes; mark cut quotes (§3.3, §3.5) | harness | M | reconnect |
| 18 | Role sections and tools only for features that are set up (Nodes, Telegram, Machines, Voice) (§3.7) | harness | S | harness |
| 19 | Settings → Agents: "agents load only kururu's MCP" switch per profile, off by default (§3.9 last row) | agents | S–M | reconnect + reload |
| 20 | Opt-in away digest for overnight done notices (§3.6) | harness | M | reconnect |
| 21 | Session rotation for Kuru with a handoff note (§3.2, if 16 is not enough) | harness | M | harness |

### Structure — one module per card, each in a worktree

| # | card | effort | cost |
|---|---|---|---|
| 22 | `context.ts`: the `let x!` singletons, `clients`, send/broadcast, `snapshot()` | M | reconnect |
| 23 | `ws/dispatch.ts` + per-area handler files from `handleMessage` | M | reconnect |
| 24 | `http/router.ts` route table + per-area route files from `handleRequest` | M | reconnect |
| 25 | `cards.ts` + `carddev.ts` out of index.ts | S | reconnect |
| 26 | `terminals.ts`, `notices.ts`, `madelinks.ts` out of index.ts | M | reconnect |
| 27 | `appearance.ts`, `lending.ts`, `repostatus.ts`, `editors.ts`, `sweeps.ts`, `boot.ts` | M | reconnect |
| 28 | `fsutil.ts` (`writeAtomic`, `stateDir`, `inside`) and `shared/text.ts` (`shq`, `abbreviateHome`, `randomHex`); move `qr.ts` to `shared/` (§1.6, §1.7) | S | reconnect |
| 29 | Harness tool table; `Workspaces.X` calls `XIn` (§1.3) | M | reconnect |
| 30 | `App.tsx` effects into hooks (§1.3) | M | reload |
| 31 | `@ts-check` or `checkJs` for `desktop/` and `server/*.mjs`, in `bun run typecheck` (§1.9) | M | none |
| 32 | `noUnusedLocals` on; delete the dead exports (§1.8) | S | none |
| 33 | Tests: `databases.ts` READ ONLY gate, `backup.ts`, `sleep.ts`; fake clocks for the three slow test files (§1.10) | M | none |
| 34 | Docs: CLAUDE.md credit-chip lines, proxy line, git line; `shared/backup.ts:171` restore text; `docs/map.md`; `server/package.json` scripts; cut CLAUDE.md invariants to one line + link (§1.12, §3.8) | S | none |
| 35 | DMG diet: drop `onnxruntime-web` and transformers' web builds, verify Kokoro in a signed build (§1.11) | S–M | rebuild |

### Host batch — one restart, when the user chooses

| # | card | effort |
|---|---|---|
| H1 | Backlog cache per agent/grid/output position (§2.6) | M |
| H2 | A "visible rows as text" verb for `OnScreen` (§2.7) | S |

Both are pty host code: they reach agents only on a host restart, which ends every
running agent. Build and test them in an isolated instance, land them together with
whatever host work is pending, gate on `HostInfo.current`, and ask before the restart.
