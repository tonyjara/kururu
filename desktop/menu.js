/**
 * The tray's menu, as data.
 *
 * A menu is the one place the three processes are described to somebody who
 * has no terminal, so what it says has to be right, and "right" here is a
 * matter of sentences — which process is up, since when, why the last one
 * went, what a click will cost. Sentences are testable when they are made
 * from plain data and nothing else, so this file takes the runner's view and
 * the app's and returns a template with labels, and knows nothing about
 * Electron. `tray.js` attaches the clicks by id.
 *
 * The rule for the labels: every disabled item says why it is disabled, in
 * the label, because a grey item with no reason is a thing somebody clicks
 * three times.
 */

/** A time that is today's as a time and anybody else's with its date. */
function when(iso) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  if (at.toDateString() === new Date().toDateString()) return time;
  return `${at.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

/** `08-07:48:40` from `ps -o etime` as "8 days"; `01:34:26` as "1 h 34 min". */
function uptimeWords(etime) {
  if (!etime) return "";
  const days = /^(\d+)-/.exec(etime);
  if (days) {
    const n = Number(days[1]);
    return `${n} day${n === 1 ? "" : "s"}`;
  }
  const parts = etime.split(":").map(Number);
  if (parts.length === 3) return `${parts[0]} h ${parts[1]} min`;
  if (parts.length === 2) return parts[0] > 0 ? `${parts[0]} min` : "under a minute";
  return etime;
}

function agents(count) {
  return count === 1 ? "1 agent running" : `${count} agents running`;
}

function ending(count) {
  return count === 1 ? "ends 1 agent" : `ends ${count} agents`;
}

/**
 * @param view  the runner's `view()` plus the app's own facts:
 *   `appVersion`, `packaged`, `windowOpen`, `talk` ({ on, status, altSpace }),
 *   `openAtLogin` ({ on, available, status })
 */
function menuTemplate(view) {
  const { server, host } = view;
  const items = [];

  items.push({ id: "about", label: `Kururu ${view.appVersion} · ${view.sourceLabel}`, enabled: false });
  if (view.checkoutProblem) items.push({ id: "checkout-problem", label: `⚠ ${view.checkoutProblem}`, enabled: false });
  if (view.building === "web") items.push({ id: "building", label: "Building the web app…", enabled: false });
  else if (view.buildError) items.push({ id: "build-error", label: `⚠ ${view.buildError}`, enabled: false });
  items.push({ type: "separator" });

  // --- the server ------------------------------------------------------------
  if (server.up) {
    const since = server.since ? ` since ${when(server.since)}` : "";
    const version = server.version ? ` · v${server.version}` : "";
    items.push({ id: "server", label: `● Server up${since}${version}`, enabled: false });
    const who = server.ours ? null : `started by ${server.adoptedBy}`;
    const because = server.because ? `because ${server.because}` : null;
    const line = [who, because].filter(Boolean).join(" — ");
    if (line) items.push({ id: "server-why", label: `    ${line}`, enabled: false });
    items.push({
      id: "server-agents",
      label: `    ${agents(server.liveAgents)} · ${server.devServers} dev server${server.devServers === 1 ? "" : "s"}`,
      enabled: false,
    });
    if (server.orphaned) items.push({ id: "server-orphaned", label: "    ⚠ its supervisor has gone — a restart would end it", enabled: false });
  } else if (server.starting) {
    items.push({ id: "server", label: "○ Server starting…", enabled: false });
  } else {
    const since = server.downSince ? ` since ${when(new Date(server.downSince).toISOString())}` : "";
    items.push({ id: "server", label: `○ Server down${since}`, enabled: false });
    const last = view.lastEvent;
    const why = server.lastExit ?? (last && last.what !== "start" ? last.why : null);
    if (why) items.push({ id: "server-why", label: `    ${trim(why, 90)}`, enabled: false });
  }

  // --- the pty host ------------------------------------------------------------
  if (host.up) {
    const up = host.uptime ? ` up ${uptimeWords(host.uptime)}` : "";
    const version = host.version ? ` · v${host.version}` : "";
    items.push({ id: "host", label: `● pty host${up}${version}`, enabled: false });
    if (host.behind) {
      items.push({
        id: "host-behind",
        label: `    ⚠ behind this server (protocol ${host.protocol}) — restart it to update, which ends every agent`,
        enabled: false,
      });
    }
  } else {
    items.push({ id: "host", label: "○ pty host down — the next server starts one", enabled: false });
  }
  items.push({ type: "separator" });

  // --- actions ------------------------------------------------------------------
  items.push(view.windowOpen ? { id: "close-window", label: "Close Window" } : { id: "open-window", label: "Open Window" });
  items.push({ id: "restart-server", label: "Restart Server", enabled: server.up || server.starting || view.canStart.ok });
  if (server.up && !server.ours) {
    items.push({ id: "stop-server", label: `Stop Server — it is ${server.adoptedBy}'s; stop it where it was started`, enabled: false });
  } else if (server.up || server.starting) {
    items.push({ id: "stop-server", label: "Stop Server" });
  } else {
    items.push({ id: "start-server", label: view.canStart.ok ? "Start Server" : `Start Server — ${view.canStart.why}`, enabled: view.canStart.ok });
  }
  const live = server.up ? server.liveAgents : 0;
  items.push({
    id: "restart-host",
    label: server.up && server.supervised ? `Restart pty host… (${ending(live)})` : "Restart pty host — needs a supervised server up",
    enabled: Boolean(server.up && server.supervised),
  });
  items.push({ type: "separator" });

  // --- the talk key ------------------------------------------------------------
  const talk = view.talk;
  const talkLabel =
    talk.status === "denied"
      ? "Talk key in every app — needs Input Monitoring"
      : talk.status === "missing"
        ? "Talk key in every app — this build has no key hook"
        : talk.status === "unsupported"
          ? "Talk key in every app — that key cannot be hooked; pick another"
          : talk.status === "crashed"
            ? "Talk key in every app — the hook stopped; switch it off and on"
            : "Talk key in every app";
  items.push({ id: "talk-global", label: talkLabel, type: "checkbox", checked: talk.on });
  if (talk.status === "denied") items.push({ id: "talk-permission", label: "    Open System Settings → Input Monitoring…" });
  items.push({ id: "talk-altspace", label: "⌥Space toggles the microphone", type: "checkbox", checked: talk.altSpace });
  items.push({ type: "separator" });

  // --- where it runs from ---------------------------------------------------------
  const source = [];
  source.push({ id: "source-app", label: view.packaged ? "This app" : "This checkout (the dev shell's)", type: "radio", checked: view.source === "app" });
  if (view.savedCheckout) {
    source.push({ id: "source-checkout", label: shortPath(view.savedCheckout, view.home), type: "radio", checked: view.source === "checkout" });
  }
  source.push({ type: "separator" });
  source.push({ id: "source-choose", label: "Choose a checkout…" });
  if (view.checkout) source.push({ id: "rebuild-web", label: "Rebuild the web app", enabled: !view.building });
  items.push({ id: "source", label: "Run from", submenu: source });

  const logs = [
    { id: "log-lifecycle", label: "Restart log (lifecycle.log)" },
    { id: "log-server", label: "Server log (server.log)" },
    { id: "log-host", label: "pty host log (ptyhost.log)" },
    { type: "separator" },
    { id: "log-reveal", label: "Show in Finder" },
  ];
  items.push({ id: "logs", label: "Logs", submenu: logs });

  const login = view.openAtLogin;
  items.push({
    id: "open-at-login",
    label: login.available
      ? login.status === "requires-approval"
        ? "Open at login — approve it in System Settings → Login Items"
        : "Open at login"
      : "Open at login — only for the installed app",
    type: "checkbox",
    checked: login.on,
    enabled: login.available,
  });
  items.push({ type: "separator" });
  items.push({ id: "quit", label: "Quit Kururu" });
  return items;
}

function trim(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function shortPath(full, home) {
  return home && full.startsWith(home) ? `~${full.slice(home.length)}` : full;
}

/** The tray's title beside the icon: the live agent count, or nothing. */
function trayTitle(view) {
  const count = view.server.up ? view.server.liveAgents : 0;
  return count > 0 ? String(count) : "";
}

module.exports = { menuTemplate, trayTitle, uptimeWords, when };
