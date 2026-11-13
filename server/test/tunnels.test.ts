/**
 * Finding tunnels and deciding whether they are up, over made-up process
 * tables and made-up answers: no ngrok, no cloudflared, no network.
 */
import { describe, expect, it } from "bun:test";
import { anyTunnelDown, tunnelsOn, unpairedTunnels } from "../../shared/tunnels";
import type { DevServer, Tunnel } from "../../shared/wire";
import type { ProcRow } from "../src/proctable";
import {
  classifyProbe,
  localPort,
  matchTunnel,
  NGROK_PUBLIC_MS,
  parseConfigIngress,
  parseIngressYaml,
  parseNgrokApi,
  parseQuickTunnel,
  publicDue,
  redactCommand,
  terminalOf,
  type Probe,
  tunnelNotice,
  tunnelsText,
  Tunnels,
  urlsOnScreen,
  watchStep,
} from "../src/tunnels";

describe("matchTunnel", () => {
  it("ngrok's tunnel commands, and not its others", () => {
    expect(matchTunnel("ngrok http 3006 --host-header=rewrite")).toEqual({ kind: "ngrok", target: "3006", url: null, config: null, named: false });
    expect(matchTunnel("/opt/homebrew/bin/ngrok http localhost:8080 --url=pasapy.ngrok.app")).toMatchObject({ target: "localhost:8080", url: "https://pasapy.ngrok.app" });
    expect(matchTunnel("ngrok http --domain x.ngrok-free.app 3000")).toMatchObject({ target: "3000", url: "https://x.ngrok-free.app" });
    expect(matchTunnel("ngrok start --all")).toMatchObject({ kind: "ngrok", target: null });
    expect(matchTunnel("ngrok config add-authtoken abc")).toBeNull();
    expect(matchTunnel("ngrok version")).toBeNull();
    expect(matchTunnel("grep ngrok")).toBeNull();
    expect(matchTunnel("nvim ngrok.yml")).toBeNull();
  });

  it("cloudflared's quick and named tunnels, and not its others", () => {
    expect(matchTunnel("cloudflared tunnel --no-autoupdate --url http://localhost:18917")).toEqual({
      kind: "cloudflared",
      target: "http://localhost:18917",
      url: null,
      config: null,
      named: false,
    });
    expect(matchTunnel("cloudflared tunnel --config ~/.cloudflared/pasapy.yml run pasapy")).toMatchObject({ named: true, config: "~/.cloudflared/pasapy.yml" });
    expect(matchTunnel("cloudflared tunnel run --token eyJabc")).toMatchObject({ named: true });
    expect(matchTunnel("cloudflared tunnel login")).toBeNull();
    expect(matchTunnel("cloudflared tunnel list")).toBeNull();
    expect(matchTunnel("cloudflared update")).toBeNull();
  });

  it("past an environment prefix", () => {
    expect(matchTunnel("NGROK_AUTHTOKEN=x ngrok http 3006")).toMatchObject({ kind: "ngrok", target: "3006" });
  });
});

