/**
 * The Electron shell — a window onto a kururu server, a frog in the menu bar
 * that runs one, and the two things a served page cannot do.
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
 * What came back is the *starting*, and it came back in the menu bar rather
 * than in the window. An installed kururu has no terminal, so somebody has to
 * run the runner, and a window is the wrong somebody: it is the least
 * important of the three processes and the first to be closed. So the app
 * keeps a tray icon with no window open (`tray.js`), starts `run.mjs` through
 * `runner.js` — the same supervisor `bun run dev` is — and shows what the host
 * and the server are up to. The window is one of the things the tray can
 * open. Closing it hides the dock icon and leaves the frog.
 *
 * The other thing only this process can do is hear a key with the window
 * unfocused, and show something over another application. `talkkey.js` is
 * that: the native hook and the floating pill. Anything that knows what an
 * agent is still belongs on the other side of the HTTP boundary, because that
 * side is also what the phone talks to.
 */
const { app, BrowserWindow, Menu, dialog, ipcMain, session, shell } = require("electron");
const { execFileSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const { readDesktop, writeDesktop } = require("./desktop");
const { Runner, hostSocket } = require("./runner");
const { candidates, forget, normalize, remember } = require("./servers");
const { TalkKey } = require("./talkkey");
const { createTray } = require("./tray");

const DEV = process.env.KURURU_DEV === "1";
/**
 * Whether this is a downloaded kururu or a checkout with `electron .` pointed at
 * it. An installed kururu has a server inside it and starts one at launch; a
 * dev shell runs from the checkout it sits in and starts a server only when
 * asked, because `bun run dev` is very often already running next door.
 */
const PACKAGED = app.isPackaged;
const PORT = Number(process.env.KURURU_PORT || 7717);
const LOCAL = `http://127.0.0.1:${PORT}`;
/** Where the checkout's vite listens — `web/vite.config.ts` reads the same variable. `vite.js` says why it is asked at `127.0.0.1`. */
const VITE_PORT = Number(process.env.KURURU_VITE_PORT || 5173);
const PICKER = path.join(__dirname, "connect.html");
const PRELOAD = path.join(__dirname, "preload.js");

/**
 * An isolated instance keeps its own profile, or two apps would share one
 * Chromium profile and one single-instance lock. `docs/testing.md` says
 * where the rest of an isolated instance lives.
 */
if (process.env.KURURU_USER_DATA) app.setPath("userData", process.env.KURURU_USER_DATA);

let win = null;
/** The server the window is showing, as an origin. Null while the picker is up. */
let connected = null;

// ---------------------------------------------------------------------------
// One of these at a time
// ---------------------------------------------------------------------------

/**
 * A second launch opens a window in the first rather than a second tray. Two
 * trays would be two runners each wanting the port, and the one that lost
 * would show "down" for a server that was up. The lock is per `userData`, so
 * an isolated instance gets its own.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.on("second-instance", () => openWindow());

// ---------------------------------------------------------------------------
// The PATH, and the runner
// ---------------------------------------------------------------------------

/**
 * The PATH a login shell would have, which is not the one a double-clicked app
 * has.
 *
 * launchd hands a GUI application `/usr/bin:/bin:/usr/sbin:/sbin` and nothing
 * else, so `claude`, `gh` and anything else installed by a version manager or by
 * Homebrew is simply not there. The *agents* are fine either way — every pty is
 * spawned under `zsh -l`, so the user's own profile builds their PATH inside it
 * — but the server also shells out on its own account, to ask who a profile is
 * signed in as, and those lookups would all come back "not installed" in a
 * packaged build while working perfectly in a checkout. That is the worst shape
 * a bug can have.
 *
 * Asked once, from the user's own shell, with a marker so that whatever an
 * interactive profile prints on the way up is not mistaken for the answer.
 */
let cachedPath = null;

function loginPath() {
  if (cachedPath !== null) return cachedPath;
  cachedPath = process.env.PATH || "";
  // A checkout was launched from a terminal, which already has the real one.
  if (!PACKAGED) return cachedPath;

  const marker = "__kururu_path__";
  try {
    const said = execFileSync(process.env.SHELL || "/bin/zsh", ["-ilc", `printf '%s%s' ${marker} "$PATH"`], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const at = said.lastIndexOf(marker);
    const found = at === -1 ? "" : said.slice(at + marker.length).trim();
    if (found) cachedPath = found;
  } catch {
    // A shell that will not start, or one that took five seconds to say hello.
    // The default PATH is worse and is not nothing.
  }
  return cachedPath;
}

/**
 * The server, through `run.mjs`. `runner.js` says how; what is decided here
 * is only where from, which is the saved choice: this app's own bundle, or
 * the checkout somebody pointed the menu at.
 */
const runner = new Runner({
  packaged: PACKAGED,
  resourcesPath: process.resourcesPath,
  shellCheckout: PACKAGED ? null : path.join(__dirname, ".."),
  port: PORT,
  vitePort: VITE_PORT,
  // `dev:desktop` binds every address, as it always has, so the phone can
  // load vite too; the menu bar starting one by itself keeps it on loopback.
  viteHost: DEV ? null : "127.0.0.1",
  loginPath,
});
runner.configure(readDesktop());

/**
 * The hook and the floating pill. The helper is built by
 * `desktop/talkkey/build.mjs` into `dist/`, which the app ships beside the
 * server; a build without it says so in the menu and the key works in the
 * window as before.
 */
const talk = new TalkKey({
  // `KURURU_TALKKEY` points an isolated instance at another build of the
  // hook, or at nothing, so a test can run with no permission prompt.
  helperPath:
    process.env.KURURU_TALKKEY ||
    (PACKAGED ? path.join(process.resourcesPath, "server", "talkkey") : path.join(__dirname, "dist", "talkkey")),
  preloadPath: PRELOAD,
  debug: !PACKAGED,
  saved: readDesktop(),
  save: writeDesktop,
});

/**
 * The checkout whose web app is shown for a server, or null for the server's
 * own page.
 *
 * A checkout's UI belongs in front of a checkout's server, so outside the dev
 * shell it is only ever the local one: a server on another machine runs its
 * own version, and the checkout's page against it is a protocol mismatch
 * waiting to happen. `dev:desktop` is for developing that page against
 * anything and keeps doing so.
 */
function uiCheckout(base) {
  const checkout = runner.effectiveCheckout();
  if (!checkout) return null;
  return DEV || base === LOCAL ? checkout : null;
}

/**
 * What the window and the pill should be showing for a server, right now:
 * the checkout's vite while it serves, the server's own page when there is no
 * checkout or vite would not start, and null — stay put — while vite is on
 * its way up or was stopped along with its server. The last is what keeps a
 * Stop from flashing a built page before the picker, and a vite coming back on
 * the same port reloads its own pages.
 */
function pageFor(base) {
  const checkout = uiCheckout(base);
  if (!checkout) return base;
  const vite = runner.vite.urlFor(checkout, base);
  if (vite) return vite;
  return runner.vite.status === "failed" ? base : null;
}

/** The page to load for a server somebody is connecting to, starting vite for it if it should have one. */
async function openPage(base) {
  const checkout = uiCheckout(base);
  if (!checkout) return base;
  return (await runner.vite.ensure(checkout, base, { retry: true })) ?? base;
}

/**
 * The pill follows the window's server, or the local one when there is no
 * window — and is the reason a checkout's vite starts with no window open:
 * the moment a checkout's server answers, it gets one in front of it.
 */
function pointPill() {
  const base = connected ?? (runner.health ? LOCAL : null);
  if (!base) {
    talk.setPage(null);
    return;
  }
  const checkout = uiCheckout(base);
  if (checkout && base === LOCAL && runner.health) void runner.vite.ensure(checkout, base);
  const page = pageFor(base);
  if (page) talk.setPage(page);
}

/**
 * Move the window to the page it should be on, when that is a different
 * origin from the one it is on: onto vite once it serves, off it when it
 * failed or the source stopped being a checkout. Never for a server restart,
 * which changes neither, so the emulators survive a save exactly as they do
 * under `dev:desktop`. Serialised, because changes come in bursts and two
 * loads of one page is a reload nobody asked for.
 */
let following = Promise.resolve();

function followPage() {
  following = following.then(async () => {
    const base = connected;
    if (!base || !win || win.isDestroyed()) return;
    const shown = originOf(win.webContents.getURL());
    // The picker, or a window still on its way to its first page.
    if (!shown?.startsWith("http")) return;
    const want = pageFor(base);
    if (!want || originOf(want) === shown) return;
    if (want === base && !(await reachable(base))) return;
    if (connected !== base || !win || win.isDestroyed()) return;
    await win.loadURL(want).catch(() => {});
  });
  return following;
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

runner.on("change", () => {
  pointPill();
  void followPage();
});

/**
 * End every agent on this machine, by stopping the pty host.
 *
 * Found by its socket and never by its name, for the reason `server/kill-hosts.mjs`
 * gives at length: `pkill -f ptyhostd` was observed matching two scratch hosts
 * while consistently skipping the real one, and a pkill that silently matches
 * nothing reads exactly like it worked. A listening socket has one holder by
 * construction. SIGTERM rather than SIGKILL because the host reaps its ptys and
 * unlinks the socket on the way out, and a corpse left behind is the next
 * server's problem.
 */
function endAgents() {
  const name = path.basename(hostSocket());
  let listed = "";
  try {
    listed = execFileSync("lsof", ["-U"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return;
  }

  const pids = new Set();
  for (const line of listed.split("\n")) {
    const fields = line.trim().split(/\s+/);
    const socket = fields.at(-1);
    const pid = Number(fields[1]);
    if (!socket || !pid || path.basename(socket) !== name) continue;
    // The guard, not the search: something else holding a file of that name is
    // not a thing to send signals to.
    try {
      const command = execFileSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
      if (!command.includes("ptyhost")) continue;
    } catch {
      continue;
    }
    pids.add(pid);
  }

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone, which is the outcome being asked for.
    }
  }
}

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
 * Point the window at a server.
 *
 * Reachability is checked before anything is remembered or loaded, so a typo in
 * the box comes back as a sentence under it rather than as a blank window with
 * a Chromium error in it. The page is the checkout's vite when this app runs
 * from a checkout — or always, in the dev shell — and the server's own
 * otherwise; `openPage` waits for vite to answer, because a failed `loadURL`
 * is not retried and the window would sit on ERR_CONNECTION_REFUSED.
 */
async function connect(address) {
  const base = normalize(address);
  if (!base) return { error: "That does not look like an address." };
  if (!(await reachable(base))) return { error: `Nothing answered at ${base}.` };

  stopSweeping();
  remember(base);
  connected = base;
  startWatchingServer();
  pointPill();

  const page = await openPage(base);
  if (connected === base) await win?.loadURL(page);
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
  if (win && !win.isDestroyed()) void win.loadFile(PICKER);
  startSweeping();
}

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

/**
 * The menu bar at the top of the screen, when a window has the focus.
 *
 * "Restart Server" lives in the tray now, where it works whoever is
 * supervising the server; this menu is Electron's own roles, spelled out only
 * because replacing the default menu replaces all of it. Edit is not
 * decoration: a terminal without copy and paste in the menu is a terminal
 * whose ⌘C people distrust.
 */
function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        { label: "New Window", accelerator: "CmdOrCtrl+N", click: () => openWindow() },
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
        /**
         * The window and the floating pill, which cannot be focused and so
         * has no ⌘R of its own. Under vite the pill takes a change by
         * itself; this is for the change that would not hot-apply, and for
         * a pill on a built page after a rebuild. One mid-sentence reloads
         * once it is done.
         */
        {
          label: "Reload Window",
          accelerator: "CmdOrCtrl+R",
          click: () => {
            (BrowserWindow.getFocusedWindow() ?? win)?.webContents.reload();
            talk.reloadPanel();
          },
        },
        {
          label: "Force Reload (clear cache)",
          accelerator: "Shift+CmdOrCtrl+R",
          click: () => {
            (BrowserWindow.getFocusedWindow() ?? win)?.webContents.reloadIgnoringCache();
            talk.reloadPanel();
          },
        },
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
  // Back in the dock for as long as there is a window; the tray is the app
  // the rest of the time. Shown before the window so the window gets a menu
  // bar, which an app with no dock presence is not given.
  app.dock?.show();
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
      preload: PRELOAD,
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

/** Bring the window up, making one if there is none. The tray's "Open Window", the dock, and ⌘N. */
function openWindow() {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    app.focus({ steal: true });
    return;
  }
  createWindow();
  if (connected) {
    const base = connected;
    void openPage(base).then((page) => connected === base && win?.loadURL(page));
  } else showPicker();
  app.focus({ steal: true });
}

function closeWindow() {
  if (win && !win.isDestroyed()) win.close();
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

/**
 * The voice, across the bridge. The window asks whether the hook is on and is
 * told when that changes; it may switch the hook, and send a gesture to the
 * pill. The pill's own channel — the keys in, its reports out — is tied to
 * the panel's webContents and no other.
 */
ipcMain.handle("kururu:voice-global", () => talk.state());
ipcMain.on("kururu:voice-set-global", (_event, on) => talk.setEnabled(on === true));
ipcMain.on("kururu:voice-set-altspace", (_event, on) => talk.setAltSpace(on === true));
ipcMain.on("kururu:voice-gesture", (_event, gesture) => talk.gesture(String(gesture)));
ipcMain.on("kururu:voice-pause", (_event, on) => talk.pause(on === true));
ipcMain.on("kururu:voice-open-settings", () => talk.openInputMonitoring());
ipcMain.on("kururu:pill", (event, state) => {
  const panel = talk.panelContents();
  if (!panel || event.sender.id !== panel.id) return;
  talk.report(state);
});
talk.on("change", (state) => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("kururu:voice-global", state);
  }
});

/**
 * Whether this launch should open a window at all.
 *
 * Opened at login, the app is the tray and nothing else: the Mac just came
 * up, the agents are not running yet, and a window would be a window onto
 * nothing in front of whatever the person was about to do. macOS says when
 * it did the opening; when it does not — a login item registered through
 * SMAppService has not always said — a launch inside the first minutes of
 * uptime with the switch on is read the same way. Opening the window is one
 * click on the frog either way.
 */
function launchedAtLogin() {
  if (!PACKAGED) return false;
  const login = app.getLoginItemSettings();
  if (login.wasOpenedAtLogin) return true;
  return login.openAtLogin && os.uptime() < 180;
}

let tray = null;

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
  tray = createTray({
    runner,
    talk,
    version: app.getVersion(),
    packaged: PACKAGED,
    actions: {
      openWindow,
      closeWindow,
      windowOpen: () => Boolean(win && !win.isDestroyed()),
      quit: () => app.quit(),
      serverChanged: () => {
        pointPill();
        void followPage();
      },
      // The checkout's `web/dist` is the pill's page only when vite is not;
      // vite's pages have the change already.
      webRebuilt: () => {
        if (talk.page === LOCAL) talk.reloadPanel();
      },
    },
  });
  runner.startProbing();

  // The hook and the pill come up with the app if they were on when it last quit.
  if (talk.enabled || talk.altSpace) {
    talk.ensurePanel();
    if (talk.enabled) talk.startHelper();
    if (talk.altSpace) {
      talk.altSpace = false;
      talk.setAltSpace(true);
    }
  }

  /**
   * A packaged kururu brings its own server up and opens a window onto it; a
   * dev shell adopts one if `bun run dev` is running and otherwise opens the
   * picker, exactly as it did, with Start a click away in the tray. Opened at
   * login there is no window at all.
   */
  const hidden = launchedAtLogin();
  if (hidden) app.dock?.hide();
  else createWindow();
  // `KURURU_AUTOSTART` makes a dev shell start as the app does, which is how
  // an isolated instance is driven with nobody to click the tray.
  const mine = await runner.ensure(PACKAGED || process.env.KURURU_AUTOSTART === "1");
  if (!hidden && (!mine || !(await connect(mine)).ok)) showPicker();
  pointPill();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 || !win || win.isDestroyed()) openWindow();
  });
});

