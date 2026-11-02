/**
 * The kururu server: one process between the agents and every UI.
 *
 * It owns the ptys, holds an emulator per agent, and pushes what changed down a
 * WebSocket to whoever is watching — the desktop window and the phone are the
 * same client code talking to this same server, which is what keeps the two from
 * drifting. It also serves the built web app, so the window loads a URL rather
 * than a file and there is exactly one asset pipeline.
 *
 * It used to poll a ghosttown daemon and forward what it saw. Now it is the
 * source, which removes the polling: a pty raises an event when it has something
 * to say, so snapshots are pushed when something actually changes rather than
 * on a timer. The timers that survive are the ones that could not be events —
 * end-of-work is *silence*, which raises no event, and the process table has to
 * be asked — plus one that coalesces, because output is an event thousands of
 * times a second and a socket should not be.
 *
 * It no longer owns the ptys. They live one process over, in `ptyhost.ts`, and
 * the reason is the dev loop: everything in this file changes weekly, and until
 * the split, restarting it to pick up a change took every agent with it. Now
 * this process can be killed and re-forked in under a second and the terminals
 * do not notice — it asks the host what is running, asks for the arrangement it
 * left behind, and carries on. See `hostlink.ts` for where the line is drawn.
 *
 * Runs on Node rather than Bun, which was once because Electron loaded it and is
 * now simply what it is: the bundle is built for node and the desktop no longer
 * starts it at all. Nothing here may import electron — this process is something
 * you run, possibly on a machine with no window on it, and the window is one
 * client of it exactly as the phone is.
 */
// First, so that nothing this server loads opens a connection on Node's 250 ms: see the module.
import "./connectbudget";
// Second, so that every module after it runs with crashes recorded: see the module.
import { PORT, RESTART_EXIT_CODE } from "./preamble";
import { randomUUID } from "node:crypto";
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { adoptMascot, countsAsAgent, defaultMascot } from "../../shared/model";
import { bindKey } from "../../shared/keys";
import type { Profile } from "../../shared/model";
import type { ClientMessage } from "../../shared/wire";
import { COMMIT_MESSAGE_MAX, GIT_ACTIONS, parseClientMessage } from "../../shared/wire";
import { DB_ROW_CAP, DB_SQL_MAX } from "../../shared/databases";
import { DROP_MAX_BYTES } from "../../shared/drops";
import {
  bindProblem,
  cookieHeader,
  fromLoopback,
  hasToken,
  isShared,
  learnTailnetName,
  listenAddresses,
  loopbackTokenRequired,
  rotateToken,
  setShare,
  sharing,
  token,
  verdict,
} from "./access";
import { parseReport } from "./agents/report";
import { dump as dumpRecording, recordInput, recordNote } from "./record";
import { DropRefused, keepDrop } from "./drops";
import { usageSnapshot } from "./usage";
import { codexUsageSnapshot } from "./codexusage";
import { clearOpenRouterKey, openRouterSnapshot, setOpenRouterKey } from "./openrouter";
// Every provider in web/providers/, each registering itself; the build makes this module from the directory.
import "kururu:web-providers";
import { callerAgent, localCaller } from "./web/chain";
import { Voice } from "./voice";
import { Outbox, legacyHeard } from "./outbox";
import { Kuru } from "./kuru";
import { Channels } from "./channels";
import { KURU_PAGE, KURU_SAY_MAX } from "../../shared/kuru";
import { type ChannelKind, isChannelKind } from "../../shared/channels";
import { Backup } from "./backup";
import { mirrorFiles } from "./export";
import { NodeHost, nodeRequestRefusal } from "./nodes";
import { NodeWatches } from "./nodewatch";
import { NodeNotices } from "./nodenotice";
import { qualifyRoot } from "../../shared/remote";
import { Mover } from "./move";
import { nodeOfUtterance, PeerKurus, peerKey } from "./peerkuru";
import { Secrets } from "./secrets";
import { TelegramLead } from "./lead";
import { webKind } from "../../shared/secrets";
import { noteCards } from "../../shared/notecards";
import { hostname } from "node:os";
import { Store, dataDir, dbPath } from "./store";
import { openUsageReader } from "./usage/sweep";
import { exportUsage, NodeUsage } from "./usage/remote";
import { parseRolloutListing } from "../../shared/sessions";
import { Launches } from "./usage/attribute";
import { isUsageDimension, isUsageRange } from "../../shared/usagereport";
import { isSearchScope } from "../../shared/store";
import { configDir } from "./config";
import { CLIP_MAX_BYTES, isClipId } from "../../shared/voice";
import {
  addMachine,
  codexRolloutsOn,
  findMachine,
  machinesSnapshot,
  pollMachine,
  removeMachine,
  usageChunkOn,
  usageFilesOn,
} from "./machines";
import { addHistory, adoptSpecs, editHistory, forgetSpecsRun, readSpecs, removeHistory, setTyped, specsSnapshot } from "./specs";
import { remoteShellCommand, remoteShellOf, validRemoteDir } from "../../shared/machines";
import { lazygitCommand, lazygitRun } from "../../shared/lazygit";
import { OnScreen } from "./onscreen";
import { Sleeper } from "./sleep";
import { closeDatabasePools, dbCatalog, dbQuery, dbRows } from "./databases";
import { allowedRoots, allowRoot, findDocs, listDir, listDirs, readBytes, readFile, resolveInRoot } from "./files";
import { parseFileOp, runFileOp } from "./fileops";
import { renderMarkdown } from "./markdown";
import { nvimCommand } from "./nvim";
import { activeAgent, BOARD_TAB, findPane, isBoardTab, isDocTab, terminalsOf } from "../../shared/layout";
import { isAgentPlacement } from "../../shared/agentpane";
import { builtinSheets, freshMascotId, importedSheets, importSheet, removeSheet, sheetImage, sheetsDir } from "./mascot";
import { writeKeys } from "./keys";
import { handsOf } from "../../shared/harness";
import { adoptNotify } from "../../shared/notify";
import { worktreePresent } from "./worktree";
import { Harness } from "./harness";
import { initializes, mcpAnswer } from "./mcp";
import { adoptLaunch, findLauncher, launcherCommand, launcherFor } from "../../shared/launchers";
import {
  addCard,
  addLane,
  cardPrompt,
  collapseLane,
  colorLane,
  editCard,
  mintCardId,
  mintLaneId,
  moveCard,
  moveLane,
  removeCard,
  removeLane,
  renameLane,
  resizeLane,
} from "../../shared/board";
import { soundBytes, sounds } from "./sounds";
import {
  annotate as annotateCatalog,
  assetFile,
  catalog,
  preview as previewStyle,
  readLibrary,
  remove as removeStyle,
  stylesHome,
} from "./styles";
import { isStyleKind } from "../../shared/styles";
import {
  createLocalSkin,
  localDir,
  putLocalAsset,
  readLocalManifest,
  removeLocalAsset,
  writeLocalManifest,
} from "./studio";
import { adoptAppearance, themeFor } from "../../shared/theme";
import { isStyleId, skinFor } from "../../shared/skin";
import { HOST_PROTOCOL, HostLink, type Port } from "./hostlink";
import { connectToHost, hostSocketPath, type SocketPort } from "./hostsock";
import { hostEnv, hostJobRunning, hostRuntime, launchHost, launchHostSystemd, unitOf } from "./hostlaunch";
import { hostEnding, lifecycleReport, lifeNow, readTail, record, recordStart, socketHeld, socketHolder, supervised } from "./lifecycle";
import { adoptReaders, readSnapshot, snapshotPath, writeSnapshot } from "./persist";
import { closeAllPreviews } from "./proxy";
import { reach } from "./reach";
import { checkForUpdate } from "./update";
import {
  isReloadHold,
  isReloadPage,
  oneLine,
  outcomeText,
  RELOAD_TIMEOUT_MAX_MS,
  RELOAD_TIMEOUT_MIN_MS,
  RELOAD_TIMEOUT_MS,
  WHY_MAX,
} from "../../shared/reload";
import { VERSION } from "./version";
import { Workspaces } from "./workspaces";
import {
  activity,
  appearance,
  backup,
  broadcast,
  channels,
  clients,
  type ClientState,
  deliver,
  harness,
  host,
  hostInfo,
  hostProtocol,
  keys,
  kuru,
  kuruKey,
  launch,
  lead,
  logins,
  madeFiles,
  mascots,
  MAX_ACTIVITY,
  mover,
  nodeNotices,
  nodes,
  notify,
  outbox,
  overlay,
  peerKurus,
  projects,
  provide,
  pushNodes,
  pushSecrets,
  pushSnapshot,
  reloaderOf,
  reloads,
  screens,
  secrets,
  send,
  sendState,
  sleeper,
  snapshot,
  snapshots,
  state,
  store,
  styles,
  syncRosterChannels,
  unread,
  usageLaunches,
  usageNodes,
  usageReader,
  voice,
  watches,
  windows,
  workspaces,
} from "./context";
import {
  cardDoneFor,
  cardStatus,
  commitCard,
  mergeCard,
  openWorktree,
  resumeCard,
  retireWorktrees,
  runCard,
  runCardAt,
  stashCard,
} from "./cards";
import { restartDev, stopDev } from "./carddev";
import { noticeStatuses } from "./notices";
import { cardHistoryOf, recordTurn, sayAside, searchFor } from "./conversation";
import { kuruFiles, noteMade, openMade, sendPictureFor, showFileFor } from "./madelinks";
import {
  agentCommand,
  agentCommandFor,
  agentOn,
  applySize,
  commandOn,
  cwdForPaneIn,
  dropClient,
  endRemote,
  endTerminal,
  fillPane,
  forget,
  harnessFeatures,
  keepNow,
  keepTimer,
  killAll,
  kuruCommandFor,
  noteLaunch,
  noteReported,
  onOutput,
  openQueue,
  openTerminal,
  openTerminalAt,
  ownedGrid,
  pinOf,
  queueSave,
  reapExited,
  saveTimer,
  sendBacklog,
  sessionShell,
  syncWatched,
  usageReportFor,
  workspaceRepo,
} from "./terminals";
import { WEB_DIST } from "./preamble";
import {
  leadEligibility,
  leadHealth,
  nodeAddress,
  nodeSummary,
  nodeUnreachable,
  refreshClaudeReady,
  secretLanded,
  STARTED_AT,
  webFieldKind,
} from "./thisnode";
import { claudeDirOf, codexHomeOf, lendingLogin, lendOffer, lendSecrets, moveAndLend, tokenInPtys, vaultFor } from "./lending";
import { installOne, saveAppearance, saveLaunch, saveMascots, saveNotify, saveProject, wear } from "./look";
import { databasesOfWorkspace, workspaceDirs, workspaceGit } from "./repostatus";
import {
  closeNvims,
  editorsHere,
  hookEditor,
  killNvims,
  NVIM_BODY_LIMIT,
  nvimBuffer,
  openInEditor,
  readForWatcher,
  rootForDir,
} from "./editors";
import {
  broadcastSpecs,
  footprint,
  pollAccountUsage,
  pollOpenRouterAccount,
  pollServers,
  startSweeps,
  stopListedDevServer,
  stopSweeps,
  wakeProcesses,
  web,
  webAgentName,
} from "./sweeps";

startSweeps();

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

/** A database id and an optional database name, as the viewer's three requests all carry. */
function validDbRef(dbId: unknown, database: unknown): dbId is string {
  return typeof dbId === "string" && (database === undefined || typeof database === "string");
}

