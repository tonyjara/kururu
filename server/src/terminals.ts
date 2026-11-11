/**
 * Terminals: opening one where it was asked for, with the command line its
 * launcher means, and everything after — the size each is drawn at, the
 * backlog then the output to each client, and forgetting one that ended.
 *
 * Most of this is the server's half of an invariant: the server owns the
 * size (`applySize`, the policy in `sizing.ts`), a backlog is a serialized
 * screen laid out at a width, and backlog-then-output ordering is per client
 * (`openQueue`). The rest is how a tab comes to exist — here, on a machine a
 * workspace is pinned to, or in a session another tab already holds — and
 * the note the usage ledger takes of whose it is when it starts. The layout's
 * save lives here too, since a terminal opening or ending is most of what
 * moves it.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { WebSocket } from "ws";
import { channelReady } from "../../shared/channels";
import { HARNESS_SERVER, type HarnessFeatures } from "../../shared/harness";
import { agentLabel } from "../../shared/labels";
import { type AgentCli, type Launcher, launcherCommand } from "../../shared/launchers";
import { terminalsOf } from "../../shared/layout";
import { type MachineEntry, remoteAgentRun, remoteShellCommand, remoteShellOf, sessionName } from "../../shared/machines";
import type { AgentSnapshot, PtyKind } from "../../shared/model";
import { mintOpencodeSession, opencodeAgentCommand } from "../../shared/opencode";
import { standingDir } from "../../shared/projects";
import { tildePath, workspaceRootPath } from "../../shared/workspaceroot";
import { isRemote } from "../../shared/remote";
import { sessionOfTranscript } from "../../shared/store";
import type { LaunchRow } from "../../shared/usage";
import type { UsageDimension, UsageNames, UsageRange, UsageReport } from "../../shared/usagereport";
import { WEB_SERVER } from "../../shared/web";
import { SAVE_DEBOUNCE_MS, type ServerMessage, type UsageLimit } from "../../shared/wire";
import { isDirectory } from "./cards";
import { codexUsageSnapshot } from "./codexusage";
import {
  activity,
  automations,
  channels,
  clients,
  type ClientState,
  deliver,
  harness,
  host,
  lastAgent,
  launch,
  madeFiles,
  memory,
  mouseEncodingOf,
  mouseEncodings,
  nodes,
  reloads,
  sees,
  send,
  sleeper,
  slots,
  state,
  store,
  turnStart,
  unread,
  usageLaunches,
  usageNodes,
  voice,
  watches,
  windows,
  workspaces,
} from "./context";
import { processCwd } from "./cwd";
import { closeDatabasePools } from "./databases";
import { allowRoot } from "./files";
import { kuruLaunchFlags } from "./harnesshome";
import { hookSettingsFlag, hookSettingsFor } from "./hooks";
import { web } from "./sweeps";
import { claudeDirOf, codexHomeOf, spawnEnv, spawnEnvFor, tokenInPtys } from "./lending";
import { endSession, findMachine, machinesSnapshot, sessionsEnding, sessionsOn } from "./machines";
import { findOpencode, prepareOpencodeAgent } from "./opencode";
import { agyAgentFlags } from "./agy";
import { hostBlob, writeSnapshot } from "./persist";
import { PORT } from "./preamble";
import { forget as forgetRecording, recordBacklog, recordNote, recordOutput } from "./record";
import { type Grid, smallestGrid } from "./sizing";
import { usageSnapshot } from "./usage";
import type { LaunchNote, LaunchNoteOf } from "./usage/attribute";
import { readRetention, usageReport } from "./usage/report";
import type { UsageReader } from "./usage/sweep";
import { abbreviateHome } from "../../shared/text";

/**
 * The layout goes two places, and they are not the same thing.
 *
 * The host gets it within `KEEP_GAP_MS`, agent ids and all — that is what makes
 * restarting this process invisible, and it never touches a disk. The file gets
 * it on a longer delay and with the processes stripped out, because that copy
 * is for surviving a quit, and dragging a divider changes the layout sixty
 * times a second while none of those are worth a write.
 *
 * Neither carries the boards. They are the database's (`store.ts`), and
 * `Store.attach` replaces whatever boards a blob brings with the rows, so
 * every card in the blob was 1.27 MB of a line the host had to parse — on the
 * thread that flushes every pty — for nothing, once per change, a divider
 * drag being sixty of those a second, each queued on the one socket ahead of
 * keystrokes. Without them the blob is the arrangement, it is sent at most
 * once per gap, and not at all when it is what the host already holds.
 */
const KEEP_GAP_MS = 100;
export let keepTimer: ReturnType<typeof setTimeout> | null = null;
let keptBlob: string | null = null;

export function keepNow(): void {
  if (keepTimer) clearTimeout(keepTimer);
  keepTimer = null;
  if (!workspaces) return;
  // `harness` is not there yet for the saves of startup, which carry no handover: nothing has been told.
  const blob = hostBlob(workspaces.all(), workspaces.active.id, harness?.handover());
  if (blob === keptBlob) return;
  keptBlob = blob;
  host.keep(blob);
}

/** The host's blob is due again and the file is not: what changed is the harness's handover, which the file never holds. */
export function queueKeep(): void {
  if (keepTimer) return;
  keepTimer = setTimeout(keepNow, KEEP_GAP_MS);
  keepTimer.unref?.();
}

export let saveTimer: ReturnType<typeof setTimeout> | null = null;
export function queueSave(): void {
  queueKeep();
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeSnapshot(workspaces.all(), workspaces.active.id);
  }, SAVE_DEBOUNCE_MS);
  saveTimer.unref?.();
}

