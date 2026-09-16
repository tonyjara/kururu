/**
 * The Electron shell — a window onto a kururu server, and nothing else.
 *
 * It used to be the whole application: it forked the server and the pty host as
 * utilityProcesses, watched the source and re-forked on save, and asked before
 * quitting because quitting killed every agent. That made one launch bring
 * everything up, which was the point, and it also made the agents *the window's*
 * — so closing the app ended work that had nothing to do with a window, and a
 * server on a machine that is always on was not expressible at all.
 *
 * The processes moved out. The pty host listens on a socket and outlives
 * everything (`server/src/ptyhostd.ts`); the server connects to it and is
 * something you run (`server/run.mjs`); this is a viewer that finds one and
 * loads it. What that buys is the thing the split was always claiming: quitting
 * this costs a window. Your agents are somewhere else, still working, and the
 * phone never noticed you closed anything.
 *
 * So what is left here is small and deliberately so — find a server, draw it,
 * and hand the page the one capability a browser cannot give it. Anything that
 * knows what an agent is belongs on the other side of the HTTP boundary, because
 * that side is also what the phone talks to, and a thing only this file can do
 * is a thing the phone cannot.
 */
const { app, BrowserWindow, Menu, dialog, ipcMain, session, shell } = require("electron");
const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");
const { candidates, forget, normalize, remember } = require("./servers");

const DEV = process.env.KURURU_DEV === "1";
const VITE_URL = `http://localhost:${process.env.KURURU_VITE_PORT || 5173}`;
const PICKER = path.join(__dirname, "connect.html");

/** Where bun lives when it is not on PATH — a GUI launch inherits almost none. */
const BUN_CANDIDATES = [
  process.env.BUN_PATH,
  path.join(process.env.HOME || "", ".bun/bin/bun"),
  "/opt/homebrew/bin/bun",
  "/usr/local/bin/bun",
].filter(Boolean);

function bunPath() {
  return BUN_CANDIDATES.find((candidate) => existsSync(candidate)) || "bun";
}

let win = null;
/** The server the window is showing, as an origin. Null while the picker is up. */
let connected = null;

// ---------------------------------------------------------------------------
// Finding a server
// ---------------------------------------------------------------------------

/**
 * Is there a kururu server here?
 *
 * `/api/health` rather than the root, because the root of a server whose web app
 * has not been built is a 404 while the server itself is perfectly fine — and
 * "connect to it and see" is a much worse answer to give someone than a dot.
 *
 * The timeout is short and unapologetic: this runs against every remembered
 * address once a second, and an address that is not answering promptly is one
 * the picker should be drawing as down.
 */
async function reachable(base) {
  try {
    const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1200) });
    return response.ok;
  } catch {
    return false;
  }
}

/** The picker's view of the world, rebuilt each sweep and pushed to it. */
let entries = candidates().map((entry) => ({ ...entry, reachable: false }));
let sweeping = false;
let sweepTimer = null;

function pushPickerState() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send("picker:state", { entries, checking: sweeping });
}

/**
 * One pass over every address, and a connection if one of them answers.
 *
 * This is the whole of "it should also be listening to local ones": there is
 * nothing to listen *to* — a server that starts raises no event anybody outside
 * it can hear — so the picker asks, repeatedly, and the loop is what makes
 * starting a server in another terminal look like the window noticing.
 *
 * It only ever runs while the picker is showing, which is what keeps it from
 * being a thing that moves you off a server you are already using.
 */
async function sweep() {
  if (sweeping || connected) return;
  sweeping = true;
  entries = candidates().map((entry) => ({ ...entry, reachable: false }));
  pushPickerState();

  const results = await Promise.all(entries.map((entry) => reachable(entry.address)));
  for (let i = 0; i < entries.length; i++) entries[i].reachable = results[i];
  sweeping = false;
  pushPickerState();

  // Already gone somewhere by the time the answers came back.
  if (connected) return;
  const found = entries.find((entry) => entry.reachable);
  if (found) await connect(found.address);
}

