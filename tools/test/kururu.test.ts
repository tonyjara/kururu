/**
 * The decisions `kururu child` makes about a machine, made on text: the API-key
 * scan over the files a pty could inherit one from, the unit it writes, the
 * doctor's table, and the small parsers in between. The addresses and paths
 * are neutral ones, never a real machine's.
 */
import { describe, expect, it } from "bun:test";
import {
  atLeast,
  cgroupUnit,
  doctorExit,
  isHostUnit,
  keysInEnv,
  lanAddresses,
  lingerOn,
  parseArgs,
  parseShowEnvironment,
  heldRows,
  lentClaude,
  pairingRow,
  pairingState,
  parseVersion,
  scanForKeys,
  settingsKeys,
  staleBuild,
  table,
  tailnetAddress,
  unitText,
} from "../kururu/pure.mjs";

describe("scanForKeys", () => {
  it("finds the forms a shell sets one in, by name and line and never by value", () => {
    const rc = [
      "# ANTHROPIC_API_KEY=commented-out",
      "export PATH=$HOME/bin:$PATH",
      "export ANTHROPIC_API_KEY=sk-ant-secret",
      "ANTHROPIC_AUTH_TOKEN='quoted'",
      "declare -x CLAUDE_CODE_USE_BEDROCK=1",
      "setenv ANTHROPIC_API_KEY cshvalue",
    ].join("\n");
    const found = scanForKeys(rc);
    expect(found).toEqual([
      { name: "ANTHROPIC_API_KEY", line: 3 },
      { name: "ANTHROPIC_AUTH_TOKEN", line: 4 },
      { name: "CLAUDE_CODE_USE_BEDROCK", line: 5 },
      { name: "ANTHROPIC_API_KEY", line: 6 },
    ]);
    expect(JSON.stringify(found)).not.toContain("secret");
  });

  it("passes over clearing one, unsetting one and reading one", () => {
    const rc = ['export ANTHROPIC_API_KEY=""', "export ANTHROPIC_API_KEY=", "unset ANTHROPIC_API_KEY", 'echo "$ANTHROPIC_API_KEY"', "MY_ANTHROPIC_API_KEY=other"].join("\n");
    expect(scanForKeys(rc)).toEqual([]);
  });

  it("reads a unit's Environment= lines, several to a line and quoted", () => {
    const unit = ["[Service]", 'Environment="PATH=/usr/bin" ANTHROPIC_API_KEY=x', 'Environment="ANTHROPIC_AUTH_TOKEN=a b"', "Environment=KURURU_BIND=tailscale"].join("\n");
    expect(scanForKeys(unit).map((hit) => hit.name)).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);
  });

  it("reads fish's set -gx", () => {
    expect(scanForKeys("set -gx ANTHROPIC_API_KEY sk-ant-x\nset -e ANTHROPIC_API_KEY")).toEqual([{ name: "ANTHROPIC_API_KEY", line: 1 }]);
  });
});

describe("keys in an environment and in Claude's settings", () => {
  it("names the keys set in an environment, empty ones not", () => {
    expect(keysInEnv({ ANTHROPIC_API_KEY: "x", ANTHROPIC_AUTH_TOKEN: "", HOME: "/home/u" })).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("parses the user manager's environment", () => {
    expect(parseShowEnvironment("HOME=/home/u\nANTHROPIC_API_KEY=k=v\n")).toEqual({ HOME: "/home/u", ANTHROPIC_API_KEY: "k=v" });
  });

  it("finds an env block's key and an apiKeyHelper, by name", () => {
    expect(settingsKeys({ env: { ANTHROPIC_API_KEY: "x", DISABLE_TELEMETRY: "1" }, apiKeyHelper: "~/bin/key.sh" })).toEqual(["env.ANTHROPIC_API_KEY", "apiKeyHelper"]);
    expect(settingsKeys({ permissions: {} })).toEqual([]);
    expect(settingsKeys(null)).toEqual([]);
  });
});

describe("versions", () => {
  it("parses node's, bun's and claude's", () => {
    expect(parseVersion("v26.12.0")).toEqual([26, 12, 0]);
    expect(parseVersion("1.4.3")).toEqual([1, 4, 3]);
    expect(parseVersion("2.1.302 (Claude Code)")).toEqual([2, 1, 302]);
    expect(parseVersion("nothing")).toBeNull();
  });

  it("compares against a floor", () => {
    expect(atLeast([24, 0, 0], [24, 0, 0])).toBe(true);
    expect(atLeast([26, 1, 0], [24, 0, 0])).toBe(true);
    expect(atLeast([22, 13, 0], [24, 0, 0])).toBe(false);
    expect(atLeast(null, [24, 0, 0])).toBe(false);
  });
});

describe("linger", () => {
  it("reads both spellings loginctl gives", () => {
    expect(lingerOn("Linger=yes\n")).toBe(true);
    expect(lingerOn("yes")).toBe(true);
    expect(lingerOn("Linger=no")).toBe(false);
  });
});

describe("addresses", () => {
  const interfaces = {
    lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    enp5s0: [
      { address: "192.168.1.20", family: "IPv4", internal: false },
      { address: "fe80::1", family: "IPv6", internal: false },
    ],
    docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false }],
    tailscale0: [{ address: "100.101.102.103", family: "IPv4", internal: false }],
  };

  it("takes the tailnet address off tailscale0, never by asking tailscale", () => {
    expect(tailnetAddress(interfaces)).toBe("100.101.102.103");
    expect(tailnetAddress({ utun4: [{ address: "100.64.0.9", family: "IPv4", internal: false }] })).toBe("100.64.0.9");
    expect(tailnetAddress({ lo: interfaces.lo })).toBeNull();
  });

  it("lists every private address that is not the tailnet's, as the ones a child must refuse", () => {
    expect(lanAddresses(interfaces)).toEqual(["192.168.1.20"]);
  });
});

