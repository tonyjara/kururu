/**
 * Firecrawl for every agent kururu starts: the key, the calls, the budget.
 *
 * `shared/firecrawl.ts` argues for the shape — the key stays here and kururu
 * fetches on the agents' behalf, over an MCP endpoint on loopback. This is
 * the half that holds the key and spends the credits, and both of those are
 * most of what there is to get right.
 *
 * **The key is kept on the OpenRouter key's terms** (`openrouter.ts` has the
 * argument): `~/.config/kururu/firecrawl.json`, 0600, read off the disk at
 * the moment of each request and dropped with it, never logged, never sent
 * to a client — `hint` is — never in a pty's environment, and not on
 * `shared/backup.ts`'s list, so it never leaves in a backup. It goes in one
 * place, the `Authorization` header of a request to `api.firecrawl.dev`, and
 * a `next` link out of a response body is followed only if it is that API
 * (`apiNext`).
 *
 * **The budget is counted here, before Firecrawl is asked.** Each call
 * reserves what it is expected to cost against the day's allowance, so ten
 * agents calling at once cannot each see the same last credit; what it really
 * cost — Firecrawl's own `creditsUsed` where it says, a credit a page where it
 * does not — is written down when it returns. The count is kept in the state
 * directory, because this server restarts on every save under `bun run dev`
 * and a budget that reset on each one would be no budget.
 *
 * **What leaves the machine:** the URL or the search, to Firecrawl, and
 * nothing else of the agent's. The page comes back through here and goes to
 * the agent that asked, wrapped as untrusted (`UNTRUSTED`).
 *
 * On the restartable side for `openrouter.ts`'s reason — a question with no
 * pty in it. Editing it costs a reconnect and no agents; what it changes in
 * a launch reaches the next agent started.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  AGENT_HEADER,
  CRAWL_WAIT_MS,
  RESULT_MAX_CHARS,
  UNTRUSTED,
  accountFrom,
  adoptFirecrawlSettings,
  apiNext,
  budgetLeft,
  claudeWebConfig,
  clip,
  codexWebFlags,
  crawlDone,
  crawlFrom,
  estimate,
  firecrawlHint,
  formatCredits,
  mapFrom,
  pageCredits,
  pageFrom,
  refusal,
  renderHits,
  renderMap,
  renderPage,
  requestBody,
  searchFrom,
  todayOf,
  validFirecrawlKey,
  webCall,
  webTools,
  type CrawlCall,
  type CrawlState,
  type FirecrawlAccount,
  type FirecrawlCall,
  type FirecrawlDay,
  type FirecrawlSettings,
  type FirecrawlStatus,
  type MapCall,
  type ScrapeCall,
  type SearchCall,
  type WebCall,
  type WebPage,
  type WebToolName,
} from "../../shared/firecrawl";
import type { AgentCli } from "../../shared/launchers";
import type { ServerMessage } from "../../shared/wire";
import { readConfigFile, removeConfigFile, writeConfigFile } from "./config";
import type { McpResult, McpTool } from "./mcp";

const FILE = "firecrawl.json";
const USAGE_FILE = "firecrawl-usage.json";
const LAUNCH_FILE = "web-mcp.json";
/**
 * Firecrawl's API — or, for an isolated instance's tests, a stand-in on this
 * Mac named by `KURURU_FIRECRAWL_API`. Loopback and nothing else, so the
 * variable can point the key at a fake and never at anybody's server.
 */
const API = /^http:\/\/127\.0\.0\.1:\d{2,5}\/v2$/.test(process.env.KURURU_FIRECRAWL_API ?? "")
  ? process.env.KURURU_FIRECRAWL_API!
  : "https://api.firecrawl.dev/v2";
const KEYS_PAGE = "firecrawl.dev/app/api-keys";

