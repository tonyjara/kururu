import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";

import {
  adoptMachineList,
  adoptPin,
  formatBytes,
  LOOP_SCRIPT,
  MACHINE_SEP,
  parseMachineSample,
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
    expect(remoteShellOf(remoteShellCommand({ host: "omarchy1" }))).toEqual({ host: "omarchy1", session: null });
    const line = remoteShellCommand({ host: "me@box", session: "kururu-api-2", dir: "~/code", run: "echo 'hi'" });
    expect(remoteShellOf(line)).toEqual({ host: "me@box", session: "kururu-api-2" });
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
    for (const script of [REMOTE_SCRIPT, LOOP_SCRIPT]) {
      expect(script).not.toContain("'");
      expect(script).not.toContain("\\");
    }
  });

  it("names the tab after the machine", () => {
    const tab = { kind: "shell", command: remoteShellCommand({ host: "omarchy1", session: "kururu-x-1" }), titleOverride: null, agent: null, exited: false } as unknown as AgentSnapshot;
    expect(agentLabel(tab)).toBe("omarchy1");
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

  it("starts at home, and says so, when the folder is not there", () => {
    writeFileSync(log, "");
    const line = remoteShellCommand({ host: "omarchy1", session: "kururu-api-1", dir: "~/gone" });
    const result = spawnSync("/bin/zsh", ["-c", line], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, LOG: log }, encoding: "utf8" });
    expect(result.stderr).toContain("there is no folder");
    expect(readFileSync(log, "utf8")).toContain(`new-session|-d|-s|kururu-api-1|-c|${home}|`);
    expect(readFileSync(log, "utf8")).not.toContain("send-keys");
  });
});
