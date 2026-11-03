/**
 * A markdown file pointed at in Kuru's box, as a card is: by its name off the
 * reader's tab menu ("Reference in Kuru"), or by a passage selected in the
 * reader and quoted with a comment, which is how a question about one part
 * of a long document gets asked without pasting it.
 *
 * **The path as the project spells it, and the project beside it.** Kuru
 * runs in a folder of its own, so a bare `docs/terminals.md` names nothing it
 * can open; a whole `/Users/…/kururu/docs/terminals.md` names it, and loses
 * which part of it is the project's own spelling — the one the user reads
 * in the tree, and the one Kuru is told to write paths in. So a file in a
 * project is written the project's way, with the project after it in
 * parentheses as a card's place is: `[file docs/terminals.md
 * (~/Desktop/Nyto/kururu)]`. A file in no project is written whole, from
 * `~`: `[file ~/Documents/Kururu/reports/x.md]`. A home directory counts as
 * no project, though a shell standing in it makes it one of a workspace's
 * roots — `Documents/x.md (~)` would be a project-relative path to nothing
 * anybody calls a project.
 *
 * **Where in the file, for a quote — near enough, and never instead of the
 * quote.** The rendered blocks carry the line they begin on (`data-line`,
 * `server/src/markdown.ts`), so a quote says the line its first block begins
 * on, and the line its last block begins on when that is another one —
 * `:40-52` — with the nearest heading above it. Both are a place to start
 * reading; the quote's two ends are what find the passage, since what was
 * selected is the text as drawn, without its markdown marks. A line range
 * ending where the passage ends would need the renderer to say where each
 * block stops, which is a server change for a hint.
 *
 * Pure, apart from `placeIn`, which reads a selection's place off the
 * reader's DOM; the tests hold the rest to the shape `chips.ts` reads back.
 */
import { cutQuoted } from "../../shared/reply";
import { parseRemote } from "../../shared/remote";

/** A file as a reference names it. */
export interface FileRef {
  /** The project's own spelling of the file's path, or — when `project` is null — the whole path, from `~` where it can be. */
  path: string;
  /** The project the path is in, from `~`, with a node's name and a colon in front for another node's; null for a file in none. */
  project: string | null;
}

/** Where in the file a quote is: the lines its first and last blocks begin on, and the nearest heading above it. */
export interface FilePlace {
  line: { from: number; to: number } | null;
  heading: string | null;
}

/** How much of a heading a reference carries. */
export const FILE_HEADING_MAX = 60;

/**
 * A path from `~` when it is in a home directory — `/Users/me` on a Mac,
 * `/home/me` on Linux, `/root`. Read off the path's shape because the page
 * is never told whose home it is; a path that only looks like one written
 * as `~/…` is still one Kuru expands to the same place on its own computer.
 */
export function tildePath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)|^\/root(?=\/|$)/, "~");
}

/** `root` and `path` as one path, with `.` and `..` worked out — a reader's path is relative to its root. */
export function joinPath(root: string, path: string): string {
  const parts: string[] = [];
  for (const part of `${path.startsWith("/") ? "" : root}/${path}`.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/**
 * A reader's file — its root as the tab holds it, which is qualified for
 * another node's, and its path under that root — as a reference names it.
 * `projects` are this node's workspace roots; the deepest one holding the
 * file is its project. Another node's projects are not known here, so a file
 * of another node's is put in the root its reader was opened on, which is
 * that workspace's project or a folder kururu found the file by.
 */
export function fileRefOf(root: string, path: string, projects: readonly string[], nameOf: (node: string) => string | null): FileRef {
  const remote = parseRemote(root);
  const dir = remote ? remote.id : root;
  const full = joinPath(dir, path);
  const on = remote ? `${nameOf(remote.node) ?? remote.node}:` : "";
  let best: string | null = null;
  for (const candidate of remote ? [dir] : projects) {
    const project = joinPath(candidate, ".");
    if (tildePath(project) === "~" || project === "/") continue;
    if (full.startsWith(`${project}/`) && (!best || project.length > best.length)) best = project;
  }
  if (best) return { path: full.slice(best.length + 1), project: on + tildePath(best) };
  return { path: on + tildePath(full), project: null };
}

/**
 * The reference — `[file docs/terminals.md (~/Desktop/Nyto/kururu)]`, and
 * with a place `[file docs/terminals.md:40-52 (~/Desktop/Nyto/kururu) under
 * "The pool"]`. The line rides on the path as an editor's `path:line` does;
 * the heading is quoted, a `"` in it a `'`, cut short as a card's title is.
 */
export function fileReference(ref: FileRef, place: FilePlace | null = null): string {
  const line = place?.line;
  const lines = line ? `:${line.from}${line.to > line.from ? `-${line.to}` : ""}` : "";
  const project = ref.project ? ` (${ref.project})` : "";
  const heading = place?.heading ? cutQuoted(place.heading.replace(/[[\]]/g, ""), FILE_HEADING_MAX) : "";
  return `[file ${flat(ref.path)}${lines}${project ? flat(project) : ""}${heading ? ` under "${heading}"` : ""}]`;
}

/** A path kept on one line, since a reference is one. */
function flat(text: string): string {
  return text.replace(/[\r\n]+/g, " ");
}

/** The line a block of the reader begins on, or null for one with none. */
function lineOf(block: Element | null | undefined): number | null {
  const n = Number((block as HTMLElement | null | undefined)?.dataset?.line);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Where a selection is in the document `host` draws. The block a point is in
 * is the innermost one with a line; a fence the highlighter drew has none,
 * and the last block before it stands in. The heading is the last one that
 * begins before the selection does, the selection's own when it starts in it.
 */
export function placeIn(host: HTMLElement, range: Range): FilePlace {
  const blocks = [...host.querySelectorAll<HTMLElement>("[data-line]")];
  const before = (el: Element, node: Node) => el === node || el.contains(node) || (el.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  const at = (container: Node, offset: number): number | null => {
    const node = container.nodeType === Node.ELEMENT_NODE ? (container.childNodes[offset] ?? container) : container;
    const el = node instanceof Element ? node : node.parentElement;
    const own = el?.closest("[data-line]");
    if (own && host.contains(own)) return lineOf(own);
    let found: number | null = null;
    for (const block of blocks) {
      if (!before(block, node)) break;
      found = lineOf(block) ?? found;
    }
    return found;
  };
  const from = at(range.startContainer, range.startOffset);
  const to = at(range.endContainer, range.endOffset);
  let heading: string | null = null;
  const start = range.startContainer.nodeType === Node.ELEMENT_NODE ? (range.startContainer.childNodes[range.startOffset] ?? range.startContainer) : range.startContainer;
  for (const h of host.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    if (!before(h, start)) break;
    heading = (h.textContent ?? "").replace(/\s+/g, " ").trim() || heading;
  }
  return { line: from ? { from, to: to && to > from ? to : from } : null, heading };
}
