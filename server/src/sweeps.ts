/**
 * The questions the server has to keep asking, because nothing raises an
 * event for them: which dev servers are listening, what each terminal costs
 * in memory, what the plan's usage is, whether the machines and OpenRouter
 * are there — and the web chain for agents, whose providers are checked on
 * a timer of their own.
 *
 * Every poll goes through `sweep`, which catches and logs. The timers start
 * from `index.ts` (`startSweeps`) at the point in start-up they always did,
 * and `shutdown` stops them first (`stopSweeps`).
 */
import { totalmem } from "node:os";
import type { Footprint, FootprintTerminal } from "../../shared/footprint";
import { agentLabel, agentSummary } from "../../shared/labels";
import { panes, terminalsOf } from "../../shared/layout";
import { DEV_SCAN_MS, GIT_SCAN_MS, MACHINE_POLL_MS, OPENROUTER_POLL_MS, USAGE_POLL_MS } from "../../shared/wire";
import { PING_MS } from "./backpressure";
import { codexUsageSnapshot, pollCodexUsage } from "./codexusage";
import { broadcast, checkLiveness, clients, host, memory, overlay, pushSnapshot, state, usageReader, windows, workspaces } from "./context";
import { scanDevServers, stopDevServer } from "./devservers";
import { NVIM_SCAN_MS, nvimCensus, pollEditors } from "./editors";
import { allowRoot } from "./files";
import { childIndex as footChildren, hostPidOf, readFootTable, readTree } from "./footprint";
import { loginsActive, refreshLogins, tokenInPtys } from "./lending";
import { claudeDirFor, codexDirFor } from "./logins";
import { machinesSnapshot, pollMachines } from "./machines";
import { MADE_SWEEP_MS, sweepMade } from "./madelinks";
import { measureMemory } from "./memory";
import { openRouterSnapshot, pollOpenRouter } from "./openrouter";
import { PORT, WEB_SOURCE } from "./preamble";
import { type ProcRows, readProcRows } from "./proctable";
import { closePreview, openPreview, openPreviews } from "./proxy";
import { pollBranches } from "./repostatus";
import { dueForReading, readSpecs, specsSnapshot } from "./specs";
import { sweep } from "./sweep";
import { refreshClaudeReady } from "./thisnode";
import { pollUsage, usageSnapshot } from "./usage";
import { recordClaudeLimits } from "./usage/limits";
import { fileStore, WebChain } from "./web/chain";

let lastDevJson = "";
let devScansStarted = 0;
let devScanShown = 0;

async function pollDevServers(procs?: ProcRows): Promise<void> {
  const scan = ++devScansStarted;
  const servers = await scanDevServers({ pid: process.pid, webDir: WEB_SOURCE }, procs);
  /**
   * Never an older reading over a newer one. Stopping a server asks for a scan
   * at once, so the row goes when the server does, and a timer scan that began
   * before the stop can finish after it — putting the stopped server back in
   * the list and opening it a fresh proxy.
   */
  if (scan < devScanShown) return;
  devScanShown = scan;
  for (const server of servers) allowRoot(server.cwd);
  /**
   * Every dev server gets a proxy, whether or not anything has asked for one.
   *
   * This used to wait for `open-preview`, which is the right shape for a preview
   * *pane* — it is opened deliberately, and the pane can wait a round trip for
   * the port to come back. It is the wrong shape for a link. A phone opening a
   * dev server wants a real anchor with a real href, because that is what buys
   * long-press to copy, the share sheet, a background tab, and Add to Home
   * Screen; a button that sends a message, waits for the next `dev-servers`
   * push and then calls `window.open` gets none of those, and is additionally
   * blocked by mobile Safari for opening a window outside the gesture that
   * asked for it. An href cannot be built after the fact, so the port has to
   * exist before anybody taps.
   *
   * The cost is a listener per dev server for sessions that never look at one —
   * an idle accept loop, which is nothing, and which `closePreview` reclaims as
   * soon as the dev server stops. Opening these only while a non-loopback client
   * is connected was the obvious economy and is a worse feature: previews are
   * global while that test is per-client, so a link would appear and disappear
   * according to who *else* had the window open.
   */
  const proxyPorts = new Set(openPreviews().values());
  for (const server of servers) {
    /**
     * Never a preview of a preview. `scanDevServers` already refuses this
     * process's own sockets, which is where the loop actually came from and the
     * fix that matters; this is the second lock on the same door, because the
     * failure mode is not a wrong row in a list but a process that opens
     * listeners until it runs out of ports, and the two guards fail for
     * different reasons — that one needs the pid to be ours, this one only needs
     * the port to be one we handed out.
     */
    if (proxyPorts.has(server.port)) continue;
    try {
      openPreview(server.port);
    } catch {
      // Out of preview ports. The snapshot simply carries no proxyPort for this
      // one, and the sidebar row draws without a link rather than with a broken.
    }
  }
  const proxied = openPreviews();
  for (const server of servers) {
    const proxyPort = proxied.get(server.port);
    if (proxyPort) server.proxyPort = proxyPort;
  }
  // A proxy whose dev server has stopped is holding a port for nothing.
  const live = new Set(servers.map((s) => s.port));
  for (const devPort of proxied.keys()) {
    if (!live.has(devPort)) closePreview(devPort);
  }
  const json = JSON.stringify(servers);
  if (json === lastDevJson) return;
  lastDevJson = json;
  state.devServers = servers;
  broadcast({ type: "dev-servers", servers });
}

