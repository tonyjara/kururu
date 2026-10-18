/**
 * Starting the host through launchd: the pure half. What the job says, what
 * `launchctl` says back, and where a runtime lives. The `launchctl list` and
 * `print` samples are the shapes macOS 26 printed for the probe jobs this was
 * built against.
 *
 * And the same for Linux, where the host is a transient systemd user unit:
 * the `systemd-run` command line, the unit-name grammar, and the reading of
 * `/proc/<pid>/cgroup` that says whether a host is in a unit of its own. The
 * cgroup samples are the shapes systemd's unified and hybrid hierarchies
 * write.
 */
import { describe, expect, test } from "bun:test";
import {
  HOST_LABEL_PREFIX,
  HOST_UNIT_PREFIX,
  cgroupUnit,
  hostEnv,
  hostJobPlist,
  hostUnitName,
  isHostJob,
  isHostUnit,
  jobPid,
  remapInto,
  staleHostJobs,
  systemdRunArgv,
  unitEnvNames,
  userRuntimeDir,
} from "../src/hostlaunch";

const LIST = [
  "PID\tStatus\tLabel",
  "-\t0\tcom.apple.SafariHistoryServiceAgent",
  `-\t0\t${HOST_LABEL_PREFIX}mgk3a1.7813`,
  `7845\t0\t${HOST_LABEL_PREFIX}mgk3z9.53271`,
  `-\t-15\t${HOST_LABEL_PREFIX}mgk2b2.4410`,
  "37999\t0\tapplication.io.github.tonyjara.kururu.976902087.976902090",
  "-\t0\tio.github.tonyjara.kururu.probe",
].join("\n");

describe("staleHostJobs", () => {
  test("is every host job that is loaded with nothing running in it", () => {
    expect(staleHostJobs(LIST)).toEqual([`${HOST_LABEL_PREFIX}mgk3a1.7813`, `${HOST_LABEL_PREFIX}mgk2b2.4410`]);
  });

  test("never names a running one, which booting out would end", () => {
    expect(staleHostJobs(LIST)).not.toContain(`${HOST_LABEL_PREFIX}mgk3z9.53271`);
  });

  test("never names a job that is not a host's, kururu's or anybody's", () => {
    const stale = staleHostJobs(LIST);
    expect(stale.some((label) => !label.startsWith(HOST_LABEL_PREFIX))).toBe(false);
  });

  test("is empty for an empty or failed list", () => {
    expect(staleHostJobs("")).toEqual([]);
  });
});

describe("isHostJob", () => {
  test("is a pid running under a host label", () => {
    expect(isHostJob(LIST, 7845)).toBe(true);
  });

  test("is not the app, nor a pid that only appears in another column", () => {
    expect(isHostJob(LIST, 37999)).toBe(false);
    expect(isHostJob(LIST, 0)).toBe(false);
    expect(isHostJob(LIST, 15)).toBe(false);
  });
});

describe("jobPid", () => {
  test("reads the pid out of launchctl print", () => {
    const print = [
      `gui/501/${HOST_LABEL_PREFIX}mgk3z9.53271 = {`,
      "\tactive count = 1",
      "\tpath = /Users/me/.local/state/kururu/ptyhost.mgk3z9.53271.plist",
      "\ttype = LaunchAgent",
      "\tstate = running",
      "",
      "\tprogram = /Users/me/.local/state/kururu/runtime/0.3.0-1a2b3c4d5e/Kururu.app/Contents/MacOS/Kururu",
      "\tpid = 19330",
      "\tlast exit code = (never exited)",
      "\tresource coalition = {",
      "\t\tID = 122399",
      "\t}",
      "}",
    ].join("\n");
    expect(jobPid(print)).toBe(19330);
  });

  test("is null for a job that is not running", () => {
    expect(jobPid("\tstate = not running\n\tlast exit code = 0\n")).toBeNull();
  });
});

describe("remapInto", () => {
  test("moves a path inside the bundle into the copy", () => {
    expect(remapInto("/Applications/Kururu.app/Contents/Resources/server/ptyhostd.mjs", "/Applications/Kururu.app", "/s/runtime/0.3.0-ab/Kururu.app")).toBe(
      "/s/runtime/0.3.0-ab/Kururu.app/Contents/Resources/server/ptyhostd.mjs",
    );
  });

  test("leaves a checkout's entry where it is", () => {
    expect(remapInto("/Users/me/kururu/desktop/dist/ptyhostd.mjs", "/Users/me/kururu/release/mac-arm64/Kururu.app", "/s/x/Kururu.app")).toBe(
      "/Users/me/kururu/desktop/dist/ptyhostd.mjs",
    );
  });

  test("is not fooled by a sibling whose name starts the same", () => {
    expect(remapInto("/Applications/Kururu.app2/x", "/Applications/Kururu.app", "/c")).toBe("/Applications/Kururu.app2/x");
  });
});

