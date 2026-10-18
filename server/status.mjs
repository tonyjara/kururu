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
 * Below both, the last few lines of `lifecycle.log`, read off the disk rather
 * than asked of the server — because the time somebody most wants to know why
 * the server went away is while it is still away.
 *
 *   bun run status                    this machine
 *   bun run status http://vm:7717     a server elsewhere, host and record still local
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tokenHeaders } from "./localtoken.mjs";
import { socketHolders } from "./sockowner.mjs";

const PORT = process.env.KURURU_PORT ?? 7717;
const socket =
  process.env.KURURU_HOST_SOCK ||
  join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "kururu", "ptyhost.sock");
/** Where `server/src/lifecycle.ts` and `run.mjs` write, by the same rule. */
const lifecycle = join(
  process.env.KURURU_STATE_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "kururu"),
  "lifecycle.log",
);
/** How many lines of it to show: enough to see the last restart and what came before it. */
const RECENT = 8;

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
  // `lsof` on macOS and `ss` on Linux; nothing to ask reads as nobody, as it always did.
  return socketHolders(socket)?.[0] ?? null;
}

function uptime(pid) {
  try {
    return execFileSync("ps", ["-o", "etime=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/**
 * The last lines of the record, oldest first. Each line was written as JSON by
 * one of three processes; one that does not parse is dropped rather than
 * allowed to hide the others, which is what `parseLifecycle` does too.
 */
function recent(count) {
  let text = "";
  for (const path of [`${lifecycle}.1`, lifecycle]) {
    try {
      text += `${readFileSync(path, "utf8")}\n`;
    } catch {
      // Not written yet, or never moved aside.
    }
  }
  const events = [];
  for (const line of text.split("\n")) {
    try {
      const event = JSON.parse(line);
      if (event && typeof event.at === "string" && typeof event.why === "string") events.push(event);
    } catch {
      // Blank, or torn.
    }
  }
  return events.slice(-count);
}

/** A time that is today's as a time and anybody else's with its date. */
function when(iso) {
  const at = new Date(iso);
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  if (at.toDateString() === new Date().toDateString()) return time;
  return `${at.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

function history() {
  const events = recent(RECENT);
  console.log();
  if (!events.length) {
    row("record", dim("nothing yet"), short(lifecycle));
    return;
  }
  row("record", "", short(lifecycle));
  const width = Math.max(...events.map((event) => when(event.at).length)) + 2;
  for (const event of events) {
    const bad = event.what === "crash" || event.what === "down" || event.what === "orphaned";
    const what = String(event.what ?? "").padEnd(10);
    console.log(`  ${dim(when(event.at).padEnd(width))}${String(event.by ?? "").padEnd(8)}${bad ? down(what) : what}${event.why}`);
    if (event.error && !event.why.includes(event.error)) console.log(`  ${" ".repeat(width + 18)}${dim(event.error)}`);
  }
}

async function ask(path) {
  try {
    // This machine's token for this machine's server, and never for one named on the line.
    const response = await fetch(`${server}${path}`, { headers: remote ? {} : tokenHeaders(), signal: AbortSignal.timeout(2000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

/**
 * Whether launchd started the host, which is whether it has a coalition of its
 * own, from `launchctl list`. A host started any other way shares the coalition
 * of the app that started it, and a Force Quit of that app — including the one
 * the Dock does when you quit a tile whose process has gone — ends it and every
 * agent. That is invisible until it happens, so it is printed: see
 * `server/src/hostlaunch.ts` and its label prefix, which this matches.
 */
function launchedByLaunchd(pid) {
  if (process.platform !== "darwin") return null;
  try {
    const list = execFileSync("launchctl", ["list"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return list.split("\n").some((line) => {
      const [first, , label] = line.trim().split(/\s+/);
      return first === String(pid) && Boolean(label?.startsWith("io.github.tonyjara.kururu.ptyhost."));
    });
  } catch {
    return null;
  }
}

/**
 * The Linux half of the same question: the systemd unit the host is in, from
 * `/proc/<pid>/cgroup`, read the way `cgroupUnit` in `server/src/hostlaunch.ts`
 * reads it. A host the user manager started is in a `kururu-ptyhost-…` unit
 * of its own; one spawned the old way is in the server's, and stopping that
 * unit ends it and every agent.
 */
function unitOf(pid) {
  if (process.platform !== "linux") return undefined;
  try {
    for (const line of readFileSync(`/proc/${pid}/cgroup`, "utf8").split("\n")) {
      const [, controllers, ...rest] = line.split(":");
      if (controllers !== "" && controllers !== "name=systemd") continue;
      const unit = rest.join(":").split("/").reverse().find((part) => part.endsWith(".service") || part.endsWith(".scope"));
      if (unit) return unit;
    }
    return null;
  } catch {
    return undefined;
  }
}

// --- the host, which is this machine's question ------------------------------

const pid = holder();
if (pid) {
  const age = uptime(pid);
  row("pty host", up("up"), `pid ${pid}${age ? `, up ${age}` : ""} · ${short(socket)}`);
  const own = launchedByLaunchd(pid);
  if (own === true) row("coalition", up("its own"), "started by launchd — no app quitting or force-quitting reaches it");
  if (own === false) {
    row(
      "coalition",
      down("shared"),
      "started inside an app's — a Force Quit of that app, or of a tile an agent's app left behind, ends every agent; the next host start moves it out",
    );
  }
  const unit = unitOf(pid);
  if (unit !== undefined && /^kururu-ptyhost-[0-9a-z]+-\d+\.service$/.test(unit ?? "")) {
    row("unit", up(unit.replace(/\.service$/, "")), "a transient systemd user unit — stopping or restarting the server's unit reaches nobody in it");
  } else if (unit !== undefined) {
    row(
      "unit",
      down("shared"),
      `in ${unit ?? "no unit at all"} — stopping or restarting that ends every agent; the next host start moves it into one of its own`,
    );
  }
} else if (existsSync(socket)) {
  row("pty host", down("stale"), `a socket with nobody behind it · ${short(socket)} — the next server clears it`);
} else {
  row("pty host", down("down"), `no socket at ${short(socket)}`);
}

// --- the server, and through it what the host is holding ---------------------

const health = await ask("/api/health");
if (!health) {
  row("server", down("down"), `nothing answered at ${server}`);
  history();
  console.log();
  console.log(
    pid
      ? dim("Your agents are still there — the host is holding them. Start a server to reach them:  bun run dev")
      : dim("Nothing is running. Start both with:  bun run dev"),
  );
  process.exit(pid ? 0 : 1);
}

const since = health.life?.startedAt ? ` · since ${when(health.life.startedAt)}` : "";
row("server", up("up"), `${server}${since}${remote ? "" : ` · dev servers ${health.devServers}`}`);
// A server that has lost its runner looks exactly like one that has not, until
// a save fails to restart it — which is the whole reason to say it here.
if (health.life?.orphaned) {
  row("supervisor", down("gone"), "saves will not restart this server and prefix+B is refused — restart `bun run dev`");
}
// The host keeps the bundle it started with, so a server can be ahead of it —
// silently, unless the handshake said so and somebody prints it. Only when it
// is behind: a current host is the normal state and not worth a line.
if (health.host && !health.host.current) {
  row(
    "host build",
    down("behind"),
    `speaks protocol ${health.host.protocol}, older than this server — restart the host to update it, which ends every agent`,
  );
}

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

history();

if (remote) {
  console.log();
  console.log(dim("The pty host and the record are this machine's; that server has its own."));
}
