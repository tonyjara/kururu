/**
 * Firecrawl's API, as two of kururu's web providers speak it: the cloud one
 * at firecrawl.dev, on the user's credits, and the one we host ourselves on
 * the Omarchy PC. What a call is, how an answer is judged and how it is
 * written for a model are `web.ts`'s and the same for every provider; this
 * is what is Firecrawl's own — its key, its credits, its request bodies and
 * the shapes it answers in.
 *
 * Firecrawl (firecrawl.dev) renders a page in a browser and hands back
 * markdown, which is the whole of what an agent wanted from a fetch. The key
 * stays in kururu and kururu does the fetching (`server/src/web/chain.ts`
 * has the argument); nothing here holds one.
 *
 * **Credits are the user's money, and an agent in a loop does not stop by
 * itself.** Firecrawl's own default limit on a crawl is ten thousand pages.
 * So the cloud provider has three guards and a fourth recommended: the
 * chain's page limit, the most pages one call may cost; a daily budget of
 * credits across every agent, reserved before a call and settled after it;
 * its switch; and Firecrawl's per-key spend limit, set in its dashboard,
 * because it is enforced on their side, where no bug in here can reach it.
 * The self-hosted one costs nothing and has only the page limit.
 *
 * Pure, in `shared/` beside `openrouter.ts` for that module's reason: the
 * parse and the arithmetic are the parts worth testing.
 */
import type { MapLink, SearchHit, WebCall, WebPage } from "./web";

/** The cloud provider's own setting: what it may spend in a day. The switch and the page limit are the chain's. */
export interface FirecrawlSettings {
  /** The most credits kururu spends in a day, every agent's calls together. */
  dailyCredits: number;
}

/**
 * Two hundred a day is a fifth of the free month, and on the cheapest paid
 * plan a little over its daily share: enough for a day of honest research,
 * and a ceiling on a day of a loop.
 */
export const FIRECRAWL_DEFAULTS: FirecrawlSettings = { dailyCredits: 200 };
export const DAILY_CREDITS_MIN = 5;
export const DAILY_CREDITS_MAX = 100_000;

/** The account, as Firecrawl's credit-usage endpoint states it. */
export interface FirecrawlAccount {
  /** Credits left in the team's balance, the plan's and any bought or given. */
  remaining: number;
  /** The plan's monthly allotment, without coupons or pay-as-you-go. Null when not stated. */
  plan: number | null;
  /** When the allotment renews, as Firecrawl wrote it (ISO 8601). */
  periodEnd: string | null;
  /** When it was read. */
  at: number;
}

/** What kururu has spent today, by the local calendar. */
export interface FirecrawlDay {
  /** `2026-10-12`. */
  day: string;
  credits: number;
  calls: number;
}

// ---------------------------------------------------------------------------
// The key and the settings
// ---------------------------------------------------------------------------

/**
 * A key worth putting in a header. Firecrawl's are `fc-` and hex today, and
 * a self-hosted one's is whatever its gate was given, so the check is the
 * header's rather than theirs, for `validOpenRouterKey`'s reason: a new
 * prefix next year should not lock anybody out, while a newline in a header
 * is a second header.
 */
export function validFirecrawlKey(key: unknown): key is string {
  return typeof key === "string" && key.length >= 8 && key.length <= 256 && /^[A-Za-z0-9_.-]+$/.test(key);
}

/** The prefix and the last four, the way Firecrawl's own key list shows one. */
export function firecrawlHint(key: string): string {
  const prefix = /^[a-z]{2,4}-/.exec(key)?.[0] ?? "";
  return `${prefix}…${key.slice(-4)}`;
}

