/**
 * The reader and the editors: documents in panes, the file tree's reads, an editor to open a file in, what an agent made, and closing or ending nvims.
 *
 * One area of what a client can ask over its socket, cut out of the switch
 * that was `index.ts`'s; `dispatch.ts` asks each area in turn and stops at
 * the one that answers. Each case is as it was, with `return true` where the
 * switch had `return`.
 */
import type { WebSocket } from "ws";
import type { ClientMessage } from "../../../shared/wire";
import { type ClientState, workspaces } from "../context";
import { closeNvims, editorsHere, hookEditor, killNvims, openInEditor, readForWatcher, rootForDir } from "../editors";
import { resolveInRoot } from "../files";
import { openMade } from "../madelinks";
import { replyAsync } from "./reply";

export function readerVerbs(ws: WebSocket, st: ClientState, msg: ClientMessage): boolean {
  switch (msg.type) {
    case "open-reader": {
      const paneId = msg.paneId ?? workspaces.focusedPaneId;
      const agentId = msg.agentId ?? workspaces.activeAgentIn(paneId);
      /**
       * The project comes from where the pane already is, and from what the
       * pane *remembers* rather than from the kernel: `cwdForNewTab` asks lsof
       * because a new terminal landing in `~` all afternoon is a real cost, and
       * here the worst case of being a directory behind is a picker that opens
       * on the project list. That is not worth an async spawn on a keypress.
       */
      const made = workspaces.openReader(paneId, agentId, rootForDir(workspaces.cwdFor(paneId)));
      if (!made) return true;
      if (msg.focus) workspaces.focusPane(made);
      // Ahead of the sweep, because the pane is on screen now and a reader that
      // is blank for two seconds reads as one that does not work.
      if (agentId) void hookEditor(agentId);
      return true;
    }

    case "pin-reader":
      workspaces.pinReader(msg.paneId, msg.follow);
      return true;

    case "select-doc":
    case "close-doc":
      // An index off the wire, and `agentIds[NaN]` is merely undefined — but a
      // fraction or a negative is not a tab either, and saying so here keeps the
      // model from ever being asked.
      if (!Number.isInteger(msg.index) || msg.index < 0) return true;
      if (msg.type === "select-doc") workspaces.selectDoc(msg.paneId, msg.index);
      else workspaces.closeDoc(msg.paneId, msg.index);
      return true;

    case "move-doc":
      if (!Number.isInteger(msg.index) || msg.index < 0) return true;
      if (msg.at !== undefined && (!Number.isInteger(msg.at) || msg.at < 0)) return true;
      workspaces.moveDoc(msg.fromPaneId, msg.index, msg.toPaneId, msg.at);
      return true;

    case "split-with-doc":
      if (!Number.isInteger(msg.index) || msg.index < 0) return true;
      if (msg.dir !== "row" && msg.dir !== "col") return true;
      workspaces.splitWithDoc(msg.fromPaneId, msg.index, msg.paneId, msg.dir, msg.before === true);
      return true;

    case "show-doc": {
      // `open-doc`'s check, for the same reason: a path that does not resolve is
      // a click that does nothing, not a reader blanked by a refusal.
      if (!resolveInRoot(msg.root, msg.path)) return true;
      const shown = workspaces.showDoc(msg.root, msg.path);
      if (shown && msg.focus) workspaces.focusPane(shown);
      return true;
    }

    case "find-editors":
      void replyAsync(ws, msg.id, () => editorsHere());
      return true;

    case "open-in-editor": {
      // `open-made`'s rule for the line: a whole one or none.
      const line = Number.isInteger(msg.line) && (msg.line as number) > 0 ? (msg.line as number) : null;
      const paneId = typeof msg.paneId === "string" ? msg.paneId : undefined;
      void replyAsync(ws, msg.id, () => openInEditor(msg.root, msg.path, msg.agentId, { paneId, line }));
      return true;
    }

    case "open-made": {
      if (typeof msg.root !== "string" || typeof msg.path !== "string") return true;
      // `Number.isFinite`'s rule, and a whole line or none: nvim's `+N` is
      // the only place this number goes.
      const line = Number.isInteger(msg.line) && (msg.line as number) > 0 ? (msg.line as number) : null;
      const workspaceId = typeof msg.workspaceId === "string" ? msg.workspaceId : null;
      void replyAsync(ws, msg.id, () => openMade(msg.root, msg.path, line, workspaceId, msg.focus === true));
      return true;
    }

    case "files-ask":
    case "doc-ask":
      // The parent's reads of this disk, for its window. A page has the
      // HTTP routes and is not answered here; the roots are this node's own,
      // checked by `files.ts` exactly as those routes check them.
      if (!st.watcher || typeof msg.root !== "string") return true;
      void replyAsync(ws, msg.id, () => readForWatcher(msg));
      return true;

    case "close-nvims":
      void replyAsync(ws, msg.id, () => closeNvims(msg.ids));
      return true;

    case "kill-nvims":
      void replyAsync(ws, msg.id, () => killNvims(msg.ids));
      return true;

    case "open-doc":
      /**
       * Checked where every path from a client is checked, and a pick that does
       * not resolve is simply not made: the pane keeps the document it had. A
       * refusal that blanked the reader would read as the feature being broken
       * rather than as a refusal, which is the argument `set-profile-column-color`
       * makes about a colour it will not take.
       */
      if (!resolveInRoot(msg.root, msg.path)) return true;
      if (msg.at !== undefined && (!Number.isInteger(msg.at) || msg.at < 0)) return true;
      if (workspaces.openDoc(msg.paneId, msg.root, msg.path, msg.at) && msg.focus) workspaces.focusPane(msg.paneId);
      return true;

    case "split-with-file":
      if (!resolveInRoot(msg.root, msg.path)) return true;
      if (msg.dir !== "row" && msg.dir !== "col") return true;
      workspaces.splitWithFile(msg.root, msg.path, msg.paneId, msg.dir, msg.before === true);
      return true;
  }
  return false;
}