function reply(ws: WebSocket, id: number, run: () => unknown): void {
  try {
    send(ws, { type: "reply", id, ok: true, result: run() ?? true });
  } catch (err) {
    send(ws, { type: "reply", id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/** The same, for anything that has to cross the link and come back. */
/** A channel by its kind off the wire. One kind today; the throw is the sentence a page shows for a kind this server does not know. */
function channelFor(kind: unknown): Channels["telegram"] {
  if (!isChannelKind(kind)) throw new Error("kururu does not know that channel.");
  const byKind: Record<ChannelKind, Channels["telegram"]> = { telegram: channels.telegram };
  return byKind[kind];
}

async function replyAsync(ws: WebSocket, id: number, run: () => Promise<unknown>): Promise<void> {
  try {
    send(ws, { type: "reply", id, ok: true, result: (await run()) ?? true });
  } catch (err) {
    send(ws, { type: "reply", id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * One frame off a client's socket. Everything past the gate is trusted to be
 * the user, not to be well formed: `JSON.parse("null")` succeeds, and a verb
 * read off it threw outside any try — `ws.on("message")` has none — which is
 * an uncaught exception, and a server that under `bun run dev` stays down
 * until the next save. So the shape is checked before anything reads it, and
 * a verb that throws on a field it was not sent is logged and answered,
 * never the end of the process.
 */
function handleMessage(ws: WebSocket, raw: string): void {
  const st = clients.get(ws);
  if (!st) return;
  const msg = parseClientMessage(raw);
  if (!msg) {
    // Its length and not its words: a frame from a terminal can be typing.
    console.error(`kururu: dropped a client message that is not one (${raw.length} characters)`);
    return;
  }
  try {
    dispatchMessage(ws, st, msg);
  } catch (err) {
    console.error(`kururu: a "${msg.type}" message failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    const id = (msg as { id?: unknown }).id;
    if (typeof id === "number" && Number.isFinite(id)) send(ws, { type: "reply", id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

function dispatchMessage(ws: WebSocket, st: ClientState, msg: ClientMessage): void {
  // The user typing or moving about, from any client, is what an Auto Swap
  // waits for or gives way to — see `handsOf`. Before the verb runs, so that a
  // switch somebody just made is never followed by a swap that was waiting.
  // Typing also names its terminal, which the harness does not type into
  // while the user is.
  const hands = handsOf(msg.type);
  if (hands) harness.hands(hands, msg.type === "input" ? msg.agentId : undefined);

  // A verb about another node's workspace goes there and is never done here;
  // see `nodewatch.ts`. A watcher's own verbs are this node's, ids bare.
  if (!st.watcher && watches.handle(ws, st, msg)) return;

  switch (msg.type) {
    // --- terminals ---------------------------------------------------------

    case "new-tab": {
      // From a workspace row's menu, which may not be the workspace on screen:
      // there first, as `open-board` goes, so the tab opens where you can see it.
      const fromRow = typeof msg.workspaceId === "string";
      if (typeof msg.workspaceId === "string") workspaces.switchWorkspace(msg.workspaceId);
      const paneId = msg.paneId ?? workspaces.focusedPaneId;
      void replyAsync(ws, msg.id, async () => {
        /*
         * In a workspace pinned to a machine, everything the menu offers opens
         * there: the terminal through `pinnedShell`, nvim and the agents here,
         * typed into a session of their own in the pin's folder. A directory
         * sent with it is a place on this disk and keeps the tab here, as
         * `local` does.
         */
        const pin = msg.cwd === undefined && msg.local !== true ? pinOf(workspaces.active.id, workspaces.activeWorkspace.id) : undefined;
        if (msg.launcher !== undefined) {
          // Looked up, never built: the id is the only thing taken off the wire.
          // Switched-off rows are not refused — the setting trims a menu, and a
          // second client with a stale one is still asking for a real agent.
          const launcher = typeof msg.launcher === "string" ? launcherFor(msg.launcher, launch) : undefined;
          if (!launcher) throw new Error(`no such agent: ${String(msg.launcher)}`);
          // Named now, as a card's run is, so that the ledger knows whose it is
          // before it has said a word. See `usage/attribute.ts`.
          const at = { profileId: workspaces.active.id, workspaceId: workspaces.activeWorkspace.id };
          const sessionId = launcher.cli === "claude" ? randomUUID() : null;
          const sessionFlag = sessionId ? ` --session-id ${sessionId}` : "";
          if (pin) {
            const command = await agentOn(pin.machine, pin.workspaceName, pin.dir, launcher.cli, launcherCommand(launcher, launch) + sessionFlag);
            const agent = await openTerminal(paneId, { command, kind: "agent" });
            noteLaunch(agent.id, at.profileId, at.workspaceId, { program: launcher.cli, sessionId, machine: pin.machine.name, cwd: pin.dir });
            return agent;
          }
          const agent = await openTerminal(paneId, { cwd: msg.cwd, command: (await agentCommand(launcher)) + sessionFlag, kind: "agent" });
          noteLaunch(agent.id, at.profileId, at.workspaceId, { program: launcher.cli, sessionId, cwd: agent.cwd });
          return agent;
        }
        if (msg.nvim) {
          // The editor there, not this one: no socket for the reader to follow
          // it by, since the reader reads this disk.
          if (pin) return openTerminal(paneId, { command: await commandOn(pin.machine, pin.workspaceName, pin.dir, "nvim"), kind: "shell" });
          return openTerminal(paneId, { cwd: msg.cwd, command: nvimCommand(), kind: "shell" });
        }
        if (msg.lazygit) {
          if (pin) return openTerminal(paneId, { command: await commandOn(pin.machine, pin.workspaceName, pin.dir, lazygitRun(pin.machine.name)), kind: "shell" });
          const cwd = msg.cwd ?? (fromRow ? workspaceRepo(workspaces.activeWorkspace.id) : undefined);
          return openTerminal(paneId, { cwd, command: lazygitCommand(), kind: "shell" });
        }
        return openTerminal(paneId, { cwd: msg.cwd, command: msg.command, kind: msg.kind, local: msg.local === true });
      });
      return;
    }

    case "close-tab": {
      const focused = findPane(workspaces.activeWorkspace.layout, workspaces.focusedPaneId);
      const agentId = msg.agentId ?? (focused ? activeAgent(focused) : null);
      // The board's tab is a view: closing it ends nothing, and the cards stay
      // on the workspace for the next `open-board`.
      if (isBoardTab(agentId)) workspaces.removeTab(BOARD_TAB);
      // A document is closed where it is showing — the only place the key can
      // mean — since the same one may be open in another pane.
      else if (isDocTab(agentId)) {
        if (focused && !msg.agentId) workspaces.closeDoc(focused.id, focused.activeIdx);
      } else if (agentId) {
        // Closing a pane's last terminal closes the pane (`reapTab`), the same as
        // when its pty ends; the last pane of a workspace stays, empty.
        for (const id of terminalsOf([agentId])) endTerminal(id);
      }
      return;
    }

    case "select-tab":
      workspaces.selectTab(msg.paneId, msg.index);
      return;

    case "cycle-tab":
      workspaces.cycleTab(msg.delta, msg.paneId);
      return;

    case "move-tab":
      workspaces.moveTab(msg.agentId, msg.paneId, msg.index);
      return;

    case "split-with":
      workspaces.splitWith(msg.agentId, msg.paneId, msg.dir, msg.before);
      return;

    case "move-tab-to-workspace":
      workspaces.moveTabToWorkspace(msg.agentId, msg.workspaceId);
      return;

    case "reorder-agent": {
      // The base is the host's order, exactly as `snapshot` takes it, because
      // the list the drop was aimed at was drawn from that and a splice against
      // any other would land the row above a different neighbour.
      const profileId = workspaces.profileOf(msg.agentId);
      if (!profileId) return;
      const mine = new Set(workspaces.agentsIn(profileId));
      const ids = host.agents.filter((agent) => mine.has(agent.id)).map((agent) => agent.id);
      workspaces.reorderAgent(msg.agentId, msg.beforeAgentId, ids);
      return;
    }

    case "hide-agent":
      // No id check of its own: `setAgentHidden` finds the profile the terminal
      // is in and does nothing when there isn't one, which is the same answer a
      // guard here would give one line earlier.
      workspaces.setAgentHidden(msg.agentId, msg.hidden === true);
      return;

    case "rename-tab":
      if (!isBoardTab(msg.agentId)) host.rename(msg.agentId, msg.name);
      return;

    case "input":
      // No reply: this is what the user typed, and it is either delivered or the
      // terminal is visibly dead already.
      recordInput(msg.agentId, msg.data);
      if (typeof msg.data === "string") sleeper.typed(msg.agentId, msg.data);
      host.write(msg.agentId, msg.data);
      return;

    case "propose-size": {
      /**
       * A pane's opinion, not its decision. Checked to the same floor the host
       * checks to, so a box that has not been laid out cannot enter the
       * minimum: the smallest proposal wins, which makes a bad small one the
       * worst possible input this could take.
       */
      const { agentId, cols, rows } = msg;
      if (!Number.isInteger(cols) || !Number.isInteger(rows)) return;
      if (cols < 2 || rows < 2) return;
      st.proposals.set(agentId, { cols, rows });
      applySize(agentId);
      return;
    }

    case "resync": {
      st.sent = null;
      if (!st.owedSnapshot) sendState([[ws, st]], snapshot());
      return;
    }

    case "looking": {
      /**
       * Somebody arrived at this screen, or left it. The proposals are kept
       * either way and merely stop counting — see `ClientState.looking` — so
       * this is one recount over the terminals this client has an opinion
       * about, and a window coming back off another Space votes with the boxes
       * it already had rather than waiting to measure them again.
       */
      const looking = msg.looking !== false;
      if (looking === st.looking) return;
      st.looking = looking;
      for (const agentId of st.proposals.keys()) applySize(agentId);
      return;
    }

    case "watch": {
      const next = new Set(msg.agentIds);
      const kept = new Set(msg.warm ?? []);
      const opened = [...next].filter((id) => !st.watching.has(id));
      st.watching = next;
      st.warm = kept;
      /**
       * Withdraw the proposals for whatever this client can no longer see, and
       * decide those terminals again without them. This is how a pane closing
       * gives the size back — the other client watching the same agent stops
       * being held to a width nobody is drawing at, and a terminal with no
       * visible watcher left keeps the shape it had rather than being resized
       * by whoever merely has it pooled.
       */
      for (const id of [...st.proposals.keys()]) {
        if (next.has(id)) continue;
        st.proposals.delete(id);
        applySize(id);
      }
      // A pane that closed while its backlog was in flight should not receive it
      // — unless the emulator behind it is still pooled, in which case it is the
      // same emulator and the same question, merely off screen.
      for (const id of [...st.awaiting.keys()]) {
        if (!next.has(id) && !kept.has(id)) st.awaiting.delete(id);
      }
      syncWatched();
      /**
       * Streaming starts here and history does not. Watching says which
       * terminals are on screen; it is a set of ids and it cannot say how wide
       * any of them is, so answering it with a reconstruction meant serializing
       * a screen at whatever width the pane that last drew this terminal
       * happened to be. The emulator that is about to draw it asks for itself,
       * and says what shape it is while asking.
       */
      let seen = false;
      for (const id of opened) {
        recordNote(id, "watch", "a client opened this terminal");
        // Somebody is looking at it now, so whatever it wanted has been seen.
        // Opened, not merely warm: an emulator kept current in a workspace you
        // are not in is nobody reading it. The other way the mark comes off is
        // the terminal going back to work — see `noticeStatuses`.
        if (unread.delete(id)) seen = true;
      }
      if (seen) pushSnapshot();
      return;
    }

    case "request-backlog":
      // Queue this terminal's live output behind the history: the client is
      // about to clear its emulator, and anything that overtakes the answer
      // would be wiped by it. `openQueue` counts rather than sets, so two
      // rebuilds in flight at once do not release each other's hold — rare now
      // that ordinary navigation rebuilds nothing, and kept because counting is
      // free and the bug it prevents is bytes the client never sees again.
      openQueue(st, msg.agentId);
      void sendBacklog(ws, msg.agentId);
      return;

    // --- panes -------------------------------------------------------------

    case "split": {
      // The half you were in is where the new one's directory comes from: it has
      // a terminal in it that can be asked where it is now, which is better than
      // the directory the pane was recorded as being for.
      const from = msg.paneId ?? workspaces.focusedPaneId;
      const fresh = workspaces.split(msg.dir, from);
      if (fresh) fillPane(fresh, from);
      return;
    }

    case "close-pane":
      killAll(workspaces.closePane(msg.paneId));
      return;

    case "focus-pane":
      workspaces.focusPane(msg.paneId);
      return;

    case "focus-dir":
      workspaces.focusDirection(msg.dir);
      return;

    case "step-pane":
      workspaces.stepFocus(msg.delta);
      return;

    case "last-pane":
      workspaces.lastPane();
      return;

    case "set-ratio":
      workspaces.setRatio(msg.splitId, msg.ratio);
      return;

    case "nudge":
      workspaces.nudge(msg.dir, msg.delta);
      return;

    case "swap-panes":
      workspaces.swapPanes(msg.paneId, msg.withPaneId);
      return;

    case "move-pane":
      workspaces.movePane(msg.paneId, msg.toPaneId, msg.dir, msg.before);
      return;

    case "merge-panes":
      workspaces.mergePanes(msg.paneId, msg.intoPaneId);
      return;

    // --- workspaces --------------------------------------------------------

    case "new-workspace":
      // A workspace is one piece of work, so its first terminal starts in the
      // directory a terminal opened in it would: `cwdForNewTab` finds nothing
      // here to follow, which is the honest answer for work not started yet.
      workspaces.newWorkspace(msg.name);
      fillPane(workspaces.focusedPaneId);
      return;

    case "switch-workspace":
      workspaces.switchWorkspace(msg.workspaceId);
      return;

    case "workspace-index":
      workspaces.switchWorkspaceByIndex(msg.index);
      return;

    case "step-workspace":
      workspaces.stepWorkspace(msg.delta);
      return;

    case "last-workspace":
      workspaces.lastWorkspace();
      return;

    case "rename-workspace":
      workspaces.renameWorkspace(msg.workspaceId, msg.name);
      return;

    case "set-workspace-mascot":
      workspaces.setWorkspaceMascot(msg.workspaceId, msg.mascotId);
      return;

    // --- the mascot --------------------------------------------------------
    /**
     * The selection is adopted rather than trusted: it arrives from a client,
     * and `adoptMascot` is what turns "a number somebody dragged too far" into
     * the nearest legal one. A sheet that does not exist is refused there and
     * falls back, so what gets written is always something that can be drawn.
     *
     * A message naming a mascot that is not there is dropped rather than
     * creating one. Settings only ever edits something it is looking at, so this
     * is a message from a window whose list is a moment out of date, and
     * resurrecting a deleted mascot is a worse answer than losing one drag.
     */
    case "set-mascot": {
      const one = mascots.list.find((m) => m.id === msg.id);
      if (!one) return;
      saveMascots({
        ...mascots,
        // Id and name first, so the file stays readable to the person it says
        // can edit it by hand.
        list: mascots.list.map((m) =>
          m.id === msg.id ? { id: m.id, name: m.name, ...adoptMascot(msg.mascot) } : m,
        ),
      });
      return;
    }

    /**
     * A copy of the one you are looking at, not a fresh default: you press this
     * when the thing in front of you is nearly right, and starting from the
     * default frog would throw away the sheet and the cell size you had just
     * found. It becomes the active one, because adding something you then have
     * to go and click is a step that decided nothing.
     */
    case "add-mascot": {
      const from = mascots.list.find((m) => m.id === (msg.from ?? mascots.default)) ?? mascots.list[0]!;
      const id = freshMascotId(mascots.list);
      saveMascots({
        ...mascots,
        // Capped here rather than left for the adopter, or a name copied enough
        // times would come back forty characters shorter than it went in.
        list: [...mascots.list, { ...from, id, name: `${from.name} copy`.slice(0, 40) }],
      });
      return;
    }

    /**
     * The last one cannot go. An empty list would mean a working agent with
     * nothing in its row, which is the one thing the mascot exists to prevent —
     * so the button is hidden rather than the message refused, and this is the
     * backstop for the window that had two of them a second ago.
     */
    case "remove-mascot": {
      if (mascots.list.length < 2) return;
      const list = mascots.list.filter((m) => m.id !== msg.id);
      if (list.length === mascots.list.length) return;
      saveMascots({
        default: list.some((m) => m.id === mascots.default) ? mascots.default : list[0]!.id,
        list,
      });
      return;
    }

    case "rename-mascot": {
      const name = msg.name.trim().slice(0, 40);
      if (!name) return;
      saveMascots({ ...mascots, list: mascots.list.map((m) => (m.id === msg.id ? { ...m, name } : m)) });
      return;
    }

    case "set-default-mascot": {
      if (!mascots.list.some((m) => m.id === msg.id)) return;
      saveMascots({ ...mascots, default: msg.id });
      return;
    }

    // --- the keyboard ------------------------------------------------------
    /**
     * `bindKey` is where the checking is, and it is shared with the client for
     * the usual reason: the action has to be one of the ones that exist and the
     * key has to be one a person can press, and two spellings of that would
     * disagree about exactly the case that matters. It returns the overrides
     * unchanged when it refuses, so a bad message is a no-op rather than an
     * error nobody is listening for.
     */
    case "bind-key": {
      provide("keys", bindKey(keys, msg.key, msg.action));
      writeKeys(keys);
      pushSnapshot();
      return;
    }

    case "reset-keys": {
      provide("keys", {});
      writeKeys(keys);
      pushSnapshot();
      return;
    }

    // --- how it looks ------------------------------------------------------
    /**
     * `themeFor` is the check and the fallback in one, which is the shape
     * `mascotFor` has and is right for the same reason: an id naming nothing is
     * what a downgrade looks like, and the default drawn is a better answer than
     * a refusal nobody is listening for. What gets written is therefore always
     * an id this version can draw.
     */
    case "set-theme":
      saveAppearance({ ...appearance, themeId: themeFor(msg.themeId, styles.themes).id });
      return;

    /**
     * The same shape `set-theme` has, and nothing more, because the difference
     * between the two is entirely on the client: a skin moves the line weight
     * and the type ramp, so applying one re-measures every terminal, whereas a
     * theme never does. That belongs where the measuring happens — nothing here
     * resizes anything, for the reason `set-terminal-appearance` gives below.
     */
    case "set-skin":
      saveAppearance({ ...appearance, skinId: skinFor(msg.skinId, styles.skins).id });
      return;

    /**
     * A notification was clicked. Take them to it — see `Workspaces.reveal` for
     * why the four moves are one method, and note the one thing this does *not*
     * do: nothing here raises the window. That is the desktop bridge's, because
     * only the process that owns a window can raise it, and the phone has no
     * window to raise.
     */
    case "reveal-agent":
      workspaces.reveal(msg.agentId);
      return;

    // The profile on screen is the one whose harness the button means; the
    // harness itself, once running, is not bound to what is on screen.
    case "open-harness": {
      const run = () =>
        harness.open(workspaces.active.id, { fresh: msg.fresh === true });
      // Asked with an id, the answer waits for a Kuru just started to be up
      // or to have died, so the drawer can say which. See `Harness.whenUp`.
      const ask = async () => {
        const opened = await run();
        if (opened.started) await harness.whenUp(opened.agentId);
        return { agentId: opened.agentId };
      };
      if (typeof msg.id === "number") void replyAsync(ws, msg.id, ask);
      else void run().catch((err: unknown) => console.error("kururu: could not open the harness:", err instanceof Error ? err.message : err));
      return;
    }

    case "restart-harness":
      if (typeof msg.id !== "number") return;
      void replyAsync(ws, msg.id, async () => {
        if (typeof msg.profileId !== "string" || !workspaces.profile(msg.profileId)) throw new Error("no such profile");
        return harness.restart(msg.profileId);
      });
      return;

    case "set-auto-swap":
      if (typeof msg.profileId !== "string") return;
      workspaces.setAutoSwap(msg.profileId, msg.on === true);
      return;

    case "set-agents-kururu-mcp-only":
      if (typeof msg.profileId !== "string") return;
      workspaces.setAgentsKururuMcpOnly(msg.profileId, msg.on === true);
      return;

    case "set-agent-placement":
      // Refused rather than defaulted, `set-profile-column-color`'s line: a word
      // that is not one of the three is not a choice to round to the nearest.
      if (typeof msg.profileId !== "string") return;
      if (typeof msg.workspaceId === "string") {
        if (msg.placement !== null && !isAgentPlacement(msg.placement)) return;
        workspaces.setWorkspaceAgentPlacement(msg.profileId, msg.workspaceId, msg.placement);
      } else if (isAgentPlacement(msg.placement)) {
        workspaces.setAgentPlacement(msg.profileId, msg.placement);
      }
      return;

    case "set-project":
      saveProject(msg.root, msg.settings);
      return;

    case "retire-worktrees":
      void replyAsync(ws, msg.id, () => retireWorktrees(msg.root));
      return;

    case "add-machine":
      reply(ws, msg.id, () => {
        const entry = addMachine(msg);
        adoptSpecs(entry, machinesSnapshot());
        broadcast({ type: "machines", machines: machinesSnapshot() });
        broadcastSpecs();
        void pollMachine(entry.id).then(() => broadcast({ type: "machines", machines: machinesSnapshot() }));
        return entry;
      });
      return;

    case "node-invite":
      reply(ws, msg.id, () => nodes.invite(msg.on === true));
      return;
    case "node-join":
      void replyAsync(ws, msg.id, () => nodes.join(msg.text));
      return;
    case "node-rename":
      void replyAsync(ws, msg.id, () => nodes.rename(msg.nodeId, msg.name));
      return;
    case "node-rank":
      void replyAsync(ws, msg.id, () => nodes.rank(msg.order));
      return;
    case "node-remove":
      void replyAsync(ws, msg.id, () => nodes.remove(msg.nodeId));
      return;
    case "node-move-plan":
      void replyAsync(ws, msg.id, () => mover.plan(workspaces.active.id, String(msg.workspaceId), String(msg.nodeId), typeof msg.folder === "string" ? msg.folder : null));
      return;
    case "node-new-check":
      void replyAsync(ws, msg.id, () => mover.newCheck(String(msg.nodeId), typeof msg.name === "string" ? msg.name : "", typeof msg.folder === "string" ? msg.folder : null));
      return;
    case "node-new-workspace":
      void replyAsync(ws, msg.id, () => mover.newOn(String(msg.nodeId), typeof msg.name === "string" ? msg.name : "", String(msg.folder ?? "")));
      return;
    case "node-card-done":
      void replyAsync(ws, msg.id, async () => {
        const name = nodes.nameOf(String(msg.nodeId));
        if (!name) throw new Error("That node is not in the roster.");
        const answer = await nodes.ask(
          String(msg.nodeId),
          (id) => ({ type: "card-done-ask", id, workspaceKey: String(msg.workspaceKey), cardId: String(msg.cardId) }),
          10_000,
          `${name} did not answer, so the card was not moved.`,
        );
        if (answer.type !== "card-done-said") throw new Error(`${name} answered something else.`);
        if (answer.error) throw new Error(answer.error);
        return { ok: true };
      });
      return;
    case "node-move":
      void replyAsync(ws, msg.id, () => moveAndLend(workspaces.active.id, String(msg.workspaceId), String(msg.nodeId), String(msg.folder ?? ""), msg.lend, "user"));
      return;
    case "vault":
      void replyAsync(ws, msg.id, () => vaultFor());
      return;
    case "secrets-offer":
      void replyAsync(ws, msg.id, () => lendOffer(workspaces.active.id, String(msg.workspaceId), String(msg.nodeId), typeof msg.folder === "string" ? msg.folder : null));
      return;
    case "secrets-lend":
      void replyAsync(ws, msg.id, () => lendSecrets(workspaces.active.id, String(msg.workspaceId), String(msg.nodeId), typeof msg.folder === "string" ? msg.folder : null, msg.ask));
      return;

    case "secret-grant":
      reply(ws, msg.id, () => secrets.grant(msg.nodeId, msg.kind, msg.on === true));
      return;
    case "secret-push":
      reply(ws, msg.id, () => secrets.pushAgain(msg.nodeId, msg.kind));
      return;
    case "claude-lend":
      void replyAsync(ws, msg.id, async () => {
        const { login, account } = await lendingLogin(msg.profileId);
        return secrets.lend(login, msg.token, account);
      });
      return;
    case "claude-unlend":
      reply(ws, msg.id, () => secrets.unlend(msg.login));
      return;
    case "claude-lend-open":
      void replyAsync(ws, msg.id, async () => {
        if (nodes.role() === "child") throw new Error("A child does not lend logins; its parent does.");
        if (typeof msg.profileId !== "string" || msg.profileId !== workspaces.active.id) throw new Error("Open this from the profile whose login you are lending.");
        // In the focused pane, as the profile's login: the tab's environment
        // is the profile's, so the token minted is that account's. Local even
        // in a workspace pinned to a machine: the login is this Mac's.
        const agent = await openTerminal(workspaces.focusedPaneId, { command: "claude setup-token", kind: "shell", local: true });
        return { id: agent.id };
      });
      return;

    case "remove-machine":
      if (typeof msg.machineId !== "string") return;
      removeMachine(msg.machineId);
      forgetSpecsRun(msg.machineId);
      workspaces.unpinMachine(msg.machineId);
      broadcast({ type: "machines", machines: machinesSnapshot() });
      broadcastSpecs();
      return;

    case "set-specs": {
      const machine = typeof msg.machineId === "string" ? findMachine(msg.machineId) : undefined;
      if (!machine) return;
      try {
        setTyped(machine, msg.key, msg.value);
      } catch {
        return;
      }
      broadcastSpecs();
      return;
    }

    case "specs-history":
      reply(ws, msg.id, () => {
        const machine = typeof msg.machineId === "string" ? findMachine(msg.machineId) : undefined;
        if (!machine) throw new Error("That machine is not in the list any more.");
        if (msg.op === "add") addHistory(machine, msg.date ?? "", msg.text);
        else if (msg.op === "edit") editHistory(machine, msg.entryId, { date: msg.date, text: msg.text });
        else if (msg.op === "remove") removeHistory(machine, msg.entryId);
        else throw new Error("Not something the history does.");
        broadcastSpecs();
        return { ok: true };
      });
      return;

    case "read-specs":
      void replyAsync(ws, msg.id, async () => {
        const machine = typeof msg.machineId === "string" ? findMachine(msg.machineId) : undefined;
        if (!machine) throw new Error("That machine is not in the list any more.");
        const error = await readSpecs(machine, broadcastSpecs);
        if (error) throw new Error(error);
        return { ok: true };
      });
      return;

    case "open-machine-shell": {
      const paneId = msg.paneId ?? workspaces.focusedPaneId;
      void replyAsync(ws, msg.id, () => {
        const machine = typeof msg.machineId === "string" ? findMachine(msg.machineId) : undefined;
        if (!machine) throw new Error("That machine is not in the list any more.");
        return openTerminal(paneId, { command: remoteShellCommand({ host: machine.host }), kind: "shell" });
      });
      return;
    }

    case "pin-workspace":
      reply(ws, msg.id, () => {
        if (typeof msg.workspaceId !== "string") throw new Error("No workspace named.");
        if (msg.machineId === null) {
          workspaces.setWorkspaceMachine(msg.workspaceId, null);
          return null;
        }
        const machine = typeof msg.machineId === "string" ? findMachine(msg.machineId) : undefined;
        if (!machine) throw new Error("That machine is not in the list any more.");
        const dir = validRemoteDir(msg.dir);
        if (dir === null) {
          throw new Error("A folder is ~, ~/… or /…, in letters, digits, spaces and . _ - + @ , : = — nothing a shell would read as code.");
        }
        const pin = { machineId: machine.id, dir };
        workspaces.setWorkspaceMachine(msg.workspaceId, pin);
        return pin;
      });
      return;

    case "set-openrouter-key":
      void replyAsync(ws, msg.id, async () => {
        secrets.refuseIfHeld("openrouter");
        const status = await setOpenRouterKey(msg.key);
        broadcast({ type: "openrouter", openrouter: status });
        return status;
      });
      return;

    case "clear-openrouter-key":
      if (secrets.heldFrom("openrouter")) return;
      clearOpenRouterKey();
      broadcast({ type: "openrouter", openrouter: null });
      return;

    // --- web -------------------------------------------------------------------
    // Each broadcasts the status itself; the replies are for the page that asked.
    case "set-web":
      reply(ws, msg.id, () => {
        if (msg.order !== undefined) web.setOrder(msg.order);
        return msg.pageLimit !== undefined ? web.setPageLimit(msg.pageLimit) : web.status();
      });
      return;

    case "set-web-provider":
      void replyAsync(ws, msg.id, async () => {
        if (msg.enabled !== undefined) web.setEnabled(msg.provider, msg.enabled);
        // A held provider's address and key are the parent's; a number — the
        // cloud's daily budget — is this node's own spending, and stays.
        if (msg.field !== undefined && typeof msg.provider === "string" && webFieldKind(msg.provider, msg.field) !== "number") secrets.refuseIfHeld(webKind(msg.provider));
        return msg.field !== undefined ? web.setField(msg.provider, msg.field, msg.value) : web.status();
      });
      return;

    case "clear-web-provider-field":
      reply(ws, msg.id, () => {
        if (typeof msg.provider === "string" && webFieldKind(msg.provider, msg.field) !== "number") secrets.refuseIfHeld(webKind(msg.provider));
        return web.clearField(msg.provider, msg.field);
      });
      return;

    case "test-web-provider":
      void replyAsync(ws, msg.id, () => web.test(msg.provider));
      return;

    // --- channels --------------------------------------------------------------
    // Each names its kind, and only Telegram is one; the rest is the
    // channel's own to check, and each refusal is a sentence for the page.
    case "channel-token":
      void replyAsync(ws, msg.id, async () => {
        secrets.refuseIfHeld("telegram");
        return channelFor(msg.kind).setToken(msg.token);
      });
      return;

    case "channel-forget":
      if (isChannelKind(msg.kind) && !secrets.heldFrom("telegram")) channelFor(msg.kind).forget();
      return;

    case "channel-set":
      void replyAsync(ws, msg.id, async () => {
        const change: { enabled?: boolean; profileKey?: string | null; speakReplies?: boolean } = {};
        // A shared channel's switch is every node's, and flipped for all of
        // them at once by a signed flip (`lead.ts`); this node polls the bot
        // for the others only while the rank says so. A token held from a
        // parent too old to share the chat is that parent's bot alone.
        if (typeof msg.enabled === "boolean") {
          if (channels.telegram.isShared && lead) lead.flip(msg.enabled);
          else {
            const held = secrets.heldFrom("telegram");
            if (held) throw new Error(`This bot is ${held.from}'s, and its kururu is too old to share the chat: turn the channel on or off in ${held.from}'s Settings → Channels, or update it.`);
            change.enabled = msg.enabled;
          }
        }
        if (typeof msg.speakReplies === "boolean") change.speakReplies = msg.speakReplies;
        if (msg.profileId === null) change.profileKey = null;
        else if (typeof msg.profileId === "string") {
          const key = workspaces.keyOf(msg.profileId);
          if (!key) throw new Error("That profile is gone.");
          change.profileKey = key;
        }
        return channelFor(msg.kind).set(change);
      });
      return;

    case "channel-pair":
      void replyAsync(ws, msg.id, async () => channelFor(msg.kind).pair(msg.on === true));
      return;

    case "channel-allow":
      void replyAsync(ws, msg.id, async () => {
        if (typeof msg.userId !== "string") throw new Error("A Telegram account id is a number, like 123456789.");
        return channelFor(msg.kind).allow(msg.userId.trim());
      });
      return;

    case "channel-refuse":
      if (isChannelKind(msg.kind)) channelFor(msg.kind).refuse();
      return;

    case "channel-disallow":
      if (isChannelKind(msg.kind) && typeof msg.userId === "string") channelFor(msg.kind).disallow(msg.userId);
      return;

    case "channel-test":
      void replyAsync(ws, msg.id, () => channelFor(msg.kind).test());
      return;

    case "channel-clear-ignored":
      if (isChannelKind(msg.kind)) channelFor(msg.kind).clearIgnored();
      return;

    // --- the database and the backups ----------------------------------------
    case "set-backup":
      void replyAsync(ws, msg.id, async () => backup.set({ url: msg.url, enabled: msg.enabled, intervalMin: msg.intervalMin }));
      return;

    case "backup-now":
      void replyAsync(ws, msg.id, () => backup.run());
      return;

    case "restore-card":
      void replyAsync(ws, msg.id, async () => {
        if (typeof msg.cardId !== "string") throw new Error("Which card?");
        const found = store.findCard(msg.cardId);
        if (!found || found.profileKey !== workspaces.active.key) throw new Error("No such deleted card in this profile.");
        const where = store.restoreCard(msg.cardId, "user");
        if (!where) throw new Error("That card is not deleted.");
        const board = store.loadBoard(where.profileKey, where.workspaceKey);
        if (board) workspaces.replaceBoard(where.profileKey, where.workspaceKey, board);
        return true;
      });
      return;

    case "deleted-cards":
      reply(ws, msg.id, () => {
        const key = typeof msg.profileId === "string" ? workspaces.keyOf(msg.profileId) : null;
        if (!key) return [];
        const profile = workspaces.profileByKey(key);
        return store.deletedCards(key).map((card) => ({
          ...card,
          workspaceId: card.workspaceKey ? (profile?.workspaces.find((w) => w.key === card.workspaceKey)?.id ?? null) : null,
        }));
      });
      return;

    // --- the voice ----------------------------------------------------------
    case "set-voice":
      voice.set(msg.voice);
      return;

    case "voice-preview":
      void replyAsync(ws, msg.id, () => {
        const lang = msg.lang === "es" ? "es" : "en";
        const choice = msg.voice;
        if (!choice || (choice.engine !== "kokoro" && choice.engine !== "lab" && choice.engine !== "system") || typeof choice.voice !== "string") throw new Error("not a voice");
        return voice.preview({ engine: choice.engine, voice: choice.voice.slice(0, 80) }, lang);
      });
      return;

    case "download-voice-model":
      void voice.download();
      return;

    case "talking":
      voice.talk(ws, msg.talking === true);
      return;

    // --- an agent reloading the window -------------------------------------

    case "reloadable": {
      if (!isReloadPage(msg.page)) return;
      const reloaded = Array.isArray(msg.reloaded) ? msg.reloaded.filter((id): id is string => typeof id === "string").slice(0, 16) : [];
      reloads.declare(ws, msg.page, reloaded);
      return;
    }

    case "reload-held":
      if (!Array.isArray(msg.ids) || !Array.isArray(msg.holds)) return;
      reloads.held(ws, msg.ids.filter((id): id is string => typeof id === "string"), msg.holds.filter(isReloadHold));
      return;

    case "reloading":
      if (!Array.isArray(msg.ids)) return;
      reloads.reloading(ws, msg.ids.filter((id): id is string => typeof id === "string"));
      return;

    case "speech-held":
      if (typeof msg.utterance === "string") voice.held(ws, msg.utterance, msg.held === true);
      return;

    case "speech-played":
      if (typeof msg.utterance === "string" && typeof msg.seq === "number") voice.played(msg.utterance, msg.seq);
      return;

    // --- the Kuru drawer ---------------------------------------------------

    case "kuru-seen": {
      const key = typeof msg.profileId === "string" ? workspaces.keyOf(msg.profileId) : null;
      if (!key || !Array.isArray(msg.utterances)) return;
      const ids = msg.utterances.filter((id): id is string => typeof id === "string" && id.length <= 80).slice(0, 200);
      // Another node's replies said here are on the list under that node's
      // key, and are read in the same drawer.
      const byKey = new Map<string, string[]>();
      for (const id of ids) {
        const node = nodeOfUtterance(id);
        const at = node ? peerKey(node) : key;
        byKey.set(at, [...(byKey.get(at) ?? []), id]);
      }
      for (const [at, some] of byKey) voice.seen(at, some);
      return;
    }

    case "kuru-replay": {
      const key = typeof msg.profileId === "string" ? workspaces.keyOf(msg.profileId) : null;
      const node = typeof msg.utterance === "string" ? nodeOfUtterance(msg.utterance) : null;
      if (key && typeof msg.utterance === "string") voice.replayOne(node ? peerKey(node) : key, msg.utterance, typeof msg.text === "string" ? msg.text.slice(0, KURU_SAY_MAX) : undefined);
      return;
    }

    case "kuru-say": {
      const key = typeof msg.profileId === "string" ? workspaces.keyOf(msg.profileId) : null;
      const text = typeof msg.text === "string" ? msg.text.trim().slice(0, KURU_SAY_MAX) : "";
      if (!key || !isClipId(msg.id) || !text) return;
      const at = typeof msg.at === "number" && Number.isFinite(msg.at) && msg.at > 0 ? msg.at : Date.now();
      outbox.say(key, msg.id, at, text);
      return;
    }

    case "kuru-stop":
      if (typeof msg.profileId === "string" && workspaces.profile(msg.profileId)) void harness.interrupt(msg.profileId);
      return;

    case "voice-resend":
      if (isClipId(msg.id)) outbox.resend(msg.id);
      return;

    case "voice-discard":
      if (isClipId(msg.id)) outbox.discard(msg.id);
      return;

    // --- the database viewer ----------------------------------------------
    // Each is a request, so a malformed one is answered rather than dropped: a
    // viewer left waiting on a reply that never comes is a spinner forever.

    case "db-catalog":
      void replyAsync(ws, msg.id, () => {
        if (!validDbRef(msg.dbId, msg.database)) throw new Error("Not a database kururu knows.");
        return dbCatalog(msg.dbId, msg.database);
      });
      return;

    case "db-rows":
      void replyAsync(ws, msg.id, () => {
        if (!validDbRef(msg.dbId, msg.database)) throw new Error("Not a database kururu knows.");
        if (typeof msg.schema !== "string" || typeof msg.table !== "string") throw new Error("No table named.");
        // Numbers off the wire: NaN loses every comparison it is in, so a
        // page that is not a number is refused rather than clamped to one.
        if (!Number.isFinite(msg.offset) || !Number.isFinite(msg.limit) || msg.offset < 0 || msg.limit < 1) {
          throw new Error("Not a page.");
        }
        return dbRows(msg.dbId, msg.database, msg.schema, msg.table, msg.offset, Math.min(msg.limit, DB_ROW_CAP));
      });
      return;

    case "db-query":
      void replyAsync(ws, msg.id, () => {
        if (!validDbRef(msg.dbId, msg.database)) throw new Error("Not a database kururu knows.");
        if (typeof msg.sql !== "string") throw new Error("Nothing to run.");
        if (msg.sql.length > DB_SQL_MAX) throw new Error("That is a file, not a query.");
        return dbQuery(msg.dbId, msg.database, msg.sql, msg.writes === true);
      });
      return;

    case "set-launch":
      saveLaunch(adoptLaunch(msg.launch));
      // Which login the bar reads may just have changed hands.
      void pollAccountUsage();
      return;

    case "set-notify":
      saveNotify(adoptNotify(msg.notify));
      return;

    /**
     * Adopted rather than trusted — a font size arrives as a number somebody
     * typed, and it is the one setting in kururu that reaches a pty: the cell
     * follows the size, the proposed grid follows the cell, and every client
     * watching that terminal is resized to whatever policy picks. `adoptAppearance`
     * clamps it, so the worst a bad message can do is a legal grid.
     *
     * Nothing is resized here. The size still comes the only way it ever comes —
     * a pane measures its box and proposes, `applySize` decides — so a font
     * change is a client re-measuring, not a server deciding a shape.
     */
    case "set-terminal-appearance":
      saveAppearance(adoptAppearance({ ...appearance, terminal: msg.terminal }));
      return;

    case "delete-workspace":
      killAll(workspaces.deleteWorkspace(msg.workspaceId));
      return;

    case "move-workspace":
      workspaces.moveWorkspace(msg.workspaceId, msg.index);
      return;

    case "set-workspace-group":
      workspaces.setWorkspaceGroup(msg.workspaceId, msg.group);
      return;

    case "rename-workspace-group":
      workspaces.renameWorkspaceGroup(msg.from, msg.to);
      return;

    case "move-workspace-group":
      workspaces.moveWorkspaceGroup(msg.group, msg.onto);
      return;

    // --- profiles ----------------------------------------------------------

    // The three that change which profile is on screen also ask the account
    // again straight away: with logins per profile the bar is that profile's,
    // and a minute of the previous one's numbers under a new name is a minute
    // of the bar lying.
    case "new-profile":
      workspaces.newProfile(msg.name);
      fillPane(workspaces.focusedPaneId);
      void pollAccountUsage();
      return;

    case "switch-profile":
      workspaces.switchProfile(msg.profileId);
      void pollAccountUsage();
      return;

    case "rename-profile":
      workspaces.renameProfile(msg.profileId, msg.name);
      return;

    // A key off the wire is held to two things: its shape, in `setProfileLogin`,
    // and membership of the list this server last offered. The second is the
    // one that matters — a well-formed key naming a directory kururu never made
    // would be pointed at anyway, and refusing it here is what makes the list
    // the whole of what can be chosen. The account may just have changed hands,
    // so the bar is asked again as the other three do.
    case "set-profile-login":
      if (typeof msg.profileId !== "string") return;
      if (msg.loginKey !== null && !logins.some((login) => login.key === msg.loginKey)) return;
      workspaces.setProfileLogin(msg.profileId, msg.loginKey);
      void pollAccountUsage();
      return;

    case "delete-profile":
      killAll(workspaces.deleteProfile(msg.profileId));
      void pollAccountUsage();
      return;

    case "restart-server":
      /**
       * Put this server back on current code, which costs a reconnect and
       * nothing else — the agents are in the pty host, a process over.
       *
       * Exiting *is* the restart: only something supervising this process can
       * bring a new one up, and `server/run.mjs` is what does, on this exit code
       * specifically so that an ordinary crash is not mistaken for a request.
       * Unsupervised there is nobody to ask, and exiting would take the server
       * away rather than replace it — so it says so instead of doing half of it.
       * That includes a server whose supervisor was there once and has since
       * died, which is why this asks `supervised()` and not the environment.
       */
      {
        const refused = requestRestart("a window asked for a restart (prefix+B)");
        if (refused) console.error(`kururu: ${refused}`);
      }
      return;

    // --- the board ---------------------------------------------------------

    case "open-board":
      // From a workspace row, which may not be the workspace on screen: it
      // goes there first, since a board is only ever opened where you can see
      // it — see `openBoardFromRow` for where in it.
      if (typeof msg.workspaceId === "string") {
        workspaces.openBoardFromRow(msg.workspaceId);
        return;
      }
      workspaces.openBoard(msg.paneId ?? workspaces.focusedPaneId, msg.here === true);
      return;

    case "add-card":
      workspaces.editBoard(msg.workspaceId, (board) =>
        addCard(board, { title: msg.title, body: msg.body, column: msg.column, isolate: msg.isolate }, mintCardId(), Date.now()),
      );
      return;

    case "add-run-card":
      void replyAsync(ws, msg.id, async () => {
        if (typeof msg.launcher !== "string" || !findLauncher(msg.launcher)) throw new Error(`no such agent: ${String(msg.launcher)}`);
        if (!workspaces.workspaceIn(workspaces.active.id, msg.workspaceId)) throw new Error("no such workspace");
        const cardId = mintCardId();
        workspaces.editBoard(msg.workspaceId, (board) =>
          addCard(board, { title: msg.title, body: msg.body, column: msg.column, isolate: msg.isolate }, cardId, Date.now()),
        );
        return runCard(msg.workspaceId, cardId, msg.launcher);
      });
      return;

    case "edit-card":
      workspaces.editBoard(msg.workspaceId, (board) =>
        editCard(board, msg.cardId, { title: msg.title, body: msg.body, isolate: msg.isolate, dates: msg.dates }),
      );
      return;

    case "move-card":
      workspaces.editBoard(msg.workspaceId, (board) => moveCard(board, msg.cardId, msg.column, msg.index));
      // A finished card is not being looked at: its server goes, whichever
      // road it took to Done — the merge, or "Just move".
      if (msg.column === "done") stopDev(msg.workspaceId, msg.cardId);
      return;

    /*
     * Deleting a card does not touch its agent. The card is a note about the
     * work; the terminal is the work, with its own ✕ — and ending somebody's
     * agent because they tidied a list is the accident `hide-agent` exists to
     * keep apart from `close-tab`.
     */
    case "delete-card":
      workspaces.editBoard(msg.workspaceId, (board) => removeCard(board, msg.cardId));
      return;

    case "resize-column":
      workspaces.editBoard(msg.workspaceId, (board) => resizeLane(board, msg.column, msg.width));
      return;

    // The profile's board. Nothing on it runs, so these are the pure functions
    // and nothing else — no agent to end on Done and no worktree to ask about.
    // The column is held to the ones the board has by the pure functions
    // themselves, since the board is what knows its columns.
    case "add-profile-card":
      workspaces.editProfileBoard(msg.profileId, (board) =>
        addCard(board, { title: msg.title, body: msg.body, column: msg.column, dates: msg.dates }, mintCardId(), Date.now()),
      );
      return;

    case "edit-profile-card":
      workspaces.editProfileBoard(msg.profileId, (board) =>
        editCard(board, msg.cardId, { title: msg.title, body: msg.body, dates: msg.dates }),
      );
      return;

    case "move-profile-card":
      workspaces.editProfileBoard(msg.profileId, (board) => moveCard(board, msg.cardId, msg.column, msg.index));
      return;

    case "delete-profile-card":
      workspaces.editProfileBoard(msg.profileId, (board) => removeCard(board, msg.cardId));
      return;

    case "add-profile-column":
      workspaces.editProfileBoard(msg.profileId, (board) => addLane(board, msg.name, mintLaneId()));
      return;

    case "rename-profile-column":
      workspaces.editProfileBoard(msg.profileId, (board) => renameLane(board, msg.columnId, msg.name));
      return;

    case "set-profile-column-color":
      workspaces.editProfileBoard(msg.profileId, (board) => colorLane(board, msg.columnId, msg.color));
      return;

    case "set-profile-column-collapsed":
      workspaces.editProfileBoard(msg.profileId, (board) => collapseLane(board, msg.columnId, msg.collapsed));
      return;

    case "move-profile-column":
      workspaces.editProfileBoard(msg.profileId, (board) => moveLane(board, msg.columnId, msg.index));
      return;

    case "delete-profile-column":
      workspaces.editProfileBoard(msg.profileId, (board) => removeLane(board, msg.columnId));
      return;

    case "resize-profile-column":
      workspaces.editProfileBoard(msg.profileId, (board) => resizeLane(board, msg.columnId, msg.width));
      return;

    case "send-profile-card":
      if (typeof msg.cardId !== "string" || typeof msg.workspaceId !== "string") return;
      workspaces.sendProfileCard(msg.profileId, msg.cardId, msg.workspaceId);
      return;

    case "run-card":
      void replyAsync(ws, msg.id, () => runCard(msg.workspaceId, msg.cardId, msg.launcher, msg.fresh === true));
      return;

    case "resume-card":
      void replyAsync(ws, msg.id, () => resumeCard(msg.workspaceId, msg.cardId));
      return;

    case "worktree-status":
      void replyAsync(ws, msg.id, () => cardStatus(msg.workspaceId, msg.cardId));
      return;
    case "commit-card":
      void replyAsync(ws, msg.id, () => commitCard(msg.workspaceId, msg.cardId));
      return;
    case "stash-card":
      void replyAsync(ws, msg.id, () => stashCard(msg.workspaceId, msg.cardId));
      return;
    case "merge-card":
      void replyAsync(ws, msg.id, () =>
        mergeCard(msg.workspaceId, msg.cardId, msg.resolve === "commit" || msg.resolve === "stash" ? msg.resolve : undefined),
      );
      return;
    case "open-worktree":
      void replyAsync(ws, msg.id, () => openWorktree(msg.workspaceId, msg.cardId));
      return;
    case "restart-card-dev":
      void replyAsync(ws, msg.id, () => restartDev(msg.workspaceId, msg.cardId));
      return;
    case "stop-card-dev":
      void replyAsync(ws, msg.id, async () => stopDev(msg.workspaceId, msg.cardId));
      return;
    case "stop-dev-server":
      void replyAsync(ws, msg.id, () => stopListedDevServer(msg.port, msg.pid));
      return;

    case "workspace-git": {
      if (!(GIT_ACTIONS as readonly string[]).includes(msg.action)) return;
      const message = typeof msg.message === "string" ? msg.message.slice(0, COMMIT_MESSAGE_MAX) : "";
      void replyAsync(ws, msg.id, () => workspaceGit(msg.workspaceId, String(msg.root), msg.action, message));
      return;
    }

    // --- the reader --------------------------------------------------------

    case "open-reader": {
      const paneId = msg.paneId ?? workspaces.focusedPaneId;
      const agentId = msg.agentId ?? workspaces.activeAgentIn(paneId);
      /**
       * The project comes from where the pane already is, and from what the
       * pane *remembers* rather than from the kernel: `cwdForNewTab` asks lsof
       * because a new terminal landing in `~` all afternoon is a real cost, and
       * here the worst case of being a directory behind is a picker that opens
       * on the project list. That is not worth an async spawn on a keypress.
       */
      const made = workspaces.openReader(paneId, agentId, rootForDir(workspaces.cwdFor(paneId)));
      if (!made) return;
      if (msg.focus) workspaces.focusPane(made);
      // Ahead of the sweep, because the pane is on screen now and a reader that
      // is blank for two seconds reads as one that does not work.
      if (agentId) void hookEditor(agentId);
      return;
    }

    case "pin-reader":
      workspaces.pinReader(msg.paneId, msg.follow);
      return;

    case "select-doc":
    case "close-doc":
      // An index off the wire, and `agentIds[NaN]` is merely undefined — but a
      // fraction or a negative is not a tab either, and saying so here keeps the
      // model from ever being asked.
      if (!Number.isInteger(msg.index) || msg.index < 0) return;
      if (msg.type === "select-doc") workspaces.selectDoc(msg.paneId, msg.index);
      else workspaces.closeDoc(msg.paneId, msg.index);
      return;

    case "move-doc":
      if (!Number.isInteger(msg.index) || msg.index < 0) return;
      if (msg.at !== undefined && (!Number.isInteger(msg.at) || msg.at < 0)) return;
      workspaces.moveDoc(msg.fromPaneId, msg.index, msg.toPaneId, msg.at);
      return;

    case "split-with-doc":
      if (!Number.isInteger(msg.index) || msg.index < 0) return;
      if (msg.dir !== "row" && msg.dir !== "col") return;
      workspaces.splitWithDoc(msg.fromPaneId, msg.index, msg.paneId, msg.dir, msg.before === true);
      return;

    case "show-doc": {
      // `open-doc`'s check, for the same reason: a path that does not resolve is
      // a click that does nothing, not a reader blanked by a refusal.
      if (!resolveInRoot(msg.root, msg.path)) return;
      const shown = workspaces.showDoc(msg.root, msg.path);
      if (shown && msg.focus) workspaces.focusPane(shown);
      return;
    }

    case "find-editors":
      void replyAsync(ws, msg.id, () => editorsHere());
      return;

    case "open-in-editor": {
      // `open-made`'s rule for the line: a whole one or none.
      const line = Number.isInteger(msg.line) && (msg.line as number) > 0 ? (msg.line as number) : null;
      const paneId = typeof msg.paneId === "string" ? msg.paneId : undefined;
      void replyAsync(ws, msg.id, () => openInEditor(msg.root, msg.path, msg.agentId, { paneId, line }));
      return;
    }

    case "open-made": {
      if (typeof msg.root !== "string" || typeof msg.path !== "string") return;
      // `Number.isFinite`'s rule, and a whole line or none: nvim's `+N` is
      // the only place this number goes.
      const line = Number.isInteger(msg.line) && (msg.line as number) > 0 ? (msg.line as number) : null;
      const workspaceId = typeof msg.workspaceId === "string" ? msg.workspaceId : null;
      void replyAsync(ws, msg.id, () => openMade(msg.root, msg.path, line, workspaceId, msg.focus === true));
      return;
    }

    case "files-ask":
    case "doc-ask":
      // The parent's reads of this disk, for its window. A page has the
      // HTTP routes and is not answered here; the roots are this node's own,
      // checked by `files.ts` exactly as those routes check them.
      if (!st.watcher || typeof msg.root !== "string") return;
      void replyAsync(ws, msg.id, () => readForWatcher(msg));
      return;

    case "close-nvims":
      void replyAsync(ws, msg.id, () => closeNvims(msg.ids));
      return;

    case "kill-nvims":
      void replyAsync(ws, msg.id, () => killNvims(msg.ids));
      return;

    case "open-doc":
      /**
       * Checked where every path from a client is checked, and a pick that does
       * not resolve is simply not made: the pane keeps the document it had. A
       * refusal that blanked the reader would read as the feature being broken
       * rather than as a refusal, which is the argument `set-profile-column-color`
       * makes about a colour it will not take.
       */
      if (!resolveInRoot(msg.root, msg.path)) return;
      if (msg.at !== undefined && (!Number.isInteger(msg.at) || msg.at < 0)) return;
      if (workspaces.openDoc(msg.paneId, msg.root, msg.path, msg.at) && msg.focus) workspaces.focusPane(msg.paneId);
      return;

    case "split-with-file":
      if (!resolveInRoot(msg.root, msg.path)) return;
      if (msg.dir !== "row" && msg.dir !== "col") return;
      workspaces.splitWithFile(msg.root, msg.path, msg.paneId, msg.dir, msg.before === true);
      return;
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  // A manifest served as anything else is a manifest Chrome refuses to parse,
  // and the symptom is the home-screen icon quietly going back to a screenshot.
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  // What a `sound` style may ship — `SOUND_FORMATS`, and nothing wider. These
  // reach a browser through `/api/styles/asset` and `/api/styles/preview`,
  // which serve whatever an entry recorded; a type guessed as
  // `application/octet-stream` is one Safari will not decode.
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
};

function json(res: ServerResponse, body: unknown, status = 200): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

function text(res: ServerResponse, body: string, status = 200): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

/**
 * A little over the sheet cap, so a file that is too big is refused by the thing
 * that can say *why* rather than by the socket closing mid-upload.
 */
const IMPORT_LIMIT = 2 * 1024 * 1024;

/** The body, as bytes. What `readJsonBody` is built on, minus the parse. */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("that file is far too big"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** A clip past `CLIP_MAX_BYTES`, told apart so it can be answered as one. */
class ClipTooLong extends Error {}

/**
 * A clip's body, read to its end even when it is past the cap, so the
 * answer reaches a window still uploading. `readBody` destroys the request
 * instead, which is right for a file nobody will look at the answer to, and
 * was wrong here: a window told nothing but "connection reset" has nothing to
 * tell the person who just spoke for two minutes.
 */
function readClip(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > limit) reject(new ClipTooLong(`the clip is ${Math.round(size / 32_000)} s, past the ${Math.round(limit / 32_000)} s the server takes`));
      else resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

/** Read a JSON request body, with a cap — this endpoint is tailnet-reachable. */
function readJsonBody(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("body is not JSON"));
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(res: ServerResponse, rel: string): void {
  const file = join(WEB_DIST, rel);
  let isFile = false;
  try {
    isFile = statSync(file).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    // Unknown paths fall through to index.html so the client router owns them.
    const index = join(WEB_DIST, "index.html");
    if (!existsSync(index)) {
      text(res, "kururu: web app not built. Run `bun run build`.", 404);
      return;
    }
    res.writeHead(200, { "content-type": CONTENT_TYPES[".html"]! });
    createReadStream(index).pipe(res);
    return;
  }
  res.writeHead(200, { "content-type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

  /**
   * Everything below this line is behind the gate, and that is deliberate rather
   * than tidy: a list of protected paths is a list somebody adds a route to
   * without noticing, and the route they forget will be the one that reads a
   * file. See `access.ts` for what is actually being decided. The two answers
   * are told apart on purpose — a page from somewhere else is a bug or an attack
   * and is worth saying so about, while a missing token is a phone that has not
   * scanned the QR code yet and is an instruction, not an error.
   */
  /**
   * A new PC joining, with the code from the command this node is showing
   * — ahead of the gate, because the code is its token: the PC holds
   * nothing of this node's before it has joined. `nodeRequestRefusal`
   * keeps it to the tailnet with no page and no proxy in between, and five
   * wrong codes burn the one showing.
   */
  if (url.pathname === "/api/nodes/join") {
    if (req.method !== "POST") {
      text(res, "POST only", 405);
      return;
    }
    let body: unknown;
    try {
      body = await readJsonBody(req, 64 * 1024);
    } catch {
      json(res, { error: "That is not JSON." }, 400);
      return;
    }
    const answer = nodes.acceptJoin(req, body);
    json(res, answer.body, answer.status);
    return;
  }

  const allowed = verdict(req, url);
  if (allowed !== "ok") {
    text(
      res,
      allowed === "cross-origin"
        ? "kururu: refused — this page is not one kururu serves."
        : isShared()
          ? "kururu: this server is shared, so it wants the token from its Share dialog. Scan the QR code again."
          : "kururu: this server wants its token from this machine too — it is in access.json, and `Authorization: Bearer` is how to present it.",
      403,
    );
    return;
  }

  /**
   * The Share URL, opened on a device for the first time. It is `/?k=…`, and
   * the exchange below lives in the page's own bundle — which the browser
   * fetches next with neither the query nor a cookie, and was refused, so a
   * fresh phone got a blank page and only a phone with last year's cookie
   * worked (found on the Omarchy PC, and the Mac's gate is the same). So any
   * request that has just presented the token in its address is answered
   * with the cookie too, and the bundle that follows carries it.
   */
  if ((isShared() || loopbackTokenRequired()) && url.searchParams.has("k") && hasToken(req, url)) {
    res.setHeader("set-cookie", cookieHeader(token()));
  }

  /**
   * One scanned QR code, turned into a device that keeps working.
   *
   * The token arrives as `?k=` on the address the phone opened, and the page
   * hands it straight back here so it can be exchanged for a cookie — which the
   * browser then attaches to every fetch *and to the WebSocket handshake*, which
   * is the whole reason this is a cookie and not something the client would have
   * to remember to add in eleven places. It also works identically in
   * development, where the page comes from vite and only the proxied requests
   * ever reach this process, so there is no second arrangement to keep in step.
   *
   * Reachable without a token by construction — the gate above has already
   * accepted this request, and on a shared server accepting it is what having
   * presented a valid one *means*.
   */
  if (url.pathname === "/api/access") {
    if (!isShared() && !loopbackTokenRequired()) {
      json(res, { ok: true, shared: false });
      return;
    }
    if (!hasToken(req, url)) {
      text(res, "kururu: that token is not this server's.", 403);
      return;
    }
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "set-cookie": cookieHeader(token()),
    });
    res.end(JSON.stringify({ ok: true, shared: true }));
    return;
  }

  if (url.pathname === "/api/health") {
    json(res, {
      ok: true,
      // The one field something outside kururu reads to tell two builds apart —
      // a window against a server in a cupboard, or the updater against either.
      version: VERSION,
      // And the host's, which can be older: it does not pick up a new bundle
      // until it is restarted. `current` is whether that restart is owed.
      host: { version: hostInfo.version, protocol: hostProtocol, current: hostInfo.current },
      agents: host.agents.length,
      liveAgents: host.agents.filter(countsAsAgent).length,
      devServers: state.devServers.length,
      // The conversation's two counts for the profile on screen, for the
      // menu bar: what Kuru said that nobody heard, and what did not reach
      // it. The frog is the one presence a Mac with no window open has.
      kuru: { profileId: workspaces.active.id, ...kuru.counts(workspaces.active.key) },
      pid: process.pid,
      clients: { now: windows(), remoteAt: remoteClientAt },
      // Who watches this node, and whom this node watches: the two ends of
      // `/link/watch`, for `bun run status`.
      watch: { by: nodes.view().watchedBy ?? [], of: watches.status() },
      // This node among the others: its role, who leads, and each member's
      // link — what `kururu child doctor` checks the pairing row against —
      // and where the Telegram poll stands, for its leading row.
      nodes: { ...nodes.health(), lead: leadHealth() },
      // When and why this process started, and whether anything would start
      // it again. Without the file: this is asked every few seconds.
      life: lifeNow(),
      // The usage ledger's counts, for `bun run status`. Held for two seconds, for the same reason.
      ledger: usageReader?.status() ?? null,
    });
    return;
  }

  /**
   * Why the server last went away, for the About page. Read from the file at
   * the moment of asking, because the lines that matter most were written by
   * a process that no longer exists.
   */
  /**
   * The nodes view, for a caller with no socket: `kururu child join` reads
   * it for the link coming up, and the desktop's picker and tray
   * read it for the nodes they offer. Behind the gate, since on the parent
   * each node's URL carries its share token.
   */
  if (url.pathname === "/api/nodes") {
    json(res, nodes.view());
    return;
  }
  /**
   * Join the Mac, for `kururu child join <mac> <code>` on a box with no
   * window: this server makes the post, since it holds the keys and the
   * share token the Mac is handed. Behind the gate like everything else.
   */
  if (url.pathname === "/api/nodes/pair" && req.method === "POST") {
    try {
      const body = (await readJsonBody(req)) as { text?: unknown } | null;
      json(res, await nodes.join(body?.text));
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 409);
    }
    return;
  }

  if (url.pathname === "/api/lifecycle") {
    json(res, lifecycleReport());
    return;
  }

  /**
   * Every card's agent as the idle look last found it, and why each one is
   * still awake — "waiting on you: its last reply asked something", "idle 4
   * min of 10". Asked, not pushed: it is for whoever is wondering.
   */
  if (url.pathname === "/api/sleep") {
    json(res, { on: launch.sleepIdle, minutes: launch.sleepMinutes, agents: sleeper.looked() });
    return;
  }

  /**
   * Where the data lives, for the About page: the database's file and how
   * big it is. Asked rather than pushed, since nobody watches it grow.
   */
  if (url.pathname === "/api/data") {
    json(res, { path: store.path, bytes: store.bytes() });
    return;
  }

  /**
   * Full text over the cards and the conversations — `shared/store.ts`. A
   * GET with the words, answered with hits that carry this session's ids
   * beside the keys, so the window can go to a card.
   */
  if (url.pathname === "/api/search") {
    const q = url.searchParams.get("q") ?? "";
    const scope = url.searchParams.get("scope");
    const asked = url.searchParams.get("profile");
    const limit = Number(url.searchParams.get("limit") ?? 20);
    json(res, {
      hits: searchFor(asked && workspaces.profile(asked) ? asked : workspaces.active.id, q, isSearchScope(scope) ? scope : "all", Number.isFinite(limit) ? limit : 20),
    });
    return;
  }

  /**
   * The conversation with Kuru before a moment, for the drawer's "Show
   * earlier": the socket carries the newest items and this pages back
   * through the rest. A GET, since it changes nothing. And one verb for a
   * caller with no socket — the menu bar — to play the unheard replies.
   */
  if (url.pathname === "/api/kuru") {
    const asked = url.searchParams.get("profile");
    const profileId = asked && workspaces.profile(asked) ? asked : workspaces.active.id;
    const before = Number(url.searchParams.get("before"));
    const limit = Number(url.searchParams.get("limit") ?? KURU_PAGE);
    json(res, kuru.page(workspaces.keyOf(profileId) ?? "", Number.isFinite(before) && before > 0 ? before : null, Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.floor(limit))) : KURU_PAGE));
    return;
  }
  /**
   * The drawer's search, as it is typed: a GET like the page above, with the
   * words in the query and never anywhere else — no model hears them, and no
   * log is written of them. A window that has moved on closes the request, and
   * that ends the scan.
   */
  if (url.pathname === "/api/kuru/search") {
    const asked = url.searchParams.get("profile");
    const profileId = asked && workspaces.profile(asked) ? asked : workspaces.active.id;
    let gone = false;
    res.on("close", () => {
      gone = true;
    });
    void kuru
      .search(workspaces.keyOf(profileId) ?? "", url.searchParams.get("q") ?? "", () => gone)
      .then((answer) => {
        if (!gone) json(res, answer);
      })
      .catch((err: unknown) => {
        if (!gone) json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
      });
    return;
  }
  /** The lines around a moment, for a result older than the drawer has loaded; `before=0` reads on from it. */
  if (url.pathname === "/api/kuru/around") {
    const asked = url.searchParams.get("profile");
    const profileId = asked && workspaces.profile(asked) ? asked : workspaces.active.id;
    const at = Number(url.searchParams.get("at"));
    if (!Number.isFinite(at)) {
      json(res, { error: "at must be a time" }, 400);
      return;
    }
    const count = (name: string): number => {
      const asked = Number(url.searchParams.get(name) ?? KURU_PAGE);
      return Number.isFinite(asked) ? Math.max(0, Math.min(200, Math.floor(asked))) : KURU_PAGE;
    };
    json(res, kuru.around(workspaces.keyOf(profileId) ?? "", at, count("before"), count("after")));
    return;
  }
  if (url.pathname === "/api/kuru/play" && req.method === "POST") {
    const asked = url.searchParams.get("profile");
    const profileId = asked && workspaces.profile(asked) ? asked : workspaces.active.id;
    json(res, { ok: true, played: voice.replay(workspaces.keyOf(profileId) ?? "").length });
    return;
  }

  /** Back up now, for `bun run backup` and anything else without a socket. */
  if (url.pathname === "/api/backup/now" && req.method === "POST") {
    json(res, await backup.run());
    return;
  }

  /**
   * The two restarts, for a caller with no socket: the menu bar.
   *
   * The server's own restart is what `prefix+B` asks over the socket, and
   * costs a reconnect. The host's is the one thing in kururu that ends
   * agents, and it is a POST on loopback for the same reason `kill-agent`
   * is a message any client may send: whatever can reach this server can
   * already end a terminal, one at a time. What is kept out of reach is the
   * *accident* — the dialog that names the count is the caller's, and
   * nothing here runs without being asked. A 409 is a refusal with its
   * reason, which is the honest answer to a request that cannot be finished.
   */
  if (url.pathname === "/api/restart" && req.method === "POST") {
    const refused = requestRestart("the menu bar asked for a restart");
    if (refused) json(res, { ok: false, error: refused }, 409);
    else json(res, { ok: true });
    return;
  }
  if (url.pathname === "/api/host/restart" && req.method === "POST") {
    const refused = requestHostRestart();
    if (refused) json(res, { ok: false, error: refused }, 409);
    else json(res, { ok: true });
    return;
  }

  /**
   * An agent asking for the window to be reloaded, for a caller with no
   * socket: `bun run reload-window`, which sends the `KURURU_AGENT_ID` its pty
   * was started with so the notice can say who asked. Held open until every
   * page on this Mac has reloaded and come back, or the time is up, or the
   * page went — the answer is what the agent acts on. Behind the gate like
   * every route here, so loopback, the Origin check and, when shared, the
   * token are what they are for everything else; and it reloads pages and
   * nothing more, the same reload `C-a R` does, never the host.
   *
   * A caller that hangs up stops the wait, and the pages still holding let
   * the ask go: a reload nobody is waiting to hear about is one that would
   * arrive unexplained but for its notice.
   */
  if (url.pathname === "/api/reload-window" && req.method === "POST") {
    let body: Record<string, unknown> = {};
    try {
      const raw = await readJsonBody(req, 16 * 1024);
      if (raw && typeof raw === "object") body = raw as Record<string, unknown>;
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 400);
      return;
    }
    const why = typeof body.why === "string" ? oneLine(body.why, WHY_MAX) : "";
    if (!why) {
      json(res, { ok: false, error: "Say why: the window shows it in the notice after the reload." }, 400);
      return;
    }
    const seconds = Number(body.timeout);
    const timeoutMs = Number.isFinite(seconds) && body.timeout !== null && body.timeout !== undefined
      ? Math.max(RELOAD_TIMEOUT_MIN_MS, Math.min(RELOAD_TIMEOUT_MAX_MS, seconds * 1000))
      : RELOAD_TIMEOUT_MS;
    const by = reloaderOf(typeof body.agent === "string" ? body.agent : null, typeof body.by === "string" ? body.by : null);
    const hangup = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) hangup.abort();
    });
    const outcome = await reloads.ask(why, by, timeoutMs, hangup.signal);
    if (!hangup.signal.aborted) json(res, { ...outcome, by, text: outcomeText(outcome) });
    return;
  }

  /**
   * Whether there is a newer kururu. A `force` is somebody pressing the button a
   * second time, which is the one case that should skip the cache — see
   * `update.ts` for why there is one.
   */
  if (url.pathname === "/api/update") {
    const check = await checkForUpdate(url.searchParams.has("force"));
    /**
     * The notes are rendered here rather than in `update.ts` because this is
     * where the theme is — release notes are code blocks as often as not, and
     * highlighting them against a palette the window is not wearing is worse
     * than not highlighting them. A failure falls back to the markdown source,
     * which is perfectly readable and is what a changelog is written as anyway.
     */
    let notesHtml: string | null = null;
    if (check.notes) {
      try {
        notesHtml = (await renderMarkdown(check.notes, "", "release-notes.md", appearance.themeId)).html;
      } catch {
        notesHtml = null;
      }
    }
    json(res, { ...check, notesHtml });
    return;
  }

  /**
   * What the pty host is holding, for something that is not a browser.
   *
   * The snapshot already goes to every client over the websocket, so this adds
   * no knowledge — what it adds is a way to ask without becoming a client. The
   * caller is `server/status.mjs`, a terminal command, and the alternative it
   * exists to avoid is much worse than an endpoint: the host's socket accepts
   * one server at a time and treats a second connection as a restarted first,
   * so a status tool that asked the *host* directly would knock the live server
   * off its own link to find out how things were going.
   *
   * So the rule stands that the host is opaque and the server is the thing that
   * describes it — and when there is no server, there is genuinely nobody who
   * can answer, which is a true thing for a status command to have to say.
   */
  if (url.pathname === "/api/agents") {
    json(res, {
      agents: host.agents.map((agent) => ({
        id: agent.id,
        name: agent.agent ?? agent.title ?? null,
        program: agent.agent,
        status: agent.status,
        cwd: agent.cwd,
        pid: agent.pid,
        exited: agent.exited,
        counts: countsAsAgent(agent),
      })),
    });
    return;
  }

  /**
   * Settings' Processes page: every terminal, what is running in it and what
   * it costs, grouped the way the sidebar groups them. Asked for, never polled
   * from here — the page asks while it is open. See `shared/footprint.ts`.
   */
  if (url.pathname === "/api/footprint") {
    json(res, await footprint());
    return;
  }

  /**
   * Settings → Usage, asked for while the page is open and never pushed: what a
   * range spent is a page's question, and the ledger's reader changes it every
   * few seconds whether or not anybody is looking. Names and live terminals are
   * looked up here because the ledger has neither. See `usage/report.ts`.
   */
  if (url.pathname === "/api/usage/report") {
    if (!usageReader) {
      json(res, { error: "The usage ledger did not open, so there is nothing to draw. Why is in the server's log." }, 503);
      return;
    }
    const range = url.searchParams.get("range");
    const by = url.searchParams.get("by");
    json(res, usageReportFor(usageReader, isUsageRange(range) ? range : "week", isUsageDimension(by) ? by : "workspace"));
    return;
  }

  /**
   * The addresses this machine can be reached at, for the QR the phone scans.
   * Asked for rather than pushed: it changes when somebody joins a different
   * network or brings tailscale up, neither of which raises an event here, and
   * a poll running forever to keep a value only one dialog ever draws would be
   * a timer earning nothing. See `reach.ts`.
   */
  if (url.pathname === "/api/reach") {
    // `listening` for `bun run share`, which has no page to ask and must not
    // offer a LAN address to a child that listens on its tailnet one alone.
    json(res, { ...reach(PORT), ...sharing(), listening: listenAddresses() });
    return;
  }

  /**
   * Turning sharing on or off, and minting a new token.
   *
   * A POST rather than a message on the socket, because it is answered with the
   * new state and the dialog needs that answer — a snapshot cannot carry it, for
   * the reason `wire.ts` gives beside `Sharing`: the token has no business going
   * to every client on every change. Restarting is the caller's, and only when
   * the bind address actually has to move: turning sharing off while already
   * loopback-bound changes nothing about the socket.
   */
  if (url.pathname === "/api/share" && req.method === "POST") {
    const body = await readJsonBody(req);
    const wanted = (body as { share?: unknown } | null)?.share;
    const rotate = (body as { rotate?: unknown } | null)?.rotate === true;

    let next = rotate ? rotateToken() : sharing();
    if (typeof wanted === "boolean") {
      next = setShare(wanted);
      json(res, next);
      /**
       * Restarted only when the *socket* disagrees with what was just chosen,
       * which is not the same test as "the decision changed": somebody who
       * turns sharing on and immediately off again has changed the file twice
       * and the socket never needed to move at all. Sent after the answer has
       * gone out, or the dialog is told nothing and is left looking at a
       * connection that dropped for no reason it could explain.
       */
      if (wanted !== isShared() && next.restartable) {
        record("stop", `sharing was switched ${wanted ? "on" : "off"}, and the socket has to be bound again`);
        setTimeout(() => process.exit(RESTART_EXIT_CODE), 250);
      }
      return;
    }
    json(res, next);
    return;
  }

  /**
   * How an agent tells kururu what it is doing. The only source of `blocked`
   * and of context usage; see agents/report.ts for why neither is inferable.
   */
  if (url.pathname === "/api/report") {
    if (req.method !== "POST") {
      text(res, "POST only", 405);
      return;
    }
    try {
      const body = await readJsonBody(req);
      const parsed = parseReport(body);
      if (!parsed) {
        json(res, { error: "need a valid status or context" }, 400);
        return;
      }
      // An agent that does not name itself is the common case: the hook runs
      // inside the pty, so its own environment already says which one it is.
      const agentId = parsed.agentId ?? process.env.KURURU_AGENT_ID ?? null;
      if (!agentId || !host.find(agentId)) {
        json(res, { error: "no such agent" }, 404);
        return;
      }
      host.report(agentId, parsed.report);
      // The rest of the report is the harness's: where the transcript and the
      // inbox are, and what was last said. See `harness.ts`.
      harness.report(agentId, body as Record<string, unknown>);
      // And the same path is the usage ledger's cue to read what the turn billed.
      noteReported(agentId, body as Record<string, unknown>);
      usageReader?.nudge((body as Record<string, unknown>).transcript);
      const spoken = harness.isHarness(agentId);
      const spokenKey = spoken ? workspaces.keyOf(spoken) : null;
      // A prompt Kuru took, which is how a message of yours is known to have
      // arrived and not merely to have been typed. See `Outbox.prompted`.
      // The channels note where it came from, and carry it to the chat when
      // it was yours from here; only a `working` report's message is a
      // prompt, as `recordTurn` below reads it.
      if (spokenKey && parsed.report.message) outbox.prompted(spokenKey, parsed.report.message);
      if (spokenKey && parsed.report.status === "working" && parsed.report.message) channels.prompted(spokenKey, parsed.report.message);
      // And when the reporter is a profile's harness, what it last said is
      // read aloud — the one place Kuru's turn ending is heard about — unless
      // the turn answered only a channel, whose reply is already in somebody's
      // hand (`replySpoken`). Every channel that carries the profile gets it.
      const reply = (body as Record<string, unknown>).reply;
      const ended = spokenKey !== null && parsed.report.status === "done";
      const utterance = ended && channels.speaks(spokenKey) ? voice.spoke(spokenKey, reply) : null;
      const answered = ended ? channels.replied(spokenKey, reply) : null;
      // And the conversation, written down: the prompt on its way in and
      // the reply on its way out, for the search and the drawer. Before the
      // cap below, which is the sidebar's and not the record's.
      const turn = recordTurn(agentId, parsed.report, body as Record<string, unknown>, utterance);
      // And the other nodes hear the reply of this node's Kuru, with what it
      // answered, under the id their drawers will see it by. See `peerkuru.ts`.
      if (answered && spokenKey === kuruKey() && typeof reply === "string" && reply.trim()) {
        peerKurus?.replied({ id: turn !== null ? `t${turn}` : `r${Date.now().toString(36)}`, at: Date.now(), text: reply.trim() }, answered.origin, answered.answers);
      }
      // And what the turn ended in, for the links under the agent's row and
      // on its card. See `noteMade`.
      noteMade(agentId, parsed.report, body as Record<string, unknown>);
      /**
       * The host is told the status and the context; the message stops here.
       * It is the one part of a report that says something about the work rather
       * than about the process, so it is the one part the host has no use for —
       * see `activity` beside `snapshot()`. Trimmed and capped on the way in
       * because it is drawn in a sidebar one line high, and an agent that
       * reported a paragraph would otherwise be storing one per turn.
       */
      const said = parsed.report.message?.replace(/\s+/g, " ").trim();
      if (said) activity.set(agentId, said.slice(0, MAX_ACTIVITY));
      json(res, { ok: true });
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 400);
    }
    return;
  }

  /**
   * kururu's web as an MCP server: the tools every agent kururu starts is
   * pointed at (`WebChain.launchFlags`), and the harness with them. Stricter
   * than `/mcp` below, because a provider behind it may spend credits: a
   * program on this Mac only — loopback, no `Origin`, nothing a proxy added —
   * whether or not sharing is on. The agent names itself in a header so the
   * Settings page can say who asked for what; one that does not is still
   * served.
   *
   * Unlike `/mcp`, it keeps what it told a client current: an `initialize`
   * is given a session carrying a fingerprint of the chain, a `GET` holds a
   * stream that hears `tools/list_changed` when the chain moves, and a
   * request on a session from before is answered 404, the protocol's way of
   * saying "start again". See `web/chain.ts`.
   */
  if (url.pathname === "/mcp/web") {
    if (!localCaller(req)) {
      json(res, { jsonrpc: "2.0", id: null, error: { code: -32000, message: "kururu's web tools answer programs on this Mac only" } }, 403);
      return;
    }
    const header = req.headers["mcp-session-id"];
    const session = typeof header === "string" ? header : null;
    // Word for word what the reference SDK's server says, because that is
    // what the clients were written against.
    const expired = (id: unknown) => json(res, { jsonrpc: "2.0", id: id ?? null, error: { code: -32001, message: "Session not found" } }, 404);
    if (req.method === "DELETE") {
      res.writeHead(200).end();
      return;
    }
    if (req.method === "GET") {
      if (!web.sessionCurrent(session)) {
        expired(null);
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.on("close", web.openStream(res, session));
      return;
    }
    if (req.method !== "POST") {
      text(res, "GET or POST", 405);
      return;
    }
    const said = callerAgent(req);
    const agentId = said && host.find(said) ? said : null;
    try {
      const body = await readJsonBody(req, 64 * 1024);
      const fresh = initializes(body);
      if (!fresh && !web.sessionCurrent(session)) {
        expired(body && typeof body === "object" && !Array.isArray(body) ? (body as { id?: unknown }).id : null);
        return;
      }
      // Issued before the answer is written, from the same chain: the
      // fingerprint in the id is the one the instructions were written from.
      if (fresh) res.setHeader("mcp-session-id", web.session());
      const agent = agentId ? webAgentName(agentId) : null;
      const answer = await mcpAnswer(body, web.tools(), (name, args) => web.call(name, args, agent), {
        name: "kururu_web",
        version: VERSION,
        instructions: web.instructions(),
        listChanged: true,
      });
      if (answer.body === undefined) res.writeHead(answer.status).end();
      else json(res, answer.body, answer.status);
    } catch (err) {
      json(res, { jsonrpc: "2.0", id: null, error: { code: -32700, message: err instanceof Error ? err.message : String(err) } }, 400);
    }
    return;
  }

  /**
   * Kururu as an MCP server: the harness's verbs, for the harness session that
   * was started with this address in its `--mcp-config`. The address names the
   * profile the tools act on and the session they were issued to, so the
   * endpoint knows who is calling without a session of its own. Behind the
   * same gate as everything else, which on loopback is open — any local process
   * may drive kururu this way, and that is the point of exposing the verbs at
   * all. See `mcp.ts` for the protocol and `harness.ts` for the tools.
   */
  if (url.pathname === "/mcp") {
    if (req.method === "GET") {
      // No server-initiated stream here; the protocol lets a server say so.
      text(res, "kururu speaks MCP over POST only\n", 405);
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(200).end();
      return;
    }
    if (req.method !== "POST") {
      text(res, "POST only", 405);
      return;
    }
    const profileId = url.searchParams.get("profile") ?? "";
    if (!workspaces.profile(profileId)) {
      json(res, { jsonrpc: "2.0", id: null, error: { code: -32000, message: "no such profile" } }, 404);
      return;
    }
    const selfId = harness.selfFor(profileId, url.searchParams.get("session") ?? "");
    try {
      const body = await readJsonBody(req, 256 * 1024);
      const answer = await mcpAnswer(body, harness.tools(profileId), (name, args) => harness.call(profileId, selfId, name, args), {
        name: "kururu",
        version: VERSION,
      });
      if (answer.body === undefined) res.writeHead(answer.status).end();
      else json(res, answer.body, answer.status);
    } catch (err) {
      json(res, { jsonrpc: "2.0", id: null, error: { code: -32700, message: err instanceof Error ? err.message : String(err) } }, 400);
    }
    return;
  }

  /**
   * The last little while of one terminal's raw stream, for diagnosing something
   * that has already happened. Plain text, deliberately: it is read by a person,
   * usually by piping it into a file. See `record.ts`.
   */
  if (url.pathname === "/api/record") {
    const agentId = url.searchParams.get("agent") ?? "";
    if (!agentId || !host.find(agentId)) {
      text(res, "no such agent\n", 404);
      return;
    }
    text(res, dumpRecording(agentId, Number(url.searchParams.get("tail")) || undefined));
    return;
  }

  /**
   * What there is to be notified *by*: kururu's own sounds and the machine's.
   *
   * A fetch rather than a snapshot field, on `/api/styles`' split — the snapshot
   * carries what somebody *chose*, and this is what there is to choose from. It
   * is a directory listing of somebody else's files, it changes when they drop a
   * file into `~/Library/Sounds` rather than when kururu does anything, and the
   * only thing in the window that cannot be drawn without it is the one tab
   * asking.
   */
  if (url.pathname === "/api/sounds") {
    json(res, { sounds: sounds() });
    return;
  }

  /**
   * One sound, in something the browser can actually play.
   *
   * The transcode is `sounds.ts`' business and the reason it exists; what
   * belongs here is the caching, and it is a year because a *sound* is
   * immutable in the way a style asset is: the id names a file on this machine
   * and the phone should fetch each one once, ever. The case that breaks that —
   * somebody replacing `~/Library/Sounds/Frog.wav` — is rare enough and
   * self-inflicted enough that a reload is the right cost, where re-fetching
   * every notification sound on every page load is not.
   */
  /**
   * The voice's two doors. A clip in: a WAV the window recorded, for the
   * profile it names, under the id the window minted for it, answered the
   * moment it is on the disk with the outbox's record of it — see
   * `outbox.ts` for the rest of its way to Kuru. A sentence out: one chunk
   * of an utterance the socket announced, which every client of the profile
   * fetches once. Not cached, since an utterance id is never reused and a
   * reply is nobody's to keep.
   *
   * A clip past the cap is answered with 413 and why, after the body has
   * been read to its end. It used to be refused by destroying the request,
   * which the window saw as a dropped connection and nothing else.
   */
  if (url.pathname === "/api/voice/hear") {
    if (req.method !== "POST") {
      text(res, "POST only", 405);
      return;
    }
    const asked = url.searchParams.get("profile") ?? "";
    const profileId = workspaces.profile(asked) ? asked : workspaces.active.id;
    const given = url.searchParams.get("id");
    // A page from before the outbox sends no id, and its clip is still a message.
    const id = isClipId(given) ? given : randomUUID();
    const said = Number(url.searchParams.get("at"));
    const at = Number.isFinite(said) && said > 0 ? said : Date.now();
    let wav: Buffer;
    try {
      wav = await readClip(req, CLIP_MAX_BYTES);
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, err instanceof ClipTooLong ? 413 : 400);
      return;
    }
    try {
      const entry = outbox.take(workspaces.keyOf(profileId)!, id, at, wav);
      // A page from before the outbox holds the upload open for the words
      // and reads them in the old shape; it gets both, once they are made.
      if (isClipId(given)) json(res, { entry });
      else json(res, { entry, ...legacyHeard(entry ? await outbox.firstPass(entry.id) : null) });
    } catch (err) {
      // Not on the disk is not taken: the window keeps it and sends again.
      json(res, { error: `the clip could not be kept: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
    return;
  }
  /**
   * A file for Kuru's box that the page cannot name by its path — a picture
   * off the clipboard, a phone's photo — kept in `drops/` and answered with
   * the path of the copy. `?name=` is what the page called it, which is only
   * ever a hint for the copy's name: the bytes decide what it is (see
   * `shared/drops.ts`). The page checks the size before it sends; the
   * declared length is checked here so a body past the cap is answered
   * rather than read, and `readBody` is the backstop for one that lied.
   */
  if (url.pathname === "/api/drop") {
    if (req.method !== "POST") {
      text(res, "POST only", 405);
      return;
    }
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > DROP_MAX_BYTES) {
      json(res, { error: `that file is over ${DROP_MAX_BYTES / 1024 / 1024} MB` }, 413);
      return;
    }
    let bytes: Buffer;
    try {
      bytes = await readBody(req, DROP_MAX_BYTES);
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 413);
      return;
    }
    try {
      json(res, keepDrop(bytes, (url.searchParams.get("name") ?? "").slice(0, 255)));
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, err instanceof DropRefused ? 415 : 500);
    }
    return;
  }
  if (url.pathname === "/api/speech") {
    const seq = Number(url.searchParams.get("seq") ?? "0");
    const bytes = Number.isFinite(seq) && seq >= 0 ? voice.chunk(url.searchParams.get("u") ?? "", Math.floor(seq)) : null;
    if (!bytes) {
      text(res, "no such sentence\n", 404);
      return;
    }
    res.writeHead(200, { "content-type": "audio/wav", "content-length": bytes.length, "cache-control": "no-store" });
    res.end(bytes);
    return;
  }

  if (url.pathname === "/api/sound") {
    const sound = await soundBytes(url.searchParams.get("id") ?? "");
    if (!sound) {
      text(res, "no such sound\n", 404);
      return;
    }
    res.writeHead(200, {
      "content-type": sound.type,
      "content-length": sound.bytes.length,
      "cache-control": "public, max-age=31536000, immutable",
    });
    res.end(sound.bytes);
    return;
  }

  /**
   * One sprite sheet. `?sheet=` names it — Settings asks for each in turn to
   * draw its picker — and without one you get whichever is currently selected,
   * which is all a row drawing a badge ever needs to know.
   *
   * An endpoint rather than a static file because most sheets live outside the
   * app entirely, in the user's config directory, and because the name has to be
   * checked against the list rather than pasted into a path: this is reachable
   * from the tailnet. `no-cache` so a user who overwrites their own sheet sees
   * it after a reload rather than after a restart; the sheets that ship never
   * change, and they are fifteen kilobytes.
   */
  if (url.pathname === "/api/mascot.png") {
    const body = sheetImage(url.searchParams.get("sheet") ?? defaultMascot(mascots).sheet);
    if (!body) {
      text(res, "no such sheet\n", 404);
      return;
    }
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[".png"]!,
      "content-length": body.length,
      "cache-control": "no-cache",
    });
    res.end(body);
    return;
  }

  // --- the styles registry -------------------------------------------------
  /**
   * What `../kururu-styles` is offering, and what this machine already has of it.
   *
   * A fetch rather than a snapshot field, and the split is the one the update
   * check draws: the snapshot carries what *kururu* owns, and this is the
   * world's. It changes when somebody merges a pull request in another
   * repository, answering it means a request over the network, and nothing in
   * the window can be drawn without it except the one tab that is asking. The
   * installed half *is* in the snapshot, because a theme you are wearing is not
   * a catalogue.
   *
   * `?refresh=1` is the *Check for updates* button, and it is the only thing
   * that bypasses the ten-minute cache — which is what makes that button a
   * button rather than decoration.
   */
  if (url.pathname === "/api/styles/catalog") {
    const { index, stale, error } = await catalog(url.searchParams.get("refresh") === "1");
    json(res, {
      entries: index ? annotateCatalog(index, styles.installed) : [],
      stale,
      ...(error ? { error } : {}),
      home: stylesHome(),
    });
    return;
  }

  /**
   * One file out of an installed style — a font, a stylesheet, a texture.
   *
   * An endpoint rather than static serving for `sheetFile`'s reason and one
   * more. The reason: the name is checked against what the entry actually
   * recorded rather than pasted into a path, and this is reachable from the
   * tailnet. The one more: everything a style brings is served from *kururu's
   * own origin*, which is the entire point of installing rather than linking —
   * a window that fetched a font from somebody else's host would tell that host
   * when its owner was working.
   *
   * Cached hard, because the URL names an entry whose contents cannot change
   * without a version bump and a reinstall.
   */
  if (url.pathname === "/api/styles/asset") {
    const path = assetFile(
      url.searchParams.get("kind") ?? "",
      url.searchParams.get("id") ?? "",
      url.searchParams.get("file") ?? "",
    );
    if (!path) {
      text(res, "no such asset\n", 404);
      return;
    }
    let body: Buffer;
    try {
      body = readFileSync(path);
    } catch {
      text(res, "no such asset\n", 404);
      return;
    }
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
      "content-length": body.length,
      "cache-control": "public, max-age=31536000, immutable",
    });
    res.end(body);
    return;
  }

  /**
   * The picture for a mascot, or the noise for a sound, that nobody has
   * installed yet — proxied from the registry. See `preview` in
   * `server/src/styles.ts` for why this exists at all and why the browser is not
   * the thing fetching it.
   */
  if (url.pathname === "/api/styles/preview") {
    const shot = await previewStyle(url.searchParams.get("kind") ?? "", url.searchParams.get("id") ?? "", url.searchParams.get("file"));
    if (!shot) {
      text(res, "no preview\n", 404);
      return;
    }
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(shot.file).toLowerCase()] ?? "application/octet-stream",
      "content-length": shot.bytes.length,
      // Not `immutable`: the URL names an entry rather than a version, so it is
      // the one asset URL in kururu whose contents can change under it — a
      // registry entry updated upstream is exactly that. An hour is long enough
      // that scrolling the list twice is one request.
      "cache-control": "public, max-age=3600",
    });
    res.end(shot.bytes);
    return;
  }

  /**
   * Install one, and — if that is what the gesture was — wear it.
   *
   * `activate` is a parameter rather than something this decides, because the
   * two callers mean different things by the same download. Picking a theme in
   * the Styles tab is "I want this one", and an install that did not put it on
   * would make choosing a two-step gesture for no reason. Pressing *Update* on a
   * style you are not currently wearing is not a request to start wearing it,
   * and one that switched the window out from under you would be the kind of
   * surprise nobody forgives.
   */
  if (url.pathname === "/api/styles/install" && req.method === "POST") {
    const kind = url.searchParams.get("kind") ?? "";
    const id = url.searchParams.get("id") ?? "";
    const activate = url.searchParams.get("activate") === "1";
    const result = await installOne(kind, id, activate);
    if (!result.ok) {
      json(res, { error: result.error }, 400);
      return;
    }
    json(res, { ok: true, installed: styles.installed });
    return;
  }

  /**
   * Wear one that is already here. No network, no download, no version.
   *
   * A separate verb from `install` rather than `install?activate=1` on a style
   * that is already on disk, and the difference is the network: this has to work
   * on a plane. Installing checks the registry for the entry, which is right for
   * a download and absurd for "put the pack I have back on" — and it is the
   * gesture somebody makes most, because a pack is five decisions and changing
   * one of them by hand is how you end up wanting the other four back.
   */
  if (url.pathname === "/api/styles/wear" && req.method === "POST") {
    const kind = url.searchParams.get("kind") ?? "";
    const id = url.searchParams.get("id") ?? "";
    if (!isStyleKind(kind) || !isStyleId(id)) {
      json(res, { error: "that is not a style" }, 400);
      return;
    }
    const result = wear(kind, id);
    if (!result.ok) {
      json(res, { error: result.error }, 400);
      return;
    }
    json(res, { ok: true, installed: styles.installed });
    return;
  }

  if (url.pathname === "/api/styles/remove" && req.method === "POST") {
    const result = removeStyle(url.searchParams.get("kind") ?? "", url.searchParams.get("id") ?? "");
    if (!result.ok) {
      json(res, { error: result.error }, 400);
      return;
    }
    /**
     * Nothing here un-picks anything, and that is the point of the design rather
     * than an omission. `appearance.json` keeps the id of a theme you removed,
     * `themeFor` falls back to the default while it is gone, and reinstalling it
     * puts you back where you were — which is only possible because
     * `adoptAppearance` stopped rewriting ids it could not resolve.
     */
    provide("styles", readLibrary());
    pushSnapshot();
    json(res, { ok: true, installed: styles.installed });
    return;
  }

  /**
   * What Settings may offer. Not in the snapshot: it is a catalogue, wanted once
   * by one dialog, and putting it on every status change would be paying for it
   * continuously to save one request nobody makes twice.
   *
   * The two lists are kept apart because they are not the same kind of thing to
   * the UI: one of them has a remove button. `dir` is there so the dialog can
   * tell you where they went without spelling the path a second time.
   *
   * DELETE removes one of yours. It is the same shape as the import below — a
   * name, checked against the list of imported sheets and nothing else.
   */
  if (url.pathname === "/api/mascot/sheets") {
    if (req.method === "DELETE") {
      const name = url.searchParams.get("name") ?? "";
      if (!removeSheet(name)) {
        json(res, { error: "no such imported sheet" }, 404);
        return;
      }
      json(res, { ok: true, builtin: builtinSheets(), imported: importedSheets(), dir: sheetsDir() });
      return;
    }
    json(res, { builtin: builtinSheets(), imported: importedSheets(), dir: sheetsDir() });
    return;
  }

  /**
   * A sheet somebody picked in a file dialog, on its way to `~/.config/kururu/sheets`.
   *
   * The body is the file, not JSON and not a form: it is one PNG going to one
   * place, and multipart would be a parser to maintain for a boundary nobody
   * needs. The name travels in the query so the bytes can stay the bytes.
   *
   * Every check is in `importSheet` rather than here, because this is the one
   * endpoint that writes a file to the user's config directory on behalf of a
   * client, and the checks belong beside the write rather than beside the route.
   */
  if (url.pathname === "/api/mascot/import") {
    if (req.method !== "POST") {
      text(res, "POST only", 405);
      return;
    }
    let bytes: Buffer;
    try {
      bytes = await readBody(req, IMPORT_LIMIT);
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : "could not read that file" }, 413);
      return;
    }
    const result = importSheet(url.searchParams.get("name") ?? "", bytes);
    if (!result.ok) {
      json(res, { error: result.error }, 400);
      return;
    }
    json(res, { name: result.name, builtin: builtinSheets(), imported: importedSheets(), dir: sheetsDir() });
    return;
  }

  // --- the skin studio ------------------------------------------------------
  /**
   * A skin of yours, being made. See `server/src/studio.ts` for what one is —
   * an ordinary installed skin with `local` on its record — and why that is the
   * whole design. What is here is the four verbs and one rule they share: every
   * one of them ends in `styles = readLibrary()` and a snapshot, because the
   * point of the studio is that the window you are looking at *is* the preview,
   * and so is the phone's.
   *
   * Wearing follows editing. Creating a skin puts it on, and so does the first
   * edit to one you are not wearing, on the reasoning the Styles tab gives for
   * picking being installing: nobody opens a skin to edit it and then wonders
   * whether to look at it. It is the studio's one act of switching, and it is
   * the reason the response is the manifest rather than a bare `ok` — the
   * page needs the file names back to draw its thumbnails from.
   */
  if (url.pathname === "/api/studio/skin") {
    const id = url.searchParams.get("id") ?? "";
    if (req.method === "GET") {
      const manifest = readLocalManifest(id);
      if (!manifest) {
        json(res, { error: "that is not a skin of yours" }, 404);
        return;
      }
      const record = styles.installed.find((r) => r.kind === "skin" && r.id === id && r.local);
      json(res, { manifest, files: record?.files ?? [], dir: localDir(id) });
      return;
    }
    if (req.method === "POST") {
      const result = createLocalSkin(id, url.searchParams.get("name") ?? "", url.searchParams.get("from"), styles);
      if (!result.ok) {
        json(res, { error: result.error }, 400);
        return;
      }
      provide("styles", readLibrary());
      saveAppearance({ ...appearance, skinId: id });
      json(res, { ok: true, manifest: result.manifest, files: styles.installed.find((r) => r.kind === "skin" && r.id === id)?.files ?? [], dir: localDir(id) });
      return;
    }
    if (req.method === "PUT") {
      let body: unknown;
      try {
        body = await readJsonBody(req, 256 * 1024);
      } catch {
        json(res, { error: "that manifest could not be read" }, 400);
        return;
      }
      const result = writeLocalManifest(id, body);
      if (!result.ok) {
        json(res, { error: result.error }, 400);
        return;
      }
      provide("styles", readLibrary());
      if (appearance.skinId !== id) saveAppearance({ ...appearance, skinId: id });
      else pushSnapshot();
      json(res, { ok: true, manifest: result.manifest });
      return;
    }
    text(res, "GET, POST or PUT", 405);
    return;
  }

  /**
   * A picture or a font, into a skin of yours. The body is the file, on the
   * mascot import's reasoning — one file to one place, and the name in the
   * query so the bytes can stay the bytes. Every check is in `putLocalAsset`,
   * beside the write.
   */
  if (url.pathname === "/api/studio/asset") {
    const id = url.searchParams.get("id") ?? "";
    const file = url.searchParams.get("file") ?? "";
    if (req.method === "DELETE") {
      const result = removeLocalAsset(id, file);
      if (!result.ok) {
        json(res, { error: result.error }, 400);
        return;
      }
      provide("styles", readLibrary());
      pushSnapshot();
      json(res, { ok: true, files: result.files });
      return;
    }
    if (req.method !== "POST") {
      text(res, "POST or DELETE", 405);
      return;
    }
    let bytes: Buffer;
    try {
      bytes = await readBody(req, IMPORT_LIMIT);
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : "could not read that file" }, 413);
      return;
    }
    const result = putLocalAsset(id, file, bytes);
    if (!result.ok) {
      json(res, { error: result.error }, 400);
      return;
    }
    provide("styles", readLibrary());
    pushSnapshot();
    json(res, { ok: true, file: result.file, files: result.files, width: result.width, height: result.height, stamp: Date.now() });
    return;
  }

  /**
   * Show the skin's directory in the file manager — of the machine the server
   * is on, which is the only machine that has it. From the phone this opens a
   * Finder window on the desktop, which is odd and correct: the files are
   * there, and "where did my skin go" has one answer. The path is the server's
   * own, built from an id it checked; nothing from the client reaches the
   * command line.
   */
  if (url.pathname === "/api/studio/reveal" && req.method === "POST") {
    const id = url.searchParams.get("id") ?? "";
    if (!readLocalManifest(id)) {
      json(res, { error: "that is not a skin of yours" }, 404);
      return;
    }
    const dir = localDir(id);
    const [cmd, args] = process.platform === "darwin" ? ["open", [dir]] : ["xdg-open", [dir]];
    execFile(cmd, args, () => {
      // A machine with no file manager is a machine where the path in the
      // dialog is the answer, and it is already on screen.
    });
    json(res, { ok: true, dir });
    return;
  }

  // --- file browsing -------------------------------------------------------
  if (url.pathname === "/api/roots") {
    json(res, { roots: allowedRoots() });
    return;
  }
  if (url.pathname === "/api/nvim-buffer" && req.method === "POST") {
    void readBody(req, NVIM_BODY_LIMIT)
      .then((body) => nvimBuffer(JSON.parse(body.toString("utf8"))))
      .catch(() => {
        // an editor that sent something unparseable is not worth a log line
      });
    json(res, { ok: true });
    return;
  }
  /**
   * The documents a picker offers, and the projects it could offer them from.
   *
   * The roots travel with every answer rather than being a second request: the
   * list and the thing that changes which list it is belong on screen together,
   * and this is answering a tap on a phone. With exactly one project there is no
   * choice to make and the client is not asked to make one — it gets the
   * documents straight away. With several and no root named, `root` comes back
   * empty and the client draws the projects instead, which is a question kururu
   * genuinely cannot answer for it.
   */
  if (url.pathname === "/api/docs") {
    const roots = allowedRoots();
    const asked = url.searchParams.get("root") ?? "";
    const root = asked || (roots.length === 1 ? (roots[0] ?? "") : "");
    if (!root) {
      json(res, { roots, root: "", docs: [] });
      return;
    }
    try {
      json(res, { roots, root, docs: findDocs(root) });
    } catch (err) {
      json(res, { roots, root: "", docs: [], error: err instanceof Error ? err.message : String(err) }, 400);
    }
    return;
  }
  if (url.pathname === "/api/markdown") {
    const root = url.searchParams.get("root") ?? "";
    const path = url.searchParams.get("path") ?? "";
    void (async () => {
      try {
        const file = readFile(root, path);
        json(res, await renderMarkdown(file.text, root, path, appearance.themeId));
      } catch (err) {
        json(res, { error: err instanceof Error ? err.message : String(err) }, 400);
      }
    })();
    return;
  }
  /**
   * A card's body as markup, for a card popped out as a note
   * (`web/src/components/Notes.tsx`). Through the reader's renderer, for its
   * reason — the phone is sent markup, not a parser — and found by the
   * card's id in the active profile, never handed the text: what is
   * rendered is what the card says. No root, as release notes have none, so
   * a relative image in a card is a fetch `files.ts` refuses rather than a
   * file read from wherever it pointed.
   */
  /**
   * The active profile's cards as the menu bar pops them out as notes —
   * what needs you, then the profile's board (`shared/notecards.ts`). A GET
   * for a caller with no socket, like `/api/kuru/play`; it says no more than
   * the snapshot every client is sent.
   */
  if (url.pathname === "/api/notes/cards") {
    const profile = workspaces.active;
    const mine = new Set(workspaces.agentsIn(profile.id));
    json(res, noteCards(profile, host.agents.filter((agent) => mine.has(agent.id)).map(overlay)));
    return;
  }
  if (url.pathname === "/api/card-markdown") {
    const cardId = url.searchParams.get("card") ?? "";
    const profile = workspaces.active;
    const card =
      profile.board.cards.find((c) => c.id === cardId) ??
      profile.workspaces.flatMap((w) => w.board?.cards ?? []).find((c) => c.id === cardId);
    if (!card) {
      json(res, { error: "no such card" }, 404);
      return;
    }
    void renderMarkdown(card.body, "", "card.md", appearance.themeId).then(
      (rendered) => json(res, { html: rendered.html }),
      (err: unknown) => json(res, { error: err instanceof Error ? err.message : String(err) }, 400),
    );
    return;
  }
  if (url.pathname === "/api/file-raw") {
    const root = url.searchParams.get("root") ?? "";
    const path = url.searchParams.get("path") ?? "";
    try {
      const file = readBytes(root, path);
      serveRaw(res, file.type, file.bytes);
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 400);
    }
    return;
  }
  if (url.pathname === "/api/dirs") {
    try {
      json(res, { dirs: listDirs(url.searchParams.get("root") ?? "") });
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 400);
    }
    return;
  }
  /**
   * The tree's edits — see `fileops.ts`, which is the only thing that decides
   * anything here. POST only: a GET that renames a file is one a prefetch, a
   * crawler or a pasted link can trigger, and the gate above is what stops a
   * page somewhere else from sending one of these at all.
   */
  if (url.pathname === "/api/fs" && req.method === "POST") {
    void (async () => {
      let op;
      try {
        op = parseFileOp(await readJsonBody(req));
      } catch {
        op = null;
      }
      if (!op) return json(res, { error: "not a file operation" }, 400);
      const result = await runFileOp(op);
      if (result.ok) json(res, result);
      else json(res, { error: result.error }, 400);
    })();
    return;
  }
  /**
   * Another node's disk, for a workspace of its on this screen: the routes
   * above, answered by that node over its watch (`NodeWatches.ask`). The
   * query is the local routes' with the node's own roots — the page strips
   * the qualification, and the node checks the root against what it found
   * itself, so nothing here decides what a path means. Reads only: the
   * tree's edits are made on the node, through nvim or its own page.
   */
  const onNode = /^\/api\/node\/(n[0-9a-f]{12})\/([a-z-]+)$/.exec(url.pathname);
  if (onNode) {
    void nodeRead(res, onNode[1]!, onNode[2]!, url.searchParams);
    return;
  }
  if (url.pathname === "/api/ls" || url.pathname === "/api/file") {
    const root = url.searchParams.get("root") ?? "";
    const path = url.searchParams.get("path") ?? "";
    try {
      json(res, url.pathname === "/api/ls" ? { entries: listDir(root, path) } : readFile(root, path));
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 400);
    }
    return;
  }

  if (process.env.KURURU_DEV === "1" && !existsSync(join(WEB_DIST, "index.html"))) {
    text(
      res,
      `kururu server is up on :${PORT}.\nThe UI is not built — run \`bun run build\`, or let the desktop app start vite.\n`,
    );
    return;
  }

  serveStatic(res, url.pathname === "/" ? "index.html" : url.pathname.slice(1));
}

