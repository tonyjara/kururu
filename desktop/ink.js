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
 * first: the talk key, the pill's Send or Done.
 *
 * **The overlays are on the screen only while a session is**, one per
 * display, and every way out takes them off it: Done, ✕, the shortcut, the
 * owner's own end, the owner's page going away (the watchdog), an overlay's
 * renderer dying, and a send the owner never answers. A stuck one is a Mac
 * where nothing can be clicked. They are made once, though, and kept hidden
 * between sessions (`warm`, `kept`): hidden is ordered out, which the window
 * server composites nothing for and the mouse never reaches, and each way
 * out lets the mouse through before it hides one. They used to be made at
 * every press and closed at every end, and a press then waited for a new
 * window and a new renderer to load before a stroke could land — 90 to
 * 270 ms in a quiet test at load 60 to 90, and seconds on a Mac with its
 * memory pushed out to swap (the owner, 2026-11-19: "whenever I hit the pen,
 * there's like a several seconds delay before I can draw sometimes"). The
 * price is one sleeping renderer per display for the life of the app, about
 * 90 MB. A display coming, going or changing shape makes them again.
 *
 * **Screen Recording is asked once, not at every press.** The helper answers
 * one request at a time, in order, and the marks a session just sent are
 * inked there after it ends; a press soon after Send waited behind those
 * pictures for the helper to say what it had said every time before — 1.8 s
 * behind four marks at load 80. So a "granted" is kept (from the helper's
 * first line, and from every answer), a press with it puts the pen down at
 * once, and the helper is asked again behind the work: a "denied" then ends
 * the pen, not the recording, with the same refusal as before. Only a press
 * with no answer kept waits for one. Every start writes how long the pen took
 * to be drawable to `pen.log`, and any answer from the helper slower than a
 * second is written there too, with how many were ahead of it.
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
 * **The tools are in the pill, and only there** (2026-11-06, asked for by
 * the user): one set, always in the same spot. A session the floating pill
 * owns — a recording while the talk key is hooked — draws them beside the
 * meter. Any other — the drawer's pencil, or a recording in the window —
 * has the pill shown in a draw-only form, with the pen's tools and none of
 * the voice (`penPanel`, which is `TalkKey.forPen`): the same panel at the
 * same place when the talk key or ⌥Space keeps one, else a panel made for
 * the session alone, loading the pill page with `draw` — which installs no
 * microphone and no speech, since the pill's page is the one voice client
 * on this Mac while it exists and a second would be a second mouth. KUR-245
 * gave those sessions a toolbar window of their own instead, which put a
 * second set of tools on the screen beside the pill's; it is gone.
 *
 * **The pill is a level above the ink** while a session is on (screen-saver
 * and one), not merely raised within the overlays' level: the first press
 * of the pill's Undo, on 2026-11-06, landed on the overlay under it and drew
 * a dot, so a press on the pill must never depend on which of two windows
 * at one level was ordered last.
 *
 * **What a mark was drawn on is asked at the ink, not where it began.** A
 * line drawn down onto a button starts on whatever is above the button —
 * the desktop, once, which is a mark on nothing — so the window under the
 * ink's centre is asked for when the burst closes, then under where the pen
 * last lifted, and only then the one under the first pen-down.
 *
 * **The Kuru box's pencil, pressed again, is Done** (2026-11-13, asked for
 * by the owner: "if I press on the pen again, then it's like if I press
 * done"). With the pen down the overlay is over the box too, so the press
 * lands on the ink and never reaches the button. Each page with a box says
 * where its pencil is while a session without a voice is on (`pencil`),
 * and a pen-down there sends the session instead of starting a mark. Only
 * a window that is in front for it counts (`pencilFront`): the floating
 * chat while it is up, the window while it has the keyboard — a pencil
 * behind another application's window is not there to be pressed, and a
 * mark begun over that spot must stay a mark.
 */
const { BrowserWindow, globalShortcut, screen, shell } = require("electron");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createInterface } = require("node:readline");
const { stateDir } = require("./runner");
const { neverActivates, staysUp } = require("./stays");
const { BURST_GAP_MS, FRAME_LONG_EDGE, MARKS_MAX, cropRect, pencilHit, pointOf, rectOf, strokesBox, windowNumberOf } = require("./inkshape");

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
/** How long the helper has to answer one request. A still is tens of milliseconds; a 5K one inked, a few hundred. */
const HELPER_ANSWER_MS = 8_000;
/** Where macOS keeps the switch the helper needs. */
const SCREEN_RECORDING = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
/** What a press says when Screen Recording is off, whether the helper said so before the pen went down or after. */
const NO_SCREEN_RECORDING = "Kururu may not take pictures of the screen yet. Turn it on in System Settings → Privacy & Security → Screen Recording, then press the pen again.";
/** An answer from the helper slower than this is written to `pen.log`, with how many were ahead of it. */
const SLOW_HELPER_MS = 1000;
/** How long the displays get to settle after a change before the kept overlays are made again for them. */
const DISPLAY_SETTLE_MS = 800;
/** How long an ended session's overlays stay ordered in, transparent and letting the mouse through, for their pages to paint blank. */
const HIDE_AFTER_MS = 100;
/** `pen.log` is moved aside at this size, as `pill.log` is. */
const LOG_MAX_BYTES = 256 * 1024;

