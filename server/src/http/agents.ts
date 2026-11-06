/**
 * What agents tell kururu and what is asked about them: the hook's report, the list of agents, and the usage ledger's report.
 *
 * One table of routes of a fixed path, cut out of the `if` chain that was
 * `index.ts`'s; `router.ts` puts the tables together and decides what comes
 * before them. Each handler is the body of the `if` it was.
 */
import { countsAsAgent } from "../../../shared/model";
import { AGY_CONVERSATION } from "../../../shared/agy";
import { isUsageDimension, isUsageRange } from "../../../shared/usagereport";
import { parseReport } from "../agents/report";
import { activity, channels, harness, host, kuruKey, MAX_ACTIVITY, outbox, peerKurus, usageReader, voice, workspaces } from "../context";
import { recordTurn } from "../conversation";
import { noteMade } from "../madelinks";
import { noteReported, usageReportFor } from "../terminals";
import { json, readJsonBody, text } from "./respond";
import type { Route } from "./router";

export const agentRoutes: Route[] = [
  /**
   * What the pty host is holding, for something that is not a browser.
   *
   * The snapshot already goes to every client over the websocket, so this adds
   * no knowledge — what it adds is a way to ask without becoming a client. The
   * caller is `server/status.mjs`, a terminal command, and the alternative it
   * exists to avoid is much worse than an endpoint: the host's socket accepts
   * one server at a time and treats a second connection as a restarted first,
   * so a status tool that asked the *host* directly would knock the live server
   * off its own link to find out how things were going.
   *
   * So the rule stands that the host is opaque and the server is the thing that
   * describes it — and when there is no server, there is genuinely nobody who
   * can answer, which is a true thing for a status command to have to say.
   */
  {
    path: "/api/agents",
    handle: (req, res, url) => {
      json(res, {
        agents: host.agents.map((agent) => ({
          id: agent.id,
          name: agent.agent ?? agent.title ?? null,
          program: agent.agent,
          status: agent.status,
          cwd: agent.cwd,
          pid: agent.pid,
          exited: agent.exited,
          counts: countsAsAgent(agent),
        })),
      });
      return;
    },
  },

  /**
   * Settings → Usage, asked for while the page is open and never pushed: what a
   * range spent is a page's question, and the ledger's reader changes it every
   * few seconds whether or not anybody is looking. Names and live terminals are
   * looked up here because the ledger has neither. See `usage/report.ts`.
   */
  {
    path: "/api/usage/report",
    handle: (req, res, url) => {
      if (!usageReader) {
        json(res, { error: "The usage ledger did not open, so there is nothing to draw. Why is in the server's log." }, 503);
        return;
      }
      const range = url.searchParams.get("range");
      const by = url.searchParams.get("by");
      json(res, usageReportFor(usageReader, isUsageRange(range) ? range : "week", isUsageDimension(by) ? by : "workspace"));
      return;
    },
  },

  /**
   * How an agent tells kururu what it is doing. The only source of `blocked`
   * and of context usage; see agents/report.ts for why neither is inferable.
   */
  {
    path: "/api/report",
    handle: async (req, res, url) => {
      if (req.method !== "POST") {
        text(res, "POST only", 405);
        return;
      }
      try {
        const body = await readJsonBody(req);
        const parsed = parseReport(body);
        if (!parsed) {
          json(res, { error: "need a valid status or context" }, 400);
          return;
        }
        // An agent that does not name itself is the common case: the hook runs
        // inside the pty, so its own environment already says which one it is.
        const agentId = parsed.agentId ?? process.env.KURURU_AGENT_ID ?? null;
        if (!agentId || !host.find(agentId)) {
          json(res, { error: "no such agent" }, 404);
          return;
        }
        host.report(agentId, parsed.report);
        // Antigravity names its own conversation and says which with its
        // first word; a card's run keeps it, as a Codex run's is kept once
        // found on disk (`sleep.ts`), so running the card again resumes it.
        const named = body as Record<string, unknown>;
        if (named.program === "agy" && typeof named.session === "string" && AGY_CONVERSATION.test(named.session)) workspaces.noteRunSession(agentId, named.session);
        // The rest of the report is the harness's: where the transcript and the
        // inbox are, and what was last said. See `harness.ts`.
        harness.report(agentId, body as Record<string, unknown>);
        // And the same path is the usage ledger's cue to read what the turn billed.
        noteReported(agentId, body as Record<string, unknown>);
        usageReader?.nudge((body as Record<string, unknown>).transcript);
        const spoken = harness.isHarness(agentId);
        const spokenKey = spoken ? workspaces.keyOf(spoken) : null;
        // A prompt Kuru took, which is how a message of yours is known to have
        // arrived and not merely to have been typed. See `Outbox.prompted`.
        // The channels note where it came from, and carry it to the chat when
        // it was yours from here; only a `working` report's message is a
        // prompt, as `recordTurn` below reads it.
        if (spokenKey && parsed.report.message) outbox.prompted(spokenKey, parsed.report.message);
        if (spokenKey && parsed.report.status === "working" && parsed.report.message) channels.prompted(spokenKey, parsed.report.message);
        // And when the reporter is a profile's harness, what it last said is
        // read aloud — the one place Kuru's turn ending is heard about — unless
        // the turn answered only a channel, whose reply is already in somebody's
        // hand (`replySpoken`). Every channel that carries the profile gets it.
        const reply = (body as Record<string, unknown>).reply;
        const ended = spokenKey !== null && parsed.report.status === "done";
        const utterance = ended && channels.speaks(spokenKey) ? voice.spoke(spokenKey, reply) : null;
        const answered = ended ? channels.replied(spokenKey, reply) : null;
        // And the conversation, written down: the prompt on its way in and
        // the reply on its way out, for the search and the drawer. Before the
        // cap below, which is the sidebar's and not the record's.
        const turn = recordTurn(agentId, parsed.report, body as Record<string, unknown>, utterance);
        // And the other nodes hear the reply of this node's Kuru, with what it
        // answered, under the id their drawers will see it by. See `peerkuru.ts`.
        if (answered && spokenKey === kuruKey() && typeof reply === "string" && reply.trim()) {
          peerKurus?.replied({ id: turn !== null ? `t${turn}` : `r${Date.now().toString(36)}`, at: Date.now(), text: reply.trim() }, answered.origin, answered.answers);
        }
        // And what the turn ended in, for the links under the agent's row and
        // on its card. See `noteMade`.
        noteMade(agentId, parsed.report, body as Record<string, unknown>);
        /**
         * The host is told the status and the context; the message stops here.
         * It is the one part of a report that says something about the work rather
         * than about the process, so it is the one part the host has no use for —
         * see `activity` beside `snapshot()`. Trimmed and capped on the way in
         * because it is drawn in a sidebar one line high, and an agent that
         * reported a paragraph would otherwise be storing one per turn.
         */
        const said = parsed.report.message?.replace(/\s+/g, " ").trim();
        if (said) activity.set(agentId, said.slice(0, MAX_ACTIVITY));
        json(res, { ok: true });
      } catch (err) {
        json(res, { error: err instanceof Error ? err.message : String(err) }, 400);
      }
      return;
    },
  },
];
