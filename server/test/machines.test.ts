import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";

import {
  adoptMachineList,
  adoptPin,
  AGENT_CHECK,
  formatBytes,
  LOOP_SCRIPT,
  MACHINE_SEP,
  parseMachineSample,
  remoteAgentRun,
  remoteShellCommand,
  remoteShellOf,
  REMOTE_SCRIPT,
  sessionName,
  validHost,
  validPanel,
  validRemoteDir,
} from "../../shared/machines";
import { agentLabel } from "../../shared/labels";
import type { AgentSnapshot } from "../../shared/model";

/** What the script printed on a real two-core Dokploy box, the second cpu line a second on. */
const SAMPLE = [
  "cpu  22898 1260 23485 3841499 1777 0 2487 2013 0 0",
  ["MemTotal:        8131476 kB", "MemAvailable:    6379064 kB"].join("\n"),
  "/dev/sda1        100476656 13246084  87214188      14% /",
  // 200 jiffies later, 50 of them busy.
  "cpu  22928 1260 23500 3841649 1777 0 2492 2013 0 0",
].join(`\n${MACHINE_SEP}\n`);

describe("parseMachineSample", () => {
  const r = parseMachineSample(SAMPLE, 1);

  it("reads cpu as a rate between the two lines, not as the counters since boot", () => {
    expect(r.cpu).toBeCloseTo(25, 5);
  });

  it("counts memory as total minus available", () => {
    expect(r.mem).toEqual({ used: (8131476 - 6379064) * 1024, total: 8131476 * 1024 });
  });

  it("takes the disk total as used plus available, the way df's percentage does", () => {
    expect(r.disk).toEqual({ used: 13246084 * 1024, total: (13246084 + 87214188) * 1024 });
  });

  it("survives a truncated run", () => {
    const partial = parseMachineSample(SAMPLE.split(MACHINE_SEP).slice(0, 2).join(MACHINE_SEP), 1);
    expect(partial.cpu).toBeNull();
    expect(partial.disk).toBeNull();
    expect(partial.mem).toEqual(r.mem);
  });
});

describe("validHost", () => {
  it("takes an alias, a user@host and an address", () => {
    for (const host of ["my-vps", "root@203.0.113.7", "db.example.com", "deploy_user@box"]) {
      expect(validHost(host)).toBe(true);
    }
  });

  it("refuses anything ssh could read as an option or a shell could read at all", () => {
    for (const host of ["-oProxyCommand=touch x", "a b", "a;b", "", "@host", "user@", "a@b@c", "$(id)", 3]) {
      expect(validHost(host)).toBe(false);
    }
  });
});

describe("validPanel", () => {
  it("keeps http(s) and refuses the rest", () => {
    expect(validPanel("https://dp.example.com")).toBe("https://dp.example.com/");
    expect(validPanel("javascript:alert(1)")).toBeNull();
    expect(validPanel("not a url")).toBeNull();
    expect(validPanel("")).toBeNull();
  });
});

describe("adoptMachineList", () => {
  it("drops entries whose host would not be run, and duplicate ids", () => {
    const list = adoptMachineList([
      { id: "a", name: "one", host: "vps", panel: "ftp://x" },
      { id: "a", name: "dup", host: "vps2" },
      { id: "b", host: "-oFoo" },
      { id: "c", name: "  ", host: "root@vps" },
      null,
    ]);
    expect(list).toEqual([
      { id: "a", name: "one", host: "vps", panel: null },
      { id: "c", name: "root@vps", host: "root@vps", panel: null },
    ]);
    expect(adoptMachineList("nope")).toEqual([]);
  });
});

describe("formatBytes", () => {
  it("prints sizes the way free -h does", () => {
    expect(formatBytes(8131476 * 1024)).toBe("7.8G");
    expect(formatBytes(512)).toBe("512B");
  });
});

describe("validRemoteDir", () => {
  it("takes home, a path under it and an absolute path, and reads blank as home", () => {
    expect(validRemoteDir("")).toBe("~");
    expect(validRemoteDir("  ~ ")).toBe("~");
    expect(validRemoteDir("~/code/my app/")).toBe("~/code/my app");
    expect(validRemoteDir("/srv/www")).toBe("/srv/www");
    expect(validRemoteDir("/")).toBe("/");
  });

  it("refuses anything a shell on the far side would read as more than a path", () => {
    for (const dir of ["code", "~root", "~/a'b", '~/a"b', "/a$(id)", "/a`id`", "/a\\b", "/a;b", "/a\nb", "~/a*", 7, null]) {
      expect(validRemoteDir(dir)).toBeNull();
    }
    expect(validRemoteDir(`/${"a".repeat(400)}`)).toBeNull();
  });
});