/** Firecrawl gives a page sixty seconds to load; this is that and a margin for the trip. */
const ASK_MS = 90_000;
/** The credit figures and a key being tried: one small GET, which should be quick or is not coming. */
const ACCOUNT_ASK_MS = 10_000;
/** Between looks at a running crawl. Looking is free; Firecrawl bills pages, not polls. */
const CRAWL_POLL_MS = 2_000;
/** How stale the credit figures may get while a window is open. */
const ACCOUNT_EVERY_MS = 5 * 60_000;
/** How often the staleness is looked at. */
const TICK_MS = 60_000;
/** How long after a call the figures are read again, so a burst of calls is one read. */
const AFTER_CALL_MS = 5_000;
const RECENT_MAX = 20;
/** How often a refusal repeated in a loop is written down and broadcast. */
const REPEAT_FLUSH_MS = 1_000;
/** The test page: tiny, stable, and nobody's business. */
const TEST_URL = "https://example.com/";

function stateDir(): string {
  return process.env.KURURU_STATE_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "kururu");
}

interface Stored {
  apiKey?: unknown;
  settings?: unknown;
}

function stored(): Stored {
  const raw = readConfigFile(FILE);
  return raw && typeof raw === "object" ? (raw as Stored) : {};
}

/** The key on disk, or null. Read per request and never cached — see the module comment. */
function storedKey(): string | null {
  const key = stored().apiKey;
  return validFirecrawlKey(key) ? key : null;
}

/** Single-quoted for `sh -c`. */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

type Asked = { ok: true; body: unknown } | { ok: false; status: number | null; error: string };

/**
 * One request to Firecrawl's API, and nowhere else: `target` is a path under
 * it, or a `next` link `apiNext` has already said is under it.
 */
async function ask(key: string, method: "GET" | "POST" | "DELETE", target: string, body?: unknown, timeoutMs = ASK_MS): Promise<Asked> {
  const url = target.startsWith(`${API}/`) ? target : `${API}${target}`;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const parsed: unknown = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, status: res.status, error: refusal(res.status, parsed) };
    // Some failures come back 200 with `success: false` and the reason beside it.
    if (parsed && typeof parsed === "object" && (parsed as { success?: unknown }).success === false) {
      const said = (parsed as { error?: unknown }).error;
      return { ok: false, status: res.status, error: `Firecrawl could not do it${typeof said === "string" ? `: ${said.slice(0, 200)}` : "."}` };
    }
    return { ok: true, body: parsed };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return { ok: false, status: null, error: timedOut ? "Firecrawl did not answer in time." : "Could not reach Firecrawl." };
  }
}

interface Usage {
  day: FirecrawlDay | null;
  recent: FirecrawlCall[];
}

function usagePath(): string {
  return join(stateDir(), USAGE_FILE);
}

/** The day's count and the recent list, as the last server left them. Anything unreadable is a fresh start. */
function readUsage(): Usage {
  try {
    const raw = JSON.parse(readFileSync(usagePath(), "utf8")) as Record<string, unknown>;
    const d = raw.day as Record<string, unknown> | null;
    const day =
      d && typeof d.day === "string" && Number.isFinite(d.credits) && Number.isFinite(d.calls)
        ? { day: d.day, credits: Number(d.credits), calls: Number(d.calls) }
        : null;
    const recent = Array.isArray(raw.recent)
      ? raw.recent.filter((c): c is FirecrawlCall => Boolean(c) && typeof (c as FirecrawlCall).at === "number" && typeof (c as FirecrawlCall).target === "string").slice(0, RECENT_MAX)
      : [];
    return { day, recent };
  } catch {
    return { day: null, recent: [] };
  }
}

function writeUsage(usage: Usage): void {
  const path = usagePath();
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(`${path}.tmp`, `${JSON.stringify(usage, null, 2)}\n`, "utf8");
    renameSync(`${path}.tmp`, path);
  } catch {
    // The count is still right in memory; the next start is the one that forgets it.
  }
}

