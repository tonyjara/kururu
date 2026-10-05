/**
 * The VPSes in the sidebar: which ones, and asking each how it is.
 *
 * `shared/vps.ts` argues for doing this over the user's own ssh rather than an
 * agent on the box; this is the half that runs it. Two rules shape it.
 *
 * **The script is a constant.** A client adds a VPS by naming a host, which
 * `validHost` holds to a grammar with no room for an option, and the command
 * that runs on the far side is `SCRIPT` below and nothing else. It only reads —
 * `/proc` and `df` — because it runs as whoever the user's ssh
 * config logs in as, which on a fresh VPS is root.
 *
 * **Nothing is ever asked for.** `BatchMode` means ssh fails rather than
 * prompting for a passphrase or a host key nobody is there to confirm: the
 * server is a daemon, and a prompt it cannot answer is a poll that hangs. A key
 * that needs unlocking, or a host not yet in `known_hosts`, shows up as the row's
 * error in ssh's own words, and is fixed by one `ssh <host>` in a terminal.
 *
 * One connection per host is kept warm with `ControlMaster`, so a poll every
 * fifteen seconds is a channel on an open session rather than a handshake — and
 * `ControlPersist` lets it close on its own a couple of minutes after the last
 * window does, since polling stops when nothing is connected.
 *
 * On the restartable side, beside `usage.ts` and `devservers.ts`, for their
 * reason: a question with no event behind it, and nothing to do with a pty.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  adoptVpsList,
  parseVpsSample,
  validHost,
  validPanel,
  vpsName,
  VPS_SEP,
  type VpsEntry,
  type VpsReading,
  type VpsStatus,
} from "../../shared/vps";
import { readConfigFile, writeConfigFile } from "./config";

const FILE = "vps.json";

/**
 * The sampling script. `LC_ALL=C` so nothing is printed with a decimal comma,
 * and the cpu line twice with a second between — see `parseVpsSample`.
 */
const SCRIPT = [
  "export LC_ALL=C",
  "head -1 /proc/stat",
  `echo ${VPS_SEP}`,
  "grep -E '^(MemTotal|MemAvailable):' /proc/meminfo",
  `echo ${VPS_SEP}`,
  "df -kP / | tail -1",
  `echo ${VPS_SEP}`,
  "sleep 1",
  "head -1 /proc/stat",
].join("\n");

/** Generous: a first connection is a handshake, and a slow tailnet or a busy box adds to it. */
const TIMEOUT_MS = 25_000;

/**
 * Where the shared connections live. `%C` is a hash of the destination, which
 * keeps the path short — a unix socket path over 104 bytes is refused on macOS,
 * and the temp directory there is most of that already.
 */
function controlPath(): string {
  const dir = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "kururu");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // ssh will say so, as the row's error.
  }
  return join(dir, "ssh-%C");
}

let entries: VpsEntry[] = adoptVpsList(readConfigFile(FILE));

interface Known {
  reading: VpsReading | null;
  stale: boolean;
  error: string | null;
}
const known = new Map<string, Known>();
const inflight = new Set<string>();

export function vpsSnapshot(): VpsStatus[] {
  return entries.map((entry) => ({
    ...entry,
    ...(known.get(entry.id) ?? { reading: null, stale: false, error: null }),
  }));
}

/** Add one, or throw a sentence the settings page can print. */
export function addVps(input: { name?: unknown; host?: unknown; panel?: unknown }): VpsEntry {
  const host = typeof input.host === "string" ? input.host.trim() : input.host;
  if (!validHost(host)) {
    throw new Error("A host is an ssh alias or user@host — letters, digits, dots, dashes.");
  }
  const entry: VpsEntry = {
    id: randomUUID().slice(0, 8),
    name: vpsName(input.name, host),
    host,
    panel: validPanel(input.panel),
  };
  entries = [...entries, entry];
  writeConfigFile(FILE, entries);
  return entry;
}

export function removeVps(id: string): void {
  entries = entries.filter((entry) => entry.id !== id);
  known.delete(id);
  writeConfigFile(FILE, entries);
}

/** One run of the script on one host. */
function sample(host: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const args = [
    "-T",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=8",
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${controlPath()}`,
    "-o", "ControlPersist=120",
    // Belt to `validHost`'s braces: after `--`, nothing is an option.
    "--",
    host,
    SCRIPT,
  ];
  return new Promise((resolve) => {
    execFile("ssh", args, { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve({ ok: true, text: stdout });
      // ssh's last line is the one that says what went wrong; the ones above
      // it are banners and warnings.
      const said = String(stderr)
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .pop();
      const error = err.killed ? "Timed out" : (said ?? err.message);
      resolve({ ok: false, error: error.slice(0, 200) });
    });
  });
}

async function pollOne(entry: VpsEntry): Promise<void> {
  if (inflight.has(entry.id)) return;
  inflight.add(entry.id);
  try {
    const result = await sample(entry.host);
    // Removed while it was in flight: nobody is drawing it any more.
    if (!entries.some((e) => e.id === entry.id)) return;
    const before = known.get(entry.id);
    known.set(
      entry.id,
      result.ok
        ? { reading: parseVpsSample(result.text, Date.now()), stale: false, error: null }
        : { reading: before?.reading ?? null, stale: Boolean(before?.reading), error: result.error },
    );
  } finally {
    inflight.delete(entry.id);
  }
}

/** Ask every VPS at once. Each reading moves every time, so there is no diff: the caller broadcasts. */
export async function pollVps(): Promise<void> {
  await Promise.all(entries.map(pollOne));
}

/** Just the one — so a VPS added in Settings has numbers without waiting for the timer. */
export async function pollVpsOne(id: string): Promise<void> {
  const entry = entries.find((e) => e.id === id);
  if (entry) await pollOne(entry);
}