/**
 * Where a new terminal should start, when nobody named a directory.
 *
 * The workspace's root, when it has one (`Workspace.root`), and nothing about
 * the pane it was opened from. That is the user's rule (2026-11-11): every
 * new shell, nvim, LazyGit and agent opens in the project's folder. The pane's
 * live directory lost because of what it usually is: wherever the last shell
 * was `cd`'d to, a `web/` or a worktree an agent was in, so the next card
 * started somewhere nobody chose. A worktree, a card's resume and a `dir`
 * still win, because they are named by whoever asks; this is only the answer
 * for nobody having said.
 *
 * Without a root, the rule from before roots, kept as the fallback rather
 * than replaced by `~`, since a workspace nobody has given one yet still had
 * a fair guess. A multiplexer's answer is "where the terminal you were just in is", and it
 * means *is*, not was: a minute after a shell opens it has been cd'd into a
 * project, and a tab that landed in the directory the pty was spawned in would
 * open in a home directory nobody is working in. So the pid is asked of the
 * kernel (`cwd.ts`) and what was recorded at spawn is only the fallback.
 *
 * Which terminal to follow is the rest of the question. The one this pane is
 * showing is the obvious answer; a pane with nothing in it remembers the project
 * it was for, which is what a restored layout and a fresh split have instead;
 * and failing both, the newest terminal anywhere in this workspace, because a
 * workspace is one piece of work and its directory is a better guess than `~`.
 */
async function cwdForNewTab(paneId: string): Promise<string | undefined> {
  const root = workspaceRoot(workspaces.active.id, workspaces.activeWorkspace.id);
  if (root) return root;
  const showing = workspaces.activeAgentIn(paneId);
  if (showing) {
    const followed = standing(await followCwd(showing));
    if (followed) return followed;
  }
  const remembered = standing(workspaces.cwdFor(paneId));
  if (remembered) return remembered;
  const newest = newestAgentHere();
  return newest ? standing(await followCwd(newest)) : undefined;
}

/** A remembered directory that is still there, or the repository of a worktree that is not — see `standingDir`. */
function standing(dir: string | undefined): string | undefined {
  return dir === undefined ? undefined : standingDir(dir, isDirectory);
}

/**
 * Where that terminal is now, or failing that where it was opened — and
 * nowhere for the harness, whose folder is its own and no project's: a tab
 * opened beside it, a split off its pane or an agent it starts from there
 * belongs in the workspace, not in kururu's data directory.
 */
async function followCwd(agentId: string): Promise<string | undefined> {
  const agent = host.find(agentId);
  if (!agent || isApart(agentId)) return undefined;
  // An exited pty has no cwd to read, and asking about a recycled pid would be
  // worse than not asking: its spawn directory is the only honest answer left.
  const live = agent.exited || !agent.pid ? undefined : await processCwd(agent.pid);
  return live ?? agent.cwd;
}

/** A terminal whose directory says nothing about its workspace: a harness, in its own folder. */
function isApart(agentId: string): boolean {
  return harness?.isHarness(agentId) != null;
}

/**
 * Open a terminal in a pane.
 *
 * Everything that *makes* a pane comes through here — a split, a new workspace,
 * a new profile, the first launch — as well as `new-tab` itself, which is the
 * point: a pane with nothing in it used to offer one button that opened a
 * terminal, and a choice with one option is not a choice, it is a step. Sharing
 * the call is also what keeps the automatic case and the asked-for one from
 * drifting apart.
 *
 * `from` is the pane whose cwd to follow, which is not always the pane the
 * terminal lands in. A split's new half is empty and remembers only the
 * directory its parent was *recorded* in, while the terminal still running next
 * door can be asked where it actually is.
 */
export async function openTerminal(
  paneId: string,
  options: { cwd?: string; command?: string; kind?: PtyKind; from?: string; local?: boolean } = {},
): Promise<AgentSnapshot> {
  // The Dashboard holds no terminals (`shared/dashboard.ts`). One asked for
  // there — a key, Settings starting a sign-in — opens in the workspace the
  // Dashboard was opened over, which comes back on screen to show it; its
  // focused pane is the one `hasPane` below falls back to.
  if (workspaces.onDashboard) workspaces.switchWorkspace(workspaces.active.activeWorkspaceId);
  const command = options.command ?? pinnedShell(workspaces.active.id, workspaces.activeWorkspace.id, options);
  const remote = remoteShellOf(command) !== null;
  // A shell on a machine starts where its folder is, over there; here, ssh
  // just needs somewhere to run, and home is the place that is always there.
  const cwd = remote ? homedir() : (options.cwd ?? (await cwdForNewTab(options.from ?? paneId)));
  const agent = await spawnHolding(command, () =>
    host.create({
      cwd,
      command,
      env: spawnEnv(),
      /**
       * A terminal unless the client insists otherwise. The window stopped
       * offering "start me an agent" as a separate thing to click: it is one
       * gesture fewer to open a terminal and type `claude` in it, and the tab ends
       * up saying the same thing either way, because `procs.ts` reports what is
       * actually running in there.
       */
      kind: options.kind ?? "shell",
    }),
  );
  /**
   * Crossing the link takes long enough for the pane to have been closed in the
   * meantime — a split followed straight away by `C-a x` is all it takes. An
   * agent in no pane at all is one running with nothing pointing at it, so it
   * goes wherever the focus ended up instead.
   */
  const target = workspaces.hasPane(paneId) ? paneId : workspaces.focusedPaneId;
  workspaces.addTab(agent.id, remote ? undefined : agent.cwd, target);
  workspaces.focusPane(target);
  // The project an agent is working in is one you can browse; that is the
  // whole basis on which the file tree decides what it may read. A tab on a
  // machine has no project here, and the `~` its ssh runs in is not one.
  if (!remote) allowRoot(agent.cwd);
  return agent;
}

/**
 * `openTerminal`, into a pane of a workspace that need not be on screen — the
 * harness's spelling, with the profile and workspace named. Nothing is
 * focused, because nobody is looking: the terminal is in the layout for when
 * they do. A pane closed while the host was spawning gets the workspace's
 * focused pane instead, on `openTerminal`'s reasoning.
 */