/**
 * Closing the last window closes a window, and the app stays in the menu bar.
 *
 * This reverses a reversal. The app used to stay open with no window because
 * the agents were inside it; then it quit on the last window because nothing
 * was inside it any more, and an app running with no window, no tray icon and
 * nothing to say it was there was a confusing thing to leave behind. Now
 * there is something to say it is there: the frog, with the live count beside
 * it, running the server for the phone. The dock icon goes with the window.
 */
app.on("window-all-closed", () => {
  stopSweeping();
  stopWatchingServer();
  app.dock?.hide();
});

/**
 * Quitting, and the one question worth asking on the way out.
 *
 * Vite is ours, and so is the server when this app started one — but the pty
 * host is nobody's, and that is the distinction the dialog exists to make
 * legible. Quitting stops a server; it does not stop work. People should be
 * told that in the moment rather than discover it later, in either direction:
 * somebody who assumed their agents died would not come back for them, and
 * somebody who assumed they were safe would be right, which is the whole point
 * of having built it this way.
 *
 * So the prompt offers both, and the destructive one is never the default. It
 * is only raised when this app is the thing holding the server *and* there is
 * something running — pointed at a machine in a cupboard, or beside a
 * `bun run dev` of your own, quitting is a window closing and has nothing to
 * ask about.
 */
