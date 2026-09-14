/**
 * The status heuristic, driven by an explicit clock.
 *
 * Every method takes `now`, which is the only reason this is testable at all:
 * the thing being asserted is a set of timing thresholds, and waiting four real
 * seconds to find out whether a shell settles to `idle` would make the suite
 * useless.
 */
import { describe, expect, it } from "bun:test";
import { StatusTracker } from "../src/agents/status";

/** Drive a tracker to `working`: two bursts a second apart is the threshold. */
function toWorking(tracker: StatusTracker): void {
  tracker.recordOutput(0);
  tracker.recordOutput(1000);
}

describe("StatusTracker", () => {
  it("starts idle and needs sustained output to call it work", () => {
    const tracker = new StatusTracker(() => {});
    expect(tracker.status).toBe("idle");
    tracker.recordOutput(0);
    // One burst is a command echoing, not a turn.
    expect(tracker.status).toBe("idle");
    tracker.recordOutput(1000);
    expect(tracker.status).toBe("working");
  });

  it("ignores output that is just the echo of a keystroke", () => {
    const tracker = new StatusTracker(() => {});
    tracker.recordInput(0);
    tracker.recordOutput(100);
    tracker.recordOutput(200);
    expect(tracker.status).toBe("idle");
  });

  it("calls a finished agent turn done", () => {
    const tracker = new StatusTracker(() => {});
    tracker.setAgent("claude");
    toWorking(tracker);
    tracker.recordOutput(2000);
    // Quiet for longer than DONE_QUIET_MS, having worked past AGENT_MIN_WORK_MS.
    tracker.tick(4500);
    expect(tracker.status).toBe("done");
  });

  it("calls the same burst from a bare shell idle, not done", () => {
    const tracker = new StatusTracker(() => {});
    // No agent: a two-second burst is a build scrolling past, not a turn that
    // finished, and flagging it `done` would cry wolf.
    toWorking(tracker);
    tracker.recordOutput(2000);
    tracker.tick(4500);
    expect(tracker.status).toBe("idle");
  });

  it("clears done once the user types", () => {
    const tracker = new StatusTracker(() => {});
    tracker.setAgent("claude");
    toWorking(tracker);
    tracker.recordOutput(2000);
    tracker.tick(4500);
    expect(tracker.status).toBe("done");
    tracker.recordInput(5000);
    expect(tracker.status).toBe("idle");
  });

  it("lets a report win, and keeps letting it win", () => {
    const tracker = new StatusTracker(() => {});
    tracker.report("blocked");
    expect(tracker.status).toBe("blocked");
    expect(tracker.hasReporter).toBe(true);

    // The heuristic must not talk over an agent that knows its own state — this
    // is the whole reason `blocked` survives long enough to be seen.
    tracker.recordOutput(0);
    tracker.recordOutput(1000);
    tracker.recordOutput(2000);
    tracker.tick(4500);
    expect(tracker.status).toBe("blocked");
  });

  it("announces only real transitions", () => {
    const seen: string[] = [];
    const tracker = new StatusTracker((status) => seen.push(status));
    toWorking(tracker);
    tracker.recordOutput(1500);
    tracker.recordOutput(2000);
    tracker.setAgent("claude");
    tracker.tick(4500);
    tracker.tick(5000);
    expect(seen).toEqual(["working", "done"]);
  });
});
