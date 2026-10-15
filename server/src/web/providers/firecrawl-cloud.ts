/**
 * Firecrawl's own service at firecrawl.dev: the one that costs the user
 * money, so last in the order, behind the agent's own tools.
 *
 * It was kururu's whole web until the chain, and it keeps what it had: the
 * key, the daily budget, the account's figures. Its stealth proxy gets past
 * the Cloudflare challenges our own Firecrawl cannot, which is what it is
 * kept for.
 *
 * **The key is kept on the OpenRouter key's terms** (`openrouter.ts` has the
 * argument): `~/.config/kururu/firecrawl.json`, 0600 — its name from before
 * the chain, kept so nobody pastes it again — read off the disk at the
 * moment of each request and dropped with it, never logged, never sent to a
 * client, never in a pty's environment, and on `shared/backup.ts`'s list of
 * what stays behind. It goes in one place, the `Authorization` header of a
 * request to `api.firecrawl.dev`.
 *
 * **The budget is counted here, before Firecrawl is asked.** Each call
 * reserves what it is expected to cost against the day's allowance, so ten
 * agents calling at once cannot each see the same last credit; what it really
 * cost — Firecrawl's own `creditsUsed` where it says, a credit a page where it
 * does not — is written down when it returns. The count is kept in the state
 * directory, because this server restarts on every save under `bun run dev`
 * and a budget that reset on each one would be no budget.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DAILY_CREDITS_MAX,
  DAILY_CREDITS_MIN,
  accountFrom,
  adoptFirecrawlSettings,
  budgetLeft,
  estimate,
  firecrawlHint,
  formatCredits,
  todayOf,
  validFirecrawlKey,
  type FirecrawlAccount,
  type FirecrawlDay,
  type FirecrawlSettings,
} from "../../../../shared/firecrawl";
import type { WebCall, WebCapability, WebHealth, WebReadout } from "../../../../shared/web";
import { readConfigFile, writeConfigFile } from "../../config";
import { FirecrawlClient, firecrawlTimeout } from "../firecrawlapi";
import { registerWebProvider, type ProviderDeps, type ProviderView, type RunContext, type StepAnswer, type WebProvider } from "../provider";

const ID = "firecrawl-cloud";
const LABEL = "Cloud Firecrawl";
/** Its name from before the chain: the key a user already pasted is still there. */
const FILE = "firecrawl.json";
const USAGE_FILE = "firecrawl-usage.json";
const CAN: readonly WebCapability[] = ["scrape", "search", "map", "crawl"];
/**
 * Firecrawl's API — or, for an isolated instance's tests, a stand-in on this
 * Mac named by `KURURU_FIRECRAWL_API`. Loopback and nothing else, so the
 * variable can point the key at a fake and never at anybody's server.
 */
const API = /^http:\/\/127\.0\.0\.1:\d{2,5}\/v2$/.test(process.env.KURURU_FIRECRAWL_API ?? "")
  ? process.env.KURURU_FIRECRAWL_API!
  : "https://api.firecrawl.dev/v2";
const KEYS_PAGE = "firecrawl.dev/app/api-keys";
const SCRAPE_MS = 90_000;
/** The credit figures and a key being tried: one small GET, which should be quick or is not coming. */
const ACCOUNT_ASK_MS = 10_000;
/** How stale the credit figures may get while a window is open. */
const ACCOUNT_EVERY_MS = 5 * 60_000;
/** How long after a call the figures are read again, so a burst of calls is one read. */
const AFTER_CALL_MS = 5_000;
/** The test page: tiny, stable, and nobody's business. */
const TEST_URL = "https://example.com/";

function stateDir(): string {
  return process.env.KURURU_STATE_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "kururu");
}

