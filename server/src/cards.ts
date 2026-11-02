/**
 * A card handed to an agent, and the worktree it may have been given.
 *
 * Running a card is the one verb that reaches into everything — the board, a
 * terminal in the agents' pane, the launcher's command line, git, the usage
 * ledger's note of whose session it is — and so it lived in `index.ts`, which
 * was the only place that could see all of them. Now that the shared state
 * is in `context.ts`, it is a module: running and resuming a card, the
 * worktree verbs a card's menu offers (commit, stash, merge, retire, open),
 * and the board's own move to Done when another node asks for it.
 */
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canResume,
  type Card,
  cardPrompt,
  type CardRun,
  type CardWorktree,
  moveCard,
  priorRunNote,
  runLive,
  setWorktree,
  startRun,
  wakeFor,
} from "../../shared/board";
import {
  findLauncher,
  type Launcher,
  launcherCommand,
  launcherFor,
  resumeCommand,
  withOpencodePrompt,
  withPrompt,
} from "../../shared/launchers";
import { BOARD_TAB, paneWithAgent } from "../../shared/layout";
import { doneRefusal } from "../../shared/needs";
import { mintOpencodeSession } from "../../shared/opencode";
import {
  type MergeBlock,
  type MergeReply,
  type MergeResolution,
  projectSettingsFor,
  type WorktreeOutcome,
  type WorktreeStatus,
} from "../../shared/projects";
import type { Actor } from "../../shared/store";
import { host, launch, overlay, projects, state, workspaces } from "./context";
import { web } from "./sweeps";
import { shellQuote } from "./editors";
import { repoFor } from "./repostatus";
import { claudeDirOf } from "./lending";
import { agentCommandFor, agentOn, cwdForPaneIn, hooksFor, killAll, kururuMcpOnly, noteLaunch, openTerminal, openTerminalAt, pinOf } from "./terminals";
import { devOpen, startDev, stopDev } from "./carddev";
import { claudeTranscriptPath } from "./sessions";
import {
  commitAll,
  ensureWorktree,
  mainRoot,
  mergeBlock,
  retireWorktree,
  stashAll,
  uncommittedError,
  worktreeChanges,
  worktreePresent,
  worktreeStatus,
} from "./worktree";

/**
 * A member's Needs drawer asking for one of this node's cards to go to Done
 * (remote workspaces, phase 4). Asked again by the rule the button there
 * was drawn by (`doneRefusal`), because the summary that drew it may be
 * seconds old and a card that has grown a terminal since is its board's
 * question, not a click's. Done as the board's own "move-card" does it.
 */
export function cardDoneFor(key: string, cardId: string): string | null {
  const workspace = workspaces.active.workspaces.find((w) => w.key === key);
  const card = workspace?.board?.cards.find((c) => c.id === cardId);
  if (!workspace || !card) return "That card is not on its board any more.";
  const live = card.run?.agentId ? host.agents.find((a) => a.id === card.run?.agentId && !a.exited) : undefined;
  const refusal = doneRefusal(card, live ? overlay(live) : null);
  if (refusal) return refusal;
  workspaces.editBoard(workspace.id, (board) => moveCard(board, cardId, "done"));
  stopDev(workspace.id, cardId);
  return null;
}

/**
 * What a card's run came to: the agent, whether it picked up the card's last
 * conversation, and — when the card had one and it did not — why not, so the
 * harness can say so rather than leave a fresh start to be found out.
 */
interface CardRunResult {
  agentId: string;
  resumed: boolean;
  why: string | null;
}

/**
 * Hand a card to an agent: a terminal in the workspace's agents' pane
 * (`agentPaneIn` — the bottom one, unless the profile says otherwise),
 * running the chosen launcher with the card as its first message.
 *
 * Any workspace of the profile on screen, not only the workspace on screen,
 * because the profile's board draws every workspace's board over the window
 * and a robot pressed there is pressed on a card somebody is looking at. The
 * terminal goes into that workspace's layout, in its agents' pane, and the screen
 * stays where it is: the card's run line is the way to it. It used to refuse
 * every workspace but the active one, when a workspace's board could only be
 * seen in its own pane. On screen, the focus is handed back afterwards
 * (`giveFocusBack`): the point of handing work off is to carry on with the
 * list, not to be taken to it.
 */
