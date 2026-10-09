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
import { homedir } from "node:os";
import { join } from "node:path";

import { Terminal } from "@xterm/headless";

import { addCard, boardLanes, cardCode, editCard, mintCardId, moveCard, runLive, type Board, type Card } from "../../shared/board";
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
  clip,
  due,
  inboxFrames,
  isCommand,
  keyBytes,
  mcpConfig,
  pasteBytes,
  rolePrompt,
  tellsHarness,
  turnsFrom,
  type Hands,
  type Held,
  type ModeClass,
  type When,
} from "../../shared/harness";
import { findLauncher, visibleLaunchers, withPrompt, type LaunchSettings, type Launcher } from "../../shared/launchers";
import type { AgentSnapshot, AgentStatus, HarnessState } from "../../shared/model";
import { isNotifyEvent } from "../../shared/notify";
import type { McpResult } from "./mcp";
import type { HostLink } from "./hostlink";
import type { Workspaces } from "./workspaces";

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
  launch: () => LaunchSettings;
  /** The grid a terminal is drawn at, for rendering its backlog the size it was laid out at. */
  grid: (agentId: string) => { cols: number; rows: number };
  /** What an agent last said it was doing, by the sidebar's reading. */
  activity: ReadonlyMap<string, string>;
  /** Claude Code's config directory for a profile's terminals — where its transcripts are filed. */
  claudeDir: (profileId: string) => string;
  /** A launcher's full command line as a terminal in that profile would get it: flags, hooks and all. */
  agentCommand: (launcher: Launcher, profileId: string) => string;
  /** Open a terminal into a pane of a workspace that need not be on screen. */
  openTerminal: (
    profileId: string,
    workspaceId: string,
    paneId: string,
    options: { cwd?: string; command?: string; kind?: "agent" | "shell" },
  ) => Promise<AgentSnapshot>;
  /** Where a new tab in that pane would start. */
  cwdFor: (profileId: string, workspaceId: string, paneId: string) => Promise<string | undefined>;
  /** Hand a card to an agent, on a board that need not be on screen. */
  runCard: (profileId: string, workspaceId: string, cardId: string, launcherId: string) => Promise<{ agentId: string }>;
  /** A card to Done takes its dev server with it, as the client's move does. */
  stopDev: (workspaceId: string, cardId: string) => void;
  /** Say a line aloud to the user, as this profile's harness. See `voice.ts`. */
  say: (profileId: string, text: string) => void;
}

