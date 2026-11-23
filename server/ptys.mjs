/**
 * How many terminals the pty host is holding, and what to say when there are
 * none left to give.
 *
 * A Mac has a fixed number of ptys — `kern.tty.ptmx_max`, 511 — shared by
 * every terminal on it, and the pty host is the one process here that opens
 * them. On 2026-11-23 it held all 511 with a handful of agents running, and
 * every new agent, card and shell failed with node-pty's "posix_spawnp
 * failed", which names neither the cause nor the cure. The cause was node-pty
 * 1.1.0's macOS spawn, which never closed two of the descriptors it opened for
 * each child: a spare `/dev/ptmx` it uses to fill fds 0–2 (its cleanup loop
 * stops before index 0, the only one a normal process ever fills) and its own
 * copy of the child's tty. One of each per terminal ever started, for the
 * life of the host. 1.2.0-beta closes both, and kururu is pinned to it.
 *
 * What is here is so the next leak, ours or a dependency's, is a number
 * somebody can read rather than an afternoon: `bun run status` prints what the
 * host holds against what it runs, and the host turns a spawn refused for want
 * of a pty into words that say so. A pty master shows up as `/dev/ptmx` on
 * both systems — `lsof` on a Mac, `/proc/<pid>/fd` on Linux, which has no
 * `lsof` on every box a child runs on.
 *
 * Plain JavaScript beside `status.mjs`, which node runs straight out of the
 * checkout; the host imports it through `ptys.d.mts` and esbuild bundles it in.
 */
import { execFileSync } from "node:child_process";
import { closeSync, constants, openSync, readFileSync, readdirSync, readlinkSync } from "node:fs";

const TIMEOUT_MS = 2_000;

/**
 * A live terminal is one master. A couple over that is allowed for a spawn in
 * flight — the master opens before the child exists — and is not worth a
 * warning; anything past it is descriptors nobody is using.
 */
const SLACK = 2;

/** `/dev/ptmx` among the `n` lines of `lsof -Fn`. */
export function countPtmx(lsofFields) {
  let count = 0;
  for (const line of lsofFields.split("\n")) if (line === "n/dev/ptmx") count++;
  return count;
}

/** `/dev/ptmx`, or `/dev/pts/ptmx` where devpts has its own, among `/proc/<pid>/fd`'s links. */
export function isPtmxLink(target) {
  return target === "/dev/ptmx" || target === "/dev/pts/ptmx";
}

/**
 * How many pty masters a process holds, or null when nothing here can tell —
 * no `lsof`, or somebody else's process. Never throws: it is asked on the way
 * to reporting a different failure.
 */
export function ptysHeld(pid = process.pid) {
  try {
    if (process.platform === "linux") {
      let count = 0;
      for (const fd of readdirSync(`/proc/${pid}/fd`)) {
        try {
          if (isPtmxLink(readlinkSync(`/proc/${pid}/fd/${fd}`))) count++;
        } catch {
          // Closed between the listing and the read.
        }
      }
      return count;
    }
    // `-a` so `-p` narrows the listing rather than adding to it; `-Fn` for names alone.
    const out = execFileSync("lsof", ["-nP", "-a", "-p", String(pid), "-Fn"], {
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return countPtmx(out);
  } catch {
    return null;
  }
}

/** The machine's pty limit, or null where it is not one number we know how to read. */
export function ptyLimit() {
  try {
    if (process.platform === "darwin") {
      const out = execFileSync("sysctl", ["-n", "kern.tty.ptmx_max"], { encoding: "utf8", timeout: TIMEOUT_MS });
      const n = Number(out.trim());
      return Number.isFinite(n) && n > 0 ? n : null;
    }
    if (process.platform === "linux") {
      const n = Number(readFileSync("/proc/sys/kernel/pty/max", "utf8").trim());
      return Number.isFinite(n) && n > 0 ? n : null;
    }
  } catch {
    // Not readable here; the words do without it.
  }
  return null;
}

/**
 * Whether one more pty can be had, by asking for one and handing it straight
 * back. The only question that tells "out of terminals" from every other way a
 * spawn fails — a missing shell, a bad cwd, a helper without its exec bit —
 * since node-pty says "posix_spawnp failed" for all of them.
 */
export function canOpenPty() {
  try {
    closeSync(openSync("/dev/ptmx", constants.O_RDWR | constants.O_NOCTTY));
    return true;
  } catch {
    return false;
  }
}

/** Whether a host holding `held` masters for `live` running terminals is holding ones nobody uses. */
export function leaking(held, live) {
  return held !== null && held > live + SLACK;
}

/**
 * The words for a spawn refused because the machine has no pty left.
 *
 * Says who has them, because the cure depends on it: if it is the host and
 * more than its terminals need, restarting the host frees them (and ends every
 * agent, so that is the owner's call, never this message's); if it is not, the
 * host is not the one to restart.
 */
export function outOfTerminals({ limit, held, live, mac }) {
  const machine = mac ? "this Mac" : "this machine";
  const sysctl = mac ? "kern.tty.ptmx_max" : "kernel.pty.max";
  const all = limit === null ? `every pty ${machine} has is in use` : `all ${limit} of ${machine}'s ptys (${sysctl}) are in use`;
  const terminals = `${live} running terminal${live === 1 ? "" : "s"}`;
  let whose;
  if (held === null) whose = "";
  else if (leaking(held, live)) {
    whose = ` — the pty host holds ${held} of them for ${terminals}, which is more than they need: restarting the pty host frees them, and ends every agent`;
  } else {
    whose = ` — the pty host holds ${held} of them, for its ${terminals}; the rest are other programs' (another terminal app, tmux, ssh)`;
  }
  return `out of terminals: ${all}${whose}`;
}
