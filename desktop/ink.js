/**
 * The screen pen: ink over every display, and one picture per burst of it
 * (docs/plans/screen-annotate.md).
 *
 * The user points at things by drawing on them — kururu itself, another
 * application, a second display — while they talk to Kuru, or, from the Kuru
 * drawer's pencil, while they do not. The ink has to be over everything,
 * which only a window can be, and the pictures have to leave the ink out,
 * which only the helper can do (`glance/glance.swift`); this file is the
 * main process's half between the two: the session, the overlays, the pen,
 * the bursts and their pictures, and the bundle the page that owns the
 * session posts to the server.
 *
 * **A session is owned by a page.** With a voice it is the one voice client
 * on this Mac — the floating pill while the talk key is hooked, the main
 * window otherwise — since that page holds the microphone and decides when
 * the clip ends; without one it is the main window, whose Kuru box the marks
 * go into. The owner is told to send or to drop, and asks for the bundle
 * itself (`finish`), so a clip and its ink end together whichever ended
 * first: the talk key, the pill's Send, the overlay's Done.
 *
 * **The overlays exist only while a session does**, one per display, made at
 * the start and closed at the end. A transparent window over every display
 * all day, for a feature used a minute at a time, is a window server
 * compositing nothing for hours and one more click-through window that can
 * go wrong; a stuck one is a Mac where nothing can be clicked. So every way
 * out closes them: Done, ✕, the shortcut's toolbar, the owner's own end,
 * the owner's page going away (the watchdog), an overlay's renderer dying,
 * and a send the owner never answers.
 *
 * **One still per burst, at its first pen-down**, of that display only, with
 * kururu's overlays and the pill left out by the helper's filter. What is
 * pointed at is what was there when the pointing began. Strokes on the same
 * display less than `BURST_GAP_MS` apart are one burst — one mark — and its
 * still is inked and written only once it is over, so nothing of the screen
 * is on the disk until there is ink to go with it. A password field with the
 * keyboard (`secure`) skips the still: the mark keeps its place and says so.
 */
const { BrowserWindow, globalShortcut, screen, shell } = require("electron");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { existsSync, mkdtempSync, readFileSync, rmSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createInterface } = require("node:readline");
const { BURST_GAP_MS, FRAME_LONG_EDGE, MARKS_MAX, cropRect, pointOf, strokesBox, windowNumberOf } = require("./inkshape");

/** The shortcut that starts a session with the voice, and toggles the pen in one. Needs no permission. */
const SHORTCUT = "Control+Alt+Command+D";
/** How long an owner told to send has to ask for the bundle before the overlays are taken down anyway. */
const SEND_ANSWER_MS = 15_000;
/** How long the helper has to answer one request. A still is tens of milliseconds; a 5K one inked, a few hundred. */
const HELPER_ANSWER_MS = 8_000;
/** Where macOS keeps the switch the helper needs. */
const SCREEN_RECORDING = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

/** A window's number as the window server knows it. */
function windowNumber(win) {
  try {
    return windowNumberOf(win.getMediaSourceId());
  } catch {
    return null;
  }
}

