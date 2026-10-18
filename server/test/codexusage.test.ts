/**
 * The Codex allowance, read off a rollout. The parsing is the whole of what
 * can go wrong without a disk: which line counts, which windows are drawn,
 * and what a window whose reset has passed turns into.
 */
import { describe, expect, it } from "bun:test";

import { codexLimitsFrom, lastRateLimits } from "../src/codexusage";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const later = (hours: number) => Math.floor((NOW + hours * 3600_000) / 1000);

describe("codexLimitsFrom", () => {
  it("names the five-hour window a session and the week a week", () => {
    const limits = codexLimitsFrom(
      {
        primary: { used_percent: 12.5, window_minutes: 300, resets_at: later(2) },
        secondary: { used_percent: 80, window_minutes: 10080, resets_at: later(48) },
      },
      NOW,
    );
    expect(limits.map((l) => [l.kind, l.percent, l.severity])).toEqual([
      ["session", 12.5, "normal"],
      ["weekly_all", 80, "warning"],
    ]);
    expect(limits[0]!.resetsAt).toBe(new Date(later(2) * 1000).toISOString());
  });

  it("drops a window whose reset has passed, and one with no percentage", () => {
    const limits = codexLimitsFrom(
      {
        primary: { used_percent: 97, window_minutes: 300, resets_at: later(-1) },
        secondary: { window_minutes: 10080, resets_at: later(48) },
      },
      NOW,
    );
    expect(limits).toEqual([]);
  });

  it("holds a percentage off the wire to 0–100 and calls the top red", () => {
    const [limit] = codexLimitsFrom({ primary: { used_percent: 140, window_minutes: 1440, resets_at: later(3) } }, NOW);
    expect(limit).toMatchObject({ kind: "1d", percent: 100, severity: "critical" });
  });

  it("reads nothing out of a shape that is not one", () => {
    expect(codexLimitsFrom(null, NOW)).toEqual([]);
    expect(codexLimitsFrom({ primary: { used_percent: Number.NaN } }, NOW)).toEqual([]);
  });
});

describe("lastRateLimits", () => {
  const event = (at: string, used: number) =>
    JSON.stringify({
      timestamp: at,
      type: "event_msg",
      payload: { type: "token_count", rate_limits: { primary: { used_percent: used, window_minutes: 300 }, plan_type: "plus" } },
    });

  it("takes the last line that carries limits, skipping a cut first line and null limits", () => {
    const text = [
      'payload":{"rate_limits":{"primary"', // a tail starts mid-line
      event("2026-10-18T10:00:00Z", 10),
      event("2026-10-18T11:00:00Z", 20),
      JSON.stringify({ timestamp: "2026-10-18T11:30:00Z", payload: { type: "token_count", rate_limits: null } }),
      JSON.stringify({ timestamp: "2026-10-18T11:31:00Z", payload: { type: "agent_message" } }),
    ].join("\n");
    const found = lastRateLimits(text);
    expect(found?.at).toBe(Date.parse("2026-10-18T11:00:00Z"));
    expect(found?.plan).toBe("plus");
    expect((found?.rateLimits.primary as { used_percent: number }).used_percent).toBe(20);
  });

  it("says nothing when no line has limits", () => {
    expect(lastRateLimits("")).toBeNull();
    expect(lastRateLimits('{"payload":{}}\n')).toBeNull();
  });
});