let quitting = false;

app.on("before-quit", (event) => {
  stopSweeping();
  stopWatchingServer();

  if (quitting) return;
  // Nothing to ask about, and nothing to wait for: vite goes on SIGTERM.
  if (!runner.child) {
    void runner.vite.stop();
    return;
  }
  event.preventDefault();
  void confirmQuit();
});

async function confirmQuit() {
  const live = runner.ours() ? Number(runner.health?.liveAgents) || 0 : 0;

  if (live === 0) {
    finishQuit(false);
    return;
  }

  const parent = win && !win.isDestroyed() ? win : null;
  if (!parent) app.focus({ steal: true });

  const { response } = await dialog.showMessageBox(parent, {
    type: "question",
    buttons: ["Quit", "Quit and end them", "Cancel"],
    defaultId: 0,
    cancelId: 2,
    message: live === 1 ? "One agent is still running." : `${live} agents are still running.`,
    detail:
      "Quitting stops kururu's server. The agents themselves are in a process below it and keep working — they are still there when you open kururu again, with their screens and their scrollback. What stops until then is the phone, which has nothing to connect to.\n\nEnding them stops every terminal on this machine, and that cannot be undone.",
  });

  if (response === 2) return;
  finishQuit(response === 1);
}

function finishQuit(alsoAgents) {
  quitting = true;
  talk.dispose();
  tray?.destroy();
  tray = null;
  if (alsoAgents) endAgents();
  void runner.stop("the app is quitting").finally(() => app.quit());
}

