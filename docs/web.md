# The web for agents

Agents keep meeting pages a plain fetch cannot read: a shop whose list is drawn
by JavaScript after the page loads, a site that answers anything without a
browser's fingerprint with a wall, a PDF. Kururu answers those for every agent it
starts, through four MCP tools — `scrape_page`, `crawl_site`, `map_site`,
`search_web` — and behind the tools is **an ordered chain of providers**, set in
**Settings → Web**.

It was one paid Firecrawl, and every description told the agent to try its own
fetch first because each call was the user's money. Then a Firecrawl of our own
came up on a box on the tailnet, free to call, and the order wanted turning round. An
order written as fallbacks inside one provider grows a branch per provider, so
the web is now a chain (`server/src/web/chain.ts`) of providers that each say
what they can do (`server/src/web/provider.ts`), and the vocabulary they share is
`shared/web.ts`.

## The order

By default, and as Settings → Web lists it:

| # | provider | file | costs |
|---|---|---|---|
| 1 | **Self-hosted Firecrawl** — ours, on the tailnet | `providers/firecrawl-self.ts` | nothing |
| 2 | **The agent's own web tools** — Claude's WebSearch and WebFetch, Codex's search | `providers/handback.ts` | nothing |
| 3 | **Cloud Firecrawl** — firecrawl.dev | `providers/firecrawl-cloud.ts` | credits |

A call goes down the list until something brings back the page. Each step is
**skipped** (switched off, not set up, cannot do this tool, resting after it
could not be reached, no time left), **tried** and then **served** or
**failed**, **passed** (it stood aside for this call), or **stopped** (it ended
the chain with a sentence for the agent).

**The agent's own tools are a step, not a special case.** Kururu cannot call an
agent's WebFetch: it runs inside the agent. What kururu can do is stop and say
"use yours" — and where that is said matters, because what comes after it is the
paid provider. So the hand-back is a provider like the others. Its one rule:
a call with `ownToolsFailed: true` is let past (`passed`), any other stops there
(`stopped`) with what kururu tried, that the agent should now use its own tools,
and what calling again with the opt-in would reach and cost. The chain knows
none of this; it saw a step answer `stop`. Move the hand-back to the top and
every call starts with the agent's own tools; switch it off and what is after it
is tried at once.

**The order is the policy.** A paid provider placed before the hand-back is
reached without asking; the tool descriptions say so (`paid, on the user's
credits`), and the page marks it `· paid`.

## What counts as a failure

Anything that was not the page (`resultVerdict` in `shared/web.ts`):

- an error, a refusal (a key, a budget), an address that did not answer — which
  also rests the provider for thirty seconds, so the next call does not wait out
  the same dead host;
- a timeout: each provider says how long a call may take (`timeoutMs`), and the
  whole call is held inside the CLI's five minutes (`CHAIN_DEADLINE_MS`); the
  chain aborts a provider's requests when it stops waiting, and does not wait on
  it to listen;
- a page that is a bot check — a Cloudflare challenge, DataDome, PerimeterX, a
  captcha — read off the title or the opening of a short page, so an article
  about captchas is still an article;
- a short 401/403/429/451, and a page with no text (a PDF excepted);
- a search with no results, a map with no links, a crawl of nothing but walls.

A 404 is not one: the site answered, and every provider would hear the same.

## What every answer says

The first line is `UNTRUSTED`, the second who served it and what was tried
first: `Served by Cloud Firecrawl. Before it: Self-hosted Firecrawl failed
(blocked: …); The agent's own web tools passed (the agent said its own tools had
failed).` Steps the user switched off are left out of the model's line — they
are a choice, not news — and kept in the record. Settings → Web keeps the last
twenty calls with every step, how long each took, what it cost and which agent
asked (`<state>/web-usage.json`); a refusal repeated in a loop is one row with a
count, written once a second at most.

## What the tools tell the model

