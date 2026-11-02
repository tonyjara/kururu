/**
 * The outside services kururu holds a key or a token for: OpenRouter, the web providers, a channel's bot, and the backup's remote.
 *
 * One area of what a client can ask over its socket, cut out of the switch
 * that was `index.ts`'s; `dispatch.ts` asks each area in turn and stops at
 * the one that answers. Each case is as it was, with `return true` where the
 * switch had `return`.
 */
import type { WebSocket } from "ws";
import { isChannelKind } from "../../../shared/channels";
import { webKind } from "../../../shared/secrets";
import type { ClientMessage } from "../../../shared/wire";
import { backup, broadcast, channels, type ClientState, lead, secrets, workspaces } from "../context";
import { clearOpenRouterKey, setOpenRouterKey } from "../openrouter";
import { web } from "../sweeps";
import { webFieldKind } from "../thisnode";
import { channelFor, reply, replyAsync } from "./reply";

export function serviceVerbs(ws: WebSocket, st: ClientState, msg: ClientMessage): boolean {
  switch (msg.type) {
    case "set-openrouter-key":
      void replyAsync(ws, msg.id, async () => {
        secrets.refuseIfHeld("openrouter");
        const status = await setOpenRouterKey(msg.key);
        broadcast({ type: "openrouter", openrouter: status });
        return status;
      });
      return true;

    case "clear-openrouter-key":
      if (secrets.heldFrom("openrouter")) return true;
      clearOpenRouterKey();
      broadcast({ type: "openrouter", openrouter: null });
      return true;

    // Each broadcasts the status itself; the replies are for the page that asked.
    case "set-web":
      reply(ws, msg.id, () => {
        if (msg.order !== undefined) web.setOrder(msg.order);
        return msg.pageLimit !== undefined ? web.setPageLimit(msg.pageLimit) : web.status();
      });
      return true;

    case "set-web-provider":
      void replyAsync(ws, msg.id, async () => {
        if (msg.enabled !== undefined) web.setEnabled(msg.provider, msg.enabled);
        // A held provider's address and key are the parent's; a number — the
        // cloud's daily budget — is this node's own spending, and stays.
        if (msg.field !== undefined && typeof msg.provider === "string" && webFieldKind(msg.provider, msg.field) !== "number") secrets.refuseIfHeld(webKind(msg.provider));
        return msg.field !== undefined ? web.setField(msg.provider, msg.field, msg.value) : web.status();
      });
      return true;

    case "clear-web-provider-field":
      reply(ws, msg.id, () => {
        if (typeof msg.provider === "string" && webFieldKind(msg.provider, msg.field) !== "number") secrets.refuseIfHeld(webKind(msg.provider));
        return web.clearField(msg.provider, msg.field);
      });
      return true;

    case "test-web-provider":
      void replyAsync(ws, msg.id, () => web.test(msg.provider));
      return true;

    // Each names its kind, and only Telegram is one; the rest is the
    // channel's own to check, and each refusal is a sentence for the page.
    case "channel-token":
      void replyAsync(ws, msg.id, async () => {
        secrets.refuseIfHeld("telegram");
        return channelFor(msg.kind).setToken(msg.token);
      });
      return true;

    case "channel-forget":
      if (isChannelKind(msg.kind) && !secrets.heldFrom("telegram")) channelFor(msg.kind).forget();
      return true;

    case "channel-set":
      void replyAsync(ws, msg.id, async () => {
        const change: { enabled?: boolean; profileKey?: string | null; speakReplies?: boolean } = {};
        // A shared channel's switch is every node's, and flipped for all of
        // them at once by a signed flip (`lead.ts`); this node polls the bot
        // for the others only while the rank says so. A token held from a
        // parent too old to share the chat is that parent's bot alone.
        if (typeof msg.enabled === "boolean") {
          if (channels.telegram.isShared && lead) lead.flip(msg.enabled);
          else {
            const held = secrets.heldFrom("telegram");
            if (held) throw new Error(`This bot is ${held.from}'s, and its kururu is too old to share the chat: turn the channel on or off in ${held.from}'s Settings → Channels, or update it.`);
            change.enabled = msg.enabled;
          }
        }
        if (typeof msg.speakReplies === "boolean") change.speakReplies = msg.speakReplies;
        if (msg.profileId === null) change.profileKey = null;
        else if (typeof msg.profileId === "string") {
          const key = workspaces.keyOf(msg.profileId);
          if (!key) throw new Error("That profile is gone.");
          change.profileKey = key;
        }
        return channelFor(msg.kind).set(change);
      });
      return true;

    case "channel-pair":
      void replyAsync(ws, msg.id, async () => channelFor(msg.kind).pair(msg.on === true));
      return true;

    case "channel-allow":
      void replyAsync(ws, msg.id, async () => {
        if (typeof msg.userId !== "string") throw new Error("A Telegram account id is a number, like 123456789.");
        return channelFor(msg.kind).allow(msg.userId.trim());
      });
      return true;

    case "channel-refuse":
      if (isChannelKind(msg.kind)) channelFor(msg.kind).refuse();
      return true;

    case "channel-disallow":
      if (isChannelKind(msg.kind) && typeof msg.userId === "string") channelFor(msg.kind).disallow(msg.userId);
      return true;

    case "channel-test":
      void replyAsync(ws, msg.id, () => channelFor(msg.kind).test());
      return true;

    case "channel-clear-ignored":
      if (isChannelKind(msg.kind)) channelFor(msg.kind).clearIgnored();
      return true;

    case "set-backup":
      void replyAsync(ws, msg.id, async () => backup.set({ url: msg.url, enabled: msg.enabled, intervalMin: msg.intervalMin }));
      return true;

    case "backup-now":
      void replyAsync(ws, msg.id, () => backup.run());
      return true;
  }
  return false;
}
