/**
 * The boards: a workspace's and the profile's, their cards and columns, a card's run and its worktree, its dev server, a deleted card back, and the workspace's git menu.
 *
 * One area of what a client can ask over its socket, cut out of the switch
 * that was `index.ts`'s; `dispatch.ts` asks each area in turn and stops at
 * the one that answers. Each case is as it was, with `return true` where the
 * switch had `return`.
 */
import type { WebSocket } from "ws";
import {
  addCard,
  addLane,
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
} from "../../../shared/board";
import { findLauncher } from "../../../shared/launchers";
import { type ClientMessage, COMMIT_MESSAGE_MAX, GIT_ACTIONS } from "../../../shared/wire";
import { restartDev, stopDev } from "../carddev";
import { cardStatus, commitCard, mergeCard, openWorktree, resumeCard, runCard, stashCard } from "../cards";
import { type ClientState, store, workspaces } from "../context";
import { workspaceGit } from "../repostatus";
import { stopListedDevServer } from "../sweeps";
import { reply, replyAsync } from "./reply";

export function boardVerbs(ws: WebSocket, st: ClientState, msg: ClientMessage): boolean {
  switch (msg.type) {
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
      return true;

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
      return true;

    case "open-board":
      // From a workspace row, which may not be the workspace on screen: it
      // goes there first, since a board is only ever opened where you can see
      // it — see `openBoardFromRow` for where in it.
      if (typeof msg.workspaceId === "string") {
        workspaces.openBoardFromRow(msg.workspaceId);
        return true;
      }
      workspaces.openBoard(msg.paneId ?? workspaces.focusedPaneId, msg.here === true);
      return true;

    case "add-card":
      workspaces.editBoard(msg.workspaceId, (board) =>
        addCard(board, { title: msg.title, body: msg.body, column: msg.column, isolate: msg.isolate }, mintCardId(), Date.now()),
      );
      return true;

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
      return true;

    case "edit-card":
      workspaces.editBoard(msg.workspaceId, (board) =>
        editCard(board, msg.cardId, { title: msg.title, body: msg.body, isolate: msg.isolate, dates: msg.dates }),
      );
      return true;

    case "move-card":
      workspaces.editBoard(msg.workspaceId, (board) => moveCard(board, msg.cardId, msg.column, msg.index));
      // A finished card is not being looked at: its server goes, whichever
      // road it took to Done — the merge, or "Just move".
      if (msg.column === "done") stopDev(msg.workspaceId, msg.cardId);
      return true;

    /*
     * Deleting a card does not touch its agent. The card is a note about the
     * work; the terminal is the work, with its own ✕ — and ending somebody's
     * agent because they tidied a list is the accident `hide-agent` exists to
     * keep apart from `close-tab`.
     */
    case "delete-card":
      workspaces.editBoard(msg.workspaceId, (board) => removeCard(board, msg.cardId));
      return true;

    case "resize-column":
      workspaces.editBoard(msg.workspaceId, (board) => resizeLane(board, msg.column, msg.width));
      return true;

    // The profile's board. Nothing on it runs, so these are the pure functions
    // and nothing else — no agent to end on Done and no worktree to ask about.
    // The column is held to the ones the board has by the pure functions
    // themselves, since the board is what knows its columns.
    case "add-profile-card":
      workspaces.editProfileBoard(msg.profileId, (board) =>
        addCard(board, { title: msg.title, body: msg.body, column: msg.column, dates: msg.dates }, mintCardId(), Date.now()),
      );
      return true;

    case "edit-profile-card":
      workspaces.editProfileBoard(msg.profileId, (board) =>
        editCard(board, msg.cardId, { title: msg.title, body: msg.body, dates: msg.dates }),
      );
      return true;

    case "move-profile-card":
      workspaces.editProfileBoard(msg.profileId, (board) => moveCard(board, msg.cardId, msg.column, msg.index));
      return true;

    case "delete-profile-card":
      workspaces.editProfileBoard(msg.profileId, (board) => removeCard(board, msg.cardId));
      return true;

    case "add-profile-column":
      workspaces.editProfileBoard(msg.profileId, (board) => addLane(board, msg.name, mintLaneId()));
      return true;

    case "rename-profile-column":
      workspaces.editProfileBoard(msg.profileId, (board) => renameLane(board, msg.columnId, msg.name));
      return true;

    case "set-profile-column-color":
      workspaces.editProfileBoard(msg.profileId, (board) => colorLane(board, msg.columnId, msg.color));
      return true;

    case "set-profile-column-collapsed":
      workspaces.editProfileBoard(msg.profileId, (board) => collapseLane(board, msg.columnId, msg.collapsed));
      return true;

    case "move-profile-column":
      workspaces.editProfileBoard(msg.profileId, (board) => moveLane(board, msg.columnId, msg.index));
      return true;

    case "delete-profile-column":
      workspaces.editProfileBoard(msg.profileId, (board) => removeLane(board, msg.columnId));
      return true;

    case "resize-profile-column":
      workspaces.editProfileBoard(msg.profileId, (board) => resizeLane(board, msg.columnId, msg.width));
      return true;

    case "send-profile-card":
      if (typeof msg.cardId !== "string" || typeof msg.workspaceId !== "string") return true;
      workspaces.sendProfileCard(msg.profileId, msg.cardId, msg.workspaceId);
      return true;

    case "run-card":
      void replyAsync(ws, msg.id, () => runCard(msg.workspaceId, msg.cardId, msg.launcher, msg.fresh === true));
      return true;

    case "resume-card":
      void replyAsync(ws, msg.id, () => resumeCard(msg.workspaceId, msg.cardId));
      return true;

    case "worktree-status":
      void replyAsync(ws, msg.id, () => cardStatus(msg.workspaceId, msg.cardId));
      return true;

    case "commit-card":
      void replyAsync(ws, msg.id, () => commitCard(msg.workspaceId, msg.cardId));
      return true;

    case "stash-card":
      void replyAsync(ws, msg.id, () => stashCard(msg.workspaceId, msg.cardId));
      return true;

    case "merge-card":
      void replyAsync(ws, msg.id, () =>
        mergeCard(msg.workspaceId, msg.cardId, msg.resolve === "commit" || msg.resolve === "stash" ? msg.resolve : undefined),
      );
      return true;

    case "open-worktree":
      void replyAsync(ws, msg.id, () => openWorktree(msg.workspaceId, msg.cardId));
      return true;

    case "restart-card-dev":
      void replyAsync(ws, msg.id, () => restartDev(msg.workspaceId, msg.cardId));
      return true;

    case "stop-card-dev":
      void replyAsync(ws, msg.id, async () => stopDev(msg.workspaceId, msg.cardId));
      return true;

    case "stop-dev-server":
      void replyAsync(ws, msg.id, () => stopListedDevServer(msg.port, msg.pid));
      return true;

    case "workspace-git": {
      if (!(GIT_ACTIONS as readonly string[]).includes(msg.action)) return true;
      const message = typeof msg.message === "string" ? msg.message.slice(0, COMMIT_MESSAGE_MAX) : "";
      void replyAsync(ws, msg.id, () => workspaceGit(msg.workspaceId, String(msg.root), msg.action, message));
      return true;
    }
  }
  return false;
}
