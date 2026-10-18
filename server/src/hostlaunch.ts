/**
 * Starting the pty host so that no app's ending is its ending.
 *
 * macOS puts every process in a *coalition*, and a child is born into its
 * parent's. A host spawned the obvious way — detached, its own session,
 * unref'd — is nobody's child in the process tree and is still a member of the
 * coalition of whatever app started the chain: the Kururu app, the terminal
 * `bun run dev` was typed into, the dev shell. `setsid` does not leave it, and
 * nothing a process can do for itself does. The coalition also outlives its
 * app, which is the half that matters.
 *
 * That is what ended every agent twice on 2026-10-10. A Dock "Quit" on an app
 * whose process has already gone is a force quit, and a force quit ends the
 * app's whole coalition. At 07:03 Ghostty had exited with a `bun run dev` host
 * still in its coalition, its tile stayed in the Dock because of it, and
 * quitting that tile ended the host and 15 agents. At 23:10 the tile was an
 * Electron that an agent had launched inside the coalition of a Kururu app quit
 * hours before: an "Electron" with the stock icon that looked like an agent's
 * leftover test, and was, and quitting it ended the host and 12 agents. The
 * unified log has both (`Calling force quit asn=…` from the Dock, the host's
 * SIGTERM in the same second) and `docs/gotchas.md` has the reading of it.
 *
 * So the host is started by launchd, as a job of its own. launchd gives every
 * job a coalition, the host is its first member, and the apps it is descended
 * from can quit or be force-quit without reaching it. A GUI app an agent
 * launches joins the host's coalition the way an app typed into Terminal joins
 * Terminal's, and its tile goes when it quits because the coalition's first
 * member is still there. Both were checked before this was written, with a
 * probe job launching an Electron that quit itself: no tile left, either way.
 *
 * The job is `RunAtLoad` and has no `KeepAlive`. A host that was stopped stays
 * stopped, so `kill-ptyhosts` and `POST /api/host/restart` keep meaning what
 * they say, and the next server starts the next host exactly as now.
 * `ProcessType` is `Interactive` because launchd throttles a job's CPU and IO
 * otherwise, and every agent and every build it runs would inherit that.
 * Labels are new on each start, so a job that is running is never one this
 * file has to bootstrap over. Stale ones (loaded, not running) are booted out
 * first, which ends nothing because nothing is running in them.
 *
 * A server that cannot reach launchd (an ssh session outside the console's)
 * is told why, and `index.ts` spawns the host the old way and says so in the
 * record.
 *
 * **Linux has the same problem under another name.** A child kururu runs as a
 * systemd user service, and systemd keeps every process a service starts in
 * the service's cgroup, detached or not: `systemctl --user restart kururu`
 * would end the host with the server and every agent with it, exactly as the
 * Dock did. The answer is the same shape, too. The host is handed to the user
 * manager as a transient unit of its own (`systemd-run --user`), so its
 * cgroup is its own and stopping the server's unit reaches nobody in it. See
 * `launchHostSystemd` for each property and why.
 *
 * Electron run as node prints a `task_name_for_pid … failure (5)` line into
 * `ptyhost.log` when it starts this way. It is Electron asking about its
 * parent, which is now launchd, and it is harmless.
 *
 * **The runtime is kururu's own copy.** The host used to run on whatever
 * binary the server had: `release/mac-arm64/Kururu.app`, which every
 * `dist:unsigned` deletes and rebuilds; `node_modules/electron`, which every
 * `bun install` replaces; or the system node. A host outlives all of those by
 * design, so it was left running on a binary that no longer existed, under a
 * name and an icon that said nothing about it. Now, when there is a Kururu.app
 * to start from, the bundle is cloned under `runtime/` beside the socket and
 * the host runs from the clone. On APFS `cp -c` makes the clone in a third of
 * a second and costs no space while the original is there. The bytes are the
 * same, so the code signature is the same and so is what macOS's privacy
 * settings have already granted (a pty under a cloned host was checked
 * reading `~/Desktop`). Which bundle is cloned, and why the order matters to
 * those privacy settings, is `sourceBundle`'s; the plain binary is used only
 * when there is no bundle at all. Clones nothing is running from are removed
 * whenever a new one is made.
 */
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { bundleOf } from "./proctitle";

