/**
 * Kuru on OpenCode: the config kururu writes into Kuru's folder, the session
 * id it picks, and the plugin that stands in for Claude Code's hooks.
 *
 * The plugin is the part that is not pure, and the part most worth pinning,
 * because everything Kuru says reaches the drawer, the voice and Telegram
 * through what it reports. So it is loaded as OpenCode would load it — the
 * same string, written to a file and imported — against a context that is
 * a fake OpenCode: an event stream the test pushes into, a prompt hook it
 * calls, a session whose messages it sets. `fetch` is a list of what was
 * posted to kururu.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OPENCODE_SESSION_ID } from "../../shared/harness";
import { mintOpencodeSession, opencodeCandidates, opencodeHarnessCommand, opencodeHarnessConfig, opencodeModelRef, opencodeVersion } from "../../shared/opencode";
import { findOpencode, OPENCODE_PLUGIN } from "../src/opencode";

describe("the session kururu picks", () => {
  it("is shaped like OpenCode's own, and a newer one sorts first", () => {
    const older = mintOpencodeSession(1_790_000_000_000);
    const newer = mintOpencodeSession(1_790_000_001_000);
    expect(older).toMatch(OPENCODE_SESSION_ID);
    expect(newer).toMatch(OPENCODE_SESSION_ID);
    expect(newer < older).toBe(true);
    expect(mintOpencodeSession()).not.toBe(mintOpencodeSession());
  });
});

describe("the line", () => {
  const id = "ses_e714cb960ffex1NPKeXQKla7iN";

  const bin = "/Users/me/.opencode/bin/opencode";

  it("starts a private server on the session by its full path, with --auto only when asked", () => {
    expect(opencodeHarnessCommand(bin, id, false)).toBe(`'${bin}' --standalone --session ${id}`);
    expect(opencodeHarnessCommand(bin, id, true)).toBe(`'${bin}' --standalone --session ${id} --auto`);
    expect(opencodeHarnessCommand("/Users/o'neil/bin/opencode", id, false)).toBe(`'/Users/o'\\''neil/bin/opencode' --standalone --session ${id}`);
  });

  it("refuses anything that is not a session id or a full path, since the line is for sh -c", () => {
    expect(() => opencodeHarnessCommand(bin, "ses_x; rm -rf ~", false)).toThrow();
    expect(() => opencodeHarnessCommand("opencode", id, false)).toThrow();
  });

  it("splits a model into what OpenCode's session API takes", () => {
    expect(opencodeModelRef("anthropic/claude-opus-5-5#high")).toEqual({ providerID: "anthropic", id: "claude-opus-5-5", variant: "high" });
    expect(opencodeModelRef("openrouter/anthropic/claude-opus-5-5")).toEqual({ providerID: "openrouter", id: "anthropic/claude-opus-5-5" });
    expect(opencodeModelRef("nonsense")).toBeNull();
  });
});

describe("which opencode", () => {
  const dir = mkdtempSync(join(tmpdir(), "kururu-which-opencode-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** A fake `opencode` in a folder of its own, which prints a version or dies as it is told. */
  function fake(name: string, body: string): string {
    const folder = join(dir, name);
    mkdirSync(folder, { recursive: true });
    const path = join(folder, "opencode");
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  it("looks in the installer's folder before the PATH, once each", () => {
    expect(opencodeCandidates("/Users/me", "/opt/homebrew/bin:/usr/bin/:relative:/opt/homebrew/bin")).toEqual([
      "/Users/me/.opencode/bin/opencode",
      "/opt/homebrew/bin/opencode",
      "/usr/bin/opencode",
    ]);
  });

  it("reads a version however OpenCode prints it", () => {
    expect(opencodeVersion("opencode v2.2.4\n")).toEqual([2, 2, 4]);
    expect(opencodeVersion("1.14.41")).toEqual([1, 14, 41]);
    expect(opencodeVersion("")).toBeNull();
  });

  it("passes over an OpenCode 1 and one that is killed at launch, for the first OpenCode 2", async () => {
    const old = fake("old", 'echo "1.14.41"');
    const killed = fake("killed", "kill -9 $$");
    const good = fake("good", 'echo "opencode v2.2.4"');
    expect(await findOpencode([join(dir, "missing", "opencode"), old, killed, good])).toEqual({ path: good, version: "2.2.4" });
  });

  it("says what it found and how to install, when none will do", async () => {
    const old = fake("old2", 'echo "1.14.41"');
    const killed = fake("killed2", "kill -9 $$");
    const error = await findOpencode([old, killed]).catch((err: Error) => err.message);
    expect(error).toContain(`${old} is 1.14.41`);
    expect(error).toContain(`${killed} was killed (SIGKILL)`);
    expect(error).toContain("opencode.ai/v2/install");
    expect(await findOpencode([join(dir, "nowhere", "opencode")]).catch((err: Error) => err.message)).toContain("There is none");
  });
});

