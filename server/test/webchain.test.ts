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
import { WebChain, freeBeforePaid, type ChainStore, type McpStream } from "../src/web/chain";
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
  healthy = true;
  async health(): Promise<WebHealth> {
    if (!this.healthy) throw new Error("no route to host");
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

describe("free before paid", () => {
  const svc = (id: string, paid: boolean) => ({ id, kind: "service", paid });
  const back = { id: "back", kind: "handback", paid: false };
  const ids = (list: { id: string }[]) => list.map((p) => p.id);

  it("moves a paid provider behind every free one that came after it, and leaves a right order alone", () => {
    expect(ids(freeBeforePaid([back, svc("cloud", true), svc("self", false)]))).toEqual(["back", "self", "cloud"]);
    expect(ids(freeBeforePaid([svc("p1", true), svc("f1", false), svc("p2", true), svc("f2", false)]))).toEqual(["f1", "f2", "p1", "p2"]);
    expect(ids(freeBeforePaid([svc("cloud", true), back, svc("self", false)]))).toEqual(["back", "self", "cloud"]);
    const right = [back, svc("self", false), svc("cloud", true)];
    expect(ids(freeBeforePaid(right))).toEqual(ids(right));
  });

  it("tries the free one first even when Settings has the paid one above it, and says so everywhere", async () => {
    const self = new Fake("self", "page");
    const cloud = new Fake("cloud", "page", true);
    // The order the user's web.json held on 2026-10-28.
    const { chain } = chainOf([self, handBack(), cloud], { order: ["agent-tools", "cloud", "self"] });
    const answer = await chain.run(scrape({ ownToolsFailed: true }));
    expect(answer.served?.provider).toBe("self");
    expect(cloud.calls).toBe(0);
    expect(chain.routes().routes.scrape_page.after.map((p) => p.label)).toEqual(["Fake self", "Fake cloud"]);
    expect(chain.status().providers.map((p) => p.id)).toEqual(["agent-tools", "self", "cloud"]);
  });
});

describe("a provider that was down at the start", () => {
  it("is described and tried all the same, and is tried again once its rest is over", async () => {
    const now = 1_000_000;
    const self = new Fake("self", "unreachable");
    self.healthy = false;
    const cloud = new Fake("cloud", "page", true);
    const { chain } = chainOf([handBack(), self, cloud], null, () => now);
    await chain.checkHealth("self");
    expect(chain.status().providers.find((p) => p.id === "self")?.health.state).toBe("bad");
    // The health check failing changes nothing an agent is told.
    expect(chain.instructions()).toContain("Fake self (free) and Fake cloud (paid");

    const first = await chain.run(scrape({ ownToolsFailed: true }));
    expect(first.served?.provider).toBe("cloud");
    expect(first.steps.find((s) => s.provider === "self")?.failure).toBe("unreachable");

    // The box comes back: a health check that answers ends the rest at once.
    self.behaviour = "page";
    self.healthy = true;
    await chain.checkHealth("self");
    const back = await chain.run(scrape({ ownToolsFailed: true }));
    expect(back.served?.provider).toBe("self");
    expect(cloud.calls).toBe(1);
  });

  it("is tried again after the rest even with no health check in between", async () => {
    let now = 1_000_000;
    const self = new Fake("self", "unreachable");
    const cloud = new Fake("cloud", "page", true);
    const { chain } = chainOf([self, cloud], null, () => now);
    await chain.run(scrape());
    self.behaviour = "page";
    expect((await chain.run(scrape())).served?.provider).toBe("cloud");
    now += 31_000;
    expect((await chain.run(scrape())).served?.provider).toBe("self");
  });
});

describe("keeping what agents were told current", () => {
  const stream = () => {
    const s: McpStream & { written: string[]; ended: boolean } = { written: [], ended: false, write: (chunk: string) => s.written.push(chunk), end: () => (s.ended = true) };
    return s;
  };

  it("tells an open stream the tools changed when a provider is set up, and refuses the session from before", () => {
    // The Deck's address saved after Kuru connected: not ready, then ready.
    const self = new Fake("self", "page", false, undefined, false);
    const { chain } = chainOf([handBack(), self, new Fake("cloud", "page", true)]);
    expect(chain.instructions()).not.toContain("Fake self");
    const session = chain.session();
    expect(chain.sessionCurrent(session)).toBe(true);
    const open = stream();
    chain.openStream(open, session);

    chain.noticeRoutes();
    expect(open.written.some((w) => w.includes("list_changed"))).toBe(false);

    self.isReady = true;
    chain.noticeRoutes();
    expect(open.written.filter((w) => w.includes('"notifications/tools/list_changed"'))).toHaveLength(1);
    expect(chain.sessionCurrent(session)).toBe(false);
    const again = chain.session();
    expect(chain.sessionCurrent(again)).toBe(true);
    expect(chain.instructions()).toContain("Fake self (free) and Fake cloud (paid");
    expect(chain.tools().find((t) => t.name === "scrape_page")?.description).toContain("Fake self (free) and Fake cloud");
  });

  it("notices a change made through Settings at once, and answers a client with no session as it always did", () => {
    const { chain } = chainOf([handBack(), new Fake("self", "page"), new Fake("cloud", "page", true)]);
    const open = stream();
    const close = chain.openStream(open, chain.session());
    chain.setEnabled("self", false);
    expect(open.written.filter((w) => w.includes("list_changed"))).toHaveLength(1);
    expect(chain.sessionCurrent(null)).toBe(true);
    close();
    chain.setEnabled("self", true);
    expect(open.written.filter((w) => w.includes("list_changed"))).toHaveLength(1);
  });

  it("takes a session issued before a restart onto the same settings as its own", () => {
    const make = () => chainOf([handBack(), new Fake("self", "page"), new Fake("cloud", "page", true)]).chain;
    expect(make().sessionCurrent(make().session())).toBe(true);
  });
});
