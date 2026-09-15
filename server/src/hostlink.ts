/**
 * The wire between the two halves of the server process.
 *
 * Kururu's agents die when the app quits, and that is deliberate (PLAN.md,
 * principle 1). What was *not* deliberate is that they also died whenever the
 * server was restarted — which, during development, is constantly. The two are
 * different things and there was no seam between them, because one process owned
 * both the ptys and every line of protocol, layout and discovery code around
 * them.
 *
 * This is that seam. On one side, `ptyhost.ts`: node-pty, the emulators, the
 * status heuristic, and a blob of opaque state it holds for whoever is talking
 * to it. On the other, `index.ts`: HTTP, WebSockets, the arrangement, dev-server
 * discovery — everything that changes often. The first can be restarted only by
 * quitting; the second can be thrown away and re-forked in a second, and the
 * agents do not notice.
 *
 * Ghosttown draws the same line one process further out, and its config file is
 * honest about the part neither of us can do: *"there is no way to hand a live
 * pty to its replacement."* So the rule for this file is simple — anything that
 * would make `ptyhost.ts` need editing belongs on the other side of it.
 *
 * This file is the protocol and nothing else — what the two say to each other,
 * not how it travels. `hostsock.ts` carries it over a unix socket, which is the
 * only transport there is; it was an Electron `MessagePortMain` once, and the
 * change of transport is why the host can now run on a machine that has no
 * window on it at all.
 */
import type { AgentReport, AgentSnapshot, PtyKind } from "../../shared/model";

/** Anything with `postMessage`/`on("message")` — a MessagePortMain, in practice. */
export interface Port {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  start?(): void;
  close?(): void;
}

export type ToHost =
  /** Asks for everything a freshly-started server needs: the agents, and the blob. */
  | { type: "hello"; id: number }
  | { type: "create"; id: number; cwd?: string; command?: string; kind?: PtyKind }
  | { type: "kill"; agentId: string }
  | { type: "write"; agentId: string; data: string }
  | { type: "resize"; agentId: string; cols: number; rows: number }
  | { type: "rename"; agentId: string; name: string }
  | { type: "report"; agentId: string; report: AgentReport }
  /** Which terminals anybody is looking at. Output for the rest is never sent. */
  | { type: "watch"; agentIds: string[] }
  | { type: "backlog"; id: number; agentId: string }
  /**
   * The arrangement, as the server last had it, for the host to hold on to.
   *
   * The host never looks inside. It is the thing that makes a server restart
   * invisible: the ptys were never the only state worth keeping — a layout full
   * of tabs pointing at them is no use if it comes back empty, and the disk
   * snapshot deliberately strips the processes out.
   */
  | { type: "blob"; data: string };

export type FromHost =
  /** Pushed whenever anything about any agent changes. Complete, never a delta. */
  | { type: "agents"; agents: AgentSnapshot[] }
  | { type: "output"; agentId: string; data: string }
  | { type: "reply"; id: number; ok: true; result: unknown }
  | { type: "reply"; id: number; ok: false; error: string };

export interface HostState {
  agents: AgentSnapshot[];
  /** What the last server left behind, or null on a cold start. */
  blob: string | null;
}

/**
 * The server's end of the link.
 *
 * Calls that can fail or need an answer are promises over a reply id; the rest
 * are posted and forgotten, because the `agents` push that follows says what
 * happened and says it completely.
 */
export class HostLink {
  private port: Port;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  /** Latest agent list, pushed by the host. Read synchronously all over index.ts. */
  agents: AgentSnapshot[] = [];

  /** Called when the agent list changes. */
  onAgents: () => void = () => {};
  /** Called with coalesced output for a watched terminal. */
  onOutput: (agentId: string, data: string) => void = () => {};

  constructor(port: Port) {
    this.port = port;
    port.on("message", (event) => {
      const msg = (event && (event as { data?: unknown }).data !== undefined
        ? (event as { data: unknown }).data
        : event) as FromHost;
      if (!msg || typeof msg !== "object") return;
      switch (msg.type) {
        case "agents":
          this.agents = msg.agents;
          this.onAgents();
          return;
        case "output":
          this.onOutput(msg.agentId, msg.data);
          return;
        case "reply": {
          const waiting = this.pending.get(msg.id);
          if (!waiting) return;
          this.pending.delete(msg.id);
          if (msg.ok) waiting.resolve(msg.result);
          else waiting.reject(new Error(msg.error));
          return;
        }
      }
    });
    port.start?.();
  }

  private send(msg: ToHost): void {
    this.port.postMessage(msg);
  }

  private request<T>(make: (id: number) => ToHost): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.send(make(id));
    });
  }

  /**
   * First thing a server does: find out what is already running, and what it was
   * arranged as.
   *
   * The answer seeds the cache as well as being returned. Without that, a
   * restarted server has an arrangement full of tabs and an empty agent list
   * until the next thing happens to change one — so the window comes back
   * correct in shape and empty of contents, which is worse than either.
   */
  async hello(): Promise<HostState> {
    const state = await this.request<HostState>((id) => ({ type: "hello", id }));
    this.agents = state.agents;
    return state;
  }

  create(options: { cwd?: string; command?: string; kind?: PtyKind }): Promise<AgentSnapshot> {
    return this.request<AgentSnapshot>((id) => ({ type: "create", id, ...options }));
  }

  backlog(agentId: string): Promise<string> {
    return this.request<string>((id) => ({ type: "backlog", id, agentId }));
  }

  kill(agentId: string): void {
    this.send({ type: "kill", agentId });
  }

  write(agentId: string, data: string): void {
    this.send({ type: "write", agentId, data });
  }

  resize(agentId: string, cols: number, rows: number): void {
    this.send({ type: "resize", agentId, cols, rows });
  }

  rename(agentId: string, name: string): void {
    this.send({ type: "rename", agentId, name });
  }

  report(agentId: string, report: AgentReport): void {
    this.send({ type: "report", agentId, report });
  }

  watch(agentIds: Iterable<string>): void {
    this.send({ type: "watch", agentIds: [...agentIds] });
  }

  /** Hand the arrangement over for safekeeping across our own restart. */
  keep(blob: string): void {
    this.send({ type: "blob", data: blob });
  }

  // Conveniences over the cached list, so index.ts does not filter in six places.

  find(agentId: string): AgentSnapshot | undefined {
    return this.agents.find((agent) => agent.id === agentId);
  }

  isLive(agentId: string): boolean {
    const agent = this.find(agentId);
    return Boolean(agent && !agent.exited);
  }
}
