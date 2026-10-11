/**
 * The talk key everywhere, and the pill that floats over everything.
 *
 * Two things the window could not do, done by the one process that can. The
 * window's key handler hears a key only while the window is focused, so the
 * hook is a native helper (`talkkey/talkkey.swift`) that listens to the
 * whole session and says, one line per event, that the key went down or
 * came up. And the pill that shows the microphone is a component inside the
 * page, so to be seen over another application it has to be a window of its
 * own: a small panel kept on top of every space, loading the same web build
 * in a mode that draws the pill and nothing else.
 *
 * **One voice client on this Mac.** While the hook is on, the panel is the
 * page that holds the microphone, posts the clip, plays the reply and tells
 * the server what it played. The main window's `voice.ts` is told so over
 * the bridge and forwards its gestures — the mic button, Escape — here
 * instead of acting on them, which is what makes a key seen by both the
 * hook and the window fire once. The grammar of the key (hold, tap, Escape)
 * stays in `voice.ts`, written once; this file routes.
 *
 * The helper's events never reach the main window. They are sent to the
 * panel's webContents and nowhere else, and the panel's reports are accepted
 * from that webContents and no other, so a served page in the window cannot
 * pose as the pill and a pill cannot be fed by anything but the hook.
 */
const { BrowserWindow, globalShortcut, screen, shell } = require("electron");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { appendFileSync, existsSync, mkdirSync, renameSync, statSync } = require("node:fs");
const path = require("node:path");
const { createInterface } = require("node:readline");
const { stateDir } = require("./runner");

/** Where macOS keeps the switch the helper needs. */
const INPUT_MONITORING = "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent";
/** Room around the pill so its shadow is not cut by the window's edge. */
const PANEL_MARGIN = 8;
/** How far above the bottom of its display a pill that was never dragged sits. */
const HOME_LIFT = 48;
/** The talk key a fresh install hooks, as `shared/voice.ts` defaults it. The panel reports the real one. */
const DEFAULT_KEY = "ControlRight";
/**
 * When the pill is placed again after a display change, besides at once.
 * macOS is still rearranging for a while after the first event — it moves
 * the windows that were on a display that left, and `screen` can answer with
 * the arrangement from before until it has caught up — so a place decided
 * at the event alone can be decided against displays that are no longer
 * there. Later passes cost nothing when the first was right.
 */
const SETTLE_MS = [600, 2500];
/** How long the pill page gets to answer a reset before it is taken for wedged and loaded again. */
const LOCATE_ANSWER_MS = 2000;
/** `pill.log` is moved aside at this size, as `lifecycle.log` is. */
const LOG_MAX_BYTES = 256 * 1024;

function pillLog() {
  return path.join(stateDir(), "pill.log");
}

/**
 * One line of `pill.log`.
 *
 * The pill is a window nobody can open the devtools of, in an app whose
 * stderr goes nowhere once it is installed, and its one recurring bug is "it
 * is not where I can see it" — which nothing on screen can answer, because
 * the answer is the thing that is not on screen. So every decision about
 * where it goes is written down with the displays it was made against, and
 * the next disappearance is a file to read rather than a theory.
 */
