/**
 * The harness's hands: what kururu's verbs look like from inside an MCP tool
 * call, and the two things the orchestrator cannot do through a verb at all —
 * read a terminal as text, and speak into a running Claude.
 *
 * Why this is a module of its own rather than more cases in `index.ts`'s
 * message handler: that handler answers a *client*, and a client is looking at
 * one profile and one workspace, so every verb in it quietly means "the one on
 * screen". The harness is not looking at anything. It acts on a profile it
 * names, from a pane the user may have left, on workspaces that are not shown.
 * So its calls go through the explicit-target spellings in `workspaces.ts`
 * and the handful of `index.ts` functions handed in as `deps`, and nothing in
 * here consults `active`. The arrangement is still the server's; this is one
 * more thing that sends verbs for it.
 *
 * Reading a terminal is done here and not in `agents/screen.ts`, where the
 * emulator that already has the answer lives, because that file is the pty
 * host's and editing it costs the user every running agent. The host will hand
 * over a serialized screen on request — that is the backlog — and a second
 * headless emulator on this side turns it back into lines. It is the one
 * redundant terminal in kururu, it exists only for the length of a read, and
 * it is the price of never restarting the host for a feature.
 *
 * Speaking into an agent is typing into its pty, as the user, for every agent
 * — see `speak`. It used to be the Claude's inbox socket whenever the hook had
 * reported one, which looked better on paper: a turn rather than keystrokes,
 * queued inside the session, read between tool calls. But Claude Code files
 * everything on that socket as another session's message, and an agent told
 * "this is not your user" did what it should: held instructions for a
 * confirmation that never came, answered "kururu" over SendMessage into
 * whichever session the name matched, and took `/compact` as a sentence. The
 * pty is the user's own keyboard, and kururu holds it. What the socket gave
 * for free is kept by hand: `due` decides when a message may go in, and a
 * prompt on screen or the user's hands in the terminal hold it.
 *
 * The socket is still how the orchestrator hears about the others: every
 * agent's transition to `done` or `blocked` in its profile is posted to the
 * harness's own inbox, so it reacts to the afternoon instead of polling it.
 * Those lines are kururu's and not the user's, and a peer's is what they are.
 * `noticeStatuses` is the one place transitions are observed, and `noticed`
 * is what it calls.
 */
import { randomUUID } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";

import { Terminal } from "@xterm/headless";

import { addCard, boardLanes, cardCode, editCard, mintCardId, moveCard, NEEDS_COLUMN, runLive, type Board, type Card } from "../../shared/board";
import { CHANNEL_NAMES, isChannelKind } from "../../shared/channels";
import {
  HARNESS_NAME,
  HARNESS_SERVER,
  HARNESS_TOOLS,
  MCP_TIMEOUT_MS,
  READ_MAX,
  REPLY_MAX,
  SCREEN_LINES,
  SWAP_QUIET_MS,
  SWAP_TOOLS,
  SwapGate,
  TRANSCRIPT_TURNS,
  WAIT_DEFAULT_S,
  WAIT_MAX_S,
  WHENS,
  agentName,
  harnessRunFlags,
  clip,
  due,
  inboxFrames,
  isCommand,
  keyBytes,
  mcpConfig,
  rolePrompt,
  tellsHarness,
  projectDirName,
  trustAnswer,
  turnsFrom,
  typingPieces,
  type Hands,
  type Held,
  type ModeClass,
  type When,
} from "../../shared/harness";
import { findLauncher, launcherCommand, visibleLaunchers, withPrompt, type AgentCli, type LaunchSettings, type Launcher } from "../../shared/launchers";
import { remoteShellOf, validRemoteDir, type MachineEntry, type MachineStatus } from "../../shared/machines";
import { folderSentence, planText, type MoveDone, type MovePlan } from "../../shared/move";
import { lendableText, type LendAsk, type Lendable } from "../../shared/secrets";
import { BOARD_VERBS, nodesText, summaryAgentName, type BoardVerb, type NodeStatus, type SummaryAgent } from "../../shared/nodes";
import { parseRemote } from "../../shared/remote";
import type { MadeFile } from "../../shared/made";
import type { AgentSnapshot, AgentStatus, HarnessState } from "../../shared/model";
import { isNotifyEvent } from "../../shared/notify";
import { readScreen } from "../../shared/onscreen";
import type { MissedReply } from "../../shared/voice";
import { RELOAD_TIMEOUT_MAX_MS, RELOAD_TIMEOUT_MIN_MS, RELOAD_TIMEOUT_MS, WHY_MAX, oneLine, outcomeText, type ReloadOutcome } from "../../shared/reload";
import { COLUMN_LABELS } from "../../shared/board";
import type { Actor, CardEvent, SearchHit, SearchScope } from "../../shared/store";
import type { McpResult } from "./mcp";
import { harnessHome, prepareHarnessHome } from "./harnesshome";
import type { HostLink } from "./hostlink";
import type { Workspaces } from "./workspaces";
import type { RemoteScreen } from "./nodewatch";

/** A Claude session's inbox, as its hook reported it. The token is what makes a message count as the session's own. */
export interface Inbox {
  socket: string;
  token: string | null;
}

/** What `index.ts` lends this module. Functions rather than the module, because `index.ts` exports nothing and should not start to. */
export interface HarnessDeps {
  workspaces: Workspaces;
  host: HostLink;
  version: string;
  port: () => number;
  /** Whether the harness's pty carries `KURURU_TOKEN`, and so its MCP config must present it. */
  tokenInPtys: () => boolean;
  launch: () => LaunchSettings;
  /** The grid a terminal is drawn at, for rendering its backlog the size it was laid out at. */
  grid: (agentId: string) => { cols: number; rows: number };
  /** What an agent last said it was doing, by the sidebar's reading. */
  activity: ReadonlyMap<string, string>;
  /** Claude Code's config directory for a profile's terminals — where its transcripts are filed. */
  claudeDir: (profileId: string) => string;
  /** A launcher's full command line as a terminal in that profile would get it: flags, hooks and all. */
  agentCommand: (launcher: Launcher, profileId: string) => string;
  /**
   * Open a terminal into a pane of a workspace that need not be on screen. A
   * plain shell in a pinned workspace opens on its machine unless `local`.
   * `apart` is a terminal whose directory is not the workspace's — the
   * harness's own folder — so the pane does not remember it and the file
   * tree is not given it.
   */
  openTerminal: (
    profileId: string,
    workspaceId: string,
    paneId: string,
    options: { cwd?: string; command?: string; kind?: "agent" | "shell"; local?: boolean; apart?: boolean },
  ) => Promise<AgentSnapshot>;
  /** The user's machines, with whether the last look at each got in. See `shared/machines.ts`. */
  machines: () => readonly MachineStatus[];
  /** The other kururus this one is linked with, each with the last summary it pushed. See `shared/nodes.ts`. */
  nodes?: () => readonly NodeStatus[];
  /**
   * Another node's workspace on the user's screen, and its terminals read
   * through the watch — `nodewatch.ts`. Reading only: nothing here acts on
   * another node's agent, which is that node's Kuru's to do.
   */
  remote?: {
    shown: () => { node: string; name: string; workspace: string | null; focused: string | null } | null;
    screen: (node: string, agentId: string) => Promise<RemoteScreen | null>;
  };
  /**
   * The other nodes' Kurus and boards, over the links: `ask_kuru`,
   * `read_kuru` and the board verbs with a `node`. See `peerkuru.ts`.
   * `self` is this node's own name, which a `node` naming it means here.
   */
  peers?: {
    self: () => string;
    ask: (node: string, message: string, wait: boolean, timeoutS: number) => Promise<McpResult>;
    read: (node: string, turns: number) => McpResult;
    board: (node: string, verb: BoardVerb, args: Record<string, unknown>) => Promise<McpResult>;
  };
  /** The command line of a tmux-session shell on a machine, in the first free slot, typing `run` there. */
  shellOn: (machine: MachineEntry, workspaceName: string, dir: string, run?: string) => Promise<string>;
  /** The same for an agent: `command` is the launcher's line, and kururu's install-and-login check goes ahead of it. */
  agentOn: (machine: MachineEntry, workspaceName: string, dir: string, cli: AgentCli, command: string) => Promise<string>;
  /** End a terminal, and the tmux session behind it when it is a shell on a machine. */
  stopTerminal: (agentId: string) => void;
  /** Where a new tab in that pane would start. */
  cwdFor: (profileId: string, workspaceId: string, paneId: string) => Promise<string | undefined>;
  /** Hand a card to an agent, on a board that need not be on screen. */
  runCard: (
    profileId: string,
    workspaceId: string,
    cardId: string,
    launcherId: string,
    fresh: boolean,
  ) => Promise<{ agentId: string; resumed: boolean; why: string | null }>;
  /** A card to Done takes its dev server with it, as the client's move does. */
  stopDev: (workspaceId: string, cardId: string) => void;
  /** Say a line aloud to the user, as this profile's harness. See `voice.ts`. */
  say: (profileId: string, text: string) => void;
  /** Play the profile's missed replies again; what was queued. See `Voice.replay`. */
  replayMissed: (profileId: string) => MissedReply[];
  /** The database: full text over the profile's cards and conversations, and a card's history. See `store.ts`. */
  search: (profileId: string, query: string, scope: SearchScope, limit: number) => SearchHit[];
  cardHistory: (cardId: string) => { card: Card; workspaceName: string | null; deleted: boolean; events: CardEvent[] } | null;
  /** Reload the user's pages on this Mac once each is safe, and say what happened. See `reload.ts`. */
  reloadWindow: (why: string, timeoutMs: number) => Promise<ReloadOutcome>;
  /** The links under an agent's row: what its last turn made. See `shared/made.ts`. */
  madeOf: (agentId: string) => readonly MadeFile[];
  /**
   * `show_file`: a file found from the agent's directory (or the profile's
   * projects, with no agent), put on the agent's row and card, and opened on
   * the user's screen when asked. Says what it did, or throws why not.
   */
  showFile: (profileId: string, agentId: string | null, path: string, line: number | null, open: boolean) => Promise<string>;
  /**
   * `send_telegram_photo`: a picture to the Telegram chat, found as
   * `show_file` finds a file, checked, and sent by the node that reads the
   * chat. Says what happened, or throws why not. See `shared/pictures.ts`.
   */
  sendPicture: (profileId: string, agentId: string | null, path: string, caption: string | null) => Promise<string>;
  /** `move_workspace`: what moving a workspace to a node would do, and doing it. See `move.ts`. */
  movePlan?: (profileId: string, workspaceId: string, nodeId: string, folder: string | null) => Promise<MovePlan>;
  moveWorkspace?: (profileId: string, workspaceId: string, nodeId: string, folder: string) => Promise<{ done: MoveDone; node: string }>;
  /** `lend_secrets`: what a workspace could lend a node, by hint, and lending it. See `secrets.ts`. */
  lendOffer?: (profileId: string, workspaceId: string, nodeId: string, folder: string | null) => Promise<Lendable>;
  lendSecrets?: (profileId: string, workspaceId: string, nodeId: string, folder: string | null, ask: LendAsk) => Promise<{ lent: string[]; to: string | null }>;
}

