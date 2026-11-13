/**
 * Kuru: its terminal, its restart and Auto Swap, and the drawer — what was seen, said and stopped, and the voice messages still on the disk.
 *
 * One area of what a client can ask over its socket, cut out of the switch
 * that was `index.ts`'s; `dispatch.ts` asks each area in turn and stops at
 * the one that answers. Each case is as it was, with `return true` where the
 * switch had `return`.
 */
import type { WebSocket } from "ws";
import { KURU_SAY_MAX } from "../../../shared/kuru";
import { isClipId } from "../../../shared/voice";
import type { ClientMessage } from "../../../shared/wire";
import { type ClientState, harness, kuru, outbox, voice, workspaces } from "../context";
import { nodeOfUtterance, peerKey } from "../peerkuru";
import { replyAsync } from "./reply";

export function kuruVerbs(ws: WebSocket, st: ClientState, msg: ClientMessage): boolean {
  switch (msg.type) {
    // The profile on screen is the one whose harness the button means; the
    // harness itself, once running, is not bound to what is on screen.
    case "open-harness": {
      const run = () =>
        harness.open(workspaces.active.id, { fresh: msg.fresh === true });
      // Asked with an id, the answer waits for a Kuru just started to be up
      // or to have died, so the drawer can say which. See `Harness.whenUp`.
      const ask = async () => {
        const opened = await run();
        if (opened.started) await harness.whenUp(opened.agentId);
        return { agentId: opened.agentId };
      };
      if (typeof msg.id === "number") void replyAsync(ws, msg.id, ask);
      else void run().catch((err: unknown) => console.error("kururu: could not open the harness:", err instanceof Error ? err.message : err));
      return true;
    }

    case "restart-harness":
      if (typeof msg.id !== "number") return true;
      void replyAsync(ws, msg.id, async () => {
        if (typeof msg.profileId !== "string" || !workspaces.profile(msg.profileId)) throw new Error("no such profile");
        return harness.restart(msg.profileId);
      });
      return true;

    case "set-auto-swap":
      if (typeof msg.profileId !== "string") return true;
      workspaces.setAutoSwap(msg.profileId, msg.on === true);
      return true;

    case "kuru-seen": {
      const key = typeof msg.profileId === "string" ? workspaces.keyOf(msg.profileId) : null;
      if (!key || !Array.isArray(msg.utterances)) return true;
      const ids = msg.utterances.filter((id): id is string => typeof id === "string" && id.length <= 80).slice(0, 200);
      // Another node's replies said here are on the list under that node's
      // key, and are read in the same drawer.
      const byKey = new Map<string, string[]>();
      for (const id of ids) {
        const node = nodeOfUtterance(id);
        const at = node ? peerKey(node) : key;
        byKey.set(at, [...(byKey.get(at) ?? []), id]);
      }
      for (const [at, some] of byKey) voice.seen(at, some);
      return true;
    }

    case "kuru-pin": {
      const key = typeof msg.profileId === "string" ? workspaces.keyOf(msg.profileId) : null;
      if (key) kuru.pin(key, msg.id, msg.pinned === true);
      return true;
    }

    case "kuru-tag": {
      const key = typeof msg.profileId === "string" ? workspaces.keyOf(msg.profileId) : null;
      if (key) kuru.tag(key, msg.id, msg.workspaceKey, msg.kept === true);
      return true;
    }

    case "kuru-say": {
      const key = typeof msg.profileId === "string" ? workspaces.keyOf(msg.profileId) : null;
      const text = typeof msg.text === "string" ? msg.text.trim().slice(0, KURU_SAY_MAX) : "";
      if (!key || !isClipId(msg.id) || !text) return true;
      const at = typeof msg.at === "number" && Number.isFinite(msg.at) && msg.at > 0 ? msg.at : Date.now();
      outbox.say(key, msg.id, at, text);
      return true;
    }

    case "kuru-stop":
      if (typeof msg.profileId === "string" && workspaces.profile(msg.profileId)) void harness.interrupt(msg.profileId);
      return true;

    case "voice-resend":
      if (isClipId(msg.id)) outbox.resend(msg.id);
      return true;

    case "voice-discard":
      if (isClipId(msg.id)) outbox.discard(msg.id);
      return true;
  }
  return false;
}