export async function openTerminalAt(
  profileId: string,
  workspaceId: string,
  paneId: string,
  options: { cwd?: string; command?: string; kind?: PtyKind; local?: boolean; apart?: boolean } = {},
): Promise<AgentSnapshot> {
  const command = options.command ?? pinnedShell(profileId, workspaceId, options);
  const remote = remoteShellOf(command) !== null;
  const cwd = remote ? homedir() : (options.cwd ?? (await cwdForPaneIn(profileId, workspaceId, paneId)));
  const agent = await spawnHolding(command, () =>
    host.create({ cwd, command, env: spawnEnvFor(profileId), kind: options.kind ?? "shell" }),
  );
  const workspace = workspaces.workspaceIn(profileId, workspaceId);
  if (!workspace) throw new Error("that workspace is gone");
  const target = workspaces.hasPaneIn(profileId, workspaceId, paneId) ? paneId : workspace.focusedPaneId;
  // `apart` is the harness in its own folder: a directory that is not this
  // workspace's, so the pane does not remember it and the tree is not given it.
  const here = !remote && !options.apart;
  workspaces.addTabIn(profileId, workspaceId, target, agent.id, here ? agent.cwd : undefined);
  if (here) allowRoot(agent.cwd);
  return agent;
}

/**
 * What a plain shell in a workspace runs when the workspace is pinned to a
 * machine: a tmux session there, in its folder. Undefined — the login shell
 * here, as ever — for anything else.
 *
 * "Plain" is narrow on purpose. A command means somebody built a line for a
 * reason, and the callers that build one for the machine — the new-tab
 * menu's nvim and agents, a card's run — have already asked `pinOf` and built
 * the remote line themselves; the rest (a card's dev server, the harness's
 * own session) are about this Mac. A directory means a place on *this* disk
 * (a worktree, the file tree's "open here"); `local` is the harness's "on
 * this Mac". Only the tab strip's terminal, `C-a T` and the terminal a split
 * opens have none of the three, and those are the shells a pinned workspace
 * means.
 */
function pinnedShell(
  profileId: string,
  workspaceId: string,
  options: { cwd?: string; command?: string; kind?: PtyKind; local?: boolean },
): string | undefined {
  if (options.local || options.command !== undefined || options.cwd !== undefined || (options.kind ?? "shell") !== "shell") {
    return undefined;
  }
  const pin = pinOf(profileId, workspaceId);
  return pin ? sessionShell(pin.machine, pin.workspaceName, pin.dir) : undefined;
}

/**
 * A workspace's pin with its machine looked up, or undefined when it runs
 * here. A pin to a machine since removed is no pin: the workspace comes home
 * rather than opening tabs on a host nobody can see in the sidebar.
 */
/**
 * The workspace's folder, for a LazyGit opened from its row: the main
 * checkout, which is what the row's git verbs act on, else where its file tree
 * starts — the repository the walk found, or outside one the directory the
 * focused terminal is in. Undefined before the walk has been, and the tab then
 * opens where any new tab would.
 *
 * Both are the walk's — directories the server found by going up from a
 * terminal it holds — and neither comes from the client. The active profile's
 * only, like the walk; a row's menu is always one of those.
 */
export function workspaceRepo(workspaceId: string): string | undefined {
  return (
    state.branches.find((head) => head.workspaceId === workspaceId)?.git?.root ??
    state.projects.find((project) => project.workspaceId === workspaceId)?.root
  );
}

/**
 * The workspace's root folder on this Mac, when it has one that is still
 * there — see `Workspace.root`. A root inside a worktree that has since been
 * removed reads as its repository, on `standing`'s reasoning; one that has
 * gone altogether reads as none, and the old rule answers instead.
 */
export function workspaceRoot(profileId: string, workspaceId: string): string | undefined {
  const root = workspaces.workspaceIn(profileId, workspaceId)?.root;
  return root ? standing(root) : undefined;
}

/**
 * A root as a client or Kuru sent it, cleaned and checked against the disk,
 * or null for "none". Throws the sentence to show. Asked at the moment it is
 * set, so a typo is said then rather than found at the next new tab.
 */
export function rootToStore(value: unknown): string | null {
  const root = workspaceRootPath(value, homedir());
  if (root === undefined) throw new Error("A root folder is an absolute path on this Mac, /… or ~/….");
  if (root !== null && !isDirectory(root)) throw new Error(`${tildePath(root, homedir())} is not a folder on this Mac.`);
  return root;
}

export function pinOf(profileId: string, workspaceId: string): { machine: MachineEntry; dir: string; workspaceName: string } | undefined {
  const workspace = workspaces.workspaceIn(profileId, workspaceId);
  const pin = workspace?.machine;
  const machine = pin ? findMachine(pin.machineId) : undefined;
  return workspace && pin && machine ? { machine, dir: pin.dir, workspaceName: workspace.name } : undefined;
}

/**
 * Session names handed to a tab whose spawn has not come back yet. The host
 * only lists a terminal once `create` returns, so two shells opened in the
 * same breath — a split, then another — would otherwise both see the slot
 * free and attach to one session, two tabs mirroring each other.
 */
const claimedSessions = new Set<string>();

/**
 * A shell on a machine in a tmux session of its own — see `sessionName` for
 * why the first slot no tab holds. Every machine's sessions count against
 * every other's, so two aliases for one box cannot hand out the same name.
 * `avoid` is what the machine itself says it has, for a line that types
 * something; see `commandOn`.
 */
export function sessionShell(
  machine: MachineEntry,
  workspaceName: string,
  dir: string,
  run?: string,
  more: { agent?: AgentCli; avoid?: Iterable<string> } = {},
): string {
  const taken = new Set([...sessionsEnding(), ...claimedSessions, ...(more.avoid ?? [])]);
  for (const agent of host.agents) {
    const session = remoteShellOf(agent.command)?.session;
    if (session) taken.add(session);
  }
  const session = sessionName(workspaceName, taken);
  claimedSessions.add(session);
  return remoteShellCommand({ host: machine.host, session, dir, run, agent: more.agent });
}

/**
 * A line that types `run` into a new session on a machine — nvim, an agent,
 * the harness's command — in a slot the machine says is free as well as the
 * tabs. See `sessionsOn` for why a plain shell does not ask and this does.
 * The listing is taken before the slot is chosen, and the choice and the
 * claim happen together after it, so two of these in flight cannot pick one
 * name.
 */
