/**
 * The other kururus on the bottom bar: a frog — Kuru's, since another node
 * is another Kuru doing work — with how many are linked, and on a hover, a
 * tap on a phone, each node with its workspaces and their agents.
 *
 * They were a section of the sidebar until 2026-11-10, when the owner had
 * it taken out: another computer's workspaces are wanted now and then, and
 * the section held a column's worth of rows all the time to be ready for
 * it. The machines had gone the same way on 2026-10-18 for the same reason
 * (`Machines.tsx`), and this is beside them and drawn like them. What the
 * section drew all the time the popover draws on request, and everything a
 * row in it did a row here still does: a workspace's row puts it on this
 * screen, an agent's goes to its terminal there, the + makes a workspace on
 * the node, and the node's name is a link to its own page, for its Settings.
 * `C-a w`, `C-a N` and `C-a P` reach the same workspaces with no popover at
 * all (`workspacesAcross` in `shared/remote.ts`), and never read the sidebar.
 *
 * Two things are said on the chip itself, since the popover is shut most of
 * the time. A node that is away makes the count "1/2" and adds the stale
 * dot, as a machine that cannot be reached does. Something on a node that
 * needs you — the node's own `needsOf`, carried in its summary — puts the
 * accent's dot after the count, the one the section's heading wore; the
 * Needs drawer has the same thing with its band per node, and is where it
 * is acted on. A node that is away is not counted there, and not here.
 *
 * A node that can be watched (`NodeSummary.watchable`) has rows like this
 * node's own sidebar; one from before remote workspaces keeps the old rows,
 * each a link to its page, with a tooltip saying what updating it would
 * give. A node that is away keeps its last summary, greyed, with since
 * when, and its rows still go. Drawn only once a node is linked, as the
 * section was.
 */
import type { MascotSet } from "../../../shared/model";
import { mascotFor } from "../../../shared/model";
import type { NodeStatus } from "../../../shared/nodes";
import { qualify } from "../../../shared/remote";
import { agentLabel, agentSummary } from "../labels";
import { asAgent, nodeState } from "../nodes";
import * as api from "../session";
import { useKururu } from "../session";
import { BarChip } from "./BarChip";
import type { DialogState } from "./Dialog";
import { Icon } from "./Icon";
import { hueStyle } from "./NodeChip";
import { Status } from "./Status";

export function NodesChip({
  mascots,
  remoteOn,
  onPrompt,
  onSettings,
}: {
  mascots: MascotSet;
  /** Which node's workspace is on this screen, if one is: its row is lit. */
  remoteOn: { nodeId: string; workspaceKey: string } | null;
  onPrompt: (state: DialogState) => void;
  onSettings: () => void;
}) {
  const { nodes } = useKururu();
  if (!nodes || nodes.nodes.length === 0) return null;
  const all = nodes.nodes;
  const up = all.filter((node) => node.state === "up");
  const away = all.length - up.length;
  const needing = up.filter((node) => (node.summary?.needs.count ?? 0) > 0);
  const count = away > 0 ? `${up.length}/${all.length}` : String(all.length);
  const words =
    away > 0 ? `${up.length} of ${all.length} nodes linked` : `${all.length} ${all.length === 1 ? "node" : "nodes"} linked`;
  const title = [
    words,
    ...all.filter((node) => node.state !== "up").map((node) => `${node.name}: ${nodeState(node)}`),
    ...needing.map((node) => `${node.name}: something needs you`),
  ].join("\n");

  return (
    <BarChip
      label={title}
      className="sb-nodes"
      chip={
        <>
          <span className="sb-usage-mark sb-nodes-mark" aria-hidden="true">
            <KuruIcon />
          </span>
          <span className="sb-nodes-n">{count}</span>
          {away > 0 && <span className="usage-stale">·</span>}
          {needing.length > 0 && <span className="unread" aria-label="needs you" />}
        </>
      }
    >
      {(close) => (
        <>
          <span className="usage-pop-head">
            <span className="sb-usage-mark sb-nodes-mark" aria-hidden="true">
              <KuruIcon />
            </span>
            Nodes
            <span className="machines-head-words">{words}</span>
          </span>
          <ul className="node-list">
            {all.map((node) => (
              <NodeBlock
                key={node.id}
                node={node}
                mascot={mascotFor(mascots, null)}
                on={remoteOn?.nodeId === node.id ? remoteOn.workspaceKey : null}
                onNavigated={close}
                /* Only the parent may put a node's workspace on its screen, so
                   only the parent offers to make one there and go to it. */
                onNew={
                  nodes.role === "parent" && node.state === "up" && node.summary?.watchable && node.summary.drives
                    ? () => {
                        close();
                        onPrompt({ kind: "node-new", title: `New workspace on ${node.name}`, nodeId: node.id, nodeName: node.name });
                      }
                    : null
                }
              />
            ))}
          </ul>
          <span className="usage-pop-foot machines-foot">
            <button
              className="kuru-head-btn"
              onClick={() => {
                close();
                onSettings();
              }}
            >
              Settings → Nodes
            </button>
          </span>
        </>
      )}
    </BarChip>
  );
}

