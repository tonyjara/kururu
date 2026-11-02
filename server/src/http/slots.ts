/**
 * The slot queue over HTTP, for `slot` (`server/src/slot-cli.ts`): a take
 * held open as a long poll, a release, the user-is-waiting priority, the
 * fingerprint a simulator carries, the status, and the sweep.
 *
 * Behind the gate like every route here — loopback, the Origin check and,
 * when shared, the token — so what can queue for this Mac's simulators is
 * what can already type into its terminals. The holder a take names is
 * checked to be alive before it is believed, and nothing here runs a command
 * a caller names: `slot run` runs its command itself, in its own process.
 */
import { fmtDur } from "../../../shared/slots";
import { slots } from "../context";
import { adoptTakeRequest } from "../slots";
import { json, readJsonBody } from "./respond";
import type { Route } from "./router";

async function body(req: Parameters<Route["handle"]>[0]): Promise<Record<string, unknown>> {
  const raw = await readJsonBody(req, 16 * 1024);
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

function holderOf(b: Record<string, unknown>) {
  const h = (b.holder && typeof b.holder === "object" ? b.holder : {}) as Record<string, unknown>;
  const pid = typeof h.pid === "number" && Number.isInteger(h.pid) && h.pid > 1 ? h.pid : null;
  const agentId = typeof h.agentId === "string" && /^[\w:-]{1,40}$/.test(h.agentId) ? h.agentId : null;
  return { agentId, pid, pstart: null };
}

const fail = (res: Parameters<Route["handle"]>[1], err: unknown, status = 400) => json(res, { error: err instanceof Error ? err.message : String(err) }, status);

export const slotRoutes: Route[] = [
  {
    path: "/api/slots",
    handle: (req, res, url) => {
      if (url.searchParams.has("who")) {
        json(res, { text: slots.whoText(url.searchParams.get("who") || null) });
        return;
      }
      json(res, { view: slots.view(), text: slots.statusText() });
    },
  },

  /**
   * One ask of the line. The answer is a lease, a place and why it is not
   * yours yet, or a refusal with the script's exit code; a caller that hangs
   * up keeps its place until its CLI's pid is gone or it has been silent for
   * `WAITER_GONE_MS`.
   */
  {
    path: "/api/slots/take",
    method: "POST",
    handle: async (req, res) => {
      let take;
      try {
        take = adoptTakeRequest(await body(req));
      } catch (err) {
        fail(res, err);
        return;
      }
      const hangup = new AbortController();
      res.on("close", () => {
        if (!res.writableFinished) hangup.abort();
      });
      try {
        const answer = await slots.take(take, hangup.signal);
        if (!hangup.signal.aborted) json(res, answer);
      } catch (err) {
        if (!hangup.signal.aborted) fail(res, err);
      }
    },
  },

  {
    path: "/api/slots/release",
    method: "POST",
    handle: async (req, res) => {
      try {
        const b = await body(req);
        const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 80) : null);
        const released = slots.release({ lease: s(b.lease), lane: s(b.lane), who: s(b.who), anyHolder: b.anyHolder === true, holder: holderOf(b) });
        json(res, { released });
      } catch (err) {
        fail(res, err);
      }
    },
  },

  /**
   * The user is waiting on somebody. For Kuru and for whoever runs the
   * orchestration; the CLI refuses `--user-waiting` on a take for the
   * script's reason — an agent never sets it for itself.
   */
  {
    path: "/api/slots/prioritize",
    method: "POST",
    handle: async (req, res) => {
      try {
        const b = await body(req);
        const who = typeof b.who === "string" ? b.who.trim().slice(0, 80) : "";
        if (!who) throw new Error("prioritize <who> [--for 60m]");
        const ms = b.off === true ? 0 : typeof b.ms === "number" && Number.isFinite(b.ms) && b.ms > 0 ? Math.min(b.ms, 24 * 3_600_000) : slots.priorityForMs;
        json(res, { text: slots.prioritize(who, ms), for: ms ? fmtDur(ms) : null });
      } catch (err) {
        fail(res, err);
      }
    },
  },

  {
    path: "/api/slots/installed",
    method: "POST",
    handle: async (req, res) => {
      try {
        const b = await body(req);
        const udid = typeof b.udid === "string" && /^[0-9A-Fa-f-]{36}$/.test(b.udid) ? b.udid : null;
        const fingerprint = typeof b.fingerprint === "string" && /^[\w.-]{1,128}$/.test(b.fingerprint) ? b.fingerprint : null;
        if (!udid || !fingerprint) throw new Error("installed <fingerprint> --udid <udid>: a simulator's udid and a fingerprint of letters, digits, . _ -");
        json(res, { text: slots.installed(udid, fingerprint) });
      } catch (err) {
        fail(res, err);
      }
    },
  },

  /** The nightly sweep now, or — the default — what it would do. */
  {
    path: "/api/slots/sweep",
    method: "POST",
    handle: async (req, res) => {
      try {
        const b = await body(req);
        json(res, { report: await slots.sweep(b.yes !== true) });
      } catch (err) {
        fail(res, err, 500);
      }
    },
  },
];