type WaitState = "done" | "blocked" | "exited";

/**
 * Word of what became of words for an agent, for whoever has to keep them
 * until they arrive — the outbox (`outbox.ts`), which is why the voice's
 * words survive a restart that this module's list of them does not.
 */
export interface HeldEvents {
  /** Written into the terminal, Enter and all. Not yet taken: that is the agent's to say. */
  typed: () => void;
  /** The agent went before they were typed. */
  dropped: () => void;
}

/** A message waiting to be typed, and who to tell when it is. */
interface Waiting extends Held {
  events?: HeldEvents;
}

/** Which agent a wait ended on, named when it ended — an exit is named before its tab is reaped, and not after. */
interface Hit {
  agent: string;
  state: WaitState;
  name: string;
}

interface Waiter {
  agents: Set<string>;
  states: Set<WaitState>;
  resolve: (hit: Hit | null) => void;
}

/** How much of a transcript's tail a read looks at. Turns are small; tool results are not, and the newest are at the end. */
const TRANSCRIPT_TAIL = 512 * 1024;
/** How long typing waits before Enter, so a paste has been taken in by the program before it is submitted. */
const ENTER_DELAY_MS = 350;
/**
 * How long between the pieces of a long line, so each is its own read and
 * none is a paste — see `TYPE_PIECE`. Six pieces must pile up to pass 800, so
 * this is a program that has not read for a third of a second; a line of
 * two thousand characters takes three quarters of one to type.
 */
const TYPE_GAP_MS = 60;
/** How long `open_shell` waits for a new local shell's first prompt before typing anyway. */
const SHELL_DRAWN_MS = 5000;
/** How long a harness just started is watched for the folder-trust dialog, and how often. */
const TRUST_WATCH_MS = 20_000;
const TRUST_POLL_MS = 300;
/** How long after a `send` to watch for the agent to leave `done`, so a wait right after does not catch the stale state. */
const SEND_SETTLE_MS = 2000;
/** The same throttle `notify.ts` applies to a person: one posting per agent per little while. */
const TELL_THROTTLE_MS = 4000;
/** What a posted notification quotes of a reply. The rest is a read away. */
const TELL_QUOTE = 1500;
/** How long words wait for a harness that was just started to report in before they are typed anyway. */
const WAKE_TIMEOUT_MS = 30_000;
/**
 * How long after a starting session's first hook report its prompt box is
 * taken to be listening. The hook runs during start-up, before the TUI has
 * put the terminal in raw mode, and keys that arrive before that are the
 * line discipline's to lose.
 */
const WAKE_SETTLE_MS = 1500;
/** How long a Stop watches Kuru's screen for the turn to end, and how often it looks. */
const STOP_WATCH_MS = 4000;
const STOP_POLL_MS = 250;
/** How long after a Stop another Escape is withheld: Claude Code reads two within about this as a double press. */
const STOP_REPEAT_MS = 1200;

