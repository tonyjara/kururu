/**
 * When the runner starts a crashed server again (`server/restart.mjs`): a
 * crash after a minute up comes back, after a wait that grows with each one
 * in ten minutes; a server that dies young, or that was stopped on purpose,
 * is left down as it always was.
 */
import { describe, expect, it } from "bun:test";
import { CRASH_WINDOW_MS, RESTART_AFTER_UP_MS, RESTART_BACKOFF_MS, restartDelay } from "../restart.mjs";

const now = 10_000_000;
const up = RESTART_AFTER_UP_MS + 1;

describe("restartDelay", () => {
  it("starts again a server that crashed after a minute up, a second later the first time", () => {
    expect(restartDelay({ upMs: up, code: 1, signal: null, crashes: [], now })).toBe(RESTART_BACKOFF_MS[0]!);
    // Native code aborting, or the system out of memory, is a crash too.
    expect(restartDelay({ upMs: up, code: null, signal: "SIGABRT", crashes: [], now })).toBe(RESTART_BACKOFF_MS[0]!);
    expect(restartDelay({ upMs: up, code: null, signal: "SIGKILL", crashes: [], now })).toBe(RESTART_BACKOFF_MS[0]!);
  });

  it("leaves down a server that died inside its first minute: one that cannot start", () => {
    expect(restartDelay({ upMs: RESTART_AFTER_UP_MS - 1, code: 1, signal: null, crashes: [], now })).toBeNull();
    expect(restartDelay({ upMs: Number.NaN, code: 1, signal: null, crashes: [], now })).toBeNull();
  });

  it("never restarts a server that chose to stop, or was stopped", () => {
    expect(restartDelay({ upMs: up, code: 0, signal: null, crashes: [], now })).toBeNull();
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
      expect(restartDelay({ upMs: up, code: null, signal, crashes: [], now })).toBeNull();
    }
  });

  it("waits longer for each crash inside the window, up to a minute, and forgets the old ones", () => {
    const waits = [0, 1, 2, 3, 4, 5, 9].map((n) =>
      restartDelay({ upMs: up, code: 1, signal: null, crashes: Array.from({ length: n }, (_, i) => now - 1_000 * (i + 1)), now }),
    );
    expect(waits).toEqual([1_000, 5_000, 15_000, 30_000, 60_000, 60_000, 60_000]);
    const old = [now - CRASH_WINDOW_MS - 1, now - CRASH_WINDOW_MS - 2];
    expect(restartDelay({ upMs: up, code: 1, signal: null, crashes: old, now })).toBe(1_000);
  });
});