The order is said **in each tool's description**, written from the chain as it
stands (`routeWords`), because a model that searched its way to one tool
(Codex's `tool_search`, Claude Code's deferred tools) reads that description and
no other. With ours first: *use this first, before your own web fetch… if kururu
cannot get it, the result says so: then use your own… if that fails too, call
again with `ownToolsFailed: true`, which goes on to Cloud Firecrawl (paid, on the
user's credits)*. With nothing free first, it reads as the fallback it was before
the chain. Every tool has the `ownToolsFailed` argument, described as the way
past the hand-back and what it may cost.

It is said once more as the server's MCP `instructions`, which Claude Code puts
in the system prompt beside the tools, and in the harness's role
(`rolePrompt`), so Kuru follows the same order and knows its agents do.
"Your own web search and fetch", never a CLI's tool names, because Claude Code
and Codex are given the same four.

## The shape, and the two it is not

**Four MCP tools served by the server on loopback, at `POST /mcp/web`.** Kururu
makes each request itself with the key it read off the disk a moment before, and
what crosses back to the agent is the page.

Not **a key in every agent's environment** with Firecrawl's own SDK or MCP
server. That is the obvious way and the one this is built not to be: the key
would be in every pty's env, inherited by everything the agent runs, in `ps e`,
and one `env` away from a transcript. Firecrawl's hosted MCP is no better —
its address carries the key in its path.

Not **a `kururu fetch` command on the `PATH`**. A tool is described to the model
by the tool list itself, so no CLAUDE.md has to mention it; its arguments arrive
as JSON rather than through a shell; and both CLIs take an MCP server on their
command line for one launch without a file of theirs being touched.

The endpoint is `mcp.ts`'s five methods — the same code `/mcp` answers the
harness with — behind a stricter gate: loopback, no `Origin`, and nothing a proxy
added (`localCaller`), whether or not sharing is on. A page in a browser tab is
the one caller that must never spend credits, and `tailscale serve` arrives on
loopback too, which is why the forwarding headers are refused.

## How an agent gets the tools

`WebChain.launchFlags` is appended to every local agent's command line while any
provider other than the hand-back is on and set up (`active`) — in
`agentCommandFor` (the + menu, a card's robot, the harness's `start_agent`, the
harness itself) and in a card picked back up (`resumeCardAt`):

- **Claude Code:** `--mcp-config='<state>/web-mcp.json'`, a file rewritten at each
  launch because the port in it moves with the server. Spelt with `=` on
  purpose: `--mcp-config` takes any number of values, so `--mcp-config file 'the
  card'` would read the card's prompt as a second config.
- **Codex:** three `-c` overrides (`mcp_servers.kururu_web.url`,
  `tool_timeout_sec`, `env_http_headers`), which change the launch and never
  `~/.codex/config.toml`.

The agent names itself in an `x-kururu-agent` header from `KURURU_AGENT_ID`, which
every kururu pty has. Both CLIs time an MCP call out at a minute by default,
which a crawl would hit, so both are told `WEB_TIMEOUT_MS` (five minutes).

**Who does not get them:** an agent already running when the first provider is
set up (the next time it is started, it does); an agent on a machine (below);
and a `claude` or `codex` typed into a shell, which kururu never sees being
launched — `claude mcp add --transport http kururu_web http://127.0.0.1:7717/mcp/web`
adds them by hand.

## Settings → Web

The order first, with ↑ and ↓; then a card per provider, in order: its switch,
what it can do, its health (checked on start, every five minutes while a window
is open, and after a field changes), its fields, its figures, a Test button, and
a fold with what it is and what leaves the Mac. Then the page limit, then the
recent calls.

**The page knows fields, not providers.** A provider describes what it asks for
— an address, a secret, a number — and what it reads out (`view` → `WebField`,
`WebReadout`), and `web/src/settings/Web.tsx` draws that. A secret crosses only
as its hint.

**The page limit is the chain's**, not a provider's (default 25, 1–500): a crawl's
pages and a PDF's, whoever does it — the cloud's credits are one reason and the
load on a box another project's production shares is the other.

## The keys

Every provider keeps its own settings and secrets on the OpenRouter key's terms
(`server/src/openrouter.ts` has the argument): a file in `~/.config/kururu`,
0600, read off the disk at the moment of each request and dropped with it; never
logged; never sent to a client, which gets a hint (`fcs-…4f1c`); never in a
pty's environment; never in a backup — the backup is an allow-list, and the
page names `web-*.json` and `firecrawl.json` as what stays.

| provider | file | holds |
|---|---|---|
| self-hosted Firecrawl | `web-firecrawl-self.json` | its address and the gate's key |
| cloud Firecrawl | `firecrawl.json` (its name from before the chain, so nobody pastes it again) | the key and the daily budget |
| the chain | `web.json` (backed up; no secrets) | the order, the switches, the page limit |

A key goes in one place: the `Authorization` header of a request under its own
provider's address. A crawl's `next` links are followed by their path alone,
under that address (`crawlNext`), so nothing in a response body can send a key
anywhere else — which also mends the self-hosted Firecrawl writing `next` with
the address it thinks it has (`http://localhost:3002/…`).

A key is tried before it is kept, for free: the cloud's against
`/team/credit-usage`, ours against `/v0/health/readiness` through the gate.

`web.json` is written on the first start of the chain from what was there:
every provider's switch as it stood (the cloud one's from `firecrawl.json`'s old
`enabled`) and the old page limit.