export async function commandOn(machine: MachineEntry, workspaceName: string, dir: string, run: string, agent?: AgentCli): Promise<string> {
  const avoid = (await sessionsOn(machine.host)) ?? [];
  return sessionShell(machine, workspaceName, dir, run, { agent, avoid });
}

/**
 * An agent on a machine: the launcher's line, with kururu's check that the
 * CLI is there and signed in typed ahead of it. `command` is the launcher's
 * line without the hook settings — see `remoteAgentRun`.
 */
export function agentOn(machine: MachineEntry, workspaceName: string, dir: string, cli: AgentCli, command: string): Promise<string> {
  return commandOn(machine, workspaceName, dir, remoteAgentRun(cli, command, machine.name), cli);
}

/** Spawn, and let go of the session name it was holding once the host lists it — or has refused it. */
async function spawnHolding(command: string | undefined, spawn: () => Promise<AgentSnapshot>): Promise<AgentSnapshot> {
  try {
    return await spawn();
  } finally {
    const session = remoteShellOf(command)?.session;
    if (session) claimedSessions.delete(session);
  }
}

/**
 * The tmux session behind a tab on a machine, ended because the tab is being
 * closed — see `endSession` for why closing and nothing else.
 *
 * Called from the doors a person closes a tab by (the tab, a pane, a
 * workspace, the harness's stop on their say-so) and never from
 * `reapExited`: a remote tab only ends on its own when ssh exits on purpose,
 * and the one way that leaves a session standing is a detach, which is a
 * person saying they want it kept.
 */
export function endRemote(agentId: string): void {
  const remote = remoteShellOf(host.find(agentId)?.command);
  if (remote?.session) endSession(remote.host, remote.session);
}

/** `cwdForNewTab`, for a pane of any workspace: the workspace's root, else the terminal it shows, else what it remembers, else the workspace's newest. */
export async function cwdForPaneIn(profileId: string, workspaceId: string, paneId: string): Promise<string | undefined> {
  const root = workspaceRoot(profileId, workspaceId);
  if (root) return root;
  const showing = workspaces.activeAgentInW(profileId, workspaceId, paneId);
  if (showing) {
    const followed = standing(await followCwd(showing));
    if (followed) return followed;
  }
  const remembered = standing(workspaces.cwdForIn(profileId, workspaceId, paneId));
  if (remembered) return remembered;
  const newest = workspaces
    .agentsInWorkspace(profileId, workspaceId)
    .map((id) => host.find(id))
    .filter((a): a is AgentSnapshot => a !== undefined && !a.exited && !isApart(a.id))
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  return newest ? standing(await followCwd(newest.id)) : undefined;
}

/**
 * The same, for the gestures that make a pane rather than ask for a terminal.
 * There is no reply for them to fail: a spawn that cannot happen leaves the pane
 * empty, which is a state the window can still draw and click its way out of.
 */
export function fillPane(paneId: string, from?: string): void {
  void openTerminal(paneId, from === undefined ? {} : { from }).catch((err) => {
    console.error("kururu: could not open a terminal:", err instanceof Error ? err.message : err);
  });
}

/**
 * The line that starts an agent from the menu, flags and all.
 *
 * A profile's own login directory has none of the hooks the machine's does, so
 * a Claude started into one is handed kururu's. See `hooks.ts`. And every
 * agent is pointed at kururu's web tools while a web provider is on — an
 * address on this Mac, never a key. See `web/chain.ts`.
 */
export function agentCommand(launcher: Launcher): Promise<string> {
  return agentCommandFor(launcher, workspaces.active.id);
}

/**
 * The same, for a profile that need not be on screen: its own hooks, if it
 * has its own directory. `settings` is the launch settings to build it from,
 * the profile's own unless a caller narrows them — an automation with
 * `permissions: ask` drops the bypass flag, and nothing ever adds one.
 */
export async function agentCommandFor(launcher: Launcher, profileId: string, sessionId?: string | null, settings = launch): Promise<string> {
  if (launcher.cli === "opencode") {
    const id = sessionId && sessionId.startsWith("ses_") ? sessionId : mintOpencodeSession();
    const found = await findOpencode();
    const config = prepareOpencodeAgent(id, { port: PORT, withToken: tokenInPtys(), model: launcher.model ?? settings.opencodeModel, web: web.active() });
    return opencodeAgentCommand(found.path, config, id, settings.bypassClis.includes("opencode") || settings.bypassClis.includes("claude"));
  }
  // Antigravity takes no hooks, MCP servers or web tools per launch — only
  // the session settings that make kururu's reporter its title command.
  // See `shared/agy.ts`.
  if (launcher.cli === "agy") return launcherCommand(launcher, settings) + agyAgentFlags();
  return launcherCommand(launcher, settings) + hooksFor(launcher, profileId) + web.launchFlags(launcher.cli) + kururuMcpOnly(launcher, profileId);
}

/**
 * ` --strict-mcp-config` for a Claude agent in a profile that keeps its agents
 * to kururu's MCP servers, or nothing — see `Profile.agentsKururuMcpOnly`.
 * kururu's own reach the agent through `--mcp-config`, which the flag keeps.
 * Claude Code only: Codex and OpenCode are handed their servers in config
 * kururu writes, and have no flag that drops the rest.
 */
export function kururuMcpOnly(launcher: Launcher, profileId: string): string {
  return launcher.cli === "claude" && workspaces.profile(profileId)?.agentsKururuMcpOnly ? " --strict-mcp-config" : "";
}

/**
 * Kuru's line on Claude Code: the launcher's, kururu's web tools, and
 * `kuruLaunchFlags` — strict MCP, the user's own servers, the plugins and
 * synced skills off, and the hooks folded into the one `--settings` rather
 * than passed as a second (`hooksFor`), which would replace it.
 */
export async function kuruCommandFor(launcher: Launcher, profileId: string): Promise<string> {
  const key = workspaces.keyOf(profileId);
  if (!key) throw new Error("that profile has no key yet");
  const dir = claudeDirOf(profileId);
  const kuru = await kuruLaunchFlags(dir, key, hookSettingsFor(dir), [HARNESS_SERVER, WEB_SERVER]);
  return launcherCommand(launcher, launch) + web.launchFlags(launcher.cli) + kuru;
}

