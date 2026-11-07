/**
 * The address to send a browser to for a dev server, worked out from the
 * address this window is already at.
 *
 * Nothing here is configured and nothing is detected. Whatever host the client
 * typed to reach kururu is, by construction, a host that reaches the machine
 * kururu is running on — it is the tailnet IP when you are on your phone, a LAN
 * address on the same Wi-Fi, `127.0.0.1` in the Electron window, and the right
 * answer in all three without kururu ever learning which. `reach.ts` makes the
 * same argument from the other side about the port: a client builds its URL
 * from where it is itself loaded from, because that is the one address it has
 * proof of.
 *
 * The port is the exception, and it is never `location.port`. In `bun run
 * dev:web` the page comes from vite on 5173 while the server is on 7717, so the
 * port on the address bar is not even kururu's; the preview proxy is on 7800+
 * regardless and the server is the only thing that knows which. So: hostname
 * from here, port from the snapshot.
 *
 * Loopback is handled separately rather than being allowed to fall through the
 * proxy, because on the desktop the dev server is a direct hop away and the
 * extra one buys nothing — no Host to rewrite for a request already saying
 * localhost, no frame headers to strip outside an iframe. It also means the
 * desktop window keeps working for a dev server the scan found before a proxy
 * had been opened for it. (The element picker PLAN.md once had injected by
 * the proxy is the browser tab's marking now — docs/plans/browser-annotate.md
 * — which needs no proxy, so this stays as it is.)
 */
import type { DevServer } from "../../shared/wire";

/** Where a page is, reduced to the two fields that decide this. */
export interface Origin {
  protocol: string;
  hostname: string;
}

/**
 * Hosts that mean "the machine this page is running on". A phone's own loopback
 * is the phone, which is the entire reason the proxy exists, so getting this
 * set wrong in the generous direction sends the phone to itself — a connection
 * refused that looks exactly like a dev server that is not running.
 */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

export function isLoopback(hostname: string): boolean {
  return LOOPBACK.has(hostname.toLowerCase());
}

/**
 * The URL for this dev server, or null when there is not one to give yet.
 *
 * Null is a real answer and the caller must draw something else for it: a
 * remote client whose proxy has not been opened yet has no address that works,
 * and an anchor pointing at the dev port would reach the *phone's* own
 * localhost. A row with no link says the server is there and not reachable from
 * here, which is true; a link that goes nowhere is a bug report.
 */
export function previewUrl(origin: Origin, dev: DevServer): string | null {
  if (isLoopback(origin.hostname)) return `http://localhost:${dev.port}/`;
  if (!dev.proxyPort) return null;
  /**
   * The page's own protocol, not a hardcoded `http:`. Over plain tailscale both
   * are http and it does not come up; behind `tailscale serve --https` the page
   * is https and this link is a downgrade the browser allows for a top-level
   * navigation and would block inside an iframe. Carrying the protocol across
   * means the day that setup grows a `serve` line per preview port, this is
   * already correct.
   */
  return `${origin.protocol}//${origin.hostname}:${dev.proxyPort}/`;
}

/**
 * Where a dev server's row in the sidebar goes: the server's page, or for
 * Metro its `/status`. Metro's own root is the app's web build, which a native
 * app's project need not have and which takes a bundle to say anything at all;
 * `/status` answers `packager-status:running` at once, which is the question
 * the row is asked — is the app's server up, and on which port. The address a
 * dev build's launcher wants (this host and that port) is in the row's hover.
 * Only the sidebar's row: a card's preview is `previewUrl` as it was.
 */
export function devServerUrl(origin: Origin, dev: DevServer): string | null {
  const url = previewUrl(origin, dev);
  return url && dev.metro ? `${url}status` : url;
}

/**
 * The address to type into a dev build's launcher for a Metro server: this
 * host, Metro's own port. Not through the proxy, which says `localhost` to
 * Metro and gets bundle addresses back that only work on the Mac; Metro
 * listens on every interface, so the host this page came by reaches it.
 */
