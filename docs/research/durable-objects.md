# Durable Objects, "pi durable objects", celld, and where the dev servers go

Research, dated 2026-10-24. **No code was changed** to write it. Two kinds of
evidence are kept apart throughout. **Read on the page** means a Cloudflare,
Earendil, Deno or GitHub page read on 2026-10-24, with the page's own "last
updated" date in brackets. **Estimated** means arithmetic of mine over list
prices, with the assumptions stated beside it, or a latency figure reasoned
from geography rather than measured. Prices are list prices in US dollars on
the day; Cloudflare changes them by changelog and the dates below say which
version was read. The reading of licences is a developer's, not legal advice.

The question had three parts: what Durable Objects and the pieces around them
are today and cost; what "pi durable objects" most likely means; and whether
any of it should replace the Omarchy PC, dead in a storm, which was the
home dev box — a child kururu, Dokploy with the preview deployments, the
self-hosted Firecrawl and SearXNG behind `kururu_web`, all reached over the
tailnet. The always-on machine now is the one VPS. The user added
[celld](#6-celld-durable-objects-on-your-own-boxes) to the list while this was
being written.

## The short answer

**Durable Objects are the right shape for the small, always-up coordinator
kururu does not have, and the wrong shape for its dev servers.** A Durable
Object (DO) is a single-threaded JavaScript actor with its own SQLite
database, a WebSocket server that hibernates for free, and one alarm; it is
cheap to the point of free at kururu's scale ([estimate A](#estimates), $0 on
the Free plan, $5 a month on Paid) and it is up when every machine of ours is
asleep. That is the one thing no node of kururu's can offer today: the
parent is a Mac with a lid, and the child that outlived it was the box that
died. The designs that use it are a *shadow* of each node's summary and
Needs that a phone can read from anywhere with a dead-man's alarm that says
"the Mac went away at 23:10", an off-machine inbox so words typed into a
phone reach a node when it wakes, and a Telegram webhook that would retire the
whole leader-election dance in `lead.ts`. Each adds Cloudflare to a path that
today stays on the tailnet, and the document says what crosses in each case.

