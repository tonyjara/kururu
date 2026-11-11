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
 */
const { app } = require("electron");
const path = require("node:path");

/** @type {{ stays: (handle: Buffer, stays: boolean) => boolean, read: (handle: Buffer) => Record<string, unknown> | undefined } | null | undefined} */
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
 * What AppKit says about a window — `canHide`, `visible`, `level`,
 * `behavior` (the collection behaviour), `appHidden` — for a test or a
 * debugging session to check against; nothing in the app reads it.
 * @param {import("electron").BrowserWindow} win
 */
function nativeState(win) {
  const native = load();
  if (!native || win.isDestroyed()) return undefined;
  return native.read(win.getNativeWindowHandle());
}

module.exports = { staysUp, nativeState };
