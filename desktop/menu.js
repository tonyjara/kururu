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

function unheard(count) {
  return count === 1 ? "1 unheard reply" : `${count} unheard replies`;
}

function undelivered(count) {
  return count === 1 ? "1 message did not get through" : `${count} messages did not get through`;
}

/**
 * @param view  the runner's `view()` plus the app's own facts:
 *   `appVersion`, `packaged`, `windowOpen`, `talk` ({ on, status, altSpace }),
 *   `nodes` ([{ id, name, why }], `why` null when it can be opened),
 *   `notes` — see `notesSection`,
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

  // --- the checkout's vite -------------------------------------------------------
  if (view.checkout && view.vite) items.push({ id: "vite", label: viteLine(view.vite), enabled: false });
  items.push({ type: "separator" });

  // --- Kuru --------------------------------------------------------------------
  // The background presence of the conversation, for a Mac with no window
  // open: a persistent count floating over every app would be intrusive, so
  // it is here, and in the title beside the frog. Only when there is news —
  // the quiet state is nothing, as on the chip.
  const kuru = server.up ? server.kuru : null;
  if (kuru && (kuru.unheard > 0 || kuru.undelivered > 0)) {
    if (kuru.unheard > 0) {
      items.push({ id: "kuru", label: `Kuru: ${unheard(kuru.unheard)}`, enabled: false });
      items.push({ id: "kuru-play", label: "    Play" });
      items.push({ id: "kuru-open", label: "    Open the conversation" });
    }
    if (kuru.undelivered > 0) {
      items.push({ id: "kuru-failed", label: `${undelivered(kuru.undelivered)} to Kuru`, enabled: false });
      items.push({ id: "kuru-open", label: "    Open the conversation" });
    }
    items.push({ type: "separator" });
  }

  // --- the other kururus ----------------------------------------------------------
  // Every member of the roster but this one, from the local server. One whose
  // link is down stays in the list, greyed, with why: a Mac asleep is the
  // node somebody looks for from a child, and a list without it would read
  // as a node removed.
  const nodes = view.nodes ?? [];
  if (nodes.length) {
    items.push({ id: "nodes", label: "Nodes", enabled: false });
    for (const node of nodes) {
      // A node whose workspaces open in the window from its sidebar is
      // reached here only for what the window cannot show: its Settings.
      const label = node.settings ? `    ${node.name}'s Settings` : `    Open ${node.name}`;
      items.push(node.why ? { id: `node:${node.id}`, label: `    ${node.name} — ${node.why}`, enabled: false } : { id: `node:${node.id}`, label });
    }
    items.push({ type: "separator" });
  }

  // --- the notes ------------------------------------------------------------------
  items.push(...notesSection(view.notes));

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
  // There is no pill to put anywhere while neither of the two things that float one is on.
  items.push({ id: "reset-pill", label: "Reset Pill Position", enabled: talk.on || talk.altSpace });
  items.push({ type: "separator" });

  // --- where it runs from ---------------------------------------------------------
  const source = [];
  source.push({ id: "source-app", label: view.packaged ? "This app" : "This checkout (the dev shell's)", type: "radio", checked: view.source === "app" });
  if (view.savedCheckout) {
    source.push({ id: "source-checkout", label: shortPath(view.savedCheckout, view.home), type: "radio", checked: view.source === "checkout" });
  }
  source.push({ type: "separator" });
  source.push({ id: "source-choose", label: "Choose a checkout…" });
  if (view.checkout) {
    source.push({
      id: "rebuild-web",
      label: `Rebuild the web app for the phone${view.webStale ? " — behind web/src" : ""}`,
      enabled: !view.building,
    });
  }
  items.push({ id: "source", label: "Run from", submenu: source });

  const logs = [
    { id: "log-lifecycle", label: "Restart log (lifecycle.log)" },
    { id: "log-server", label: "Server log (server.log)" },
    ...(view.checkout ? [{ id: "log-vite", label: "Vite log (vite.log)" }] : []),
    { id: "log-host", label: "pty host log (ptyhost.log)" },
    { id: "log-pill", label: "Floating pill log (pill.log)" },
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

/** How many cards a list in "Pop Out a Card" shows before it says how many more there are. */
const CARDS_SHOWN = 20;

/** A card as a menu row: its code and its title, cut to what a menu can hold. */
function cardLabel(card) {
  const title = trim(card.title || "Untitled", 56);
  return card.code ? `${card.code}  ${title}` : title;
}

