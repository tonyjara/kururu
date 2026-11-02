/**
 * The harness's pure half: the vocabulary a session is handed, and the two
 * grammars it is reached through. What is worth pinning is that a key name
 * never becomes letters typed into a prompt, that an inbox frame is the shape
 * a Claude Code session's own stdin takes and is signed by nothing a reply
 * could find, that a message waits for the moment the terminal may take it,
 * that a screen comes back as the lines a person saw — and the two things
 * about the harness that are about the user rather than the agents: that it
 * calls an agent by what it is rather than by its id, and that Auto Swap
 * never moves the screen out from under somebody's hands or flickers between
 * agents.
 *
 * And two that are not pure, because the rules they pin are wires rather
 * than functions: that a shell's edge never reaches the harness's inbox, and
 * that `send_agent` types the user's words into the pty and not into a
 * prompt. The inbox is a Unix socket in a temp directory, which is all the
 * real one is; the pty is a function that records what it was written.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HARNESS_TOOLS,
  SWAP_DWELL_MS,
  SWAP_GATHER_MS,
  SWAP_QUIET_MS,
  SWAP_STALE_MS,
  SWAP_TOOLS,
  SwapGate,
  TYPE_PIECE,
  DONE_SHOWN,
  READ_MAX,
  adoptHarness,
  agentName,
  boardCardOf,
  boardListing,
  clip,
  clipHead,
  due,
  envelope,
  handsOf,
  harnessCliOf,
  harnessConversation,
  harnessRunFlags,
  inboxFrames,
  isCommand,
  keyBytes,
  kuruRunningOn,
  mcpConfig,
  memoryIndexFor,
  memoryOrigin,
  projectDirName,
  rolePrompt,
  tellsHarness,
  trustAnswer,
  turnsFrom,
  typingPieces,
} from "../../shared/harness";
import { countsAsAgent, type AgentSnapshot } from "../../shared/model";
import { Harness, SAY_ANSWERS, screenText, type HarnessDeps, type SayOutcome } from "../src/harness";
import { Workspaces } from "../src/workspaces";
import { NEEDS_COLUMN, addCard, moveCard, type Board } from "../../shared/board";


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

  it("tells the session to call agents by name and to keep ids for tools", () => {
    const prompt = rolePrompt({ profile: "main", workspaces: [], launchers: [] });
    expect(prompt).toContain("## What you call them");
    expect(prompt).toContain("the Acme migration agent");
    expect(prompt).toMatch(/never say or write one to the user unless they ask/);
  });

  it("tells the session a path the user dropped is a file to Read, escaped as a terminal writes it", () => {
    const prompt = rolePrompt({ profile: "main", workspaces: [], launchers: [] });
    expect(prompt).toContain("## Files the user hands you");
    expect(prompt).toContain("Screenshot\\ 2026-10-25\\ at\\ 1.55.16\\ PM.png");
    expect(prompt).toMatch(/Read it — a picture too/);
    expect(prompt).toMatch(/leave the backslashes out when you Read/);
  });
});

describe("what an agent is called", () => {
  const base = { id: "a237", name: null, doing: null, program: "claude", workspace: "Acme", card: null };

  it("puts the words first and the id last, labelled", () => {
    const named = agentName({ ...base, name: "migration" });
    expect(named).toBe('"migration" (claude in Acme; id a237)');
    expect(named.startsWith("a237")).toBe(false);
  });

  it("falls back from a rename to the card, then to what it is doing, then to what it is", () => {
    const card = { code: "ACM-3", title: "Migrate the orders table" };
    expect(agentName({ ...base, card })).toBe('"Migrate the orders table" (claude in Acme, card ACM-3; id a237)');
    expect(agentName({ ...base, doing: "Fix the login bug" })).toBe('"Fix the login bug" (claude in Acme; id a237)');
    expect(agentName(base)).toBe("claude in Acme (id a237)");
    expect(agentName({ ...base, workspace: null })).toBe("claude (id a237)");
  });

  it("names a card's title once when the run is named after it, and both when renamed", () => {
    const card = { code: "ACM-3", title: "Migrate orders" };
    expect(agentName({ ...base, name: "Migrate orders", card })).toBe('"Migrate orders" (claude in Acme, card ACM-3; id a237)');
    expect(agentName({ ...base, name: "db", card })).toBe('"db" (claude in Acme, card ACM-3 "Migrate orders"; id a237)');
  });

  it("keeps a title a turn wrote to one short line", () => {
    const named = agentName({ ...base, doing: `Refactor\nthe ${"very ".repeat(30)}long thing` });
    expect(named).not.toContain("\n");
    expect(named.split('"')[1]!.length).toBeLessThanOrEqual(60);
    expect(named).toEndWith("(claude in Acme; id a237)");
  });
});

describe("Auto Swap's gate", () => {
  /** Ask the gate at `now` until it shows something or gives up, the way the server's timer does. */
  function settle<T>(gate: SwapGate<T>, now: number): { shown: T | null; at: number } {
    for (;;) {
      const next = gate.next(now);
      if (!next) return { shown: null, at: now };
      if ("show" in next) {
        gate.moved(now);
        return { shown: next.show, at: now };
      }
      now += next.wait;
    }
  }

  it("is told about every tool aimed at one agent, and not the wait or the explicit reveal", () => {
    const names = new Set(HARNESS_TOOLS.map((t) => t.name));
    for (const tool of SWAP_TOOLS) expect(names.has(tool)).toBe(true);
    for (const tool of ["send_agent", "read_agent", "press_keys", "start_agent", "run_card", "add_card", "stop_agent", "rename_agent"]) {
      expect(SWAP_TOOLS.has(tool)).toBe(true);
    }
    expect(SWAP_TOOLS.has("wait_agent")).toBe(false);
    expect(SWAP_TOOLS.has("reveal_agent")).toBe(false);
  });

  it("swaps a moment after one call", () => {
    const gate = new SwapGate<string>();
    gate.ask("a1", 1000);
    expect(gate.next(1000)).toEqual({ wait: SWAP_GATHER_MS });
    expect(gate.next(1000 + SWAP_GATHER_MS)).toEqual({ show: "a1" });
    expect(gate.next(1000 + SWAP_GATHER_MS)).toBeNull();
  });

  it("makes a burst of calls one swap, to the last of them", () => {
    const gate = new SwapGate<string>();
    gate.ask("a1", 0);
    gate.ask("a2", 50);
    gate.ask("a3", 100);
    expect(settle(gate, 100)).toEqual({ shown: "a3", at: 100 + SWAP_GATHER_MS });
  });

  it("holds each swap for the dwell, with the newest call waiting in one slot", () => {
    const gate = new SwapGate<string>();
    gate.ask("a1", 0);
    const first = settle(gate, 0);
    expect(first.shown).toBe("a1");
    // Two more while a1 is still being looked at: a2 is replaced, never shown.
    gate.ask("a2", first.at + 1000);
    expect(gate.next(first.at + 1000)).toEqual({ wait: SWAP_DWELL_MS - 1000 });
    gate.ask("a3", first.at + 2000);
    expect(settle(gate, first.at + 2000)).toEqual({ shown: "a3", at: first.at + SWAP_DWELL_MS });
  });

  it("waits for the hands to be still while somebody types, however long the call waited", () => {
    const gate = new SwapGate<string>();
    gate.touched("typing", 0);
    gate.ask("a1", 100);
    expect(gate.next(SWAP_GATHER_MS + 100)).toEqual({ wait: SWAP_QUIET_MS - SWAP_GATHER_MS - 100 });
    // Still typing when it was due: it waits again from the last keystroke.
    gate.touched("typing", 2000);
    expect(gate.next(SWAP_QUIET_MS)).toEqual({ wait: 2000 });
    expect(gate.next(2000 + SWAP_QUIET_MS)).toEqual({ show: "a1" });
  });

  it("drops a swap held off past the point of meaning anything", () => {
    const gate = new SwapGate<string>();
    gate.ask("a1", 0);
    for (let t = 0; t <= SWAP_STALE_MS; t += 1000) gate.touched("typing", t);
    expect(gate.next(SWAP_STALE_MS)).toBeNull();
    expect(gate.next(SWAP_STALE_MS + SWAP_QUIET_MS)).toBeNull();
  });

  it("gives way to a move of the user's own, and holds what is asked after it", () => {
    const gate = new SwapGate<string>();
    gate.ask("a1", 0);
    gate.touched("steering", 200);
    expect(gate.next(SWAP_GATHER_MS)).toBeNull();
    gate.ask("a2", 300);
    expect(settle(gate, 300)).toEqual({ shown: "a2", at: 200 + SWAP_QUIET_MS });
  });

  it("lets an explicit reveal stand: what was waiting is dropped and the dwell starts", () => {
    const gate = new SwapGate<string>();
    gate.ask("a1", 0);
    gate.moved(100);
    expect(gate.next(SWAP_GATHER_MS)).toBeNull();
    gate.ask("a2", 200);
    expect(settle(gate, 200)).toEqual({ shown: "a2", at: 100 + SWAP_DWELL_MS });
  });
});

