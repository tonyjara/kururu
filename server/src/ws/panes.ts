/**
 * Panes: splitting, closing, focus and moving between them, and the dividers.
 *
 * One area of what a client can ask over its socket, cut out of the switch
 * that was `index.ts`'s; `dispatch.ts` asks each area in turn and stops at
 * the one that answers. Each case is as it was, with `return true` where the
 * switch had `return`.
 */
import type { WebSocket } from "ws";
import type { ClientMessage } from "../../../shared/wire";
import { type ClientState, workspaces } from "../context";
import { fillPane, killAll } from "../terminals";

export function paneVerbs(ws: WebSocket, st: ClientState, msg: ClientMessage): boolean {
  switch (msg.type) {
    case "split": {
      // The half you were in is where the new one's directory comes from: it has
      // a terminal in it that can be asked where it is now, which is better than
      // the directory the pane was recorded as being for.
      const from = msg.paneId ?? workspaces.focusedPaneId;
      const fresh = workspaces.split(msg.dir, from);
      if (fresh) fillPane(fresh, from);
      return true;
    }

    case "close-pane":
      killAll(workspaces.closePane(msg.paneId));
      return true;

    case "focus-pane":
      workspaces.focusPane(msg.paneId);
      return true;

    case "focus-dir":
      workspaces.focusDirection(msg.dir);
      return true;

    case "step-pane":
      workspaces.stepFocus(msg.delta);
      return true;

    case "last-pane":
      workspaces.lastPane();
      return true;

    case "set-ratio":
      workspaces.setRatio(msg.splitId, msg.ratio);
      return true;

    case "nudge":
      workspaces.nudge(msg.dir, msg.delta);
      return true;

    case "swap-panes":
      workspaces.swapPanes(msg.paneId, msg.withPaneId);
      return true;

    case "move-pane":
      workspaces.movePane(msg.paneId, msg.toPaneId, msg.dir, msg.before);
      return true;

    case "merge-panes":
      workspaces.mergePanes(msg.paneId, msg.intoPaneId);
      return true;
  }
  return false;
}
