/**
 * Reverse proxy that gives a dev server an origin a phone can reach.
 *
 * The desktop window never needs this — localhost is the same machine, so the
 * preview iframe points straight at the dev server. The phone cannot: its own
 * localhost is the phone. So each previewed dev server gets a proxy listener
 * here, and `tailscale serve` is pointed at *that*.
 *
 * Why a port per preview, rather than one listener and a `/preview/<id>/` path:
 * dev servers emit absolute URLs (`/@vite/client`, `/src/main.tsx`,
 * `/node_modules/.vite/deps/…`), so a path prefix breaks on the first asset and
 * the only fix is rewriting every absolute URL in the HTML, the JS and the CSS.
 * A port is an origin, and an origin makes all of that somebody else's problem.
 *
 * Two things this hop buys that pointing tailscale at the dev server directly
 * would not:
 *
 *  - The Host header is rewritten to the upstream's own. Vite has refused
 *    requests carrying an unfamiliar Host since 5.4.12/6.0.9, and a tailnet
 *    name is about as unfamiliar as it gets; rewriting it here means no project
 *    needs `server.allowedHosts` added to its config to be previewable.
 *  - Frame-blocking headers are stripped, so the preview can live in an iframe.
 *
 * The upstream hop is `http.request` and a pipe, not `fetch`. That matters: a
 * fetch decodes the body but forwards `content-encoding` untouched, so a gzipped
 * asset arrives at the browser decompressed and still labelled gzip. Piping
 * bytes keeps the body and the headers describing it in agreement by
 * construction, and streams without buffering as a side effect.
 */
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket as UpstreamSocket, WebSocketServer, type RawData } from "ws";

/** First port handed out to a preview. Below the ephemeral range, above the usual dev ports. */
const BASE_PORT = 7800;

interface Preview {
  devPort: number;
  proxyPort: number;
  server: Server;
  sockets: WebSocketServer;
}

const previews = new Map<number, Preview>();

/**
 * Which proxy port a dev server has *ever* been given, kept after its preview
 * closes.
 *
 * The point is a bookmark. A phone reaches a preview by typing an origin once
 * and then never again — the tailnet address and a port, added to a home
 * screen — so the port has to mean the same thing tomorrow that it meant today.
 * Without this it does not survive the one gesture most likely to follow it:
 * pressing the row's restart button drops the dev server for a second, the
 * scan closes the preview, and with two projects open the *other* one takes the
 * freed slot before the first comes back. The icon on the home screen then
 * opens somebody else's app, which is worse than opening nothing.
 *
 * Reservations are never reclaimed, because the thing they are protecting
 * against is exactly reuse, and two hundred of them is a map with two hundred
 * numbers in it. They die with the process, which is the same lifetime as the
 * ports themselves.
 */
const reserved = new Map<number, number>();

/** Headers that describe *this* hop and must not be forwarded to the next one. */
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host",
]);

/**
 * Vite's refusal is a 403 with this exact body. Recognising it turns a blank
 * iframe into something that says what to do — the single most likely way a
 * first preview fails.
 */
const VITE_BLOCKED = "This host is not allowed";