export async function runCard(workspaceId: string, cardId: string, launcherId: string, fresh = false): Promise<CardRunResult> {
  return runCardAt(workspaces.active.id, workspaceId, cardId, launcherId, true, "user", fresh);
}

/**
 * The same, for a board that need not be on screen — the harness pressing the
 * robot on a workspace the user is not in. One difference, and it is on
 * purpose: the harness's run starts a card's dev server only when the
 * workspace is the one on screen, since nobody is looking at a card on any
 * other and a server for a project you are not looking at is a process you
 * did not ask for. The card's ↻ starts it when they get there. `shown` is the
 * robot pressed on the profile's board, which is a card somebody *is* looking
 * at whichever workspace it is in, and gets its server as the workspace's own
 * board would — beside that workspace's board, never in the one on screen.
 */
export async function runCardAt(
  profileId: string,
  workspaceId: string,
  cardId: string,
  launcherId: string,
  shown = false,
  actor: Actor = "user",
  fresh = false,
): Promise<CardRunResult> {
  const onScreen = profileId === workspaces.active.id && workspaceId === workspaces.activeWorkspace.id;
  // `startDev` acts on the profile on screen, which a shown card's always is.
  const seen = onScreen || (shown && profileId === workspaces.active.id);
  const workspace = workspaces.workspaceIn(profileId, workspaceId);
  if (!workspace) throw new Error("no such workspace");
  const found = workspaces.findCardIn(profileId, workspaceId, cardId);
  if (!found) throw new Error("no such card");
  if (runLive(found.card.run) && host.agents.some((a) => a.id === found.card.run?.agentId && !a.exited)) {
    throw new Error("that card already has an agent on it");
  }
  const launcher = typeof launcherId === "string" ? launcherFor(launcherId, launch) : undefined;
  if (!launcher) throw new Error(`no such agent: ${String(launcherId)}`);
  /*
   * A card whose last agent has gone is picked back up, not started over —
   * put to sleep, lost with the host, closed by hand, alike (`wakeFor`). On
   * the launcher asked for when it is the same CLI — a model can change
   * between turns of one conversation — and fresh only when asked for in so
   * many words, on the other CLI, which cannot read this one's, or when the
   * transcript is not where `--resume` would look: a resume that finds
   * nothing is an agent that exits on its first line.
   */
  const last = found.card.run;
  const open = last?.agentId != null && host.agents.some((a) => a.id === last.agentId && !a.exited);
  let wake = wakeFor(last, launcher.cli, fresh, open);
  if (wake.resume && last && !(await conversationKept(profileId, workspaceId, last))) {
    wake = { resume: false, why: "its conversation is no longer on this Mac's disk" };
  }
  if (wake.resume) {
    return { ...(await resumeCardAt(profileId, workspaceId, cardId, launcher, actor)), resumed: true, why: null };
  }

  const boardPane = paneWithAgent(workspace.layout, BOARD_TAB)?.id;
  const focused = onScreen ? workspaces.focusedPaneId : null;
  // Where it starts is read off the pane it always was; where its tab goes
  // is the agents' pane, decided below — see `cwdPaneIn`.
  const fromPane = workspaces.cwdPaneIn(profileId, workspaceId);
  if (!fromPane) throw new Error("nowhere to put the agent");
  /*
   * In a workspace pinned to a machine the agent runs there, in the pin's
   * folder, the way the menu's agents do — unless the card has a worktree
   * standing here from before the pin, which is where its work is. A
   * worktree is git's on this disk (`worktree.ts`), so a card that asks for
   * a new one in a pinned workspace is refused rather than run on the machine
   * in the main checkout: the person ticked the box expecting isolation.
   */
  const standing = found.card.worktree !== null && worktreePresent(found.card.worktree.path);
  const remote = standing ? undefined : pinOf(profileId, workspaceId);
  if (remote && found.card.isolate) {
    throw new Error(`${workspace.name} runs on ${remote.machine.name}, and a card's worktree is made on this Mac. Untick the card's worktree box to run it on ${remote.machine.name}.`);
  }
  /*
   * Where the agent would have started is where the repository is looked for;
   * where it *does* start is the card's worktree, when the card asked for one. A worktree that cannot be made is an error on the card rather
   * than an agent quietly started in the main checkout — the person pressed
   * the robot expecting isolation, and the one thing worse than no agent is
   * two agents in one tree that they believe are in two.
   */
  const from = remote ? undefined : await cwdForPaneIn(profileId, workspaceId, fromPane);
  const checkout = remote ? null : await checkoutFor(found.card, from);
  /*
   * A Claude run is told its session id rather than left to pick one, because
   * the id is the only road back to the conversation once the terminal has
   * gone — `resume-card` is `--resume` with it. Codex takes no such flag.
   */
  const sessionId = launcher.cli === "claude" ? randomUUID() : launcher.cli === "opencode" && !remote ? mintOpencodeSession() : null;
  const cwd = checkout?.worktree.path ?? from;
  // No hook settings on a machine: they name files on this one. See `remoteAgentRun`.
  const line = remote ? launcherCommand(launcher, launch) : await agentCommandFor(launcher, profileId, sessionId);
  // A card that has run before says so to the new conversation, which
  // otherwise starts from the card's words as if nothing had been done.
  const prompt = last ? `${cardPrompt(found.card)}\n\n${priorRunNote(last, wake.why)}` : cardPrompt(found.card);
  // Claude's id is a `--session-id`; OpenCode already has its corresponding
  // `--session` in `agentCommandFor`. Its positional argument is a directory,
  // so its opening card text must be the `--prompt` value instead.
  const sessionFlag = launcher.cli === "claude" && sessionId ? ` --session-id ${sessionId}` : "";
  let command = launcher.cli === "opencode"
    ? withOpencodePrompt(line, prompt)
    : withPrompt(line + sessionFlag, prompt);
  /*
   * The dev server starts with the worktree, when the project has a dev line —
   * so that the card's work can be looked at without anybody having to ask.
   * Only for a worktree: in the main checkout the dev server is the one the
   * person already runs, and a second on another port would be serving the
   * same files. A fresh checkout's server has to wait for the setup line, which
   * runs in the agent's terminal below; the marker is how the two terminals
   * agree that it has, and it lives outside the worktree because a file in
   * there is an uncommitted change that would hold up the merge.
   */
  const serve = seen && checkout && checkout.dev && !devOpen(found.card) ? { ...checkout, dev: checkout.dev } : null;
  const ready = serve?.fresh && serve.setup ? join(tmpdir(), `kururu-setup-${cardId}-${Date.now()}`) : null;
  /*
   * The setup line runs in the agent's own terminal, ahead of it, rather than
   * as a subprocess of the server's: an install takes a minute, its output is
   * the only explanation when it fails, and `&&` means an agent is never
   * started into a checkout the setup gave up on.
   */
  if (checkout?.fresh && checkout.setup) {
    command = `${checkout.setup} && ${ready ? `touch ${shellQuote(ready)} && ` : ""}${command}`;
  }
  /*
   * The server's terminal is opened before the agent's, so that when both land
   * in one pane it is the agent that is left showing. A server that cannot be
   * started is not a reason to withhold the agent; it is a line in the log and
   * a card with no link, and the card's menu can try again.
   */
  if (serve) {
    await startDev(workspaceId, found.card, serve.worktree, serve.dev, ready).catch((err: unknown) => {
      console.error("kururu: could not start the card's dev server:", err instanceof Error ? err.message : err);
    });
  }
  const options = remote
    ? { command: await agentOn(remote.machine, remote.workspaceName, remote.dir, launcher.cli, command), kind: "agent" as const }
    : { cwd, command, kind: "agent" as const };
  // Last, after everything that can refuse, so that a refusal leaves no
  // empty agents' pane behind it.
  const target = workspaces.agentPaneIn(profileId, workspaceId);
  if (!target) throw new Error("nowhere to put the agent");
  const agent = onScreen
    ? await openTerminal(target, options)
    : await openTerminalAt(profileId, workspaceId, target, options);
  noteLaunch(agent.id, profileId, workspaceId, { program: launcher.cli, sessionId, cardId, machine: remote?.machine.name, cwd: remote ? remote.dir : agent.cwd });
  /*
   * Named after the card, as if somebody had typed it into rename-tab. Without
   * it the sidebar row says `starting…` and then whatever the agent titles its
   * first turn, and "which terminal is the migration" is the question the
   * board was meant to have answered. A name the user gives it later wins, the
   * same as always.
   */
  host.rename(agent.id, found.card.title.slice(0, 80));
  workspaces.as(actor, () => workspaces.editBoardIn(profileId, workspaceId, (board) =>
    startRun(setWorktree(board, cardId, checkout?.worktree ?? null), cardId, {
      agentId: agent.id,
      launcher: launcher.id,
      label: launcher.label,
      startedAt: Date.now(),
      sessionId,
      cwd: cwd ?? null,
    }),
  ));
  if (onScreen) giveFocusBack(boardPane ?? focused);
  return { agentId: agent.id, resumed: false, why: wake.why };
}

