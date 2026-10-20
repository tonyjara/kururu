/**
 * What the band over another node's workspace says: whose it is, whether
 * the link to it is up, and — for a moment — what could not be sent there.
 *
 * The panes of a remote workspace are drawn by the components every local
 * workspace is drawn by (`Panes.tsx`), so the one thing that has to be
 * added is the label, and it goes where the eye already reads which
 * workspace this is: the left end of the top band. While the watch is down
 * the panes keep what their emulators hold, greyed, because a window that
 * empties itself when a lid closes is a window nobody can read; the band
 * says since when, in the sidebar's words (`web/src/nodes.ts`).
 */
import { useEffect, useState } from "react";
import type { RemoteView } from "../../../shared/remote";
import { clock } from "../nodes";
import { useKururu } from "../session";
import { NodeChip } from "./NodeChip";

/** How long a refusal stays in the band. Long enough to read a sentence, short enough not to be mistaken for a state. */
const SAID_MS = 4_000;

/** The server's last refusal for this node, while it is fresh; null otherwise. */
export function useRemoteSaid(nodeId: string | null): string | null {
  const { remoteSaid } = useKururu();
  const fresh = !!remoteSaid && remoteSaid.node === nodeId && Date.now() - remoteSaid.at < SAID_MS;
  const [, expire] = useState(0);
  useEffect(() => {
    if (!fresh || !remoteSaid) return;
    const timer = setTimeout(() => expire((n) => n + 1), SAID_MS - (Date.now() - remoteSaid.at));
    return () => clearTimeout(timer);
  }, [fresh, remoteSaid]);
  return fresh ? remoteSaid.text : null;
}

/** The link to a watched node in a few words, or null while it is up and there is nothing to say. */
function stateWords(remote: RemoteView): string | null {
  if (remote.state === "up") return null;
  if (remote.state === "opening") return "connecting…";
  return remote.since ? `away since ${clock(remote.since)}` : "away";
}

export function RemoteBand({ remote, said }: { remote: RemoteView; said: string | null }) {
  const words = stateWords(remote);
  return (
    <span className="remote-band">
      <NodeChip
        nodeId={remote.node.id}
        name={remote.node.name}
        className="node-chip-band"
        title={`${remote.node.name}'s workspace: its terminals run there, and this window types into them${words ? `\n${words}` : ""}`}
      >
        {words && <span className="node-chip-state">{words}</span>}
      </NodeChip>
      {said && (
        <span className="remote-said" role="status">
          {said}
        </span>
      )}
    </span>
  );
}

/** The pane area before the node has said what its workspace is: the first second of a watch, or a workspace it no longer has. */
export function RemoteWaiting({ remote }: { remote: RemoteView }) {
  const words = stateWords(remote);
  return (
    <div className="remote-waiting">
      <NodeChip nodeId={remote.node.id} name={remote.node.name} className="node-chip-band">
        {words && <span className="node-chip-state">{words}</span>}
      </NodeChip>
      <p className="muted">
        {remote.state === "up"
          ? `${remote.node.name} has no workspace by that name any more.`
          : remote.state === "opening"
            ? `Opening ${remote.node.name}'s workspace…`
            : `${remote.node.name} cannot be reached. Its workspace comes back here when it does.`}
      </p>
    </div>
  );
}