describe("unitText", () => {
  const unit = unitText({
    description: "kururu, a child",
    node: "/home/u/.local/share/mise/installs/node/26.12.0/bin/node",
    checkout: "/home/u/kururu",
    env: { KURURU_BIND: "tailscale", KURURU_LOOPBACK_TOKEN: "1", PATH: "/usr/bin:/bin" },
  });

  it("runs the checkout's runner on node by its full path, without building", () => {
    expect(unit).toContain("ExecStart=/home/u/.local/share/mise/installs/node/26.12.0/bin/node /home/u/kururu/server/run.mjs --no-build\n");
  });

  it("binds the tailnet, asks loopback for the token, and leaves the host alone when it stops", () => {
    expect(unit).toContain("Environment=KURURU_BIND=tailscale\n");
    expect(unit).toContain("Environment=KURURU_LOOPBACK_TOKEN=1\n");
    expect(unit).toContain("KillMode=process\n");
    expect(unit).toContain("Restart=on-failure\n");
    expect(unit).toContain("WantedBy=default.target\n");
  });

  it("waits for the tailnet before starting, and starts anyway when it never comes", () => {
    expect(unit).toContain("ExecStartPre=-/home/u/.local/share/mise/installs/node/26.12.0/bin/node /home/u/kururu/tools/kururu.mjs child wait-tailnet\n");
  });

  it("quotes what has spaces and doubles a specifier", () => {
    const odd = unitText({ description: "d", node: "/opt/my node/node", checkout: "/srv/k", env: { NOTE: "50% done" } });
    expect(odd).toContain('ExecStart="/opt/my node/node" /srv/k/server/run.mjs --no-build');
    expect(odd).toContain('Environment="NOTE=50%% done"');
  });

  it("is the same text for the same answers, which is what makes a second run change nothing", () => {
    const again = unitText({
      description: "kururu, a child",
      node: "/home/u/.local/share/mise/installs/node/26.12.0/bin/node",
      checkout: "/home/u/kururu",
      env: { KURURU_BIND: "tailscale", KURURU_LOOPBACK_TOKEN: "1", PATH: "/usr/bin:/bin" },
    });
    expect(again).toBe(unit);
  });
});

describe("staleBuild", () => {
  it("is stale when a source is newer than the build, or there is no build", () => {
    expect(staleBuild(100, [["a.ts", 50], ["b.ts", 150]])).toEqual({ stale: true, newest: "b.ts" });
    expect(staleBuild(200, [["a.ts", 50], ["b.ts", 150]])).toEqual({ stale: false, newest: "b.ts" });
    expect(staleBuild(null, [])).toEqual({ stale: true, newest: null });
  });
});

describe("the host's unit", () => {
  it("reads it off a cgroup v2 line, and knows a host's from the server's", () => {
    const own = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/kururu-ptyhost-a1b2c3-2.service\n";
    const shared = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/kururu.service\n";
    expect(cgroupUnit(own)).toBe("kururu-ptyhost-a1b2c3-2.service");
    expect(isHostUnit(cgroupUnit(own))).toBe(true);
    expect(isHostUnit(cgroupUnit(shared))).toBe(false);
    expect(isHostUnit(null)).toBe(false);
  });
});

describe("the doctor's table", () => {
  const rows = [
    { title: "node", state: "ok", detail: "v26.12.0" },
    { title: "linger", state: "fail", detail: "off", fix: "loginctl enable-linger u" },
    { title: "codex", state: "skip", detail: "not wanted" },
  ];

  it("marks each row and puts the fix under a failure", () => {
    expect(table(rows)).toEqual(["  ✓ node    v26.12.0", "  ✗ linger  off", "            → loginctl enable-linger u", "  – codex   not wanted"]);
  });

  it("exits 1 on a failure and 0 on a skip", () => {
    expect(doctorExit(rows)).toBe(1);
    expect(doctorExit([rows[0]!, rows[2]!])).toBe(0);
  });
});

