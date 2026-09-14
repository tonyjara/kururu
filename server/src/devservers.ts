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
 *
 * Beside it, and answering a different question, is a walk *down* from the pids
 * kururu's own ptys are running on: which of this session's terminals has a dev
 * server in it, what was typed to start it, and which process to interrupt to
 * stop it. That is what puts a ▸ and a ↻ on a workspace row, and it is
 * deliberately not derived from the port scan. A server that is still compiling
 * is listening on nothing and would blink the button back to ▸ for the ten
 * seconds it takes to come up; the process is there the whole time. The two
 * halves share one `ps`, and nothing else.
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

// ---------------------------------------------------------------------------
// Which of kururu's own terminals is serving
// ---------------------------------------------------------------------------

/** A dev server running inside a terminal kururu owns. */
export interface DevProc {
  /** The name that matched, for a label: "vite", "npm run dev". */
  program: string;
  /**
   * The process to interrupt. The shallowest match under the pty, not the one
   * holding the port — stopping `npm run dev` takes the `next-server` beneath it
   * with it, and stopping the `next-server` alone leaves npm sitting there.
   */
  pid: number;
  /** The line that started it, which is the line a restart types again. */
  command: string;
  /** Hops from the pty's own process. 1 is the usual answer: the shell's child. */
  depth: number;
}

/** Depth cap on the descendant walk; a dev server is a hop or two from the shell. */
const MAX_DEPTH = 6;
/** Backstop so a fork bomb in a pty cannot make the poll expensive. */
const MAX_VISITED = 4000;

/** ppid → children, built once per scan and shared by every terminal's walk. */
export function childIndex(table: Map<number, ProcInfo>): Map<number, ProcInfo[]> {
  const index = new Map<number, ProcInfo[]>();
  for (const proc of table.values()) {
    const siblings = index.get(proc.ppid);
    if (siblings) siblings.push(proc);
    else index.set(proc.ppid, [proc]);
  }
  return index;
}

/**
 * The dev server running under a pty, found by walking down rather than up.
 *
 * Breadth-first, and the shallowest match wins, which is the whole reason this
 * exists beside `resolveDevCommand`. Both find the same server; they disagree
 * about what to call it. Starting from the listening socket, the first thing
 * that matches on the way up is usually the process holding the port —
 * `node .../vite/bin/vite.js` — and re-typing that is neither what the user ran
 * nor, for a launcher that compiles first, the same thing at all. Starting from
 * the terminal, the first match is the child of the shell: `npm run dev`, which
 * is what was typed and what to type again.
 */
export function findDevUnder(
  rootPid: number,
  table: Map<number, ProcInfo>,
  children: Map<number, ProcInfo[]>,
): DevProc | null {
  const root = table.get(rootPid);
  if (!root) return null;
  let visited = 0;
  let frontier: ProcInfo[] = [root];
  for (let depth = 0; depth <= MAX_DEPTH && frontier.length > 0; depth++) {
    const next: ProcInfo[] = [];
    for (const proc of frontier) {
      if (++visited > MAX_VISITED) return null;
      const program = matchDevCommand(proc.args);
      // The pty's own shell cannot be the server (depth 0 is `zsh -l`), but a
      // tab opened with a command runs it directly, so depth is not filtered.
      if (program) return { program, pid: proc.pid, command: proc.args.slice(0, 200), depth };
      const kids = children.get(proc.pid);
      if (kids) next.push(...kids);
    }
    frontier = next;
  }
  return null;
}

/**
 * One pass over every terminal: `roots` maps agent id → the pid its pty is
 * running. Terminals with nothing serving in them are absent.
 */
