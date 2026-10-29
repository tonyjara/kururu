/**
 * The frog in the menu bar, and what clicking it offers.
 *
 * The three processes used to have one face, `bun run status`, and it is a
 * terminal's. An installed kururu has no terminal, and the pty host — the
 * process holding every agent — has no window, no dock icon and nothing to
 * say it is there. This is that face: the host and the server at a glance,
 * the live count beside the icon, and the verbs that were only ever
 * commands before. `menu.js` makes the sentences; this file attaches the
 * clicks and raises the one dialog that matters.
 *
 * That dialog is the pty host's. Everything else in this menu is free —
 * stopping the server costs the phone a connection and nothing else — and
 * only restarting the host ends agents. So that item names the count, asks,
 * and defaults to no, exactly as `bun run kill-ptyhosts` does, and nothing
 * in here can reach the host any other way.
 */
const { Menu, Tray, app, dialog, nativeImage, shell } = require("electron");
const { homedir } = require("node:os");
const path = require("node:path");
const { readDesktop, writeDesktop } = require("./desktop");
const { menuTemplate, trayTitle } = require("./menu");
const { hostSocket, stateDir } = require("./runner");
const { pillLog } = require("./talkkey");

/** How long a click on the frog waits for the server's list of cards before drawing the menu without a fresh one. */
const CARDS_WAIT_MS = 350;

/**
 * @param {object} options
 * @param {import("./runner").Runner} options.runner
 * @param {import("./talkkey").TalkKey} options.talk
 * @param {import("./notes").NoteWindows} options.notes
 * @param {string} options.version
 * @param {boolean} options.packaged
 * @param {object} options.actions  `openWindow`, `closeWindow`, `windowOpen`, `nodes`, `openNode`, `quit`, `serverChanged`, `webRebuilt`
 */