## The cloud's guards

Credits are the user's money and an agent in a loop does not stop by itself.
Firecrawl's own default limit on a crawl is ten thousand pages.

- **The page limit**, above: a crawl's `limit` is held to it and always sent.
- **A daily budget** (default 200 credits, every agent together, the local
  calendar's day). Each call reserves its estimate before Firecrawl is asked —
  so ten agents at once cannot each see the same last credit — and what it
  really cost is written down after. A crawl that would cross the line is
  lowered to what is left, and says so; anything else is refused with a
  sentence that tells the agent to tell the user. The count lives in
  `<state>/firecrawl-usage.json`.
- **A crawl waits four minutes**, then is cancelled (`DELETE /crawl/{id}`) and
  returns the pages it had — and is cancelled too when the chain stops waiting.
- **The hand-back in front of it**, so it is reached only when the agent says
  its own tools failed.
- **Firecrawl's per-key spend limit**, set in Firecrawl's dashboard and enforced
  on their side, where no bug in here can reach it.

## What comes back is untrusted

The web is written by strangers, and a page can say "ignore your previous
instructions" in white on white. So every result's first line is `UNTRUSTED`;
each page is wrapped in `<web_page url=… title=… status=…>`, each map or search
result in `<web_result>`, and a closing tag inside a page is defused
(`<\/web_page`); every tool's description says the same.

## What leaves the machine

The URL of every page an agent asks for, or the words of its search:

- to **our Firecrawl**, over the tailnet, which fetches the page from the
  internet from that box's own connection and searches through SearXNG, which
  asks Google and the other engines it is set up with;
- to **firecrawl.dev**, with the key, only when the chain reaches the cloud,
  which caches pages for up to two days.

Nothing else of the agent's goes. Addresses on this Mac, the local network or
the tailnet (`localhost`, private and CGNAT ranges, `.local`, `.ts.net`, a name
with no dot) are refused before anything is sent, for every provider — the
cloud could not reach them, and ours could, which is worse: a page an agent read
could ask it to fetch a dashboard on the tailnet or the router. The cloud's credit figures are read
every five minutes while a window is open and after calls.

## Running your own Firecrawl

The self-hosted provider wants a Firecrawl reachable from this Mac and a key in
front of it. Ours is Firecrawl's own `docker-compose.yaml` on a Linux box on
the tailnet, with SearXNG beside it for search
(`SEARXNG_ENDPOINT=http://searxng:8080`; deploy SearXNG first if it creates the
network Firecrawl joins).

```
 Mac (kururu) ── tailnet ── <box>:3002 ── gate (nginx: bearer key) ── api ──┬── playwright-service
                                                                            ├── redis, rabbitmq, nuq-postgres
                                                                            └── searxng
```

**The gate.** A self-hosted Firecrawl has no authentication
(`USE_DB_AUTHENTICATION=false`; turning it on needs Supabase), so nothing
should reach the API but an nginx that compares `Authorization: Bearer <key>`
and answers 401 otherwise. Let nothing but the gate be reached from off the
box, and that only from the tailnet. On a box with a LAN, ours published the
gate on the box's Tailscale address and kept it there with ufw route rules
too (`ufw route allow in on tailscale0`, deny on the other interfaces),
because Docker-published ports skip ufw's input rules. On the VPS it runs on
now, it is a Swarm stack and publishes nothing: the gate is the one service on
the reverse proxy's network, and a Traefik router on the plain-HTTP entrypoint
(`Host(<the box's Tailscale address>)`) lets it through behind an allowlist of
`100.64.0.0/10`, so anything from the internet gets a 403 whatever Host header
it sends. Plain HTTP is enough over the tailnet, which WireGuard encrypts. A
port bound to the Tailscale address is the thing to avoid there: at boot it can
be bound before tailscaled has brought the address up, Docker does not retry a
start that failed, and Swarm cannot bind one address at all. A
`/healthz` that answers `ok` without the key is enough for a load balancer;
the provider's health check is Firecrawl's `/v0/health/readiness` through the
gate. The key's other copy is kururu's `web-firecrawl-self.json`: to change
it, set the new value on the box, redeploy, and paste it in Settings → Web.

**What we changed from Firecrawl's compose, each for something its logs
showed:**

- **SearXNG's engines cut to the ones that answer from the box's IP**
  (`use_default_settings.engines.keep_only`). With the defaults, from a home
  IP, DuckDuckGo answered every query with a CAPTCHA, Brave with 429 and a
  suspension, Google and Qwant with access denied, and Wikidata timed out —
  holding every search for the full timeout. Google CSE, Bing and Yahoo answer,
  in about a second, from a home IP and from a VPS alike; Wikipedia answered
  from home and is suspended for too many requests from the VPS. Which engines
  answer depends on the address, so re-check after a move, with a query per
  engine (`&engines=bing`), and look at `unresponsive_engines` before adding
  one back.
- **Redis keeps no snapshots** (`--save "" --appendonly no`). Its data is a
  throwaway cache, and without `vm.overcommit_memory=1` on the host a failed
  background save makes Redis refuse every write.
- **pg_cron is quiet** (`-c cron.log_run=off -c cron.log_statement=off`). It
  runs about forty queue jobs, several every few seconds, and otherwise logs
  every statement.
- **Playwright runs `node dist/api.js`**, which is all `pnpm start` does, so a
  new container does not fetch pnpm through Corepack first.
- **Sized to share a box:** lower `cpu_shares` than whatever else runs there,
  so production wins any contest for the CPU (Swarm has no shares, so as a
  stack it is a ceiling of 1.5 of the box's two cores on the API and on
  Playwright instead); one NuQ worker instead of five
  (`NUQ_WORKER_COUNT`, about 300 MB each), `NUM_WORKERS_PER_QUEUE=2`, two
  pages at a time in the browser. Memory is left uncapped, so check the box
  has the room before deploying: idle, the whole project takes about 2.5 GB,
  most of it the API.

**A changed inline config needs a new name.** Compose does not recreate a
container when only the `content:` of a config changes, so version a config in
its name (`settings-v3`) and bump it with any edit. As a stack the gate's and
SearXNG's configs are files mounted beside the compose instead (Dokploy's File
Mounts), and the gate's key reaches nginx through its own template step
(`/etc/nginx/templates`, `NGINX_ENVSUBST_FILTER`), never written into a file.

