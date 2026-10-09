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
import { afterAll, describe, expect, it } from "bun:test";
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
  adoptHarness,
  agentName,
  clip,
  due,
  envelope,
  handsOf,
  inboxFrames,
  isCommand,
  keyBytes,
  mcpConfig,
  pasteBytes,
  rolePrompt,
  tellsHarness,
  turnsFrom,
} from "../../shared/harness";
import { countsAsAgent, type AgentSnapshot } from "../../shared/model";
import { Harness, screenText, type HarnessDeps } from "../src/harness";

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
    expect(prompt).toContain("the Fastermenu migration agent");
    expect(prompt).toMatch(/never say or write one to the user unless they ask/);
  });
});

describe("what an agent is called", () => {
  const base = { id: "a237", name: null, doing: null, program: "claude", workspace: "Fastermenu", card: null };

  it("puts the words first and the id last, labelled", () => {
    const named = agentName({ ...base, name: "migration" });
    expect(named).toBe('"migration" (claude in Fastermenu; id a237)');
    expect(named.startsWith("a237")).toBe(false);
  });

  it("falls back from a rename to the card, then to what it is doing, then to what it is", () => {
    const card = { code: "FAS-3", title: "Migrate the orders table" };
    expect(agentName({ ...base, card })).toBe('"Migrate the orders table" (claude in Fastermenu, card FAS-3; id a237)');
    expect(agentName({ ...base, doing: "Fix the login bug" })).toBe('"Fix the login bug" (claude in Fastermenu; id a237)');
    expect(agentName(base)).toBe("claude in Fastermenu (id a237)");
    expect(agentName({ ...base, workspace: null })).toBe("claude (id a237)");
  });

  it("names a card's title once when the run is named after it, and both when renamed", () => {
    const card = { code: "FAS-3", title: "Migrate orders" };
    expect(agentName({ ...base, name: "Migrate orders", card })).toBe('"Migrate orders" (claude in Fastermenu, card FAS-3; id a237)');
    expect(agentName({ ...base, name: "db", card })).toBe('"db" (claude in Fastermenu, card FAS-3 "Migrate orders"; id a237)');
  });

  it("keeps a title a turn wrote to one short line", () => {
    const named = agentName({ ...base, doing: `Refactor\nthe ${"very ".repeat(30)}long thing` });
    expect(named).not.toContain("\n");
    expect(named.split('"')[1]!.length).toBeLessThanOrEqual(60);
    expect(named).toEndWith("(claude in Fastermenu; id a237)");
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

  it("brackets a paste only when there is a newline to protect", () => {
    expect(pasteBytes("one line")).toBe("one line");
    expect(pasteBytes("two\nlines")).toBe("\x1b[200~two\nlines\x1b[201~");
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

describe("the user's words", () => {
  /** A harness for profile `p` over terminals whose pty is a list of what was written to it. */
  function rig(terminals: AgentSnapshot[]) {
    const all = new Map(terminals.map((t) => [t.id, t]));
    const typed = new Map<string, string>();
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
          // An Enter starts a turn, as it would; it also spares the test the
          // two seconds `settled` would otherwise wait for one.
          const agent = all.get(id);
          if (data === "\r" && agent) all.set(id, { ...agent, status: "working" });
        },
      },
      activity: new Map<string, string>(),
      launch: () => ({ bypassClis: [] }),
    } as unknown as HarnessDeps;
    const harness = new Harness(deps);
    const send = async (agent: string, text: string, when?: string) => JSON.stringify(await harness.call("p", "h", "send_agent", { agent, text, when }));
    const set = (id: string, status: AgentSnapshot["status"]) => {
      const agent = { ...all.get(id)!, status };
      all.set(id, agent);
      return agent;
    };
    return { harness, typed, send, set };
  }

  async function until(check: () => boolean, ms = 3000): Promise<void> {
    const end = Date.now() + ms;
    while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  it("types a message into an agent between turns, with no envelope and no sender", async () => {
    const { typed, send } = rig([terminal("a1", "agent", "claude", "Mailpit")]);
    const result = await send("a1", "put dev:prod on the shared Mailpit");
    expect(result).toContain("Typed into");
    expect(typed.get("a1")).toBe("put dev:prod on the shared Mailpit\r");
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
    await new Promise((resolve) => setTimeout(resolve, 50));
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
