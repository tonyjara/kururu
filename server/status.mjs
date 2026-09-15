/**
 * What is running, for a person at a terminal.
 *
 * The pty host became a detached daemon so that agents outlive the window and
 * the server, and the price of that is a process with no face: no terminal, no
 * dock icon, nothing in a window to say it is there — and it is holding every
 * agent you have. `ps` is not an answer to give somebody about their own work.
 *
 * It asks two different things two different ways, which is not an accident.
 * Whether the *host* is alive is a question about this machine, answered by the
 * socket and who is holding it. What it is *holding* is a question only a server
 * can answer: the host's socket takes one server at a time and reads a second
 * connection as a restarted first, so a status tool that asked the host directly
 * would knock the live server off its link to find out how things were going. So
 * when there is no server there is genuinely nobody who can say, and this prints
 * that rather than inventing it.
 *
 *   bun run status                    this machine
 *   bun run status http://vm:7717     a server elsewhere, host line still local
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = process.env.KURURU_PORT ?? 7717;
const socket =
  process.env.KURURU_HOST_SOCK ||
  join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "kururu", "ptyhost.sock");

const argument = process.argv[2];
const server = (argument || `http://127.0.0.1:${PORT}`).replace(/\/+$/, "");
const remote = Boolean(argument);

// Colour only when somebody is looking at it; piped output is parsed, not read.
const tty = process.stdout.isTTY;
const paint = (code, text) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
const up = (text) => paint("32", text);
const down = (text) => paint("31", text);
const dim = (text) => paint("2", text);

const home = homedir();
const short = (path) => (path?.startsWith(home) ? `~${path.slice(home.length)}` : path);

function row(label, value, note) {
  console.log(`${label.padEnd(12)}${value}${note ? `  ${dim(note)}` : ""}`);
}

/** Who is holding the socket, or null. A file with nobody behind it is a corpse. */
function holder() {
  if (!existsSync(socket)) return null;
  try {
    const pid = execFileSync("lsof", ["-t", socket], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return Number(pid.trim().split("\n")[0]) || null;
  } catch {
    // lsof exits non-zero when nothing holds it, and is absent on some systems.
    return null;
  }
}

function uptime(pid) {
  try {
    return execFileSync("ps", ["-o", "etime=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

async function ask(path) {
  try {
    const response = await fetch(`${server}${path}`, { signal: AbortSignal.timeout(2000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

// --- the host, which is this machine's question ------------------------------

const pid = holder();
if (pid) {
  const age = uptime(pid);
  row("pty host", up("up"), `pid ${pid}${age ? `, up ${age}` : ""} · ${short(socket)}`);
} else if (existsSync(socket)) {
  row("pty host", down("stale"), `a socket with nobody behind it · ${short(socket)} — the next server clears it`);
} else {
  row("pty host", down("down"), `no socket at ${short(socket)}`);
}

// --- the server, and through it what the host is holding ---------------------

const health = await ask("/api/health");
if (!health) {
  row("server", down("down"), `nothing answered at ${server}`);
  console.log();
  console.log(
    pid
      ? dim("Your agents are still there — the host is holding them. Start a server to reach them:  bun run dev")
      : dim("Nothing is running. Start both with:  bun run dev"),
  );
  process.exit(pid ? 0 : 1);
}

row("server", up("up"), `${server}${remote ? "" : ` · dev servers ${health.devServers}`}`);

const listed = await ask("/api/agents");
const agents = listed?.agents ?? [];
const live = agents.filter((agent) => !agent.exited);
row("agents", `${agents.length}`, `${live.length} running, ${agents.length - live.length} exited`);

if (agents.length) {
  console.log();
  for (const agent of agents) {
    const name = agent.program ?? (agent.exited ? "—" : "shell");
    const state = agent.exited ? dim("exited") : agent.status === "working" ? up(agent.status) : agent.status;
    console.log(`  ${name.padEnd(10)}${String(state).padEnd(tty ? 18 : 9)}${dim(`pid ${agent.pid}`)}  ${short(agent.cwd)}`);
  }
}

if (remote) {
  console.log();
  console.log(dim("The pty host line is this machine's; that server has its own."));
}
