/**
 * Workspaces: making, switching, naming, grouping and deleting them, a pin to a machine, a project's settings, and the worktrees a workspace's cards leave behind.
 *
 * One area of what a client can ask over its socket, cut out of the switch
 * that was `index.ts`'s; `dispatch.ts` asks each area in turn and stops at
 * the one that answers. Each case is as it was, with `return true` where the
 * switch had `return`.
 */
import type { WebSocket } from "ws";
import { validRemoteDir } from "../../../shared/machines";
import type { ClientMessage } from "../../../shared/wire";
import { retireWorktrees } from "../cards";
import { type ClientState, workspaces } from "../context";
import { saveProject } from "../look";
import { findMachine } from "../machines";
import { fillPane, killAll } from "../terminals";
import { reply, replyAsync } from "./reply";

export function workspaceVerbs(ws: WebSocket, st: ClientState, msg: ClientMessage): boolean {
  switch (msg.type) {
    case "new-workspace":
      // A workspace is one piece of work, so its first terminal starts in the
      // directory a terminal opened in it would: `cwdForNewTab` finds nothing
      // here to follow, which is the honest answer for work not started yet.
      workspaces.newWorkspace(msg.name);
      fillPane(workspaces.focusedPaneId);
      return true;

    case "switch-workspace":
      workspaces.switchWorkspace(msg.workspaceId);
      return true;

    case "workspace-index":
      workspaces.switchWorkspaceByIndex(msg.index);
      return true;

    case "step-workspace":
      workspaces.stepWorkspace(msg.delta);
      return true;

    case "last-workspace":
      workspaces.lastWorkspace();
      return true;

    case "open-dashboard":
      workspaces.openDashboard(msg.tab);
      return true;

    case "rename-workspace":
      workspaces.renameWorkspace(msg.workspaceId, msg.name);
      return true;

    case "set-workspace-mascot":
      workspaces.setWorkspaceMascot(msg.workspaceId, msg.mascotId);
      return true;

    case "set-project":
      saveProject(msg.root, msg.settings);
      return true;

    case "retire-worktrees":
      void replyAsync(ws, msg.id, () => retireWorktrees(msg.root));
      return true;

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
      return true;

    case "delete-workspace":
      killAll(workspaces.deleteWorkspace(msg.workspaceId));
      return true;

    case "move-workspace":
      workspaces.moveWorkspace(msg.workspaceId, msg.index);
      return true;

    case "set-workspace-group":
      workspaces.setWorkspaceGroup(msg.workspaceId, msg.group);
      return true;

    case "rename-workspace-group":
      workspaces.renameWorkspaceGroup(msg.from, msg.to);
      return true;

    case "move-workspace-group":
      workspaces.moveWorkspaceGroup(msg.group, msg.onto);
      return true;
  }
  return false;
}
