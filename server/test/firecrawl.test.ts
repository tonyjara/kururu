/**
 * That a call to a Firecrawl — ours or the cloud's — cannot spend more than
 * it was allowed, cannot send the key anywhere it should not go, and reads
 * Firecrawl's answers as what they are.
 *
 * The shapes Firecrawl answers in are the documented v2 ones; the parse is
 * held to `openrouter.test.ts`'s rule — refuse, never repair — for the credit
 * figures, which a window draws as what is left.
 */
import { describe, expect, it } from "bun:test";

import {
  FIRECRAWL_DEFAULTS,
  accountFrom,
  adoptFirecrawlSettings,
  budgetLeft,
  crawlDone,
  crawlFrom,
  crawlNext,
  dayOf,
  estimate,
  firecrawlHint,
  mapFrom,
  pageCredits,
  pageFrom,
  refusal,
  requestBody,
  searchFrom,
  selfHostedApi,
  todayOf,
  validFirecrawlKey,
  type FirecrawlSettings,
} from "../../shared/firecrawl";
import { webCall } from "../../shared/web";

const S: FirecrawlSettings = { dailyCredits: 200 };
const L = { pageLimit: 25 };

describe("the key", () => {
  it("takes Firecrawl's keys and refuses anything that could break a header", () => {
    expect(validFirecrawlKey("fc-0123456789abcdef0123456789abcdef")).toBe(true);
    expect(validFirecrawlKey("fcs-0123456789abcdef0123456789abcdef0123456789abcdef")).toBe(true);
    expect(validFirecrawlKey("fc-abc\nx-evil: 1")).toBe(false);
    expect(validFirecrawlKey("fc-a b c d e f")).toBe(false);
    expect(validFirecrawlKey("short")).toBe(false);
    expect(validFirecrawlKey(42)).toBe(false);
  });

  it("is shown as its prefix and last four, never more", () => {
    expect(firecrawlHint("fc-0123456789abcdef0123456789abcdef")).toBe("fc-…cdef");
    expect(firecrawlHint("fcs-0123456789abcdef0123456789abcdef")).toBe("fcs-…cdef");
    expect(firecrawlHint("other-key-123456789")).toBe("…6789");
  });
});

describe("settings", () => {
  it("defaults what is missing and brings the budget into range", () => {
    expect(adoptFirecrawlSettings(null)).toEqual(FIRECRAWL_DEFAULTS);
    expect(adoptFirecrawlSettings({ enabled: false, pageLimit: 9999, dailyCredits: 1 })).toEqual({ dailyCredits: 5 });
    expect(adoptFirecrawlSettings({ dailyCredits: Number.NaN })).toEqual(FIRECRAWL_DEFAULTS);
    expect(adoptFirecrawlSettings({ dailyCredits: "300" })).toEqual(FIRECRAWL_DEFAULTS);
  });
});

describe("a self-hosted address", () => {
  it("is the API base under what was typed, /v2 or not", () => {
    expect(selfHostedApi("http://100.96.133.4:3002")).toBe("http://100.96.133.4:3002/v2");
    expect(selfHostedApi("http://100.96.133.4:3002/")).toBe("http://100.96.133.4:3002/v2");
    expect(selfHostedApi("https://fc.example.com/v2/")).toBe("https://fc.example.com/v2");
    expect(selfHostedApi("https://example.com/firecrawl")).toBe("https://example.com/firecrawl/v2");
  });

  it("refuses anything that is not a plain http(s) address", () => {
    for (const bad of ["", "100.96.133.4:3002", "ftp://x.example", "http://user:pw@x.example", "http://x.example/?a=1", "http://x.example/#h", 42, null]) {
      expect(selfHostedApi(bad)).toBeNull();
    }
  });
});