/** Every host job's label starts with this, and nothing else's does. */
export const HOST_LABEL_PREFIX = "io.github.tonyjara.kururu.ptyhost.";

/** The packaged app's id. The dev shell's is `.dev`, and is not one this will run a host on. */
const APP_ID = "io.github.tonyjara.kururu";

/** Where a Kururu.app is looked for when the server is not running on one. */
const INSTALLED = ["/Applications/Kururu.app", join(homedir(), "Applications", "Kururu.app")];

/**
 * Variables that describe how the *server* was launched and are wrong for a
 * process launchd starts: launchd sets its own `XPC_*` for the job, and
 * `__CFBundleIdentifier` would have the host claim to be the app.
 */
const LAUNCH_ONLY = ["XPC_SERVICE_NAME", "XPC_FLAGS", "__CFBundleIdentifier"];

/**
 * Variables that are the *server's* business and nobody else's, kept out of
 * the host because the host's environment is every pty's. The runner's
 * `KURURU_SUPERVISED` in an agent's shell made any server that agent started
 * believe it had a supervisor it did not have; `KURURU_BIND`, the token's
 * switch and the server's own paths would hand a kururu started inside a tab
 * this one's network and files. What the host itself reads stays:
 * `KURURU_PORT`, `KURURU_HOST_SOCK`, `KURURU_STATE_DIR` and the agent
 * defaults. `KURURU_TOKEN` is handed to each pty on its own, while it is
 * wanted (`access.ts`), never through the host's environment.
 */
const SERVER_ONLY = [
  "KURURU_SUPERVISED",
  "KURURU_STARTED_BECAUSE",
  "KURURU_RUNNER_LABEL",
  "KURURU_BIND",
  "KURURU_LOOPBACK_TOKEN",
  "KURURU_TOKEN",
  "KURURU_AGENT_ID",
  "KURURU_WEB_DIST",
  "KURURU_ASSETS",
  "KURURU_SOUNDS",
  "KURURU_PTYHOSTD",
];

/** The environment a host is started with: the server's, less what is the server's alone. Pure, for the test. */
export function hostEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) if (!SERVER_ONLY.includes(key)) out[key] = value;
  return out;
}

/** A clone is a third of a second; a minute is a disk that is not APFS doing a real copy, or a hang. */
const CLONE_TIMEOUT_MS = 60_000;
const LAUNCHCTL_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Pure: what the job is, and what launchd says
// ---------------------------------------------------------------------------

