/**
 * Starting the host through launchd: the pure half. What the job says, what
 * `launchctl` says back, and where a runtime lives. The `launchctl list` and
 * `print` samples are the shapes macOS 26 printed for the probe jobs this was
 * built against.
 */
import { describe, expect, test } from "bun:test";
import { HOST_LABEL_PREFIX, hostJobPlist, isHostJob, jobPid, remapInto, staleHostJobs } from "../src/hostlaunch";

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
