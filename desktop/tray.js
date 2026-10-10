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

/**
 * @param {object} options
 * @param {import("./runner").Runner} options.runner
 * @param {import("./talkkey").TalkKey} options.talk
 * @param {string} options.version
 * @param {boolean} options.packaged
 * @param {object} options.actions  `openWindow`, `closeWindow`, `windowOpen`, `quit`, `serverChanged`, `webRebuilt`
 */
function createTray({ runner, talk, version, packaged, actions }) {
  const image = nativeImage.createFromPath(path.join(__dirname, "icon", "trayTemplate.png"));
  image.setTemplateImage(true);
  const tray = new Tray(image);
  tray.setToolTip("Kururu");

  const view = () => {
    const config = readDesktop();
    const login = packaged ? app.getLoginItemSettings() : { openAtLogin: false, status: "not-registered" };
    return {
      ...runner.view(),
      appVersion: version,
      packaged,
      home: homedir(),
      windowOpen: actions.windowOpen(),
      source: config.source,
      savedCheckout: config.checkout,
      talk: talk.state(),
      openAtLogin: { on: login.openAtLogin, available: packaged, status: login.status },
    };
  };

  const title = () => {
    const h = runner.health;
    tray.setTitle(trayTitle({ server: { up: Boolean(h), liveAgents: Number(h?.liveAgents) || 0 } }));
  };
  runner.on("change", title);
  title();

  /** Attach a click to every item `menu.js` named, submenus included. */
  const attach = (items) =>
    items.map((item) => ({
      ...item,
      ...(item.submenu ? { submenu: attach(item.submenu) } : {}),
      ...(item.id && clicks[item.id] ? { click: () => void clicks[item.id]() } : {}),
    }));

  // Built fresh on every click, so the record is read off the disk at that
  // moment rather than kept in step by a timer.
  const show = () => tray.popUpContextMenu(Menu.buildFromTemplate(attach(menuTemplate(view()))));
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

module.exports = { createTray };
