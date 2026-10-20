/**
 * Another node's agents, wanting a human: the card this node's window raises
 * for a blocked agent on omarchy, and nothing else.
 *
 * It exists because a child's notifications reached only the child's own
 * clients. The Mac's window could see omarchy's agents in the sidebar and
 * the Needs drawer, and the first it heard of one asking was the dot — the
 * card and the croak went to the box's phone, if it had one open. Phase 3 of
 * `docs/plans/remote-workspaces.md` has this node notice the edge itself and
 * run its own gate over its own clients (`shared/notify.ts`), so "claude on
 * omarchy needs input" arrives where the user is, and a click on it is a
 * `reveal-agent` with the qualified id, which the relay turns into omarchy's
 * pane on this screen.
 *
 * **Two sources, one at a time.** While a watch is up, the child's own
 * snapshot is relayed and is the freshest word there is — that is what the
 * plan means by noticing "over relayed snapshots". While none is, the
 * summary the child pushes over `/link` (at most once a second) says the
 * same statuses for the same agents (`snapshotAgents` and `summaryAgents`
 * pick the same set), and an idle Mac must not open a watch only to hear
 * them. Reading both at once would be two clocks: a summary a second behind
 * the snapshot reads as the agent going back and forth. So a node is read
 * from one, and when it changes source the first reading only learns where
 * things stand, raising nothing — `noticeStatuses`' rule for a restart, and
 * for the same reason: a state first seen is not news.
 *
 * **What it does not do.** It sets no unread mark (that is the child's,
 * cleared by whoever watches, the relay among them), and it tells this
 * node's Kuru nothing: a remote agent's edges are its own Kuru's to hear,
 * and the rule "read anywhere, act locally" is unchanged.
 */
import type { WebSocket } from "ws";
import type { AgentSnapshot, AgentStatus, SessionSnapshot } from "../../shared/model";
import type { NodeSummary } from "../../shared/nodes";
import { agentLabel, agentSummary, basename } from "../../shared/labels";
import { countsAsAgent } from "../../shared/model";
import { NOTIFY_THROTTLE_MS, notifyGate, notifyText, type NotifyEvent, type NotifySettings } from "../../shared/notify";
import { qualify, snapshotAgents, statusEdges, summaryAgents, type RemoteAgent } from "../../shared/remote";
import type { ServerMessage } from "../../shared/wire";

export interface NodeNoticeDeps {
  /** This node's clients, with what each has on screen and whether it is a watch of this node's. */
  clients: () => Iterable<[WebSocket, { watching: ReadonlySet<string>; watcher?: string | null }]>;
  send: (ws: WebSocket, msg: ServerMessage) => void;
  settings: () => NotifySettings;
  name: (node: string) => string;
}

type Source = "watch" | "summary";

export class NodeNotices {
  private readonly seen = new Map<string, { source: Source; statuses: Map<string, AgentStatus> }>();
  private readonly notifiedAt = new Map<string, number>();

  constructor(private readonly deps: NodeNoticeDeps) {}

  /** The child's snapshot, relayed by its watch. */
  snapshot(node: string, snapshot: Pick<SessionSnapshot, "profile" | "agents">): void {
    this.read(node, "watch", snapshotAgents(snapshot));
  }

  /**
   * The node's latest summary, pushed over its link; read only while no
   * watch of it is up. A node that is away is not read at all, since what it
   * last said is no longer known to be true.
   */
  summary(node: string, summary: NodeSummary | null, linked: boolean, watched: boolean): void {
    // A node this window cannot open — the parent, seen from a child, or one
    // from before — is its own clients' to tell: a card here would be a
    // click that goes nowhere.
    if (watched || !linked || !summary?.watchable) return;
    this.read(node, "summary", summaryAgents(summary));
  }

  private read(node: string, source: Source, agents: RemoteAgent[]): void {
    const was = this.seen.get(node);
    // A source changing is a first look, as a restart is: learnt, not announced.
    const fresh = !was || was.source !== source;
    const { seen, edges } = statusEdges(fresh ? new Map() : was.statuses, agents);
    this.seen.set(node, { source, statuses: seen });
    if (fresh) return;
    for (const edge of edges) this.announce(node, edge, edge.event);
  }

  /** `announce` in `index.ts`, for a node's agent: the same gate per client, the same throttle, the node in the words. */
  private announce(node: string, { agent, workspace }: RemoteAgent, event: NotifyEvent): void {
    const id = qualify(node, agent.id);
    const now = Date.now();
    if (now - (this.notifiedAt.get(id) ?? 0) < NOTIFY_THROTTLE_MS) return;
    // A summary's agent has no process fields; the label reads `command` only for a shell, which is never news here.
    const shaped = { pid: 0, command: "", ...agent } as AgentSnapshot;
    // `announce`'s choice: the placeholder `starting…` would sit on a card all
    // afternoon, so an agent the scan has not named is called by its command —
    // which a summary does not carry, and then it is "an agent".
    const label = shaped.agent || shaped.titleOverride ? agentLabel(shaped) : shaped.command ? basename(shaped.command) : "an agent";
    const text = notifyText({
      label: `${label} on ${this.deps.name(node)}`,
      summary: agentSummary(shaped),
      workspace,
      event,
    });
    const notification = { agentId: id, event, ...text };
    const settings = this.deps.settings();
    let sent = false;
    for (const [ws, st] of this.deps.clients()) {
      // A watch of this node by another is not a window to raise a card on.
      if (st.watcher) continue;
      // The node's Kuru is never in the list (`snapshotAgents`), so this is never a harness.
      const verdict = notifyGate({ event, visible: st.watching.has(id), isAgent: countsAsAgent(shaped), isHarness: false }, settings);
      if (!verdict.pass) continue;
      this.deps.send(ws, { type: "notify", notification });
      sent = true;
    }
    if (sent) this.notifiedAt.set(id, now);
  }
}