/** A file's bytes, as `/api/file-raw` serves them, from this disk or a node's. */
function serveRaw(res: ServerResponse, type: string, bytes: Uint8Array): void {
  res.writeHead(200, {
    "content-type": type,
    "content-length": bytes.length,
    // An SVG is a document, and a browser pointed straight at this URL would
    // treat it as one. In an `<img>` — the only way the reader asks for it —
    // none of that runs; these say so for the case somebody opens the link.
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    "x-content-type-options": "nosniff",
    "content-disposition": "inline",
    "cache-control": "no-cache",
  });
  res.end(bytes);
}

/** A media type as a node said it, or the one that makes a browser do nothing clever with it. */
const MEDIA_TYPE = /^[a-z]+\/[a-z0-9.+-]+(; ?charset=[a-z0-9-]+)?$/i;

/**
 * `/api/node/<id>/ls`, `docs`, `markdown` and `file-raw`: what the local
 * route of the same name answers, asked of the node. Every root the answer
 * names is qualified on the way to the page, so the tree's and the picker's
 * next verb says whose disk it is about; the markup's image links are
 * pointed back through here, since `/api/file-raw` is this disk's.
 */
async function nodeRead(res: ServerResponse, node: string, op: string, query: URLSearchParams): Promise<void> {
  const root = query.get("root") ?? "";
  const path = query.get("path") ?? "";
  try {
    switch (op) {
      case "ls":
        return json(res, await watches.ask(node, { type: "files-ask", op: "ls", root, path }));
      case "docs": {
        const answer = (await watches.ask(node, { type: "files-ask", op: "docs", root })) as { roots?: unknown; root?: unknown; docs?: unknown };
        const roots = Array.isArray(answer.roots) ? answer.roots.filter((r): r is string => typeof r === "string") : [];
        return json(res, {
          roots: roots.map((r) => qualifyRoot(node, r)),
          root: typeof answer.root === "string" ? qualifyRoot(node, answer.root) : "",
          docs: Array.isArray(answer.docs) ? answer.docs : [],
        });
      }
      case "markdown": {
        const answer = (await watches.ask(node, { type: "doc-ask", op: "markdown", root, path, themeId: appearance.themeId })) as Record<string, unknown>;
        // An attribute is the only place a bare quote survives the renderer —
        // markdown-it escapes one in text — so this finds the image links and
        // nothing a document says.
        const html = typeof answer.html === "string" ? answer.html.replaceAll('"/api/file-raw?', `"/api/node/${node}/file-raw?`) : "";
        return json(res, { ...answer, html });
      }
      case "file-raw": {
        const answer = (await watches.ask(node, { type: "doc-ask", op: "raw", root, path })) as { type?: unknown; data?: unknown };
        if (typeof answer.data !== "string") throw new Error("that node sent no file");
        const type = typeof answer.type === "string" && MEDIA_TYPE.test(answer.type) ? answer.type : "application/octet-stream";
        return serveRaw(res, type, Buffer.from(answer.data, "base64"));
      }
      default:
        return json(res, { error: "not a read of another computer's this server makes" }, 404);
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    json(res, op === "docs" ? { roots: [], root: "", docs: [], error } : { error }, 400);
  }
}

// ---------------------------------------------------------------------------
// Listen
// ---------------------------------------------------------------------------

function onRequest(req: IncomingMessage, res: ServerResponse): void {
  void handleRequest(req, res).catch((err: unknown) => {
    // The path without its query, which is where a share token or a search would be.
    const path = (req.url ?? "").split("?")[0];
    console.error(`kururu: ${req.method ?? "?"} ${path} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    if (!res.headersSent) text(res, "kururu: internal error", 500);
    else res.destroy();
  });
}

/**
 * One server per address in `listenAddresses()`, all answering alike. One
 * almost always; two for a server bound to one address that is not loopback
 * (a child's tailnet address), because every caller on this machine — the
 * hooks, the tools, the agents' MCP configs — dials 127.0.0.1 and a socket
 * on 100.x does not answer there.
 */
const servers = listenAddresses().map(() => createServer(onRequest));
const server = servers[0]!;

/**
 * Compressed, because a snapshot is JSON of every card on every board and
 * deflates to under a third — 1.2 MB to the phone over the tailnet is the
 * case it is for. Level 1, since the ratio on text this repetitive barely
 * moves past it and the cost is per client; and nothing under 4 KB, which
 * is every keystroke's echo and most output, where deflating would only add
 * latency. The compressing runs on libuv's pool, off this thread.
 */
const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: { threshold: 4096, zlibDeflateOptions: { level: 1 } },
});

/**
 * When a client last connected from anywhere but this machine, or null. It is
 * how `kururu child setup` knows the phone it printed a code for has opened
 * it: a child has no window, so a first client from elsewhere is the phone.
 */
let remoteClientAt: string | null = null;

/**
 * The links between nodes: their own server, for the larger frames a
 * child's backup is, and so a link is never mistaken for a client.
 */
const linkWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });

function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  /**
   * Another node. Ahead of the token gate, like joining, because a node
   * is not let in by the share token — nobody holds another's — but by the
   * handshake that follows, in which it signs a challenge with a key the
   * roster lists. What is checked here is only where it came from.
   */
  if (url.pathname === "/link") {
    if (nodeRequestRefusal(req)) {
      socket.destroy();
      return;
    }
    linkWss.handleUpgrade(req, socket, head, (ws) => nodes.accept(ws));
    return;
  }
  /**
   * The parent's server, to be a client of this one: `/ws` with a different
   * doorman. What `/link` refuses first — a page's `Origin`, a proxy's
   * header, anything off the tailnet and loopback — then the node
   * handshake, then the roster's parent and nobody else. A child's
   * compromise is accepted as words into its peers' Kurus; a shell on
   * another node is a different order of thing, so the parent watches
   * children and nothing watches the parent (a parent's `parentId` is
   * itself, so it refuses every peer here). Past that, it is a client like
   * any other, tagged with the node it proved.
   */
  if (url.pathname === "/link/watch") {
    if (nodeRequestRefusal(req)) {
      socket.destroy();
      return;
    }
    linkWss.handleUpgrade(req, socket, head, (ws) =>
      nodes.watchHandshake(
        ws,
        null,
        (peer) => {
          const name = nodes.nameOf(peer) ?? peer;
          const refusal = nodes.watchRefusal(peer);
          if (refusal) {
            console.log(`kururu: refused a watch from ${name}: ${refusal}`);
            try {
              ws.send(JSON.stringify({ type: "refuse", reason: refusal }));
            } catch {
              // Going anyway.
            }
            ws.close(1008, refusal);
            return;
          }
          record("watch", `${name} is watching this node's terminals`);
          nodes.noteWatcher(peer, true);
          ws.on("close", () => {
            record("watch", `${name} stopped watching`);
            nodes.noteWatcher(peer, false);
          });
          admitClient(ws, peer, url.searchParams.get("delta") === "1");
        },
        (reason) => console.log(`kururu: refused a watch: ${reason}`),
      ),
    );
    return;
  }
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  /**
   * The same gate the HTTP side is behind, and the case it exists for most.
   *
   * A WebSocket is not subject to the same-origin policy and sends no preflight,
   * so without this any page in any tab could open one to a *loopback-bound*
   * kururu and drive it — read the snapshot, spawn a pty, type into it. The
   * refusal is a closed socket rather than a status, because there is no
   * handshake to put one in yet and a client that is not ours has nothing to be
   * told.
   */
  if (verdict(req, url) !== "ok") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (!fromLoopback(req)) remoteClientAt = new Date().toISOString();
    admitClient(ws, null, url.searchParams.get("delta") === "1");
  });
}