describe("the config in Kuru's folder", () => {
  const base = {
    port: 7717,
    profileId: "p3",
    sessionId: "ses_e714cb960ffex1NPKeXQKla7iN",
    withToken: false,
    model: "anthropic/claude-opus-5-5#high",
    plugin: "/state/opencode-plugin",
    role: "/home/.opencode/kururu-role.md",
    web: false,
  };
  type Server = { type: string; url: string; oauth: boolean; codemode: boolean; headers?: Record<string, string> };
  const servers = (config: Record<string, unknown>) => (config.mcp as { servers: Record<string, Server> }).servers;

  it("points kururu's verbs at the endpoint Claude Code is given, each a tool of its own", () => {
    const kururu = servers(opencodeHarnessConfig(base)).kururu!;
    expect(kururu).toMatchObject({ type: "remote", url: "http://127.0.0.1:7717/mcp?profile=p3&session=ses_e714cb960ffex1NPKeXQKla7iN", oauth: false, codemode: false });
    expect(kururu.headers).toBeUndefined();
  });

  it("presents the token by name only for a server that wants it, and never the token", () => {
    const config = opencodeHarnessConfig({ ...base, withToken: true, web: true });
    expect(servers(config).kururu!.headers).toEqual({ authorization: "Bearer {env:KURURU_TOKEN}" });
    expect(servers(config).kururu_web!.headers).toEqual({ "x-kururu-agent": "{env:KURURU_AGENT_ID}", authorization: "Bearer {env:KURURU_TOKEN}" });
  });

  it("adds the web tools only while a provider is on", () => {
    expect(servers(opencodeHarnessConfig(base)).kururu_web).toBeUndefined();
    expect(servers(opencodeHarnessConfig({ ...base, web: true })).kururu_web!.url).toBe("http://127.0.0.1:7717/mcp/web");
  });

  it("puts the model on build, the role in the instructions, and the session in the plugin's options", () => {
    const config = opencodeHarnessConfig(base);
    expect(config.agents).toEqual({ build: { model: "anthropic/claude-opus-5-5#high" } });
    expect(config.default_agent).toBe("build");
    expect(config.instructions).toEqual(["/home/.opencode/kururu-role.md"]);
    expect(config.plugins).toEqual([
      {
        package: "/state/opencode-plugin",
        options: {
          session: base.sessionId,
          port: 7717,
          model: base.model,
          modelRef: { providerID: "anthropic", id: "claude-opus-5-5", variant: "high" },
          compactAt: 200_000,
        },
      },
    ]);
  });
});

/** A stream the test pushes events into and the plugin reads with `for await`. */
function stream<T>() {
  const queue: T[] = [];
  let wake: (() => void) | null = null;
  return {
    push(item: T) {
      queue.push(item);
      wake?.();
    },
    async *read(signal: AbortSignal): AsyncGenerator<T> {
      while (!signal.aborted) {
        if (!queue.length) await new Promise<void>((resolve) => ((wake = resolve), signal.addEventListener("abort", () => resolve(), { once: true })));
        while (queue.length) yield queue.shift()!;
      }
    },
  };
}