export function metroAddress(origin: Origin, dev: DevServer): string {
  return `http://${origin.hostname}:${dev.port}`;
}

/** A workspace as a dev server is named after it: its name and its project folder. */
export interface NamedRoot {
  name: string;
  root: string;
}

function trimmed(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function within(path: string, root: string): boolean {
  const r = trimmed(root);
  const p = trimmed(path);
  return p === r || p.startsWith(r === "/" ? "/" : `${r}/`);
}

/** A name or a folder reduced to what both spell alike: "Tile Bandit" and `tile-bandit`. */
function spelled(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** Whether a workspace is named after its own project folder: Pasapy on `…/pasapy`. */
function namedFor(place: NamedRoot): boolean {
  const folder = trimmed(place.root).split("/").pop() ?? "";
  return folder !== "" && spelled(folder) === spelled(place.name);
}

/**
 * Whether `place` is the better name than `best` for a server both hold: the
 * deeper root, and between two on the same root, the one named after it.
 *
 * Two workspaces on one root is ordinary, because a workspace's root is
 * wherever its focused pane is, and a pane goes wherever a document is opened
 * from. Tile Bandit with Pasapy's `docs/simulate-event.md` open in it is on
 * `~/…/pasapy` exactly as Pasapy is, and the first in the list used to win,
 * so a Pasapy server read "Tile Bandit" (the user, 2026-11-07). The name is
 * the one thing that says which of them the folder belongs to; with neither
 * named for it, the first still wins, so the label holds still.
 */
function outranks(place: NamedRoot, best: NamedRoot): boolean {
  const depth = trimmed(place.root).length - trimmed(best.root).length;
  if (depth !== 0) return depth > 0;
  return namedFor(place) && !namedFor(best);
}

/**
 * What to call a dev server in a list: the workspace it came from, and nothing
 * else (the user, 2026-11-07). It was the folder's name and the program —
 * `web · next dev`, `holapy · vite` — and in a monorepo the folder is `web` in
 * every project, which says nothing; the program is in the hover with the
 * command. Two servers of one workspace read the same, and the port beside
 * the name is what tells them apart.
 *
 * The workspace whose project folder holds the server's, or failing that holds
 * the main checkout of the server's repository — which is how a worktree kept
 * outside the project (`pasapy-wt/simulacro/apps/web`) is still Pasapy's. The
 * deepest root wins, so a workspace on `~/code` does not take a server from
 * one on `~/code/app`. With no workspace, the project folder's own name: the
 * repository's, then the folder's, then the program when not even the folder
 * could be read.
 */
export function previewLabel(dev: DevServer, workspaces: readonly NamedRoot[] = []): string {
  let best: NamedRoot | null = null;
  for (const place of workspaces) {
    if (!place.root) continue;
    const holds = (dev.cwd && within(dev.cwd, place.root)) || (dev.repo && within(dev.repo, place.root));
    if (holds && (!best || outranks(place, best))) best = place;
  }
  if (best) return best.name;
  const folder = dev.repo ?? dev.cwd;
  return folder?.split("/").filter(Boolean).pop() ?? dev.program;
}

/**
 * The dev server a card's worktree is being served on, of those the scan found:
 * one whose directory is the worktree or under it, and of those the one on the
 * port it was offered, else the lowest. By directory rather than by port
 * because the port offered is a suggestion — vite ignores `PORT` and takes the
 * next free one after its own — and a project whose dev line starts two
 * servers has both in the worktree; the offered port is only the tie-break.
 */
export function serverIn(servers: DevServer[], path: string, offered: number): DevServer | null {
  const inside = servers.filter((dev) => dev.cwd === path || dev.cwd?.startsWith(`${path}/`));
  return inside.find((dev) => dev.port === offered) ?? inside[0] ?? null;
}