/**
 * What `/ws` does once a client is let in, and what `/link/watch` does once
 * the parent has proved itself: the same client, with a watcher sent only
 * what it relays and starting nothing a window starts.
 */
function admitClient(ws: WebSocket, watcher: string | null, deltas: boolean): void {
  const st: ClientState = {
    watching: new Set(),
    warm: new Set(),
    proposals: new Map(),
    looking: true,
    awaiting: new Map(),
    watcher,
    heard: true,
    owedSnapshot: false,
    deltas,
    sent: null,
  };
  clients.set(ws, st);
  const heard = () => {
    const st = clients.get(ws);
    if (st) st.heard = true;
  };
  ws.on("pong", heard);
  // The first one in after a quiet spell, when the process table is being
  // read at the idle beat: read it now rather than up to half a minute on.
  if (clients.size === 1) wakeProcesses();
  ws.on("message", (data) => {
    heard();
    handleMessage(ws, data.toString());
    // What a verb changed is drawn at once, gap or no gap: see `pushSnapshot`.
    if (snapshots.pending) queueMicrotask(() => snapshots.flush());
  });
  ws.on("close", () => dropClient(ws));
  ws.on("error", () => dropClient(ws));
  // A change already waiting goes to everybody first, this client whole with it.
  if (snapshots.pending) snapshots.flush();
  if (!st.sent) sendState([[ws, st]], snapshot());
  send(ws, { type: "projects", projects: state.projects });
  // The listeners went first: a watcher is admitted from inside the frame that
  // proved it, and the parent's first `watch` may be the next frame in the
  // same chunk (phase 0, finding 2).
  if (watcher) return;
  send(ws, { type: "dev-servers", servers: state.devServers });
  send(ws, { type: "branches", branches: state.branches });
  send(ws, { type: "databases", databases: state.databases });
  send(ws, { type: "usage", usage: usageSnapshot() });
  send(ws, { type: "codex-usage", codex: codexUsageSnapshot() });
  send(ws, { type: "machines", machines: machinesSnapshot() });
  send(ws, { type: "specs", specs: specsSnapshot(machinesSnapshot()) });
  send(ws, { type: "nodes", nodes: nodes.view() });
  send(ws, { type: "secrets", secrets: secrets.view() });
  send(ws, { type: "openrouter", openrouter: openRouterSnapshot() });
  send(ws, { type: "web", web: web.status() });
  send(ws, { type: "voice", voice: voice.status() });
  send(ws, voice.hush());
  send(ws, kuru.message());
  send(ws, outbox.message());
  send(ws, channels.message());
  send(ws, backup.message());
  // The first client through the door is also what starts the usage poll: it
  // is skipped while nothing is connected, so without this a freshly started
  // server would draw no bar for a minute.
  void pollAccountUsage();
  // The machine and OpenRouter polls the same way, but only for the first: a
  // second window would otherwise buy every machine an extra ssh round, and
  // the account an extra request, for nothing.
  if (windows() === 1) {
    void pollServers();
    void pollOpenRouterAccount();
  }
}