/**
 * Watching the server we are actually on, which is a different job from looking
 * for one and needs a different clock.
 *
 * `session.ts` reconnects forever and must keep doing so: the server restarts
 * on every save, a phone drops the socket every time it sleeps, and a page that
 * gave up on either would be wrong far more often than right. But "forever" is
 * the correct answer to *a gap* and the wrong answer to *a server that is not
 * coming back* — close the laptop the VM was on, or stop the server, and the
 * window sits on a dead page reconnecting into nothing, with no way to say where
 * it would rather be pointed.
 *
 * So the window bails out to the picker, and the *strike count times the
 * interval* is the whole design. A restart through `run.mjs` is one to three
 * seconds of entirely legitimate silence, and bouncing to the picker during one
 * would tear down every emulator in the window to reconnect to the server that
 * was always coming back — much worse than the problem. Three strikes at three
 * seconds is about ten seconds of confirmed silence: far past any restart, and
 * still prompt when the thing is genuinely gone.
 */
const HEALTH_EVERY_MS = 3000;
const HEALTH_STRIKES = 3;

let watchTimer = null;
let strikes = 0;

function stopWatchingServer() {
  clearInterval(watchTimer);
  watchTimer = null;
  strikes = 0;
}

function startWatchingServer() {
  stopWatchingServer();
  watchTimer = setInterval(async () => {
    const base = connected;
    if (!base) return;
    if (await reachable(base)) {
      strikes = 0;
      return;
    }
    // Somewhere else by the time the probe gave up; those strikes are not this
    // server's.
    if (connected !== base) return;
    if (++strikes < HEALTH_STRIKES) return;
    console.error(`kururu: ${base} has not answered ${HEALTH_STRIKES} times — going back to the picker`);
    showPicker();
  }, HEALTH_EVERY_MS);
}

function startSweeping() {
  if (sweepTimer) return;
  void sweep();
  sweepTimer = setInterval(() => void sweep(), 1000);
}

function stopSweeping() {
  clearInterval(sweepTimer);
  sweepTimer = null;
}

// ---------------------------------------------------------------------------
// Showing one
// ---------------------------------------------------------------------------

/**
 * Vite, in development, pointed at whichever server was chosen.
 *
 * In dev the window loads vite rather than the server so that editing the UI is
 * instant, and vite proxies `/api` and `/ws` onwards — which is what keeps the
 * websocket same-origin and means the web app never has to know which of the two
 * arrangements it is in. The cost is that the *choice* of server is baked into
 * vite's config at startup, so switching servers restarts it. That is a second
 * or so, it happens when you deliberately change machines, and the alternative
 * is teaching the web app to talk cross-origin — which would need CORS on a
 * server that has no authentication, and that is not a trade worth making to
 * save a second.
 */
let vite = null;
let viteTarget = null;

function stopVite() {
  if (!vite) return;
  vite.kill();
  vite = null;
  viteTarget = null;
}

async function startVite(target) {
  if (vite && viteTarget === target) return;
  stopVite();
  viteTarget = target;
  vite = spawn(bunPath(), ["run", "--cwd", path.join(__dirname, "../web"), "dev"], {
    stdio: "inherit",
    env: { ...process.env, KURURU_SERVER: target },
  });
  vite.on("error", (err) => console.error("kururu: could not start vite —", err.message));
  // Without this the window loads before vite is listening and sits on
  // ERR_CONNECTION_REFUSED, because a failed loadURL is not retried.
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(VITE_URL, { signal: AbortSignal.timeout(600) });
      if (response.ok) return;
    } catch {
      // Still coming up.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  console.error("kururu: vite did not come up");
}

/**
 * Point the window at a server.
 *
 * Reachability is checked before anything is remembered or loaded, so a typo in
 * the box comes back as a sentence under it rather than as a blank window with
 * a Chromium error in it.
 */