describe("the user's hands", () => {
  it("are typing in a terminal, or moving about the screen, and nothing a client does on its own", () => {
    expect(handsOf("input")).toBe("typing");
    for (const type of ["switch-workspace", "switch-profile", "select-tab", "focus-pane", "last-workspace", "reveal-agent", "open-harness", "new-tab"] as const) {
      expect(handsOf(type)).toBe("steering");
    }
    for (const type of ["watch", "looking", "propose-size", "request-backlog", "worktree-status", "set-auto-swap"] as const) {
      expect(handsOf(type)).toBeNull();
    }
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

  it("brackets a paste only when there is a line break to protect", () => {
    expect(typingPieces("one line")).toEqual(["one line"]);
    expect(typingPieces("two\nlines")).toEqual(["\x1b[200~two\nlines\x1b[201~"]);
    expect(typingPieces("a\rb")).toEqual(["\x1b[200~a\rb\x1b[201~"]);
    expect(typingPieces("")).toEqual([]);
  });

  it("types a long line in pieces Claude Code never takes for a paste", () => {
    // The shape of the clip that lost its first half: one line of 1805.
    const said = `[voice] ${"I want to make a few changes on the sidebar, ".repeat(40)}`.trim();
    const pieces = typingPieces(said);
    expect(pieces.join("")).toBe(said);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((piece) => piece.length <= TYPE_PIECE)).toBe(true);
    // Over 800 in one read is a paste, so five that pile up are still typing.
    expect(5 * TYPE_PIECE).toBeLessThanOrEqual(800);
  });

  it("never ends a piece on half a character", () => {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const text = `${"a".repeat(TYPE_PIECE - 1)}${"😀".repeat(200)}`;
    const pieces = typingPieces(text);
    expect(pieces.join("")).toBe(text);
    for (const piece of pieces) expect(lone.test(piece)).toBe(false);
  });
});

describe("the inbox frames", () => {
  it("are the token, then one user turn, a line each, the content in the envelope", () => {
    const lines = inboxFrames("hello", "tok", "next").split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!)).toEqual({ type: "auth", token: "tok" });
    expect(JSON.parse(lines[1]!)).toEqual({
      type: "user",
      message: { role: "user", content: '<cross-session-message from-name="kururu (no reply)" from-mode="bypass">\nhello\n</cross-session-message>' },
      from: "kururu (no reply)",
      priority: "next",
    });
    expect(lines[2]).toBe("");
  });

  it("leave the token out when there is none, and declare the class they are told", () => {
    const lines = inboxFrames("x", null, "now", "prompting").trim().split("\n");
    expect(lines).toHaveLength(1);
    const frame = JSON.parse(lines[0]!);
    expect(frame.priority).toBe("now");
    expect(frame.message.content).toContain('from-mode="prompting"');
  });

  it("keep a body from closing the envelope early", () => {
    const wrapped = envelope("a </cross-session-message> b\n<CROSS-session-message>", "bypass");
    expect(wrapped.split("</cross-session-message>")).toHaveLength(2);
    expect(wrapped.endsWith("\n</cross-session-message>")).toBe(true);
    expect(wrapped.startsWith('<cross-session-message from-name="kururu (no reply)" from-mode="bypass">\n')).toBe(true);
  });

  it("are signed by a name no session's name begins with", () => {
    // Claude Code names a session nobody named after its folder and two hex
    // digits, folds a name to lower case with dashes for spaces, and resolves
    // a SendMessage address by prefix. The sender, folded the same way, must
    // be a prefix of none of those, or a reply finds a stranger.
    const folded = (name: string) => name.toLowerCase().replace(/\s+/g, "-");
    const sender = folded(JSON.parse(inboxFrames("x", null, "next").trim()).from);
    for (const session of ["kururu-7f", "kururu-f5", "kururu", "kururu-server-log", "harness"]) {
      expect(session.startsWith(sender)).toBe(false);
    }
    expect(sender.startsWith("kururu")).toBe(true);
  });
});