for (const each of servers) {
  each.on("upgrade", onUpgrade);
  /** A websocket held open by a sleeping phone must not be hung up on. */
  each.keepAliveTimeout = 0;
  each.headersTimeout = 0;
  each.requestTimeout = 0;
}

// ---------------------------------------------------------------------------
// Coming up
// ---------------------------------------------------------------------------

/**
 * Attach to the pty host, work out what the window is supposed to look like,
 * and only then start serving.
 *
 * The order of preference for the arrangement is the whole point of the split.
 * The host's blob is what a server *we* replaced left behind a moment ago —
 * complete, with every tab still pointing at a live pty — so a restart is
 * invisible. The file on disk is the cold-start fallback, and it has the
 * processes stripped out because they are not coming back. Neither is trusted
 * blindly: a tab pointing at a terminal the host does not have is dropped,
 * which is what stops a stale blob from showing tabs that are not there.
 */
async function attach(port: Port): Promise<void> {
  provide("host", new HostLink(port));
  host.onAgents = () => {
    // One event, three readers. Notifications want the *transition* and the
    // snapshot carries the state, so this has to run wherever the state is
    // learnt — a second subscription would be a second thing to keep in step
    // with a status that already only changes in one place. The reap is the
    // same argument again, and runs after the notice so that a terminal which
    // said something on its way out has still been heard.
    noticeStatuses();
    reapExited();
    pushSnapshot();
  };
  host.onOutput = onOutput;

  const state = await host.hello();
  provide("hostInfo", { version: state.version, current: state.protocol >= HOST_PROTOCOL });
  provide("hostProtocol", state.protocol);
  if (!hostInfo.current) {
    // Said once, here, because the host's log is the only other place it could
    // be said and nobody is reading that until something has gone wrong.
    console.warn(
      `kururu: the pty host speaks protocol ${state.protocol} and this server ${HOST_PROTOCOL} — restart the host to pick up its new code, which ends every agent`,
    );
  }
  const live = new Set(state.agents.filter((agent) => !agent.exited).map((agent) => agent.id));

  let profiles: Profile[] | undefined;
  let activeProfileId: string | undefined;
  if (state.blob) {
    try {
      const kept = JSON.parse(state.blob) as { profiles: Profile[]; activeProfileId: string };
      profiles = adoptReaders(kept.profiles);
      activeProfileId = kept.activeProfileId;
    } catch {
      // A blob we cannot read is no worse than not having one.
    }
  }
  if (!profiles) {
    const fromDisk = readSnapshot();
    profiles = fromDisk?.profiles;
    activeProfileId = fromDisk?.activeProfileId;
  }

  provide("workspaces", new Workspaces(profiles));
  if (activeProfileId) workspaces.switchProfile(activeProfileId);
  /**
   * The database, made on the first start: every board read out of it and
   * every change written through it from here on, with the keys the blob or
   * the file carried matched up. A card either of them holds that the
   * database has never seen — a file a build from before the database
   * wrote — is adopted, and the file is written again at once, keys and no
   * boards, so it is read for cards once. A database that is there and will
   * not open is a server that does not start: boards live nowhere else, and
   * a server running on without it would draw boards that forget everything
   * typed into them.
   */
  const made = !existsSync(dbPath());
  try {
    provide("store", Store.open());
    const attached = store.attach(workspaces.all(), live);
    workspaces.attachStore(store, attached.profiles);
    if (made) console.log(`kururu: no database at ${dbPath()}, so a new one was made`);
    if (attached.adopted || attached.recovered) {
      console.log(`kururu: database attached — ${attached.adopted} card(s) adopted from the layout, ${attached.recovered} key(s) matched by name`);
    }
    if (attached.adopted) writeSnapshot(workspaces.all(), workspaces.active.id);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    const what = made ? "made" : "opened";
    record("crash", `the database at ${dbPath()} could not be ${what}: ${why}`);
    console.error(
      `kururu: the database at ${dbPath()} could not be ${what}: ${why}\n  Boards live nowhere else, so the server will not start without it.${made ? "" : " Move the file aside only if you mean to start from the last backup."}`,
    );
    process.exit(1);
  }
  // The usage ledger, read after the window has had a moment. Its own file and
  // nothing to do with whether the boards opened: a server without it has lost
  // a chart, and it says so rather than refusing to start.
  provide("usageReader", openUsageReader(
    () => store.usageAttribution(),
    (line) => console.log(line),
    {
      // A machine is read once it has given a reason to: a workspace pinned to it,
      // or an agent kururu started there. Being in the list is only being watched.
      machines: () => {
        const pinned = workspaces.pinnedMachines();
        const launched = usageReader?.ledger.machinesLaunchedOn() ?? new Set<string>();
        return machinesSnapshot()
          .filter((machine) => pinned.has(machine.id) || launched.has(machine.name))
          .map(({ id, name, host }) => ({ id, name, host }));
      },
      machineReads: { list: usageFilesOn, chunk: usageChunkOn },
    },
  ));
  usageReader?.start();
  provide("usageLaunches", usageReader
    ? new Launches({
        ledger: usageReader.ledger,
        cardSessions: () => workspaces.cardSessions(),
        log: (line) => console.log(line),
        rolloutsOn: async (name, minutes) => {
          const machine = machinesSnapshot().find((each) => each.name === name);
          const listing = machine ? await codexRolloutsOn(machine.host, minutes) : null;
          return listing === null ? null : parseRolloutListing(listing).map(({ id, cwd, at }) => ({ id, cwd, at }));
        },
      })
    : null);
  usageLaunches?.start();
  // Everything the harness touches, lent as functions: `index.ts` exports
  // nothing and should not start to for one caller.
  provide("harness", new Harness({
    workspaces,
    host,
    version: VERSION,
    port: () => PORT,
    tokenInPtys: () => tokenInPtys(),
    launch: () => launch,
    grid: ownedGrid,
    activity,
    claudeDir: claudeDirOf,
    agentCommand: agentCommandFor,
    kuruCommand: kuruCommandFor,
    features: harnessFeatures,
    spawned: noteLaunch,
    webTools: () => web.active(),
    openTerminal: openTerminalAt,
    machines: machinesSnapshot,
    nodes: () => nodes.statuses(),
    remote: {
      shown: () => watches?.shown() ?? null,
      screen: (node, agentId) => (watches ? watches.screen(node, agentId) : Promise.resolve(null)),
    },
    // Through the variables: the links and the peers are built further down.
    peers: {
      self: () => nodes.name(),
      ask: (node, message, wait, timeoutS) => (peerKurus ? peerKurus.ask(node, message, wait, timeoutS) : Promise.resolve({ text: "Nodes are not up yet.", isError: true })),
      read: (node, turns) => (peerKurus ? peerKurus.read(node, turns) : { text: "Nodes are not up yet.", isError: true }),
      board: (node, verb, args) => (peerKurus ? peerKurus.board(node, verb, args) : Promise.resolve({ text: "Nodes are not up yet.", isError: true })),
    },
    shellOn: (machine, workspaceName, dir, run) =>
      run ? commandOn(machine, workspaceName, dir, run) : Promise.resolve(sessionShell(machine, workspaceName, dir)),
    agentOn,
    stopTerminal: (agentId) => {
      endRemote(agentId);
      host.kill(agentId);
    },
    cwdFor: cwdForPaneIn,
    runCard: (profileId, workspaceId, cardId, launcherId, fresh) => runCardAt(profileId, workspaceId, cardId, launcherId, false, "harness", fresh),
    stopDev,
    // Through the variable rather than the instance, because the voice is
    // built on the next line and needs the harness to hand words to. The
    // voice and the outbox name a profile by its key — see `store.ts` —
    // and the harness by its id, so the two are mapped here, at the edge.
    say: (profileId, text) => sayAside(profileId, text),
    replayMissed: (profileId) => voice.replay(workspaces.keyOf(profileId) ?? ""),
    search: searchFor,
    cardHistory: cardHistoryOf,
    reloadWindow: (why, timeoutMs) => reloads.ask(why, "Kuru", timeoutMs),
    madeOf: (agentId) => madeFiles.of(agentId),
    showFile: showFileFor,
    sendPicture: sendPictureFor,
    movePlan: (profileId, workspaceId, nodeId, folder) => mover.plan(profileId, workspaceId, nodeId, folder),
    moveWorkspace: (profileId, workspaceId, nodeId, folder) => mover.move(profileId, workspaceId, nodeId, folder, "harness"),
    lendOffer: (profileId, workspaceId, nodeId, folder) => lendOffer(profileId, workspaceId, nodeId, folder),
    lendSecrets: (profileId, workspaceId, nodeId, folder, ask) => lendSecrets(profileId, workspaceId, nodeId, folder, ask),
  }));
  // The reports a remote agent's hooks cannot send, read off its screen.
  provide("screens", new OnScreen({
    host,
    grid: ownedGrid,
    report: (agentId, report) => host.report(agentId, report),
    said: (agentId, text) => {
      if (text) activity.set(agentId, text.slice(0, MAX_ACTIVITY));
      else activity.delete(agentId);
      pushSnapshot();
    },
  }));
  screens.start();
  provide("sleeper", new Sleeper({
    host,
    settings: () => ({ on: launch.sleepIdle, minutes: launch.sleepMinutes }),
    cards: () => workspaces.cardRuns().map((at) => ({ ...at, prompt: cardPrompt(at.card) })),
    taken: () => workspaces.cardSessions(),
    grid: ownedGrid,
    isHarness: (agentId) => harness.isHarness(agentId) !== null,
    holding: (agentId) => harness.holding(agentId),
    transcript: (agentId) => harness.transcriptOf(agentId),
    claudeDir: claudeDirOf,
    codexHome: codexHomeOf,
    learned: (agentId, sessionId) => {
      workspaces.noteRunSession(agentId, sessionId);
      usageLaunches?.learned(agentId, sessionId);
    },
    sleep: (at, agent, idleMs) => {
      // The card first, so that a board the database refuses ends nothing.
      if (!workspaces.sleepRunOf(agent.id)) return;
      console.log(`kururu: put "${at.card.title}" to sleep after ${Math.round(idleMs / 60_000)} min idle (${agent.id}); running the card resumes it`);
      endTerminal(agent.id);
    },
  }));
  sleeper.start();
  provide("voice", new Voice({
    broadcast,
    index: { load: () => store.loadMissed(), save: (list) => store.saveMissed(list) },
    profileIdOf: (key) => workspaces.profileIdOf(key),
    // Through the variable: the conversation is assembled below, after the
    // outbox it also reads, and nothing here moves the list before then.
    changed: () => kuru.changed(),
  }));
  provide("outbox", new Outbox({
    // Every move of a message is also a move of the conversation it is in,
    // and of a channel's, which says when one of its messages failed.
    broadcast: (msg) => {
      broadcast(msg);
      if (msg.type === "outbox") {
        kuru.changed();
        channels.outboxMoved(msg.outbox, (id) => workspaces.keyOf(id));
        // And another node's words here report back to it as they move.
        peerKurus?.outboxMoved(msg.outbox);
      }
    },
    index: { load: () => store.loadOutbox(), save: (entries) => store.saveOutbox(entries), remove: (id) => store.removeVoice(id) },
    profileIdOf: (key) => workspaces.profileIdOf(key),
    transcribe: (path, ms) => voice.transcribe(path, ms),
    deliver: (profileKey, text, events) => {
      const profileId = workspaces.profileIdOf(profileKey);
      if (!profileId) return Promise.reject(new Error("that profile is gone"));
      return harness.hear(profileId, text, events);
    },
    harness: (profileKey) => {
      const agentId = workspaces.profileByKey(profileKey)?.harness?.agentId;
      const agent = agentId ? host.find(agentId) : undefined;
      if (!agentId || !agent || agent.exited) return null;
      return { agentId, status: agent.status, transcript: harness.transcriptOf(agentId) };
    },
    talk: (who, on) => voice.talk(who, on),
    delivered: (entry) => channels.delivered(entry.profileKey, entry),
    // `@devbox …`, for another node's Kuru, goes over the link. See `peerkuru.ts`.
    addressed: (text, spoken) => peerKurus?.addressed(text, spoken) ?? null,
    relay: (nodeId, words) => (peerKurus ? peerKurus.relay(nodeId, words) : "nodes are not up yet"),
  }));
  provide("channels", new Channels({
    // And the parent's settings into the roster, when they are what moved.
    broadcast: (msg) => {
      broadcast(msg);
      syncRosterChannels();
    },
    // A channel's message takes the composer's road: the same outbox, so the
    // same order, the same confirmation by Kuru's own hook, the same Resend.
    say: (profileKey, id, at, text) => void outbox.say(profileKey, id, at, text),
    profileKeyFor: (chosen) => (chosen && workspaces.profileByKey(chosen) ? chosen : workspaces.active.key),
    profileIdOf: (key) => workspaces.profileIdOf(key),
    kuruBusy: (profileKey) => {
      const agentId = workspaces.profileByKey(profileKey)?.harness?.agentId;
      const agent = agentId ? host.find(agentId) : undefined;
      return Boolean(agent && !agent.exited && agent.status === "working");
    },
  }));
  {
    // What is already failed is learned now, so only a failure from here on is told.
    const first = outbox.message();
    if (first.type === "outbox") channels.outboxMoved(first.outbox, (id) => workspaces.keyOf(id));
  }
  provide("kuru", new Kuru({
    store,
    profiles: () => workspaces.all().map((profile) => ({ id: profile.id, key: profile.key })),
    outbox: (key) => outbox.entriesOf(key),
    missed: (key) => voice.missedFor(key),
    broadcast,
    files: kuruFiles,
    peers: () => peerKurus?.peers() ?? [],
    moved: () => peerKurus?.conversationMoved(),
  }));
  provide("backup", new Backup({
    store,
    broadcast,
    configDir,
    stateDir: () => dirname(snapshotPath()),
    dataDir,
    ledger: () => usageReader?.ledger ?? null,
    // Each child's mirror, pulled over its link when its data moved, for
    // `nodes/<name>/` — through the variable, built on the next line.
    nodeMirrors: () => nodes.mirrors(),
    nodeMirrorsOwed: () => nodes.mirrorsOwed(),
  }));
  provide("nodes", new NodeHost({
    version: VERSION,
    port: PORT,
    hostname: hostname(),
    platform: process.platform,
    stateDir: dirname(snapshotPath()),
    address: nodeAddress,
    unreachable: nodeUnreachable,
    shareToken: () => token(),
    summary: nodeSummary,
    exportFiles: () => {
      const marks = store.marks();
      return {
        mark: `${marks.events}.${marks.turns}.${store.changes}@${STARTED_AT}`,
        files: mirrorFiles({ store, configDir: configDir(), stateDir: dirname(snapshotPath()), ledger: usageReader?.ledger ?? null }),
      };
    },
    changed: () => {
      pushNodes();
      // A link up or down is a grant that can be sent now, or cannot.
      pushSecrets();
    },
    log: (line) => console.log(`kururu: ${line}`),
    moves: { check: (peer, ask) => mover.check(peer, ask), adopt: (peer, offer) => mover.adopt(peer, offer), make: (peer, ask) => mover.make(peer, ask) },
    cardDone: (_peer, key, cardId) => cardDoneFor(key, cardId),
    peer: (nodeId, message) => peerKurus?.message(nodeId, message),
    // Leading is the Telegram poll, so the node that holds it leads.
    leader: () => lead?.holder() ?? null,
    usageExport: (known) =>
      usageReader
        ? exportUsage(usageReader.ledger, known, {
            workspace: (key) => store.usageWorkspaceName(key),
            card: (id) => store.usageCard(id)?.title ?? null,
          })
        : null,
    linked: (nodeId) => {
      peerKurus?.linked(nodeId);
      usageNodes?.pullSoon(3_000);
      // The user's words for that node that were waiting go now.
      outbox.retry(nodeId);
    },
  }));
  // After the host, whose statuses it reads. Only a parent has anybody to ask.
  provide("usageNodes", usageReader
    ? new NodeUsage({
        ledger: usageReader.ledger,
        nodes: () =>
          nodes.role() !== "parent"
            ? []
            : nodes.statuses().map((node) => ({ id: node.id, name: node.name, up: node.state === "up", answers: (node.summary?.ledger ?? 0) >= 1 })),
        ask: (nodeId, known) => nodes.usagePull(nodeId, known),
        log: (line) => console.log(line),
      })
    : null);
  usageNodes?.start();
  provide("watches", new NodeWatches({
    member: (nodeId) => {
      const entry = nodes.member(nodeId);
      return entry && nodeId !== nodes.selfId() ? { name: entry.name, address: entry.address, port: entry.port } : null;
    },
    summary: (nodeId) => nodes.summaryOf(nodeId),
    handshake: (ws, expect, up, refused) => nodes.watchHandshake(ws, expect, up, refused),
    clients: () => clients,
    send,
    changed: () => pushSnapshot(),
    log: (line) => console.log(`kururu: ${line}`),
    record: (line) => record("watch", line),
    relayed: (node, snapshot) => nodeNotices.snapshot(node, snapshot),
    across: {
      local: () => {
        const profile = workspaces.active;
        return { ids: profile.workspaces.map((w) => w.id), activeId: profile.activeWorkspaceId, key: `${profile.id}/${profile.activeWorkspaceId}` };
      },
      nodes: () => nodes.statuses(),
      switchLocal: (workspaceId) => workspaces.switchWorkspace(workspaceId),
    },
  }));
  provide("nodeNotices", new NodeNotices({
    clients: () => clients,
    send,
    settings: () => notify,
    name: (node) => nodes.member(node)?.name ?? node,
  }));
  // A node whose link came back is worth dialling at once, rather than at
  // the end of a watch's backoff: it is the box's server back after a restart.
  nodes.onLinkUp((peer) => watches.linked(peer));
  provide("peerKurus", new PeerKurus({
    nodes,
    kuruKey,
    items: () => {
      const key = kuruKey();
      return key ? kuru.items(key) : [];
    },
    outbox: {
      fromPeer: (profileKey, id, at, text) => outbox.fromPeer(profileKey, id, at, text),
      peerState: (id, report) => outbox.peerState(id, report),
      all: () => {
        const message = outbox.message();
        return message.type === "outbox" ? message.outbox : [];
      },
    },
    speak: (key, text, utterance) => voice.spoke(key, text, utterance),
    missed: (key) => voice.missedFor(key),
    board: (verb, args, from) => {
      const key = kuruKey();
      const profileId = key ? workspaces.profileIdOf(key) : null;
      return profileId ? harness.peerBoard(profileId, verb, args, from) : Promise.resolve({ text: "This node has no Kuru profile.", isError: true });
    },
    changed: () => kuru.changed(),
    stateDir: dirname(snapshotPath()),
    log: (line) => console.log(`kururu: ${line}`),
  }));
  provide("mover", new Mover({
    workspaces,
    store,
    nodes,
    agents: () => host.agents.map(overlay),
    harnessOf: (profileId) => workspaces.profile(profileId)?.harness?.agentId ?? null,
    dirsOf: workspaceDirs,
    databasesOf: databasesOfWorkspace,
    machineOf: (workspace) => (workspace.machine ? (findMachine(workspace.machine.machineId)?.name ?? null) : null),
    standing: (worktree) => worktreePresent(worktree.path),
    endTerminals: killAll,
    home: homedir(),
    log: (line) => console.log(`kururu: ${line}`),
  }));
  provide("secrets", new Secrets({ nodes, landed: secretLanded, changed: pushSecrets, log: (line) => console.log(`kururu: ${line}`) }));
  const madeLead = provide("lead", new TelegramLead({
    nodes,
    telegram: channels.telegram,
    eligible: leadEligibility,
    // A bot of the child's own, pasted there: not the parent's, so not shared.
    ownBot: () => channels.telegram.hasToken && !secrets.heldFrom("telegram"),
    say: (id, at, text) => {
      const key = kuruKey();
      if (!key) return false;
      outbox.say(key, id, at, text);
      return true;
    },
    changed: () => nodes.queueSummary(),
    switched: syncRosterChannels,
    log: (line) => console.log(`kururu: ${line}`),
    moved: (line) => record("telegram", line),
  }));
  for (const agentId of workspaces.allAgents()) {
    if (!live.has(agentId)) workspaces.removeTab(agentId);
  }
  // And which terminal each profile's harness is in, now that the dead tabs
  // are gone: a harness outlives a server restart, and its record must too.
  harness.adopt(live);
  // Only now may words be handed to Kuru: before `adopt`, a harness that
  // outlived the last server looks like none, and handing over would start a
  // second one.
  outbox.resume();
  // And only then may a channel read what was sent to it: its messages go
  // through the outbox, which is now ready to hand them over. Whether this
  // node polls the shared bot is the lead's to say first, or a node that
  // does not hold the poll would ask Telegram once at start — and that is
  // a 409 for the node that does.
  madeLead.evaluate();
  channels.start();
  void refreshClaudeReady();
  // An agent the host has but no layout mentions would be running with nothing
  // pointing at it — put it somewhere rather than leave it unreachable.
  const placed = new Set(workspaces.allAgents());
  for (const agent of state.agents) {
    if (placed.has(agent.id)) continue;
    // One that ended while nothing was attached is reaped rather than placed:
    // `live` has already dropped its tab, and putting a dead terminal in
    // whatever pane happens to be focused is worse than not showing it at all.
    // Straight to the host, because the layout no longer mentions it and the
    // rest of `reapExited` would be looking for a tab that is not there.
    if (agent.exited) {
      host.kill(agent.id);
      continue;
    }
    workspaces.addTab(agent.id, remoteShellOf(agent.command) ? undefined : agent.cwd);
  }

  workspaces.onChange = () => {
    pushSnapshot();
    queueSave();
  };
  // Written back at once rather than on the next change, because adopting may
  // have minted what was not there — a login key for a profile from before
  // they existed — and a key that lived only in this process would be minted
  // again by the next one, with a fresh directory and nobody signed into it.
  queueSave();
  for (const agent of state.agents) allowRoot(agent.cwd);

  /**
   * A first run — no blob, no file on disk, nothing running — is the one
   * restore-shaped case that opens a terminal. `persist.ts` deliberately brings
   * panes back empty and this does not change that: there is nothing to bring
   * back here. The blank pane in a blank profile is a pane being *made*, and a
   * pane being made gets a terminal like every other one.
   */
  if (!profiles && state.agents.length === 0) fillPane(workspaces.focusedPaneId);

  listenOnce(() => {
    recordStart(PORT, VERSION);
    /**
     * Minted now on a server that will ask for it, rather than when somebody
     * first asks: a child has no Share dialog to ask, and a box whose tools
     * read `access.json` before the first request would find none.
     */
    if (isShared() || loopbackTokenRequired()) token();
    // This machine's MagicDNS name, the one `ts.net` origin the gate lets in;
    // asked now so the phone's first page does not wait on it. See `access.ts`.
    void learnTailnetName();
    const built = existsSync(join(WEB_DIST, "index.html"));
    // The address it can be reached at, which on a child is not localhost.
    const [first] = listenAddresses();
    const at = !first || first === "127.0.0.1" || first === "0.0.0.0" || first === "::" ? "localhost" : first;
    console.log(`kururu server  http://${at}:${PORT}  (v${VERSION})`);
    console.log(`  agents       ${state.agents.length} held by the pty host`);
    console.log(`  web app      ${built ? WEB_DIST : "not built — bun run build"}`);
    // Said every time, because which of the two a server is in is the one thing
    // about it somebody could be wrong about in a way that matters.
    console.log(
      `  reachable    ${isShared() ? `from other machines, with the token from ${loopbackTokenRequired() ? "access.json" : "the Share dialog"}` : "from this machine only"}`,
    );
    console.log(`  listening    ${listenAddresses().join(", ")}${loopbackTokenRequired() ? " · the token wanted on loopback too" : ""}`);
    const bindWhy = bindProblem();
    if (bindWhy) {
      console.error(`kururu: ${bindWhy}`);
      record("start", bindWhy);
    }
  });
}

