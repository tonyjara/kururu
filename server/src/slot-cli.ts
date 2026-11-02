/**
 * `slot`: an agent's door into the slot queue the server holds
 * (`server/src/slots.ts`). The `ios-q` script's commands, flags, output and
 * exit codes, kept on purpose, so that a brief written for the script reads
 * the same and the script can become a two-line shim (`docs/slots.md`).
 *
 * What is not the script's is where the state is. This process holds
 * nothing: it asks the server, which keeps the line on disk, and asks again
 * at once whenever it is told "still waiting", so a server restarted under
 * `bun run dev` costs it a retry and no place in line. It knows which agent
 * it is the way the report hook does — `KURURU_AGENT_ID` in the pty's
 * environment — and the server ends the lease when that terminal exits.
 *
 * Bundled to `dist/slot.mjs` beside the server, and run as
 * `~/.local/state/kururu/bin/slot`, which the server writes on each start
 * pointing at itself; `bun run slot` from the checkout runs this file.
 *
 * Plain `node:http` rather than `fetch`, whose client gives up on a response
 * after five minutes; a take is held twenty seconds, but a sweep need not be.
 */
import { execFileSync, spawn } from "node:child_process";
import { request } from "node:http";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { isLane, LANES, parseDuration, type Lane, type Lease } from "../../shared/slots";
import { tokenHeaders } from "../localtoken.mjs";

const NAME = "slot";
/** A restart under `bun run dev` is back in seconds; a server silent this long is down. */
const DOWN_MS = 90_000;
const RETRY_MS = 1000;
/** How often a waiting take says where it is. */
const REPORT_MS = 60_000;

/** The shells and wrappers between an agent and this process, skipped when finding who the lease belongs to. */
const WRAPPERS = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "fish", "env", "nohup", "timeout", "gtimeout", "sudo", "xargs", "time",
  "caffeinate", "script", "perl", "bun", "ios-q", "ios-q.sh", "ios-lock.sh", "slot",
]);

const say = (line: string) => process.stderr.write(`${NAME}: ${line}\n`);
function die(line: string, code = 2): never {
  say(line);
  process.exit(code);
}

const port = Number(process.env.KURURU_PORT || 7717);
const agentId = process.env.KURURU_AGENT_ID || null;

function call(path: string, body: unknown | null, waitMs = 60_000): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : JSON.stringify(body);
    const headers: Record<string, string | number> = { ...tokenHeaders() };
    if (payload !== null) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(payload);
    }
    const req = request({ host: "127.0.0.1", port, path, method: payload === null ? "GET" : "POST", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown> });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: { error: text.trim() || `the server said ${res.statusCode}` } });
        }
      });
      res.on("error", reject);
    });
    req.setTimeout(waitMs, () => req.destroy(new Error("the server did not answer in time")));
    req.on("error", reject);
    req.end(payload ?? undefined);
  });
}