function whole(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function adoptFirecrawlSettings(value: unknown): FirecrawlSettings {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return { dailyCredits: whole(raw.dailyCredits, DAILY_CREDITS_MIN, DAILY_CREDITS_MAX, FIRECRAWL_DEFAULTS.dailyCredits) };
}

/**
 * A self-hosted Firecrawl's address as typed into Settings — `http://100.96.133.4:3002`,
 * with or without the `/v2` — as the API base every request is made under,
 * or null. http is allowed because the tailnet is the encryption; a login in
 * the URL is not, because the key has a field of its own.
 */
export function selfHostedApi(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 300) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) return null;
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path.endsWith("/v2") ? path : `${path}/v2`}`;
}

// ---------------------------------------------------------------------------
// The budget
// ---------------------------------------------------------------------------

/** The local calendar day: the budget resets at the user's midnight, not UTC's. */
export function dayOf(now = Date.now()): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Today's figures: yesterday's record reads as nothing spent. */
export function todayOf(record: FirecrawlDay | null, now = Date.now()): FirecrawlDay {
  const day = dayOf(now);
  return record && record.day === day ? record : { day, credits: 0, calls: 0 };
}

/** Credits still to spend today, before whatever calls are in flight. */
export function budgetLeft(settings: FirecrawlSettings, record: FirecrawlDay | null, now = Date.now()): number {
  return Math.max(0, settings.dailyCredits - todayOf(record, now).credits);
}

/** A PDF met in a crawl is read this far; `scrape_page` it alone for the rest. */
export const CRAWL_PDF_PAGES = 2;

/**
 * What a call is reserved against the day's budget before it is made, from
 * Firecrawl's price list: a page a credit, a map a credit, a search two per
 * ten results and a credit for each one scraped. A scraped page is reserved
 * at one even though a PDF costs a credit a page — what it really cost is
 * settled afterwards, and reserving the page limit for every scrape would
 * stop a day's budget at eight pages.
 */
export function estimate(call: WebCall): number {
  switch (call.tool) {
    case "scrape_page":
    case "map_site":
      return 1;
    case "crawl_site":
      return call.limit;
    case "search_web":
      return Math.ceil(call.limit / 10) * 2 + (call.scrape ? call.limit : 0);
  }
}

/** The request body Firecrawl is sent for a call. Pure, for the test. */
export function requestBody(call: WebCall, limits: { pageLimit: number }): Record<string, unknown> {
  switch (call.tool) {
    case "scrape_page":
      return {
        url: call.url,
        formats: call.links ? ["markdown", "links"] : ["markdown"],
        onlyMainContent: call.mainOnly,
        ...(call.waitMs ? { waitFor: call.waitMs } : {}),
        ...(call.fresh ? { maxAge: 0 } : {}),
        parsers: [{ type: "pdf", maxPages: limits.pageLimit }],
      };
    case "crawl_site":
      return {
        url: call.url,
        limit: call.limit,
        ...(call.includePaths.length ? { includePaths: call.includePaths } : {}),
        ...(call.excludePaths.length ? { excludePaths: call.excludePaths } : {}),
        ...(call.maxDepth !== null ? { maxDiscoveryDepth: call.maxDepth } : {}),
        crawlEntireDomain: call.entireDomain,
        scrapeOptions: { formats: ["markdown"], onlyMainContent: true, parsers: [{ type: "pdf", maxPages: CRAWL_PDF_PAGES }] },
      };
    case "map_site":
      return {
        url: call.url,
        limit: call.limit,
        includeSubdomains: call.subdomains,
        ...(call.search ? { search: call.search } : {}),
      };
    case "search_web": {
      const tbs = call.recency ? { tbs: `qdr:${call.recency[0]}` } : {};
      return {
        query: call.query,
        limit: call.limit,
        ...(call.country ? { country: call.country } : {}),
        ...tbs,
        ...(call.scrape ? { scrapeOptions: { formats: ["markdown"], onlyMainContent: true } } : {}),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Firecrawl's answers
// ---------------------------------------------------------------------------

/** A count off the wire: finite and not negative, or nothing. */
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/**
 * `/team/credit-usage`'s `{ data: { remainingCredits, planCredits, billingPeriodEnd } }`,
 * or null. The remaining figure is the one that matters and the one required.
 */
export function accountFrom(body: unknown, at: number): FirecrawlAccount | null {
  const data = (body as { data?: Record<string, unknown> } | null)?.data;
  if (!data || typeof data !== "object") return null;
  const remaining = count(data.remainingCredits);
  if (remaining === null) return null;
  return { remaining, plan: count(data.planCredits), periodEnd: str(data.billingPeriodEnd), at };
}

/** One of Firecrawl's documents, or null if it is not one. */
export function pageFrom(doc: unknown, fallbackUrl: string): WebPage | null {
  if (!doc || typeof doc !== "object") return null;
  const d = doc as Record<string, unknown>;
  const meta = (d.metadata && typeof d.metadata === "object" ? d.metadata : {}) as Record<string, unknown>;
  const markdown = typeof d.markdown === "string" ? d.markdown : "";
  const links = Array.isArray(d.links) ? d.links.filter((l): l is string => typeof l === "string") : [];
  const contentType = str(meta.contentType) ?? "";
  return {
    url: str(meta.url) ?? str(meta.sourceURL) ?? fallbackUrl,
    title: str(meta.title),
    status: count(meta.statusCode),
    markdown,
    links,
    pdfPages: contentType.includes("pdf") ? count(meta.numPages) : null,
  };
}

/** What a scraped page cost: a credit, or a credit a PDF page. */
export function pageCredits(page: WebPage): number {
  return Math.max(1, page.pdfPages ?? 1);
}

export interface CrawlState {
  status: "scraping" | "completed" | "failed" | "cancelled" | "unknown";
  total: number | null;
  completed: number | null;
  credits: number | null;
  next: string | null;
  pages: WebPage[];
}

export function crawlFrom(body: unknown): CrawlState | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const known = ["scraping", "completed", "failed", "cancelled"] as const;
  const status = known.find((s) => s === b.status) ?? "unknown";
  const data = Array.isArray(b.data) ? b.data : [];
  return {
    status,
    total: count(b.total),
    completed: count(b.completed),
    credits: count(b.creditsUsed),
    next: str(b.next),
    pages: data.map((doc) => pageFrom(doc, "")).filter((p): p is WebPage => p !== null),
  };
}

export function crawlDone(state: CrawlState): boolean {
  return state.status === "completed" || state.status === "failed" || state.status === "cancelled";
}

/**
 * A crawl's `next` link, as a URL under our own API base, or null. Only its
 * path and query are taken, and only if the path is one of a crawl's pages
 * under that base: the key goes in the header of whatever this returns, and
 * a host out of a response body is not a thing to send a key to on trust.
 * Taking the path also mends the self-hosted case, where Firecrawl, behind
 * its gate, writes `next` with the address it thinks it has
 * (`http://localhost:3002/…`) rather than the one we reach it by.
 */
