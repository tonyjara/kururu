/**
 * Firecrawl on a server of our own: free to call, so first in the order.
 *
 * Ours runs on a Linux box on the tailnet (`docs/web.md` has the shape of
 * the deployment): the API, its workers, a Playwright
 * browser and SearXNG for search, behind an nginx gate that wants a bearer
 * key, on the Tailscale address only. Nothing here assumes that box — the
 * address and the key are Settings fields — but the key is not optional in
 * spirit: a self-hosted Firecrawl has no authentication of its own, and
 * anything on the tailnet could otherwise spend its browser.
 *
 * The key is kept on the OpenRouter key's terms, in `web-firecrawl-self.json`
 * beside the address, and goes only in the header of a request under that
 * address. The pages it fetches are fetched from that server's own internet
 * connection, so what leaves is the URL, to our box, and from there the
 * request a browser would make.
 *
 * What it cannot do, measured on 2026-10-15: a Cloudflare challenge page
 * (its Playwright gets the 403, and the stealth proxy Firecrawl wants for it
 * is a cloud feature). The chain reads that as `blocked` and moves on.
 */
import { firecrawlHint, selfHostedApi, validFirecrawlKey } from "../../../../shared/firecrawl";
import type { WebCall, WebCapability, WebHealth } from "../../../../shared/web";
import { readConfigFile, removeConfigFile, writeConfigFile } from "../../config";
import { FirecrawlClient, firecrawlTimeout } from "../firecrawlapi";
import { providerFile, registerWebProvider, type ProviderDeps, type ProviderView, type RunContext, type StepAnswer, type WebProvider } from "../provider";

const ID = "firecrawl-self";
const FILE = providerFile(ID);
const LABEL = "Self-hosted Firecrawl";
const CAN: readonly WebCapability[] = ["scrape", "search", "map", "crawl"];
/** A page on a box at home, with Playwright's own fifteen-second load and a retry inside it. */
const SCRAPE_MS = 60_000;
const HEALTH_MS = 8_000;
const TEST_URL = "https://example.com/";

interface Stored {
  endpoint: string | null;
  apiKey: string | null;
}

function stored(): Stored {
  const raw = readConfigFile(FILE) as Record<string, unknown> | null;
  return {
    endpoint: raw && selfHostedApi(raw.endpoint) ? (raw.endpoint as string) : null,
    apiKey: raw && validFirecrawlKey(raw.apiKey) ? (raw.apiKey as string) : null,
  };
}

function save(next: Stored): void {
  writeConfigFile(FILE, next, 0o600);
}

/** The server's root, where Firecrawl's health checks live, from the API base under it. */
function rootOf(api: string): string {
  return api.replace(/\/v2$/, "");
}

class SelfHostedFirecrawl implements WebProvider {
  readonly id = ID;
  readonly label = LABEL;
  readonly kind = "service" as const;
  readonly paid = false;

  constructor(private readonly deps: ProviderDeps) {}

  defaultEnabled(): boolean {
    return true;
  }

  can(): readonly WebCapability[] {
    return CAN;
  }

  ready(): boolean {
    return stored().endpoint !== null;
  }

  timeoutMs(call: WebCall): number {
    return firecrawlTimeout(call, SCRAPE_MS);
  }

  /** A client with the address and key as they are on the disk this moment. */
  private client(): FirecrawlClient | null {
    const s = stored();
    const api = selfHostedApi(s.endpoint);
    return api ? new FirecrawlClient(api, s.apiKey, LABEL) : null;
  }

  async run(call: WebCall, ctx: RunContext): Promise<StepAnswer> {
    const client = this.client();
    if (!client) return { outcome: "failed", failure: "refused", reason: "no address is set in Settings → Web" };
    return client.run(call, { pageLimit: ctx.pageLimit }, ctx.signal, false);
  }

  /**
   * Firecrawl's readiness check, through the gate with the key: free, and it
   * says three things at once — the box answers, the gate takes the key, the
   * API behind it is up.
   */
  async health(): Promise<WebHealth> {
    const s = stored();
    const api = selfHostedApi(s.endpoint);
    if (!api) return { state: "unknown", detail: "No address set.", at: Date.now() };
    const said = await this.readiness(rootOf(api), s.apiKey);
    return { state: said.ok ? "ok" : "bad", detail: said.text, at: Date.now() };
  }