/** How long a port held by a server on its way out is waited for. */
const PORT_WAIT_MS = 5_000;

/**
 * Listen, and wait out an older server that is leaving.
 *
 * This process links to the pty host before it listens, and the host lets go
 * of the older of two servers when a second one connects. So a server started
 * beside an older one, whether an orphan whose runner died or a second
 * `bun run dev`, already holds the host at this point while the older one
 * still holds the port and is only now being told to leave. Failing on
 * `EADDRINUSE` here used to leave neither running: the older stepped aside a
 * moment after this one had already crashed. So the port is asked for again
 * for a few seconds, which is the Node documentation's own pattern. Anything
 * still holding it after that is not a kururu on its way out, and the crash
 * that follows says which port.
 */
function listenOnce(onListening: () => void): void {
  const deadline = Date.now() + PORT_WAIT_MS;
  const addresses = listenAddresses();
  let left = servers.length;
  servers.forEach((each, i) => {
    const address = addresses[i]!;
    const retry = (err: NodeJS.ErrnoException) => {
      if (err.code !== "EADDRINUSE" || Date.now() > deadline) throw err;
      setTimeout(() => {
        each.close();
        each.listen(PORT, address);
      }, 250);
    };
    each.on("error", retry);
    each.once("listening", () => {
      each.off("error", retry);
      if (--left === 0) onListening();
    });
    each.listen(PORT, address);
  });
}

