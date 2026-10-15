/**
 * Settings → Connections → Firecrawl: the web for every agent kururu starts,
 * set up from nothing.
 *
 * A walkthrough for Channels' reason: the person here may never have heard of
 * Firecrawl, and what it needs — an account, a key, a sense of what the
 * credits buy — comes from somebody else's site. The switch and the readout
 * sit above the steps, because once it is set up they are all anybody comes
 * back for.
 *
 * The key goes to the server once and is never sent back; what this draws is
 * the status every window is sent, whose `hint` is the prefix and the last
 * four. What leaves the machine is on the page, folded, because every URL an
 * agent fetches goes to somebody else's servers and that is a decision to
 * make knowing it.
 */
import { useState } from "react";
import { DAILY_CREDITS_MAX, DAILY_CREDITS_MIN, PAGE_LIMIT_MAX, PAGE_LIMIT_MIN, formatCredits, todayOf, type FirecrawlCall, type FirecrawlStatus } from "../../../shared/firecrawl";
import * as api from "../session";
import { useKururu } from "../session";
import { A, Action, Banner, Details, Empty, errorText, Group, Item, KeyRow, Mono, NumField, P, Readout, Step, Steps, Toggle, when } from "./ui";

const SIGN_UP = "https://www.firecrawl.dev/signin";
const KEYS = "https://www.firecrawl.dev/app/api-keys";
const PRICING = "https://www.firecrawl.dev/pricing";
const DASHBOARD = "https://www.firecrawl.dev/app";

export function FirecrawlPage() {
  const { firecrawl } = useKururu();
  if (!firecrawl) {
    return (
      <Group>
        <Empty>Waiting for the server…</Empty>
      </Group>
    );
  }
  return <Page status={firecrawl} />;
}

function Page({ status }: { status: FirecrawlStatus }) {
  const [error, setError] = useState<string | null>(null);
  const keyed = status.hint !== null;
  const tested = status.recent.some((call) => call.tool === "test" && call.ok);
  const today = todayOf(status.today);
  const change = (patch: Parameters<typeof api.setFirecrawl>[0]) => {
    setError(null);
    api.setFirecrawl(patch).catch((err: unknown) => setError(errorText(err)));
  };

  return (
    <>
      {error && <Banner tone="bad">{error}</Banner>}

      <Group title="Firecrawl" foot="For when an agent's own fetch fails — pages drawn by JavaScript, sites that block bots, PDFs: rendered on Firecrawl's servers, handed to the agent as text. The agent never sees the key.">
        <Toggle label="Agents get Firecrawl" hint={describe(status)} on={keyed && status.settings.enabled} disabled={!keyed} onChange={(enabled) => change({ enabled })} />
        {keyed && (
          <>
            <Readout
              label="Account"
              tone={status.error ? "bad" : status.account ? "ok" : "busy"}
              value={
                status.error
                  ? status.error
                  : status.account
                    ? `${formatCredits(status.account.remaining)}${status.account.plan ? ` of ${formatCredits(status.account.plan)}` : ""} credits left${status.account.periodEnd ? `, renews ${when(status.account.periodEnd)}` : ""}`
                    : "Reading the account…"
              }
            />
            <NumField
              label="Pages per call"
              hint="The most one crawl, or one PDF, may cost."
              value={status.settings.pageLimit}
              min={PAGE_LIMIT_MIN}
              max={PAGE_LIMIT_MAX}
              ariaLabel="The most pages one call may cost"
              onCommit={(pageLimit) => change({ pageLimit })}
            />
            <NumField
              label="Daily budget"
              hint={`Every agent together, resets at midnight. Spent ${formatCredits(today.credits)} today.`}
              value={status.settings.dailyCredits}
              min={DAILY_CREDITS_MIN}
              max={DAILY_CREDITS_MAX}
              unit="credits"
              ariaLabel="The most credits kururu spends in a day"
              onCommit={(dailyCredits) => change({ dailyCredits })}
            />
          </>
        )}
      </Group>

      <Group title="Set up">
        <Steps>
          <Step n={1} done={keyed} title="A Firecrawl account" line="Sign up with Google, GitHub or an email; no card for the free plan.">
            <Readout label="Sign in" value={<A href={SIGN_UP}>firecrawl.dev</A>} />
            <Details summary="What the credits buy">
              <P>
                One credit per page scraped or crawled (a PDF, one per page), one per site map, two per ten search results plus one per result fetched. A page that answers 403 or
                404 still costs its credit.
              </P>
              <P>
                <b>Free</b>: 1,000 credits a month, two requests at a time, refused rather than billed when they run out. <b>Hobby</b>: 5,000 a month for $19. <b>Standard</b> and
                up: 100,000 and more. Prices as listed in October 2026; the <A href={PRICING}>pricing page</A> is the current word. Start on Free.
              </P>
            </Details>
          </Step>
          <Step n={2} done={keyed} title="A key for kururu" line={<>Make one named <Mono>kururu</Mono> and paste it here. Checked by asking Firecrawl the balance, which costs nothing.</>}>
            <Readout label="Keys page" value={<A href={KEYS}>firecrawl.dev/app/api-keys</A>} />
            <KeyRow
              label="Key"
              placeholder="fc-…"
              ariaLabel="Firecrawl API key"
              stored={status.hint ? { hint: status.hint, tone: status.error ? "bad" : status.account ? "ok" : "busy" } : null}
              hint={
                <>
                  Kept in <Mono>~/.config/kururu/firecrawl.json</Mono>, never in an agent's environment, never sent back, never backed up.
                </>
              }
              onSave={(key) => api.setFirecrawlKey(key)}
              removeAsk="Forget the key?"
              onRemove={() => api.clearFirecrawlKey()}
            />
            <Details summary="A limit on Firecrawl's side too">
              <P>
                In the key's ⋯ menu choose <b>Set limit</b> and give it a credit limit per day, the same as kururu's daily budget or a little more. Firecrawl enforces that itself,
                so it holds even if something here went wrong. The account's <b>Default</b> key works too, but a separate one can be limited and removed on its own.
              </P>
            </Details>
          </Step>
          <Step n={3} done={tested} title="Test it">
            <TestRow keyed={keyed} />
          </Step>
        </Steps>
      </Group>

      <Group title="What this is">
        <Details summary="Four tools, for every Claude Code and Codex agent kururu starts on this Mac.">
          <P>
            <Mono>scrape_page</Mono> (one page as markdown), <Mono>crawl_site</Mono> (several pages, following links), <Mono>map_site</Mono> (a site's URLs, without their
            content) and <Mono>search_web</Mono>, served by kururu on this Mac to agents from the + menu, a card's robot, Kuru, and a card picked back up. An agent already
            running gets them next time it starts. Not given them: agents on a machine, and a <Mono>claude</Mono> or <Mono>codex</Mono> you type into a shell yourself. Every
            result tells the agent that what came back is untrusted content from the web.
          </P>
          <P>
            They are a fallback, and each one's description opens by saying so: an agent searches and reads with its own web search and fetch first, and calls one of these
            only when that fails — a site that blocks it, a page that comes back empty, content drawn by JavaScript, a PDF its fetch cannot read. <Mono>search_web</Mono> is
            for what its own search cannot find, never a first search; <Mono>map_site</Mono> and <Mono>crawl_site</Mono> for a site a plain fetch has already failed on.
          </P>
        </Details>
        <Details summary="What leaves this Mac: the address of every page an agent asks for, or its search words, with your key.">
          <P>
            They go to <Mono>api.firecrawl.dev</Mono>, which fetches the page from the internet. Nothing else of the agent's goes: not its files, not its conversation. Firecrawl
            caches pages for up to two days. Addresses on this Mac, your network or the tailnet are refused before anything is sent. What agents spent shows below and in{" "}
            <A href={DASHBOARD}>Firecrawl's dashboard</A>.
          </P>
        </Details>
      </Group>

      {status.recent.length > 0 && (
        <Group title="Recent requests">
          {status.recent.map((call) => (
            <Recent key={`${call.at}-${call.target}`} call={call} />
          ))}
        </Group>
      )}
    </>
  );
}

