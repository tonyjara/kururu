/**
 * That a terminal's pty is given back when it ends, and the words for when
 * there are none left.
 *
 * node-pty 1.1.0 kept a `/dev/ptmx` (and the child's tty) for every terminal
 * the host ever started, until the Mac's 511 were gone and nothing more could
 * be spawned (2026-11-23). The release test runs node-pty for real, under
 * `node` — the host's runtime, and the one node-pty works under: in bun its
 * read stream never ends — with harmless children only: `true`, `sleep`, a
 * shell hung up. It counts the masters the process holds before, while and
 * after, with the same `ptysHeld` that `bun run status` prints.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { canOpenPty, countPtmx, isPtmxLink, leaking, outOfTerminals } from "../ptys.mjs";

const require = createRequire(import.meta.url);

/**
 * Each way a terminal ends in kururu: the program finishing, the host's kill
 * (SIGHUP to the group — stop_agent, a closed tab), an interactive shell hung
 * up, and a program that leaves a child behind on its tty, which is the case
 * where the master never sees the end on its own and node-pty has to close it.
 */
const SCRIPT = `
import { spawn } from ${JSON.stringify(require.resolve("node-pty"))};
import { ptysHeld } from ${JSON.stringify(join(import.meta.dir, "..", "ptys.mjs"))};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { PATH: "/usr/bin:/bin", HOME: "/tmp" };
const ways = [
  { name: "finishes", argv: ["-c", "sleep 0.8"], end: null },
  { name: "killed", argv: ["-c", "sleep 30"], end: "SIGHUP" },
  { name: "shell hung up", argv: ["-i"], end: "SIGHUP" },
  { name: "leaves a child", argv: ["-c", "sleep 2 & sleep 0.8"], end: null },
];
const before = ptysHeld();
const terms = ways.map((way) => {
  const term = spawn("/bin/sh", way.argv, { cols: 80, rows: 24, cwd: "/tmp", env });
  term.onData(() => {});
  return { way, term, exited: new Promise((r) => term.onExit(() => r(true))) };
});
await wait(300);
const during = ptysHeld();
for (const { way, term } of terms) {
  // The group node-pty made with setsid for this child, and nobody else's.
  if (way.end) try { process.kill(-term.pid, way.end); } catch {}
}
const all = await Promise.race([Promise.all(terms.map((t) => t.exited)), wait(8000).then(() => false)]);
await wait(300);
console.log(JSON.stringify({ before, during, after: ptysHeld(), exited: Boolean(all), n: ways.length }));
process.exit(0);
`;

describe("a terminal's pty", () => {
  test(
    "is given back however the terminal ends",
    () => {
      const out = execFileSync("node", ["--input-type=module", "-e", SCRIPT], { encoding: "utf8", timeout: 20_000 });
      const { before, during, after, exited, n } = JSON.parse(out.trim().split("\n").at(-1) ?? "{}");
      expect(exited).toBe(true);
      expect(typeof before).toBe("number");
      // Counting works at all: the four were open while they ran.
      expect(during).toBeGreaterThanOrEqual(before + n);
      // And every one of them is closed now. 1.1.0 left `before + n` here.
      expect(after).toBe(before);
    },
    30_000,
  );
});

describe("counting", () => {
  test("masters in lsof's names", () => {
    const fields = ["p4242", "fcwd", "n/Users/me", "f17", "n/dev/ptmx", "f18", "n/dev/ttys004", "f19", "n/dev/ptmx", "f20", "n/dev/ptmx-not"].join("\n");
    expect(countPtmx(fields)).toBe(2);
    expect(countPtmx("")).toBe(0);
  });

  test("masters among /proc's links", () => {
    expect(isPtmxLink("/dev/ptmx")).toBe(true);
    expect(isPtmxLink("/dev/pts/ptmx")).toBe(true);
    expect(isPtmxLink("/dev/pts/3")).toBe(false);
    expect(isPtmxLink("socket:[1234]")).toBe(false);
  });

  test("one per running terminal is not a leak, and a few in flight are not either", () => {
    expect(leaking(4, 4)).toBe(false);
    expect(leaking(6, 4)).toBe(false);
    expect(leaking(7, 4)).toBe(true);
    expect(leaking(509, 4)).toBe(true);
    expect(leaking(null, 4)).toBe(false);
  });
});

describe("out of terminals", () => {
  test("is only said when a pty cannot be had, and here one can", () => {
    // The probe opens one and closes it; a machine running this suite has one to spare.
    expect(canOpenPty()).toBe(true);
  });

  test("the host's leak: says so, and what a restart costs", () => {
    const words = outOfTerminals({ limit: 511, held: 509, live: 4, mac: true });
    expect(words).toStartWith("out of terminals: all 511 of this Mac's ptys (kern.tty.ptmx_max) are in use");
    expect(words).toContain("the pty host holds 509 of them for 4 running terminals");
    expect(words).toContain("restarting the pty host frees them, and ends every agent");
    expect(words).not.toContain("posix_spawnp");
  });

  test("somebody else's: the host is not the one to restart", () => {
    const words = outOfTerminals({ limit: 511, held: 3, live: 3, mac: true });
    expect(words).toContain("holds 3 of them, for its 3 running terminals");
    expect(words).toContain("the rest are other programs'");
    expect(words).not.toContain("restarting");
  });

  test("Linux, one terminal, and nothing known", () => {
    expect(outOfTerminals({ limit: 4096, held: 1, live: 1, mac: false })).toContain(
      "all 4096 of this machine's ptys (kernel.pty.max) are in use — the pty host holds 1 of them, for its 1 running terminal;",
    );
    expect(outOfTerminals({ limit: null, held: null, live: 0, mac: true })).toBe("out of terminals: every pty this Mac has is in use");
  });
});
