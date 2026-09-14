/**
 * One long-lived connection to a ghosttown daemon's control socket.
 *
 * `gt` opens a socket per command and closes it; kururu polls several times a
 * second and would spend more time connecting than asking. The control server
 * loops over every newline it receives on a connection and answers each one, so
 * a held-open socket is already supported — requests are matched to responses
 * by the id we put on them.
 *
 * Reconnection is the normal case, not the error case: the daemon restarts
 * whenever the TUI reloads (prefix+R), and the socket is replaced under us. So
 * a closed connection schedules a retry and the UI is told; nothing here throws
 * on the daemon simply not being there yet.
 */
import { readdirSync } from "node:fs";
import type { Request, Response } from "../../shared/ghosttown";
import { defaultSocketDir, socketPathFor } from "../../shared/ghosttown";
import { SocketWriter } from "./sockbuf";

/** Profiles with a daemon right now — one attach socket each. */
export function runningSessions(): string[] {
  try {
    return readdirSync(defaultSocketDir())
      .filter((f) => f.endsWith(".attach.sock"))
      .map((f) => f.slice(0, -".attach.sock".length))
      .sort();
  } catch {
    return []; // run dir lives under /tmp and may not exist yet
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type Socket = { write(data: Uint8Array): number; end(): void };

/** Backoff between reconnect attempts, in ms. Capped so a long outage still recovers fast. */
const RETRY_MS = [100, 250, 500, 1000, 2000];

export class DaemonLink {
  private socket: Socket | null = null;
  private writer: SocketWriter | null = null;
  private inbuf = "";
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private attempt = 0;
  private closed = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  /** Called whenever the connection comes up or goes down. */
  onState: (connected: boolean, error?: string) => void = () => {};

  constructor(public session: string) {}

  get connected(): boolean {
    return this.socket !== null;
  }

  start(): void {
    this.closed = false;
    void this.open();
  }

  /** Point this link at a different profile, keeping the same consumers. */
  switchTo(session: string): void {
    if (session === this.session) return;
    this.session = session;
    this.drop("switched profile");
    this.attempt = 0;
    void this.open();
  }

  stop(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.drop("stopped");
  }

  /**
   * One request. Rejects rather than queues when the daemon is down: every
   * caller here is a poll or a keypress, and both are better off failing now
   * and being retried than arriving late against stale state.
   */
  call(method: string, params: Record<string, unknown> = {}, timeoutMs = 3000): Promise<unknown> {
    const writer = this.writer;
    if (!writer) return Promise.reject(new Error("ghosttown daemon not connected"));
    const id = this.nextId++;
    const req: Request = { id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      writer.write(JSON.stringify(req) + "\n");
    });
  }

  private async open(): Promise<void> {
    if (this.closed) return;
    const path = socketPathFor(this.session);
    try {
      await Bun.connect({
        unix: path,
        socket: {
          open: (socket) => {
            this.socket = socket as unknown as Socket;
            this.writer = new SocketWriter(this.socket);
            this.inbuf = "";
            this.attempt = 0;
            this.onState(true);
          },
          data: (_socket, data) => this.feed(data.toString()),
          drain: () => this.writer?.flush(),
          error: (_socket, error) => this.lost(error.message),
          close: () => this.lost("connection closed"),
        },
      });
    } catch (err) {
      this.lost(err instanceof Error ? err.message : String(err));
    }
  }

  /** Split on newlines and settle whatever each line answers. */
  private feed(chunk: string): void {
    const buffered = this.inbuf + chunk;
    const lines = buffered.split("\n");
    this.inbuf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let res: Response;
      try {
        res = JSON.parse(line) as Response;
      } catch {
        continue; // a daemon that sends us junk is not worth dying over
      }
      const waiting = this.pending.get(res.id);
      if (!waiting) continue; // already timed out
      this.pending.delete(res.id);
      clearTimeout(waiting.timer);
      if (res.ok) waiting.resolve(res.result);
      else waiting.reject(new Error(res.error));
    }
  }

  private lost(why: string): void {
    const wasUp = this.socket !== null;
    this.drop(why);
    if (wasUp) this.onState(false, why);
    if (this.closed) return;
    const delay = RETRY_MS[Math.min(this.attempt, RETRY_MS.length - 1)]!;
    this.attempt++;
    this.retryTimer = setTimeout(() => void this.open(), delay);
  }

  private drop(why: string): void {
    for (const [, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error(why));
    }
    this.pending.clear();
    try {
      this.socket?.end();
    } catch {
      // already gone
    }
    this.socket = null;
    this.writer = null;
  }
}