function blockedHostPage(devPort: number): string {
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:15px/1.6 -apple-system,system-ui,sans-serif;margin:0;padding:24px;background:#111;color:#eee}
code{background:#222;padding:2px 6px;border-radius:4px;font-size:13px}
h1{font-size:17px;margin:0 0 12px}p{color:#aaa;max-width:40em}</style>
<h1>The dev server on :${devPort} refused this host</h1>
<p>It is checking the <code>Host</code> header and does not recognise the one it got.
Kururu already rewrites <code>Host</code> to <code>localhost:${devPort}</code>, so this is a
server that checks something else — an origin allowlist, or a proxy setting of its own.</p>
<p>For Vite, add to <code>vite.config.ts</code>:</p>
<p><code>server: { allowedHosts: ['.ts.net'] }</code></p>`;
}

/** Copy a request's headers, minus the ones that belong to this hop. */
function forwardHeaders(source: IncomingHttpHeaders, hostValue: string): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  out.host = hostValue;
  return out;
}

/** Strip what would stop the response rendering inside our iframe. */
function unframe(source: IncomingHttpHeaders): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = { ...source };
  // Node stamps its own on the way out; forwarding upstream's sends two.
  delete out.date;
  delete out["x-frame-options"];
  delete out["content-security-policy-report-only"];
  const csp = out["content-security-policy"];
  if (typeof csp === "string") {
    const kept = csp
      .split(";")
      .filter((d) => !/^\s*frame-ancestors/i.test(d))
      .join(";")
      .trim();
    if (kept) out["content-security-policy"] = kept;
    else delete out["content-security-policy"];
  }
  return out;
}

/** The subprotocols a client offered, in the order it offered them. */
function offeredProtocols(header: string | string[] | undefined): string[] {
  if (!header) return [];
  const raw = Array.isArray(header) ? header.join(",") : header;
  return raw.split(",").map((p) => p.trim()).filter(Boolean);
}

function proxyHttp(req: IncomingMessage, res: ServerResponse, devPort: number, upstreamHost: string): void {
  const upstream = httpRequest(
    {
      host: "127.0.0.1",
      port: devPort,
      method: req.method,
      path: req.url,
      headers: forwardHeaders(req.headers, upstreamHost),
    },
    (upstreamRes) => {
      const status = upstreamRes.statusCode ?? 502;
      const headers = unframe(upstreamRes.headers);

      // A 403 might be vite refusing the Host. It is the one status worth
      // buffering for, and the body is a sentence.
      if (status === 403) {
        const chunks: Buffer[] = [];
        upstreamRes.on("data", (chunk: Buffer) => chunks.push(chunk));
        upstreamRes.on("end", () => {
          const body = Buffer.concat(chunks);
          if (body.toString("utf8").includes(VITE_BLOCKED)) {
            const page = blockedHostPage(devPort);
            res.writeHead(502, { "content-type": "text/html; charset=utf-8" });
            res.end(page);
            return;
          }
          res.writeHead(status, headers);
          res.end(body);
        });
        return;
      }

      res.writeHead(status, headers);
      upstreamRes.pipe(res);
    },
  );

  upstream.on("error", (err) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end(`kururu: dev server on :${devPort} did not answer (${err.message})`);
  });

  req.pipe(upstream);
}

function proxyWebSocket(
  sockets: WebSocketServer,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  devPort: number,
): void {
  const protocols = offeredProtocols(req.headers["sec-websocket-protocol"]);

  sockets.handleUpgrade(req, socket, head, (client) => {
    /**
     * The path and the query are part of the endpoint, not decoration: Vite's
     * HMR socket happens to live at `/`, but Next.js listens on
     * `/_next/webpack-hmr` and several dev servers put a token in the query.
     * Dialling the bare origin works for exactly one framework by luck.
     */
    const upstream = new UpstreamSocket(`ws://127.0.0.1:${devPort}${req.url ?? "/"}`, protocols, {
      headers: { host: `localhost:${devPort}` },
    });

    /** Frames the browser sent before upstream finished connecting. */
    const backlog: { data: RawData; binary: boolean }[] = [];

    upstream.on("open", () => {
      for (const frame of backlog) upstream.send(frame.data, { binary: frame.binary });
      backlog.length = 0;
    });

    // `isBinary` is the whole reason this is not a one-liner: a text frame and a
    // binary frame both arrive as a Buffer, so relaying without it would turn
    // every HMR message into binary and the dev server would ignore it.
    upstream.on("message", (data: RawData, isBinary: boolean) => {
      if (client.readyState === UpstreamSocket.OPEN) client.send(data, { binary: isBinary });
    });
    client.on("message", (data: RawData, isBinary: boolean) => {
      if (upstream.readyState === UpstreamSocket.OPEN) upstream.send(data, { binary: isBinary });
      else backlog.push({ data, binary: isBinary });
    });

    const closeBoth = (): void => {
      try { client.close(); } catch { /* already gone */ }
      try { upstream.close(); } catch { /* already gone */ }
    };
    upstream.on("close", closeBoth);
    upstream.on("error", closeBoth);
    client.on("close", closeBoth);
    client.on("error", closeBoth);
  });
}

