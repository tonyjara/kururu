/**
 * Coming up and going down: the listeners and the WebSocket upgrade, a
 * client admitted, the pty host found or started, `attach()` building every
 * subsystem once the host has answered, a restart asked for, and `shutdown`.
 *
 * It was the bottom of `index.ts`. What stays there is the order these run
 * in — the link to the host awaited at the top level, then `attach` — so the
 * entry point reads as the sequence it is.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { type WebSocket, WebSocketServer } from "ws";
import { cardCode, cardPrompt } from "../../shared/board";
import { remoteShellOf } from "../../shared/machines";
import { countsAsAgent, type Profile } from "../../shared/model";
import { claudeLastReply, parseRolloutListing } from "../../shared/sessions";
import { bindProblem, fromLoopback, isShared, learnTailnetName, listenAddresses, loopbackTokenRequired, token, verdict } from "./access";
import { Backup } from "./backup";
import { stopDev } from "./carddev";
import { cardDoneFor, cardRunPrompt, isDirectory, runCardAt } from "./cards";
import { Channels } from "./channels";
import { codexUsageSnapshot } from "./codexusage";
import { agyUsageSnapshot } from "./agy";
import { configDir, configPath, readConfigFile, readConfigFileRaw, sealConfigSecrets, writeConfigFile } from "./config";
import { keychainSealer, moveConfigSecrets, OWNER_ONLY, sealableFiles, sealsConfig } from "./configkeys";
import { writeAtomic } from "./fsutil";
import {
  activity,
  automations,
  backup,
  broadcast,
  channels,
  clients,
  type ClientState,
  harness,
  host,
  hostInfo,
  kuru,
  kuruKey,
  launch,
  lead,
  madeFiles,
  MAX_ACTIVITY,
  mover,
  nodeNotices,
  nodes,
  notify,
  outbox,
  overlay,
  peerKurus,
  provide,
  pushNodes,
  pushSecrets,
  pushSnapshot,
  reloads,
  screens,
  secrets,
  send,
  sendState,
  sleeper,
  slots,
  vault,
  snapshot,
  snapshots,
  state,
  state as found,
  store,
  syncRosterChannels,
  usageLaunches,
  usageNodes,
  usageReader,
  voice,
  watches,
  windows,
  workspaces,
} from "./context";
import { cardHistoryOf, pinnedFor, sayAside, searchFor } from "./conversation";
import { closeDatabasePools } from "./databases";
import { mirrorFiles } from "./export";
import { allowRoot } from "./files";
import { Harness } from "./harness";
import { hostEnv, hostJobRunning, hostRuntime, launchHost, launchHostSystemd, unitOf } from "./hostlaunch";
import { HOST_PROTOCOL, HOST_SINCE, HostLink, type Port } from "./hostlink";
import { connectToHost, hostSocketPath, type SocketPort } from "./hostsock";
import { text } from "./http/respond";
import { handleRequest } from "./http/router";
import { Kuru } from "./kuru";
import { TelegramLead } from "./lead";
import { claudeDirOf, codexHomeOf, lendOffer, lendSecrets, tokenInPtys } from "./lending";
import { hostEnding, readTail, record, recordStart, socketHolder, supervised } from "./lifecycle";
import { finishScreenSet, startMarkSweep } from "./marks";
import { codexRolloutsOn, findMachine, machinesSnapshot, usageChunkOn, usageFilesOn } from "./machines";
import { kuruFiles, sendPictureFor, showFileFor } from "./madelinks";
import { Mover } from "./move";
import { NodeNotices } from "./nodenotice";
import { NodeHost, nodeRequestRefusal } from "./nodes";
import { NodeWatches } from "./nodewatch";
import { noticeStatuses } from "./notices";
import { OnScreen, screenRows } from "./onscreen";
import { openRouterSnapshot } from "./openrouter";
import { Outbox } from "./outbox";
import { PeerKurus } from "./peerkuru";
import { adoptReaders, readSnapshot, snapshotPath, writeSnapshot } from "./persist";
import { PORT, RESTART_EXIT_CODE, WEB_DIST } from "./preamble";
import { closeAllPreviews } from "./proxy";
import { databasesOfWorkspace, workspaceDirs } from "./repostatus";
import { Secrets } from "./secrets";
import { Sleeper } from "./sleep";
import { Automations } from "./automations";
import { END_AFTER_MS } from "../../shared/automation";
import { notifyGate } from "../../shared/notify";
import { resumeCommand } from "../../shared/launchers";
import { claudeTranscriptPath, readTail as readSessionTail } from "./sessions";
import { Slots, writeSlotCommand } from "./slots";
import { machineStore } from "./keychain";
import { readAsksFile, Vault, writeAsksFile } from "./vaultstore";
import { vaultAskpassPath, writeVaultCommand } from "./vaultbin";
import { usesPath, VaultRuns } from "./vaultrun";
import { specsSnapshot } from "./specs";
import { dataDir, dbPath, Store } from "./store";
import { startSubprojectScan, stopSubprojectScan } from "./subprojects";
import { pollAccountUsage, pollOpenRouterAccount, pollServers, stopSweeps, wakeProcesses, web } from "./sweeps";
import {
  agentCommandFor,
  agentOn,
  commandOn,
  cwdForPaneIn,
  dropClient,
  endRemote,
  endTerminal,
  fillPane,
  harnessFeatures,
  hooksFor,
  keepNow,
  keepTimer,
  killAll,
  kuruCommandFor,
  noteLaunch,
  onOutput,
  openTerminalAt,
  ownedGrid,
  queueKeep,
  queueSave,
  reapExited,
  saveTimer,
  sessionShell,
  workspaceRepo,
  workspaceRoot,
  rootToStore,
} from "./terminals";
import { leadEligibility, nodeAddress, nodeSummary, nodeUnreachable, refreshClaudeReady, secretLanded, STARTED_AT } from "./thisnode";
import { usageSnapshot } from "./usage";
import { Launches } from "./usage/attribute";
import { exportUsage, NodeUsage } from "./usage/remote";
import { openUsageReader } from "./usage/sweep";
import { programs } from "./programs";
import { VERSION } from "./version";
import { Voice } from "./voice";
import { Workspaces } from "./workspaces";
import { mainRoot, worktreePresent } from "./worktree";
import { handleMessage } from "./ws/dispatch";

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
export let remoteClientAt: string | null = null;

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
  send(ws, { type: "tunnels", tunnels: state.tunnels });
  send(ws, { type: "branches", branches: state.branches });
  send(ws, { type: "databases", databases: state.databases });
  send(ws, { type: "usage", usage: usageSnapshot() });
  send(ws, { type: "codex-usage", codex: codexUsageSnapshot() });
  send(ws, { type: "agy-usage", agy: agyUsageSnapshot() });
  send(ws, { type: "machines", machines: machinesSnapshot() });
  send(ws, { type: "specs", specs: specsSnapshot(machinesSnapshot()) });
  send(ws, { type: "nodes", nodes: nodes.view() });
  send(ws, { type: "secrets", secrets: secrets.view() });
  send(ws, { type: "openrouter", openrouter: openRouterSnapshot() });
  send(ws, { type: "slots", slots: slots.view() });
  send(ws, { type: "vault-asks", asks: vault.asks() });
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
 * What a lease taken without `--who` is called: the card the agent was
 * handed, by its code — which is what the queue's lines are read by — or,
 * for an agent no card claims, the name it was given or set itself.
 */
