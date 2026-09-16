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
const { execFileSync, spawn } = require("node:child_process");
const { existsSync, mkdirSync, openSync, closeSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { candidates, forget, normalize, remember } = require("./servers");

const DEV = process.env.KURURU_DEV === "1";
/**
 * Whether this is a downloaded kururu or a checkout with `electron .` pointed at
 * it. The difference is one thing only and it is the whole of what packaging
 * changed: an installed kururu has a server inside it and is expected to start
 * one, while a checkout has `bun run dev` next door and must never fight it.
 */
const PACKAGED = app.isPackaged;
const PORT = Number(process.env.KURURU_PORT || 7717);
const LOCAL = `http://127.0.0.1:${PORT}`;
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
// The server, when this is the thing that has to start one
// ---------------------------------------------------------------------------

/**
 * A downloaded kururu starts its own server; a checkout never does.
 *
 * This is the one thing packaging changed about the architecture, and it changed
 * less than it looks. The three processes are the same three: the window finds a
 * server and draws it, the server connects to a detached pty host, and the host
 * outlives both. What an installed kururu adds is somebody to *begin* that, which
 * in a checkout is a person typing `bun run dev` and in a .app is nobody at all —
 * a downloaded application that opened onto an address picker would be asking a
 * question only its author could answer.
 *
 * So the rule is: if something already answers on 7717, use it and start nothing.
 * That is not politeness, it is the one case that would otherwise be broken —
 * open the app on a machine where you are already running `bun run dev` and a
 * second server would take `EADDRINUSE` and die, or worse, take the port first
 * and leave the one you were working in homeless.
 *
 * The server is a child and dies with us, which is the shape you asked for and is
 * also the honest one: quit means quit. Nothing is lost by it — the ptys are in
 * the host below, which is detached and is nobody's child, so reopening kururu
 * finds every agent still working. What does stop is the phone, until you open
 * the window again.
 */

/** Kept in step with `RESTART_EXIT_CODE` in `server/src/index.ts`, which sends it. */
const RESTART_EXIT_CODE = 75;

/**
 * The pty host's socket, spelled exactly as `server/src/hostsock.ts` spells it.
 * Duplicated rather than imported because that file is TypeScript on the other
 * side of a process boundary, and the alternative — bundling a second copy of
 * the server's code into the window — is a much worse kind of duplication.
 */
function hostSocket() {
  if (process.env.KURURU_HOST_SOCK) return process.env.KURURU_HOST_SOCK;
  const state = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(state, "kururu", "ptyhost.sock");
}

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

let server = null;
/** Set while we are ending it on purpose, so the exit is not read as a crash. */
let serverStopping = false;

function startServer() {
  const entry = path.join(process.resourcesPath, "server", "server.mjs");
  if (!existsSync(entry)) {
    console.error(`kururu: no server bundled at ${entry}`);
    return;
  }

  /**
   * Its output goes to a file beside the host's, because a packaged app has no
   * stdout anybody will ever see — and a server whose logs go nowhere is one
   * nobody can debug from a bug report.
   */
  const dir = path.dirname(hostSocket());
  mkdirSync(dir, { recursive: true });
  const log = openSync(path.join(dir, "server.log"), "a");

  server = spawn(process.execPath, [entry], {
    stdio: ["ignore", log, log],
    env: {
      ...process.env,
      // This binary is Electron; that is what makes it node instead.
      ELECTRON_RUN_AS_NODE: "1",
      // How the server knows that asking to be restarted will get it restarted,
      // which is what `prefix+B` and the Share toggle both depend on.
      KURURU_SUPERVISED: "1",
      PATH: loginPath(),
      KURURU_WEB_DIST: path.join(process.resourcesPath, "web"),
      KURURU_ASSETS: path.join(process.resourcesPath, "assets", "spritesheets"),
      KURURU_SOUNDS: path.join(process.resourcesPath, "assets", "sounds"),
      KURURU_PTYHOSTD: path.join(process.resourcesPath, "server", "ptyhostd.mjs"),
    },
  });
  closeSync(log);

  server.on("error", (err) => console.error("kururu: could not start the server —", err.message));
  server.on("exit", (code) => {
    server = null;
    if (serverStopping) return;
    if (code === RESTART_EXIT_CODE) {
      startServer();
      return;
    }
    /**
     * Anything else is left down, on `run.mjs`'s reasoning: a supervisor that
     * resurrects a server which cannot start is a loop, and the error in the log
     * is the useful part.
     */
    console.error(`kururu: the server exited (${code}); not restarting it`);
  });
}

function stopServer() {
  if (!server) return;
  serverStopping = true;
  server.kill();
  server = null;
}

/**
 * The server this window is responsible for, if it is responsible for one.
 *
 * Null means "go to the picker", which is what a checkout always gets and what a
 * packaged build gets when its own server could not be started — in which case
 * the sweep is still running and will find it if it turns up late.
 */
async function ownServer() {
  if (!PACKAGED) return null;
  // Somebody else's, and theirs to manage. Very often `bun run dev`.
  if (await reachable(LOCAL)) return LOCAL;

  startServer();
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await reachable(LOCAL)) return LOCAL;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  console.error("kururu: the bundled server did not come up");
  return null;
}

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

  /**
   * A packaged kururu opens onto its own agents; a checkout opens onto the
   * picker, exactly as it did. The picker is still the answer when the bundled
   * server could not be started, and is still how you point this window at a
   * machine that is not this one.
   */
  const mine = await ownServer();
  if (!mine || !(await connect(mine)).ok) showPicker();

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

