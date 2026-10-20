/**
 * Which disk a read goes to: this server's routes for a root of its own, and
 * `/api/node/<id>/…` for a root of another node's — the file tree, the
 * reader and the picker of a remote workspace on this screen.
 *
 * It exists so that none of those components learns there are two disks. A
 * root of a child's reaches the page qualified (`shared/remote.ts`), so the
 * root a component already holds says whose it is, and the URL is decided
 * here once: the qualification stripped, since the node checks its own
 * roots, and the node put in the path, where the server answering it reads
 * it. A reader with no root yet — the picker asking which project — names
 * its node by hand.
 */
import { parseRemote } from "../../shared/remote";

export type Read = "ls" | "docs" | "markdown" | "file-raw";

export function readUrl(read: Read, params: { root: string; path?: string }, node: string | null = null): string {
  const remote = parseRemote(params.root);
  const on = remote?.node ?? node;
  const query = new URLSearchParams({ root: remote?.id ?? params.root });
  if (params.path !== undefined) query.set("path", params.path);
  return on ? `/api/node/${on}/${read}?${query}` : `/api/${read}?${query}`;
}
