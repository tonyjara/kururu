/**
 * The server's clock: the automations that live on this kururu, fired when
 * their slot comes round, and every slot written down. See
 * `docs/plans/automations.md`; the rules are `shared/automation.ts` and the
 * schedule's grammar `shared/schedule.ts`.
 *
 * **Why the server and not launchd or cron.** A job either started would be
 * an agent outside the pty host, which kururu could neither show nor stop,
 * and the server is already supervised. A run here is an ordinary terminal
 * in the workspace's agents' pane, so the sidebar, the Needs drawer, the
 * notifications, Kuru's notices and the usage ledger all see it as they see
 * any agent. **Why not the pty host:** it is the one process whose restart
 * costs every agent; nothing in here is the host's to know.
 *
 * **A tick, not a timer.** Every thirty seconds the wall clock is compared
 * with each automation's next slot. A timer set for the exact moment would be
 * simpler and is wrong after a sleep, when every timer is late and the clock
 * has jumped. A run is never early: a slot is due once the clock has passed it.
 *
 * **The slot is the run's id.** A row is written, unique by the automation and
 * the slot, *before* anything is started. A server restarted at 09:00:01, or a
 * second server on the same database, is refused the insert, and a row the
 * database refuses is a run that does not start.
 *
 * **A restart is not the run ending.** The agent lives in the host. At start
 * each live row's terminal is found again — by its id, and by the run's tag in
 * the terminal's command line, since ids are given out again after a host
 * restart — and one that is gone is written `interrupted`, so a run left
 * `running` can never hold the schedule up for good.
 *
 * **An agent run ends with its turn.** Its `done` is the hooks' (`noticeStatuses`
 * sees it, and so does `onAgents` here); the verdict is the `RESULT:` line of
 * its last reply. Two minutes later the terminal is ended, under the sleeper's
 * own checks — nothing running under it, no question on its screen, its
 * conversation found on disk — so a daily automation does not leave a tab a
 * day, and **Open conversation** brings it back. A shell run is a pty whose
 * command prints its status after it, read off the screen through the host's
 * `text`; in a pty and not a child of this process, because this process
 * restarts on every save and would take the command with it.
 *
 * **An isolated instance has no clock.** With `KURURU_DATA_DIR` set the tick
 * stays off unless `KURURU_AUTOMATIONS=1` says otherwise: a scratch server
 * pointed at a copy of the real database would otherwise start the owner's
 * real agents. Run now still works there, being a press.
 *
 * Phase 1 of the plan: this Mac only, `agent` and `shell` tasks, the time
 * limit. `needs`, `max-usd`, `month-usd` and `tell`'s findings are read and
 * kept, and are acted on from phase 2.
 */
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { join, sep } from "node:path";
import {
  automationText,
  catchUpFor,
  decide,
  durationWords,
  END_AFTER_MS,
  isLiveRun,
  MAX_LIVE_RUNS,
  parseAutomation,
  runPrompt,
  runTag,
  shellEnd,
  shellLine,
  verdictOf,
  type AutomationDef,
  type AutomationView,
  type RunView,
} from "../../shared/automation";
import type { CardRun } from "../../shared/board";
import { findLauncher, withPromptFor, type AgentCli, type Launcher } from "../../shared/launchers";
import type { AgentSnapshot } from "../../shared/model";
import { mintOpencodeSession } from "../../shared/opencode";
import { inWords, latestSlot, nextRun, todayIn, zoneOf } from "../../shared/schedule";
import { randomHex } from "../../shared/text";
import type { AutomationRow, AutomationRunRow, Store } from "./store";
import { sweep } from "./sweep";

export const AUTOMATION_TICK_MS = 30_000;

