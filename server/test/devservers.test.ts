/**
 * The parsing and matching here is what decides whether a preview finds its
 * dev server, and it is all pure — so it is all testable without a dev server,
 * an lsof, or a machine in any particular state.
 */
import { describe, expect, it } from "bun:test";
import {
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

  /**
   * The monorepo shapes, which are most of the real ones: the flag's *value* is
   * not the script, and filtering the flag out on its own left the value
   * standing where the script should be. Kururu's own `dev:web` is this line.
   */
  it("steps over a flag the package manager takes a value for", () => {
    expect(matchDevCommand("bun run --cwd /Users/x/kururu/web dev")).toBe("bun dev");
    expect(matchDevCommand("npm --prefix ./api run dev")).toBe("npm dev");
    expect(matchDevCommand("pnpm -C web dev")).toBe("pnpm dev");
    expect(matchDevCommand("npm run -w web dev")).toBe("npm dev");
    expect(matchDevCommand("pnpm --filter web dev")).toBe("pnpm dev");
  });

  it("does not eat the argument of a flag that comes after the script", () => {
    expect(matchDevCommand("npm run dev -- --port 3001")).toBe("npm dev");
  });

  it("still refuses a non-dev script behind a flag", () => {
    expect(matchDevCommand("bun run --cwd web typecheck")).toBeNull();
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
