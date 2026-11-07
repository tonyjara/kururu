import { describe, expect, test } from "bun:test";
import type { DevServer } from "../../shared/wire";
import { isLoopback, previewLabel, previewUrl, serverIn } from "../src/preview";

const dev = (over: Partial<DevServer> = {}): DevServer => ({
  port: 5173,
  pid: 1234,
  command: "vite",
  program: "vite",
  ...over,
});

describe("previewUrl", () => {
  test("goes straight to the dev port on the desktop, proxy or no proxy", () => {
    const origin = { protocol: "http:", hostname: "127.0.0.1" };
    expect(previewUrl(origin, dev())).toBe("http://localhost:5173/");
    expect(previewUrl(origin, dev({ proxyPort: 7800 }))).toBe("http://localhost:5173/");
  });

  test("uses the host the client itself reached kururu by", () => {
    const url = previewUrl({ protocol: "http:", hostname: "100.64.1.2" }, dev({ proxyPort: 7801 }));
    expect(url).toBe("http://100.64.1.2:7801/");
  });

  test("carries the page's own protocol across", () => {
    const url = previewUrl({ protocol: "https:", hostname: "mac.ts.net" }, dev({ proxyPort: 7800 }));
    expect(url).toBe("https://mac.ts.net:7800/");
  });

  /**
   * The one that matters most. An anchor to the dev port from a phone reaches
   * the phone's own localhost, so "no proxy yet" has to be a refusal rather
   * than a best effort.
   */
  test("refuses rather than pointing a remote client at its own localhost", () => {
    expect(previewUrl({ protocol: "http:", hostname: "100.64.1.2" }, dev())).toBeNull();
  });

  test("knows every spelling of this machine", () => {
    for (const host of ["localhost", "LOCALHOST", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]) {
      expect(isLoopback(host)).toBe(true);
    }
    expect(isLoopback("100.64.1.2")).toBe(false);
    expect(isLoopback("mac.ts.net")).toBe(false);
  });
});

describe("previewLabel", () => {
  const places = [
    { name: "Holapy", root: "/n/holapy" },
    { name: "Pasapy", root: "/n/pasapy" },
    { name: "Rogapy", root: "/n/rogapy/" },
  ];

  test("is the workspace's name alone, from the folder the server runs in", () => {
    expect(previewLabel(dev({ cwd: "/n/holapy" }), places)).toBe("Holapy");
    expect(previewLabel(dev({ cwd: "/n/rogapy/apps/web", repo: "/n/rogapy" }), places)).toBe("Rogapy");
  });

  test("a worktree kept outside the project is its main repository's", () => {
    const wt = dev({ cwd: "/n/pasapy-wt/simulacro/apps/web", repo: "/n/pasapy" });
    expect(previewLabel(wt, places)).toBe("Pasapy");
  });

  test("a sibling with a longer name is not inside", () => {
    expect(previewLabel(dev({ cwd: "/n/holapy-old" }), places)).toBe("holapy-old");
  });

  test("the deepest workspace wins", () => {
    const nested = [{ name: "Code", root: "/n" }, ...places];
    expect(previewLabel(dev({ cwd: "/n/holapy/web" }), nested)).toBe("Holapy");
    expect(previewLabel(dev({ cwd: "/n/other" }), nested)).toBe("Code");
  });

  test("with no workspace, the project folder's name, then the program", () => {
    expect(previewLabel(dev({ cwd: "/x/pasapy-wt/s/apps/web", repo: "/x/pasapy" }), places)).toBe("pasapy");
    expect(previewLabel(dev({ cwd: "/Users/n/code/kururu/" }))).toBe("kururu");
    expect(previewLabel(dev())).toBe("vite");
  });
});

describe("serverIn", () => {
  const tree = "/r.worktrees/fix-c1";
  test("only a server in the worktree, or under it", () => {
    expect(serverIn([dev({ cwd: "/r" }), dev({ cwd: "/r.worktrees/fix-c1-other" })], tree, 5173)).toBeNull();
    expect(serverIn([dev({ cwd: `${tree}/web`, port: 5174 })], tree, 4000)?.port).toBe(5174);
  });
  test("the offered port breaks a tie, else the first (lowest) one", () => {
    const two = [dev({ cwd: tree, port: 5173 }), dev({ cwd: tree, port: 7717 })];
    expect(serverIn(two, tree, 7717)?.port).toBe(7717);
    expect(serverIn(two, tree, 9000)?.port).toBe(5173);
  });
});