/**
 * Open (or reuse) a proxy for a dev server and return the port it is on.
 * Idempotent: asking twice for the same dev server gives the same port back,
 * which is what keeps a phone's bookmark working across a reload.
 *
 * Returns synchronously even though `listen` is not, because callers want a port
 * to put in a snapshot rather than a promise to await. If the bind fails the
 * preview closes itself and the next dev scan simply stops advertising it.
 */
export function openPreview(devPort: number): number {
  const existing = previews.get(devPort);
  if (existing) return existing.proxyPort;

  const upstreamHost = `localhost:${devPort}`;
  const proxyPort = reserved.get(devPort) ?? nextFreePort();
  reserved.set(devPort, proxyPort);

  const sockets = new WebSocketServer({
    noServer: true,
    // Echo the first protocol the client offered, as the old Bun handshake did.
    handleProtocols: (protocols) => protocols.values().next().value ?? false,
  });

  const server = createServer((req, res) => proxyHttp(req, res, devPort, upstreamHost));
  server.on("upgrade", (req, socket, head) => proxyWebSocket(sockets, req, socket, head, devPort));

  /**
   * An HMR socket is idle by design — it exists to say nothing until a file
   * changes. Node's default timeouts would hang up on it.
   */
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;
  server.requestTimeout = 0;

  server.on("error", (err) => {
    console.error(`kururu: preview proxy on :${proxyPort} failed —`, err.message);
    /**
     * A port this process does not believe it is using, that the kernel refuses
     * anyway, is one something else on the machine holds — so the reservation
     * is wrong rather than merely unlucky, and keeping it would make every
     * subsequent scan ask for the same refusal and advertise no preview at all,
     * with the reason only in this log. Dropping it lets the next poll allocate
     * somewhere else. Any other failure leaves the reservation alone: the port
     * is still this dev server's, and the bookmark is still worth keeping.
     */
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") reserved.delete(devPort);
    closePreview(devPort);
  });

  // The tailnet interface, not just loopback — the phone is the point.
  server.listen(proxyPort, "0.0.0.0");

  previews.set(devPort, { devPort, proxyPort, server, sockets });
  return proxyPort;
}

/** Shut a preview down — its dev server is gone, or nothing is watching. */
export function closePreview(devPort: number): void {
  const preview = previews.get(devPort);
  if (!preview) return;
  previews.delete(devPort);
  /**
   * Order matters and so does the second call. `close()` alone stops new
   * connections and waits for existing ones, and an upgraded websocket never
   * ends on its own — the listener would stay open forever, holding the port.
   */
  for (const client of preview.sockets.clients) {
    try { client.terminate(); } catch { /* already gone */ }
  }
  preview.sockets.close();
  preview.server.close();
  preview.server.closeAllConnections();
}

export function openPreviews(): Map<number, number> {
  return new Map([...previews].map(([devPort, p]) => [devPort, p.proxyPort]));
}

/** Every preview, shut down. Called on the way out; see index.ts. */
export function closeAllPreviews(): void {
  for (const devPort of [...previews.keys()]) closePreview(devPort);
}

/**
 * Lowest unclaimed proxy port at or above the base. Small set; a scan is fine.
 *
 * Claimed means reserved, not merely listening: a dev server that is between
 * restarts has no preview open and must still not have its port handed to the
 * project in the next window along. See `reserved`.
 */
function nextFreePort(): number {
  const taken = new Set(reserved.values());
  for (let port = BASE_PORT; port < BASE_PORT + 200; port++) {
    if (!taken.has(port)) return port;
  }
  throw new Error("no free preview port");
}
