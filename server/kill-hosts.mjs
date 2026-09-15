/**
 * Stop the pty hosts, which is the one command in kururu that ends somebody's
 * work.
 *
 * Everything else is free: the window is a window, the server restarts on every
 * save and hands its agents back when it returns. Only the host holds ptys, so
 * only stopping the host costs anything — and because it is detached it is the
 * one process nothing else will ever reap for you. That asymmetry is the whole
 * reason this exists as a named command rather than a line in a README: the
 * expensive thing should be the one you have to type on purpose.
 *
 * It finds hosts **by their socket, never by their name.** `pkill -f ptyhostd`
 * is the obvious way and it is not reliable here — macOS `pgrep -f` was seen
 * matching two scratch hosts while consistently skipping the real one, with
 * `ps -ww` showing an identical command line for all three, and a pkill that
 * silently matches nothing reads exactly like a host that restarted and ignored
 * your change. A listening socket has one holder by construction, so asking who
 * is holding one cannot answer with the wrong process. `ps` is still consulted,
 * as a guard rather than as the search: something else holding a file called
 * ptyhost.sock is not a thing to send signals to.
 *
 * Plural because instances accumulate. A `KURURU_HOST_SOCK` pointed at a scratch
 * directory is how kururu is tested against real ptys without touching the
 * agents you are working in, and those hosts outlive the test that made them for
 * exactly the same reason the real one outlives your window.
 *
 * What it deliberately does **not** do is connect to any of them to find out
 * what they are holding. The host's socket takes one server at a time and reads
 * a second connection as a restarted first, so a tool that asked would knock the
 * live server off its link — `status.mjs` makes the same argument at more
 * length. The pty count here is counted from the outside instead: a host's
 * direct children are its pty leaders, which is a fact about how they were
 * spawned and needs nobody's permission to read.
 *
 *   bun run kill-ptyhosts               ask first, if there is anybody to ask
 *   bun run kill-ptyhosts --list        say what is running and stop there
 *   bun run kill-ptyhosts --yes         do not ask
 *   bun run kill-ptyhosts /tmp/k2       only the hosts whose socket path says so
 *
 * The prompt is skipped when stdin is not a terminal, which is what makes this
 * usable from a script — and is exactly why `--list` is here. Something that
 * ends agents without asking whenever it is not run by hand needs a way to be
 * *run* by something that is not a hand, safely, and asking it what it would do
 * is that way.
 */
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { basename } from "node:path";

const flags = process.argv.slice(2);
const force = flags.some((argument) => argument === "-y" || argument === "--yes");
const listOnly = flags.some((argument) => argument === "-n" || argument === "--list");
/**
 * Which hosts this is about, as a fragment of the socket path. Nothing means all
 * of them, which is the plural in the name. It is here because the instance you
 * want to stop is very often *not* the one holding your work: an isolated host
 * under `KURURU_HOST_SOCK` is how kururu is tested against real ptys, and
 * `kill-ptyhosts /tmp/k2` is how one is cleared up afterwards without the
 * clearing-up ending an afternoon.
 */
const only = flags.filter((argument) => !argument.startsWith("-"));

const tty = process.stdout.isTTY;
const paint = (code, text) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = (text) => paint("2", text);
const warn = (text) => paint("33", text);
const gone = (text) => paint("32", text);

const home = homedir();
const short = (path) => (path.startsWith(home) ? `~${path.slice(home.length)}` : path);

/** A command that is allowed to fail, since most of these answer by exit code. */
function run(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

/**
 * Every pty host on this machine, from the sockets rather than from the process
 * table. `lsof -U` prints the path last, and a host holds its listener and each
 * accepted connection under the same name — hence the dedupe by pid.
 */
function hosts() {
  const found = new Map();
  for (const line of run("lsof", ["-U"]).split("\n")) {
    const fields = line.trim().split(/\s+/);
    const path = fields.at(-1);
    const pid = Number(fields[1]);
    if (!path || !pid || basename(path) !== "ptyhost.sock") continue;
    // The guard, not the search: whatever is holding this has to be a host.
    if (!run("ps", ["-ww", "-o", "command=", "-p", String(pid)]).includes("ptyhost")) continue;
    if (!found.has(pid)) found.set(pid, { pid, path });
  }
  return [...found.values()];
}

const uptime = (pid) => run("ps", ["-o", "etime=", "-p", String(pid)]).trim();

/** Its pty leaders, which are its children — see the note above about not asking it. */
const ptys = (pid) => run("pgrep", ["-P", String(pid)]).trim().split("\n").filter(Boolean).length;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const running = hosts().filter((host) => !only.length || only.some((match) => host.path.includes(match)));
if (!running.length) {
  console.log(dim(only.length ? `No pty host matches ${only.join(" ")}.` : "No pty host is running. Nothing to stop."));
  process.exit(0);
}

let terminals = 0;
for (const host of running) {
  const count = ptys(host.pid);
  terminals += count;
  const age = uptime(host.pid);
  console.log(
    `pty host  pid ${String(host.pid).padEnd(7)}${`${count} terminal${count === 1 ? "" : "s"}`.padEnd(14)}${dim(
      `${age ? `up ${age} · ` : ""}${short(host.path)}`,
    )}`,
  );
}

if (listOnly) {
  console.log();
  console.log(
    dim(
      `${terminals} terminal${terminals === 1 ? "" : "s"} would end. Run it without --list to stop ${
        running.length === 1 ? "it" : "them"
      }.`,
    ),
  );
  process.exit(0);
}

if (!force && process.stdin.isTTY) {
  console.log();
  console.log(
    warn(
      `This ends ${terminals} terminal${terminals === 1 ? "" : "s"} and whatever is running in ${
        terminals === 1 ? "it" : "them"
      }.`,
    ),
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  /**
   * Anything other than yes is no, and that includes the question failing to be
   * asked. Ctrl-D rejects the promise rather than answering it, and a prompt
   * that threw its way out of a confirmation would be a stack trace where a
   * decision should have been — with the agents still running, which is at
   * least the right direction to fail in, but not a thing to print at somebody.
   */
  const answer = await rl.question("Stop them? [y/N] ").catch(() => "");
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) {
    console.log();
    console.log(dim("Left alone."));
    process.exit(1);
  }
}

/**
 * SIGTERM, and then wait rather than escalating. The host reaps its ptys and
 * unlinks its socket on the way out, and that is the difference between a clean
 * stop and a SIGKILL: killed outright it leaves the agents orphaned with no
 * terminal attached, and a socket file the next server has to recognise as a
 * corpse. If one really will not go, saying so is more use than doing it.
 */
for (const host of running) {
  try {
    process.kill(host.pid, "SIGTERM");
  } catch {
    // Already gone between listing and signalling, which is a fine outcome.
  }
}

const deadline = Date.now() + 5000;
let left = running;
while (left.length && Date.now() < deadline) {
  await sleep(100);
  left = left.filter((host) => alive(host.pid));
}

console.log();
if (!left.length) {
  console.log(gone(`Stopped ${running.length} pty host${running.length === 1 ? "" : "s"}.`));
  process.exit(0);
}

for (const host of left) {
  console.log(warn(`pid ${host.pid} is still up after SIGTERM — kill -9 ${host.pid} if you mean it.`));
}
process.exit(1);