describe("the plugin", () => {
  const dir = mkdtempSync(join(tmpdir(), "kururu-opencode-"));
  const session = "ses_e714cb960ffex1NPKeXQKla7iN";
  const saved = { fetch: globalThis.fetch, agent: process.env.KURURU_AGENT_ID, config: process.env.KURURU_CONFIG_DIR, token: process.env.KURURU_TOKEN };
  const posted: Record<string, unknown>[] = [];
  type Plugin = {
    default: { id: string; setup: (ctx: unknown) => Promise<(() => Promise<void>) | undefined> };
    turnEnd: (messages: unknown[]) => { id: string | null; text: string } | null;
    failureOf: (messages: unknown[]) => string | null;
  };
  let plugin: Plugin;

  beforeAll(async () => {
    writeFileSync(join(dir, "index.js"), OPENCODE_PLUGIN);
    plugin = (await import(join(dir, "index.js"))) as Plugin;
    process.env.KURURU_AGENT_ID = "a1";
    process.env.KURURU_CONFIG_DIR = dir;
    delete process.env.KURURU_TOKEN;
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      posted.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
      return new Response("{}");
    }) as unknown as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = saved.fetch;
    for (const [key, value] of [
      ["KURURU_AGENT_ID", saved.agent],
      ["KURURU_CONFIG_DIR", saved.config],
      ["KURURU_TOKEN", saved.token],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  async function until(check: () => boolean, ms = 2000): Promise<void> {
    const end = Date.now() + ms;
    while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const assistant = (id: string, text: string, tokens?: object) => ({
    id,
    type: "assistant",
    content: text ? [{ type: "text", text }] : [{ type: "tool", name: "kururu_read_agent" }],
    model: { providerID: "anthropic", id: "claude-opus-5-5" },
    ...(tokens ? { tokens } : {}),
  });

  it("reads a turn's reply off its last words, and why a failed one failed", () => {
    const messages = [{ type: "user", text: "go" }, assistant("m1", "Looking."), assistant("m2", "Done: a typo."), assistant("m3", "")];
    expect(plugin.turnEnd(messages)).toMatchObject({ id: "m2", text: "Done: a typo." });
    expect(plugin.turnEnd([{ type: "user", text: "go" }])).toBeNull();
    expect(plugin.failureOf([{ type: "user" }, { type: "idle", outcome: "failed", error: { message: "credit balance too low" } }])).toBe("credit balance too low");
    expect(plugin.failureOf([{ type: "idle", outcome: "succeeded" }])).toBeNull();
  });

  it("reports what Claude Code's hooks would, for its own session only", async () => {
    const events = stream<{ type: string; data: Record<string, unknown> }>();
    let prompt: ((event: unknown) => void) | null = null;
    let messages: unknown[] = [];
    const compacted: unknown[] = [];
    const ctx = {
      options: { session, port: 4242, compactAt: 1000, modelRef: { providerID: "anthropic", id: "claude-opus-5-5", variant: "high" } },
      session: {
        get: async () => {
          throw new Error("not made yet");
        },
        switchModel: async () => {},
        hook: async (_name: string, callback: (event: unknown) => void) => {
          prompt = callback;
          return { dispose: async () => {} };
        },
        context: async () => messages,
        compact: async (input: unknown) => void compacted.push(input),
      },
      model: { list: async () => [{ providerID: "anthropic", id: "claude-opus-5-5", limit: { context: 1_000_000 } }] },
      event: { subscribe: ({ signal }: { signal: AbortSignal }) => events.read(signal) },
    };
    const dispose = await plugin.default.setup(ctx);

    // Up: the word that lets kururu type to a Kuru it just started.
    await until(() => posted.length >= 1);
    expect(posted[0]).toEqual({ agent: "a1", session, status: "idle" });

    prompt!({ sessionID: "ses_somebodyelse00000000000000", prompt: { text: "not ours" } });
    prompt!({ sessionID: session, prompt: { text: "  [voice] what is running?  " } });
    await until(() => posted.length >= 2);
    expect(posted[1]).toEqual({ agent: "a1", session, status: "working", message: "[voice] what is running?" });

    events.push({ type: "session.execution.started", data: { sessionID: session } });
    messages = [{ type: "user", text: "what is running?" }, assistant("m1", ""), assistant("m2", "Two agents are working.", { input: 10, output: 5, reasoning: 0, cache: { read: 1490, write: 0 } })];
    events.push({ type: "session.execution.succeeded", data: { sessionID: session } });
    await until(() => posted.length >= 4);
    expect(posted[2]).toEqual({ agent: "a1", session, status: "working" });
    expect(posted[3]).toEqual({ agent: "a1", session, status: "done", reply: "Two agents are working.", context: { used: 1500, window: 1_000_000 } });
    // Past the point kururu compacts at, so OpenCode is asked to.
    await until(() => compacted.length >= 1);
    expect(compacted).toEqual([{ sessionID: session }]);

    // The compaction's own run ends with no new words: idle, never the reply again.
    events.push({ type: "session.execution.started", data: { sessionID: session } });
    events.push({ type: "session.execution.succeeded", data: { sessionID: session } });
    await until(() => posted.length >= 6);
    expect(posted[5]).toMatchObject({ agent: "a1", session, status: "idle" });
    expect(posted.filter((p) => p.reply)).toHaveLength(1);

    // Another session's events are not Kuru's.
    events.push({ type: "permission.asked", data: { sessionID: "ses_somebodyelse00000000000000", action: "shell", resources: ["ls"] } });
    events.push({ type: "permission.asked", data: { sessionID: session, action: "shell", resources: ["rm -rf build"] } });
    await until(() => posted.length >= 7);
    expect(posted[6]).toEqual({ agent: "a1", session, status: "blocked", message: "OpenCode asks to shell: rm -rf build" });

    // A turn that failed without a word says why, aloud and in the drawer.
    events.push({ type: "session.execution.started", data: { sessionID: session } });
    messages = [{ type: "user", text: "and now?" }, { type: "idle", outcome: "failed", error: { message: "credit balance too low" } }];
    events.push({ type: "session.execution.failed", data: { sessionID: session } });
    await until(() => posted.length >= 9);
    expect(posted[8]).toEqual({ agent: "a1", session, status: "done", reply: "OpenCode could not finish that turn: credit balance too low" });

    // Stopped from the drawer: idle, which rings nothing.
    events.push({ type: "session.execution.interrupted", data: { sessionID: session } });
    await until(() => posted.length >= 10);
    expect(posted[9]).toMatchObject({ status: "idle" });

    await dispose?.();
  });

  it("does nothing in a session kururu did not start", async () => {
    const before = posted.length;
    const agent = process.env.KURURU_AGENT_ID;
    delete process.env.KURURU_AGENT_ID;
    try {
      expect(await plugin.default.setup({ options: { session } })).toBeUndefined();
      expect(await plugin.default.setup({ options: {} })).toBeUndefined();
    } finally {
      process.env.KURURU_AGENT_ID = agent;
    }
    expect(posted.length).toBe(before);
  });
});