/**
 * Pick a card's last conversation back up, in a terminal beside the board —
 * the robot's other row, for a card whose agent has gone.
 *
 * It starts where the run started, because that is where the CLI filed the
 * transcript. A card that went through Done has had that directory taken
 * down with its worktree, and there the main checkout is the nearest thing:
 * the work was merged into it, and Claude Code is still handed the id. Its
 * transcript is filed under the old path, so whether it finds it from the new
 * one is Claude's call, and the terminal is where it says so. The card goes
 * back to In progress, the same as any run, because it is being worked on.
 * Any workspace of the profile on screen, for `runCard`'s reason.
 *
 * A run on a machine kept no directory here, so in a workspace pinned to one
 * it is resumed there, in the pin's folder, which is where it started and
 * where its CLI filed the conversation. One that did start here — a directory
 * that is still on this disk, a worktree standing — is resumed here whatever
 * the pin says now, because here is where its transcript is.
 */
export async function resumeCard(workspaceId: string, cardId: string): Promise<{ agentId: string }> {
  const run = workspaces.findCardIn(workspaces.active.id, workspaceId, cardId)?.card.run ?? null;
  const was = run ? findLauncher(run.launcher)?.cli : null;
  if ((launch.harnessCli === "opencode" && was === "claude") || (launch.harnessCli === "claude" && was === "opencode")) {
    const launcher = launcherFor("claude", launch)!;
    return runCardAt(workspaces.active.id, workspaceId, cardId, launcher.id, true, "user", false);
  }
  return resumeCardAt(workspaces.active.id, workspaceId, cardId);
}