/**
 * How this process finds the pty host.
 *
 * There used to be two arrangements and only one of them worked the way the
 * split promises. Under Electron the main process forked a host beside us and
 * handed over a `MessagePort`; standalone, with nobody to do that, we built a
 * host *inside this process* — which meant that during development, when the
 * server is restarted on every save, every restart quietly killed every agent.
 * The seam was there and the process boundary was not.
 *
 * So there is one arrangement now: the host listens on a socket and we connect
 * to it. A server that has just been restarted connects again and `hello` hands
 * it back the agents and the arrangement, which is exactly what a re-forked
 * utilityProcess got. Starting the host if it is not there is a convenience for
 * the common case of one machine and one person; it is started **by launchd**,
 * so it is not our child, does not go down with us, and is not in the
 * coalition of the app that started us either — `hostlaunch.ts` has why that
 * last part cost 27 agents in one day. That is the whole point.
 */
const SOCKET = hostSocketPath();
const HOST_LOG = join(dirname(SOCKET), "ptyhost.log");

/**
 * Start a host and wait for it to answer.
 *
 * Its output goes to a file rather than to ours: it outlives this process by
 * design, so inheriting our stdio would leave it writing into a terminal that
 * has moved on, and a daemon nobody can see the logs of is one nobody can debug.
 *
 * Starting one means the last one is gone, and how it went is in the bottom of
 * that same file, so it is read before the new host writes its first line
 * there and the two go into the record together.
 *
 * launchd first, and a detached child of ours only when launchd will not take
 * it. The fallback is the arrangement every host had before, so it works; what
 * it lacks is a coalition of its own, and the record says that in as many
 * words, because a host that a Force Quit can reach is one somebody should know
 * about. On Linux the user manager takes launchd's place, as a transient unit,
 * and what the fallback lacks there is a cgroup of its own: it is in this
 * server's, and stopping the server's unit ends it.
 */