/** A call that rides out a server restart: retried for `DOWN_MS`, then given up on with exit 6. */
async function ask(path: string, body: unknown | null, waitMs = 60_000): Promise<Record<string, unknown>> {
  let downSince: number | null = null;
  let told = false;
  for (;;) {
    try {
      const { status, body: answer } = await call(path, body, waitMs);
      if (status >= 400) die(String(answer.error ?? `the server said ${status}`));
      return answer;
    } catch (err) {
      downSince ??= Date.now();
      if (Date.now() - downSince >= DOWN_MS) die(`no kururu server answered on :${port} (${(err as Error).message})`, 6);
      if (!told) {
        say(`the kururu server on :${port} is not answering (${(err as Error).message}); asking again once it is back`);
        told = true;
      }
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
  }
}

// ---------------------------------------------------------------------------
// Who holds it
// ---------------------------------------------------------------------------

function ps(pid: number, fields: string): string | null {
  try {
    return execFileSync("ps", ["-o", fields, "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

function pstartOf(pid: number): string | null {
  return ps(pid, "lstart=")?.replace(/\s+/g, " ") ?? null;
}

/**
 * The process a take belongs to: the first ancestor that is not a shell or a
 * wrapper. For an agent's Bash tool that is the agent itself, so the lease
 * lives as long as the agent and ends with it — and, inside kururu, with its
 * terminal, whichever goes first.
 */
function holderPid(): number {
  const given = process.env.IOS_Q_HOLDER_PID || process.env.KURURU_SLOT_HOLDER_PID;
  if (given && /^\d+$/.test(given)) return Number(given);
  let pid = process.ppid;
  for (let i = 0; i < 32 && pid > 1; i++) {
    const line = ps(pid, "ppid=,comm=");
    const m = line ? /^\s*(\d+)\s+(.+)$/.exec(line) : null;
    if (!m) break;
    const comm = basename(m[2]!.trim()).replace(/^-/, "");
    if (!WRAPPERS.has(comm)) return pid;
    pid = Number(m[1]);
  }
  return process.ppid;
}

function copyRoot(): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    try {
      return realpathSync(process.cwd());
    } catch {
      return process.cwd();
    }
  }
}

const clock = (at: number) => new Date(at).toTimeString().slice(0, 5);
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

interface TakeOpts {
  who: string | null;
  why: string | null;
  maxMs: number;
  udid: string | null;
  waitMs: number;
  pid: number | null;
  root: string | null;
  noBoot: boolean;
  command: string[];
}

function parseTake(argv: string[]): TakeOpts {
  const o: TakeOpts = { who: null, why: null, maxMs: 0, udid: null, waitMs: 0, pid: null, root: null, noBoot: false, command: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => argv[++i] ?? die(`${arg} wants a value`);
    switch (arg) {
      case "--who":
        o.who = value();
        break;
      case "--why":
        o.why = value();
        break;
      case "--max":
        o.maxMs = parseDuration(value()) ?? die("--max takes 30m, 2h, 90s");
        break;
      case "--udid":
        o.udid = value();
        break;
      case "--wait":
        o.waitMs = parseDuration(value()) ?? die("--wait takes 10m, 1h");
        break;
      case "--pid": {
        const p = value();
        if (!/^\d+$/.test(p)) die("--pid takes a process id");
        o.pid = Number(p);
        break;
      }
      case "--root":
        o.root = value();
        break;
      case "--no-boot":
        o.noBoot = true;
        break;
      case "--user-waiting":
        die("--user-waiting is not an agent's flag; Kuru calls prioritize_agent, or the orchestrator runs 'slot prioritize <who>'");
        break;
      case "--":
        o.command = argv.slice(i + 1);
        return o;
      default:
        die(`unknown option: ${arg} (see ${NAME} help)`);
    }
  }
  return o;
}

// ---------------------------------------------------------------------------
// Taking
// ---------------------------------------------------------------------------

interface Granted {
  lease: Lease;
  fingerprint: string | null;
  settings: { jobs: number; polite: boolean; ccacheConfigPath: string | null };
}

/** Wait in line, saying where every minute, until the lane is ours. Exits on a refusal with its code. */
async function takeLine(kind: "take" | "sim", lane: Lane | null, project: string | null, o: TakeOpts, holder: { pid: number }): Promise<Granted> {
  if (!o.why) die("--why <what for> is required");
  if (!o.who && !agentId) die("--who <your name or card code> is required");
  const started = Date.now();
  const deadline = o.waitMs > 0 ? started + o.waitMs : 0;
  const body = {
    kind,
    lane,
    project,
    who: o.who,
    why: o.why,
    maxMs: o.maxMs,
    udid: o.udid,
    root: o.root ?? copyRoot(),
    holder: { agentId, pid: holder.pid, pstart: pstartOf(holder.pid) },
    cliPid: process.pid,
    noBoot: o.noBoot,
    waiter: null as string | null,
  };
  let lastSaid = 0;
  for (;;) {
    const answer = await ask("/api/slots/take", body);
    if (answer.state === "granted") return answer as unknown as Granted;
    if (answer.state === "failed") {
      say(String(answer.error));
      for (const hint of (answer.hint as string[] | undefined) ?? []) say(hint);
      process.exit(Number(answer.code) || 2);
    }
    body.waiter = String(answer.waiter);
    const now = Date.now();
    if (lastSaid === 0 || now - lastSaid >= REPORT_MS) {
      lastSaid = now;
      say(`[${clock(now)}] ${String(answer.line)}`);
    }
    if (deadline && now >= deadline) {
      say(`gave up on ${kind === "sim" ? `a '${project}' simulator` : lane} after ${Math.round((now - started) / 60_000)}m (--wait)`);
      process.exit(3);
    }
  }
}

function waitedText(lease: Lease): string {
  return `until ${clock(lease.until)}`;
}

async function cmdTake(args: string[]): Promise<void> {
  const lane = args[0];
  if (!isLane(lane)) die(`take <lane>: one of ${LANES.join(" ")}`);
  const o = parseTake(args.slice(1));
  const pid = o.pid ?? holderPid();
  const got = await takeLine("take", lane, null, o, { pid });
  const { lease } = got;
  process.stdout.write(`export IOS_Q_LEASE=${q(lease.id)}\n`);
  if (lane === "build" && lease.root) {
    process.stdout.write(`export EXPO_CUSTOM_BUILD_ROOT=${q(lease.root)}\n`);
    say(`build politely: EXPO_CUSTOM_BUILD_ROOT=${lease.root} taskpolicy -c utility xcodebuild -jobs ${got.settings.jobs} … (or use '${NAME} run build')`);
  }
  say(`${lane} is yours, ${lease.who} (${waitedText(lease)})`);
  say(`release with: ${NAME} release ${lease.id}`);
}

async function cmdSim(args: string[]): Promise<void> {
  const project = args[0];
  if (!project || project.startsWith("-")) die("sim <project>: name the project");
  const o = parseTake(args.slice(1));
  const pid = o.pid ?? holderPid();
  const got = await takeLine("sim", null, project, o, { pid });
  const { lease } = got;
  const out = [
    `export IOS_Q_LEASE=${q(lease.id)}`,
    `export IOS_Q_UDID=${q(lease.udid ?? "")}`,
    `export IOS_Q_PORT=${q(String(lease.port ?? ""))}`,
    `export IOS_Q_SIM_NAME=${q(lease.name ?? "")}`,
  ];
  if (got.fingerprint) out.push(`export IOS_Q_FINGERPRINT=${q(got.fingerprint)}`);
  process.stdout.write(`${out.join("\n")}\n`);
  say(`simulator '${lease.name}' (${lease.udid}) is yours, ${lease.who}, with Metro port ${lease.port} (${waitedText(lease)}).`);
  if (got.fingerprint) say(`it carries the development build for fingerprint ${got.fingerprint}.`);
  say(`metro:  npx expo start --dev-client --port ${lease.port} --max-workers 2   (from your own copy)`);
  say(`open:   xcrun simctl openurl ${lease.udid} "<scheme>://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A${lease.port}&disableOnboarding=1"`);
  say(`reset with 'xcrun simctl terminate ${lease.udid} <bundle id>' or clearState in the flow; never shutdown or erase. Release: ${NAME} release ${lease.id}`);
}

async function release(lease: string): Promise<void> {
  try {
    await call("/api/slots/release", { lease, holder: { agentId, pid: process.pid } }, 10_000);
  } catch {
    // The server reaps a lease whose holder — this process — has gone.
  }
}

async function cmdRun(args: string[]): Promise<void> {
  const lane = args[0];
  if (!isLane(lane)) die(`run <lane>: one of ${LANES.join(" ")}`);
  const o = parseTake(args.slice(1));
  if (o.command.length === 0) die(`run ${lane} … -- <command>: the command is missing`);
  // `maestro --udid X` / `--device X` names the simulator this run drives.
  if (lane === "maestro" && !o.udid) {
    o.command.forEach((a, i) => {
      if ((a === "--udid" || a === "--device") && o.command[i + 1]) o.udid = o.command[i + 1]!;
      else if (a.startsWith("--udid=") || a.startsWith("--device=")) o.udid = a.slice(a.indexOf("=") + 1);
    });
  }
  // `run` holds the lease itself, and ends it when its command does.
  const pid = o.pid ?? process.pid;
  let signalled: NodeJS.Signals | null = null;
  const early = (sig: NodeJS.Signals) => () => process.exit(sig === "SIGINT" ? 130 : 143);
  process.once("SIGINT", early("SIGINT"));
  process.once("SIGTERM", early("SIGTERM"));
  const got = await takeLine("take", lane, null, o, { pid });
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
  const { lease, settings } = got;
  say(`${lane} is yours, ${lease.who} (${waitedText(lease)})`);
  const env: NodeJS.ProcessEnv = { ...process.env, IOS_Q_LEASE: lease.id };
  let command = [...o.command];
  if (lane === "build") {
    env.EXPO_CUSTOM_BUILD_ROOT ??= lease.root ?? copyRoot();
    if (settings.ccacheConfigPath) env.CCACHE_CONFIGPATH ??= settings.ccacheConfigPath;
    if (basename(command[0]!) === "xcodebuild") {
      if (!command.includes("-jobs")) command.push("-jobs", String(settings.jobs));
      if (!command.some((a) => a.startsWith("COMPILER_INDEX_STORE_ENABLE="))) command.push("COMPILER_INDEX_STORE_ENABLE=NO");
    }
    if (settings.polite && process.platform === "darwin") command = ["/usr/sbin/taskpolicy", "-c", "utility", ...command];
  }
  const started = Date.now();
  const child = spawn(command[0]!, command.slice(1), { stdio: "inherit", env });
  let killer: ReturnType<typeof setTimeout> | null = null;
  const stop = (sig: NodeJS.Signals) => {
    if (child.exitCode !== null) return;
    child.kill(sig);
    killer ??= setTimeout(() => child.kill("SIGKILL"), 15_000);
  };
  // Ctrl-C reaches the command through the terminal's process group; this
  // process waits for it to stop rather than leaving it running unleased.
  process.on("SIGINT", () => {
    signalled = "SIGINT";
  });
  process.on("SIGTERM", () => {
    signalled = "SIGTERM";
    say("stopping the command (SIGTERM)");
    stop("SIGTERM");
  });
  process.on("SIGHUP", () => {
    signalled = "SIGHUP";
    stop("SIGTERM");
  });
  const watchdog = setTimeout(() => {
    say(`${lane}: --max of ${Math.round((lease.until - lease.since) / 60_000)}m reached, stopping the command`);
    stop("SIGTERM");
  }, Math.max(1000, lease.until - Date.now()));
  const code = await new Promise<number>((resolve) => {
    child.on("error", (err) => {
      say(`cannot run ${command[0]}: ${err.message}`);
      resolve(127);
    });
    child.on("exit", (c, sig) => resolve(c ?? (sig === "SIGINT" ? 130 : 143)));
  });
  clearTimeout(watchdog);
  if (killer) clearTimeout(killer);
  await release(lease.id);
  say(`released ${lane} (${lease.who})`);
  if (signalled === "SIGINT") process.exit(130);
  if (signalled) process.exit(143);
  if (code !== 0) say(`${lane}: the command exited ${code} after ${Math.round((Date.now() - started) / 1000)}s`);
  process.exit(code);
}

async function cmdRelease(args: string[]): Promise<void> {
  let target: string | null = null;
  let who: string | null = null;
  let any = false;
  let pid: number | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--who") who = args[++i] ?? die("--who wants a value");
    else if (a === "--any-holder") any = true;
    else if (a === "--legacy") continue;
    else if (a === "--pid") pid = Number(args[++i]);
    else if (a.startsWith("-")) die(`unknown option: ${a}`);
    else target = a;
  }
  const answer = await ask("/api/slots/release", { lease: target, lane: null, who, anyHolder: any, holder: { agentId, pid: pid ?? holderPid() } });
  const released = (answer.released as string[] | undefined) ?? [];
  for (const line of released) say(line);
  if (!released.length) say(`nothing of yours to release${target ? ` in ${target}` : ""}`);
}

async function cmdStatus(args: string[]): Promise<void> {
  const answer = await ask("/api/slots", null);
  if (args[0] === "--json") process.stdout.write(`${JSON.stringify(answer.view)}\n`);
  else process.stdout.write(`${String(answer.text)}\n`);
}

async function cmdWho(args: string[]): Promise<void> {
  const answer = await ask(`/api/slots?who=${encodeURIComponent(args[0] ?? "")}`, null);
  process.stdout.write(`${String(answer.text)}\n`);
}

async function cmdPrioritize(args: string[], off: boolean): Promise<void> {
  let who: string | null = null;
  let ms: number | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--for") ms = parseDuration(args[++i] ?? "") ?? die("--for takes 30m, 2h");
    else if (a.startsWith("-")) die(`unknown option: ${a}`);
    else who = a;
  }
  if (!who) die(off ? "unprioritize <who>" : "prioritize <who> [--for 60m]");
  const answer = await ask("/api/slots/prioritize", { who, ms, off });
  say(String(answer.text));
}

async function cmdInstalled(args: string[]): Promise<void> {
  let udid = process.env.IOS_Q_UDID || null;
  let fingerprint: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--udid") udid = args[++i] ?? die("--udid wants a value");
    else if (a.startsWith("-")) die(`unknown option: ${a}`);
    else fingerprint = a;
  }
  if (!fingerprint || !udid) die("installed <fingerprint> [--udid U]: the udid defaults to $IOS_Q_UDID");
  const answer = await ask("/api/slots/installed", { udid, fingerprint });
  say(String(answer.text));
}

