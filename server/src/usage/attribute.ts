/**
 * Whose a session was, written down at the moment kururu knows it.
 *
 * A transcript says which folder it ran in and nothing else. Which workspace,
 * which card, which terminal, whether it was Kuru, which node: kururu knows all
 * of it when it spawns the pty and nobody can work it out afterwards, least of
 * all from a folder, since a dozen workspaces here live in the home folder. So
 * each road that starts an agent says so here, and the session's row is written
 * before the program has read its first line. It is one row per session, so a
 * card resumed three times is one session of that card; what the reader finds
 * in the logs later adds to the row and gives way to it.
 *
 * **Three ways of knowing the id, in the order they are believed.** Claude takes
 * one on its line and so does OpenCode, so kururu chooses and the launch is
 * exact. Codex takes none: its id is learned off its rollout, by the card's
 * words for a card's run (`sleep.ts`, which has always looked) and, for a tab
 * from the menu, by folder and time here. And a hook names a session too, which
 * catches what no launch could: a card's agent that moved to a new session with
 * `/clear`, and a `claude` somebody typed into a shell. That one is marked
 * `report` rather than `spawn`, because kururu saw it running and did not start
 * it.
 *
 * **This can never be why an agent did not start.** Every entry here is called
 * after the terminal is up, from code that has work left to do, so nothing throws
 * out of it; a launch that could not be written is a session the reader will
 * still count, by its folder.
 *
 * Nothing here is told to Kuru or spends a token. An id on an agent's line is the
 * one thing a launch changes about what the program is asked to do, and it is
 * the flag a card's run has always been started with.
 */
import { realpath } from "node:fs/promises";
import { fitsRemoteDir } from "../../../shared/machines";
import { matchRollouts, ROLLOUT_EARLY_REMOTE_MS, type LaunchRow, type RolloutSeen, type SessionKind, type UsageProgram, type WaitingLaunch } from "../../../shared/usage";
import { rolloutsSince } from "../sessions";
import type { Ledger } from "./store";
import { sweep } from "../sweep";

/** How often a launch still waiting for its id is looked for. It costs a `select` when none is. */
const WAITING_MS = 60_000;
/** How long one is looked for: a Codex tab can sit a long time before its first prompt makes a rollout. */
const WAITING_DAYS_MS = 7 * 24 * 3600_000;
/** Hooks fire several times a turn, and a session already written needs no second look until the next start. */
const REMEMBERED_MAX = 4096;

/** The shape a session's id has to be before it reaches a query, whichever road it came by. */
const SESSION = /^[\w.:-]{1,128}$/;

/** What a road that starts an agent adds to what the server can look up for itself. */
export interface LaunchNote {
  program: UsageProgram;
  sessionId: string | null;
  cardId?: string | null;
  /** When it is not the card's or the menu's plain agent: Kuru's own session. */
  kind?: SessionKind;
  machine?: string | null;
  cwd: string | null;
}

export interface LaunchesDeps {
  ledger: Ledger;
  /** Conversations some card already holds, which a folder and a time must not claim. */
  cardSessions: () => ReadonlySet<string>;
  log: (line: string) => void;
  /** The rollouts a machine has touched lately, or null when it could not be asked. Absent in a test with no machine. */
  rolloutsOn?: (machine: string, minutes: number) => Promise<RolloutSeen[] | null>;
}

export class Launches {
  private readonly ledger: Ledger;
  /** Sessions a hook has already been heard about since this process started. */
  private readonly heard = new Set<string>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private looking = false;

  constructor(private readonly deps: LaunchesDeps) {
    this.ledger = deps.ledger;
  }

  start(): void {
    this.interval = setInterval(sweep("usage attribution", () => this.lookForWaiting()), WAITING_MS);
    this.interval.unref?.();
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
  }

  /** kururu started this agent. With no id yet, it waits for one if it is a program whose id can be found. */
  spawned(launch: LaunchRow): void {
    this.quietly(() => {
      if (launch.sessionId && SESSION.test(launch.sessionId)) {
        this.ledger.recordLaunch({ ...launch, sessionId: launch.sessionId });
      } else if (launch.program === "codex" && launch.agentId) {
        this.ledger.addWaiting({ ...launch, agentId: launch.agentId, sessionId: null });
      }
    });
  }

