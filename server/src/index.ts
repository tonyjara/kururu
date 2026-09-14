/**
 * The kururu server: one process between the ghosttown daemon and every UI.
 *
 * It holds a socket open to the daemon, polls it, and pushes what changed down
 * a WebSocket to whoever is watching — the desktop window and the phone are the
 * same client code talking to this same server, which is what keeps the two
 * from drifting. It also serves the built web app, so Electron loads a URL
 * rather than a file and there is exactly one asset pipeline.
 *
 * Polling is a placeholder with a known replacement: ghosttown's control
 * protocol is request/response with no way to push, so "what changed" can only
 * be found by asking. Over a unix socket on the same machine that is cheap, and
 * the diff means a quiet session sends nothing over the tailnet. When the
 * daemon grows an event stream, the loops here become subscriptions and nothing
 * above this file changes.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SessionSnapshot } from "../../shared/ghosttown";
import type { ClientMessage, DevServer, ServerMessage } from "../../shared/wire";
import { DEV_SCAN_MS, SCREEN_POLL_MS, SNAPSHOT_POLL_MS } from "../../shared/wire";
import { DaemonLink, runningSessions } from "./daemon";
import { scanDevServers } from "./devservers";
import { allowedRoots, allowRoot, listDir, readFile } from "./files";
import { closePreview, openPreview, openPreviews } from "./proxy";

const PORT = Number(process.env.KURURU_PORT ?? 7717);
const DEV = process.env.KURURU_DEV === "1";
const WEB_DIST = join(import.meta.dir, "../../web/dist");

/**
 * Extra directories the file browser may read, colon-separated. Dev server
 * cwds are added automatically; this is for a project with nothing running in
 * it yet. Set at launch by the person running the server, never by a client.
 */
for (const dir of (process.env.KURURU_ROOTS ?? "").split(":")) allowRoot(dir.trim() || undefined);

interface ClientState {
  /** Surface whose screen this client is showing, if any. */
  watching: string | null;
}

/** Everything the server knows, kept so a new client can be caught up in one go. */
const state = {
  snapshot: null as SessionSnapshot | null,
  devServers: [] as DevServer[],
  sessions: [] as string[],
  connected: false,
};

const clients = new Set<Bun.ServerWebSocket<ClientState>>();

function send(ws: Bun.ServerWebSocket<ClientState>, msg: ServerMessage): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // client went away mid-send; the close handler will clean up
  }
}

function broadcast(msg: ServerMessage): void {
  const payload = JSON.stringify(msg);
  for (const ws of clients) {
    try {
      ws.send(payload);
    } catch {
      // ditto
    }
  }
}

// ---------------------------------------------------------------------------
// The daemon link, and the loops that watch it
// ---------------------------------------------------------------------------

const initialSession = process.env.KURURU_SESSION ?? runningSessions()[0] ?? "main";
const link = new DaemonLink(initialSession);

link.onState = (connected, error) => {
  state.connected = connected;
  if (!connected) state.snapshot = null;
  broadcast({ type: "daemon", connected, error });
};
link.start();

/** JSON compare: the snapshot is small, and it is the only thing we diff. */
let lastSnapshotJson = "";

async function pollSnapshot(): Promise<void> {
  if (!link.connected) return;
  try {
    const snapshot = (await link.call("list")) as SessionSnapshot;
    const json = JSON.stringify(snapshot);
    if (json === lastSnapshotJson) return;
    lastSnapshotJson = json;
    state.snapshot = snapshot;
    broadcast({ type: "snapshot", snapshot });
  } catch {
    // A failed poll is normal while the daemon restarts; the link retries.
  }
}

/**
 * Only the surfaces someone is actually looking at. A profile can hold a dozen
 * agents, and reading every screen every second would be most of this server's
 * work for a view nobody has open.
 */
const lastScreen = new Map<string, string>();

async function pollScreens(): Promise<void> {
  if (!link.connected) return;
  const wanted = new Set<string>();
  for (const ws of clients) {
    if (ws.data.watching) wanted.add(ws.data.watching);
  }
  for (const surfaceId of lastScreen.keys()) {
    if (!wanted.has(surfaceId)) lastScreen.delete(surfaceId);
  }
  for (const surfaceId of wanted) {
    try {
      const res = (await link.call("read-screen", { surface: surfaceId })) as { text: string };
      const text = trimTrailingBlank(res.text ?? "");
      if (lastScreen.get(surfaceId) === text) continue;
      lastScreen.set(surfaceId, text);
      for (const ws of clients) {
        if (ws.data.watching === surfaceId) send(ws, { type: "screen", surfaceId, text });
      }
    } catch {
      // surface closed between the snapshot and the read
    }
  }
}

/** A terminal screen is padded to its full height; the blank rows are not content. */
function trimTrailingBlank(text: string): string {
  const lines = text.split("\n");
  while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines.join("\n");
}

let lastDevJson = "";