describe("adoptPin", () => {
  it("keeps a pin whose halves both hold, and drops the rest", () => {
    expect(adoptPin({ machineId: "m1", dir: "~/x/" })).toEqual({ machineId: "m1", dir: "~/x" });
    expect(adoptPin({ machineId: "m1", dir: "~/x;rm" })).toBeNull();
    expect(adoptPin({ machineId: "", dir: "~" })).toBeNull();
    expect(adoptPin(undefined)).toBeNull();
  });
});

describe("sessionName", () => {
  it("is the workspace, slugged, in the first slot nothing holds", () => {
    expect(sessionName("Fastermenu API", [])).toBe("kururu-fastermenu-api-1");
    expect(sessionName("api", ["kururu-api-1", "kururu-api-3"])).toBe("kururu-api-2");
    expect(sessionName("ünïcode: ☃.x", [])).toBe("kururu-n-code-x-1");
    expect(sessionName("…", [])).toBe("kururu-ws-1");
  });
});

describe("remoteShellCommand", () => {
  it("is read back as the machine and session it was built for", () => {
    expect(remoteShellOf(remoteShellCommand({ host: "omarchy1" }))).toEqual({ host: "omarchy1", session: null, agent: null });
    const line = remoteShellCommand({ host: "me@box", session: "kururu-api-2", dir: "~/code", run: "echo 'hi'" });
    expect(remoteShellOf(line)).toEqual({ host: "me@box", session: "kururu-api-2", agent: null });
  });

  it("carries the agent it was started as, last, where an older reader never looks", () => {
    const run = remoteAgentRun("codex", "codex --model gpt-5.5 'fix it'", "omarchy1");
    const line = remoteShellCommand({ host: "omarchy1", session: "kururu-api-3", dir: "~/code", run, agent: "codex" });
    expect(remoteShellOf(line)).toEqual({ host: "omarchy1", session: "kururu-api-3", agent: "codex" });
    // The loop and the remote line are where they always were, so a server
    // from before agents went to machines still reads host and session.
    expect(line.startsWith(remoteShellCommand({ host: "omarchy1", session: "kururu-api-3", dir: "~/code", run }).replace(/'[^']*'$/, ""))).toBe(true);
  });

  it("will not put an agent on a plain ssh, or name one it does not start", () => {
    expect(() => remoteShellCommand({ host: "box", agent: "claude" })).toThrow();
    expect(() => remoteShellCommand({ host: "box", session: "kururu-a-1", agent: "sh" as never })).toThrow();
  });

  it("types a card's tab as spaces, since a typed tab is a completion", () => {
    expect(remoteAgentRun("claude", "claude 'a\tb'", "box").endsWith("&& claude 'a  b'")).toBe(true);
    // And the machine's name is cut to what needs no quoting anywhere.
    expect(remoteAgentRun("claude", "claude", "my box; rm -rf ~").includes("'my box rm -rf'")).toBe(true);
  });

  it("is not seen in a shell somebody typed ssh into, or in anything else", () => {
    for (const command of ["/bin/zsh", "ssh -t omarchy1", "claude --resume", "", null, undefined]) {
      expect(remoteShellOf(command)).toBeNull();
    }
  });

  it("refuses to build a line from a host, session or folder the grammars refuse", () => {
    expect(() => remoteShellCommand({ host: "-oProxyCommand=x" })).toThrow();
    expect(() => remoteShellCommand({ host: "box", session: "mine" })).toThrow();
    expect(() => remoteShellCommand({ host: "box", session: "kururu-a-1", dir: "~/$(id)" })).toThrow();
  });

  it("keeps both scripts free of the two characters that would change meaning in fish's quotes", () => {
    // The remote script rides in single quotes through whatever the login
    // shell is; the loop must be one quoted word for remoteShellOf to find.
    for (const script of [REMOTE_SCRIPT, LOOP_SCRIPT, AGENT_CHECK]) {
      expect(script).not.toContain("'");
      expect(script).not.toContain("\\");
    }
  });

  it("names the tab after the machine", () => {
    const tab = { kind: "shell", command: remoteShellCommand({ host: "omarchy1", session: "kururu-x-1" }), titleOverride: null, agent: null, exited: false } as unknown as AgentSnapshot;
    expect(agentLabel(tab)).toBe("omarchy1");
  });

  it("names an agent's tab after its CLI, which the process table here cannot see", () => {
    const command = remoteShellCommand({ host: "omarchy1", session: "kururu-x-1", run: remoteAgentRun("claude", "claude", "omarchy1"), agent: "claude" });
    const tab = { kind: "agent", command, titleOverride: null, agent: null, exited: false } as unknown as AgentSnapshot;
    expect(agentLabel(tab)).toBe("claude");
    expect(agentLabel({ ...tab, exited: true })).toBe("claude");
  });
});

/**
 * The line run for real, under both shells a Mac logs in with, against an
 * `ssh` that hands the remote half to a shell here and a `tmux` that writes
 * down what it was asked. What this proves is the quoting: four shells deep,
 * a command with a quote and a `$` in it has to arrive at `send-keys`
 * exactly as it was written.
 */
describe("the line, run", () => {
  const dir = mkdtempSync(join(tmpdir(), "kururu-machines-"));
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  const log = join(dir, "log");
  mkdirSync(bin);
  mkdirSync(join(home, "code"), { recursive: true });
  const fake = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // Everything after `--` and the host is the remote line, which ssh hands to
  // the account's login shell — bash here, as on omarchy1.
  fake("ssh", `while [ "$1" != "--" ]; do shift; done; shift; echo "ssh $1" >> "$LOG"; shift; [ $# -eq 0 ] || exec /bin/bash -c "$1"`);
  // has-session fails — no session yet — unless EXISTS says there is one.
  fake("tmux", `printf '%s|' "$@" >> "$LOG"; echo >> "$LOG"; [ "$1" != has-session ] || [ -n "$EXISTS" ]`);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  /** What every attach is preceded by, scoped to the session: see `REMOTE_SCRIPT`. */
  const PASSTHROUGH = [
    "set-option|-w|-t|=kururu-api-1:|allow-passthrough|on|",
    "set-hook|-t|=kururu-api-1:|after-new-window|set-option -w allow-passthrough on|",
  ];

  for (const shell of ["/bin/zsh", "/bin/bash"]) {
    it(`arrives intact through ${shell}`, () => {
      writeFileSync(log, "");
      const run = `echo "it's $HOME" && ls`;
      const line = remoteShellCommand({ host: "omarchy1", session: "kururu-api-1", dir: "~/code", run });
      const result = spawnSync(shell, ["-c", line], {
        env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, LOG: log },
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.status).toBe(0);
      expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toEqual([
        "ssh omarchy1",
        "has-session|-t|=kururu-api-1|",
        `new-session|-d|-s|kururu-api-1|-c|${home}/code|`,
        `send-keys|-t|=kururu-api-1:|-l|--|${run}|`,
        "send-keys|-t|=kururu-api-1:|Enter|",
        ...PASSTHROUGH,
        "attach-session|-t|=kururu-api-1|",
      ]);
    });
  }

  it("lets a copy through on reattach too, and types nothing", () => {
    writeFileSync(log, "");
    const line = remoteShellCommand({ host: "omarchy1", session: "kururu-api-1", run: "claude" });
    const result = spawnSync("/bin/zsh", ["-c", line], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, LOG: log, EXISTS: "1" },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toEqual([
      "ssh omarchy1",
      "has-session|-t|=kururu-api-1|",
      ...PASSTHROUGH,
      "attach-session|-t|=kururu-api-1|",
    ]);
  });

  it("lets an agent's title out, and only an agent's", () => {
    writeFileSync(log, "");
    const line = remoteShellCommand({ host: "omarchy1", session: "kururu-api-1", run: "claude", agent: "claude" });
    const result = spawnSync("/bin/zsh", ["-c", line], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, LOG: log }, encoding: "utf8" });
    expect(result.status).toBe(0);
    const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
    expect(calls).toContain("set-option|-t|=kururu-api-1:|set-titles|on|");
    expect(calls).toContain("set-option|-t|=kururu-api-1:|set-titles-string|#T|");
    expect(calls.at(-1)).toBe("attach-session|-t|=kururu-api-1|");
  });

  it("starts at home, and says so, when the folder is not there", () => {
    writeFileSync(log, "");
    const line = remoteShellCommand({ host: "omarchy1", session: "kururu-api-1", dir: "~/gone" });
    const result = spawnSync("/bin/zsh", ["-c", line], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, LOG: log }, encoding: "utf8" });
    expect(result.stderr).toContain("there is no folder");
    expect(readFileSync(log, "utf8")).toContain(`new-session|-d|-s|kururu-api-1|-c|${home}|`);
    expect(readFileSync(log, "utf8")).not.toContain("send-keys");
  });
});

