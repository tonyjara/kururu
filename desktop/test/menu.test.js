/**
 * The tray's sentences. `menu.js` knows nothing about Electron so the words
 * it puts in the menu can be read here, which matters because a grey item
 * with no reason and a "Restart pty host" that does not name the cost are
 * both bugs that look like a menu.
 */
import { describe, expect, it } from "bun:test";
import { menuTemplate, trayTitle, uptimeWords } from "../menu.js";

const base = {
  appVersion: "0.2.0",
  packaged: true,
  home: "/Users/x",
  sourceLabel: "running from this app",
  checkout: null,
  checkoutOk: true,
  checkoutProblem: null,
  webStale: false,
  building: null,
  buildError: null,
  vite: { status: "off", port: 5173, error: null },
  windowOpen: true,
  source: "app",
  savedCheckout: null,
  talk: { on: false, status: "off", altSpace: false },
  openAtLogin: { on: false, available: true, status: "not-registered" },
  lastEvent: null,
  canStart: { ok: true },
  host: { up: true, pid: 1, uptime: "08-07:48:40", version: "0.2.0", protocol: 2, behind: false },
  server: {
    up: true,
    ours: true,
    adoptedBy: null,
    since: new Date().toISOString(),
    because: "the app started it",
    version: "0.2.0",
    liveAgents: 3,
    devServers: 1,
    supervised: true,
    orphaned: false,
  },
};

const labels = (view) =>
  menuTemplate(view).flatMap((item) => [item.label ?? "", ...(item.submenu ?? []).map((sub) => sub.label ?? "")]);
const byId = (view, id) => {
  for (const item of menuTemplate(view)) {
    if (item.id === id) return item;
    for (const sub of item.submenu ?? []) if (sub.id === id) return sub;
  }
  return undefined;
};

