/**
 * The file or two an agent's turn ended in, as links — under its row in the
 * sidebar and on its card. Which files earn one is the server's decision
 * (`shared/made.ts`); this only draws them and opens one when asked.
 *
 * One component for both places because a link is the same promise in each:
 * a document opens in the reader, code in a new nvim tab at the line the
 * agent named, in the workspace the work is in. The icon says which of the
 * two a click will do before it is made, since the two land in very
 * different places.
 *
 * A link that fails says so where it was clicked, for a few seconds, rather
 * than in a dialog: the usual reason is a file that went a moment ago, and the
 * server takes the link away within seconds of that anyway. A dialog for a
 * link that is about to vanish would outlive the thing it was about.
 *
 * A link on another node's card — a remote workspace's board — names that
 * node's disk, its root qualified (`shared/remote.ts`), and opens there
 * through the same verb, which the server forwards. It wears the node's
 * chip, since a click on it changes a pane on another computer.
 */
import { useEffect, useState } from "react";
import { madeName, readsInReader, type MadeFile } from "../../../shared/made";
import { nodeOfId } from "../../../shared/remote";
import * as api from "../session";
import { Icon } from "./Icon";
import { NodeChip } from "./NodeChip";

/** How long a failed open says why, beside the links. */
const ERROR_MS = 4000;

/**
 * Opening a link, and what to say when it did not open. Shared by the links
 * here and the paths in Kuru's replies, which open the same way and fail for
 * the same reasons.
 */
function useOpenMade(workspaceId: string | null, onOpened: (() => void) | undefined) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), ERROR_MS);
    return () => clearTimeout(timer);
  }, [error]);
  const open = (file: MadeFile) => {
    setError(null);
    // A phone draws one pane, so the one the file lands in is the one it
    // should be drawing. `App` says which window this is on <html>.
    const narrow = document.documentElement.hasAttribute("data-narrow");
    api
      .openMade(file, workspaceId, narrow)
      .then(() => onOpened?.())
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };
  return { open, error };
}

export function MadeLinks({
  files,
  workspaceId,
  className,
  onOpened,
}: {
  files: readonly MadeFile[];
  /** Where to open it: the agent's workspace, the card's. Null leaves it to the server. */
  workspaceId: string | null;
  className?: string;
  /** Opened, for a container that should get out of the way — the sidebar over a phone. */
  onOpened?: () => void;
}) {
  const { open, error } = useOpenMade(workspaceId, onOpened);
  const { nodes } = api.useKururu();
  if (files.length === 0) return null;
  // One agent's or one card's files are all on one disk.
  const nodeId = nodeOfId(files[0]!.root);
  const nodeName = nodeId ? (nodes?.nodes.find((n) => n.id === nodeId)?.name ?? "another computer") : null;
  return (
    <span
      className={`made ${className ?? ""}`}
      // A card opens its editor on a double-click, and two quick clicks on a
      // link are somebody impatient, not somebody editing.
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {files.map((file) => (
        <button
          key={`${file.root}/${file.path}`}
          type="button"
          className="made-link"
          title={madeTitle(file, nodeName)}
          onClick={(event) => {
            event.stopPropagation();
            open(file);
          }}
        >
          <Icon name={readsInReader(file.path) ? "doc" : "code"} />
          <span className="made-name">{madeName(file)}</span>
          {file.line ? <span className="made-line">:{file.line}</span> : null}
        </button>
      ))}
      {nodeId && nodeName && <NodeChip nodeId={nodeId} name={nodeName} title={`These open on ${nodeName}`} />}
      {error && (
        <span className="made-error" role="status">
          {error}
        </span>
      )}
    </span>
  );
}

/**
 * A path in running text — one of Kuru's replies — drawn as a link in place,
 * in the words it was written in. The server found the file (`KuruFile`);
 * which workspace it opens in is the server's to work out from its project.
 */
export function MadeInline({ file, label, onOpened }: { file: MadeFile; label: string; onOpened?: () => void }) {
  const { open, error } = useOpenMade(null, onOpened);
  return (
    <>
      <button type="button" className="kuru-file" title={madeTitle(file)} onClick={() => open(file)}>
        {label}
      </button>
      {error && (
        <span className="made-error" role="status">
          {` ${error}`}
        </span>
      )}
    </>
  );
}

/** The whole path, and where a click takes it — on which computer, when it is not this one. */
export function madeTitle(file: MadeFile, node: string | null = null): string {
  const where = readsInReader(file.path) ? "in the reader" : `in nvim, in a new tab${file.line ? `, at line ${file.line}` : ""}`;
  return `${file.path}\nOpen ${where}${node ? `, on ${node}` : ""}`;
}