/**
 * The same, for any profile's card — the harness's `run_card` on a card put
 * to sleep — and on another launcher of the same CLI when one is named.
 */
async function resumeCardAt(
  profileId: string,
  workspaceId: string,
  cardId: string,
  on?: Launcher,
  actor: Actor = "user",
): Promise<{ agentId: string }> {
  const workspace = workspaces.workspaceIn(profileId, workspaceId);
  if (!workspace) throw new Error("no such workspace");
  const onScreen = profileId === workspaces.active.id && workspaceId === workspaces.activeWorkspace.id;
  const found = workspaces.findCardIn(profileId, workspaceId, cardId);
  if (!found) throw new Error("no such card");
  const run = found.card.run;
  const open = run?.agentId != null && host.agents.some((a) => a.id === run.agentId && !a.exited);
  if (!run || !canResume(run, open)) {
    throw new Error(open ? "its agent is still open" : "there is no conversation on this card to resume");
  }
  // Said here rather than by an agent that prints "No conversation found" and exits.
  if (run.sessionId && !(await conversationKept(profileId, workspaceId, run))) {
    throw new Error("its conversation is no longer on this Mac's disk");
  }
  const launcher = on ?? launcherFor(run.launcher, launch);
  if (!launcher) throw new Error(`no such agent: ${run.launcher}`);

  const boardPane = paneWithAgent(workspace.layout, BOARD_TAB)?.id;
  const focused = onScreen ? workspaces.focusedPaneId : null;
  const fromPane = workspaces.cwdPaneIn(profileId, workspaceId);
  if (!fromPane) throw new Error("nowhere to put the agent");
  const there = run.cwd && isDirectory(run.cwd) ? run.cwd : null;
  const standing = found.card.worktree !== null && worktreePresent(found.card.worktree.path);
  const remote = there || standing ? undefined : pinOf(profileId, workspaceId);
  const cwd = remote ? undefined : (there ?? found.card.worktree?.root ?? (await cwdForPaneIn(profileId, workspaceId, fromPane)));
  // On a machine the folder is the one it ran in, so Codex's picker is not widened to every directory.
  const command = launcher.cli === "opencode"
    ? await agentCommandFor(launcher, profileId, run.sessionId)
    : resumeCommand(launcher, launch, run.sessionId, !remote && there === null);
  if (!command) throw new Error("there is no conversation on this card to resume");
  const options = remote
    ? { command: await agentOn(remote.machine, remote.workspaceName, remote.dir, launcher.cli, command), kind: "agent" as const }
    : { cwd, command: launcher.cli === "opencode" ? command : command + hooksFor(launcher, profileId) + web.launchFlags(launcher.cli) + kururuMcpOnly(launcher, profileId), kind: "agent" as const };
  const target = workspaces.agentPaneIn(profileId, workspaceId);
  if (!target) throw new Error("nowhere to put the agent");
  const agent = onScreen
    ? await openTerminal(target, options)
    : await openTerminalAt(profileId, workspaceId, target, options);
  // The same id, so the same row: a card picked back up is one session of that card.
  noteLaunch(agent.id, profileId, workspaceId, { program: launcher.cli, sessionId: run.sessionId, cardId, machine: remote?.machine.name, cwd: remote ? remote.dir : agent.cwd });
  host.rename(agent.id, found.card.title.slice(0, 80));
  workspaces.as(actor, () =>
    workspaces.editBoardIn(profileId, workspaceId, (board) =>
      startRun(board, cardId, {
        agentId: agent.id,
        launcher: launcher.id,
        label: launcher.label,
        startedAt: Date.now(),
        sessionId: run.sessionId,
        cwd: cwd ?? null,
      }),
    ),
  );
  if (onScreen) giveFocusBack(boardPane ?? focused);
  return { agentId: agent.id };
}

