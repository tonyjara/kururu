/**
 * Finding tunnels and deciding whether they are up, over made-up process
 * tables and made-up answers: no cloudflared, no network.
 */
import { describe, expect, it } from "bun:test";
import { anyTunnelDown, tunnelsOn, unpairedTunnels } from "../../shared/tunnels";
import type { DevServer, Tunnel } from "../../shared/wire";
import type { ProcRow } from "../src/proctable";
import {
  addressesOfIngress,
  classifyProbe,
  localPort,
  matchTunnel,
  parseConfigIngress,
  parseIngressYaml,
  parseQuickTunnel,
  redactCommand,
  terminalOf,
  type Probe,
  tunnelNotice,
  tunnelsText,
  Tunnels,
  urlOnScreen,
  watchStep,
} from "../src/tunnels";

describe("matchTunnel", () => {
  it("cloudflared's quick and named tunnels, and not its others", () => {
    expect(matchTunnel("cloudflared tunnel --no-autoupdate --url http://localhost:18917")).toEqual({
      target: "http://localhost:18917",
      config: null,
      named: false,
    });
    expect(matchTunnel("cloudflared tunnel --config ~/.cloudflared/pasapy.yml run pasapy")).toMatchObject({ named: true, config: "~/.cloudflared/pasapy.yml" });
    expect(matchTunnel("cloudflared tunnel run --token eyJabc")).toMatchObject({ named: true });
    expect(matchTunnel("/opt/homebrew/bin/cloudflared --no-autoupdate --config /etc/cloudflared/config.yml tunnel run")).toMatchObject({ named: true });
    expect(matchTunnel("cloudflared tunnel login")).toBeNull();
    expect(matchTunnel("cloudflared tunnel list")).toBeNull();
    expect(matchTunnel("cloudflared update")).toBeNull();
  });

  it("cloudflared alone runs the config's tunnel, as a service install starts it", () => {
    expect(matchTunnel("/opt/homebrew/bin/cloudflared")).toEqual({ target: null, config: null, named: true });
    expect(matchTunnel("cloudflared tunnel")).toMatchObject({ named: true });
    expect(matchTunnel("cloudflared --version")).toBeNull();
    expect(matchTunnel("cloudflared tunnel --help")).toBeNull();
  });

  it("ngrok is nobody's tunnel, and nor is a mention", () => {
    expect(matchTunnel("ngrok http 3006")).toBeNull();
    expect(matchTunnel("grep cloudflared")).toBeNull();
    expect(matchTunnel("nvim cloudflared.yml")).toBeNull();
  });

  it("past an environment prefix", () => {
    expect(matchTunnel("TUNNEL_TOKEN=x cloudflared tunnel run")).toMatchObject({ named: true });
  });
});

describe("redactCommand", () => {
  it("takes out tokens however they are passed", () => {
    expect(redactCommand("cloudflared tunnel run --token eyJsecret")).toBe("cloudflared tunnel run --token …");
    expect(redactCommand("cloudflared tunnel run --token=eyJsecret")).toBe("cloudflared tunnel run --token=…");
    expect(redactCommand("TUNNEL_TOKEN=abc cloudflared tunnel run")).toBe("TUNNEL_TOKEN=… cloudflared tunnel run");
    expect(redactCommand("cloudflared tunnel --credentials-file /x.json run")).toBe("cloudflared tunnel --credentials-file … run");
    expect(redactCommand("cloudflared tunnel --config x.yml run dev")).toBe("cloudflared tunnel --config x.yml run dev");
  });
});

describe("localPort", () => {
  it("reads a port on this machine and refuses one elsewhere", () => {
    expect(localPort("3006")).toBe(3006);
    expect(localPort("localhost:3006")).toBe(3006);
    expect(localPort("http://localhost:3006")).toBe(3006);
    expect(localPort("https://127.0.0.1:8443/")).toBe(8443);
    expect(localPort("http://[::1]:5173")).toBe(5173);
    expect(localPort("http://localhost")).toBe(80);
    expect(localPort("http://192.168.0.10:3000")).toBeNull();
    expect(localPort("http_status:404")).toBeNull();
    expect(localPort(null)).toBeNull();
    expect(localPort("99999")).toBeNull();
  });
});

