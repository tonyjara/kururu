/**
 * The status of an agent on another machine, which nothing reports, read off
 * its screen every couple of seconds and reported for it.
 *
 * `shared/onscreen.ts` argues for reading a screen at all and holds the
 * reading; this is the loop. It posts what it reads through `host.report` —
 * the call a hook's `POST /api/report` ends in — so that everything
 * downstream of a status, the dot, the notification, the card's run, the
 * harness's `[kururu]` messages and its `wait_agent`, works for a remote agent
 * without knowing it is one. And it is here, on the side that restarts for
 * free, rather than in the host beside the byte heuristic, because the host is
 * the one process that costs every agent to change and this is a reading
 * that will want tuning.
 *
 * A poll and not the output stream, because the server is only sent the
 * bytes of terminals somebody is looking at, and a remote agent's status
 * matters most when nobody is. A backlog is the host's emulator serialized,
 * which for a tab attached to tmux is tmux's one screen and little else, and
 * one reading is a few kilobytes parsed. Only kururu's own remote agent tabs
 * are read — a line `remoteShellCommand` built with an agent on it — and one
 * at a time, so a slow host never has a queue of them.
 */
import { readScreen, ScreenWatch } from "../../shared/onscreen";
import { remoteShellOf } from "../../shared/machines";
import type { AgentReport, AgentStatus } from "../../shared/model";
import { screenText } from "./harness";
import type { HostLink } from "./hostlink";

/** Often enough that a turn's end is heard about in seconds, seldom enough to cost nothing. */
const POLL_MS = 2000;

export interface OnScreenDeps {
  host: HostLink;
  /** The grid a terminal is laid out at, which its screen is rendered at to be read. */
  grid: (agentId: string) => { cols: number; rows: number };
  /** Post a status, as a hook would have. */
  report: (agentId: string, report: AgentReport) => void;
  /** What the sidebar's second line says the agent is doing: a question, or what is missing. Null clears it. */
  said: (agentId: string, text: string | null) => void;
}

export class OnScreen {
  private watches = new Map<string, { watch: ScreenWatch; detail: string | null }>();
  private busy = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: OnScreenDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    this.timer.unref?.();
  }

  /** One pass over every remote agent, skipped while the last is still going. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const live = new Set<string>();
      for (const agent of this.deps.host.agents) {
        if (agent.exited || agent.kind !== "agent" || !remoteShellOf(agent.command)?.agent) continue;
        live.add(agent.id);
        const data = await this.deps.host.backlog(agent.id).catch(() => null);
        if (data === null) continue;
        const { cols, rows } = this.deps.grid(agent.id);
        const read = readScreen(await screenText(data, cols, rows, rows));
        let held = this.watches.get(agent.id);
        if (!held) this.watches.set(agent.id, (held = { watch: new ScreenWatch(), detail: null }));
        // The status as it is now rather than as it was a backlog ago: a
        // keystroke in between is the host setting it, and is believed.
        const now = this.deps.host.find(agent.id);
        if (!now || now.exited) continue;
        // The words first, so the report's push carries them.
        if (read.detail !== held.detail) {
          held.detail = read.detail;
          this.deps.said(agent.id, read.detail);
        }
        const status: AgentStatus | null = held.watch.see(read, now.status);
        if (status) this.deps.report(agent.id, { status });
      }
      for (const id of [...this.watches.keys()]) if (!live.has(id)) this.watches.delete(id);
    } catch (err) {
      console.error(`kururu: reading a remote agent's screen failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.busy = false;
    }
  }
}
