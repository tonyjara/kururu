/**
 * The renderer is HTTP content served by the kururu server, so it is treated
 * like any other web page: context isolation on, node integration off. This
 * bridge is the whole surface it gets, and it stays that way — anything the web
 * app can do from a phone it should do the same way here, or the two drift.
 */
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("kururu", {
  /** True in the Electron window, absent in a browser or on the phone. */
  desktop: true,
  /** Where the kururu server is, for the rare thing that needs an absolute URL. */
  serverUrl: () => ipcRenderer.invoke("kururu:server-url"),
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
   */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
});