describe("hostJobPlist", () => {
  const plist = hostJobPlist({
    label: `${HOST_LABEL_PREFIX}mgk3z9.53271`,
    program: ["/s/runtime/0.3.0-ab/Kururu.app/Contents/MacOS/Kururu", "/Users/me/kururu/desktop/dist/ptyhostd.mjs"],
    env: { ZED: "last", PATH: "/opt/homebrew/bin:/usr/bin", ODD: `a<b & "c"\u0007` },
    cwd: "/Users/me/kururu",
    log: "/Users/me/.local/state/kururu/ptyhost.log",
  });

  test("starts once, and never again by itself", () => {
    expect(plist).toContain("<key>RunAtLoad</key>\n\t<true/>");
    expect(plist).toContain("<key>KeepAlive</key>\n\t<false/>");
  });

  test("is not throttled, because every agent would inherit it", () => {
    expect(plist).toContain("<key>ProcessType</key>\n\t<string>Interactive</string>");
  });

  test("writes both streams to the host's log", () => {
    expect(plist.match(/ptyhost\.log/g)).toHaveLength(2);
  });

  test("escapes what XML cannot hold as it is, and drops what it cannot hold at all", () => {
    expect(plist).toContain("<string>a&lt;b &amp; \"c\"</string>");
    expect(plist).not.toContain("\u0007");
  });

  test("lists the environment sorted, so two starts diff cleanly", () => {
    expect(plist.indexOf("<key>ODD</key>")).toBeLessThan(plist.indexOf("<key>PATH</key>"));
    expect(plist.indexOf("<key>PATH</key>")).toBeLessThan(plist.indexOf("<key>ZED</key>"));
  });

  test("is a plist macOS accepts", async () => {
    if (process.platform !== "darwin") return;
    const { spawnSync } = await import("node:child_process");
    const done = spawnSync("plutil", ["-lint", "-"], { input: plist, encoding: "utf8" });
    expect(done.status).toBe(0);
  });
});

describe("hostUnitName and isHostUnit", () => {
  test("names a unit by the time and the pid that started it", () => {
    expect(hostUnitName(1_760_000_000_000, 4410)).toBe(`${HOST_UNIT_PREFIX}mgj6k3cw-4410`);
  });

  test("knows its own names, with or without .service", () => {
    const name = hostUnitName(Date.now(), 53271);
    expect(isHostUnit(name)).toBe(true);
    expect(isHostUnit(`${name}.service`)).toBe(true);
  });

  test("knows nobody else's — the server's unit least of all", () => {
    expect(isHostUnit("kururu.service")).toBe(false);
    expect(isHostUnit("kururu-ptyhost.service")).toBe(false);
    expect(isHostUnit("kururu-ptyhost-mgk3z9-4410.scope")).toBe(false);
    expect(isHostUnit("app-kururu-ptyhost-mgk3z9-4410.service")).toBe(false);
    expect(isHostUnit(null)).toBe(false);
  });
});

describe("unitEnvNames", () => {
  test("is every variable systemd can carry, sorted", () => {
    expect(unitEnvNames({ ZED: "last", PATH: "/usr/bin", HOME: "/home/me", TABS: "a\tb", LINES: "a\nb" })).toEqual(["HOME", "LINES", "PATH", "TABS", "ZED"]);
  });

  test("drops what systemd would refuse the whole start over", () => {
    expect(unitEnvNames({ OK: "1", BELL: "a\u0007", ESC: "\u001b[0m", DEL: "\u007f", "NOT-A-NAME": "1", "9LIVES": "1" })).toEqual(["OK"]);
  });

  test("drops what describes the server's own unit, which the host's is not", () => {
    const names = unitEnvNames({ PATH: "/usr/bin", INVOCATION_ID: "x", JOURNAL_STREAM: "8:1", NOTIFY_SOCKET: "/run/x", LISTEN_FDS: "1", XPC_SERVICE_NAME: "0" });
    expect(names).toEqual(["PATH"]);
  });

  test("leaves out a variable that is not set", () => {
    expect(unitEnvNames({ SET: "1", UNSET: undefined })).toEqual(["SET"]);
  });
});