describe("what a tunnel says about itself", () => {
  it("cloudflared's metrics", () => {
    expect(parseQuickTunnel({ hostname: "chess-informed-inside-pose.trycloudflare.com" })).toBe("chess-informed-inside-pose.trycloudflare.com");
    expect(parseQuickTunnel({ hostname: "" })).toBeNull();
    expect(parseConfigIngress({ version: 0, config: { ingress: [{ hostname: "", service: "http://localhost:18917" }] } })).toEqual([
      { hostname: "", service: "http://localhost:18917" },
    ]);
  });

  it("a named tunnel's config file", () => {
    const yaml = [
      "tunnel: 6ff42ae2-765d-4adf-8112-31c55c1551ef",
      "credentials-file: /Users/me/.cloudflared/6ff42ae2.json",
      "",
      "ingress:",
      "  - hostname: api.pasapy.com   # the API",
      "    service: http://localhost:3001",
      "  - hostname: 'app.pasapy.com'",
      "    service: http://localhost:3000",
      "  - service: http_status:404",
      "warp-routing:",
      "  enabled: true",
    ].join("\n");
    expect(parseIngressYaml(yaml)).toEqual([
      { hostname: "api.pasapy.com", service: "http://localhost:3001" },
      { hostname: "app.pasapy.com", service: "http://localhost:3000" },
    ]);
  });

  it("one address per hostname, the one to a port here, and none for a rule that answers by itself", () => {
    const yaml = [
      "tunnel: b55fd3d0",
      "ingress:",
      "  - hostname: dev.example.com",
      "    path: ^/(admin|login)([/.?]|$)",
      "    service: http_status:404",
      "  - hostname: dev.example.com",
      "    service: http://127.0.0.1:3007",
      "  - hostname: hello.example.com",
      "    service: hello_world",
      "  - hostname: db.example.com",
      "    service: tcp://10.0.0.5:5432",
      "  - service: http_status:404",
    ].join("\n");
    expect(addressesOfIngress(parseIngressYaml(yaml))).toEqual([
      { url: "https://dev.example.com", target: "http://127.0.0.1:3007" },
      { url: "https://db.example.com", target: "tcp://10.0.0.5:5432" },
    ]);
  });

  it("what a quick tunnel printed", () => {
    const cf = "INF |  Your quick Tunnel has been created! Visit it at:  |\nINF |  https://chess-informed-inside-pose.trycloudflare.com      |";
    expect(urlOnScreen(cf)).toBe("https://chess-informed-inside-pose.trycloudflare.com");
    expect(urlOnScreen("nothing")).toBeNull();
  });
});

describe("classifyProbe", () => {
  const answer = (status: number, headers: Record<string, string> = {}): Probe => ({ status, headers });
  it("any answer is up", () => {
    expect(classifyProbe(answer(200))).toEqual({ up: true, why: "HTTP 200" });
    expect(classifyProbe(answer(404))).toEqual({ up: true, why: "HTTP 404" });
    expect(classifyProbe(answer(405))).toMatchObject({ up: true });
    expect(classifyProbe(answer(500))).toMatchObject({ up: true });
  });
  it("except Cloudflare's word that it is not", () => {
    expect(classifyProbe(answer(530, { server: "cloudflare" }))).toMatchObject({ up: false });
    expect(classifyProbe(answer(502, { server: "cloudflare" }))).toMatchObject({ up: false });
    expect(classifyProbe({ error: "ENOTFOUND" })).toEqual({ up: false, why: "no answer from the address (ENOTFOUND)" });
  });
  it("a 502 that is not Cloudflare's is the app's own answer", () => {
    expect(classifyProbe(answer(502, { server: "nginx" }))).toMatchObject({ up: true });
  });
});

describe("watchStep", () => {
  it("says down once, after two looks, only of one that was up; and back up after", () => {
    let w = { wasUp: false, downLooks: 0, told: false };
    let r = watchStep(w, "down");
    expect(r.event).toBeNull(); // never up: nothing to say
    w = watchStep(w, "up").watch;
    r = watchStep(w, "down");
    expect(r.event).toBeNull();
    r = watchStep(r.watch, "gone");
    expect(r.event).toBe("down");
    r = watchStep(r.watch, "down");
    expect(r.event).toBeNull();
    r = watchStep(r.watch, "unknown");
    expect(r.event).toBeNull();
    r = watchStep(r.watch, "up");
    expect(r.event).toBe("up");
    r = watchStep(r.watch, "up");
    expect(r.event).toBeNull();
  });
});

