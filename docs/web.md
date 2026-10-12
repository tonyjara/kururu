# The web for agents (Firecrawl)

Agents keep meeting pages a plain fetch cannot read: a shop whose list is drawn
by JavaScript after the page loads, a site that answers anything without a
browser's fingerprint with a wall, a PDF. Firecrawl (firecrawl.dev, the hosted
API) renders the page in a browser on its own servers and hands back markdown.
Kururu holds one Firecrawl key and lends the fetching — never the key — to every
agent it starts.

Set up in **Settings → Agents → Firecrawl**, which is a walkthrough: an account,
a key, what the credits buy, the paste, a test page.

## The shape, and the two it is not

**Four MCP tools served by the server on loopback, at `POST /mcp/web`**:
`scrape_page`, `crawl_site`, `map_site`, `search_web`. Kururu makes each request
itself with the key it read off the disk a moment before, and what crosses back
to the agent is the page.

Not **the key in every agent's environment** with Firecrawl's own SDK or MCP
server. That is the obvious way and the one this is built not to be: the key
would be in every pty's env, inherited by everything the agent runs, in `ps e`,
and one `env` away from a transcript. Firecrawl's hosted MCP is no better —
its address carries the key in its path, in every agent's config.

Not **a `kururu fetch` command on the `PATH`**. A tool is described to the model
by the tool list itself, so no CLAUDE.md has to mention it and no agent has to
think of running a command it has never heard of; its arguments arrive as JSON
rather than through a shell; and both CLIs take an MCP server on their command
line for one launch without a file of theirs being touched.

The endpoint is `mcp.ts`'s five methods again — the same code `/mcp` answers the
harness with — and a stricter gate in front: loopback, no `Origin`, and nothing a
proxy added (`localCaller`), whether or not sharing is on. A page in a browser
tab is the one caller that must never spend credits, and `tailscale serve`
arrives on loopback too, which is why the forwarding headers are refused.

## How an agent gets the tools