/**
 * Stop a dev server from the sidebar's list, by the port and pid its row showed.
 *
 * The pair has to be one the last scan reported, which is what keeps this a
 * verb about servers kururu found rather than a way to signal any pid a client
 * names. What is spared is decided here because only here knows it: this
 * process, every terminal the host holds, and the host itself, found as the
 * terminals' parent — the same way `hostPidOf` finds it.
 */
export async function stopListedDevServer(port: unknown, pid: unknown): Promise<{ stopped: number }> {
  if (!Number.isInteger(port) || !Number.isInteger(pid)) throw new Error("no such dev server");
  if (!state.devServers.some((server) => server.port === port && server.pid === pid)) {
    throw new Error("That dev server is not running any more");
  }
  const roots = memRoots().map(([, root]) => root);
  const stopped = await stopDevServer(port as number, pid as number, (table) => {
    const spare = new Set([process.pid, ...roots]);
    for (const root of roots) {
      const parent = table.get(root)?.ppid;
      if (parent && parent > 1) spare.add(parent);
    }
    return spare;
  });
  await pollDevServers();
  return { stopped: stopped.length };
}

// ---------------------------------------------------------------------------
// What each terminal is costing the machine
// ---------------------------------------------------------------------------

/**
 * Which pids to add up from: every live pty, and deliberately not the filtered
 * set the dev scan walks.
 *
 * `devRoots` withholds terminals with an agent running in them, because what it
 * feeds is a button that types into one. Nothing here types anywhere — it reads
 * a number out of a table — and an agent's terminal is the one whose memory is
 * worth knowing, so withholding it would leave the feature answering only for
 * the rows nobody asked about.
 */
function memRoots(): Array<[string, number]> {
  const roots: Array<[string, number]> = [];
  if (!host) return roots;
  for (const agent of host.agents) {
    if (agent.exited || !agent.pid) continue;
    roots.push([agent.id, agent.pid]);
  }
  return roots;
}

/**
 * Measure, and say so only when the figure moved.
 *
 * The comparison is against what was already rounded (see `memory.ts`), which is
 * the whole reason this can push at all: on the raw byte count every working
 * agent changes every poll, and a snapshot every five seconds for the life of a
 * session is a lot of bytes to spend redrawing `390 MB` as `390 MB`.
 */
async function pollMemory(procs: ProcRows): Promise<void> {
  const found = measureMemory(memRoots(), procs);
  let changed = false;
  for (const [agentId, bytes] of found) {
    if (memory.get(agentId) !== bytes) changed = true;
    memory.set(agentId, bytes);
  }
  // A terminal the scan could not find is one whose process has gone; the row
  // stays (an exited agent is still listed) and simply stops saying a number,
  // rather than keeping the last one it had, which would be a claim about a
  // process that does not exist.
  for (const agentId of [...memory.keys()]) {
    if (found.has(agentId)) continue;
    memory.delete(agentId);
    changed = true;
  }
  if (changed) pushSnapshot();
}

/**
 * One reading of every terminal the host holds, placed in the profile and
 * workspace whose tab holds it.
 *
 * Every profile and not only the active one, which is the difference between
 * this and the snapshot: the snapshot is what one window is drawing, and this is
 * what the machine is paying for — a claude left running in a profile you
 * switched away from yesterday is exactly the one worth finding. A terminal no
 * tab holds is listed apart rather than dropped, for the same reason.
 */