function NodeBlock({
  node,
  mascot,
  on,
  onNavigated,
  onNew,
}: {
  node: NodeStatus;
  mascot: ReturnType<typeof mascotFor>;
  /** The key of this node's workspace that is on screen, or null. */
  on: string | null;
  onNavigated: () => void;
  /** New workspace on this node, or null where that cannot be asked of it. */
  onNew: (() => void) | null;
}) {
  const up = node.state === "up";
  const summary = node.summary;
  const watchable = !!summary?.watchable;
  const go = watchable ? `${node.name}'s own page, for its Settings` : `Open ${node.name}'s kururu`;
  // The parent is never watched, and updating it would not change that.
  const old = node.parent ? "" : `Update ${node.name} (kururu child update) to open its workspaces in this window.`;
  return (
    <li className={`node-item ${up ? "" : "node-stale"}`} style={hueStyle(node.id)}>
      <div className="node-headrow">
        <a className="node-head" href={node.url} target="_blank" rel="noreferrer noopener" title={[go, node.error && !up ? node.error : null].filter(Boolean).join("\n")}>
          <span className="node-chip-dot" aria-hidden="true" />
          <span className="node-name">{node.name}</span>
          {!up && <span className="node-state">{nodeState(node)}</span>}
          {up && summary && summary.needs.count > 0 && <span className="unread" aria-label="needs you" />}
        </a>
        {onNew && (
          <button className="mini" onClick={onNew} title={`New workspace on ${node.name}, in a folder there`} aria-label={`New workspace on ${node.name}`}>
            <Icon name="add" />
          </button>
        )}
      </div>
      {summary ? (
        <ul className="node-workspaces">
          {summary.workspaces.map((w) =>
            watchable ? (
              <li key={w.key}>
                <button
                  className={`node-ws ${on === w.key ? "node-ws-on" : ""}`}
                  onClick={() => {
                    api.showNodeWorkspace(node.id, w.key);
                    onNavigated();
                  }}
                  title={[`${w.name}, on ${node.name}`, w.folder].filter(Boolean).join("\n")}
                >
                  <span className="node-ws-name">{w.name}</span>
                  {w.band === "needs" && <span className="unread" aria-label="needs you" />}
                </button>
                {/* Its agents, as this node's own list has them: agents and
                    not shells, which the workspace's row is the way to. */}
                {w.agents.some(listedAgent) && (
                  <ul className="node-agents">
                    {w.agents.filter(listedAgent).map((agent) => {
                      const shaped = asAgent(agent);
                      return (
                        <li key={agent.id}>
                          <button
                            className="node-agent"
                            onClick={() => {
                              api.revealAgent(qualify(node.id, agent.id));
                              onNavigated();
                            }}
                            title={[`${agentLabel(shaped)} on ${node.name}`, agentSummary(shaped)].filter(Boolean).join(" · ")}
                          >
                            <Status agent={shaped} mascot={mascot} />
                            <span className="node-agent-name">{agentLabel(shaped)}</span>
                            {agent.unread && <span className="unread" aria-label="waiting for you" />}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            ) : (
              <li key={w.key}>
                <a className="node-ws" href={node.url} target="_blank" rel="noreferrer noopener" title={[w.name, w.folder, old].filter(Boolean).join("\n")}>
                  <span className="node-ws-name">{w.name}</span>
                  <span className="node-marks">
                    {w.agents.map((agent) => (
                      <span key={agent.id} className="node-mark" title={[agentLabel(asAgent(agent)), agentSummary(asAgent(agent))].filter(Boolean).join(" · ")}>
                        <Status agent={asAgent(agent)} mascot={mascot} />
                      </span>
                    ))}
                  </span>
                  {w.band === "needs" && <span className="unread" aria-label="needs you" />}
                </a>
              </li>
            ),
          )}
          {summary.workspaces.length === 0 && <li className="node-empty">No workspaces.</li>}
        </ul>
      ) : (
        <p className="node-empty">{up ? "Waiting for what it is doing…" : "Not heard from since this server started."}</p>
      )}
    </li>
  );
}

/** The rule this node's own Agents list draws by: a terminal that has had an agent in it. */
function listedAgent(agent: { agent: string | null; lastAgent?: string | null }): boolean {
  return Boolean(agent.agent || agent.lastAgent);
}

/**
 * Kuru's frog, face on: two eyes on top of a wide head. Another node is
 * another Kuru with its own agents, which is what sets it apart from the
 * machine beside it, a box kururu only types into over ssh. A line drawing
 * in the bar's gray, as the machines' rack is, rather than the app's green
 * logo, which would be the loudest thing on a bar that is quiet until
 * something is wrong. Drawn here as `ServerIcon` is: the icon set has none.
 */
function KuruIcon() {
  return (
    <svg className="glyph glyph-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="7" cy="8" r="3" />
      <circle cx="17" cy="8" r="3" />
      <path d="M4.6 10.2C3.2 11.7 3 14.6 4.4 16.6c1.9 2.6 13.3 2.6 15.2 0 1.4-2 1.2-4.9-.2-6.4" />
      <path d="M7 8h.01M17 8h.01M9.5 15c1.5.8 3.5.8 5 0" />
    </svg>
  );
}
