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
 * A server that cannot reach launchd (Linux, an ssh session outside the
 * console's) is told why, and `index.ts` spawns the host the old way and says
 * so in the record.
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
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