export async function footprint(): Promise<Footprint> {
  const table = await readFootTable();
  const children = footChildren(table);
  const roots: number[] = [];
  const terminals: FootprintTerminal[] = (host?.agents ?? []).map((raw) => {
    const agent = overlay(raw);
    const tree = !agent.exited && agent.pid ? readTree(agent.pid, table, children) : null;
    if (tree) roots.push(agent.pid);
    return {
      agentId: agent.id,
      label: agentLabel(agent),
      summary: agentSummary(agent),
      kind: agent.kind,
      status: agent.status,
      exited: agent.exited,
      cwd: agent.cwd,
      rss: tree?.rss ?? null,
      processes: tree?.processes ?? 0,
      agents: tree?.agents ?? [],
      editors: tree?.editors ?? 0,
      devServers: tree?.devServers ?? [],
    };
  });
  const known = new Set(terminals.map((t) => t.agentId));
  const placed = new Set<string>();
  const profiles = workspaces.all().map((profile) => ({
    id: profile.id,
    name: profile.name,
    active: profile.id === workspaces.active.id,
    workspaces: profile.workspaces.map((workspace) => {
      const ids = panes(workspace.layout)
        .flatMap((pane) => terminalsOf(pane.agentIds))
        .filter((id) => known.has(id));
      for (const id of ids) placed.add(id);
      return { id: workspace.id, name: workspace.name, terminals: ids };
    }),
  }));
  const hostPid = hostPidOf(roots, table);
  return {
    measuredAt: Date.now(),
    terminals,
    profiles,
    unplaced: terminals.filter((t) => !placed.has(t.agentId)).map((t) => t.agentId),
    nvims: await nvimCensus(table, children),
    kururu: {
      server: table.get(process.pid)?.rss ?? null,
      host: hostPid === null ? null : (table.get(hostPid)?.rss ?? null),
    },
    machineTotal: totalmem(),
  };
}

/**
 * Ask the account where it stands against its limits.
 *
 * Skipped entirely when nobody is connected, which none of the other polls
 * bother with and this one must. The others read this machine — a `ps`, an
 * `lsof` — and running them for nobody wastes a few milliseconds of our own CPU.
 * This one is a request to somebody else's API carrying somebody's credential,
 * and making it on a schedule for a window that is not open is the kind of thing
 * that should never have been written. A client connecting gets the last reading
 * immediately and a fresh one within the minute.
 */
export async function pollAccountUsage(): Promise<void> {
  // The login list first and regardless of who is connected: it reads this
  // machine and nothing else, like the other polls, and it is on this schedule
  // because a `/login` is the one thing that changes both. Whether Kuru could
  // answer the chat here, for the Telegram poll, is the same kind of look.
  await refreshLogins();
  await refreshClaudeReady();
  if (windows() === 0) return;
  // Codex's allowance on the same beat, though it is read off this disk and
  // asks nobody: the profile's Codex home when profiles keep their logins, the
  // machine's otherwise — the same rule as the Claude scope below.
  const codexHome = loginsActive() ? codexDirFor(workspaces.active.loginKey) : null;
  if (await pollCodexUsage(codexHome)) broadcast({ type: "codex-usage", codex: codexUsageSnapshot() });
  // The profile's own login when profiles keep them, because that is the
  // account its terminals are spending; otherwise whichever this machine was
  // signed into last, as before.
  const loginKey = loginsActive() ? workspaces.active.loginKey : null;
  const scope = loginKey ? claudeDirFor(loginKey) : null;
  const moved = await pollUsage(scope);
  // Every fresh sighting, moved or not: a bar that read the same percentage
  // twice is still two points on the history `limits` keeps.
  recordClaudeLimits(usageReader?.ledger, usageSnapshot(), loginKey);
  if (moved) broadcast({ type: "usage", usage: usageSnapshot() });
}

/**
 * Sample every machine the sidebar watches. Skipped while nobody is connected,
 * on the usage poll's argument: it leaves this Mac, as the user, and doing that
 * for a window that is not open is not a thing to do on a timer.
 */
export async function pollServers(): Promise<void> {
  if (windows() === 0) return;
  await pollMachines();
  const machines = machinesSnapshot();
  broadcast({ type: "machines", machines });
  // The hardware rides the same poll: a machine that answered and is due —
  // never read, six hours old, or just back after not answering — is read
  // now. See `specs.ts`.
  for (const machine of dueForReading(machines, Date.now())) void readSpecs(machine, broadcastSpecs);
}

/** Every machine's kept specs, to every window. Only when they move: a reading is hours old by design. */
export function broadcastSpecs(): void {
  broadcast({ type: "specs", specs: specsSnapshot(machinesSnapshot()) });
}

/**
 * Ask OpenRouter what is left. Skipped while nobody is connected, on the usage
 * poll's argument, and a no-op while no key has been given.
 */
export async function pollOpenRouterAccount(): Promise<void> {
  if (windows() === 0) return;
  if (await pollOpenRouter()) {
    broadcast({ type: "openrouter", openrouter: openRouterSnapshot() });
  }
}

