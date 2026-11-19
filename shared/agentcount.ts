/**
 * How many agents are at work, and how many are waiting on you, across a
 * profile and the nodes linked to it: what the floating Kuru's logo carries
 * and what its Agents list draws (`web/src/components/Float.tsx`).
 *
 * It exists because the logo floats over other applications, where the
 * sidebar is not, and "is anything still going?" is the question somebody
 * in another app asks before they come back. The Needs count on the logo's
 * corner answers a different one — what will not move without you — and
 * counts cards as well as agents; this counts terminals, and only the ones
 * an agent has run in, by the sidebar's own test (`agent || lastAgent`), so
 * a shell somebody ran `ls` in is never "an agent idle".
 *
 * Three states, not the four statuses, because the logo has room for two
 * numbers and the list for three headings. **Waiting** is an agent that is
 * blocked or that the Needs rule names — asking, queued past the wait, a
 * turn nobody saw, a card in Review whose terminal is still open — so the
 * two counts on the logo never disagree about an agent. **Working** is the
 * rest of `working`. **Quiet** is done and idle together: nobody is waiting
 * on them, and they are not using the Mac. An exited terminal is none of
 * these; it is a screen kept for reading, not an agent, and Kuru's own
 * terminal is the status bar chip's, as in `needsOf`.
 *
 * **Other nodes are counted, from the summary each one already pushes.**
 * The question is "are my agents still going", and an agent on the Omarchy
 * box is as much the owner's as one on the Mac — the Needs count on the
 * same logo already adds the nodes in, and a count that left them out would
 * read as "nothing running" while a box worked away. Only a node that is up:
 * an away node's summary is a picture of the past, and counting it as at
 * work would be the one wrong thing this could say. Nothing is asked of the
 * nodes for this; the summary is pushed when it changes, as before.
 *
 * Pure, over what the snapshot and the `nodes` message carry, so the logo's
 * badge and the list are one answer, and a test can hold it.
 */
import type { AgentSnapshot, AgentStatus, Profile } from "./model";
import { panes, terminalsOf } from "./layout";
import type { ProfileNeeds } from "./needs";
import type { NodeStatus, SummaryAgent } from "./nodes";

export type AgentState = "waiting" | "working" | "quiet";

/** An agent as the list draws it: by its own fields, whichever machine it is on. */
export type CountedSnapshot = Pick<AgentSnapshot, "id" | "status" | "exited" | "exitCode" | "kind" | "agent" | "lastAgent" | "titleOverride" | "title" | "activity">;

export interface CountedAgent {
  /** Its id where it lives: a local agent's own, another node's unqualified (the caller qualifies it to go there). */
  id: string;
  state: AgentState;
  agent: CountedSnapshot;
}

export interface AgentGroup {
  /** A local workspace's id, or `<node>/<workspace key>`: unique across the list. */
  key: string;
  name: string;
  /** The local workspace's id; null for another node's. */
  workspaceId: string | null;
  /** The node it is on, or null for this one. */
  node: { id: string; name: string } | null;
  /** Another node's workspace key, for the door to it. */
  workspaceKey: string | null;
  /** Waiting first, then working, then quiet; within each, the order the panes have them. */
  agents: CountedAgent[];
}

export interface AgentCount {
  waiting: number;
  working: number;
  quiet: number;
  /** Every workspace with an agent in it, this node's first in the sidebar's order, then each node's. */
  groups: AgentGroup[];
}

const RANK: Record<AgentState, number> = { waiting: 0, working: 1, quiet: 2 };

/** The sidebar's test for a row: an agent has been seen in this terminal. */
function isAgent(agent: Pick<AgentSnapshot, "agent" | "lastAgent">): boolean {
  return Boolean(agent.agent || agent.lastAgent);
}

function stateOf(status: AgentStatus, needed: boolean): AgentState {
  if (needed || status === "blocked") return "waiting";
  return status === "working" ? "working" : "quiet";
}

