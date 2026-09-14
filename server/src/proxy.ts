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
 */

/** First port handed out to a preview. Below the ephemeral range, above the usual dev ports. */
const BASE_PORT = 7800;

interface Preview {
  devPort: number;
  proxyPort: number;
  server: { stop(closeActiveConnections?: boolean): void };
}

interface SocketData {
  /** The dev server's side of this websocket, once it is open. */
  upstream: WebSocket | null;
  /** Frames the browser sent before upstream finished connecting. */
  backlog: (string | Uint8Array)[];
}

const previews = new Map<number, Preview>();

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

function blockedHostPage(devPort: number): Response {
  const body = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:15px/1.6 -apple-system,system-ui,sans-serif;margin:0;padding:24px;background:#111;color:#eee}
code{background:#222;padding:2px 6px;border-radius:4px;font-size:13px}
h1{font-size:17px;margin:0 0 12px}p{color:#aaa;max-width:40em}</style>
<h1>The dev server on :${devPort} refused this host</h1>
<p>It is checking the <code>Host</code> header and does not recognise the one it got.
Kururu already rewrites <code>Host</code> to <code>localhost:${devPort}</code>, so this is a
server that checks something else — an origin allowlist, or a proxy setting of its own.</p>
<p>For Vite, add to <code>vite.config.ts</code>:</p>
<p><code>server: { allowedHosts: ['.ts.net'] }</code></p>`;
  return new Response(body, { status: 502, headers: { "content-type": "text/html; charset=utf-8" } });
}

/** Copy a request's headers, minus the ones that belong to this hop. */
function forwardHeaders(source: Headers, hostValue: string): Headers {
  const out = new Headers();
  source.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) out.set(key, value);
  });
  out.set("host", hostValue);
  return out;
}

/** Strip what would stop the response rendering inside our iframe. */
function unframe(source: Headers): Headers {
  const out = new Headers(source);
  // Bun stamps its own on the way out; forwarding upstream's sends two.
  out.delete("date");
  out.delete("x-frame-options");
  out.delete("content-security-policy-report-only");
  const csp = out.get("content-security-policy");
  if (csp) {
    const kept = csp
      .split(";")
      .filter((d) => !/^\s*frame-ancestors/i.test(d))
      .join(";")
      .trim();
    if (kept) out.set("content-security-policy", kept);
    else out.delete("content-security-policy");
  }
  return out;
}

/**
 * Open (or reuse) a proxy for a dev server and return the port it is on.
 * Idempotent: asking twice for the same dev server gives the same port back,
 * which is what keeps a phone's bookmark working across a reload.
 */
export function openPreview(devPort: number): number {
  const existing = previews.get(devPort);
  if (existing) return existing.proxyPort;

  const upstreamHost = `localhost:${devPort}`;
  const proxyPort = nextFreePort();

  const server = Bun.serve<SocketData>({
    port: proxyPort,
    // The tailnet interface, not just loopback — the phone is the point.
    hostname: "0.0.0.0",
    idleTimeout: 0,

    async fetch(req, srv) {
      const url = new URL(req.url);
      const target = `http://127.0.0.1:${devPort}${url.pathname}${url.search}`;

      // HMR, and anything else the app opens: upgrade here, dial upstream, pipe.
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const protocol = req.headers.get("sec-websocket-protocol") ?? undefined;
        const upgraded = srv.upgrade(req, {
          data: { upstream: null, backlog: [] } satisfies SocketData,
          headers: protocol ? { "sec-websocket-protocol": protocol.split(",")[0]!.trim() } : undefined,
        });
        if (upgraded) return undefined;
        return new Response("expected a websocket upgrade", { status: 400 });
      }

      try {
        const res = await fetch(target, {
          method: req.method,
          headers: forwardHeaders(req.headers, upstreamHost),
          body: req.body,
          redirect: "manual",
          // Bun needs this to stream a request body through without buffering it.
          // @ts-expect-error -- duplex is valid at runtime, not yet in the types
          duplex: "half",
        });
        if (res.status === 403) {
          const text = await res.clone().text();
          if (text.includes(VITE_BLOCKED)) return blockedHostPage(devPort);
        }
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers: unframe(res.headers) });
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        return new Response(`kururu: dev server on :${devPort} did not answer (${why})`, { status: 502 });
      }
    },

    websocket: {
      open(ws) {
        // The browser's frames can arrive before upstream is ready; hold them.
        const upstream = new WebSocket(`ws://127.0.0.1:${devPort}`);
        upstream.binaryType = "arraybuffer";
        upstream.onopen = () => {
          for (const frame of ws.data.backlog) upstream.send(frame);
          ws.data.backlog = [];
        };
        upstream.onmessage = (event) => {
          const data = event.data;
          ws.send(typeof data === "string" ? data : new Uint8Array(data as ArrayBuffer));
        };
        upstream.onclose = () => { try { ws.close(); } catch { /* already gone */ } };
        upstream.onerror = () => { try { ws.close(); } catch { /* already gone */ } };
        ws.data.upstream = upstream;
      },
      message(ws, message) {
        const upstream = ws.data.upstream;
        const frame = typeof message === "string" ? message : new Uint8Array(message);
        if (upstream && upstream.readyState === WebSocket.OPEN) upstream.send(frame);
        else ws.data.backlog.push(frame);
      },
      close(ws) {
        try { ws.data.upstream?.close(); } catch { /* already gone */ }
      },
    },
  });

  previews.set(devPort, { devPort, proxyPort, server });
  return proxyPort;
}

/** Shut a preview down — its dev server is gone, or nothing is watching. */
export function closePreview(devPort: number): void {
  const preview = previews.get(devPort);
  if (!preview) return;
  preview.server.stop(true);
  previews.delete(devPort);
}

export function openPreviews(): Map<number, number> {
  return new Map([...previews].map(([devPort, p]) => [devPort, p.proxyPort]));
}

/** Lowest unused proxy port at or above the base. Small set; a scan is fine. */
function nextFreePort(): number {
  const taken = new Set([...previews.values()].map((p) => p.proxyPort));
  for (let port = BASE_PORT; port < BASE_PORT + 200; port++) {
    if (!taken.has(port)) return port;
  }
  throw new Error("no free preview port");
}
