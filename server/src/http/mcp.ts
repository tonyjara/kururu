/**
 * The two MCP endpoints agents on this Mac are given: kururu's own tools, and the web lent to them through the provider chain.
 *
 * One table of routes of a fixed path, cut out of the `if` chain that was
 * `index.ts`'s; `router.ts` puts the tables together and decides what comes
 * before them. Each handler is the body of the `if` it was.
 */
import { harness, host, workspaces } from "../context";
import { initializes, mcpAnswer } from "../mcp";
import { web, webAgentName } from "../sweeps";
import { VERSION } from "../version";
import { callerAgent, localCaller } from "../web/chain";
import { json, readJsonBody, text } from "./respond";
import type { Route } from "./router";

export const mcpRoutes: Route[] = [
  /**
   * kururu's web as an MCP server: the tools every agent kururu starts is
   * pointed at (`WebChain.launchFlags`), and the harness with them. Stricter
   * than `/mcp` below, because a provider behind it may spend credits: a
   * program on this Mac only — loopback, no `Origin`, nothing a proxy added —
   * whether or not sharing is on. The agent names itself in a header so the
   * Settings page can say who asked for what; one that does not is still
   * served.
   *
   * Unlike `/mcp`, it keeps what it told a client current: an `initialize`
   * is given a session carrying a fingerprint of the chain, a `GET` holds a
   * stream that hears `tools/list_changed` when the chain moves, and a
   * request on a session from before is answered 404, the protocol's way of
   * saying "start again". See `web/chain.ts`.
   */
  {
    path: "/mcp/web",
    handle: async (req, res, url) => {
      if (!localCaller(req)) {
        json(res, { jsonrpc: "2.0", id: null, error: { code: -32000, message: "kururu's web tools answer programs on this Mac only" } }, 403);
        return;
      }
      const header = req.headers["mcp-session-id"];
      const session = typeof header === "string" ? header : null;
      // Word for word what the reference SDK's server says, because that is
      // what the clients were written against.
      const expired = (id: unknown) => json(res, { jsonrpc: "2.0", id: id ?? null, error: { code: -32001, message: "Session not found" } }, 404);
      if (req.method === "DELETE") {
        res.writeHead(200).end();
        return;
      }
      if (req.method === "GET") {
        if (!web.sessionCurrent(session)) {
          expired(null);
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.on("close", web.openStream(res, session));
        return;
      }
      if (req.method !== "POST") {
        text(res, "GET or POST", 405);
        return;
      }
      const said = callerAgent(req);
      const agentId = said && host.find(said) ? said : null;
      try {
        const body = await readJsonBody(req, 64 * 1024);
        const fresh = initializes(body);
        if (!fresh && !web.sessionCurrent(session)) {
          expired(body && typeof body === "object" && !Array.isArray(body) ? (body as { id?: unknown }).id : null);
          return;
        }
        // Issued before the answer is written, from the same chain: the
        // fingerprint in the id is the one the instructions were written from.
        if (fresh) res.setHeader("mcp-session-id", web.session());
        const agent = agentId ? webAgentName(agentId) : null;
        const answer = await mcpAnswer(body, web.tools(), (name, args) => web.call(name, args, agent), {
          name: "kururu_web",
          version: VERSION,
          instructions: web.instructions(),
          listChanged: true,
        });
        if (answer.body === undefined) res.writeHead(answer.status).end();
        else json(res, answer.body, answer.status);
      } catch (err) {
        json(res, { jsonrpc: "2.0", id: null, error: { code: -32700, message: err instanceof Error ? err.message : String(err) } }, 400);
      }
      return;
    },
  },

  /**
   * Kururu as an MCP server: the harness's verbs, for the harness session that
   * was started with this address in its `--mcp-config`. The address names the
   * profile the tools act on and the session they were issued to, so the
   * endpoint knows who is calling without a session of its own. Behind the
   * same gate as everything else, which on loopback is open — any local process
   * may drive kururu this way, and that is the point of exposing the verbs at
   * all. See `mcp.ts` for the protocol and `harness.ts` for the tools.
   */
  {
    path: "/mcp",
    handle: async (req, res, url) => {
      if (req.method === "GET") {
        // No server-initiated stream here; the protocol lets a server say so.
        text(res, "kururu speaks MCP over POST only\n", 405);
        return;
      }
      if (req.method === "DELETE") {
        res.writeHead(200).end();
        return;
      }
      if (req.method !== "POST") {
        text(res, "POST only", 405);
        return;
      }
      const profileId = url.searchParams.get("profile") ?? "";
      if (!workspaces.profile(profileId)) {
        json(res, { jsonrpc: "2.0", id: null, error: { code: -32000, message: "no such profile" } }, 404);
        return;
      }
      const selfId = harness.selfFor(profileId, url.searchParams.get("session") ?? "");
      try {
        const body = await readJsonBody(req, 256 * 1024);
        const answer = await mcpAnswer(body, harness.tools(profileId), (name, args) => harness.call(profileId, selfId, name, args), {
          name: "kururu",
          version: VERSION,
        });
        if (answer.body === undefined) res.writeHead(answer.status).end();
        else json(res, answer.body, answer.status);
      } catch (err) {
        json(res, { jsonrpc: "2.0", id: null, error: { code: -32700, message: err instanceof Error ? err.message : String(err) } }, 400);
      }
      return;
    },
  },
];
