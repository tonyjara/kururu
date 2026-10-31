/**
 * Following a file somebody else is appending to, from where we last stopped,
 * without ever turning the lines we do not want into strings.
 *
 * Four gigabytes of logs, of which the ledger wants under two percent, read by
 * the process that serves every terminal the user is watching. So the shape is
 * dictated by never holding the event loop: one chunk at a time, read off the
 * thread pool, then a search for the needles over the raw bytes, with `JSON.
 * parse` only on the lines that hold one. A line that holds no needle is passed
 * over by `indexOf` and costs nothing but its read. Nothing is kept between
 * chunks except the offset, and a partial last line is not read past: the
 * offset stops at the newline before it, and it is read again whole next time.
 *
 * Between chunks it sleeps for as long as the chunk took, so a backfill can
 * never take more than about half of the loop whatever the disk does. A chunk
 * is small enough that the longest it holds the loop is a few milliseconds,
 * and a terminal's output waits for no longer than a stray garbage collection.
 *
 * It knows nothing of Claude Code. Needles go in and lines come out, so that
 * Codex's rollouts can come through here too.
 */
import { open, stat, type FileHandle } from "node:fs/promises";

export const CHUNK = 1024 * 1024;
/** A line longer than this is not read: nothing the ledger wants comes close, and it would all be held in memory. */
export const MAX_LINE = 64 * 1024 * 1024;

const NEWLINE = 0x0a;

/**
 * Each line of `buffer[0, end)` holding any of the needles, in order. `end` is
 * one past a newline. Finding a needle first and its line second, because the
 * lines that hold none are the ones that are megabytes long, and walking them
 * for their newlines is the very cost this exists to avoid.
 */
export function scanLines(buffer: Buffer, end: number, needles: readonly Buffer[], visit: (start: number, stop: number) => void): void {
  const hits = needles.map((needle) => buffer.indexOf(needle, 0));
  let at = 0;
  while (at < end) {
    let hit = -1;
    for (let i = 0; i < needles.length; i++) {
      if (hits[i]! !== -1 && hits[i]! < at) hits[i] = buffer.indexOf(needles[i]!, at);
      if (hits[i]! !== -1 && (hit === -1 || hits[i]! < hit)) hit = hits[i]!;
    }
    if (hit === -1 || hit >= end) return;
    const start = hit === 0 ? 0 : buffer.lastIndexOf(NEWLINE, hit - 1) + 1;
    const stop = buffer.indexOf(NEWLINE, hit);
    // `end` is one past a newline, so a hit before it always has one.
    if (stop === -1 || stop >= end) return;
    visit(Math.max(start, at), stop);
    at = stop + 1;
  }
}

export interface Tailing {
  inode: number;
  /** Where to read from, which is zero when the file is not the one the offset was for. */
  offset: number;
  /** Whether it had to start over, or is being met for the first time. */
  fresh: boolean;
}

/**
 * Where to pick a file up. An inode that changed under the same path is a new
 * file, and a file shorter than the offset was truncated: both start again
 * from zero, which the ledger's primary key makes harmless.
 */
export function resume(known: { inode: number; offset: number } | null, inode: number, size: number): Tailing {
  if (known && known.inode === inode && size >= known.offset) return { inode, offset: known.offset, fresh: false };
  return { inode, offset: 0, fresh: true };
}

export interface TailSink {
  /** Where the file stands, before anything is read. False ends the read: nothing has changed. */
  begin(info: { inode: number; size: number; mtime: number; fresh: boolean; offset: number }): boolean;
  /** The first bytes of a file met from the start, for what only a head can say. */
  head?(bytes: Buffer): void;
  /** A complete line holding a needle. `at` is its byte offset in the file. */
  line(text: string, at: number): void;
  /** A line was not read, in a word of ours. */
  skip(at: number, why: string): void;
  /** Everything before this offset has been read. Called after every chunk. */
  advanced(offset: number, read: number): void;
}

export interface TailOptions {
  chunk?: number;
  maxLine?: number;
  /** Called between chunks with how long the last one held the loop, so a test can skip the sleep. */
  pause?: (busyMs: number) => Promise<void>;
}

export function halfDuty(busyMs: number): Promise<void> {
  return new Promise((done) => setTimeout(done, Math.max(1, Math.min(busyMs, 50))));
}

/**
 * Read whatever has been appended to a file. Says `gone` when it is not there
 * to read, which is not an error: a sweep can delete a transcript between a
 * `readdir` and this.
 */
export async function tailFile(
  path: string,
  known: { inode: number; offset: number } | null,
  needles: readonly Buffer[],
  sink: TailSink,
  options: TailOptions = {},
): Promise<"gone" | "read" | "same"> {
  const chunk = options.chunk ?? CHUNK;
  const maxLine = options.maxLine ?? MAX_LINE;
  const pause = options.pause ?? halfDuty;
  const info = await stat(path).catch(() => null);
  if (!info || !info.isFile()) return "gone";
  const from = resume(known, info.ino, info.size);
  if (!sink.begin({ inode: info.ino, size: info.size, mtime: info.mtimeMs, fresh: from.fresh, offset: from.offset })) return "same";
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch {
    return "gone";
  }
  try {
    let buffer = Buffer.allocUnsafe(chunk);
    let position = from.offset;
    /** In the middle of a line too long to hold: everything up to its newline is thrown away. */
    let discarding = false;
    let first = from.offset === 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const began = performance.now();
      if (first) {
        sink.head?.(buffer.subarray(0, bytesRead));
        first = false;
      }
      const lastNewline = buffer.subarray(0, bytesRead).lastIndexOf(NEWLINE);
      if (discarding) {
        const newline = buffer.subarray(0, bytesRead).indexOf(NEWLINE);
        if (newline === -1) {
          position += bytesRead;
          sink.advanced(position, bytesRead);
        } else {
          position += newline + 1;
          sink.advanced(position, newline + 1);
          discarding = false;
        }
        await pause(performance.now() - began);
        continue;
      }
      if (lastNewline === -1) {
        // No whole line in here. At the end of the file that is a line still
        // being written, and it is read whole next time.
        if (bytesRead < buffer.length) break;
        if (buffer.length * 2 <= maxLine) {
          buffer = Buffer.allocUnsafe(buffer.length * 2);
          continue;
        }
        sink.skip(position, "a line too long to read");
        discarding = true;
        position += bytesRead;
        sink.advanced(position, bytesRead);
        continue;
      }
      const end = lastNewline + 1;
      const base = position;
      scanLines(buffer.subarray(0, bytesRead), end, needles, (start, stop) => {
        sink.line(buffer.toString("utf8", start, stop), base + start);
      });
      position += end;
      sink.advanced(position, end);
      // Back to size once the long line that grew it has been read.
      if (buffer.length > chunk) buffer = Buffer.allocUnsafe(chunk);
      await pause(performance.now() - began);
    }
    return "read";
  } finally {
    await handle.close().catch(() => {});
  }
}