describe("terminalOf", () => {
  it("walks up to the terminal's process", () => {
    const rows = new Map<number, ProcRow>([
      [10, { pid: 10, ppid: 1, rss: 0, args: "zsh" }],
      [11, { pid: 11, ppid: 10, rss: 0, args: "sh -c cloudflared tunnel run dev" }],
      [12, { pid: 12, ppid: 11, rss: 0, args: "cloudflared tunnel run dev" }],
      [20, { pid: 20, ppid: 1, rss: 0, args: "cloudflared tunnel run other" }],
    ]);
    const roots = new Map([[10, "a7"]]);
    expect(terminalOf(12, rows, roots)).toBe("a7");
    expect(terminalOf(20, rows, roots)).toBeUndefined();
  });
});

describe("pairing", () => {
  const t = (port: number | null, health: Tunnel["health"] = "up"): Tunnel => ({
    id: `1:${port}`,
    pid: 1,
    url: "https://dev.example.com",
    port,
    target: null,
    command: "cloudflared tunnel run dev",
    health,
    why: "",
    checkedAt: 0,
    publicAt: 0,
    since: 0,
  });
  it("by the port, and the rest left apart", () => {
    const servers = [{ port: 3006 }];
    const tunnels = [t(3006), t(4000), t(null)];
    expect(tunnelsOn(3006, tunnels).map((x) => x.port)).toEqual([3006]);
    expect(unpairedTunnels(tunnels, servers).map((x) => x.port)).toEqual([4000, null]);
    expect(anyTunnelDown(tunnels)).toBe(false);
    expect(anyTunnelDown([t(1, "gone")])).toBe(true);
  });
});

/** A watcher over one process table and made-up answers, its clock in our hands. */
function rig(args: string, answers: { metrics?: unknown; config?: string | null; reachable?: boolean; probe?: Probe; screen?: string | null }) {
  let now = 1_000_000;
  const changed: Tunnel[][] = [];
  const told: Array<{ event: string; tunnel: Tunnel }> = [];
  const read: string[] = [];
  let probes = 0;
  const tunnels = new Tunnels({
    listening: async (pids) => new Map(pids.map((pid) => [pid, [20241]] as const)),
    localJson: async (_port, path) => (path === "/config" ? (answers.metrics ?? null) : null),
    probe: async () => {
      probes++;
      return answers.probe ?? { status: 200, headers: {} };
    },
    reachable: async () => answers.reachable ?? true,
    screen: async () => answers.screen ?? null,
    readText: async (path) => {
      read.push(path);
      return answers.config ?? null;
    },
    changed: (list) => changed.push(list),
    tell: (tunnel, event) => told.push({ tunnel, event }),
    now: () => now,
    home: "/Users/me",
  });
  const procs = (present: boolean) =>
    new Map<number, ProcRow>([
      [10, { pid: 10, ppid: 1, rss: 0, args: "-zsh" }],
      ...(present ? ([[30818, { pid: 30818, ppid: 10, rss: 0, args }]] as const) : []),
    ]);
  const roots = new Map([[10, "a7"]]);
  return {
    tunnels,
    changed,
    told,
    read,
    probes: () => probes,
    see: (present = true) => tunnels.see(procs(present), roots),
    advance: (ms: number) => (now += ms),
    stop: () => tunnels.stop(),
  };
}

