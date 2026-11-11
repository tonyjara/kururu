/**
 * A card's dev server: the project's dev line, run in the card's worktree on
 * a port the kernel picked, as a terminal of its own beside the agent working
 * there.
 *
 * Apart from `cards.ts` because it is a different lifetime — a run starts it,
 * but the card's ↻ restarts it and the board's ■ stops it with no agent in
 * the picture — and because it is the one place a card opens a terminal that
 * is not an agent.
 */
import { createServer as createNetServer } from "node:net";
import { type Card, type CardWorktree, setDev } from "../../shared/board";
import { BOARD_TAB, paneWithAgent } from "../../shared/layout";
import { projectSettingsFor } from "../../shared/projects";
import { worktreeOf } from "./cards";
import { host, projects, workspaces } from "./context";
import { killAll, openTerminal, openTerminalAt } from "./terminals";
import { copyEnvFiles, worktreePresent } from "./worktree";
import { shq } from "../../shared/text";

/**
 * A port nothing is listening on, from the kernel: bind port 0, read what it
 * gave, let it go. There is a window between the close and the dev server's
 * own bind, and it is the same window every "find me a free port" has; the
 * alternative — counting up from 3000 — is a guess about the machine, and
 * `devservers.ts` states the rule against those.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error("the kernel gave no port"))));
    });
  });
}

/** Whether the card's dev server still has a terminal open — running or ended, it is still a tab. */
export function devOpen(card: Card): boolean {
  const agentId = card.dev?.agentId;
  return agentId != null && host.agents.some((agent) => agent.id === agentId);
}

/**
 * Where a card's dev server goes: the lower half, as every terminal does
 * (`shared/halves.ts`), which is where the agent it was started for is about
 * to go — the server goes in first, so the agent is the tab left showing.
 * It used to follow the last dev server's pane, else the newest terminal's,
 * which put it in the upper half whenever that is where a terminal was. The
 * card's own workspace, which the profile's board means need not be the one
 * on screen.
 */
function devPane(workspaceId: string): string | null {
  return workspaces.paneForIn(workspaces.active.id, workspaceId, "lower");
}

/**
 * Open the card's dev server: the project's dev line in the worktree, in a
 * terminal of its own, with a free port in `PORT`. `export` rather than the
 * pty's environment because the host would have to be taught a new variable
 * to pass, and restarting the host ends every agent; the login shell's line
 * does the same job. `ready` is the setup marker `runCard` explains — the
 * server waits for it, and says so, rather than starting against a checkout
 * with no dependencies in it. `pane` is where a restart puts it back.
 */
export async function startDev(
  workspaceId: string,
  card: Card,
  worktree: CardWorktree,
  dev: string,
  ready: string | null,
  pane?: string,
): Promise<{ agentId: string; port: number }> {
  const profileId = workspaces.active.id;
  const target = pane && workspaces.hasPaneIn(profileId, workspaceId, pane) ? pane : devPane(workspaceId);
  if (!target) throw new Error("nowhere to put the dev server");
  // A worktree made before env files were copied in gets them here, on its
  // next start; one made since already has them and nothing is overwritten.
  await copyEnvFiles(worktree.root, worktree.path);
  const port = await freePort();
  const wait = ready
    ? `echo 'waiting for the setup line in the agent’s terminal…'; until [ -e ${shq(ready)} ]; do sleep 1; done; rm -f ${shq(ready)}; `
    : "";
  const options = { cwd: worktree.path, command: `${wait}export PORT=${port}; ${dev}`, kind: "shell" as const };
  const agent =
    workspaceId === workspaces.activeWorkspace.id
      ? await openTerminal(target, options)
      : await openTerminalAt(profileId, workspaceId, target, options);
  host.rename(agent.id, `dev · ${card.title}`.slice(0, 80));
  workspaces.editBoard(workspaceId, (board) => setDev(board, card.id, { agentId: agent.id, port }));
  return { agentId: agent.id, port };
}

/** End the card's dev server and close its tab, if it has one. */
export function stopDev(workspaceId: string, cardId: string): void {
  const found = workspaces.findCard(workspaceId, cardId);
  const agentId = found?.card.dev?.agentId;
  if (agentId && host.agents.some((agent) => agent.id === agentId)) killAll([agentId]);
  if (found?.card.dev) workspaces.editBoard(workspaceId, (board) => setDev(board, cardId, null));
}

/**
 * The card's ↻: end its dev server and start it again, in the pane it was in —
 * or start one for the first time, which is the same button on a card whose
 * server was never started or has been stopped. Any workspace of the profile
 * on screen, for `runCard`'s reason, and only a card with a worktree and a
 * project with a dev line; on screen, the focus goes back to the board.
 */
export async function restartDev(workspaceId: string, cardId: string): Promise<{ agentId: string; port: number }> {
  const workspace = workspaces.workspaceIn(workspaces.active.id, workspaceId);
  if (!workspace) throw new Error("no such workspace");
  const onScreen = workspaceId === workspaces.activeWorkspace.id;
  const { card, worktree } = worktreeOf(workspaceId, cardId);
  if (!worktreePresent(worktree.path)) throw new Error("the worktree is not there any more");
  const dev = projectSettingsFor(projects, worktree.root).dev;
  if (!dev) throw new Error("this project has no dev server line — Settings → Workspaces");
  const old = card.dev?.agentId;
  const pane = old ? paneWithAgent(workspace.layout, old)?.id : undefined;
  stopDev(workspaceId, cardId);
  const boardPane = paneWithAgent(workspace.layout, BOARD_TAB)?.id;
  const started = await startDev(workspaceId, card, worktree, dev, null, pane);
  if (onScreen && boardPane && workspaces.hasPane(boardPane)) workspaces.focusPane(boardPane);
  return started;
}