describe("parseArgs", () => {
  it("takes --a=b, --a b for the valued ones, bare flags, and words", () => {
    expect(parseArgs(["child", "setup", "--port", "7818", "--dry-run", "--codex=no", "--yes"], ["port"])).toEqual({
      flags: { port: "7818", "dry-run": true, codex: "no", yes: true },
      words: ["child", "setup"],
    });
  });

  it("never takes the next flag as a value", () => {
    expect(parseArgs(["--port", "--yes"], ["port"]).flags).toEqual({ port: true, yes: true });
  });
});

describe("pairing", () => {
  const health = (nodes: unknown) => ({ ok: true, nodes });
  const child = (state: string, since: number | null = null) =>
    health({ role: "child", name: "box", leader: null, nodes: [{ name: "mac", state, parent: true, since }, { name: "other", state: "up", parent: false, since: 1 }] });

  it("reads where the node stands off the health answer", () => {
    expect(pairingState({ ok: true })).toEqual({ state: "unknown" });
    expect(pairingState(health({ role: "alone", nodes: [] }))).toEqual({ state: "alone" });
    expect(pairingState(health({ role: "parent", nodes: [{}, {}] }))).toEqual({ state: "parent", count: 2 });
    expect(pairingState(child("up"))).toEqual({ state: "linked", parent: "mac" });
    expect(pairingState(child("away", 5))).toEqual({ state: "waiting", parent: "mac", link: "away", since: 5 });
  });

  it("is a – when not paired or the Mac is away, a ✓ when linked, and a ✗ only when the parent was never reached", () => {
    expect(pairingRow(health({ role: "alone", nodes: [] })).state).toBe("skip");
    expect(pairingRow(null).state).toBe("skip");
    expect(pairingRow({ ok: true }).detail).toContain("kururu child update");
    expect(pairingRow(child("up"))).toEqual({ title: "pairing", state: "ok", detail: "paired with mac, linked" });
    const away = pairingRow(child("away", 1_000), 1_000 + 12 * 60_000);
    expect(away.state).toBe("skip");
    expect(away.detail).toContain("paired with mac, away for 12 min");
    const never = pairingRow(child("connecting"));
    expect(never.state).toBe("fail");
    expect(never.detail).toBe("paired with mac, connecting");
    expect(never.fix).toContain("Mac awake");
  });
});

describe("heldRows", () => {
  const held = {
    from: "n000000000001",
    held: {
      openrouter: { digest: "d", seq: 1, hint: "sk-or-v1-…abcd", since: 1, updated: 1 },
      "claude-token:machine": { digest: "e", seq: 2, hint: "someone@example.com …wxyz", since: 1, updated: 1 },
    },
    seen: {},
  };

  it("lists what is held by kind and hint, a – when nothing is or the box stands alone", () => {
    expect(heldRows(null, { paired: false, parent: null, name: null, claudeLent: false })).toEqual([{ title: "secrets", state: "skip", detail: "not paired, so nothing is lent" }]);
    expect(heldRows(null, { paired: false, parent: null, name: null, claudeLent: true, isParent: true })[0]?.detail).toContain("the parent");
    const none = heldRows({ held: {} }, { paired: true, parent: "mac", name: "omarchy", claudeLent: false });
    expect(none[0]?.state).toBe("skip");
    expect(none[0]?.detail).toContain("mac's Settings → Nodes → omarchy → Secrets");
    const some = heldRows(held, { paired: true, parent: "mac", name: "omarchy", claudeLent: true });
    expect(some).toEqual([{ title: "secrets", state: "ok", detail: "held from mac: openrouter sk-or-v1-…abcd, claude-token:machine someone@example.com …wxyz" }]);
  });

  it("names a project's env files, ssh hosts and GitHub login by hint, never by hash", () => {
    const project = {
      held: {
        "env:0123456789ab": { digest: "d", seq: 1, hint: "storefront/.env.local · 14 variables", since: 1, updated: 1 },
        "ssh:vps": { digest: "d", seq: 1, hint: "vps · key vps_key (ed25519)", since: 1, updated: 1 },
        "gh:someone": { digest: "d", seq: 1, hint: "someone · …wxyz", since: 1, updated: 1 },
      },
    };
    expect(heldRows(project, { paired: true, parent: "mac", name: "omarchy", claudeLent: false })[0]?.detail).toBe(
      "held from mac: env storefront/.env.local · 14 variables, ssh vps · key vps_key (ed25519), github someone · …wxyz",
    );
  });

  it("is a ✗ only when Claude was to be lent and has not been", () => {
    const rows = heldRows({ held: { openrouter: held.held.openrouter } }, { paired: true, parent: "mac", name: "omarchy", claudeLent: true });
    expect(rows[1]?.state).toBe("fail");
    expect(rows[1]?.fix).toContain("Lend this login to a node");
    expect(lentClaude(held)).toEqual({ kind: "claude-token:machine", hint: "someone@example.com …wxyz" });
    expect(lentClaude({ held: { openrouter: held.held.openrouter } })).toBeNull();
    expect(lentClaude(null)).toBeNull();
  });
});
