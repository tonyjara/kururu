/**
 * Antigravity's `agy`, read the way kururu reads it: the title payload's
 * states turned into reports, the transcript's last reply, the quota without
 * the email beside it, and the lines and settings Kuru is started with.
 *
 * The payloads and the transcript are trimmed from what agy 1.5.2 actually
 * sent and wrote on 2026-11-06, in a throwaway folder on the cheapest model.
 */
import { describe, expect, it } from "bun:test";

import {
  AGY_CONVERSATION,
  adoptAgyQuota,
  agyContext,
  agyKuruCommand,
  agyKuruHooks,
  agyKuruMcp,
  agyLastReply,
  agyLimitsFrom,
  agyQuotaOf,
  agyReport,
  agyRoleRule,
  agySessionSettings,
  agyStatusOf,
  agyTitleCommand,
  agyTranscriptPaths,
  agyTransition,
  isAgyLine,
} from "../../shared/agy";
import { HARNESS_TOOLS, adoptHarness, harnessConversation, noticesTyped, rolePrompt } from "../../shared/harness";
import { readScreen } from "../../shared/onscreen";

const ID = "13f042a6-6698-4a14-a210-d71eb5f402eb";

/** What the title command was handed once the plan had loaded, cut to the fields kururu reads. */
const PAYLOAD = {
  cwd: "/tmp/proj",
  session_id: ID,
  conversation_id: ID,
  context_window: { total_input_tokens: 12340, context_window_size: 1048576, used_percentage: 0, remaining_percentage: 100, current_usage: null },
  quota: {
    "3p-5h": { remaining_fraction: 0.98256433, reset_time: "2026-11-06T23:48:34Z", reset_in_seconds: 17208 },
    "3p-weekly": { remaining_fraction: 0.2501456, reset_time: "2026-11-08T22:02:29Z", reset_in_seconds: 183643 },
    "gemini-5h": { remaining_fraction: 0.91996, reset_time: "2026-11-06T22:07:00Z", reset_in_seconds: 11114 },
    "gemini-weekly": { remaining_fraction: 0.54295826, reset_time: "2026-11-08T22:02:39Z", reset_in_seconds: 183653 },
  },
  agent_state: "idle",
  plan_tier: "Google AI Ultra",
  email: "someone@example.com",
};

const TRANSCRIPT = [
  `{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","content":"<USER_REQUEST>\\nRun the shell command: touch b.txt\\n</USER_REQUEST>"}`,
  `{"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","content":""}`,
  `{"step_index":2,"source":"MODEL","type":"GENERIC","status":"DONE"}`,
  `{"step_index":3,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","input_tokens":8886,"output_tokens":1,"content":"ok"}`,
].join("\n");

describe("the title's states, as reports", () => {
  it("calls every busy state working, idle idle, and start-up nothing", () => {
    for (const busy of ["working", "thinking", "tool_use", "something_new"]) expect(agyStatusOf(busy)).toBe("working");
    expect(agyStatusOf("idle")).toBe("idle");
    expect(agyStatusOf("initializing")).toBeNull();
    expect(agyStatusOf("authenticating")).toBeNull();
  });

  it("reports the edges once, though agy runs the title on every redraw", () => {
    // The order agy 1.5.2 went through for one turn with a permission prompt in it.
    const seen = ["initializing", "idle", "idle", "working", "working", "tool_use", "tool_use", "working", "idle", "idle"];
    let previous: string | null = null;
    const said: string[] = [];
    for (const state of seen) {
      const change = agyTransition(previous, state);
      if (change) said.push(change);
      if (agyStatusOf(state) !== null) previous = state;
    }
    expect(said).toEqual(["wake", "working", "done"]);
  });

  it("is not done out of nothing: a first idle is a wake, and a resumed one too", () => {
    expect(agyTransition(null, "idle")).toBe("wake");
    expect(agyTransition("idle", "idle")).toBeNull();
    expect(agyTransition("tool_use", "idle")).toBe("done");
  });
});

describe("the transcript", () => {
  it("gives the last thing the model said after the user last spoke", () => {
    expect(agyLastReply(TRANSCRIPT)).toBe("ok");
  });

  it("gives nothing while a turn has not said anything yet", () => {
    expect(agyLastReply(`${TRANSCRIPT}\n{"type":"USER_INPUT","content":"again"}`)).toBeNull();
    expect(agyLastReply(`{"type":"PLANNER_RESPONSE","content":"cut mid-wr`)).toBeNull();
  });

  it("is looked for in the CLI's folder first, and only for a real id", () => {
    expect(agyTranscriptPaths("/Users/x", ID)[0]).toBe(`/Users/x/.gemini/antigravity-cli/brain/${ID}/.system_generated/logs/transcript_full.jsonl`);
    expect(agyTranscriptPaths("/Users/x", "../../etc")).toEqual([]);
  });
});

