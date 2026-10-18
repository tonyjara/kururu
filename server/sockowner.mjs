/**
 * Who is holding a unix socket, asked of the kernel's own tools.
 *
 * The pty host is found by its socket and never by its name (`kill-hosts.mjs`
 * has the afternoon that rule cost), and that question used to be one `lsof`.
 * `lsof` is macOS's and is not on every Linux: the Omarchy PC a child runs on
 * has `ss` and no `lsof`. So the question is asked here, once, for the three
 * places that ask it — `status.mjs`, `kill-hosts.mjs`, and the server's
 * `lifecycle.ts` — rather than taught to each of them twice.
 *
 * Plain JavaScript beside the two tools, because they are run by `node`
 * straight out of the checkout with nothing built; the server imports the same
 * file through `sockowner.d.mts` and esbuild bundles it in. One copy, so the
 * Linux reading cannot drift from the Mac's.
 *
 * The two tools do not answer the same question, and the difference is on
 * purpose. `lsof -t <path>` names every process with the file open, which on
 * macOS is the listener and the connections it accepted, all one pid. `ss
 * -xlpn` names the processes holding a *listening* socket at that path, which
 * is the host and nobody else — a server connected to it is on the other end,
 * not holding the name. Both answer "who is the host", which is the only thing
 * anybody here asks.
 */
import { execFileSync } from "node:child_process";
import { basename } from "node:path";

const TIMEOUT_MS = 2_000;

/** Every `pid=` in an `ss -p` process column: `users:(("node",pid=4321,fd=21),…)`. */
function pidsOf(users) {
  const pids = [];
  for (const found of (users ?? "").matchAll(/pid=(\d+)/g)) {
    const pid = Number(found[1]);
    if (Number.isInteger(pid) && pid > 0 && !pids.includes(pid)) pids.push(pid);
  }
  return pids;
}

/**
 * `ss -xlpnH`: the listening unix sockets, by path, with their holders.
 *
 *     u_str LISTEN 0 511 /home/me/.local/state/kururu/ptyhost.sock 88812 * 0 users:(("node",pid=4321,fd=21))
 *
 * The netid column is optional, since `ss` prints it only when more than one
 * kind of socket was asked for. The path is everything between the queues and
 * the inode, so a path with a space in it survives; an abstract socket (`@…`)
 * is kept as `ss` spells it, and a socket another user holds comes back with
 * no pids, since `-p` sees only our own processes. Pure, for the test.
 */
export function parseSsUnix(out) {
  const sockets = [];
  for (const line of out.split("\n")) {
    const found = /^\s*(?:\S+\s+)?LISTEN\s+\d+\s+\d+\s+(.+?)\s+\d+\s+\*\s+\d+(?:\s+(users:.*))?\s*$/.exec(line);
    if (!found) continue;
    sockets.push({ path: found[1], pids: pidsOf(found[2]) });
  }
  return sockets;
}

/**
 * `ss -ltnpH`: the listening TCP sockets, as pid → ports, the shape
 * `devservers.ts` reads `lsof -F pn` into.
 *
 *     LISTEN 0 511       127.0.0.1:5173  0.0.0.0:*  users:(("node",pid=1234,fd=23))
 *     LISTEN 0 4096           [::]:22       [::]:*
 *
 * The port is after the last colon of the local address, which holds for
 * `*:3000`, `[::1]:5432` and `127.0.0.53%lo:53` alike. A socket two processes
 * share — a server that forked its workers after listening — counts for both.
 * Pure, for the test.
 */
export function parseSsTcp(out) {
  const byPid = new Map();
  for (const line of out.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] !== "LISTEN" || fields.length < 5) continue;
    const local = fields[3];
    const port = Number(local.slice(local.lastIndexOf(":") + 1));
    if (!Number.isInteger(port) || port <= 0) continue;
    for (const pid of pidsOf(fields.slice(5).join(" "))) {
      const ports = byPid.get(pid);
      if (!ports) byPid.set(pid, [port]);
      else if (!ports.includes(port)) ports.push(port);
    }
  }
  return byPid;
}

/**
 * `lsof -U`: every unix socket, one line each, the pid second and the path
 * last. A host holds its listener and each connection it accepted under the
 * same name, so the same pid comes back more than once. Pure, for the test.
 */
export function parseLsofUnix(out) {
  const sockets = [];
  for (const line of out.split("\n")) {
    const fields = line.trim().split(/\s+/);
    const path = fields.at(-1);
    const pid = Number(fields[1]);
    if (!path?.startsWith("/") || !Number.isInteger(pid) || pid <= 0) continue;
    sockets.push({ path, pids: [pid] });
  }
  return sockets;
}

/** A tool's output, or null when it is not there or did not answer. `status` is what it exited with. */
function run(command, args) {
  try {
    return { out: execFileSync(command, args, { encoding: "utf8", timeout: TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] }), status: 0 };
  } catch (err) {
    if (err?.code === "ENOENT" || err?.signal) return null;
    return { out: String(err?.stdout ?? ""), status: typeof err?.status === "number" ? err.status : -1 };
  }
}

/** The listening unix sockets from `ss`, or null when there is no `ss` to ask. */
function ssUnix() {
  const done = run("ss", ["-xlpnH"]);
  return done && done.status === 0 ? parseSsUnix(done.out) : null;
}

/**
 * Who holds the socket at `path`: the pids, an empty list for nobody, and null
 * when that cannot be found out — no tool, or one that timed out. The three
 * answers are kept apart because `lifecycle.ts` reads "nobody" as the host
 * gone and "cannot tell" as nothing at all.
 *
 * macOS asks `lsof`, as it always did. Elsewhere `ss` first and `lsof` when
 * there is no `ss`; `lsof` exits 1 having found nobody.
 */
export function socketHolders(path) {
  if (process.platform !== "darwin") {
    const sockets = ssUnix();
    if (sockets) return [...new Set(sockets.filter((socket) => socket.path === path).flatMap((socket) => socket.pids))];
  }
  const done = run("lsof", ["-t", path]);
  if (!done) return null;
  if (done.status === 1 && !done.out.trim()) return [];
  if (done.status !== 0) return null;
  return [...new Set(done.out.split("\n").map(Number).filter((pid) => Number.isInteger(pid) && pid > 0))];
}

/**
 * Every socket on this machine whose file is called `name`, with the pid
 * holding it — one entry per pid. How `kill-hosts.mjs` finds every pty host,
 * scratch instances and all, without being told where any of them are.
 */
export function socketsNamed(name) {
  let sockets = process.platform === "darwin" ? null : ssUnix();
  if (!sockets) {
    const done = run("lsof", ["-U"]);
    sockets = done ? parseLsofUnix(done.out) : [];
  }
  const found = new Map();
  for (const socket of sockets) {
    if (basename(socket.path) !== name) continue;
    for (const pid of socket.pids) if (!found.has(pid)) found.set(pid, { pid, path: socket.path });
  }
  return [...found.values()];
}