export function findDevServers(
  roots: Iterable<[string, number]>,
  table: Map<number, ProcInfo>,
): Map<string, DevProc> {
  const out = new Map<string, DevProc>();
  if (table.size === 0) return out;
  const children = childIndex(table);
  for (const [agentId, pid] of roots) {
    const dev = findDevUnder(pid, table, children);
    if (dev) out.set(agentId, dev);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stopping one
// ---------------------------------------------------------------------------

/** How long to wait for an interrupt to be honoured before escalating. */
const STOP_LADDER: ReadonlyArray<{ after: number; signal: "SIGTERM" | "SIGKILL" }> = [
  { after: 3000, signal: "SIGTERM" },
  { after: 6000, signal: "SIGKILL" },
];
/** After this the server has won and we stop waiting for it to die. */
const STOP_TIMEOUT_MS = 8000;
/** How often the pid is checked in between. */
const STOP_CHECK_MS = 100;

/** Still there? `signal 0` asks the kernel without sending anything. */
function alive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The targeted form of ^C: the dev server and everything it spawned, and
 * nothing above it.
 *
 * Deliberately *not* the process group, which is the one thing teardown
 * elsewhere in kururu always signals. The group here is the pty's, and the pty's
 * leader is the shell — killing the group would close the tab the restart is
 * about to type into. So the tree is collected from the same `ps` the scan runs
 * on and each member is signalled by pid.
 */
async function signalTree(pid: number, signal: "SIGINT" | "SIGTERM" | "SIGKILL"): Promise<void> {
  const table = parseProcTable(await run(["ps", "-eo", "pid=,ppid=,args="]));
  const children = childIndex(table);
  const tree: number[] = [];
  const walk = (at: number, depth: number): void => {
    if (depth > MAX_DEPTH || tree.length > MAX_VISITED) return;
    tree.push(at);
    for (const kid of children.get(at) ?? []) walk(kid.pid, depth + 1);
  };
  if (table.has(pid)) walk(pid, 0);
  else tree.push(pid);
  for (const target of tree) {
    try {
      process.kill(target, signal);
    } catch {
      // Gone between the ps and here, or never ours to signal.
    }
  }
}

/**
 * Stop a dev server, and resolve once it is really gone.
 *
 * The wait is the point: a restart that re-typed its command the instant it sent
 * SIGINT would be typing at a program that is still shutting down, and the line
 * would land in whatever the old server printed on its way out. Escalating is
 * for the ones that trap the interrupt and take their time about it; after
 * `STOP_TIMEOUT_MS` it has won and the caller is told anyway, because a button
 * that never comes back is worse than one that gives up.
 */
export async function stopDev(pid: number): Promise<void> {
  if (!alive(pid)) return;
  void signalTree(pid, "SIGINT");
  const started = Date.now();
  let escalated = 0;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, STOP_CHECK_MS));
    if (!alive(pid)) return;
    const waited = Date.now() - started;
    if (waited >= STOP_TIMEOUT_MS) return;
    while (escalated < STOP_LADDER.length && waited >= STOP_LADDER[escalated]!.after) {
      void signalTree(pid, STOP_LADDER[escalated]!.signal);
      escalated++;
    }
  }
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

/** The two answers one scan produces. See the note at the top of the file. */
export interface DevScan {
  /** Everything listening on this machine, whoever started it. For previews. */
  servers: DevServer[];
  /** The ones inside a terminal kururu owns, by agent id. For the workspace row. */
  running: Map<string, DevProc>;
}

/**
 * Every dev server listening right now, lowest port first — ports are what the
 * user recognises ("the one on 5173"), so that is the sort — and, from the same
 * `ps`, the ones running inside the terminals named by `roots` (agent id → the
 * pid its pty is on).
 */
export async function scanDevServers(roots: Iterable<[string, number]> = []): Promise<DevScan> {
  const [lsofOut, psOut] = await Promise.all([
    run(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pn"]),
    run(["ps", "-eo", "pid=,ppid=,args="]),
  ]);
  const listeners = parseListeners(lsofOut);
  const table = parseProcTable(psOut);
  const running = findDevServers(roots, table);

  const found: DevServer[] = [];
  for (const [pid, ports] of listeners) {
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

  return { servers: found.sort((a, b) => a.port - b.port), running };
}