class Ink extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.helperPath  the compiled helper, missing from a build without Xcode
   * @param {string} options.pagePath  `ink.html`
   * @param {string} options.preloadPath  `inkpreload.js`
   * @param {() => import("electron").WebContents | null} options.voiceClient  the page that holds the microphone now
   * @param {() => import("electron").WebContents | null} options.mainWindow  the main window's page, whose box a session with no voice fills
   * @param {() => import("electron").BrowserWindow | null} options.pill  the floating pill's panel, kept over the ink and out of the pictures
   * @param {boolean} options.debug
   */
  constructor({ helperPath, pagePath, preloadPath, voiceClient, mainWindow, pill, debug = false }) {
    super();
    this.helperPath = helperPath;
    this.pagePath = pagePath;
    this.preloadPath = preloadPath;
    this.voiceClient = voiceClient;
    this.mainWindow = mainWindow;
    this.pill = pill;
    this.debug = debug;
    /** @type {any} */
    this.session = null;
    this.helper = null;
    this.helperSeq = 0;
    /** @type {Map<number, (answer: any) => void>} */
    this.waiting = new Map();
    this.watchingDisplays = false;
    this.lastEscapeAt = 0;
    this.registered = false;
    /** A start waiting on the helper's word about Screen Recording; a second press then is the same start. */
    this.starting = false;
  }

  // --- what the pages are told ----------------------------------------------------

  state() {
    const s = this.session;
    return s ? { on: true, id: s.id, voice: s.voice, pen: s.pen, marks: s.bursts.length, ending: s.ending } : { on: false, id: null, voice: false, pen: false, marks: 0, ending: false };
  }

  /** The owner, every overlay and every other window hear what the session is now: the drawer's pencil and the pill's pen draw from it. */
  changed() {
    const state = this.state();
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      if (this.session?.overlays && [...this.session.overlays.values()].includes(win)) win.webContents.send("ink:state", state);
      else win.webContents.send("kururu:ink", { ev: "state", ...state });
    }
    this.emit("change", state);
  }

  /** Tell the owner something only it acts on: send, drop, or why there is no pen. */
  tellOwner(owner, event) {
    if (owner && !owner.isDestroyed()) owner.send("kururu:ink", event);
  }

  // --- the shortcut -----------------------------------------------------------------

  /** ⌃⌥⌘D, for the life of the app: a session with the voice when there is none, the pen on or off in one. */
  register() {
    if (this.registered) return;
    this.registered = globalShortcut.register(SHORTCUT, () => this.shortcut());
    if (!this.registered) console.error(`kururu: ${SHORTCUT} is taken by something else; the screen pen starts from the tray or the drawer`);
  }

  shortcut() {
    if (this.session) this.setPen(!this.session.pen);
    else void this.start({ voice: true });
  }

  // --- the helper ---------------------------------------------------------------------

  ensureHelper() {
    if (this.helper) return this.helper;
    if (!existsSync(this.helperPath)) return null;
    const child = spawn(this.helperPath, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.helper = child;
    child.on("error", (err) => {
      console.error("kururu: the screen pen's helper could not start —", err.message);
      if (this.helper === child) this.helperGone();
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      let answer;
      try {
        answer = JSON.parse(line);
      } catch {
        return;
      }
      if (this.helper !== child || !answer || typeof answer.seq !== "number") return;
      const resolve = this.waiting.get(answer.seq);
      if (!resolve) return;
      this.waiting.delete(answer.seq);
      resolve(answer);
    });
    child.stderr.on("data", (chunk) => console.error(`kururu glance: ${String(chunk).trim()}`));
    child.on("exit", () => {
      if (this.helper === child) this.helperGone();
    });
    return child;
  }

  /** The helper went: every answer it owed is a failure, and a session that needed it is let go, so no overlay outlives it. */
  helperGone() {
    this.helper = null;
    for (const resolve of this.waiting.values()) resolve({ ok: false, error: "the helper went" });
    this.waiting.clear();
    if (this.session) this.cancel(this.session.id, "the screen pen's helper stopped");
  }

  stopHelper() {
    const child = this.helper;
    this.helper = null;
    for (const resolve of this.waiting.values()) resolve({ ok: false, error: "the helper was stopped" });
    this.waiting.clear();
    if (!child) return;
    try {
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
  }

  /** One request, answered or failed within `HELPER_ANSWER_MS`. */
  ask(request) {
    const child = this.ensureHelper();
    if (!child) return Promise.resolve({ ok: false, error: "missing" });
    const seq = ++this.helperSeq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.waiting.delete(seq)) resolve({ ok: false, error: "the helper did not answer" });
      }, HELPER_ANSWER_MS);
      this.waiting.set(seq, (answer) => {
        clearTimeout(timer);
        resolve(answer);
      });
      try {
        child.stdin.write(`${JSON.stringify({ ...request, seq })}\n`);
      } catch {
        this.waiting.delete(seq);
        clearTimeout(timer);
        resolve({ ok: false, error: "the helper is not listening" });
      }
    });
  }

  // --- a session ----------------------------------------------------------------------

  /**
   * Start a session. With `voice`, its owner is the voice client and it is
   * told to open the microphone, unless it already has; without, the owner
   * is the page that asked, which is the main window's. Refused, the owner
   * is told why and nothing is put on the screen: no helper, or Screen
   * Recording not allowed — which is asked for here, the first time, with
   * the system's own prompt.
   *
   * @param {{ voice: boolean, asker?: import("electron").WebContents | null }} options
   */
  async start({ voice, asker = null }) {
    if (this.session || this.starting) return this.state();
    const owner = voice ? this.voiceClient() : asker;
    if (!owner || owner.isDestroyed()) {
      console.error("kururu: the screen pen has no page to send to: no window and no pill");
      return this.state();
    }
    this.starting = true;
    try {
      if (!existsSync(this.helperPath)) {
        this.tellOwner(owner, { ev: "refused", voice, why: "This build has no screen pen: its helper was not built (it needs Xcode)." });
        return this.state();
      }
      let access = await this.ask({ op: "access" });
      if (access.screen !== "granted") access = await this.ask({ op: "ask" });
      if (access.screen !== "granted") {
        // A helper that asked before the switch was flipped may keep the old
        // answer; the next session starts a fresh one.
        this.stopHelper();
        void shell.openExternal(SCREEN_RECORDING);
        this.tellOwner(owner, { ev: "refused", voice, why: "Kururu may not take pictures of the screen yet. Turn it on in System Settings → Privacy & Security → Screen Recording, then press the pen again." });
        return this.state();
      }
      const dir = mkdtempSync(path.join(os.tmpdir(), "kururu-ink-"));
      let home = null;
      try {
        home = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id;
      } catch {
        home = screen.getPrimaryDisplay().id;
      }
      this.session = {
        id: randomBytes(6).toString("hex"),
        voice,
        owner,
        at: Date.now(),
        pen: true,
        dir,
        home,
        /** @type {Map<number, import("electron").BrowserWindow>} */
        overlays: new Map(),
        bursts: [],
        open: null,
        sendTimer: null,
        ending: false,
        hoveringBar: new Set(),
        watch: null,
      };
      this.watchOwner(owner);
      this.watchDisplays();
      this.makeOverlays();
      this.raisePill(true);
      this.registerEscape(true);
      this.tellOwner(owner, { ev: "start", id: this.session.id, voice });
      this.changed();
      return this.state();
    } finally {
      this.starting = false;
    }
  }

  /** The owner's page going is the session going: a reload, a crash, a navigation or the window closed. */
  watchOwner(owner) {
    const session = this.session;
    const gone = (why) => () => {
      if (this.session === session) this.cancel(session.id, why);
    };
    const onGone = gone("the page that owned the pen went away");
    // A page loaded again or elsewhere, and never its own history moving
    // within it, which the window's does as it goes from view to view. Both
    // spellings read: Electron 44 hands an object and the old arguments.
    const onNavigate = (event, _url, isSameDocument, isMainFrame) => {
      const main = event?.isMainFrame ?? isMainFrame;
      const same = event?.isSameDocument ?? isSameDocument;
      if (main && !same) onGone();
    };
    owner.on("render-process-gone", onGone);
    owner.on("destroyed", onGone);
    owner.on("did-start-navigation", onNavigate);
    session.watch = () => {
      if (owner.isDestroyed()) return;
      owner.removeListener("render-process-gone", onGone);
      owner.removeListener("destroyed", onGone);
      owner.removeListener("did-start-navigation", onNavigate);
    };
  }

  makeOverlays() {
    const session = this.session;
    if (!session) return;
    for (const win of session.overlays.values()) if (!win.isDestroyed()) win.destroy();
    session.overlays.clear();
    const displays = screen.getAllDisplays();
    if (!displays.some((d) => d.id === session.home)) session.home = screen.getPrimaryDisplay().id;
    for (const display of displays) {
      const { x, y, width, height } = display.bounds;
      const win = new BrowserWindow({
        x,
        y,
        width,
        height,
        show: false,
        frame: false,
        transparent: true,
        hasShadow: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        // Never the key window, so the keyboard stays where it was; a
        // non-activating panel still takes the mouse, as the pill's ✕ shows.
        focusable: false,
        acceptFirstMouse: true,
        enableLargerThanScreen: true,
        alwaysOnTop: true,
        type: "panel",
        webPreferences: {
          preload: this.preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
        },
      });
      // Over the menu bar and every app's floating windows; the pill is
      // raised to the same level after, so its buttons stay over the ink.
      win.setAlwaysOnTop(true, "screen-saver");
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      // Made at the bounds, and set there again: macOS keeps a new window
      // under the menu bar unless it is told otherwise after it exists.
      win.setBounds(display.bounds);
      win.setIgnoreMouseEvents(!session.pen, { forward: true });
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", (event) => event.preventDefault());
      if (this.debug) win.webContents.on("console-message", (event, ...legacy) => console.log(`kururu ink: ${event?.message ?? legacy[1]}`));
      // An overlay whose page went is a window that may still take the
      // mouse with nothing in it to give it back: the session ends.
      win.webContents.on("render-process-gone", () => {
        if (this.session === session) this.cancel(session.id, "the pen's overlay stopped");
      });
      win.webContents.once("did-finish-load", () => {
        if (this.session !== session || win.isDestroyed()) return;
        win.webContents.send("ink:state", this.state());
        win.showInactive();
        this.raisePill(true);
      });
      void win.loadFile(this.pagePath, { query: { display: String(display.id), home: display.id === session.home ? "1" : "0", voice: session.voice ? "1" : "0" } });
      session.overlays.set(display.id, win);
    }
  }

  /** The overlay a page message came from, and its display, or null for any other sender. */
  overlayOf(sender) {
    const session = this.session;
    if (!session) return null;
    for (const [displayId, win] of session.overlays) {
      if (!win.isDestroyed() && win.webContents.id === sender.id) {
        const display = screen.getAllDisplays().find((d) => d.id === displayId);
        return display ? { win, display } : null;
      }
    }
    return null;
  }

  /** The windows a still leaves out: every overlay, and the pill. */
  ours() {
    const out = [];
    for (const win of this.session?.overlays.values() ?? []) {
      const n = !win.isDestroyed() ? windowNumber(win) : null;
      if (n !== null) out.push(n);
    }
    const pill = this.pill();
    const n = pill && !pill.isDestroyed() ? windowNumber(pill) : null;
    if (n !== null) out.push(n);
    return out;
  }

  raisePill(on) {
    const pill = this.pill();
    if (!pill || pill.isDestroyed()) return;
    pill.setAlwaysOnTop(true, on ? "screen-saver" : "floating");
    if (on) pill.moveTop();
  }

  setPen(on) {
    const session = this.session;
    if (!session || session.ending) return;
    session.pen = on === true;
    for (const win of session.overlays.values()) {
      if (!win.isDestroyed()) win.setIgnoreMouseEvents(!session.pen && !session.hoveringBar.has(win.webContents.id), { forward: true });
    }
    this.registerEscape(session.pen);
    if (!session.pen) this.closeBurst();
    this.changed();
  }

  /**
   * Escape lifts the pen while it is down, taken system-wide only then: with
   * the pen up the mouse is the apps' again and so is Escape. The talk-key
   * hook hears the same key and would hand it to the pill as "drop the
   * clip" — `takeEscape` is what tells it the key was the pen's.
   */
  registerEscape(on) {
    if (on) {
      if (!globalShortcut.isRegistered("Escape")) globalShortcut.register("Escape", () => this.takeEscape());
    } else if (globalShortcut.isRegistered("Escape")) globalShortcut.unregister("Escape");
  }

  /** Whether an Escape was the pen's: it lifts a pen that is down, and the same press seen twice — the shortcut and the hook — is the pen's both times. */
  takeEscape() {
    const now = Date.now();
    if (this.session?.pen) {
      this.lastEscapeAt = now;
      this.setPen(false);
      return true;
    }
    return now - this.lastEscapeAt < 400;
  }

  // --- strokes ------------------------------------------------------------------------

  /**
   * A stroke began on an overlay: part of the burst still open on that
   * display, or the first of a new one — whose still is taken now, before a
   * point of ink is on the picture, with the window under the pen and
   * whether a password field has the keyboard.
   */
  begin(sender, raw) {
    const session = this.session;
    const at = this.overlayOf(sender);
    const p = pointOf(raw?.point);
    const t = Number(raw?.t);
    if (!session || !at || !p || !Number.isFinite(t) || !session.pen || session.ending) return;
    const now = t - session.at;
    let burst = session.open;
    if (burst && (burst.display !== at.display.id || now - burst.t1 > BURST_GAP_MS)) {
      this.closeBurst();
      burst = null;
    }
    if (!burst) {
      if (session.bursts.length >= MARKS_MAX) {
        at.win.webContents.send("ink:full", MARKS_MAX);
        return;
      }
      const display = at.display;
      const id = `${session.id}-${session.bursts.length + 1}`;
      const global = { x: display.bounds.x + p[0], y: display.bounds.y + p[1] };
      const exclude = this.ours();
      burst = {
        n: session.bursts.length + 1,
        id,
        display: display.id,
        size: { width: display.bounds.width, height: display.bounds.height, scale: display.scaleFactor },
        t0: Math.max(0, now),
        t1: Math.max(0, now),
        strokes: [],
        closer: null,
        done: null,
      };
      // In order, one after another, in the helper: whether the screen may be
      // taken, then the still, then what was under the pen.
      burst.secure = this.ask({ op: "secure" }).then((a) => a.secure === true);
      burst.shot = burst.secure.then((secure) => (secure ? { ok: false, error: "secure" } : this.ask({ op: "shot", id, display: display.id, bounds: display.bounds, exclude })));
      burst.under = this.ask({ op: "under", x: global.x, y: global.y, exclude }).then((a) => (a && typeof a.app === "string" ? a : null));
      session.bursts.push(burst);
      session.open = burst;
      this.changed();
    }
    clearTimeout(burst.closer);
    burst.closer = null;
    burst.strokes.push([p]);
    burst.t1 = Math.max(burst.t1, now);
  }

  points(sender, raw) {
    const burst = this.session?.open;
    if (!burst || !this.overlayOf(sender) || !Array.isArray(raw)) return;
    const stroke = burst.strokes[burst.strokes.length - 1];
    if (!stroke || stroke.length > 20_000) return;
    for (const value of raw.slice(0, 2000)) {
      const p = pointOf(value);
      if (p) stroke.push(p);
    }
  }

  /** The pen lifted: the burst stays open for `BURST_GAP_MS`, for an arrow's head or a second circle. */
  lift(sender, raw) {
    const session = this.session;
    const burst = session?.open;
    const t = Number(raw?.t);
    if (!session || !burst || !this.overlayOf(sender)) return;
    if (Number.isFinite(t)) burst.t1 = Math.max(burst.t1, t - session.at);
    clearTimeout(burst.closer);
    burst.closer = setTimeout(() => this.closeBurst(), BURST_GAP_MS);
  }

  /**
   * The open burst is over: its still is inked and written by the helper,
   * as the crop and the whole display. `done` settles once the files are
   * there, or are not going to be.
   */
  closeBurst() {
    const session = this.session;
    const burst = session?.open;
    if (!session || !burst) return;
    session.open = null;
    clearTimeout(burst.closer);
    burst.closer = null;
    const box = strokesBox(burst.strokes);
    burst.box = box;
    const crop = path.join(session.dir, `mark-${burst.n}.png`);
    const frame = path.join(session.dir, `frame-${burst.n}.jpg`);
    burst.done = burst.shot.then(async (shot) => {
      if (!shot || shot.ok !== true) return { crop: null, frame: null };
      const answer = await this.ask({
        op: "ink",
        id: burst.id,
        strokes: burst.strokes,
        crop: { path: crop, rect: cropRect(box, burst.size) },
        frame: { path: frame, long: FRAME_LONG_EDGE },
      });
      return { crop: answer.crop ? crop : null, frame: answer.frame ? frame : null };
    });
    this.changed();
  }

  // --- the end ------------------------------------------------------------------------

  /** Done or the pill's Send: the owner is told to send, and asks for the bundle. One that never asks is not waited on for ever. */
  send(from) {
    const session = this.session;
    if (!session || session.ending) return;
    if (from && from.id !== session.owner.id && !this.overlayOf(from) && !this.isOurs(from)) return;
    this.closeBurst();
    this.tellOwner(session.owner, { ev: "send", id: session.id, voice: session.voice });
    clearTimeout(session.sendTimer);
    session.sendTimer = setTimeout(() => {
      if (this.session === session) this.cancel(session.id, "the page did not take the marks");
    }, SEND_ANSWER_MS);
  }

  /** ✕ on the overlay: gone at once, and the owner told to drop its clip with it. */
  drop(from) {
    const session = this.session;
    if (!session) return;
    if (from && from.id !== session.owner.id && !this.overlayOf(from) && !this.isOurs(from)) return;
    this.tellOwner(session.owner, { ev: "cancel", id: session.id, voice: session.voice });
    this.cancel(session.id, null);
  }

  /** The main window or the pill: the pages of ours that may press the pen's buttons. */
  isOurs(sender) {
    const main = this.mainWindow();
    const pill = this.pill();
    return Boolean((main && !main.isDestroyed() && main.id === sender.id) || (pill && !pill.isDestroyed() && pill.webContents.id === sender.id));
  }

  /**
   * The owner asks for the bundle: every burst closed and inked, the
   * pictures read in, the overlays gone and the folder removed. Null when
   * there was no ink — a clip with no marks is an ordinary clip.
   */
  async finish(sender, id) {
    const session = this.session;
    if (!session || session.id !== id || sender.id !== session.owner.id || session.ending) return null;
    session.ending = true;
    clearTimeout(session.sendTimer);
    this.closeBurst();
    this.takeDown();
    this.changed();
    const displays = new Map();
    const marks = [];
    for (const burst of session.bursts) {
      const [files, under, secure] = await Promise.all([burst.done ?? Promise.resolve({ crop: null, frame: null }), burst.under, burst.secure]);
      displays.set(burst.display, { id: burst.display, ...burst.size });
      const read = (file) => {
        try {
          return file ? readFileSync(file).toString("base64") : "";
        } catch {
          return "";
        }
      };
      marks.push({ display: burst.display, t0: burst.t0, t1: burst.t1, box: burst.box ?? strokesBox(burst.strokes), strokes: burst.strokes, under, secure, crop: read(files.crop), frame: read(files.frame) });
    }
    this.end(session);
    if (!marks.length) return null;
    return { kind: "screen", at: session.at, audioAt: null, displays: [...displays.values()], marks };
  }

  /** Let a session go with nothing kept: its stills dropped, its overlays and folder gone. `why` goes to the owner when there is one to say. */
  cancel(id, why) {
    const session = this.session;
    if (!session || (id && session.id !== id)) return;
    for (const burst of session.bursts) void this.ask({ op: "drop", id: burst.id });
    if (why) this.tellOwner(session.owner, { ev: "cancel", id: session.id, voice: session.voice, why });
    this.takeDown();
    this.end(session);
  }

  /** The overlays down and the keys given back — first, before anything that might wait. */
  takeDown() {
    const session = this.session;
    if (!session) return;
    for (const burst of session.bursts) clearTimeout(burst.closer);
    for (const win of session.overlays.values()) if (!win.isDestroyed()) win.destroy();
    session.overlays.clear();
    this.registerEscape(false);
    this.raisePill(false);
  }

  end(session) {
    clearTimeout(session.sendTimer);
    session.watch?.();
    try {
      rmSync(session.dir, { recursive: true, force: true });
    } catch {
      // A temporary folder the system empties anyway.
    }
    if (this.session === session) this.session = null;
    this.changed();
  }

  /** The pointer is over the toolbar while the pen is up: that overlay takes the mouse until it leaves. */
  hoverBar(sender, on) {
    const session = this.session;
    const at = this.overlayOf(sender);
    if (!session || !at) return;
    if (on) session.hoveringBar.add(sender.id);
    else session.hoveringBar.delete(sender.id);
    at.win.setIgnoreMouseEvents(!session.pen && !on, { forward: true });
  }

  /** A display came, went or changed shape: the overlays are made again for what there is now. The ink on them was fading anyway. */
  watchDisplays() {
    if (this.watchingDisplays) return;
    this.watchingDisplays = true;
    const again = () => {
      if (!this.session || this.session.ending) return;
      this.closeBurst();
      this.makeOverlays();
    };
    screen.on("display-added", again);
    screen.on("display-removed", again);
    screen.on("display-metrics-changed", again);
  }

  dispose() {
    if (this.session) this.cancel(this.session.id, null);
    if (this.registered) globalShortcut.unregister(SHORTCUT);
    this.registered = false;
    this.stopHelper();
  }
}

module.exports = { Ink, SHORTCUT };
