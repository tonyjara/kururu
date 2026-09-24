/**
 * Which dev servers are running on this machine, and on what port.
 *
 * The port is asked of the kernel, never parsed out of the command line. `npm
 * run dev` names no port at all, and `vite --port 3001` *lies* the moment 3001
 * is taken and vite falls back to 3002 — a preview pointed at the number the
 * user typed would show a blank frame with nothing to explain it. `lsof` knows
 * which socket the process actually holds.
 *
 * Two passes, both cheap and both over the whole machine at once: lsof for
 * pid → listening ports, ps for pid → argv. Cross-referencing them is what
 * turns "something is on :5173" into "vite, in ~/Desktop/Nyto/kururu".
 *
 * The port scan is machine-wide rather than per-agent, which is both a
 * limitation and a feature: a dev server you started in a plain terminal shows
 * up there, and so does one an agent started.
 */
import { execFile } from "node:child_process";
import type { DevServer } from "../../shared/wire";
import { processCwd } from "./cwd";

/**
 * Programs whose name means a server is running. Mirrors ghosttown's
 * [dev_servers] defaults so the two agree about what counts.
 */
const DEV_COMMANDS = [
  "next dev", "vite", "astro dev", "nuxt dev", "remix dev", "ng serve",
  "webpack serve", "webpack-dev-server", "parcel", "gatsby develop",
  "react-scripts start", "expo start", "storybook dev", "turbo dev", "nodemon",
  "tsx watch", "wrangler dev", "netlify dev", "vercel dev", "serve",
  "http-server", "live-server", "rails server", "swift run",
  "manage.py runserver", "flask run", "fastapi dev", "uvicorn",
  "php artisan serve", "hugo server", "jekyll serve", "dotnet watch",
];

/** Script names that mean "dev server" when a package manager runs one. */
const DEV_SCRIPTS = ["dev", "start", "serve", "watch"];

/** Heads that run a *script*, where the script name decides. */
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun", "deno", "make", "just", "task"]);

/** Filler between a package manager and the script it was asked for. */
const PM_SUBCOMMANDS = new Set(["run", "run-script", "task", "exec"]);

/**
 * Package-manager flags that eat the word *after* them.
 *
 * Dropping a flag and leaving its value standing is what made `bun run --cwd
 * web dev` read as a request to run a script called `/Users/…/web` — no match,
 * no button, and nothing on screen to say why. Every monorepo line is this
 * shape (`npm --prefix api run dev`, `pnpm -C web dev`, `npm run -w web dev`),
 * so it is not an edge case; it is how most people start the server they would
 * actually press ↯ for. Enumerated rather than inferred: a lone `--port 3001`
 * after the script name is a flag whose value must *not* be eaten, and nothing
 * in the token itself distinguishes the two.
 */
const PM_VALUE_FLAGS = new Set([
  "--cwd", "-C", "--prefix", "--dir", "--filter", "-F", "--workspace", "-w", "--package",
]);

/**
 * The script a package manager was asked to run, from the tokens after its
 * name — past the subcommand, past the flags, and past whatever a flag was
 * carrying. Null when there is nothing left, which is `npm` on its own.
 */
function scriptAfter(tokens: string[]): string | null {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (PM_VALUE_FLAGS.has(token)) {
      i++; // and its value with it
      continue;
    }
    if (isPreamble(token) || PM_SUBCOMMANDS.has(token)) continue;
    return token;
  }
  return null;
}

/** Interpreters worth looking past: the server is the script they were given. */
const LAUNCHERS = new Set(["node", "bun", "deno", "python", "python3", "npx", "bunx", "uv", "uvx", "sh", "bash", "zsh", "env"]);

/**
 * Ports that are somebody else's business. macOS itself listens on 5000 and
 * 7000 (ControlCenter/AirPlay), and offering those as a "preview" is pure
 * noise — the user's own dev server is never there.
 */
const IGNORED_PORTS = new Set([22, 25, 53, 88, 445, 631, 5000, 5432, 6379, 7000, 27017]);

function basename(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}

/** Executable name: no directory, no script extension, no shell quoting. */
function programName(token: string): string {
  return basename(token).replace(/^['"]+/, "").replace(/\.(js|mjs|cjs|ts|py|rb|sh)$/, "").toLowerCase();
}

/** A `-flag` or a `VAR=value` prefix — neither one names the program. */
function isPreamble(token: string): boolean {
  return token.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

/**
 * Does this command line run a dev server? Returns the matched name for a
 * label, or null. Pure string work over the leading tokens, so it is the part
 * that is worth testing.
 */
export function matchDevCommand(args: string): string | null {
  const tokens = args.split(/\s+/).filter(Boolean);
  let i = 0;
  // Step past env-var prefixes, flags, and interpreters until a real name.
  while (i < tokens.length && tokens.length - i > 0) {
    const token = tokens[i]!;
    if (isPreamble(token)) { i++; continue; }
    const name = programName(token);
    if (LAUNCHERS.has(name) && !PACKAGE_MANAGERS.has(name)) { i++; continue; }

    // `npm run dev`, `bun dev`, `pnpm dev:web` — the script name decides.
    if (PACKAGE_MANAGERS.has(name)) {
      const script = scriptAfter(tokens.slice(i + 1));
      if (!script) return null;
      const head = script.split(":")[0]!;
      return DEV_SCRIPTS.includes(head) ? `${name} ${script}` : null;
    }

    // Otherwise the program's own name, optionally plus the word after it.
    const pair = `${name} ${tokens[i + 1] ?? ""}`.trim();
    for (const candidate of DEV_COMMANDS) {
      if (candidate === name || candidate === pair || pair.startsWith(candidate + " ")) {
        return candidate;
      }
    }
    return null;
  }
  return null;
}

/** `lsof -F` field output: `p<pid>` starts a record, `n<addr:port>` names a socket. */
export function parseListeners(out: string): Map<number, number[]> {
  const byPid = new Map<number, number[]>();
  let pid = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1)) || 0;
      continue;
    }
    if (!pid || !line.startsWith("n")) continue;
    // "*:5173", "127.0.0.1:5173", "[::1]:5432" — the port is after the last colon.
    const addr = line.slice(1);
    const colon = addr.lastIndexOf(":");
    if (colon === -1) continue;
    const port = Number(addr.slice(colon + 1));
    if (!Number.isInteger(port) || port <= 0 || IGNORED_PORTS.has(port)) continue;
    const ports = byPid.get(pid);
    if (!ports) byPid.set(pid, [port]);
    else if (!ports.includes(port)) ports.push(port); // same port on v4 and v6
  }
  return byPid;
}