  /** A Codex run's id, off its rollout by the card's words. */
  learned(agentId: string, sessionId: string): void {
    if (SESSION.test(sessionId)) this.quietly(() => void this.ledger.settleWaiting(agentId, sessionId));
  }

  /**
   * A hook in a terminal kururu holds named its session. `who` is asked only
   * for a session not heard of since this process started, because it walks the
   * layout and this is on every hook of every agent.
   */
  reported(sessionId: unknown, who: () => LaunchRow | null): void {
    if (typeof sessionId !== "string" || !SESSION.test(sessionId) || this.heard.has(sessionId)) return;
    this.quietly(() => {
      const launch = who();
      if (!launch) return;
      if (this.heard.size >= REMEMBERED_MAX) this.heard.clear();
      this.heard.add(sessionId);
      this.ledger.recordReport({ ...launch, sessionId });
    });
  }

  /**
   * Waiting launches, matched against the rollouts of their Codex home, here or
   * on the machine they were started on. A card's run stays out of it, because
   * its own words will find it.
   */
  async lookForWaiting(now = Date.now()): Promise<number> {
    if (this.looking) return 0;
    this.looking = true;
    try {
      this.ledger.dropWaitingBefore(now - WAITING_DAYS_MS);
      const here = this.ledger.waiting().filter((launch) => launch.cardId === null && launch.machine === null && launch.loginDir !== null && launch.cwd !== null);
      let settled = 0;
      for (const home of new Set(here.map((launch) => launch.loginDir!))) {
        const mine = await Promise.all(here.filter((launch) => launch.loginDir === home).map(withRealCwd));
        const since = Math.min(...mine.map((launch) => launch.at));
        const seen = (await rolloutsSince(home, since, now)).map(({ rollout }) => ({ id: rollout.id, cwd: rollout.cwd, at: rollout.at }));
        const taken = new Set([...this.deps.cardSessions(), ...this.ledger.launched(seen.map((rollout) => rollout.id))]);
        for (const { launch, sessionId } of matchRollouts(mine, seen, taken)) {
          if (this.ledger.settleWaiting(launch.agentId, sessionId)) settled++;
        }
      }
      return settled + (await this.lookOnMachines(now));
    } catch (err) {
      this.complain(err);
      return 0;
    } finally {
      this.looking = false;
    }
  }

  /**
   * The same over ssh, once a minute and only while something is waiting. A pin's
   * folder may be `~/code`, which only the far side can expand, so a rollout is
   * read as the pin's folder when it fits; and that machine's clock is not this
   * one's, so a rollout may say it began a little before its launch did.
   */
  private async lookOnMachines(now: number): Promise<number> {
    const asked = this.deps.rolloutsOn;
    if (!asked) return 0;
    const there = this.ledger.waiting().filter((launch) => launch.cardId === null && launch.machine !== null && launch.cwd !== null);
    let settled = 0;
    for (const machine of new Set(there.map((launch) => launch.machine!))) {
      const mine = there.filter((launch) => launch.machine === machine);
      const since = Math.min(...mine.map((launch) => launch.at));
      const rollouts = await asked(machine, Math.ceil((now - since) / 60_000) + 2);
      if (!rollouts) continue;
      const dirs = [...new Set(mine.map((launch) => launch.cwd!))];
      const seen = rollouts.map((rollout) => ({ ...rollout, cwd: rollout.cwd === null ? null : (dirs.find((dir) => fitsRemoteDir(dir, rollout.cwd!)) ?? rollout.cwd) }));
      const taken = new Set([...this.deps.cardSessions(), ...this.ledger.launched(seen.map((rollout) => rollout.id))]);
      for (const { launch, sessionId } of matchRollouts(mine, seen, taken, ROLLOUT_EARLY_REMOTE_MS)) {
        if (this.ledger.settleWaiting(launch.agentId, sessionId)) settled++;
      }
    }
    return settled;
  }

  private quietly(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.complain(err);
    }
  }

  private complain(err: unknown): void {
    // A session id at most, and the database's own words: nothing here holds any of a conversation.
    this.deps.log(`kururu: the usage ledger could not write down a launch: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Codex records the folder as the kernel has it, and a tab's can arrive through a link (`/tmp` on a Mac). */
async function withRealCwd(launch: WaitingLaunch): Promise<WaitingLaunch> {
  return { ...launch, cwd: await realpath(launch.cwd!).catch(() => launch.cwd) };
}