describe("the quota", () => {
  it("keeps the windows and the plan, and never the email", () => {
    const quota = agyQuotaOf(PAYLOAD, 1000)!;
    expect(JSON.stringify(quota)).not.toContain("someone@example.com");
    expect(quota.plan).toBe("Google AI Ultra");
    expect(Object.keys(quota.windows)).toEqual(["3p-5h", "3p-weekly", "gemini-5h", "gemini-weekly"]);
    expect(adoptAgyQuota(JSON.parse(JSON.stringify(quota)))).toEqual(quota);
  });

  it("draws spent rather than left, Claude's group first, a week as a week", () => {
    const limits = agyLimitsFrom(agyQuotaOf(PAYLOAD, 0), Date.parse("2026-11-06T20:00:00Z"));
    expect(limits.map((l) => [l.kind, l.scope])).toEqual([
      ["session", "Claude/GPT"],
      ["weekly_all", "Claude/GPT"],
      ["session", "Gemini"],
      ["weekly_all", "Gemini"],
    ]);
    expect(limits[1]!.percent).toBe(75);
    expect(limits[1]!.severity).toBe("warning");
    expect(limits[0]!.severity).toBe("normal");
  });

  it("drops a window whose reset has passed", () => {
    const after = agyLimitsFrom(agyQuotaOf(PAYLOAD, 0), Date.parse("2026-11-07T00:00:00Z"));
    expect(after.map((l) => l.scope + l.kind)).toEqual(["Claude/GPTweekly_all", "Geminiweekly_all"]);
  });

  it("is nothing from a payload that has none", () => {
    expect(agyQuotaOf({ agent_state: "idle" }, 0)).toBeNull();
    expect(agyLimitsFrom(null, 0)).toEqual([]);
  });
});

describe("the context", () => {
  it("reads the current request when agy gives one, and the percentage otherwise", () => {
    expect(agyContext(PAYLOAD)).toBeNull();
    expect(agyContext({ context_window: { context_window_size: 200000, used_percentage: 12.5 } })).toEqual({ used: 25000, window: 200000 });
    expect(agyContext({ context_window: { context_window_size: 200000, current_usage: { input_tokens: 900, cache_read_input_tokens: 100 } } })).toEqual({ used: 1000, window: 200000 });
  });
});

describe("the report", () => {
  it("names the program and the conversation, and says nothing when there is nothing", () => {
    expect(agyReport({ agent: "a1", status: "done", conversation: ID, context: null, reply: "ok" })).toEqual({ agent: "a1", program: "agy", status: "done", session: ID, reply: "ok" });
    expect(agyReport({ agent: "a1", status: "working", conversation: "not-an-id", context: null })).toEqual({ agent: "a1", program: "agy", status: "working" });
    expect(agyReport({ agent: "a1", status: null, conversation: ID, context: null })).toBeNull();
  });
});

describe("the lines", () => {
  const runtime = "/Applications/Kururu.app/Contents/MacOS/Kururu";
  const script = "/Applications/Kururu.app/Contents/Resources/server/agyreport.mjs";

  it("runs the reporter on the server's own runtime, with the launch's nonce", () => {
    expect(agyTitleCommand(runtime, script, "agent", "0123456789abcdef")).toBe(`ELECTRON_RUN_AS_NODE=1 '${runtime}' '${script}' title agent 0123456789abcdef`);
    expect(() => agyTitleCommand(runtime, script, "agent", "../x")).toThrow();
  });

  it("trusts Kuru's folder and allows its tools for the launch only", () => {
    const settings = agySessionSettings({ title: "t", trusted: ["/home/k"], allowMcp: ["kururu"] });
    expect(settings).toEqual({ title: { type: "command", command: "t" }, trustedWorkspaces: ["/home/k"], permissions: { allow: ["mcp(kururu/*)"] } });
    expect(agySessionSettings({ title: "t" })).toEqual({ title: { type: "command", command: "t" } });
  });

  it("starts Kuru with its settings as one quoted word, resuming only a real conversation", () => {
    const line = agyKuruCommand({ model: "claude-opus-5-5-high", settings: { title: { type: "command", command: "x 'y'" } }, conversation: ID, bypass: false });
    expect(line).toBe(`agy --model 'claude-opus-5-5-high' --settings '{"title":{"type":"command","command":"x '\\''y'\\''"}}' --conversation ${ID}`);
    expect(() => agyKuruCommand({ model: "m", settings: {}, conversation: "x; rm", bypass: false })).toThrow();
    expect(agyKuruCommand({ model: "m", settings: {}, conversation: null, bypass: true })).toEndWith("--dangerously-skip-permissions");
  });

  it("gives Kuru every kururu tool eagerly, and the token only when there is one", () => {
    const mcp = agyKuruMcp({ port: 7717, profileId: "p1", session: ID, token: null, web: false }) as { mcpServers: Record<string, { serverUrl: string; tools: Record<string, unknown>; headers?: unknown }> };
    const kururu = mcp.mcpServers.kururu!;
    expect(kururu.serverUrl).toBe(`http://127.0.0.1:7717/mcp?profile=p1&session=${ID}`);
    expect(Object.keys(kururu.tools)).toEqual(HARNESS_TOOLS.map((t) => t.name));
    expect(kururu.headers).toBeUndefined();
    const withToken = agyKuruMcp({ port: 7717, profileId: "p1", session: ID, token: "secret", web: true }) as { mcpServers: Record<string, { headers?: Record<string, string> }> };
    expect(withToken.mcpServers.kururu!.headers).toEqual({ authorization: "Bearer secret" });
    expect(withToken.mcpServers.kururu_web!.headers).toEqual({ authorization: "Bearer secret" });
  });

  it("hooks the turn's start and its end, and the role is always on", () => {
    expect(Object.keys((agyKuruHooks(runtime, script) as { kururu: object }).kururu)).toEqual(["PreInvocation", "Stop"]);
    expect(agyRoleRule("You are Kuru.")).toStartWith("---\ntrigger: always_on\n");
  });

  it("tells the role its tools by the names agy gives them", () => {
    const role = rolePrompt({ profile: "Home", workspaces: [], launchers: [], cli: "agy" });
    expect(role).toContain("mcp_kururu_kururu_status");
    expect(role).toContain("kururu types it into your prompt");
    expect(role).not.toContain("SendMessage");
  });

  it("knows its own launch lines and no others", () => {
    expect(isAgyLine("agy --model m --settings '{}'")).toBe(true);
    expect(isAgyLine("bun install && agy --model m")).toBe(true);
    expect(isAgyLine("claude --model agy")).toBe(false);
    expect(isAgyLine("agyfoo")).toBe(false);
    expect(AGY_CONVERSATION.test(ID)).toBe(true);
  });
});

