/**
 * Ending a card's agent once it has sat idle, so that a laptop running a dozen
 * of them is not powering the ones nobody is using.
 *
 * `shared/sleep.ts` says what idle is and argues for the line it draws; this
 * is the loop that gathers the facts and acts on them. Every thirty seconds it
 * looks over every card in every profile whose run has a terminal behind it —
 * never an agent opened in a tab, never the harness, never a shell or a dev
 * server, none of which is a card's run — and asks first what kururu already
 * knows: the run's state, the terminal's status, how long since anything
 * happened, whether a message is waiting to be typed, whether something is
 * typed and not sent. Only an agent that is past all of that is read: its
 * screen, the processes under it, its conversation's last reply. A run that
 * gets through is put to sleep — the card says so — and ended the way the
 * close button ends a terminal, which on a machine also ends its tmux session.
 *
 * **The conversation is made sure of first.** A Claude run has the id kururu
 * gave it at launch; a Codex run is given its id here, read off the rollout
 * Codex wrote (`shared/sessions.ts`), which is done for every Codex card run
 * whether or not sleeping is on, so that the card's resume goes straight back
 * to it either way. Then the transcript or rollout is opened — on the machine,
 * over ssh, for an agent there — both to see that `--resume` will find it and
 * to read the last reply. A run whose conversation cannot be found stays awake:
 * there would be nothing to wake it into.
 *
 * **The clock is this process's.** Every status edge and keystroke restarts
 * it, and so does the server starting, because the keystrokes before that went
 * to a server that has gone. The cost is that a server restart grants every
 * agent a fresh stretch, which under `bun run dev` is often; the other way an
 * agent somebody was typing into a minute before the restart could be ended a
 * minute after it.
 *
 * On the restartable side, like `onscreen.ts`: a matter of judgement that will
 * be tuned, and nothing the pty host has to know about.
 */
import { SESSION_ID, type Card, type CardRun } from "../../shared/board";
import { findLauncher, type AgentCli } from "../../shared/launchers";
import type { AgentSnapshot, AgentStatus } from "../../shared/model";
import { readScreen } from "../../shared/onscreen";
import { remoteShellOf } from "../../shared/machines";
import { claudeLastReply, codexLastReply, parseRolloutListing, pickCodexRollout } from "../../shared/sessions";
import { commandRunning, draftAfter, notIdle, SLEEP_TICK_MS, stillWanted } from "../../shared/sleep";
import { childIndex, readFootTable, readTree, type FootTable } from "./footprint";
import { screenText } from "./harness";
import type { HostLink } from "./hostlink";
import { codexRolloutsOn, sessionTailOn } from "./machines";
import { claudeTranscriptPath, codexRolloutPath, findCodexRollout, readTail } from "./sessions";

/** A card whose run has a terminal, and where the card is. */
export interface CardAt {
  profileId: string;
  workspaceId: string;
  card: Card & { run: CardRun };
  prompt: string;
}

export interface SleepDeps {
  host: HostLink;
  /** On, and after how many minutes — `LaunchSettings.sleepIdle`, `sleepMinutes`. */
  settings: () => { on: boolean; minutes: number };
  /** Every card in every profile whose run names a terminal. */
  cards: () => CardAt[];
  /** Every conversation id a card already has, so a rollout is never handed to two. */
  taken: () => Set<string>;
  grid: (agentId: string) => { cols: number; rows: number };
  isHarness: (agentId: string) => boolean;
  /** kururu has a message waiting to be typed into it — `Harness.holding`. */
  holding: (agentId: string) => boolean;
  /** Where the session's own hooks said its transcript is, if they did. */
  transcript: (agentId: string) => string | null;
  claudeDir: (profileId: string) => string;
  codexHome: (profileId: string) => string;
  /** A Codex run's conversation id, learned. */
  learned: (agentId: string, sessionId: string) => void;
  /** Mark the card's run asleep and end its terminal as the close button does. */
  sleep: (at: CardAt, agent: AgentSnapshot, idleMs: number) => void;
}

/** One card's agent as the last look found it — `GET /api/sleep`, for whoever wants to know why one is still awake. */
export interface SleepLook {
  agentId: string;
  cardId: string;
  title: string;
  status: AgentStatus;
  /** How long it has been quiet, as this process counts. */
  quietMs: number;
  /** Why it is awake; null when it was ended on this look. */
  why: string | null;
  sessionId: string | null;
  remote: boolean;
}

/** How often a Codex run on a machine is looked for over ssh, and for how long before giving up. */
const REMOTE_LOOK_MS = 60_000;
const REMOTE_LOOKS = 30;

