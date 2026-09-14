/**
 * The agent host: owner of every pty kururu has opened.
 *
 * This is what replaced the daemon link. Before, kururu asked ghosttown what
 * agents existed and what their screens said; now it spawns them, holds the
 * other end of the pty, and is the only thing that knows. The trade is written
 * down in PLAN.md and is not subtle: these agents are kururu's, they are not the
 * ones in your TUI, and they do not outlive the app.
 *
 * Three things are deliberately *not* in here, because they are the reason the
 * old design was worth copying from:
 *
 *  - No terminal rendering. Nothing in kururu renders a terminal any more — the
 *    browser does. `screen.ts` keeps a headless emulator beside each pty so a
 *    pane opened later can be given the history; this file only moves bytes.
 *  - No status rules. `status.ts` owns the heuristic, unchanged from ghosttown.
 *  - No guessing what is running. `procs.ts` asks the kernel.
 *
 * What is left is lifecycle: spawn, write, watch, reap.
 */
import { spawn, type IPty } from "node-pty";
import { homedir } from "node:os";
import { countsAsAgent } from "../../../shared/model";
import type { AgentReport, AgentSnapshot, PtyKind } from "../../../shared/model";
import { DEFAULT_AGENT_COMMANDS, findAgents, readProcTable } from "./procs";
import { Screen, screenSize } from "./screen";
import { StatusTracker } from "./status";

/**
 * What a new agent runs when the client does not say. A login shell runs it, so
 * that rc files have set PATH first — an Electron GUI launch inherits almost
 * nothing, which is the same reason the shell had to go looking for `bun`.
 */
const DEFAULT_COMMAND = process.env.KURURU_AGENT_COMMAND || "claude";

function loginShell(): string {
  return process.env.SHELL || "/bin/zsh";
}

function defaultCwd(): string {
  return process.env.KURURU_AGENT_CWD || homedir();
}

/** How long a process group gets to exit on its own before it is killed outright. */
const GRACE_MS = 600;

/**
 * Signal an agent's whole process group, not just the process on the end of the
 * pty.
 *
 * This is the difference between quitting cleanly and leaving orphans behind. A
 * login shell running `-c "claude"` does not necessarily exec it — zsh forks for
 * anything with job control or rc-file side effects — so the pty's own pid is
 * the shell, and killing only that leaves the agent running with nothing
 * attached to it and no way to ever get back to it.
 *
 * node-pty opens the pty with setsid, so the shell is its own session and
 * process-group leader and `-pid` reaches every descendant.
 */
function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    // ESRCH: already gone, which is the outcome we wanted anyway.
    return false;
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface Agent {
  id: string;
  kind: PtyKind;
  pty: IPty;
  screen: Screen;
  status: StatusTracker;
  cwd: string;
  command: string;
  createdAt: number;
  unread: boolean;
  contextUsage: AgentSnapshot["contextUsage"];
  /**
   * The pty has closed, but the agent is still listed. Deliberate: the screen is
   * the only record of what the agent said, and dropping the tab the instant a
   * process exits would take the transcript with it — including, especially,
   * whatever it printed on its way out. `kill()` is what removes it.
   */
  exited: boolean;
  exitCode: number | null;
  /** A name the user typed for this tab. Never overwritten by what is detected. */
  titleOverride: string | null;
  /**
   * What the program in the pty last called itself, kept across its exit: that
   * title is the last thing the terminal said about what it was doing, and a
   * dead tab relabelling itself back to "claude" would throw the one fact that
   * distinguished it from the other three.
   */
  title: string | null;
}

export class AgentHost {
  private agents = new Map<string, Agent>();
  private watched = new Set<string>();
  private seq = 0;

  /** Called whenever anything a snapshot would show has changed. */
  onChange: () => void = () => {};

  /**
   * Called with every byte a pty produces, watched or not. The host does not
   * know who is looking — that is the server's business, and it is the one that
   * coalesces these into something a socket should carry.
   */
  onOutput: (id: string, data: string) => void = () => {};

  /**
   * Spawn one. `command` runs under a login shell rather than being exec'd
   * directly, so `claude` resolves the way it does in a terminal.
   *
   * A shell is the same thing with nothing to run: the login shell itself,
   * interactive, which is what "open a terminal" means. It is not a second
   * mechanism — same pty, same emulator, same teardown — and the only thing
   * `kind` decides in here is whether quitting counts it as an agent.
   */
  create(options: { cwd?: string; command?: string; kind?: PtyKind } = {}): AgentSnapshot {
    const cwd = options.cwd || defaultCwd();
    const kind = options.kind ?? "agent";
    const shell = loginShell();
    const command = kind === "shell" ? (options.command || shell) : options.command || DEFAULT_COMMAND;
    const id = `a${++this.seq}`;

    // `-l -c <command>` for an agent; a bare login shell for a terminal, which
    // is interactive because its stdio is a pty and zsh can see that.
    const args = kind === "shell" && !options.command ? ["-l"] : ["-l", "-c", command];

    const pty = spawn(shell, args, {
      name: "xterm-256color",
      cols: screenSize.cols,
      rows: screenSize.rows,
      cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        /**
         * So a hook running inside this agent can report back about *itself*
         * without having to work out which agent it is. See `report.ts`.
         */
        KURURU_AGENT_ID: id,
        KURURU_PORT: String(process.env.KURURU_PORT ?? 7717),
      } as Record<string, string>,
    });