export function crawlNext(next: string | null, api: string): string | null {
  if (!next) return null;
  try {
    const url = new URL(next, api);
    const base = new URL(api);
    const prefix = `${base.pathname.replace(/\/+$/, "")}/crawl/`;
    return url.pathname.startsWith(prefix) ? `${base.origin}${url.pathname}${url.search}` : null;
  } catch {
    return null;
  }
}

/** `/map`'s `links`: objects now, strings in v1, either accepted. */
export function mapFrom(body: unknown): MapLink[] | null {
  const links = (body as { links?: unknown } | null)?.links;
  if (!Array.isArray(links)) return null;
  const out: MapLink[] = [];
  for (const link of links) {
    if (typeof link === "string") out.push({ url: link, title: null });
    else if (link && typeof link === "object" && typeof (link as { url?: unknown }).url === "string") {
      out.push({ url: (link as { url: string }).url, title: str((link as { title?: unknown }).title) });
    }
  }
  return out;
}

export function searchFrom(body: unknown): { hits: SearchHit[]; credits: number | null } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const data = b.data;
  // v2 groups results by source; v1 answered a bare list.
  const web = Array.isArray(data) ? data : data && typeof data === "object" ? (data as { web?: unknown }).web : null;
  if (!Array.isArray(web)) return null;
  const hits: SearchHit[] = [];
  for (const item of web) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const url = str(r.url);
    if (!url) continue;
    hits.push({ url, title: str(r.title), description: str(r.description), markdown: typeof r.markdown === "string" ? r.markdown : null });
  }
  return { hits, credits: count(b.creditsUsed) };
}

/**
 * Firecrawl's refusal as the sentence an agent and the Settings page read,
 * naming the provider it came from. Its own `error` text is added when it
 * gave one, cut short: it says which option was wrong, and it never holds
 * the key.
 */
export function refusal(status: number, body: unknown, label = "Firecrawl"): string {
  const said = str((body as { error?: unknown } | null)?.error)?.replace(/\s+/g, " ").slice(0, 200);
  const base =
    status === 401
      ? `${label} does not recognise the key in kururu's Settings → Web.`
      : status === 402
        ? `The ${label} account is out of credits, or this key reached the spend limit set on it in Firecrawl's dashboard.`
        : status === 403
          ? `${label} refused this request for this key.`
          : status === 408
            ? `The page did not finish loading in time on ${label}'s side.`
            : status === 429
              ? `${label} is rate-limiting these requests; try again in a minute.`
              : `${label} answered ${status}.`;
  return said ? `${base} (${said})` : base;
}

/** `1,204`, the way a credit count is read. */
export function formatCredits(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}
