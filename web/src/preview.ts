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
 * had been opened for it. (When the element picker lands it is injected by the
 * proxy, and this is the line that will have to go: the picker is worth a hop.)
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

/** What to call a dev server in a list: the project it is in, then the program. */
export function previewLabel(dev: DevServer): string {
  const project = dev.cwd ? dev.cwd.split("/").filter(Boolean).pop() : undefined;
  return project ? `${project} · ${dev.program}` : dev.program;
}