interface Stored {
  apiKey?: unknown;
  /** `dailyCredits`, and from before the chain `enabled` and `pageLimit`, read once by `seed` and `defaultEnabled`. */
  settings?: Record<string, unknown>;
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

function readDay(): FirecrawlDay | null {
  try {
    const d = (JSON.parse(readFileSync(join(stateDir(), USAGE_FILE), "utf8")) as { day?: Record<string, unknown> | null }).day;
    return d && typeof d.day === "string" && Number.isFinite(d.credits) && Number.isFinite(d.calls) ? { day: d.day, credits: Number(d.credits), calls: Number(d.calls) } : null;
  } catch {
    return null;
  }
}

function writeDay(day: FirecrawlDay | null): void {
  const path = join(stateDir(), USAGE_FILE);
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(`${path}.tmp`, `${JSON.stringify({ day }, null, 2)}\n`, "utf8");
    renameSync(`${path}.tmp`, path);
  } catch {
    // The count is still right in memory; the next start is the one that forgets it.
  }
}

class CloudFirecrawl implements WebProvider {
  readonly id = ID;
  readonly label = LABEL;
  readonly kind = "service" as const;
  readonly paid = true;
  private settings: FirecrawlSettings;
  private account: FirecrawlAccount | null = null;
  private accountError: string | null = null;
  private day: FirecrawlDay | null;
  /** Credits promised to calls still in flight. */
  private reserved = 0;
  /** Bumped when the key changes hands, so a read that set off with the old key lands nowhere. */
  private generation = 0;
  private polling = false;
  private soon: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: ProviderDeps) {
    this.settings = adoptFirecrawlSettings(stored().settings);
    this.day = readDay();
  }

  close(): void {
    if (this.soon) clearTimeout(this.soon);
  }

  defaultEnabled(): boolean {
    // Its switch from before the chain, until the user sets one in Settings → Web.
    return stored().settings?.enabled !== false;
  }

  seed(): { pageLimit?: number } {
    const limit = stored().settings?.pageLimit;
    return typeof limit === "number" && Number.isFinite(limit) ? { pageLimit: limit } : {};
  }

  can(): readonly WebCapability[] {
    return CAN;
  }

  ready(): boolean {
    return storedKey() !== null;
  }

  timeoutMs(call: WebCall): number {
    return firecrawlTimeout(call, SCRAPE_MS);
  }

  private write(key: string | null): void {
    if (key) writeConfigFile(FILE, { apiKey: key, settings: this.settings }, 0o600);
    else writeConfigFile(FILE, { settings: this.settings }, 0o600);
  }

  // -------------------------------------------------------------------------
  // The account
  // -------------------------------------------------------------------------

  /** Read the credit figures. A failed read keeps the last figures and says why. */
  private async readAccount(): Promise<WebHealth> {
    const key = storedKey();
    if (!key) return { state: "unknown", detail: "No key.", at: Date.now() };
    const started = this.generation;
    const asked = await new FirecrawlClient(API, key, LABEL).ask("GET", "/team/credit-usage", undefined, ACCOUNT_ASK_MS);
    if (this.generation !== started) return { state: "unknown", detail: null, at: Date.now() };
    const before = JSON.stringify([this.account?.remaining, this.account?.plan, this.account?.periodEnd, this.accountError]);
    if (asked.ok) {
      const account = accountFrom(asked.body, Date.now());
      if (account) {
        this.account = account;
        this.accountError = null;
      } else this.accountError = "Firecrawl's credit figures were not in a shape kururu knows.";
    } else this.accountError = asked.error;
    if (JSON.stringify([this.account?.remaining, this.account?.plan, this.account?.periodEnd, this.accountError]) !== before) this.deps.changed();
    return this.accountError
      ? { state: "bad", detail: this.accountError, at: Date.now() }
      : { state: "ok", detail: `${formatCredits(this.account?.remaining ?? 0)} credits left.`, at: Date.now() };
  }

  /** The figures, while a window is open and they are stale. */
  async refresh(): Promise<void> {
    if (!storedKey() || this.polling || this.deps.clients() === 0) return;
    if (this.account && !this.accountError && Date.now() - this.account.at < ACCOUNT_EVERY_MS) return;
    this.polling = true;
    try {
      await this.readAccount();
    } finally {
      this.polling = false;
    }
  }

  /** Reading the figures is free, and it says whether the key works. */
  async health(): Promise<WebHealth> {
    return this.readAccount();
  }

  private readSoon(): void {
    if (this.soon) clearTimeout(this.soon);
    this.soon = setTimeout(() => {
      this.soon = null;
      void this.readAccount();
    }, AFTER_CALL_MS);
    this.soon.unref?.();
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  async setField(name: string, value: unknown): Promise<void> {
    if (name === "dailyCredits") {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("The daily budget is a number.");
      this.settings = adoptFirecrawlSettings({ dailyCredits: value });
      this.write(storedKey());
      return;
    }
    if (name !== "key") throw new Error(`${LABEL} has no setting called ${name}.`);
    const key = typeof value === "string" ? value.trim() : value;
    if (!validFirecrawlKey(key)) throw new Error("That does not look like a Firecrawl API key. They start with fc-.");
    // Tried on the credit figures — a GET that costs nothing — and kept only if Firecrawl knows it.
    const asked = await new FirecrawlClient(API, key, LABEL).ask("GET", "/team/credit-usage", undefined, ACCOUNT_ASK_MS);
    // A 404 is a key Firecrawl knows on a team it has no figures for yet: still a key.
    if (!asked.ok && asked.status !== 404) {
      throw new Error(asked.status === 401 ? `Firecrawl does not recognise this key. Copy it again from ${KEYS_PAGE}.` : asked.error);
    }
    this.write(key);
    if (storedKey() !== key) throw new Error("Could not save the key to ~/.config/kururu/firecrawl.json.");
    this.generation++;
    this.account = asked.ok ? accountFrom(asked.body, Date.now()) : null;
    this.accountError = null;
  }

  /** Forget the key: off the disk. The budget stays, for the next key. */
  clearField(name: string): void {
    if (name !== "key") return;
    this.write(null);
    this.generation++;
    this.account = null;
    this.accountError = null;
  }

  /**
   * One real page, a credit, so "it works" means a page came back rather
   * than that a key was accepted. Not held to the day's budget — the person
   * pressing it is the person who set it — but counted in it.
   */
  async test(): Promise<string> {
    const key = storedKey();
    if (!key) throw new Error("Paste a key first.");
    const answer = await new FirecrawlClient(API, key, LABEL).run(
      { tool: "scrape_page", url: TEST_URL, links: false, mainOnly: true, waitMs: 0, fresh: false, maxChars: 1000, ownToolsFailed: false },
      { pageLimit: this.deps.pageLimit() },
      AbortSignal.timeout(SCRAPE_MS),
      true,
    );
    const credits = answer.outcome === "served" || answer.outcome === "failed" ? (answer.credits ?? 0) : 0;
    this.spend(credits, true);
    if (answer.outcome !== "served" || answer.result.tool !== "scrape_page") throw new Error(answer.outcome === "failed" ? answer.reason : "No page came back.");
    const page = answer.result.page;
    if (!page.markdown.trim()) throw new Error("Firecrawl answered, but no text came back for the test page.");
    return `It works: fetched “${page.title ?? "example.com"}”, ${formatCredits(page.markdown.length)} characters, for ${formatCredits(credits)} ${credits === 1 ? "credit" : "credits"}.`;
  }

  private spend(credits: number, sent: boolean): void {
    const today = todayOf(this.day);
    this.day = { day: today.day, credits: today.credits + credits, calls: today.calls + (sent ? 1 : 0) };
    writeDay(this.day);
    this.deps.changed();
    if (sent) this.readSoon();
  }

  // -------------------------------------------------------------------------
  // A call
  // -------------------------------------------------------------------------

  async run(original: WebCall, ctx: RunContext): Promise<StepAnswer> {
    const key = storedKey();
    if (!key) return { outcome: "failed", failure: "refused", reason: "no key is set in Settings → Web" };
    let call = original;
    const notes: string[] = [];
    const left = budgetLeft(this.settings, this.day) - this.reserved;
    let cost = estimate(call);
    if (call.tool === "crawl_site" && cost > left && left >= 1) {
      notes.push(`kururu lowered this crawl to ${left} pages to stay inside today's Cloud Firecrawl budget.`);
      call = { ...call, limit: left };
      cost = left;
    }
    if (cost > left) {
      const spent = todayOf(this.day).credits;
      return {
        outcome: "failed",
        failure: "refused",
        reason: `kururu's daily Cloud Firecrawl budget is used up: ${formatCredits(spent)} of ${formatCredits(this.settings.dailyCredits)} credits today${this.reserved ? `, with ${formatCredits(this.reserved)} promised to calls still running` : ""}, and this would need about ${formatCredits(cost)}. It resets at midnight; the user can raise it in Settings → Web. Tell the user rather than retrying`,
      };
    }

    this.reserved += cost;
    let answer: StepAnswer;
    try {
      answer = await new FirecrawlClient(API, key, LABEL).run(call, { pageLimit: ctx.pageLimit }, ctx.signal, true);
    } finally {
      this.reserved -= cost;
    }
    const credits = answer.outcome === "served" || answer.outcome === "failed" ? (answer.credits ?? 0) : 0;
    this.spend(credits, true);
    if (answer.outcome !== "served") return answer;
    const today = todayOf(this.day);
    notes.unshift(`Cloud Firecrawl: ${formatCredits(credits)} ${credits === 1 ? "credit" : "credits"} · kururu has spent ${formatCredits(today.credits)} of ${formatCredits(this.settings.dailyCredits)} today.`);
    return { ...answer, notes: [...notes, ...(answer.notes ?? [])] };
  }

  // -------------------------------------------------------------------------
  // What the window draws
  // -------------------------------------------------------------------------

  view(): ProviderView {
    const key = storedKey();
    const today = todayOf(this.day);
    const readouts: WebReadout[] = [];
    if (key) {
      readouts.push({
        label: "Account",
        tone: this.accountError ? "bad" : this.account ? "ok" : "busy",
        value: this.accountError
          ? this.accountError
          : this.account
            ? `${formatCredits(this.account.remaining)}${this.account.plan ? ` of ${formatCredits(this.account.plan)}` : ""} credits left${this.account.periodEnd ? `, renews ${this.account.periodEnd.slice(0, 10)}` : ""}`
            : "Reading the account…",
      });
      readouts.push({ label: "Today", value: `${formatCredits(today.credits)} of ${formatCredits(this.settings.dailyCredits)} credits spent, ${formatCredits(today.calls)} ${today.calls === 1 ? "call" : "calls"}` });
    }
    return {
      summary: "firecrawl.dev, on your credits: gets past the Cloudflare challenges your own cannot. Last, and only when an agent says its own tools failed.",
      fields: [
        {
          name: "key",
          kind: "secret",
          label: "Key",
          hint: "Checked by asking Firecrawl the balance, which costs nothing. Kept in ~/.config/kururu/firecrawl.json, never sent back, never backed up.",
          placeholder: "fc-…",
          held: key ? firecrawlHint(key) : null,
        },
        {
          name: "dailyCredits",
          kind: "number",
          label: "Daily budget",
          hint: "Every agent together; resets at midnight.",
          value: this.settings.dailyCredits,
          min: DAILY_CREDITS_MIN,
          max: DAILY_CREDITS_MAX,
          unit: "credits",
        },
      ],
      readouts,
      about: [
        "One credit per page scraped or crawled (a PDF, one per page), one per site map, two per ten search results plus one per result fetched. A page that answers 403 or 404 still costs its credit. Free: 1,000 credits a month, refused rather than billed when they run out; Hobby: 5,000 a month for $19 (October 2026).",
        "Give the key a limit on Firecrawl's side too: in the key's ⋯ menu, Set limit, a credit limit per day the same as the budget here or a little more. Firecrawl enforces it itself, so it holds even if something here went wrong.",
        "What leaves this Mac: the address of every page asked for, or the search words, with your key, to api.firecrawl.dev, which caches pages for up to two days.",
      ],
      links: [
        { label: "Sign in", href: "https://www.firecrawl.dev/signin" },
        { label: "API keys", href: "https://www.firecrawl.dev/app/api-keys" },
        { label: "Pricing", href: "https://www.firecrawl.dev/pricing" },
      ],
      test: "Fetches example.com through it. One credit.",
    };
  }
}

registerWebProvider({ id: ID, rank: 30, create: (deps) => new CloudFirecrawl(deps) });