async function connect(address) {
  const base = normalize(address);
  if (!base) return { error: "That does not look like an address." };
  if (!(await reachable(base))) return { error: `Nothing answered at ${base}.` };

  stopSweeping();
  remember(base);
  connected = base;
  startWatchingServer();

  if (DEV) {
    await startVite(base);
    await win?.loadURL(VITE_URL);
  } else {
    await win?.loadURL(base);
  }
  buildMenu();
  return { ok: true };
}

/**
 * Back to the picker — the window is showing a server or this, never both.
 *
 * Reached two ways that feel different and are the same thing: you asked
 * (⇧⌘O), or the server stopped answering. Both destroy the emulators, which is
 * the right trade only because the page they were in has nothing behind it any
 * more; when a server comes back the sweep connects and every pane asks for its
 * history again.
 */
function showPicker() {
  connected = null;
  stopWatchingServer();
  buildMenu();
  void win?.loadFile(PICKER);
  startSweeping();
}

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

/**
 * The menu bar.
 *
 * "Restart Server" used to live here and does not any more: the server is not
 * this process's to restart, and a menu item that works only when the server
 * happens to be one kururu forked is worse than none. `prefix+B` still asks for
 * a restart; it now asks whatever is supervising the server, which is where the
 * answer actually lives. What replaces it is the thing this window *can* do,
 * which is point somewhere else.
 *
 * Everything else is Electron's own roles, spelled out only because replacing
 * the default menu replaces all of it. Edit is not decoration: a terminal
 * without copy and paste in the menu is a terminal whose ⌘C people distrust.
 */
function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        {
          label: "Connect to Server…",
          accelerator: "Shift+CmdOrCtrl+O",
          enabled: Boolean(connected),
          click: showPicker,
        },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload", label: "Reload Window" },
        { role: "forceReload", label: "Force Reload (clear cache)" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { role: "toggleDevTools" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 420,
    backgroundColor: "#0d0f0e",
    titleBarStyle: "hiddenInset",
    // macOS ignores this and draws the bundle's icon, which `brand.mjs` is what
    // puts the frog into. Linux and Windows read it off the window instead, so
    // this is the same picture arriving by the only road those two have.
    icon: path.join(__dirname, "icon", "icon-1024.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      /**
       * Let kururu make a notification noise without having been clicked first.
       *
       * Chromium's autoplay policy exists for pages that ambush you with sound,
       * and this window is an application the user launched whose sounds they
       * chose in its own settings. The web build keeps the general answer — an
       * `AudioContext` resumed on the first gesture, which is what the phone
       * gets — and this removes the one case that answer does not cover: a
       * window relaunched onto agents that were already running, where the
       * first thing to happen may be a notification rather than a keystroke.
       */
      autoplayPolicy: "no-user-gesture-required",
    },
  });

  // A link to somewhere else is somewhere else's business: open it in the
  // browser rather than turning this window into one.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  /**
   * The renderer being killed is the way this window goes black that is not
   * kururu's own doing.
   *
   * When macOS runs out of memory it does not slow down, it picks processes and
   * kills them — and a Chromium renderer is a prime target, being large and, as
   * far as the kernel is concerned, reconstructible. The process dies, nothing
   * paints, and `backgroundColor` is all that is left: a window of flat
   * `#0d0f0e` that looks exactly like a crashed UI, with the browser's tabs
   * dying alongside it for the same reason. There is nothing in the page that
   * can report this, because there is no page any more — so the main process
   * says it instead, being a few megabytes and the only thing still able to put
   * words on screen.
   *
   * It asks rather than reloading by itself. A reload allocates a fresh renderer
   * immediately, and if the machine is still out of memory that one is killed
   * too — an automatic retry under real pressure is a loop.
   */
  let explaining = false;
  win.webContents.on("render-process-gone", async (_event, details) => {
    if (details.reason === "clean-exit" || win.isDestroyed()) return;
    if (explaining) return;
    explaining = true;

    const starved = details.reason === "oom" || details.reason === "killed";
    console.error(`kururu: the window's renderer went away (${details.reason})`);
    try {
      const { response } = await dialog.showMessageBox(win, {
        type: "warning",
        buttons: ["Reload the window", "Leave it"],
        defaultId: 0,
        cancelId: 1,
        message: starved
          ? "The system killed kururu's window."
          : `kururu's window stopped (${details.reason}).`,
        detail: starved
          ? "macOS ran out of memory and reclaimed it, which is the same thing it does to browser tabs — so anything else that disappeared went the same way, and kururu is not what it was reacting to. Your agents are untouched: they are in a server this window only looks at. Reloading costs a repaint.\n\nIf this keeps happening, something on this machine is holding far more memory than it should; the window is the symptom, not the cause."
          : "The agents are in a server this window only looks at, and are still running. Reloading costs a repaint and nothing else.",
      });
      if (response === 0 && !win.isDestroyed()) win.reload();
    } finally {
      explaining = false;
    }
  });

  win.on("closed", () => {
    win = null;
  });

  return win;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

