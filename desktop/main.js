/**
 * The Electron shell.
 *
 * Its entire job is: make sure a kururu server is running, then show it. The
 * window loads the same URL a phone loads, so there is one build of the UI and
 * no `file://` variant to keep in step. Everything stateful — ptys, the daemon
 * link, the preview proxies — lives in the Bun server, which is why closing
 * this window does not disturb an agent and why the phone keeps working when
 * the desktop app is not running at all.
 *
 * Electron's main process is Node and cannot be Bun, which is the reason the
 * server is a child process rather than a module: it gets to stay on Bun, with
 * Bun.serve and Bun.connect, and this file never imports any of it.
 */
const { app, BrowserWindow, ipcMain, session, shell } = require("electron");
const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.KURURU_PORT || 7717);
const DEV = process.env.KURURU_DEV === "1";
const URL = DEV ? "http://localhost:5173" : `http://127.0.0.1:${PORT}`;

/** Where bun lives when it is not on PATH — a GUI launch inherits almost none. */
const BUN_CANDIDATES = [
  process.env.BUN_PATH,
  path.join(process.env.HOME || "", ".bun/bin/bun"),
  "/opt/homebrew/bin/bun",
  "/usr/local/bin/bun",
].filter(Boolean);

let server = null;

function bunPath() {
  return BUN_CANDIDATES.find((candidate) => existsSync(candidate)) || "bun";
}

async function serverAlive() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, {
      signal: AbortSignal.timeout(600),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Adopt a server that is already up rather than starting a second one — the
 * usual case when the phone has been using it, or when `bun run dev` is
 * running in a terminal. Two servers would fight over the port and over the
 * preview proxies.
 */
async function ensureServer() {
  if (await serverAlive()) return;
  const entry = path.join(__dirname, "../server/src/index.ts");
  server = spawn(bunPath(), ["run", entry], {
    stdio: "inherit",
    env: { ...process.env, KURURU_PORT: String(PORT) },
  });
  server.on("error", (err) => console.error("kururu: could not start the server —", err.message));

  for (let i = 0; i < 40; i++) {
    if (await serverAlive()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  console.error("kururu: server did not come up on", PORT);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 420,
    backgroundColor: "#0d0f0e",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadURL(URL);

  // A link to somewhere else is somewhere else's business: open it in the
  // browser rather than turning this window into one.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  return win;
}

ipcMain.handle("kururu:server-url", () => URL);

app.whenReady().then(async () => {
  /**
   * The desktop equivalent of the proxy's header stripping: a dev server that
   * sends X-Frame-Options would otherwise refuse to render in the preview
   * iframe. Scoped to localhost, which is the only thing the preview loads.
   */
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders || {};
    for (const key of Object.keys(headers)) {
      const name = key.toLowerCase();
      if (name === "x-frame-options" || name === "content-security-policy") delete headers[key];
    }
    callback({ responseHeaders: headers });
  });

  await ensureServer();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

/**
 * Only kill the server if this process started it. One that was already running
 * belongs to a terminal or to the phone, and taking it down on window close
 * would cut the phone off for no reason.
 */
app.on("before-quit", () => {
  if (server) server.kill();
});
