/**
 * The words and shapes the four drawings of another node share: the
 * sidebar's section, the Needs drawer's band, the Share dialog's codes and
 * Settings → Nodes.
 *
 * Apart from those four so that a node's state is said one way wherever it
 * is said — "away since 23:10" in the sidebar and "away since 11:10 PM" in
 * Settings would be two clocks reading one fact. Nothing here decides
 * anything; the rules are `shared/nodes.ts`'s and the server's.
 */
import type { AgentSnapshot } from "../../shared/model";
import type { NodeStatus, SummaryAgent } from "../../shared/nodes";

/** "14:03" today, "Oct 11, 14:03" before: when a node went away is a moment, and the day matters once it is not today. */
export function clock(at: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return date.toDateString() === new Date().toDateString() ? time : `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

/** A node's link in a few words: "linked", "connecting…", "away since 23:10". */
export function nodeState(node: NodeStatus): string {
  if (node.state === "up") return "linked";
  if (node.state === "connecting") return "connecting…";
  const since = node.since ?? node.lastSeen;
  return since ? `away since ${clock(since)}` : "away";
}

/**
 * A summary's agent as the snapshot shape the sidebar's helpers take. The
 * two fields left out are about this machine's processes, which a row on
 * another node's heading never reads; they are filled with nothing rather
 * than every helper growing a second type.
 */
export function asAgent(agent: SummaryAgent): AgentSnapshot {
  return { ...agent, pid: 0, command: "" };
}
