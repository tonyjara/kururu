/**
 * The Electron shell.
 *
 * Its job is: bring up everything kururu needs, then show it. One launch, one
 * app — no server to start in another terminal, and nothing to have running
 * first. The window loads the same URL a phone loads, so there is one build of
 * the UI and no `file://` variant to keep in step.
 *
 * The server does not run *in this process*. It runs in utilityProcesses, which
 * are still this app — Electron forks them, owns them, and they die when the app
 * does — but are not the thread that draws the window. That distinction is load
 * bearing: the server reads files synchronously for the file browser, shells out
 * to `lsof` and `ps` across the whole machine every three seconds, and pushes
 * every byte of every pty through a terminal emulator. On the main process all
 * of that would be jank in the UI, and it would look like Electron's fault.
 *
 * There are *two* of them, and which is which matters more than it looks. The
 * **pty host** owns everything that cannot be recreated — the ptys, their
 * emulators — and can only be restarted by quitting. The **server** owns the
 * protocol, the layout and the discovery, all of which change constantly, and
 * can be killed and re-forked in a second without an agent noticing. They are
 * handed the two ends of a MessageChannel and talk to each other directly; this
 * process is never in the middle of a terminal's output.
 *
 * What stays here is what only the main process can do: the window, forking
 * those two, re-forking one of them on request, and asking before quitting kills
 * somebody's agents.
 */
const {
  app,
  BrowserWindow,
  Menu,
  MessageChannelMain,
  dialog,
  ipcMain,
  session,
  shell,
  utilityProcess,
} = require("electron");
const { spawn } = require("node:child_process");
const { existsSync, watch } = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.KURURU_PORT || 7717);
const DEV = process.env.KURURU_DEV === "1";
/** In dev the UI comes from vite so that editing it is instant; otherwise from the server. */
const URL = DEV ? "http://localhost:5173" : `http://127.0.0.1:${PORT}`;

const SERVER_ENTRY = path.join(__dirname, "dist/server.mjs");
const PTYHOST_ENTRY = path.join(__dirname, "dist/ptyhost.mjs");
const WEB_DIST = path.join(__dirname, "../web/dist");

/** Where bun lives when it is not on PATH — a GUI launch inherits almost none. */
const BUN_CANDIDATES = [
  process.env.BUN_PATH,
  path.join(process.env.HOME || "", ".bun/bin/bun"),
  "/opt/homebrew/bin/bun",
  "/usr/local/bin/bun",
].filter(Boolean);

/** The two halves of the server, and in dev the vite that serves the UI. */
let ptyhost = null;
let server = null;
let vite = null;
/** Set while a restart is in flight, so the server's exit is not reported as a crash. */
let replacingServer = false;
/** Guards against re-forking a server that cannot start, forever, at full speed. */
let lastServerStart = 0;
let crashes = 0;

function bunPath() {
  return BUN_CANDIDATES.find((candidate) => existsSync(candidate)) || "bun";
}