/**
 * Which of the features Kuru's role and tools have parts about are set up on
 * this node — see `HarnessFeatures`. Telegram counts once it could be
 * switched on, and while it is on, whichever node set it up.
 */
export function harnessFeatures(): HarnessFeatures {
  const telegram = channels.status().telegram;
  return {
    nodes: nodes.statuses().length > 0,
    telegram: telegram.enabled || channelReady(telegram),
    machines: machinesSnapshot().length > 0,
    speak: voice.speaks(),
    slots: (slots?.inUse() ?? false) || workspaces.all().some((profile) => profile.workspaces.some((w) => w.mobile)),
  };
}

/** Everything the usage ledger keeps about a launch: what the road that started it said, and what can be looked up. */
function launchRow(agentId: string, profileId: string, workspaceId: string | null, note: LaunchNote): LaunchRow {
  const machine = note.machine ?? null;
  return {
    agentId,
    sessionId: note.sessionId,
    program: note.program,
    profileKey: workspaces.keyOf(profileId),
    workspaceKey: workspaceId ? (workspaces.workspaceIn(profileId, workspaceId)?.key ?? null) : null,
    cardId: note.cardId ?? null,
    kind: note.kind ?? (note.cardId ? "card" : "agent"),
    // Through `?.`, since the harness can start before the nodes are up, and a
    // row with no node is one read as this node's, like everything before this.
    node: nodes?.name() ?? null,
    machine,
    // A machine's login is over there, and the reader there will say.
    loginDir: machine ? null : note.program === "codex" ? codexHomeOf(profileId) : note.program === "claude" ? claudeDirOf(profileId) : null,
    cwd: note.cwd,
    at: Date.now(),
  };
}

/** kururu has just started an agent: the ledger is told whose it is. See `usage/attribute.ts`. */
export function noteLaunch(agentId: string, profileId: string, workspaceId: string | null, note: LaunchNoteOf): void {
  const { program } = note;
  // Antigravity's conversations are not in the ledger: see `noteReported`.
  if (program === "agy") return;
  usageLaunches?.spawned(launchRow(agentId, profileId, workspaceId, { ...note, program }));
}

/**
 * What the Usage page needs from the rest of the server: what things are called
 * and what is alive. Memoised for the one request, since these are asked per
 * cell and a card's title is a query. A session's `agent_id` is only as good as
 * the terminal still being the one it named, and ids are given out again after a
 * host restart, so a terminal younger than the session's last message is
 * somebody else's.
 */
export function usageReportFor(reader: UsageReader, range: UsageRange, by: UsageDimension): UsageReport {
  const memo = <T,>(read: (key: string) => T) => {
    const held = new Map<string, T>();
    return (key: string): T => {
      if (!held.has(key)) held.set(key, read(key));
      return held.get(key)!;
    };
  };
  const home = homedir();
  const card = memo((id) => store.usageCard(id));
  const liveIn = workspaces.active.workspaces;
  const names: UsageNames = {
    // A node's own workspace and card are known here only by what it said they were called.
    workspace: memo((key) => store.usageWorkspaceName(key) ?? reader.ledger.nodeName("workspaces", key)),
    card: memo((id) => card(id)?.title ?? reader.ledger.nodeName("cards", id)),
    here: process.platform === "darwin" ? "This Mac" : "This computer",
    liveAgent: (fact) => {
      if (!fact.agentId) return null;
      const agent = host.find(fact.agentId);
      if (!agent || agent.exited || agent.createdAt > fact.lastAt) return null;
      return { id: agent.id, label: agentLabel(agent) };
    },
    openableCard: (id) => {
      const key = card(id)?.workspaceKey;
      const workspace = key ? liveIn.find((w) => w.key === key) : undefined;
      return workspace ? { workspaceId: workspace.id } : null;
    },
    folder: (path) => abbreviateHome(path, home),
  };
  const claude = usageSnapshot();
  const weekly = (limits: readonly UsageLimit[] | undefined) => {
    const held = limits?.find((limit) => limit.kind === "weekly_all") ?? limits?.find((limit) => limit.kind.startsWith("weekly"));
    const at = held?.resetsAt ? Date.parse(held.resetsAt) : NaN;
    return Number.isFinite(at) ? at : null;
  };
  const claudeWeek = weekly(claude?.limits);
  const codexWeek = weekly(codexUsageSnapshot()?.limits);
  const profile = claudeDirOf(workspaces.active.id);
  const machine = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return usageReport(reader.ledger, range, by, Date.now(), {
    names,
    weekResetsAt: claudeWeek ?? codexWeek,
    weekOwner: claudeWeek !== null ? "claude" : codexWeek !== null ? "codex" : null,
    retention: profile === machine ? [readRetention(machine, "This Mac's login")] : [readRetention(profile, `${workspaces.active.name}'s login`), readRetention(machine, "This Mac's login")],
    status: reader.status(),
    remote: [...reader.machineSources(), ...(usageNodes?.sources() ?? [])],
  });
}

/** A hook in one of kururu's terminals named its session, which may be one no launch knew: `/clear`, or a `claude` typed into a shell. */
export function noteReported(agentId: string, body: Record<string, unknown>): void {
  // Antigravity's conversations are not in the ledger, which reads Claude's,
  // Codex's and OpenCode's logs: a row for one would hold nothing.
  if (body.program === "agy") return;
  const transcript = typeof body.transcript === "string" ? sessionOfTranscript(body.transcript) : null;
  usageLaunches?.reported(transcript ?? body.session, () => {
    const own = harness.isHarness(agentId);
    const at = own ? { profileId: own, workspaceId: null, cardId: null } : workspaces.terminalAt(agentId);
    if (!at) return null;
    return launchRow(agentId, at.profileId, at.workspaceId, {
      program: transcript ? "claude" : "opencode",
      sessionId: null,
      cardId: at.cardId,
      kind: own ? "harness" : undefined,
      cwd: host.find(agentId)?.cwd ?? null,
    });
  });
}