/** XML 1.0 has no spelling for most control characters, so they are dropped rather than escaped. */
function xml(text: string): string {
  return text
    .replace(/[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export interface HostJob {
  label: string;
  /** The runtime first, then the entry. */
  program: string[];
  env: Record<string, string>;
  cwd: string;
  /** stdout and stderr both, as `ptyhost.log` always was. */
  log: string;
}

/** The plist launchd is handed. Keys sorted where order is free, so two starts can be diffed. */
export function hostJobPlist(job: HostJob): string {
  const string = (value: string) => `<string>${xml(value)}</string>`;
  const env = Object.keys(job.env)
    .sort()
    .map((key) => `\t\t<key>${xml(key)}</key>\n\t\t${string(job.env[key]!)}`)
    .join("\n");
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `\t<key>Label</key>\n\t${string(job.label)}`,
    `\t<key>ProgramArguments</key>\n\t<array>\n${job.program.map((arg) => `\t\t${string(arg)}`).join("\n")}\n\t</array>`,
    `\t<key>EnvironmentVariables</key>\n\t<dict>\n${env}\n\t</dict>`,
    `\t<key>WorkingDirectory</key>\n\t${string(job.cwd)}`,
    `\t<key>StandardOutPath</key>\n\t${string(job.log)}`,
    `\t<key>StandardErrorPath</key>\n\t${string(job.log)}`,
    `\t<key>RunAtLoad</key>\n\t<true/>`,
    `\t<key>KeepAlive</key>\n\t<false/>`,
    `\t<key>ProcessType</key>\n\t<string>Interactive</string>`,
    `\t<key>AbandonProcessGroup</key>\n\t<true/>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

/**
 * Host jobs launchd still has loaded with nothing running in them, from
 * `launchctl list`: `PID  Status  Label`, with `-` for a pid when the job is
 * not running. Those are the only ones safe to boot out — booting out a
 * running job sends its process SIGTERM.
 */
export function staleHostJobs(list: string): string[] {
  const stale: string[] = [];
  for (const line of list.split("\n")) {
    const [pid, , label] = line.trim().split(/\s+/);
    if (pid === "-" && label?.startsWith(HOST_LABEL_PREFIX)) stale.push(label);
  }
  return stale;
}

/** Whether `pid` is running as one of our host jobs, from the same `launchctl list`. */
export function isHostJob(list: string, pid: number): boolean {
  return list.split("\n").some((line) => {
    const [first, , label] = line.trim().split(/\s+/);
    return first === String(pid) && Boolean(label?.startsWith(HOST_LABEL_PREFIX));
  });
}

/** The pid of a running job, from `launchctl print`. */
export function jobPid(print: string): number | null {
  const found = /^\tpid = (\d+)$/m.exec(print);
  return found ? Number(found[1]) : null;
}

/** `path` moved from under `from` to the same place under `to`, or unchanged when it is not under `from`. */
export function remapInto(path: string, from: string, to: string): string {
  return path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path;
}

// ---------------------------------------------------------------------------
// The runtime
// ---------------------------------------------------------------------------

function plistValue(plist: string, key: string): string | null {
  try {
    return execFileSync("plutil", ["-extract", key, "raw", "-o", "-", plist], {
      encoding: "utf8",
      timeout: LAUNCHCTL_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * The bundle this host may run a copy of.
 *
 * The one the server is on comes first — the app around the helper it runs
 * on, since that is where the app starts it (`proctitle.ts`) — and not only
 * because it is the build being run: launchd makes the host its own *responsible process*, so what
 * macOS's privacy settings allow every agent is what they allow this binary.
 * The server's own build is the one whose grants the agents had until now,
 * and a copy of it has them still. An installed Kururu.app comes next, for a
 * server on node or on the dev shell; if nobody has let it into `~/Desktop`
 * yet, the first host it runs asks once and waits for the answer. The dev
 * shell is last, and only from a copy, so a `bun install` cannot take it out
 * from under a host.
 */
function sourceBundle(execPath: string): string | null {
  const id = (bundle: string) => plistValue(join(bundle, "Contents", "Info.plist"), "CFBundleIdentifier");
  const own = bundleOf(execPath);
  const ownId = own && existsSync(own) ? id(own) : null;
  if (own && ownId === APP_ID) return own;
  for (const bundle of INSTALLED) {
    if (existsSync(bundle) && id(bundle) === APP_ID) return bundle;
  }
  if (own && ownId === `${APP_ID}.dev`) return own;
  return null;
}

/**
 * Which build of the bundle this is, as far as a copy of it is concerned. Its
 * path, and the times and sizes of the three things a rebuild always rewrites.
 * Two builds of one version are different runtimes, and that is the case
 * `dist:unsigned` makes all day.
 */
function fingerprint(bundle: string, exe: string): string {
  const stamp = (path: string) => {
    const info = statSync(path);
    return [info.mtimeMs, info.size];
  };
  const parts = [bundle, stamp(join(bundle, "Contents", "Info.plist")), stamp(exe), stamp(join(bundle, "Contents", "Resources"))];
  return createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 10);
}

/** Whether anything is running from `exe`. `lsof` exits 1 having found nobody; anything else unexpected counts as yes. */
function inUse(exe: string): boolean {
  const done = spawnSync("lsof", ["-t", exe], { encoding: "utf8", timeout: LAUNCHCTL_TIMEOUT_MS });
  return !(done.status === 1 && !done.stdout.trim());
}

/**
 * Remove every clone but `keep` that nothing runs from. A clone holds no space
 * while its original exists and all of it once a rebuild deletes the original,
 * so the ones from last week's builds are worth taking back. Never one in use:
 * that is a host, and its binary is the one thing this exists to keep.
 */
function sweep(root: string, keep: string): void {
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    if (dir === keep) continue;
    // A clone another server is still making: rename makes it whole, and an hour is long past any clone.
    if (name.startsWith(".tmp-") && Date.now() - statSync(dir).mtimeMs < 3_600_000) continue;
    const app = join(dir, "Kururu.app");
    const executable = existsSync(app) ? plistValue(join(app, "Contents", "Info.plist"), "CFBundleExecutable") : null;
    if (executable && inUse(join(app, "Contents", "MacOS", executable))) continue;
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface Runtime {
  /** The binary to run the host on. */
  exe: string;
  /** The entry, moved into the clone when it was inside the bundle that was cloned. */
  entry: string;
  /** What the record says about it. */
  note: string;
}

/**
 * The binary the host runs on, and the entry it runs, for a host that is about
 * to be started.
 *
 * In a packaged app the entry is in `Resources/server` beside the node-pty its
 * spawns need, so it moves into the clone with the binary; from a checkout it
 * is the checkout's, as before. The binary is the clone's main one and never
 * its helper, though the server itself runs on a helper: the host is its own
 * responsible process, and the main binary is the one macOS's privacy settings
 * know. It goes unnamed for that rather than take a Dock tile (`proctitle.ts`).
 *
 * Any failure gives back what the host ran on before this existed, with the
 * reason, because a host on the old binary is much better than no host.
 */
export function hostRuntime(execPath: string, entry: string, dir: string): Runtime {
  if (process.platform !== "darwin") return { exe: execPath, entry, note: "" };
  try {
    const source = sourceBundle(execPath);
    if (!source) return { exe: execPath, entry, note: `on ${basename(execPath)}, with no Kururu.app to copy` };
    const executable = plistValue(join(source, "Contents", "Info.plist"), "CFBundleExecutable") ?? "Kururu";
    const version = plistValue(join(source, "Contents", "Info.plist"), "CFBundleShortVersionString") ?? "0";
    const root = join(dir, "runtime");
    const home = join(root, `${version}-${fingerprint(source, join(source, "Contents", "MacOS", executable))}`);
    const app = join(home, "Kururu.app");
    if (!existsSync(join(app, "Contents", "MacOS", executable))) {
      mkdirSync(root, { recursive: true });
      const scratch = join(root, `.tmp-${process.pid}-${Date.now()}`);
      mkdirSync(scratch);
      try {
        execFileSync("cp", ["-c", "-R", source, join(scratch, "Kururu.app")], { timeout: CLONE_TIMEOUT_MS, stdio: "ignore" });
        renameSync(scratch, home);
      } catch (err) {
        rmSync(scratch, { recursive: true, force: true });
        // Another server made the same clone first, which is as good as making it.
        if (!existsSync(join(app, "Contents", "MacOS", executable))) throw err;
      }
    }
    try {
      sweep(root, home);
    } catch {
      // A clone left behind is space, not a fault.
    }
    return {
      exe: join(app, "Contents", "MacOS", executable),
      entry: remapInto(entry, source, app),
      note: `on a copy of ${source}`,
    };
  } catch (err) {
    return { exe: execPath, entry, note: `on ${basename(execPath)}, because copying Kururu.app failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

function launchctl(args: string[]): string {
  const done = spawnSync("launchctl", args, { encoding: "utf8", timeout: LAUNCHCTL_TIMEOUT_MS });
  if (done.error) throw done.error;
  if (done.status !== 0) {
    const said = `${done.stderr ?? ""}${done.stdout ?? ""}`.trim().split("\n")[0];
    throw new Error(`launchctl ${args[0]}: ${said || `exited ${done.status}`}`);
  }
  return done.stdout;
}

function domain(): string {
  return `gui/${process.getuid!()}`;
}

/**
 * Whether the job is still running, which is what tells a host that is slow to
 * listen from one that has died. Slow is a real case: a host whose runtime
 * macOS has not yet allowed into a protected folder blocks in `open()` until
 * somebody answers the prompt, and the checkout is under `~/Desktop`.
 */
export function hostJobRunning(label: string): boolean {
  if (label.startsWith(HOST_UNIT_PREFIX)) return hostUnitRunning(label);
  try {
    return /^\tstate = running$/m.test(launchctl(["print", `${domain()}/${label}`]));
  } catch {
    return false;
  }
}

/** Whether `pid` is a host launchd started, which is to say one in a coalition of its own. */
export function launchedByLaunchd(pid: number): boolean {
  if (process.platform !== "darwin") return false;
  try {
    return isHostJob(launchctl(["list"]), pid);
  } catch {
    return false;
  }
}

export interface LaunchedHost {
  label: string;
  /** Null when launchd had not got round to it in the time allowed; the socket is what the caller waits on anyway. */
  pid: number | null;
}

/**
 * Hand the host to launchd and return once it has been started.
 *
 * The plist is bootstrapped from a file of its own and then renamed to
 * `ptyhost.plist`, which is kept: it is the one place that says exactly how the
 * running host was started, and a fixed name would let two servers starting
 * at once bootstrap each other's.
 */
export async function launchHost(runtime: Runtime, options: { dir: string; log: string; cwd: string; env: NodeJS.ProcessEnv }): Promise<LaunchedHost> {
  if (process.platform !== "darwin") throw new Error("launchd is macOS's");
  const label = `${HOST_LABEL_PREFIX}${Date.now().toString(36)}.${process.pid}`;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.env)) {
    if (value !== undefined && !LAUNCH_ONLY.includes(key)) env[key] = value;
  }
  // Harmless under node, and the one thing that makes the host a node rather
  // than a second Kururu window when the runtime is Electron.
  env.ELECTRON_RUN_AS_NODE = "1";

  try {
    for (const stale of staleHostJobs(launchctl(["list"]))) {
      try {
        launchctl(["bootout", `${domain()}/${stale}`]);
      } catch {
        // Gone already, or never ours to remove.
      }
    }
  } catch {
    // A list that failed is a bootstrap that will fail, and say so better.
  }

  const file = join(options.dir, `ptyhost.${label.slice(HOST_LABEL_PREFIX.length)}.plist`);
  writeFileSync(file, hostJobPlist({ label, program: [runtime.exe, runtime.entry], env, cwd: options.cwd, log: options.log }), { mode: 0o600 });
  try {
    launchctl(["bootstrap", domain(), file]);
  } catch (err) {
    try {
      unlinkSync(file);
    } catch {
      // Nothing to tidy.
    }
    throw err;
  }
  try {
    renameSync(file, join(options.dir, "ptyhost.plist"));
  } catch {
    // The record of how it started, not the start.
  }

  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const pid = jobPid(launchctl(["print", `${domain()}/${label}`]));
      if (pid) return { label, pid };
    } catch {
      // Not printable yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { label, pid: null };
}

// ---------------------------------------------------------------------------
// Linux: a transient systemd user unit
// ---------------------------------------------------------------------------

/** Every host unit's name starts with this, and nothing else's does. */
export const HOST_UNIT_PREFIX = "kururu-ptyhost-";

const SYSTEMCTL_TIMEOUT_MS = 10_000;

/**
 * Variables the server's own unit was given by systemd, which describe that
 * unit and would be lies inside another: the user manager sets its own for
 * the host's. `NOTIFY_SOCKET` and `LISTEN_*` most of all, since a host that
 * inherited them would be answering for the server's unit.
 */
const SYSTEMD_ONLY = [
  "INVOCATION_ID",
  "JOURNAL_STREAM",
  "SYSTEMD_EXEC_PID",
  "MANAGERPID",
  "NOTIFY_SOCKET",
  "LISTEN_PID",
  "LISTEN_FDS",
  "LISTEN_FDNAMES",
  "WATCHDOG_PID",
  "WATCHDOG_USEC",
  "MONITOR_SERVICE_RESULT",
  "MONITOR_EXIT_CODE",
  "MONITOR_EXIT_STATUS",
];

/**
 * A unit name for a host started now by `pid`: the prefix, the time in base
 * 36 and the pid, so two servers starting at once cannot ask for the same
 * name. What `systemd-run --unit=` is given; systemd adds `.service`.
 */
export function hostUnitName(now: number, pid: number): string {
  return `${HOST_UNIT_PREFIX}${now.toString(36)}-${pid}`;
}

/** Whether a unit name, with or without its `.service`, is one `hostUnitName` made. */
export function isHostUnit(name: string | null | undefined): boolean {
  return typeof name === "string" && /^kururu-ptyhost-[0-9a-z]+-\d+(\.service)?$/.test(name);
}

/**
 * The variables the unit is given, by name. systemd refuses a whole start
 * over one assignment it cannot carry — a name that is not one, a value with
 * a control character other than a tab or a newline — so those are left out
 * here rather than costing the host. Sorted, so two starts can be diffed.
 */
export function unitEnvNames(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter((key) => {
      const value = env[key];
      if (value === undefined || SYSTEMD_ONLY.includes(key) || LAUNCH_ONLY.includes(key)) return false;
      return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value);
    })
    .sort();
}

/**
 * The `systemd-run` command line for a host unit. Pure, for the test.
 *
 * Each property is a decision:
 *
 * - `--user`, so the user manager owns it — the one that keeps running with
 *   linger on when nobody is logged in, which a child depends on anyway.
 * - `--collect`, so a host that exited badly is not left as a failed unit to
 *   trip the next name; the record and `ptyhost.log` are where how it ended
 *   is read, as on the Mac.
 * - `Type=exec`, so `systemd-run` fails when the runtime cannot be executed
 *   rather than reporting a start that never happened.
 * - `KillMode=process`: stopping the unit signals the host and nobody else.
 *   The host reaps its own ptys on SIGTERM, which is what `kill-ptyhosts`
 *   and `/api/host/restart` rely on; systemd sweeping the cgroup behind it
 *   would be a second, cruder answer to the same question.
 * - `OOMPolicy=continue`. The default stops the whole unit when the kernel's
 *   OOM killer takes any process in it, and every agent's build and test run
 *   is in this cgroup: one runaway `bun test` would end every agent. With
 *   this the kernel takes the process it chose and nothing else.
 * - stdout and stderr appended to `ptyhost.log`, which is where every host
 *   has written and where `lifecycle.ts` reads how the last one ended.
 *
 * The environment goes by name only, `--setenv=NAME`, and `systemd-run` reads
 * each value out of its own environment. So no value is ever on a command
 * line, where any user on the box could read it in `/proc` for as long as the
 * start takes; it travels to the user manager over its private bus.
 */
export function systemdRunArgv(unit: string, job: { program: string[]; envNames: string[]; cwd: string; log: string }): string[] {
  return [
    "--user",
    `--unit=${unit}`,
    "--description=kururu pty host",
    "--collect",
    "--quiet",
    "--property=Type=exec",
    "--property=KillMode=process",
    "--property=OOMPolicy=continue",
    `--property=StandardOutput=append:${job.log}`,
    `--property=StandardError=append:${job.log}`,
    `--working-directory=${job.cwd}`,
    ...job.envNames.map((name) => `--setenv=${name}`),
    "--",
    ...job.program,
  ];
}

/**
 * The unit a process is in, from `/proc/<pid>/cgroup`: the last `.service` or
 * `.scope` on its path. cgroup v2 has one line, `0::/user.slice/…/app.slice/
 * kururu-ptyhost-mgk3z9-4410.service`; a hybrid v1 machine has one per
 * controller, and only the `name=systemd` one is read. Pure, for the test.
 */
export function cgroupUnit(text: string): string | null {
  for (const line of text.split("\n")) {
    const [, controllers, ...rest] = line.split(":");
    // Only the unified line or systemd's own: a v1 controller's hierarchy
    // can stop at `user@1000.service`, which is the manager and not the unit.
    if (controllers !== "" && controllers !== "name=systemd") continue;
    const path = rest.join(":");
    const unit = path.split("/").reverse().find((part) => part.endsWith(".service") || part.endsWith(".scope"));
    if (unit) return unit;
  }
  return null;
}

function systemctl(args: string[]): string {
  const done = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8", timeout: SYSTEMCTL_TIMEOUT_MS });
  if (done.error) throw done.error;
  return done.stdout ?? "";
}

/** The unit `pid` is in, or null: not Linux, gone, or not in one. */
export function unitOf(pid: number): string | null {
  if (process.platform !== "linux") return null;
  try {
    return cgroupUnit(readFileSync(`/proc/${pid}/cgroup`, "utf8"));
  } catch {
    return null;
  }
}

/** Whether `pid` is a host the user manager started, which is to say one in a cgroup of its own. */
export function launchedBySystemd(pid: number): boolean {
  return isHostUnit(unitOf(pid));
}

/** Whether a host unit is still running, or starting; `hostJobRunning`'s question, asked of systemd. */
export function hostUnitRunning(unit: string): boolean {
  try {
    const state = systemctl(["is-active", unit]).trim();
    return state === "active" || state === "activating";
  } catch {
    return false;
  }
}

/**
 * The runtime directory to give `systemd-run`, when the environment names no
 * way to the user manager. It needs `XDG_RUNTIME_DIR` or
 * `DBUS_SESSION_BUS_ADDRESS`, and a server started by hand from a stripped
 * environment can have neither: Tailscale SSH sets the bus and not the
 * directory, and the spike on the Omarchy PC found that either is enough
 * while none fails. A unit under the user manager has both. So the
 * directory every logind machine makes for the user is named when it is
 * there, and nothing is invented when it is not. Pure, for the test.
 */
export function userRuntimeDir(env: NodeJS.ProcessEnv, uid: number | null, exists: (path: string) => boolean): string | null {
  if (env.XDG_RUNTIME_DIR || env.DBUS_SESSION_BUS_ADDRESS || uid === null) return null;
  const dir = `/run/user/${uid}`;
  return exists(dir) ? dir : null;
}

/**
 * Hand the host to the user manager and return once it has been started.
 *
 * Refused up front on a machine not booted with systemd, where the fallback
 * in `index.ts` is the whole of the answer; anything `systemd-run` says when
 * it refuses — no user bus in an ssh session without `pam_systemd`, most
 * likely — comes back as the reason.
 */
export async function launchHostSystemd(runtime: Runtime, options: { log: string; cwd: string; env: NodeJS.ProcessEnv }): Promise<LaunchedHost> {
  if (process.platform !== "linux") throw new Error("systemd is Linux's");
  if (!existsSync("/run/systemd/system")) throw new Error("this machine was not booted with systemd");
  const unit = hostUnitName(Date.now(), process.pid);
  // Harmless under node, and the one thing that makes the host a node rather
  // than a window when the runtime is Electron — as under launchd.
  const env: NodeJS.ProcessEnv = { ...options.env, ELECTRON_RUN_AS_NODE: "1" };
  const runtimeDir = userRuntimeDir(env, process.getuid?.() ?? null, existsSync);
  if (runtimeDir) env.XDG_RUNTIME_DIR = runtimeDir;
  const argv = systemdRunArgv(unit, { program: [runtime.exe, runtime.entry], envNames: unitEnvNames(env), cwd: options.cwd, log: options.log });
  const done = spawnSync("systemd-run", argv, { encoding: "utf8", env, timeout: SYSTEMCTL_TIMEOUT_MS });
  if (done.error) throw done.error;
  if (done.status !== 0) {
    const said = `${done.stderr ?? ""}${done.stdout ?? ""}`.trim().split("\n")[0];
    throw new Error(`systemd-run: ${said || `exited ${done.status}`}`);
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const pid = Number(systemctl(["show", "--property=MainPID", "--value", unit]).trim());
      if (Number.isInteger(pid) && pid > 0) return { label: unit, pid };
    } catch {
      // Not answering yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { label: unit, pid: null };
}
