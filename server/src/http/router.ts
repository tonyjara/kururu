
import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { cookieHeader, hasToken, isShared, loopbackTokenRequired, token, verdict } from "../access";
import { nodes } from "../context";
import { listDir, readFile } from "../files";
import { PORT, WEB_DIST } from "../preamble";
import { json, readJsonBody, serveStatic, text } from "./respond";
import { serverRoutes } from "./server";
import { agentRoutes } from "./agents";
import { mcpRoutes } from "./mcp";
import { nodeRead, nodeRoutes } from "./nodes";
import { kuruRoutes } from "./kuru";
import { voiceRoutes } from "./voice";
import { mascotRoutes } from "./mascot";
import { fileRoutes } from "./files";
import { slotRoutes } from "./slots";
import { vaultRoutes } from "./vault";
import { markRead, markRoutes } from "./marks";

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

  /**
   * Everything below this line is behind the gate, and that is deliberate rather
   * than tidy: a list of protected paths is a list somebody adds a route to
   * without noticing, and the route they forget will be the one that reads a
   * file. See `access.ts` for what is actually being decided. The two answers
   * are told apart on purpose — a page from somewhere else is a bug or an attack
   * and is worth saying so about, while a missing token is a phone that has not
   * scanned the QR code yet and is an instruction, not an error.
   */
  /**
   * A new PC joining, with the code from the command this node is showing
   * — ahead of the gate, because the code is its token: the PC holds
   * nothing of this node's before it has joined. `nodeRequestRefusal`
   * keeps it to the tailnet with no page and no proxy in between, and five
   * wrong codes burn the one showing.
   */
  if (url.pathname === "/api/nodes/join") {
    if (req.method !== "POST") {
      text(res, "POST only", 405);
      return;
    }
    let body: unknown;
    try {
      body = await readJsonBody(req, 64 * 1024);
    } catch {
      json(res, { error: "That is not JSON." }, 400);
      return;
    }
    const answer = nodes.acceptJoin(req, body);
    json(res, answer.body, answer.status);
    return;
  }

  const allowed = verdict(req, url);
  if (allowed !== "ok") {
    text(
      res,
      allowed === "cross-origin"
        ? "kururu: refused — this page is not one kururu serves."
        : isShared()
          ? "kururu: this server is shared, so it wants the token from its Share dialog. Scan the QR code again."
          : "kururu: this server wants its token from this machine too — it is in access.json, and `Authorization: Bearer` is how to present it.",
      403,
    );
    return;
  }

  /**
   * The Share URL, opened on a device for the first time. It is `/?k=…`, and
   * the exchange below lives in the page's own bundle — which the browser
   * fetches next with neither the query nor a cookie, and was refused, so a
   * fresh phone got a blank page and only a phone with last year's cookie
   * worked (found on the Omarchy PC, and the Mac's gate is the same). So any
   * request that has just presented the token in its address is answered
   * with the cookie too, and the bundle that follows carries it.
   */
  if ((isShared() || loopbackTokenRequired()) && url.searchParams.has("k") && hasToken(req, url)) {
    res.setHeader("set-cookie", cookieHeader(token()));
  }

  /**
   * Every route of a fixed path, by path (`ROUTES`). Each was an `if` in a
   * chain; no two share a path, so a map answers what the chain did, and a
   * route for one method lets the others fall through to what follows as
   * the chain did.
   */
  const route = ROUTES.get(url.pathname);
  if (route && (route.method === undefined || route.method === req.method)) {
    await route.handle(req, res, url);
    return;
  }
  /**
   * Another node's disk, for a workspace of its on this screen: the routes
   * above, answered by that node over its watch (`NodeWatches.ask`). The
   * query is the local routes' with the node's own roots — the page strips
   * the qualification, and the node checks the root against what it found
   * itself, so nothing here decides what a path means. Reads only: the
   * tree's edits are made on the node, through nvim or its own page.
   */
  /** A set of marks, or one of its files (`http/marks.ts`). */
  const onMarks = /^\/api\/marks\/(m[0-9a-f]{12})(?:\/([a-z0-9.-]{1,32}))?$/.exec(url.pathname);
  if (onMarks) {
    markRead(req, res, onMarks[1]!, onMarks[2] ?? null);
    return;
  }
  const onNode = /^\/api\/node\/(n[0-9a-f]{12})\/([a-z-]+)$/.exec(url.pathname);
  if (onNode) {
    void nodeRead(res, onNode[1]!, onNode[2]!, url.searchParams);
    return;
  }
  if (url.pathname === "/api/ls" || url.pathname === "/api/file") {
    const root = url.searchParams.get("root") ?? "";
    const path = url.searchParams.get("path") ?? "";
    try {
      json(res, url.pathname === "/api/ls" ? { entries: listDir(root, path) } : readFile(root, path));
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 400);
    }
    return;
  }

  if (process.env.KURURU_DEV === "1" && !existsSync(join(WEB_DIST, "index.html"))) {
    text(
      res,
      `kururu server is up on :${PORT}.\nThe UI is not built — run \`bun run build\`, or let the desktop app start vite.\n`,
    );
    return;
  }

  serveStatic(res, url.pathname === "/" ? "index.html" : url.pathname.slice(1));
}

/** A route of a fixed path: what handles it, and the one method it answers when it answers only one. */
export interface Route {
  path: string;
  method?: "POST";
  handle: (req: IncomingMessage, res: ServerResponse, url: URL) => void | Promise<void>;
}

/**
 * Every route of a fixed path, by path. Built once, at load; a path in two
 * tables is a mistake the chain would have hidden — the first `if` won — so
 * it is refused here, loudly, before anything is served.
 */
const ROUTES = new Map<string, Route>();
for (const route of [...serverRoutes, ...agentRoutes, ...mcpRoutes, ...nodeRoutes, ...kuruRoutes, ...voiceRoutes, ...mascotRoutes, ...fileRoutes, ...slotRoutes, ...vaultRoutes, ...markRoutes]) {
  if (ROUTES.has(route.path)) throw new Error(`two routes for ${route.path}`);
  ROUTES.set(route.path, route);
}