/**
 * Kururu's hooks for a Claude launch whose config directory does not already
 * run them — a profile's own, or the machine's on a box nobody installed them
 * on by hand, which is every child. `hookSettingsFlag` steps aside for a
 * directory that has them, so the Mac's hand-installed hooks are not doubled.
 */
export function hooksFor(launcher: Launcher, profileId: string): string {
  if (launcher.cli !== "claude" || !workspaces.profile(profileId)) return "";
  return hookSettingsFlag(claudeDirOf(profileId));
}

/** The newest terminal in this workspace, preferring one that is still running. */
function newestAgentHere(): string | undefined {
  const here = new Set(workspaces.agentsHere());
  // host.agents is oldest first, so the last of them is the most recent.
  const mine = host.agents.filter((agent) => here.has(agent.id) && !isApart(agent.id));
  const live = mine.filter((agent) => !agent.exited);
  return (live.length ? live : mine).at(-1)?.id;
}

/**
 * End one terminal the way its close button does: its tmux session on a
 * machine, the process group here, its tab, and everything this side kept
 * about it. `close-tab` and an idle card's sleep (`sleep.ts`) are the same
 * gesture, so they are the same function.
 */
export function endTerminal(agentId: string): void {
  endRemote(agentId);
  host.kill(agentId);
  workspaces.reapTab(agentId);
  forget(agentId);
}

/**
 * Reap a terminal the arrangement no longer has room for. Pane and workspace
 * deletion hand back what was inside them; this is what ends it.
 */
export function killAll(agentIds: string[]): void {
  for (const agentId of terminalsOf(agentIds)) {
    endRemote(agentId);
    host.kill(agentId);
    // It must not be left as a tab pointing at a terminal that no longer exists.
    workspaces.removeTab(agentId);
    forget(agentId);
  }
}

/**
 * Everything on this side that was about one terminal.
 *
 * Ids are not reused, so none of this is correctness — but every one of these
 * maps would otherwise grow for the life of the process. `lastStatus` and
 * `notifiedAt` are deliberately not in here: `noticeStatuses` drops an id the
 * moment the host stops listing it, which is the same event by a shorter road.
 */
export function forget(agentId: string): void {
  // A card whose agent was killed outright ends here; one that exited on its
  // own was already told by `noticeStatuses`.
  workspaces.noteRun(agentId, "", true);
  activity.delete(agentId);
  madeFiles.forget(agentId);
  turnStart.delete(agentId);
  harness.forget(agentId);
  sleeper.forget(agentId);
  lastAgent.delete(agentId);
  memory.delete(agentId);
  unread.delete(agentId);
  sizes.delete(agentId);
  for (const st of clients.values()) st.proposals.delete(agentId);
  forgetRecording(agentId);
  mouseEncodings.delete(agentId);
}

/**
 * Clear away terminals whose pty has ended on its own — `exit` at a shell, a
 * command that ran out, an agent that quit.
 *
 * The host keeps an exited pty listed with its screen intact, and that is right
 * for the host: it cannot know whether anybody still wants to read it, and a
 * screen is the only record a dead terminal leaves. Deciding is this side's
 * job, and the answer is that a tab is where a terminal *lives* — so when the
 * terminal has gone the tab has nothing left to be, and a pane holding nothing
 * else goes with it (`reapTab`). That is tmux's default and what typing `exit`
 * means everywhere else; the cost is the screen, and the alternative was a dead
 * tab per terminal you ever closed, waiting to be dismissed by hand.
 *
 * It is noticed here rather than in `agents/host.ts` for the reason `lastStatus`
 * is: that file costs the user every running agent to edit, and this is a matter
 * of taste that will be tuned. Nothing has to be remembered between calls,
 * because the reap is what makes the host stop listing it — the kill is a
 * message, so the same agent may still be in the list on the next push, and a
 * second kill is swallowed by `ptyhost.ts` and a second `reapTab` finds no pane.
 */
export function reapExited(): void {
  for (const agent of host.agents) {
    if (!agent.exited) continue;
    /*
     * Except a card's dev server. A dev line that dies does it in its first
     * second — a missing `.env`, a port already taken — and the screen is the
     * only place the reason was ever written; reaping it made the tab flash
     * and vanish with nothing to say why. It stays, the card says "ended",
     * and the card's ↻ or ■ is what takes the tab away.
     */
    if (workspaces.isCardDev(agent.id)) continue;
    // An automation's shell run, whose status is printed on its screen as it
    // exits: the clock reads it, then ends the terminal itself.
    if (automations?.holds(agent.id)) continue;
    // A Kuru that died starting, for the same reason: the tab is the only
    // record of why, and the next start is what takes it away.
    if (harness.diedStarting(agent.id)) continue;
    // Before the tab goes, while the layout can still say whose it was.
    harness.noticed(agent, agent.status, true);
    host.kill(agent.id);
    workspaces.reapTab(agent.id);
    forget(agent.id);
  }
}

// ---------------------------------------------------------------------------
// What is watched, the size each is drawn at, and the output
// ---------------------------------------------------------------------------

/**
 * What the host should stream, recomputed whenever it might have changed: every
 * terminal any client has on screen, plus every one any client is keeping an
 * emulator for. The union, because a pooled emulator that stops being fed is one
 * that has to be reconstructed — see `ClientState.warm`.
 *
 * The host reads its watched set as "somebody is looking at this" and keeps a
 * mark of its own off the back of it. That mark is not used — see `unread` and
 * `overlay` — and it is left alone because `agents/host.ts` costs the user every
 * running agent to edit.
 */
export function syncWatched(): void {
  const watched = new Set<string>();
  for (const st of clients.values()) {
    for (const id of st.watching) if (!isRemote(id)) watched.add(id);
    for (const id of st.warm) if (!isRemote(id)) watched.add(id);
  }
  host.watch(watched);
  // Another node's terminals are that node's to stream: the watch says so.
  watches?.sync();
}