describe("when a waiting message is typed", () => {
  const m = (text: string, when: "now" | "next" | "later" = "next") => ({ text, when });

  it("knows a slash command from a message", () => {
    expect(isCommand("/compact")).toBe(true);
    expect(isCommand("  /model opus")).toBe(true);
    expect(isCommand("plugin:/cmd")).toBe(false);
    expect(isCommand("// a comment")).toBe(false);
    expect(isCommand("compact please")).toBe(false);
  });

  it("puts nothing into a prompt, whatever when says", () => {
    const held = [m("go", "now"), m("/compact")];
    expect(due(held, "blocked", true)).toEqual({ type: [], rest: held });
  });

  it("puts only now into a turn in progress, and never a command", () => {
    const held = [m("after", "next"), m("steer", "now"), m("/compact", "now"), m("also", "now"), m("last", "later")];
    expect(due(held, "working", true)).toEqual({ type: ["steer\n\nalso"], rest: [m("after", "next"), m("/compact", "now"), m("last", "later")] });
  });

  it("puts everything in between turns, now then next then later, a command alone", () => {
    const held = [m("last", "later"), m("first", "next"), m(" /compact ", "next"), m("then", "next"), m("steer", "now")];
    expect(due(held, "done", true)).toEqual({ type: ["steer\n\nfirst", "/compact", "then\n\nlast"], rest: [] });
    expect(due([m("hello")], "idle", true)).toEqual({ type: ["hello"], rest: [] });
  });

  it("types into a shell as it comes, since a shell has no turns to wait for", () => {
    const held = [m("ls", "later"), m(":q", "next")];
    expect(due(held, "working", false)).toEqual({ type: ["ls", ":q"], rest: [] });
  });

  it("types a notice as a turn of its own, never joined to the user's words", () => {
    const notice = { text: "[kururu] \"Migrate\" finished its turn. It said:\n  done ", when: "next" as const, alone: true };
    const held = [m("first", "now"), notice, m("then", "next")];
    expect(due(held, "done", true).type).toEqual(["first", notice.text, "then"]);
    // Its timing is still its when's: it waits out a turn in progress.
    expect(due(held, "working", true)).toEqual({ type: ["first"], rest: [notice, m("then", "next")] });
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

  it("keeps the program and OpenCode's conversation beside Claude Code's, and only a real session id", () => {
    const id = "0b6c2f1e-8d7a-4c3b-9e2f-1a2b3c4d5e6f";
    const ses = "ses_e714cb960ffex1NPKeXQKla7iN";
    expect(adoptHarness({ sessionId: id, cli: "opencode", opencodeSessionId: ses })).toEqual({
      sessionId: id,
      launcher: "claude",
      agentId: null,
      startedAt: 0,
      cli: "opencode",
      opencodeSessionId: ses,
    });
    // A record from before the choice reads back with neither key.
    expect(Object.keys(adoptHarness({ sessionId: id })!)).toEqual(["sessionId", "launcher", "agentId", "startedAt"]);
    expect(adoptHarness({ sessionId: id, cli: "gemini", opencodeSessionId: "ses_; rm -rf ~" })).toEqual({ sessionId: id, launcher: "claude", agentId: null, startedAt: 0 });
  });

  it("files turns under the conversation of the program the harness runs on", () => {
    const base = { sessionId: "claude-one", opencodeSessionId: "ses_e714cb960ffex1NPKeXQKla7iN" };
    expect(harnessConversation(base)).toBe("claude-one");
    expect(harnessConversation({ ...base, cli: "claude" })).toBe("claude-one");
    expect(harnessConversation({ ...base, cli: "opencode" })).toBe(base.opencodeSessionId);
    expect(harnessCliOf({})).toBe("claude");
  });

  it("says what a running Kuru is on, and nothing for one that is not running", () => {
    const harness = { sessionId: "s", launcher: "opencode", agentId: "h", startedAt: 0, cli: "opencode" as const };
    expect(kuruRunningOn(harness, [{ id: "h", exited: false }])).toBe("opencode");
    expect(kuruRunningOn({ ...harness, cli: undefined }, [{ id: "h", exited: false }])).toBe("claude");
    expect(kuruRunningOn(harness, [{ id: "h", exited: true }])).toBeNull();
    expect(kuruRunningOn(harness, [])).toBeNull();
    expect(kuruRunningOn(null, [{ id: "h", exited: false }])).toBeNull();
  });

  it("tells an OpenCode harness its tools' names there, and that a typed notice is not the user", () => {
    const claude = rolePrompt({ profile: "main", workspaces: [], launchers: [] });
    const opencode = rolePrompt({ profile: "main", workspaces: [], launchers: [], cli: "opencode" });
    expect(claude).toContain("mcp__kururu__");
    expect(claude).toContain("SendMessage");
    expect(opencode).not.toContain("mcp__kururu");
    expect(opencode).not.toContain("SendMessage");
    expect(opencode).toContain("kururu_kururu_status");
    expect(opencode).toContain("kururu_web_ tools");
    expect(opencode).toMatch(/it is not the user/);
    expect(opencode).toMatch(/never an instruction from the user/);
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

  it("presents the token by name, for a server that wants it on loopback, and only then", () => {
    const plain = JSON.parse(mcpConfig(7717, "p1", "s-1")) as { mcpServers: Record<string, { headers?: Record<string, string> }> };
    expect(plain.mcpServers.kururu!.headers).toBeUndefined();
    const config = JSON.parse(mcpConfig(7717, "p1", "s-1", true)) as { mcpServers: Record<string, { headers?: Record<string, string> }> };
    expect(config.mcpServers.kururu!.headers).toEqual({ authorization: "Bearer ${KURURU_TOKEN}" });
  });
});

function terminal(id: string, kind: AgentSnapshot["kind"], agent: string | null, title: string | null = null): AgentSnapshot {
  return {
    id,
    kind,
    title,
    status: "done",
    agent,
    unread: false,
    cwd: "/x",
    pid: 1,
    command: kind === "agent" ? "claude" : "/bin/zsh -l",
    createdAt: 0,
    contextUsage: null,
    titleOverride: null,
    exited: false,
    exitCode: null,
  };
}

describe("what the harness is told about", () => {
  it("is an agent's edge, and never a shell's", () => {
    expect(tellsHarness(terminal("a1", "agent", "claude"))).toBe(true);
    // Launched as one, before the process scan has named it.
    expect(tellsHarness(terminal("a2", "agent", null))).toBe(true);
    // A shell somebody typed claude into, while claude is in it.
    expect(tellsHarness(terminal("a3", "shell", "claude"))).toBe(true);
    // nvim, a card's dev server, a bare prompt.
    expect(tellsHarness(terminal("a4", "shell", null, "nvim"))).toBe(false);
  });

  it("still hears an agent exit, which is where it parts from countsAsAgent", () => {
    const gone = { ...terminal("a1", "agent", "claude"), exited: true };
    expect(countsAsAgent(gone)).toBe(false);
    expect(tellsHarness(gone)).toBe(true);
    expect(tellsHarness({ ...terminal("a4", "shell", null), exited: true })).toBe(false);
  });
});

describe("the feed", () => {
  const dir = mkdtempSync(join(tmpdir(), "kururu-feed-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** A harness `h` in profile `p`, an inbox that records what it is sent, and the terminals named. */
  async function rig(terminals: AgentSnapshot[]) {
    const socket = join(dir, `inbox-${Math.random().toString(36).slice(2, 8)}.sock`);
    const heard: string[] = [];
    const server = createServer((conn) => {
      let text = "";
      conn.on("data", (chunk) => (text += chunk.toString("utf8")));
      conn.on("end", () => heard.push(text));
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    const all = new Map(terminals.map((t) => [t.id, t]));
    const profile = { id: "p", harness: { agentId: "h" }, workspaces: [] };
    const deps = {
      workspaces: {
        profileOf: () => "p",
        profile: (id: string) => (id === "p" ? profile : undefined),
        agentsInWorkspace: () => [],
      },
      host: { isLive: () => true, find: (id: string) => all.get(id) },
      activity: new Map<string, string>(),
      launch: () => ({ bypassClis: [] }),
      madeOf: () => [],
    } as unknown as HarnessDeps;
    const harness = new Harness(deps);
    harness.report("h", { inbox: { socket, token: "tok" } });
    return { harness, heard, close: () => new Promise((resolve) => server.close(resolve)) };
  }

  async function until(check: () => boolean, ms = 2000): Promise<void> {
    const end = Date.now() + ms;
    while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  it("posts an agent's turn and its exit, and nothing about a shell's", async () => {
    const nvim = terminal("a8", "shell", null, "nvim");
    const claude = terminal("a9", "agent", "claude", "Migrate orders");
    const { harness, heard, close } = await rig([nvim, claude]);
    harness.noticed(nvim, "done", false);
    harness.noticed(nvim, "blocked", false);
    harness.noticed({ ...nvim, exited: true }, "done", true);
    harness.noticed(claude, "done", false);
    harness.noticed({ ...claude, exited: true }, "done", true);
    await until(() => heard.length >= 2);
    // Long enough for a shell's post to have landed, had one been sent.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await close();
    expect(heard).toHaveLength(2);
    expect(heard.join("")).not.toContain("a8");
    expect(heard[0]).toContain("Migrate orders");
    expect(heard[0]).toContain("finished its turn");
    expect(heard.some((text) => text.includes("exited."))).toBe(true);
  });

  it("types a notice into an OpenCode harness, which has no inbox, once its turn is over", async () => {
    jest.useFakeTimers();
    try {
      await notices();
    } finally {
      jest.useRealTimers();
    }
  });

  async function notices() {
    const kuru = { ...terminal("h", "agent", "opencode"), status: "working" as const };
    const claude = terminal("a9", "agent", "claude", "Migrate orders");
    const all = new Map([kuru, claude].map((t) => [t.id, t]));
    const typed: string[] = [];
    const profile = { id: "p", harness: { agentId: "h", cli: "opencode" }, workspaces: [] };
    const harness = new Harness({
      workspaces: { profileOf: () => "p", profile: (id: string) => (id === "p" ? profile : undefined), agentsInWorkspace: () => [] },
      host: { isLive: () => true, find: (id: string) => all.get(id), write: (_id: string, data: string) => typed.push(data) },
      activity: new Map<string, string>(),
      launch: () => ({ bypassClis: [] }),
      madeOf: () => [],
    } as unknown as HarnessDeps);
    harness.noticed(claude, "done", false);
    await elapse(50);
    // Mid-turn: held, as a `next` is.
    expect(typed).toHaveLength(0);
    all.set("h", { ...kuru, status: "done" });
    harness.report("h", { status: "done" });
    harness.noticed(all.get("h")!, "done", false);
    await untilFaked(() => typed.at(-1) === "\r");
    expect(typed.join("")).toContain('[kururu] "Migrate orders"');
    expect(typed.join("")).toContain("finished its turn");
  }

  it("says why a Kuru died starting, keeps its tab for it, and lets go once another starts", async () => {
    const all = new Map([["h1", terminal("h1", "agent", "opencode")]]);
    const profile = { id: "p", harness: { agentId: "h1", cli: "opencode", startedAt: Date.now() }, workspaces: [] };
    const harness = new Harness({
      workspaces: { profileOf: () => "p", profile: (id: string) => (id === "p" ? profile : undefined), agentsInWorkspace: () => [] },
      host: { isLive: (id: string) => all.get(id)?.exited === false, find: (id: string) => all.get(id), backlog: async () => "Error: no such flag --standalone\r\n", write: () => {} },
      grid: () => ({ cols: 80, rows: 24 }),
      activity: new Map<string, string>(),
      launch: () => ({ bypassClis: [] }),
      madeOf: () => [],
    } as unknown as HarnessDeps);

    // Up: reported in, so the wait is over and its end is an ordinary one.
    harness.report("h1", { status: "idle" });
    await harness.whenUp("h1", 500);
    all.set("h1", { ...all.get("h1")!, exited: true });
    expect(harness.diedStarting("h1")).toBe(false);

    // Never up: the end of its screen, and its tab kept.
    all.set("h2", { ...terminal("h2", "agent", "opencode"), exited: true });
    profile.harness = { ...profile.harness, agentId: "h2" };
    const said = await harness.whenUp("h2", 500).catch((err: Error) => err.message);
    expect(said).toContain("closed as it started, saying:\nError: no such flag --standalone");
    expect(harness.diedStarting("h2")).toBe(true);
    expect(harness.diedStarting("h2")).toBe(true);

    // The next start points the profile elsewhere, and the old tab is reaped.
    profile.harness = { ...profile.harness, agentId: "h3" };
    expect(harness.diedStarting("h2")).toBe(false);
  });

  it("still answers a wait that names a shell, since the harness asked", async () => {
    const nvim = { ...terminal("a8", "shell", null, "nvim"), status: "working" as const };
    const { harness, heard, close } = await rig([nvim]);
    const answer = harness.call("p", "h", "wait_agent", { agents: ["a8"], timeout_s: 5 });
    harness.noticed({ ...nvim, status: "done" }, "done", false);
    const result = await answer;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await close();
    expect(JSON.stringify(result)).toContain("finished its turn");
    expect(heard).toHaveLength(0);
  });
});

/**
 * A faked clock, for the tests that wait on the harness's own pacing — the
 * pause before Enter, the gap between pieces of a long line — which are
 * hundreds of milliseconds of nothing in real time. The clock is moved a
 * step at a time, and between steps what real time would have let finish is
 * let finish. Only for a test that called `jest.useFakeTimers()` first.
 */
const STEP_MS = 25;

async function elapse(ms: number): Promise<void> {
  for (let passed = 0; passed < ms; passed += STEP_MS) {
    jest.advanceTimersByTime(STEP_MS);
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  }
}

async function untilFaked(check: () => boolean, ms = 3000): Promise<void> {
  for (let passed = 0; !check() && passed < ms; passed += STEP_MS) await elapse(STEP_MS);
}

/** A promise that waits on the harness's timers, resolved by moving the clock until it is. */
async function settled<T>(promise: Promise<T>, ms = 10_000): Promise<T> {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  await untilFaked(() => done, ms);
  return promise;
}

describe("the user's words", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  /** A harness for profile `p` over terminals whose pty is a list of what was written to it. */
  function rig(terminals: AgentSnapshot[]) {
    const all = new Map(terminals.map((t) => [t.id, t]));
    const typed = new Map<string, string>();
    const writes: { id: string; data: string; at: number }[] = [];
    const deps = {
      workspaces: {
        profileOf: () => "p",
        profile: (id: string) => (id === "p" ? { id: "p", harness: { agentId: "h" }, workspaces: [] } : undefined),
        agentsInWorkspace: () => [],
      },
      host: {
        isLive: () => true,
        find: (id: string) => all.get(id),
        write: (id: string, data: string) => {
          typed.set(id, (typed.get(id) ?? "") + data);
          writes.push({ id, data, at: Date.now() });
          // An Enter starts a turn, as it would; it also spares the test the
          // two seconds `settled` would otherwise wait for one.
          const agent = all.get(id);
          if (data === "\r" && agent) all.set(id, { ...agent, status: "working" });
        },
      },
      activity: new Map<string, string>(),
      launch: () => ({ bypassClis: [] }),
      madeOf: () => [],
    } as unknown as HarnessDeps;
    const harness = new Harness(deps);
    const send = async (agent: string, text: string, when?: string) => JSON.stringify(await settled(harness.call("p", "h", "send_agent", { agent, text, when })));
    const set = (id: string, status: AgentSnapshot["status"]) => {
      const agent = { ...all.get(id)!, status };
      all.set(id, agent);
      return agent;
    };
    return { harness, typed, writes, send, set };
  }

  const until = untilFaked;

  it("types a message into an agent between turns, with no envelope and no sender", async () => {
    const { typed, send } = rig([terminal("a1", "agent", "claude", "Mailpit")]);
    const result = await send("a1", "put dev:prod on the shared Mailpit");
    expect(result).toContain("Typed into");
    expect(typed.get("a1")).toBe("put dev:prod on the shared Mailpit\r");
  });

  it("types a long line as pieces written apart, and presses Enter after the last", async () => {
    const { typed, writes, send } = rig([terminal("a1", "agent", "claude")]);
    const said = `[voice] ${"I want to make a few changes on the sidebar, ".repeat(40)}`.trim();
    expect(await send("a1", said)).toContain("Typed into");
    expect(typed.get("a1")).toBe(`${said}\r`);
    const mine = writes.filter((w) => w.id === "a1");
    expect(mine.at(-1)?.data).toBe("\r");
    const pieces = mine.slice(0, -1);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((w) => w.data.length <= TYPE_PIECE)).toBe(true);
    // Apart, so that each is a read of its own and not one paste of them all.
    for (let i = 1; i < pieces.length; i++) expect(pieces[i]!.at - pieces[i - 1]!.at).toBeGreaterThanOrEqual(30);
  });

  it("holds next for the end of the turn, and types it then", async () => {
    const { harness, typed, send, set } = rig([{ ...terminal("a1", "agent", "claude", "Mailpit"), status: "working" }]);
    expect(await send("a1", "then run the tests")).toContain("mid-turn");
    expect(typed.has("a1")).toBe(false);
    harness.noticed(set("a1", "done"), "done", false);
    await until(() => typed.get("a1")?.endsWith("\r") ?? false);
    expect(typed.get("a1")).toBe("then run the tests\r");
  });

  it("types /compact as a command once the turn is over, and not before", async () => {
    const { harness, typed, send, set } = rig([{ ...terminal("a1", "agent", "claude"), status: "working" }]);
    expect(await send("a1", "/compact", "now")).toContain("slash command");
    expect(typed.has("a1")).toBe(false);
    harness.noticed(set("a1", "done"), "done", false);
    await until(() => typed.get("a1")?.endsWith("\r") ?? false);
    expect(typed.get("a1")).toBe("/compact\r");
  });

  it("never types into a prompt, even now", async () => {
    const { harness, typed, send, set } = rig([{ ...terminal("a1", "agent", "claude"), status: "blocked" }]);
    expect(await send("a1", "yes, go ahead", "now")).toContain("showing a prompt");
    harness.noticed(set("a1", "blocked"), "blocked", false);
    await elapse(50);
    expect(typed.has("a1")).toBe(false);
  });

  it("waits for the user's hands to leave the terminal", async () => {
    const { harness, typed, send } = rig([terminal("a1", "agent", "claude"), terminal("a2", "agent", "claude")]);
    harness.hands("typing", "a1");
    expect(await send("a1", "hello")).toContain("the user is typing");
    expect(typed.has("a1")).toBe(false);
    // Somebody typing elsewhere holds nothing here.
    expect(await send("a2", "hello")).toContain("Typed into");
  });
});

describe("the harness's own run", () => {
  it("names its model, effort and a window that compacts it near 200k, last on the line", () => {
    expect(harnessRunFlags()).toEqual(["--model", "claude-opus-5-5", "--effort", "high", "--autocompact", "233k"]);
  });

  it("files a folder's transcripts where Claude Code does", () => {
    expect(projectDirName("/Users/me/.local/share/kururu/harness/pk0123456789ab")).toBe("-Users-me--local-share-kururu-harness-pk0123456789ab");
  });

  it("reads which session a memory was written in", () => {
    const memory = "---\nname: x\nmetadata:\n  type: feedback\n  originSessionId: 584040cf-b964-4819-a0fc-afefed5fcc79\n---\n\nbody originSessionId: nope";
    expect(memoryOrigin(memory)).toBe("584040cf-b964-4819-a0fc-afefed5fcc79");
    expect(memoryOrigin("no frontmatter\noriginSessionId: 584040cf-b964-4819-a0fc-afefed5fcc79")).toBeNull();
    expect(memoryOrigin("---\nname: x\n---\n")).toBeNull();
  });

  it("keeps the index lines of what was carried, and names what the index forgot", () => {
    const index = "- [Mine](mine.md) — kept\n- [Theirs](theirs.md) — the project's\nnot a link\n- [Also](also.md) — kept too\n";
    expect(memoryIndexFor(index, new Set(["mine.md", "also.md", "lost.md"]))).toBe(
      "- [Mine](mine.md) — kept\n- [Also](also.md) — kept too\n- [lost](lost.md)\n",
    );
    expect(memoryIndexFor(index, new Set())).toBe("");
  });

  it("says yes to the trust dialog by looking where the pointer is", () => {
    const asked = (first: string, second: string) => `Quick safety check: Is this a project you created or one you trust?\n${first}\n${second}\nEnter to confirm`;
    expect(trustAnswer(asked("❯ No, exit", "  Yes, I trust this folder"))).toBe("down");
    expect(trustAnswer(asked("  No, exit", "❯ Yes, I trust this folder"))).toBe("enter");
    expect(trustAnswer("❯ Try \"how does <filepath> work?\"")).toBeNull();
  });
});

describe("run_card on a card that has run", () => {
  const id = "0b6c2f1e-8d7a-4c3b-9e2f-1a2b3c4d5e6f";
  const lastRun = (agentId: string | null, state: "ended" | "finished" | "asleep") => ({
    agentId,
    launcher: "claude:claude-opus-5-5",
    label: "Claude Opus 5.5",
    state,
    startedAt: 1_000,
    endedAt: 2_000,
    sessionId: id,
    cwd: "/work/site",
  });

  /** A harness whose board has card `c1` with the run given, and whose `runCard` answers as told. */
  function rig(run: ReturnType<typeof lastRun> | null, answer: { resumed: boolean; why: string | null }, live: string[] = []) {
    const asked: { launcherId: string; fresh: boolean }[] = [];
    const card = { id: "c1", title: "F1 theme", body: "", run };
    const deps = {
      workspaces: {
        profileOf: () => "p",
        profile: (pid: string) => (pid === "p" ? { id: "p", harness: { agentId: "h" }, workspaces: [] } : undefined),
        agentsInWorkspace: () => [],
        workspaceIn: (_p: string, w: string) => (w === "w1" ? { id: "w1" } : undefined),
        findCardIn: (_p: string, _w: string, c: string) => (c === "c1" ? { card } : undefined),
      },
      host: { isLive: (agentId: string) => live.includes(agentId), find: () => undefined },
      runCard: async (_p: string, _w: string, _c: string, launcherId: string, fresh: boolean) => {
        asked.push({ launcherId, fresh });
        return { agentId: "a20", ...answer };
      },
      activity: new Map<string, string>(),
      launch: () => ({ bypassClis: [] }),
      madeOf: () => [],
    } as unknown as HarnessDeps;
    const harness = new Harness(deps);
    const call = async (args: Record<string, unknown> = {}) =>
      JSON.stringify(await harness.call("p", "h", "run_card", { workspace: "w1", card: "c1", ...args }));
    return { call, asked };
  }

  it("goes back to the launcher a crash took it off, and says it resumed", async () => {
    const { call, asked } = rig(lastRun(null, "ended"), { resumed: true, why: null });
    const said = await call();
    expect(asked).toEqual([{ launcherId: "claude:claude-opus-5-5", fresh: false }]);
    expect(said).toContain("Resumed card c1's conversation");
    expect(said).toContain("Claude Opus 5.5");
  });

  it("says so, loudly, when it had to start over", async () => {
    const { call } = rig(lastRun(null, "finished"), { resumed: false, why: "its conversation is no longer on this Mac's disk" });
    const said = await call();
    expect(said).toContain("NEW conversation, because its conversation is no longer on this Mac's disk");
    expect(said).toContain("told the card has run before");
  });

  it("refuses a card whose agent is still open, rather than start a second beside it", async () => {
    const { call, asked } = rig(lastRun("a12", "finished"), { resumed: false, why: null }, ["a12"]);
    const said = await call();
    expect(asked).toEqual([]);
    expect(said).toContain("still open");
    expect(said).toContain("send_agent");
    // Asked for in so many words, a second conversation is allowed.
    await call({ fresh: true });
    expect(asked).toEqual([{ launcherId: "claude:claude-opus-5-5", fresh: true }]);
  });

  it("hands a card that never ran to Claude without a word about earlier work", async () => {
    const { call, asked } = rig(null, { resumed: false, why: null });
    const said = await call();
    expect(asked).toEqual([{ launcherId: "claude", fresh: false }]);
    expect(said).toContain("Handed card c1 to Claude");
    expect(said).not.toContain("NEW conversation");
  });
});

/**
 * Needs you through Kuru's own tools, on a real arrangement: a card it puts
 * there is Kuru's, `cards` says so, and a column that is not one is refused
 * by name rather than reported as a move.
 */
describe("Needs you, from the harness", () => {
  function rig() {
    const ws = new Workspaces();
    const profileId = ws.active.id;
    const deps = {
      workspaces: ws,
      host: { isLive: () => false, find: () => undefined },
      activity: new Map<string, string>(),
      launch: () => ({ bypassClis: [] }),
      madeOf: () => [],
    } as unknown as HarnessDeps;
    const harness = new Harness(deps);
    const call = async (name: string, args: Record<string, unknown>) => harness.call(profileId, null, name, args);
    return { ws, call };
  }

  it("puts a card there as Kuru's, and says where it went", async () => {
    const { ws, call } = rig();
    const added = await call("add_card", { title: "Renew the domain", column: NEEDS_COLUMN });
    expect(added.isError).toBeFalsy();
    expect(added.text).toContain("in Needs you");
    const card = ws.active.board.cards[0]!;
    expect([card.column, card.needsBy]).toEqual([NEEDS_COLUMN, "kuru"]);
    expect((await call("cards", {})).text).toContain("[put here by Kuru]");
    // No column at all is the first, and the reply says which.
    expect((await call("add_card", { title: "A thought" })).text).toContain("in To do");
  });

  it("moves a card in as Kuru's, and refuses a column the board does not have", async () => {
    const { ws, call } = rig();
    await call("add_card", { title: "Try it on the phone" });
    const id = ws.active.board.cards[0]!.id;
    const moved = await call("move_card", { card: id, column: NEEDS_COLUMN });
    expect(moved.text).toContain("Needs you");
    expect(ws.active.board.cards[0]!.needsBy).toBe("kuru");
    const refused = await call("move_card", { card: id, column: "review" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(NEEDS_COLUMN);
    expect(ws.active.board.cards[0]!.column).toBe(NEEDS_COLUMN);
    expect((await call("move_card", { card: "nope", column: "done" })).isError).toBe(true);
  });
});

/**
 * `cards` on a board with a history. It listed every column and cut with
 * `clip`, which keeps the end, so past `READ_MAX` the live work was cut and
 * Done was what Kuru read — four times in its transcript before the review
 * found it. And it took `column` and `card` without reading either.
 */
describe("cards, on a big board", () => {
  /** A profile board with a few live cards and a Done far past `READ_MAX`. */
  function bigBoard(): Board {
    let board: Board = { cards: [], next: 1 } as unknown as Board;
    const now = Date.now();
    board = addCard(board, { title: "Live: ship the gate fix", body: "The gate.", column: "todo" }, "c-live-1", now);
    board = addCard(board, { title: "Live: the cards tool", column: "doing" }, "c-live-2", now);
    for (let i = 0; i < 200; i++) {
      board = addCard(board, { title: `Old work ${i}`, body: "x".repeat(300) }, `c-old-${i}`, now);
      board = moveCard(board, `c-old-${i}`, "done");
    }
    return board;
  }
  const line = (card: { id: string; title: string; body: string }, full: boolean) => `${card.id} "${card.title}"${full ? `\n${card.body}` : ` — ${card.body.slice(0, 200)}`}`;

  it("lists the live columns whole and Done as a count and its most recent", () => {
    const board = bigBoard();
    expect(board.cards.length).toBe(202);
    const { ok, text } = boardListing(board, "the board", line);
    expect(ok).toBe(true);
    expect(text).toContain("Live: ship the gate fix");
    expect(text).toContain("Live: the cards tool");
    expect(text).toContain("— 200; the 5 most recent");
    // Done keeps its newest on top, so the five shown are the last five done.
    expect(text).toContain("Old work 199");
    expect(text).toContain(`Old work ${200 - DONE_SHOWN}`);
    expect(text).not.toContain(`Old work ${199 - DONE_SHOWN}"`);
    expect(text.length).toBeLessThan(READ_MAX);
  });

  it("lists one column whole when asked, cut from the end and never the start", () => {
    const { ok, text } = boardListing(bigBoard(), "the board", line, { column: "done" });
    expect(ok).toBe(true);
    expect(text).not.toContain("Live:");
    expect(text).toContain("Old work 199");
    expect(text).toContain("characters after this were cut");
    expect(text.length).toBeLessThan(READ_MAX + 200);
  });

  it("refuses a column the board does not have, by name", () => {
    const { ok, text } = boardListing(bigBoard(), "the board", line, { column: "nonsense" });
    expect(ok).toBe(false);
    expect(text).toContain("todo");
  });

  it("reads one card whole, by id or by code", () => {
    const board = bigBoard();
    const number = board.cards.find((c) => c.id === "c-live-1")!.number;
    for (const ref of ["c-live-1", `#${number}`, `KUR-${number}`, String(number)]) {
      const { ok, text } = boardListing(board, "the board", line, { card: ref });
      expect(ok).toBe(true);
      expect(text).toContain("Live: ship the gate fix");
      expect(text).toContain("in To do (todo)");
      expect(text).not.toContain("Old work");
    }
    expect(boardCardOf(board, "KUR-99999")).toBeNull();
    expect(boardListing(board, "the board", line, { card: "nope" }).ok).toBe(false);
  });

  it("keeps the start of what it cuts", () => {
    expect(clipHead("abcdef", 3)).toBe("abc\n…[3 characters after this were cut]");
    expect(clipHead("abc", 3)).toBe("abc");
  });

  it("does all of it through the tool, as Kuru calls it", async () => {
    const ws = new Workspaces();
    const profileId = ws.active.id;
    const harness = new Harness({
      workspaces: ws,
      host: { isLive: () => false, find: () => undefined },
      activity: new Map<string, string>(),
      launch: () => ({ bypassClis: [] }),
      madeOf: () => [],
    } as unknown as HarnessDeps);
    const call = (args: Record<string, unknown>) => harness.call(profileId, null, "cards", args);
    await harness.call(profileId, null, "add_card", { title: "Live: ship the gate fix", body: "The whole body." });
    for (let i = 0; i < 120; i++) await harness.call(profileId, null, "add_card", { title: `Old work ${i}`, body: "x".repeat(300), column: "done" });
    const all = await call({});
    expect(all.text).toContain("Live: ship the gate fix");
    expect(all.text).toContain("the 5 most recent");
    const done = await call({ column: "done" });
    expect(done.text).not.toContain("Live:");
    expect(done.text).toContain("Old work");
    const live = ws.active.board.cards.find((c) => c.title.startsWith("Live"))!;
    const one = await call({ card: live.id });
    expect(one.text).toContain("The whole body.");
    expect(one.text).not.toContain("Old work");
    expect((await call({ column: "nonsense" })).isError).toBe(true);
    // The schema says it takes both, so a call with them is not one Kuru is guessing at.
    const schema = HARNESS_TOOLS.find((t) => t.name === "cards")!.inputSchema as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(["column", "card"]));
  });
});

/**
 * `say` with voice replies off. The speaker is `index.ts`'s and `Voice.aside`
 * is held by its own test; what this holds is that Kuru is told, so it writes
 * the line instead of reaching for the tool again.
 */
describe("say, and what Kuru is told", () => {
  function rig(outcome: SayOutcome) {
    const ws = new Workspaces();
    const said: string[] = [];
    const harness = new Harness({
      workspaces: ws,
      host: { isLive: () => false, find: () => undefined },
      activity: new Map<string, string>(),
      launch: () => ({ bypassClis: [] }),
      madeOf: () => [],
      say: (_profileId: string, text: string) => {
        said.push(text);
        return outcome;
      },
    } as unknown as HarnessDeps);
    return { said, call: (text: string) => harness.call(ws.active.id, null, "say", { text }) };
  }

  it("says Said. when it was", async () => {
    const { said, call } = rig("spoken");
    expect((await call("Starting three agents.")).text).toBe(SAY_ANSWERS.spoken);
    expect(said).toEqual(["Starting three agents."]);
  });

  it("says voice replies are off, and to write it instead, when they are", async () => {
    const { call } = rig("voice-off");
    const answer = await call("Starting three agents.");
    expect(answer.isError).toBeFalsy();
    expect(answer.text).toContain("voice replies are off");
    expect(answer.text).toContain("written reply");
  });
});
