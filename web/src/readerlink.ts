/**
 * What a click on a link in rendered markdown should do, decided from its
 * `href` alone.
 *
 * It exists because the browser's own answer is wrong for nearly every link a
 * document can hold. The page *is* kururu: a link the browser follows replaces
 * the whole app with whatever it pointed at. `markdown.ts` rewrites a relative
 * path into a `/api/file-raw` URL so that an image beside the document can be
 * fetched, and a link to `bancard.md` in a README got the same rewrite — so
 * clicking it took the window to a JSON error, which on 2026-11-11 read as
 * kururu crashing. Only `#heading` links were caught before, and only because
 * the browser would otherwise write the fragment into the app's own URL.
 *
 * So every link is classified here and none is left to the browser except the
 * ones the server already sends out of the window. A markdown file is a
 * document for the reader, resolved by the server against the document it was
 * written in (the `path` in the rewritten URL is already relative to the
 * root). Any other file of the project is opened outside the window, where it
 * cannot replace anything. Everything else does nothing, which is the safe
 * reading of a link nobody can say the meaning of.
 *
 * Pure, so it is tested without a page (`web/test/readerlink.test.ts`).
 */
import { fragmentOf } from "./readerplace";

export type ReaderLink =
  /** A heading in the document already drawn. */
  | { kind: "anchor"; fragment: string }
  /** A markdown file of the same root, for the reader, and a heading in it if one was named. */
  | { kind: "doc"; path: string; fragment: string | null }
  /** Another file of the project, which the window must not navigate to. */
  | { kind: "file"; href: string }
  /** Somewhere outside kururu altogether — a web page or a mail. */
  | { kind: "out"; href: string }
  /** Nothing anybody can follow: an emptied scheme, a path the server did not write. */
  | { kind: "none" };

/** The files the reader draws itself; the same list as the tree's `MARKDOWN`. */
const DOC = /\.(md|markdown|mdx)$/i;

/** `/api/file-raw?…` and a node's `/api/node/<id>/file-raw?…` (`http/nodes.ts` rewrites one into the other). */
const FILE_RAW = /^\/api\/(?:node\/[^/?#]+\/)?file-raw\?/;

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * `current` is the path of the document the link is in, so that a link to the
 * document itself with a fragment is a scroll rather than a reopening.
 */
export function readerLink(href: string | null, current: string): ReaderLink {
  if (!href) return { kind: "none" };
  if (href.startsWith("#")) {
    const fragment = fragmentOf(href);
    return fragment === null ? { kind: "none" } : { kind: "anchor", fragment };
  }
  if (/^(https?:)?\/\//i.test(href) || /^mailto:/i.test(href)) return { kind: "out", href };
  if (!FILE_RAW.test(href)) return { kind: "none" };

  let url: URL;
  try {
    url = new URL(href, "http://kururu.invalid");
  } catch {
    return { kind: "none" };
  }
  let path = url.searchParams.get("path") ?? "";
  let fragment = url.hash.length > 1 ? decoded(url.hash.slice(1)) : null;
  // A server from before the fragment was kept apart put `a.md#part` into the
  // path itself, where it named a file that is not there. Markdown means a
  // fragment by `#` in a link, so it is split off here as well.
  const hash = path.indexOf("#");
  if (hash >= 0) {
    fragment ??= path.length > hash + 1 ? path.slice(hash + 1) : null;
    path = path.slice(0, hash);
  }
  if (!path || path === ".") return { kind: "none" };
  if (!DOC.test(path)) return { kind: "file", href: url.hash ? href.slice(0, href.indexOf("#")) : href };
  if (path === current) return fragment ? { kind: "anchor", fragment } : { kind: "none" };
  return { kind: "doc", path, fragment };
}
