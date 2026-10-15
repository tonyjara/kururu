/**
 * Firecrawl's v2 API, spoken to whichever Firecrawl a provider points at:
 * the cloud one, or ours on the Omarchy PC. Two providers and one client,
 * because the API is the same and only the address, the key and what a call
 * costs differ — and those stay in the providers.
 *
 * The client is made per call with the key just read off the disk, and the
 * key goes in one place: the `Authorization` header of a request under the
 * base it was made with. A crawl's `next` links are followed by their path
 * alone, under that base (`crawlNext`), so nothing in a response body can
 * send the key anywhere else.
 *
 * It returns answers and failures the chain can read — `unreachable` for an
 * address that did not answer, `refused` for a key or a credit Firecrawl
 * would not take, `blocked` for a page every one of its engines failed on —
 * and judges nothing else: whether what came back was the page is the
 * chain's question (`resultVerdict`).
 */
import { CRAWL_WAIT_MS, type CrawlCall, type MapCall, type ScrapeCall, type SearchCall, type WebCall, type WebFailure } from "../../../shared/web";
import { crawlDone, crawlFrom, crawlNext, estimate, mapFrom, pageCredits, pageFrom, refusal, requestBody, searchFrom, type CrawlState } from "../../../shared/firecrawl";
import type { StepAnswer } from "./provider";

/** Firecrawl gives a page sixty seconds to load; this is that and a margin for the trip. */
export const ASK_MS = 90_000;
/** Between looks at a running crawl. Looking is free; Firecrawl bills pages, not polls. */
const CRAWL_POLL_MS = 2_000;

export type Asked = { ok: true; body: unknown } | { ok: false; status: number | null; error: string; failure: WebFailure };

/** What a Firecrawl failure is, to the chain. */
function failureOf(status: number, body: unknown): WebFailure {
  const code = (body as { code?: unknown } | null)?.code;
  if (code === "SCRAPE_ALL_ENGINES_FAILED") return "blocked";
  if (status === 401 || status === 402 || status === 403) return "refused";
  if (status === 408) return "timeout";
  return "error";
}

export class FirecrawlClient {
  constructor(
    private readonly api: string,
    private readonly key: string | null,
    /** The provider's name, for the sentences a refusal is written in. */
    private readonly label: string,
  ) {}

