/**
 * The voice in a page — its settings, a preview, the model, a talk key held — and the window reload, which waits on speech as much as on anything.
 *
 * One area of what a client can ask over its socket, cut out of the switch
 * that was `index.ts`'s; `dispatch.ts` asks each area in turn and stops at
 * the one that answers. Each case is as it was, with `return true` where the
 * switch had `return`.
 */
import type { WebSocket } from "ws";
import { isReloadHold, isReloadPage } from "../../../shared/reload";
import type { ClientMessage } from "../../../shared/wire";
import { type ClientState, reloads, voice } from "../context";
import { replyAsync } from "./reply";

export function voiceVerbs(ws: WebSocket, st: ClientState, msg: ClientMessage): boolean {
  switch (msg.type) {
    case "set-voice":
      voice.set(msg.voice);
      return true;

    case "voice-preview":
      void replyAsync(ws, msg.id, () => {
        const lang = msg.lang === "es" ? "es" : "en";
        const choice = msg.voice;
        if (!choice || (choice.engine !== "kokoro" && choice.engine !== "lab" && choice.engine !== "system") || typeof choice.voice !== "string") throw new Error("not a voice");
        return voice.preview({ engine: choice.engine, voice: choice.voice.slice(0, 80) }, lang);
      });
      return true;

    case "download-voice-model":
      void voice.download();
      return true;

    case "talking":
      voice.talk(ws, msg.talking === true);
      return true;

    case "reloadable": {
      if (!isReloadPage(msg.page)) return true;
      const reloaded = Array.isArray(msg.reloaded) ? msg.reloaded.filter((id): id is string => typeof id === "string").slice(0, 16) : [];
      reloads.declare(ws, msg.page, reloaded);
      return true;
    }

    case "reload-held":
      if (!Array.isArray(msg.ids) || !Array.isArray(msg.holds)) return true;
      reloads.held(ws, msg.ids.filter((id): id is string => typeof id === "string"), msg.holds.filter(isReloadHold));
      return true;

    case "reloading":
      if (!Array.isArray(msg.ids)) return true;
      reloads.reloading(ws, msg.ids.filter((id): id is string => typeof id === "string"));
      return true;

    case "speech-held":
      if (typeof msg.utterance === "string") voice.held(ws, msg.utterance, msg.held === true);
      return true;

    case "speech-played":
      if (typeof msg.utterance === "string" && typeof msg.seq === "number") voice.played(msg.utterance, msg.seq);
      return true;
  }
  return false;
}
