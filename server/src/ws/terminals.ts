/**
 * Terminals: opening and closing tabs, typing, the size a pane proposes, what a client is watching and the backlog it asks for.
 *
 * One area of what a client can ask over its socket, cut out of the switch
 * that was `index.ts`'s; `dispatch.ts` asks each area in turn and stops at
 * the one that answers. Each case is as it was, with `return true` where the
 * switch had `return`.
 */
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { launcherCommand, launcherFor } from "../../../shared/launchers";
import { activeAgent, BOARD_TAB, findPane, isBoardTab, isDocTab, isWebTab, terminalsOf } from "../../../shared/layout";
import { lazygitCommand, lazygitRun } from "../../../shared/lazygit";
import type { ClientMessage } from "../../../shared/wire";
import { type ClientState, host, launch, pushSnapshot, sendState, sleeper, snapshot, unread, workspaces } from "../context";
import { nvimCommand } from "../nvim";
import { recordInput, recordNote } from "../record";
import {
  agentCommand,
  agentOn,
  applySize,
  commandOn,
  endTerminal,
  noteLaunch,
  openQueue,
  openTerminal,
  pinOf,
  sendBacklog,
  syncWatched,
  workspaceRepo,
} from "../terminals";
import { replyAsync } from "./reply";

export function terminalVerbs(ws: WebSocket, st: ClientState, msg: ClientMessage): boolean {
  switch (msg.type) {
    case "new-tab": {
      // From a workspace row's menu, which may not be the workspace on screen:
      // there first, as `open-board` goes, so the tab opens where you can see it.
      const fromRow = typeof msg.workspaceId === "string";
      if (typeof msg.workspaceId === "string") workspaces.switchWorkspace(msg.workspaceId);
      const paneId = msg.paneId ?? workspaces.focusedPaneId;
      void replyAsync(ws, msg.id, async () => {
        /*
         * In a workspace pinned to a machine, everything the menu offers opens
         * there: the terminal through `pinnedShell`, nvim and the agents here,
         * typed into a session of their own in the pin's folder. A directory
         * sent with it is a place on this disk and keeps the tab here, as
         * `local` does.
         */
        const pin = msg.cwd === undefined && msg.local !== true ? pinOf(workspaces.active.id, workspaces.activeWorkspace.id) : undefined;
        if (msg.launcher !== undefined) {
          // Looked up, never built: the id is the only thing taken off the wire.
          // Switched-off rows are not refused — the setting trims a menu, and a
          // second client with a stale one is still asking for a real agent.
          const launcher = typeof msg.launcher === "string" ? launcherFor(msg.launcher, launch) : undefined;
          if (!launcher) throw new Error(`no such agent: ${String(msg.launcher)}`);
          // Named now, as a card's run is, so that the ledger knows whose it is
          // before it has said a word. See `usage/attribute.ts`.
          const at = { profileId: workspaces.active.id, workspaceId: workspaces.activeWorkspace.id };
          const sessionId = launcher.cli === "claude" ? randomUUID() : null;
          const sessionFlag = sessionId ? ` --session-id ${sessionId}` : "";
          if (pin) {
            const command = await agentOn(pin.machine, pin.workspaceName, pin.dir, launcher.cli, launcherCommand(launcher, launch) + sessionFlag);
            const agent = await openTerminal(paneId, { command, kind: "agent" });
            noteLaunch(agent.id, at.profileId, at.workspaceId, { program: launcher.cli, sessionId, machine: pin.machine.name, cwd: pin.dir });
            return agent;
          }
          const agent = await openTerminal(paneId, { cwd: msg.cwd, command: (await agentCommand(launcher)) + sessionFlag, kind: "agent" });
          noteLaunch(agent.id, at.profileId, at.workspaceId, { program: launcher.cli, sessionId, cwd: agent.cwd });
          return agent;
        }
        if (msg.nvim) {
          // The editor there, not this one: no socket for the reader to follow
          // it by, since the reader reads this disk.
          if (pin) return openTerminal(paneId, { command: await commandOn(pin.machine, pin.workspaceName, pin.dir, "nvim"), kind: "shell" });
          return openTerminal(paneId, { cwd: msg.cwd, command: nvimCommand(), kind: "shell" });
        }
        if (msg.lazygit) {
          if (pin) return openTerminal(paneId, { command: await commandOn(pin.machine, pin.workspaceName, pin.dir, lazygitRun(pin.machine.name)), kind: "shell" });
          const cwd = msg.cwd ?? (fromRow ? workspaceRepo(workspaces.activeWorkspace.id) : undefined);
          return openTerminal(paneId, { cwd, command: lazygitCommand(), kind: "shell" });
        }
        return openTerminal(paneId, { cwd: msg.cwd, command: msg.command, kind: msg.kind, local: msg.local === true });
      });
      return true;
    }

    case "close-tab": {
      const focused = findPane(workspaces.activeWorkspace.layout, workspaces.focusedPaneId);
      const agentId = msg.agentId ?? (focused ? activeAgent(focused) : null);
      // The board's tab is a view: closing it ends nothing, and the cards stay
      // on the workspace for the next `open-board`.
      if (isBoardTab(agentId)) workspaces.removeTab(BOARD_TAB);
      // A document is closed where it is showing — the only place the key can
      // mean — since the same one may be open in another pane.
      else if (isDocTab(agentId)) {
        if (focused && !msg.agentId) workspaces.closeDoc(focused.id, focused.activeIdx);
      } else if (isWebTab(agentId)) {
        // A page is a view of the window's: closing its tab ends no process
        // here, and the window that holds the page lets it go when the tab
        // leaves its layout. The pane goes with its last tab, `reapTab`'s rule.
        workspaces.reapTab(agentId);
      } else if (agentId) {
        // Closing a pane's last terminal closes the pane (`reapTab`), the same as
        // when its pty ends; the last pane of a workspace stays, empty.
        for (const id of terminalsOf([agentId])) endTerminal(id);
      }
      return true;
    }

    case "select-tab":
      workspaces.selectTab(msg.paneId, msg.index);
      return true;

    case "cycle-tab":
      workspaces.cycleTab(msg.delta, msg.paneId);
      return true;

    case "move-tab":
      workspaces.moveTab(msg.agentId, msg.paneId, msg.index);
      return true;

    case "split-with":
      workspaces.splitWith(msg.agentId, msg.paneId, msg.dir, msg.before);
      return true;

    case "move-tab-to-workspace":
      workspaces.moveTabToWorkspace(msg.agentId, msg.workspaceId);
      return true;

    case "reorder-agent": {
      // The base is the host's order, exactly as `snapshot` takes it, because
      // the list the drop was aimed at was drawn from that and a splice against
      // any other would land the row above a different neighbour.
      const profileId = workspaces.profileOf(msg.agentId);
      if (!profileId) return true;
      const mine = new Set(workspaces.agentsIn(profileId));
      const ids = host.agents.filter((agent) => mine.has(agent.id)).map((agent) => agent.id);
      workspaces.reorderAgent(msg.agentId, msg.beforeAgentId, ids);
      return true;
    }

    case "hide-agent":
      // No id check of its own: `setAgentHidden` finds the profile the terminal
      // is in and does nothing when there isn't one, which is the same answer a
      // guard here would give one line earlier.
      workspaces.setAgentHidden(msg.agentId, msg.hidden === true);
      return true;

    case "rename-tab":
      if (!isBoardTab(msg.agentId) && !isWebTab(msg.agentId)) host.rename(msg.agentId, msg.name);
      return true;

    case "input":
      // No reply: this is what the user typed, and it is either delivered or the
      // terminal is visibly dead already.
      recordInput(msg.agentId, msg.data);
      if (typeof msg.data === "string") sleeper.typed(msg.agentId, msg.data);
      host.write(msg.agentId, msg.data);
      return true;

    case "propose-size": {
      /**
       * A pane's opinion, not its decision. Checked to the same floor the host
       * checks to, so a box that has not been laid out cannot enter the
       * minimum: the smallest proposal wins, which makes a bad small one the
       * worst possible input this could take.
       */
      const { agentId, cols, rows } = msg;
      if (!Number.isInteger(cols) || !Number.isInteger(rows)) return true;
      if (cols < 2 || rows < 2) return true;
      st.proposals.set(agentId, { cols, rows });
      applySize(agentId);
      return true;
    }

    case "resync": {
      st.sent = null;
      if (!st.owedSnapshot) sendState([[ws, st]], snapshot());
      return true;
    }

    case "looking": {
      /**
       * Somebody arrived at this screen, or left it. The proposals are kept
       * either way and merely stop counting — see `ClientState.looking` — so
       * this is one recount over the terminals this client has an opinion
       * about, and a window coming back off another Space votes with the boxes
       * it already had rather than waiting to measure them again.
       */
      const looking = msg.looking !== false;
      if (looking === st.looking) return true;
      st.looking = looking;
      for (const agentId of st.proposals.keys()) applySize(agentId);
      return true;
    }

    case "watch": {
      const next = new Set(msg.agentIds);
      const kept = new Set(msg.warm ?? []);
      const opened = [...next].filter((id) => !st.watching.has(id));
      st.watching = next;
      st.warm = kept;
      /**
       * Withdraw the proposals for whatever this client can no longer see, and
       * decide those terminals again without them. This is how a pane closing
       * gives the size back — the other client watching the same agent stops
       * being held to a width nobody is drawing at, and a terminal with no
       * visible watcher left keeps the shape it had rather than being resized
       * by whoever merely has it pooled.
       */
      for (const id of [...st.proposals.keys()]) {
        if (next.has(id)) continue;
        st.proposals.delete(id);
        applySize(id);
      }
      // A pane that closed while its backlog was in flight should not receive it
      // — unless the emulator behind it is still pooled, in which case it is the
      // same emulator and the same question, merely off screen.
      for (const id of [...st.awaiting.keys()]) {
        if (!next.has(id) && !kept.has(id)) st.awaiting.delete(id);
      }
      syncWatched();
      /**
       * Streaming starts here and history does not. Watching says which
       * terminals are on screen; it is a set of ids and it cannot say how wide
       * any of them is, so answering it with a reconstruction meant serializing
       * a screen at whatever width the pane that last drew this terminal
       * happened to be. The emulator that is about to draw it asks for itself,
       * and says what shape it is while asking.
       */
      let seen = false;
      for (const id of opened) {
        recordNote(id, "watch", "a client opened this terminal");
        // Somebody is looking at it now, so whatever it wanted has been seen.
        // Opened, not merely warm: an emulator kept current in a workspace you
        // are not in is nobody reading it. The other way the mark comes off is
        // the terminal going back to work — see `noticeStatuses`.
        if (unread.delete(id)) seen = true;
      }
      if (seen) pushSnapshot();
      return true;
    }

    case "request-backlog":
      // Queue this terminal's live output behind the history: the client is
      // about to clear its emulator, and anything that overtakes the answer
      // would be wiped by it. `openQueue` counts rather than sets, so two
      // rebuilds in flight at once do not release each other's hold — rare now
      // that ordinary navigation rebuilds nothing, and kept because counting is
      // free and the bug it prevents is bytes the client never sees again.
      openQueue(st, msg.agentId);
      void sendBacklog(ws, msg.agentId);
      return true;

    /**
     * A notification was clicked. Take them to it — see `Workspaces.reveal` for
     * why the four moves are one method, and note the one thing this does *not*
     * do: nothing here raises the window. That is the desktop bridge's, because
     * only the process that owns a window can raise it, and the phone has no
     * window to raise.
     */
    case "reveal-agent":
      workspaces.reveal(msg.agentId);
      return true;
  }
  return false;
}