/** Where a run's terminal goes and what it is: the workspace, its folder, and the profile's launch settings. */
export interface AutomationDeps {
  store: Store;
  /** Whether this server keeps the clock. See the module comment. */
  clock: boolean;
  /** This node's name: an automation's home. */
  home: () => string;
  find: (agentId: string) => AgentSnapshot | undefined;
  /** The profile's id by its key, and a workspace of it by key. */
  profileIdOf: (profileKey: string) => string | null;
  workspaceOf: (profileId: string, workspaceKey: string) => { id: string; name: string } | null;
  /** The workspace's project folder, where its runs start. Null when there is none to be found. */
  folderOf: (profileId: string, workspaceId: string) => Promise<string | null>;
  /** The launcher's line, with the profile's hooks, and the bypass flag unless `ask` drops it. */
  agentLine: (launcher: Launcher, profileId: string, sessionId: string | null, ask: boolean) => Promise<string>;
  /** Open a terminal in the workspace's agents' pane, off screen, the keyboard where it was. */
  open: (profileId: string, workspaceId: string, options: { cwd: string; command: string; kind: "agent" | "shell" }) => Promise<AgentSnapshot>;
  /** The tab named after the automation, and — for an agent — the ledger told whose session it is. */
  launched: (agent: AgentSnapshot, profileId: string, workspaceId: string, note: { program: AgentCli; sessionId: string | null } | null, name: string) => void;
  /** Its last reply, from the Stop hook's report, else its transcript. */
  lastReply: (agentId: string, profileId: string, run: AutomationRunRow) => Promise<string | null>;
  /** What its screen says, many lines of it. Null when it could not be read. */
  screen: (agentId: string) => Promise<string | null>;
  /** Why an ended run's agent should stay open, by the sleeper's checks; null to end it. */
  whyAwake: (profileId: string, agentId: string, run: CardRun) => Promise<string | null>;
  /** End a terminal as the close button does. */
  end: (agentId: string) => void;
  /** What it last said it was doing — a permission prompt's words. */
  activity: (agentId: string) => string | undefined;
  /** A `[kururu]` line for the profile's Kuru, at once. */
  tell: (profileId: string, line: string) => void;
  /** A notification through the server's gate, to every client it passes. */
  notify: (title: string, body: string, agentId: string | null) => void;
  /** Something a client draws moved. */
  changed: () => void;
  /** Resume a conversation in the workspace's agents' pane and show it. */
  resume: (profileId: string, workspaceId: string, run: AutomationRunRow, launcher: Launcher) => Promise<AgentSnapshot>;
  reveal: (agentId: string) => boolean;
  now?: () => number;
}

/** The fields of a row a client is sent. */
function runView(row: AutomationRunRow): RunView {
  return {
    id: row.id,
    slot: row.slot,
    slotAt: row.slotAt,
    why: row.why,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    state: row.state,
    words: row.words,
    output: row.output,
    agentId: row.closedAt === null ? row.agentId : null,
    sessionId: row.sessionId,
    launcher: row.launcher,
  };
}

export class Automations {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private watching = false;
  private again = false;
  private againAll = false;
  private rows: AutomationRow[] = [];
  private heads: ReturnType<Store["runHeads"]> = { live: new Map(), last: new Map() };
  /** Shell runs whose terminal must stay after it exits, until its status is read. See `holds`. */
  private readonly held = new Set<string>();
  /** Why an ended run's agent is still open, for the sheet. */
  private readonly kept = new Map<number, string>();