function TestRow({ keyed }: { keyed: boolean }) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ text: string; bad?: boolean } | null>(null);
  return (
    <Action
      label="Fetch a test page"
      hint={<><Mono>example.com</Mono>, through Firecrawl the way an agent would. One credit.</>}
      button="Fetch"
      busy={busy}
      busyLabel="Fetching…"
      disabled={!keyed}
      outcome={outcome}
      onClick={() => {
        if (busy) return;
        setBusy(true);
        setOutcome(null);
        api
          .testFirecrawl()
          .then((got) =>
            setOutcome({ text: `It works: fetched “${got.title ?? "example.com"}”, ${formatCredits(got.chars)} characters, for ${formatCredits(got.credits)} ${got.credits === 1 ? "credit" : "credits"}.` }),
          )
          .catch((err: unknown) => setOutcome({ text: errorText(err), bad: true }))
          .finally(() => setBusy(false));
      }}
    />
  );
}

function Recent({ call }: { call: FirecrawlCall }) {
  const what = call.tool === "test" ? "test" : call.tool.replace("_", " ");
  return (
    <Item
      className={call.ok ? undefined : "st-item-bad"}
      lead={<span className="st-when">{when(call.at)}</span>}
      name={<Mono title={call.target}>{call.target}</Mono>}
      sub={[what, call.credits ? `${formatCredits(call.credits)} cr` : null, call.agent, call.error].filter(Boolean).join(" · ")}
    />
  );
}

/** The line under the switch: the key and today, or what is missing. */
function describe(status: FirecrawlStatus): string {
  if (!status.hint) return "Not set up: the steps below give kururu a key.";
  if (!status.settings.enabled) return "Off: agents started now do not get the tools, and calls from ones that have them are refused.";
  const today = todayOf(status.today);
  return `On · ${formatCredits(today.credits)} of ${formatCredits(status.settings.dailyCredits)} credits spent today`;
}