type WaitState = "done" | "blocked" | "exited";

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
  private readonly held = new Map<string, Held[]>();
  /** When the user last typed into each terminal, from any client. A message is never typed into the middle of their sentence. */
  private readonly keys = new Map<string, number>();
  /** The one writer per terminal: whatever is typing now, which the next waits behind, so two pastes never interleave. */
  private readonly pumps = new Map<string, Promise<void>>();
  /** A pump put off until the user's hands have left the terminal. */
  private readonly retries = new Map<string, NodeJS.Timeout>();
  /** Harnesses just started and not yet reported in, whose words wait. See `hear`. */
  private readonly starting = new Map<string, NodeJS.Timeout>();
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

  /** Which profile an agent is the harness of, or null — how `index.ts` knows a Stop report is Kuru's own and worth saying aloud. */
  isHarness(agentId: string): string | null {
    const profileId = this.deps.workspaces.profileOf(agentId);
    const profile = profileId ? this.deps.workspaces.profile(profileId) : null;
    return profile?.harness?.agentId === agentId ? profile.id : null;
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
   * them typed after a while anyway.
   */
  async hear(profileId: string, text: string): Promise<{ outcome: "typed" | "held" | "starting"; agentId: string }> {
    const ws = this.deps.workspaces;
    const profile = ws.profile(profileId);
    if (!profile) throw new Error("that profile is gone");
    const running = profile.harness?.agentId;
    if (running && this.deps.host.isLive(running) && !this.starting.has(running)) {
      return { outcome: await this.speak(running, text, "now"), agentId: running };
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
    this.hold(agentId, { text, when: "now" });
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
  private async speak(agentId: string, text: string, when: When): Promise<"typed" | "held"> {
    const message = { text, when };
    this.hold(agentId, message);
    await this.pump(agentId);
    return this.held.get(agentId)?.includes(message) ? "held" : "typed";
  }

  private hold(agentId: string, message: Held): void {
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
      this.deps.host.write(agentId, pasteBytes(text));
      await sleep(ENTER_DELAY_MS);
      this.deps.host.write(agentId, "\r");
    }
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
        ? `finished its turn${this.replies.has(agent.id) ? `. It said:\n${this.replies.get(agent.id)!.slice(0, TELL_QUOTE)}` : "."}`
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
  async call(profileId: string, selfId: string | null, name: string, args: Record<string, unknown>): Promise<McpResult> {
    const ws = this.deps.workspaces;
    const profile = ws.profile(profileId);
    if (!profile) return fail("That profile is gone.");
    // Every tool aimed at one agent passes through here or names the agent it
    // made, so this is the one place Auto Swap is told — `SWAP_TOOLS` decides.
    const follow = (agentId: string): void => {
      if (SWAP_TOOLS.has(name)) this.follow(profileId, agentId, selfId);
    };
    const agentArg = (): AgentSnapshot => {
      const id = str(args.agent);
      const agent = id && ws.profileOf(id) === profileId ? this.deps.host.find(id) : undefined;
      if (!agent) throw new Error(`No agent ${id || "(none)"} in this profile. Call kururu_status.`);
      follow(agent.id);
      return agent;
    };
    const workspaceArg = (required: boolean): string | null => {
      const id = str(args.workspace);
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
        const agent = agentArg();
        const source = str(args.source) || "reply";
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
        for (const id of ids) if (ws.profileOf(id) !== profileId) return fail(`No agent ${id} in this profile.`);
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
        const prompt = str(args.prompt);
        if (!prompt) return fail("A prompt is needed.");
        const launcher = this.launcher(str(args.launcher));
        const pane = ws.paneBesideBoardIn(profileId, workspaceId);
        if (!pane) return fail("Nowhere to put a terminal in that workspace.");
        const asked = str(args.cwd);
        if (asked && !asked.startsWith("/")) return fail("cwd must be an absolute path.");
        const cwd = asked || (await this.deps.cwdFor(profileId, workspaceId, pane));
        const command = withPrompt(this.deps.agentCommand(launcher, profileId), prompt);
        const agent = await this.deps.openTerminal(profileId, workspaceId, pane, { cwd, command, kind: "agent" });
        const nameFor = str(args.name);
        if (nameFor) this.deps.host.rename(agent.id, nameFor.slice(0, 80));
        follow(agent.id);
        const started = this.deps.host.find(agent.id) ?? agent;
        return ok(`Started ${launcher.label} as ${this.name(started)}, in ${agent.cwd}. It is working on the prompt; wait_agent or a message from kururu will tell you when it finishes.${nameFor ? "" : " It has no name yet — rename_agent gives it one the user can call it by."}`);
      }

      case "stop_agent": {
        const agent = agentArg();
        if (agent.id === selfId) return fail("That is you. The user closes the harness from its tab.");
        this.deps.host.kill(agent.id);
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
          ws.editProfileBoard(profileId, (board) => addCard(board, fields, id, Date.now()));
          return ok(`Added card ${id} "${title}" to the profile's board.`);
        }
        ws.ensureBoardIn(profileId, workspaceId);
        ws.editBoardIn(profileId, workspaceId, (board) => addCard(board, fields, id, Date.now()));
        if (!ws.findCardIn(profileId, workspaceId, id)) return fail("The card was refused — an empty title, or a column that is not one.");
        if (args.run === true) {
          const launcher = this.launcher(str(args.launcher));
          const { agentId } = await this.deps.runCard(profileId, workspaceId, id, launcher.id);
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
        if (workspaceId) ws.editBoardIn(profileId, workspaceId, (board) => editCard(board, cardId, fields));
        else ws.editProfileBoard(profileId, (board) => editCard(board, cardId, fields));
        return ok(`Edited card ${cardId}.`);
      }

      case "move_card": {
        const cardId = str(args.card);
        const column = str(args.column);
        if (!cardId || !column) return fail("A card id and a column are needed.");
        const workspaceId = workspaceArg(false);
        if (workspaceId) {
          ws.editBoardIn(profileId, workspaceId, (board) => moveCard(board, cardId, column));
          if (column === "done") this.deps.stopDev(workspaceId, cardId);
        } else {
          ws.editProfileBoard(profileId, (board) => moveCard(board, cardId, column));
        }
        return ok(`Moved card ${cardId} to ${column}.`);
      }

      case "run_card": {
        const workspaceId = workspaceArg(true)!;
        const cardId = str(args.card);
        if (!cardId) return fail("A card id is needed.");
        const launcher = this.launcher(str(args.launcher));
        const { agentId } = await this.deps.runCard(profileId, workspaceId, cardId, launcher.id);
        follow(agentId);
        return ok(`Handed card ${cardId} to ${launcher.label}: ${this.nameOf(agentId)}.`);
      }

      case "send_card_to_workspace": {
        const cardId = str(args.card);
        const workspaceId = workspaceArg(true)!;
        if (!cardId) return fail("A card id is needed.");
        ws.sendProfileCard(profileId, cardId, workspaceId);
        return ok(`Sent card ${cardId} to the workspace's To do.`);
      }

      case "new_workspace": {
        const nameFor = str(args.name);
        if (!nameFor) return fail("A name is needed.");
        const id = ws.newWorkspaceIn(profileId, nameFor.slice(0, 60));
        return id ? ok(`Made workspace ${id} "${nameFor}".`) : fail("Could not make it.");
      }

      case "say": {
        const text = str(args.text);
        if (!text) return fail("Nothing to say.");
        this.deps.say(profileId, text.slice(0, 300));
        return ok("Said.");
      }

      default:
        return fail(`No such tool: ${name}`);
    }
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
   * in the same place, the profile's active workspace, and a transcript that is
   * not there any more means a fresh start rather than a tab that opens and
   * closes with an error nobody saw.
   */
  async open(profileId: string, options: { fresh?: boolean; launcher?: string } = {}): Promise<{ agentId: string }> {
    const ws = this.deps.workspaces;
    const profile = ws.profile(profileId);
    if (!profile) throw new Error("no such profile");
    const running = profile.harness?.agentId;
    if (running && this.deps.host.isLive(running)) {
      ws.reveal(running);
      return { agentId: running };
    }
    const launcher = this.launcher(options.launcher ?? profile.harness?.launcher);
    if (launcher.cli !== "claude") throw new Error("the harness is a Claude Code session");
    const workspaceId = profile.activeWorkspaceId;
    const pane = ws.paneBesideBoardIn(profileId, workspaceId);
    if (!pane) throw new Error("nowhere to put the harness");
    const cwd = (await this.deps.cwdFor(profileId, workspaceId, pane)) ?? homedir();

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
      quote(mcpConfig(this.deps.port(), profileId, sessionId!)),
      "--allowedTools",
      `mcp__${HARNESS_SERVER}`,
      "--append-system-prompt",
      quote(role),
    ];
    // The tool-call ceiling, as an environment variable on the line rather than
    // in the pty's env, which only a current host applies: `sh -c` takes it
    // either way, and a wait that was cut off at the default would be a wait
    // that lied.
    const command = `MCP_TOOL_TIMEOUT=${MCP_TIMEOUT_MS} ${this.deps.agentCommand(launcher, profileId)} ${flags.join(" ")}`;
    const agent = await this.deps.openTerminal(profileId, workspaceId, pane, { cwd, command, kind: "agent" });
    this.deps.host.rename(agent.id, HARNESS_NAME);
    ws.setHarness(profileId, { sessionId: sessionId!, launcher: launcher.id, agentId: agent.id, startedAt: Date.now() });
    ws.reveal(agent.id);
    return { agentId: agent.id };
  }

  /** Which harness, if any, a session id names — the MCP endpoint's way of knowing who is calling. */
  selfFor(profileId: string, sessionId: string): string | null {
    const harness = this.deps.workspaces.profile(profileId)?.harness;
    return harness && harness.sessionId === sessionId ? harness.agentId : null;
  }

  private async transcriptExists(profileId: string, cwd: string, sessionId: string): Promise<boolean> {
    // Claude Code files a transcript under the directory it ran in, with every
    // character that is not a letter or digit turned into a dash.
    const dir = cwd.replace(/[^A-Za-z0-9]/g, "-");
    try {
      await stat(join(this.deps.claudeDir(profileId), "projects", dir, `${sessionId}.jsonl`));
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------

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
    const out: string[] = [`profile: ${profile.name} (${profile.id})`, `you: ${selfId ? `id ${selfId}` : "(not started from kururu)"}`, ""];
    out.push("workspaces:");
    for (const workspace of profile.workspaces) {
      const ids = ws.agentsInWorkspace(profileId, workspace.id).filter((id) => this.deps.host.isLive(id));
      const board = workspace.board;
      const counts = board ? ["todo", "doing", "review", "done"].map((c) => `${c} ${board.cards.filter((k) => k.column === c).length}`).join(", ") : "no board";
      out.push(`  - ${workspace.name} (${workspace.id}) · ${ids.length} agent${ids.length === 1 ? "" : "s"} · ${counts}${workspace.id === profile.activeWorkspaceId ? " · on screen" : ""}`);
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
        out.push(
          `  - ${id === selfId ? "you: " : ""}${this.name(agent)} · ${agent.exited ? "exited" : agent.status}${ctx}` +
            (doing ? ` · last told: ${doing.slice(0, 120)}` : "") +
            (this.inboxes.has(id) ? "" : agent.agent === "claude" ? " · not heard from its hooks yet" : "") +
            (this.held.has(id) ? ` · ${this.held.get(id)!.length} message${this.held.get(id)!.length === 1 ? "" : "s"} from you waiting to be typed` : ""),
        );
      }
    }
    if (!any) out.push("  (none)");
    out.push("", "launchers:");
    for (const launcher of visibleLaunchers(this.deps.launch())) out.push(`  - ${launcher.id}: ${launcher.label}`);
    return out.join("\n");
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
    return `${code} ${card.id} "${card.title}"${run}${card.isolate ? " [worktree]" : ""}${body}`;
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
    return agentName({
      id: agent.id,
      name: agent.titleOverride || null,
      doing: agent.title || this.deps.activity.get(agent.id) || null,
      program: agent.agent ?? agent.lastAgent ?? (agent.kind === "shell" ? "shell" : "agent"),
      workspace,
      card,
    });
  }

  /** The same by id, for an agent that may have gone. */
  private nameOf(agentId: string): string {
    const agent = this.deps.host.find(agentId);
    return agent ? this.name(agent) : `an agent that has gone (id ${agentId})`;
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

export type { HarnessState };
