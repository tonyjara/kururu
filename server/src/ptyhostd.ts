/**
 * The pty host, as a process of its own that nothing owns.
 *
 * This replaces `ptyhost-main.ts`, which was the same host wired to Electron's
 * `parentPort`. The wiring is the whole difference and it is not a small one:
 * forked by Electron, the host was Electron's child and died with the app, so
 * every agent in kururu was a thing you lost by quitting the window. Listening
 * on a socket instead, it belongs to nobody — the window is one client of it,
 * the phone reaches it through a server that is another, and closing either is
 * a thing that costs a repaint.
 *
 * What has not changed is the rule about editing this side of the link: the ptys
 * are in here and a live pty cannot be handed to a replacement process, so
 * restarting *this* still ends every agent. The difference is that now it is the
 * only thing that does.
 *
 * It does not exit on its own, and that is the point rather than an oversight. A
 * host with no server attached is the normal state between two servers, and one
 * holding an exited agent is holding the only record of what that agent said —
 * `host.ts` keeps its screen exactly so a pane opened later can show it. So it
 * waits, and it is stopped the way any daemon is: a signal, which it answers by
 * reaping its ptys first.
 */
import { unlinkSync } from "node:fs";
import type { Server } from "node:net";
import { connectToHost, hostSocketPath, serveHostSocket, type SocketPort } from "./hostsock";
import { createPtyHost } from "./ptyhost";

const path = hostSocketPath();
const host = createPtyHost();

/**
 * The server currently attached, if any.
 *
 * One at a time, deliberately. The host holds one blob of arrangement and pushes
 * output to one place, and two servers sharing that would each see the other's
 * idea of the layout arrive as their own. A second connection is therefore
 * treated as what it almost always is — the same server, restarted, arriving
 * before the old socket's FIN did — and the older one is dropped.
 */
let attached: SocketPort | null = null;

function onConnection(port: SocketPort): void {
  if (attached) attached.close?.();
  attached = port;
  port.onClose(() => {
    if (attached === port) attached = null;
  });
  host.attach(port);
}

/**
 * Listen, and work out what an address already in use actually means.
 *
 * Two different things leave a socket file behind and they want opposite
 * answers: a host that is genuinely running (in which case this process is a
 * duplicate and should go away quietly, because starting a second one would
 * bind nothing and serve nobody) and a host that was killed without unlinking
 * (in which case the file is a corpse and holding the address against us is
 * absurd). Connecting is the only thing that tells them apart.
 */
async function listen(): Promise<Server> {
  try {
    return await serveHostSocket(path, onConnection);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    try {
      const probe = await connectToHost(path, 500);
      probe.close?.();
      console.log(`kururu pty host: one is already listening at ${path}`);
      process.exit(0);
    } catch {
      // Nobody home. The file is what is left of a host that was killed.
    }
    unlinkSync(path);
    return serveHostSocket(path, onConnection);
  }
}

let server: Server | null = null;

/**
 * Take the socket out of the filesystem on the way down.
 *
 * Unlinking here rather than only in the signal handler because the alternative
 * is a file that outlives the process and makes the *next* host pay a round trip
 * to discover it is a corpse. It is best-effort by nature: a host killed with
 * SIGKILL cannot run this, which is why `listen` above can still cope.
 */
function unlinkSocket(): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or never ours.
  }
}

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`kururu pty host: ${signal} — stopping ${host.liveCount()} agent(s)`);
  server?.close();
  // The ptys are the reason this process exists: one whose owner exits without
  // reaping it leaves an agent running with no terminal attached and no way back
  // to it.
  await host.shutdown();
  unlinkSocket();
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => void stop(signal));
}
process.on("exit", unlinkSocket);

server = await listen();
console.log(`kururu pty host  ${path}`);
