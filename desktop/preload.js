/**
 * The bridge, and the two very different pages it has to serve.
 *
 * The app is HTTP content served by a kururu server — which may be on this
 * machine or on a box across a tailnet — so it is treated like any other web
 * page: context isolation on, node integration off. What it is handed is the
 * whole surface it gets, and it stays tiny on purpose. Anything the web app can
 * do from a phone it should do the same way here, or the two drift.
 *
 * The picker is the other page, and it needs the one capability that must never
 * be on that surface: pointing this window at an arbitrary address. A served
 * page able to call `connect()` is a served page able to move the window
 * somewhere else, which is a redirect attack with none of the work.
 *
 * A preload is chosen when the window is built and cannot be swapped per
 * navigation, so the two APIs live in one file and the boundary is drawn where
 * it can actually be trusted: `location.protocol`. The picker is a file kururu
 * ships and loads from disk; nothing arriving over HTTP can make itself
 * `file:`, and nothing served can therefore reach the half below.
 */
const { contextBridge, ipcRenderer, webUtils } = require("electron");

const isPicker = location.protocol === "file:" && location.pathname.endsWith("connect.html");

if (isPicker) {
  contextBridge.exposeInMainWorld("picker", {
    /** Told on every probe sweep: which addresses are known, and which answered. */
    onState(listener) {
      ipcRenderer.on("picker:state", (_event, state) => listener(state));
    },
    /** Say the page is listening, so the current state arrives without waiting for a sweep. */
    ready() {
      ipcRenderer.send("picker:ready");
    },
    connect(address) {
      return ipcRenderer.invoke("picker:connect", address);
    },
    forget(address) {
      return ipcRenderer.invoke("picker:forget", address);
    },
  });
} else {
  contextBridge.exposeInMainWorld("kururu", {
    /** True in the Electron window, absent in a browser or on the phone. */
    desktop: true,
    /** Which server this window is showing, for the rare thing that needs an absolute URL. */
    serverUrl: () => ipcRenderer.invoke("kururu:server-url"),
    /**
     * Raise this window, for a click on a notification. See the note on
     * `show?()` in `web/src/desktop.ts` for why this is on the bridge and why
     * it is the whole of what it can do.
     */
    show: () => ipcRenderer.send("kururu:show"),
    /**
     * Where a file dropped onto the window actually is on disk.
     *
     * This has to be here because it cannot be anywhere else. A renderer is given
     * a `File` for a dropped file and, by the web's rules, is told nothing about
     * where it came from — `File.path` was Electron's non-standard answer to that
     * and was removed in Electron 32. `webUtils.getPathForFile` replaced it, and
     * it only exists on this side of the bridge.
     *
     * Which is also why the web app must not assume it: a phone dropping a photo
     * into the same UI over the tailnet has no path to be told, and the caller
     * treats null as "this runtime cannot answer that" rather than as a failure.
     *
     * Worth knowing what it now means for a *remote* server: the path is real on
     * the machine holding the window and means nothing on the machine holding the
     * agent. That is a live wrong answer rather than a missing one, and it is the
     * next thing to fix on this bridge.
     */
    pathForFile: (file) => {
      try {
        return webUtils.getPathForFile(file) || null;
      } catch {
        return null;
      }
    },
    /**
     * Replacing this application with a newer one.
     *
     * The whole of what a page may say is "fetch it" and "restart into it".
     * Where the download comes from is `app-update.yml` inside the bundle and
     * is not addressable from here, and Squirrel refuses an archive that is not
     * signed the way the running app is — so this is two verbs and no nouns,
     * which is what makes it something a served page can be handed. See the
     * long note in `main.js`; it also answers `unavailable` for every case
     * except a packaged window showing the server it started itself.
     *
     * `onState` hands back its own unsubscribe rather than relying on the page
     * living as long as the window: Settings is a dialog that opens and closes
     * all afternoon, and a listener per open is a listener per open forever.
     */
    update: {
      state: () => ipcRenderer.invoke("kururu:update-state"),
      onState: (listener) => {
        const relay = (_event, state) => listener(state);
        ipcRenderer.on("kururu:update", relay);
        return () => ipcRenderer.removeListener("kururu:update", relay);
      },
      download: () => ipcRenderer.send("kururu:update-download"),
      install: () => ipcRenderer.send("kururu:update-install"),
    },
  });
}
