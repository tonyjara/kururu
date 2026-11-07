/**
 * The screen pen's overlay page and the main process, and nothing else.
 *
 * `ink.html` is a file the app ships, loaded into one transparent window per
 * display while a session is on (`ink.js`). It is handed the strokes' road
 * in and the session's state out, and no other door: no server, no bridge
 * to kururu's own API, and every message it sends is checked in main
 * against the overlays of the session that is on. The tools are the pill's.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ink", {
  /** A stroke began, at a point in the window, at a time on `performance.timeOrigin + now()`. */
  begin: (point, t) => ipcRenderer.send("ink:begin", { point: [Number(point && point[0]), Number(point && point[1])], t: Number(t) }),
  /** More of the stroke, as `[x, y]` pairs. */
  points: (points) => ipcRenderer.send("ink:points", Array.isArray(points) ? points.slice(0, 2000) : []),
  /** The pen lifted. */
  end: (t) => ipcRenderer.send("ink:end", { t: Number(t) }),
  /** The last mark on this display was taken back: its ink comes off. */
  onUndo: (listener) => {
    ipcRenderer.on("ink:undo", () => listener());
  },
  /** A snapshot was taken of this display. */
  onFlash: (listener) => {
    ipcRenderer.on("ink:flash", () => listener());
  },
  onState: (listener) => {
    ipcRenderer.on("ink:state", (_event, state) => listener(state && typeof state === "object" ? state : {}));
  },
  onFull: (listener) => {
    ipcRenderer.on("ink:full", (_event, max) => listener(Number(max)));
  },
});
