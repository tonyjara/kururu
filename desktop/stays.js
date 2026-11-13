/**
 * The windows that stay up while kururu is hidden.
 *
 * Hiding an application takes every window it has with it, and a hidden
 * kururu is ordinary: ⌘H, or a workspace switcher that hides every app not
 * in the workspace it switches to, which is how the owner moves between
 * workspaces (Tile Bandit, with `NSRunningApplication.hide`). The window and
 * the notes belong to kururu's workspace and go with it. The floating Kuru,
 * the pill and the pen's ink are made to be over every app, whatever is in
 * front, and a logo that went away whenever the workspace with kururu in it
 * did would be over one workspace's apps only.
 *
 * Nothing else changes for those windows. They are already on every space
 * and over full-screen apps (`setVisibleOnAllWorkspaces`), and none of them
 * activates the app: the chat takes the keys as a non-activating panel does,
 * so opening it while kururu is hidden leaves kururu hidden, its window
 * down and the app in front with the menu bar. Only something said in the
 * chat that asks for the window — a card, a terminal — brings it back.
 *
 * The property is NSWindow's `canHide`, which Electron neither sets nor
 * offers, so it is set by a small addon (`stay/stay.m`). An app built
 * without it, or a Mac it will not load on, has these windows hide with the
 * app as they always did, said once on the console.
 *
 * The same addon holds the one other window property Electron reaches only
 * for a whole window: the first click, given to the room the page draws the
 * window's three buttons in and nowhere else (`firstClick`; `stay.m` says
 * why).
 *
 * And it finishes what Electron's `type: "panel"` leaves half done
 * (`neverActivates`). Such a panel tells AppKit it is non-activating but
 * never told the window server, so a click on the floating Kuru could bring
 * kururu to the front — and a workspace switcher that follows the app in
 * front, as the owner's does, then left the workspace they were in for the
 * one with kururu's window. Every panel kururu makes is told as it is made,
 * before it is first shown, which is the only time the telling takes.
 */
const { app } = require("electron");
const path = require("node:path");

/** @type {{ stays: (handle: Buffer, stays: boolean) => boolean, firstClick?: (handle: Buffer, x: number, y: number, width: number, height: number) => boolean, neverActivates?: (handle: Buffer) => boolean, read: (handle: Buffer) => Record<string, unknown> | undefined } | null | undefined} */
let addon;

function load() {
  if (addon !== undefined) return addon;
  addon = null;
  // Only in Electron's main: the tests run these modules under Bun with a stand-in Electron.
  if (process.platform !== "darwin" || !process.versions.electron || !app) return addon;
  const file = app.isPackaged ? path.join(process.resourcesPath, "server", "stay.node") : path.join(__dirname, "dist", "stay.node");
  try {
    addon = require(file);
  } catch (err) {
    console.warn(`kururu: ${file} did not load, so the floating windows hide with the app (${/** @type {Error} */ (err).message})`);
  }
  return addon;
}

/**
 * This window stays on screen while the app is hidden. True if it was set.
 * @param {import("electron").BrowserWindow} win
 */
function staysUp(win) {
  const native = load();
  if (!native || win.isDestroyed()) return false;
  try {
    return native.stays(win.getNativeWindowHandle(), true);
  } catch {
    return false;
  }
}

/**
 * This panel's clicks never activate the app, for the window server too
 * (`stay.m` has why). Called as the panel is made, before its first show,
 * which is the only moment it reaches the window server. True if the addon
 * took it; a build or a Mac without it leaves the panel as Electron made it.
 * @param {import("electron").BrowserWindow} win
 */
function neverActivates(win) {
  const native = load();
  if (!native?.neverActivates || win.isDestroyed()) return false;
  try {
    return native.neverActivates(win.getNativeWindowHandle());
  } catch {
    return false;
  }
}

/**
 * The room the page's three buttons take, as the page sent it in its own
 * pixels, put into the window's points; null for none, or for anything that
 * is not four finite numbers and a width and height above nothing. A page at
 * 110% measures its buttons a tenth smaller than the window holds them, so
 * the room is multiplied by the zoom the window reports.
 * @param {unknown} raw
 * @param {number} zoom
 * @returns {{ x: number, y: number, width: number, height: number } | null}
 */
function firstClickRoom(raw, zoom) {
  if (!raw || typeof raw !== "object" || !Number.isFinite(zoom) || zoom <= 0) return null;
  const { x, y, width, height } = /** @type {Record<string, unknown>} */ (raw);
  if (typeof x !== "number" || typeof y !== "number" || typeof width !== "number" || typeof height !== "number") return null;
  const room = { x: x * zoom, y: y * zoom, width: width * zoom, height: height * zoom };
  if (!Object.values(room).every(Number.isFinite)) return null;
  // Three buttons and the room between them; anything near a window's size is a page that measured the wrong thing.
  if (room.width <= 0 || room.height <= 0 || room.width > 400 || room.height > 200) return null;
  return room;
}

/**
 * A first click in `room` on this window acts while the window is behind,
 * as one on the system's own buttons does (`stay.m`); null takes it away.
 * True if the addon took it.
 * @param {import("electron").BrowserWindow} win
 * @param {{ x: number, y: number, width: number, height: number } | null} room
 */
function firstClick(win, room) {
  const native = load();
  if (!native?.firstClick || win.isDestroyed()) return false;
  try {
    return room ? native.firstClick(win.getNativeWindowHandle(), room.x, room.y, room.width, room.height) : native.firstClick(win.getNativeWindowHandle(), 0, 0, 0, 0);
  } catch {
    return false;
  }
}

/**
 * What AppKit says about a window — `canHide`, `visible`, `level`,
 * `behavior` (the collection behaviour), `appHidden`, `firstClick` (a room
 * is set), `preventsActivation` — for a test or a
 * debugging session to check against; nothing in the app reads it.
 * @param {import("electron").BrowserWindow} win
 */
function nativeState(win) {
  const native = load();
  if (!native || win.isDestroyed()) return undefined;
  return native.read(win.getNativeWindowHandle());
}

module.exports = { staysUp, neverActivates, nativeState, firstClick, firstClickRoom };