describe("the day's budget", () => {
  const noon = new Date(2026, 9, 12, 12, 0).getTime();
  it("counts today by the local calendar", () => {
    expect(dayOf(noon)).toBe("2026-10-12");
  });

  it("reads yesterday's spending as none", () => {
    const yesterday = { day: "2026-10-11", credits: 190, calls: 40 };
    expect(todayOf(yesterday, noon)).toEqual({ day: "2026-10-12", credits: 0, calls: 0 });
    expect(budgetLeft(S, yesterday, noon)).toBe(200);
  });

  it("is what is left of today's allowance, never below nothing", () => {
    expect(budgetLeft(S, { day: "2026-10-12", credits: 150, calls: 9 }, noon)).toBe(50);
    expect(budgetLeft(S, { day: "2026-10-12", credits: 250, calls: 9 }, noon)).toBe(0);
  });
});

describe("what a call is reserved at", () => {
  const call = (name: string, args: Record<string, unknown>) => {
    const checked = webCall(name, args, L);
    if (!checked.ok) throw new Error(checked.error);
    return checked.value;
  };
  it("follows Firecrawl's price list", () => {
    expect(estimate(call("scrape_page", { url: "example.com" }))).toBe(1);
    expect(estimate(call("map_site", { url: "example.com" }))).toBe(1);
    expect(estimate(call("crawl_site", { url: "example.com", limit: 12 }))).toBe(12);
    expect(estimate(call("search_web", { query: "x", limit: 5 }))).toBe(2);
    expect(estimate(call("search_web", { query: "x", limit: 11 }))).toBe(4);
    expect(estimate(call("search_web", { query: "x", limit: 5, scrape: true }))).toBe(7);
  });
});

describe("the request bodies", () => {
  const call = (name: string, args: Record<string, unknown>) => {
    const checked = webCall(name, args, L);
    if (!checked.ok) throw new Error(checked.error);
    return checked.value;
  };

  it("caps a PDF at the page limit and asks for markdown", () => {
    expect(requestBody(call("scrape_page", { url: "example.com", fresh: true, waitMs: 2000, links: true }), L)).toEqual({
      url: "https://example.com/",
      formats: ["markdown", "links"],
      onlyMainContent: true,
      waitFor: 2000,
      maxAge: 0,
      parsers: [{ type: "pdf", maxPages: 25 }],
    });
  });

  it("always sends a crawl its limit, so Firecrawl's ten thousand is never the default", () => {
    const body = requestBody(call("crawl_site", { url: "example.com", includePaths: ["^/p/"], maxDepth: 3 }), L);
    expect(body).toMatchObject({ limit: 10, includePaths: ["^/p/"], maxDiscoveryDepth: 3, crawlEntireDomain: false });
    expect(body).not.toHaveProperty("excludePaths");
  });

  it("spells recency the way Firecrawl's tbs does", () => {
    expect(requestBody(call("search_web", { query: "x", recency: "month" }), L)).toEqual({ query: "x", limit: 5, tbs: "qdr:m" });
  });
});

