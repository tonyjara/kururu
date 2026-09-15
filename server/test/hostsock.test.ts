/**
 * The framing, which is the only thing the socket transport adds and therefore
 * the only thing it can get wrong.
 *
 * A `MessagePort` hands the other side an object; a socket hands it bytes, and
 * every difference between the two lives in how those bytes are cut back into
 * messages. Two of the cuts are load bearing and neither is visible from the
 * types. Frames are separated by newlines, which is safe only because
 * `JSON.stringify` escapes the newlines *inside* a string — and the payload here
 * is terminal output, which is nothing but control characters and newlines. And
 * a read boundary has nothing to do with a UTF-8 character boundary, so a
 * multi-byte character split across two reads must not become two replacement
 * characters in somebody's terminal.
 *
 * No pty anywhere: this is two ports and a socket in a temp directory.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:net";
import { connectToHost, serveHostSocket, type SocketPort } from "../src/hostsock";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

/** A listening host and a connected server, both started. */
async function pair(): Promise<{ host: SocketPort; client: SocketPort }> {
  const dir = mkdtempSync(join(tmpdir(), "kururu-"));
  const path = join(dir, "h.sock");

  let accepted: (port: SocketPort) => void;
  const incoming = new Promise<SocketPort>((resolve) => (accepted = resolve));
  const server: Server = await serveHostSocket(path, (port) => accepted(port));

  const client = await connectToHost(path);
  const host = await incoming;

  cleanup.push(() => {
    client.close?.();
    host.close?.();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { host, client };
}

/** The next message to arrive on a port, once it has been started. */
function next(port: SocketPort): Promise<unknown> {
  return new Promise((resolve) => {
    port.on("message", (event) => resolve(event.data));
    port.start?.();
  });
}

describe("the host socket", () => {
  it("carries a message each way", async () => {
    const { host, client } = await pair();
    const toHost = next(host);
    const toClient = next(client);

    client.postMessage({ type: "hello", id: 1 });
    expect(await toHost).toEqual({ type: "hello", id: 1 });

    host.postMessage({ type: "reply", id: 1, ok: true, result: { agents: [] } });
    expect(await toClient).toEqual({ type: "reply", id: 1, ok: true, result: { agents: [] } });
  });

  /**
   * The frame separator inside the payload, which is what a terminal emits all
   * day. If this ever fails, every message after the first newline of output is
   * being read as a frame of its own and discarded as unparseable.
   */
  it("survives a payload full of newlines, escapes and multibyte characters", async () => {
    const { host, client } = await pair();
    const arrived = next(client);

    const data = `${String.fromCharCode(27)}[2J\nline one\r\nline two\n\ttabbed — em dash, 日本語, 🐸\n`;
    host.postMessage({ type: "output", agentId: "a1", data });

    expect(await arrived).toEqual({ type: "output", agentId: "a1", data });
  });

  /**
   * `start()` is a MessagePort's way of saying "my handler is attached now", and
   * both ends of the link call it. A socket has no such gate and will deliver a
   * reply into an empty listener list, so the gate is kept — losing the first
   * message means losing `hello`, which is the one that carries every agent.
   */
  it("holds messages that arrive before anybody is listening", async () => {
    const { host, client } = await pair();

    host.postMessage({ type: "agents", agents: [{ id: "a1" }] });
    // Long enough for the bytes to have crossed and been parsed.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const received: unknown[] = [];
    client.on("message", (event) => received.push(event.data));
    client.start?.();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(received).toEqual([{ type: "agents", agents: [{ id: "a1" }] }]);
  });

  /**
   * `sun_path` is 104 bytes on macOS and the kernel's complaint is a bare
   * `EINVAL` that names no limit and says nothing about paths. Refused with a
   * sentence instead, and refused rather than truncated for `files.ts`'s reason:
   * a clamped path is a bug that looks like it worked.
   */
  it("refuses a socket path longer than a socket path can be", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kururu-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const tooLong = join(dir, `${"x".repeat(120)}.sock`);

    await expect(serveHostSocket(tooLong, () => {})).rejects.toThrow(/unix socket allows/);
  });
});
