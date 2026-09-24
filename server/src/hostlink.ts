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

/**
 * Which host this server can be fully understood by.
 *
 * The host does not pick up a new bundle until it is restarted, and restarting
 * it ends every agent, so it is routinely older than the server talking to it.
 * Most of the time that is fine: the relay in `ptyhost.ts` hands every field of
 * a `create` through, and a host that ignores one it does not know about does
 * so silently — which is exactly the problem. A terminal opened with an `env`
 * an old host dropped is a terminal opened as somebody you did not expect.
 *
 * So the host says which protocol it speaks in its `hello`, and this is the
 * number it is compared against. Bumped when — and only when — the host has to
 * be restarted for something the server now sends to take effect. A version
 * string cannot do this job: in a checkout both halves are `0.0.0-dev` however
 * far apart their code is.
 *
 *   1  everything before the handshake carried one
 *   2  `create` takes `env`; `hello` answers with `version` and `protocol`
 */
export const HOST_PROTOCOL = 2;

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
  /**
   * `env` goes on top of the host's own environment — a profile's login
   * directories, today. Protocol 2: a host from before it drops the field and
   * says nothing, which is why the server checks `protocol` before sending one.
   */
  | { type: "create"; id: number; cwd?: string; command?: string; kind?: PtyKind; env?: Record<string, string> }
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
  /** The host's build, or null for one from before the handshake carried it. */
  version: string | null;
  /** The protocol it speaks — see `HOST_PROTOCOL`. A host that says nothing is at 1. */
  protocol: number;
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
    const state = await this.request<Partial<HostState>>((id) => ({ type: "hello", id }));
    this.agents = state.agents ?? [];
    return {
      agents: this.agents,
      blob: typeof state.blob === "string" ? state.blob : null,
      // Read as anything off the link is. A host from before the handshake
      // carried these sends neither, and that absence is the whole reading: it
      // speaks the first protocol, whatever build it is.
      version: typeof state.version === "string" ? state.version : null,
      protocol: Number.isInteger(state.protocol) && (state.protocol as number) >= 1 ? (state.protocol as number) : 1,
    };
  }

  /**
   * Spawn a pty — and take the reply as news about the agent list as well as an
   * answer, exactly as `hello` does and for the same reason.
   *
   * The `agents` push that follows says it too, and says it completely. But it
   * is a separate frame on a socket, coalesced to a microtask on the host's
   * side, so it lands a turn of the event loop later than the reply. In between
   * there is a window where this server knows an agent exists — it is on the
   * next line, putting it in a pane — and `agents` does not list it. Anything
   * that pushes a snapshot in that window sends a layout naming a terminal the
   * same snapshot says is not there.
   *
   * The client is entitled to believe that, and does: `web/src/terminals.ts`
   * disposes the emulator of every agent a snapshot has stopped listing, which
   * is the only way it is ever told a terminal has ended. So a brand-new tab had
   * its emulator built and thrown away in the same breath, and came back black
   * — until it was switched away from and back, which borrowed a second one.
   */
  async create(options: {
    cwd?: string;
    command?: string;
    kind?: PtyKind;
    env?: Record<string, string>;
  }): Promise<AgentSnapshot> {
    const agent = await this.request<AgentSnapshot>((id) => ({ type: "create", id, ...options }));
    // Appended rather than spliced in anywhere: the host lists oldest first and
    // this is the newest, which is what `cwdForNewTab` reads the order for.
    if (!this.agents.some((held) => held.id === agent.id)) this.agents = [...this.agents, agent];
    return agent;
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
