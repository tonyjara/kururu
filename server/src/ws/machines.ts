/**
 * Machines reached over ssh: adding and removing one, its specs, and a shell on it.
 *
 * One area of what a client can ask over its socket, cut out of the switch
 * that was `index.ts`'s; `dispatch.ts` asks each area in turn and stops at
 * the one that answers. Each case is as it was, with `return true` where the
 * switch had `return`.
 */
import type { WebSocket } from "ws";
import { remoteShellCommand } from "../../../shared/machines";
import type { ClientMessage } from "../../../shared/wire";
import { broadcast, type ClientState, workspaces } from "../context";
import { addMachine, findMachine, machinesSnapshot, pollMachine, removeMachine } from "../machines";
import { addHistory, adoptSpecs, editHistory, forgetSpecsRun, readSpecs, removeHistory, setTyped } from "../specs";
import { broadcastSpecs } from "../sweeps";
import { openTerminal } from "../terminals";
import { reply, replyAsync } from "./reply";

export function machineVerbs(ws: WebSocket, st: ClientState, msg: ClientMessage): boolean {
  switch (msg.type) {
    case "add-machine":
      reply(ws, msg.id, () => {
        const entry = addMachine(msg);
        adoptSpecs(entry, machinesSnapshot());
        broadcast({ type: "machines", machines: machinesSnapshot() });
        broadcastSpecs();
        void pollMachine(entry.id).then(() => broadcast({ type: "machines", machines: machinesSnapshot() }));
        return entry;
      });
      return true;

    case "remove-machine":
      if (typeof msg.machineId !== "string") return true;
      removeMachine(msg.machineId);
      forgetSpecsRun(msg.machineId);
      workspaces.unpinMachine(msg.machineId);
      broadcast({ type: "machines", machines: machinesSnapshot() });
      broadcastSpecs();
      return true;

    case "set-specs": {
      const machine = typeof msg.machineId === "string" ? findMachine(msg.machineId) : undefined;
      if (!machine) return true;
      try {
        setTyped(machine, msg.key, msg.value);
      } catch {
        return true;
      }
      broadcastSpecs();
      return true;
    }

    case "specs-history":
      reply(ws, msg.id, () => {
        const machine = typeof msg.machineId === "string" ? findMachine(msg.machineId) : undefined;
        if (!machine) throw new Error("That machine is not in the list any more.");
        if (msg.op === "add") addHistory(machine, msg.date ?? "", msg.text);
        else if (msg.op === "edit") editHistory(machine, msg.entryId, { date: msg.date, text: msg.text });
        else if (msg.op === "remove") removeHistory(machine, msg.entryId);
        else throw new Error("Not something the history does.");
        broadcastSpecs();
        return { ok: true };
      });
      return true;

    case "read-specs":
      void replyAsync(ws, msg.id, async () => {
        const machine = typeof msg.machineId === "string" ? findMachine(msg.machineId) : undefined;
        if (!machine) throw new Error("That machine is not in the list any more.");
        const error = await readSpecs(machine, broadcastSpecs);
        if (error) throw new Error(error);
        return { ok: true };
      });
      return true;

    case "open-machine-shell": {
      const paneId = msg.paneId ?? workspaces.focusedPaneId;
      void replyAsync(ws, msg.id, () => {
        const machine = typeof msg.machineId === "string" ? findMachine(msg.machineId) : undefined;
        if (!machine) throw new Error("That machine is not in the list any more.");
        return openTerminal(paneId, { command: remoteShellCommand({ host: machine.host }), kind: "shell" });
      });
      return true;
    }
  }
  return false;
}
