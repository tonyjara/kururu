/**
 * What to do with one frame for a client that may be falling behind.
 *
 * A window's socket buffers in the server, so a phone gone half-open on the
 * tailnet, or a page that has stopped reading, used to be memory held for it
 * until TCP gave up — minutes — while 1.2 MB snapshots and every byte of
 * terminal output piled up behind it (the 2026-11-02 review, §2.5). Two lines:
 *
 * - Past `SNAPSHOT_HOLD`, a snapshot is held rather than queued. It is the
 *   whole state, so the newest replaces every one the client would have had
 *   queued, and it goes once the buffer drains (`releaseSnapshots`).
 * - Past `CLIENT_BUFFER_MAX`, anything cuts the client off. It has missed
 *   output that cannot be sent piecemeal anyway, and what a reconnect gives
 *   it — a snapshot and a backlog per pane — is exactly the catching up it
 *   needs. Output is never held: a terminal's bytes are a stream, and one
 *   missing in the middle is a screen drawn wrong until it is rebuilt.
 */
export const SNAPSHOT_HOLD = 1024 * 1024;
export const CLIENT_BUFFER_MAX = 16 * 1024 * 1024;

export type Delivery = "send" | "hold" | "cut";

export function delivery(buffered: number, snapshot: boolean): Delivery {
  if (buffered > CLIENT_BUFFER_MAX) return "cut";
  if (snapshot && buffered > SNAPSHOT_HOLD) return "hold";
  return "send";
}

/**
 * The liveness rule, once per `PING_MS`: a client that has said nothing
 * since the last ping — no pong, no message — is let go, and one that has is
 * pinged again. Browsers answer a ping themselves, below the page.
 */
export const PING_MS = 30_000;

export function liveness(heard: boolean): "ping" | "drop" {
  return heard ? "ping" : "drop";
}
