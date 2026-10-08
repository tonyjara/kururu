/**
 * Just enough of the Model Context Protocol for Claude Code to call kururu's
 * verbs as tools.
 *
 * MCP over "streamable HTTP" is JSON-RPC 2.0 in a POST body, and a server that
 * has only tools to offer needs five methods of it: `initialize`, the
 * `notifications/initialized` that follows, `ping`, `tools/list` and
 * `tools/call`. The official SDK does all of that and a great deal more —
 * resources, prompts, sessions, server-sent event streams — and pulling it
 * into a server with seven dependencies to answer five methods was the wrong
 * trade. This is the whole protocol surface kururu speaks, written out, and
 * `handleMcp` in `index.ts` is the one route that reaches it.
 *
 * Pure: a body in, a status and a body out, and the tools passed in. The test
 * speaks the protocol to it without a socket.
 */

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** What a tool call comes back as: text for the model, and whether it is an error. */
export interface McpResult {
  text: string;
  isError?: boolean;
}

export type McpCall = (name: string, args: Record<string, unknown>) => Promise<McpResult>;

/** The version of the protocol answered when the client names none, or one this does not know. */
const PROTOCOL = "2025-06-18";
const KNOWN = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);

interface Request {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

/**
 * Answer one POST. A notification gets 202 and no body, a request gets its
 * reply, a batch gets a batch. Anything that is not JSON-RPC at all is a
 * parse error, which the protocol has a code for.
 */
export async function mcpAnswer(
  body: unknown,
  tools: readonly McpTool[],
  call: McpCall,
  server: { name: string; version: string },
): Promise<{ status: number; body?: unknown }> {
  if (Array.isArray(body)) {
    const replies = (await Promise.all(body.map((one) => answerOne(one, tools, call, server)))).filter((r) => r !== null);
    return replies.length ? { status: 200, body: replies } : { status: 202 };
  }
  const reply = await answerOne(body, tools, call, server);
  return reply === null ? { status: 202 } : { status: 200, body: reply };
}

async function answerOne(
  raw: unknown,
  tools: readonly McpTool[],
  call: McpCall,
  server: { name: string; version: string },
): Promise<Record<string, unknown> | null> {
  if (!raw || typeof raw !== "object") return failure(null, -32700, "Parse error");
  const req = raw as Request;
  const id = req.id === undefined ? null : req.id;
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") return failure(id, -32600, "Invalid request");
  const params = req.params && typeof req.params === "object" ? (req.params as Record<string, unknown>) : {};
  // A notification has no id and gets no reply, whatever it says.
  if (req.id === undefined) return null;

  switch (req.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL;
      return success(id, {
        protocolVersion: KNOWN.has(asked) ? asked : PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: server,
      });
    }
    case "ping":
      return success(id, {});
    case "tools/list":
      return success(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      if (!tools.some((tool) => tool.name === name)) return failure(id, -32602, `Unknown tool: ${name}`);
      const args = params.arguments && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {};
      try {
        const result = await call(name, args);
        return success(id, { content: [{ type: "text", text: result.text }], isError: result.isError === true });
      } catch (err) {
        // A tool that threw is a tool result the model can read, not a protocol
        // error: it said why, and the model's next move depends on the why.
        return success(id, { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true });
      }
    }
    default:
      return failure(id, -32601, `Method not found: ${req.method}`);
  }
}

function success(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function failure(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
