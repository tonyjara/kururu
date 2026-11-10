/**
 * The automations' verbs: save, pause, run now, delete, and the history.
 *
 * One area of what a client can ask over its socket; `dispatch.ts` asks each
 * area in turn. Every verb is about the active profile's automations, the
 * way a workspace's verbs are about the active profile's workspaces, and is
 * replied to with what happened or why not. Strings are checked here and
 * nothing else is trusted: the definition's text goes through the same
 * parser a file does, and a workspace is named by an id the server looks up.
 */
import type { WebSocket } from "ws";
import type { ClientMessage } from "../../../shared/wire";
import { automations, type ClientState, workspaces } from "../context";
import { reply, replyAsync } from "./reply";

function clock() {
  if (!automations) throw new Error("Automations are not running on this server yet.");
  return automations;
}

function profileKey(): string {
  const key = workspaces.active.key;
  if (!key) throw new Error("This profile has no key yet.");
  return key;
}

function str(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length < 200;
}

export function automationVerbs(ws: WebSocket, _st: ClientState, msg: ClientMessage): boolean {
  switch (msg.type) {
    case "automation-save":
      reply(ws, msg.id, () => {
        if (typeof msg.text !== "string" || (msg.key !== null && !str(msg.key)) || !str(msg.workspaceId)) throw new Error("That is not an automation.");
        const workspace = workspaces.active.workspaces.find((w) => w.id === msg.workspaceId);
        if (!workspace?.key) throw new Error("That workspace is not in this profile.");
        return clock().save(profileKey(), workspace.key, msg.key, msg.text);
      });
      return true;

    case "automation-pause":
      reply(ws, msg.id, () => {
        if (!str(msg.key) || typeof msg.on !== "boolean") throw new Error("That is not an automation.");
        clock().setEnabled(profileKey(), msg.key, msg.on, msg.on ? null : "paused by you");
        return { ok: true };
      });
      return true;

    case "automation-pause-all":
      reply(ws, msg.id, () => ({ paused: clock().pauseAll(profileKey()) }));
      return true;

    case "automation-run":
      void replyAsync(ws, msg.id, async () => {
        if (!str(msg.key)) throw new Error("That is not an automation.");
        return clock().runNow(profileKey(), msg.key, "you");
      });
      return true;

    case "automation-delete":
      reply(ws, msg.id, () => {
        if (!str(msg.key)) throw new Error("That is not an automation.");
        clock().delete(profileKey(), msg.key);
        return { ok: true };
      });
      return true;

    case "automation-runs":
      reply(ws, msg.id, () => {
        if (!str(msg.key)) throw new Error("That is not an automation.");
        if (!clock().view(profileKey()).some((a) => a.key === msg.key)) throw new Error("That automation is not there any more.");
        return clock().runs(msg.key);
      });
      return true;

    case "automation-open":
      void replyAsync(ws, msg.id, async () => {
        if (!str(msg.key) || typeof msg.runId !== "number" || !Number.isFinite(msg.runId)) throw new Error("That is not a run.");
        return clock().openRun(profileKey(), msg.key, msg.runId);
      });
      return true;
  }
  return false;
}