  constructor(private readonly deps: AutomationDeps) {
    this.reload();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** The clock on, and every live row looked for again. Resolves when the first look is done. */
  start(): Promise<void> {
    this.reattach();
    if (!this.deps.clock || this.timer) return Promise.resolve();
    const tick = sweep("automations", () => this.tick());
    this.timer = setInterval(tick, AUTOMATION_TICK_MS);
    this.timer.unref?.();
    return tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  clockOn(): boolean {
    return this.deps.clock;
  }

  private reload(): void {
    this.rows = this.deps.store.automations();
    this.heads = this.deps.store.runHeads();
  }

  private touched(): void {
    this.reload();
    this.deps.changed();
  }

  // -------------------------------------------------------------------------
  // What a client sees
  // -------------------------------------------------------------------------

  /** Every automation of a profile, as the sidebar draws it. */
  view(profileKey: string): AutomationView[] {
    const profileId = this.deps.profileIdOf(profileKey);
    return this.rows
      .filter((row) => row.profileKey === profileKey)
      .map((row) => {
        const parsed = parseAutomation(row.text);
        const workspace = profileId && row.workspaceKey ? this.deps.workspaceOf(profileId, row.workspaceKey) : null;
        const live = this.heads.live.get(row.key);
        const last = this.heads.last.get(row.key);
        const name = parsed.ok ? parsed.def.name : (/^name:\s*(.+)$/m.exec(row.text)?.[1]?.trim() ?? row.key);
        return {
          key: row.key,
          name,
          workspaceId: workspace?.id ?? null,
          workspaceName: workspace?.name ?? null,
          home: row.home,
          enabled: row.enabled,
          whyOff: row.whyOff,
          text: row.text,
          error: parsed.ok ? (workspace ? null : "its workspace is gone") : parsed.error,
          schedule: parsed.ok ? parsed.def.schedule : "",
          words: parsed.ok ? inWords(parsed.def.parsed) : "",
          zone: parsed.ok ? zoneOf(parsed.def.parsed) : null,
          anchor: row.anchor,
          run: parsed.ok ? parsed.def.run : "agent",
          next: row.enabled ? row.nextSlot : null,
          live: live ? runView(live) : null,
          last: last ? runView(last) : null,
          clock: this.deps.clock,
        };
      });
  }

  /** The last twenty runs of one, newest first, with why an ended one's agent is still open. */
  runs(key: string): (RunView & { kept: string | null })[] {
    return this.deps.store.automationRuns(key, 20).map((row) => ({ ...runView(row), kept: this.kept.get(row.id) ?? null }));
  }

  /** A shell run's terminal that has exited and not yet been read. `reapExited` leaves it for this module. */
  holds(agentId: string): boolean {
    return this.held.has(agentId);
  }

  // -------------------------------------------------------------------------
  // The verbs
  // -------------------------------------------------------------------------

  /**
   * Make one, or replace one's definition. The text is read and written back
   * in the one spelling (`automationText`), so what the database keeps is the
   * same whether it came from the form or a file. A new one is on: whoever
   * pressed Save made it. Its anchor is the line's `from`, else today in the
   * schedule's zone, and an edit keeps the anchor it had.
   */
  save(profileKey: string, workspaceKey: string, key: string | null, text: string): { key: string } {
    const parsed = parseAutomation(text);
    if (!parsed.ok) throw new Error(parsed.error);
    const def = parsed.def;
    if (def.run === "card") throw new Error("A card task is not offered yet: use agent or shell.");
    if (def.permissions === "auto") throw new Error("permissions: auto is not offered yet: use profile, or ask.");
    const before = key ? this.rows.find((row) => row.key === key) : undefined;
    if (key && !before) throw new Error("That automation is not there any more.");
    if (before && before.profileKey !== profileKey) throw new Error("That automation is another profile's.");
    const clash = this.rows.find((row) => row.profileKey === profileKey && row.key !== key && nameOf(row) === def.name.toLowerCase());
    if (clash) throw new Error(`There is already an automation called "${def.name}".`);
    const now = this.now();
    const anchor = def.parsed.kind === "every" && def.parsed.from ? def.parsed.from : (before?.anchor ?? todayIn(zoneOf(def.parsed), now));
    const enabled = before?.enabled ?? true;
    const row: AutomationRow = {
      key: before?.key ?? `ak${randomHex(4)}`,
      profileKey,
      workspaceKey,
      text: automationText(def),
      home: before?.home ?? this.deps.home(),
      enabled,
      whyOff: before?.whyOff ?? null,
      anchor,
      nextSlot: enabled ? nextRun(def.parsed, now, anchor) : null,
      createdAt: before?.createdAt ?? now,
      updatedAt: now,
    };
    this.deps.store.putAutomation(row, now);
    this.touched();
    return { key: row.key };
  }

  /** On or off. Off takes the next slot away; on works it out again from now, so nothing paused fires the moment it is resumed. */
  setEnabled(profileKey: string, key: string, on: boolean, why: string | null): void {
    const row = this.mine(profileKey, key);
    const parsed = parseAutomation(row.text);
    const next = on && parsed.ok ? nextRun(parsed.def.parsed, this.now(), row.anchor) : null;
    this.deps.store.setAutomationEnabled(key, on, on ? null : (why ?? "paused"), next, this.now());
    this.touched();
  }

  pauseAll(profileKey: string): number {
    const on = this.rows.filter((row) => row.profileKey === profileKey && row.enabled);
    for (const row of on) this.deps.store.setAutomationEnabled(row.key, false, "paused with Pause all", null, this.now());
    this.touched();
    return on.length;
  }

  /** Gone from the list, its history kept. Refused while a run is going: that is a terminal somebody should end on purpose. */
  delete(profileKey: string, key: string): void {
    this.mine(profileKey, key);
    if (this.heads.live.has(key)) throw new Error("It is running: end its run first.");
    this.deps.store.deleteAutomation(key, this.now());
    this.touched();
  }

  /** Run now, whatever the schedule says: a slot of its own, `now:<time>`. Refused while a run is going, since runs never stack. */
  async runNow(profileKey: string, key: string, by: string): Promise<{ runId: number; agentId: string | null }> {
    const row = this.mine(profileKey, key);
    const parsed = parseAutomation(row.text);
    if (!parsed.ok) throw new Error(parsed.error);
    if (this.heads.live.has(key)) throw new Error("It is already running.");
    const now = this.now();
    const id = this.deps.store.claimRun({ automationKey: key, slot: `now:${now}`, slotAt: now, why: "now", by, state: "running", words: null, startedAt: now, endedAt: null });
    if (id === null) throw new Error("It was started a moment ago.");
    this.touched();
    const agentId = await this.begin(row, parsed.def, id);
    return { runId: id, agentId };
  }

  /** A run's terminal shown, or its conversation picked back up when the terminal has gone. */
  async openRun(profileKey: string, key: string, runId: number): Promise<{ agentId: string }> {
    const row = this.mine(profileKey, key);
    const run = this.deps.store.automationRun(runId);
    if (!run || run.automationKey !== key) throw new Error("That run is not in its history.");
    const agent = run.agentId && run.closedAt === null ? this.agentOf(run) : null;
    if (agent && this.deps.reveal(agent.id)) return { agentId: agent.id };
    const launcher = run.launcher ? findLauncher(run.launcher) : undefined;
    if (!launcher || !run.sessionId) throw new Error("That run has no conversation kururu can open.");
    const profileId = this.deps.profileIdOf(row.profileKey);
    const workspace = profileId && row.workspaceKey ? this.deps.workspaceOf(profileId, row.workspaceKey) : null;
    if (!profileId || !workspace) throw new Error("Its workspace is gone.");
    const resumed = await this.deps.resume(profileId, workspace.id, run, launcher);
    this.deps.reveal(resumed.id);
    return { agentId: resumed.id };
  }

  private mine(profileKey: string, key: string): AutomationRow {
    const row = this.rows.find((r) => r.key === key);
    if (!row || row.profileKey !== profileKey) throw new Error("That automation is not there any more.");
    return row;
  }

  // -------------------------------------------------------------------------
  // The clock
  // -------------------------------------------------------------------------

  /** One look at every automation this node is home to, then at every run that is going. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.fire();
      await this.watch(true);
    } finally {
      this.ticking = false;
    }
  }

  private async fire(): Promise<void> {
    const home = this.deps.home();
    for (const row of [...this.rows]) {
      if (!row.enabled || row.home !== home || row.nextSlot === null) continue;
      const now = this.now();
      if (now < row.nextSlot) continue;
      const parsed = parseAutomation(row.text);
      if (!parsed.ok) continue;
      const def = parsed.def;
      const { slot, passed } = latestSlot(def.parsed, row.nextSlot, now, row.anchor);
      const next = nextRun(def.parsed, Math.max(slot, now), row.anchor);
      const live = this.heads.live.size ? [...this.heads.live.values()] : [];
      const full = live.filter((run) => this.rows.find((r) => r.key === run.automationKey)?.profileKey === row.profileKey).length >= MAX_LIVE_RUNS;
      const decision = decide({ slot, now, catchUpMs: catchUpFor(def), passed, running: this.heads.live.has(row.key), full });
      if (decision.act === "early" || decision.act === "wait") continue;
      const base = { automationKey: row.key, slot: String(slot), slotAt: slot, by: null };
      if (decision.act === "missed" || decision.act === "skipped") {
        const id = this.deps.store.claimRun({ ...base, why: "schedule", state: decision.act, words: decision.words, startedAt: null, endedAt: now });
        this.deps.store.setAutomationNext(row.key, next);
        this.touched();
        if (id !== null) this.raise(row, def, decision.act === "missed" ? "was missed" : "was skipped", decision.words, null);
        continue;
      }
      const id = this.deps.store.claimRun({ ...base, why: decision.why, state: "running", words: decision.words, startedAt: now, endedAt: null });
      this.deps.store.setAutomationNext(row.key, next);
      this.touched();
      // Another server claimed the slot first: it is that one's run.
      if (id === null) continue;
      await this.begin(row, def, id);
    }
  }

  /**
   * Start a claimed run. Anything that refuses — the workspace gone, the
   * launcher retired, the folder not there — ends the row `skipped` with the
   * reason, and anything that throws ends it `failed`: the row is never left
   * running with nothing behind it.
   */
  private async begin(row: AutomationRow, def: AutomationDef, runId: number): Promise<string | null> {
    const skip = (words: string) => {
      this.deps.store.updateRun(runId, { state: "skipped", words, endedAt: this.now() });
      this.touched();
      this.raise(row, def, "was skipped", words, null);
      return null;
    };
    const profileId = this.deps.profileIdOf(row.profileKey);
    if (!profileId) return skip("its profile is gone.");
    const workspace = row.workspaceKey ? this.deps.workspaceOf(profileId, row.workspaceKey) : null;
    if (!workspace) return skip("its workspace is gone; edit it to name another.");
    let launcher: Launcher | undefined;
    if (def.run === "agent") {
      launcher = def.launcher ? findLauncher(def.launcher) : undefined;
      if (!launcher) return skip(`its launcher ${def.launcher ?? ""} is not offered any more; edit it to pick another.`);
    }
    try {
      const folder = await this.deps.folderOf(profileId, workspace.id);
      if (!folder) return skip(`kururu could not find ${workspace.name}'s folder on this Mac.`);
      const cwd = def.dir ? under(folder, def.dir) : folder;
      if (!cwd) return skip(`its folder ${def.dir} is not a folder under ${workspace.name}'s.`);
      const tag = runTag(runId, randomHex(2));
      if (def.run === "shell") {
        this.deps.store.updateRun(runId, { tag, cwd });
        const agent = await this.deps.open(profileId, workspace.id, { cwd, command: shellLine(def.body, tag), kind: "shell" });
        this.held.add(agent.id);
        this.deps.store.updateRun(runId, { agentId: agent.id });
        this.deps.launched(agent, profileId, workspace.id, null, def.name);
        this.touched();
        return agent.id;
      }
      const cli = launcher!.cli;
      const sessionId = cli === "claude" ? randomUUID() : cli === "opencode" ? mintOpencodeSession() : null;
      const line = await this.deps.agentLine(launcher!, profileId, sessionId, def.permissions === "ask");
      const sessionFlag = cli === "claude" && sessionId ? ` --session-id ${sessionId}` : "";
      const command = withPromptFor(cli, line + sessionFlag, runPrompt(def, tag));
      this.deps.store.updateRun(runId, { tag, cwd, sessionId, launcher: launcher!.id });
      const agent = await this.deps.open(profileId, workspace.id, { cwd, command, kind: "agent" });
      this.deps.store.updateRun(runId, { agentId: agent.id });
      this.deps.launched(agent, profileId, workspace.id, { program: cli, sessionId }, def.name);
      this.touched();
      return agent.id;
    } catch (err) {
      const words = `it could not be started: ${err instanceof Error ? err.message : String(err)}`;
      this.deps.store.updateRun(runId, { state: "failed", words, endedAt: this.now() });
      this.touched();
      this.raise(row, def, "failed", words, null);
      return null;
    }
  }

  /** The terminal a run's row names, if it is still that run's: its tag is in the command line. */
  private agentOf(run: AutomationRunRow): AgentSnapshot | null {
    if (!run.agentId || !run.tag) return null;
    const agent = this.deps.find(run.agentId);
    return agent && agent.command?.includes(run.tag) ? agent : null;
  }

  /**
   * At start: every live row whose terminal is gone is written `interrupted`,
   * and every ended one whose terminal is gone is closed. A row claimed and
   * never started — the server ended between the two — is interrupted too.
   */
  private reattach(): void {
    const now = this.now();
    for (const run of this.deps.store.openRuns()) {
      const agent = this.agentOf(run);
      if (isLiveRun(run.state)) {
        if (agent) {
          if (run.launcher === null) this.held.add(agent.id);
          continue;
        }
        const words = run.agentId ? "its terminal was gone when kururu started again." : "kururu stopped before it could start it.";
        this.deps.store.updateRun(run.id, { state: "interrupted", words, endedAt: now, closedAt: now });
        const row = this.rows.find((r) => r.key === run.automationKey);
        const parsed = row ? parseAutomation(row.text) : null;
        if (row && parsed?.ok) this.raise(row, parsed.def, "was interrupted", words, null);
      } else if (!agent) {
        this.deps.store.updateRun(run.id, { closedAt: now });
      }
    }
    this.reload();
  }

  /**
   * Something about some agent changed: look at the live runs now rather
   * than at the next tick. Only the live ones: whether an ended run's agent
   * may be closed reads its screen and the process table, which is the
   * tick's to do every thirty seconds and not every hook report's.
   */
  onAgents(): void {
    if (!this.heads.live.size && !this.held.size) return;
    void this.watch(false);
  }

  /** The runs going and, on the tick, the ended ones whose terminal is still open. One look at a time; a call during one asks for another after. */
  private async watch(all: boolean): Promise<void> {
    if (this.watching) {
      this.again = true;
      this.againAll ||= all;
      return;
    }
    this.watching = true;
    try {
      let wide = all;
      do {
        this.again = false;
        for (const run of this.deps.store.openRuns()) if (wide || isLiveRun(run.state)) await this.follow(run);
        wide = this.againAll;
        this.againAll = false;
      } while (this.again);
    } finally {
      this.watching = false;
    }
  }

  private async follow(run: AutomationRunRow): Promise<void> {
    const row = this.rows.find((r) => r.key === run.automationKey) ?? this.deps.store.automations().find((r) => r.key === run.automationKey);
    const parsed = row ? parseAutomation(row.text) : null;
    const def = parsed?.ok ? parsed.def : null;
    const profileId = row ? this.deps.profileIdOf(row.profileKey) : null;
    const agent = this.agentOf(run);
    const now = this.now();
    const shell = run.launcher === null;

    if (!isLiveRun(run.state)) {
      // Ended: its terminal is closed two minutes on, when nothing about it says to wait.
      if (!agent || agent.exited) {
        this.held.delete(run.agentId ?? "");
        this.deps.store.updateRun(run.id, { closedAt: now });
        this.kept.delete(run.id);
        this.touched();
        return;
      }
      if (now - (run.endedAt ?? now) < END_AFTER_MS || !profileId) return;
      const why = await this.deps.whyAwake(profileId, agent.id, cardRunOf(run));
      if (why) {
        if (this.kept.get(run.id) !== why) {
          this.kept.set(run.id, why);
          this.deps.changed();
        }
        return;
      }
      this.deps.end(agent.id);
      this.deps.store.updateRun(run.id, { closedAt: this.now() });
      this.kept.delete(run.id);
      this.touched();
      return;
    }

    if (!agent) {
      // Not there before it had even been opened: `begin` is still at it.
      if (!run.agentId) return;
      this.held.delete(run.agentId);
      this.finish(run, row, def, "failed", "its terminal ended before the run did.", { closedAt: now });
      return;
    }

    if (shell && agent.exited) {
      const screen = run.tag ? await this.deps.screen(agent.id) : null;
      const end = screen !== null && run.tag ? shellEnd(screen, run.tag) : null;
      this.held.delete(agent.id);
      this.deps.end(agent.id);
      if (!end) this.finish(run, row, def, "failed", "it ended without printing its status.", { closedAt: now });
      else if (end.status === 0) this.finish(run, row, def, "ok", null, { output: end.output, closedAt: now });
      else this.finish(run, row, def, "failed", `it exited with status ${end.status}.`, { output: end.output, closedAt: now });
      return;
    }

    const timeout = def?.timeoutMs ?? 60 * 60_000;
    if (run.startedAt !== null && now - run.startedAt > timeout) {
      const question = this.deps.activity(agent.id);
      const words = run.state === "asking" ? `it asked${question ? ` "${question.slice(0, 200)}"` : " something"} and nobody answered in ${durationWords(timeout)}.` : `it ran past ${durationWords(timeout)}.`;
      this.held.delete(agent.id);
      this.deps.end(agent.id);
      this.finish(run, row, def, "failed", words, { closedAt: now });
      return;
    }

    if (shell) return;
    if (agent.exited) {
      this.finish(run, row, def, "failed", "its agent exited before its turn ended.", { closedAt: now });
      return;
    }
    if (agent.status === "blocked" && run.state !== "asking") {
      this.deps.store.updateRun(run.id, { state: "asking" });
      this.touched();
      return;
    }
    if (agent.status === "working" && run.state === "asking") {
      this.deps.store.updateRun(run.id, { state: "running" });
      this.touched();
      return;
    }
    if (agent.status !== "done" || !profileId) return;
    const verdict = verdictOf(await this.deps.lastReply(agent.id, profileId, run));
    this.finish(run, row, def, verdict.state, verdict.words, {});
  }

  /** A run ended: the row, and — for one that failed — a notification and Kuru's line, unless it says never. */
  private finish(
    run: AutomationRunRow,
    row: AutomationRow | undefined,
    def: AutomationDef | null,
    state: "ok" | "finding" | "failed",
    words: string | null,
    more: { output?: string; closedAt?: number },
  ): void {
    this.deps.store.updateRun(run.id, { state, words, endedAt: this.now(), ...more });
    this.touched();
    if (state === "failed" && row && def) this.raise(row, def, "failed", words, run.agentId);
  }

  /**
   * Tell the owner a run went wrong: a notification through the server's
   * gate and one `[kururu]` line to the profile's Kuru, who passes it on
   * wherever the owner is. A quiet run tells nobody; findings and `tell:
   * always` come with phase 2, and until then a finished agent's ordinary
   * notice is how Kuru hears of one.
   */
  private raise(row: AutomationRow, def: AutomationDef, what: string, words: string | null, agentId: string | null): void {
    if (def.tell === "never") return;
    const profileId = this.deps.profileIdOf(row.profileKey);
    const workspace = profileId && row.workspaceKey ? this.deps.workspaceOf(profileId, row.workspaceKey) : null;
    const where = workspace ? ` (in ${workspace.name})` : "";
    const why = words ? `: ${words}` : ".";
    this.deps.notify(`${def.name} ${what}`, words ?? "", agentId);
    if (profileId) this.deps.tell(profileId, `[kururu] Automation "${def.name}"${where} ${what}${why}`);
  }
}

function nameOf(row: AutomationRow): string {
  return (/^name:\s*(.+)$/m.exec(row.text)?.[1] ?? "").trim().toLowerCase();
}

/**
 * A folder under the workspace's, resolved and then checked again through
 * the real path, as `files.ts` checks: refused, never clamped.
 */
function under(root: string, dir: string): string | null {
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(join(realRoot, dir));
    return real === realRoot || real.startsWith(realRoot + sep) ? real : null;
  } catch {
    return null;
  }
}

/** A run as the sleeper's checks read a card's: finished, with its conversation. */
function cardRunOf(run: AutomationRunRow): CardRun {
  return {
    agentId: run.agentId,
    launcher: run.launcher ?? "",
    label: "",
    state: "finished",
    startedAt: run.startedAt ?? run.slotAt,
    endedAt: run.endedAt,
    sessionId: run.sessionId,
    cwd: run.cwd,
  };
}