/**
 * The web for the agents: an ordered chain of providers set in Settings →
 * Web, served at `/mcp/web`. It checks its providers' health and reads their
 * figures on its own timer, only while a window is open, and broadcasts
 * whatever moves. See `web/chain.ts`.
 */
export const web = WebChain.fromRegistry({
  store: fileStore,
  changed: () => broadcast({ type: "web", web: web.status() }),
  clients: () => windows(),
  port: () => PORT,
  tokenInPtys: () => tokenInPtys(),
});

/** An agent's name, for the list of recent web calls, or null if it is not one of ours. */
export function webAgentName(agentId: string): string | null {
  const agent = host.find(agentId);
  if (!agent) return null;
  const where = `${agent.agent ?? "agent"} in ${agent.cwd.split("/").pop() || agent.cwd}`;
  const what = agent.title?.replace(/\s+/g, " ").trim().slice(0, 60);
  return what ? `${where}: ${what}` : where;
}

/**
 * The timers left in this process, and what they have in common: each one asks
 * the *machine* a question no pty can raise an event about. The status heuristic
 * and the agent scan went with the ptys, because those are questions about a
 * process kururu owns and the host is where those live now.
 *
 * The usage poll is the exception to the sentence above and the only one of
 * these that leaves the machine at all. It is out here with the rest because it
 * is the same shape — a question with no event behind it — and a minute apart
 * rather than seconds because it is measuring a five-hour window.
 *
 * Each goes through `sweep`, which catches and logs, because a rejection here
 * is an unhandled one and Node ends the server over it.
 */
const sweepBranches = sweep("branches", pollBranches);

/**
 * The dev-server scan and the memory column, off one `ps` (`proctable.ts`),
 * on one timer: every `DEV_SCAN_MS` while anybody is connected, and every
 * `PROC_IDLE_MS` while nobody is — the answers go to windows, and a Mac with
 * none open was spending its share of a core on a list nobody was shown. A
 * card's dev server is found within that slower beat even so, and the first
 * client back is not made to wait for it: `wakeProcesses` reads at once.
 *
 * Memory used to be read every five seconds rather than three, as the one
 * answer nobody acts on within a second; it rides along now because the read
 * is shared, and a figure that changes only on a 10 MB step costs nothing
 * extra to look at more often.
 */
const PROC_IDLE_MS = 30_000;
const sweepProcesses = sweep("processes", async () => {
  const procs = await readProcRows();
  // Separately caught, so that one failing does not cost the other its turn.
  await Promise.all([sweep("dev servers", () => pollDevServers(procs))(), sweep("memory", () => pollMemory(procs))()]);
});
let procTimer: ReturnType<typeof setTimeout> | null = null;
let procRunning = false;
/** Set by `stopSweeps`, for `shutdown`, which this cannot read `stopping` for: that is declared below the top-level `await`, and this runs during it. */
let procHalted = false;
async function procTick(): Promise<void> {
  if (procTimer) clearTimeout(procTimer);
  procTimer = null;
  if (procRunning) return;
  procRunning = true;
  try {
    await sweepProcesses();
  } finally {
    procRunning = false;
    if (!procHalted) {
      procTimer = setTimeout(() => void procTick(), clients.size > 0 ? DEV_SCAN_MS : PROC_IDLE_MS);
      procTimer.unref?.();
    }
  }
}

/** A client arrived to a server that was reading slowly: read now, and at the fast beat from here. */
export function wakeProcesses(): void {
  if (!procRunning) void procTick();
}

let timers: ReturnType<typeof setInterval>[] = [];

/**
 * The web chain's own timer, the timers above and the first reads, started
 * from `index.ts` at the point in start-up where they always were, rather
 * than whenever this module happens to be imported. See `preamble.ts`.
 */
export function startSweeps(): void {
  web.start();
  timers = [
    setInterval(sweepBranches, GIT_SCAN_MS),
    setInterval(sweep("editors", pollEditors), NVIM_SCAN_MS),
    setInterval(checkLiveness, PING_MS),
    setInterval(sweep("usage bar", pollAccountUsage), USAGE_POLL_MS),
    setInterval(sweep("machines", pollServers), MACHINE_POLL_MS),
    setInterval(sweep("OpenRouter", pollOpenRouterAccount), OPENROUTER_POLL_MS),
    setInterval(sweep("made links", sweepMade), MADE_SWEEP_MS),
  ];
  void procTick();
  void sweepBranches();
}

/** What `shutdown` stops of the above, first, so that nothing is read while the rest closes. */
export function stopSweeps(): void {
  for (const timer of timers) clearInterval(timer);
  procHalted = true;
  if (procTimer) clearTimeout(procTimer);
}
