/**
 * That the chain goes in the order Settings gives, passes over what is off,
 * not set up or resting, moves on from an error, a timeout or a page that
 * is a wall, stops at the hand-back, and reaches the paid provider behind it
 * only when the agent says its own tools failed.
 *
 * The providers are fakes that count their calls, except the hand-back,
 * which is the real one off the registry: its rule is the one under test.
 */
import { describe, expect, it } from "bun:test";

import type { WebCall, WebCallRecord, WebCapability, WebHealth, WebPage, WebSettings } from "../../shared/web";
import { webCall } from "../../shared/web";
import { WebChain, type ChainStore } from "../src/web/chain";
import { webProviderDefs, type ProviderView, type RunContext, type StepAnswer, type WebProvider } from "../src/web/provider";
import "../src/web/providers/handback";

const PAGE: WebPage = { url: "https://e.example/", title: "E", status: 200, markdown: "The page itself, with words enough to count as one.", links: [], pdfPages: null };
const WALL: WebPage = { url: "https://e.example/", title: "Just a moment...", status: 403, markdown: "Checking your browser before accessing e.example.", links: [], pdfPages: null };

type Behaviour = "page" | "wall" | "error" | "unreachable" | "hang" | "empty";

class Fake implements WebProvider {
  readonly kind = "service" as const;
  calls = 0;
  lastCtx: RunContext | null = null;
  constructor(
    readonly id: string,
    public behaviour: Behaviour,
    readonly paid = false,
    private readonly caps: WebCapability[] = ["scrape", "search", "map", "crawl"],
    public isReady = true,
  ) {}
  get label() {
    return `Fake ${this.id}`;
  }
  defaultEnabled() {
    return true;
  }
  can() {
    return this.caps;
  }
  ready() {
    return this.isReady;
  }
  timeoutMs() {
    return 60;
  }
  async run(_call: WebCall, ctx: RunContext): Promise<StepAnswer> {
    this.calls++;
    this.lastCtx = ctx;
    switch (this.behaviour) {
      case "page":
        return { outcome: "served", result: { tool: "scrape_page", page: PAGE }, credits: this.paid ? 1 : 0 };
      case "wall":
        return { outcome: "served", result: { tool: "scrape_page", page: WALL }, credits: this.paid ? 1 : 0 };
      case "empty":
        return { outcome: "served", result: { tool: "search_web", query: "q", hits: [] } };
      case "error":
        return { outcome: "failed", failure: "error", reason: "it broke" };
      case "unreachable":
        return { outcome: "failed", failure: "unreachable", reason: "no route" };
      case "hang":
        return new Promise<StepAnswer>(() => undefined);
    }
  }
  async health(): Promise<WebHealth> {
    return { state: "ok", detail: null, at: 0 };
  }
  view(): ProviderView {
    return { summary: "", fields: [], readouts: [], about: [], links: [], test: null };
  }
}

function memoryStore(settings: Partial<WebSettings> | null = null): ChainStore & { recent: WebCallRecord[] } {
  let saved: unknown = settings;
  const store = {
    recent: [] as WebCallRecord[],
    readSettings: () => saved,
    writeSettings: (s: WebSettings) => {
      saved = s;
    },
    readRecent: () => [],
    writeRecent: (r: WebCallRecord[]) => {
      store.recent = r;
    },
  };
  return store;
}

const handBack = () =>
  webProviderDefs()
    .find((d) => d.id === "agent-tools")!
    .create({ changed: () => undefined, clients: () => 0, pageLimit: () => 25 });

function chainOf(providers: WebProvider[], settings: Partial<WebSettings> | null = null, now?: () => number) {
  const store = memoryStore(settings);
  const chain = new WebChain(providers, { store, changed: () => undefined, clients: () => 0, port: () => 7717, now });
  return { chain, store };
}