async function cmdSweep(args: string[]): Promise<void> {
  const yes = args.includes("--yes");
  const answer = await ask("/api/slots/sweep", { yes }, 15 * 60_000);
  const r = answer.report as { dry: boolean; shutdown: string[]; unavailable: boolean; derivedData: string[]; errors: string[] };
  const verb = r.dry ? "would" : "did";
  process.stdout.write(
    [
      `${r.dry ? "What the sweep would do (run with --yes to do it):" : "The sweep:"}`,
      `  shut down, idle an hour: ${r.shutdown.length ? r.shutdown.join(", ") : "none"}`,
      `  simulators whose runtime is gone: ${r.unavailable ? `${verb} delete them (xcrun simctl delete unavailable)` : "no pool, so not asked"}`,
      `  DerivedData of a workspace no longer on the disk: ${r.derivedData.length ? `\n    ${r.derivedData.join("\n    ")}` : "none"}`,
      ...r.errors.map((e) => `  error: ${e}`),
    ].join("\n") + "\n",
  );
}

function usage(): string {
  return `${NAME}: lanes for builds, simulators and tests on a shared Mac, held by the kururu server

  ${NAME} take <lane> --who <name> --why <text> [--max 30m] [--udid U] [--wait 10m] [--pid P]
        wait for a place in the lane, print it every minute, then hold it until
        'release', the end of --max, or the end of the agent that took it
  ${NAME} run <lane> --who <name> --why <text> [--max 30m] [--udid U] -- <command...>
        take, run the command, release whatever happens (exit, error, Ctrl-C)
  ${NAME} sim <project> --who <name> --why <text> [--max 60m] [--no-boot]
        lend the project's booted simulator and a Metro port; prints
        export IOS_Q_UDID=… IOS_Q_PORT=… IOS_Q_LEASE=… (use with eval)
  ${NAME} release [<lease> | <lane>] [--who <name>] [--any-holder]
  ${NAME} status [--json]    leases, waiters, priorities, load and memory
  ${NAME} who [<lane>]       who holds a lane (or every lane); "free" if nobody
  ${NAME} prioritize <who> [--for 60m]   the user is waiting on <who>. Not for agents.
  ${NAME} unprioritize <who>
  ${NAME} installed <fingerprint> [--udid U]   the development build a simulator carries
  ${NAME} sweep [--yes]      the nightly sweep: what it would do, or do it now

--who defaults to your card's code inside kururu.
lanes: build (1)  boot (1)  maestro (2; 1 per simulator)  heavy (1)  device (1)
exit: 0 granted · 2 usage · 3 gave up (--wait) · 4 no simulator · 5 would not boot · 6 no server
`;
}

const [cmd = "help", ...rest] = process.argv.slice(2);
switch (cmd) {
  case "take":
    await cmdTake(rest);
    break;
  case "run":
    await cmdRun(rest);
    break;
  case "sim":
    await cmdSim(rest);
    break;
  case "release":
    await cmdRelease(rest);
    break;
  case "status":
    await cmdStatus(rest);
    break;
  case "who":
    await cmdWho(rest);
    break;
  case "prioritize":
    await cmdPrioritize(rest, false);
    break;
  case "unprioritize":
    await cmdPrioritize(rest, true);
    break;
  case "installed":
    await cmdInstalled(rest);
    break;
  case "sweep":
    await cmdSweep(rest);
    break;
  case "reap":
    say("the kururu server reaps on its own, the moment a holder's terminal exits");
    break;
  case "version":
  case "--version":
    process.stdout.write(`${NAME} (kururu)\n`);
    break;
  case "help":
  case "-h":
  case "--help":
    process.stdout.write(usage());
    break;
  default:
    process.stderr.write(usage());
    process.exit(2);
}
