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
 *
 * **Phase 2 made it pleasant** (docs/plans/screen-annotate.md): two pens
 * and a highlighter, each stroke keeping what it was drawn with; ⌘Z while the
 * pen is down takes the last mark back, picture and all; a snapshot key
 * (⌃⌥⌘S, while a session is on) takes the display under the pointer as a
 * mark with no ink; applications on the never-capture list are left out of
 * every still and their titles unread; a mark on kururu's own window asks
 * the page under it what is there (`whatAt`); and a recording that rolls at
 * five minutes takes the marks so far with its clip and keeps the pen.
 *
 * **The tools are where the pill is** (2026-11-06, asked for by the user):
 * the toolbar that sat at the top of the session's first display could not
 * be moved, and the pill — which can — had a pen and Send and nothing else.
 * So a session the floating pill owns has every tool in the pill, and any
 * other — the drawer's pencil, or a recording in the window while the talk
 * key is not hooked — gets the toolbar as a small window of its own
 * (`inkbar.html`), dragged where it is wanted and put back there next time.
 * Not the pill shown for it: the pill's page is the one voice client on
 * this Mac while it exists, and a pill made for a pen would be a second
 * microphone and a second mouth. A window of its own over the overlays
 * also needs none of the overlay's forwarding to take a click with the pen
 * up, which the toolbar inside an overlay did.
 *
 * **What a mark was drawn on is asked at the ink, not where it began.** A
 * line drawn down onto a button starts on whatever is above the button —
 * the desktop, once, which is a mark on nothing — so the window under the
 * ink's centre is asked for when the burst closes, then under where the pen
 * last lifted, and only then the one under the first pen-down.
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
/** The snapshot key: the display under the pointer, now, as a mark. Only while a session is on. */
const SNAP_SHORTCUT = "Control+Alt+Command+S";
/** Undo, taken system-wide only while the pen is down, as Escape is. */
const UNDO_SHORTCUT = "Command+Z";
/** How long the page under a mark has to say what is there before the mark goes without it. */
const WHAT_AT_MS = 1500;
/** The pens and the highlighter, as `shared/ink.ts` spells them. */
const TOOLS = ["pen", "highlighter"];
const COLORS = ["red", "blue", "yellow"];
/**
 * Applications whose windows never go into a still, until Settings → Voice
 * says otherwise: password managers, the keychain, and messages.
 */