async function startPtyHost(): Promise<string | null> {
  const entry = process.env.KURURU_PTYHOSTD || fileURLToPath(new URL("./ptyhostd.mjs", import.meta.url));
  if (!existsSync(entry)) throw new Error(`no pty host to start at ${entry} — bun run build:server`);

  const before = hostEnding(readTail(HOST_LOG));
  const { how, ...detail } = before ?? { how: null };
  const last = how ? `; the last one ${how}` : "";
  const dir = dirname(SOCKET);
  mkdirSync(dir, { recursive: true });
  const runtime = hostRuntime(process.execPath, entry, dir);
  const env = hostEnv(process.env);

  let refused = "";
  if (process.platform === "darwin") {
    try {
      const { pid, label } = await launchHost(runtime, { dir, log: HOST_LOG, cwd: process.cwd(), env });
      record("host", `started a pty host (pid ${pid ?? "pending"}) through launchd, in a coalition of its own, ${runtime.note}, because none was answering${last}`, detail);
      return label;
    } catch (err) {
      refused = err instanceof Error ? err.message : String(err);
    }
  }
  if (process.platform === "linux") {
    try {
      const { pid, label } = await launchHostSystemd(runtime, { log: HOST_LOG, cwd: process.cwd(), env });
      record("host", `started a pty host (pid ${pid ?? "pending"}) as a transient systemd user unit (${label}), in a cgroup of its own, because none was answering${last}`, detail);
      return label;
    } catch (err) {
      refused = err instanceof Error ? err.message : String(err);
    }
  }

  const log = openSync(HOST_LOG, "a");
  const child = spawn(runtime.exe, [runtime.entry], {
    detached: true,
    stdio: ["ignore", log, log],
    // Harmless under node, and the one thing that makes this work if the binary
    // running us ever turns out to be Electron's.
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
  });
  child.unref();
  closeSync(log);
  const unit = unitOf(process.pid);
  const shared = !refused
    ? ""
    : process.platform === "linux"
      ? ` as a child of this server, because systemd-run refused it (${refused}) — it shares this server's cgroup${unit ? ` (${unit})` : ""}, and stopping or restarting that unit ends every agent`
      : ` as a child of this server, because launchd refused it (${refused}) — it shares the coalition of the app that started this server, and a Force Quit of that app ends every agent`;
  record("host", `started a pty host (pid ${child.pid})${shared}${runtime.note ? `, ${runtime.note}` : ""}, because none was answering${last}`, detail);
  return null;
}

/** How long a host gets to listen before anybody asks why: plenty for one that is only starting. */
const HOST_START_MS = 5_000;
/**
 * How long a host launchd says is still running gets, past that. One blocked
 * on a privacy prompt is waiting for a person, and two minutes is long enough
 * to read one and short enough that a hung host is still noticed.
 */
const HOST_PROMPT_MS = 120_000;

/**
 * The link, however we have to get it.
 *
 * Retried rather than awaited once because a host that has just been spawned is
 * not listening yet, and because two servers started together both find nothing
 * and both spawn one — the loser exits on `EADDRINUSE` and the winner is there a
 * moment later, so patience is also what resolves the race.
 *
 * Past five seconds, a host launchd started is waited for as long as launchd
 * says it is running, up to two minutes, and the console says why. The case is
 * a runtime macOS has not yet let into `~/Desktop`: the host's first `open()`
 * there blocks on the prompt, and a server that gave up at five seconds would
 * exit, leave its runner down, and have a host come up a minute later with
 * nobody to talk to.
 */
async function linkToHost(): Promise<SocketPort> {
  try {
    return await connectToHost(SOCKET);
  } catch {
    // Nothing listening. Ours to start.
  }
  const job = await startPtyHost();
  const started = Date.now();
  let told = false;
  for (let attempt = 0; ; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      return await connectToHost(SOCKET);
    } catch {
      // Still coming up.
    }
    const waited = Date.now() - started;
    if (waited < HOST_START_MS) continue;
    // launchctl once a second, not ten times.
    if (attempt % 10 !== 0) continue;
    if (!job || waited > HOST_PROMPT_MS || !hostJobRunning(job)) break;
    if (!told) {
      told = true;
      console.error(
        process.platform === "darwin"
          ? "kururu: the pty host is running but not listening yet — if macOS is asking whether Kururu may use a folder, it is waiting for that answer"
          : `kururu: the pty host is running but not listening yet — ${HOST_LOG} says what it is doing`,
      );
    }
  }
  throw new Error(`the pty host did not come up at ${SOCKET} — see ${HOST_LOG}`);
}

const link = await linkToHost();

/**
 * The host going away is not survivable, and pretending otherwise is worse than
 * exiting. Every agent was in that process; what is left here is a layout full
 * of tabs pointing at terminals that no longer exist and a UI that would draw
 * them as though they did.
 *
 * Except that a dropped link does not always mean the host went away. The host
 * keeps one server and lets go of the older when a second connects, so a
 * second server started beside this one, by a second `bun run dev` or by a
 * runner that started a replacement before this one had finished stopping,
 * looks exactly the same from here. That one is not a crash and every agent is
 * fine, so it is told apart before anything is written down that says
 * otherwise.
 */
/**
 * Exit so that whatever supervises this process starts a new one.
 *
 * Exiting *is* the restart: only a supervisor can bring a new server up, and
 * `server/run.mjs` reads this exit code specifically, so that an ordinary
 * crash is not mistaken for a request. Unsupervised there is nobody to ask,
 * and exiting would take the server away rather than replace it — so this
 * says so instead of doing half of it. That includes a server whose
 * supervisor was there once and has since died, which is why it asks
 * `supervised()` and not the environment. The reason given is what the
 * record says, and is the caller's: a window's prefix+B, the menu bar.
 *
 * A moment's delay before the shutdown, so an HTTP caller has its answer
 * before the socket it asked on is closed under it.
 */
function requestRestart(why: string): string | null {
  if (!supervised()) return "nothing is supervising this server, so there is nobody to restart it";
  record("stop", why);
  setTimeout(() => void shutdown().then(() => process.exit(RESTART_EXIT_CODE)), 100);
  return null;
}

/** Set once this server has asked the host to stop, so the link dropping is read as the restart it is. */
let hostRestartAsked = false;

/**
 * Restart the pty host, which ends every agent, by asking it to stop and
 * then restarting ourselves.
 *
 * This is the one thing in kururu that reaches for the host on purpose, and
 * it is here rather than in whatever is supervising the server because this
 * is the process that knows how to come back to a host: a server that
 * starts and finds no host starts one. So the host is sent SIGTERM — it
 * reaps its ptys and unlinks its socket on the way out — the link drops, and
 * `link.onClose` below exits with the restart code rather than the crash
 * one. The supervisor, whichever it is, starts a server, and that server
 * starts a host from its own bundle. Which is also what makes this correct
 * under `bun run dev` and under the app alike, and what puts the new host on
 * the current build.
 *
 * The asking — the dialog that names the count — is the caller's. What is
 * refused here is the case where the dance cannot finish: unsupervised, this
 * server would end the host and then itself, and nothing would bring either
 * back.
 */
function requestHostRestart(): string | null {
  if (!supervised()) return "nothing is supervising this server, so nothing would start the new host";
  const pid = socketHolder(SOCKET);
  if (pid === null) return "nothing is holding the pty host's socket";
  const live = host.agents.filter(countsAsAgent).length;
  hostRestartAsked = true;
  record("host", `asked the pty host (pid ${pid}) to stop, ending ${live} agent(s); this server restarts to start a new one`);
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    hostRestartAsked = false;
    return `could not signal the pty host: ${err instanceof Error ? err.message : String(err)}`;
  }
  return null;
}

link.onClose(() => {
  if (stopping) return;
  if (hostRestartAsked) {
    record("stop", "the pty host stopped as asked; this server is restarting to start a new one");
    console.error("kururu: the pty host was stopped on request — restarting to start a new one");
    void shutdown().then(() => process.exit(RESTART_EXIT_CODE));
    return;
  }
  if (socketHeld(SOCKET)) {
    record("stop", "another server connected to the pty host, which lets go of the older of two; this one is stepping aside");
    console.error("kururu: another server has taken over the pty host — this one is stepping aside");
    // Zero, because nothing failed: this server is choosing to stop, and its
    // supervisor should say so rather than report a crash.
    process.exit(0);
  }
  const { how, ...detail } = hostEnding(readTail(HOST_LOG)) ?? { how: null };
  record("crash", `the pty host went away, and every agent with it${how ? `: it ${how}` : ""}`, detail);
  console.error("kururu: the pty host went away — every agent went with it");
  process.exit(1);
});

await attach(link);

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

/**
 * What this process owns, which is deliberately not much any more. The ptys are
 * the host's, and it is told to let go of them by the main process rather than
 * by us — a server being torn down is usually just a server being replaced.
 */
let stopping: Promise<void> | null = null;
export function shutdown(): Promise<void> {
  if (stopping) return stopping;
  stopping = (async () => {
    stopSweeps();
    // The arrangement outlives this process either way; flush it while it is
    // whole, to the host as well, since a restart is what reads that copy.
    if (keepTimer) keepNow();
    if (saveTimer) clearTimeout(saveTimer);
    if (workspaces) writeSnapshot(workspaces.all(), workspaces.active.id);
    closeAllPreviews();
    backup?.close();
    secrets?.close();
    lead?.close();
    watches?.close();
    nodes?.close();
    peerKurus?.close();
    linkWss.close();
    store?.close();
    void closeDatabasePools();
    // The Kokoro process, so it goes now rather than when it notices.
    voice?.close();
    outbox?.close();
    channels?.close();
    for (const ws of clients.keys()) {
      try { ws.terminate(); } catch { /* already gone */ }
    }
    clients.clear();
    wss.close();
    for (const each of servers) {
      each.close();
      each.closeAllConnections();
    }
  })();
  return stopping;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // Who sent it is not knowable from here. The supervisor writes its own
    // line when it is the sender, so a signal with no such line above it came
    // from somewhere else, and that is worth being able to see.
    if (!stopping) record("stop", `stopped by ${signal}`, { signal });
    void shutdown().then(() => process.exit(0));
  });
}