app.on("will-quit", () => {
  talk.dispose();
});

// ---------------------------------------------------------------------------
// Updating
// ---------------------------------------------------------------------------

/**
 * Replacing this application with a newer one — the half of the update story
 * the server is deliberately not allowed to have.
 *
 * `server/src/update.ts` answers *what is out there* and stops there, because
 * what installing means depends on how kururu arrived: a DMG has this, a
 * Homebrew cask has `brew upgrade`, a checkout has `git pull`, and only the
 * thing that did the installing knows which. So the doing is here, in the one
 * process that knows it is a packaged .app, and the About tab drives it across
 * the bridge rather than the server driving anything at all.
 *
 * **It is offered only when this app started the server it is showing, from
 * its own bundle**, and that condition is load bearing rather than cautious.
 * About draws the *server's* version, since that is what `/api/health` reports
 * and what the check compares against GitHub — and that number is this
 * bundle's exactly when the runner launched the server out of its own
 * Resources. Pointed at the box in the cupboard, at a `bun run dev` that
 * answered on 7717 first, or at a checkout the menu was pointed at, swapping
 * this .app would leave the page reporting the number it reported before,
 * which reads as an update that silently did not happen. Those cases get the
 * link to the release page, which is the honest answer for all of them and is
 * also what a browser and the phone have always got.
 *
 * Nothing downloads until somebody presses the button (`autoDownload = false`)
 * and nothing is applied until they press the second one. What a page can ask
 * for is exactly "fetch it" and "now" — the *feed* is `app-update.yml`, written
 * into the bundle by electron-builder out of the `publish` block and not
 * addressable from a renderer, so a served page cannot point the updater
 * anywhere. Squirrel then refuses an archive whose signature does not match the
 * running app's. Those two together are what make this safe to put on a surface
 * a server across a tailnet can reach: the worst a hostile one can do is make
 * kururu download its own genuine update and restart into it.
 */