/**
 * One line of `pen.log`: how long each press took to put a pen on the
 * screen, and the helper when it was slow. "There's a delay sometimes" is
 * a thing nobody can see after it has passed; this is where it is kept.
 */
function penLog(what, fields = {}) {
  try {
    const file = path.join(stateDir(), "pen.log");
    mkdirSync(path.dirname(file), { recursive: true });
    if (existsSync(file) && statSync(file).size > LOG_MAX_BYTES) renameSync(file, `${file}.1`);
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), what, ...fields })}\n`);
  } catch {
    // The log is for afterwards; it is not a reason to fail now.
  }
}

/** The 1-minute load average, for the log: a slow press on a busy Mac reads differently from one on a quiet Mac. */
const loadNow = () => Math.round(os.loadavg()[0] ?? 0);

/** Milliseconds, rounded to one place, for the log. */
const ms = (since) => Math.round((performance.now() - since) * 10) / 10;

/** Whether a kept overlay was made for a display as it is now. */
function sameBounds(a, b) {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

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
   * @param {() => string[]} [options.denyList]  bundle ids whose windows are left out of every still
   * @param {((global: {x: number, y: number}, under: any) => Promise<any>) | null} [options.whatAt]  what kururu's own window says is at a point, or null
   * @param {() => boolean} [options.withVoice]  whether every recording starts with the pen down (Settings → Voice → Screen pen)
   * @param {(on: boolean) => void} [options.penPanel]  the pill shown for a session whose tools are not already in it, and let go after
   * @param {(contents: import("electron").WebContents) => number | null} [options.pencilFront]  how near the front a page's window is for a press on its pencil, lower nearer; null for one that is not in front
   * @param {(owner: import("electron").WebContents) => void} [options.bringUp]  a session the talk key and Shift started was sent: the box its marks land in put where it can be seen
   * @param {boolean} options.debug
   */
  constructor({ helperPath, pagePath, preloadPath, voiceClient, mainWindow, pill, denyList = () => DENY_DEFAULT, whatAt = null, withVoice = () => true, penPanel = () => {}, pencilFront = () => null, bringUp = () => {}, debug = false }) {
    super();
    this.bringUp = bringUp;
    this.helperPath = helperPath;
    this.pagePath = pagePath;
    this.preloadPath = preloadPath;
    this.withVoice = withVoice;
    this.penPanel = penPanel;
    this.voiceClient = voiceClient;
    this.mainWindow = mainWindow;
    this.pill = pill;
    this.denyList = denyList;
    this.whatAt = whatAt;
    this.pencilFront = pencilFront;
    /** @type {Map<number, { contents: import("electron").WebContents, rect: { x: number, y: number, width: number, height: number } }>} the boxes' pencils, by page */
    this.pencils = new Map();
    this.debug = debug;
    /** @type {any} */
    this.session = null;
    this.helper = null;
    this.helperSeq = 0;
    /** @type {Map<number, (answer: any) => void>} */
    this.waiting = new Map();
    this.watchingDisplays = false;
    /** What `watchDisplays` listens with, taken off again by `dispose`. @type {(() => void) | null} */
    this.displaysChanged = null;
    /**
     * The overlays, made once and kept hidden between sessions, by display:
     * `loaded` once its page can draw, `bounds` the display's when it was made.
     * @type {Map<number, { win: import("electron").BrowserWindow, bounds: { x: number, y: number, width: number, height: number }, loaded: boolean }>}
     */
    this.kept = new Map();
    /** The kept overlays made again once the displays have settled after a change with no session on. */
    this.rewarmTimer = null;
    /** The overlays of a session that ended, ordered out once their pages have painted blank (`takeDown`). */
    this.hideTimer = null;
    /** The helper's last word on Screen Recording — "granted", "denied" — or null for none from this helper. */
    this.screenAccess = null;
    this.lastEscapeAt = 0;
    this.registered = false;
    /** A start waiting on the helper's word about Screen Recording; a second press then is the same start. */
    this.starting = false;
  }

  // --- what the pages are told ----------------------------------------------------

  /**
   * The session as every page draws it. `tools` says where its buttons are
   * — beside the floating pill's meter (`pill`), or in the pill's draw-only
   * form (`draw`) — and `withVoice` is the setting, there whether a session
   * is on or not. `away` is a recording's pen put away (`putAway`): no
   * tools drawn anywhere, the marks still the clip's.
   */
  state() {
    const s = this.session;
    const withVoice = this.withVoiceNow();
    return s
      ? { on: true, id: s.id, voice: s.voice, pen: s.pen, away: s.away, marks: s.bursts.length, ending: s.ending, tool: s.tool, color: s.color, held: s.held !== null, tools: s.inPill ? "pill" : "draw", withVoice }
      : { on: false, id: null, voice: false, pen: false, away: false, marks: 0, ending: false, tool: "pen", color: "red", held: false, tools: "draw", withVoice };
  }

  withVoiceNow() {
    try {
      return this.withVoice() !== false;
    } catch {
      return true;
    }
  }

  /**
   * The windows of the pen itself — every overlay, kept hidden or on the
   * screen — which hear the state on their own channel: a hidden one hears
   * its session end, and clears its ink before it is next shown.
   */
  penWindows() {
    return [...this.overlays().values()];
  }

  /** The overlays that are there, by display. */
  overlays() {
    const out = new Map();
    for (const [id, entry] of this.kept) if (!entry.win.isDestroyed()) out.set(id, entry.win);
    return out;
  }

  /** The owner, every overlay and every other window hear what the session is now: the drawer's pencil and the pill's tools draw from it. */
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
      if (this.helper !== child || !answer) return;
      // The helper's first line says what it found Screen Recording to be, before anything was asked.
      if (answer.ready === true && typeof answer.screen === "string") {
        this.screenAccess = answer.screen;
        return;
      }
      if (typeof answer.seq !== "number") return;
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
    this.screenAccess = null;
    for (const resolve of this.waiting.values()) resolve({ ok: false, error: "the helper went" });
    this.waiting.clear();
    if (this.session) this.cancel(this.session.id, "the screen pen's helper stopped");
  }

  stopHelper() {
    const child = this.helper;
    this.helper = null;
    this.screenAccess = null;
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

  /**
   * One request, answered or failed within `HELPER_ANSWER_MS`. An answer
   * about Screen Recording is kept (`screenAccess`), and a slow one of any
   * kind is written down with how many were ahead of it.
   */
  ask(request) {
    const child = this.ensureHelper();
    if (!child) return Promise.resolve({ ok: false, error: "missing" });
    const seq = ++this.helperSeq;
    const sent = performance.now();
    const ahead = this.waiting.size;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.waiting.delete(seq)) resolve({ ok: false, error: "the helper did not answer" });
      }, HELPER_ANSWER_MS);
      this.waiting.set(seq, (answer) => {
        clearTimeout(timer);
        const took = ms(sent);
        if (took > SLOW_HELPER_MS) penLog("slow helper", { op: request.op, ms: took, ahead, load: loadNow() });
        if ((request.op === "access" || request.op === "ask") && this.helper === child && typeof answer?.screen === "string") this.screenAccess = answer.screen;
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
   * `key` is a session the talk key and Shift started (`TalkKey.onPenKey`),
   * most likely over another application: its Done brings the box its marks
   * land in up (`bringUp`), since there is no drawer open in front of it.
   *
   * @param {{ voice: boolean, asker?: import("electron").WebContents | null, key?: boolean }} options
   */
  async start({ voice, asker = null, key = false }) {
    if (this.session || this.starting) return this.state();
    const pressed = performance.now();
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
      // A "granted" this helper already said is taken at its word, and asked
      // again behind whatever the helper is doing (`confirmAccess`); only a
      // press with none kept waits for the answer.
      const kept = this.helper !== null && this.screenAccess === "granted";
      if (!kept) {
        let access = await this.ask({ op: "access" });
        if (access.screen !== "granted") access = await this.ask({ op: "ask" });
        if (access.screen !== "granted") {
          this.refuse(owner, voice);
          return this.state();
        }
      }
      const accessMs = ms(pressed);
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
        key: key === true && !voice,
        owner,
        at: Date.now(),
        pen: true,
        dir,
        home,
        /**
         * The press, for `pen.log`: when it came, whether Screen Recording was
         * taken as kept or asked, how many overlays had to be made, the
         * displays whose overlay is not up yet, and whether the first stroke
         * has been written down.
         * @type {{ pressed: number, access: string, accessMs: number, made: number, waiting: Set<number>, logged: boolean, stroke: boolean } | null}
         */
        timing: null,
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
        /** Whether the pen was put away when hold-to-draw took it out, for the release to put it back there. */
        heldAway: false,
        /** A recording's pen put away, its tools with it, until it is put down again (`putAway`). */
        away: false,
        /** The tools are beside the floating pill's meter, since it owns the session; otherwise in its draw-only form. */
        inPill: this.pillOwns(voice, owner),
      };
      const session = this.session;
      this.watchOwner(owner);
      this.watchDisplays();
      // The overlays first, since they are what the press is waiting for:
      // kept ones are shown now, with the session's state sent ahead of
      // them, and one still loading shows itself when its page is ready.
      const made = this.ensureOverlays();
      session.timing = { pressed, access: kept ? "kept" : "asked", accessMs, made, waiting: new Set(this.overlays().keys()), logged: false, stroke: false };
      for (const [id, entry] of this.kept) if (entry.loaded) this.reveal(id, entry);
      // Then the pill, a level above them whenever it is made or shown
      // (`raisePill`); it shows itself once its page says it is drawing.
      this.askPanel(true);
      this.raisePill(true);
      this.registerEscape(true);
      this.registerSnap(true);
      this.tellOwner(owner, { ev: "start", id: session.id, voice });
      this.changed();
      if (kept) this.confirmAccess(session);
      return this.state();
    } finally {
      this.starting = false;
    }
  }

  /**
   * Screen Recording off: the owner told why, System Settings opened at the
   * switch, and the helper let go — one that asked before the switch was
   * flipped may keep the old answer, and the next press starts a fresh one.
   */
  refuse(owner, voice) {
    this.stopHelper();
    void shell.openExternal(SCREEN_RECORDING);
    this.tellOwner(owner, { ev: "refused", voice, why: NO_SCREEN_RECORDING });
  }

  /**
   * The helper asked again, behind its work, about the "granted" a session
   * was started on. Turned off since — which macOS does not do to a running
   * app on its own — the pen ends and the owner hears the refusal; with a
   * voice the recording goes on without it, as a clip whose pen was never
   * there. No answer at all is not a refusal: a busy helper keeps the pen.
   */
  confirmAccess(session) {
    void this.ask({ op: "access" }).then((answer) => {
      if (answer?.screen !== "denied" || this.session !== session) return;
      penLog("access withdrawn", { id: session.id });
      this.cancel(session.id, null);
      this.refuse(session.owner, session.voice);
    });
  }

  /**
   * A kept overlay put on the screen for the session that is on: the
   * session's state first, so its page has the pen down before any click
   * can reach it, then the mouse taken and the window shown without taking
   * the keyboard. The press is written to `pen.log` once every display's is
   * up.
   */
  reveal(displayId, entry) {
    const session = this.session;
    const win = entry.win;
    if (!session || session.ending || win.isDestroyed()) return;
    win.webContents.send("ink:state", this.state());
    // macOS keeps a window under the menu bar unless told otherwise after it exists, and again after it was ordered out.
    win.setBounds(entry.bounds);
    win.setIgnoreMouseEvents(!session.pen);
    win.setOpacity(1);
    win.showInactive();
    this.raisePill(true);
    const timing = session.timing;
    if (!timing || timing.logged || !timing.waiting.delete(displayId) || timing.waiting.size) return;
    timing.logged = true;
    penLog("start", {
      id: session.id,
      voice: session.voice,
      ...(session.key ? { from: "talk key + Shift" } : {}),
      ms: ms(timing.pressed),
      access: timing.access,
      accessMs: timing.accessMs,
      overlays: timing.made ? `${timing.made} made` : "kept",
      displays: this.kept.size,
      load: loadNow(),
    });
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

  /**
   * The overlays kept ready while the app runs, hidden: made shortly after
   * it starts, so the first press does not wait for them either (main calls
   * this), and with the helper started, whose first line says whether
   * Screen Recording is on. Nothing in a build without the helper.
   */
  warm() {
    if (!existsSync(this.helperPath)) return;
    this.ensureHelper();
    this.watchDisplays();
    if (!this.session) this.ensureOverlays();
  }

  /**
   * One overlay per display as the displays are now: a kept one whose
   * display has not changed is used as it is, any other made, and one for a
   * display that went destroyed. Returns how many were made.
   */
  ensureOverlays() {
    const displays = screen.getAllDisplays();
    const session = this.session;
    if (session && !displays.some((d) => d.id === session.home)) session.home = screen.getPrimaryDisplay().id;
    for (const [id, entry] of this.kept) {
      const display = displays.find((d) => d.id === id);
      if (entry.win.isDestroyed() || !display || !sameBounds(display.bounds, entry.bounds)) {
        if (!entry.win.isDestroyed()) entry.win.destroy();
        this.kept.delete(id);
      }
    }
    let made = 0;
    for (const display of displays) {
      if (this.kept.has(display.id)) continue;
      this.makeOverlay(display);
      made++;
    }
    return made;
  }

  /** Every kept overlay closed, for displays that changed or an app that is going. */
  dropOverlays() {
    for (const { win } of this.kept.values()) if (!win.isDestroyed()) win.destroy();
    this.kept.clear();
  }

  /** One display's overlay, made hidden and letting the mouse through; shown by `reveal` while a session is on. */
  makeOverlay(display) {
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
    const entry = { win, bounds: { ...display.bounds }, loaded: false };
    // Over the menu bar and every app's floating windows; the pill is
    // raised a level above while a session is on, so its buttons stay over
    // the ink. A stroke over another app leaves that app in front (`stays.js`).
    neverActivates(win);
    win.setAlwaysOnTop(true, "screen-saver");
    // Without the accessory transform, which left the window unable to hide with the app (`stays.js`).
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    // The pen draws on whatever is on the screen, kururu hidden or not (`stays.js`).
    staysUp(win);
    // Made at the bounds, and set there again: macOS keeps a new window
    // under the menu bar unless it is told otherwise after it exists.
    win.setBounds(display.bounds);
    win.setIgnoreMouseEvents(true);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    if (this.debug) win.webContents.on("console-message", (event, ...legacy) => console.log(`kururu ink: ${event?.message ?? legacy[1]}`));
    // An overlay whose page went is a window that may still take the
    // mouse with nothing in it to give it back: the session ends, and the
    // next press makes it again.
    win.webContents.on("render-process-gone", () => {
      if (this.kept.get(display.id) === entry) this.kept.delete(display.id);
      if (!win.isDestroyed()) win.destroy();
      if (this.session) this.cancel(this.session.id, "the pen's overlay stopped");
    });
    win.webContents.once("did-finish-load", () => {
      if (win.isDestroyed() || this.kept.get(display.id) !== entry) return;
      entry.loaded = true;
      win.webContents.send("ink:state", this.state());
      if (this.session) this.reveal(display.id, entry);
    });
    void win.loadFile(this.pagePath, { query: { display: String(display.id) } });
    this.kept.set(display.id, entry);
  }

  /** The overlay a page message came from, and its display, or null for any other sender. */
  overlayOf(sender) {
    const session = this.session;
    if (!session) return null;
    for (const [displayId, win] of this.overlays()) {
      if (win.webContents.id === sender.id) {
        const display = screen.getAllDisplays().find((d) => d.id === displayId);
        return display ? { win, display } : null;
      }
    }
    return null;
  }

  /** The windows a still leaves out: every overlay, and the pill. */
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

  /**
   * The pill over the ink, a level above the overlays' while a session is
   * on, so no ordering of windows at one level can put an overlay over its
   * buttons; back among the floating windows after. Ordered to the front
   * only while it is up: a hidden panel ordered in is a window shown with
   * nothing in it.
   */
  raisePill(on) {
    const pill = this.pill();
    if (!pill || pill.isDestroyed()) return;
    pill.setAlwaysOnTop(true, on ? "screen-saver" : "floating", on ? 1 : 0);
    if (on && pill.isVisible()) pill.moveTop();
  }

  /** The pill wanted for the pen, or let go: `penPanel`, which a throw from cannot stop a session's start or end. */
  askPanel(on) {
    try {
      this.penPanel(on);
    } catch (err) {
      console.error("kururu: the pill for the pen —", err instanceof Error ? err.message : String(err));
    }
  }

  setPen(on) {
    const session = this.session;
    if (!session || session.ending) return;
    // Pressed by hand while a hold has it: the hand wins, and the release leaves it be.
    session.held = null;
    this.penTo(on === true);
  }

  /**
   * The pen down or up; `away` with it up is a recording's pen put away
   * (`putAway`). Down is never away: the pen down again, by any key or
   * button, brings the tools back with it.
   */
  penTo(on, away = false) {
    const session = this.session;
    if (!session || session.ending) return;
    session.pen = on;
    session.away = !on && away === true && session.voice;
    for (const win of this.overlays().values()) win.setIgnoreMouseEvents(!session.pen);
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
      const away = session.away;
      this.penTo(true);
      session.held = was;
      session.heldAway = away;
    } else if (session.held !== null) {
      const was = session.held;
      session.held = null;
      this.penTo(was, session.heldAway);
    }
  }

  /** The pen's colour or the highlighter, from the pill: what the next stroke is drawn with. */
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
    if (session.timing && !session.timing.stroke) {
      // The press to the first stroke main heard: the pen's time and the hand's together, the hand's being most of it.
      session.timing.stroke = true;
      penLog("first stroke", { id: session.id, ms: ms(session.timing.pressed) });
    }
    if (!session.voice && this.onPencil({ x: at.display.bounds.x + p[0], y: at.display.bounds.y + p[1] })) {
      // Done, once: the overlay's dot under the press goes with the overlay.
      if (!session.sendTimer) this.send(null);
      return;
    }
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
   * ⌘Z, or the pill's Undo: the last mark taken back — its still let go,
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
    const overlay = this.overlays().get(burst.display);
    if (overlay && !overlay.isDestroyed() && !burst.snap) overlay.webContents.send("ink:undo");
    this.changed();
  }

  /**
   * ⌃⌥⌘S, or the pill's Snap: the display under the pointer as it is
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
    const overlay = this.overlays().get(display.id);
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

  // --- the box's pencil ----------------------------------------------------------------

  /** Where a page's pencil is now, in its own pixels, or null for gone; kept until the page says otherwise or goes. */
  pencil(contents, raw) {
    const rect = rectOf(raw);
    if (!rect) {
      this.pencils.delete(contents.id);
      return;
    }
    if (!this.pencils.has(contents.id)) contents.once("destroyed", () => this.pencils.delete(contents.id));
    this.pencils.set(contents.id, { contents, rect });
  }

  /** Whether a point on the whole desktop is on the pencil of a box in front. */
  onPencil(global) {
    const windows = [];
    for (const [id, { contents, rect }] of this.pencils) {
      if (contents.isDestroyed()) {
        this.pencils.delete(id);
        continue;
      }
      const win = BrowserWindow.fromWebContents(contents);
      if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) continue;
      let front = null;
      try {
        front = this.pencilFront(contents);
      } catch {}
      if (typeof front !== "number") continue;
      windows.push({ front, bounds: win.getContentBounds(), zoom: contents.getZoomFactor(), pencil: rect });
    }
    windows.sort((a, b) => a.front - b.front);
    return pencilHit(global, windows);
  }

  // --- the end ------------------------------------------------------------------------

  /** Done or the pill's Send: the owner is told to send, and asks for the bundle. One that never asks is not waited on for ever. */
  send(from) {
    const session = this.session;
    if (!session || session.ending) return;
    if (from && from.id !== session.owner.id && !this.overlayOf(from) && !this.isOurs(from)) return;
    this.closeBurst();
    this.tellOwner(session.owner, { ev: "send", id: session.id, voice: session.voice });
    if (session.key && !session.owner.isDestroyed()) this.bringUp(session.owner);
    clearTimeout(session.sendTimer);
    session.sendTimer = setTimeout(() => {
      if (this.session === session) this.cancel(session.id, "the page did not take the marks");
    }, SEND_ANSWER_MS);
  }

  /**
   * The ✕ on a recording's pen (2026-11-15, the owner: "I want that to close
   * the drawing"), and Shift letting the pen go: the pen up and its tools
   * gone, while the recording goes on and every mark made so far stays the
   * clip's, sent with it however it ends. Before this the ✕ was `drop`,
   * which ended the recording with the pen; and lifting the pen, the only
   * other way out, left its tools up saying "Pen up" until the clip ended,
   * so Shift pressed again and again only ever moved the pen. The overlays
   * stay, letting the mouse through, so the ink drawn fades where it was
   * and the pen put down again comes back at once. A session with no voice
   * has nothing to go on without its pen: its ✕ is still `drop`.
   */
  putAway(from) {
    const session = this.session;
    if (!session || session.ending || !session.voice) return;
    if (from && from.id !== session.owner.id && !this.overlayOf(from) && !this.isOurs(from)) return;
    session.held = null;
    this.penTo(false, true);
  }

  /** ✕ on the pill for a session with no voice: gone at once, and the owner told to drop with it. */
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

  /**
   * The overlays off the screen and the keys given back — first, before
   * anything that might wait. Each lets the mouse through and goes fully
   * transparent at once, is told the session is over so its page paints
   * itself blank, and is ordered out a beat later (`HIDE_AFTER_MS`): a window
   * ordered out with ink on it can show that ink again for a frame when it
   * is next shown, before its page has drawn anything new. Kept for the next
   * press; a press within the beat is left alone.
   */
  takeDown() {
    const session = this.session;
    if (!session) return;
    for (const burst of session.bursts) clearTimeout(burst.closer);
    const off = { ...this.state(), on: false, id: null, pen: false };
    for (const win of this.overlays().values()) {
      win.setIgnoreMouseEvents(true);
      win.setOpacity(0);
      win.webContents.send("ink:state", off);
    }
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      if (this.session && this.session !== session) return;
      for (const win of this.overlays().values()) win.hide();
    }, HIDE_AFTER_MS);
    this.registerEscape(false);
    this.registerSnap(false);
    this.raisePill(false);
    this.askPanel(false);
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

  /**
   * A display came, went or changed shape: the overlays are made again for
   * what there is now — at once during a session, whose ink on them was
   * fading anyway, and otherwise once the displays have settled, since
   * macOS goes on rearranging for a while after the first event.
   */
  watchDisplays() {
    if (this.watchingDisplays) return;
    this.watchingDisplays = true;
    const again = () => {
      clearTimeout(this.rewarmTimer);
      this.rewarmTimer = null;
      if (this.session) {
        if (this.session.ending) return;
        this.closeBurst();
        this.dropOverlays();
        this.ensureOverlays();
        return;
      }
      this.dropOverlays();
      this.rewarmTimer = setTimeout(() => {
        this.rewarmTimer = null;
        if (!this.session && existsSync(this.helperPath)) this.ensureOverlays();
      }, DISPLAY_SETTLE_MS);
    };
    this.displaysChanged = again;
    screen.on("display-added", again);
    screen.on("display-removed", again);
    screen.on("display-metrics-changed", again);
  }

  dispose() {
    if (this.session) this.cancel(this.session.id, null);
    clearTimeout(this.rewarmTimer);
    this.rewarmTimer = null;
    clearTimeout(this.hideTimer);
    this.hideTimer = null;
    const again = this.displaysChanged;
    if (again) {
      screen.removeListener("display-added", again);
      screen.removeListener("display-removed", again);
      screen.removeListener("display-metrics-changed", again);
    }
    this.displaysChanged = null;
    this.watchingDisplays = false;
    this.dropOverlays();
    if (this.registered) globalShortcut.unregister(SHORTCUT);
    this.registered = false;
    this.stopHelper();
  }
}

module.exports = { Ink, SHORTCUT, SNAP_SHORTCUT, DENY_DEFAULT };