function createTray({ runner, talk, notes, version, packaged, actions }) {
  const image = nativeImage.createFromPath(path.join(__dirname, "icon", "trayTemplate.png"));
  image.setTemplateImage(true);
  const tray = new Tray(image);
  tray.setToolTip("Kururu");

  /**
   * The active profile's cards, for "Pop Out a Card": asked of the server at
   * the click, with a short wait, since the menu is built then and a list
   * kept up to date on a timer would be a poll for a menu nobody opened. The
   * last answer stands in for one that is late, and a server that is down is
   * said in the label.
   */
  let cards = null;
  const fetchCards = async () => {
    if (!runner.health) {
      cards = null;
      return;
    }
    try {
      const res = await fetch(`${runner.local}/api/notes/cards`, { signal: AbortSignal.timeout(CARDS_WAIT_MS) });
      cards = res.ok ? await res.json() : cards;
    } catch {
      // Late or refused: the last answer, if there was one.
    }
  };

  const view = () => {
    const config = readDesktop();
    const login = packaged ? app.getLoginItemSettings() : { openAtLogin: false, status: "not-registered" };
    return {
      ...runner.view(),
      appVersion: version,
      packaged,
      home: homedir(),
      windowOpen: actions.windowOpen(),
      nodes: actions.nodes(),
      source: config.source,
      savedCheckout: config.checkout,
      talk: talk.state(),
      notes: {
        list: notes.list(),
        cards: runner.health ? cards : null,
        why: runner.health ? "the server did not answer" : "needs the server up",
      },
      openAtLogin: { on: login.openAtLogin, available: packaged, status: login.status },
    };
  };

  const title = () => {
    tray.setTitle(trayTitle(runner.view()));
  };
  runner.on("change", title);
  title();

  /** Attach a click to every item `menu.js` named, submenus included. */
  const attach = (items) =>
    items.map((item) => ({
      ...item,
      ...(item.submenu ? { submenu: attach(item.submenu) } : {}),
      ...(item.id && clicks[item.id] ? { click: () => void clicks[item.id]() } : {}),
      // One item per node, by id, so the click names the node and not a menu position.
      ...(item.id?.startsWith("node:") ? { click: () => void actions.openNode(item.id.slice("node:".length)) } : {}),
      // And per note and per card, likewise.
      ...(noteClick(item) ? { click: noteClick(item) } : {}),
    }));

  const noteClick = (item) => {
    const [verb, cardId] = splitId(item.id);
    if (!cardId) return null;
    if (verb === "note-toggle") return () => notes.setShown(cardId, !item.checked);
    if (verb === "note-close") return () => notes.close(cardId);
    if (verb === "note-pop") {
      const card = cardsById().get(cardId);
      if (!card || !cards) return null;
      return () => notes.popOut({ cardId, profileKey: cards.profileKey, profileName: cards.profileName, title: card.title, code: card.code });
    }
    return null;
  };
  const cardsById = () => new Map([...(cards?.needs ?? []), ...(cards?.columns ?? []).flatMap((column) => column.cards)].map((card) => [card.id, card]));

  // Built fresh on every click, so the record is read off the disk at that
  // moment rather than kept in step by a timer.
  const show = async () => {
    await fetchCards();
    tray.popUpContextMenu(Menu.buildFromTemplate(attach(menuTemplate(view()))));
  };
  tray.on("click", show);
  tray.on("right-click", show);

  const failed = (what, result) => {
    if (result.ok) return;
    dialog.showErrorBox(`Kururu could not ${what}`, result.why ?? "It did not say why.");
  };

  /**
   * Stop whatever this app is running, change the source, start again from
   * the new one. The pty host is not involved: the new server connects to
   * the host the old one was using, agents and all, and the menu says if
   * that host is now behind the code it is serving.
   *
   * An adopted server is left exactly where it is. The source is about what
   * *this app* starts, not about who holds the port, so with `bun run dev`
   * on 7717 the choice is saved and takes effect the next time this app
   * starts a server — and no dialog says it could not start one now, since
   * it was not asked to. What does change at once is the page: the old
   * source's vite is stopped either way, and the window and the pill move to
   * the new source's page in front of whichever server is there.
   */
  const switchSource = async (next) => {
    const wasRunning = Boolean(runner.child);
    await runner.stop("the source was changed");
    runner.configure(next);
    writeDesktop(next);
    if (!wasRunning && runner.adopted()) {
      actions.serverChanged();
      return;
    }
    if (wasRunning || packaged) failed("start the server", await runner.start("the source was changed"));
    actions.serverChanged();
  };

  const clicks = {
    "open-window": () => actions.openWindow(),
    "close-window": () => actions.closeWindow(),
    // Kuru's lines. Play asks the server, which has the voice; Open is the
    // window with the drawer up. Both are the profile on screen's.
    "kuru-play": async () => {
      try {
        const res = await fetch(`${runner.local}/api/kuru/play`, { method: "POST", signal: AbortSignal.timeout(3000) });
        if (!res.ok) failed("play Kuru's unheard replies", { ok: false, why: `the server said ${res.status}` });
      } catch (err) {
        failed("play Kuru's unheard replies", { ok: false, why: err instanceof Error ? err.message : String(err) });
      }
    },
    "kuru-open": () => actions.openKuru(),
    "restart-server": async () => failed("restart the server", await runner.restart()),
    "stop-server": () => runner.stop(),
    "start-server": async () => failed("start the server", await runner.start()),
    "restart-host": async () => {
      const live = Number(runner.health?.liveAgents) || 0;
      app.focus({ steal: true });
      const { response } = await dialog.showMessageBox({
        type: "warning",
        buttons: ["Restart the pty host", "Cancel"],
        defaultId: 1,
        cancelId: 1,
        message:
          live === 0
            ? "Restart the pty host?"
            : live === 1
              ? "Restarting the pty host ends 1 agent."
              : `Restarting the pty host ends ${live} agents.`,
        detail:
          "The pty host holds every terminal on this machine. A new one starts with none, on the current build; the server restarts with it and the window reconnects. Nothing can hand a running agent to the new host — whatever they were doing stops here.",
      });
      if (response !== 0) return;
      failed("restart the pty host", await runner.restartHost());
    },
    "talk-global": () => talk.setEnabled(!talk.enabled),
    "talk-permission": () => talk.openInputMonitoring(),
    "talk-altspace": () => talk.setAltSpace(!talk.altSpace),
    "reset-pill": () => talk.resetPlace(),
    "notes-show-all": () => notes.showAll(),
    "notes-hide-all": () => notes.hideAll(),
    "source-app": () => switchSource({ source: "app", checkout: readDesktop().checkout }),
    "source-checkout": () => {
      const { checkout } = readDesktop();
      if (checkout) void switchSource({ source: "checkout", checkout });
    },
    "source-choose": async () => {
      app.focus({ steal: true });
      const picked = await dialog.showOpenDialog({
        title: "Choose a kururu checkout",
        message:
          "A kururu checkout you have run `bun install` in. The server runs from it, with the file watcher, and the window and the floating pill load its web app through vite, so a change under web/ shows as it is saved.",
        properties: ["openDirectory"],
        buttonLabel: "Run from here",
      });
      const dir = picked.filePaths[0];
      if (picked.canceled || !dir) return;
      const report = runner.checkoutReport(dir);
      if (!report.ok) {
        dialog.showErrorBox("That folder cannot be run from", report.problems.join("\n"));
        return;
      }
      await switchSource({ source: "checkout", checkout: dir });
    },
    "rebuild-web": async () => {
      const checkout = runner.effectiveCheckout();
      if (!checkout) return;
      const built = await runner.buildWeb(checkout);
      if (!built) failed("build the web app", { ok: false, why: runner.buildError ?? "see server.log" });
      else actions.webRebuilt();
    },
    "log-lifecycle": () => shell.openPath(path.join(stateDir(), "lifecycle.log")),
    "log-server": () => shell.openPath(runner.serverLog()),
    "log-vite": () => shell.openPath(runner.viteLog()),
    "log-host": () => shell.openPath(path.join(path.dirname(hostSocket()), "ptyhost.log")),
    "log-pill": () => shell.openPath(pillLog()),
    "log-reveal": () => shell.showItemInFolder(path.join(stateDir(), "lifecycle.log")),
    "open-at-login": () => {
      if (!packaged) return;
      const on = !app.getLoginItemSettings().openAtLogin;
      app.setLoginItemSettings({ openAtLogin: on });
    },
    quit: () => actions.quit(),
  };

  return {
    refresh: title,
    destroy() {
      runner.off("change", title);
      tray.destroy();
    },
  };
}

/** `note-pop:<card>` as its verb and its card, or a verb alone for an id with no card in it. */
function splitId(id) {
  if (typeof id !== "string") return [null, null];
  const at = id.indexOf(":");
  return at < 0 ? [id, null] : [id.slice(0, at), id.slice(at + 1)];
}

module.exports = { createTray };
