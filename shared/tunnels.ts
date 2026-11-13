/**
 * Which dev server a tunnel is for, decided the one way both ends need it.
 *
 * A tunnel says what it forwards to (`http://localhost:3006`) and a dev server
 * says what it listens on (`:3006`), and nothing else ties the two: cloudflared
 * was typed into one shell and `pnpm dev` into another, often in different
 * workspaces' tabs, and neither process is the other's parent. The port is
 * the whole of the pairing, so a tunnel to a port nothing listens on is a
 * tunnel of its own, drawn and listed apart — which is also the one worth
 * seeing, since nothing is answering it.
 *
 * Pure, for the sidebar and for `kururu_status` alike; the finding and the
 * checking are `server/src/tunnels.ts`.
 */
import type { DevServer, Tunnel } from "./wire";

/** The tunnels forwarding to `port`, up ones first. */
export function tunnelsOn(port: number, tunnels: readonly Tunnel[]): Tunnel[] {
  return tunnels.filter((t) => t.port === port).sort((a, b) => rank(a) - rank(b));
}

/** The tunnels no dev server in the list is listening for. */
export function unpairedTunnels(tunnels: readonly Tunnel[], servers: readonly Pick<DevServer, "port">[]): Tunnel[] {
  const ports = new Set(servers.map((s) => s.port));
  return tunnels.filter((t) => t.port === null || !ports.has(t.port));
}

function rank(t: Tunnel): number {
  return t.health === "up" ? 0 : t.health === "unknown" ? 1 : t.health === "down" ? 2 : 3;
}

/** The address without its scheme, which is what a person reads and repeats. */
export function tunnelHost(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, "").replace(/\/$/, "");
}

/** Whether any tunnel wants looking at: one down or gone. */
export function anyTunnelDown(tunnels: readonly Tunnel[]): boolean {
  return tunnels.some((t) => t.health === "down" || t.health === "gone");
}

/** One word for a tunnel's state, as the sidebar and the status say it. */
export function healthWord(t: Pick<Tunnel, "health">): string {
  return t.health === "gone" ? "stopped" : t.health === "unknown" ? "checking" : t.health;
}