describe("Tunnels", () => {
  const named = "cloudflared tunnel --config scripts/dev-tunnel.yml run app-dev";
  const metrics = {
    version: -1,
    config: {
      ingress: [
        { hostname: "app-dev.example.com", path: "^/admin", service: "http_status:404" },
        { hostname: "app-dev.example.com", service: "http://127.0.0.1:3007" },
        { service: "http_status:404" },
      ],
    },
  };

  it("finds a named tunnel through its metrics, once for its hostname, in its terminal, up", async () => {
    const r = rig(named, { metrics });
    r.see();
    await r.tunnels.tick();
    r.stop();
    expect(r.tunnels.list()).toHaveLength(1);
    expect(r.tunnels.list()[0]).toMatchObject({ url: "https://app-dev.example.com", port: 3007, agentId: "a7", health: "up", why: "HTTP 200" });
    expect(r.changed.length).toBe(1);
  });

  it("reads a named tunnel's config file when its metrics do not answer", async () => {
    const config = "tunnel: x\ningress:\n  - hostname: app-dev.example.com\n    service: http://localhost:3007\n  - service: http_status:404\n";
    const r = rig("/opt/homebrew/bin/cloudflared", { config });
    r.see();
    await r.tunnels.tick();
    r.stop();
    expect(r.read[0]).toBe("/Users/me/.cloudflared/config.yml");
    expect(r.tunnels.list()[0]).toMatchObject({ url: "https://app-dev.example.com", port: 3007, health: "up" });
  });

  it("asks the address from outside every minute", async () => {
    const r = rig(named, { metrics });
    r.see();
    for (let i = 0; i < 5; i++) {
      await r.tunnels.tick();
      r.advance(60_000);
    }
    r.stop();
    expect(r.probes()).toBe(5);
  });

  it("is down when Cloudflare says so", async () => {
    const r = rig(named, { metrics, probe: { status: 530, headers: { server: "cloudflare" } } });
    r.see();
    await r.tunnels.tick();
    r.stop();
    expect(r.tunnels.list()[0]).toMatchObject({ health: "down", why: "Cloudflare cannot reach the tunnel (530)", publicAt: 1_000_000 });
  });

  it("is down at once when nothing listens on its port, and Kuru hears on the second look", async () => {
    const answers: { metrics: unknown; reachable: boolean } = { metrics, reachable: true };
    const r = rig(named, answers);
    r.see();
    await r.tunnels.tick();
    answers.reachable = false;
    r.advance(60_000);
    await r.tunnels.tick();
    expect(r.tunnels.list()[0]).toMatchObject({ health: "down", why: "nothing is listening on :3007", publicAt: 1_000_000 });
    expect(r.told).toEqual([]);
    r.advance(60_000);
    await r.tunnels.tick();
    expect(r.told.map((t) => t.event)).toEqual(["down"]);
    answers.reachable = true;
    r.advance(60_000);
    await r.tunnels.tick();
    r.stop();
    expect(r.told.map((t) => t.event)).toEqual(["down", "up"]);
  });

  it("keeps a tunnel whose process ended, as stopped", async () => {
    const r = rig(named, { metrics });
    r.see();
    await r.tunnels.tick();
    r.see(false);
    r.advance(60_000);
    await r.tunnels.tick();
    r.stop();
    expect(r.tunnels.list()).toHaveLength(1);
    expect(r.tunnels.list()[0]).toMatchObject({ health: "gone", why: "cloudflared is no longer running" });
  });

  it("reads a quick tunnel's address off its screen when nothing else says it", async () => {
    const r = rig("cloudflared tunnel --url http://localhost:18917", { screen: "|  https://chess-informed-inside-pose.trycloudflare.com  |" });
    r.see();
    await r.tunnels.tick();
    r.stop();
    expect(r.tunnels.list()[0]).toMatchObject({ url: "https://chess-informed-inside-pose.trycloudflare.com", port: 18917, health: "up" });
  });

  it("says so when no address has been found", async () => {
    const r = rig("cloudflared tunnel --url http://localhost:18917", {});
    r.see();
    await r.tunnels.tick();
    r.stop();
    expect(r.tunnels.list()[0]).toMatchObject({ url: null, port: 18917, health: "unknown" });
  });
});

describe("in words", () => {
  const tunnel: Tunnel = {
    id: "1:x",
    pid: 1,
    url: "https://app-dev.example.com",
    port: 3007,
    target: "http://127.0.0.1:3007",
    command: "cloudflared tunnel run app-dev",
    agentId: "a7",
    health: "down",
    why: "nothing is listening on :3007",
    checkedAt: 1_000_000,
    publicAt: 940_000,
    since: 940_000,
  };
  const servers: DevServer[] = [{ port: 3007, pid: 2, command: "next dev -p 3007", program: "next dev", repo: "/Users/x/app" }];
  it("a status line names the dev server and the terminal", () => {
    const text = tunnelsText([tunnel], servers, () => "the tunnel shell in App", 1_030_000)!;
    expect(text).toStartWith("tunnels (Cloudflare tunnels on this Mac;");
    expect(text).not.toContain("ngrok");
    expect(text).toContain("https://app-dev.example.com · DOWN (nothing is listening on :3007)");
    expect(text).toContain("looked at 30s ago");
    expect(text).toContain("serves the dev server on :3007 (next dev -p 3007 in app)");
    expect(text).toContain("runs in the tunnel shell in App");
    expect(tunnelsText([], servers, () => "", 0)).toBeNull();
  });
  it("a notice", () => {
    expect(tunnelNotice(tunnel, "down", servers, () => "the tunnel shell", 1_000_000)).toStartWith("[kururu] Tunnel down: https://app-dev.example.com — nothing is listening on :3007, since 1 min ago.");
    expect(tunnelNotice({ ...tunnel, health: "up", why: "HTTP 200" }, "up", [], () => "x")).toContain("Tunnel back up: https://app-dev.example.com (HTTP 200)");
  });
});