async function reachable(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(600) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitFor(url, what) {
  for (let i = 0; i < 100; i++) {
    if (await reachable(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  console.error(`kururu: ${what} did not come up`);
  return false;
}

const CHILD_ENV = {
  ...process.env,
  KURURU_PORT: String(PORT),
  // The bundle does not sit where the source did, so it cannot work this out
  // for itself.
  KURURU_WEB_DIST: WEB_DIST,
};

/**
 * The pty host. Forked once, for the life of the app: restarting it is the one
 * thing that costs the user their agents, and there is no way around that — a
 * live pty cannot be handed to a replacement process.
 */
function startPtyHost() {
  if (!existsSync(PTYHOST_ENTRY)) {
    console.error(`kururu: ${PTYHOST_ENTRY} is missing — run \`bun run build:server\``);
    return;
  }
  ptyhost = utilityProcess.fork(PTYHOST_ENTRY, [], { stdio: "inherit", env: CHILD_ENV });
  ptyhost.on("exit", (code) => {
    ptyhost = null;
    if (!quitting) console.error(`kururu: the pty host exited (${code}) — agents are gone`);
  });
}

/**
 * The server, and the channel that joins it to the pty host.
 *
 * A fresh MessageChannel every time: the old one went with the process that held it,
 * and the host treats a new port as a new server and hands it back everything it
 * was keeping — the agents, and the arrangement the last server left behind.
 */
function startServer() {
  if (!existsSync(SERVER_ENTRY)) {
    console.error(`kururu: ${SERVER_ENTRY} is missing — run \`bun run build:server\``);
    return;
  }
  lastServerStart = Date.now();
  server = utilityProcess.fork(SERVER_ENTRY, [], { stdio: "inherit", env: CHILD_ENV });

  const channel = new MessageChannelMain();
  ptyhost?.postMessage({ type: "link" }, [channel.port1]);
  server.postMessage({ type: "link" }, [channel.port2]);

  server.on("message", (raw) => {
    const msg = raw && raw.data !== undefined ? raw.data : raw;
    // The UI asking to be put back on current source. Ghosttown's prefix+B,
    // except that here it costs nothing: the agents are next door.
    if (msg && msg.type === "restart") void restartServer();
  });

  server.on("exit", (code) => {
    server = null;
    if (quitting || replacingServer) return;
    /**
     * A server that dies on its own is worth bringing back — it holds no ptys,
     * so it is cheap, and the agents next door are still waiting for one. But a
     * server that cannot start at all (a port already taken, a bad build) would
     * otherwise be forked forever at full speed, so give up after a few tries in
     * quick succession and say why.
     */
    const now = Date.now();
    if (now - lastServerStart < 3000) crashes++;
    else crashes = 0;
    if (crashes >= 3) {
      console.error(`kururu: the server keeps exiting (${code}) — leaving it down`);
      return;
    }
    console.error(`kururu: the server exited (${code}) — restarting it`);
    startServer();
  });
}

/**
 * Throw the server away and fork a new one. The agents are not in it, so this
 * costs a websocket reconnect and a repaint — the client reconnects forever by
 * design, and the layout comes back from the host.
 */
async function restartServer() {
  if (!ptyhost || replacingServer) return;
  replacingServer = true;
  try {
    if (DEV) await rebuildServer();
    const old = server;
    server = null;
    if (old) {
      await new Promise((resolve) => {
        old.once("exit", resolve);
        old.kill();
        setTimeout(resolve, 2000);
      });
    }
    startServer();
    await waitFor(`http://127.0.0.1:${PORT}/api/health`, "the server");
  } finally {
    replacingServer = false;
  }
}

/** In dev the source is what changed, so it has to be rebuilt before re-forking. */
function rebuildServer() {
  return new Promise((resolve) => {
    const build = spawn(process.execPath, [path.join(__dirname, "build.mjs")], {
      stdio: "inherit",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    build.on("exit", resolve);
    build.on("error", resolve);
  });
}

/**
 * In dev, editing the server restarts it — the same reflex `GHOSTTOWN_DEV=1`
 * gives the TUI, and possible for the same reason: what it restarts is not what
 * holds the processes. The pty host is deliberately *not* watched. Its files
 * change rarely, and picking up a change there means ending every agent, which
 * is a thing to do on purpose rather than on save.
 */
function watchServerSources() {
  const roots = [path.join(__dirname, "../server/src"), path.join(__dirname, "../shared")];
  let timer = null;
  for (const dir of roots) {
    if (!existsSync(dir)) continue;
    watch(dir, { recursive: true }, (_event, file) => {
      if (!file || !file.endsWith(".ts")) return;
      // The host is the part a restart cannot help with; say so rather than
      // silently doing half of what the edit asked for.
      if (file.includes("agents/") || file.includes("ptyhost")) {
        console.log(`kururu: ${file} is the pty host's — restart the app to pick it up`);
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => void restartServer(), 250);
    });
  }
}

/**
 * Ask the pty host something and wait for its answer. There is exactly one
 * question worth asking (how many agents are running), so this stays a function
 * rather than growing into a protocol. It goes to the host rather than the
 * server because the host is the one that knows — and the one that is still
 * there while the server is being replaced.
 */
function askPtyHost(type, replyType = type, timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (!ptyhost) return resolve(null);
    const timer = setTimeout(() => {
      ptyhost?.removeListener("message", onMessage);
      // A server that does not answer must not hold the app open; the caller
      // treats null as "assume the worst and carry on".
      resolve(null);
    }, timeoutMs);
    const onMessage = (raw) => {
      // Electron hands the parent the value; a MessagePort-shaped event would
      // wrap it in `.data`. Accept either rather than depend on which.
      const msg = raw && raw.data !== undefined ? raw.data : raw;
      if (!msg || msg.type !== replyType) return;
      clearTimeout(timer);
      ptyhost?.removeListener("message", onMessage);
      resolve(msg);
    };
    ptyhost.on("message", onMessage);
    ptyhost.postMessage({ type });
  });
}

/** In dev the UI is vite's, so the app starts vite too rather than asking you to. */
function startVite() {
  vite = spawn(bunPath(), ["run", "--cwd", path.join(__dirname, "../web"), "dev"], {
    stdio: "inherit",
    env: { ...process.env, KURURU_PORT: String(PORT) },
  });
  vite.on("error", (err) => console.error("kururu: could not start vite —", err.message));
}

/**
 * The menu bar, and the one thing it exists to say out loud.
 *
 * Kururu has two reloads and they are not variations on each other. **Reload
 * Window** throws away the UI and draws it again from the same server — a
 * repaint, and the only one of the two that is ever about what is on screen.
 * **Restart Server** throws the server process away and forks a new one, which
 * is how a change to the protocol, the layout or the discovery gets picked up
 * without the app going down with it. The agents are in neither: they live in
 * the pty host, one process over, and watch both of these happen without
 * noticing. That is the whole reason the split exists, and a menu that offered
 * only one of them made the cheaper half look like the only half.
 *
 * Everything else here is Electron's own roles, spelled out only because
 * replacing the default menu replaces all of it. Edit is not decoration: a
 * terminal without copy and paste in the menu is a terminal whose ⌘C people
 * distrust.
 */
function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload", label: "Reload Window" },
        {
          label: "Restart Server",
          accelerator: "Shift+CmdOrCtrl+R",
          // The agents are next door, so this is cheap — say so, because the
          // word "restart" in an app that owns processes reads as expensive.
          toolTip: "Fork a new server. The agents keep running.",
          click: () => void restartServer(),
        },
        // Kept, without a shortcut: it is Chromium's cache-busting reload, which
        // is a browser concern rather than a kururu one, and the chord it
        // normally answers to is worth more to the restart above.
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

  /**
   * The renderer being killed is the third way this window goes black, and the
   * only one that is not kururu's own doing.
   *
   * When macOS runs out of memory it does not slow down, it picks processes and
   * kills them — and a Chromium renderer is a prime target, being large and, as
   * far as the kernel is concerned, reconstructible. The process dies, nothing
   * paints, and `backgroundColor` is all that is left: a window of flat
   * `#0d0f0e` that looks exactly like a lost GL context or a crashed UI, with
   * the browser's tabs dying alongside it for the same reason. There is nothing
   * in the page that can report this, because there is no page any more.
   *
   * So the main process says it instead. It survives — it is a few megabytes
   * and holds nothing worth reclaiming — and it is the only part of the app
   * still able to put words on screen. What it mostly has to get across is that
   * the agents are not in here: they are in the pty host, which the OS had no
   * reason to touch, so this costs a repaint even though it looked terminal.
   *
   * It asks rather than reloading by itself. A reload allocates a fresh renderer
   * immediately, and if the machine is still out of memory that one is killed
   * too — an automatic retry under real pressure is a loop, and a loop is how a
   * window that could have waited becomes one that never comes back.
   */
  let explaining = false;
  win.webContents.on("render-process-gone", async (_event, details) => {
    if (details.reason === "clean-exit" || win.isDestroyed()) return;
    // One dialog at a time; a second kill while the first is still up would
    // stack a box the user has to dismiss twice to act once.
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
          ? "macOS ran out of memory and reclaimed it, which is the same thing it does to browser tabs — so anything else that disappeared went the same way, and kururu is not what it was reacting to. Your agents are untouched: they run in the pty host, a separate process, and are still going. Reloading costs a repaint.\n\nIf this keeps happening, something on this machine is holding far more memory than it should; the window is the symptom, not the cause."
          : "The agents are in the pty host, a separate process, and are still running. Reloading the window costs a repaint and nothing else.",
      });
      if (response === 0 && !win.isDestroyed()) win.reload();
    } finally {
      explaining = false;
    }
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

  buildMenu();

  startPtyHost();
  startServer();
  await waitFor(`http://127.0.0.1:${PORT}/api/health`, "the server");
  if (DEV) watchServerSources();

  if (DEV) {
    startVite();
    // Without this the window loads before vite is listening and sits there
    // showing ERR_CONNECTION_REFUSED, because a failed loadURL is not retried.
    await waitFor(URL, "vite");
  }

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/**
 * Closing the window is not quitting, on macOS by convention and here very much
 * on purpose: the agents are in this app now, so window-all-closed quitting
 * would mean closing a window ends whatever they were doing. Shut instead of
 * quit, the server keeps serving the phone and the agents keep working.
 */
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// ---------------------------------------------------------------------------
// Quitting
// ---------------------------------------------------------------------------

let quitting = false;

/**
 * Quitting kills every agent, which is the sharp edge of owning them. So it
 * asks first — but only when there is something to lose, because a confirmation
 * on every quit is one nobody reads.
 */
async function confirmAndQuit() {
  const answer = await askPtyHost("live-agents");
  const live = answer?.count ?? 0;

  if (live > 0) {
    const { response } = await dialog.showMessageBox({
      type: "warning",
      buttons: ["Quit and stop them", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: live === 1 ? "One agent is still running." : `${live} agents are still running.`,
      detail: "They run inside kururu, so quitting stops them. Closing the window instead leaves them working, and keeps the phone connected.",
    });
    if (response !== 0) return;
  }

  await shutdown();
  quitting = true;
  app.quit();
}

/** Everything the OS will not clean up for us: ptys first, they are the ones that linger. */
async function shutdown() {
  // The server first, and without ceremony: it holds no ptys, and stopping it
  // stops anybody typing at one while the host is taking them down.
  if (server) {
    server.kill();
    server = null;
  }
  if (ptyhost) {
    // Give it the chance to kill its ptys itself; killing the host first would
    // orphan them, which is the exact thing this is for.
    await askPtyHost("shutdown", "shutdown-done", 3000);
    ptyhost.kill();
    ptyhost = null;
  }
  if (vite) {
    vite.kill();
    vite = null;
  }
}

app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  void confirmAndQuit();
});

// A crash or a signal still gets the ptys reaped, even with no chance to ask.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    quitting = true;
    if (server) server.kill();
    if (ptyhost) ptyhost.kill();
    if (vite) vite.kill();
    app.quit();
  });
}