/** Screens as agy 1.5.2 drew them in a 140-column tmux pane, blank rows dropped. */
describe("agy's screen", () => {
  const footer = "Gemini 3.8 Flash · low";
  it("is working under its spinner and its lowercase footer", () => {
    const screen = `> Reply with just the word ok.\n⣽  Generating...\n${"─".repeat(60)}\n>\n${"─".repeat(60)}\nesc to cancel${" ".repeat(90)}${footer}`;
    expect(readScreen(screen).phase).toBe("working");
  });

  it("is asking on a permission prompt, and says what about", () => {
    const screen = [
      "> Run the shell command: touch b.txt",
      "● Ran (touch b.txt) (ctrl+o to expand)",
      "Requesting permission for:",
      "   touch b.txt",
      "Run this command?",
      "> 1. Yes, run command",
      "  2. Yes, and always allow in this conversation for commands that start with 'touch'",
      "  4. No, cancel",
      "  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command",
      `esc to cancel${" ".repeat(90)}${footer}`,
    ].join("\n");
    expect(readScreen(screen)).toEqual({ phase: "asking", detail: "Run this command? touch b.txt" });
  });

  it("is asking on the folder's trust", () => {
    const screen = ["Do you trust the contents of this project?", "Antigravity CLI requires permission to read, edit, and execute files here.", "> Yes, I trust this folder", "  No, exit", "  ↑/↓ Navigate · enter Confirm"].join("\n");
    expect(readScreen(screen)).toEqual({ phase: "asking", detail: "Do you trust the contents of this project?" });
  });

  it("is quiet once the turn is over, and a question in the user's own words is not a prompt", () => {
    expect(readScreen(`> Reply with just the word ok.\n  ok\n${"─".repeat(60)}\n>\n${"─".repeat(60)}\n? for shortcuts${" ".repeat(90)}${footer}`).phase).toBe("quiet");
    expect(readScreen(`> is this right?\n  yes\n>\n? for shortcuts`).phase).toBe("quiet");
  });

  it("does not take Claude Code's capitalised dialog footer for agy's", () => {
    expect(readScreen("Some menu\nEsc to cancel").phase).toBe("quiet");
  });
});

describe("Kuru's record on Antigravity", () => {
  const claude = "11111111-2222-4333-8444-555555555555";
  it("keeps agy's conversation beside the others, and files turns under it", () => {
    const harness = adoptHarness({ sessionId: claude, launcher: "agy", agentId: "a1", startedAt: 1, cli: "agy", agySessionId: ID })!;
    expect(harness).toMatchObject({ cli: "agy", agySessionId: ID });
    expect(harnessConversation(harness)).toBe(ID);
    expect(harnessConversation({ ...harness, cli: "claude" })).toBe(claude);
    expect(noticesTyped(harness)).toBe(true);
    expect(noticesTyped({ cli: "claude" })).toBe(false);
  });

  it("drops an id that is not one, and a program it does not know", () => {
    expect(adoptHarness({ sessionId: claude, cli: "agy", agySessionId: "x; rm" })!.agySessionId).toBeUndefined();
    expect(adoptHarness({ sessionId: claude, cli: "gemini" })!.cli).toBeUndefined();
  });
});

