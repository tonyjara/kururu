/**
 * The one bridge Claude's live allowance reading takes into the ledger:
 * `recordClaudeLimits`, against a real (temp) ledger so the `limits` table's
 * own shape is what is checked, not a mock of it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountUsage } from "../../shared/wire";
import { recordClaudeLimits, resetClaudeLimitHistory } from "../src/usage/limits";
import { Ledger } from "../src/usage/store";

let dir: string;
let ledger: Ledger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kururu-limits-"));
  ledger = Ledger.open(join(dir, "usage.db"));
  resetClaudeLimitHistory();
});
afterEach(() => {
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

function reading(over: Partial<AccountUsage> = {}): AccountUsage {
  return {
    limits: [{ kind: "session", group: "session", percent: 41, severity: "normal", resetsAt: "2026-11-02T00:00:00.000Z", scope: null }],
    at: 1_000,
    stale: false,
    signedOut: false,
    email: "me@example.com",
    error: null,
    retryAt: null,
    ...over,
  };
}

function rows(): unknown[] {
  return ledger.usageLimits(0, Number.MAX_SAFE_INTEGER);
}

describe("recordClaudeLimits", () => {
  it("writes a fresh reading's windows", () => {
    recordClaudeLimits(ledger, reading(), "pk1");
    expect(rows()).toEqual([{ at: 1_000, kind: "session", scope: null, percent: 41, source: "claude" }]);
  });

  it("writes nothing for the same sighting twice", () => {
    recordClaudeLimits(ledger, reading(), "pk1");
    recordClaudeLimits(ledger, reading(), "pk1");
    expect(rows().length).toBe(1);
  });

  it("writes a new sighting at a later `at`, even with the same percentage", () => {
    recordClaudeLimits(ledger, reading(), "pk1");
    recordClaudeLimits(ledger, reading({ at: 2_000 }), "pk1");
    expect(rows().length).toBe(2);
  });

  it("writes nothing for a stale reading: an unmoved `at` kept standing by a failed poll", () => {
    recordClaudeLimits(ledger, reading({ stale: true }), "pk1");
    expect(rows()).toEqual([]);
  });

  it("writes nothing while signed out", () => {
    recordClaudeLimits(ledger, reading({ signedOut: true, limits: [] }), "pk1");
    expect(rows()).toEqual([]);
  });

  it("writes nothing for no ledger", () => {
    expect(() => recordClaudeLimits(null, reading(), "pk1")).not.toThrow();
  });

  it("drops a resetsAt that will not parse rather than writing NaN", () => {
    recordClaudeLimits(ledger, reading({ limits: [{ kind: "session", group: "session", percent: 10, severity: "normal", resetsAt: "not a date", scope: null }] }), null);
    const row = ledger.usageLimits(0, Number.MAX_SAFE_INTEGER)[0]!;
    expect(row.percent).toBe(10);
  });
});