export class Sleeper {
  /** When each terminal's status last moved — a turn starting or ending, a prompt coming or going. */
  private readonly edges = new Map<string, number>();
  /** When somebody last typed into each terminal, from any client. */
  private readonly keys = new Map<string, number>();
  /** How much is typed into each terminal's prompt and not sent. See `draftAfter`. */
  private readonly drafts = new Map<string, number>();
  /** Codex runs on a machine whose rollout is being looked for: when last, and how often. */
  private readonly looks = new Map<string, { at: number; count: number }>();
  private readonly last = new Map<string, SleepLook>();
  private readonly started = Date.now();
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(private readonly deps: SleepDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), SLEEP_TICK_MS);
    this.timer.unref?.();
  }

  /** Somebody typed into a terminal. The clock starts again, and the prompt may now hold a draft. */
  typed(agentId: string, data: string, now = Date.now()): void {
    this.keys.set(agentId, now);
    this.drafts.set(agentId, draftAfter(this.drafts.get(agentId) ?? 0, data));
  }

  /**
   * A terminal's status moved. The clock starts again; and a turn starting
   * means whatever was in its prompt went in with it — typed by the person,
   * or joined by a message kururu typed — so there is no draft left.
   */
  status(agentId: string, status: AgentStatus, now = Date.now()): void {
    this.edges.set(agentId, now);
    if (status === "working") this.drafts.delete(agentId);
  }

  forget(agentId: string): void {
    this.edges.delete(agentId);
    this.keys.delete(agentId);
    this.drafts.delete(agentId);
    this.looks.delete(agentId);
    this.last.delete(agentId);
  }

  looked(): SleepLook[] {
    return [...this.last.values()];
  }

  /** One look over every card's agent, skipped while the last is still going. */
  async tick(now = Date.now()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.look(now);
    } catch (err) {
      console.error(`kururu: looking for idle card agents failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.busy = false;
    }
  }

  private async look(now: number): Promise<void> {
    const { on, minutes } = this.deps.settings();
    const afterMs = minutes * 60_000;
    const seen = new Set<string>();
    const ready: { at: CardAt; agent: AgentSnapshot; quietSince: number }[] = [];
    for (const at of this.deps.cards()) {
      const agentId = at.card.run.agentId;
      const agent = agentId ? this.deps.host.find(agentId) : undefined;
      if (!agent || agent.exited || this.deps.isHarness(agent.id)) continue;
      seen.add(agent.id);
      const remote = remoteOf(agent);
      let run = at.card.run;
      if (cliOf(run) === "codex" && run.sessionId === null) {
        const id = await this.learn(at, agent, remote, now);
        if (id) run = { ...run, sessionId: id };
      }
      const quietSince = this.quietSince(agent.id, run);
      const note = (why: string | null) =>
        this.last.set(agent.id, {
          agentId: agent.id,
          cardId: at.card.id,
          title: at.card.title,
          status: agent.status,
          quietMs: now - quietSince,
          why,
          sessionId: run.sessionId,
          remote: remote !== null,
        });
      if (!on) {
        note("sleeping idle card agents is switched off");
        continue;
      }
      const why = notIdle(
        { run: run.state, status: agent.status, quietSince, holding: this.deps.holding(agent.id), draft: this.drafts.get(agent.id) ?? 0 },
        now,
        afterMs,
      );
      if (why) {
        note(why);
        continue;
      }
      if (!run.sessionId || !SESSION_ID.test(run.sessionId)) {
        note(cliOf(run) === "codex" ? "its Codex conversation has not been found yet" : "it has no conversation id to resume");
        continue;
      }
      note("being looked at");
      ready.push({ at: { ...at, card: { ...at.card, run } }, agent, quietSince });
    }
    for (const id of [...this.last.keys()]) if (!seen.has(id)) this.last.delete(id);
    if (!ready.length) return;

    // One process table for every agent on this Mac that got this far.
    let table: FootTable | null = null;
    for (const { at, agent, quietSince } of ready) {
      const remote = remoteOf(agent);
      const screen = await this.screenOf(agent);
      let tree: { agent: boolean; busy: boolean } | null = null;
      if (remote === null && screen === "quiet") {
        table ??= await readFootTable();
        tree = readUnder(agent.pid, table);
      }
      const facts = { screen, busy: tree?.busy ?? null, agent: tree?.agent ?? null };
      const early = stillWanted({ ...facts, conversation: { reply: null } });
      const conversation = early ? null : await this.conversationOf(at, agent, remote);
      const why = early ?? stillWanted({ ...facts, conversation });
      // The world may have moved while the files were read: ask the cheap
      // half again, of the terminal as it is now.
      const fresh = this.deps.host.find(agent.id);
      const run = this.deps.cards().find((c) => c.card.id === at.card.id)?.card.run;
      const again =
        !fresh || fresh.exited || !run || run.agentId !== agent.id
          ? "it went while it was being looked at"
          : notIdle(
              { run: run.state, status: fresh.status, quietSince: this.quietSince(agent.id, run), holding: this.deps.holding(agent.id), draft: this.drafts.get(agent.id) ?? 0 },
              Date.now(),
              afterMs,
            );
      const held = why ?? again;
      const look = this.last.get(agent.id);
      if (look) look.why = held;
      if (held) continue;
      this.deps.sleep(at, agent, Date.now() - quietSince);
    }
  }

  /** The latest of everything that restarts the clock. */
  private quietSince(agentId: string, run: CardRun): number {
    return Math.max(this.started, run.endedAt ?? 0, this.edges.get(agentId) ?? 0, this.keys.get(agentId) ?? 0);
  }

  /** What its screen shows, as a remote agent's status is read; null when it could not be had. */
  private async screenOf(agent: AgentSnapshot): Promise<ReturnType<typeof readScreen>["phase"] | null> {
    const data = await this.deps.host.backlog(agent.id).catch(() => null);
    if (data === null) return null;
    const { cols, rows } = this.deps.grid(agent.id);
    return readScreen(await screenText(data, cols, rows, rows)).phase;
  }

  /**
   * The run's conversation, found where its CLI keeps it — and its last reply.
   * Null when it is not there, or the machine it is on could not be asked.
   */
  private async conversationOf(at: CardAt, agent: AgentSnapshot, remote: string | null): Promise<{ reply: string | null } | null> {
    const run = at.card.run;
    const id = run.sessionId!;
    const cli = cliOf(run);
    if (remote !== null) {
      const tail = await sessionTailOn(remote, cli, id);
      if (!tail) return null;
      return { reply: cli === "claude" ? claudeLastReply(tail) : codexLastReply(tail) };
    }
    const path =
      cli === "claude"
        ? await claudeTranscriptPath(this.deps.claudeDir(at.profileId), id, run.cwd, this.deps.transcript(agent.id))
        : await codexRolloutPath(this.deps.codexHome(at.profileId), id, run.startedAt);
    const tail = path ? await readTail(path) : null;
    if (tail === null) return null;
    return { reply: cli === "claude" ? claudeLastReply(tail) : codexLastReply(tail) };
  }

  /**
   * Look for a Codex run's rollout and give the card its id. On this Mac, on
   * every look until it is found, since that is a directory listing; on a
   * machine, once a minute for half an hour, since that is an ssh.
   */
  private async learn(at: CardAt, agent: AgentSnapshot, remote: string | null, now: number): Promise<string | null> {
    const run = at.card.run;
    const looking = { startedAt: run.startedAt, cwd: remote === null ? run.cwd : null, prompt: at.prompt };
    let id: string | null = null;
    if (remote === null) {
      id = (await findCodexRollout(this.deps.codexHome(at.profileId), looking, this.deps.taken(), now))?.id ?? null;
    } else {
      const tried = this.looks.get(agent.id) ?? { at: 0, count: 0 };
      if (tried.count >= REMOTE_LOOKS || now - tried.at < REMOTE_LOOK_MS) return null;
      this.looks.set(agent.id, { at: now, count: tried.count + 1 });
      const minutes = Math.ceil((now - run.startedAt) / 60_000) + 2;
      const listing = await codexRolloutsOn(remote, minutes);
      if (listing !== null) id = pickCodexRollout(parseRolloutListing(listing), looking, this.deps.taken())?.id ?? null;
    }
    if (!id) return null;
    this.looks.delete(agent.id);
    this.deps.learned(agent.id, id);
    return id;
  }
}

/** The machine an agent tab runs on, or null for one on this Mac. */
function remoteOf(agent: AgentSnapshot): string | null {
  const remote = remoteShellOf(agent.command);
  return remote?.agent ? remote.host : null;
}

/** Which CLI a run was started on, by its launcher; Claude for one the catalogue no longer has, which is the safer guess of the two. */
function cliOf(run: CardRun): AgentCli {
  return findLauncher(run.launcher)?.cli ?? (run.launcher.startsWith("codex") ? "codex" : "claude");
}

/**
 * What is running under a pty's root: whether an agent CLI still is (the root
 * itself counts — a login shell execs the command it was given), and whether
 * a command one started is. A root the table has not got is a terminal that
 * has gone, and neither.
 */
function readUnder(rootPid: number, table: FootTable): { agent: boolean; busy: boolean } {
  const children = childIndex(table);
  const agent = rootPid > 0 && (readTree(rootPid, table, children)?.agents.length ?? 0) > 0;
  const below: string[] = [];
  const stack = [...(children.get(rootPid) ?? [])];
  while (stack.length && below.length < 4000) {
    const proc = stack.pop()!;
    below.push(proc.args);
    stack.push(...(children.get(proc.pid) ?? []));
  }
  return { agent, busy: commandRunning(below) };
}