/**
 * The count and the list. `needs` is `needsOf` for the same profile and
 * agents — passed in rather than worked out again, since every caller has
 * it already and the rule is that one's.
 */
export function countAgents(profile: Profile, agents: readonly AgentSnapshot[], needs: ProfileNeeds, nodes: readonly NodeStatus[] = []): AgentCount {
  const harness = profile.harness?.agentId ?? null;
  const byId = new Map(agents.map((a) => [a.id, a] as const));
  const wanted = new Set<string>();
  for (const w of needs.workspaces) for (const need of w.needs) if (need.agent) wanted.add(need.agent.id);

  const groups: AgentGroup[] = [];
  const seen = new Set<string>();
  for (const workspace of profile.workspaces) {
    const here: CountedAgent[] = [];
    for (const pane of panes(workspace.layout)) {
      for (const id of terminalsOf(pane.agentIds)) {
        const agent = byId.get(id);
        // A terminal is in one pane of one workspace; `seen` only guards a layout caught mid-move.
        if (!agent || id === harness || agent.exited || !isAgent(agent) || seen.has(id)) continue;
        seen.add(id);
        here.push({ id, state: stateOf(agent.status, wanted.has(id)), agent });
      }
    }
    if (here.length) groups.push({ key: workspace.id, name: workspace.name, workspaceId: workspace.id, node: null, workspaceKey: null, agents: ranked(here) });
  }

  for (const node of nodes) {
    if (node.state !== "up" || !node.summary) continue;
    for (const workspace of node.summary.workspaces) {
      const asked = new Set(workspace.needs.flatMap((need) => (need.agentId ? [need.agentId] : [])));
      const here: CountedAgent[] = workspace.agents
        .filter((agent: SummaryAgent) => !agent.exited && isAgent(agent))
        .map((agent) => ({ id: agent.id, state: stateOf(agent.status, asked.has(agent.id)), agent }));
      if (here.length) {
        groups.push({
          key: `${node.id}/${workspace.key}`,
          name: workspace.name,
          workspaceId: null,
          node: { id: node.id, name: node.name },
          workspaceKey: workspace.key,
          agents: ranked(here),
        });
      }
    }
  }

  const count = { waiting: 0, working: 0, quiet: 0 };
  for (const group of groups) for (const agent of group.agents) count[agent.state] += 1;
  return { ...count, groups };
}

function ranked(agents: CountedAgent[]): CountedAgent[] {
  // `sort` is stable, so within a state the panes' order stands.
  return agents.sort((a, b) => RANK[a.state] - RANK[b.state]);
}

/** Of one group, how many in each state: the list's heading, and the badge's tooltip line. */
export function groupCounts(group: AgentGroup): Record<AgentState, number> {
  const out = { waiting: 0, working: 0, quiet: 0 };
  for (const agent of group.agents) out[agent.state] += 1;
  return out;
}

/** "2 working, 1 waiting on you, 3 done or idle" — the parts that are not zero, or "no agents". */
export function countWords(count: Record<AgentState, number>): string {
  const parts = [
    count.working ? `${count.working} working` : "",
    count.waiting ? `${count.waiting} waiting on you` : "",
    count.quiet ? `${count.quiet} done or idle` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "no agents";
}

/**
 * The badge's tooltip: the whole count, then a line per workspace, the
 * other nodes' named after their node. Cut at `max` lines, saying how many
 * more, since a native tooltip has no scroll.
 */
export function countSummary(count: AgentCount, max = 12): string {
  const lines = [`Agents: ${countWords(count)}`];
  const shown = count.groups.slice(0, max);
  for (const group of shown) lines.push(`${group.node ? `${group.node.name} · ` : ""}${group.name}: ${countWords(groupCounts(group))}`);
  const more = count.groups.length - shown.length;
  if (more > 0) lines.push(`and ${more} more ${more === 1 ? "workspace" : "workspaces"}`);
  return lines.join("\n");
}