describe("redactCommand", () => {
  it("takes out tokens however they are passed", () => {
    expect(redactCommand("cloudflared tunnel run --token eyJsecret")).toBe("cloudflared tunnel run --token …");
    expect(redactCommand("ngrok http 3006 --authtoken=abc")).toBe("ngrok http 3006 --authtoken=…");
    expect(redactCommand("NGROK_AUTHTOKEN=abc ngrok http 3006")).toBe("NGROK_AUTHTOKEN=… ngrok http 3006");
    expect(redactCommand("ngrok http 3006 --basic-auth user:pass")).toBe("ngrok http 3006 --basic-auth …");
    expect(redactCommand("ngrok http 3006 --host-header=rewrite")).toBe("ngrok http 3006 --host-header=rewrite");
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
  it("ngrok's API, as ngrok 3 answers it", () => {
    const body = {
      tunnels: [
        {
          name: "command_line",
          public_url: "https://moodier-jaliyah-nonexpeditiously.ngrok-free.dev",
          proto: "https",
          config: { addr: "http://localhost:3006", inspect: true },
        },
      ],
    };
    expect(parseNgrokApi(body)).toEqual([{ url: "https://moodier-jaliyah-nonexpeditiously.ngrok-free.dev", target: "http://localhost:3006" }]);
    expect(parseNgrokApi({ nope: 1 })).toBeNull();
    expect(parseNgrokApi(null)).toBeNull();
  });

  it("ngrok 2's http twin of an https tunnel is one tunnel", () => {
    const body = {
      tunnels: [
        { public_url: "https://a.ngrok.io", config: { addr: "localhost:3000" } },
        { public_url: "http://a.ngrok.io", config: { addr: "localhost:3000" } },
      ],
    };
    expect(parseNgrokApi(body)).toEqual([{ url: "https://a.ngrok.io", target: "localhost:3000" }]);
  });

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

  it("what it printed", () => {
    const cf = "INF |  Your quick Tunnel has been created! Visit it at:  |\nINF |  https://chess-informed-inside-pose.trycloudflare.com      |";
    expect(urlsOnScreen(cf, "cloudflared")).toEqual([{ url: "https://chess-informed-inside-pose.trycloudflare.com", target: null }]);
    const ng = "Session Status                online\nForwarding                    https://moodier.ngrok-free.dev -> http://localhost:3006\n";
    expect(urlsOnScreen(ng, "ngrok")).toEqual([{ url: "https://moodier.ngrok-free.dev", target: "http://localhost:3006" }]);
    expect(urlsOnScreen("nothing", "ngrok")).toEqual([]);
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
  it("except the tunnel's own error", () => {
    expect(classifyProbe(answer(404, { "ngrok-error-code": "ERR_NGROK_3200" }))).toEqual({ up: false, why: "ngrok says the endpoint is offline" });
    expect(classifyProbe(answer(502, { "ngrok-error-code": "ERR_NGROK_8012" }))).toMatchObject({ up: false });
    expect(classifyProbe(answer(530, { server: "cloudflare" }))).toMatchObject({ up: false });
    expect(classifyProbe(answer(502, { server: "cloudflare" }))).toMatchObject({ up: false });
    expect(classifyProbe({ error: "ENOTFOUND" })).toEqual({ up: false, why: "no answer from the address (ENOTFOUND)" });
  });
  it("a 502 that is not Cloudflare's is the app's own answer", () => {
    expect(classifyProbe(answer(502, { server: "nginx" }))).toMatchObject({ up: true });
  });
});

describe("publicDue", () => {
  it("spares ngrok's free plan and not Cloudflare", () => {
    const now = 10_000_000;
    expect(publicDue("ngrok", null, now)).toBe(true);
    expect(publicDue("ngrok", { at: now - 60_000, up: true }, now)).toBe(false);
    expect(publicDue("ngrok", { at: now - NGROK_PUBLIC_MS, up: true }, now)).toBe(true);
    expect(publicDue("ngrok", { at: now - 6 * 60_000, up: false }, now)).toBe(true);
    expect(publicDue("cloudflared", { at: now - 60_000, up: true }, now)).toBe(true);
    expect(publicDue("cloudflared", { at: now - 20_000, up: true }, now)).toBe(false);
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
      [11, { pid: 11, ppid: 10, rss: 0, args: "sh -c ngrok http 3006" }],
      [12, { pid: 12, ppid: 11, rss: 0, args: "ngrok http 3006" }],
      [20, { pid: 20, ppid: 1, rss: 0, args: "ngrok http 4000" }],
    ]);
    const roots = new Map([[10, "a7"]]);
    expect(terminalOf(12, rows, roots)).toBe("a7");
    expect(terminalOf(20, rows, roots)).toBeUndefined();
  });
});

describe("pairing", () => {
  const t = (port: number | null, health: Tunnel["health"] = "up"): Tunnel => ({
    id: `ngrok:1:${port}`,
    kind: "ngrok",
    pid: 1,
    url: "https://x.ngrok-free.dev",
    port,
    target: null,
    command: "ngrok",
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
function rig(args: string, answers: { api?: unknown; reachable?: boolean; probe?: Probe; screen?: string | null; kept?: Record<string, unknown> }) {
  let now = 1_000_000;
  const changed: Tunnel[][] = [];
  const told: Array<{ event: string; tunnel: Tunnel }> = [];
  let probes = 0;
  let saved: Record<string, unknown> = {};
  const tunnels = new Tunnels({
    listening: async (pids) => new Map(pids.map((pid) => [pid, [4040]] as const)),
    localJson: async (_port, path) => (path === "/api/tunnels" ? answers.api ?? null : null),
    probe: async () => {
      probes++;
      return answers.probe ?? { status: 200, headers: {} };
    },
    reachable: async () => answers.reachable ?? true,
    screen: async () => answers.screen ?? null,
    readText: async () => null,
    changed: (list) => changed.push(list),
    tell: (tunnel, event) => told.push({ tunnel, event }),
    asked: { load: async () => answers.kept ?? {}, save: (looks) => (saved = looks) },
    now: () => now,
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
    probes: () => probes,
    saved: () => saved,
    see: (present = true) => tunnels.see(procs(present), roots),
    advance: (ms: number) => (now += ms),
    stop: () => tunnels.stop(),
  };
}

describe("Tunnels", () => {
  const api = { tunnels: [{ public_url: "https://moodier.ngrok-free.dev", config: { addr: "http://localhost:3006" } }] };

  it("finds ngrok through its API, in its terminal, up", async () => {
    const r = rig("ngrok http 3006 --host-header=rewrite", { api });
    r.see();
    await r.tunnels.tick();
    r.stop();
    const [t] = r.tunnels.list();
    expect(t).toMatchObject({ kind: "ngrok", url: "https://moodier.ngrok-free.dev", port: 3006, agentId: "a7", health: "up", why: "HTTP 200" });
    expect(r.changed.length).toBe(1);
  });

  it("asks ngrok's address from outside only every half hour", async () => {
    const r = rig("ngrok http 3006", { api });
    r.see();
    for (let i = 0; i < 10; i++) {
      await r.tunnels.tick();
      r.advance(60_000);
    }
    r.stop();
    expect(r.probes()).toBe(1);
    expect(r.tunnels.list()[0]!.health).toBe("up");
  });

  it("does not ask again after a restart what it asked a minute before it", async () => {
    const kept = { "https://moodier.ngrok-free.dev": { at: 1_000_000 - 60_000, up: true, why: "HTTP 200" }, junk: { at: "x" } };
    const r = rig("ngrok http 3006", { api, kept });
    r.see();
    await r.tunnels.tick();
    r.stop();
    expect(r.probes()).toBe(0);
    expect(r.tunnels.list()[0]).toMatchObject({ health: "up", publicAt: 940_000 });
  });

  it("keeps what it asked", async () => {
    const r = rig("ngrok http 3006", { api });
    r.see();
    await r.tunnels.tick();
    r.stop();
    expect(r.saved()).toEqual({ "https://moodier.ngrok-free.dev": { at: 1_000_000, up: true, why: "HTTP 200" } });
  });

  it("is down at once when nothing listens on its port, and Kuru hears on the second look", async () => {
    const answers: { api: unknown; reachable: boolean } = { api, reachable: true };
    const r = rig("ngrok http 3006", answers);
    r.see();
    await r.tunnels.tick();
    answers.reachable = false;
    r.advance(60_000);
    await r.tunnels.tick();
    expect(r.tunnels.list()[0]).toMatchObject({ health: "down", why: "nothing is listening on :3006" });
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
    const r = rig("ngrok http 3006", { api });
    r.see();
    await r.tunnels.tick();
    r.see(false);
    r.advance(60_000);
    await r.tunnels.tick();
    r.stop();
    expect(r.tunnels.list()).toHaveLength(1);
    expect(r.tunnels.list()[0]).toMatchObject({ health: "gone", why: "ngrok is no longer running" });
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
    id: "ngrok:1:x",
    kind: "ngrok",
    pid: 1,
    url: "https://moodier.ngrok-free.dev",
    port: 3006,
    target: "http://localhost:3006",
    command: "ngrok http 3006",
    agentId: "a7",
    health: "down",
    why: "nothing is listening on :3006",
    checkedAt: 1_000_000,
    publicAt: 940_000,
    since: 940_000,
  };
  const servers: DevServer[] = [{ port: 3006, pid: 2, command: "next dev -p 3006", program: "next dev", repo: "/Users/x/holapy" }];
  it("a status line names the dev server and the terminal", () => {
    const text = tunnelsText([tunnel], servers, () => "the ngrok shell in Holapy", 1_030_000)!;
    expect(text).toContain("DOWN (nothing is listening on :3006)");
    expect(text).toContain("looked at 30s ago");
    expect(text).toContain("serves the dev server on :3006 (next dev -p 3006 in holapy)");
    expect(text).toContain("runs in the ngrok shell in Holapy");
    expect(tunnelsText([], servers, () => "", 0)).toBeNull();
  });
  it("a notice", () => {
    expect(tunnelNotice(tunnel, "down", servers, () => "the ngrok shell", 1_000_000)).toStartWith("[kururu] Tunnel down: ngrok https://moodier.ngrok-free.dev — nothing is listening on :3006, since 1 min ago.");
    expect(tunnelNotice({ ...tunnel, health: "up", why: "HTTP 200" }, "up", [], () => "x")).toContain("Tunnel back up");
  });
});