  private async readiness(root: string, key: string | null): Promise<{ ok: boolean; text: string; status: number | null }> {
    try {
      const res = await fetch(`${root}/v0/health/readiness`, {
        headers: key ? { authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(HEALTH_MS),
      });
      if (res.ok) return { ok: true, text: `Ready at ${new URL(root).host}.`, status: res.status };
      if (res.status === 401) return { ok: false, text: key ? "It refuses the key." : "It wants a key.", status: 401 };
      return { ok: false, text: `It answered ${res.status}.`, status: res.status };
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      return { ok: false, text: timedOut ? `No answer in ${HEALTH_MS / 1000} s.` : `Could not reach ${new URL(root).host}.`, status: null };
    }
  }

  async setField(name: string, value: unknown): Promise<void> {
    const s = stored();
    if (name === "endpoint") {
      const text = typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
      if (!selfHostedApi(text)) throw new Error("An http(s) address, like http://100.101.102.103:3002 — no login, query or path but /v2.");
      save({ ...s, endpoint: text });
      return;
    }
    if (name === "key") {
      const key = typeof value === "string" ? value.trim() : value;
      if (!validFirecrawlKey(key)) throw new Error("That does not look like a key: letters, digits, dots, dashes and underscores, 8 to 256 of them.");
      const api = selfHostedApi(s.endpoint);
      if (!api) throw new Error("Set the address first, so the key can be tried against it.");
      // Tried before it is kept, against the free readiness check behind the gate.
      const said = await this.readiness(rootOf(api), key);
      if (said.status === 401) throw new Error("The server refuses this key.");
      if (!said.ok) throw new Error(`${said.text} The key was not saved; try again when it answers.`);
      save({ ...s, apiKey: key });
      return;
    }
    throw new Error(`${LABEL} has no setting called ${name}.`);
  }

  clearField(name: string): void {
    const s = stored();
    const next = name === "key" ? { ...s, apiKey: null } : name === "endpoint" ? { endpoint: null, apiKey: null } : s;
    if (!next.endpoint && !next.apiKey) removeConfigFile(FILE);
    else save(next);
  }

  async test(): Promise<string> {
    const client = this.client();
    if (!client) throw new Error("Set the address first.");
    const started = Date.now();
    const answer = await client.run(
      { tool: "scrape_page", url: TEST_URL, links: false, mainOnly: true, waitMs: 0, fresh: true, maxChars: 1000, ownToolsFailed: false },
      { pageLimit: this.deps.pageLimit() },
      AbortSignal.timeout(SCRAPE_MS),
      false,
    );
    if (answer.outcome !== "served" || answer.result.tool !== "scrape_page") throw new Error(answer.outcome === "failed" ? answer.reason : "No page came back.");
    const page = answer.result.page;
    if (!page.markdown.trim()) throw new Error("It answered, but no text came back for the test page.");
    return `It works: fetched “${page.title ?? "example.com"}”, ${page.markdown.length.toLocaleString("en-US")} characters, in ${((Date.now() - started) / 1000).toFixed(1)} s.`;
  }

  view(): ProviderView {
    const s = stored();
    return {
      summary: "Firecrawl on a server of your own: free, so it goes first. Pages are fetched from that server's connection.",
      fields: [
        {
          name: "endpoint",
          kind: "url",
          label: "Address",
          hint: "Where its API answers. Over the tailnet, http is fine.",
          placeholder: "http://100.101.102.103:3002",
          value: s.endpoint,
        },
        {
          name: "key",
          kind: "secret",
          label: "Key",
          hint: `What its gate expects as a bearer token. Kept in ~/.config/kururu/${FILE}, never sent back, never backed up.`,
          placeholder: "fcs-…",
          held: s.apiKey ? firecrawlHint(s.apiKey) : null,
        },
      ],
      readouts: [],
      about: [
        "A Firecrawl you run yourself — on a box on your tailnet, say — with SearXNG behind its search. It renders pages in its own Playwright browser and searches through SearXNG, so a call costs nothing but that box's time. docs/web.md has how it is deployed.",
        "What leaves this Mac: the URL or the search words, to that server over the tailnet. The server then fetches the page from the internet, from its own address. It cannot get past a Cloudflare challenge (the stealth proxy that needs is a cloud feature); the chain sees that and moves on.",
      ],
      links: [{ label: "Self-hosting guide", href: "https://docs.firecrawl.dev/contributing/self-host" }],
      test: "Fetches example.com through it. Free.",
    };
  }
}

registerWebProvider({ id: ID, rank: 10, create: (deps) => new SelfHostedFirecrawl(deps) });