function slotWhoOf(agentId: string): string | null {
  const profileId = workspaces.profileOf(agentId);
  const profile = profileId ? workspaces.profile(profileId) : undefined;
  for (const w of profile?.workspaces ?? []) {
    const card = w.board?.cards.find((k) => k.run?.agentId === agentId);
    if (card) return cardCode(w.name, card.number);
  }
  const agent = host.find(agentId);
  const name = agent?.titleOverride || agent?.title || null;
  return name ? name.replace(/\s+/g, " ").trim().slice(0, 40) : agentId;
}

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
export async function attach(port: Port): Promise<void> {
  // Before any module reads a key: on a Mac, the keys in kururu's config
  // files live in the Keychain from here on, and any still in a file move
  // there now. See `configkeys.ts`; KURURU_KEYCHAIN_CONFIG=0 keeps them in
  // their files, and `vault to-files` puts them back.
  if (sealsConfig()) {
    sealConfigSecrets(keychainSealer(process.env.KURURU_VAULT_KEYCHAIN || undefined));
    moveConfigSecrets({
      files: () => {
        try {
          return sealableFiles(readdirSync(configDir()));
        } catch {
          return [];
        }
      },
      readRaw: readConfigFileRaw,
      read: readConfigFile,
      // Each of these files is a kind or never shared already (`shared/secrets.ts`), and stays owner-only.
      write: (name, value) => writeConfigFile(name, value, OWNER_ONLY),
      restore: (name, raw) => writeAtomic(configPath(name), `${JSON.stringify(raw, null, 2)}\n`, { mode: OWNER_ONLY }),
      log: (line) => console.log(`kururu: ${line}`),
    });
  }
  provide("host", new HostLink(port));
  host.onAgents = () => {
    // Before anybody reads it: the programs an older host cannot name, filled
    // in from this server's own reading of the process table (`programs.ts`).
    host.agents = programs.apply(host.agents);
    // One event, three readers. Notifications want the *transition* and the
    // snapshot carries the state, so this has to run wherever the state is
    // learnt — a second subscription would be a second thing to keep in step
    // with a status that already only changes in one place. The reap is the
    // same argument again, and runs after the notice so that a terminal which
    // said something on its way out has still been heard.
    noticeStatuses();
    // Before the reap, so a shell run that has just exited is still there to read.
    automations?.onAgents();
    reapExited();
    // A lease taken in a terminal that has gone ends now, not at a poll.
    slots?.onAgents();
    pushSnapshot();
  };
  host.onOutput = onOutput;

  const state = await host.hello();
  provide("hostInfo", { version: state.version, current: state.protocol >= HOST_PROTOCOL, env: state.protocol >= HOST_SINCE.env });
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
  let handover: unknown;
  if (state.blob) {
    try {
      const kept = JSON.parse(state.blob) as { profiles: Profile[]; activeProfileId: string; harness?: unknown };
      profiles = adoptReaders(kept.profiles);
      activeProfileId = kept.activeProfileId;
      handover = kept.harness;
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
    token: () => token(),
    launch: () => launch,
    grid: ownedGrid,
    activity,
    claudeDir: claudeDirOf,
    agentCommand: agentCommandFor,
    kuruCommand: kuruCommandFor,
    features: harnessFeatures,
    slots: {
      status: (nameOf) => slots?.statusForKuru(nameOf) ?? null,
      prioritize: (agentId, ms) => slots.prioritize(`agent:${agentId}`, ms),
    },
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
    checkRoot: rootToStore,
    runCard: (profileId, workspaceId, cardId, launcherId, fresh) => runCardAt(profileId, workspaceId, cardId, launcherId, false, "harness", fresh),
    stopDev,
    // Through the variable rather than the instance, because the voice is
    // built on the next line and needs the harness to hand words to. The
    // voice and the outbox name a profile by its key — see `store.ts` —
    // and the harness by its id, so the two are mapped here, at the edge.
    say: (profileId, text) => sayAside(profileId, text),
    replayMissed: (profileId) => voice.replay(workspaces.keyOf(profileId) ?? ""),
    search: searchFor,
    pinned: pinnedFor,
    cardHistory: cardHistoryOf,
    reloadWindow: (why, timeoutMs) => reloads.ask(why, "Kuru", timeoutMs),
    madeOf: (agentId) => madeFiles.of(agentId),
    // The module's `state`, by another name: `attach` has one of its own, the host's hello.
    tunnels: () => ({ tunnels: found.tunnels, devServers: found.devServers }),
    showFile: showFileFor,
    sendPicture: sendPictureFor,
    movePlan: (profileId, workspaceId, nodeId, folder) => mover.plan(profileId, workspaceId, nodeId, folder),
    moveWorkspace: (profileId, workspaceId, nodeId, folder) => mover.move(profileId, workspaceId, nodeId, folder, "harness"),
    lendOffer: (profileId, workspaceId, nodeId, folder) => lendOffer(profileId, workspaceId, nodeId, folder),
    lendSecrets: (profileId, workspaceId, nodeId, folder, ask) => lendSecrets(profileId, workspaceId, nodeId, folder, ask),
    // Through the binding, which is filled in a little further down.
    vault: {
      ask: (req, from) => vault.ask(req, from),
      wait: (id) => vault.wait(id),
      list: () => vault.list(),
    },
    kept: queueKeep,
  }));
  // The reports a remote agent's hooks cannot send, read off its screen.
  provide("screens", new OnScreen({
    host,
    grid: ownedGrid,
    report: (agentId, report) => host.report(agentId, report),
    isHarness: (agentId) => harness.isHarness(agentId) !== null,
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
    cards: () =>
      workspaces.cardRuns().map((at) => {
        const workspace = workspaces.workspaceIn(at.profileId, at.workspaceId);
        const local = !remoteShellOf(host.find(at.card.run.agentId ?? "")?.command)?.agent;
        return { ...at, prompt: workspace ? cardRunPrompt(workspace, at.card, local) : cardPrompt(at.card) };
      }),
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
  provide("slots", new Slots({
    agentAlive: (agentId) => host.isLive(agentId),
    whoOf: slotWhoOf,
    changed: (view) => broadcast({ type: "slots", slots: view }),
    watched: () => windows() > 0,
    store,
  }));
  writeSlotCommand();
  slots.start();
  provide("vault", new Vault({
    // The login Keychain on a Mac; 0600 files on a node with none. See `keychain.ts`.
    store: machineStore("kururu-vault", join(configDir(), "vault")),
    changed: (asks) => broadcast({ type: "vault-asks", asks }),
    // An ask may stay up for hours, across the restarts `bun run dev` makes on every save.
    loadAsks: readAsksFile,
    saveAsks: writeAsksFile,
  }));
  provide("vaultRuns", new VaultRuns({
    item: (name) => vault.item(name),
    valueOf: (name) => vault.valueOf(name),
    used: (names, by) => vault.used(names, by),
    approve: (run, note, signal) => vault.approve(run, note, signal),
    askpassPath: vaultAskpassPath,
    port: PORT,
    logPath: () => usesPath(dataDir()),
  }));
  writeVaultCommand();
  provide("automations", new Automations({
    store,
    // Off in an isolated instance unless asked for: a scratch server on a
    // copy of the real database would otherwise start the owner's agents.
    clock: !process.env.KURURU_DATA_DIR || process.env.KURURU_AUTOMATIONS === "1",
    home: () => nodes?.name() ?? "this Mac",
    find: (agentId) => host.find(agentId),
    profileIdOf: (key) => workspaces.profileIdOf(key),
    workspaceOf: (profileId, key) => {
      const workspace = workspaces.profile(profileId)?.workspaces.find((w) => w.key === key);
      return workspace ? { id: workspace.id, name: workspace.name } : null;
    },
    folderOf: async (profileId, workspaceId) => {
      // The workspace's root when it has one (`Workspace.root`), as it is
      // where everything else in the workspace starts.
      const root = workspaceRoot(profileId, workspaceId);
      if (root) return root;
      // Otherwise the main checkout the walk found, as the row's git verbs use; else
      // the main checkout of wherever the workspace's agents start, as a
      // card's run starts — the repository's top, not a subfolder or a
      // worktree a tab happens to be in. A folder in no repository is itself.
      const repo = profileId === workspaces.active.id ? workspaceRepo(workspaceId) : undefined;
      if (repo && isDirectory(repo)) return repo;
      const pane = workspaces.cwdPaneIn(profileId, workspaceId);
      const cwd = pane ? await cwdForPaneIn(profileId, workspaceId, pane) : undefined;
      return cwd && isDirectory(cwd) ? mainRoot(cwd) : null;
    },
    agentLine: (launcher, profileId, sessionId, ask) =>
      agentCommandFor(launcher, profileId, sessionId, ask ? { ...launch, bypassClis: launch.bypassClis.filter((cli) => cli !== launcher.cli) } : launch),
    open: async (profileId, workspaceId, options) => {
      const target = workspaces.paneForIn(profileId, workspaceId, "lower");
      if (!target) throw new Error("there is nowhere in the workspace to put it");
      return openTerminalAt(profileId, workspaceId, target, options);
    },
    launched: (agent, profileId, workspaceId, note, name) => {
      if (note) noteLaunch(agent.id, profileId, workspaceId, { program: note.program, sessionId: note.sessionId, cwd: agent.cwd });
      host.rename(agent.id, name.slice(0, 80));
    },
    lastReply: async (agentId, profileId, run) => {
      const said = harness.lastReply(agentId);
      if (said) return said;
      // A server restarted since the turn ended has not heard its Stop hook:
      // the transcript says the same thing.
      if (!run.sessionId || !run.launcher?.startsWith("claude")) return null;
      const path = await claudeTranscriptPath(claudeDirOf(profileId), run.sessionId, run.cwd, harness.transcriptOf(agentId));
      const tail = path ? await readSessionTail(path) : null;
      return tail ? claudeLastReply(tail) : null;
    },
    screen: (agentId) => screenRows(host, agentId, { ...ownedGrid(agentId), rows: 200 }),
    whyAwake: (profileId, agentId, run) => sleeper.whyAwake(profileId, agentId, run, END_AFTER_MS),
    end: (agentId) => endTerminal(agentId),
    activity: (agentId) => activity.get(agentId),
    tell: (profileId, line) => harness.announce(profileId, line),
    notify: (title, body, agentId) => {
      const notification = { agentId: agentId ?? "", event: "blocked" as const, title, body };
      for (const [ws, st] of clients) {
        if (st.watcher) continue;
        if (!notifyGate({ event: "blocked", visible: false, isAgent: true, isHarness: false }, notify).pass) continue;
        send(ws, { type: "notify", notification });
      }
    },
    changed: () => pushSnapshot(),
    resume: async (profileId, workspaceId, run, launcher) => {
      const command = resumeCommand(launcher, launch, run.sessionId, false);
      if (!command) throw new Error("That run has no conversation kururu can open.");
      const target = workspaces.paneForIn(profileId, workspaceId, "lower");
      if (!target) throw new Error("there is nowhere in the workspace to put it");
      const cwd = run.cwd && isDirectory(run.cwd) ? run.cwd : undefined;
      const agent = await openTerminalAt(profileId, workspaceId, target, { cwd, command: command + hooksFor(launcher, profileId), kind: "agent" });
      noteLaunch(agent.id, profileId, workspaceId, { program: launcher.cli === "agy" ? "agy" : launcher.cli, sessionId: run.sessionId, cwd: agent.cwd });
      return agent;
    },
    reveal: (agentId) => workspaces.reveal(agentId),
  }));
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
    transcribe: (path, ms, timed) => voice.transcribe(path, ms, timed),
    screenWords: (setId, said) => finishScreenSet(setId, said),
    deliver: (profileKey, text, events, again) => {
      const profileId = workspaces.profileIdOf(profileKey);
      if (!profileId) return Promise.reject(new Error("that profile is gone"));
      return harness.hear(profileId, text, events, again);
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
  // Kuru's inbox and what was waiting to go into it, from the server this one
  // replaced — without which a restart between Kuru's turns is a Kuru told
  // nothing until the user speaks. See `HarnessHandover`.
  harness.takeOver(handover);
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
    // Sets of marks past their thirty days, now and daily (`marks.ts`): after
    // the start's own line, so the log reads in the order it happened.
    startMarkSweep();
    // The clock, once there is a node name to be home to and a port to serve the runs it starts.
    void automations?.start();
    // The projects inside each workspace's root, for Kuru's tags (`subprojects.ts`).
    startSubprojectScan(workspaces);
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
export const SOCKET = hostSocketPath();
export const HOST_LOG = join(dirname(SOCKET), "ptyhost.log");

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
export async function linkToHost(): Promise<SocketPort> {
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
export function requestRestart(why: string): string | null {
  if (!supervised()) return "nothing is supervising this server, so there is nobody to restart it";
  record("stop", why);
  setTimeout(() => void shutdown().then(() => process.exit(RESTART_EXIT_CODE)), 100);
  return null;
}

/** Set once this server has asked the host to stop, so the link dropping is read as the restart it is. */
export let hostRestartAsked = false;

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
export function requestHostRestart(): string | null {
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

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

/**
 * What this process owns, which is deliberately not much any more. The ptys are
 * the host's, and it is told to let go of them by the main process rather than
 * by us — a server being torn down is usually just a server being replaced.
 */
export let stopping: Promise<void> | null = null;
export function shutdown(): Promise<void> {
  if (stopping) return stopping;
  stopping = (async () => {
    stopSweeps();
    stopSubprojectScan();
    slots?.stop();
    // Before the connections are closed below, which would otherwise read
    // as every waiting caller hanging up and cancel their asks.
    vault?.shutdown();
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