describe("Firecrawl's answers", () => {
  it("reads the credit figures, and refuses a shape without the remaining count", () => {
    const body = { success: true, data: { remainingCredits: 812, planCredits: 1000, billingPeriodStart: null, billingPeriodEnd: "2026-10-31T23:59:59Z" } };
    expect(accountFrom(body, 5)).toEqual({ remaining: 812, plan: 1000, periodEnd: "2026-10-31T23:59:59Z", at: 5 });
    expect(accountFrom({ data: { remainingCredits: "812" } }, 5)).toBeNull();
    expect(accountFrom({ data: { remainingCredits: Number.NaN } }, 5)).toBeNull();
    expect(accountFrom(null, 5)).toBeNull();
  });

  it("reads a scraped page, and charges a PDF by its pages", () => {
    const page = pageFrom(
      { markdown: "# Hi", links: ["https://a.example", 3], metadata: { title: "T", sourceURL: "https://x.example", url: "https://y.example", statusCode: 200, contentType: "text/html" } },
      "https://fallback.example",
    );
    expect(page).toEqual({ url: "https://y.example", title: "T", status: 200, markdown: "# Hi", links: ["https://a.example"], pdfPages: null });
    expect(pageCredits(page!)).toBe(1);
    const pdf = pageFrom({ markdown: "x", metadata: { contentType: "application/pdf", numPages: 7 } }, "https://f.example/a.pdf")!;
    expect(pdf.url).toBe("https://f.example/a.pdf");
    expect(pageCredits(pdf)).toBe(7);
  });

  it("reads a crawl's state and knows when it is over", () => {
    const state = crawlFrom({ status: "scraping", total: 9, completed: 3, creditsUsed: 3, next: "https://api.firecrawl.dev/v2/crawl/abc?skip=3", data: [{ markdown: "a", metadata: { url: "https://e.example/1" } }] })!;
    expect(state).toMatchObject({ status: "scraping", total: 9, completed: 3, credits: 3 });
    expect(state.pages).toHaveLength(1);
    expect(crawlDone(state)).toBe(false);
    expect(crawlDone(crawlFrom({ status: "cancelled" })!)).toBe(true);
    expect(crawlFrom({ status: "who knows" })!.status).toBe("unknown");
  });

  it("follows a next link by its path alone, under our own base", () => {
    const api = "https://api.firecrawl.dev/v2";
    expect(crawlNext("https://api.firecrawl.dev/v2/crawl/abc?skip=10", api)).toBe("https://api.firecrawl.dev/v2/crawl/abc?skip=10");
    // A host in a response body is never where the key goes: the path is taken and put under the base.
    expect(crawlNext("https://evil.example/v2/crawl/abc?skip=1", api)).toBe("https://api.firecrawl.dev/v2/crawl/abc?skip=1");
    expect(crawlNext("https://api.firecrawl.dev/v1/crawl/abc", api)).toBeNull();
    expect(crawlNext("https://api.firecrawl.dev/v2/team/credit-usage", api)).toBeNull();
    expect(crawlNext("https://api.firecrawl.dev/v2/crawl/../team/x", api)).toBeNull();
    expect(crawlNext(null, api)).toBeNull();
  });

  it("mends a self-hosted Firecrawl's next link, written with the address it thinks it has", () => {
    expect(crawlNext("http://localhost:3002/v2/crawl/abc-123?skip=10", "http://100.96.133.4:3002/v2")).toBe("http://100.96.133.4:3002/v2/crawl/abc-123?skip=10");
  });

  it("reads a map's links as objects or strings", () => {
    expect(mapFrom({ success: true, links: [{ url: "https://e.example/a", title: "A" }, "https://e.example/b", { nope: 1 }] })).toEqual([
      { url: "https://e.example/a", title: "A" },
      { url: "https://e.example/b", title: null },
    ]);
    expect(mapFrom({ links: "x" })).toBeNull();
  });

  it("reads v2 search results grouped by source, and v1's bare list", () => {
    const v2 = searchFrom({ success: true, creditsUsed: 2, data: { web: [{ url: "https://e.example", title: "E", description: "d" }, { title: "no url" }] } });
    expect(v2).toEqual({ hits: [{ url: "https://e.example", title: "E", description: "d", markdown: null }], credits: 2 });
    expect(searchFrom({ data: [{ url: "https://e.example" }] })!.hits).toHaveLength(1);
    expect(searchFrom({ data: { images: [] } })).toBeNull();
  });

  it("says what a refusal means, with Firecrawl's reason beside it", () => {
    expect(refusal(402, { error: "Insufficient credits" })).toContain("out of credits");
    expect(refusal(402, { error: "Insufficient credits" })).toContain("(Insufficient credits)");
    expect(refusal(401, null)).toContain("does not recognise the key in kururu's Settings → Web");
    expect(refusal(503, null)).toBe("Firecrawl answered 503.");
    expect(refusal(503, null, "Self-hosted Firecrawl")).toBe("Self-hosted Firecrawl answered 503.");
  });
});
