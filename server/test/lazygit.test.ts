import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";

import { LAZYGIT_CHECK, lazygitCommand, lazygitRun } from "../../shared/lazygit";
import { remoteShellCommand, remoteShellOf } from "../../shared/machines";

describe("lazygit lines", () => {
  it("keeps the check free of the two characters that change meaning in fish's quotes", () => {
    expect(LAZYGIT_CHECK).not.toContain("'");
    expect(LAZYGIT_CHECK).not.toContain("\\");
  });

  it("names the machine in words no shell needs quoting", () => {
    expect(lazygitRun("my box; rm -rf ~").includes("'my box rm -rf'")).toBe(true);
    expect(lazygitRun("").includes("'this machine'")).toBe(true);
  });

  it("rides a session on a machine like any other typed line", () => {
    const line = remoteShellCommand({ host: "devbox", session: "kururu-api-1", dir: "~/code", run: lazygitRun("devbox") });
    expect(remoteShellOf(line)).toEqual({ host: "devbox", session: "kururu-api-1", agent: null });
  });

  it("sets the tab's title before anything else runs", () => {
    expect(lazygitCommand().startsWith("printf '\\033]2;lazygit\\007'; ")).toBe(true);
  });
});

/**
 * Both lines, run for real under both shells against a fake `lazygit` and a
 * fake login shell, each writing down that it was called. The two that matter
 * are the ends of a tab: a clean quit ends the line, so the tab closes; and a
 * LazyGit that is not there, or would not start, is said and leaves a shell
 * standing under it rather than a tab the server reaps with the reason in it.
 */
describe("lazygit lines, run", () => {
  const dir = mkdtempSync(join(tmpdir(), "kururu-lazygit-"));
  const bin = join(dir, "bin");
  const log = join(dir, "log");
  mkdirSync(bin);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const fake = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "$LOG"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  fake("lazygit", `exit "\${FAIL:-0}"`);
  fake("login-shell", "exit 0");
  const run = (shell: string, line: string, env: Record<string, string> = {}, path = `${bin}:/usr/bin:/bin`) => {
    writeFileSync(log, "");
    const result = spawnSync(shell, ["-c", line], {
      env: { PATH: path, HOME: dir, LOG: log, SHELL: join(bin, "login-shell"), ...env },
      encoding: "utf8",
      timeout: 10_000,
    });
    return { ...result, calls: readFileSync(log, "utf8").split("\n").filter(Boolean) };
  };

  for (const shell of ["/bin/zsh", "/bin/bash"]) {
    it(`ends the tab on a clean quit here, under ${shell}`, () => {
      const result = run(shell, lazygitCommand());
      expect(result.status).toBe(0);
      expect(result.calls).toEqual(["lazygit "]);
    });

    it(`drops to a shell when LazyGit fails here, under ${shell}`, () => {
      const result = run(shell, lazygitCommand(), { FAIL: "2" });
      expect(result.calls).toEqual(["lazygit ", "login-shell -l"]);
    });

    it(`says this Mac has no LazyGit, and leaves a shell, under ${shell}`, () => {
      // The fake login shell is still reachable by its path; only lazygit is gone.
      const result = run(shell, lazygitCommand(), {}, "/usr/bin:/bin");
      expect(result.stdout).toContain("kururu: LazyGit is not installed on this Mac. There is no lazygit on the PATH here.");
      expect(result.calls).toEqual(["login-shell -l"]);
    });

    it(`starts LazyGit on a machine and exits the session's shell after, under ${shell}`, () => {
      const result = run(shell, `${lazygitRun("devbox")}; echo STILL-HERE`);
      expect(result.status).toBe(0);
      expect(result.calls).toEqual(["lazygit "]);
      expect(result.stdout).not.toContain("STILL-HERE");
    });

    it(`says which machine has no LazyGit, and starts nothing, under ${shell}`, () => {
      const result = run(shell, `${lazygitRun("devbox")}; echo STILL-HERE`, {}, "/usr/bin:/bin");
      expect(result.stdout).toContain("kururu: LazyGit is not installed on devbox. There is no lazygit on the PATH here.");
      // The session's shell is left at its prompt, under what it said.
      expect(result.stdout).toContain("STILL-HERE");
      expect(result.calls).toEqual([]);
    });
  }
});