/**
 * `LOOP_SCRIPT`'s own retry count, run for real against a fake `ssh` that
 * fails on cue and a fake `date` that makes "connected for twelve seconds"
 * mean whatever a case needs without the test waiting twelve seconds — the
 * fake `ssh` nudges the clock forward before it exits 255 exactly when a case
 * wants that attempt read as "got in, then dropped". `sleep` is faked too, so
 * the one real reattach pause in here does not cost the suite three seconds.
 */
describe("LOOP_SCRIPT, run", () => {
  const dir = mkdtempSync(join(tmpdir(), "kururu-loop-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const calls = join(dir, "calls");
  const clock = join(dir, "clock");
  const ctrl = join(dir, "ctrl");
  const fake = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // Ticks the clock by one on every call, so two calls a script makes back to
  // back read ten seconds apart; `ssh` jumps it further on a "slow" attempt.
  fake("date", `v=$(cat "$CLOCK"); printf '%s\\n' "$v"; echo $((v + 1)) > "$CLOCK"`);
  fake("sleep", `exit 0`);
  // One line of CTRL per call it expects, in order: "fail" exits 255 at once,
  // "slow" nudges the clock past the twelve-second line first, "end" exits 0.
  fake(
    "ssh",
    `n=$(( $(cat "$CALLS") + 1 )); echo "$n" > "$CALLS"
action=$(sed -n "\${n}p" "$CTRL")
case "$action" in
  slow) echo $(( $(cat "$CLOCK") + 20 )) > "$CLOCK"; exit 255;;
  end) exit 0;;
  *) exit 255;;
esac`,
  );
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const run = (actions: string[], input: string) => {
    writeFileSync(calls, "0");
    writeFileSync(clock, "1000");
    writeFileSync(ctrl, actions.join("\n"));
    return spawnSync("/bin/sh", ["-c", LOOP_SCRIPT, "loop", "box", "kururu-x-1", ""], {
      env: { PATH: `${bin}:/usr/bin:/bin`, CALLS: calls, CLOCK: clock, CTRL: ctrl },
      input,
      encoding: "utf8",
      timeout: 10_000,
    });
  };

  it("gives up after three tries that never got in, and Enter starts the count over", () => {
    // Two manual retries get the "did not get in" prompt; the third is the
    // third in a row and gives up instead, then EOF at that prompt ends it.
    const result = run(["fail", "fail", "fail"], "\n\n");
    const lines = result.stdout.split("\n").filter((l) => l.startsWith("kururu:"));
    expect(lines).toEqual([
      "kururu: ssh to box did not get in. Enter tries again; Ctrl-D gives up.",
      "kururu: ssh to box did not get in. Enter tries again; Ctrl-D gives up.",
      "kururu: box has not answered in 3 tries running. Enter tries again; Ctrl-D gives up.",
    ]);
    expect(result.status).toBe(255);
  });

  it("keeps reattaching a connection that got in and then dropped, and resets the count", () => {
    // fail, slow (got in, so the count resets), fail again — never three in a
    // row, so the giving-up line never shows, and the loop reaches "end".
    const result = run(["fail", "slow", "fail", "end"], "\n\n");
    const lines = result.stdout.split("\n").filter((l) => l.startsWith("kururu:"));
    expect(lines).toEqual([
      "kururu: ssh to box did not get in. Enter tries again; Ctrl-D gives up.",
      "kururu: lost the connection to box. Reattaching kururu-x-1 in 3s; Ctrl-C stops.",
      "kururu: ssh to box did not get in. Enter tries again; Ctrl-D gives up.",
    ]);
    expect(result.status).toBe(0);
  });
});

/**
 * The check typed ahead of an agent on a machine, run for real under both
 * shells against a fake `claude` and `codex` that write down how they were
 * called. What matters most is the third case: a CLI too old to have the
 * status subcommand must never be asked it, because it would take
 * `auth status` for a prompt and start a session on it.
 */
describe("the agent check, run", () => {
  const dir = mkdtempSync(join(tmpdir(), "kururu-agentcheck-"));
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  const log = join(dir, "log");
  mkdirSync(bin);
  mkdirSync(home);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const fake = (name: string, body: string, where = bin) => {
    writeFileSync(join(where, name), `#!/bin/sh\necho "${name} $*" >> "$LOG"\n${body}\n`);
    chmodSync(join(where, name), 0o755);
  };
  fake(
    "claude",
    `case "$*" in
  "auth --help") if [ -n "$OLD" ]; then echo "Usage: claude [options] [command] [prompt]"; else echo "Usage: claude auth [options] [command]"; fi;;
  "auth status") if [ -n "$OUT" ]; then printf '{\\n  "loggedIn": false,\\n  "authMethod": "none"\\n}\\n'; exit 1; else printf '{\\n  "loggedIn": true\\n}\\n'; fi;;
  *) echo STARTED;;
esac`,
  );
  fake(
    "codex",
    `case "$*" in
  "login --help") echo "  status  Show login status";;
  "login status") if [ -n "$OUT" ]; then echo "Not logged in"; exit 1; else echo "Logged in using ChatGPT"; fi;;
  *) echo STARTED;;
esac`,
  );
  const run = (shell: string, line: string, env: Record<string, string> = {}, path = `${bin}:/usr/bin:/bin`) => {
    writeFileSync(log, "");
    const result = spawnSync(shell, ["-c", line], { env: { PATH: path, HOME: home, LOG: log, ...env }, encoding: "utf8", timeout: 10_000 });
    return { ...result, calls: readFileSync(log, "utf8").split("\n").filter(Boolean) };
  };

  for (const shell of ["/bin/zsh", "/bin/bash"]) {
    it(`starts a signed-in Claude with its prompt intact, under ${shell}`, () => {
      const result = run(shell, remoteAgentRun("claude", `claude --model claude-opus-5-5 'it'\\''s "$HOME"'`, "omarchy1"));
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("STARTED");
      expect(result.calls).toEqual(["claude auth --help", "claude auth status", `claude --model claude-opus-5-5 it's "$HOME"`]);
    });

    it(`says which machine has no Claude, and starts nothing, under ${shell}`, () => {
      const result = run(shell, remoteAgentRun("claude", "claude", "omarchy1"), {}, "/usr/bin:/bin");
      expect(result.status).toBe(127);
      expect(result.stdout).toContain("kururu: Claude Code is not installed on omarchy1. There is no claude on the PATH here.");
      expect(result.calls).toEqual([]);
    });
  }

  it("says a Claude is signed out, and does not start it", () => {
    const result = run("/bin/zsh", remoteAgentRun("claude", "claude", "omarchy1"), { OUT: "1" });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("kururu: Claude Code is not logged in on omarchy1.");
    expect(result.stdout).toContain("Run claude auth login here");
    expect(result.calls).toEqual(["claude auth --help", "claude auth status"]);
  });

  it("never asks an old Claude for auth status, which it would take for a prompt", () => {
    const result = run("/bin/bash", remoteAgentRun("claude", "claude --model x", "omarchy1"), { OLD: "1", OUT: "1" });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual(["claude auth --help", "claude --model x"]);
  });

  it("finds the alias-only install Claude Code used to make", () => {
    const local = join(home, ".claude", "local");
    mkdirSync(local, { recursive: true });
    fake("claude", `[ "$*" != "auth --help" ] || echo "Usage: claude auth"; [ "$*" != "auth status" ] || echo '{"loggedIn":false}'`, local);
    const result = run("/bin/bash", remoteAgentRun("claude", "claude", "omarchy1"), {}, "/usr/bin:/bin");
    rmSync(join(home, ".claude"), { recursive: true, force: true });
    // Found, asked, and its compact JSON read as signed out.
    expect(result.stdout).toContain("kururu: Claude Code is not logged in on omarchy1.");
    expect(result.calls).toEqual(["claude auth --help", "claude auth status"]);
  });

  it("asks Codex the same way", () => {
    const out = run("/bin/zsh", remoteAgentRun("codex", "codex --model gpt-5.5", "box"), { OUT: "1" });
    expect(out.status).toBe(1);
    expect(out.stdout).toContain("kururu: Codex is not logged in on box.");
    expect(out.stdout).toContain("Run codex login here");
    const ok = run("/bin/zsh", remoteAgentRun("codex", "codex --model gpt-5.5", "box"));
    expect(ok.calls).toEqual(["codex login --help", "codex login status", "codex --model gpt-5.5"]);
  });
});