describe("systemdRunArgv", () => {
  const unit = `${HOST_UNIT_PREFIX}mgk3z9-4410`;
  const argv = systemdRunArgv(unit, {
    program: ["/home/me/.local/share/mise/installs/node/26.8.2/bin/node", "/home/me/kururu/desktop/dist/ptyhostd.mjs"],
    envNames: ["HOME", "PATH"],
    cwd: "/home/me/kururu",
    log: "/home/me/.local/state/kururu/ptyhost.log",
  });

  test("is a user unit of its own, under the name it was given", () => {
    expect(argv[0]).toBe("--user");
    expect(argv).toContain(`--unit=${unit}`);
  });

  test("leaves nothing behind when the host exits badly", () => {
    expect(argv).toContain("--collect");
  });

  test("fails the start when the runtime cannot be run, rather than reporting one", () => {
    expect(argv).toContain("--property=Type=exec");
  });

  /**
   * The two that keep agents alive: stopping the unit signals the host and
   * lets it reap its own ptys, and the kernel's OOM killer taking one agent's
   * build does not stop the unit every other agent is in.
   */
  test("signals only the host when stopped, and survives an OOM kill inside it", () => {
    expect(argv).toContain("--property=KillMode=process");
    expect(argv).toContain("--property=OOMPolicy=continue");
  });

  test("appends both streams to the host's log", () => {
    expect(argv).toContain("--property=StandardOutput=append:/home/me/.local/state/kururu/ptyhost.log");
    expect(argv).toContain("--property=StandardError=append:/home/me/.local/state/kururu/ptyhost.log");
  });

  test("starts where it was asked to", () => {
    expect(argv).toContain("--working-directory=/home/me/kururu");
  });

  test("passes the environment by name, so no value is on a command line", () => {
    expect(argv.filter((arg) => arg.startsWith("--setenv="))).toEqual(["--setenv=HOME", "--setenv=PATH"]);
  });

  test("ends with the runtime and the entry, after a --", () => {
    const end = argv.indexOf("--");
    expect(argv.slice(end + 1)).toEqual(["/home/me/.local/share/mise/installs/node/26.8.2/bin/node", "/home/me/kururu/desktop/dist/ptyhostd.mjs"]);
    expect(argv.slice(0, end).every((arg) => arg.startsWith("--"))).toBe(true);
  });
});

describe("cgroupUnit", () => {
  test("is the host's own unit under the unified hierarchy", () => {
    const text = `0::/user.slice/user-1000.slice/user@1000.service/app.slice/${HOST_UNIT_PREFIX}mgk3z9-4410.service\n`;
    expect(cgroupUnit(text)).toBe(`${HOST_UNIT_PREFIX}mgk3z9-4410.service`);
    expect(isHostUnit(cgroupUnit(text))).toBe(true);
  });

  test("is the server's unit for a host spawned the old way, which is the shared case", () => {
    const text = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/kururu.service\n";
    expect(cgroupUnit(text)).toBe("kururu.service");
    expect(isHostUnit(cgroupUnit(text))).toBe(false);
  });

  test("is a login session's scope for a host started from an ssh shell", () => {
    expect(cgroupUnit("0::/user.slice/user-1000.slice/session-4.scope\n")).toBe("session-4.scope");
  });

  test("reads systemd's own line on a hybrid machine, and not a controller's that stops at the manager", () => {
    const text = [
      "12:memory:/user.slice/user-1000.slice/user@1000.service",
      "11:cpu,cpuacct:/user.slice",
      `1:name=systemd:/user.slice/user-1000.slice/user@1000.service/${HOST_UNIT_PREFIX}mgk3z9-4410.service`,
      `0::/user.slice/user-1000.slice/user@1000.service/${HOST_UNIT_PREFIX}mgk3z9-4410.service`,
    ].join("\n");
    expect(cgroupUnit(text)).toBe(`${HOST_UNIT_PREFIX}mgk3z9-4410.service`);
  });

  test("is null for a process in no unit, or a file that says nothing", () => {
    expect(cgroupUnit("0::/\n")).toBeNull();
    expect(cgroupUnit("")).toBeNull();
  });
});

describe("hostEnv", () => {
  /** The host's environment is every pty's, so what is the server's alone stays out of it. */
  test("leaves out the runner's and the server's own variables", () => {
    const env = hostEnv({
      PATH: "/usr/bin",
      KURURU_SUPERVISED: "1",
      KURURU_STARTED_BECAUSE: "the menu bar was started",
      KURURU_BIND: "tailscale",
      KURURU_LOOPBACK_TOKEN: "1",
      KURURU_TOKEN: "secret",
      KURURU_WEB_DIST: "/app/web",
    });
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  test("keeps what the host itself reads", () => {
    const kept = { KURURU_PORT: "7717", KURURU_HOST_SOCK: "/s/ptyhost.sock", KURURU_STATE_DIR: "/s", KURURU_AGENT_CWD: "/w", XDG_CONFIG_HOME: "/c" };
    expect(hostEnv(kept)).toEqual(kept);
  });
});

describe("userRuntimeDir", () => {
  const there = () => true;
  test("names /run/user/<uid> for an environment with no way to the user manager", () => {
    expect(userRuntimeDir({ PATH: "/usr/bin" }, 1000, there)).toBe("/run/user/1000");
  });

  test("leaves an environment that has one alone, either one", () => {
    expect(userRuntimeDir({ XDG_RUNTIME_DIR: "/run/user/1000" }, 1000, there)).toBeNull();
    expect(userRuntimeDir({ DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" }, 1000, there)).toBeNull();
  });

  test("invents nothing when the directory is not there", () => {
    expect(userRuntimeDir({}, 1000, () => false)).toBeNull();
    expect(userRuntimeDir({}, null, there)).toBeNull();
  });
});