/**
 * Quitting, and the one question worth asking on the way out.
 *
 * Vite is ours, and so is the server when this is a packaged build that started
 * one — but the pty host is nobody's, and that is the distinction the dialog
 * exists to make legible. Quitting stops a server; it does not stop work. People
 * should be told that in the moment rather than discover it later, in either
 * direction: somebody who assumed their agents died would not come back for
 * them, and somebody who assumed they were safe would be right, which is the
 * whole point of having built it this way.
 *
 * So the prompt offers both, and the destructive one is never the default. It is
 * only raised when this window is the thing holding the server *and* there is
 * something running — pointed at a machine in a cupboard, quitting is a window
 * closing and has nothing to ask about.
 */
let quitting = false;

app.on("before-quit", (event) => {
  stopSweeping();
  stopWatchingServer();
  stopVite();

  if (quitting || !server) return;
  event.preventDefault();
  void confirmQuit();
});

async function confirmQuit() {
  let live = 0;
  try {
    const response = await fetch(`${LOCAL}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (response.ok) live = Number((await response.json()).liveAgents) || 0;
  } catch {
    // A server that cannot answer has nothing running that we can name, and
    // holding the app open to say so would be worse than letting it go.
  }

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
  if (alsoAgents) endAgents();
  stopServer();
  app.quit();
}

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
 * **It is offered only when this window started the server it is showing**, and
 * that condition is load bearing rather than cautious. About draws the
 * *server's* version, since that is what `/api/health` reports and what the
 * check compares against GitHub — and that number is this bundle's exactly when
 * the window launched the server out of its own Resources. Pointed at the box
 * in the cupboard, or at a `bun run dev` that answered on 7717 first, swapping
 * this .app would leave the page reporting the number it reported before, which
 * reads as an update that silently did not happen. Those cases get the link to
 * the release page, which is the honest answer for both and is also what a
 * browser and the phone have always got.
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
  return PACKAGED && server !== null && connected === LOCAL && loadUpdater() !== null;
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
 * server especially: it is a child of this process rather than a thing that
 * dies with it, so leaving it up would have the new version find 7717 already
 * taken by the old one.
 */
function installUpdate() {
  if (update.status !== "ready") return;
  quitting = true;
  stopSweeping();
  stopWatchingServer();
  stopVite();
  stopServer();
  loadUpdater().quitAndInstall();
}

ipcMain.handle("kururu:update-state", () => (updatable() ? update : { status: "unavailable" }));
ipcMain.on("kururu:update-download", () => void downloadUpdate());
ipcMain.on("kururu:update-install", () => installUpdate());


for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    // A signal is not somebody choosing, so it is not asked a question.
    quitting = true;
    stopVite();
    stopServer();
    app.quit();
  });
}