/**
 * electron-updater, loaded on first use rather than beside the requires at the
 * top of this file.
 *
 * A packaging mistake that left it out of the bundle would, as a top-level
 * require, take the whole window down at startup — which is the worst available
 * outcome for the one feature whose absence costs nothing at all. Loaded here it
 * degrades to the link instead. `undefined` is "not tried yet" and `null` is
 * "tried and there is none", so a build without it does not re-throw on every
 * keystroke in the About tab.
 */
let updater;

function loadUpdater() {
  if (updater !== undefined) return updater;
  try {
    updater = require("electron-updater").autoUpdater;
  } catch (error) {
    console.error("kururu: this build has no updater in it —", error.message);
    updater = null;
    return null;
  }

  updater.autoDownload = false;
  updater.on("download-progress", (progress) => {
    setUpdate({ status: "downloading", percent: Math.max(0, Math.min(100, Math.round(progress.percent))) });
  });
  updater.on("update-downloaded", (info) => setUpdate({ status: "ready", version: info.version }));
  updater.on("error", (error) => {
    setUpdate({ status: "error", message: error?.message || "The download did not finish." });
  });
  return updater;
}

/** What the About tab is drawing. Pushed on every change, and asked for on open. */
let update = { status: "idle" };

function setUpdate(next) {
  update = next;
  if (win && !win.isDestroyed()) win.webContents.send("kururu:update", next);
}