/**
 * The shape each terminal is, as decided here rather than claimed by a pane.
 *
 * Empty at startup and filled by the first proposal, which is the honest state
 * of affairs: a pty the host spawned has whatever grid the host gave it, this
 * process has no way to ask, and the first client to put a pane on it is the
 * first thing that makes the size a decision anybody made. See `ownedGrid` for
 * the one path that has to answer before that has happened.
 */
const sizes = new Map<string, Grid>();

/**
 * The shape to fall back on for a terminal nothing has ever proposed a size for
 * — and it is applied, not merely reported, which is what makes it safe.
 *
 * It mirrors the spawn grid in `agents/screen.ts` rather than importing it:
 * that module is the pty host's and pulling it in here would drag a headless
 * xterm into this bundle, and the alternative — a constant they share — means
 * editing a file in `agents/`, which costs the user every agent they are
 * running. A mirror that has drifted therefore has to be harmless, and it is:
 * the screen is put into this shape before it is serialized, so the answer
 * names a grid that is true whether or not the guess matched.
 *
 * Nothing should reach it. `web/src/session.ts` sends `propose-size` and
 * `request-backlog` from one function for exactly this reason, so by the time
 * a history is being built the server owns a size for that terminal.
 */
const FALLBACK_GRID: Grid = {
  cols: Number(process.env.KURURU_COLS) || 120,
  rows: Number(process.env.KURURU_ROWS) || 40,
};

/**
 * The grid a terminal is at, establishing one if nobody has ever said.
 *
 * A read in every case that matters. The write is the cold path above, and it
 * resizes rather than guessing quietly, because a caller asking this is about
 * to lay a screen out in the answer.
 */
export function ownedGrid(agentId: string): Grid {
  const had = sizes.get(agentId);
  if (had) return had;
  host.resize(agentId, FALLBACK_GRID.cols, FALLBACK_GRID.rows);
  const grid = { ...FALLBACK_GRID };
  sizes.set(agentId, grid);
  return grid;
}

/**
 * Decide how big a terminal is, resize it, and tell everybody drawing it.
 *
 * This is the inversion Part 2 of the lifecycle rework exists for. A pane used
 * to fit its emulator to its own box and inform the pty afterwards, so the size
 * was whichever client resized last — which is fine with one window, is why a
 * phone made the desktop ragged, and, worse, let the client and the pty hold
 * two ideas of the shape at once. Every screen kururu has drawn wrong has been
 * that disagreement. Now the pty is resized first and each client's emulator
 * conforms to what it is told, in that order, so the two cannot diverge.
 *
 * The policy itself is `sizing.ts`, which argues for it. What is here is whose
 * proposals are still in play, and the answer is *everyone who has one* — with
 * no test against `watching`, deliberately. A pane measures its box in a layout
 * effect and the watch listing it arrives a passive effect later, so a proposal
 * is reliably the first this server hears of a terminal being on screen;
 * requiring `watching` to already contain it would mean answering the first
 * backlog at a size nobody asked for and correcting it a moment afterwards. So
 * a proposal counts from the moment it arrives, and `watch` is what takes it
 * away again — which is also what keeps a warm client, whose detached emulator
 * cannot measure a box and so never proposes anyway, out of the minimum.
 *
 * The one test here is `looking`, and it is a different question from either of
 * those: not which panes a client has, but whether anybody is in front of it.
 * A phone that locks keeps its panes and its socket and would otherwise go on
 * holding the desktop at phone width from a pocket, which is the bug this
 * inherited when the policy stopped being last-writer-wins. See `ClientState`.
 */
export function applySize(agentId: string): void {
  // Another node's terminal is sized there; what this node has to say about
  // it is one proposal, composed in `nodewatch.ts`.
  if (isRemote(agentId)) {
    watches?.sync();
    return;
  }
  const proposals: Grid[] = [];
  for (const st of clients.values()) {
    if (!st.looking) continue;
    const proposed = st.proposals.get(agentId);
    if (proposed) proposals.push(proposed);
  }
  const next = smallestGrid(proposals);
  if (!next) return;
  const { cols, rows } = next;
  const had = sizes.get(agentId);
  if (had && had.cols === cols && had.rows === rows) return;
  sizes.set(agentId, next);
  // Recorded for the same reason an input is: a repaint arriving on the wrong
  // side of a resize is the shape of most terminal bugs, and the bytes alone
  // cannot show which side it was on.
  recordNote(agentId, "resize", `${cols}x${rows}`);
  host.resize(agentId, cols, rows);
  /**
   * Warm clients are told too. A pooled emulator that is off screen is still
   * being fed bytes the agent laid out for the pty's grid, so an emulator left
   * at the old shape would wrap every one of them — and it would carry that
   * damage into the pane that borrows it next, having asked for nothing,
   * because there is nothing about a tab switch that says a rebuild is needed.
   */
  for (const [ws, st] of clients) {
    if (sees(st, agentId)) send(ws, { type: "grid", agentId, cols, rows });
  }
}

/**
 * A client went away, which is a window closing, a phone going to sleep, or
 * this server being about to be replaced. Everything it was holding open goes
 * with it: the terminals it had streaming, and its say in how big they are.
 *
 * The sizes are decided again *after* it is out of the map, so its proposals
 * are gone from the minimum. Closing the narrow window is how the wide one gets
 * its columns back, and without this the last shape a departed client asked for
 * would outlive it for as long as the terminal did.
 */
export function dropClient(ws: WebSocket): void {
  const st = clients.get(ws);
  if (!st) return;
  clients.delete(ws);
  watches?.leave(ws);
  syncWatched();
  for (const agentId of st.proposals.keys()) applySize(agentId);
  // A phone whose socket died with its key held must not keep Kuru quiet
  // everywhere else, and what it was going to play is not going to be heard
  // there.
  voice.leave(ws);
  // A page that said it was reloading goes this way, and so does one that
  // was closed while it waited.
  reloads.leave(ws);
  // The viewer cannot be open with nobody connected, and a connection to
  // somebody's production database is not a thing to keep for the company.
  if (windows() === 0) void closeDatabasePools();
}

