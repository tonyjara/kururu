/**
 * The pty host, as a process.
 *
 * Everything it does is in `ptyhost.ts`; this is only the wiring to Electron —
 * kept apart so that the host itself is a plain factory with no opinion about
 * how it was started. That matters for the arrangement where there is no
 * Electron at all: `bun run dev` has nothing to fork, so the server builds one
 * of these in its own process and links to it locally, and neither side can tell
 * the difference.
 *
 * The main process hands each of its two children one end of a MessageChannel,
 * so the server and the host talk to each other directly. The main process is
 * never in the middle of a terminal's output — it has a window to draw.
 */
import { createPtyHost } from "./ptyhost";
import type { Port } from "./hostlink";

const host = createPtyHost();

const parentPort = (process as NodeJS.Process & {
  parentPort?: {
    on(ev: string, fn: (e: { data: unknown; ports?: Port[] }) => void): void;
    postMessage(msg: unknown): void;
  };
}).parentPort;

if (parentPort) {
  parentPort.on("message", (event) => {
    const data = event.data as { type?: string } | null;
    const incoming = event.ports?.[0];

    // A fresh port is a fresh server — the old one has been re-forked.
    if (data?.type === "link" && incoming) return host.attach(incoming);

    if (data?.type === "live-agents") {
      parentPort.postMessage({ type: "live-agents", count: host.liveCount() });
      return;
    }
    if (data?.type === "shutdown") {
      // Acknowledged only once the ptys are actually gone — the app treats this
      // as permission to exit, and exiting first is what orphans them.
      void host.shutdown().then(() => parentPort.postMessage({ type: "shutdown-done" }));
    }
  });
} else {
  console.error("kururu: the pty host was started with nothing to talk to");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void host.shutdown().then(() => process.exit(0));
  });
}
