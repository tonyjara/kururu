import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfigFile } from "../src/config";
import { REPEAT_MS, sweep } from "../src/sweep";

function recorder() {
  const lines: string[] = [];
  let clock = 1_000;
  return {
    lines,
    advance: (ms: number) => void (clock += ms),
    options: { log: (line: string) => void lines.push(line), now: () => clock },
  };
}

describe("sweep", () => {
  test("a rejection is caught and said, and the returned promise settles", async () => {
    const r = recorder();
    const run = sweep("memory", () => Promise.reject(new Error("ps went away")), r.options);
    await expect(run()).resolves.toBeUndefined();
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toContain("the memory sweep failed");
    expect(r.lines[0]).toContain("ps went away");
  });

  test("a synchronous throw is caught too", async () => {
    const r = recorder();
    const run = sweep("made links", () => {
      throw new Error("bad row");
    }, r.options);
    expect(() => run()).not.toThrow();
    await run();
    expect(r.lines.filter((line) => line.includes("bad row"))).toHaveLength(1);
  });

  test("a value that is not an Error is said as text", async () => {
    const r = recorder();
    await sweep("x", () => Promise.reject("plain"), r.options)();
    expect(r.lines[0]).toEndWith(": plain");
  });

  test("the same failure is said once, then again after REPEAT_MS with a count", async () => {
    const r = recorder();
    const run = sweep("branches", () => Promise.reject(new Error("git timed out")), r.options);
    for (let i = 0; i < 5; i++) {
      await run();
      r.advance(2_000);
    }
    expect(r.lines).toHaveLength(1);
    r.advance(REPEAT_MS);
    await run();
    expect(r.lines).toHaveLength(2);
    expect(r.lines[1]).toContain("again; 4 more times");
  });

  test("a different failure is said at once", async () => {
    const r = recorder();
    let message = "one";
    const run = sweep("machines", () => Promise.reject(new Error(message)), r.options);
    await run();
    message = "two";
    await run();
    expect(r.lines).toHaveLength(2);
    expect(r.lines[1]).toContain("two");
    expect(r.lines[1]).not.toContain("again");
  });

  test("recovery is said once, and silence is kept while it works", async () => {
    const r = recorder();
    let fail = true;
    const run = sweep("usage bar", async () => {
      if (fail) throw new Error("offline");
    }, r.options);
    await run();
    fail = false;
    await run();
    await run();
    expect(r.lines).toHaveLength(2);
    expect(r.lines[1]).toBe("kururu: the usage bar sweep works again");
  });

  test("a sweep that never fails says nothing", async () => {
    const r = recorder();
    const run = sweep("editors", () => undefined, r.options);
    await run();
    await sweep("editors", async () => 3, r.options)();
    expect(r.lines).toEqual([]);
  });
});

describe("writeConfigFile", () => {
  let dir: string;
  let before: string | undefined;
  let errors: ReturnType<typeof spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kururu-config-"));
    before = process.env.KURURU_CONFIG_DIR;
    errors = spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (before === undefined) delete process.env.KURURU_CONFIG_DIR;
    else process.env.KURURU_CONFIG_DIR = before;
    errors.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  test("says it wrote, and wrote", () => {
    process.env.KURURU_CONFIG_DIR = join(dir, "config");
    const wrote = writeConfigFile("x.json", { a: 1 });
    expect(wrote).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "config", "x.json"), "utf8"))).toEqual({ a: 1 });
    expect(errors).not.toHaveBeenCalled();
  });

  test("a failed save returns false and is logged without the value", () => {
    // A file where the directory should be: mkdir fails, as on a disk that will not take it.
    writeFileSync(join(dir, "config"), "");
    process.env.KURURU_CONFIG_DIR = join(dir, "config");
    const wrote = writeConfigFile("secret.json", { token: "sk-very-secret" }, 0o600);
    expect(wrote).toBe(false);
    expect(errors).toHaveBeenCalledTimes(1);
    const line = String(errors.mock.calls[0]?.[0]);
    expect(line).toContain("could not save secret.json");
    expect(line).not.toContain("sk-very-secret");
  });
});