/**
 * Output arrives already coalesced — the host batches it at one frame, because
 * the flood is on its side of the link and a message per pty write would cross
 * the process boundary as well as the socket. What is left here is fan-out: the
 * same chunk to every client watching that terminal.
 *
 * It used to decide `unread` here as well, on the theory that bytes off screen
 * are news. They are not — see `unread` — and a function on the hot path that
 * also carried a policy was the shape that made that easy to miss.
 */
export function onOutput(agentId: string, data: string): void {
  recordOutput(agentId, data);
  mouseEncodingOf(agentId).read(data);
  // Stringified once for every client that gets it, and only if one does:
  // this is the hottest path in the process.
  let payload: string | null = null;
  for (const [ws, st] of clients) {
    if (!sees(st, agentId)) continue;
    const pending = st.awaiting.get(agentId);
    if (pending) pending.queued.push(data);
    else deliver(ws, (payload ??= JSON.stringify({ type: "output", agentId, data } satisfies ServerMessage)));
  }
}

/**
 * Start holding a terminal's live output, ready for its backlog to go out first.
 *
 * One rebuild, one hold; the count is what makes overlapping rebuilds safe. See
 * `ClientState.awaiting` for why releasing on the first of them loses bytes.
 */
export function openQueue(st: ClientState, agentId: string): void {
  const pending = st.awaiting.get(agentId);
  if (pending) pending.inflight++;
  else st.awaiting.set(agentId, { inflight: 1, queued: [] });
}

/**
 * Hand a pane the history of a terminal, at the size the server owns.
 *
 * It used to resize first, to whatever grid the asking pane claimed on the
 * request, because a backlog is the server's emulator *serialized* and a
 * serialized screen is laid out at a particular width: reconstructed into a
 * grid of a different one it wraps, the rows below shift, and the top scrolls
 * away. The client's buffer then disagrees with the server's about where
 * everything is — permanently, because an agent redraws differentially and
 * never resends a row it believes is already right. That was the borked text on
 * a workspace switch and the cwd sitting inside an agent's input box.
 *
 * The shape still has to be right; what changed is who says so. It is settled
 * before this is ever called, by the `propose-size` the client sends in the
 * same breath as its request, so there is nothing to resize here and nothing to
 * take a pane's word for. The answer names the grid all the same — a screen
 * that states its own shape is correct for whoever receives it, and that is
 * worth keeping for the one ordering a single size does not cover.
 *
 * Everything after the `await` re-checks. A pane can close, the whole socket go
 * away, or the size be decided again by another client, in the time it takes to
 * drain the write queue and serialize.
 */
export async function sendBacklog(ws: WebSocket, agentId: string): Promise<void> {
  const { cols, rows } = ownedGrid(agentId);
  /**
   * The serialized screen, plus the one thing it cannot carry. Appended here
   * rather than in `screen.ts` so this fix costs a reconnect and not every agent
   * the user is running; see `mouseencoding.ts` for what is being restored.
   */
  const serialized = await host.backlog(agentId).catch(() => "");
  const data = serialized + mouseEncodingOf(agentId).suffix();
  const st = clients.get(ws);
  const pending = st?.awaiting.get(agentId);
  if (!st || !pending) return;
  const watching = sees(st, agentId);
  if (watching) {
    // The bytes, not just the size: a screen rebuilt wrongly can only be
    // explained by replaying exactly what rebuilt it.
    recordNote(agentId, "backlog", `${data.length} bytes rebuilt at ${cols}x${rows}`);
    recordBacklog(agentId, data);
    send(ws, { type: "backlog", agentId, data, cols, rows });
    /**
     * And the shape again, if it moved while this was being built.
     *
     * The host serialized at `cols`x`rows` — it had the request before any
     * later resize — so the answer is correct and the client is right to
     * become that shape to read it. But the `grid` announcing the newer size
     * went out *before* this did, so without this the client would end up back
     * at the older one while the pty sat at the newer, which is exactly the
     * permanent disagreement everything else here is arranged to prevent. It
     * takes two clients and a resize inside a few milliseconds to reach, and it
     * costs one message to close.
     */
    const now = sizes.get(agentId);
    if (now && (now.cols !== cols || now.rows !== rows)) {
      send(ws, { type: "grid", agentId, cols: now.cols, rows: now.rows });
    }
  }
  // A later rebuild is still being prepared, so the hold stays on for it.
  if (--pending.inflight > 0) return;
  st.awaiting.delete(agentId);
  if (!watching) return;
  for (const queued of pending.queued) send(ws, { type: "output", agentId, data: queued });
}

/**
 * Where a tab's terminal is now, as of the last look — never a wait.
 *
 * The spawn directory was the answer here once, and it is the reason a fresh
 * workspace's tree could sit on `~` while its only terminal had long since
 * `cd`'d into a project: a shell that moves never says so. The live cwd is an
 * `lsof` on macOS, one per terminal, and this is asked about every tab of
 * every workspace on the git poll — so the answer is cached, refreshed in the
 * background when stale, and a tab nobody has looked at yet answers with where
 * it was opened until the first look comes back one poll later.
 */
const cwdSeen = new Map<string, { at: number; cwd: string | undefined }>();
const CWD_CACHE_MS = 10_000;

export function tabCwd(agentId: string): string | undefined {
  const agent = host.find(agentId);
  if (!agent) {
    cwdSeen.delete(agentId);
    return undefined;
  }
  // Somewhere kururu cannot read: the branch, the tree and the database scan
  // are all about this disk, and the `~` the tab's ssh runs in is not a
  // project. A pinned workspace whose tabs are all remote has no project here.
  if (remoteShellOf(agent.command) || isApart(agentId)) return undefined;
  const seen = cwdSeen.get(agentId);
  if (!seen || Date.now() - seen.at > CWD_CACHE_MS) {
    // Stamped before the look so a slow `lsof` is not asked again by every
    // poll that lands while it is still running.
    cwdSeen.set(agentId, { at: Date.now(), cwd: seen?.cwd });
    void followCwd(agentId).then((cwd) => cwdSeen.set(agentId, { at: Date.now(), cwd }));
  }
  return seen?.cwd ?? agent.cwd;
}
