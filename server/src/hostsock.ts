/**
 * `hostlink.ts`'s `Port`, carried over a unix socket.
 *
 * The link between the server and the pty host used to be an Electron
 * `MessagePortMain`, handed to both halves by the main process. That worked, and
 * it quietly made Electron the only thing that could arrange the split: the two
 * processes could not find each other on their own, so with no Electron there
 * was no split at all — `index.ts` built a host inside itself and the property
 * the whole seam exists for, *restarting the server does not cost the agents*,
 * silently did not hold. Every `bun run dev` had it backwards and nothing said
 * so.
 *
 * A socket at a known path fixes that by removing the matchmaker. The host
 * listens; whoever wants it connects; a server that has just been restarted
 * connects again and is handed back the agents and the blob, exactly as a
 * re-forked utilityProcess was. It also means the arrangement no longer has a
 * desktop in it, which is what lets the host run on a machine that has no window
 * at all.
 *
 * Newline-delimited JSON, which is safe rather than lucky: `JSON.stringify`
 * escapes newlines inside strings, so a frame can never contain the byte that
 * separates frames — and terminal output, which is the only payload here big
 * enough to care, is a string. Length prefixing would be marginally cheaper and
 * would make a tape of this socket unreadable, which is the opposite of what
 * `record.ts` argues for.
 */
import { connect, createServer, type Server, type Socket } from "node:net";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Port } from "./hostlink";

/**
 * Where the host listens.
 *
 * XDG's *state* directory rather than the config one, on `persist.ts`'s
 * reasoning: a socket is not a decision anybody made, it is a running process's
 * address, and losing it between versions costs nothing that is not rebuilt by
 * starting again. `KURURU_HOST_SOCK` overrides it, which is how a test gets its
 * own host and how two kururus can be run side by side on one machine.
 */
export function hostSocketPath(): string {
  const override = process.env.KURURU_HOST_SOCK;
  if (override) return override;
  const state = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(state, "kururu", "ptyhost.sock");
}

/**
 * A `Port` whose other end is a socket, plus the two things a socket has that a
 * MessagePort does not: it can go away by itself, and somebody has to be told.
 */
export interface SocketPort extends Port {
  /** The far end hung up — the server was restarted, or the host died. */
  onClose(listener: () => void): void;
  socket: Socket;
}

function socketPort(socket: Socket): SocketPort {
  const listeners: Array<(event: { data: unknown }) => void> = [];
  const closers: Array<() => void> = [];

  /**
   * Frames that arrived before anybody asked for them.
   *
   * `start()` is a MessagePort's way of saying "I have attached my handler now",
   * and both ends of this link call it — `HostLink`'s constructor and the host's
   * `attach`. A socket has no such gate and will happily deliver a `hello` reply
   * into a listener list that is still empty, so this one keeps the gate rather
   * than dropping the first thing anybody says.
   */
  const queued: unknown[] = [];
  let started = false;

  const decoder = new StringDecoder("utf8");
  let buffer = "";

  // Terminal output is already coalesced by the host every 16ms; what is left to
  // avoid is Nagle adding 40 more to a keystroke on its way to a pty.
  socket.setNoDelay(true);

  socket.on("data", (chunk) => {
    // Through a decoder rather than `chunk.toString()`: a frame boundary and a
    // UTF-8 character boundary have nothing to do with each other, and a
    // multi-byte character split across two reads would otherwise become two
    // replacement characters in somebody's terminal.
    buffer += decoder.write(chunk);
    for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let data: unknown;
      try {
        data = JSON.parse(line);
      } catch {
        // One unparseable frame is not a reason to take down a process holding
        // ptys, and saying so is how it gets found.
        console.error("kururu: a frame on the host socket was not JSON and was dropped");
        continue;
      }
      if (!started) queued.push(data);
      else for (const listener of listeners) listener({ data });
    }
  });

  // An error is always followed by a close, so the close handler is the only
  // place that has to do anything; what this listener is for is the fact that an
  // unhandled 'error' on a socket is a thrown exception.
  socket.on("error", () => {});
  socket.on("close", () => {
    for (const listener of closers) listener();
  });

  return {
    postMessage(message) {
      if (socket.destroyed) return;
      socket.write(`${JSON.stringify(message)}\n`);
    },
    on(_event, listener) {
      listeners.push(listener);
    },
    start() {
      if (started) return;
      started = true;
      for (const data of queued.splice(0)) {
        for (const listener of listeners) listener({ data });
      }
    },
    close() {
      socket.destroy();
    },
    onClose(listener) {
      closers.push(listener);
    },
    socket,
  };
}

/**
 * Connect to a host that is already listening.
 *
 * The timeout is on the connect only and is cleared the moment it lands: a
 * socket timeout in node is an *idle* timeout, so leaving it set would tear down
 * the link to a host that was merely not saying anything — which is what a host
 * with nothing running looks like.
 */
export function connectToHost(path: string, timeoutMs = 2000): Promise<SocketPort> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    const fail = (err: Error) => {
      socket.destroy();
      reject(err);
    };
    socket.once("error", fail);
    socket.setTimeout(timeoutMs, () => fail(new Error(`no pty host answered at ${path}`)));
    socket.once("connect", () => {
      socket.setTimeout(0);
      socket.removeListener("error", fail);
      resolve(socketPort(socket));
    });
  });
}

/**
 * How long a unix socket path is allowed to be, which is shorter than anybody
 * expects and is not a thing the kernel explains.
 *
 * `sun_path` is a fixed 104-byte array on macOS and 108 on Linux, so a path past
 * it fails `listen` with a bare `EINVAL` — an error that names no limit, says
 * nothing about paths, and reads exactly like a bug in the code that called it.
 * The default (`~/.local/state/kururu/ptyhost.sock`) is nowhere near it; a
 * `KURURU_HOST_SOCK` pointing somewhere deep, which is what a test or a second
 * instance does, is how you find out. Checked rather than truncated, for
 * `files.ts`'s reason: a clamped path is a bug that looks like it worked.
 */
const SUN_PATH_MAX = 103;

/** Listen, creating the directory if this is the first run on this machine. */
export function serveHostSocket(
  path: string,
  onConnection: (port: SocketPort) => void,
): Promise<Server> {
  return new Promise((resolve, reject) => {
    if (Buffer.byteLength(path) > SUN_PATH_MAX) {
      reject(
        new Error(
          `the socket path is ${Buffer.byteLength(path)} bytes and a unix socket allows ${SUN_PATH_MAX} — set KURURU_HOST_SOCK to somewhere shorter`,
        ),
      );
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    const server = createServer((socket) => onConnection(socketPort(socket)));
    server.once("error", reject);
    server.listen(path, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}
