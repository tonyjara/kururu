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
): { program: string; command: string; pid: number } | null {
  let current = table.get(pid);
  for (let hop = 0; current && hop <= MAX_ANCESTORS; hop++) {
    const program = matchDevCommand(current.args);
    if (program) return { program, command: current.args, pid: current.pid };
    if (current.ppid <= 1) break; // launchd is nobody's dev server
    current = table.get(current.ppid);
  }
  return null;
}

/** Every process at or under `root`, root first. */
function subtree(root: number, table: Map<number, ProcInfo>): number[] {
  const children = new Map<number, number[]>();
  for (const proc of table.values()) {
    const siblings = children.get(proc.ppid);
    if (siblings) siblings.push(proc.pid);
    else children.set(proc.ppid, [proc.pid]);
  }
  const out: number[] = [];
  const seen = new Set<number>();
  const stack = [root];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid) || !table.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return out;
}

/**
 * What stopping a dev server ends: the command the row is named after and
 * everything under it — or, failing that, the listener and everything under
 * it — or nothing, which is null.
 *
 * The named command rather than the listener, because the listener is so often
 * not the thing anybody started. `next dev` forks a `next-server` that holds the
 * port, nodemon and `tsx watch` hold it through a child they will restart on the
 * next save, and ending only the child of any of those leaves the row gone and
 * the server about to come back. The command the walk up found is the one the
 * row prints, so it is also the one a person pressing "stop" on that row means.
 *
 * A tree and not a process group, though a group is what Ctrl-C signals. A dev
 * server an agent started from its own tool shares the agent's group as often as
 * not, and signalling the group the port is in would end the agent with it.
 * Downward from a dev command is the one direction that cannot reach anything
 * that started it.
 *
 * `spare` is what may never be in the tree: kururu, its pty host, and the
 * process each terminal was opened with. The walk up is what makes that
 * necessary rather than paranoid — it goes four hops looking for a name, and a
 * listener with no name of its own (`python -m http.server`) typed into a
 * kururu shell could otherwise find one above the shell. When the named command
 * would take a spared process with it the listener alone is tried; when that
 * would too — a terminal opened *as* the dev server — the answer is no, and its
 * tab is the way to end it.
 */
export function stopTargets(
  listener: number,
  table: Map<number, ProcInfo>,
  spare: ReadonlySet<number>,
): number[] | null {
  if (!table.has(listener)) return null;
  const named = resolveDevCommand(listener, table)?.pid;
  const roots = named === undefined || named === listener ? [listener] : [named, listener];
  for (const root of roots) {
    const tree = subtree(root, table);
    if (!tree.some((pid) => pid <= 1 || spare.has(pid))) return tree;
  }
  return null;
}

/**
 * What kururu is, to its own scan.
 *
 * Kururu listens like a dev server and is started like one — `bun run dev`
 * above the server, `bun run --cwd web dev` above the window's vite — so a scan
 * that walks up looking for a name finds it every time, and a preview of kururu
 * is only kururu again. Both are known by the process, never by the port: 5173
 * is vite's default for every project on the machine, and another one's vite
 * there is exactly what the list is for whenever kururu's is not running.
 */
export interface Self {
  /** This process — the server on :7717 and every preview proxy it has opened. */
  pid: number;
  /**
   * The directory kururu's web app is built from, as a real path, or null where
   * there is none (a packaged app serves a built copy and runs no vite).
   *
   * The window's vite is a different process from ours, started by Electron
   * rather than by us, so there is no pid to hold. Its working directory is the
   * thing about it that is kururu's — `bun run --cwd web dev` is how both the
   * window and `bun run dev:web` start it — and the kernel says what that is.
   * Equality and not a prefix: a worktree of kururu has a `web` of its own,
   * and its vite is a project under work like any other.
   */
  webDir: string | null;
}

/** Whether a listener is kururu itself. `cwd` is absent until it has been asked. */
export function isKururu(listener: { pid: number; cwd?: string }, self: Self): boolean {
  if (listener.pid === self.pid) return true;
  return self.webDir !== null && listener.cwd === self.webDir;
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
export async function scanDevServers(self: Self): Promise<DevServer[]> {
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
     * point of the scan. The window's vite is the other half of `isKururu`, and
     * waits for the cwd below.
     */
    if (isKururu({ pid }, self)) continue;
    const match = resolveDevCommand(pid, table);
    if (!match) continue;
    for (const port of ports) {
      found.push({ port, pid, command: match.command.slice(0, 200), program: match.program });
    }
  }

  // cwd is the label that tells two vite servers apart, so it is worth the
  // extra lsof — but only for the handful that matched. Same question a new tab
  // asks about a terminal, so it is asked in one place: see `cwd.ts`. It is also
  // what tells kururu's own vite from the rest, so the filter waits for it.
  await Promise.all(
    found.map(async (server) => {
      server.cwd = await processCwd(server.pid);
    }),
  );

  return found.filter((server) => !isKururu(server, self)).sort((a, b) => a.port - b.port);
}

/** How long a dev server is given to shut itself down before it is made to. */
const STOP_GRACE_MS = 3000;

/** Signal 0 asks whether a pid exists; EPERM is a yes that is not ours. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Signal each pid, and say how many took it and how many were not ours to. */
function signal(pids: number[], sig: NodeJS.Signals): { sent: number; denied: number } {
  let sent = 0;
  let denied = 0;
  for (const pid of pids) {
    try {
      process.kill(pid, sig);
      sent++;
    } catch (err) {
      // ESRCH is a process that finished on its own between the read and now.
      if ((err as NodeJS.ErrnoException).code === "EPERM") denied++;
    }
  }
  return { sent, denied };
}

/**
 * Stop the dev server `pid` is holding `port` for, and resolve once it has.
 *
 * Both numbers are what the row was showing, and both are checked again here
 * against a fresh read rather than believed: the list is up to a scan old, and
 * in that time the server can have stopped and the pid, or the port, been taken
 * by something that is not a dev server at all. The narrow `lsof -p` is the
 * question "does this process still hold this port", asked of one process
 * instead of the machine.
 *
 * SIGTERM first, because every dev server worth the name cleans up on it — vite
 * closes its watcher, next its workers — and then SIGKILL for whatever is still
 * there after the grace, because "stop" that leaves the port held is not one.
 * The second signal goes to the same pids a few seconds later; the kernel does
 * not hand a pid out again inside that window on any machine this runs on.
 */
export async function stopDevServer(
  port: number,
  pid: number,
  spare: (table: Map<number, ProcInfo>) => ReadonlySet<number>,
): Promise<number[]> {
  const [lsofOut, psOut] = await Promise.all([
    run(["lsof", "-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-F", "pn"]),
    run(["ps", "-eo", "pid=,ppid=,args="]),
  ]);
  if (!parseListeners(lsofOut).get(pid)?.includes(port)) {
    throw new Error(`Nothing is serving :${port} from that process any more`);
  }
  const table = parseProcTable(psOut);
  const match = resolveDevCommand(pid, table);
  if (!match) throw new Error(`What is on :${port} is not a dev server`);
  const targets = stopTargets(pid, table, spare(table));
  if (!targets) throw new Error(`:${port} is a kururu terminal of its own — close its tab instead`);

  const { sent, denied } = signal(targets, "SIGTERM");
  if (sent === 0 && denied > 0) throw new Error(`${match.program} on :${port} belongs to another user`);

  const deadline = Date.now() + STOP_GRACE_MS;
  let left = targets.filter(alive);
  while (left.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    left = left.filter(alive);
  }
  if (left.length > 0) signal(left, "SIGKILL");
  return targets;
}