/**
 * Whether a request to `/mcp/web` comes from a program on this Mac: a
 * loopback socket, no `Origin` (an agent's CLI is not a browser, and a page
 * in a tab is the one caller that must never spend credits), and nothing a
 * proxy in front would have added — `tailscale serve` arrives on loopback too.
 */
export function localCaller(req: IncomingMessage): boolean {
  const remote = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  const loopback = remote === "::1" || remote.startsWith("127.");
  return loopback && !req.headers.origin && !req.headers["x-forwarded-for"] && !req.headers.forwarded;
}

/** The agent a request says it is from, or null. Its own header; checked against the host by the caller. */
export function callerAgent(req: IncomingMessage): string | null {
  const value = req.headers[AGENT_HEADER];
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
}

export interface FirecrawlDeps {
  broadcast(message: ServerMessage): void;
  /** How many windows are open: the figures are not read for nobody. */
  clients(): number;
  /** This server's port, for the address agents are pointed at. */
  port(): number;
  /** An agent's name, for the list of recent calls, or null if it is not one of ours. */
  nameOf(agentId: string): string | null;
}

interface Ran {
  text: string;
  credits: number;
  /** Whether Firecrawl was asked at all. */
  sent: boolean;
  error: string | null;
}

export class Firecrawl {
  private hint: string | null;
  private settings: FirecrawlSettings;
  private account: FirecrawlAccount | null = null;
  private error: string | null = null;
  private day: FirecrawlDay | null;
  private recent: FirecrawlCall[];
  /** Credits promised to calls still in flight. */
  private reserved = 0;
  /** Bumped when the key changes hands, so a read that set off with the old key lands nowhere. */
  private generation = 0;
  private polling = false;
  private soon: ReturnType<typeof setTimeout> | null = null;
  private flush: ReturnType<typeof setTimeout> | null = null;
  private readonly tick: ReturnType<typeof setInterval>;

  constructor(private readonly deps: FirecrawlDeps) {
    const s = stored();
    this.hint = validFirecrawlKey(s.apiKey) ? firecrawlHint(s.apiKey) : null;
    this.settings = adoptFirecrawlSettings(s.settings);
    const usage = readUsage();
    this.day = usage.day;
    this.recent = usage.recent;
    // Unref'd: a timer that asks a question is never a reason for the process to stay up.
    this.tick = setInterval(() => void this.poll(), TICK_MS);
    this.tick.unref();
  }

  close(): void {
    clearInterval(this.tick);
    if (this.soon) clearTimeout(this.soon);
    if (this.flush) clearTimeout(this.flush);
  }

  status(): FirecrawlStatus {
    return {
      hint: this.hint,
      settings: this.settings,
      account: this.account,
      error: this.error,
      today: todayOf(this.day),
      recent: this.recent,
    };
  }

  message(): ServerMessage {
    return { type: "firecrawl", firecrawl: this.status() };
  }

  private changed(): void {
    this.deps.broadcast(this.message());
  }

  /** Whether agents started now are given the tools. */
  active(): boolean {
    return this.hint !== null && this.settings.enabled;
  }

  // -------------------------------------------------------------------------
  // The account
  // -------------------------------------------------------------------------

  /**
   * Read the credit figures, when a window is open and they are stale, or at
   * once when `force`. A failed read keeps the last figures and says why.
   */
  async poll(force = false): Promise<void> {
    const key = storedKey();
    if (!key || this.polling) return;
    if (!force) {
      if (this.deps.clients() === 0) return;
      if (this.account && !this.error && Date.now() - this.account.at < ACCOUNT_EVERY_MS) return;
    }
    this.polling = true;
    const started = this.generation;
    try {
      const asked = await ask(key, "GET", "/team/credit-usage", undefined, ACCOUNT_ASK_MS);
      if (this.generation !== started) return;
      const before = JSON.stringify([this.account?.remaining, this.account?.plan, this.account?.periodEnd, this.error]);
      if (asked.ok) {
        const account = accountFrom(asked.body, Date.now());
        if (account) {
          this.account = account;
          this.error = null;
        } else this.error = "Firecrawl's credit figures were not in a shape kururu knows.";
      } else this.error = asked.error;
      if (JSON.stringify([this.account?.remaining, this.account?.plan, this.account?.periodEnd, this.error]) !== before) this.changed();
    } finally {
      this.polling = false;
    }
  }

