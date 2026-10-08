/**
 * The harness's pure half: the vocabulary a session is handed, and the two
 * grammars it is reached through. What is worth pinning is that a key name
 * never becomes letters typed into a prompt, that an inbox frame is the shape
 * a Claude Code session's own stdin takes, and that a screen comes back as the
 * lines a person saw.
 */
import { describe, expect, it } from "bun:test";
import {
  HARNESS_TOOLS,
  adoptHarness,
  clip,
  inboxFrames,
  keyBytes,
  mcpConfig,
  pasteBytes,
  rolePrompt,
  turnsFrom,
} from "../../shared/harness";
import { screenText } from "../src/harness";

describe("the tool catalogue", () => {
  it("has unique names Claude Code can prefix, and schemas that have what they require", () => {
    const names = HARNESS_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of HARNESS_TOOLS) {
      expect(tool.name).toMatch(/^[a-z_]+$/);
      expect(tool.description.length).toBeGreaterThan(20);
      const schema = tool.inputSchema as { type: string; properties: Record<string, unknown>; required: string[] };
      expect(schema.type).toBe("object");
      for (const key of schema.required) expect(schema.properties).toHaveProperty(key);
    }
  });

  it("is what the role tells the session it has, with its profile named", () => {
    const prompt = rolePrompt({
      profile: "main",
      workspaces: [{ id: "w1", name: "api" }],
      launchers: [{ id: "claude", label: "Claude" }],
    });
    expect(prompt).toContain('"main"');
    expect(prompt).toContain("api (w1)");
    expect(prompt).toContain("claude: Claude");
    expect(prompt).toContain("kururu_status");
    expect(prompt).toContain("[kururu]");
  });
});

describe("keys and pastes", () => {
  it("turns names into bytes and refuses what is not a key", () => {
    expect(keyBytes(["enter"])).toEqual({ data: "\r" });
    expect(keyBytes(["y", "Enter"])).toEqual({ data: "y\r" });
    expect(keyBytes(["ctrl-c", "ctrl-c"])).toEqual({ data: "\x03\x03" });
    expect(keyBytes(["escape", "down", "2"])).toEqual({ data: "\x1b\x1b[B2" });
    expect(keyBytes(["ctrl-z-z"])).toEqual({ bad: "ctrl-z-z" });
    expect(keyBytes(["rm -rf"])).toEqual({ bad: "rm -rf" });
  });

  it("brackets a paste only when there is a newline to protect", () => {
    expect(pasteBytes("one line")).toBe("one line");
    expect(pasteBytes("two\nlines")).toBe("\x1b[200~two\nlines\x1b[201~");
  });
});

describe("the inbox frames", () => {
  it("are the token, then one user turn, a line each", () => {
    const lines = inboxFrames("hello", "tok", "next").split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!)).toEqual({ type: "auth", token: "tok" });
    expect(JSON.parse(lines[1]!)).toEqual({
      type: "user",
      message: { role: "user", content: "hello" },
      from: "kururu",
      priority: "next",
    });
    expect(lines[2]).toBe("");
  });

  it("leave the token out when there is none", () => {
    const lines = inboxFrames("x", null, "now").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).priority).toBe("now");
  });
});

describe("a transcript's turns", () => {
  const line = (rec: object) => JSON.stringify(rec);
  const tail = [
    "fragment of a previous line}",
    line({ type: "user", message: { role: "user", content: "fix the bug" } }),
    line({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Looking." }, { type: "tool_use", name: "Read" }] },
    }),
    line({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "..." }] } }),
    line({ type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "noise" }] } }),
    line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done: a typo." }] } }),
    line({ type: "system", subtype: "compact_boundary" }),
  ].join("\n");

  it("reads user and assistant turns, names tools, counts results, skips sidechains", () => {
    const turns = turnsFrom(tail, 10);
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(turns[1]!.text).toBe("Looking.\n[tool: Read]");
    expect(turns[2]!.text).toBe("[1 tool result]");
    expect(turns[3]!.text).toBe("Done: a typo.");
  });

  it("keeps the last N", () => {
    expect(turnsFrom(tail, 1).map((t) => t.text)).toEqual(["Done: a typo."]);
  });
});

describe("a screen as text", () => {
  it("renders the escape sequences into the lines a person saw, without the blank bottom", async () => {
    const text = await screenText("\x1b[1mhello\x1b[0m\r\n> \x1b[32mworld\x1b[0m\r\n", 40, 10, 60);
    expect(text).toBe("hello\n> world");
  });

  it("keeps only the last lines asked for", async () => {
    const data = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\r\n");
    expect(await screenText(data, 40, 10, 3)).toBe("line 27\nline 28\nline 29");
  });
});

describe("the rest", () => {
  it("clips from the front, since the end is the newest", () => {
    expect(clip("abcdef", 3)).toEndWith("def");
    expect(clip("abc", 3)).toBe("abc");
  });

  it("adopts a harness only with a session id, and a process id only from the blob", () => {
    expect(adoptHarness(null)).toBeNull();
    expect(adoptHarness({ sessionId: "nope" })).toBeNull();
    const id = "0b6c2f1e-8d7a-4c3b-9e2f-1a2b3c4d5e6f";
    expect(adoptHarness({ sessionId: id })).toEqual({ sessionId: id, launcher: "claude", agentId: null, startedAt: 0 });
    expect(adoptHarness({ sessionId: id, agentId: "a7", launcher: "claude:x", startedAt: 5 })).toEqual({
      sessionId: id,
      launcher: "claude:x",
      agentId: "a7",
      startedAt: 5,
    });
  });

  it("addresses the endpoint with the profile and the session, and raises the per-request limit", () => {
    const config = JSON.parse(mcpConfig(7717, "p1", "s-1")) as {
      mcpServers: Record<string, { type: string; url: string; timeout: number }>;
    };
    const server = config.mcpServers.kururu!;
    expect(server.type).toBe("http");
    expect(server.url).toBe("http://127.0.0.1:7717/mcp?profile=p1&session=s-1");
    expect(server.timeout).toBeGreaterThan(60_000);
  });
});
