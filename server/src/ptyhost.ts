/**
 * The pty host: the process that must not be restarted.
 *
 * Everything kururu cannot get back once it is gone lives in here — the ptys,
 * the emulators beside them, and whatever the server last told us the window
 * was arranged as. Nothing else does. There is no HTTP here, no WebSocket, no
 * layout logic, no `lsof`: those all change weekly, and anything that changes
 * weekly is a reason to restart, which is the one thing this process cannot
 * survive doing.
 *
 * That is the whole point of the split. `index.ts` can be killed and re-forked
 * in under a second — during development it is, on every save — and the agents
 * never know. What it cannot do is come back and find that its arrangement is
 * gone while the terminals it described are still running, so this file also
 * holds an opaque blob for it. The host does not look inside; it just gives it
 * back to whoever connects next.
 *
 * Restarting *this* still kills everything, and there is no clever way around
 * that: a live pty cannot be handed to a replacement process. Ghosttown's config
 * says the same thing about its daemon in the same words. So the rule when
 * editing kururu is simply: if a change would touch this file, it costs the
 * user their agents, and it should be batched with one that already does.
 *
 * `ptyhostd.ts` is the entry point that runs this as a daemon, and it is the
 * only one. This stays a factory rather than a module that does things on import
 * because the thing it makes is worth being able to make twice — in a test, in a
 * process that is also something else — and because a module with a running
 * timer in it the moment you import it is a module you cannot reason about.
 *
 * It used to be forked by Electron, and there was a second arrangement where the
 * server built one of these *inside itself* because there was no Electron to
 * fork anything. That second one quietly did not deliver the split at all: the
 * ptys were in the process being restarted. There is one arrangement now.
 */
import type { AgentReport, AgentSnapshot } from "../../shared/model";
import { AGENT_SCAN_MS, OUTPUT_FLUSH_MS, STATUS_TICK_MS } from "../../shared/wire";
import { AgentHost } from "./agents/host";
import { HOST_PROTOCOL, type FromHost, type Port, type ToHost } from "./hostlink";
import { VERSION } from "./version";

export interface PtyHost {
  /** Give it the server's end of the link. A second call replaces the first —
   * which *is* a server restart, and the new server's `hello` refills it. */
  attach(port: Port): void;
  /** How many agents would be killed by quitting — what a confirmation needs. */
  liveCount(): number;
  shutdown(): Promise<void>;
}

