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
 * Ghosttown attributes dev servers to the surface running them, by walking the
 * surface's process tree. Kururu cannot: the daemon's `list` does not put dev
 * info in the snapshot yet. Scanning the machine is the version that needs no
 * change to ghosttown, and it finds servers started outside the mux too.
 */
import type { DevServer } from "../../shared/wire";

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
      const rest = tokens.slice(i + 1).filter((t) => !isPreamble(t) && t !== "run");
      const script = rest[0];
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

async function run(cmd: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
    return await new Response(proc.stdout).text();
  } catch {
    return "";
  }
}

/** Working directory of a pid, or undefined. One lsof per candidate, not per pid. */
async function cwdOf(pid: number): Promise<string | undefined> {
  const out = await run(["lsof", "-a", "-d", "cwd", "-p", String(pid), "-F", "n"]);
  for (const line of out.split("\n")) {
    if (line.startsWith("n/")) return line.slice(1);
  }
  return undefined;
}

/**
 * Every dev server listening right now, lowest port first. Ports are what the
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
    const match = resolveDevCommand(pid, table);
    if (!match) continue;
    for (const port of ports) {
      found.push({ port, pid, command: match.command.slice(0, 200), program: match.program });
    }
  }

  // cwd is the label that tells two vite servers apart, so it is worth the
  // extra lsof — but only for the handful that matched.
  await Promise.all(
    found.map(async (server) => {
      server.cwd = await cwdOf(server.pid);
    }),
  );

  return found.sort((a, b) => a.port - b.port);
}