export interface ProcInfo {
  pid: number;
  ppid: number;
  /** argv joined, as ps prints it. */
  args: string;
}

/** `ps -eo pid=,ppid=,args=` into pid → {ppid, args}. */
export function parseProcTable(out: string): Map<number, ProcInfo> {
  const byPid = new Map<number, ProcInfo>();
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    byPid.set(pid, { pid, ppid: Number(m[2]) || 0, args: m[3]!.trim() });
  }
  return byPid;
}

/** How far up the tree to look for the command that names the server. */
const MAX_ANCESTORS = 4;

/**
 * The command a listening process *is*, looking up the tree when its own argv
 * does not say.
 *
 * The process holding the port is usually not the one you started: `npm run
 * dev` execs a shell that execs vite, and `bun run dev` runs a script whose
 * argv is the script path. Matching only the listener would miss every one of
 * those. Ghosttown has the same problem from the other end and solves it by
 * walking *down* from a surface (see collectTree, "the server it spawned — the
 * one that is holding the port"); with only a port to start from, the same walk
 * runs upwards.
 *
 * The ancestor's command is the better label anyway: "npm run dev" is what the
 * user typed and what they would type again.
 */
export function resolveDevCommand(
  pid: number,
  table: Map<number, ProcInfo>,
): { program: string; command: string } | null {
  let current = table.get(pid);
  for (let hop = 0; current && hop <= MAX_ANCESTORS; hop++) {
    const program = matchDevCommand(current.args);
    if (program) return { program, command: current.args };
    if (current.ppid <= 1) break; // launchd is nobody's dev server
    current = table.get(current.ppid);
  }
  return null;
}

/**
 * `ps -eo args` over a busy machine runs to a few hundred KB and lsof is no
 * smaller, so the default 1 MB ceiling is not the headroom it looks like:
 * overflowing it kills the child and the scan silently finds nothing.
 */
const MAX_BUFFER = 8 * 1024 * 1024;

function run(cmd: string[]): Promise<string> {
  const [file, ...args] = cmd;
  if (!file) return Promise.resolve("");
  return new Promise((resolve) => {
    execFile(file, args, { maxBuffer: MAX_BUFFER }, (err, stdout) => {
      // A missing lsof, a non-zero exit, a truncated read: all the same answer.
      // Discovery is best-effort and the next scan is three seconds away.
      resolve(err && !stdout ? "" : stdout);
    });
  });
}

/**
 * Every dev server listening right now, lowest port first — ports are what the
 * user recognises ("the one on 5173"), so that is the sort.
 */
export async function scanDevServers(): Promise<DevServer[]> {
  const [lsofOut, psOut] = await Promise.all([
    run(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pn"]),
    run(["ps", "-eo", "pid=,ppid=,args="]),
  ]);
  const listeners = parseListeners(lsofOut);
  const table = parseProcTable(psOut);

  const found: DevServer[] = [];
  for (const [pid, ports] of listeners) {
    /**
     * Never kururu itself. The walk *up* the process tree is what makes this
     * necessary: the server is a bare `node dist/server.mjs` that nothing would
     * match, but its parent is the `bun run dev` that started it, and a script
     * called `dev` is the scan's strongest signal. So kururu answers its own
     * description, and every socket this process holds — :7717, and one per
     * preview proxy — came back as a dev server you could open a preview of.
     *
     * That was cosmetic while previews were opened by hand and became a runaway
     * the moment they were opened for everything found: each new proxy is
     * another listening port on this same pid, which the next scan reports as
     * another dev server, which is given another proxy. It ran to a hundred and
     * twenty entries in about a minute before the port range would have stopped
     * it. Excluding our own pid is the fix at the root, and it is the right
     * answer independently of the loop — a preview of kururu is kururu.
     *
     * Only this process, never its children: the pty host is a different pid,
     * and the dev servers running inside kururu's own terminals are the entire
     * point of the scan.
     */
    if (pid === process.pid) continue;
    const match = resolveDevCommand(pid, table);
    if (!match) continue;
    for (const port of ports) {
      found.push({ port, pid, command: match.command.slice(0, 200), program: match.program });
    }
  }

  // cwd is the label that tells two vite servers apart, so it is worth the
  // extra lsof — but only for the handful that matched. Same question a new tab
  // asks about a terminal, so it is asked in one place: see `cwd.ts`.
  await Promise.all(
    found.map(async (server) => {
      server.cwd = await processCwd(server.pid);
    }),
  );

  return found.sort((a, b) => a.port - b.port);
}