/**
 * The notes: every card popped out as a window, each ticked while it is up
 * and a click to put away or bring back; all of them at once; closing one;
 * and popping a card out from here, for a Mac with no window open.
 *
 * @param notes  `list` — [{ cardId, code, title, state, away, waiting, profileName }] as `notes.js` lists them;
 *   `cards` — the active profile's cards as `GET /api/notes/cards` answers, or null;
 *   `why` — why there are no cards to offer, when `cards` is null
 */
function notesSection(notes) {
  const items = [];
  const list = notes?.list ?? [];
  if (list.length) {
    items.push({ id: "notes", label: "Notes", enabled: false });
    for (const note of list) {
      const waits = note.away
        ? ` — waits for ${note.profileName || "its profile"}`
        : note.waiting
          ? " — opening…"
          : "";
      items.push({
        id: `note-toggle:${note.cardId}`,
        label: `    ${cardLabel(note)}${waits}`,
        type: "checkbox",
        checked: note.state === "shown",
      });
    }
    // Only the one that would do something: a grey "Show All" beside notes
    // that are all up is a grey item with no reason.
    if (list.some((note) => note.state === "hidden")) items.push({ id: "notes-show-all", label: "    Show All Notes" });
    if (list.some((note) => note.state === "shown")) items.push({ id: "notes-hide-all", label: "    Hide All Notes" });
    items.push({
      id: "notes-close",
      label: "    Close a Note",
      submenu: list.map((note) => ({ id: `note-close:${note.cardId}`, label: cardLabel(note) })),
    });
  }
  items.push(popOutItem(notes, new Set(list.filter((note) => note.state === "shown").map((note) => note.cardId))));
  items.push({ type: "separator" });
  return items;
}

/**
 * "Pop Out a Card": what needs you first — the Needs drawer's cards, a click
 * from a note — and then the profile's board a column at a time. A card that
 * is a note already is ticked, and a click brings it forward.
 */
function popOutItem(notes, up) {
  const cards = notes?.cards ?? null;
  if (!cards) return { id: "note-pop", label: `Pop Out a Card — ${notes?.why ?? "needs the server up"}`, enabled: false };
  const row = (card) => ({
    id: `note-pop:${card.id}`,
    label: card.where ? `${cardLabel(card)} · ${trim(card.where, 24)}` : cardLabel(card),
    type: "checkbox",
    checked: up.has(card.id),
  });
  const more = (count, where) => ({ id: "note-pop-more", label: `${count} more — pop them out from ${where}`, enabled: false });
  const submenu = [];
  if (cards.needs.length) {
    submenu.push({ id: "note-pop-needs", label: "Needs you", enabled: false });
    submenu.push(...cards.needs.slice(0, CARDS_SHOWN).map(row));
    if (cards.needs.length > CARDS_SHOWN) submenu.push(more(cards.needs.length - CARDS_SHOWN, "the Needs drawer"));
  }
  const columns = cards.columns.filter((column) => column.cards.length);
  if (columns.length) {
    if (submenu.length) submenu.push({ type: "separator" });
    submenu.push({ id: "note-pop-board", label: `${cards.profileName}'s board`, enabled: false });
    for (const column of columns) {
      const rows = column.cards.slice(0, CARDS_SHOWN).map(row);
      if (column.cards.length > CARDS_SHOWN) rows.push(more(column.cards.length - CARDS_SHOWN, "the board"));
      submenu.push({ id: `note-pop-column:${column.id}`, label: `${column.name} (${column.cards.length})`, submenu: rows });
    }
  }
  if (submenu.length === 0) return { id: "note-pop", label: "Pop Out a Card — nothing needs you and the board is empty", enabled: false };
  return { id: "note-pop", label: "Pop Out a Card", submenu };
}

/**
 * The checkout's vite in one line. It is what the window and the pill are
 * showing, so the line says that — and when it is not serving, what they show
 * instead.
 */
function viteLine(vite) {
  const port = `:${vite.port}`;
  switch (vite.status) {
    case "up":
      return `● vite on ${port} — the window and the pill reload as web/ is saved`;
    case "adopted":
      return `● vite on ${port}, already running — the window and the pill reload as web/ is saved`;
    case "starting":
      return `○ vite starting on ${port}…`;
    case "failed":
      return `⚠ ${trim(vite.error ?? "vite stopped", 70)} — the window shows web/dist`;
    default:
      return "○ vite down — it starts with the server";
  }
}

function trim(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function shortPath(full, home) {
  return home && full.startsWith(home) ? `~${full.slice(home.length)}` : full;
}

/**
 * The tray's title beside the icon. Empty to show only the frog.
 */
function trayTitle(view) {
  return "";
}

module.exports = { menuTemplate, notesSection, trayTitle, unheard, undelivered, uptimeWords, when };
