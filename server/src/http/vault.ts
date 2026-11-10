/**
 * The vault for programs on this Mac: `vault ask`, `vault list`, `vault
 * run` and the askpass `vault run --askpass` points sudo at
 * (`server/src/vault-cli.ts`).
 *
 * Programs on this Mac only — loopback, no `Origin`, nothing a proxy added
 * (`localCaller`, as `/mcp/web` is) — and behind the gate as well, which on a
 * child asks loopback for the token too. Nothing here ever answers with a
 * value: an ask is answered with a word per field, the list with names.
 *
 * An ask is a request held open until the owner answers, up to the fifteen
 * minutes the dialog stays up; a caller that hangs up — Ctrl-C, its agent
 * stopped — closes the dialog as cancelled, since nobody is left to hear it.
 * A run is a response streamed as JSON lines while the command runs; a
 * caller that hangs up ends the command's process group.
 *
 * The askpass's trade is the one answer here that carries a value, to the
 * askpass sudo started, for a ticket only that run's environment holds. It is
 * no wider than the run itself: the command could read its own environment.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { cardCode } from "../../../shared/board";
import { adoptAskRequest, itemLine, outcomeLines } from "../../../shared/vaultitems";
import { harness, host, vault, vaultRuns, workspaces } from "../context";
import { adoptRunRequest, type RunEvent } from "../vaultrun";
import { localCaller } from "../web/chain";
import { json, readJsonBody } from "./respond";
import type { Route } from "./router";

/** An agent as the owner knows it — its card's code, else its tab's title — with its id; "a shell" for a caller that is no agent kururu knows. */
export function callerName(agentId: string | null): { name: string; agentId: string | null } {
  const agent = agentId ? host.find(agentId) : undefined;
  if (!agent || !agentId) return { name: "a shell", agentId: null };
  if (harness.isHarness(agentId)) return { name: "Kuru", agentId };
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
      // The id first, at once, so a caller cut off by a restart can wait again by it.
      res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
      res.write(`${JSON.stringify({ id: opened.id, until: Date.now() + ask.openFor })}\n`);
      const outcomes = await opened.done;
      if (hangup.signal.aborted || res.writableEnded) return;
      const labels = new Map(ask.fields.map((f, i) => [String(i), f.label]));
      res.end(`${JSON.stringify({ id: opened.id, outcomes, text: outcomeLines(outcomes, labels) })}\n`);
    },
  },

  /**
   * Waiting again for an ask by its id: what `vault ask` does when the
   * server it asked went away under it (a restart under `bun run dev`) and
   * the next one has taken the ask up. The same lines as an ask's, the id
   * first; 404 for an ask this server never heard of or forgot. Hanging up
   * cancels it, as hanging up on the ask does.
   */
  {
    path: "/api/vault/wait",
    method: "POST",
    handle: async (req, res) => {
      if (refuseRemote(req, res)) return;
      let id = "";
      try {
        const raw = (await readJsonBody(req, 1024)) as { id?: unknown } | null;
        id = typeof raw?.id === "string" && /^[0-9a-f]{8}$/.test(raw.id) ? raw.id : "";
      } catch {
        // No id, then.
      }
      const done = id ? vault.wait(id) : null;
      if (!done) {
        json(res, { error: "no such ask: it ended more than a day ago, or was never made here" }, 404);
        return;
      }
      const hangup = new AbortController();
      res.on("close", () => {
        if (!res.writableFinished) hangup.abort();
      });
      vault.hangup(id, hangup.signal);
      res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
      res.write(`${JSON.stringify({ id })}\n`);
      // Read now: once the ask ends it is no longer open to read them from.
      const labels = new Map((vault.labelsOf(id) ?? []).map((l, i) => [String(i), l]));
      const outcomes = await done;
      if (hangup.signal.aborted || res.writableEnded) return;
      res.end(`${JSON.stringify({ id, outcomes, text: outcomeLines(outcomes, labels) })}\n`);
    },
  },

  {
    path: "/api/vault/run",
    method: "POST",
    handle: async (req, res) => {
      if (refuseRemote(req, res)) return;
      let body: Record<string, unknown>;
      try {
        const raw = await readJsonBody(req, 512 * 1024);
        body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      } catch {
        json(res, { error: "that was not JSON" }, 400);
        return;
      }
      const run = adoptRunRequest(body);
      if ("error" in run) {
        json(res, { error: run.error }, 400);
        return;
      }
      const hangup = new AbortController();
      res.on("close", () => {
        if (!res.writableFinished) hangup.abort();
      });
      res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
      const emit = (ev: RunEvent) => {
        if (!res.writableEnded && !hangup.signal.aborted) res.write(`${JSON.stringify(ev)}\n`);
      };
      await vaultRuns.run(run, callerName(agentOf(body)), emit, hangup.signal);
      if (!res.writableEnded) res.end();
    },
  },

  {
    path: "/api/vault/askpass",
    method: "POST",
    handle: async (req, res) => {
      if (refuseRemote(req, res)) return;
      let ticket = "";
      try {
        const raw = (await readJsonBody(req, 1024)) as { ticket?: unknown } | null;
        ticket = typeof raw?.ticket === "string" && /^[0-9a-f]{48}$/.test(raw.ticket) ? raw.ticket : "";
      } catch {
        // No ticket, then.
      }
      const value = ticket ? await vaultRuns.askpass(ticket) : null;
      if (value === null) json(res, { error: "that ticket is spent or its run has ended" }, 403);
      else json(res, { value });
    },
  },
];
