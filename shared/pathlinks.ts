/**
 * Two spellings of one folder, and how to compare a path in one with a path
 * in the other.
 *
 * A path reaches kururu from two kinds of place. Some are spelt the way a
 * person wrote them — a workspace's root in Settings, the folder a terminal
 * was opened in, the roots the branch walk learns by going up from those —
 * and keep any symbolic link they went through. Others are what the disk
 * says — the kernel's cwd of a process (`lsof`, `/proc`), git's own answers —
 * and never do. The owner's bpay workspace has its root at `~/…/pylink`, a
 * link to `bpay`, and its dashboard's cwd comes back as `…/bpay/
 * dashboard`: a prefix check between the two can never say the server is
 * that workspace's, and nothing on screen says why (2026-11-19).
 *
 * So the server, which can ask the disk, finds the deepest symbolic link each
 * root it learns goes through and sends it: `from` the linked folder as it
 * was spelt, `to` where it leads (`server/src/pathlinks.ts`). The folder that *is* the link rather than the root, so one
 * link also covers what sits beside the root under it — a card's worktree at
 * `app.worktrees/` is under a linked `~/code` exactly as `app` is — and never
 * a folder cut back by the names the two share, which would turn `~/Desktop/
 * kururu → ~/code/kururu` into `~/Desktop → ~/code` and send every other
 * folder on the Desktop along with it. A client, which cannot ask the disk,
 * follows those links before comparing.
 * Rewriting what is *drawn* into one spelling was the alternative, and the
 * wrong one: the spelling a root is kept under is what its settings and its
 * cards are keyed by (`mainRoot` in `server/src/worktree.ts` keeps it for that
 * reason), so the spelling stays and only the comparison follows the link.
 */

export interface PathLink {
  /** As kururu was told it: a folder that is, or is under, a symbolic link. */
  from: string;
  /** The same folder as the disk has it. */
  to: string;
}

/** Without a trailing slash, except the root itself. */
function trim(path: string): string {
  const out = path.replace(/\/+$/, "");
  return out === "" ? "/" : out;
}

/** Whether `path` is `root` or under it: a prefix check with its separator, so `/a/bc` is not under `/a/b`. */
export function within(path: string, root: string): boolean {
  const base = trim(root);
  const full = trim(path);
  return full === base || full.startsWith(base === "/" ? "/" : `${base}/`);
}

/**
 * `path` as the disk has it, as far as the links say: the longest link it is
 * under is followed, once — a link's `to` is already the disk's, so there is
 * nothing left to follow after it. A path under no link is itself.
 */
export function followLinks(path: string, links: readonly PathLink[]): string {
  let best: PathLink | null = null;
  for (const link of links) {
    if (within(path, link.from) && (!best || link.from.length > best.from.length)) best = link;
  }
  if (!best) return path;
  const rest = trim(path).slice(trim(best.from).length);
  return trim(`${trim(best.to)}${rest}`);
}

/** Whether `path` is `root` or under it, either spelt as given or once the links are followed. */
export function withinLinked(path: string, root: string, links: readonly PathLink[]): boolean {
  return within(path, root) || within(followLinks(path, links), followLinks(root, links));
}

/** Each link once, from however many roots said it. */
export function uniqueLinks(links: readonly PathLink[]): PathLink[] {
  const seen = new Map<string, PathLink>();
  for (const link of links) seen.set(`${link.from}\0${link.to}`, link);
  return [...seen.values()];
}