/** Whether replacing this application is a thing this window can honestly offer. */
function updatable() {
  return PACKAGED && runner.ours() && runner.effectiveCheckout() === null && connected === LOCAL && loadUpdater() !== null;
}

async function downloadUpdate() {
  if (!updatable()) return;
  // Pressing it twice is not a second download, and a finished one is not
  // something to start again.
  if (update.status === "downloading" || update.status === "ready") return;

  setUpdate({ status: "downloading", percent: 0 });
  try {
    const found = await loadUpdater().checkForUpdates();
    /**
     * The server said there was a newer one and the updater disagrees, which is
     * a race rather than a fault — a release published between the two asks, or
     * a feed that has not propagated. Back to idle, so the button is there to
     * press again, rather than an error about something that is nobody's fault.
     */
    if (!found || !found.isUpdateAvailable) {
      setUpdate({ status: "idle" });
      return;
    }
    await loadUpdater().downloadUpdate();
  } catch (error) {
    setUpdate({ status: "error", message: error?.message || "The download did not finish." });
  }
}

/**
 * Restart into the version that was just downloaded.
 *
 * This deliberately does not go through `confirmQuit`. That dialog exists to
 * say that quitting stops the server while the agents carry on below it, which
 * is a thing worth telling somebody who is leaving — and this is not leaving.
 * The app comes back in a few seconds, starts its server again and reconnects
 * to the same pty host, so the agents are not even interrupted. Asking "3
 * agents are still running" here would be inviting somebody to cancel an
 * install over a consequence that is not one.
 *
 * Which means everything `finishQuit` does has to be done here instead, and the
 * runner especially: it is a child of this process rather than a thing that
 * dies with it, so leaving it up would have the new version find 7717 already
 * taken by the old one.
 */
function installUpdate() {
  if (update.status !== "ready") return;
  quitting = true;
  stopSweeping();
  stopWatchingServer();
  talk.dispose();
  tray?.destroy();
  tray = null;
  void runner.stop("the app is restarting into an update").finally(() => loadUpdater().quitAndInstall());
}

ipcMain.handle("kururu:update-state", () => (updatable() ? update : { status: "unavailable" }));
ipcMain.on("kururu:update-download", () => void downloadUpdate());
ipcMain.on("kururu:update-install", () => installUpdate());

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    // A signal is not somebody choosing, so it is not asked a question.
    quitting = true;
    talk.dispose();
    void runner.stop(`the app was stopped by ${signal}`).finally(() => app.quit());
  });
}
