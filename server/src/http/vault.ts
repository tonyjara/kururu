/**
 * The vault for programs on this Mac: `vault ask` and `vault list` today,
 * `vault run` once the broker is built (`server/src/vault-cli.ts`).
 *
 * Programs on this Mac only — loopback, no `Origin`, nothing a proxy added
 * (`localCaller`, as `/mcp/web` is) — and behind the gate as well, which on a
 * child asks loopback for the token too. Nothing here ever answers with a
 * value: an ask is answered with a word per field, the list with names.
 *
 * An ask is a request held open until the owner answers, up to the fifteen
 * minutes the dialog stays up; a caller that hangs up — Ctrl-C, its agent
 * stopped — closes the dialog as cancelled, since nobody is left to hear it.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { cardCode } from "../../../shared/board";
import { adoptAskRequest, itemLine, outcomeLines } from "../../../shared/vaultitems";
import { host, vault, workspaces } from "../context";
import { localCaller } from "../web/chain";
import { json, readJsonBody } from "./respond";
import type { Route } from "./router";

/** An agent as the owner knows it — its card's code, else its tab's title — with its id; "a shell" for a caller that is no agent kururu knows. */
export function callerName(agentId: string | null): { name: string; agentId: string | null } {
  const agent = agentId ? host.find(agentId) : undefined;
  if (!agent || !agentId) return { name: "a shell", agentId: null };
  const profileId = workspaces.profileOf(agentId);
  const profile = profileId ? workspaces.profile(profileId) : undefined;
  for (const w of profile?.workspaces ?? []) {
    const card = w.board?.cards.find((k) => k.run?.agentId === agentId);
    if (card) return { name: `${cardCode(w.name, card.number)} (${agentId})`, agentId };
  }
  const title = (agent.titleOverride || agent.title || "").replace(/\s+/g, " ").trim().slice(0, 40);
  return { name: title ? `${title} (${agentId})` : agentId, agentId };
}

function refuseRemote(req: IncomingMessage, res: ServerResponse): boolean {
  if (localCaller(req)) return false;
  json(res, { error: "the vault answers programs on this Mac only" }, 403);
  return true;
}

function agentOf(body: Record<string, unknown>): string | null {
  return typeof body.agentId === "string" && /^[\w:-]{1,40}$/.test(body.agentId) ? body.agentId : null;
}

export const vaultRoutes: Route[] = [
  {
    path: "/api/vault/list",
    handle: (req, res) => {
      if (refuseRemote(req, res)) return;
      const items = vault.list();
      json(res, { store: vault.storeKind, items, text: items.length ? items.map(itemLine).join("\n") : "The vault keeps nothing yet." });
    },
  },

  {
    path: "/api/vault/ask",
    method: "POST",
    handle: async (req, res) => {
      if (refuseRemote(req, res)) return;
      let body: Record<string, unknown>;
      try {
        const raw = await readJsonBody(req, 32 * 1024);
        body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      } catch {
        json(res, { error: "that was not JSON" }, 400);
        return;
      }
      const ask = adoptAskRequest(body);
      if ("error" in ask) {
        json(res, { error: ask.error }, 400);
        return;
      }
      const hangup = new AbortController();
      res.on("close", () => {
        if (!res.writableFinished) hangup.abort();
      });
      let opened;
      try {
        opened = vault.ask(ask, callerName(agentOf(body)).name, hangup.signal);
      } catch (err) {
        json(res, { error: err instanceof Error ? err.message : String(err) }, 400);
        return;
      }
      const outcomes = await opened.done;
      if (hangup.signal.aborted) return;
      const labels = new Map(ask.fields.map((f, i) => [String(i), f.label]));
      json(res, { id: opened.id, outcomes, text: outcomeLines(outcomes, labels) });
    },
  },
];
