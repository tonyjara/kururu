/**
 * Per-agent status, inferred from the shape of its output over time.
 *
 * Lifted from ghosttown's `src/core/status.ts`, which had already tuned these
 * thresholds against real agents, and kept deliberately identical so the dot in
 * kururu means what the dot in the TUI means. The only changes are the import
 * and this comment: the logic is pure, with no terminal and no pty in it, which
 * is why it survived the move between two otherwise unrelated runtimes.
 *
 * The heuristic can only ever see bytes and timing, so it produces `idle`,
 * `working` and `done`. It cannot produce `blocked` — nothing in a byte stream
 * distinguishes "waiting for you to answer" from "thinking". That status comes
 * from the agent saying so; see `report.ts`, and note that one report disables
 * the heuristic here for good, because a process that reports once is a better
 * source than a guess forever after.
 */
import type { AgentStatus } from "../../../shared/model";

/** Output within this window after a keystroke is treated as echo, not work. */
const ECHO_MS = 300;
/** Sustained output for this long flips an agent to `working`. */
const WORKING_AFTER_MS = 1000;
/** A gap this long ends an output burst. */
const BURST_GAP_MS = 1500;
/** Quiet for this long ends `working`. */
const DONE_QUIET_MS = 2500;
/** Work shorter than this settles to `idle` instead of `done`. */
const MIN_WORK_MS = 4000;
/**
 * Same, for an agent we can see a known program running in (see `procs.ts`). A
 * short burst from a shell is a command scrolling by; from an agent it is a turn
 * that finished, and worth flagging as `done`.
 */
const AGENT_MIN_WORK_MS = 1200;

export class StatusTracker {
  status: AgentStatus = "idle";
  hasReporter = false;
  /** Agent program detected in this pty right now, or null. */
  agent: string | null = null;

  private lastOutputAt = 0;
  private lastInputAt = 0;
  private burstStartAt = 0;
  private workStartAt = 0;

  constructor(private onChange: (status: AgentStatus, prev: AgentStatus) => void) {}

  private set(status: AgentStatus): void {
    if (status === this.status) return;
    const prev = this.status;
    this.status = status;
    this.onChange(status, prev);
  }

  /** An agent said what it is doing. Authoritative, and permanent. */
  report(status: AgentStatus): void {
    this.hasReporter = true;
    this.set(status);
  }

  /** What the process poll sees running here (null = no agent anymore). */
  setAgent(agent: string | null): void {
    this.agent = agent;
  }

  recordOutput(now = Date.now()): void {
    if (now - this.lastInputAt < ECHO_MS) return;
    if (now - this.lastOutputAt > BURST_GAP_MS) this.burstStartAt = now;
    this.lastOutputAt = now;
    if (this.hasReporter) return;
    if (this.status !== "working" && now - this.burstStartAt >= WORKING_AFTER_MS) {
      this.workStartAt = this.burstStartAt;
      this.set("working");
    }
  }

  recordInput(now = Date.now()): void {
    this.lastInputAt = now;
    // The user is interacting: done/blocked have been acted on.
    if (this.status === "done" || this.status === "blocked") this.set("idle");
  }

  /** Called on a coarse interval to detect end-of-work; silence raises no event. */
  tick(now = Date.now()): void {
    if (this.hasReporter || this.status !== "working") return;
    if (now - this.lastOutputAt >= DONE_QUIET_MS) {
      const workedFor = this.lastOutputAt - this.workStartAt;
      const minWork = this.agent ? AGENT_MIN_WORK_MS : MIN_WORK_MS;
      this.set(workedFor >= minWork ? "done" : "idle");
    }
  }
}