function note(what, fields = {}) {
  try {
    const file = pillLog();
    mkdirSync(path.dirname(file), { recursive: true });
    if (existsSync(file) && statSync(file).size > LOG_MAX_BYTES) renameSync(file, `${file}.1`);
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), what, ...fields })}\n`);
  } catch {
    // The log is for afterwards; it is not a reason to fail now.
  }
}

/** A display as the log spells it: enough to see what `place()` was choosing between. */
function describe(display) {
  if (!display) return null;
  const { id, label, bounds, workArea, scaleFactor, internal, detected } = display;
  return { id, label, bounds, workArea, scale: scaleFactor, internal, detected };
}

function inside(point, rect) {
  return point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height;
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

/**
 * The displays a pill may be put on. `screen` can list one the system says
 * it has not detected — Electron's own `detected` flag — or one with no work
 * area to speak of, and a pill sent to either is a pill nobody sees. All of
 * them, if that leaves none: a guess on a listed display beats no place.
 */
function realDisplays() {
  const all = screen.getAllDisplays();
  const real = all.filter((d) => d.detected !== false && d.workArea.width > 0 && d.workArea.height > 0);
  return real.length > 0 ? real : all;
}

/**
 * Where a pill with nowhere of its own to be lands: the display under the
 * cursor, which is almost always the one the person is looking at — it is
 * the one whose menu bar Reset was clicked in — or the nearest real one to
 * it, or the primary one when there is no cursor to ask. Said with which of
 * those it was, for the log.
 */
function homeDisplay(displays) {
  let cursor = null;
  try {
    cursor = screen.getCursorScreenPoint();
  } catch {
    // No cursor to ask; the primary display answers below.
  }
  if (cursor) {
    const under = displays.find((d) => inside(cursor, d.bounds));
    if (under) return { display: under, via: "under the cursor", cursor };
    const nearest = screen.getDisplayNearestPoint(cursor);
    const known = displays.find((d) => d.id === nearest.id);
    if (known) return { display: known, via: "nearest the cursor", cursor };
  }
  const primary = screen.getPrimaryDisplay();
  return { display: displays.find((d) => d.id === primary.id) ?? displays[0] ?? primary, via: "primary", cursor };
}

/**
 * A saved place, or none. Kept as a share of whichever display it was
 * dragged on — `web/src/place.ts`'s own reasoning, moved from a window that
 * resizes to a display that can disappear: a pixel position is nonsense the
 * moment that display is unplugged, where a share of *a* display, any
 * display, is always a real spot on it. An older build saved a raw pixel
 * pair with no `displayId`, which would misread as a share far past 1 and
 * is dropped rather than honoured.
 */
function sanitizePlace(raw) {
  if (!raw || typeof raw !== "object") return null;
  const { displayId, x, y } = raw;
  if (typeof displayId !== "number" || typeof x !== "number" || typeof y !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { displayId, x, y };
}

/** How far along `free` pixels `at` is, 0–1. A pill as wide as its display has no room to move in on that axis, and the middle is the honest answer. */
function share(at, free) {
  if (!(free > 0) || !Number.isFinite(at)) return 0.5;
  return Math.min(1, Math.max(0, at / free));
}

class TalkKey extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.helperPath  the compiled hook, which may be missing from a build without Xcode
   * @param {string} options.preloadPath
   * @param {boolean} options.debug  relay the pill page's console and its reports to stderr: a dev shell has one
   * @param {object} options.saved  `talkKeyEverywhere`, `altSpace`, `pill`, `talkKey` from `desktop.json`
   * @param {(patch: object) => void} options.save
   */
  constructor({ helperPath, preloadPath, debug = false, saved, save }) {
    super();
    this.helperPath = helperPath;
    this.preloadPath = preloadPath;
    this.debug = debug;
    this.save = save;

    this.enabled = saved.talkKeyEverywhere === true;
    this.altSpace = saved.altSpace === true;
    this.pillPlace = sanitizePlace(saved.pill);
    this.key = typeof saved.talkKey === "string" ? saved.talkKey : DEFAULT_KEY;

    /** `off`, `starting`, `live`, `denied`, `missing`, `unsupported`, `crashed`. */
    this.status = "off";
    this.phase = "idle";
    this.paused = false;
    this.helper = null;
    this.helperHeld = false;
    this.stoppingHelper = false;
    this.panel = null;
    /** The origin the pill's page comes from — a server, or a checkout's vite — or null while there is none. */
    this.page = null;
    /** What the panel last loaded, so a page that went away and came back is not loaded again. */
    this.loaded = null;
    /** A reload asked for while the pill was busy, done when it is idle. */
    this.reloadOwed = false;
    this.moveTimer = null;
    this.placing = false;
    /**
     * Whether this file has the panel up. Kept rather than asked of
     * `isVisible()`, which is the window server's opinion, and the one case
     * that matters is a panel that was shown and is not where anybody can see
     * it — which still answers that it is visible.
     */
    this.shown = false;
    /** Whether `screen`'s display events are already being listened for — once for the process, not once per panel. */
    this.watchingDisplays = false;
    /** The passes still to run after the last display change. */
    this.settleTimers = [];
    /** Until when a move of the panel is the system's rearranging and not a drag. */
    this.settleUntil = 0;
    /** The page is showing itself for the tray's Reset. */
    this.locating = false;
    this.locateTimer = null;
    /** A reset the page did not answer, sent again once it has loaded again. */
    this.locateOwed = false;
    /** When the page was last loaded again because its renderer went, so a renderer that dies on load is not loaded forever. */
    this.revivedAt = 0;
  }

  state() {
    return { on: this.enabled, live: this.status === "live", status: this.status, phase: this.phase, altSpace: this.altSpace };
  }

  changed() {
    this.emit("change", this.state());
  }

  // --- switching on and off ------------------------------------------------------

  setEnabled(on) {
    on = on === true;
    if (on === this.enabled) return;
    this.enabled = on;
    this.save({ talkKeyEverywhere: on });
    if (on) {
      this.ensurePanel();
      this.startHelper();
    } else {
      this.stopHelper();
      this.destroyPanel();
      this.status = "off";
      this.phase = "idle";
    }
    this.changed();
  }

  /**
   * ⌥Space as a toggle, through Electron's own global shortcut. It needs no
   * permission and sees no key-up, so it can only toggle — a tap, in the
   * key's grammar — and it is the fallback for a Mac where Input Monitoring
   * was refused, never the default.
   */
  setAltSpace(on) {
    on = on === true;
    if (on === this.altSpace) return;
    this.altSpace = on;
    this.save({ altSpace: on });
    if (on) {
      this.ensurePanel();
      const registered = globalShortcut.register("Alt+Space", () => this.toPanel("toggle"));
      if (!registered) console.error("kururu: ⌥Space is taken by something else");
    } else {
      globalShortcut.unregister("Alt+Space");
      if (!this.enabled) this.destroyPanel();
    }
    this.changed();
  }

  /** The window's Settings page is capturing a new key; a press meant for it is not a word for Kuru. */
  pause(on) {
    this.paused = on === true;
  }

  openInputMonitoring() {
    void shell.openExternal(INPUT_MONITORING);
  }

  // --- the helper ---------------------------------------------------------------------

  startHelper() {
    this.stopHelper();
    if (!existsSync(this.helperPath)) {
      this.status = "missing";
      return;
    }
    this.status = "starting";
    const child = spawn(this.helperPath, [this.key], { stdio: ["pipe", "pipe", "pipe"] });
    this.helper = child;
    this.helperHeld = false;
    child.on("error", (err) => {
      console.error("kururu: the talk-key hook could not start —", err.message);
      if (this.helper === child) {
        this.helper = null;
        this.status = "crashed";
        this.changed();
      }
    });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (this.helper !== child || !event || typeof event.ev !== "string") return;
      this.fromHelper(event.ev);
    });
    child.stderr.on("data", (chunk) => console.error(`kururu talkkey: ${String(chunk).trim()}`));
    child.on("exit", (code, signal) => {
      if (this.helper !== child) return;
      this.helper = null;
      // A hold the hook was in the middle of ends with the hook: the clip
      // is sent rather than the microphone left open, as the window does
      // when it loses focus mid-sentence.
      if (this.helperHeld) {
        this.helperHeld = false;
        this.toPanel("up");
      }
      if (this.stoppingHelper || this.status === "unsupported") return;
      console.error(`kururu: the talk-key hook ${signal ? `was killed by ${signal}` : `exited with ${code}`}`);
      this.status = "crashed";
      this.changed();
    });
  }

  stopHelper() {
    const child = this.helper;
    if (!child) return;
    this.stoppingHelper = true;
    this.helper = null;
    try {
      // Closing its stdin is how it is told to go; a signal is for one that did not listen.
      child.stdin.end();
      setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          // Already gone.
        }
      }, 1000).unref();
    } catch {
      // Already gone.
    }
    this.stoppingHelper = false;
  }

  fromHelper(ev) {
    switch (ev) {
      case "ready":
        this.status = "live";
        this.changed();
        return;
      case "denied":
        this.status = "denied";
        this.changed();
        return;
      case "unsupported":
        this.status = "unsupported";
        this.changed();
        return;
      case "down":
        this.helperHeld = true;
        break;
      case "up":
        this.helperHeld = false;
        break;
      case "escape":
      case "chord":
        break;
      default:
        return;
    }
    if (this.paused) return;
    this.toPanel(ev);
  }

  /** The talk key the server's settings name, as the panel last reported it. A change restarts the hook on the new key. */
  setKey(code) {
    if (typeof code !== "string" || !/^[A-Za-z0-9]{1,32}$/.test(code) || code === this.key) return;
    this.key = code;
    this.save({ talkKey: code });
    if (this.enabled) {
      this.startHelper();
      this.changed();
    }
  }

  // --- the panel --------------------------------------------------------------------

  /**
   * Where the pill's page comes from: the server's own, or the checkout's
   * vite in front of it, as `main.js` decides for the window too. Null while
   * there is no server, which loads nothing, and the page already loaded is
   * not loaded again when the same one comes back — a server restart is a
   * reconnect for the pill as it is for the window, never a reload.
   */
  setPage(origin) {
    this.page = origin;
    if (!this.panel || !origin || origin === this.loaded) return;
    this.load();
  }

  load() {
    if (!this.panel || !this.page) return;
    this.loaded = this.page;
    this.reloadOwed = false;
    void this.panel.loadURL(`${this.page}/?pill`).catch(() => {});
  }

  /**
   * The pill's ⌘R, which it cannot have of its own because it never takes
   * the focus. Not while it is listening or speaking: a reload there drops
   * the sentence, so it waits for the pill to go idle.
   */
  reloadPanel() {
    if (!this.panel || !this.loaded) return;
    if (this.phase !== "idle") {
      this.reloadOwed = true;
      return;
    }
    this.load();
  }

  ensurePanel() {
    if (this.panel) return;
    this.watchDisplays();
    const panel = new BrowserWindow({
      width: 480,
      height: 72,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // Never focusable, so a key pressed over another application moves no
      // focus and the reply is read over whatever was being typed into.
      focusable: false,
      alwaysOnTop: true,
      // A non-activating panel on macOS, which is what lets it sit over a
      // full-screen application without taking the app out of the way.
      type: "panel",
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        // The pill plays Kuru's reply, and nobody clicked it first.
        autoplayPolicy: "no-user-gesture-required",
        // Hidden most of the time, and the hidden page is the one holding
        // the microphone and the player.
        backgroundThrottling: false,
      },
    });
    panel.setAlwaysOnTop(true, "floating");
    panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    panel.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    if (this.debug) {
      // Electron 44 hands the event an object with `message` on it and warns about the old positional arguments; both are read so neither version is silent.
      panel.webContents.on("console-message", (event, ...legacy) => console.log(`kururu pill: ${event?.message ?? legacy[1]}`));
    }
    panel.webContents.on("did-fail-load", (_event, code, text, url) => {
      if (this.debug) console.error(`kururu pill: ${url} failed to load (${code} ${text})`);
      note("load-failed", { url, code, text });
    });
    panel.webContents.on("did-finish-load", () => {
      if (!this.locateOwed) return;
      this.locateOwed = false;
      // The preload keeps it for a page still mounting.
      panel.webContents.send("kururu:pill-locate");
    });
    // The page holds the microphone and draws the pill, so a renderer that
    // went is a pill that went, and nothing else would ever bring it back.
    panel.webContents.on("render-process-gone", (_event, details) => {
      note("page-gone", { reason: details.reason, exitCode: details.exitCode });
      if (this.panel !== panel || Date.now() - this.revivedAt < 30_000) return;
      this.revivedAt = Date.now();
      this.conceal();
      this.load();
    });
    panel.on("moved", () => {
      // Our own `setPosition` moves it too, and a spot this file chose is not
      // one to remember: only a drag pins the pill. Neither is macOS moving
      // it off a display that left, which it does on its own schedule after
      // the change — a pin taken then would be a share of wherever the system
      // happened to drop it, measured against displays `screen` may not have
      // caught up with.
      if (this.placing || Date.now() < this.settleUntil) return;
      clearTimeout(this.moveTimer);
      this.moveTimer = setTimeout(() => {
        if (!this.panel || this.panel.isDestroyed()) return;
        const [x, y] = this.panel.getPosition();
        const [width, height] = this.panel.getSize();
        // The display it was actually dropped on, not the one it started
        // from — a drag across two monitors pins it to where most of it landed.
        const display = screen.getDisplayNearestPoint({ x: x + width / 2, y: y + height / 2 });
        const area = display.workArea;
        this.pillPlace = { displayId: display.id, x: share(x - area.x, area.width - width), y: share(y - area.y, area.height - height) };
        this.save({ pill: this.pillPlace });
        note("pinned", { place: this.pillPlace, at: { x, y, width, height }, display: describe(display) });
      }, 300);
    });
    panel.on("closed", () => {
      if (this.panel === panel) this.panel = null;
    });
    this.panel = panel;
    this.loaded = null;
    this.shown = false;
    this.place("created");
    this.load();
  }

  destroyPanel() {
    const panel = this.panel;
    this.panel = null;
    this.shown = false;
    this.locating = false;
    this.locateOwed = false;
    clearTimeout(this.locateTimer);
    for (const timer of this.settleTimers) clearTimeout(timer);
    this.settleTimers = [];
    if (panel && !panel.isDestroyed()) panel.destroy();
  }

  /**
   * A display plugged in, unplugged, or resized or rotated under it. `place`
   * redoes the position from the share it kept, which is what both fixes a
   * pill stranded on a monitor that is gone and keeps it in the same
   * relative spot on one that only changed shape.
   *
   * KUR-68 did only that, once, at the event — and the pill still went
   * missing, because the event is where a change starts rather than where
   * it ends (`SETTLE_MS`), and because a pill that was up when it happened
   * was moved but never shown again. So it is placed now and again as the
   * change settles, and a pill that is up is shown again each time.
   */
  watchDisplays() {
    if (this.watchingDisplays) return;
    this.watchingDisplays = true;
    const on = (what) => (_event, display, metrics) => this.displaysChanged(what, display, metrics);
    screen.on("display-added", on("display-added"));
    screen.on("display-removed", on("display-removed"));
    screen.on("display-metrics-changed", on("display-metrics-changed"));
  }

  displaysChanged(what, display, metrics) {
    if (!this.panel) return;
    note(what, { display: describe(display), metrics });
    const again = (why) => (this.shown ? this.reveal(why) : this.place(why));
    for (const timer of this.settleTimers) clearTimeout(timer);
    this.settleUntil = Date.now() + Math.max(...SETTLE_MS) + 500;
    again(what);
    this.settleTimers = SETTLE_MS.map((ms) => setTimeout(() => again(`settled ${ms} ms after ${what}`), ms));
  }

  /**
   * Where this Mac last left it: the share it was dragged to, reapplied to
   * the same display when it still exists, or to whichever is home when it
   * does not — which is also the whole of what fixes a pill stranded on a
   * monitor switched away from, since the display that is gone is exactly
   * the one `find` fails to match. No saved place at all is a pill that has
   * never been dragged, which gets its own spot at the bottom of home.
   *
   * Whatever the arithmetic says, the result is held inside the chosen
   * display's work area, and then read back: a panel whose middle is on no
   * display the system detects is put on the primary one, said in the log,
   * rather than trusted.
   */
  place(why) {
    const panel = this.panel;
    if (!panel || panel.isDestroyed()) return;
    const [width, height] = panel.getSize();
    const displays = realDisplays();
    const saved = this.pillPlace;
    const pinned = saved ? displays.find((d) => d.id === saved.displayId) : undefined;
    const home = pinned ? null : homeDisplay(displays);
    const display = pinned ?? home.display;
    const area = display.workArea;
    const x = saved ? area.x + saved.x * Math.max(0, area.width - width) : area.x + (area.width - width) / 2;
    const y = saved ? area.y + saved.y * Math.max(0, area.height - height) : area.y + area.height - height - HOME_LIFT;
    const target = {
      x: Math.round(clamp(x, area.x, area.x + area.width - width)),
      y: Math.round(clamp(y, area.y, area.y + area.height - height)),
      width,
      height,
    };
    this.setPosition(target.x, target.y);
    let got = panel.getBounds();
    const middle = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
    let landed = displays.find((d) => inside(middle(got), d.bounds)) ?? null;
    let rescued = false;
    if (!landed) {
      const primary = screen.getPrimaryDisplay().workArea;
      this.setPosition(Math.round(primary.x + (primary.width - width) / 2), Math.round(primary.y + primary.height - height - HOME_LIFT));
      got = panel.getBounds();
      landed = displays.find((d) => inside(middle(got), d.bounds)) ?? null;
      rescued = true;
    }
    note("place", {
      why,
      via: pinned ? "pinned display" : saved ? `pinned display ${saved.displayId} is gone; ${home.via}` : home.via,
      display: display.id,
      saved,
      cursor: home?.cursor ?? null,
      target,
      got,
      landed: landed?.id ?? null,
      rescued,
      shown: this.shown,
      visible: panel.isVisible(),
      phase: this.phase,
      displays: displays.map(describe),
    });
  }

  setPosition(x, y) {
    this.placing = true;
    try {
      this.panel.setPosition(x, y);
    } finally {
      // The `moved` event is delivered after this returns, so the flag is let
      // go a turn later rather than here.
      setTimeout(() => {
        this.placing = false;
      }, 0);
    }
  }

  /** Put it up, wherever `place` says. */
  reveal(why) {
    const panel = this.panel;
    if (!panel || panel.isDestroyed()) return;
    this.place(why);
    // Again on a panel already up is deliberate: it is `orderFrontRegardless`,
    // which puts it back in front of its level on the display it now sits on,
    // and costs nothing when it already was.
    panel.showInactive();
    this.shown = true;
    // A transparent window with no shadow that has not painted is invisible
    // and reports itself visible, and a display that changed under it is when
    // a frame is likeliest to be missing. The meter repaints thirty times a
    // second while listening; a pill only showing words would wait for its
    // next sentence.
    panel.webContents.invalidate();
  }

  conceal() {
    const panel = this.panel;
    if (!panel || panel.isDestroyed()) return;
    if (this.shown || panel.isVisible()) panel.hide();
    this.shown = false;
  }

  /**
   * The tray's "Reset Pill Position": forget where it was dragged to, put it
   * at its own spot on the display under the cursor, and show it there — now,
   * whether or not it has anything to say.
   *
   * The last part is the fix. The pill is only up while it is talking, so a
   * reset used to move a hidden window to the right place and show nothing,
   * which reads exactly as a reset that did not work. The page draws a pill
   * that says where it is for a few seconds (`Pill.tsx`) and reports
   * `locating`, which `report` shows like any other phase. A page that does
   * not answer is loaded again and asked again, since a wedged page is the
   * other way a pill disappears.
   */
  resetPlace() {
    this.pillPlace = null;
    this.save({ pill: null });
    const contents = this.panelContents();
    if (!contents) {
      note("reset", { why: "there is no panel: the talk key everywhere and ⌥Space are both off" });
      return;
    }
    note("reset", { phase: this.phase, shown: this.shown });
    if (this.shown) this.reveal("reset");
    else this.place("reset");
    contents.send("kururu:pill-locate");
    clearTimeout(this.locateTimer);
    this.locateTimer = setTimeout(() => {
      if (this.locating || this.phase !== "idle" || this.panelContents() !== contents) return;
      note("reset", { why: `the pill page did not answer in ${LOCATE_ANSWER_MS} ms; loading it again`, crashed: contents.isCrashed(), url: contents.getURL(), page: this.page });
      // With no server there is no page to load, and a reset kept until one
      // comes back would show a pill nobody asked for just then.
      if (!this.page) return;
      this.locateOwed = true;
      this.load();
    }, LOCATE_ANSWER_MS);
  }

  panelContents() {
    return this.panel && !this.panel.isDestroyed() ? this.panel.webContents : null;
  }

  toPanel(ev) {
    const contents = this.panelContents();
    if (!contents) return;
    contents.send("kururu:talk", ev);
  }

  /**
   * The pill's page saying what it is showing and how big it is. The window
   * is sized to the pill so the transparent part of it is never under a
   * pointer, and shown or hidden as the pill is.
   */
  report(state) {
    if (!this.panel || !state || typeof state !== "object") return;
    if (this.debug && state.phase !== this.phase) console.log(`kururu pill: ${state.phase} ${Math.round(state.width)}x${Math.round(state.height)} key=${state.key}`);
    if (typeof state.key === "string") this.setKey(state.key);
    const phase = typeof state.phase === "string" ? state.phase : "idle";
    const changed = phase !== this.phase;
    this.phase = phase;
    // Kept apart from the phase, which every window is told: a reset is the
    // panel's business, and a window that took it for a phase would take an
    // Escape for the pill's and keep it from the terminal.
    this.locating = state.locating === true;
    if (this.locating) clearTimeout(this.locateTimer);
    if (phase === "idle" && !this.locating) {
      this.conceal();
      if (this.reloadOwed) this.load();
    } else {
      let resized = false;
      const width = Number.isFinite(state.width) ? Math.ceil(state.width) + PANEL_MARGIN * 2 : null;
      const height = Number.isFinite(state.height) ? Math.ceil(state.height) + PANEL_MARGIN * 2 : null;
      if (width && height && width > 0 && height > 0) {
        const [w, h] = this.panel.getSize();
        if (w !== width || h !== height) {
          this.panel.setSize(width, height);
          resized = true;
        }
      }
      // Shown afresh whenever this file did not leave it up, and never on the
      // word of `isVisible()` alone — see `shown`.
      if (!this.shown || !this.panel.isVisible()) this.reveal(phase === "idle" ? "shown for a reset" : `shown: ${phase}`);
      // Grown from the left edge in place rather than re-centred, so a pill
      // that gets longer with each sentence does not walk.
      else if (resized) this.place(`resized: ${phase}`);
    }
    if (changed) this.changed();
  }

  /** A gesture from the main window — its mic button, or Escape while the pill is listening or speaking — routed to the one voice client. */
  gesture(ev) {
    if (!this.enabled && !this.altSpace) return;
    if (!["down", "up", "escape", "dismiss", "toggle"].includes(ev)) return;
    this.toPanel(ev);
  }

  dispose() {
    this.stopHelper();
    globalShortcut.unregisterAll();
    this.destroyPanel();
  }
}

module.exports = { TalkKey, pillLog };
