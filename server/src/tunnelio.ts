/**
 * The tunnels' reaching out, kept apart from `tunnels.ts` so that what is
 * decided there is decided over plain values the test can make up. Every
 * call here has a short timeout and answers rather than throws: a tunnel
 * that does not answer is the reading, not an error.
 */
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { stateDir, writeAtomic } from "./fsutil";
import type { Probe, PublicLook } from "./tunnels";

/** A loopback port's JSON — ngrok's API, cloudflared's metrics — or null. */
export async function localJson(port: number, path: string): Promise<unknown> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

/**
 * A HEAD of `/` at a tunnel's public address. HEAD rather than GET so that a
 * page is never rendered for it, and `/` so that no webhook route is
 * touched; redirects are not followed, since a redirect is an answer. The
 * `ngrok-skip-browser-warning` header keeps ngrok's free plan from answering
 * with its interstitial instead of the app.
 */
export async function probeUrl(url: string): Promise<Probe> {
  let root: string;
  try {
    root = new URL("/", url).toString();
  } catch {
    return { error: "not an address" };
  }
  try {
    const res = await fetch(root, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      headers: { "user-agent": "kururu-tunnel-check", "ngrok-skip-browser-warning": "1" },
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));
    return { status: res.status, headers };
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    const name = (err as Error).name;
    return { error: name === "TimeoutError" ? "timed out after 15s" : (cause ?? (err as Error).message) };
  }
}

function tryConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(2_000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** Whether something on this machine takes a connection on the port, over IPv4 or IPv6 — a dev server binds either. */
export async function reachablePort(port: number): Promise<boolean> {
  return (await tryConnect("127.0.0.1", port)) || (await tryConnect("::1", port));
}

export async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** Where the last look from outside at each address is kept, beside the host's socket. */
function askedPath(): string {
  return join(stateDir(), "tunnels.json");
}

/** `TunnelDeps.asked`: the kept looks, read once at start and written after each. */
export const askedFile = {
  load: async (): Promise<Record<string, unknown>> => {
    const text = await readTextFile(askedPath());
    try {
      const parsed: unknown = text ? JSON.parse(text) : {};
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  },
  save: (asked: Record<string, PublicLook>): void => {
    try {
      writeAtomic(askedPath(), JSON.stringify(asked));
    } catch {
      // A look not kept is asked again after a restart; nothing worse.
    }
  },
};
