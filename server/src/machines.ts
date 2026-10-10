/**
 * The machines in the sidebar: which ones, asking each how it is, and ending
 * a tmux session kururu started on one.
 *
 * `shared/machines.ts` argues for doing this over the user's own ssh rather
 * than an agent on the box; this is the half that runs it. Two rules shape it.
 *
 * **The script is a constant.** A client adds a machine by naming a host,
 * which `validHost` holds to a grammar with no room for an option, and the
 * command that runs on the far side is `SCRIPT` below and nothing else. It
 * only reads — `/proc` and `df` — because it runs as whoever the user's ssh
 * config logs in as, which on a fresh VPS is root. The one other line this
 * file sends is `tmux kill-session` on a session name `sessionName` made.
 *
 * **Nothing is ever asked for.** `BatchMode` means ssh fails rather than
 * prompting for a passphrase or a host key nobody is there to confirm: the
 * server is a daemon, and a prompt it cannot answer is a poll that hangs. A key
 * that needs unlocking, a host not yet in `known_hosts`, or Tailscale SSH
 * wanting a browser check shows up as the row's error in ssh's own words, and
 * is fixed by one `ssh <host>` in a terminal — which the row's shell button is.
 *
 * One connection per host is kept warm with `ControlMaster`, so a poll every
 * fifteen seconds is a channel on an open session rather than a handshake — and
 * `ControlPersist` lets it close on its own a couple of minutes after the last
 * window does, since polling stops when nothing is connected.
 *
 * The list is kept in `vps.json`, the name it had when every machine in it was
 * a VPS. Renaming the file would buy a migration to read the old one, forever,
 * for the sake of a word nobody sees; the type is what changed.
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
  adoptMachineList,
  machineName,
  MACHINE_SEP,
  parseMachineSample,
  validHost,
  validPanel,
  type MachineEntry,
  type MachineReading,
  type MachineStatus,
} from "../../shared/machines";
import { readConfigFile, writeConfigFile } from "./config";

const FILE = "vps.json";

/**
 * The sampling script. `LC_ALL=C` so nothing is printed with a decimal comma,
 * and the cpu line twice with a second between — see `parseMachineSample`.
 */
const SCRIPT = [
  "export LC_ALL=C",
  "head -1 /proc/stat",
  `echo ${MACHINE_SEP}`,
  "grep -E '^(MemTotal|MemAvailable):' /proc/meminfo",
  `echo ${MACHINE_SEP}`,
  "df -kP / | tail -1",
  `echo ${MACHINE_SEP}`,
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

let entries: MachineEntry[] = adoptMachineList(readConfigFile(FILE));

interface Known {
  reading: MachineReading | null;
  stale: boolean;
  error: string | null;
}
const known = new Map<string, Known>();
const inflight = new Set<string>();

export function machinesSnapshot(): MachineStatus[] {
  return entries.map((entry) => ({
    ...entry,
    ...(known.get(entry.id) ?? { reading: null, stale: false, error: null }),
  }));
}

export function findMachine(id: string): MachineEntry | undefined {
  return entries.find((entry) => entry.id === id);
}

/** Add one, or throw a sentence the settings page can print. */
export function addMachine(input: { name?: unknown; host?: unknown; panel?: unknown }): MachineEntry {
  const host = typeof input.host === "string" ? input.host.trim() : input.host;
  if (!validHost(host)) {
    throw new Error("A host is an ssh alias or user@host — letters, digits, dots, dashes.");
  }
  const entry: MachineEntry = {
    id: randomUUID().slice(0, 8),
    name: machineName(input.name, host),
    host,
    panel: validPanel(input.panel),
  };
  entries = [...entries, entry];
  writeConfigFile(FILE, entries);
  return entry;
}

export function removeMachine(id: string): void {
  entries = entries.filter((entry) => entry.id !== id);
  known.delete(id);
  writeConfigFile(FILE, entries);
}

/** The options every non-interactive ssh here runs with: no questions, and the warm connection. */
function batchArgs(): string[] {
  return [
    "-T",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=8",
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${controlPath()}`,
    "-o", "ControlPersist=120",
  ];
}

/** One line on one host, with ssh's own last word when it fails. */
function run(host: string, line: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  // Belt to `validHost`'s braces: after `--`, nothing is an option.
  const args = [...batchArgs(), "--", host, line];
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

async function pollOne(entry: MachineEntry): Promise<void> {
  if (inflight.has(entry.id)) return;
  inflight.add(entry.id);
  try {
    const result = await run(entry.host, SCRIPT);
    // Removed while it was in flight: nobody is drawing it any more.
    if (!entries.some((e) => e.id === entry.id)) return;
    const before = known.get(entry.id);
    known.set(
      entry.id,
      result.ok
        ? { reading: parseMachineSample(result.text, Date.now()), stale: false, error: null }
        : { reading: before?.reading ?? null, stale: Boolean(before?.reading), error: result.error },
    );
  } finally {
    inflight.delete(entry.id);
  }
}

/** Ask every machine at once. Each reading moves every time, so there is no diff: the caller broadcasts. */
export async function pollMachines(): Promise<void> {
  await Promise.all(entries.map(pollOne));
}

/** Just the one — so a machine added in Settings has numbers without waiting for the timer. */
export async function pollMachine(id: string): Promise<void> {
  const entry = entries.find((e) => e.id === id);
  if (entry) await pollOne(entry);
}

/**
 * Sessions on their way out, until the machine has said so — so the name is
 * not handed to a new tab in the second between the old tab closing and tmux
 * hearing about it, which would attach the new tab to the session a moment
 * before it was killed. Names only, not hosts: names are kept unique across
 * every machine (see `sessionShell` in `index.ts`).
 */
const ending = new Set<string>();

/** Names not to give a new session yet. */
export function sessionsEnding(): string[] {
  return [...ending];
}

/**
 * End a tmux session kururu started, because its tab was closed.
 *
 * Closing a tab ends the terminal in it, here or there: that is what closing
 * means everywhere else in kururu, and a session left behind per closed tab
 * would be a machine slowly filling with shells nobody can see. What does
 * *not* come through here is everything else that ends the ssh — a dropped
 * link, a detach, the pty host restarting — and those are exactly the cases
 * the session is there to outlive.
 *
 * `=` is tmux's exact match; without it `-t kururu-api-1` is a prefix, and
 * would end `kururu-api-12` when `-1` was already gone. Quoted because zsh
 * reads a word starting with `=` as a command path. A machine that cannot be
 * reached is logged and left: the session is still the user's on the far side,
 * and the next tab in that slot reattaches to it.
 */
export function endSession(host: string, session: string): void {
  if (!validHost(host) || !/^kururu-[a-z0-9-]{1,40}$/.test(session)) return;
  ending.add(session);
  void run(host, `tmux kill-session -t '=${session}' 2>/dev/null; true`).then((result) => {
    ending.delete(session);
    if (!result.ok) console.error(`kururu: could not end tmux session ${session} on ${host}: ${result.error}`);
  });
}