`Firecrawl.launchFlags` is appended to every local agent's command line while a
key is saved and the switch is on — in `agentCommandFor` (the + menu, a card's
robot, the harness's `start_agent`, the harness itself) and in a card picked back
up (`resumeCardAt`):

- **Claude Code:** `--mcp-config='<state>/web-mcp.json'`, a file rewritten at each
  launch because the port in it moves with the server. Layered over whatever MCP
  servers the agent already has, and spelt with `=` on purpose: `--mcp-config`
  takes any number of values, so `--mcp-config file 'the card'` would read the
  card's prompt as a second config. The harness ends up with two
  `--mcp-config` values — this file and its own — which Claude Code merges.
- **Codex:** three `-c` overrides (`mcp_servers.kururu_web.url`,
  `tool_timeout_sec`, `env_http_headers`), which change the launch and never
  `~/.codex/config.toml`. Codex 0.146 puts every MCP server's tools behind its
  own `tool_search`, so a GPT model finds them by searching, as it finds any
  server's.

The agent names itself in an `x-kururu-agent` header from `KURURU_AGENT_ID`,
which every kururu pty has (Claude Code expands `${KURURU_AGENT_ID}` in the
config; Codex reads the variable it is told to). Settings lists who spent what by
it. A call without it is still served.

**Who does not get them:** an agent already running when the key is saved or
the switch turned on (the next time it is started, it does); an agent on a
machine (below); and a `claude` or `codex` typed into a shell, which kururu never
sees being launched. For the last, the tools can be added to a CLI's own config
by hand — `claude mcp add --transport http kururu_web http://127.0.0.1:7717/mcp/web`
— and refuse with a sentence while the switch is off.

Both CLIs time an MCP call out at a minute by default, which a crawl would hit,
so both are told `WEB_TIMEOUT_MS` (five minutes); a crawl gives up at four.

## The key

On the OpenRouter key's terms (`server/src/openrouter.ts` has the argument):
`~/.config/kururu/firecrawl.json`, 0600, with the switch and the two limits beside
it. Read off the disk at the moment of each request and dropped with it; never
logged; never sent to a client, which gets `hint` (`fc-…a3f9`); never in a pty's
environment; never in a backup — the backup is an allow-list and the file is on
its `EXCLUDED` list so the page says so.

It goes in one place: the `Authorization` header of a request to
`api.firecrawl.dev/v2`. A crawl's results come in pages linked by `next`, and a
`next` link is followed only if it is that API (`apiNext`) — a URL out of a
response body is not a thing to send a key to on trust.

A key is tried before it is kept, against `/team/credit-usage`, which costs
nothing. The walkthrough's last step is one real page (`example.com`, a credit),
so "it works" means a page came back.

## The guards

Credits are the user's money and an agent in a loop does not stop by itself.
Firecrawl's own default limit on a crawl is ten thousand pages.

- **Pages per call** (default 25, 1–500): a crawl's `limit` is held to it and
  always sent, and a PDF is parsed to that many pages. A PDF met inside a crawl
  is read to two (`CRAWL_PDF_PAGES`). The result says when the cap bit.
- **A daily budget** (default 200 credits, every agent together, the local
  calendar's day). Each call reserves its estimate before Firecrawl is asked —
  so ten agents at once cannot each see the same last credit — and what it really
  cost is written down after: Firecrawl's `creditsUsed` where it says, a credit a
  page (a PDF, a credit a PDF page) where it does not. A crawl that would cross
  the line is lowered to what is left, and says so; anything else is refused
  with a sentence that tells the agent to tell the user rather than retry. The
  count lives in `<state>/firecrawl-usage.json`, because the server restarts on
  every save under `bun run dev`.
- **A crawl waits four minutes**, then is cancelled (`DELETE /crawl/{id}`) and
  returns the pages it had, rather than spending in the background on a result
  nobody collects.
- **A refusal repeated** — same tool, page, agent and reason — is a count on one
  row of the recent list, written and broadcast once a second at most. A real
  Claude Code in a stuck tool loop made eleven hundred calls in twenty seconds in
  testing; the budget stopped it at the credit, and this keeps the window out of
  it.
- **Firecrawl's per-key spend limit**, which the walkthrough asks the user to set
  in Firecrawl's dashboard. It is enforced on their side, where no bug in here can
  reach it.

The switch off means new agents are not given the tools and a call from one that
has them is refused.

## What comes back is untrusted

The web is written by strangers, and a page can say "ignore your previous
instructions" in white on white. So:

- every result's first line is `UNTRUSTED` — data, never instructions;
- each page is wrapped in `<web_page url=… title=… status=…>`, each map or search
  result in `<web_result>`, and a closing tag inside a page is defused
  (`<\/web_page`) so a page cannot end its own wrapper and speak outside it;
- every tool's description says the same, which the model reads before it ever
  calls one.

## What leaves the machine

The URL of every page an agent asks for, or the words of its search, go to
Firecrawl with the key; Firecrawl fetches the page from the internet and keeps it
in a cache for up to two days. Nothing else of the agent's goes. Addresses on
this Mac, the local network or the tailnet (`localhost`, private and CGNAT
ranges, `.local`, `.ts.net`, a name with no dot) are refused before anything is
sent — Firecrawl could not reach them, and such a URL is often a dev server with
a token in its query string. The credit figures (`/team/credit-usage`) are read
every five minutes while a window is open and after calls.

## Agents on a machine

**They do not get the tools.** A workspace pinned to omarchy1 (or any machine)
runs its agents there, in tmux over `ssh -t`, and the server binds loopback on
this Mac, so there is no address on the machine to give them. The remote launch
path (`remoteAgentRun`) is left alone on purpose; an agent there simply has no
`kururu_web` tools rather than tools that fail.

Making it work is not small, which is why it is not done: each ssh link would
need a reverse forward (`ssh -R`) to a listener that serves `/mcp/web` and
nothing else — forwarding the server's port would hand every process on the
machine the harness's verbs too — on a port that cannot collide between links,
and the tunnel dies with the link while the agent lives on in tmux, so a
reattach would have to bring it back. Until then, a local agent or the harness
can fetch a page and pass on what it needs.

## Testing

`KURURU_FIRECRAWL_API=http://127.0.0.1:<port>/v2` points the server half at a
stand-in — loopback only, so the variable cannot point the key anywhere else. The
pure half is `server/test/firecrawl.test.ts`. What was verified end to end is in
[testing](testing.md#what-has-been-verified-end-to-end).