  private pollSoon(): void {
    if (this.soon) clearTimeout(this.soon);
    this.soon = setTimeout(() => {
      this.soon = null;
      void this.poll(true);
    }, AFTER_CALL_MS);
    this.soon.unref();
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  /**
   * Take a key from Settings: try it on the credit figures — a GET that costs
   * nothing — and keep it only if Firecrawl knows it. Throws the sentence the
   * page prints.
   */
  async setKey(raw: unknown): Promise<FirecrawlStatus> {
    const key = typeof raw === "string" ? raw.trim() : raw;
    if (!validFirecrawlKey(key)) throw new Error("That does not look like a Firecrawl API key. They start with fc-.");
    const asked = await ask(key, "GET", "/team/credit-usage", undefined, ACCOUNT_ASK_MS);
    // A 404 is a key Firecrawl knows on a team it has no figures for yet: still a key.
    if (!asked.ok && asked.status !== 404) {
      throw new Error(asked.status === 401 ? `Firecrawl does not recognise this key. Copy it again from ${KEYS_PAGE}.` : asked.error);
    }
    writeConfigFile(FILE, { apiKey: key, settings: this.settings }, 0o600);
    if (storedKey() !== key) throw new Error("Could not save the key to ~/.config/kururu/firecrawl.json.");
    this.generation++;
    this.hint = firecrawlHint(key);
    this.account = asked.ok ? accountFrom(asked.body, Date.now()) : null;
    this.error = null;
    this.changed();
    return this.status();
  }

  /** Forget the key: off the disk, with the settings that were kept beside it. */
  clearKey(): void {
    removeConfigFile(FILE);
    this.generation++;
    this.hint = null;
    this.account = null;
    this.error = null;
    this.settings = adoptFirecrawlSettings(null);
    this.changed();
  }

  /**
   * The switch and the two limits. Only what came as the right type is
   * taken — a NaN off the wire would otherwise read as "the default" — and
   * then brought into range.
   */
  setSettings(patch: { enabled?: unknown; pageLimit?: unknown; dailyCredits?: unknown }): FirecrawlStatus {
    const next: Record<string, unknown> = { ...this.settings };
    if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
    if (typeof patch.pageLimit === "number" && Number.isFinite(patch.pageLimit)) next.pageLimit = patch.pageLimit;
    if (typeof patch.dailyCredits === "number" && Number.isFinite(patch.dailyCredits)) next.dailyCredits = patch.dailyCredits;
    this.settings = adoptFirecrawlSettings(next);
    const key = storedKey();
    writeConfigFile(FILE, key ? { apiKey: key, settings: this.settings } : { settings: this.settings }, 0o600);
    this.changed();
    return this.status();
  }

  /**
   * The walkthrough's last step: one real page, a credit, so "it works" means
   * a page came back rather than that a key was accepted. Not held to the
   * day's budget — the person pressing it is the person who set it.
   */
  async test(): Promise<{ title: string | null; chars: number; credits: number }> {
    const key = storedKey();
    if (!key) throw new Error("Paste a key first.");
    const call: ScrapeCall = { tool: "scrape_page", url: TEST_URL, links: false, mainOnly: true, waitMs: 0, fresh: false, maxChars: 1000 };
    const asked = await ask(key, "POST", "/scrape", requestBody(call, this.settings));
    if (!asked.ok) {
      this.record("test", TEST_URL, 0, true, asked.error, null);
      throw new Error(asked.error);
    }
    const page = pageFrom((asked.body as { data?: unknown } | null)?.data, TEST_URL);
    const credits = page ? pageCredits(page) : 1;
    if (!page || !page.markdown.trim()) {
      this.record("test", TEST_URL, credits, true, "No text came back.", null);
      throw new Error("Firecrawl answered, but no text came back for the test page.");
    }
    this.record("test", TEST_URL, credits, true, null, null);
    return { title: page.title, chars: page.markdown.length, credits };
  }

  // -------------------------------------------------------------------------
  // What agents are given
  // -------------------------------------------------------------------------

  tools(): McpTool[] {
    return webTools(this.settings);
  }

  /**
   * What is appended to an agent's command line so it gets the tools: a
   * `--mcp-config` file for Claude Code, `-c` overrides for Codex, nothing
   * while there is no key or the switch is off. Neither touches the CLI's own
   * config, and neither carries the key — only this server's address.
   *
   * Claude's flag is spelt with `=` on purpose. `--mcp-config` takes any
   * number of values, so `--mcp-config file 'the card'` would read the card's
   * prompt as a second config; the `=` form takes exactly one.
   */
  launchFlags(cli: AgentCli): string {
    if (!this.active()) return "";
    if (cli === "codex") return ` ${codexWebFlags(this.deps.port())}`;
    const file = this.launchFile();
    return file ? ` --mcp-config=${quote(file)}` : "";
  }

  /** The file Claude's flag names, written now, because the port in it moves with the server. */
  private launchFile(): string | null {
    const path = join(stateDir(), LAUNCH_FILE);
    try {
      mkdirSync(stateDir(), { recursive: true });
      writeFileSync(path, `${JSON.stringify(claudeWebConfig(this.deps.port()), null, 2)}\n`, "utf8");
      return path;
    } catch {
      return null;
    }
  }

  /** One tool call from an agent, start to finish. */
  async call(name: string, args: Record<string, unknown>, agentId: string | null): Promise<McpResult> {
    const agent = agentId ? this.deps.nameOf(agentId) : null;
    const key = storedKey();
    if (!key) {
      return { text: "Firecrawl is not set up in kururu: there is no key in Settings → Firecrawl. Tell the user, or fetch the page another way.", isError: true };
    }
    if (!this.settings.enabled) {
      return { text: "Firecrawl is switched off in kururu's Settings → Firecrawl. Tell the user, or fetch the page another way.", isError: true };
    }
    const checked = webCall(name, args, this.settings);
    if (!checked.ok) return { text: checked.error, isError: true };
    let call = checked.value;
    const notes: string[] = [];
    if (call.tool === "crawl_site" && typeof args.limit === "number" && args.limit > this.settings.pageLimit) {
      notes.push(`kururu caps a crawl at ${this.settings.pageLimit} pages (Settings → Firecrawl), so this one fetched at most that.`);
    }

    const left = budgetLeft(this.settings, this.day) - this.reserved;
    let cost = estimate(call);
    if (call.tool === "crawl_site" && cost > left && left >= 1) {
      notes.push(`kururu lowered this crawl to ${left} pages to stay inside today's Firecrawl budget.`);
      call = { ...call, limit: left };
      cost = left;
    }
    const target = call.tool === "search_web" ? call.query : call.url;
    if (cost > left) {
      const spent = todayOf(this.day).credits;
      const error = `kururu's daily Firecrawl budget is used up: ${formatCredits(spent)} of ${formatCredits(this.settings.dailyCredits)} credits today${this.reserved ? `, with ${formatCredits(this.reserved)} promised to calls still running` : ""}, and this would need about ${formatCredits(cost)}. It resets at midnight; the user can raise it in Settings → Firecrawl. Tell the user rather than retrying.`;
      this.record(call.tool, target, 0, false, "Over today's budget.", agent);
      return { text: error, isError: true };
    }

    this.reserved += cost;
    let ran: Ran;
    try {
      ran = await this.run(key, call);
    } finally {
      this.reserved -= cost;
    }
    this.record(call.tool, target, ran.credits, ran.sent, ran.error, agent);
    if (ran.error) return { text: ran.error, isError: true };
    const today = todayOf(this.day);
    const spent = `Firecrawl: ${formatCredits(ran.credits)} ${ran.credits === 1 ? "credit" : "credits"} · kururu has spent ${formatCredits(today.credits)} of ${formatCredits(this.settings.dailyCredits)} today.`;
    return { text: [UNTRUSTED, spent, ...notes, "", ran.text].join("\n") };
  }

  private async run(key: string, call: WebCall): Promise<Ran> {
    switch (call.tool) {
      case "scrape_page":
        return this.scrape(key, call);
      case "crawl_site":
        return this.crawl(key, call);
      case "map_site":
        return this.map(key, call);
      case "search_web":
        return this.search(key, call);
    }
  }

  private async scrape(key: string, call: ScrapeCall): Promise<Ran> {
    const asked = await ask(key, "POST", "/scrape", requestBody(call, this.settings));
    if (!asked.ok) return { text: "", credits: 0, sent: true, error: asked.error };
    const page = pageFrom((asked.body as { data?: unknown } | null)?.data, call.url);
    if (!page) return { text: "", credits: 1, sent: true, error: "Firecrawl's answer was not in a shape kururu knows." };
    const site = page.status !== null && page.status >= 400 ? `The site itself answered ${page.status}; what it sent is below.\n` : "";
    return { text: site + renderPage(page, call.maxChars, "call scrape_page with a larger maxChars for more"), credits: pageCredits(page), sent: true, error: null };
  }

  /**
   * Start a crawl, wait for it, and hand back what it fetched. A crawl still
   * running at `CRAWL_WAIT_MS` is cancelled rather than left to spend in the
   * background on a result nobody will collect — the agent's call has to
   * return before its CLI gives up on it.
   */
  private async crawl(key: string, call: CrawlCall): Promise<Ran> {
    const started = await ask(key, "POST", "/crawl", requestBody(call, this.settings));
    if (!started.ok) return { text: "", credits: 0, sent: true, error: started.error };
    const id = (started.body as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(id)) {
      return { text: "", credits: 0, sent: true, error: "Firecrawl did not say which crawl it started." };
    }
    const deadline = Date.now() + CRAWL_WAIT_MS;
    let state: CrawlState | null = null;
    let cancelled = false;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, CRAWL_POLL_MS));
      const asked = await ask(key, "GET", `/crawl/${id}`);
      if (asked.ok) state = crawlFrom(asked.body) ?? state;
      else if (asked.status === 404 || asked.status === 401) break;
      if (state && crawlDone(state)) break;
      if (Date.now() > deadline) {
        await ask(key, "DELETE", `/crawl/${id}`, undefined, 15_000);
        cancelled = true;
        const last = await ask(key, "GET", `/crawl/${id}`);
        if (last.ok) state = crawlFrom(last.body) ?? state;
        break;
      }
    }
    if (!state) return { text: "", credits: call.limit, sent: true, error: "Firecrawl did not say how the crawl went." };

    // A finished crawl's pages come ten megabytes at a time; `next` is also
    // sent on a crawl that is not `completed`, so an empty page ends the walk.
    const pages: WebPage[] = [...state.pages];
    let next = apiNext(state.next, API);
    for (let hops = 0; next && pages.length < call.limit && hops < 10; hops++) {
      const more = await ask(key, "GET", next);
      const page = more.ok ? crawlFrom(more.body) : null;
      if (!page || page.pages.length === 0) break;
      pages.push(...page.pages);
      next = apiNext(page.next, API);
    }

    const head =
      `Crawled ${pages.length} ${pages.length === 1 ? "page" : "pages"} from ${call.url}` +
      (cancelled ? ` — it had not finished after ${CRAWL_WAIT_MS / 60_000} minutes, so kururu cancelled it; these are the pages it had.` : ".") +
      (state.status === "failed" ? " Firecrawl says the crawl failed." : "");
    const parts: string[] = [];
    let size = head.length;
    let shown = 0;
    for (const page of pages) {
      const part = renderPage(page, call.maxCharsPerPage, "scrape_page this one alone for the rest");
      if (size + part.length > RESULT_MAX_CHARS) break;
      parts.push(part);
      size += part.length + 2;
      shown++;
    }
    const rest = pages.slice(shown).map((p) => `- ${p.url}`);
    const tail = rest.length ? `\n\n[${rest.length} more pages not shown, to keep this result small; scrape_page the ones you need:]\n${rest.join("\n")}` : "";
    return { text: `${head}\n\n${parts.join("\n\n")}${tail}`, credits: state.credits ?? pages.length, sent: true, error: null };
  }

  private async map(key: string, call: MapCall): Promise<Ran> {
    const asked = await ask(key, "POST", "/map", requestBody(call, this.settings));
    if (!asked.ok) return { text: "", credits: 0, sent: true, error: asked.error };
    const links = mapFrom(asked.body);
    if (!links) return { text: "", credits: 1, sent: true, error: "Firecrawl's list of links was not in a shape kururu knows." };
    const head = `${links.length} ${links.length === 1 ? "URL" : "URLs"} on ${call.url}${call.search ? ` matching "${call.search}"` : ""}:`;
    return { text: `${head}\n${renderMap(links, RESULT_MAX_CHARS)}`, credits: 1, sent: true, error: null };
  }

  private async search(key: string, call: SearchCall): Promise<Ran> {
    const asked = await ask(key, "POST", "/search", requestBody(call, this.settings));
    if (!asked.ok) return { text: "", credits: 0, sent: true, error: asked.error };
    const found = searchFrom(asked.body);
    if (!found) return { text: "", credits: estimate(call), sent: true, error: "Firecrawl's search results were not in a shape kururu knows." };
    const body = clip(renderHits(found.hits, call.maxCharsPerResult), RESULT_MAX_CHARS);
    const tail = body.cut ? `\n[… ${body.cut.toLocaleString("en-US")} more characters cut by kururu]` : "";
    return { text: `${found.hits.length} results for "${call.query}":\n\n${body.text}${tail}`, credits: found.credits ?? estimate(call), sent: true, error: null };
  }

  /**
   * Write a call down: the day's count, the recent list, the file, the windows.
   *
   * A refusal that repeats the last one — same tool, page, agent and reason —
   * is a count on that row rather than a row of its own, and reaches the disk
   * and the windows once a second at most. That is an agent in a loop against
   * the budget, which is the case the budget is for: a real Claude Code with
   * a stuck tool loop made eleven hundred calls in twenty seconds, and a
   * broadcast per call would have been the window's problem too.
   */
  private record(tool: WebToolName, target: string, credits: number, sent: boolean, error: string | null, agent: string | null): void {
    const today = todayOf(this.day);
    this.day = { day: today.day, credits: today.credits + credits, calls: today.calls + (sent ? 1 : 0) };
    const row: FirecrawlCall = { at: Date.now(), tool, target: target.slice(0, 300), credits, ok: error === null, error, agent };
    const head = this.recent[0];
    if (!sent && head && !head.ok && head.credits === 0 && head.tool === row.tool && head.target === row.target && head.agent === agent && head.error === error) {
      this.recent = [{ ...head, at: row.at, times: (head.times ?? 1) + 1 }, ...this.recent.slice(1)];
      if (!this.flush) {
        this.flush = setTimeout(() => {
          this.flush = null;
          writeUsage({ day: this.day, recent: this.recent });
          this.changed();
        }, REPEAT_FLUSH_MS);
        this.flush.unref();
      }
      return;
    }
    this.recent = [row, ...this.recent].slice(0, RECENT_MAX);
    writeUsage({ day: this.day, recent: this.recent });
    this.changed();
    if (sent) this.pollSoon();
  }
}
