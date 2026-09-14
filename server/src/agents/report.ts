/**
 * What an agent is allowed to say about itself.
 *
 * Two things the byte stream cannot tell us arrive here instead. `blocked` is
 * one: no amount of watching output distinguishes "waiting for you to approve
 * something" from "thinking hard", so an agent has to say it. Context usage is
 * the other — it is a number the agent knows and the terminal never carries.
 *
 * This is the same payload ghosttown accepts over its control socket, on
 * purpose: the Claude Code hooks people already have pointed at `gt report` can
 * be pointed here instead without rewriting what they send. The transport is
 * different (an HTTP POST rather than a unix socket) because kururu already has
 * an HTTP server and agents already know where it is — `KURURU_AGENT_ID` and
 * `KURURU_PORT` are in every agent's environment; see `host.ts`.
 *
 * A report is authoritative and permanent: once an agent has reported even once,
 * the timing heuristic stops speaking for it. A process that knows its own state
 * beats a guess about it forever after.
 */
import type { AgentReport, ContextUsage } from "../../../shared/model";
import { isAgentStatus } from "../../../shared/model";

function parseContext(value: unknown): ContextUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { used, window } = value as Record<string, unknown>;
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0) return undefined;
  // `window <= 0` is rejected rather than clamped: the ring divides by it, and a
  // zero would render NaN into an SVG attribute rather than failing visibly.
  if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) return undefined;
  return { used, window };
}

/**
 * Parse an untrusted body into a report. Returns null when there is nothing
 * usable in it, so the endpoint can answer 400 rather than silently accepting
 * a typo'd status and reporting nothing.
 */
export function parseReport(body: unknown): { agentId: string | null; report: AgentReport } | null {
  if (!body || typeof body !== "object") return null;
  const raw = body as Record<string, unknown>;

  const report: AgentReport = {};
  if (raw.status !== undefined) {
    if (!isAgentStatus(raw.status)) return null;
    report.status = raw.status;
  }
  if (typeof raw.message === "string") report.message = raw.message;
  const context = parseContext(raw.context);
  if (context) report.context = context;

  if (report.status === undefined && report.context === undefined) return null;

  const agentId =
    typeof raw.agent === "string" && raw.agent
      ? raw.agent
      : typeof raw.agentId === "string" && raw.agentId
        ? raw.agentId
        : null;

  return { agentId, report };
}
