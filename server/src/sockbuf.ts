/**
 * Partial-write-safe outbound buffering for Bun unix sockets.
 *
 * Bun's socket.write returns how many bytes the kernel accepted — under load
 * that can be less than the whole payload, and the rest is silently dropped.
 * The stream is newline-delimited JSON, so one truncated line corrupts
 * everything after it. Queue the tail and resume from the socket's drain
 * handler. (Same hazard, same fix, as ghosttown's own control/sockbuf.)
 */
const encoder = new TextEncoder();

interface WritableSocket {
  write(data: Uint8Array): number;
  end(): void;
}

export class SocketWriter {
  private queue: Uint8Array[] = [];
  private offset = 0;
  private pending = 0;

  constructor(
    private sock: WritableSocket,
    /** Drop the connection past this instead of buffering unbounded memory. */
    private maxPending = 32 * 1024 * 1024,
  ) {}

  write(line: string): void {
    const bytes = encoder.encode(line);
    if (this.pending + bytes.length > this.maxPending) {
      this.reset();
      try {
        this.sock.end();
      } catch {
        // already gone
      }
      return;
    }
    this.queue.push(bytes);
    this.pending += bytes.length;
    this.flush();
  }

  /** Call from the socket's drain handler. */
  flush(): void {
    while (this.queue.length) {
      const head = this.queue[0]!;
      const chunk = this.offset > 0 ? head.subarray(this.offset) : head;
      let wrote: number;
      try {
        wrote = this.sock.write(chunk);
      } catch {
        this.reset();
        return;
      }
      const accepted = Math.max(0, wrote);
      this.pending -= accepted;
      if (accepted < chunk.length) {
        this.offset += accepted; // kernel buffer full — drain() resumes here
        return;
      }
      this.queue.shift();
      this.offset = 0;
    }
  }

  private reset(): void {
    this.queue = [];
    this.offset = 0;
    this.pending = 0;
  }
}
