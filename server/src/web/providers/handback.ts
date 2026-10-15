/**
 * The agent's own web tools, as a step in the chain.
 *
 * Claude Code's WebSearch and WebFetch, and Codex's search, run inside the
 * agent: kururu cannot call them, see them, or know whether they worked. What
 * it can do is stop and say "use yours" — and it matters where in the order
 * that is said, because what comes after it is the paid provider. So it is a
 * provider like the others rather than a rule in the chain: it can be moved,
 * switched off (and then whatever is after it is tried without asking), and
 * the chain does not know what it is, only that it answered `stop`.
 *
 * Its one rule is the opt-in. A call that says `ownToolsFailed` is let past —
 * the agent's word is all there is to go on, and the descriptions say what it
 * costs to give it — and any other call stops here with a sentence that says
 * what kururu tried, what to do next, and what the opt-in would reach.
 */
import { describeStep, type WebCall, type WebCapability, type WebHealth } from "../../../../shared/web";
import { registerWebProvider, type ProviderView, type RunContext, type StepAnswer, type WebProvider } from "../provider";

const CAN: readonly WebCapability[] = ["search", "scrape", "map", "crawl"];

function list(labels: string[]): string {
  return labels.length <= 1 ? (labels[0] ?? "") : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/** What the hand-back tells the agent. Exported for the test. */
export function handBackText(call: WebCall, ctx: Pick<RunContext, "trail" | "after">): string {
  const own = call.tool === "search_web" ? "web search" : "web fetch";
  const tried = ctx.trail.filter((s) => s.outcome === "failed" || (s.outcome === "skipped" && s.reason !== "switched off in Settings"));
  const head = tried.length ? `kururu_web could not get this: ${tried.map(describeStep).join("; ")}.` : "kururu_web hands this to your own tools first.";
  const paid = ctx.after.filter((a) => a.paid).map((a) => a.label);
  const then = ctx.after.length
    ? `If that fails too, call ${call.tool} again with the same arguments and ownToolsFailed: true; that goes on to ${list(ctx.after.map((a) => a.label))}${paid.length ? `, which costs the user credits — so only once your own ${own} has really failed` : ""}.`
    : "If that fails too, kururu has nothing further to try: tell the user what you could not reach.";
  return `${head} Use your own ${own} for it now. ${then}`;
}

class HandBack implements WebProvider {
  readonly id = "agent-tools";
  readonly label = "The agent's own web tools";
  readonly kind = "handback" as const;
  readonly paid = false;

  defaultEnabled(): boolean {
    return true;
  }

  can(): readonly WebCapability[] {
    return CAN;
  }

  ready(): boolean {
    return true;
  }

  timeoutMs(): number {
    return 1000;
  }

  async run(call: WebCall, ctx: RunContext): Promise<StepAnswer> {
    if (call.ownToolsFailed) return { outcome: "pass", reason: "the agent said its own tools had failed" };
    return { outcome: "stop", text: handBackText(call, ctx) };
  }

  async health(): Promise<WebHealth> {
    return { state: "ok", detail: "Always there: it is the agent's.", at: Date.now() };
  }

  view(): ProviderView {
    return {
      summary: "Not a service: the step where kururu tells the agent to use its own web search and fetch. What comes after it is tried only when the agent says those failed too.",
      fields: [],
      readouts: [],
      about: [
        "Claude Code's WebSearch and WebFetch, and Codex's web search, run inside the agent, so kururu cannot call them. When the chain reaches this step it stops and answers the agent: what kururu tried, that it should now use its own tools, and that it may call again with ownToolsFailed: true if those fail too — which is the only way past this step.",
        "Switch it off and the providers after it are tried straight away, without the agent's own tools in between. Move it to the top and every call starts with the agent's own tools.",
      ],
      links: [],
      test: null,
    };
  }
}

registerWebProvider({ id: "agent-tools", rank: 20, create: () => new HandBack() });
