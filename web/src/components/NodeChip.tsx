/**
 * Another node's name, in its own hue: what every remote thing on this
 * screen wears so it is never mistaken for one of this machine's — the
 * band over a remote workspace's panes, each of its tabs, the sidebar's
 * heading for it.
 *
 * The machines chip's shape (`.remote-mark`), with the hue added, because
 * the two say the same kind of fact — this is somewhere else — and differ
 * in what the somewhere is: a machine is an ssh host kururu types into, a
 * node is another kururu doing the work itself. The hue is the node's own
 * (`nodeHue`, off its id), reached as one of the board palette's tokens, so
 * every theme says what it looks like and no hex is written anywhere.
 */
import type { CSSProperties, ReactNode } from "react";
import { nodeHue } from "../../../shared/remote";

/** The custom property a node's hue is set through, for a box that tints itself by it. */
export function hueStyle(nodeId: string): CSSProperties {
  return { "--node-hue": `var(--ws-${nodeHue(nodeId)})` } as CSSProperties;
}

export function NodeChip({
  nodeId,
  name,
  title,
  className = "",
  children,
}: {
  nodeId: string;
  name: string;
  title?: string;
  className?: string;
  /** Said after the name, inside the chip: "away since 23:10". */
  children?: ReactNode;
}) {
  return (
    <span className={`node-chip ${className}`} style={hueStyle(nodeId)} title={title ?? `On ${name}: another kururu does this work, and this window shows it`}>
      <span className="node-chip-dot" aria-hidden="true" />
      <span className="node-chip-name">{name}</span>
      {children}
    </span>
  );
}
