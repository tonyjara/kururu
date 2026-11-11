/**
 * Nodes: pairing, naming, ranking and removing them, moving a workspace to one, and the secrets and logins this node lends; the vault's census is asked for here too.
 *
 * One area of what a client can ask over its socket, cut out of the switch
 * that was `index.ts`'s; `dispatch.ts` asks each area in turn and stops at
 * the one that answers. Each case is as it was, with `return true` where the
 * switch had `return`.
 */
import type { WebSocket } from "ws";
import type { ClientMessage } from "../../../shared/wire";
import { type ClientState, mover, nodes, secrets, workspaces } from "../context";
import { lendingLogin, lendOffer, lendSecrets, moveAndLend, vaultFor } from "../lending";
import { openTerminal } from "../terminals";
import { reply, replyAsync } from "./reply";

export function nodeVerbs(ws: WebSocket, st: ClientState, msg: ClientMessage): boolean {
  switch (msg.type) {
    case "node-invite":
      reply(ws, msg.id, () => nodes.invite(msg.on === true));
      return true;

    case "node-join":
      void replyAsync(ws, msg.id, () => nodes.join(msg.text));
      return true;

    case "node-rename":
      void replyAsync(ws, msg.id, () => nodes.rename(msg.nodeId, msg.name));
      return true;

    case "node-rank":
      void replyAsync(ws, msg.id, () => nodes.rank(msg.order));
      return true;

    case "node-remove":
      void replyAsync(ws, msg.id, () => nodes.remove(msg.nodeId));
      return true;

    case "node-move-plan":
      void replyAsync(ws, msg.id, () => mover.plan(workspaces.active.id, String(msg.workspaceId), String(msg.nodeId), typeof msg.folder === "string" ? msg.folder : null));
      return true;

    case "node-new-check":
      void replyAsync(ws, msg.id, () => mover.newCheck(String(msg.nodeId), typeof msg.name === "string" ? msg.name : "", typeof msg.folder === "string" ? msg.folder : null));
      return true;

    case "node-new-workspace":
      void replyAsync(ws, msg.id, () => mover.newOn(String(msg.nodeId), typeof msg.name === "string" ? msg.name : "", String(msg.folder ?? "")));
      return true;

    case "node-card-done":
      void replyAsync(ws, msg.id, async () => {
        const name = nodes.nameOf(String(msg.nodeId));
        if (!name) throw new Error("That node is not in the roster.");
        const answer = await nodes.ask(
          String(msg.nodeId),
          (id) => ({ type: "card-done-ask", id, workspaceKey: String(msg.workspaceKey), cardId: String(msg.cardId) }),
          10_000,
          `${name} did not answer, so the card was not moved.`,
        );
        if (answer.type !== "card-done-said") throw new Error(`${name} answered something else.`);
        if (answer.error) throw new Error(answer.error);
        return { ok: true };
      });
      return true;

    case "node-move":
      void replyAsync(ws, msg.id, () => moveAndLend(workspaces.active.id, String(msg.workspaceId), String(msg.nodeId), String(msg.folder ?? ""), msg.lend, "user"));
      return true;

    case "vault":
      void replyAsync(ws, msg.id, () => vaultFor());
      return true;

    case "secrets-offer":
      void replyAsync(ws, msg.id, () => lendOffer(workspaces.active.id, String(msg.workspaceId), String(msg.nodeId), typeof msg.folder === "string" ? msg.folder : null));
      return true;

    case "secrets-lend":
      void replyAsync(ws, msg.id, () => lendSecrets(workspaces.active.id, String(msg.workspaceId), String(msg.nodeId), typeof msg.folder === "string" ? msg.folder : null, msg.ask));
      return true;

    case "secret-grant":
      reply(ws, msg.id, () => secrets.grant(msg.nodeId, msg.kind, msg.on === true));
      return true;

    case "secret-push":
      reply(ws, msg.id, () => secrets.pushAgain(msg.nodeId, msg.kind));
      return true;

    case "claude-lend":
      void replyAsync(ws, msg.id, async () => {
        const { login, account } = await lendingLogin(msg.profileId);
        return secrets.lend(login, msg.token, account);
      });
      return true;

    case "claude-unlend":
      reply(ws, msg.id, () => secrets.unlend(msg.login));
      return true;

    case "claude-lend-open":
      void replyAsync(ws, msg.id, async () => {
        if (nodes.role() === "child") throw new Error("A child does not lend logins; its parent does.");
        if (typeof msg.profileId !== "string" || msg.profileId !== workspaces.active.id) throw new Error("Open this from the profile whose login you are lending.");
        // In the lower half, as the profile's login: the tab's environment
        // is the profile's, so the token minted is that account's. Local even
        // in a workspace pinned to a machine: the login is this Mac's.
        const pane = workspaces.paneFor("lower");
        if (!pane) throw new Error("There is no pane to open it in.");
        const agent = await openTerminal(pane, { command: "claude setup-token", kind: "shell", local: true });
        return { id: agent.id };
      });
      return true;
  }
  return false;
}
