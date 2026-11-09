/**
 * The server itself: the token's cookie, its health and its lifecycle, a restart of it or of the host, a window reload, the update, the reach and Share, the data file, a backup now, what the machine is costing, and a terminal's recent stream.
 *
 * One table of routes of a fixed path, cut out of the `if` chain that was
 * `index.ts`'s; `router.ts` puts the tables together and decides what comes
 * before them. Each handler is the body of the `if` it was.
 */
import { countsAsAgent } from "../../../shared/model";
import { oneLine, outcomeText, RELOAD_TIMEOUT_MAX_MS, RELOAD_TIMEOUT_MIN_MS, RELOAD_TIMEOUT_MS, WHY_MAX } from "../../../shared/reload";
import { cookieHeader, hasToken, isShared, listenAddresses, loopbackTokenRequired, rotateToken, setShare, sharing, token } from "../access";
import {
  backup,
  host,
  hostInfo,
  hostProtocol,
  kuru,
  launch,
  nodes,
  reloaderOf,
  reloads,
  sleeper,
  state,
  store,
  usageReader,
  watches,
  windows,
  workspaces,
} from "../context";
import { remoteClientAt, requestHostRestart, requestRestart } from "../boot";
import { lifecycleReport, lifeNow, record } from "../lifecycle";
import { renderMarkdown } from "../markdown";
import { PORT, RESTART_EXIT_CODE } from "../preamble";
import { reach } from "../reach";
import { dump as dumpRecording } from "../record";
import { footprint } from "../sweeps";
import { leadHealth } from "../thisnode";
import { checkForUpdate } from "../update";
import { VERSION } from "../version";
import { json, readJsonBody, text } from "./respond";
import type { Route } from "./router";

