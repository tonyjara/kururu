/**
 * What is currently being dragged, so the thing under the pointer can react.
 *
 * This exists because of one rule in the drag-and-drop spec: `dataTransfer` is
 * readable on `drop` and *not* on `dragover`. That is a sensible privacy rule for
 * something dragged in from another window and a nuisance for something dragged
 * across one page — a pane cannot ask what is in flight while deciding whether
 * to light up, which is exactly when it needs to know.
 *
 * So a drag that starts inside kururu announces itself here as well as on the
 * event. The payload still travels on `dataTransfer`, which is what makes the
 * drop work; this is only for deciding what to show on the way.
 */
import { useSyncExternalStore } from "react";

/** Kururu's own drag types. Anything else dropped on the window is ignored. */
export const AGENT_MIME = "application/x-kururu-agent";
export const PANE_MIME = "application/x-kururu-pane";
export const WORKSPACE_MIME = "application/x-kururu-workspace";
/**
 * A document's tab. Its id is `docId(pane, index)` — the same document can be
 * open in two panes, so the drag carries where it is rather than what it is.
 */
export const DOC_MIME = "application/x-kururu-doc";
/**
 * A markdown file out of the tree, on its way to becoming a tab. Its id is
 * `fileId(root, path)`: it has no place in any strip yet, so it goes by the
 * address `files.ts` answers to, and the server checks it like any other.
 */
export const FILE_MIME = "application/x-kururu-file";
/** A group of workspaces, by its heading. Its id is the group's name — see `Workspace.group`. */
export const GROUP_MIME = "application/x-kururu-group";

export type DragKind = "agent" | "pane" | "workspace" | "doc" | "file" | "group";
export type Dragging = { kind: DragKind; id: string } | null;

const MIME: Record<DragKind, string> = {
  agent: AGENT_MIME,
  pane: PANE_MIME,
  workspace: WORKSPACE_MIME,
  doc: DOC_MIME,
  file: FILE_MIME,
  group: GROUP_MIME,
};

export function docId(paneId: string, index: number): string {
  return `${index}:${paneId}`;
}

/** The two halves of a `docId`, or null for anything that is not one. */
export function parseDocId(id: string): { paneId: string; index: number } | null {
  const colon = id.indexOf(":");
  const index = Number(id.slice(0, colon));
  if (colon < 1 || !Number.isInteger(index) || index < 0) return null;
  return { paneId: id.slice(colon + 1), index };
}

export function fileId(root: string, path: string): string {
  return JSON.stringify([root, path]);
}

/** The two halves of a `fileId`, or null for anything that is not one. */
export function parseFileId(id: string): { root: string; path: string } | null {
  try {
    const parsed: unknown = id ? JSON.parse(id) : null;
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [root, path] = parsed as unknown[];
    return typeof root === "string" && typeof path === "string" && path ? { root, path } : null;
  } catch {
    return null;
  }
}

let dragging: Dragging = null;
const listeners = new Set<() => void>();

function set(next: Dragging): void {
  dragging = next;
  for (const listener of listeners) listener();
}

/**
 * Call from `dragstart`: puts the payload on the event and announces it here.
 *
 * Note the guard callers need around it. A pane is dragged by its tab strip and
 * a tab is dragged by itself, so the strip contains draggable children — and
 * `dragstart` *bubbles*, which means a tab drag reaches the strip's handler too.
 * Whoever is the actual source has to check `event.target === event.currentTarget`
 * before claiming the drag, or picking up a tab would put a whole pane in flight.
 */
export function beginDrag(event: React.DragEvent, kind: DragKind, id: string): void {
  event.dataTransfer.setData(MIME[kind], id);
  event.dataTransfer.effectAllowed = "move";
  set({ kind, id });
}

/**
 * Call from `dragend`. It fires even when the drop happened somewhere that did
 * not accept it, or outside the window entirely, which is why the highlight is
 * cleared here rather than in the drop handlers.
 */
export function endDrag(): void {
  if (dragging) set(null);
}

/** Let this element be dropped on. Without the preventDefault there is no drop. */
export function allowDrop(event: React.DragEvent): void {
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDragging(): Dragging {
  return useSyncExternalStore(subscribe, () => dragging);
}