export class Harness {
  private readonly inboxes = new Map<string, Inbox>();
  private readonly transcripts = new Map<string, string>();
  private readonly replies = new Map<string, string>();
  private readonly waiters = new Set<Waiter>();
  private readonly told = new Map<string, { status: string; at: number }>();
  /**
   * Messages waiting to be typed, by agent id, in the order they were sent —
   * see `due` for until when. In memory only: a server restart forgets them,
   * which is the price of holding them here rather than in the session.
   */
  private readonly held = new Map<string, Waiting[]>();
  /** When the user last typed into each terminal, from any client. A message is never typed into the middle of their sentence. */
  private readonly keys = new Map<string, number>();
  /** The one writer per terminal: whatever is typing now, which the next waits behind, so two pastes never interleave. */
  private readonly pumps = new Map<string, Promise<void>>();
  /** A pump put off until the user's hands have left the terminal. */
  private readonly retries = new Map<string, NodeJS.Timeout>();
  /** Harnesses just started and not yet reported in, whose words wait. See `hear`. */
  private readonly starting = new Map<string, NodeJS.Timeout>();
  /** Harnesses an Escape was just sent to by `interrupt`, which does not send another until this lets go. */
  private readonly stopping = new Set<string>();
  /** Auto Swap's clock, and the one timer that asks it again. See `follow`. */
  private readonly swaps = new SwapGate<{ profileId: string; agentId: string }>();
  private swapTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: HarnessDeps) {}

  // ---------------------------------------------------------------------------
  // What the hooks tell us
  // ---------------------------------------------------------------------------

  /** The extras on a `/api/report`: where the transcript is, where the inbox is, what was last said. */
  report(agentId: string, extras: { transcript?: unknown; inbox?: unknown; reply?: unknown }): void {
    if (typeof extras.transcript === "string" && extras.transcript.startsWith("/")) this.transcripts.set(agentId, extras.transcript);
    const inbox = extras.inbox as { socket?: unknown; token?: unknown } | undefined;
    if (inbox && typeof inbox.socket === "string" && inbox.socket.startsWith("/")) {
      this.inboxes.set(agentId, { socket: inbox.socket, token: typeof inbox.token === "string" ? inbox.token : null });
    }
    if (typeof extras.reply === "string" && extras.reply.trim()) this.replies.set(agentId, extras.reply.trim().slice(0, REPLY_MAX));
    const wake = this.starting.get(agentId);
    if (wake) {
      clearTimeout(wake);
      this.starting.delete(agentId);
      setTimeout(() => void this.pump(agentId), WAKE_SETTLE_MS).unref();
    }
  }

  forget(agentId: string): void {
    for (const message of this.held.get(agentId) ?? []) message.events?.dropped();
    this.inboxes.delete(agentId);
    this.transcripts.delete(agentId);
    this.replies.delete(agentId);
    this.told.delete(agentId);
    this.held.delete(agentId);
    this.keys.delete(agentId);
    for (const timers of [this.retries, this.starting]) {
      clearTimeout(timers.get(agentId));
      timers.delete(agentId);
    }
    this.settle(agentId, "exited");
  }

  /**
   * After a server start: which terminal each profile's harness is in.
   *
   * The pty host outlives the server, so a harness started before a restart
   * is still running when the server comes back; what may be gone is the
   * record of which terminal it is — a blob written before the id was kept,
   * or a host that has since restarted and minted new ids. The id on the
   * record is kept when the host still has it. Otherwise the profile's live
   * agents are searched for the one named as the harness is named at start,
   * and the record is set to it, or to nothing. Without this, `isHarness`
   * and `tell` are blind until the harness is reopened, which is the silence
   * that was reported.
   */
  adopt(live: ReadonlySet<string>): void {
    const ws = this.deps.workspaces;
    for (const { id } of ws.summaries(() => 0, (key) => key)) {
      const harness = ws.profile(id)?.harness;
      if (!harness) continue;
      if (harness.agentId && live.has(harness.agentId)) continue;
      const found = ws.agentsIn(id).find((agentId) => live.has(agentId) && this.deps.host.find(agentId)?.titleOverride === HARNESS_NAME) ?? null;
      if (found !== harness.agentId) ws.setHarness(id, { ...harness, agentId: found });
    }
  }

  /** Where an agent's session keeps its transcript, as its hooks last said — for the outbox, which looks there for what it typed. */
  transcriptOf(agentId: string): string | null {
    return this.transcripts.get(agentId) ?? null;
  }

  /** Whether kururu is holding a message to type into this terminal — which keeps a card's agent awake (`sleep.ts`). */
  holding(agentId: string): boolean {
    return (this.held.get(agentId)?.length ?? 0) > 0;
  }

  /** Which profile an agent is the harness of, or null — how `index.ts` knows a Stop report is Kuru's own and worth saying aloud. */
  isHarness(agentId: string): string | null {
    const profileId = this.deps.workspaces.profileOf(agentId);
    const profile = profileId ? this.deps.workspaces.profile(profileId) : null;
    return profile?.harness?.agentId === agentId ? profile.id : null;
  }

  /**
   * Stop Kuru's turn, from the drawer's Stop: the Escape a press in its
   * terminal would have sent, and then the status put right, which the press
   * never does. Claude Code runs no Stop hook for a turn the user interrupted,
   * so the last word its hooks said is `working` and stays that until the next
   * prompt — and a drawer that keeps saying "thinking" after you stopped it
   * says the stop did not work. Nothing else will say otherwise, so the screen
   * is asked: once the footer's "esc to interrupt" and the spinner are gone
   * (`readScreen`), the turn is over and the status is `idle`, the word for a
   * turn nobody needs to be told about — not `done`, which would ring.
   *
   * Only while it is `working`: an Escape at a permission prompt answers it,
   * which is the user's to do in the terminal (the drawer's line for that
   * says so), and one at an idle prompt does nothing worth sending. And once
   * per stop: a second Escape soon after the first is Claude Code's
   * double-press, which opens its rewind menu over the prompt. A screen that
   * still says working when the watch gives up is left saying it, since that
   * is what is true, and Stop can be pressed again.
   */
  async interrupt(profileId: string): Promise<boolean> {
    const agentId = this.deps.workspaces.profile(profileId)?.harness?.agentId;
    const agent = agentId ? this.deps.host.find(agentId) : undefined;
    if (!agentId || !agent || agent.exited || agent.status !== "working" || this.stopping.has(agentId)) return false;
    this.stopping.add(agentId);
    try {
      this.deps.host.write(agentId, "\x1b");
      const until = Date.now() + STOP_WATCH_MS;
      while (Date.now() < until) {
        await sleep(STOP_POLL_MS);
        const now = this.deps.host.find(agentId);
        // A hook got there first — the turn ended on its own, or went on to
        // ask something — and its word is better than the screen's.
        if (!now || now.exited || now.status !== "working") return true;
        const { cols, rows } = this.deps.grid(agentId);
        const screen = await screenText(await this.deps.host.backlog(agentId), cols, rows, rows);
        if (readScreen(screen).phase === "working") continue;
        this.deps.host.report(agentId, { status: "idle" });
        // Anything held for the turn's end is due now, as it would be on a Stop.
        void this.pump(agentId);
        return true;
      }
      return false;
    } finally {
      // Held past the watch for as long as Claude Code counts two presses as
      // one gesture, so a Stop pressed again at once is not the rewind menu.
      setTimeout(() => this.stopping.delete(agentId), STOP_REPEAT_MS).unref();
    }
  }

  // ---------------------------------------------------------------------------
  // What the user says
  // ---------------------------------------------------------------------------

  /**
   * Words for a profile's harness, from the user — the voice's path in, and
   * usable by anything else that has words for Kuru and no pane to type them
   * in. Running, they are typed the way `send_agent` types, with `now`, so a
   * harness mid-turn hears them between tool calls. Not running, it is
   * started and the words wait for its first hook report, the sign its
   * session is up; a harness that never reports — hooks not installed — gets
   * them typed after a while anyway. `events` says when they are typed, or
   * dropped with a harness that went first; the outbox keeps them until then.
   */
  async hear(profileId: string, text: string, events?: HeldEvents): Promise<{ outcome: "typed" | "held" | "starting"; agentId: string }> {
    const ws = this.deps.workspaces;
    const profile = ws.profile(profileId);
    if (!profile) throw new Error("that profile is gone");
    const running = profile.harness?.agentId;
    if (running && this.deps.host.isLive(running) && !this.starting.has(running)) {
      return { outcome: await this.speak(running, text, "now", events), agentId: running };
    }
    const { agentId } = running && this.deps.host.isLive(running) ? { agentId: running } : await this.open(profileId);
    if (!this.starting.has(agentId)) {
      const timer = setTimeout(() => {
        this.starting.delete(agentId);
        void this.pump(agentId);
      }, WAKE_TIMEOUT_MS);
      timer.unref();
      this.starting.set(agentId, timer);
    }
    this.hold(agentId, { text, when: "now", events });
    return { outcome: "starting", agentId };
  }

  /**
   * Words for an agent, as the user's: typed into its terminal with Enter,
   * now or once `due` says they may be. Resolves with which.
   *
   * Typed, because typing is the only door into a Claude that makes the
   * words the user's. The inbox socket was the other, and Claude Code turns
   * every message on it into another session's — introduced as "not typed by
   * your user", with a sender to SendMessage back to, and with slash commands
   * left as text — whatever the frame says. Typing has hazards the socket did
   * not, and the waiting is what answers them: nothing goes into a prompt,
   * nothing goes into the user's half-typed sentence, and a turn is not
   * interrupted unless `now` asked for it. What waiting cannot see is a
   * draft the user left in the prompt box and walked away from: the paste
   * joins it, and the Enter sends both.
   */
  private async speak(agentId: string, text: string, when: When, events?: HeldEvents): Promise<"typed" | "held"> {
    const message: Waiting = { text, when, events };
    this.hold(agentId, message);
    await this.pump(agentId);
    return this.held.get(agentId)?.includes(message) ? "held" : "typed";
  }

  private hold(agentId: string, message: Waiting): void {
    const queue = this.held.get(agentId);
    if (queue) queue.push(message);
    else this.held.set(agentId, [message]);
  }

  /** Type whatever is due, behind whatever is being typed already. Never rejects. */
  private pump(agentId: string): Promise<void> {
    const run = (this.pumps.get(agentId) ?? Promise.resolve()).then(() => this.pumpOnce(agentId)).catch(() => {});
    this.pumps.set(agentId, run);
    void run.then(() => {
      if (this.pumps.get(agentId) === run) this.pumps.delete(agentId);
    });
    return run;
  }

  private async pumpOnce(agentId: string): Promise<void> {
    const queue = this.held.get(agentId);
    if (!queue?.length || this.starting.has(agentId)) return;
    const agent = this.deps.host.find(agentId);
    if (!agent || agent.exited) return;
    const hands = (this.keys.get(agentId) ?? 0) + SWAP_QUIET_MS - Date.now();
    if (hands > 0) {
      clearTimeout(this.retries.get(agentId));
      const timer = setTimeout(() => {
        this.retries.delete(agentId);
        void this.pump(agentId);
      }, hands);
      timer.unref();
      this.retries.set(agentId, timer);
      return;
    }
    const { type, rest } = due(queue, agent.status, tellsHarness(agent));
    if (!type.length) return;
    // The queue is replaced before the first await, so a message sent while
    // these are being typed lands in what is left and waits its own turn.
    if (rest.length) this.held.set(agentId, rest);
    else this.held.delete(agentId);
    for (const [i, text] of type.entries()) {
      if (i) await sleep(ENTER_DELAY_MS);
      for (const [j, piece] of typingPieces(text).entries()) {
        if (j) await sleep(TYPE_GAP_MS);
        this.deps.host.write(agentId, piece);
      }
      await sleep(ENTER_DELAY_MS);
      this.deps.host.write(agentId, "\r");
    }
    for (const message of queue) if (!rest.includes(message)) message.events?.typed();
  }

  /**
   * An agent's status moved. Two things follow: any wait on it is answered,
   * and the harness of its profile is told, if there is one and it is not the
   * agent itself. Only the edges a person would be told about — see
   * `isNotifyEvent` — because a harness interrupted for every `working` would
   * be a harness that never gets a turn of its own; and only an agent's,
   * never a shell's — see `tellsHarness`.
   */
  noticed(agent: AgentSnapshot, status: AgentStatus, exited: boolean): void {
    const tells = tellsHarness(agent);
    if (exited) {
      this.settle(agent.id, "exited");
      if (tells) this.tell(agent, "exited");
      return;
    }
    if (!isNotifyEvent(status)) return;
    // A turn ending is what `next` and `later` were waiting for. Typed
    // before the harness is told, so what it reads back is the new turn.
    if (status === "done") void this.pump(agent.id);
    this.settle(agent.id, status);
    if (tells) this.tell(agent, status);
  }

  private settle(agentId: string, state: WaitState): void {
    for (const waiter of this.waiters) {
      if (!waiter.agents.has(agentId) || !waiter.states.has(state)) continue;
      this.waiters.delete(waiter);
      waiter.resolve({ agent: agentId, state, name: this.nameOf(agentId) });
    }
  }

  /** Post a transition to the profile's harness, if one is running and can be reached. */
  private tell(agent: AgentSnapshot, status: "done" | "blocked" | "exited"): void {
    const profileId = this.deps.workspaces.profileOf(agent.id);
    const profile = profileId ? this.deps.workspaces.profile(profileId) : null;
    const self = profile?.harness?.agentId;
    if (!profile || !self || self === agent.id || !this.deps.host.isLive(self)) return;
    const inbox = this.inboxes.get(self);
    if (!inbox) return;
    const last = this.told.get(agent.id);
    const now = Date.now();
    if (last && last.status === status && now - last.at < TELL_THROTTLE_MS) return;
    this.told.set(agent.id, { status, at: now });
    const lost = status === "exited" ? (this.held.get(agent.id)?.length ?? 0) : 0;
    const said =
      status === "done"
        ? `finished its turn${this.replies.has(agent.id) ? `. It said:\n${this.replies.get(agent.id)!.slice(0, TELL_QUOTE)}` : "."}${madeLine(this.deps.madeOf(agent.id), "\n\nIts links in kururu:")}`
        : status === "blocked"
          ? `is blocked — it is asking something or waiting on a permission prompt${this.deps.activity.has(agent.id) ? `: ${this.deps.activity.get(agent.id)}` : ""}. Read its screen to see what.${this.held.has(agent.id) ? " What you sent it is waiting until the prompt is answered." : ""}`
          : `exited.${lost ? ` ${lost === 1 ? "A message you sent it was" : `${lost} messages you sent it were`} still waiting and never reached it.` : ""}`;
    void this.post(inbox, `[kururu] ${this.name(agent)} ${said}`, "next").catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Auto Swap
  // ---------------------------------------------------------------------------

  /**
   * The user typed or moved, on any client — `index.ts` asks `handsOf` of
   * every message. Typing names its terminal, and that terminal is not typed
   * into by `speak` until the hands have been still as long as a swap waits.
   */
  hands(hands: Hands, agentId?: string): void {
    const now = Date.now();
    this.swaps.touched(hands, now);
    if (hands === "typing" && agentId) this.keys.set(agentId, now);
  }

  /**
   * The harness acted on an agent: with the profile's Auto Swap on, the
   * screen goes to it once `SwapGate` says it may. With it off this returns
   * at the first line, and nothing about the screen differs from before the
   * switch existed.
   *
   * Off the tool call, here, rather than by asking the harness to call
   * `reveal_agent` alongside everything it does: the server sees every call,
   * and a model remembers an instruction most of the time.
   */
  private follow(profileId: string, agentId: string, selfId: string | null): void {
    if (agentId === selfId || !this.deps.workspaces.profile(profileId)?.autoSwap) return;
    this.swaps.ask({ profileId, agentId }, Date.now());
    this.swapSoon();
  }

  /** Ask the gate, and either swap, or ask it again when it says to. Typing in the meantime only moves the answer later. */
  private swapSoon(): void {
    if (this.swapTimer) clearTimeout(this.swapTimer);
    this.swapTimer = null;
    const now = Date.now();
    const next = this.swaps.next(now);
    if (!next) return;
    if ("wait" in next) {
      this.swapTimer = setTimeout(() => this.swapSoon(), next.wait);
      this.swapTimer.unref();
      return;
    }
    if (this.swapNow(next.show.profileId, next.show.agentId)) this.swaps.moved(now);
  }

  /**
   * The checks a swap needs the layout for, made when it is due rather than
   * when it was asked, since seconds may have passed. Never into another
   * profile: the switch is this profile's, a profile can be another login,
   * and being moved out of the one you are in by a harness you are not
   * looking at is a jump with no visible cause. And not when the agent is
   * already showing in a pane on screen — the harness beside it is the usual
   * case, and moving the focus from one to the other would only move where
   * the next keystroke goes.
   */
  private swapNow(profileId: string, agentId: string): boolean {
    const ws = this.deps.workspaces;
    if (!ws.profile(profileId)?.autoSwap || ws.active.id !== profileId) return false;
    if (!this.deps.host.isLive(agentId) || ws.profileOf(agentId) !== profileId) return false;
    if (ws.visible().includes(agentId)) return false;
    return ws.reveal(agentId);
  }

  // ---------------------------------------------------------------------------
  // The tools
  // ---------------------------------------------------------------------------

  tools() {
    return HARNESS_TOOLS;
  }

  /**
   * One tool call, for the harness of one profile. Every agent named is
   * checked to be in that profile first: a harness is "on top of all spaces"
   * in its profile and of nothing in another, which is what a profile is.
   */
  async call(profileId: string, selfId: string | null, name: string, args: Record<string, unknown>, actor: Actor = "harness"): Promise<McpResult> {
    const ws = this.deps.workspaces;
    const profile = ws.profile(profileId);
    if (!profile) return fail("That profile is gone.");
    // A board verb aimed at another node goes over the link, whole; one
    // naming this node is this node's. A run is never one of them.
    const node = str(args.node);
    if (node && (BOARD_VERBS as readonly string[]).includes(name) && node.toLowerCase() !== this.deps.peers?.self().toLowerCase()) {
      if (!this.deps.peers) return fail("This kururu is not linked with any other node.");
      if (name === "add_card" && args.run === true) {
        return fail(`A run starts an agent, and only ${node}'s Kuru starts the agents there. Add the card without run, then ask_kuru ${node} to run it.`);
      }
      const { node: _node, run: _run, launcher: _launcher, ...rest } = args;
      return this.deps.peers.board(node, name as BoardVerb, rest);
    }
    // Every tool aimed at one agent passes through here or names the agent it
    // made, so this is the one place Auto Swap is told — `SWAP_TOOLS` decides.
    const follow = (agentId: string): void => {
      if (SWAP_TOOLS.has(name)) this.follow(profileId, agentId, selfId);
    };
    const agentArg = (): AgentSnapshot => {
      const id = str(args.agent);
      const there = this.remoteId(args);
      if (there) throw new Error(this.notHere(there.node));
      const agent = id && ws.profileOf(id) === profileId ? this.deps.host.find(id) : undefined;
      if (!agent) throw new Error(`No agent ${id || "(none)"} in this profile. Call kururu_status.`);
      follow(agent.id);
      return agent;
    };
    const workspaceArg = (required: boolean): string | null => {
      const id = str(args.workspace);
      const there = parseRemote(id);
      if (there) throw new Error(this.notHere(there.node));
      if (!id) {
        if (required) throw new Error("A workspace id is needed. Call kururu_status for the list.");
        return null;
      }
      if (!ws.workspaceIn(profileId, id)) throw new Error(`No workspace ${id} in this profile.`);
      return id;
    };

    switch (name) {
      case "kururu_status":
        return ok(this.status(profileId, selfId));

      case "read_agent": {
        if (this.remoteId(args)) return this.readRemote(args);
        const agent = agentArg();
        // An agent on a machine has no reply or transcript here — its hooks do
        // not reach kururu — so its screen is the only answer to give.
        const source = str(args.source) || (remoteShellOf(agent.command)?.agent ? "screen" : "reply");
        if (source === "screen") return ok(await this.screen(agent, int(args.lines) ?? SCREEN_LINES));
        if (source === "transcript") return ok(await this.transcript(agent, int(args.turns) ?? TRANSCRIPT_TURNS));
        const reply = this.replies.get(agent.id);
        if (reply) return ok(clip(reply));
        const doing = this.deps.activity.get(agent.id);
        return ok(
          `${this.name(agent)} has not finished a turn since kururu started watching it${doing ? ` — it was last told: ${doing}` : ""}. Try source=screen${this.transcripts.has(agent.id) ? " or source=transcript" : ""}.`,
        );
      }

      case "send_agent": {
        const agent = agentArg();
        const text = str(args.text);
        if (!text) return fail("Nothing to send.");
        const when = (WHENS as readonly string[]).includes(str(args.when)) ? (str(args.when) as When) : "next";
        const was = agent.status;
        if ((await this.speak(agent.id, text, when)) === "typed") {
          await this.settled(agent.id);
          const midTurn = was === "working" && tellsHarness(agent);
          return ok(`Typed into ${this.name(agent)}'s terminal and pressed Enter${midTurn ? "; it was mid-turn, so it reads this between its tool calls" : ""}. It is now ${this.deps.host.find(agent.id)?.status ?? "gone"}.`);
        }
        const now = this.deps.host.find(agent.id);
        const why =
          (this.keys.get(agent.id) ?? 0) + SWAP_QUIET_MS > Date.now()
            ? "the user is typing in its terminal; it goes in when they stop"
            : now?.status === "blocked"
              ? "it is showing a prompt, and the Enter would answer it; it goes in once its turn ends. The prompt is the user's: read its screen and tell them what it asks"
              : isCommand(text)
                ? "a slash command runs only between turns; it goes in when this turn ends"
                : `it is mid-turn; it goes in when this turn ends${when === "now" ? "" : " (when=now would have put it in between its tool calls)"}`;
        return ok(`Not typed yet into ${this.name(agent)}: ${why}. kururu holds it until then, and a server restart before then loses it.`);
      }

      case "press_keys": {
        const agent = agentArg();
        const keys = Array.isArray(args.keys) ? args.keys.filter((k): k is string => typeof k === "string") : [];
        if (!keys.length) return fail("No keys given.");
        const bytes = keyBytes(keys);
        if ("bad" in bytes) return fail(`Not a key: ${bytes.bad}. Use enter, escape, tab, up, down, left, right, backspace, space, ctrl-c, ctrl-d, or a single character.`);
        this.deps.host.write(agent.id, bytes.data);
        await sleep(ENTER_DELAY_MS);
        return ok(`Pressed ${keys.join(", ")} in ${this.name(agent)}. Read its screen to see what happened.`);
      }

      case "wait_agent": {
        const ids = Array.isArray(args.agents) ? args.agents.filter((a): a is string => typeof a === "string") : [];
        if (!ids.length) return fail("Name at least one agent.");
        for (const id of ids) {
          const there = parseRemote(id);
          if (there) return fail(this.notHere(there.node));
          if (ws.profileOf(id) !== profileId) return fail(`No agent ${id} in this profile.`);
        }
        const wanted = new Set<WaitState>(
          (Array.isArray(args.states) ? args.states : ["done", "blocked", "exited"]).filter(
            (s): s is WaitState => s === "done" || s === "blocked" || s === "exited",
          ),
        );
        if (!wanted.size) return fail("states must name done, blocked or exited.");
        if (args.include_current !== false) {
          for (const id of ids) {
            const agent = this.deps.host.find(id);
            const state: WaitState | null = !agent || agent.exited ? "exited" : agent.status === "done" || agent.status === "blocked" ? agent.status : null;
            if (state && wanted.has(state)) return ok(this.arrived(id, state, this.nameOf(id)));
          }
        }
        const seconds = Math.min(WAIT_MAX_S, Math.max(1, int(args.timeout_s) ?? WAIT_DEFAULT_S));
        const hit = await new Promise<Hit | null>((resolve) => {
          const waiter: Waiter = { agents: new Set(ids), states: wanted, resolve };
          this.waiters.add(waiter);
          setTimeout(() => {
            if (this.waiters.delete(waiter)) resolve(null);
          }, seconds * 1000).unref();
        });
        if (!hit) return ok(`Nothing happened in ${seconds}s. ${ids.map((id) => `${this.nameOf(id)}: ${this.deps.host.find(id)?.status ?? "gone"}`).join("; ")}. Call again to keep waiting.`);
        return ok(this.arrived(hit.agent, hit.state, hit.name));
      }

      case "start_agent": {
        const workspaceId = workspaceArg(true)!;
        const workspace = ws.workspaceIn(profileId, workspaceId)!;
        const prompt = str(args.prompt);
        if (!prompt) return fail("A prompt is needed.");
        const launcher = this.launcher(str(args.launcher));
        // It starts where it always did, and its tab goes to the workspace's
        // agents' pane — decided last, so that a refusal leaves no empty one
        // behind. See `agentPaneIn` and `cwdPaneIn`.
        const fromPane = ws.cwdPaneIn(profileId, workspaceId);
        if (!fromPane) return fail("Nowhere to put a terminal in that workspace.");
        const into = (): string => {
          const pane = ws.agentPaneIn(profileId, workspaceId);
          if (!pane) throw new Error("Nowhere to put a terminal in that workspace.");
          return pane;
        };
        const place = this.place(str(args.machine), workspace, str(args.cwd));
        if ("error" in place) return fail(place.error);
        let agent: AgentSnapshot;
        let where: string;
        if (place.machine) {
          // The launcher's own line, without the hooks a local agent gets:
          // they name files on this Mac. See `remoteAgentRun`.
          const line = withPrompt(launcherCommand(launcher, this.deps.launch()), prompt);
          const command = await this.deps.agentOn(place.machine, workspace.name, place.folder, launcher.cli, line);
          agent = await this.deps.openTerminal(profileId, workspaceId, into(), { command, kind: "agent" });
          where = `on ${place.machine.name}, in ${place.folder}`;
        } else {
          const asked = str(args.cwd);
          if (asked && !asked.startsWith("/")) return fail("On this Mac, cwd must be an absolute path.");
          const cwd = asked || (await this.deps.cwdFor(profileId, workspaceId, fromPane));
          const command = withPrompt(this.deps.agentCommand(launcher, profileId), prompt);
          agent = await this.deps.openTerminal(profileId, workspaceId, into(), { cwd, command, kind: "agent" });
          where = `in ${agent.cwd}`;
        }
        const nameFor = str(args.name);
        if (nameFor) this.deps.host.rename(agent.id, nameFor.slice(0, 80));
        follow(agent.id);
        const started = this.deps.host.find(agent.id) ?? agent;
        const remote = place.machine
          ? ` On a machine kururu reads its status off its screen, as nothing there reports back: done and blocked can come a few seconds late, a prompt it does not recognise is not seen as blocked, and there is no transcript — read it with source=screen. If ${launcher.cli === "claude" ? "Claude Code" : "Codex"} is not installed or not logged in there, the tab says so and it is reported as blocked.`
          : "";
        return ok(`Started ${launcher.label} as ${this.name(started)}, ${where}. It is working on the prompt; wait_agent or a message from kururu will tell you when it finishes.${remote}${nameFor ? "" : " It has no name yet — rename_agent gives it one the user can call it by."}`);
      }

      case "open_shell": {
        const workspaceId = workspaceArg(true)!;
        const workspace = ws.workspaceIn(profileId, workspaceId)!;
        const pane = ws.paneBesideBoardIn(profileId, workspaceId);
        if (!pane) return fail("Nowhere to put a terminal in that workspace.");
        const dir = str(args.dir).trim();
        const place = this.place(str(args.machine), workspace, dir);
        if ("error" in place) return fail(place.error);
        const machine = place.machine;
        const run = str(args.run);
        let agent: AgentSnapshot;
        let where: string;
        if (machine) {
          const folder = place.folder;
          const command = await this.deps.shellOn(machine, workspace.name, folder, run || undefined);
          agent = await this.deps.openTerminal(profileId, workspaceId, pane, { command, kind: "shell" });
          where = `on ${machine.name}, in ${folder} (tmux session ${remoteShellOf(command)?.session ?? "?"})`;
        } else {
          if (dir && !dir.startsWith("/")) return fail("On this Mac, dir must be an absolute path.");
          agent = await this.deps.openTerminal(profileId, workspaceId, pane, { cwd: dir || undefined, kind: "shell", local: true });
          where = `on this Mac, in ${agent.cwd}`;
          if (run) {
            await this.drawn(agent.id);
            await this.speak(agent.id, run, "now");
          }
        }
        const nameFor = str(args.name);
        if (nameFor) this.deps.host.rename(agent.id, nameFor.slice(0, 80));
        follow(agent.id);
        const opened = this.deps.host.find(agent.id) ?? agent;
        const said = run ? ` Ran: ${run.length > 160 ? `${run.slice(0, 159)}…` : run}.` : "";
        return ok(`Opened ${this.name(opened)} ${where}.${said} read_agent source=screen shows what it prints; reveal_agent puts it in front of the user.`);
      }

      case "stop_agent": {
        const agent = agentArg();
        if (agent.id === selfId) return fail("That is you. The user closes the harness from its tab.");
        this.deps.stopTerminal(agent.id);
        return ok(`Ending ${this.name(agent)}. Its terminal closes once the process is gone.`);
      }

      case "reveal_agent": {
        const agent = agentArg();
        if (!ws.reveal(agent.id)) return fail("That agent is in no pane.");
        // On purpose, so Auto Swap neither undoes it with a swap that was
        // waiting nor follows it with another before it has been seen.
        this.swaps.moved(Date.now());
        return ok(`Showing ${this.name(agent)} to the user.`);
      }

      case "show_file": {
        const path = str(args.path);
        if (!path) return fail("A path is needed.");
        const open = args.open === true;
        const agent = str(args.agent) ? agentArg() : null;
        if (!agent && !open) return fail("Name the agent whose row the link goes on, or pass open=true to only open the file.");
        const line = int(args.line);
        return ok(await this.deps.showFile(profileId, agent?.id ?? null, path, line !== undefined && line > 0 ? line : null, open));
      }

      case "send_telegram_photo": {
        const path = str(args.path);
        if (!path) return fail("A path is needed.");
        const agent = str(args.agent) ? agentArg() : null;
        return ok(await this.deps.sendPicture(profileId, agent?.id ?? null, path, str(args.caption) || null));
      }

      case "rename_agent": {
        const agent = agentArg();
        const to = str(args.name);
        if (!to) return fail("A name is needed.");
        const was = this.name(agent);
        this.deps.host.rename(agent.id, to.slice(0, 80));
        return ok(`Renamed ${was} to "${to.slice(0, 80)}".`);
      }

      case "cards": {
        const workspaceId = workspaceArg(false);
        if (!workspaceId) return ok(this.boardText(profile.board, "the profile's board", null));
        const workspace = ws.workspaceIn(profileId, workspaceId)!;
        return ok(workspace.board ? this.boardText(workspace.board, `${workspace.name}'s board`, workspace.name) : `${workspace.name} has no board yet — add_card makes one.`);
      }

      case "add_card": {
        const title = str(args.title);
        if (!title) return fail("A title is needed.");
        const workspaceId = workspaceArg(false);
        const id = mintCardId();
        const fields = { title, body: str(args.body), column: str(args.column) || undefined, isolate: typeof args.isolate === "boolean" ? args.isolate : undefined };
        if (!workspaceId) {
          ws.as(actor, () => ws.editProfileBoard(profileId, (board) => addCard(board, fields, id, Date.now())));
          const board = ws.profile(profileId)?.board;
          const lane = board && boardLanes(board).find((l) => l.id === board.cards.find((c) => c.id === id)?.column);
          if (!lane) return fail("The card was refused — an empty title.");
          // The column said back, since one that is not one lands in the first.
          return ok(`Added card ${id} "${title}" to the profile's board, in ${lane.name}${lane.id === NEEDS_COLUMN ? ", where the user sees it in their Needs drawer" : ""}.`);
        }
        ws.as(actor, () => {
          ws.ensureBoardIn(profileId, workspaceId);
          ws.editBoardIn(profileId, workspaceId, (board) => addCard(board, fields, id, Date.now()));
        });
        if (!ws.findCardIn(profileId, workspaceId, id)) return fail("The card was refused — an empty title, or a column that is not one.");
        if (args.run === true) {
          const launcher = this.launcher(str(args.launcher));
          const { agentId } = await this.deps.runCard(profileId, workspaceId, id, launcher.id, false);
          follow(agentId);
          return ok(`Added card ${id} "${title}" and handed it to ${launcher.label}: ${this.nameOf(agentId)}.`);
        }
        return ok(`Added card ${id} "${title}".`);
      }

      case "edit_card": {
        const cardId = str(args.card);
        if (!cardId) return fail("A card id is needed.");
        const fields = { title: args.title === undefined ? undefined : str(args.title), body: args.body === undefined ? undefined : str(args.body) };
        const workspaceId = workspaceArg(false);
        ws.as(actor, () => {
          if (workspaceId) ws.editBoardIn(profileId, workspaceId, (board) => editCard(board, cardId, fields));
          else ws.editProfileBoard(profileId, (board) => editCard(board, cardId, fields));
        });
        return ok(`Edited card ${cardId}.`);
      }

      case "move_card": {
        const cardId = str(args.card);
        const column = str(args.column);
        if (!cardId || !column) return fail("A card id and a column are needed.");
        const workspaceId = workspaceArg(false);
        if (workspaceId) {
          ws.as(actor, () => ws.editBoardIn(profileId, workspaceId, (board) => moveCard(board, cardId, column)));
          if (column === "done") this.deps.stopDev(workspaceId, cardId);
        } else {
          const board = profile.board;
          if (!board.cards.some((c) => c.id === cardId)) return fail(`No card ${cardId} on the profile's board.`);
          const lane = boardLanes(board).find((l) => l.id === column);
          if (!lane) return fail(`The profile's board has no column ${column}. Its columns: ${boardLanes(board).map((l) => l.id).join(", ")}.`);
          ws.as(actor, () => ws.editProfileBoard(profileId, (b) => moveCard(b, cardId, column)));
          return ok(`Moved card ${cardId} to ${lane.name}${lane.id === NEEDS_COLUMN ? ", where the user sees it in their Needs drawer" : ""}.`);
        }
        return ok(`Moved card ${cardId} to ${column}.`);
      }

      case "run_card": {
        const workspaceId = workspaceArg(true)!;
        const cardId = str(args.card);
        if (!cardId) return fail("A card id is needed.");
        const fresh = args.fresh === true;
        const last = ws.findCardIn(profileId, workspaceId, cardId)?.card.run ?? null;
        /*
         * A card whose agent is still in its terminal — its turn finished and
         * nobody closed it — is talked to, not run again: a second agent there
         * is a new conversation beside the one that has the whole context,
         * which is never what running the card was for.
         */
        if (!fresh && last?.agentId && this.deps.host.isLive(last.agentId)) {
          return fail(`Card ${cardId}'s agent, ${this.nameOf(last.agentId)}, is still open. send_agent gives it more to do; fresh=true starts a second conversation beside it.`);
        }
        // The launcher it last ran on when none is named, so that leaving it
        // out resumes on the model it had rather than on Claude's default.
        const named = str(args.launcher) || (last && findLauncher(last.launcher) ? last.launcher : undefined);
        const launcher = this.launcher(named);
        const { agentId, resumed, why } = await this.deps.runCard(profileId, workspaceId, cardId, launcher.id, fresh);
        follow(agentId);
        const name = this.nameOf(agentId);
        if (resumed) return ok(`Resumed card ${cardId}'s conversation, with its context, on ${launcher.label}: ${name}.`);
        if (!last) return ok(`Handed card ${cardId} to ${launcher.label}: ${name}.`);
        // Said loudly, because a fresh start on a card with work behind it is
        // the thing that rereads the card and redoes what is done.
        const because = fresh ? "as asked" : `because ${why ?? "its last conversation could not be found"}`;
        return ok(
          `Handed card ${cardId} to ${launcher.label}: ${name}, in a NEW conversation, ${because}. Its earlier work is not in this agent's context; it was told the card has run before and to check what is done before starting.`,
        );
      }

      case "send_card_to_workspace": {
        const cardId = str(args.card);
        const workspaceId = workspaceArg(true)!;
        if (!cardId) return fail("A card id is needed.");
        ws.as("harness", () => ws.sendProfileCard(profileId, cardId, workspaceId));
        return ok(`Sent card ${cardId} to the workspace's To do.`);
      }

      case "new_workspace": {
        const nameFor = str(args.name);
        if (!nameFor) return fail("A name is needed.");
        const id = ws.newWorkspaceIn(profileId, nameFor.slice(0, 60));
        return id ? ok(`Made workspace ${id} "${nameFor}".`) : fail("Could not make it.");
      }

      case "move_workspace": {
        const workspaceId = workspaceArg(true)!;
        const nodeName = str(args.node);
        const node = this.deps.nodes?.().find((n) => n.name === nodeName);
        if (!node) return fail(`No node ${nodeName || "(none)"}. kururu_status lists them under nodes.`);
        if (!this.deps.movePlan || !this.deps.moveWorkspace) return fail("This kururu cannot move workspaces.");
        const plan = await this.deps.movePlan(profileId, workspaceId, node.id, str(args.folder) || null);
        if (args.confirm !== true) return ok(planText(plan));
        if (plan.refusal) return fail(plan.refusal);
        if (!plan.check) return fail(`Could not ask ${node.name} about the folder: ${plan.checkError ?? "no answer"}`);
        if (plan.check.problem) return fail(folderSentence(plan.check.problem, node.name, plan.check.shown));
        const moved = await this.deps.moveWorkspace(profileId, workspaceId, node.id, plan.check.folder);
        return ok(
          `Moved ${plan.workspace.name} to ${moved.node}${moved.done.again ? " (it had arrived already)" : ""}: workspace ${moved.done.name} in ${plan.check.shown}, ${moved.done.cards} cards, in ${moved.done.profile}. It is gone from this list, and its board here is in Search → Deleted. ${moved.node}'s own Kuru drives it from now on.`,
        );
      }

      case "lend_secrets": {
        const workspaceId = workspaceArg(true)!;
        const nodeName = str(args.node);
        const node = this.deps.nodes?.().find((n) => n.name === nodeName);
        if (!node) return fail(`No node ${nodeName || "(none)"}. kururu_status lists them under nodes.`);
        if (!this.deps.lendOffer || !this.deps.lendSecrets) return fail("This kururu cannot lend secrets.");
        const folder = str(args.folder) || null;
        const offer = await this.deps.lendOffer(profileId, workspaceId, node.id, folder);
        if (args.confirm !== true) return ok(lendableText(offer));
        const names = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
        const env = names(args.env);
        const ask: LendAsk = {
          env: env.includes("all") ? offer.env.filter((c) => !c.note).map((c) => c.name) : env,
          ssh: names(args.ssh),
          github: str(args.github) || null,
        };
        // Only what the preview offered: a name it did not list is a guess, and a guess is not lent.
        const offered = (list: Lendable["env"], wanted: string[]) => wanted.filter((name) => !list.some((c) => c.name === name && !c.note));
        const unknown = [...offered(offer.env, ask.env), ...offered(offer.ssh, ask.ssh), ...(ask.github ? offered(offer.github, [ask.github]) : [])];
        if (unknown.length) return fail(`Not offered for ${offer.workspace.name}: ${unknown.join(", ")}. Call lend_secrets without confirm to see what is.`);
        if (!ask.env.length && !ask.ssh.length && !ask.github) return fail("Name what to lend: env, ssh or github.");
        const { lent, to } = await this.deps.lendSecrets(profileId, workspaceId, node.id, folder, ask);
        const where = to ? ` Env files go into ${to} there.` : "";
        return ok(`Lent ${node.name} ${lent.join(", ")}: sealed to it and sent now, or when it next links.${where} Settings → Nodes on this Mac shows when it holds each, and takes each back.`);
      }

      case "search": {
        const query = str(args.query);
        if (!query) return fail("Words to look for are needed.");
        const scope = args.scope === "cards" || args.scope === "turns" ? args.scope : "all";
        const hits = this.deps.search(profileId, query, scope, Math.min(50, int(args.limit) ?? 20));
        if (!hits.length) return ok(`Nothing matches "${query}".`);
        return ok(hits.map((hit) => this.hitLine(hit)).join("\n"));
      }

      case "card_history": {
        const cardId = str(args.card);
        if (!cardId) return fail("A card id is needed.");
        const found = this.deps.cardHistory(cardId);
        if (!found) return fail(`No card ${cardId} in the database.`);
        const where = found.workspaceName ? `${found.workspaceName}'s board` : "the profile's board";
        const head = `${found.workspaceName ? cardCode(found.workspaceName, found.card.number) : `#${found.card.number}`} "${found.card.title}" on ${where}, now in ${laneName(found.card.column)}${found.deleted ? " (deleted)" : ""}:`;
        const lines = found.events.map((event) => `- ${stamp(event.at)} ${eventLine(event)}`);
        return ok([head, ...lines].join("\n"));
      }

      case "ask_kuru": {
        if (!this.deps.peers) return fail("This kururu is not linked with any other node.");
        const to = str(args.node);
        const message = str(args.message);
        if (!to || !message) return fail("A node and a message are needed.");
        if (to.toLowerCase() === this.deps.peers.self().toLowerCase()) return fail("That is this node, and you are its Kuru.");
        const seconds = Math.min(WAIT_MAX_S, Math.max(1, int(args.timeout_s) ?? WAIT_DEFAULT_S));
        return this.deps.peers.ask(to, message, args.wait === true, seconds);
      }

      case "read_kuru": {
        if (!this.deps.peers) return fail("This kururu is not linked with any other node.");
        const to = str(args.node);
        if (!to) return fail("A node is needed.");
        return this.deps.peers.read(to, Math.max(1, Math.min(40, int(args.turns) ?? TRANSCRIPT_TURNS)));
      }

      case "say": {
        const text = str(args.text);
        if (!text) return fail("Nothing to say.");
        this.deps.say(profileId, text.slice(0, 300));
        return ok("Said.");
      }

      case "play_missed": {
        // The words go back to the model as well as out of the speaker, so it
        // knows what was just played and does not say it a third time.
        const queued = this.deps.replayMissed(profileId);
        if (!queued.length) return ok("Nothing was missed: every reply you gave was heard to the end, or is playing now.");
        const lines = queued.map((entry) => `- ${new Date(entry.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}: ${entry.text}`);
        return ok(`Playing ${queued.length} missed ${queued.length === 1 ? "reply" : "replies"}, oldest first:\n${lines.join("\n")}`);
      }

      case "reload_window": {
        // Waits for the answer, as `wait_agent` does: the harness is the one
        // that tells the agent which asked whether its change is on screen.
        const why = oneLine(str(args.why), WHY_MAX);
        if (!why) return fail("Say why: the window shows it in the notice after the reload.");
        const seconds = int(args.seconds);
        const timeoutMs = seconds === undefined ? RELOAD_TIMEOUT_MS : Math.max(RELOAD_TIMEOUT_MIN_MS, Math.min(RELOAD_TIMEOUT_MAX_MS, seconds * 1000));
        return ok(outcomeText(await this.deps.reloadWindow(why, timeoutMs)));
      }

      default:
        return fail(`No such tool: ${name}`);
    }
  }

  /**
   * A board verb another node's Kuru asked for, over the link, on this
   * profile's boards: the same verb its own tool call would be, with the
   * workspace named by its name (ids are each node's own and change), never
   * a run, and every change recorded as `peer:<node>` in the card's history.
   */
  peerBoard(profileId: string, verb: BoardVerb, args: Record<string, unknown>, from: string): Promise<McpResult> {
    const profile = this.deps.workspaces.profile(profileId);
    if (!profile) return Promise.resolve(fail("This node's Kuru profile is gone."));
    const wanted = str(args.workspace).toLowerCase();
    const workspace = wanted ? profile.workspaces.find((w) => w.name.toLowerCase() === wanted || w.key === wanted || w.id === wanted) : undefined;
    if (wanted && !workspace) return Promise.resolve(fail(`No workspace "${str(args.workspace)}" on this node. kururu_status lists them under nodes.`));
    const { node: _node, run: _run, launcher: _launcher, workspace: _workspace, ...rest } = args;
    return this.call(profileId, null, verb, workspace ? { ...rest, workspace: workspace.id } : rest, `peer:${from}`);
  }

  // ---------------------------------------------------------------------------
  // Starting the harness itself
  // ---------------------------------------------------------------------------

  /**
   * Bring a profile's harness to the screen: running, it is revealed; gone, it
   * is resumed into its last conversation; never started, it is started.
   *
   * Resumed rather than restarted because the conversation is the point: what
   * it told the user yesterday and what it decided about each card is in
   * there, and a pane closing is not a reason to lose it. `--resume` needs the
   * transcript to be where Claude Code filed it, which is under the config
   * directory, by the directory it ran in — so the harness is always started
   * in the same place, its own folder (`harnesshome.ts`), and a transcript
   * that is not there means a fresh start rather than a tab that opens and
   * closes with an error nobody saw. A session that ran in a project's
   * folder, as every harness did before the folder existed, is one of those.
   *
   * The tab still goes into the active workspace, beside the board; only the
   * directory is its own. And always the plain Claude launcher, with the
   * model, effort and compaction named after it (`harnessRunFlags`), so no
   * launcher's `--model` and no profile's settings decide them.
   */
  async open(profileId: string, options: { fresh?: boolean } = {}): Promise<{ agentId: string }> {
    const ws = this.deps.workspaces;
    const profile = ws.profile(profileId);
    if (!profile) throw new Error("no such profile");
    const running = profile.harness?.agentId;
    if (running && this.deps.host.isLive(running)) {
      ws.reveal(running);
      return { agentId: running };
    }
    const launcher = this.launcher("claude");
    const key = ws.keyOf(profileId);
    if (!key) throw new Error("that profile has no key yet");
    const workspaceId = profile.activeWorkspaceId;
    const pane = ws.paneBesideBoardIn(profileId, workspaceId);
    if (!pane) throw new Error("nowhere to put the harness");
    const cwd = harnessHome(key);
    await prepareHarnessHome(cwd, this.deps.claudeDir(profileId), profile.harness?.sessionId ?? null);

    let sessionId = profile.harness?.sessionId ?? null;
    const resume = !options.fresh && sessionId !== null && (await this.transcriptExists(profileId, cwd, sessionId));
    if (!resume) sessionId = randomUUID();

    const role = rolePrompt({
      profile: profile.name,
      workspaces: profile.workspaces.map((w) => ({ id: w.id, name: w.name })),
      launchers: visibleLaunchers(this.deps.launch()).map((l) => ({ id: l.id, label: l.label })),
    });
    const flags = [
      "--name",
      HARNESS_NAME,
      resume ? "--resume" : "--session-id",
      sessionId!,
      "--mcp-config",
      quote(mcpConfig(this.deps.port(), profileId, sessionId!, this.deps.tokenInPtys())),
      "--allowedTools",
      `mcp__${HARNESS_SERVER}`,
      "--append-system-prompt",
      quote(role),
      ...harnessRunFlags(),
    ];
    // The tool-call ceiling, as an environment variable on the line rather than
    // in the pty's env, which only a current host applies: `sh -c` takes it
    // either way, and a wait that was cut off at the default would be a wait
    // that lied.
    const command = `MCP_TOOL_TIMEOUT=${MCP_TIMEOUT_MS} ${this.deps.agentCommand(launcher, profileId)} ${flags.join(" ")}`;
    const agent = await this.deps.openTerminal(profileId, workspaceId, pane, { cwd, command, kind: "agent", apart: true });
    this.deps.host.rename(agent.id, HARNESS_NAME);
    ws.setHarness(profileId, { sessionId: sessionId!, launcher: launcher.id, agentId: agent.id, startedAt: Date.now() });
    ws.reveal(agent.id);
    void this.trustHome(agent.id);
    return { agentId: agent.id };
  }

  /**
   * Say yes to Claude Code's "do you trust this folder?" for the harness's
   * own folder, which it asks the first time a profile's harness starts
   * there. The folder is one kururu made and put nothing in but two files,
   * and a harness stopped on a dialog is a voice message that waits thirty
   * seconds and is then typed into the dialog. Watched for a while after the
   * start and then left: a dialog still up after that is on screen for the
   * user, as it would have been anyway.
   */
  private async trustHome(agentId: string): Promise<void> {
    const until = Date.now() + TRUST_WATCH_MS;
    let downs = 0;
    while (Date.now() < until) {
      await sleep(TRUST_POLL_MS);
      const agent = this.deps.host.find(agentId);
      if (!agent || agent.exited) return;
      const { cols, rows } = this.deps.grid(agentId);
      const answer = trustAnswer(await screenText(await this.deps.host.backlog(agentId), Math.max(cols, 120), rows, rows));
      if (answer === "enter") {
        this.deps.host.write(agentId, "\r");
        return;
      }
      // One Down, then wait to see it land: two could carry the pointer past the yes.
      if (answer === "down" && downs++ === 0) this.deps.host.write(agentId, "\x1b[B");
    }
  }

  /** Which harness, if any, a session id names — the MCP endpoint's way of knowing who is calling. */
  selfFor(profileId: string, sessionId: string): string | null {
    const harness = this.deps.workspaces.profile(profileId)?.harness;
    return harness && harness.sessionId === sessionId ? harness.agentId : null;
  }

  private async transcriptExists(profileId: string, cwd: string, sessionId: string): Promise<boolean> {
    try {
      await stat(join(this.deps.claudeDir(profileId), "projects", projectDirName(cwd), `${sessionId}.jsonl`));
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------

  /**
   * Wait, a few seconds at most, for a shell that was just opened to draw
   * something — its prompt, as a rule. Keys typed into a login shell still
   * reading its rc files are the tty's to keep and are usually kept, but not
   * by everything an rc file runs first, and a command that vanished would
   * be reported as run. On a machine none of this is needed: the line is
   * handed to tmux there, which types it once the session exists.
   */
  private async drawn(agentId: string): Promise<void> {
    const until = Date.now() + SHELL_DRAWN_MS;
    while (Date.now() < until) {
      const agent = this.deps.host.find(agentId);
      if (!agent || agent.exited) return;
      const { cols, rows } = this.deps.grid(agentId);
      if ((await screenText(await this.deps.host.backlog(agentId), cols, rows, rows)).trim()) return;
      await sleep(200);
    }
  }

  private async screen(agent: AgentSnapshot, lines: number): Promise<string> {
    const data = await this.deps.host.backlog(agent.id);
    const { cols, rows } = this.deps.grid(agent.id);
    /*
     * Wider than the grid, never narrower. A serialized screen carries a break
     * at the end of every row that ended, and only a row that *wrapped* relies
     * on the width to wrap again — so a wide emulator joins a wrapped line
     * back into one, which is what a reader wants, while a narrow one breaks
     * every full-width rule in two. The grid the server remembers is also the
     * fallback for a while after a restart, until a client has proposed one.
     */
    const text = await screenText(data, Math.max(cols, 240), rows, Math.max(1, Math.min(400, lines)));
    return clip(text || `${this.name(agent)}'s screen is blank.`);
  }

  /** Another node's agent, by its qualified id: the node's and the node's own id, or null for one of this node's. */
  private remoteId(args: Record<string, unknown>): { node: string; id: string } | null {
    return parseRemote(str(args.agent));
  }

  /** What a tool that acts says to another node's agent or workspace: whose it is, and the road that does reach it. */
  private notHere(nodeId: string): string {
    const name = this.deps.nodes?.().find((n) => n.id === nodeId)?.name ?? "another node";
    return `That is on ${name}, and only ${name}'s Kuru acts on its agents and workspaces — ask_kuru ${name} to do it. read_agent reads one of its agents' screens from here.`;
  }

  /**
   * `read_agent` for another node's agent: its screen, off a backlog the
   * child serializes for this server through the watch (`nodewatch.ts`),
   * and marked as read through the link. Its reply and transcript are on
   * the child's disk and in its Kuru's hearing, so only the screen is read.
   */
  private async readRemote(args: Record<string, unknown>): Promise<McpResult> {
    const there = this.remoteId(args)!;
    const node = this.deps.nodes?.().find((n) => n.id === there.node);
    if (!node) return fail(`No node for ${str(args.agent)}. kururu_status lists the nodes and their agents.`);
    const source = str(args.source);
    if (source && source !== "screen") {
      return fail(`Only the screen of an agent on ${node.name} can be read from here; its replies and transcript are ${node.name}'s. read_kuru ${node.name} reads what its Kuru said, and ask_kuru ${node.name} asks it.`);
    }
    if (node.state !== "up") return fail(`${node.name} is away, so its screens cannot be read; kururu_status shows the last it said.`);
    if (!node.summary?.watchable || !this.deps.remote) {
      return fail(
        node.parent
          ? `${node.name} is the parent, and nothing reads the parent's terminals from another node. ask_kuru ${node.name} instead.`
          : `${node.name}'s kururu is too old to be read from here (kururu child update there). ask_kuru ${node.name} instead.`,
      );
    }
    let found: { agent: SummaryAgent; workspace: string } | null = null;
    for (const w of node.summary.workspaces) {
      const agent = w.agents.find((a) => a.id === there.id);
      if (agent) found = { agent, workspace: w.name };
    }
    if (!found) return fail(`No agent ${there.id} on ${node.name} now. kururu_status lists its agents.`);
    const name = summaryAgentName(found.agent, found.workspace, node, true);
    const screen = await this.deps.remote.screen(node.id, there.id);
    if (!screen) return fail(`${name}'s screen did not come back from ${node.name}; the link to it may have dropped. Try again, or ask_kuru ${node.name}.`);
    const lines = Math.max(1, Math.min(400, int(args.lines) ?? SCREEN_LINES));
    const text = await screenText(screen.data, Math.max(screen.cols, 240), screen.rows, lines);
    return ok(clip(`${name} — on ${node.name}, read through the link (${found.agent.exited ? "exited" : found.agent.status}):\n\n${text || "Its screen is blank."}`));
  }

  private async transcript(agent: AgentSnapshot, turns: number): Promise<string> {
    const path = this.transcripts.get(agent.id);
    if (!path) return `${this.name(agent)} has no transcript kururu knows of — it is not a Claude Code agent with hooks installed. Try source=screen.`;
    let file;
    try {
      const size = (await stat(path)).size;
      file = await open(path, "r");
      const start = Math.max(0, size - TRANSCRIPT_TAIL);
      const buffer = Buffer.alloc(size - start);
      await file.read(buffer, 0, buffer.length, start);
      const found = turnsFrom(buffer.toString("utf8"), Math.max(1, Math.min(50, turns)));
      if (!found.length) return `${this.name(agent)}'s transcript has no turns yet.`;
      return clip(found.map((turn) => `${turn.role === "user" ? "user" : "agent"}: ${turn.text}`).join("\n\n"));
    } catch (err) {
      return `Could not read ${this.name(agent)}'s transcript: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      await file?.close().catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // Speaking
  // ---------------------------------------------------------------------------

  /** A notice into the harness's inbox: one connection, the frames, and gone. Rejects when the socket is not there. */
  private post(inbox: Inbox, text: string, when: When): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connect(inbox.socket);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("the inbox did not answer"));
      }, 3000);
      socket.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      socket.once("connect", () => {
        socket.end(inboxFrames(text, inbox.token, when, this.modeClass()), () => {
          clearTimeout(timer);
          resolve();
        });
      });
    });
  }

  /**
   * The permission class of the Claude sessions kururu starts, which is what
   * it declares on every notice it posts to one — see `envelope`. Decided by
   * the same setting that decides the flag at launch, so the two cannot
   * disagree for a session kururu started; one started by hand with the
   * other flag will hold the message for the user, which is the receiver's
   * rule and the right one.
   */
  private modeClass(): ModeClass {
    return this.deps.launch().bypassClis.includes("claude") ? "bypass" : "prompting";
  }

  /** Give a `done` agent a moment to turn `working` after a send, so the status reported back is the new one. */
  private async settled(agentId: string): Promise<void> {
    const until = Date.now() + SEND_SETTLE_MS;
    while (Date.now() < until) {
      const agent = this.deps.host.find(agentId);
      if (!agent || agent.exited || agent.status === "working") return;
      await sleep(100);
    }
  }

  // ---------------------------------------------------------------------------
  // Words
  // ---------------------------------------------------------------------------

  private status(profileId: string, selfId: string | null): string {
    const ws = this.deps.workspaces;
    const profile = ws.profile(profileId)!;
    const out: string[] = [`profile: ${profile.name} (${profile.id})`, `you: ${selfId ? `id ${selfId}` : "(not started from kururu)"}`];
    const remote = this.onScreenText();
    if (remote) out.push(remote);
    out.push("", "workspaces:");
    for (const workspace of profile.workspaces) {
      const ids = ws.agentsInWorkspace(profileId, workspace.id).filter((id) => this.deps.host.isLive(id));
      const board = workspace.board;
      const counts = board ? ["todo", "doing", "review", "done"].map((c) => `${c} ${board.cards.filter((k) => k.column === c).length}`).join(", ") : "no board";
      const pin = workspace.machine;
      const machine = pin ? this.deps.machines().find((m) => m.id === pin.machineId) : undefined;
      const runsOn = pin && machine ? ` · runs on ${machine.name} in ${pin.dir} (its shells, agents and card runs open there)` : "";
      const shown = workspace.id === profile.activeWorkspaceId ? (remote ? " · on screen when the user comes back from the other node's" : " · on screen") : "";
      out.push(`  - ${workspace.name} (${workspace.id}) · ${ids.length} agent${ids.length === 1 ? "" : "s"} · ${counts}${runsOn}${shown}`);
    }
    // By name, which is what open_shell takes and what the user says.
    const machines = this.deps.machines();
    out.push("", "machines (open_shell and start_agent open on one):");
    if (!machines.length) out.push("  (none — the user adds them in Settings → Machines)");
    for (const m of machines) {
      const state = m.error ? `last look failed: ${m.error}` : m.reading ? "reachable" : "not looked at yet";
      out.push(`  - ${m.name}${m.name === m.host ? "" : ` (ssh ${m.host})`} · ${state}`);
    }
    // Each agent by `name` — what it is, where, and the id last — because
    // this list is where the harness learns what to call them.
    out.push("", "agents (call them by name and workspace, never by id):");
    let any = false;
    for (const workspace of profile.workspaces) {
      for (const id of ws.agentsInWorkspace(profileId, workspace.id)) {
        const agent = this.deps.host.find(id);
        if (!agent) continue;
        any = true;
        const ctx = agent.contextUsage ? ` · context ${Math.round((agent.contextUsage.used / agent.contextUsage.window) * 100)}%` : "";
        const doing = this.deps.activity.get(id);
        const remote = remoteShellOf(agent.command)?.agent ? " · status read off its screen, no transcript" : "";
        out.push(
          `  - ${id === selfId ? "you: " : ""}${this.name(agent)} · ${agent.exited ? "exited" : agent.status}${ctx}${remote}` +
            (doing ? ` · ${remote ? "on screen" : "last told"}: ${doing.slice(0, 120)}` : "") +
            (this.inboxes.has(id) ? "" : agent.agent === "claude" ? " · not heard from its hooks yet" : "") +
            (this.held.has(id) ? ` · ${this.held.get(id)!.length} message${this.held.get(id)!.length === 1 ? "" : "s"} from you waiting to be typed` : "") +
            madeLine(this.deps.madeOf(id)),
        );
      }
    }
    if (!any) out.push("  (none)");
    if (this.deps.nodes) out.push(...nodesText(this.deps.nodes()));
    out.push("", "launchers:");
    for (const launcher of visibleLaunchers(this.deps.launch())) out.push(`  - ${launcher.id}: ${launcher.label}`);
    return out.join("\n");
  }

  /**
   * The line that says another node's workspace is on the user's screen,
   * so that "what is this one doing", said while looking at it, is heard as
   * a question about that node's agent. Null while one of this node's is.
   */
  private onScreenText(): string | null {
    const shown = this.deps.remote?.shown();
    if (!shown) return null;
    const node = this.deps.nodes?.().find((n) => n.id === shown.node);
    const where = `${shown.name}'s workspace ${shown.workspace ? `"${shown.workspace}"` : "(not known yet)"}`;
    let focused = "";
    if (shown.focused && node?.summary) {
      for (const w of node.summary.workspaces) {
        const agent = w.agents.find((a) => a.id === shown.focused);
        if (agent) focused = `; the keyboard is in ${summaryAgentName(agent, w.name, node, true)}`;
      }
    }
    const away = node && node.state !== "up" ? ` ${shown.name} is away, so the screen shows what it last drew.` : "";
    return `on the user's screen: ${where}, on another node${focused}. Its agents are ${shown.name}'s: read_agent reads them, ask_kuru ${shown.name} acts on them.${away}`;
  }

  private boardText(board: Board, title: string, workspaceName: string | null): string {
    const out = [`${title}:`];
    for (const lane of boardLanes(board)) {
      const cards = board.cards.filter((card) => card.column === lane.id);
      out.push(`  ${lane.name} (${lane.id}) — ${cards.length}`);
      for (const card of cards) out.push(`    ${this.cardLine(card, workspaceName)}`);
    }
    return clip(out.join("\n"));
  }

  private cardLine(card: Card, workspaceName: string | null): string {
    const code = workspaceName ? cardCode(workspaceName, card.number) : `#${card.number}`;
    const body = card.body ? ` — ${card.body.replace(/\s+/g, " ").slice(0, 200)}${card.body.length > 200 ? "…" : ""}` : "";
    const run = card.run ? ` [${card.run.label}: ${card.run.state}${runLive(card.run) ? `, agent ${card.run.agentId}` : ""}]` : "";
    const by = card.needsBy ? ` [put here by ${card.needsBy === "kuru" ? "Kuru" : "the user"}]` : "";
    return `${code} ${card.id} "${card.title}"${by}${run}${card.isolate ? " [worktree]" : ""}${madeLine(card.made ?? [])}${body}`;
  }

  private arrived(agentId: string, state: WaitState, name: string): string {
    const reply = this.replies.get(agentId);
    const doing = this.deps.activity.get(agentId);
    if (state === "done") return `${name} finished its turn.${reply ? `\n\nIt said:\n${clip(reply, 6000)}` : ""}`;
    if (state === "blocked") return `${name} is blocked${doing ? `: ${doing}` : ""}. Read its screen to see what it is asking.`;
    return `${name} exited.`;
  }

  /**
   * An agent as the harness reads it: its name, program, workspace and card,
   * and the id last — see `agentName`, and the role's "What you call them".
   *
   * The name is a rename, which a card's run also gets; failing that, the
   * title the program set, which for Claude is its own summary of the task
   * and the nearest thing to a name an unnamed agent has, then what it was
   * last told. Never the id alone, which is the habit this replaced.
   */
  /** One search hit as a line the harness can repeat: what it is, where, when, and the words that matched. */
  private hitLine(hit: SearchHit): string {
    if (hit.kind === "card") {
      const code = hit.workspaceName ? cardCode(hit.workspaceName, hit.number) : `#${hit.number}`;
      const where = hit.workspaceName ? `${hit.workspaceName}, ${laneName(hit.column)}` : `profile board, ${laneName(hit.column)}`;
      const moved = hit.movedAt ? `, moved ${stamp(hit.movedAt)}` : "";
      return `card ${code} "${hit.title}" (${where}${moved}${hit.deleted ? ", deleted" : ""}; id ${hit.id}) — ${hit.snippet}`;
    }
    const who =
      hit.role === "you"
        ? hit.via === "voice"
          ? "you (spoken)"
          : isChannelKind(hit.via)
            ? `you (on ${CHANNEL_NAMES[hit.via]})`
            : "you"
        : hit.role === "kuru"
          ? "you (Kuru)"
          : "an agent";
    return `${who} ${stamp(hit.at)} — ${hit.snippet}`;
  }

  private name(agent: AgentSnapshot): string {
    const ws = this.deps.workspaces;
    const profileId = ws.profileOf(agent.id);
    let workspace: string | null = null;
    let card: { code: string; title: string } | null = null;
    for (const w of (profileId && ws.profile(profileId)?.workspaces) || []) {
      if (!ws.agentsInWorkspace(profileId!, w.id).includes(agent.id)) continue;
      workspace = w.name;
      const running = w.board?.cards.find((k) => k.run?.agentId === agent.id);
      if (running) card = { code: cardCode(w.name, running.number), title: running.title };
      break;
    }
    // A terminal on a machine says which, since "run it there" is what it is for.
    const remote = remoteShellOf(agent.command);
    const host = remote?.host;
    return agentName({
      id: agent.id,
      name: agent.titleOverride || null,
      doing: agent.title || this.deps.activity.get(agent.id) || null,
      program: remote?.agent
        ? `${remote.agent} on ${remote.host}`
        : (agent.agent ?? agent.lastAgent ?? (agent.kind === "shell" ? (host ? `shell on ${host}` : "shell") : "agent")),
      workspace,
      card,
    });
  }

  /** The same by id, for an agent that may have gone. */
  private nameOf(agentId: string): string {
    const agent = this.deps.host.find(agentId);
    return agent ? this.name(agent) : `an agent that has gone (id ${agentId})`;
  }

  /**
   * Where `open_shell` and `start_agent` open: the machine asked for by name,
   * host or id, `local` for this Mac, or — asked nothing — the workspace's
   * pin. On a machine, `dir` is a folder there, defaulting to the pin's when
   * it is the workspace's own machine and home anywhere else, since a folder
   * on one box means nothing on another. Here, `folder` is unused and the
   * caller reads its own directory argument.
   */
  private place(
    asked: string,
    workspace: { machine: { machineId: string; dir: string } | null },
    dir: string,
  ): { machine: MachineStatus; folder: string } | { machine: null } | { error: string } {
    const machines = this.deps.machines();
    const wanted = asked.trim().toLowerCase();
    const here = /^(local|this mac|mac|here|localhost)$/.test(wanted);
    const named = wanted && !here ? machines.find((m) => [m.name, m.host, m.id].some((v) => v.toLowerCase() === wanted)) : undefined;
    if (wanted && !here && !named) return { error: `No machine "${asked}". kururu_status lists them under machines.` };
    const pin = workspace.machine;
    const pinned = pin ? machines.find((m) => m.id === pin.machineId) : undefined;
    const machine = here ? undefined : (named ?? pinned);
    if (!machine) return { machine: null };
    const folder = validRemoteDir(dir || (pin && machine.id === pinned?.id ? pin.dir : "~"));
    if (folder === null) return { error: "A folder on a machine is ~, ~/… or /…, in letters, digits, spaces and . _ - + @ , : = only." };
    return { machine, folder };
  }

  private launcher(id: string | undefined): Launcher {
    const launcher = findLauncher(id || "claude");
    if (!launcher) throw new Error(`No launcher ${id}. kururu_status lists them.`);
    return launcher;
  }
}

/**
 * A serialized screen, back into lines. The emulator is the same one the host
 * uses and is given the same grid, so the lines wrap where the user saw them
 * wrap. Written and then read once the parser has caught up — xterm parses on
 * its own schedule, which is `screen.ts`'s lesson. Trailing blank rows are the
 * unused bottom of the grid and are not news.
 */
export async function screenText(data: string, cols: number, rows: number, lines: number): Promise<string> {
  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 2000 });
  try {
    await new Promise<void>((resolve) => term.write(data, resolve));
    const buffer = term.buffer.active;
    const out: string[] = [];
    for (let y = 0; y < buffer.length; y++) out.push(buffer.getLine(y)?.translateToString(true) ?? "");
    while (out.length && !out[out.length - 1]!.trim()) out.pop();
    return out.slice(-lines).join("\n");
  } finally {
    term.dispose();
  }
}

/** Single-quoted for `sh`, the same spelling `withPrompt` uses. */
function quote(value: string): string {
  return `'${value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replaceAll("'", `'\\''`)}'`;
}

function ok(text: string): McpResult {
  return { text: text.length > READ_MAX ? clip(text) : text };
}

function fail(text: string): McpResult {
  return { text, isError: true };
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function int(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A column by the name a person sees, for the fixed four; a profile board's own columns are named by their id, which is all a tool has. */
function laneName(column: string): string {
  return (COLUMN_LABELS as Record<string, string>)[column] ?? column;
}

function stamp(at: number): string {
  return new Date(at).toISOString().slice(0, 16).replace("T", " ");
}

/** One event of a card's history as a sentence. */
function eventLine(event: CardEvent): string {
  const by =
    event.actor === "user"
      ? "the user"
      : event.actor === "harness"
        ? "you"
        : event.actor === "automation"
          ? "the run automation"
          : event.actor.startsWith("peer:")
            ? `the Kuru on ${event.actor.slice("peer:".length)}`
            : "an import";
  const detail = event.detail ?? {};
  switch (event.kind) {
    case "created":
      return `made by ${by} in ${laneName(event.toColumn ?? "")}`;
    case "imported":
      if (typeof detail.from === "string") return `arrived on ${typeof detail.to === "string" ? detail.to : "this node"} from ${detail.from} with its workspace, in ${laneName(event.toColumn ?? "")}`;
      return `imported from the layout file, in ${laneName(event.toColumn ?? "")}`;
    case "moved":
      if (typeof detail.node === "string") return `went with its workspace to ${detail.node}, moved by ${by}${detail.carried === false ? " (made during the move, so not carried)" : ""}`;
      return `moved by ${by} from ${laneName(event.fromColumn ?? "")} to ${laneName(event.toColumn ?? "")}`;
    case "sent":
      return `sent by ${by} to another board, into ${laneName(event.toColumn ?? "")}`;
    case "edited": {
      const fields = Array.isArray(detail.fields) ? (detail.fields as string[]).join(", ") : "fields";
      const title = detail.title as { from?: string; to?: string } | undefined;
      return `edited by ${by} (${fields})${title ? `: title "${title.from}" → "${title.to}"` : ""}`;
    }
    case "run": {
      const state = typeof detail.state === "string" ? detail.state : "";
      const launcher = typeof detail.launcher === "string" ? ` (${detail.launcher})` : "";
      if (state === "asleep") return `its agent put to sleep after sitting idle${launcher}; running the card resumes it`;
      return state === "started" ? `handed to an agent by ${by}${launcher}` : `run ${state}${launcher}`;
    }
    case "deleted":
      return `deleted by ${by} from ${laneName(event.fromColumn ?? "")}`;
    case "restored":
      return `restored by ${by} into ${laneName(event.toColumn ?? "")}`;
    default:
      return event.kind;
  }
}

export type { HarnessState };

/**
 * An agent's or a card's links, as a line Kuru reads: the paths, and the
 * line a link opens at. Nothing at all when there are none, which is the
 * ordinary case and not worth a word in every status line.
 */
function madeLine(files: readonly MadeFile[], lead = " · links:"): string {
  if (!files.length) return "";
  return `${lead} ${files.map((file) => `${file.path}${file.line ? `:${file.line}` : ""}`).join(", ")}`;
}
