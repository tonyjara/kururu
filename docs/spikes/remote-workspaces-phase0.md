# Remote workspaces phase 0: the watch socket, measured

Phase 0 of [the remote workspaces plan](../plans/remote-workspaces.md#phase-0--a-spike-measured-1-day),
run on 2026-10-20 against `d8f508f`. The spike code was never on `main` and
never ran anywhere but throwaway instances. It is kept here as
[`spike.patch`](remote-workspaces-phase0/spike.patch), which applies to
`d8f508f`, beside the two timing scripts. Nothing else in the tree changed.

The short version: **the watch socket is a `/ws`, confirmed.** The child
needed a door and nothing else. Past the node handshake, its `handleMessage`,
`applySize`, `sendBacklog` and `syncWatched` served the Mac's server exactly as
they serve a phone. **A keystroke's echo from the Mac to omarchy costs what the
round trip costs, about 167 ms at the median.** That is the same whether the
page dials the box directly or goes through the Mac's relay, and the same as
`ssh -tt omarchy` today. The relay costs about half a millisecond. The plan's
"1–5 ms, indistinguishable from local" does not describe this pair of
machines: Tailscale says `direct`, and direct here means across the internet.

## What was built

Three pieces, all behind environment variables nothing sets by default:

- **`NodeHost.watchHandshake`** (`nodes.ts`). This is `LinkHandshake` as it
  stands, run on a socket that is not a `Link`. It calls `up(peer)`
  synchronously from inside the frame that proved the peer, and takes its
  listener off in the same call. That turned out to matter (finding 2).
- **The child's door** (`index.ts`, `KURURU_SPIKE_WATCH=1`). `/link/watch`
  makes the `/link` refusals (`nodeRequestRefusal`) and runs the handshake.
  It then refuses any peer but `parentId()` and calls `admitClient(ws)`. That
  function is the body of `/ws`'s success path, lifted out unchanged: the
  `clients.set`, the opening sends and the three listeners.
- **The relay** (`spikewatch.ts`, `KURURU_SPIKE_WATCH_URL` and `_NODE`, with
  `_AGENT` optional). It dials the child, proves itself and logs the child's
  snapshot. It then relays one agent as `n:<node>:<id>` in a hard-coded pane,
  split beside the active workspace's tree in the outgoing snapshot only.
  `Workspaces` never sees it. A Mac client's `input`, `propose-size` and
  `request-backlog` for that id go to the child with the id bare. `watch` and
  `looking` are recorded as usual and then summarised to the child as one
  client: watching if any Mac client watches, looking if any looks, and the
  `smallestGrid` over the Mac's looking proposals. The child's `output`,
  `grid` and `backlog` come back qualified, behind the same per-client
  `awaiting` hold `index.ts` keeps. `syncWatched` and `applySize` skip
  qualified ids, so the Mac's host never hears of them.

## Where it ran

- **Two throwaway instances on this Mac**, from a scratch copy outside
  `~/Desktop` with `node-pty` cloned (`docs/testing.md`): a parent on :7871
  and a child on :7872 with `KURURU_LOOPBACK_TOKEN=1`, paired by the join
  command, `KURURU_NODE_ADDRESS=127.0.0.1`, `HOME` scratch and `SHELL=/bin/sh`.
- **A throwaway child on omarchy** on :7873. It ran the same tree, built on
  the box against the box's own `node_modules`, with `KURURU_BIND=tailscale`
  and its own config, state and host under `/tmp`. It was paired with the
  throwaway Mac parent through `ssh -R 7871:127.0.0.1:7871`, so the join and
  the child's `/link` reached the parent by the box's loopback. The relay then
  dialled the box's tailnet address directly. The box's own kururu (its
  :7717, its host unit, its roster) was never touched, and the user's :7717
  on the Mac was never touched either.

The relayed agent was a `cat` each time. Its pty's line discipline does the
echo, so what is timed is the road and not a program.

## The first half: the snapshot

```
kururu: spike watch: proved n0a1b2c3d4e5f; now a /ws client of it
kururu: spike watch: snapshot: 1 workspace(s), 2 agent(s)
kururu: spike watch:   workspace main: 95 bytes of layout
kururu: spike watch:   agent a1 shell  idle
kururu: spike watch:   agent a2 shell  idle
kururu: spike watch: relaying a2 as n:n0a1b2c3d4e5f:a2
```

and on the box, `kururu: spike watch: mac is watching`.

## The second half: one agent in a pane

The parent's page was opened in headless Chrome, driven over the DevTools
protocol, and the hard-coded pane drew as `shell · on n0a1b2` (the spike's label: the node id's first six). It showed the
box's `cat` with its backlog, including a line typed into the box beforehand.
Keys pressed in that pane were then read back off the box's own server as
part of its screen: `typed in the mac page`, echoed and repeated by `cat`.
The Mac proposed 100×30, and that grid came back in the child's backlog.
Ids of the form `n:<node>:a2` went through `terminals.ts`'s pool and the pane
code with no change.

## The numbers

Each sample is one key sent as `input` on a `/ws`, timed to the `output`
frame carrying its echo. Keys go out one at a time at random 20–80 ms gaps.
(The first runs used a fixed 15 ms gap. That phase-locked to the host's flush
and read a flat 17 ms.) The scripts are [`echo.mjs`](remote-workspaces-phase0/echo.mjs)
and [`sshecho.mjs`](remote-workspaces-phase0/sshecho.mjs).

**On this Mac, loopback**, 2 rounds of 250:

| road | p50 | p90 | p99 | mean |
|---|---|---|---|---|
| the parent's own `cat` | 10.2–10.4 | 16.9–17.3 | 18.2–20.0 | 10.2–10.4 |
| the child's `/ws`, direct | 10.0–11.1 | 17.2–17.6 | 18.3–19.0 | 10.0–10.7 |
| the child, relayed through the parent | 10.6–11.2 | 17.1–17.7 | 19.5–19.6 | 10.7–11.0 |

**Mac to omarchy, over the tailnet**, 3 rounds of 150, ms:

| road | p50 | p90 | p99 | mean |
|---|---|---|---|---|
| ICMP `ping` (20 per round) | | | | 165–173, min 151 |
| the box's `/ws`, direct (path B) | 166–168 | 232–238 | 521–561 | 188–192 |
| relayed through the Mac's server (path A) | 167–170 | 229–237 | 250–260 | 179–185 |
| `ssh -tt omarchy cat`, the machines feature's road | 168–171 | 230–240 | 254–263 | 183–187 |

`tailscale status`, read by hand on both sides at the time:

```
mac:      100.101.102.103  omarchy  linux  active; direct 203.0.113.20:14020
omarchy:  100.101.102.104  mac      macOS  active; direct 198.51.100.7:41641
```

(Addresses replaced with documentation ranges; the real ones were the box's
and the Mac's own public addresses.) Both ends say `direct`, and both endpoints
are public addresses. The two
machines are on different networks, with UDP punched through both NATs, so
"direct" is a straight line across the internet. DERP was never seen, and
forcing it would take more `tailscale` than reading `status`, so a relayed
path was not measured. A DERP path would add the relay's own distance on top
of these figures.

A backlog on open took one round trip and a little more: 150–225 ms direct
and 166–357 ms relayed, against 2–5 ms on loopback.

## Findings

1. **The floor is the host's flush, paid once.** `OUTPUT_FLUSH_MS` is a 16 ms
   `setInterval` in `ptyhost.ts`, so every echo waits between 0 and 16 ms
   (mean 8) on whichever node holds the pty. That is the whole of the 10 ms
   local figure. The relay adds no second wait, because the Mac's server
   forwards each child `output` frame the moment it arrives. **Phase 1 must
   keep it that way.** A coalescing step in `nodewatch.ts` would be a second
   frame on every keystroke.
2. **The hand-off from handshake to client must be synchronous.** `ws` emits
   every frame parsed from one TCP chunk in the same tick. A promise resolved
   by the proving frame would let the next frames (on the child, the Mac's
   first `watch`; on the Mac, the child's `snapshot`) fall through to nobody.
   `watchHandshake` swaps listeners inside the frame. `LinkHandshake` itself
   needed no change. `NodeHost.open` cannot be reused, because it ties the
   handshake to a `Link` and `onFrame`.
3. **The child needs only the door, and one lifted function.** `/ws`'s
   success path became `admitClient(ws)`, and `/link/watch` calls it. Nothing
   else on the child was edited, and the size the Mac proposed was the size
   the child's backlog came back at.
4. **A watch is a client in every way the child counts one.** On open it is
   sent everything a window is sent: 18 message types and about 13 kB on a
   near-empty profile. That includes `web` (4.2 kB), `voice` (2.8 kB),
   `snapshot` (2.2 kB), `nodes` (1.9 kB), `secrets` hints, `usage`,
   `openrouter`, `channels`, `kuru` and `backup`. It enters `clients.size`,
   and three things key off that: the usage poll, the first-client machine
   and OpenRouter polls, and the database pools. `voice.hush` and Kuru's
   speech would also address it. Phase 1 wants a `watcher: true` tag on
   `ClientState`, read in those places. With it, a watch skips the opening
   sends the relay drops, starts none of the polls (the Mac draws its own
   bar), and takes no part in voice. The tag does not need a new socket or
   protocol. The spike put the watch in `linkWss` and reached
   `admitClient` only after the handshake, so it never set `remoteClientAt`,
   which the setup wizard reads as "the phone arrived". Phase 1 must keep
   that.
5. **The relay costs about half a millisecond**: 0.5–0.8 ms of mean on
   loopback. Over the tailnet it is lost in the jitter: path A's median is
   within 1.5 ms of path B's in every round.
6. **A fresh direct socket had a tail the long-lived relay socket did not.**
   Path B's p99 was 520–560 ms in all three rounds, with maxima to 900 ms.
   Path A's was 250–260 ms. Each B run opened a new connection across the
   internet. The relay's socket to the box had been up for minutes. This was
   not chased, but it is one more small point for A.
7. **The refusal of a non-parent watcher is written and not exercised.** It
   would take a second child's key to try it, and the spike had none in hand.
   Phase 1's test is the right place: a `watchHandshake` between two
   `NodeHost`s in `nodes.test.ts`, with a sibling refused.

## What it means for the plan

- **The relay (A) stands, and the direct route (B) for the window has no case
  left.** It saves nothing measurable and showed the worse tail.
- **Remote panes will feel like the machines feature's ssh shells to
  omarchy, because that is what they are on the wire.** That means about
  170 ms per key, 230–260 ms at p90. Nothing in kururu changes that. Only a
  local echo (mosh's prediction) would make typing feel local, and that is a
  feature of its own, not phase 1.
- **A remote pane fills a round trip later than a local one.** The pool's
  warm emulators matter more here. A remote terminal kept warm is the
  difference between switching to it and waiting a beat.

## Cleanup

All three throwaway servers were stopped. Their hosts were ended by socket
(`kill-hosts.mjs /tmp/krw/p/ptyhost.sock`, and the same for the child and the
box's `/tmp/krw-o/c/ptyhost.sock`), after `--list` dry runs that named only
them. The two dead launchd labels the Mac's throwaway hosts left were
removed with `launchctl remove`. `/tmp/krw-o` was deleted on the box. The
user's host (pid 48633, 18 terminals) and the box's host unit and server were
running before and after.