describe("the tray menu", () => {
  it("names the host restart's cost and offers it only under a supervised server", () => {
    expect(byId(base, "restart-host").label).toBe("Restart pty host… (ends 3 agents)");
    expect(byId(base, "restart-host").enabled).toBe(true);
    const one = { ...base, server: { ...base.server, liveAgents: 1 } };
    expect(byId(one, "restart-host").label).toBe("Restart pty host… (ends 1 agent)");
    const unsupervised = { ...base, server: { ...base.server, supervised: false } };
    expect(byId(unsupervised, "restart-host").enabled).toBe(false);
    expect(byId(unsupervised, "restart-host").label).toContain("needs a supervised server");
  });

  it("refuses to stop an adopted server and says whose it is", () => {
    const adopted = { ...base, server: { ...base.server, ours: false, adoptedBy: "bun run dev (pid 25239)" } };
    const stop = byId(adopted, "stop-server");
    expect(stop.enabled).toBe(false);
    expect(stop.label).toContain("bun run dev (pid 25239)");
    expect(labels(adopted).some((label) => label.includes("started by bun run dev (pid 25239)"))).toBe(true);
    // Restarting goes through the server's own verb, so it is still offered.
    expect(byId(adopted, "restart-server").enabled).toBe(true);
  });

  it("says why a server is down and why a start would not work", () => {
    const down = {
      ...base,
      server: { up: false, starting: false, downSince: Date.now(), lastExit: "the runner exited with 1" },
      canStart: { ok: false, why: "run `bun install` in it first" },
    };
    expect(byId(down, "server").label).toMatch(/^○ Server down since/);
    expect(byId(down, "server-why").label).toContain("the runner exited with 1");
    const start = byId(down, "start-server");
    expect(start.enabled).toBe(false);
    expect(start.label).toBe("Start Server — run `bun install` in it first");
    expect(byId(down, "restart-host").enabled).toBe(false);
  });

  it("flags a host that is behind the server", () => {
    const behind = { ...base, host: { ...base.host, behind: true, protocol: 1 } };
    expect(byId(behind, "host-behind").label).toContain("behind this server (protocol 1)");
    expect(byId(base, "host-behind")).toBeUndefined();
  });

  it("says what the talk key needs", () => {
    expect(byId(base, "talk-global").label).toBe("Talk key in every app");
    expect(byId(base, "talk-permission")).toBeUndefined();
    const denied = { ...base, talk: { on: true, status: "denied", altSpace: false } };
    expect(byId(denied, "talk-global").label).toContain("needs Input Monitoring");
    expect(byId(denied, "talk-global").checked).toBe(true);
    expect(byId(denied, "talk-permission").label).toContain("Input Monitoring");
    const missing = { ...base, talk: { on: true, status: "missing", altSpace: false } };
    expect(byId(missing, "talk-global").label).toContain("no key hook");
  });

  it("offers the window the right way round, and login only to the installed app", () => {
    expect(byId(base, "close-window")).toBeDefined();
    expect(byId(base, "open-window")).toBeUndefined();
    const closed = { ...base, windowOpen: false };
    expect(byId(closed, "open-window")).toBeDefined();
    const dev = { ...base, packaged: false, openAtLogin: { on: false, available: false, status: "not-registered" } };
    expect(byId(dev, "open-at-login").enabled).toBe(false);
    expect(byId(dev, "open-at-login").label).toContain("only for the installed app");
    const approval = { ...base, openAtLogin: { on: true, available: true, status: "requires-approval" } };
    expect(byId(approval, "open-at-login").label).toContain("approve it in System Settings");
  });

  it("lists a saved checkout under Run from, shortened to the home directory", () => {
    const withCheckout = { ...base, savedCheckout: "/Users/x/Desktop/kururu", source: "checkout", checkout: "/Users/x/Desktop/kururu" };
    expect(byId(withCheckout, "source-checkout").label).toBe("~/Desktop/kururu");
    expect(byId(withCheckout, "source-checkout").checked).toBe(true);
    expect(byId(withCheckout, "rebuild-web").label).toBe("Rebuild the web app for the phone");
    expect(byId({ ...withCheckout, webStale: true }, "rebuild-web").label).toBe("Rebuild the web app for the phone — behind web/src");
    expect(byId(base, "rebuild-web")).toBeUndefined();
    expect(byId(withCheckout, "log-vite")).toBeDefined();
    expect(byId(base, "log-vite")).toBeUndefined();
  });

  it("says what the window is showing from a checkout, and nothing about vite from the app", () => {
    const checkout = { ...base, source: "checkout", checkout: "/Users/x/Desktop/kururu" };
    expect(byId(base, "vite")).toBeUndefined();
    expect(byId({ ...checkout, vite: { status: "up", port: 5173, error: null } }, "vite").label).toBe(
      "● vite on :5173 — the window and the pill reload as web/ is saved",
    );
    expect(byId({ ...checkout, vite: { status: "adopted", port: 5173, error: null } }, "vite").label).toContain("already running");
    expect(byId(checkout, "vite").label).toBe("○ vite down — it starts with the server");
    const failed = { ...checkout, vite: { status: "failed", port: 5173, error: "something else answers on :5173" } };
    expect(byId(failed, "vite").label).toBe("⚠ something else answers on :5173 — the window shows web/dist");
    expect(byId(failed, "vite").enabled).toBe(false);
  });

  it("puts the live count in the tray title and nothing when there are none", () => {
    expect(trayTitle(base)).toBe("3");
    expect(trayTitle({ server: { up: true, liveAgents: 0 } })).toBe("");
    expect(trayTitle({ server: { up: false } })).toBe("");
  });

  it("reads ps's elapsed time as words", () => {
    expect(uptimeWords("08-07:48:40")).toBe("8 days");
    expect(uptimeWords("1-00:00:01")).toBe("1 day");
    expect(uptimeWords("01:34:26")).toBe("1 h 34 min");
    expect(uptimeWords("30:19")).toBe("30 min");
    expect(uptimeWords("00:40")).toBe("under a minute");
  });
});