**What the logs say that is fine:** `AUTUMN_SECRET_KEY is not set` and
`You're bypassing authentication` (cloud billing and auth; the gate is the auth
here); `Credits billed unknown`; `All scraping engines failed` for a page
behind a bot check (the chain's `blocked`); `SCRAPE_SITEMAP_ERROR` 404 for a
site with no sitemap; Playwright's `No proxy server provided`; SearXNG's missing
`limiter.toml`. When Postgres or Redis is recreated, Firecrawl's supervisor
restarts the API container — about ten seconds, by itself.

**What it handles**, measured on 2026-10-15 through the chain:

| page | result |
|---|---|
| a static page (gnu.org) | served, 1.7 s |
| a page drawn by JavaScript (quotes.toscrape.com/js) | served, 1.9 s |
| a Cloudflare challenge (scrapingcourse.com's test page), G2 behind Cloudflare | **failed** — Playwright gets the 403, and the stealth proxy Firecrawl would retry with is a cloud feature; the chain reads `blocked` and hands back |
| an Instagram profile (`/natgeo/`) | served, with the recent posts' captions |
| a search (through SearXNG) | served, 1.5 s (4 s before the engines were cut to the ones that answer) |
| a crawl of three or four pages | served, 12–23 s; only pages under the starting path unless `entireDomain` |
| a map | served from a sitemap; a site without one comes back with nothing, which fails over |

## Adding a provider

One new file in `server/src/web/providers/`, and nothing else. The build imports
every file in that directory (`webProviders` in `desktop/build.mjs` makes the
module `kururu:web-providers` from it at build time), the chain puts the new
provider in the order by its `rank` — after the provider that comes before it by
default, so the user's order is not reshuffled — and Settings → Web draws it
from its `view`.

```ts
import type { WebCall, WebCapability, WebHealth } from "../../../../shared/web";
import { readConfigFile, writeConfigFile } from "../../config";
import { providerFile, registerWebProvider, type ProviderView, type RunContext, type StepAnswer, type WebProvider } from "../provider";

const FILE = providerFile("brave-search"); // web-brave-search.json: the backup already leaves it behind

class BraveSearch implements WebProvider {
  readonly id = "brave-search";
  readonly label = "Brave Search";
  readonly kind = "service" as const;
  readonly paid = true;
  defaultEnabled() { return true; }
  can(): readonly WebCapability[] { return ["search"]; }      // the chain passes it over for the other three
  ready() { return /* a key on disk */ false; }
  timeoutMs() { return 20_000; }
  async run(call: WebCall, ctx: RunContext): Promise<StepAnswer> {
    // Read the key now, request with ctx.signal, and answer in the shared shape:
    // { outcome: "served", result: { tool: "search_web", query, hits }, credits }
    // or { outcome: "failed", failure: "unreachable" | "refused" | …, reason }.
    // Never judge the page and never retry: the chain does both.
  }
  async health(): Promise<WebHealth> { /* a free request */ }
  view(): ProviderView { /* summary, fields (a "secret" named "key"), readouts, about, links, test */ }
  async setField(name: string, value: unknown) { /* check, try for free, writeConfigFile(FILE, …, 0o600) */ }
  clearField(name: string) { /* … */ }
}

registerWebProvider({ id: "brave-search", rank: 25, create: () => new BraveSearch() });
```

`rank` places it in the default order (self 10, hand-back 20, cloud 30). A
provider that answers some tools and not others says so in `can`; one that
costs money says `paid`, which the descriptions and the page then say for it.
If it reaches a new host on the user's behalf, say so in its `about` and in
"What leaves the machine" above.

## Calling the chain from elsewhere in kururu

`web.run(call, agent)` in `index.ts` is the chain without the MCP wrapping: it
takes a `WebCall` (`webCall` checks raw arguments into one) and returns a
`ChainAnswer` — the result as data (`WebResult`), who served it, every step, the
credits — so another part of kururu can read a page through the same order,
the same guards and the same record, and render it with `renderResult` or not
at all.

## Agents on a machine

**They do not get the tools.** A workspace pinned to a machine
runs its agents there, in tmux over `ssh -t`, and the server binds loopback on
this Mac, so there is no address on the machine to give them. The remote launch
path (`remoteAgentRun`) is left alone on purpose; an agent there simply has no
`kururu_web` tools rather than tools that fail.

Making it work is not small: each ssh link would need a reverse forward
(`ssh -R`) to a listener that serves `/mcp/web` and nothing else — forwarding
the server's port would hand every process on the machine the harness's verbs
too — on a port that cannot collide between links, and the tunnel dies with the
link while the agent lives on in tmux. (An agent on the Firecrawl box itself could reach
our Firecrawl directly, but would need the key, which is the thing this is built
not to lend.)

## Testing

`bun test server/test/webchain.test.ts` is the chain over fake providers and the
real hand-back: the order, a provider off, not set up or unable, failover on an
error, a timeout (and the abort), a challenge page and no results, the rest
after an unreachable provider, the hand-back and the opt-in, the MCP answer and
the record. `web.test.ts` is the vocabulary — the verdicts, the descriptions as
the chain changes, the settings — and `firecrawl.test.ts` is Firecrawl's API.

`KURURU_FIRECRAWL_API=http://127.0.0.1:<port>/v2` points the cloud provider at a
stand-in — loopback only, so the variable cannot point the key anywhere else.
The self-hosted provider needs no such switch: its address is a Settings field,
so a stand-in is an address. What was verified end to end is in
[testing](testing.md#what-has-been-verified-end-to-end).