  /** One request under the base this client was made with, and nowhere else. */
  async ask(method: "GET" | "POST" | "DELETE", target: string, body?: unknown, timeoutMs = ASK_MS, signal?: AbortSignal): Promise<Asked> {
    const url = target.startsWith(`${this.api}/`) ? target : `${this.api}${target}`;
    const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
    try {
      const res = await fetch(url, {
        method,
        headers: {
          ...(this.key ? { authorization: `Bearer ${this.key}` } : {}),
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any(signals),
      });
      const parsed: unknown = await res.json().catch(() => null);
      // Firecrawl's own words for this run to a paragraph of possible causes; the agent needs one.
      if ((parsed as { code?: unknown } | null)?.code === "SCRAPE_ALL_ENGINES_FAILED") {
        return { ok: false, status: res.status, error: `every engine ${this.label} has failed on this page; the site most likely blocks automated access`, failure: "blocked" };
      }
      if (!res.ok) return { ok: false, status: res.status, error: refusal(res.status, parsed, this.label), failure: failureOf(res.status, parsed) };
      // Some failures come back 200 with `success: false` and the reason beside it.
      if (parsed && typeof parsed === "object" && (parsed as { success?: unknown }).success === false) {
        const said = (parsed as { error?: unknown }).error;
        return {
          ok: false,
          status: res.status,
          error: `${this.label} could not do it${typeof said === "string" ? `: ${said.slice(0, 200)}` : "."}`,
          failure: failureOf(res.status, parsed),
        };
      }
      return { ok: true, body: parsed };
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      return timedOut
        ? { ok: false, status: null, error: `${this.label} did not answer in time.`, failure: "timeout" }
        : { ok: false, status: null, error: `Could not reach ${this.label}.`, failure: "unreachable" };
    }
  }

  /** A call, done. `credits` is what a page costs on this Firecrawl — the cloud's price list, or nothing for ours. */
  async run(call: WebCall, limits: { pageLimit: number }, signal: AbortSignal, priced: boolean): Promise<StepAnswer> {
    switch (call.tool) {
      case "scrape_page":
        return this.scrape(call, limits, signal, priced);
      case "crawl_site":
        return this.crawl(call, limits, signal, priced);
      case "map_site":
        return this.map(call, limits, signal, priced);
      case "search_web":
        return this.search(call, limits, signal, priced);
    }
  }

  private failed(asked: Extract<Asked, { ok: false }>, credits = 0): StepAnswer {
    return { outcome: "failed", failure: asked.failure, reason: asked.error, credits };
  }

  private async scrape(call: ScrapeCall, limits: { pageLimit: number }, signal: AbortSignal, priced: boolean): Promise<StepAnswer> {
    const asked = await this.ask("POST", "/scrape", requestBody(call, limits), ASK_MS, signal);
    if (!asked.ok) return this.failed(asked);
    const page = pageFrom((asked.body as { data?: unknown } | null)?.data, call.url);
    if (!page) return { outcome: "failed", failure: "error", reason: `${this.label}'s answer was not in a shape kururu knows.`, credits: priced ? 1 : 0 };
    return { outcome: "served", result: { tool: "scrape_page", page }, credits: priced ? pageCredits(page) : 0 };
  }

  /**
   * Start a crawl, wait for it, and hand back what it fetched. A crawl still
   * running at `CRAWL_WAIT_MS` is cancelled rather than left to spend in the
   * background on a result nobody will collect — the agent's call has to
   * return before its CLI gives up on it — and so is one the chain stopped
   * waiting for.
   */
  private async crawl(call: CrawlCall, limits: { pageLimit: number }, signal: AbortSignal, priced: boolean): Promise<StepAnswer> {
    const started = await this.ask("POST", "/crawl", requestBody(call, limits), ASK_MS, signal);
    if (!started.ok) return this.failed(started);
    const id = (started.body as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(id)) {
      return { outcome: "failed", failure: "error", reason: `${this.label} did not say which crawl it started.` };
    }
    const cancel = () => void this.ask("DELETE", `/crawl/${id}`, undefined, 15_000);
    signal.addEventListener("abort", cancel, { once: true });
    const deadline = Date.now() + CRAWL_WAIT_MS;
    let state: CrawlState | null = null;
    let cancelled = false;
    try {
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, CRAWL_POLL_MS));
        if (signal.aborted) return { outcome: "failed", failure: "timeout", reason: "the crawl was cancelled when the chain stopped waiting", credits: priced ? (state?.credits ?? 0) : 0 };
        const asked = await this.ask("GET", `/crawl/${id}`, undefined, ASK_MS, signal);
        if (asked.ok) state = crawlFrom(asked.body) ?? state;
        else if (asked.status === 404 || asked.status === 401) break;
        if (state && crawlDone(state)) break;
        if (Date.now() > deadline) {
          await this.ask("DELETE", `/crawl/${id}`, undefined, 15_000);
          cancelled = true;
          const last = await this.ask("GET", `/crawl/${id}`);
          if (last.ok) state = crawlFrom(last.body) ?? state;
          break;
        }
      }
    } finally {
      signal.removeEventListener("abort", cancel);
    }
    if (!state) return { outcome: "failed", failure: "error", reason: `${this.label} did not say how the crawl went.`, credits: priced ? call.limit : 0 };

    // A finished crawl's pages come ten megabytes at a time; `next` is also
    // sent on a crawl that is not `completed`, so an empty page ends the walk.
    const pages = [...state.pages];
    let next = crawlNext(state.next, this.api);
    for (let hops = 0; next && pages.length < call.limit && hops < 10; hops++) {
      const more = await this.ask("GET", next, undefined, ASK_MS, signal);
      const page = more.ok ? crawlFrom(more.body) : null;
      if (!page || page.pages.length === 0) break;
      pages.push(...page.pages);
      next = crawlNext(page.next, this.api);
    }
    return {
      outcome: "served",
      result: { tool: "crawl_site", url: call.url, pages, cancelled, failed: state.status === "failed" },
      credits: priced ? (state.credits ?? pages.length) : 0,
    };
  }

  private async map(call: MapCall, limits: { pageLimit: number }, signal: AbortSignal, priced: boolean): Promise<StepAnswer> {
    const asked = await this.ask("POST", "/map", requestBody(call, limits), ASK_MS, signal);
    if (!asked.ok) return this.failed(asked);
    const links = mapFrom(asked.body);
    if (!links) return { outcome: "failed", failure: "error", reason: `${this.label}'s list of links was not in a shape kururu knows.`, credits: priced ? 1 : 0 };
    return { outcome: "served", result: { tool: "map_site", url: call.url, links }, credits: priced ? 1 : 0 };
  }

  private async search(call: SearchCall, limits: { pageLimit: number }, signal: AbortSignal, priced: boolean): Promise<StepAnswer> {
    const asked = await this.ask("POST", "/search", requestBody(call, limits), ASK_MS, signal);
    if (!asked.ok) return this.failed(asked);
    const found = searchFrom(asked.body);
    if (!found) return { outcome: "failed", failure: "error", reason: `${this.label}'s search results were not in a shape kururu knows.`, credits: priced ? estimate(call) : 0 };
    return { outcome: "served", result: { tool: "search_web", query: call.query, hits: found.hits }, credits: priced ? (found.credits ?? estimate(call)) : 0 };
  }
}

/** How long a call to a Firecrawl may take, by tool: a crawl waits its four minutes and a margin to cancel and collect. */
export function firecrawlTimeout(call: WebCall, scrapeMs: number): number {
  switch (call.tool) {
    case "crawl_site":
      return CRAWL_WAIT_MS + 30_000;
    case "scrape_page":
      return scrapeMs + call.waitMs;
    case "search_web":
      return call.scrape ? scrapeMs * 2 : 45_000;
    case "map_site":
      return scrapeMs;
  }
}