function scrape(args: Record<string, unknown> = {}): WebCall {
  const checked = webCall("scrape_page", { url: "https://e.example", ...args }, { pageLimit: 25 });
  if (!checked.ok) throw new Error(checked.error);
  return checked.value;
}

describe("the order", () => {
  it("asks the first provider first, and the one it answers is the one that served", async () => {
    const a = new Fake("a", "page");
    const b = new Fake("b", "page");
    const { chain } = chainOf([a, b]);
    const answer = await chain.run(scrape());
    expect(answer.served?.provider).toBe("a");
    expect([a.calls, b.calls]).toEqual([1, 0]);
  });

  it("follows the order Settings gives, not the order they were registered in", async () => {
    const a = new Fake("a", "page");
    const b = new Fake("b", "page");
    const { chain } = chainOf([a, b]);
    chain.setOrder(["b", "a"]);
    expect((await chain.run(scrape())).served?.provider).toBe("b");
    expect(a.calls).toBe(0);
  });

  it("passes over a provider that is switched off, one that is not set up, and one that cannot do the call", async () => {
    const off = new Fake("off", "page");
    const unset = new Fake("unset", "page", false, undefined, false);
    const cannot = new Fake("cannot", "page", false, ["search"]);
    const last = new Fake("last", "page");
    const { chain } = chainOf([off, unset, cannot, last]);
    chain.setEnabled("off", false);
    const answer = await chain.run(scrape());
    expect(answer.served?.provider).toBe("last");
    expect(off.calls + unset.calls + cannot.calls).toBe(0);
    expect(answer.steps.map((s) => [s.provider, s.outcome, s.reason])).toEqual([
      ["off", "skipped", "switched off in Settings"],
      ["unset", "skipped", "not set up in Settings → Web"],
      ["cannot", "skipped", "it cannot scrape"],
      ["last", "served", null],
    ]);
  });
});

describe("failing over", () => {
  it("moves on from an error", async () => {
    const a = new Fake("a", "error");
    const b = new Fake("b", "page");
    const answer = await chainOf([a, b]).chain.run(scrape());
    expect(answer.served?.provider).toBe("b");
    expect(answer.steps[0]).toMatchObject({ provider: "a", outcome: "failed", failure: "error", reason: "it broke" });
  });

  it("stops waiting on a provider that does not answer in its time, and aborts it", async () => {
    const a = new Fake("a", "hang");
    const b = new Fake("b", "page");
    const answer = await chainOf([a, b]).chain.run(scrape());
    expect(answer.served?.provider).toBe("b");
    expect(answer.steps[0]).toMatchObject({ provider: "a", outcome: "failed", failure: "timeout" });
    expect(a.lastCtx?.signal.aborted).toBe(true);
  });

  it("moves on from a page that is a Cloudflare challenge, and from no results", async () => {
    const a = new Fake("a", "wall");
    const b = new Fake("b", "page");
    const answer = await chainOf([a, b]).chain.run(scrape());
    expect(answer.served?.provider).toBe("b");
    expect(answer.steps[0]).toMatchObject({ provider: "a", outcome: "failed", failure: "challenge" });

    const empty = new Fake("empty", "empty");
    const search = webCall("search_web", { query: "q" }, { pageLimit: 25 });
    if (!search.ok) throw new Error(search.error);
    const none = await chainOf([empty]).chain.run(search.value);
    expect(none.served).toBeNull();
    expect(none.steps[0]).toMatchObject({ outcome: "failed", failure: "empty" });
  });

  it("leaves an unreachable provider alone for a while, then tries it again", async () => {
    let now = 1_000_000;
    const a = new Fake("a", "unreachable");
    const b = new Fake("b", "page");
    const { chain } = chainOf([a, b], null, () => now);
    await chain.run(scrape());
    const second = await chain.run(scrape());
    expect(a.calls).toBe(1);
    expect(second.steps[0]).toMatchObject({ provider: "a", outcome: "skipped" });
    expect(second.steps[0]!.reason).toMatch(/could not be reached/);
    now += 31_000;
    await chain.run(scrape());
    expect(a.calls).toBe(2);
  });
});