**For dev servers, Containers and the Sandbox SDK are built for a different
job.** A container's disk is lost when it stops, the longest it will idle is
six hours, nothing on the internet can reach a port in it except through a
Worker you write, and the two-vCPU size costs about as much per month in
weekday hours as a whole VPS does around the clock ([estimate B](#estimates)).
Above all, kururu's agents edit files on the machine whose pty host owns their
terminal, and a dev server has to see those files: a container somewhere else
would run a dev server on a clone, not on the worktree the agent is typing
into. The fit is for *disposable* work — Cloudflare's own guides run Claude
Code, Codex, OpenCode and Pi in a sandbox for one task and hand back a diff —
and for a public preview link, neither of which is what the Omarchy box did.
What replaces the box is a second always-on Linux node, and the comparison in
[§4](#4-remote-dev-servers) is among the ways to get one.

**"pi durable objects" almost certainly means Pi Durable on Durable Objects.**
Pi is Mario Zechner's minimal coding agent, now Earendil's; Pi 1.0 shipped on
2026-10-01 with **Pi Durable**, a crash-tolerant harness whose SQLite storage
runs unchanged inside a DO; and Cloudflare's Agents SDK gained `PiHarness`
the next day, which runs it in one. Both words of the phrase are product
names. The runner-up reading — Sunil **Pai**, whose PartyServer is the class
the Agents SDK's `Agent` extends — is the layer underneath the same thing.
For kururu, Pi the CLI is a launcher worth adding one day (it has an RPC mode
and reports its status in-band); Pi Durable is a different runtime from the
one kururu oversees, and `PiHarness` has no permission step, so "the agent is
asking" does not exist there yet.

**celld is the DO programming model on your own machines**, Ryan Dahl's Rust
daemon, Apache-2.0, in beta since August and v0.6.3 on 2026-10-21, coordinated
through a bucket you own. Cloudflare acquired Deno on 2026-10-09 to fold it
into `workerd`, so its ideas will outlive its name. It does not fit kururu
now: its durability posture needs two running nodes and ours would be one VPS
and a sleeping Mac, its containers need Docker on every node and are
experimental, and the coordinator problem it would solve for us is the one
Cloudflare's hosted DOs solve for nothing.

**Try first:** the shadow-and-alarm DO on the Free plan, as a page the phone
can open without the tailnet; and Cloudflare Tunnel with Access, which is
free for a team under fifty, as the phone's HTTPS instead of `tailscale
serve` — it gives the phone the secure context its microphone has waited on.
**Skip:** Containers for dev servers, a DO relay for the node links, celld
for now, and Pi Durable as a Kuru.

## 1. Durable Objects today

### The model

A Durable Object is one instance of a class you deploy with a Worker, named
by an id, with exactly one running copy anywhere in the world, single-threaded
and cooperatively scheduled "just like code running in a web browser", and
with a storage that only it can reach [1][2]. A stub is free; the constructor
runs at the first call. The object is placed near where that first call was
made and **does not move afterwards** [5]. Location hints are best-effort and
`sam`, South America, is a hint under which "objects don't spawn here" — they
land in a nearby supported location, Eastern North America [5]. So a DO made
for kururu from Paraguay lives in Miami or Virginia, and every call pays that
round trip: on the order of 100–150 ms (estimated, not measured; the Worker
in front of it runs at Cloudflare's Asunción edge, the object does not).
`where.durableobjects.live` is the place to see where one actually lands.

### Storage

New classes are SQLite-backed; the older key-value backend is only for
accounts that already have one, and is closed to the Free plan [2][7]. Each
object has a SQL API (`ctx.storage.sql.exec`, with FTS5 and JSON), a
synchronous KV API over the same database, transactions, and point-in-time
recovery to any moment in the past thirty days [7]. The per-object limit is
10 GB, a row or value 2 MB, and per-account storage is unlimited on Paid and
5 GB on Free [2]. One page says the Free plan's per-object cap is 1 GB and
another says 10 GB; the pages do not agree, so treat Free as 1 GB until it is
tried [2][10]. Storage billing for SQLite objects started on 2026-01-07 [1].

### WebSockets that hibernate

A DO accepts WebSockets with `ctx.acceptWebSocket()`, and after about ten
seconds without events the *object* is evicted from memory while the
*connections stay open on Cloudflare's network*; the next message re-runs
the constructor and delivers it [3][4]. Duration is not billed while
hibernated, incoming messages are billed at twenty to the request, outgoing
ones are free, and ping frames are answered without waking it [1][3]. Only
inbound sockets hibernate — an outbound WebSocket from the object holds it in
memory, and so does any pending I/O, for up to fifteen minutes [4]. Up to
32,768 sockets may hang off one object, each with a 16 KB attachment that
survives hibernation while the socket does [6]. Deploying new code
disconnects every socket on every object, so clients reconnect as a matter
of course [3].

### Alarms, RPC, and the gates

One alarm per object, at-least-once, retried six times from two seconds with
backoff, fifteen minutes of wall time for the handler [8][2]. Methods on a
class that `extends DurableObject` are callable as RPC from a Worker or
another object, serialized up to 32 MiB [12]. `blockConcurrencyWhile` closes
the input gate for at most thirty seconds, after which the object is reset
[6]. An object serves "a soft limit of 1,000 requests per second" and answers
an overload error past it; the rules page's working numbers are 500–1,000 a
second for trivial handlers and 200–500 with storage writes [9][10].

### Lifecycle numbers worth knowing

Hibernation after about 10 s idle when nothing is pending; eviction of a
non-hibernatable idle object after 70–140 s; pending I/O keeps an object
alive and billed for up to 15 min; in-flight requests get 30 s during a
runtime update; 128 MB of memory per isolate; CPU time 30 s per request by
default and configurable to 5 min [4][2][14]. There are no processes: a DO
is a V8 isolate, and anything that needs Linux goes through
`ctx.container` ([§1, Containers](#containers)).

### Free against Paid

The Free plan has had DOs since 2025-04-07 [11]. Free: SQLite only, 100
classes, 5 GB, 100,000 requests a day, 13,000 GB-s a day, 5 M rows read and
100,000 rows written a day, each limit resetting at 00:00 UTC and failing
that operation when crossed [1][2]. Paid is the $5 minimum for Workers plus
the included amounts in [§3](#3-prices).

### The pieces around it

**Workers** are the stateless front: every request to a DO goes through one,
and the Worker is where you check who is calling before the object sees it.
Free is 100,000 requests a day at 10 ms of CPU each; Paid is $5 a month with
10 M requests and 30 M CPU-ms included [13].

<a id="containers"></a>
**Containers** are Linux microVMs, each owned by one Durable Object and
reached only through it: "a Container can only be accessed through its
Durable Object", and "end-users cannot make non-HTTP TCP or UDP requests"
[20][30]. They went GA on 2026-04-13 on the Paid plan [22]. Six sizes, from
`lite` (1/16 vCPU, 256 MiB, 2 GB) to `standard-4` (4 vCPU, 12 GiB, 20 GB),
and custom sizes from 1 to 4 vCPU with at least 3 GiB per vCPU and at most
20 GB of disk [19]. Cold starts "can often be in the 1–3 second range" [21];
the rebuilt scheduler of 2026-09-30 measured 648 ms median and 1.1 s p99 for
a burst of a hundred, down from four and six seconds [28]. **Disk is
ephemeral**: "the next `start()` creates a new instance from the image"
[32]; what survives is a filesystem snapshot of up to 20 GB that expires
thirty days after its last restore (public beta), or an R2 bucket mounted
over FUSE "below SSD speed" [19][21][28]. An instance keeps running after its
object goes idle for an inactivity timeout of **at most six hours**, work
inside the container does not count as activity, and "Cloudflare does not
guarantee that an instance runs for a set time" [32]. Placement is the
nearest location holding a pre-fetched image, which "may be farther away
from the end-user" [20]; regional constraints since 2026-04-05 list `SAM`
among the regions a container may be pinned to, which a Durable Object
cannot be [24][5]. SSH into a running instance is `wrangler containers ssh`
over the control plane, never a public port [26]. The account may run 1,500
vCPU, 6 TiB and 30 TB at once since 2026-02-25 [23]. The `Container` class
from `@cloudflare/containers` and the legacy `Sandbox` class get updates
only until 2026-12-31; new code uses `ctx.container` [28][27].

**The Sandbox SDK** (`@cloudflare/sandbox`, 1.0 on 2026-09-30) is the
container story told for agents: your own Durable Object starts a container
from the `cloudflare/sandbox` image, runs commands with streamed output,
opens PTY terminals, snapshots the filesystem, mounts a bucket, and serves
**preview URLs** [31][38]. A preview is a route *you* write on your Worker's
hostname, `/previews/<name>/`, forwarded to the container's port with
`getTcpPort()`; the page says plainly that the example has no authentication
and "anyone who can reach the Worker can reach a preview by name", and shows
a one-hour share token kept in the object's storage [34]. WebSockets pass
through, but only a bridged connection keeps the sandbox alive; Vite's HMR
works once its `allowedHosts` admits the preview hostname, and absolute asset
URLs break under a path prefix, which is why the page recommends one
hostname per preview — the same reason `proxy.ts` is a port per preview and
never a path [34]. Credentials are kept in the Worker and injected into
outbound requests by hostname, so "the sandbox never receives" the model key
[41]. The GA post's numbers: boot plus clone plus `npm install` about 30 s,
restore from a backup about 2 s [39]. The coding-agents section has a shared
runner and one guide each for **Claude Code, Codex, OpenCode and Pi**, all
headless: `claude --print --output-format stream-json
--dangerously-skip-permissions --no-session-persistence`, the key replaced
at AI Gateway, the result read off an events file after exit, the changes
returned as a diff; no interactive terminal, no session resume, no `git
push` [35][36][37]. Vendor-run loops — Devin, Cursor Cloud Agents, Claude
Managed Agents, the OpenAI Agents API — use the same containers as hands
[35].

**The Agents SDK** (`agents` on npm, 0.30.1 on 2026-10-23, pre-1.0) is a
`DurableObject` subclass with state synced to clients, a `schedule()`
multiplexed onto the one alarm, WebSocket callbacks, `@callable` RPC, an MCP
client and (through `createMcpHandler`) an MCP server, and since October the
two harnesses: `PiHarness` ([§2](#2-pi-durable-objects)) and an experimental
`OpenCodeHarness` [42][43][47]. Its `Agent` extends PartyServer's `Server`,
which extends `DurableObject` [48]. A sandbox is attached to an agent through
`ctx.container` with a 10-minute inactivity timeout in the example, internet
off by default, and the note that "all users of one agent instance share its
sandbox" [40].

**Workflows** are durable execution — `step.do` with retries, `step.sleep`
up to a year, `waitForEvent` — GA since 2025-04-07 and on both plans [17][16].
Free: 3,000 steps a day, 100 concurrent instances; Paid: 500,000 steps
included then $0.80 per 100,000, 50,000 concurrent [15][16]. Step billing
began 2026-08-10 [15].

**Cloudflare Tunnel** is `cloudflared` making outbound connections so a
service behind NAT answers on a Cloudflare hostname with TLS; HTTP, SSH, RDP
and arbitrary TCP, the non-HTTP ones streamed over a WebSocket to a
`cloudflared access` client or a browser-rendered terminal [52][54][56]. It
belongs to Zero Trust, whose Free plan is "$0 forever" for teams under fifty
users, with Access policies, 24-hour logs and community support [57]. A
**quick tunnel** needs no account or domain, gets a random
`trycloudflare.com` name that dies with the process, allows 200 in-flight
requests and has no uptime promise [53]. Two things to carry over from
`tailscale serve`: the tunnel delivers to kururu from loopback with proxy
headers, so the **`loopbackToken` switch must be on** or every visitor is
the loopback that the token gate exempts, and `/link` and `/api/nodes/join`
already refuse a proxied request, so the node mesh stays on the tailnet
whatever the phone uses.

**Dynamic Workers** (open beta 2026-03-24) load code at runtime into fresh
isolates, 1,000 unique Workers a month included then $0.002 per Worker per
day; **Facets** (beta, 2026-04-13) let a supervisor object hold child
objects with their own SQLite from dynamically loaded code; **Artifacts**
(2026-04-13) is git-compatible storage [45][46]. These are the pieces
Cloudflare's own "coding agent in a DO" demos lean on instead of a
container when no native build is needed ([§2](#community-builds)).

### A timeline

- 2025-02-25 Agents SDK. 2025-03-25 remote MCP servers on Workers.
- 2025-04-07 DOs on the Free plan; SQLite storage GA at 10 GB; Workflows GA.
- 2025-06-24 Containers public beta; 2025-06-25 Sandboxes; 2025-08-05 Sandbox
  SDK major update (preview URLs, code interpreters).
- 2025-09-23 VibeSDK; 2025-09-26 Code Mode; 2025-11-21 active-CPU billing for
  Containers and R2 FUSE mounts; 2026-01-07 DO storage billing.
- 2026-01-29 Moltworker (OpenClaw in a sandbox); 2026-02-25 container limits
  ×15; 2026-03-24 Dynamic Workers beta.
- 2026-04-13 Containers and Sandboxes GA, Facets, Artifacts; 2026-04-15
  Project Think; 2026-05-19 Claude Managed Agents on Cloudflare.
- 2026-09-30 Sandbox SDK 1.0, `durable_object` scheduling policy, container
  snapshots, the faster scheduler.
- 2026-10-01 Pi 1.0 and Pi Durable; 2026-10-02 `PiHarness`; 2026-10-09
  Cloudflare acquires Deno (celld); 2026-10-12 `OpenCodeHarness`.

Sources for the timeline: [11][12][22][23][28][38][44][45][46][77][98].

## 2. "pi durable objects"

### The reading, and why

The phrase is **Pi Durable** running on **Durable Objects**. Three concrete
things carry that name:

1. **`PiHarness` in Cloudflare's Agents SDK**, announced 2026-10-02 as "built
   with Earendil": "Pi runs the agent loop, while PiHarness gives Pi storage
   in the Durable Object's SQLite database, and wakes the object when Pi has
   work to finish" [44][43]. It is the thing Zechner himself called "Pi
   Durable in the agents SDK" [71].
2. **Cloudflare's "Run Pi in a sandbox" guide** (2026-10-13), one of the four
   coding-agent runners, which runs the Pi *CLI* headless in a container with
   `--mode json --no-session --provider cloudflare-ai-gateway` [37].
3. **celld's `examples/pi`**, which runs the same `PiHarness` — from the
   Agents SDK pull request that introduced it, #2197, opened 2026-09-01 by
   Matt Carey of Cloudflare — inside a self-hosted cell ([§6](#6-celld-durable-objects-on-your-own-boxes))
   [94][50].

The alternatives were checked and set aside. **Sunil Pai** founded PartyKit,
which Cloudflare bought in 2024; his PartyServer is "powered by Durable
Objects", and the Agents SDK's `Agent` class extends its `Server` — so a
half-remembered "Pai" would name the layer `PiHarness` stands on, not a
different product [81][48]. **Raspberry Pi** and Cloudflare meet only in
Tunnel tutorials, with no Durable Objects angle. Inflection's Pi, "pi-base"
and the like have none. The one stray hit, `PiSharp.Durable` on NuGet, looks
like a .NET port of Pi Durable and its relation to Earendil is unconfirmed.

### Pi, the coding agent

Pi is "a minimal, extensible agent harness that you can make your own": four
tools (`read`, `write`, `edit`, `bash`), a system prompt under a thousand
tokens, no sub-agents, no plan mode, no permission system, and everything
else an extension installed from npm or git [63]. Mario Zechner wrote it as
`badlogic/pi-mono`; on 2026-05-07 it moved to Earendil Inc., formed by Armin
Ronacher and Colin Daymond Hanna, with the npm scope changing from
`@mariozechner` to `@earendil-works` and Zechner staying on as a shareholder
leading technical direction [69][70][71]. The repository has about 117,600
stars and 7,100 commits, MIT, and needs Node 22.19 or newer [63]. **Pi 1.0**
shipped on 2026-10-01 — native MCP through Codemode, which reversed an
earlier stance, deferred tool loading, Anthropic cache warming, a
full-screen TUI — and the packages were at 1.4.0 on 2026-10-21 [61][62][84].
There is no hosted Pi; Earendil's **Radius** is an "early alpha" of hosted
services for Pi users (an AI gateway, artifacts for `/share`, web search),
reached by `/login radius`, with no price listed [73].

What matters to a program that oversees agents in terminals: Pi has four run
modes — interactive, `-p` for one answer, `--mode json` for a one-shot event
stream, and **`--mode rpc`**, a long-lived JSON protocol over stdin and
stdout with `prompt`, `steer`, `follow_up`, `abort`, `get_state`, `fork` and
the rest, where `agent_settled` is the real "done" and
`extension_ui_request` is "it is asking the user" [65][66]. Sessions are
files under `~/.pi/agent/sessions/`, grouped by directory, resumable by id
[68]. Since 1.1.0 (2026-10-07) Pi reports its status in-band over OSC 7501,
which a pty reader could take instead of parsing the screen [84]. Pi 0.99
added "Sign in with ChatGPT"; a Claude-subscription login is not named on
its providers page and is unconfirmed [84]. Pi's README still points at
OpenClaw as "a real-world integration", but OpenClaw dropped Pi's packages
for its own `@openclaw/agent-core` sometime between May and October 2026,
and Cloudflare's Moltworker (2026-01-29) ran OpenClaw in a sandbox
container, never in a Durable Object — that thread is history [63][79][77].

### Pi Durable

Announced with 1.0 by "Earendil Engineering": "an experimental TypeScript
framework for building long-running, crash-tolerant, multi-user agentic
applications", MIT, about 15,000 lines, which "does not replace the Pi
coding agent" [60]. The model: a **Harness** opens one storage and runs many
**Conversations**; a conversation is an immutable transcript of entries;
every change is an atomic **Commit**; typed JSON **Documents** commit beside
the transcript; a **Task** is a durable state machine that checkpoints each
phase and may end asleep; tasks form an ownership tree; a `requestId` makes
a submission exactly-once; any number of clients attach and receive the
current view rather than a replay, and may steer or queue follow-ups
[60][64]. After a crash, interrupted model calls are resent, tools marked
replay-safe run again, others come back to the model as interrupted, and a
task that crashes five times is parked [64]. Storages shipped: memory,
IndexedDB, SQLite, JSONL, and `storage/sqlite/cloudflare` for one Durable
Object; the SQLite core avoids Node APIs on purpose so that it runs in a DO
or on Bun [64][60]. One process owns a storage at a time; a second may open
it `readOnly` to watch [64]. Pi Durable's Hacker News thread drew 515 points
[72], and Vercel ships a parallel `durable-harness/pi-durable` that keeps the
same harness's commits in Vercel's workflow log, with its tools in a Vercel
Sandbox [82].

### `PiHarness`

`PiHarness` is "a Lifecycle capability" of the Agents SDK: Pi owns the
transcript, inbox, tasks, retries and recovery in `pi_*` tables of the
object's SQLite; the SDK supplies the storage and a Lifecycle job that wakes
the object [43]. While Pi works a heartbeat alarm fires every 30 s; when its
tasks sleep the object may hibernate until the next wake; after an eviction,
a crash or a deploy (30 s of grace) the alarm restarts the object and Pi
continues from its last checkpoint; a model stream longer than fifteen
minutes can be cut, because that is the alarm handler's limit [43]. Clients
connect over WebSockets, HTTP or RPC and get a snapshot then event batches;
the stream is in memory and is opened anew after a restart [43]. It ships
in `agents@0.26.0` and later, each `agents` release pinned to one Pi minor
(0.30 ↔ Pi 1.4), and Pi 1.4 changed the schema so there is no rolling back
past it [49][43]. Models come through Workers AI or AI Gateway with
`createAI`, or any pi-ai provider — which is to say an API key or a gateway,
never a subscription login [43]. The stated limits: **no approval or
permission step for tool calls**, no event replay cursor, `abort()` waits
for idle, background completions noticed up to 30 s late, no graceful drain,
no deleting a conversation; beta, "the API will likely change" [43]. The
example app gives Pi a filesystem on the same SQLite through
`@cloudflare/computer` and runs model-written JavaScript in a Dynamic Worker
with no network [51].

<a id="community-builds"></a>
### What people built with it

- **pi-on-cf** (Harshil Agrawal, Cloudflare; MIT): a `PiSession` object per
  conversation and a singleton `PiRegistry` with FTS5 search, Pi Durable via
  `PiHarness`, a workspace on `@cloudflare/computer`, previews in Dynamic
  Workers, a GitHub App opening draft PRs; "single-user", no app-level
  auth, "put it behind Access" [74]. His write-up of 2026-08-03 lists the
  gaps honestly: no shell, no `npm install`, active streams do not resume
  after a restart [75].
- **camelAI** (MIT, ~390 stars): "a custom harness built on pi" with a
  `ChatThreadDO` per thread, Code Mode in fresh isolates, files in SQLite
  and R2, and sandbox containers only for builds [76].
- Cloudflare's own harness index now lists Pi as "the recommended starting
  point" and OpenCode as experimental [47].

### What it means for kururu

Two different things. **Pi the CLI** is a launcher like Claude and Codex: a
real process in a pty, resumable sessions, and an RPC mode and an in-band
status channel that kururu's `onscreen.ts` would not need to parse. Adding it
to `LAUNCHERS` is a small, ordinary change, and the `/update-models` skill's
shape already fits. **Pi Durable** is not something kururu would oversee; it
is the kind of thing Kuru *is* — one conversation, many clients attached,
steering and follow-ups queued, state in SQLite — rebuilt for a server with
no terminal. Kururu's harness rule is that the harness is a Claude Code
session typed into, with no API key anywhere and the permission prompt left
to the user; `PiHarness` needs a key or a gateway and has no permission
prompt to leave. If kururu ever wanted a Kuru that runs when every machine
is asleep, Pi Durable in a DO is the nearest built thing, and it would be a
second Kuru with a different model, a different bill and no hands on this
Mac, not the one in the drawer.

## 3. Prices

All read on 2026-10-24; the bracketed date is each page's own.

### Durable Objects [1] (2026-10-18)

| | Free | Workers Paid ($5/month minimum) |
|---|---|---|
| Requests (HTTP, RPC session, WebSocket message at 20:1, alarm) | 100,000 / day | 1 M / month, then $0.15 per million |
| Duration (billed at 128 MB per active object) | 13,000 GB-s / day | 400,000 GB-s / month, then $12.50 per million GB-s |
| SQLite rows read | 5 M / day | 25 billion / month, then $0.001 per million |
| SQLite rows written | 100,000 / day | 50 M / month, then $1.00 per million |
| Stored data | 5 GB total | 5 GB-month, then $0.20 per GB-month |

Hibernated and hibernation-eligible idle objects are not billed for
duration. Outgoing WebSocket messages and protocol pings are free. Each
`setAlarm()` is one row written and each alarm firing one request. The
page's own examples: a coordination service at 1.5 M requests is $5.15; a
hundred rooms of a hundred hibernating sockets at a hundred messages a
minute each is $20.65; the same without hibernation is $142.95 to $419.30 —
hibernation is the whole difference [1].

### Workers and Workflows [13][15] (2026-10-02, 2026-09-21)

| | Free | Paid |
|---|---|---|
| Worker requests | 100,000 / day | 10 M / month, then $0.30 per million |
| Worker CPU | 10 ms per invocation | 30 M CPU-ms / month, then $0.02 per million |
| Workflow steps | 3,000 / day | 500,000 / month, then $0.80 per 100,000 |
| Workflow storage | 1 GB-month | 1 GB-month, then $0.20 per GB-month |

### Containers (Paid only) [18][19] (2026-10-05, 2026-10-21)

| Resource | Included per month | Then |
|---|---|---|
| Memory (provisioned, while running) | 25 GiB-hours | $0.0000025 per GiB-second |
| CPU (active use only, since 2025-11-21) | 375 vCPU-minutes | $0.000020 per vCPU-second |
| Disk (provisioned, while running) | 200 GB-hours | $0.00000007 per GB-second |
| Egress, North America and Europe | 1 TB | $0.025 per GB |
| Egress, everywhere else (South America) | 500 GB | $0.04 per GB |

| Instance | vCPU | Memory | Disk |
|---|---|---|---|
| lite | 1/16 | 256 MiB | 2 GB |
| basic | 1/4 | 1 GiB | 4 GB |
| standard-1 | 1/2 | 4 GiB | 8 GB |
| standard-2 | 1 | 6 GiB | 12 GB |
| standard-3 | 2 | 8 GiB | 16 GB |
| standard-4 | 4 | 12 GiB | 20 GB |

The Sandbox SDK has no price of its own; it is Containers plus the Durable
Object and Worker in front [31]. Snapshot storage is not priced on any page
read (public beta). Dynamic Workers: 1,000 unique a month, then $0.002 per
Worker per day [45].

### Around them

R2, for celld's bucket and sandbox backups: $0.015 per GB-month, Class A
$4.50 and Class B $0.36 per million, egress free; 10 GB, 1 M Class A and
10 M Class B a month free [59] (2026-10-01). Zero Trust, for Tunnel and
Access: free under fifty users, then $7 per user per month [57].

<a id="estimates"></a>
### Worked estimates

Arithmetic over the tables above; the assumptions are the first line of
each. The $5 Paid minimum is counted once.

**A. A kururu coordinator — the shadow and inbox of [§5](#5-kururu).**
Two nodes pushing a changed summary at most once a second but in practice
about 3,000 times a day each; three phones connecting twenty times a day;
a dead-man's alarm every 60 s; one row written per summary and per alarm.
That is about 1,800 billable requests a day (6,000 messages at 20:1, plus
1,440 alarms and the connections), about 7,500 rows written a day, and
about 11 GB-s of duration a day at 10 ms of activity per event. Every
figure is under 2 % of the Free plan's daily limits. **$0 on Free, $5 on
Paid**, and the 20:1 ratio means it stays there at ten times the traffic.

**B. One dev server, weekdays, 8 h a day** — the ask was 2 vCPU and 4 GB;
Cloudflare's 2-vCPU size is `standard-3` with 8 GiB, and memory is billed
as provisioned. 176 h is 633,600 s. Memory 8 GiB × 633,600 s = 5.07 M
GiB-s, less 90,000 included, × $0.0000025 = **$12.45**. CPU at 10 % of two
vCPU: 126,720 vCPU-s, less 22,500 included, × $0.00002 = **$2.08** ($5.89
at 25 %). Disk 16 GB × 633,600 s = 10.1 M GB-s, less 720,000, ×
$0.00000007 = **$0.66**. With the minimum: **about $20 a month**, $24 if
the agent keeps it busy — and the disk is empty again every time it stops,
so add a snapshot or an R2 backup and the thirty seconds to restore one.
On `standard-2` (1 vCPU, 6 GiB) the same hours are about $17.

**C. Three agents' sandboxes, 3 h a day each, every day** — 270 h,
972,000 s, `standard-3`, CPU at 30 % because agents build and test. Memory
7.78 M − 0.09 M GiB-s × $0.0000025 = **$19.22**; CPU 583,200 − 22,500
vCPU-s × $0.00002 = **$11.21**; disk 15.6 M − 0.72 M GB-s × $0.00000007 =
**$1.04**. **About $36 a month**, plus whatever keeps each workspace between
sessions.

**D. Always on, 24/7** — 730 h, 2,628,000 s, `standard-3` (Cloudflare's
largest disk is 20 GB, so the asked-for 40 GB does not exist). Memory
**$52.34**, CPU at 10 % **$10.06**, disk **$2.89**: **about $70 a month**
for a thing the platform says it will not promise to keep running, that
needs an alarm firing under every six hours to stay up, and that forgets
its disk when it does stop. Moltworker's README arrives at about $34.50 a
month for a `standard-1` the same way [78], which checks the arithmetic.
This is the estimate that says Containers are not a VPS.

**E. A `PiHarness` conversation**, for completeness: duration while a turn
is live, one request per 30-second heartbeat, one row written per
checkpoint, nothing while hibernating between sleeps; Cloudflare publishes
no Pi-specific figure, and the model calls are billed by the provider on
top [43][1].

## 4. Remote dev servers

### What the box did, and what the VPS can take

The Omarchy PC was a child kururu (`docs/linux.md`), the Dokploy host for
the self-hosted Firecrawl and SearXNG behind `kururu_web` (`docs/web.md`),
and the place cards' dev servers and previews ran when a workspace was
pinned to it (`docs/machines.md`). It died on 2026-10-22. By the time this
was written the Firecrawl stack had already been redeployed on the VPS
(2026-10-24, as a Swarm stack under its Dokploy, reached tailnet-only
through Traefik — the VPS's runbook has rules of its own and the first try
that ignored them was undone). Nothing left on the list needs a machine at
home: a child kururu is a systemd user unit, and the tailnet reaches a VPS
exactly as it reached the PC. What the PC had that a small VPS does not is
cores and RAM for free, no bill when idle, and no other tenants: the VPS
already carries the user's deployed projects, and every dev server and
Playwright process added beside them is a neighbour of production.

### Could Durable Objects plus Containers do it instead?

Taking the four questions in turn.

**Where the files are.** Kururu's agents are real processes in ptys the host
owns, editing a checkout on the machine that runs them; a card's dev server
is started beside that checkout so the agent's edits are what the preview
shows (`docs/layout.md`, the worktree plan). A container is another machine
with an empty disk. For it to serve a dev server it must hold a clone, and
for that clone to follow the agent's edits something must push them — a
commit and a pull on every save, or a file sync kururu does not have. The
only arrangement that keeps dev server and files together is to run the
*agent* in the container too, which is Cloudflare's own model: one task, one
sandbox, a diff out, `--dangerously-skip-permissions` because nobody is
there to answer [35][36]. That is a different product from a terminal the
user types into, and it would also mean a machine kind the pty host cannot
own (a container's PTY is reached through the Worker, not `ssh -t`; a bridge
command in the pty is possible and is named in [§5](#a-sandbox-as-a-machine)).

**Cold start and persistence.** One to three seconds to a shell, about
thirty to a cloned and installed project, two from a backup [21][39]. Then
the disk is gone when the instance stops, the instance stops after at most
six hours idle, and "code running inside the instance does not count as
activity" [32] — a dev server that nobody requests for six hours ends, and
with it `node_modules`. Snapshots keep the root filesystem for thirty days
and must be taken by your code [32]. Postgres beside the dev server is the
same story: a database on an ephemeral disk under a six-hour timer is a
database on a bucket mount, "below SSD speed", or no database.

**Reaching it.** No port in a container is on the internet. A preview is a
route on your Worker, public to whoever knows the name unless you put Access
or a token in front, with WebSockets and HMR working when bridged and when
each preview has its own hostname [34][20]. That is a real feature — a
preview link that works from a phone off the tailnet — and it is also
exactly the hop `proxy.ts` already makes locally, with the same frame and
Host rewriting.

**Cost.** [Estimates B–D](#estimates): $20 a month for weekday hours, $36
for three agents' afternoons, $70 for a machine that is not allowed to be
always on. A VPS at the same size is a flat two-digit sum for all three at
once.

**Latency from Paraguay.** A Durable Object will not spawn in South America
[5]; a container may be pinned to `SAM` since 2026-04-05 [24], but its object
is still in North America, so a keystroke to a terminal in it would cross
the Gulf twice. The remote-workspace spike measured 167 ms median per echoed
key between the Mac and the Omarchy box over the tailnet, the same as a
plain ping between them, and noted that "direct here means across the
internet" (`docs/spikes/remote-workspaces-phase0.md`); a DO hop would be in
that range or above it before the container is reached.

**Fit for Claude Code and Codex.** Cloudflare's guides are the proof that
both run in a sandbox, headless, with an API key injected at the gateway
[36]. Neither guide mentions a subscription login, and the Claude Code one
sets a placeholder key because "Claude Code won't start without one" — the
Max plan's OAuth that kururu's usage bar reads is not what these containers
run on, and the token kururu lends to a child as `CLAUDE_CODE_OAUTH_TOKEN`
would have to be put in a Cloudflare secret to use it there, which the
secrets rule forbids.

**Verdict.** Containers and the Sandbox SDK fit the disposable, headless,
one-task agent and the public preview link. They do not fit a worktree an
agent is typing into, a dev server that should still be there tomorrow, or
a Postgres. For the Omarchy box's job the answer is another always-on Linux
node; the choice is which.

### The alternatives

The field divides in two. **Machines** — a VPS, a Fly Machine, a dedicated
box — keep a disk and an address and cost by the month or the second
whether or not anyone is typing. **Sandboxes** — Modal, Daytona, E2B,
Vercel, Blaxel, Cloudflare — cost by the second only while running,
converge on about $0.17–0.24 an hour for two vCPU and 4 GB, and each has a
wrinkle for anything meant to outlive a session: a lifetime cap, an empty
disk, a public URL, or a plan gate. Fly's **Sprites** sit between: a
microVM per sprite with a 100 GB filesystem that survives sleep, services
that restart on wake, and a flat plan that covers a dev server's month.
Every figure below is from the provider's own page read on 2026-10-24
unless marked; the three scenarios are the ask's, with the assumptions
stated under the table, and the arithmetic is in [A3]. Hetzner is in euros.

| | one dev server, 176 h | three agents, 270 h | always on, 730 h | start | what survives a stop | lifetime and idle rules | preview URL | shell | Claude Code | free | São Paulo |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Fly Machine, shared-cpu-2x + 4 GB | $9 (gru $13) | $19 (gru $25) | $31 (gru $47) | ~2 s stopped, ~300 ms suspended | volume and rootfs, snapshots | none; proxy auto-stops and auto-starts | `*.fly.dev` with TLS; private over WireGuard | yes | it is a VM | trial: 2 h or 7 days | `gru`, at 1.615× |
| Fly Sprites | $20 flat (Adventurer) | $20 | $50–75 (Veteran) | wake under 1 s, 10 s cap | 100 GB fs, checkpoints, services | sleeps on idle; no cap | `*.sprites.app`, org-auth or public, one port | `sprite proxy --ssh` | MCP server, plugins | $30 once | cannot choose |
| Modal Sandbox | $42 (−$30 credit) | $64 (−$30) | $174 (−$30) | "sub-second" claim | fs snapshot 30 days; memory alpha | **24 h hard cap** | random public `*.modal.host`, no auth | via a TCP tunnel | official example | $30 a month | `sa`, ~1.75× |
| Daytona | $30 | $49 | $124 | <90 ms claim | fs on stop; archive after 7 days | auto-stop 15 min default, ignores running processes; 10 GB disk cap | token, signed or public per port | yes, 60-min tokens | official, preinstalled | $200 once | no (us, eu) |
| E2B | $29 + Pro $150 | $45 + Pro $150 | $121 + Pro $150 | ~1 s resume | pause keeps fs, memory and processes | **1 h on Hobby, 24 h on Pro** per run | `PORT-id.e2b.app`, public unless token | PTY only | official template | $100 once | no |
| Codespaces, 2-core | $33 ($21 after quota) | $53 ($41) | **not possible** | tens of seconds | disk, 30-day retention | **12 h max**, idle 30 min to 4 h, a port alone is not activity | GitHub login, org, or public | `gh codespace ssh` | official feature | 120 core-h + 15 GB | no |
| Cloudflare, standard-3 | $20–43 | $33–64 | $70–165 | 1–3 s | **nothing**; snapshot beta, R2 | none fixed, none promised; 6 h idle max | your Worker's route, your auth | none | official guides | none; Paid $5 | not selectable |
| Vercel Sandbox, Pro | $26–62 | $42–97 | $103–252 | not stated | auto-snapshot and resume | 24 h a session, resumed | yes, auth unconfirmed | `sandbox connect` | Agent SDK guide | Hobby 5 CPU-h | `gru1` |
| Blaxel | $32 | $52 | $126 | 25 ms resume | standby, volumes | days | yes | no | tutorial | $200 once | not listed |
| Northflank, nf-compute-200 | $14 | $25 | $53 | under 1 s | volume | none | yes | yes | none found | $20 a month | BYOC only |
| Hetzner CX23, 2 vCPU 4 GB 40 GB | €6 (≈€2.3 snapshot-and-delete) | €18 (≈€3.2) | **€6** | 10–30 s boot | disk, always, billed | none | yours to build | yes | it is a VM | none | no |

Assumptions: 2 vCPU and 4 GB (Cloudflare's 2-vCPU size carries 8 GiB and
is billed on it); scenario one keeps 20 GB all month, scenario two three
times 20 GB, scenario three 40 GB; where a provider meters CPU by use
(Sprites, Cloudflare, Vercel) the range is 10–20 % busy to 100 % busy;
plan fees shown separately; egress ignored. Fly's Ashburn price first, São
Paulo in brackets. The dollar figures carry the agent-sized rounding of
list prices read that day; Hetzner's are after its 2026-04-01 and
2026-06-15 increases and exclude VAT, and its CX line was reported out of
stock in August (unconfirmed today) — CAX11 at €6.49 is the Arm fallback
and CPX22 at €19.99 the AMD one [A1]–[A3].

What the table says, in order of weight:

- **A machine that is mostly idle and must stay reachable is cheapest as a
  machine.** A Hetzner VPS is €6; a Fly Machine with auto-stop is $9–13 and
  has a São Paulo region and a real Postgres on a volume. The sandboxes beat
  a VPS only under roughly 35 hours a month of use, and none of them keeps a
  Postgres the way a disk does.
- **Sprites is the one sandbox priced like a machine.** Scenarios one and two
  fit inside the $20 plan, the filesystem and the URL survive sleep, and
  services restart on wake; against it, no region choice, one HTTP port on
  the URL, and SSH only as a `ProxyCommand` — which is exactly the shape
  `remoteShellCommand` already wraps.
- **Lifetime caps rule out the two famous ones for a dev server.**
  Codespaces ends at twelve hours and does not count a forwarded port as
  activity; E2B ends every run at one hour unless you pay $150 a month;
  Modal ends at twenty-four. Daytona's auto-stop "triggers even if there are
  internal processes running" and its standard disk is 10 GB.
- **Public by default is the norm.** Modal's tunnels, E2B's ports and
  Cloudflare's example route are open to whoever has the URL; Daytona,
  Codespaces and Sprites gate theirs. Whatever is chosen, the preview sits
  behind a token or a login, as `proxy.ts` sits behind kururu's.
- **Where it is matters for a dev box in a way it does not for a
  coordinator.** A pinned workspace's keystrokes and a preview's HMR cross
  to the box and back; the spike's 167 ms was a direct Tailscale path
  across the internet between the Mac and the Omarchy PC, equal to a plain
  ping, and the plan's hoped-for "indistinguishable from local" did not
  describe it. São Paulo exists at Fly, Vercel and Modal; Hetzner,
  OVH, Daytona, E2B and Codespaces have nothing in South America, and
  Cloudflare will not promise a region.
- **Claude Code runs everywhere; Codex is thin.** Daytona ships it
  preinstalled; E2B has a template; Modal, Vercel and Cloudflare have
  guides; Codespaces has Anthropic's devcontainer feature. Codex CLI has
  Cloudflare's guide and Coder's module and little else — on a VM it is
  `npm install -g`, which is the point.
- **The open-source escape hatches moved.** Daytona archived its repository
  on 2026-10-03 with "core development has moved to a private codebase";
  Gitpod became Ona in September 2025 and OpenAI agreed to buy it on
  2026-06-11; Coder is the one self-hosted workspace product still free to
  run, on whatever VM you bring, with Claude Code and Codex modules.

**Verdict for the box.** The replacement is a Linux machine on the tailnet
with a child kururu and Dokploy on it, sized so the Firecrawl stack and
two or three dev servers are not neighbours of production — and the VPS's
runbook already says what it refuses. Two candidates: a second VPS at the
same host or Hetzner (cheapest, Europe, the same rules as the first), or a
Fly Machine in `gru` with a volume and auto-stop (nearest, per-second, a
little dearer, and stops when nobody is there). Sprites are worth one
afternoon's try as a *disposable* workspace for a card, because the price
and the persistence are right and the shell fits the machines model — not
as the box. Cloudflare Containers are not on the list for this job.

## 5. kururu

### Where kururu stands, in the terms that matter here

The parent is the Mac. Links are one WebSocket per pair, the lower rank
dialling the higher, so the Mac dials nobody and must be reachable on the
tailnet; a node is away after twenty-five seconds of silence, because a lid
that closes sends no FIN (`docs/nodes.md`). What crosses a link is a summary
of a few kilobytes, never a board. Telegram is read by one node at a time,
the leader, and `LeadGate` plus `lead.ts` exist because `getUpdates` answers
a second reader with a 409: thirty seconds to take over, a minute of steady
link and a holder not mid-conversation to take back, the offset and queue
handed over, the 409 settled by rank. Words for a node that is away wait on
the sender's outbox and go when the link is back. The phone reaches a node
over the tailnet, with no secure context, so no microphone. Push
notifications are the third open item on the roadmap; the voice on the
phone is the fifth, waiting on `tailscale serve` and the user's decision.
And today the only node that is up when the Mac sleeps is the VPS.

A Durable Object changes one fact in that picture: **something of kururu's
can be up when nothing of ours is.** Every design below is a use of that
fact, and each one moves something off the machine that stays on it today.
That is the trade in every row.

### Design 1: the shadow, with a dead-man's alarm

One object per node, `NodeShadow`, on the Free plan. Each node, when it is
up, holds one outbound WebSocket to its shadow — from the node, not the
reverse, so no port opens anywhere — and pushes the summary it already
pushes to peers (`NodeSummary`: workspaces, agents, Needs bands and count,
Kuru's counts, whether it leads), at most once a second, only on change. The
shadow writes it to one SQLite row with a timestamp, sets its alarm sixty
seconds out on every push, and when the alarm fires with no push since, the
node is *away* in the shadow's eyes at a known time. Phones connect to the
shadow with the hibernating API and get the last summary at once; one
`broadcast` per push after. A page can therefore show every node's
workspaces, agents and Needs, and "mac away since 23:10", from any browser
with no tailnet, with the Mac shut and the VPS rebooting.

- **Replaces:** nothing. `nodes-seen.json` and the sidebar's "away since" are
  this node's view of the others; the shadow is the view when this node is
  down too. The Share dialog's QR would offer it as a second link.
- **Adds:** the roadmap's push notifications have a sender at last: the
  alarm that notices silence, and the push that says a Needs count rose,
  are both things the shadow can do that a sleeping node cannot. Web Push
  itself is the node posting to a push service when awake; the shadow is
  for when it is not.
- **Crosses:** the summary. It carries workspace names, folders, agents'
  titles and the first lines of what needs you — not boards, not screens,
  not the conversation. `summarize` already clips long text and drops pids
  and command lines. The rule to write: the shadow is a cache and never a
  source; nothing in kururu reads a board or a card out of it.
- **Auth:** a node signs in with its roster key — the Worker verifies an
  Ed25519 signature over a challenge with WebCrypto, which is the handshake
  `/link` already does. A phone signs in with the node's share token, which
  the shadow checks against a hash the node gave it. The object never
  holds a key.
- **Cost:** [estimate A](#estimates), $0.
- **Risk:** a public endpoint where kururu had none. The Worker must refuse
  anything that is not a signed node or a tokened phone before the object
  sees it, and the summary should be treated as it already is on the
  phone — something a screen may show, never something that moves a card.

### Design 2: an inbox for words to a sleeping node

The same object holds an **inbox**: a phone, or a Telegram line, or a Kuru
on another node, leaves words for a node that is away, and the node drains
them when it reconnects, in order, with the ids the outbox already uses so a
retry is the same message. On the node it is the drawer's road: the words
go into the outbox marked by *who* left them, as `[user@mac]` or
`[telegram]` are today, and Kuru takes them as it takes any held message.

- **Replaces:** the "Not sent yet: box is away" wait on the sender's outbox,
  for the case where the *sender* is down too — a phone with no node awake.
- **Does not do:** reach an agent. The agents' ptys are in the RAM of a
  sleeping Mac, and nothing in a cloud wakes it. What this gives the user
  out with a phone and the Mac shut is leaving the instruction, and
  knowing from the shadow that it is waiting. Keeping the Mac awake is a
  setting on the Mac (`caffeinate`, or Energy → prevent sleep on power),
  and the honest place for agents that must run at three in the morning is
  the node that is up at three in the morning.
- **Crosses:** the user's words to Kuru, held in SQLite at Cloudflare until
  drained. That is a second road off the machine for the conversation, after
  Telegram; the Channels page says it of Telegram above the switch and this
  would be said the same way.
- **Cost:** within estimate A.

### Design 3: Telegram by webhook

A Worker route receives Telegram's webhook instead of a node polling
`getUpdates`. The object stores each update, delivers it to whichever
eligible node is connected (the leader's rule, but with no 409 to settle
because nobody polls), holds it when none is, and keeps the reply map so
"reply to a node's line" still routes. Nodes send replies to Telegram
themselves, as now, with the token they hold.

- **Replaces:** `LeadGate`'s poll ownership, `lead.ts`'s hand-over of the
  offset and queue, the 409 stand-down, the lead-ask/lead-busy/force
  sequence — all of it exists because one reader may poll. The switch and
  the allow-list in the roster stay as they are.
- **Keeps the token home:** Telegram authenticates its webhook calls with a
  separate `secret_token` you choose at `setWebhook`, so the Worker verifies
  a random string and never sees the bot token; off is `setWebhook` to an
  empty URL, after which there is no request, as the channel doc wants.
- **Crosses:** the chat's text through Cloudflare on its way in, in addition
  to Telegram's servers, which already see it unencrypted. The channel doc's
  "the one road off the machine for the conversation" becomes a road with
  two carriers. Replies do not cross.
- **Gains:** a message sent while every node sleeps is held and delivered,
  rather than fetched later from Telegram's own 24-hour buffer — which,
  to be fair, long polling also gets. The real gain is the deleted code and
  the end of "the poll moves every time a lid closes".
- **Cost:** within estimate A.

### Design 4: a relay for the node links — skip

A DO could be the rendezvous that lets a child behind a NAT link to a parent
without a tailnet, forwarding `/link` frames. Everything of kururu's is on
the tailnet already, which does this with no third party; the relay would
put the summaries, the Kuru turns, the sealed secrets' envelopes and the
board verbs through a hop in North America; and the watch socket that
carries terminal bytes for a remote workspace would pay two round trips per
keystroke where the spike already measured one at 167 ms. Nothing it replaces
is broken.

<a id="a-sandbox-as-a-machine"></a>
### Design 5: a sandbox as a machine

Kururu's rule is that a shell on another machine is a command line in an
ordinary pty, read back by `remoteShellOf`, and the pty host never learns
there is a remote. A Cloudflare sandbox could be a machine kind on those
terms: the command in the pty is a small client that opens the Sandbox SDK's
PTY through the Worker and bridges stdin and stdout, so `ssh -t host` becomes
`kururu-sbx attach <name>`. `onscreen.ts` reads the agent's status off the
screen as it does for a pinned machine; `endRemote` destroys the sandbox.

- **What it would give:** a disposable checkout for a card — "run this card's
  agent in a sandbox" — with a public preview URL, and a workspace that costs
  nothing when idle.
- **What it would cost:** the Worker and its token on the Mac; a Claude login
  in the sandbox, which is an API key at a gateway under the secrets rule
  as it stands; the file tree, reader, worktrees and databases, which the
  machines doc already leaves out for a remote and which here have no disk
  to read tomorrow; the agent's session files, which end with the instance
  unless snapshotted; and the latency of [§4](#4-remote-dev-servers).
- **When:** after the preview pane exists and if a disposable agent is ever
  wanted. Not as the replacement for a dev box.

### Design 6: Pi Durable as a Kuru — skip, watch

Said in [§2](#what-it-means-for-kururu). The one case it answers is a Kuru
that is up when no machine is, and it would be a second Kuru with a key, no
hands, and no permission prompt.

### Risks across all of it

- **Lock-in.** The DO API is Cloudflare's. The mitigation is real: celld
  ([§6](#6-celld-durable-objects-on-your-own-boxes)) runs the same `wrangler.json`
  on your own boxes, Cloudflare now owns it and means to make `workerd`
  self-hosting "a first-class supported way", and a shadow or inbox object
  is a few hundred lines with a SQLite schema that any server could keep.
  Keep the Worker's logic in `shared/` as pure functions and the lock-in is
  the deployment, not the design.
- **Latency.** Every object call from here is a North American round trip.
  For a summary pushed once a second and read by a phone it does not
  matter; for anything on a keystroke's path it rules the design out.
- **Cost.** Designs 1–3 are free. The things that cost are containers, and
  [§4](#4-remote-dev-servers) says to leave them.
- **Security of the agents' terminals.** No design above puts terminal bytes
  through a DO; the watch socket and `/ws` stay on the tailnet and
  loopback, behind the token and the Origin check. The new surface is the
  Worker: it is on the internet, it must verify a node's Ed25519 signature
  or a phone's token before an object is touched, and the object must hold
  no key and no secret — the summary and the inbox are the most it sees.
  `NEVER_SHARED` and the backup allow-list in `shared/backup.ts` are the
  pattern: one list of what may cross, and a test that holds it.
- **Two roads off the machine.** Design 2 and 3 move the conversation's text
  through Cloudflare. It is the user's call, said in Settings above a
  switch, off by default, as Telegram's is.

## 6. celld: Durable Objects on your own boxes

### What it is

celld is "self-hosted, distributed Durable Objects": an open-source daemon
that runs a Cloudflare Workers application — Workers, Durable Objects, KV,
Queues, D1, R2, Workflows, Cron Triggers, static assets, Dynamic Workers —
"on your own machines", from the `wrangler.json` you already have [87][86].
A **cell** is one Durable Object: "a named server with its own SQLite
database". A node is one `celld` process embedding V8; the nodes that share
one bucket are a fleet, and the bucket — S3-compatible (R2 included), Google
Cloud Storage or Azure Blob — holds the deployments, every cell's state and
the small ownership records. "A conditional bucket write gives a node the
ownership of a cell, so exactly one node owns a cell at a time. The fleet
needs no membership protocol, failure detector, or consensus service" [87].
Each SQLite write is captured in Litestream's LTX format; with two or more
nodes the owner sends it to one or two followers and the write is durable
once their disks hold it (about 25 ms in their lab), then uploads it; a
single node must wait for the bucket on every write, "about 90 ms" to a
region-local store and 600 ms measured against one that was not [87][91].
Its acknowledgement rule is RPO = 0: no response reveals a write a crash
could still lose [91].

### Maturity, licence, people

- Repository `denoland/celld`, created 2025-04-25, Rust, Apache-2.0; first
  release v0.1.0 on 2026-08-05, then twelve releases to **v0.6.3 on
  2026-10-21**; about 6,100 stars and 416 forks; the public history is one
  squashed commit per release and the two committers are Ryan Dahl and
  Bartek Iwańczuk [102][85].
- "celld v0.6.3 is a beta release" [89]. "It is not safe for hostile
  multi-tenant use. Only the latest release receives security fixes" [90].
  Mixed versions cannot share a fleet; upgrading from v0.4.1 means stopping
  every old node first [87].
- Pull requests are disabled — "coding agents make it too easy to send a
  large, low-context change" — patches go by email with a CLA that assigns
  rights to Deno Land Inc. [87].
- The Register called the first release an alpha and advised against
  production use [101].
- **On 2026-10-09 Cloudflare acquired Deno.** Kenton Varda: `workerd`
  implements Durable Objects "but only in a single-instance way", good for
  local testing, unable to scale; Dahl and Bert Belder will lead "merging
  workerd and celld" to "make workerd self-hosting a first-class supported
  way to build and run apps" [98]. Dahl's side: "celld has been working
  remarkably well, depending only on object storage for coordination and
  persistence"; the Deno runtime gets one more year of monthly fixes, Deno
  Deploy shuts in six months, JSR moves to Cloudflare [99][100].

### Hosting and price

There is no service and no price: you run it. The site's cost comparison
assumes a $48-a-month 8 GB node and claims about 2,500 resident cells per
such node, 0.2 ms p50 for stateless requests, and that "an inactive cell
costs almost nothing" [86]. Binaries for Linux x86-64, Linux ARM64 and
**Apple Silicon** — a Mac can be a node — and a Docker image; Windows is not
supported [87][89]. Telemetry is off by default [97]. The bucket is the only
recurring cost: on R2, storage at $0.015 per GB-month and writes at $4.50 a
million, with 10 GB and a million writes a month free [59]; a chatty single
node turns every SQLite commit into a bucket round trip and a Class A
operation, which is both the latency and the bill.

### How close to Cloudflare's it is

The compatibility page marks Workers, Durable Objects (SQLite storage,
alarms, hibernating WebSockets, RPC, facets), KV, Queues, D1, R2, Workflows,
Cron, static assets and Dynamic Workers **Yes**; Containers
**Experimental**; Workers AI, Vectorize, Hyperdrive, Browser Rendering and
Email Workers **No** [88]. The differences that would matter to a kururu
object: no placement or jurisdiction promise, `jurisdiction()` throws; a
hibernatable WebSocket survives hibernation on the same node but **closes
when the cell moves** to another, with code 1012, so clients reconnect; an
outbound WebSocket from a cell ends when the cell moves; transactions and
`blockConcurrencyWhile` have the same 30-second limit; the V8 heap is 128 MB
per isolate, which they note holds about 50,000 hibernating sockets [93][88].
Idle rebalancing moves hibernated cells between nodes, 32 at a time, which is
what makes a two-node fleet a fleet [87].

Containers in celld: a Durable Object starts a container "on the node that
owns the cell", through a Docker or Podman daemon that every such node must
have; the disk is ephemeral; by default the container **shares the node's
kernel** with capabilities dropped and an nftables fence that blocks the
private ranges — `100.64/10` among them, so a container cannot reach the
tailnet — and gVisor or Kata can be named per class for "code that you did
not write"; `snapshotContainer()` rejects; a move, a restart or a node stop
destroys the container; `@cloudflare/sandbox` "runs as published" on the
`cloudflare/sandbox` image, its preview URLs needing a wildcard hostname at
your load balancer [92][95]. celld terminates no TLS and its peer traffic is
plaintext HTTP authenticated by an HMAC, so the internal listener must sit
on "an encrypted overlay such as WireGuard or Tailscale" [89][90].

And the two examples that close the loop on [§2](#2-pi-durable-objects):
`examples/pi` runs `PiHarness` from the Agents SDK's pull request #2197 in a
cell, transcript in the cell's SQLite, model from any OpenAI-compatible
endpoint (OpenRouter by default) [94]; `examples/opencode` runs OpenCode's
Workerd SDK in a cell with no credentials at all, resolving a free model
[96].

### Does it fit kururu?

celld answers "I want the Durable Objects model and I do not want
Cloudflare's compute to run it." For kururu the honest comparison is this:

- The reason to want a DO at all ([§5](#5-kururu)) is a thing that is up
  when the Mac and the VPS are not. A celld fleet made of the Mac and the
  VPS is up exactly when they are. On the VPS alone it adds a Rust daemon
  and a bucket round trip per write to a machine that already runs a kururu
  server with its own SQLite, and gives nothing the server does not.
- Its durability posture wants two running nodes. The Mac sleeps, so the
  fleet would spend half its life in the single-node posture — correct,
  per the guarantees page, and 90–600 ms per write.
- Its containers want Docker on the node and share its kernel by default,
  which on the VPS beside the Dokploy stacks is one more tenant of the
  same engine, and they cannot reach the tailnet from inside the fence.
- It is beta, it refuses pull requests, and its roadmap is now Cloudflare's
  merge into `workerd`, with "further details … over the coming months".

What it is good for, from here: the **exit** from Design 1–3 if Cloudflare's
hosting ever becomes unwanted — the same `wrangler.json`, the same object
code, a bucket on R2 or on Hetzner's object storage, a node on the VPS; and,
for anyone building the DO-shaped thing Pi Durable or OpenCode's SDK want to
live in, a way to run it at home. Watch after the `workerd` merge lands;
skip until then.

## 7. Recommendation

**Try first, in this order, each one small and reversible:**

1. **Cloudflare Tunnel with Access for the phone**, as a documented option
   beside `tailscale serve` rather than instead of it: a named tunnel on the
   Mac or the VPS to `localhost:7717`, an Access policy on the user's own
   email, `loopbackToken` on. It costs nothing under fifty users, it is
   the HTTPS the phone's microphone has been waiting on (roadmap item 5),
   and it touches no kururu code beyond a doc page and the Origin list. It
   is the user's decision and the user's command, like every `tailscale`
   line.
2. **The shadow with the dead-man's alarm (Design 1)** on the Free plan: one
   object class, one Worker, one page; a node pushes what it already pushes
   to peers; the gain is "the Mac went away at 23:10" and a Needs count on a
   phone off the tailnet, and the first real sender for push notifications
   (roadmap item 3). Write the rule — a cache, never a source — into
   `docs/nodes.md` first, and the allow-list of what a summary may carry as
   a test in `shared/`.
3. **The webhook for Telegram (Design 3)** once 2 has held up, because it
   deletes more code than it adds; only with the user's yes to a second
   carrier for the chat's text.
4. **Pi as a launcher**, when the model list is next refreshed: a small
   change, and its RPC mode and OSC 7501 status are worth a look for
   `onscreen.ts`.

**Later, maybe:** the inbox (Design 2), which is the shadow's object with a
queue; a sandbox machine kind (Design 5) only after the preview pane exists
and only for disposable work.

**Skip:** Containers or sandboxes as dev servers — [estimate D](#estimates)
and the six-hour, empty-disk, no-inbound-port facts; a DO relay for the
links (Design 4); celld until the `workerd` merge; Pi Durable as a Kuru.

**For the dev box itself:** [§4](#the-alternatives) — a second always-on
Linux node, sized for the Firecrawl stack and two or three dev servers,
reached over the tailnet, with a child kururu on it, which `kururu child
setup` already knows how to make. The two candidates are a second VPS
(the same host, or Hetzner at about €6 a month, in Europe) and a Fly
Machine in São Paulo with a volume and auto-stop (nearest, $9–13 a month
at weekday hours, and off when nobody is there). Sprites earn one
afternoon as a disposable workspace for a card; Cloudflare Containers do
not.

## Sources

Cloudflare, read 2026-10-24; dates are the pages' own.

- [1] Durable Objects pricing — https://developers.cloudflare.com/durable-objects/platform/pricing/ (2026-10-18)
- [2] Durable Objects limits — https://developers.cloudflare.com/durable-objects/platform/limits/ (2026-06-01)
- [3] WebSockets best practices — https://developers.cloudflare.com/durable-objects/best-practices/websockets/ (2026-09-30)
- [4] Durable Object lifecycle — https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/ (2026-10-15)
- [5] Data location — https://developers.cloudflare.com/durable-objects/reference/data-location/ (2026-06-26)
- [6] State API — https://developers.cloudflare.com/durable-objects/api/state/ (2026-09-30)
- [7] Storage API — https://developers.cloudflare.com/durable-objects/api/storage-api/ (2026-09-21)
- [8] Alarms — https://developers.cloudflare.com/durable-objects/api/alarms/ (2026-04-21)
- [9] Rules of Durable Objects — https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/ (2026-10-18)
- [10] Durable Objects FAQ — https://developers.cloudflare.com/durable-objects/reference/faq/ (2026-04-21)
- [11] Durable Objects on the Free plan — https://developers.cloudflare.com/changelog/post/2025-04-07-durable-objects-free-tier/ (2025-04-07)
- [12] Durable Objects release notes — https://developers.cloudflare.com/durable-objects/release-notes/ ; Workers RPC — https://developers.cloudflare.com/workers/runtime-apis/rpc/ (2026-10-12)
- [13] Workers pricing — https://developers.cloudflare.com/workers/platform/pricing/ (2026-10-02)
- [14] Workers limits — https://developers.cloudflare.com/workers/platform/limits/ (2026-10-12)
- [15] Workflows pricing — https://developers.cloudflare.com/workflows/reference/pricing/ (2026-09-21)
- [16] Workflows limits — https://developers.cloudflare.com/workflows/reference/limits/ (2026-09-21)
- [17] Workflows GA — https://blog.cloudflare.com/workflows-ga-production-ready-durable-execution/ (2025-04-07)
- [18] Containers pricing — https://developers.cloudflare.com/containers/pricing/ (2026-10-05)
- [19] Containers limits — https://developers.cloudflare.com/containers/platform-details/limits/ (2026-10-21)
- [20] Containers architecture — https://developers.cloudflare.com/containers/architecture/ (2026-09-30)
- [21] Containers FAQ — https://developers.cloudflare.com/containers/faq/ (2026-10-05)
- [22] Containers and Sandboxes GA — https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/ (2026-04-13)
- [23] Higher container limits — https://developers.cloudflare.com/changelog/post/2026-02-25-higher-container-resource-limits/ (2026-02-25)
- [24] Regional placement — https://developers.cloudflare.com/changelog/post/2026-04-05-regional-placement/ (2026-04-05)
- [25] Scheduling policy — https://developers.cloudflare.com/containers/configuration/scheduling-policy/ (2026-10-12)
- [26] SSH into a container — https://developers.cloudflare.com/containers/guides/ssh/ (2026-10-12)
- [27] Durable Object container API — https://developers.cloudflare.com/durable-objects/api/container/ (2026-09-30)
- [28] "Cloudflare Containers, rebuilt to scale agent sandboxes" — https://blog.cloudflare.com/faster-agent-sandboxes/ (2026-09-30)
- [29] Active-CPU pricing — https://developers.cloudflare.com/changelog/post/2025-11-21-new-cpu-pricing/ (2025-11-21)
- [30] Containers overview — https://developers.cloudflare.com/containers/ (2026-10-12)
- [31] Sandbox overview — https://developers.cloudflare.com/sandbox/ (2026-09-30)
- [32] Sandbox lifetime — https://developers.cloudflare.com/sandbox/concepts/lifetime/ (2026-10-22)
- [33] Sandbox files — https://developers.cloudflare.com/sandbox/files/ (2026-10-22)
- [34] Sandbox previews — https://developers.cloudflare.com/sandbox/previews/ (2026-10-22)
- [35] Run coding agents in a sandbox — https://developers.cloudflare.com/sandbox/coding-agents/ (2026-09-30)
- [36] Run Claude Code in a sandbox — https://developers.cloudflare.com/sandbox/coding-agents/claude-code/ (2026-10-22)
- [37] Run Pi in a sandbox — https://developers.cloudflare.com/sandbox/coding-agents/pi/ (2026-10-13)
- [38] Sandbox SDK 1.0 — https://developers.cloudflare.com/changelog/post/2026-09-30-sandbox-sdk-1-0/ (2026-09-30)
- [39] Sandbox GA post — https://blog.cloudflare.com/sandbox-ga/ (2026-04-13)
- [40] Agents SDK: a sandbox for an agent — https://developers.cloudflare.com/agents/tools/sandbox/ (2026-10-22)
- [41] Sandbox network and credentials — https://developers.cloudflare.com/sandbox/network/ (2026-09-30)
- [42] Agents API reference — https://developers.cloudflare.com/agents/api-reference/agents-api/ (2026-08-04)
- [43] PiHarness — https://developers.cloudflare.com/agents/harnesses/pi/ (2026-10-22)
- [44] PiHarness changelog — https://developers.cloudflare.com/changelog/post/2026-10-02-pi-harness/ (2026-10-02)
- [45] Agents changelog — https://developers.cloudflare.com/changelog/product/agents/ ; Dynamic Workers pricing — https://developers.cloudflare.com/dynamic-workers/pricing/ (2026-06-11)
- [46] Project Think — https://blog.cloudflare.com/project-think/ (2026-04-15); Facets — https://blog.cloudflare.com/durable-object-facets-dynamic-workers/ (2026-04-13)
- [47] Harnesses index — https://developers.cloudflare.com/agents/harnesses/ (2026-10-22)
- [48] The Agent class — https://developers.cloudflare.com/agents/concepts/agent-class/ (2026-08-17)
- [49] agents@0.26.0 — https://github.com/cloudflare/agents/releases/tag/agents%400.26.0 (2026-10-02)
- [50] Pull request #2197, "add durable pi harness capability" — https://github.com/cloudflare/agents/pull/2197 (opened 2026-09-01)
- [51] Example: a Pi harness app — https://github.com/cloudflare/agents/tree/main/examples/next/harnesses/pi
- [52] Cloudflare Tunnel — https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/ (2026-08-04)
- [53] Quick tunnels — https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/ (2026-09-30)
- [54] Tunnel routing and service types — https://developers.cloudflare.com/tunnel/concepts/routing/ (2026-10-16)
- [55] Zero Trust account limits — https://developers.cloudflare.com/cloudflare-one/account-limits/ (2026-10-16)
- [56] SSH over Tunnel — https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/use-cases/ssh/ (2026-10-12)
- [57] Cloudflare Access plans (free under 50 users, $7 per user) — https://www.cloudflare.com/en-gb/sase/products/access/ (undated product page)
- [58] Arbitrary TCP through Access — https://developers.cloudflare.com/cloudflare-one/applications/non-http/cloudflared-authentication/arbitrary-tcp/ (2026-04-17)
- [59] R2 pricing — https://developers.cloudflare.com/r2/pricing/ (2026-10-01)

Pi and Earendil, read 2026-10-24.

- [60] "Pi Durable" — https://earendil.com/posts/pi-durable/ (2026-10-01)
- [61] "Pi 1.0" — https://earendil.com/posts/pi-1-0/ (2026-10-01)
- [62] Pi 1.0.0 changelog — https://pi.dev/changelog/releases/1.0.0 (2026-10-01)
- [63] Repository — https://github.com/earendil-works/pi
- [64] pi-durable README — https://github.com/earendil-works/pi/blob/main/packages/durable/README.md
- [65] RPC mode — https://pi.dev/docs/latest/rpc
- [66] JSON mode — https://pi.dev/docs/latest/json
- [67] SDK — https://pi.dev/docs/latest/sdk
- [68] Sessions — https://pi.dev/docs/latest/sessions
- [69] "Pi has a new home" — https://pi.dev/news/2026/5/7/pi-has-a-new-home (2026-05-07)
- [70] The Register on Pi 1.0 — https://www.theregister.com/ai-and-ml/2026/10/02/pi-coding-agent-pulls-a-180-and-adds-mcp-support/5300678 (2026-10-02)
- [71] Trending Topics on Earendil and Pi 1.0 — https://www.trendingtopics.eu/pi-1-0-earendil-en/ (October 2026); Zechner on the Agents SDK integration — https://x.com/badlogicgames/status/2106093146296008857
- [72] Hacker News, "Pi Durable" — https://news.ycombinator.com/item?id=49925969 (about 2026-10-01)
- [73] Radius — https://radius.earendil.com/
- [74] pi-on-cf — https://github.com/harshil1712/pi-on-cf
- [75] "How I run the pi coding agent on Cloudflare" — https://dev.to/cloudflare/how-i-run-the-pi-coding-agent-on-cloudflare-ld5 (2026-08-03)
- [76] camelAI — https://github.com/qaml-ai/camelAI
- [77] Moltworker — https://blog.cloudflare.com/moltworker-self-hosted-ai-agent/ (2026-01-29)
- [78] Moltworker repository — https://github.com/cloudflare/moltworker
- [79] OpenClaw runtime docs — https://docs.openclaw.ai/agent-runtime-architecture and https://docs.openclaw.ai/pi
- [80] OpenClaw architecture deep dive — https://www.chattergo.ai/blog/openclaw-deep-dive-architecture-agent-loop (2026-02-07)
- [81] PartyServer — https://github.com/cloudflare/partykit
- [82] "Running Pi Durably on Vercel" — https://vercel.com/docs/agent-harnesses/pi
- [83] Pi with AI Gateway — https://developers.cloudflare.com/ai-gateway/integrations/coding-agents/pi/ (2026-09-10)
- [84] Pi news and releases — https://pi.dev/news (1.1.0 on 2026-10-07, 1.4.0 on 2026-10-21)

celld and Deno, read 2026-10-24.

- [85] Repository — https://github.com/denoland/celld
- [86] Site — https://celld.dev/
- [87] README — https://github.com/denoland/celld/blob/main/README.md
- [88] Cloudflare compatibility — https://github.com/denoland/celld/blob/main/docs/cloudflare-compat.md
- [89] Limitations — https://github.com/denoland/celld/blob/main/docs/limitations.md
- [90] Security — https://github.com/denoland/celld/blob/main/docs/security.md
- [91] What celld guarantees — https://github.com/denoland/celld/blob/main/docs/guarantees.md
- [92] Containers in celld — https://github.com/denoland/celld/blob/main/docs/services/containers.md
- [93] Durable Objects in celld — https://github.com/denoland/celld/blob/main/docs/services/durable-objects.md
- [94] examples/pi (PiHarness in a cell) — https://github.com/denoland/celld/tree/main/examples/pi
- [95] examples/sandbox — https://github.com/denoland/celld/tree/main/examples/sandbox
- [96] examples/opencode — https://github.com/denoland/celld/tree/main/examples/opencode
- [97] Telemetry — https://github.com/denoland/celld/blob/main/docs/telemetry.md
- [98] "Deno joins Cloudflare" — https://blog.cloudflare.com/deno-joins-cloudflare/ (2026-10-09, Ryan Dahl and Kenton Varda)
- [99] Deno's announcement — https://deno.com/blog/cloudflare (2026-10-09)
- [100] Simon Willison on the acquisition — https://simonwillison.net/2026/oct/9/deno-is-joining-cloudflare/ (2026-10-09)
- [101] The Register on celld's first release — https://theregister.com/devops/2026/08/12/nodejs-creator-liberates-durable-objects-from-cloudflare-with-celld/5286954 (2026-08-12)
- [102] GitHub API metadata and release list for denoland/celld, queried 2026-10-24 (created 2025-04-25; v0.1.0 2026-08-05; v0.6.3 2026-10-21; 6,100 stars; 416 forks)

The alternatives in §4, read 2026-10-24; "undated" is a page with no date of
its own. Third-party pages are marked.

- [A1] Fly — pricing https://fly.io/pricing.md and https://docs.fly.io/about/pricing (undated); auto-stop https://docs.fly.io/launch/autostop-autostart/ ; regions https://docs.fly.io/reference/regions/ ; trial https://fly.io/docs/about/free-trial/ (October 2025); Tailscale on Fly https://tailscale.com/kb/1132/flydotio/ (validated 2025-12-04); Sprites https://fly.io/sprites , https://fly.io/sprites/agent-ready.md , https://fly.io/sprites/release-notes/ (2025-12-23 to 2026-04-21), plans https://fly.io/changelog/new-sprites-plans.md (2026-01-16), CLI https://docs.fly.io/sprites/cli/commands.md ; region question https://community.fly.io/t/where-do-sprites-dev-sprites-live-as-in-which-fly-io-region-is-it/26775 (early 2026, community)
- [A2] Modal — https://modal.com/pricing (2026); sandboxes https://modal.com/docs/guide/sandbox , snapshots https://modal.com/docs/guide/sandbox-snapshots , tunnels https://modal.com/docs/guide/tunnels , regions https://modal.com/docs/guide/region-selection , Claude Code example https://modal.com/docs/examples/sandbox_agent (undated). Daytona — https://www.daytona.io/pricing (2026-10-20); sandboxes https://www.daytona.io/docs/en/sandboxes.md , limits https://www.daytona.io/docs/en/limits/ , previews https://www.daytona.io/docs/en/preview-and-authentication/ , SSH https://www.daytona.io/docs/en/ssh-access/ , Claude Code https://www.daytona.io/docs/en/guides/claude/claude-code-run-cli-sandbox/ (docs v0.225); archived repository https://github.com/daytonaio/daytona (2026-10-03). E2B — https://e2b.dev/pricing ; persistence https://docs.e2b.dev/sandbox/persistence ; URLs https://docs.e2b.dev/network/public-url and https://docs.e2b.dev/network/restrict-public-access ; EU https://docs.e2b.dev/faq/eu-region.md ; Claude Code https://docs.e2b.dev/agents/claude-code (undated). Codespaces — billing https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-codespaces/about-billing-for-github-codespaces ; timeout https://docs.github.com/en/codespaces/setting-your-user-preferences/setting-your-timeout-period-for-github-codespaces ; retention https://docs.github.com/en/codespaces/setting-your-user-preferences/configuring-automatic-deletion-of-your-codespaces ; ports https://docs.github.com/en/codespaces/developing-in-a-codespace/forwarding-ports-in-your-codespace ; CLI https://docs.github.com/en/codespaces/developing-in-a-codespace/using-github-codespaces-with-github-cli ; regions https://docs.github.com/en/codespaces/setting-your-user-preferences/setting-your-default-region-for-github-codespaces (undated); data residency https://github.blog/changelog/2026-04-01-codespaces-is-now-generally-available-for-github-enterprise-with-data-residency (2026-04-01); Claude Code devcontainer https://code.claude.com/docs/en/devcontainer
- [A3] Vercel Sandbox — pricing https://vercel.com/docs/sandbox/pricing (2026-09-10), regions https://vercel.com/docs/sandbox/concepts/regions (2026-09-22), persistent sandboxes https://vercel.com/docs/sandbox/concepts/persistent-sandboxes (2026-09-15), Claude Agent SDK guide https://vercel.com/kb/guide/using-vercel-sandbox-claude-agent-sdk (2026-06-17). Blaxel — https://blaxel.ai/pricing , https://docs.blaxel.ai/Tutorials/Claude-Code.md (undated). Northflank — https://northflank.com/pricing (October 2026), regions https://northflank.com/docs/v1/application/run/deploy-to-a-region . Coder — https://coder.com/pricing , https://coder.com/docs/ai-coder/tasks (undated). Ona — https://ona.com/pricing , https://ona.com/stories/gitpod-classic-payg-sunset (2025-09-02), https://siliconangle.com/2026/06/11/openai-acquires-ai-agent-orchestration-startup-ona/ (2026-06-11, press). Hetzner — price adjustment https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/ (2026-07-08), https://www.hetzner.com/cloud/ , AX42 https://www.hetzner.com/dedicated-rootserver/ax42/ ; stock and extras https://agentdeals.dev/hetzner-pricing-2026 (2026-10-02, third party). OVH Eco — https://eco.ovhcloud.com/en/ and https://eco.ovhcloud.com/en/kimsufi/ (undated). Cloudflare's 0.x preview URLs https://developers.cloudflare.com/sandbox/concepts/preview-urls/ (2026-10-23) and backup API https://developers.cloudflare.com/changelog/2026-02-23-sandbox-backup-restore-api (2026-02-23).

Kururu's own pages, for what they say about today: `docs/nodes.md` (links,
away, summaries, One Telegram, remote workspaces), `docs/machines.md`,
`docs/channels.md`, `docs/web.md`, `docs/linux.md`,
`docs/spikes/remote-workspaces-phase0.md` (the 167 ms), `PLAN.md` (the
roadmap's items 3 and 5), and `CLAUDE.md` (the rules on secrets, the
harness, loopback and the token).