async function pollDevServers(): Promise<void> {
  const servers = await scanDevServers();
  for (const server of servers) allowRoot(server.cwd);
  const proxied = openPreviews();
  for (const server of servers) {
    const proxyPort = proxied.get(server.port);
    if (proxyPort) server.proxyPort = proxyPort;
  }
  // A proxy whose dev server has stopped is holding a port for nothing.
  const live = new Set(servers.map((s) => s.port));
  for (const devPort of proxied.keys()) {
    if (!live.has(devPort)) closePreview(devPort);
  }
  const json = JSON.stringify(servers);
  if (json === lastDevJson) return;
  lastDevJson = json;
  state.devServers = servers;
  broadcast({ type: "dev-servers", servers });
}

function pollSessions(): void {
  const sessions = runningSessions();
  if (JSON.stringify(sessions) === JSON.stringify(state.sessions)) return;
  state.sessions = sessions;
  broadcast({ type: "sessions", sessions, active: link.session });
}

setInterval(() => void pollSnapshot(), SNAPSHOT_POLL_MS);
setInterval(() => void pollScreens(), SCREEN_POLL_MS);
setInterval(() => void pollDevServers(), DEV_SCAN_MS);
setInterval(pollSessions, 2000);
void pollSnapshot();
void pollDevServers();
pollSessions();

// ---------------------------------------------------------------------------
// HTTP + WebSocket
// ---------------------------------------------------------------------------

async function handleMessage(ws: Bun.ServerWebSocket<ClientState>, raw: string): Promise<void> {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw) as ClientMessage;
  } catch {
    return;
  }

  switch (msg.type) {
    case "call": {
      try {
        const result = await link.call(msg.method, msg.params ?? {});
        send(ws, { type: "reply", id: msg.id, ok: true, result });
      } catch (err) {
        send(ws, { type: "reply", id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    case "watch-screen": {
      ws.data.watching = msg.surfaceId;
      // Answer immediately from cache so switching tabs is not a poll away.
      if (msg.surfaceId) {
        const cached = lastScreen.get(msg.surfaceId);
        if (cached !== undefined) send(ws, { type: "screen", surfaceId: msg.surfaceId, text: cached });
      }
      void pollScreens();
      return;
    }
    case "select-session": {
      link.switchTo(msg.session);
      lastSnapshotJson = "";
      lastScreen.clear();
      broadcast({ type: "sessions", sessions: state.sessions, active: link.session });
      void pollSnapshot();
      return;
    }
    case "open-preview": {
      try {
        openPreview(msg.port);
      } catch {
        // out of preview ports; the next dev-servers push just omits proxyPort
      }
      lastDevJson = "";
      void pollDevServers();
      return;
    }
  }
}

const server = Bun.serve<ClientState>({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 0,

  async fetch(req, srv) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      if (srv.upgrade(req, { data: { watching: null } satisfies ClientState })) return undefined;
      return new Response("expected a websocket upgrade", { status: 400 });
    }

    if (url.pathname === "/api/health") {
      return Response.json({
        ok: true,
        session: link.session,
        daemon: link.connected,
        agents: state.snapshot?.agents.length ?? 0,
        devServers: state.devServers.length,
      });
    }

    // --- file browsing -----------------------------------------------------
    if (url.pathname === "/api/roots") {
      return Response.json({ roots: allowedRoots() });
    }
    if (url.pathname === "/api/ls" || url.pathname === "/api/file") {
      const root = url.searchParams.get("root") ?? "";
      const path = url.searchParams.get("path") ?? "";
      try {
        return Response.json(
          url.pathname === "/api/ls" ? { entries: listDir(root, path) } : readFile(root, path),
        );
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
      }
    }

    if (DEV) {
      return new Response(
        `kururu server is up on :${PORT}.\nThe UI is served by vite in dev — run \`bun run dev:web\` and open http://localhost:5173\n`,
        { headers: { "content-type": "text/plain" } },
      );
    }

    // Built app. Unknown paths fall through to index.html so the client router
    // owns them; assets are matched first so a missing one still 404s.
    const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = Bun.file(join(WEB_DIST, rel));
    if (await file.exists()) return new Response(file);
    const index = Bun.file(join(WEB_DIST, "index.html"));
    if (await index.exists()) return new Response(index);
    return new Response("kururu: web app not built. Run `bun run build`.", { status: 404 });
  },

  websocket: {
    open(ws) {
      clients.add(ws);
      send(ws, { type: "daemon", connected: state.connected });
      send(ws, { type: "sessions", sessions: state.sessions, active: link.session });
      if (state.snapshot) send(ws, { type: "snapshot", snapshot: state.snapshot });
      send(ws, { type: "dev-servers", servers: state.devServers });
    },
    message(ws, message) {
      void handleMessage(ws, typeof message === "string" ? message : new TextDecoder().decode(message));
    },
    close(ws) {
      clients.delete(ws);
    },
  },
});

const built = existsSync(WEB_DIST);
console.log(`kururu server  http://localhost:${server.port}`);
console.log(`  profile      ${link.session}${state.sessions.length > 1 ? `  (of ${state.sessions.join(", ")})` : ""}`);
console.log(`  web app      ${DEV ? "vite dev — bun run dev:web" : built ? WEB_DIST : "not built — bun run build"}`);
