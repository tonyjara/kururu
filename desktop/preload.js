/**
 * The renderer is HTTP content served by the kururu server, so it is treated
 * like any other web page: context isolation on, node integration off. This
 * bridge is the whole surface it gets, and it stays that way — anything the web
 * app can do from a phone it should do the same way here, or the two drift.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kururu", {
  /** True in the Electron window, absent in a browser or on the phone. */
  desktop: true,
  /** Where the kururu server is, for the rare thing that needs an absolute URL. */
  serverUrl: () => ipcRenderer.invoke("kururu:server-url"),
});