describe("the hand-back and the opt-in", () => {
  const setup = () => {
    const self = new Fake("self", "wall");
    const cloud = new Fake("cloud", "page", true);
    const { chain, store } = chainOf([self, handBack(), cloud]);
    return { self, cloud, chain, store };
  };

  it("stops at the hand-back when ours fails, and never reaches the paid provider", async () => {
    const { self, cloud, chain } = setup();
    const answer = await chain.run(scrape());
    expect(answer.served).toBeNull();
    expect(answer.stopped?.provider).toBe("agent-tools");
    expect([self.calls, cloud.calls]).toEqual([1, 0]);
    expect(answer.stopped?.text).toContain("Fake self failed (challenge");
    expect(answer.stopped?.text).toContain("Use your own web fetch for it now.");
    expect(answer.stopped?.text).toContain("ownToolsFailed: true; that goes on to Fake cloud, which costs the user credits");
  });

  it("goes past it to the paid provider when the agent says its own tools failed", async () => {
    const { cloud, chain } = setup();
    const answer = await chain.run(scrape({ ownToolsFailed: true }));
    expect(answer.served?.provider).toBe("cloud");
    expect(cloud.calls).toBe(1);
    expect(answer.steps.map((s) => s.outcome)).toEqual(["failed", "passed", "served"]);
    expect(answer.credits).toBe(1);
  });

  it("is an ordinary step: switched off, what is after it is tried at once", async () => {
    const { cloud, chain } = setup();
    chain.setEnabled("agent-tools", false);
    expect((await chain.run(scrape())).served?.provider).toBe("cloud");
    expect(cloud.calls).toBe(1);
  });

  it("tells the agent there is nothing further when nothing is after it", async () => {
    const self = new Fake("self", "error");
    const { chain } = chainOf([self, handBack()]);
    const answer = await chain.run(scrape());
    expect(answer.stopped?.text).toContain("kururu has nothing further to try");
  });

  it("answers the MCP call with who served it, and the hand-back as an error the agent reads", async () => {
    const { chain, store } = setup();
    const back = await chain.call("scrape_page", { url: "https://e.example" }, "claude in kururu");
    expect(back.isError).toBe(true);
    expect(back.text).toContain("Use your own web fetch");
    const served = await chain.call("scrape_page", { url: "https://e.example", ownToolsFailed: true }, "claude in kururu");
    expect(served.isError).toBeUndefined();
    expect(served.text).toContain("Served by Fake cloud. Before it: Fake self failed (challenge");
    expect(served.text).toContain("<web_page");
    expect(store.recent.map((r) => [r.outcome, r.served, r.agent])).toEqual([
      ["served", "Fake cloud", "claude in kururu"],
      ["handed-back", null, "claude in kururu"],
    ]);
  });
});

describe("what the descriptions are written from", () => {
  it("is the chain as it stands: ours first, the hand-back, the paid one after", () => {
    const { chain } = chainOf([new Fake("self", "page"), handBack(), new Fake("cloud", "page", true)]);
    expect(chain.routes().routes.scrape_page).toEqual({
      first: [{ label: "Fake self", paid: false }],
      handback: true,
      after: [{ label: "Fake cloud", paid: true }],
    });
    expect(chain.active()).toBe(true);
  });

  it("is not active with only the hand-back on", () => {
    const cloud = new Fake("cloud", "page", true);
    const { chain } = chainOf([handBack(), cloud]);
    chain.setEnabled("cloud", false);
    expect(chain.active()).toBe(false);
  });

  it("writes every switch down on a first start, so a provider's default changing later cannot flip it", () => {
    const off = new Fake("off", "page");
    off.defaultEnabled = () => false;
    const { store } = chainOf([off, handBack()]);
    expect((store.readSettings() as WebSettings).enabled).toEqual({ off: false, "agent-tools": true });
  });
});