/**
 * Whether a run's conversation is still where `--resume` will look for it,
 * read at the moment of asking. Believed without a look in two cases: a run
 * on a machine, whose transcript is there and an ssh away, as the card's own
 * Resume row has always believed it; and Codex, whose rollouts are filed by
 * the day they began, which a resumed run's `startedAt` no longer says — a
 * miss there would be a guess, and `codex resume` says so itself.
 */
async function conversationKept(profileId: string, workspaceId: string, run: CardRun): Promise<boolean> {
  if (!run.sessionId) return false;
  if (run.cwd === null && pinOf(profileId, workspaceId)) return true;
  if (!run.launcher.startsWith("claude")) return true;
  return (await claudeTranscriptPath(claudeDirOf(profileId), run.sessionId, run.cwd, null)) !== null;
}

/**
 * Where the keyboard goes after a card's agent has been put on screen: back
 * to the board, the robot's own pane, when there is one, and otherwise to
 * the pane that had it. `openTerminal` focuses the pane it fills, which was
 * right while that was the pane you were in; the agents' pane is usually
 * not, and the point of handing work off is to carry on with what you were
 * doing rather than to be taken to it. Said in the same breath as the
 * spawn's own focus, so the window sees one move, not two.
 */
function giveFocusBack(paneId: string | null | undefined): void {
  if (paneId && workspaces.hasPane(paneId)) workspaces.focusPane(paneId);
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The checkout a card's agent works in: the card's own worktree, made now if
 * it has to be, or null for "wherever the pane was going anyway".
 *
 * Null when the card did not ask for a worktree, and when the directory is not
 * in a repository — both are the ordinary run, in place. A card that already
 * has a worktree standing goes back into it, whatever its box says today: the
 * work is in there. `setup` is empty on that road, since the
 * setup line is for a checkout that has only ever held tracked files.
 */
async function checkoutFor(
  card: Card,
  from: string | undefined,
): Promise<{ worktree: CardWorktree; fresh: boolean; setup: string; dev: string } | null> {
  if (card.worktree && worktreePresent(card.worktree.path)) {
    return { worktree: card.worktree, fresh: false, setup: "", dev: projectSettingsFor(projects, card.worktree.root).dev };
  }
  if (!card.isolate || !from) return null;
  const repo = await repoFor(from);
  if (!repo) return null;
  /*
   * The *main* repository's settings, which is not always the one the walk
   * found: the pane beside the board may be an earlier card's agent, and its
   * worktree is a repository too. Cutting a card from another card's branch
   * is never what anybody meant.
   */
  const root = await mainRoot(repo.root);
  const settings = projectSettingsFor(projects, root);
  const made = await ensureWorktree(root, card);
  return { ...made, setup: settings.setup, dev: settings.dev };
}

/**
 * Merge every card's worktree in one repository back and take it down — the
 * sweep Settings → Workspaces offers for a repository's standing worktrees,
 * after the person has read the list and confirmed it.
 *
 * One at a time and in order, because they all land on the same branch: the
 * second card's rebase has to see the first card's commits on the base, or the
 * second fast-forward is refused for being behind. A dirty worktree is left
 * standing and its agent left running — that is the one check made *before*
 * anything is ended, since `worktree remove` would refuse it anyway and there
 * is no sense killing an agent for a removal that was never going to happen.
 * Past that check the card's agent is ended first, the way `close-tab` ends
 * one: it was working in a directory that is about to not exist. Each card
 * gets a row in the reply, and a card whose worktree went forgets it, so the
 * next robot press on it starts a fresh one if the card still asks for one.
 */
export async function retireWorktrees(root: unknown): Promise<WorktreeOutcome[]> {
  if (typeof root !== "string") throw new Error("no such repository");
  const known = root in projects || state.projects.some((project) => project.root === root);
  if (!known) throw new Error("no such repository");
  const outcomes: WorktreeOutcome[] = [];
  for (const { workspace, card, worktree } of workspaces.cardsWithWorktrees(root)) {
    const outcome: WorktreeOutcome = { cardId: card.id, title: card.title, branch: worktree.branch, commits: 0, error: null };
    try {
      outcome.commits = (await retireCard(workspace.id, card, worktree)).commits;
    } catch (err) {
      outcome.error = err instanceof Error ? err.message : String(err);
    }
    outcomes.push(outcome);
  }
  return outcomes;
}

/**
 * One card's worktree merged back and taken down — the step the sweep repeats
 * and `merge-card` does once. The dirty check comes before the agent is ended,
 * for the reason given on the sweep; past it the card's agent goes the way
 * `close-tab` ends one, and the card forgets a worktree that is no longer
 * there. The card's column is the caller's business: the sweep leaves it, the
 * menu's merge puts it in Done, because merged is what done means on a board
 * that runs cards in worktrees.
 */
async function retireCard(
  workspaceId: string,
  card: Card,
  worktree: CardWorktree,
  resolve?: MergeResolution,
): Promise<{ commits: number; note: string | null }> {
  const changes = worktreePresent(worktree.path) ? await worktreeChanges(worktree.path) : [];
  if (changes.length) throw uncommittedError(changes);
  /*
   * The other tree with a say: the base's own checkout, with work in it that
   * the merge would overwrite. Asked here, before the agent is ended, for
   * the dirty check's reason — and answered with a block rather than an
   * error, because the card has two ways through to offer. A resolution
   * that arrives for a block neither way gets past is refused as an error,
   * the same as any other refusal.
   */
  const block = await mergeBlock(worktree);
  if (block) {
    if (!resolve) throw new MergeBlocked(block);
    if (block.untracked.length || block.clean === false) throw new MergeBlocked(block);
    if (resolve === "commit") await commitAll(worktree.root, `wip: before merging “${card.title}”`, "");
  }
  const agentId = card.run?.agentId;
  if (agentId && host.agents.some((agent) => agent.id === agentId && !agent.exited)) killAll([agentId]);
  // Its server goes before its directory does, for the same reason.
  stopDev(workspaceId, card.id);
  const outcome = await retireWorktree(worktree, { autostash: block !== null && resolve === "stash" });
  workspaces.editBoard(workspaceId, (board) => setWorktree(board, card.id, null));
  return outcome;
}

/**
 * A merge stopped by `mergeBlock`, carried as an error so that the sweep and
 * the menu's merge can treat it differently: the sweep reports its message
 * on the card's row, the menu's merge hands the block itself back for the
 * card to ask about.
 */
class MergeBlocked extends Error {
  constructor(readonly block: MergeBlock) {
    super(blockMessage(block));
  }
}

function blockMessage(block: MergeBlock): string {
  const list = (paths: string[]) => paths.slice(0, 3).join(", ") + (paths.length > 3 ? ` and ${paths.length - 3} more` : "");
  const parts: string[] = [];
  if (block.files.length) {
    parts.push(`${block.base} has uncommitted changes in ${list(block.files)}, which this branch also changes`);
  }
  if (block.untracked.length) {
    parts.push(`${block.base} has untracked ${list(block.untracked)}, which this branch creates`);
  }
  return `${parts.join("; ")} — commit or set them aside on ${block.base}, then merge again`;
}

/** The card, and the worktree on it — or the refusal, since every verb below needs both. */
export function worktreeOf(workspaceId: string, cardId: string): { card: Card; worktree: CardWorktree } {
  const found = workspaces.findCard(workspaceId, cardId);
  if (!found) throw new Error("no such card");
  if (!found.card.worktree) throw new Error("this card has no worktree");
  return { card: found.card, worktree: found.card.worktree };
}

/** The menu's opening question. */
export function cardStatus(workspaceId: string, cardId: string): Promise<WorktreeStatus> {
  return worktreeStatus(worktreeOf(workspaceId, cardId).worktree);
}

/** Commit everything in the card's worktree, with the card as the message. */
export async function commitCard(workspaceId: string, cardId: string): Promise<{ files: number }> {
  const { card, worktree } = worktreeOf(workspaceId, cardId);
  if (!worktreePresent(worktree.path)) throw new Error("the worktree is not there any more");
  const files = await commitAll(worktree.path, card.title, card.body);
  return { files: files.length };
}

/** Set the card's uncommitted work aside — see `stashAll` for why this is not a discard. */
export async function stashCard(workspaceId: string, cardId: string): Promise<{ files: number }> {
  const { card, worktree } = worktreeOf(workspaceId, cardId);
  if (!worktreePresent(worktree.path)) throw new Error("the worktree is not there any more");
  const files = await stashAll(worktree.path, card.title);
  return { files: files.length };
}

/**
 * Merge this card back, take its worktree down, and put the card in Done —
 * or hand back what stopped it, with nothing ended, when the stop is one the
 * card can ask the person about.
 */
export async function mergeCard(workspaceId: string, cardId: string, resolve?: MergeResolution): Promise<MergeReply> {
  const { card, worktree } = worktreeOf(workspaceId, cardId);
  let outcome: { commits: number; note: string | null };
  try {
    outcome = await retireCard(workspaceId, card, worktree, resolve);
  } catch (err) {
    if (err instanceof MergeBlocked && !resolve) return { blocked: err.block };
    throw err;
  }
  workspaces.editBoard(workspaceId, (board) => moveCard(board, cardId, "done"));
  return outcome;
}

/**
 * A shell in the card's worktree, beside the board — for whatever the four
 * verbs above do not cover. Any workspace of the profile on screen, for
 * `runCard`'s reason; off screen it lands beside that workspace's board, and
 * the profile's board takes the person to it.
 */
export async function openWorktree(workspaceId: string, cardId: string): Promise<{ agentId: string }> {
  const profileId = workspaces.active.id;
  const { worktree } = worktreeOf(workspaceId, cardId);
  if (!worktreePresent(worktree.path)) throw new Error("the worktree is not there any more");
  const target = workspaces.paneBesideBoardIn(profileId, workspaceId);
  if (!target) throw new Error("nowhere to put the terminal");
  const agent =
    workspaceId === workspaces.activeWorkspace.id
      ? await openTerminal(target, { cwd: worktree.path })
      : await openTerminalAt(profileId, workspaceId, target, { cwd: worktree.path });
  return { agentId: agent.id };
}
