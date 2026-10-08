/**
 * The five methods of MCP kururu speaks, spoken to it without a socket. What
 * is worth pinning is the protocol's own courtesies — a notification gets no
 * reply, a tool that throws is an error *result* the model can read and not a
 * protocol error, a batch comes back as a batch — because a client that does
 * not get them hangs rather than complains.
 */
import { describe, expect, it } from "bun:test";
import { mcpAnswer, type McpTool } from "../src/mcp";

const tools: McpTool[] = [
  { name: "echo", description: "says it back", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
];
const call = async (name: string, args: Record<string, unknown>) => {
  if (args.text === "boom") throw new Error("it broke");
  return { text: `${name}: ${String(args.text)}` };
};
const server = { name: "kururu", version: "0.0.0" };
const ask = (method: string, params?: unknown, id: unknown = 1) =>
  mcpAnswer({ jsonrpc: "2.0", id, method, params }, tools, call, server);
const result = (answer: { body?: unknown }) => (answer.body as { result: Record<string, unknown> }).result;
const error = (answer: { body?: unknown }) => (answer.body as { error: { code: number } }).error;

describe("mcpAnswer", () => {
  it("initializes on the client's version when it knows it, and on its own when not", async () => {
    const known = await ask("initialize", { protocolVersion: "2025-03-26" });
    expect(known.status).toBe(200);
    expect(result(known)).toMatchObject({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: server });
    expect(result(await ask("initialize", { protocolVersion: "1999-01-01" })).protocolVersion).toBe("2025-06-18");
  });

  it("answers a notification with 202 and nothing, and a ping with nothing much", async () => {
    const note = await mcpAnswer({ jsonrpc: "2.0", method: "notifications/initialized" }, tools, call, server);
    expect(note).toEqual({ status: 202 });
    expect(result(await ask("ping"))).toEqual({});
  });

  it("lists and calls tools, and turns a thrown error into an error result", async () => {
    expect(result(await ask("tools/list"))).toEqual({ tools });
    const fine = result(await ask("tools/call", { name: "echo", arguments: { text: "hi" } }));
    expect(fine).toEqual({ content: [{ type: "text", text: "echo: hi" }], isError: false });
    const broke = result(await ask("tools/call", { name: "echo", arguments: { text: "boom" } }));
    expect(broke).toEqual({ content: [{ type: "text", text: "it broke" }], isError: true });
  });

  it("refuses an unknown tool, an unknown method, and what is not a request", async () => {
    expect(error(await ask("tools/call", { name: "nope" })).code).toBe(-32602);
    expect(error(await ask("resources/list")).code).toBe(-32601);
    expect(error(await mcpAnswer({ id: 1, method: "ping" }, tools, call, server)).code).toBe(-32600);
    expect(error(await mcpAnswer("text", tools, call, server)).code).toBe(-32700);
  });

  it("answers a batch with a batch, leaving the notifications out", async () => {
    const batch = await mcpAnswer(
      [
        { jsonrpc: "2.0", id: "a", method: "ping" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: "b", method: "tools/list" },
      ],
      tools,
      call,
      server,
    );
    expect(batch.status).toBe(200);
    expect((batch.body as unknown[]).map((r) => (r as { id: unknown }).id)).toEqual(["a", "b"]);
  });
});