ipcMain.handle("kururu:server-url", () => connected);

/**
 * A notification was clicked, so bring the window forward.
 *
 * The server has already moved the arrangement — that went over the socket the
 * renderer was holding — and this is the half only the main process can do.
 * `show()` before `focus()` because the window may be minimised, in which case
 * focusing it alone raises nothing; on macOS the app itself may also be behind
 * everything, which is what `app.focus` with `steal` is for. Together they are
 * what "take me to the agent" has to mean when the agent is in a window that is
 * not on screen.
 */
ipcMain.on("kururu:show", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  app.focus({ steal: true });
});

ipcMain.on("picker:ready", () => pushPickerState());
ipcMain.handle("picker:connect", (_event, address) => connect(address));
ipcMain.handle("picker:forget", (_event, address) => {
  forget(address);
  void sweep();
});

app.whenReady().then(async () => {
  /**
   * A dev server that sends X-Frame-Options would otherwise refuse to render in
   * the preview iframe. The same thing `proxy.ts` does for the phone, done here
   * for the window, and scoped to nothing else because the preview is the only
   * thing this window frames.
   */
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders || {};
    for (const key of Object.keys(headers)) {
      const name = key.toLowerCase();
      if (name === "x-frame-options" || name === "content-security-policy") delete headers[key];
    }
    callback({ responseHeaders: headers });
  });

  buildMenu();
  createWindow();
  showPicker();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      if (connected) void (DEV ? win.loadURL(VITE_URL) : win.loadURL(connected));
      else showPicker();
    }
  });
});

/**
 * Closing the last window quits, on every platform — which is a reversal, and
 * the reversal is the whole change.
 *
 * It used to decline on macOS, on purpose: the agents were *in this app*, so
 * quitting ended them, and staying alive with no window was what let you shut
 * the window and leave them working. That guard bought a real thing and cost a
 * confusing one — an app running with no window, no tray icon and nothing to
 * say it was there.
 *
 * The agents are not in here any more. Nothing is: no ptys, no server, no state
 * worth a process. So there is nothing left for a windowless kururu to be doing,
 * and the honest behaviour is to go away. What used to need the guard now needs
 * nothing at all — close the window, quit the app, the server keeps serving and
 * the phone never drops.
 */
app.on("window-all-closed", () => {
  stopSweeping();
  stopWatchingServer();
  stopVite();
  app.quit();
});

// Vite is ours and nothing else is; the server and the pty host are deliberately
// not this process's to stop.
app.on("before-quit", () => {
  stopSweeping();
  stopWatchingServer();
  stopVite();
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopVite();
    app.quit();
  });
}
