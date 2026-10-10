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
const { existsSync } = require("node:fs");
const { createInterface } = require("node:readline");

/** Where macOS keeps the switch the helper needs. */
const INPUT_MONITORING = "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent";
/** Room around the pill so its shadow is not cut by the window's edge. */
const PANEL_MARGIN = 8;
/** The talk key a fresh install hooks, as `shared/voice.ts` defaults it. The panel reports the real one. */
const DEFAULT_KEY = "ControlRight";

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
    this.pillPlace = saved.pill ?? null;
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
      panel.webContents.on("did-fail-load", (_event, code, text, url) => console.error(`kururu pill: ${url} failed to load (${code} ${text})`));
    }
    panel.on("moved", () => {
      // Our own `setPosition` moves it too, and a spot this file chose is not
      // one to remember: only a drag pins the pill.
      if (this.placing) return;
      clearTimeout(this.moveTimer);
      this.moveTimer = setTimeout(() => {
        if (!this.panel || this.panel.isDestroyed()) return;
        const [x, y] = this.panel.getPosition();
        this.pillPlace = { x, y };
        this.save({ pill: this.pillPlace });
      }, 300);
    });
    panel.on("closed", () => {
      if (this.panel === panel) this.panel = null;
    });
    this.panel = panel;
    this.loaded = null;
    this.place();
    this.load();
  }

  destroyPanel() {
    const panel = this.panel;
    this.panel = null;
    if (panel && !panel.isDestroyed()) panel.destroy();
  }

  /** Where this Mac last left it, kept on a screen that still exists, or its own spot at the bottom of the main one. */
  place() {
    if (!this.panel) return;
    const [width, height] = this.panel.getSize();
    const saved = this.pillPlace;
    this.placing = true;
    try {
      if (saved) {
        const display = screen.getDisplayNearestPoint(saved);
        const area = display.workArea;
        const x = Math.min(Math.max(saved.x, area.x), area.x + area.width - width);
        const y = Math.min(Math.max(saved.y, area.y), area.y + area.height - height);
        this.panel.setPosition(Math.round(x), Math.round(y));
      } else {
        const area = screen.getPrimaryDisplay().workArea;
        this.panel.setPosition(Math.round(area.x + (area.width - width) / 2), Math.round(area.y + area.height - height - 48));
      }
    } finally {
      // The `moved` event is delivered after this returns, so the flag is let
      // go a turn later rather than here.
      setTimeout(() => {
        this.placing = false;
      }, 0);
    }
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
    if (phase === "idle") {
      if (this.panel.isVisible()) this.panel.hide();
      if (this.reloadOwed) this.load();
    } else {
      const width = Number.isFinite(state.width) ? Math.ceil(state.width) + PANEL_MARGIN * 2 : null;
      const height = Number.isFinite(state.height) ? Math.ceil(state.height) + PANEL_MARGIN * 2 : null;
      if (width && height && width > 0 && height > 0) {
        const [w, h] = this.panel.getSize();
        if (w !== width || h !== height) {
          // Grown from the left edge in place rather than re-centred, so a
          // pill that gets longer with each sentence does not walk.
          this.panel.setSize(width, height);
          this.place();
        }
      }
      if (!this.panel.isVisible()) {
        this.place();
        this.panel.showInactive();
      }
    }
    if (changed) this.changed();
  }

  /** A gesture from the main window — its mic button, or Escape while the pill is listening — routed to the one voice client. */
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

module.exports = { TalkKey };