export function createPtyHost(): PtyHost {
  const host = new AgentHost();

  /**
   * The arrangement, as the last server had it. Opaque on purpose: the moment this
   * file knows what a workspace is, changing what a workspace is means restarting
   * the process that owns the ptys.
   */
  let blob: string | null = null;

  /** The server's end of the link, once the main process has handed it over. */
  let port: Port | null = null;

  function send(msg: FromHost): void {
    port?.postMessage(msg);
  }

  function reply(id: number, run: () => unknown): void {
    try {
      send({ type: "reply", id, ok: true, result: run() ?? true });
    } catch (err) {
      send({ type: "reply", id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function replyAsync(id: number, run: () => Promise<unknown>): Promise<void> {
    try {
      send({ type: "reply", id, ok: true, result: (await run()) ?? true });
    } catch (err) {
      send({ type: "reply", id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ---------------------------------------------------------------------------
  // Pushing
  // ---------------------------------------------------------------------------

  /**
   * The agent list is pushed on change rather than asked for, and coalesced to a
   * microtask: several things change in one turn of the event loop — a pty exits,
   * its status settles, its program disappears — and each of them calls onChange.
   */
  let queued = false;
  host.onChange = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      send({ type: "agents", agents: host.list() });
    });
  };

  /**
   * Output is coalesced here rather than at the socket, because this is where the
   * flood is: a pty mid-build emits thousands of writes a second and each one
   * would otherwise be a message across the process boundary as well as a frame.
   *
   * Only what somebody is watching is buffered at all. Every pty's bytes still go
   * through its own emulator — that is what makes history possible — but bytes for
   * a terminal nobody has open never leave this process.
   */
  const pending = new Map<string, string>();
  let watched = new Set<string>();

  host.onOutput = (id, data) => {
    if (!watched.has(id)) return;
    pending.set(id, (pending.get(id) ?? "") + data);
  };

  function flush(): void {
    if (pending.size === 0) return;
    for (const [agentId, data] of pending) send({ type: "output", agentId, data });
    pending.clear();
  }

  const timers = [
    setInterval(() => host.tick(), STATUS_TICK_MS),
    setInterval(flush, OUTPUT_FLUSH_MS),
    setInterval(() => void host.scanPrograms(), AGENT_SCAN_MS),
  ];

  // ---------------------------------------------------------------------------
  // The link
  // ---------------------------------------------------------------------------

  function handle(msg: ToHost): void {
    switch (msg.type) {
      case "hello":
        // A server has come up — this one, or the one that replaced it. Either way
        // it knows nothing yet, so it gets both halves of what survived — and
        // which build and protocol this is, so that a server newer than this
        // process can tell rather than guess. See `HOST_PROTOCOL`.
        reply(msg.id, () => ({ agents: host.list(), blob, version: VERSION, protocol: HOST_PROTOCOL }));
        return;

      /**
       * Everything but the framing, handed straight through.
       *
       * This listed the fields once — `{ cwd, command, kind }` — and that cost a
       * restart nobody had budgeted for. A fourth field was added to the
       * protocol, to `HostLink.create` and to `AgentHost.create`, and dropped
       * here, one line before it would have been used: passing fewer properties
       * than an optional parameter accepts is perfectly good TypeScript, so
       * nothing said a word. The symptom was terminals that quietly ignored it,
       * with correct code on both sides of this line.
       *
       * So the relay no longer names them. `type` and `id` are the envelope and
       * everything else is the request, which means the next field added to a
       * `create` arrives here whether or not anybody remembered this file — and
       * this is the file where forgetting is most expensive.
       */
      case "create": {
        const { type, id, ...options } = msg;
        reply(id, () => host.create(options));
        return;
      }

      case "backlog":
        void replyAsync(msg.id, async () => (await host.backlog(msg.agentId)) ?? "");
        return;

      case "kill":
        try {
          host.kill(msg.agentId);
        } catch {
          // Already gone, which is the outcome the caller wanted anyway.
        }
        return;

      case "write":
        try {
          host.write(msg.agentId, msg.data);
        } catch {
          // Typing into a pty that has exited; the agent list already says so.
        }
        return;

      case "resize":
        host.resize(msg.agentId, msg.cols, msg.rows);
        return;

      case "rename":
        try {
          host.rename(msg.agentId, msg.name);
        } catch {
          // Renaming a tab that has just been closed.
        }
        return;

      case "report":
        host.report(msg.agentId, msg.report as AgentReport);
        return;

      case "watch": {
        watched = new Set(msg.agentIds);
        host.setWatched(watched);
        // Anything buffered for a terminal nobody is watching any more is stale.
        for (const id of [...pending.keys()]) if (!watched.has(id)) pending.delete(id);
        return;
      }

      case "blob":
        blob = msg.data;
        return;
    }
  }

  // ---------------------------------------------------------------------------
  // Teardown
  // ---------------------------------------------------------------------------

  let stopping: Promise<void> | null = null;

  /**
   * The ptys are the reason this exists: one whose owner exited is not reaped by
   * anybody else, and its agent would keep running with nothing attached to it and
   * no way to get back to it.
   */
  function shutdown(): Promise<void> {
    if (stopping) return stopping;
    stopping = (async () => {
      for (const timer of timers) clearInterval(timer);
      try {
        port?.close?.();
      } catch {
        // The other end may already be gone; that is what we are here for.
      }
      await host.disposeAll();
    })();
    return stopping;
  }

  return {
    attach(incoming: Port) {
      port = incoming;
      /**
       * Nothing arriving on this port may end the process.
       *
       * Everything carrying an `id` is already answered through `reply`, which
       * turns a throw into a refusal the caller can see. The fire-and-forget
       * verbs had no such floor, and they are messages from a process that is
       * *meant* to be restarted freely — so a field that went missing across a
       * protocol change, or an argument the emulator will not accept, arrived
       * here as an uncaught exception and took every agent in this process with
       * it. That is a disproportion nothing justifies: the server can be forked
       * again in a second and a pty cannot be handed to anybody.
       *
       * Logged rather than swallowed, because the alternative failure — a verb
       * that quietly does nothing — is the kind that is debugged by staring at
       * a terminal wondering why it will not resize.
       */
      incoming.on("message", (event) => {
        try {
          handle((event && event.data !== undefined ? event.data : event) as ToHost);
        } catch (err) {
          console.error("kururu pty host: a message threw and was dropped", err);
        }
      });
      incoming.start?.();
    },
    liveCount: () => host.liveCount(),
    shutdown,
  };
}

export type { AgentSnapshot };
