/**
 * The vault over a page's socket: the owner's answer to a dialog, and
 * Settings → Vault's own sections.
 *
 * `vault-answer` is the one message in kururu that carries a vault value, so
 * this area is written to never let one out: nothing here is logged but the
 * ask's id, the reply is the outcome per field, and a throw's sentence comes
 * from `vaultstore.ts`, which writes its errors without the value. Another
 * node's watcher is refused every verb here — an ask is this node's owner's
 * to answer, on this node's pages.
 */
import type { WebSocket } from "ws";
import { adoptUses, adoptValues, validItemName, type VaultPage } from "../../../shared/vaultitems";
import type { ClientMessage } from "../../../shared/wire";
import { type ClientState, vault, vaultRuns } from "../context";
import { reply, replyAsync } from "./reply";

/** What Settings → Vault draws above the census. */
export function vaultPage(): VaultPage {
  return { store: vault.storeKind, items: vault.list(), uses: vaultRuns.uses() };
}

export function vaultVerbs(ws: WebSocket, st: ClientState, msg: ClientMessage): boolean {
  switch (msg.type) {
    case "vault-answer":
    case "vault-allow":
    case "vault-page":
    case "vault-set-use":
    case "vault-remove":
    case "vault-clear-uses":
      break;
    default:
      return false;
  }
  if (st.watcher) {
    if (typeof msg.id === "number") reply(ws, msg.id, () => {
      throw new Error("The vault is this node's own.");
    });
    return true;
  }
  switch (msg.type) {
    case "vault-answer": {
      const ask = typeof msg.ask === "string" ? msg.ask : "";
      // Null is Cancel; anything else that is not values is refused, never
      // read as Cancel, so a malformed Save cannot quietly drop the keys.
      const values = msg.values === null ? null : adoptValues(msg.values);
      void replyAsync(ws, msg.id, async () => {
        if (msg.values !== null && values === null) throw new Error("Those values could not be read.");
        return vault.answer(ask, values, adoptUses(msg.uses));
      });
      return true;
    }
    case "vault-allow":
      reply(ws, msg.id, () => {
        if (typeof msg.ask !== "string" || (msg.answer !== "once" && msg.answer !== "lasting" && msg.answer !== "deny")) throw new Error("That answer could not be read.");
        vault.allow(msg.ask, msg.answer);
      });
      return true;
    case "vault-page":
      reply(ws, msg.id, vaultPage);
      return true;
    case "vault-set-use":
      reply(ws, msg.id, () => {
        if (!validItemName(msg.name) || (msg.use !== "free" && msg.use !== "ask")) throw new Error("No such item.");
        vault.setUse(msg.name, msg.use);
        return vaultPage();
      });
      return true;
    case "vault-remove":
      void replyAsync(ws, msg.id, async () => {
        if (!validItemName(msg.name)) throw new Error("No such item.");
        await vault.remove(msg.name);
        return vaultPage();
      });
      return true;
    case "vault-clear-uses":
      reply(ws, msg.id, () => {
        vaultRuns.clearUses();
        return vaultPage();
      });
      return true;
  }
  return false;
}