    const screen = new Screen();
    const agent: Agent = {
      id,
      kind,
      pty,
      screen,
      status: new StatusTracker(() => this.onChange()),
      cwd,
      command,
      createdAt: Date.now(),
      unread: false,
      contextUsage: null,
      exited: false,
      exitCode: null,
      titleOverride: null,
      title: null,
    };

    /**
     * The emulator has already decided this is worth saying — it only calls back
     * when the cleaned title differs from the last one — so there is nothing to
     * throttle here. An empty title is a program handing the name back rather
     * than naming the terminal "", so it becomes null and the label falls
     * through to whatever we would have called it.
     */
    screen.onTitle = (title) => {
      agent.title = title || null;
      this.onChange();
    };

    pty.onData((data) => {
      agent.screen.write(data);
      agent.status.recordOutput();
      this.onOutput(id, data);
      // Output nobody is looking at is the definition of unread.
      if (!this.watched.has(id) && !agent.unread) {
        agent.unread = true;
        this.onChange();
      }
    });

    pty.onExit(({ exitCode }) => {
      agent.exited = true;
      agent.exitCode = exitCode;
      agent.status.setAgent(null);
      this.onChange();
    });

    this.agents.set(id, agent);
    this.onChange();
    return this.toSnapshot(agent);
  }

  /** Type at an agent. Throws rather than silently dropping into a dead pty. */
  write(id: string, text: string): void {
    const agent = this.agents.get(id);
    if (!agent) throw new Error("no such agent");
    if (agent.exited) throw new Error("agent has exited");
    agent.status.recordInput();
    agent.pty.write(text);
  }

  /**
   * Kill and forget. Safe on an agent that has already exited — that is the
   * dismiss case, and the whole point of keeping exited agents listed.
   */
  kill(id: string): void {
    const agent = this.agents.get(id);
    if (!agent) throw new Error("no such agent");
    if (!agent.exited) {
      const pid = agent.pty.pid;
      if (!signalGroup(pid, "SIGHUP")) {
        try {
          agent.pty.kill();
        } catch {
          // Already gone between the check and the kill; nothing to do.
        }
      }
      // Anything still up after the grace period is not going to leave politely.
      setTimeout(() => {
        if (groupAlive(pid)) signalGroup(pid, "SIGKILL");
      }, GRACE_MS).unref?.();
    }
    agent.screen.dispose();
    this.agents.delete(id);
    this.watched.delete(id);
    this.onChange();
  }

  /** Name a tab. An empty name hands it back to whatever we would have called it. */
  rename(id: string, name: string): void {
    const agent = this.agents.get(id);
    if (!agent) throw new Error("no such agent");
    agent.titleOverride = name.trim() || null;
    this.onChange();
  }

  /** An agent told us about itself. Authoritative over the heuristic, for good. */
  report(id: string, report: AgentReport): boolean {
    const agent = this.agents.get(id);
    if (!agent) return false;
    if (report.status) agent.status.report(report.status);
    if (report.context) agent.contextUsage = report.context;
    this.onChange();
    return true;
  }

  /**
   * Which agents somebody is looking at. Output to a watched agent is not
   * unread, and watching one clears the mark it already has.
   */
  setWatched(ids: Iterable<string>): void {
    this.watched = new Set(ids);
    let changed = false;
    for (const id of this.watched) {
      const agent = this.agents.get(id);
      if (agent?.unread) {
        agent.unread = false;
        changed = true;
      }
    }
    if (changed) this.onChange();
  }

  /**
   * Resize the pty and the emulator beside it, together. A pty has one size and
   * a terminal can be on screen in more than one pane, so this is last-writer-
   * wins; the alternative is picking a winner, and the pane that just changed
   * size is the one the user is looking at.
   *
   * An exited agent still resizes, and only the pty half is skipped. Its screen
   * is the sole record of what it said, and that record is handed out by being
   * serialized at the emulator's current width — so a dead terminal that refused
   * to reflow would hand every pane that opened it a screen laid out for the box
   * it died in. The buffer is frozen, not immutable: reflowing it is exactly
   * what a live one does when its pane changes shape, and there is no SIGWINCH
   * to send about it.
   */
  resize(id: string, cols: number, rows: number): void {
    const agent = this.agents.get(id);
    if (!agent) return;
    /**
     * Integers first, and the order matters more than it looks. Every comparison
     * against a non-number is false, so `undefined` walks straight through the
     * bounds check below — and lands in the emulator, whose public `resize`
     * throws on anything that is not an integer. That throw comes out of a
     * message handler in the process that owns every pty, and this process
     * dying is the most expensive failure kururu has. A size that is not a size
     * is therefore not a resize: the pane that sent it will send another one.
     */
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) return;
    // A zero here is a pane that has not been laid out yet, and SIGWINCH with a
    // zero column count makes a curses app draw nothing at all.
    if (cols < 2 || rows < 2) return;
    if (cols === agent.screen.cols && rows === agent.screen.rows) return;
    agent.screen.resize(cols, rows);
    if (agent.exited) return;
    try {
      agent.pty.resize(cols, rows);
    } catch {
      // The pty closed between the check and the call; the exit handler has it.
    }
  }

  /** Everything this terminal has said, for a pane that has just opened on it. */
  backlog(id: string): Promise<string> | null {
    return this.agents.get(id)?.screen.backlog() ?? null;
  }

  has(id: string): boolean {
    return this.agents.has(id);
  }

  /** Its pty is still open. What a profile's agent count is counting. */
  isLive(id: string): boolean {
    const agent = this.agents.get(id);
    return Boolean(agent && !agent.exited);
  }

  /** True when this one would be counted by a quit confirmation. See liveCount. */
  countsAsAgent(id: string): boolean {
    const agent = this.agents.get(id);
    if (!agent || agent.exited) return false;
    return agent.kind === "agent" || agent.status.agent !== null;
  }

  /** Live ptys that are somebody's work — see `countsAsAgent` for the rule. */
  liveCount(): number {
    return this.list().filter(countsAsAgent).length;
  }

  /** Every live pty, agent or not. Teardown cares about all of them. */
  liveTotal(): number {
    let n = 0;
    for (const agent of this.agents.values()) if (!agent.exited) n++;
    return n;
  }

  /** End-of-work detection: silence produces no event, so it needs a tick. */
  tick(): void {
    const now = Date.now();
    for (const agent of this.agents.values()) agent.status.tick(now);
  }

  /**
   * Re-read the process table and update which agent program is running in each
   * pty. One `ps` for all of them, not one each.
   */
  async scanPrograms(): Promise<void> {
    const live: [string, number][] = [];
    for (const agent of this.agents.values()) {
      if (!agent.exited) live.push([agent.id, agent.pty.pid]);
    }
    if (live.length === 0) return;
    const table = await readProcTable();
    const found = findAgents(live, table, DEFAULT_AGENT_COMMANDS);
    let changed = false;
    for (const [id] of live) {
      const agent = this.agents.get(id);
      if (!agent) continue;
      const name = found.get(id)?.kind ?? null;
      if (agent.status.agent !== name) {
        agent.status.setAgent(name);
        changed = true;
      }
    }
    if (changed) this.onChange();
  }

  /**
   * Every agent, oldest first. The arrangement they live in is not this file's
   * business — `workspaces.ts` owns that, and `index.ts` is what puts the two
   * together into one snapshot.
   */
  list(): AgentSnapshot[] {
    return [...this.agents.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((agent) => this.toSnapshot(agent));
  }

  private toSnapshot(agent: Agent): AgentSnapshot {
    return {
      id: agent.id,
      kind: agent.kind,
      title: agent.title,
      status: agent.status.status,
      agent: agent.status.agent,
      unread: agent.unread,
      cwd: agent.cwd,
      pid: agent.pty.pid,
      command: agent.command,
      createdAt: agent.createdAt,
      contextUsage: agent.contextUsage,
      titleOverride: agent.titleOverride,
      exited: agent.exited,
      exitCode: agent.exitCode,
    };
  }

  /**
   * Take every pty down, and wait long enough to be sure.
   *
   * This is the teardown the app owes the user on quit. It is deliberately not
   * fire-and-forget: an agent gets SIGHUP and a moment to finish what it is
   * doing, and only what is still standing after that gets SIGKILL. The caller
   * awaits this before telling Electron it may exit, because a process killed
   * halfway through writing a file is worse than a quit that took half a second.
   */
  async disposeAll(): Promise<void> {
    const pids: number[] = [];
    for (const agent of this.agents.values()) {
      if (!agent.exited) {
        pids.push(agent.pty.pid);
        signalGroup(agent.pty.pid, "SIGHUP");
      }
      agent.screen.dispose();
    }
    this.agents.clear();
    this.watched.clear();
    if (pids.length === 0) return;

    const deadline = Date.now() + GRACE_MS;
    while (Date.now() < deadline && pids.some(groupAlive)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    for (const pid of pids) {
      if (groupAlive(pid)) signalGroup(pid, "SIGKILL");
    }
  }
}