const DENY_DEFAULT = ["com.1password.1password", "com.agilebits.onepassword7", "com.apple.keychainaccess", "com.apple.Passwords", "com.bitwarden.desktop", "com.apple.MobileSMS"];
/** How long an owner told to send has to ask for the bundle before the overlays are taken down anyway. */
const SEND_ANSWER_MS = 15_000;
/** Where the toolbar goes when it has never been dragged: this far below the top of the display's work area. */
const BAR_TOP = 12;
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
   * @param {string} [options.barPath]  `inkbar.html`, the toolbar for a session the floating pill does not own
   * @param {() => import("electron").WebContents | null} options.voiceClient  the page that holds the microphone now
   * @param {() => import("electron").WebContents | null} options.mainWindow  the main window's page, whose box a session with no voice fills
   * @param {() => import("electron").BrowserWindow | null} options.pill  the floating pill's panel, kept over the ink and out of the pictures
   * @param {() => string[]} [options.denyList]  bundle ids whose windows are left out of every still
   * @param {((global: {x: number, y: number}, under: any) => Promise<any>) | null} [options.whatAt]  what kururu's own window says is at a point, or null
   * @param {() => boolean} [options.withVoice]  whether every recording starts with the pen down (Settings → Voice → Screen pen)
   * @param {() => any} [options.barAt]  where the toolbar was last dragged to, `{x, y}`, or nothing
   * @param {(at: {x: number, y: number}) => void} [options.saveBarAt]
   * @param {boolean} options.debug
   */
  constructor({ helperPath, pagePath, preloadPath, barPath = "", voiceClient, mainWindow, pill, denyList = () => DENY_DEFAULT, whatAt = null, withVoice = () => true, barAt = () => null, saveBarAt = () => {}, debug = false }) {
    super();
    this.helperPath = helperPath;
    this.pagePath = pagePath;
    this.preloadPath = preloadPath;
    this.barPath = barPath;
    this.withVoice = withVoice;
    this.barAt = barAt;
    this.saveBarAt = saveBarAt;
    this.voiceClient = voiceClient;
    this.mainWindow = mainWindow;
    this.pill = pill;
    this.denyList = denyList;
    this.whatAt = whatAt;
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
    /** When this file last moved the toolbar itself, so its own move is not taken for a drag. */
    this.barPlacedAt = 0;
    this.barMoveTimer = null;
  }

  // --- what the pages are told ----------------------------------------------------

  /**
   * The session as every page draws it. `tools` says where its buttons are
   * — the floating pill's, or the toolbar's window — and `withVoice` is the
   * setting, there whether a session is on or not.
   */
  state() {
    const s = this.session;
    const withVoice = this.withVoiceNow();
    return s
      ? { on: true, id: s.id, voice: s.voice, pen: s.pen, marks: s.bursts.length, ending: s.ending, tool: s.tool, color: s.color, held: s.held !== null, tools: s.inPill ? "pill" : "bar", withVoice }
      : { on: false, id: null, voice: false, pen: false, marks: 0, ending: false, tool: "pen", color: "red", held: false, tools: "bar", withVoice };
  }

  withVoiceNow() {
    try {
      return this.withVoice() !== false;
    } catch {
      return true;
    }
  }

  /** The windows of the pen itself — every overlay and the toolbar — which hear the state on their own channel. */
  penWindows() {
    const s = this.session;
    if (!s) return [];
    const out = [...s.overlays.values()];
    if (s.bar) out.push(s.bar);
    return out.filter((w) => !w.isDestroyed());
  }

  /** The owner, every overlay, the toolbar and every other window hear what the session is now: the drawer's pencil and the pill's tools draw from it. */
  changed() {
    const state = this.state();
    const pen = this.penWindows();
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      if (pen.includes(win)) win.webContents.send("ink:state", state);
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
        watch: null,
        tool: "pen",
        color: "red",
        /** Every burst ever begun in the session, for ids no undo or roll reuses. */
        made: 0,
        /** The pen as it was before hold-to-draw put it down, while the key is held; null otherwise. */
        held: null,
        /** The tools are in the floating pill, which owns the session; otherwise in `bar`. */
        inPill: this.pillOwns(voice, owner),
        /** @type {import("electron").BrowserWindow | null} */
        bar: null,
      };
      this.watchOwner(owner);
      this.watchDisplays();
      this.makeOverlays();
      if (!this.session.inPill) this.makeBar();
      this.raisePill(true);
      this.registerEscape(true);
      this.registerSnap(true);
      this.tellOwner(owner, { ev: "start", id: this.session.id, voice });
      this.changed();
      return this.state();
    } finally {
      this.starting = false;
    }
  }

  /** Whether the floating pill's page owns a session, and so draws its tools: a recording while the pill is the voice client. */
  pillOwns(voice, owner) {
    const pill = this.pill();
    return voice && Boolean(pill && !pill.isDestroyed() && pill.webContents.id === owner.id);
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
      win.setIgnoreMouseEvents(!session.pen);
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
        this.raiseBar();
        this.raisePill(true);
      });
      void win.loadFile(this.pagePath, { query: { display: String(display.id) } });
      session.overlays.set(display.id, win);
    }
  }

  /**
   * The toolbar, for a session whose tools are not in the pill: a small
   * panel of its own over the overlays, never focused, dragged by its own
   * background, shown once its page has said how big it is — and put where
   * it was last dragged to, or at the top of the display the session began
   * on. Its renderer going is not the session's end, as an overlay's is:
   * the keys, the pill and the drawer still end it, and nothing of the bar
   * can hold the mouse.
   */
  makeBar() {
    const session = this.session;
    if (!session || !this.barPath) return;
    const bar = new BrowserWindow({
      width: 520,
      height: 48,
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
      focusable: false,
      acceptFirstMouse: true,
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
    bar.setAlwaysOnTop(true, "screen-saver");
    bar.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    bar.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    bar.webContents.on("will-navigate", (event) => event.preventDefault());
    if (this.debug) bar.webContents.on("console-message", (event, ...legacy) => console.log(`kururu ink bar: ${event?.message ?? legacy[1]}`));
    bar.webContents.once("did-finish-load", () => {
      if (this.session === session && !bar.isDestroyed()) bar.webContents.send("ink:state", this.state());
    });
    bar.on("moved", () => {
      // Only a drag is remembered: this file's own placing moves it too, and
      // macOS may say so a moment after the call that did it.
      if (Date.now() - this.barPlacedAt < 500 || bar.isDestroyed()) return;
      clearTimeout(this.barMoveTimer);
      this.barMoveTimer = setTimeout(() => {
        if (bar.isDestroyed()) return;
        const [x, y] = /** @type {[number, number]} */ (bar.getPosition());
        this.saveBarAt({ x, y });
      }, 300);
    });
    session.bar = bar;
    session.barShown = false;
    void bar.loadFile(this.barPath, { query: { voice: session.voice ? "1" : "0" } });
  }

  /** The toolbar's page measured itself: the window is that size, and shown where it belongs the first time. */
  barSize(sender, raw) {
    const session = this.session;
    const bar = session?.bar;
    if (!bar || bar.isDestroyed() || sender.id !== bar.webContents.id) return;
    const width = Math.ceil(Number(raw?.width));
    const height = Math.ceil(Number(raw?.height));
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 40 || height < 20 || width > 1600 || height > 400) return;
    this.barPlacedAt = Date.now();
    bar.setSize(width, height);
    if (!session.barShown) {
      this.placeBar(session);
      session.barShown = true;
      bar.showInactive();
      this.raiseBar();
    }
  }

  /**
   * Where the toolbar was last dragged to, while that is still wholly on a
   * display — a display unplugged since is not a place — or the top middle
   * of the display the session began on.
   */
  placeBar(session) {
    const bar = session.bar;
    if (!bar || bar.isDestroyed()) return;
    this.barPlacedAt = Date.now();
    const [width, height] = /** @type {[number, number]} */ (bar.getSize());
    let saved = null;
    try {
      saved = this.barAt();
    } catch {
      saved = null;
    }
    const x = Number(saved?.x);
    const y = Number(saved?.y);
    const fits =
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      screen.getAllDisplays().some((d) => x >= d.workArea.x && y >= d.workArea.y && x + width <= d.workArea.x + d.workArea.width && y + height <= d.workArea.y + d.workArea.height);
    if (fits) {
      bar.setPosition(Math.round(x), Math.round(y));
      return;
    }
    const display = screen.getAllDisplays().find((d) => d.id === session.home) ?? screen.getPrimaryDisplay();
    const area = display.workArea;
    bar.setPosition(Math.round(area.x + (area.width - width) / 2), Math.round(area.y + BAR_TOP));
  }

  /** The toolbar over the overlays, at their level: made after them, and raised again whenever one is shown. */
  raiseBar() {
    const bar = this.session?.bar;
    if (bar && !bar.isDestroyed() && this.session.barShown) bar.moveTop();
  }

  /** Whether a page message came from the toolbar of the session that is on. */
  isBar(sender) {
    const bar = this.session?.bar;
    return Boolean(bar && !bar.isDestroyed() && bar.webContents.id === sender.id);
  }

  /** A press on the pen's own buttons, from the toolbar or an overlay: `pen`, `done`, `drop`, `undo` or `snap`. */
  press(sender, what) {
    if (!this.session || (!this.isBar(sender) && !this.overlayOf(sender))) return;
    if (what === "pen") this.setPen(!this.session.pen);
    else if (what === "done") this.send(sender);
    else if (what === "drop") this.drop(sender);
    else if (what === "undo") this.undo();
    else if (what === "snap") this.snap();
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

  /** The windows a still leaves out: every overlay, the toolbar, and the pill. */
  ours() {
    const out = [];
    for (const win of this.penWindows()) {
      const n = windowNumber(win);
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
    // Pressed by hand while a hold has it: the hand wins, and the release leaves it be.
    session.held = null;
    this.penTo(on === true);
  }

  penTo(on) {
    const session = this.session;
    if (!session || session.ending) return;
    session.pen = on;
    for (const win of session.overlays.values()) {
      if (!win.isDestroyed()) win.setIgnoreMouseEvents(!session.pen);
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
      if (!globalShortcut.isRegistered(UNDO_SHORTCUT)) globalShortcut.register(UNDO_SHORTCUT, () => this.undo());
    } else {
      if (globalShortcut.isRegistered("Escape")) globalShortcut.unregister("Escape");
      if (globalShortcut.isRegistered(UNDO_SHORTCUT)) globalShortcut.unregister(UNDO_SHORTCUT);
    }
  }

  /** ⌃⌥⌘S for the life of a session, pen up or down: "and now look at this" needs no ink. */
  registerSnap(on) {
    if (on) {
      if (!globalShortcut.isRegistered(SNAP_SHORTCUT)) globalShortcut.register(SNAP_SHORTCUT, () => this.snap());
    } else if (globalShortcut.isRegistered(SNAP_SHORTCUT)) globalShortcut.unregister(SNAP_SHORTCUT);
  }

  /**
   * Hold-to-draw: the talk-key hook's second key held puts the pen down,
   * and letting go puts it back as it was. Only in a session — the key is
   * a modifier, and outside one it is the apps'.
   */
  hold(down) {
    const session = this.session;
    if (!session || session.ending) return;
    if (down) {
      if (session.held !== null) return;
      const was = session.pen;
      this.penTo(true);
      session.held = was;
    } else if (session.held !== null) {
      const was = session.held;
      session.held = null;
      this.penTo(was);
    }
  }

  /** The pen's colour or the highlighter, from the toolbar: what the next stroke is drawn with. */
  setStyle(raw) {
    const session = this.session;
    if (!session || session.ending || !raw || typeof raw !== "object") return;
    if (TOOLS.includes(raw.tool)) session.tool = raw.tool;
    if (COLORS.includes(raw.color) && raw.color !== "yellow") session.color = raw.color;
    this.changed();
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
      burst = this.newBurst(at.display, { x: at.display.bounds.x + p[0], y: at.display.bounds.y + p[1] }, now, false);
      session.open = burst;
      this.changed();
    }
    clearTimeout(burst.closer);
    burst.closer = null;
    burst.strokes.push([p]);
    burst.styles.push(session.tool === "highlighter" ? { tool: "highlighter", color: "yellow" } : { tool: "pen", color: session.color });
    burst.t1 = Math.max(burst.t1, now);
  }

  /**
   * A burst begun: its still asked for now, before any ink is on it, with
   * what was under the pen and whether a password field has the keyboard —
   * in that order, in the helper. Its id is the session's count of bursts
   * ever made, so an undone or rolled one's is never reused.
   */
  newBurst(display, global, now, snap) {
    const session = this.session;
    const id = `${session.id}-${++session.made}`;
    const exclude = this.ours();
    const deny = this.deny();
    const burst = {
      n: session.bursts.length + 1,
      id,
      display: display.id,
      size: { width: display.bounds.width, height: display.bounds.height, scale: display.scaleFactor },
      bounds: display.bounds,
      t0: Math.max(0, now),
      t1: Math.max(0, now),
      strokes: [],
      styles: [],
      snap,
      closer: null,
      done: null,
      facts: null,
      undone: false,
      /** Where the burst began, on the whole desktop, and what the helper is told to leave out — for asking again at the ink. */
      start: global,
      exclude,
      deny,
    };
    burst.secure = this.ask({ op: "secure" }).then((a) => a.secure === true);
    burst.shot = burst.secure.then((secure) => (secure ? { ok: false, error: "secure" } : this.ask({ op: "shot", id, display: display.id, bounds: display.bounds, exclude, deny })));
    burst.under = this.ask({ op: "under", x: global.x, y: global.y, exclude, deny }).then((a) => (a && typeof a.app === "string" ? a : null));
    session.bursts.push(burst);
    return burst;
  }

  deny() {
    try {
      const list = this.denyList();
      return Array.isArray(list) ? list.filter((b) => typeof b === "string" && b).slice(0, 200) : [];
    } catch {
      return [];
    }
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
    this.inkBurst(burst);
    this.changed();
  }

  /**
   * A burst over: its still inked by the helper and written as the crop and
   * the whole display — a snapshot as the display alone — under names of
   * its own id, so an undone burst's files are never another's. `done`
   * settles once the files are there, or are not going to be. And the
   * page under it, when that is kururu's, asked what is there.
   */
  inkBurst(burst) {
    const session = this.session;
    const box = burst.snap ? { x: 0, y: 0, width: burst.size.width, height: burst.size.height } : strokesBox(burst.strokes);
    burst.box = box;
    const crop = path.join(session.dir, `${burst.id}-crop.png`);
    const frame = path.join(session.dir, `${burst.id}-frame.jpg`);
    burst.files = [crop, frame];
    burst.done = burst.shot.then(async (shot) => {
      if (!shot || shot.ok !== true || burst.undone) return { crop: null, frame: null };
      const answer = await this.ask({
        op: "ink",
        id: burst.id,
        strokes: burst.strokes,
        styles: burst.styles,
        ...(burst.snap ? {} : { crop: { path: crop, rect: cropRect(box, burst.size) } }),
        frame: { path: frame, long: FRAME_LONG_EDGE },
      });
      return { crop: answer.crop ? crop : null, frame: answer.frame ? frame : null };
    });
    burst.where = burst.snap ? burst.under.then((under) => ({ under, at: burst.at })) : this.underInk(burst, box);
    burst.facts = this.whatAt ? burst.where.then(({ under, at }) => this.factsAt(at, under)) : Promise.resolve(null);
  }

  /**
   * The window the ink was drawn on, and the point it was found at: under
   * the ink's centre, else where the pen last lifted, else where it first
   * went down — the first that has a window. A circle's middle is what it
   * circles; a line drawn down onto a button ends on the button and may
   * begin on the desktop, which is no window at all.
   */
  async underInk(burst, box) {
    const { x, y } = burst.bounds;
    const last = burst.strokes[burst.strokes.length - 1];
    const end = last?.[last.length - 1];
    const points = [{ x: x + box.x + box.width / 2, y: y + box.y + box.height / 2 }];
    if (end) points.push({ x: x + end[0], y: y + end[1] });
    for (const at of points) {
      const answer = await this.ask({ op: "under", x: at.x, y: at.y, exclude: burst.exclude, deny: burst.deny });
      if (answer && typeof answer.app === "string" && answer.app) return { under: answer, at };
    }
    return { under: await burst.under, at: burst.start };
  }

  /**
   * What kururu's page under a point says is there, or nothing — never later
   * than `WHAT_AT_MS`. Asked even when the helper found no window, since the
   * pill is left out of what the helper sees and may be what was circled.
   */
  factsAt(global, under) {
    const ask = this.whatAt;
    if (!ask) return Promise.resolve(null);
    let timer;
    return Promise.race([
      Promise.resolve()
        .then(() => ask(global, under))
        .catch(() => null),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), WHAT_AT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  /**
   * ⌘Z, or the toolbar's Undo: the last mark taken back — its still let go,
   * its pictures removed once written, its ink off the overlay. Marks before
   * it keep their numbers.
   */
  undo() {
    const session = this.session;
    if (!session || session.ending || !session.bursts.length) return;
    const burst = session.bursts.pop();
    burst.undone = true;
    if (session.open === burst) {
      session.open = null;
      clearTimeout(burst.closer);
      burst.closer = null;
    }
    void this.ask({ op: "drop", id: burst.id });
    void Promise.resolve(burst.done).finally(() => {
      for (const file of burst.files ?? []) rmSync(file, { force: true });
    });
    const overlay = session.overlays.get(burst.display);
    if (overlay && !overlay.isDestroyed() && !burst.snap) overlay.webContents.send("ink:undo");
    this.changed();
  }

  /**
   * ⌃⌥⌘S, or the toolbar's Snap: the display under the pointer as it is
   * now, with no ink — "and now look at this" — as a mark at this moment in
   * the words. The pen's state is not touched.
   */
  snap() {
    const session = this.session;
    if (!session || session.ending) return;
    this.closeBurst();
    let display;
    let point;
    try {
      point = screen.getCursorScreenPoint();
      display = screen.getDisplayNearestPoint(point);
    } catch {
      display = screen.getPrimaryDisplay();
      point = { x: display.bounds.x + display.bounds.width / 2, y: display.bounds.y + display.bounds.height / 2 };
    }
    const overlay = session.overlays.get(display.id);
    if (session.bursts.length >= MARKS_MAX) {
      if (overlay && !overlay.isDestroyed()) overlay.webContents.send("ink:full", MARKS_MAX);
      return;
    }
    const burst = this.newBurst(display, point, Date.now() - session.at, true);
    burst.at = point;
    this.inkBurst(burst);
    if (overlay && !overlay.isDestroyed()) overlay.webContents.send("ink:flash");
    this.changed();
  }

  // --- the end ------------------------------------------------------------------------

  /** Done or the pill's Send: the owner is told to send, and asks for the bundle. One that never asks is not waited on for ever. */
  send(from) {
    const session = this.session;
    if (!session || session.ending) return;
    if (from && from.id !== session.owner.id && !this.overlayOf(from) && !this.isBar(from) && !this.isOurs(from)) return;
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
    if (from && from.id !== session.owner.id && !this.overlayOf(from) && !this.isBar(from) && !this.isOurs(from)) return;
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
  async finish(sender, id, roll = false) {
    const session = this.session;
    if (!session || session.id !== id || sender.id !== session.owner.id || session.ending) return null;
    if (roll === true) return this.roll(session);
    session.ending = true;
    clearTimeout(session.sendTimer);
    this.closeBurst();
    this.takeDown();
    this.changed();
    const bundle = await this.bundle(session, session.bursts);
    this.end(session);
    return bundle;
  }

  /**
   * The recording rolled at five minutes: the marks so far go with the clip
   * that ends, as a set of their own, and the session carries on — the pen,
   * the overlays, the ink still fading — numbering the next clip's from one.
   */
  async roll(session) {
    this.closeBurst();
    const bursts = session.bursts.splice(0);
    this.changed();
    const bundle = await this.bundle(session, bursts);
    for (const burst of bursts) for (const file of burst.files ?? []) rmSync(file, { force: true });
    return bundle;
  }

  /** Some bursts as the set the owner posts: each closed, inked and read in. Null for none. */
  async bundle(session, bursts) {
    const displays = new Map();
    const marks = [];
    for (const burst of bursts) {
      const [files, where, secure, facts] = await Promise.all([
        burst.done ?? Promise.resolve({ crop: null, frame: null }),
        burst.where ?? burst.under.then((under) => ({ under })),
        burst.secure,
        burst.facts ?? Promise.resolve(null),
      ]);
      const under = where.under;
      displays.set(burst.display, { id: burst.display, ...burst.size });
      const read = (file) => {
        try {
          return file ? readFileSync(file).toString("base64") : "";
        } catch {
          return "";
        }
      };
      marks.push({
        display: burst.display,
        t0: burst.t0,
        t1: burst.t1,
        box: burst.box ?? strokesBox(burst.strokes),
        strokes: burst.strokes,
        styles: burst.styles,
        snap: burst.snap === true,
        under,
        secure,
        kururu: facts && typeof facts.kururu === "object" ? facts.kururu : null,
        page: facts && typeof facts.page === "object" ? facts.page : null,
        crop: read(files.crop),
        frame: read(files.frame),
      });
    }
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
    clearTimeout(this.barMoveTimer);
    if (session.bar && !session.bar.isDestroyed()) session.bar.destroy();
    session.bar = null;
    this.registerEscape(false);
    this.registerSnap(false);
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

  /** A display came, went or changed shape: the overlays are made again for what there is now. The ink on them was fading anyway. */
  watchDisplays() {
    if (this.watchingDisplays) return;
    this.watchingDisplays = true;
    const again = () => {
      if (!this.session || this.session.ending) return;
      this.closeBurst();
      this.makeOverlays();
      // The toolbar is a window of its own, which macOS moves off a display that left; where it lands is put right.
      if (this.session.bar && this.session.barShown) this.placeBar(this.session);
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

module.exports = { Ink, SHORTCUT, SNAP_SHORTCUT, DENY_DEFAULT };
