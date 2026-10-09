/**
 * The record's pure half: reading lines back, and reading how a pty host ended
 * out of what it printed. The host log samples are the lines `ptyhostd.ts`
 * actually prints, plus what Node puts on stderr when a process dies of an
 * uncaught exception and what libc++ prints when a native library aborts.
 */
import { describe, expect, test } from "bun:test";
import { parseLifecycle } from "../../shared/lifecycle";
import { hostEnding } from "../src/lifecycle";

const line = (fields: Record<string, unknown>) =>
  JSON.stringify({ at: "2026-10-08T14:21:35.000Z", by: "server", pid: 60032, what: "start", why: "listening", ...fields });

describe("parseLifecycle", () => {
  test("reads one event per line, in order", () => {
    const text = [
      line({ by: "runner", pid: 7348, what: "restart", why: "server/src/harness.ts was saved", file: "server/src/harness.ts", server: 7352 }),
      line({ what: "start", why: "listening on :7717 (v0.2.0), because server/src/harness.ts was saved", version: "0.2.0" }),
    ].join("\n");
    const events = parseLifecycle(text);
    expect(events.map((e) => e.what)).toEqual(["restart", "start"]);
    expect(events[0]).toMatchObject({ by: "runner", file: "server/src/harness.ts", server: 7352 });
    expect(events[1]!.version).toBe("0.2.0");
  });

  test("keeps the whole lines around a torn or foreign one", () => {
    const text = [line({ why: "first" }), '{"at":"2026-10-08T14:2', "not json at all", "", line({ why: "last" })].join("\n");
    expect(parseLifecycle(text).map((e) => e.why)).toEqual(["first", "last"]);
  });

  test("drops a line whose shape is wrong rather than guessing at it", () => {
    const text = [
      line({ by: "somebody" }),
      line({ what: "exploded" }),
      line({ at: "yesterday" }),
      line({ pid: "60032" }),
      line({ pid: Number.NaN }),
      line({ why: 7 }),
      line({ why: "kept" }),
    ].join("\n");
    expect(parseLifecycle(text).map((e) => e.why)).toEqual(["kept"]);
  });

  test("keeps a null code and signal, which is how an exit by signal and an exit by code are told apart", () => {
    const [event] = parseLifecycle(line({ by: "runner", what: "crash", why: "the server was killed by SIGABRT", code: null, signal: "SIGABRT" }));
    expect(event).toMatchObject({ code: null, signal: "SIGABRT" });
  });

  test("ignores optional fields of the wrong type instead of dropping the line", () => {
    const [event] = parseLifecycle(line({ server: "7352", file: 3, code: "1", stack: ["x"] }));
    expect(event).toBeDefined();
    expect(event!.server).toBeUndefined();
    expect(event!.file).toBeUndefined();
    expect(event!.code).toBeUndefined();
    expect(event!.stack).toBeUndefined();
  });
});

const LISTENING = "kururu pty host  /Users/someone/.local/state/kururu/ptyhost.sock";

describe("hostEnding", () => {
  test("knows nothing from a log with no host in it", () => {
    expect(hostEnding("")).toBeNull();
    expect(hostEnding("some unrelated line\n")).toBeNull();
  });

  test("reads a signal stop, from the last host rather than an earlier one", () => {
    const log = [
      LISTENING,
      "kururu pty host: SIGTERM — stopping 0 agent(s)",
      LISTENING,
      "kururu pty host: SIGHUP — stopping 8 agent(s)",
      "",
    ].join("\n");
    expect(hostEnding(log)).toEqual({ how: "was stopped by SIGHUP with 8 agent(s) running" });
  });

  test("reads an uncaught exception off Node's stderr, with the stack", () => {
    const log = [
      LISTENING,
      "file:///Users/someone/kururu/desktop/dist/ptyhostd.mjs:812",
      "        throw new TypeError(\"cannot read the grid\");",
      "        ^",
      "",
      "TypeError: cannot read the grid",
      "    at resize (file:///Users/someone/kururu/desktop/dist/ptyhostd.mjs:812:15)",
      "",
      "Node.js v24.18.0",
    ].join("\n");
    const ending = hostEnding(log)!;
    expect(ending.how).toBe("crashed: TypeError: cannot read the grid");
    expect(ending.error).toBe("TypeError: cannot read the grid");
    expect(ending.stack).toContain("at resize");
  });

  test("reads a native abort", () => {
    const log = `${LISTENING}\nlibc++abi: terminating due to uncaught exception of type std::__1::system_error: mutex lock failed: Invalid argument\n`;
    expect(hostEnding(log)!.how).toStartWith("crashed: libc++abi: terminating");
  });

  test("says a host that printed nothing after starting was killed without being asked", () => {
    expect(hostEnding(`${LISTENING}\n`)!.how).toContain("without a word");
  });

  test("is not fooled by the duplicate a racing server spawns", () => {
    const log = [LISTENING, "kururu pty host: one is already listening at /x/ptyhost.sock", ""].join("\n");
    expect(hostEnding(log)).toEqual({ how: "ended without a word, which is SIGKILL or the machine going down" });
  });

  test("does not call a warning a crash", () => {
    const log = `${LISTENING}\n(node:16973) Warning: something deprecated\n`;
    const ending = hostEnding(log)!;
    expect(ending.how).toContain("without a word");
    expect(ending.error).toBeUndefined();
    expect(ending.stack).toContain("Warning");
  });
});
