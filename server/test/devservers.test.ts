/**
 * The parsing and matching here is what decides whether a preview finds its
 * dev server, and it is all pure — so it is all testable without a dev server,
 * an lsof, or a machine in any particular state.
 */
import { describe, expect, it } from "bun:test";
import {
  findDevServers,
  matchDevCommand,
  parseListeners,
  parseProcTable,
  resolveDevCommand,
} from "../src/devservers";

describe("matchDevCommand", () => {
  it("matches a dev server by its own name", () => {
    expect(matchDevCommand("vite")).toBe("vite");
    expect(matchDevCommand("next dev")).toBe("next dev");
    expect(matchDevCommand("uvicorn app:main")).toBe("uvicorn");
  });

  it("looks past the interpreter to the script it was given", () => {
    expect(matchDevCommand("node /x/node_modules/.bin/vite --port 3001")).toBe("vite");
  });

  it("reads a package manager's script name", () => {
    expect(matchDevCommand("npm run dev")).toBe("npm dev");
    expect(matchDevCommand("bun run dev:web")).toBe("bun dev:web");
    expect(matchDevCommand("pnpm serve")).toBe("pnpm serve");
  });

  it("does not match a dev server's name used as an argument", () => {
    expect(matchDevCommand("vim vite.config.ts")).toBeNull();
    expect(matchDevCommand("/usr/bin/ssh -N host")).toBeNull();
  });

  it("does not match a script that is not a dev script", () => {
    expect(matchDevCommand("npm run build")).toBeNull();
    expect(matchDevCommand("bun run typecheck")).toBeNull();
  });
});

describe("parseListeners", () => {
  const sample = ["p707", "cdbeaver", "f40", "n127.0.0.1:49184", "p1238", "cpostgres", "f7", "n[::1]:5432", "f8", "n127.0.0.1:5432", "p900", "cnode", "f20", "n*:5173", "f21", "n*:5173"].join("\n");

  it("groups ports under the pid holding them", () => {
    const byPid = parseListeners(sample);
    expect(byPid.get(707)).toEqual([49184]);
    expect(byPid.get(900)).toEqual([5173]); // same port on v4 and v6 is one port
  });

  it("drops ports that belong to the system, not to a project", () => {
    // 5432 is postgres; macOS itself holds 5000 and 7000.
    expect(parseListeners(sample).get(1238)).toBeUndefined();
  });
});

describe("resolveDevCommand", () => {
  // `bun run dev` (34999) spawns the script (35001); the child holds the port.
  const table = parseProcTable(["34999 34994 bun run dev", "35001 34999 bun run serve.ts", "34994     1 -zsh"].join("\n"));

  it("walks up to the ancestor that names the server", () => {
    expect(resolveDevCommand(35001, table)).toEqual({ program: "bun dev", command: "bun run dev" });
  });

  it("stops rather than claiming the shell is a dev server", () => {
    expect(resolveDevCommand(34994, table)).toBeNull();
  });
});

/**
 * The other direction. `resolveDevCommand` starts at a socket and looks up;
 * this starts at a terminal and looks down, and the point of having both is that
 * they disagree about what the server is *called* — which is the string a ↻ has
 * to type again.
 */
describe("findDevServers", () => {
  // Two ptys: 100 is running `npm run dev` (vite underneath it), 200 is a shell
  // somebody is reading a config file in.
  const table = parseProcTable(
    [
      "100     1 -zsh",
      "101   100 npm run dev",
      "102   101 sh -c vite",
      "103   102 node /x/node_modules/vite/bin/vite.js",
      "200     1 -zsh",
      "201   200 vim vite.config.ts",
    ].join("\n"),
  );

  it("names the server by what was typed, not by what holds the port", () => {
    const found = findDevServers([["a1", 100]], table);
    expect(found.get("a1")).toEqual({ program: "npm dev", pid: 101, command: "npm run dev", depth: 1 });
  });

  it("finds nothing in a terminal that is not serving", () => {
    expect(findDevServers([["a2", 200]], table).has("a2")).toBe(false);
  });

  it("finds nothing under a pid the table does not have", () => {
    expect(findDevServers([["a3", 999]], table).size).toBe(0);
  });

  it("takes a command run directly in the pty, with no shell above it", () => {
    const direct = parseProcTable(["300 1 next dev", "301 300 next-server"].join("\n"));
    expect(findDevServers([["a4", 300]], direct).get("a4")?.depth).toBe(0);
  });
});