export const serverRoutes: Route[] = [
  /**
   * One scanned QR code, turned into a device that keeps working.
   *
   * The token arrives as `?k=` on the address the phone opened, and the page
   * hands it straight back here so it can be exchanged for a cookie — which the
   * browser then attaches to every fetch *and to the WebSocket handshake*, which
   * is the whole reason this is a cookie and not something the client would have
   * to remember to add in eleven places. It also works identically in
   * development, where the page comes from vite and only the proxied requests
   * ever reach this process, so there is no second arrangement to keep in step.
   *
   * Reachable without a token by construction — the gate above has already
   * accepted this request, and on a shared server accepting it is what having
   * presented a valid one *means*.
   */
  {
    path: "/api/access",
    handle: (req, res, url) => {
      if (!isShared() && !loopbackTokenRequired()) {
        json(res, { ok: true, shared: false });
        return;
      }
      if (!hasToken(req, url)) {
        text(res, "kururu: that token is not this server's.", 403);
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "set-cookie": cookieHeader(token()),
      });
      res.end(JSON.stringify({ ok: true, shared: true }));
      return;
    },
  },

  {
    path: "/api/health",
    handle: (req, res, url) => {
      json(res, {
        ok: true,
        // The one field something outside kururu reads to tell two builds apart —
        // a window against a server in a cupboard, or the updater against either.
        version: VERSION,
        // And the host's, which can be older: it does not pick up a new bundle
        // until it is restarted. `current` is whether that restart is owed.
        host: { version: hostInfo.version, protocol: hostProtocol, current: hostInfo.current },
        agents: host.agents.length,
        liveAgents: host.agents.filter(countsAsAgent).length,
        devServers: state.devServers.length,
        // The conversation's two counts for the profile on screen, for the
        // menu bar: what Kuru said that nobody heard, and what did not reach
        // it. The frog is the one presence a Mac with no window open has.
        kuru: { profileId: workspaces.active.id, ...kuru.counts(workspaces.active.key) },
        pid: process.pid,
        clients: { now: windows(), remoteAt: remoteClientAt },
        // Who watches this node, and whom this node watches: the two ends of
        // `/link/watch`, for `bun run status`.
        watch: { by: nodes.view().watchedBy ?? [], of: watches.status() },
        // This node among the others: its role, who leads, and each member's
        // link — what `kururu child doctor` checks the pairing row against —
        // and where the Telegram poll stands, for its leading row.
        nodes: { ...nodes.health(), lead: leadHealth() },
        // When and why this process started, and whether anything would start
        // it again. Without the file: this is asked every few seconds.
        life: lifeNow(),
        // The usage ledger's counts, for `bun run status`. Held for two seconds, for the same reason.
        ledger: usageReader?.status() ?? null,
      });
      return;
    },
  },

  /**
   * Why the server last went away, for the About page. Read from the file at
   * the moment of asking, because the lines that matter most were written by
   * a process that no longer exists.
   */
  {
    path: "/api/lifecycle",
    handle: (req, res, url) => {
      json(res, lifecycleReport());
      return;
    },
  },

  /**
   * Every card's agent as the idle look last found it, and why each one is
   * still awake — "waiting on you: its last reply asked something", "idle 4
   * min of 10". Asked, not pushed: it is for whoever is wondering.
   */
  {
    path: "/api/sleep",
    handle: (req, res, url) => {
      json(res, { on: launch.sleepIdle, minutes: launch.sleepMinutes, agents: sleeper.looked() });
      return;
    },
  },

  /**
   * Where the data lives, for the About page: the database's file and how
   * big it is. Asked rather than pushed, since nobody watches it grow.
   */
  {
    path: "/api/data",
    handle: (req, res, url) => {
      json(res, { path: store.path, bytes: store.bytes() });
      return;
    },
  },

  /** Back up now, for `bun run backup` and anything else without a socket. */
  {
    path: "/api/backup/now",
    method: "POST",
    handle: async (req, res, url) => {
      json(res, await backup.run());
      return;
    },
  },

  /**
   * The two restarts, for a caller with no socket: the menu bar.
   *
   * The server's own restart is what `prefix+B` asks over the socket, and
   * costs a reconnect. The host's is the one thing in kururu that ends
   * agents, and it is a POST on loopback for the same reason `kill-agent`
   * is a message any client may send: whatever can reach this server can
   * already end a terminal, one at a time. What is kept out of reach is the
   * *accident* — the dialog that names the count is the caller's, and
   * nothing here runs without being asked. A 409 is a refusal with its
   * reason, which is the honest answer to a request that cannot be finished.
   */
  {
    path: "/api/restart",
    method: "POST",
    handle: (req, res, url) => {
      const refused = requestRestart("the menu bar asked for a restart");
      if (refused) json(res, { ok: false, error: refused }, 409);
      else json(res, { ok: true });
      return;
    },
  },

  {
    path: "/api/host/restart",
    method: "POST",
    handle: (req, res, url) => {
      const refused = requestHostRestart();
      if (refused) json(res, { ok: false, error: refused }, 409);
      else json(res, { ok: true });
      return;
    },
  },

  /**
   * An agent asking for the window to be reloaded, for a caller with no
   * socket: `bun run reload-window`, which sends the `KURURU_AGENT_ID` its pty
   * was started with so the notice can say who asked. Held open until every
   * page on this Mac has reloaded and come back, or the time is up, or the
   * page went — the answer is what the agent acts on. Behind the gate like
   * every route here, so loopback, the Origin check and, when shared, the
   * token are what they are for everything else; and it reloads pages and
   * nothing more, the same reload `C-a R` does, never the host.
   *
   * A caller that hangs up stops the wait, and the pages still holding let
   * the ask go: a reload nobody is waiting to hear about is one that would
   * arrive unexplained but for its notice.
   */
  {
    path: "/api/reload-window",
    method: "POST",
    handle: async (req, res, url) => {
      let body: Record<string, unknown> = {};
      try {
        const raw = await readJsonBody(req, 16 * 1024);
        if (raw && typeof raw === "object") body = raw as Record<string, unknown>;
      } catch (err) {
        json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 400);
        return;
      }
      const why = typeof body.why === "string" ? oneLine(body.why, WHY_MAX) : "";
      if (!why) {
        json(res, { ok: false, error: "Say why: the window shows it in the notice after the reload." }, 400);
        return;
      }
      const seconds = Number(body.timeout);
      const timeoutMs = Number.isFinite(seconds) && body.timeout !== null && body.timeout !== undefined
        ? Math.max(RELOAD_TIMEOUT_MIN_MS, Math.min(RELOAD_TIMEOUT_MAX_MS, seconds * 1000))
        : RELOAD_TIMEOUT_MS;
      const by = reloaderOf(typeof body.agent === "string" ? body.agent : null, typeof body.by === "string" ? body.by : null);
      const hangup = new AbortController();
      res.on("close", () => {
        if (!res.writableFinished) hangup.abort();
      });
      const outcome = await reloads.ask(why, by, timeoutMs, hangup.signal);
      if (!hangup.signal.aborted) json(res, { ...outcome, by, text: outcomeText(outcome) });
      return;
    },
  },

  /**
   * Whether there is a newer kururu. A `force` is somebody pressing the button a
   * second time, which is the one case that should skip the cache — see
   * `update.ts` for why there is one.
   */
  {
    path: "/api/update",
    handle: async (req, res, url) => {
      const check = await checkForUpdate(url.searchParams.has("force"));
      /**
       * The notes are rendered here rather than in `update.ts`, which stays a
       * fetch and a comparison. A failure falls back to the markdown source,
       * which is perfectly readable and is what a changelog is written as anyway.
       */
      let notesHtml: string | null = null;
      if (check.notes) {
        try {
          notesHtml = (await renderMarkdown(check.notes, "", "release-notes.md")).html;
        } catch {
          notesHtml = null;
        }
      }
      json(res, { ...check, notesHtml });
      return;
    },
  },

  /**
   * Settings' Processes page: every terminal, what is running in it and what
   * it costs, grouped the way the sidebar groups them. Asked for, never polled
   * from here — the page asks while it is open. See `shared/footprint.ts`.
   */
  {
    path: "/api/footprint",
    handle: async (req, res, url) => {
      json(res, await footprint());
      return;
    },
  },

  /**
   * The addresses this machine can be reached at, for the QR the phone scans.
   * Asked for rather than pushed: it changes when somebody joins a different
   * network or brings tailscale up, neither of which raises an event here, and
   * a poll running forever to keep a value only one dialog ever draws would be
   * a timer earning nothing. See `reach.ts`.
   */
  {
    path: "/api/reach",
    handle: (req, res, url) => {
      // `listening` for `bun run share`, which has no page to ask and must not
      // offer a LAN address to a child that listens on its tailnet one alone.
      json(res, { ...reach(PORT), ...sharing(), listening: listenAddresses() });
      return;
    },
  },

  /**
   * Turning sharing on or off, and minting a new token.
   *
   * A POST rather than a message on the socket, because it is answered with the
   * new state and the dialog needs that answer — a snapshot cannot carry it, for
   * the reason `wire.ts` gives beside `Sharing`: the token has no business going
   * to every client on every change. Restarting is the caller's, and only when
   * the bind address actually has to move: turning sharing off while already
   * loopback-bound changes nothing about the socket.
   */
  {
    path: "/api/share",
    method: "POST",
    handle: async (req, res, url) => {
      const body = await readJsonBody(req);
      const wanted = (body as { share?: unknown } | null)?.share;
      const rotate = (body as { rotate?: unknown } | null)?.rotate === true;

      let next = rotate ? rotateToken() : sharing();
      if (typeof wanted === "boolean") {
        next = setShare(wanted);
        json(res, next);
        /**
         * Restarted only when the *socket* disagrees with what was just chosen,
         * which is not the same test as "the decision changed": somebody who
         * turns sharing on and immediately off again has changed the file twice
         * and the socket never needed to move at all. Sent after the answer has
         * gone out, or the dialog is told nothing and is left looking at a
         * connection that dropped for no reason it could explain.
         */
        if (wanted !== isShared() && next.restartable) {
          record("stop", `sharing was switched ${wanted ? "on" : "off"}, and the socket has to be bound again`);
          setTimeout(() => process.exit(RESTART_EXIT_CODE), 250);
        }
        return;
      }
      json(res, next);
      return;
    },
  },

  /**
   * The last little while of one terminal's raw stream, for diagnosing something
   * that has already happened. Plain text, deliberately: it is read by a person,
   * usually by piping it into a file. See `record.ts`.
   */
  {
    path: "/api/record",
    handle: (req, res, url) => {
      const agentId = url.searchParams.get("agent") ?? "";
      if (!agentId || !host.find(agentId)) {
        text(res, "no such agent\n", 404);
        return;
      }
      text(res, dumpRecording(agentId, Number(url.searchParams.get("tail")) || undefined));
      return;
    },
  },
];
