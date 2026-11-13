/**
 * The tunnels' reaching out, kept apart from `tunnels.ts` so that what is
 * decided there is decided over plain values the test can make up. Every
 * call here has a short timeout and answers rather than throws: a tunnel
 * that does not answer is the reading, not an error.
 */
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import type { Probe } from "./tunnels";

/** A loopback port's JSON — cloudflared's metrics — or null. */
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
 * touched; redirects are not followed, since a redirect is an answer.
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
      headers: { "user-agent": "kururu-tunnel-check" },
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
